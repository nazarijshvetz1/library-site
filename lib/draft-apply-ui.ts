import { DRAFT_KINDS, type DraftKind } from "./draft-validation.ts";

export type DraftApplyUiAction = "apply" | "resume";

export type DraftApplyUiOutcome = {
  phase: "success" | "error" | "unknown";
  message: string;
  stale: boolean;
};

export const UNKNOWN_APPLY_MESSAGE =
  "Результат запису ще не підтверджено. Оновіть дані й натисніть «Перевірити результат» — система повторно використає попередній запит.";

const KIND_LABELS: Record<DraftKind, string> = {
  "material.create": "Новий матеріал",
  "material.update": "Редагування матеріалу",
  "receipt.create": "Надходження",
  "transfer.create": "Переміщення",
  "writeoff.create": "Списання",
  "revision.count": "Ревізія",
  "academic-year.create": "Новий навчальний рік",
  "class-year.create": "Відкриття класу",
  "class-year.update": "Зміна класу",
  "class-year.close": "Закриття класу",
  "academic-year.rollover": "Перехід класів на новий рік",
};

const SUCCESS_MESSAGES: Record<DraftKind, string> = {
  "material.create": "Матеріал додано до Google Sheets",
  "material.update": "Картку матеріалу оновлено в Google Sheets",
  "receipt.create": "Надходження внесено до Google Sheets",
  "transfer.create": "Переміщення внесено до Google Sheets",
  "writeoff.create": "Списання внесено до Google Sheets",
  "revision.count": "Результат ревізії внесено до Google Sheets",
  "academic-year.create": "Навчальний рік внесено до Google Sheets",
  "class-year.create": "Клас відкрито в Google Sheets",
  "class-year.update": "Дані класу оновлено в Google Sheets",
  "class-year.close": "Клас закрито в Google Sheets",
  "academic-year.rollover": "Перехід класів внесено до Google Sheets",
};

export function draftApplyUiAction(
  kind: string,
  status: string,
): DraftApplyUiAction | null {
  if (!isDraftKind(kind)) return null;
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
  if (status === "draft") {
    return {
      phase: "error",
      stale: true,
      message: "Чернетку повернуто до редагування. Оновіть перевірені значення та надішліть її повторно.",
    };
  }
  return null;
}

/**
 * Builds the final, operation-specific confirmation shown immediately before
 * the server claims a reviewed draft. Values are display-only: the API reads
 * the immutable kind and payload from D1, never from this text or the browser.
 */
export function draftApplyConfirmation(
  kind: DraftKind,
  payload: Record<string, unknown>,
  action: DraftApplyUiAction,
): string {
  const details = confirmationDetails(kind, payload);
  if (action === "resume") {
    return [
      "Перевірити результат попереднього запиту?",
      "",
      `Операція: ${KIND_LABELS[kind]}`,
      ...details,
      "",
      "Новий запит не створюється. Система повторно використає попередню операцію, щоб не допустити дубля.",
    ].join("\n");
  }

  return [
    "Увага: це реальний запис у Google Sheets.",
    "",
    `Операція: ${KIND_LABELS[kind]}`,
    ...details,
    "",
    applyConsequence(kind),
    "Запит має унікальний номер: повторне натискання не створить дубль.",
    "Не закривайте сторінку до підтвердженого результату.",
  ].join("\n");
}

/** Backward-compatible helper kept for callers and documentation. */
export function academicYearApplyConfirmation(
  payload: Record<string, unknown>,
  action: DraftApplyUiAction,
): string {
  return draftApplyConfirmation("academic-year.create", payload, action);
}

