import {
  beginDraftApply,
  completeDraftApply,
  DraftApplyRequestConflictError,
  failDraftApply,
} from "@/lib/draft-apply-store";
import {
  isSupportedDraftApplyKind,
  validateDraftApplyInput,
} from "@/lib/draft-apply-validation";
import {
  DraftConflictError,
  DraftLockedError,
  DraftNotFoundError,
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

  const { id, revision, requestId } = validated.value;
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

  try {
    const claim = await beginDraftApply(user, id, revision, requestId);
    if (claim.alreadyApplied) {
      return librarianJson({
        success: true,
        idempotent: true,
        draft: claim.draft,
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
      });
    } catch (error) {
      if (error instanceof GatewayRejectedError) {
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
        status: gatewayResult.status,
        message: gatewayResult.message,
        sheet: gatewayResult.sheet,
        row: gatewayResult.row,
        academicYearId: gatewayResult.academicYearId,
        alreadyApplied: gatewayResult.alreadyApplied,
        appliedAt: gatewayResult.appliedAt,
      },
    );
    return librarianJson({
      success: true,
      idempotent: gatewayResult.alreadyApplied,
      draft: applied,
      result: gatewayResult,
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
          requestId: requestId || null,
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
          requestId: requestId || null,
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
