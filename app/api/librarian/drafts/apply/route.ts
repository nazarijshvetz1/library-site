import {
  beginDraftApply,
  completeDraftApply,
  DraftApplyRequestConflictError,
  failDraftApply,
  returnDraftApplyForChanges,
} from "@/lib/draft-apply-store";
import { draftGatewayFailureDisposition } from "@/lib/draft-apply-disposition";
import {
  isSupportedDraftApplyKind,
  validateDraftApplyInput,
} from "@/lib/draft-apply-validation";
import {
  DraftConflictError,
  DraftLockedError,
  DraftNotFoundError,
  activeDraftReferencesCoverPhoto,
  listDrafts,
  type LibrarianDraft,
} from "@/lib/draft-store";
import {
  authorizeLibrarianApi,
  isSameOriginRequest,
  librarianError,
  librarianJson,
  readDraftJsonBody,
} from "@/lib/librarian-api";
import {
  applyLibrarianDraftGateway,
  type DraftGatewayApplyResult,
  GatewayRejectedError,
  isSheetsGatewayConfigured,
} from "@/lib/sheets-gateway";
import {
  CoverAttachmentError,
  deleteOwnedCoverAttachment,
  readOwnedCoverAttachment,
} from "@/lib/cover-storage";
import {
  confirmedPermanentPrivateCover,
  persistedCoverFromApplyResult,
} from "@/lib/cover-cleanup-proof";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;

  const { user, access } = authorization.value;
  if (!isSameOriginRequest(request)) {
    return librarianError(
      403,
      "cross_origin_request",
      "Запит має надійти з цього самого сайту.",
      access.writesEnabled,
    );
  }
  if (!access.writesEnabled) {
    return librarianError(
      503,
      "librarian_writes_disabled",
      "Застосування чернеток вимкнено. Дані Google Sheets не змінено.",
      false,
    );
  }

  const body = await readDraftJsonBody(request, access.writesEnabled);
  if (!body.ok) return body.response;
  const validated = validateDraftApplyInput(body.value);
  if (!validated.ok) {
    return librarianError(
      400,
      "validation_failed",
      "Перевірте дані запиту на застосування чернетки.",
      access.writesEnabled,
      validated.fieldErrors,
    );
  }

  const { id, revision } = validated.value;
  let existing: LibrarianDraft | undefined;
  try {
    [existing] = await listDrafts(user.userId, id);
  } catch {
    return librarianError(
      503,
      "draft_store_unavailable",
      "Сховище чернеток тимчасово недоступне.",
      access.writesEnabled,
    );
  }
  if (!existing) {
    return librarianError(
      404,
      "draft_not_found",
      "Чернетку не знайдено.",
      access.writesEnabled,
    );
  }
  if (!isSupportedDraftApplyKind(existing.kind)) {
    return librarianError(
      422,
      "draft_kind_not_safely_supported",
      "Цей тип чернетки ще не має перевіреного безпечного запису до Google Sheets. Чернетку не змінено.",
      access.writesEnabled,
    );
  }
  if (!isSheetsGatewayConfigured()) {
    return librarianError(
      503,
      "apply_gateway_not_configured",
      "Захищений шлюз Google Sheets ще не налаштовано. Чернетку не змінено.",
      access.writesEnabled,
    );
  }

  let attachment: Awaited<ReturnType<typeof readOwnedCoverAttachment>> | undefined;
  const coverPhotoKey = draftCoverPhotoKey(existing.kind, existing.payload);
  if (
    coverPhotoKey
    && ["ready_for_review", "approved_pending_apply"].includes(existing.status)
  ) {
    try {
      attachment = await readOwnedCoverAttachment(user.userId, coverPhotoKey);
    } catch (error) {
      if (error instanceof CoverAttachmentError) {
        const unavailable = error.code === "storage_unavailable";
        return librarianError(
          unavailable ? 503 : 422,
          `cover_attachment_${error.code}`,
          error.message,
          access.writesEnabled,
        );
      }
      return librarianError(
        503,
        "cover_attachment_unavailable",
        "Не вдалося безпечно прочитати фотографію обкладинки. Чернетку не змінено.",
        access.writesEnabled,
      );
    }
  }

  try {
    const claim = await beginDraftApply(user, id, revision);
    if (claim.alreadyApplied) {
      const replayCover = persistedCoverFromApplyResult(claim.persistedResult);
      const replayPhotoKey = draftCoverPhotoKey(claim.draft.kind, claim.draft.payload);
      let coverAttachmentCleanedUp = false;
      if (
        replayPhotoKey
        && confirmedPermanentPrivateCover(replayCover, claim.requestId)
      ) {
        try {
          const replayAttachment = await readOwnedCoverAttachment(
            user.userId,
            replayPhotoKey,
          );
          if (replayAttachment.key === replayPhotoKey) {
            coverAttachmentCleanedUp = await cleanupConfirmedCoverAttachment(
              user.userId,
              replayPhotoKey,
            );
          }
        } catch {
          // A missing object normally means the first response already cleaned
          // it up. Any uncertain read retains the object and does not affect the
          // durable applied result.
        }
      }
      return librarianJson({
        success: true,
        idempotent: true,
        draft: claim.draft,
        coverAttachmentCleanedUp,
        requestId: claim.requestId,
        writesEnabled: access.writesEnabled,
      });
    }

    let gatewayResult: DraftGatewayApplyResult;
    try {
      gatewayResult = await applyLibrarianDraftGateway({
        requestId: claim.requestId,
        draftId: claim.draft.id,
        revision: claim.sourceRevision,
        kind: claim.draft.kind,
        payload: claim.draft.payload,
        actor: {
          id: user.userId,
          email: user.email,
        },
        ...(attachment ? {
          attachment: {
            key: attachment.key,
            contentType: attachment.contentType,
            originalName: attachment.originalName,
            byteLength: attachment.byteLength,
            sha256: attachment.sha256,
            base64: attachment.base64,
          },
        } : {}),
      });
    } catch (error) {
      if (error instanceof GatewayRejectedError) {
        const disposition = draftGatewayFailureDisposition(error);
        if (disposition !== "keep_pending") {
          if (disposition === "return_for_changes") {
            const returned = await returnDraftApplyForChanges(
              user,
              id,
              claim.draft.revision,
              claim.requestId,
              error.code,
              error.message,
            );
            return librarianJson(
              {
                success: false,
                code: error.code,
                error: `${error.message} Чернетку повернуто до редагування.`,
                needsChanges: true,
                retryable: false,
                outcomeKnown: true,
                draft: returned,
                requestId: claim.requestId,
                writesEnabled: access.writesEnabled,
              },
              { status: 409 },
            );
          }
          const failed = await failDraftApply(
            user,
            id,
            claim.draft.revision,
            claim.requestId,
            error.code,
            error.message,
          );
          return librarianJson(
            {
              success: false,
              code: error.code,
              error: error.message,
              retryable: false,
              outcomeKnown: true,
              draft: failed,
              requestId: claim.requestId,
              writesEnabled: access.writesEnabled,
            },
            { status: 422 },
          );
        }
        return librarianJson(
          {
            success: false,
            code: error.code,
            error: error.message,
            retryable: error.retryable,
            outcomeKnown: error.outcomeKnown,
            draft: claim.draft,
            requestId: claim.requestId,
            writesEnabled: access.writesEnabled,
          },
          { status: error.outcomeKnown ? 503 : 502 },
        );
      }

      return librarianJson(
        {
          success: false,
          code: "apply_outcome_unknown",
          error: "Не вдалося підтвердити відповідь Google Sheets. Оновіть дані й натисніть «Перевірити результат» — система повторно використає попередній запит.",
          draft: claim.draft,
          currentRevision: claim.draft.revision,
          requestId: claim.requestId,
          writesEnabled: access.writesEnabled,
        },
        { status: 502 },
      );
    }

    const applied = await completeDraftApply(
      user,
      id,
      claim.draft.revision,
      claim.requestId,
      {
        kind: gatewayResult.kind,
        status: gatewayResult.status,
        message: gatewayResult.message,
        alreadyApplied: gatewayResult.alreadyApplied,
        appliedAt: gatewayResult.appliedAt,
        mutations: gatewayResult.mutations,
        entityIds: gatewayResult.entityIds,
        summary: gatewayResult.summary,
        cover: gatewayResult.cover,
      },
    );
    const coverAttachmentCleanedUp = attachment
      && confirmedPermanentPrivateCover(gatewayResult.cover, claim.requestId)
      ? await cleanupConfirmedCoverAttachment(user.userId, attachment.key)
      : false;
    return librarianJson({
      success: true,
      idempotent: gatewayResult.alreadyApplied,
      draft: applied,
      result: gatewayResult,
      coverAttachmentCleanedUp,
      requestId: claim.requestId,
      writesEnabled: access.writesEnabled,
    });
  } catch (error) {
    if (error instanceof DraftNotFoundError) {
      return librarianError(
        404,
        "draft_not_found",
        "Чернетку не знайдено.",
        access.writesEnabled,
      );
    }
    if (error instanceof DraftConflictError) {
      return librarianJson(
        {
          success: false,
          code: "draft_revision_conflict",
          error: "Чернетку вже змінено. Оновіть дані перед застосуванням.",
          currentRevision: error.currentRevision,
          requestId: null,
          writesEnabled: access.writesEnabled,
        },
        { status: 409 },
      );
    }
    if (error instanceof DraftApplyRequestConflictError) {
      return librarianError(
        409,
        "apply_request_conflict",
        "Цю чернетку вже обробляє інший запит. Оновіть дані й не створюйте новий requestId.",
        access.writesEnabled,
      );
    }
    if (error instanceof DraftLockedError) {
      return librarianJson(
        {
          success: false,
          code: "draft_not_ready_for_apply",
          error: "Застосувати можна лише чернетку зі статусом «Готова до перевірки».",
          status: error.status,
          requestId: null,
          writesEnabled: access.writesEnabled,
        },
        { status: 409 },
      );
    }
    return librarianError(
      503,
      "draft_apply_unavailable",
      "Не вдалося завершити застосування чернетки. Дані не вважатимуться застосованими без підтвердження.",
      access.writesEnabled,
    );
  }
}

function draftCoverPhotoKey(
  kind: string,
  payload: Record<string, unknown>,
): string {
  const source = kind === "material.update" && isRecord(payload.changes)
    ? payload.changes
    : payload;
  return typeof source.coverPhotoKey === "string"
    ? source.coverPhotoKey.trim()
    : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function cleanupConfirmedCoverAttachment(
  userId: string,
  key: string,
): Promise<boolean> {
  try {
    if (await activeDraftReferencesCoverPhoto(userId, key)) return false;
    return await deleteOwnedCoverAttachment(userId, key);
  } catch {
    // The permanent write remains successful. Unknown cleanup outcomes retain
    // the private object so a transient storage/database failure loses no data.
    return false;
  }
}