export function classifyDraftApplyResponse(
  responseStatus: number,
  body: unknown,
): DraftApplyUiOutcome {
  const record = isRecord(body) ? body : {};
  if (responseStatus >= 200 && responseStatus < 300 && record.success === true) {
    const appliedDraft = confirmedAppliedDraft(record.draft);
    if (!appliedDraft) {
      return { phase: "unknown", stale: false, message: UNKNOWN_APPLY_MESSAGE };
    }

    if (record.idempotent === true) {
      return {
        phase: "success",
        stale: false,
        message: "Операцію вже було внесено; дубль не створено.",
      };
    }

    const result = normalizedConfirmedResult(record.result, appliedDraft.kind);
    if (!result) {
      return { phase: "unknown", stale: false, message: UNKNOWN_APPLY_MESSAGE };
    }
    const destination = resultDestination(result);
    const coverMessage = coverResultMessage(result.cover);
    return {
      phase: "success",
      stale: false,
      message: [
        result.alreadyApplied
          ? "Операцію вже було внесено; дубль не створено."
          : `${SUCCESS_MESSAGES[appliedDraft.kind]}.`,
        destination,
        coverMessage,
      ].filter(Boolean).join(" "),
    };
  }
  if (responseStatus >= 200 && responseStatus < 300) {
    return { phase: "unknown", stale: false, message: UNKNOWN_APPLY_MESSAGE };
  }

  const code = readText(record.code);
  const retryable = record.retryable === true;
  const outcomeKnown = record.outcomeKnown === true || record.outcome_known === true;
  if (
    record.needsChanges === true
    && isRecord(record.draft)
    && record.draft.status === "draft"
  ) {
    return {
      phase: "error",
      stale: true,
      message: readText(record.error)
        || "Дані змінилися. Чернетку повернуто до редагування — оновіть значення й надішліть її повторно.",
    };
  }
  const definitelyNotStarted = code.startsWith("cover_attachment_") || [
    "librarian_writes_disabled",
    "apply_gateway_not_configured",
    "draft_store_unavailable",
  ].includes(code);

  if (
    code === "apply_outcome_unknown"
    || code === "draft_apply_unavailable"
    || (retryable && !outcomeKnown)
    || (responseStatus >= 500 && !definitelyNotStarted && !outcomeKnown)
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

function confirmationDetails(
  kind: DraftKind,
  payload: Record<string, unknown>,
): string[] {
  const materialId = readText(payload.materialId) || "не вказано";
  const quantity = readNumberText(payload.quantity) || "не вказано";
  const location = readText(payload.locationName || payload.location) || "не вказано";
  const fromLocation = readText(payload.fromLocationName || payload.fromLocation) || "не вказано";
  const toLocation = readText(payload.toLocationName || payload.toLocation) || "не вказано";

  switch (kind) {
    case "material.create": {
      const receipt = isRecord(payload.initialReceipt) ? payload.initialReceipt : null;
      return [
        `Назва: ${readText(payload.title) || "без назви"}`,
        `Рубрика: ${readText(payload.rubric) || "не вказано"}`,
        `ISBN: ${readText(payload.isbn) || "не вказано"}`,
        ...(receipt ? [
          `Початкове надходження: ${readNumberText(receipt.quantity) || "?"} прим. · ${readText(receipt.locationName) || "місце не вказано"} · ${readText(receipt.date) || "дата не вказана"}`,
        ] : []),
      ];
    }
    case "material.update":
      return [
        `Матеріал: ${materialId}`,
        `Змінювані поля: ${changedFields(payload.changes)}`,
        `Причина: ${readText(payload.reason) || "не вказано"}`,
      ];
    case "receipt.create":
      return [
        `Матеріал: ${materialId}`,
        `Надходження: ${quantity} прим. · ${location}`,
        `Дата: ${readText(payload.date) || "не вказано"}`,
      ];
    case "transfer.create":
      return [
        `Матеріал: ${materialId}`,
        `Кількість: ${quantity} прим.`,
        `Звідки: ${fromLocation}`,
        `Куди: ${toLocation}`,
        `Дата: ${readText(payload.date) || "не вказано"}`,
      ];
    case "writeoff.create":
      return [
        `Матеріал: ${materialId}`,
        `Кількість: ${quantity} прим.`,
        `Звідки: ${fromLocation}`,
        `Призначення: ${readText(payload.destination) === "lost" ? "Втрачено" : "Списано"}`,
        `Дата: ${readText(payload.date) || "не вказано"}`,
      ];
    case "revision.count":
      return [
        `Матеріал: ${materialId}`,
        `Місце: ${location}`,
        `Фактично: ${readNumberText(payload.countedQuantity) || "не вказано"} прим.`,
        `Дата: ${readText(payload.date) || "не вказано"}`,
      ];
    case "academic-year.create":
      return [
        `Навчальний рік: ${readText(payload.label) || "без назви"}`,
        `Період: ${readText(payload.startDate) || "не вказано"} — ${readText(payload.endDate) || "не вказано"}`,
        "Статус нового рядка: Чернетка",
      ];
    case "class-year.create":
      return [
        `Навчальний рік: ${readText(payload.academicYearId) || "не вказано"}`,
        `Клас: ${classLabel(payload.grade, payload.code)}`,
        `Класний керівник: ${readText(payload.teacherName) || "не вказано"}`,
        `Кабінет: ${readText(payload.locationName) || "не вказано"}`,
      ];
    case "class-year.update":
      return [
        `Клас: ${readText(payload.classYearId) || "не вказано"}`,
        `Змінювані поля: ${changedFields(payload.changes)}`,
        `Причина: ${readText(payload.reason) || "не вказано"}`,
      ];
    case "class-year.close":
      return [
        `Клас: ${readText(payload.classYearId) || "не вказано"}`,
        `Дата закриття: ${readText(payload.actualClosedDate) || "не вказано"}`,
        `Причина: ${closeReasonLabel(readText(payload.reason))}`,
        `Класну групу буде закрито: ${payload.closeCohort === false ? "ні" : "так"}`,
      ];
    case "academic-year.rollover": {
      const classes = Array.isArray(payload.classes) ? payload.classes : [];
      const promote = classes.filter((item) => isRecord(item) && item.action === "promote").length;
      const graduate = classes.filter((item) => isRecord(item) && item.action === "graduate").length;
      const close = classes.filter((item) => isRecord(item) && item.action === "close").length;
      return [
        `Перехід: ${readText(payload.sourceYearId) || "не вказано"} → ${readText(payload.targetYearId) || "не вказано"}`,
        `Дата переходу: ${readText(payload.effectiveDate) || "не вказано"}`,
        `Класи: перевести ${promote}, випустити ${graduate}, закрити ${close}`,
      ];
    }
  }
}

function applyConsequence(kind: DraftKind): string {
  switch (kind) {
    case "material.create":
      return "Буде призначено новий CAT-ID; якщо додано початкове надходження, одночасно створиться підтверджена облікова операція.";
    case "material.update":
      return "Буде змінено лише перелічені поля картки; залишки й облікові операції не змінюються.";
    case "receipt.create":
      return "Підтверджена операція збільшить баланс обраного матеріалу у вказаному місці.";
    case "transfer.create":
      return "Підтверджена операція зменшить залишок у вихідному місці й збільшить його в цільовому.";
    case "writeoff.create":
      return "Підтверджена операція зменшить доступний залишок. Скасування через сайт поки немає.";
    case "revision.count":
      return "Система збереже факт ревізії та, за наявності різниці, створить підтверджене коригування балансу.";
    case "academic-year.create":
      return "Буде створено або підтверджено один запис навчального року; поточний активний рік, класи, матеріали й облікові операції не зміняться.";
    case "class-year.create":
      return "Буде створено запис класу для вибраного навчального року; попередня історія класів не зміниться.";
    case "class-year.update":
      return "Буде змінено лише вибраний запис класу; попередні навчальні роки не зміняться.";
    case "class-year.close":
      return "Клас буде закрито зі збереженням історії. Скасування через сайт поки немає.";
    case "academic-year.rollover":
      return "Система виконає весь перевірений перехід як одну відновлювану операцію зі збереженням історії кожного класу.";
  }
}

type ConfirmedResult = {
  status: "applied" | "already_applied";
  alreadyApplied: boolean;
  mutations: Array<{
    sheet: string;
    row: number;
    key: string;
    action: string;
    entityId: string;
  }>;
  entityIds: Record<string, string | string[]>;
  cover: Record<string, unknown>;
};

function normalizedConfirmedResult(
  value: unknown,
  expectedKind: DraftKind,
): ConfirmedResult | null {
  if (!isRecord(value) || value.kind !== expectedKind) return null;
  const status = value.status;
  if (status !== "applied" && status !== "already_applied") return null;
  if (typeof value.alreadyApplied !== "boolean") return null;
  if (!isIsoDateTime(value.appliedAt)) return null;
  if (!Array.isArray(value.mutations) || value.mutations.length > 250) return null;

  const mutations: ConfirmedResult["mutations"] = [];
  for (const raw of value.mutations) {
    if (!isRecord(raw)) return null;
    const sheet = readText(raw.sheet);
    const row = positiveInteger(raw.row);
    const key = readText(raw.key);
    const action = readText(raw.action);
    const entityId = readText(raw.entityId || raw.entity_id);
    if (!sheet || !row || !action) return null;
    mutations.push({ sheet, row, key, action, entityId });
  }

  const entityIds: Record<string, string | string[]> = {};
  if (!isRecord(value.entityIds)) return null;
  for (const [key, raw] of Object.entries(value.entityIds)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/i.test(key)) return null;
    if (typeof raw === "string" && raw.trim()) {
      entityIds[key] = raw.trim().slice(0, 100);
    } else if (
      Array.isArray(raw)
      && raw.length <= 100
      && raw.every((item) => typeof item === "string" && item.trim())
    ) {
      entityIds[key] = raw.map((item) => item.trim().slice(0, 100));
    } else {
      return null;
    }
  }
  if (!isRecord(value.summary) || !isRecord(value.cover)) return null;
  return {
    status,
    alreadyApplied: value.alreadyApplied,
    mutations,
    entityIds,
    cover: value.cover,
  };
}

function confirmedAppliedDraft(
  value: unknown,
): { kind: DraftKind } | null {
  if (!isRecord(value) || !isRecord(value.payload)) return null;
  if (
    typeof value.id !== "string"
    || !value.id
    || !isDraftKind(value.kind)
    || value.status !== "applied"
    || positiveInteger(value.revision) === null
  ) return null;
  return { kind: value.kind };
}

function resultDestination(result: ConfirmedResult): string {
  const ids = Object.values(result.entityIds).flatMap((value) => (
    Array.isArray(value) ? value : [value]
  )).filter(Boolean);
  const uniqueIds = [...new Set(ids)].slice(0, 5);
  const locations = result.mutations.map((mutation) => (
    `${mutation.sheet}, рядок ${mutation.row}`
  ));
  const uniqueLocations = [...new Set(locations)].slice(0, 3);
  const parts = [
    uniqueIds.length ? `ID: ${uniqueIds.join(", ")}.` : "",
    uniqueLocations.length ? `Запис: ${uniqueLocations.join("; ")}.` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

function coverResultMessage(cover: Record<string, unknown>): string {
  const status = readText(cover.status);
  if (
    status === "dispatch_required"
    || status === "attachment_required"
    || status === "queued"
  ) {
    return "Обкладинку передано на окрему захищену обробку.";
  }
  if (status === "completed") return "Постійну адресу обкладинки записано.";
  if (status === "already_exists") return "Обкладинка вже є у постійному сховищі.";
  return "";
}

function changedFields(value: unknown): string {
  if (!isRecord(value)) return "не вказано";
  const labels: Record<string, string> = {
    title: "назва",
    rubric: "рубрика",
    publicationType: "тип видання",
    subject: "предмет",
    classFrom: "клас від",
    classTo: "клас до",
    author: "автор",
    year: "рік",
    isbn: "ISBN",
    publisher: "видавництво",
    electronicUrl: "електронна версія",
    coverSourceUrl: "обкладинка",
    coverPhotoKey: "фото обкладинки",
    notes: "примітка",
    grade: "паралель",
    code: "код класу",
    teacherUserId: "класний керівник",
    locationId: "кабінет",
  };
  const fields = Object.keys(value)
    .filter((key) => !["coverPhotoName", "coverConfirmed", "teacherName", "locationName"].includes(key))
    .map((key) => labels[key] || key);
  return fields.length ? fields.join(", ") : "не вказано";
}

function classLabel(grade: unknown, code: unknown): string {
  const gradeText = readNumberText(grade);
  const codeText = readText(code);
  return gradeText && codeText ? `${gradeText}-${codeText}` : gradeText || codeText || "не вказано";
}

function closeReasonLabel(value: string): string {
  const labels: Record<string, string> = {
    closed: "закрито",
    merged: "об’єднано",
    graduated: "випуск",
    reorganized: "реорганізовано",
    other: "інша",
  };
  return labels[value] || value || "не вказано";
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 500) : "";
}

function readNumberText(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : typeof value === "string" && /^\d+$/.test(value.trim())
      ? String(Number(value.trim()))
      : "";
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 1_000_000
    ? parsed
    : null;
}

function isIsoDateTime(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function isDraftKind(value: unknown): value is DraftKind {
  return typeof value === "string"
    && (DRAFT_KINDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
