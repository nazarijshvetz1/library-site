import { env } from "cloudflare:workers";

import { normalizeCatalogId } from "@/lib/catalog-d1";
import {
  type PromotedCoverSourceCleanup,
  settlePromotedCoverSource,
} from "@/lib/cover-cleanup";
import {
  deleteOwnedCoverAttachment,
  CoverAttachmentError,
  coverBucket,
  readOwnedCoverAttachment,
} from "@/lib/cover-storage";
import { validCoverPhotoKey } from "@/lib/cover-upload";
import { activeDraftReferencesCoverPhoto } from "@/lib/draft-store";
import {
  type CoverMutationDatabase,
  LibraryCoverMutationError,
  replayCompletedMaterialCover,
  replaceMaterialCoverDirect,
} from "@/lib/library-cover-mutation";
import {
  authorizeLibrarianApi,
  isSameOriginRequest,
  librarianError,
  librarianJson,
  readDraftJsonBody,
} from "@/lib/librarian-api";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  const { user, access } = authorization.value;
  if (!access.writesEnabled) {
    return librarianError(
      503,
      "writes_disabled",
      "Збереження обкладинки тимчасово вимкнено адміністратором.",
      false,
    );
  }
  if (!isSameOriginRequest(request)) {
    return librarianError(
      403,
      "cross_origin_request",
      "Запит має надійти з цього самого сайту.",
      true,
    );
  }

  const { id: rawId } = await context.params;
  const materialId = normalizeCatalogId(rawId);
  if (!materialId) {
    return librarianError(400, "invalid_material_id", "Некоректний CAT-ID.", true);
  }

  const body = await readDraftJsonBody(request, true);
  if (!body.ok) return body.response;
  const validation = validateFinalizeBody(body.value);
  if (!validation.ok) {
    return librarianError(
      400,
      "validation_failed",
      "Перевірте дані обкладинки.",
      true,
      validation.fieldErrors,
    );
  }

  const database = env.DB as unknown as CoverMutationDatabase;
  const bucket = coverBucket();
  try {
    const replay = await replayCompletedMaterialCover(
      user,
      {
        requestId: validation.value.requestId,
        materialId,
        expectedVersion: validation.value.expectedVersion,
        sourceKey: validation.value.coverPhotoKey,
      },
      database,
      bucket ?? undefined,
    );
    if (replay) {
      return finalizedCoverResponse(
        user.userId,
        validation.value.coverPhotoKey,
        replay,
        true,
      );
    }
    if (!bucket) {
      return librarianError(
        503,
        "cover_storage_unavailable",
        "Сховище обкладинок тимчасово недоступне.",
        true,
      );
    }
    const attachment = await readOwnedCoverAttachment(
      user.userId,
      validation.value.coverPhotoKey,
    );
    const result = await replaceMaterialCoverDirect(
      user,
      {
        requestId: validation.value.requestId,
        materialId,
        expectedVersion: validation.value.expectedVersion,
        attachment: {
          key: attachment.key,
          bytes: attachment.bytes,
          byteLength: attachment.byteLength,
          sha256: attachment.sha256,
          width: attachment.width,
          height: attachment.height,
          originalName: attachment.originalName,
        },
      },
      database,
      bucket,
    );
    return finalizedCoverResponse(
      user.userId,
      validation.value.coverPhotoKey,
      result,
      false,
    );
  } catch (error) {
    if (error instanceof CoverAttachmentError) {
      const status = error.code === "not_found" ? 404
        : error.code === "storage_unavailable" ? 503
        : error.code === "cover_too_large" ? 413
        : 400;
      if (status >= 400 && status < 500) {
        const cleanup = await cleanupPromotedSource(
          user.userId,
          validation.value.coverPhotoKey,
        );
        if (!cleanup.settled) {
          return cleanupPendingResponse(validation.value.coverPhotoKey);
        }
      }
      return librarianError(status, `cover_attachment_${error.code}`, error.message, true);
    }
    if (error instanceof LibraryCoverMutationError) {
      if (error.status >= 400 && error.status < 500) {
        const cleanup = await cleanupPromotedSource(
          user.userId,
          validation.value.coverPhotoKey,
        );
        if (!cleanup.settled) {
          return cleanupPendingResponse(validation.value.coverPhotoKey, {
            pendingError: {
              code: error.code,
              message: error.message,
              ...(error.details ?? {}),
            },
          });
        }
      }
      return librarianJson(
        {
          success: false,
          code: error.code,
          error: error.message,
          ...(error.details ?? {}),
          writesEnabled: true,
        },
        { status: error.status },
      );
    }
    return librarianError(
      503,
      "cover_replace_unavailable",
      "Не вдалося зберегти обкладинку. Повторіть запит із тією самою фотографією.",
      true,
    );
  }
}

async function finalizedCoverResponse(
  userId: string,
  sourceKey: string,
  result: unknown,
  replayed: boolean,
): Promise<Response> {
  const cleanup = await cleanupPromotedSource(userId, sourceKey);
  if (!cleanup.settled) {
    return cleanupPendingResponse(sourceKey, { result, replayed });
  }
  return librarianJson({
    success: true,
    result,
    sourceKey,
    sourceCleanedUp: cleanup.sourceCleanedUp,
    ...(replayed ? { replayed: true } : {}),
    writesEnabled: true,
  });
}

function cleanupPendingResponse(
  sourceKey: string,
  details: Record<string, unknown> = {},
): Response {
  return librarianJson(
    {
      success: false,
      code: "cover_cleanup_pending",
      error: "Стан зміни обкладинки ще не вдалося остаточно підтвердити, оскільки очищення тимчасового фото не завершено. Повторіть запит із тим самим request ID.",
      sourceKey,
      ...details,
      writesEnabled: true,
    },
    { status: 503 },
  );
}

async function cleanupPromotedSource(
  userId: string,
  key: string,
): Promise<PromotedCoverSourceCleanup> {
  return settlePromotedCoverSource(userId, key, {
    hasActiveReference: activeDraftReferencesCoverPhoto,
    deleteOwnedSource: deleteOwnedCoverAttachment,
  });
}

type FinalizeBody = {
  requestId: string;
  coverPhotoKey: string;
  expectedVersion: number;
};

type FinalizeValidation =
  | { ok: true; value: FinalizeBody }
  | { ok: false; fieldErrors: Record<string, string> };

function validateFinalizeBody(input: Record<string, unknown>): FinalizeValidation {
  const errors: Record<string, string> = {};
  const allowed = new Set(["requestId", "coverPhotoKey", "expectedVersion"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) errors[key] = "Невідоме поле.";
  }

  const requestId = typeof input.requestId === "string" ? input.requestId.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(requestId)) {
    errors.requestId = "Некоректний request ID.";
  }
  const coverPhotoKey = typeof input.coverPhotoKey === "string"
    ? input.coverPhotoKey.trim()
    : "";
  if (!validCoverPhotoKey(coverPhotoKey)) {
    errors.coverPhotoKey = "Завантажте фотографію повторно.";
  }
  const expectedVersion = Number(input.expectedVersion);
  if (
    !Number.isInteger(expectedVersion)
    || expectedVersion < 0
    || expectedVersion > 1_000_000_000
  ) {
    errors.expectedVersion = "Некоректна версія обкладинки.";
  }

  return Object.keys(errors).length > 0
    ? { ok: false, fieldErrors: errors }
    : { ok: true, value: { requestId, coverPhotoKey, expectedVersion } };
}
