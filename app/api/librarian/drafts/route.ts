import {
  isDraftId,
  validateDraftActionInput,
  validateDraftInput,
} from "@/lib/draft-validation";
import {
  DraftConflictError,
  DraftLockedError,
  DraftNotFoundError,
  DraftRevisionRequiredError,
  listDrafts,
  saveDraft,
  transitionDraft,
} from "@/lib/draft-store";
import { verifyOwnedCoverPhoto } from "@/lib/cover-storage";
import {
  authorizeLibrarianApi,
  isSameOriginRequest,
  librarianError,
  librarianJson,
  readDraftJsonBody,
} from "@/lib/librarian-api";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;

  const { user, access } = authorization.value;
  const id = new URL(request.url).searchParams.get("id") ?? undefined;
  if (id && !isDraftId(id)) {
    return librarianError(
      400,
      "invalid_draft_id",
      "Некоректний ідентифікатор чернетки.",
      access.writesEnabled,
      { id: "Некоректний ідентифікатор чернетки." },
    );
  }

  try {
    const drafts = await listDrafts(user.userId, id);
    return librarianJson({
      success: true,
      drafts,
      writesEnabled: access.writesEnabled,
    });
  } catch {
    return librarianError(
      503,
      "draft_store_unavailable",
      "Сховище чернеток тимчасово недоступне.",
      access.writesEnabled,
    );
  }
}

export async function POST(request: Request) {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;

  const { user, access } = authorization.value;
  if (!access.writesEnabled) {
    return librarianError(
      503,
      "writes_disabled",
      "Збереження чернеток тимчасово вимкнено.",
      false,
    );
  }
  if (!isSameOriginRequest(request)) {
    return librarianError(
      403,
      "cross_origin_request",
      "Запит має надійти з цього самого сайту.",
      access.writesEnabled,
    );
  }

  const body = await readDraftJsonBody(request, access.writesEnabled);
  if (!body.ok) return body.response;

  const validated = validateDraftInput(body.value);
  if (!validated.ok) {
    return librarianError(
      400,
      "validation_failed",
      "Перевірте поля чернетки.",
      access.writesEnabled,
      validated.fieldErrors,
    );
  }

  const coverError = await validateCoverPhotoPayload(
    user.userId,
    validated.value.payload,
    access.writesEnabled,
  );
  if (coverError) return coverError;

  try {
    const saved = await saveDraft(user, validated.value);
    return librarianJson(
      {
        success: true,
        draft: saved.draft,
        writesEnabled: access.writesEnabled,
      },
      { status: saved.created ? 201 : 200 },
    );
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
          error: "Чернетку вже змінено в іншій вкладці. Оновіть дані.",
          currentRevision: error.currentRevision,
          writesEnabled: access.writesEnabled,
        },
        { status: 409 },
      );
    }
    if (error instanceof DraftRevisionRequiredError) {
      return librarianJson(
        {
          success: false,
          code: "draft_revision_required",
          error: "Оновіть чернетку перед повторним збереженням.",
          currentRevision: error.currentRevision,
          writesEnabled: access.writesEnabled,
        },
        { status: 428 },
      );
    }
    if (error instanceof DraftLockedError) {
      return librarianJson(
        {
          success: false,
          code: "draft_locked",
          error: "Цю чернетку вже надіслано або скасовано; редагування заблоковано.",
          status: error.status,
          writesEnabled: access.writesEnabled,
        },
        { status: 409 },
      );
    }
    return librarianError(
      503,
      "draft_store_unavailable",
      "Не вдалося зберегти чернетку.",
      access.writesEnabled,
    );
  }
}

export async function PATCH(request: Request) {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;

  const { user, access } = authorization.value;
  if (!access.writesEnabled) {
    return librarianError(
      503,
      "writes_disabled",
      "Зміна чернеток тимчасово вимкнена.",
      false,
    );
  }
  if (!isSameOriginRequest(request)) {
    return librarianError(
      403,
      "cross_origin_request",
      "Запит має надійти з цього самого сайту.",
      access.writesEnabled,
    );
  }

  const body = await readDraftJsonBody(request, access.writesEnabled);
  if (!body.ok) return body.response;
  const validated = validateDraftActionInput(body.value);
  if (!validated.ok) {
    return librarianError(
      400,
      "validation_failed",
      "Перевірте дію з чернеткою.",
      access.writesEnabled,
      validated.fieldErrors,
    );
  }

  try {
    const { id, revision, action } = validated.value;
    if (action === "submit") {
      const [current] = await listDrafts(user.userId, id);
      if (!current) throw new DraftNotFoundError();
      const coverError = await validateCoverPhotoPayload(
        user.userId,
        current.payload,
        access.writesEnabled,
      );
      if (coverError) return coverError;
    }
    const draft = await transitionDraft(user, id, revision, action);
    return librarianJson({
      success: true,
      draft,
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
          error: "Чернетку вже змінено в іншій вкладці. Оновіть дані.",
          currentRevision: error.currentRevision,
          writesEnabled: access.writesEnabled,
        },
        { status: 409 },
      );
    }
    if (error instanceof DraftLockedError) {
      return librarianJson(
        {
          success: false,
          code: "draft_transition_not_allowed",
          error: "Для поточного стану чернетки ця дія недоступна.",
          status: error.status,
          writesEnabled: access.writesEnabled,
        },
        { status: 409 },
      );
    }
    return librarianError(
      503,
      "draft_store_unavailable",
      "Не вдалося змінити стан чернетки.",
      access.writesEnabled,
    );
  }
}

async function validateCoverPhotoPayload(
  userId: string,
  payload: Record<string, unknown>,
  writesEnabled: boolean,
): Promise<Response | null> {
  const key = payload.coverPhotoKey;
  if (typeof key !== "string" || key.length === 0) return null;

  let ownership: Awaited<ReturnType<typeof verifyOwnedCoverPhoto>>;
  try {
    ownership = await verifyOwnedCoverPhoto(userId, key);
  } catch {
    return librarianError(
      503,
      "cover_storage_unavailable",
      "Не вдалося перевірити приватне фото. Спробуйте ще раз.",
      writesEnabled,
    );
  }
  if (ownership.ok) return null;
  if (ownership.code === "storage_unavailable") {
    return librarianError(
      503,
      "cover_storage_unavailable",
      "Сховище фотографій тимчасово недоступне.",
      writesEnabled,
    );
  }
  return librarianError(
    400,
    "cover_photo_not_found",
    "Приватне фото не знайдено або воно належить іншій чернетці.",
    writesEnabled,
    { coverPhotoKey: "Завантажте фото повторно." },
  );
}
