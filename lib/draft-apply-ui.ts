export type DraftApplyUiAction = "apply" | "resume";

export type DraftApplyUiOutcome = {
  phase: "success" | "error" | "unknown";
  message: string;
  stale: boolean;
};

export const UNKNOWN_APPLY_MESSAGE =
  "Результат запису ще не підтверджено. Оновіть дані й натисніть «Перевірити результат» — система повторно використає попередній запит.";

export function draftApplyUiAction(
  kind: string,
  status: string,
): DraftApplyUiAction | null {
  if (kind !== "academic-year.create") return null;
  if (status === "ready_for_review") return "apply";
  if (status === "approved_pending_apply") return "resume";
  return null;
}

export function draftApplyDisabledReason(
  writesEnabled: boolean,
  gatewayConfigured: boolean,
  revision: unknown,
): string | null {
  if (!writesEnabled) return "Запис у Google Sheets вимкнено адміністратором";
  if (!gatewayConfigured) return "Захищений шлюз Google Sheets не налаштовано";
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    return "Оновіть дані чернетки";
  }
  return null;
}

export function refreshedDraftApplyOutcome(
  status: string,
): DraftApplyUiOutcome | null {
  if (status === "applied") {
    return {
      phase: "success",
      stale: false,
      message: "Запис у Google Sheets підтверджено після оновлення. Дубль не створено.",
    };
  }
  if (status === "failed") {
    return {
      phase: "error",
      stale: false,
      message: "Застосування завершилося помилкою. Успішний запис не підтверджено.",
    };
  }
  if (status === "approved_pending_apply") {
    return { phase: "unknown", stale: false, message: UNKNOWN_APPLY_MESSAGE };
  }
  return null;
}

export function academicYearApplyConfirmation(
  payload: Record<string, unknown>,
  action: DraftApplyUiAction,
): string {
  const label = readText(payload.label) || "без назви";
  const startDate = readText(payload.startDate) || "не вказано";
  const endDate = readText(payload.endDate) || "не вказано";

  if (action === "resume") {
    return [
      "Перевірити результат попереднього запиту?",
      "",
      `Навчальний рік: ${label}`,
      `Період: ${startDate} — ${endDate}`,
      "",
      "Новий запит не створюється. Система повторно використає попередню операцію, щоб не допустити дубля.",
    ].join("\n");
  }

  return [
    "Увага: це реальний запис у Google Sheets.",
    "",
    `Додати навчальний рік «${label}» до аркуша «Навчальні роки»?`,
    `Початок: ${startDate}`,
    `Завершення: ${endDate}`,
    "Статус нового рядка: Чернетка",
    "",
    "Буде створено або підтверджено один запис навчального року; дубль не створюється. Поточний активний рік, класи, матеріали й облікові операції не зміняться.",
    "Скасування цього запису через сайт поки немає. Не закривайте сторінку до підтвердженого результату.",
  ].join("\n");
}

export function classifyDraftApplyResponse(
  responseStatus: number,
  body: unknown,
): DraftApplyUiOutcome {
  const bodyIsRecord = isRecord(body);
  const record = bodyIsRecord ? body : {};
  if (responseStatus >= 200 && responseStatus < 300 && record.success === true) {
    if (!isConfirmedAppliedDraft(record.draft)) {
      return { phase: "unknown", stale: false, message: UNKNOWN_APPLY_MESSAGE };
    }
    const result = isRecord(record.result) ? record.result : {};
    const yearId = readText(result.academicYearId || result.academic_year_id);
    const sheet = readText(result.sheet);
    const row = positiveInteger(result.row);
    const destination = [
      yearId,
      sheet ? `аркуш «${sheet}»` : "",
      row ? `рядок ${row}` : "",
    ].filter(Boolean).join(" · ");
    return {
      phase: "success",
      stale: false,
      message: record.idempotent === true
        ? `Запис уже був внесений; дубль не створено${destination ? `. ${destination}` : "."}`
        : `Навчальний рік внесено до Google Sheets${destination ? `. ${destination}` : "."}`,
    };
  }
  if (responseStatus >= 200 && responseStatus < 300) {
    return { phase: "unknown", stale: false, message: UNKNOWN_APPLY_MESSAGE };
  }

  const code = readText(record.code);
  const definitelyNotStarted = [
    "librarian_writes_disabled",
    "apply_gateway_not_configured",
    "draft_store_unavailable",
  ].includes(code);
  if (
    code === "apply_outcome_unknown"
    || code === "draft_apply_unavailable"
    || (responseStatus >= 500 && !definitelyNotStarted)
    || !Number.isInteger(responseStatus)
    || responseStatus <= 0
  ) {
    return { phase: "unknown", stale: false, message: UNKNOWN_APPLY_MESSAGE };
  }

  const stale = responseStatus === 409 || responseStatus === 428;
  return {
    phase: "error",
    stale,
    message: stale
      ? "Стан чернетки вже змінився. Дані не перезаписано — оновіть список перед наступною дією."
      : readText(record.error) || "Не вдалося застосувати чернетку. Успішний запис не підтверджено.",
  };
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 500) : "";
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 1_000_000
    ? parsed
    : null;
}

function isConfirmedAppliedDraft(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === "string"
    && value.id.length > 0
    && value.kind === "academic-year.create"
    && value.status === "applied"
    && isRecord(value.payload)
    && positiveInteger(value.revision) !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
