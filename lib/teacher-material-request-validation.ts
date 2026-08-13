export const MATERIAL_REQUEST_MAX_ITEMS = 10;
export const MATERIAL_REQUEST_MAX_QUANTITY = 1_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MATERIAL_ID_RE = /^CAT-\d{4,}$/u;
const RESOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CONDITIONS = ["unspecified", "good", "worn", "damaged"] as const;

export type MaterialCondition = (typeof CONDITIONS)[number];

export type MaterialRequestCreateInput = {
  requestId: string;
  notes: string | null;
  items: Array<{ materialId: string; quantity: number }>;
};

export type MaterialRequestCancelInput = {
  requestId: string;
  expectedVersion: number;
  reason: string | null;
};

type CommonActionInput = {
  requestId: string;
  expectedVersion: number;
};

export type MaterialRequestStartReviewInput = CommonActionInput & {
  action: "start_review";
};

export type MaterialRequestRejectInput = CommonActionInput & {
  action: "reject";
  reason: string;
};

export type MaterialRequestCompleteInput = CommonActionInput & {
  action: "complete";
};

export type MaterialRequestReservationQuantity = {
  reservationId: string;
  quantity: number;
};

export type MaterialRequestIssueInput = CommonActionInput & {
  action: "issue";
  issuedAt: string;
  dueAt: string | null;
  items: MaterialRequestReservationQuantity[];
};

export type MaterialRequestReleaseInput = CommonActionInput & {
  action: "release";
  reason: string;
  items: MaterialRequestReservationQuantity[];
};

export type MaterialRequestReadyItem = {
  itemId: string;
  approvedQuantity: number;
  sourceLocationId: string;
  condition: MaterialCondition;
  expectedAvailableQuantity: number;
};

export type MaterialRequestReadyInput = CommonActionInput & {
  action: "ready";
  pickupLocationId: string;
  dueAt: string | null;
  items: MaterialRequestReadyItem[];
};

export type MaterialRequestActionInput =
  | MaterialRequestStartReviewInput
  | MaterialRequestRejectInput
  | MaterialRequestCompleteInput
  | MaterialRequestReadyInput
  | MaterialRequestIssueInput
  | MaterialRequestReleaseInput;

export type NotificationReadInput = {
  requestId: string;
  expectedVersion: number;
  read: true;
};

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; fieldErrors: Record<string, string> };

export function validateMaterialRequestCreateInput(
  input: unknown,
): ValidationResult<MaterialRequestCreateInput> {
  const errors: Record<string, string> = {};
  if (!isRecord(input)) return invalid("body", "Очікуються дані заявки.");
  exactKeys(input, ["requestId", "notes", "items"], errors);
  const requestId = readUuid(input.requestId, "requestId", errors);
  const notes = readNullableText(input.notes, "notes", errors, 2_000);
  const items: MaterialRequestCreateInput["items"] = [];
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > MATERIAL_REQUEST_MAX_ITEMS) {
    errors.items = `Додайте від 1 до ${MATERIAL_REQUEST_MAX_ITEMS} позицій.`;
  } else {
    const seen = new Set<string>();
    let total = 0;
    input.items.forEach((raw, index) => {
      const prefix = `items.${index}`;
      if (!isRecord(raw)) {
        errors[prefix] = "Некоректна позиція заявки.";
        return;
      }
      exactKeys(raw, ["materialId", "quantity"], errors, `${prefix}.`);
      const materialId = readMaterialId(raw.materialId, `${prefix}.materialId`, errors);
      const quantity = readInteger(raw.quantity, `${prefix}.quantity`, errors, 1, MATERIAL_REQUEST_MAX_QUANTITY);
      if (materialId && seen.has(materialId)) {
        errors[`${prefix}.materialId`] = "Матеріал уже додано до заявки.";
      }
      if (materialId) seen.add(materialId);
      total += quantity;
      items.push({ materialId, quantity });
    });
    if (total > MATERIAL_REQUEST_MAX_QUANTITY) {
      errors.items = `Загальна кількість не може перевищувати ${MATERIAL_REQUEST_MAX_QUANTITY}.`;
    }
  }
  return finish(errors, { requestId, notes, items });
}

export function validateMaterialRequestCancelInput(
  input: unknown,
): ValidationResult<MaterialRequestCancelInput> {
  const errors: Record<string, string> = {};
  if (!isRecord(input)) return invalid("body", "Очікується підтвердження скасування.");
  exactKeys(input, ["requestId", "expectedVersion", "reason"], errors);
  return finish(errors, {
    requestId: readUuid(input.requestId, "requestId", errors),
    expectedVersion: readInteger(input.expectedVersion, "expectedVersion", errors, 1, 1_000_000),
    reason: readNullableText(input.reason, "reason", errors, 500),
  });
}

export function validateMaterialRequestActionInput(
  input: unknown,
): ValidationResult<MaterialRequestActionInput> {
  const errors: Record<string, string> = {};
  if (!isRecord(input)) return invalid("body", "Очікуються дані зміни статусу.");
  const action = input.action;
  if (
    action !== "start_review"
    && action !== "ready"
    && action !== "complete"
    && action !== "reject"
    && action !== "issue"
    && action !== "release"
  ) {
    errors.action = "Оберіть підтримувану дію.";
    return { ok: false, fieldErrors: errors };
  }
  const common = {
    requestId: readUuid(input.requestId, "requestId", errors),
    expectedVersion: readInteger(input.expectedVersion, "expectedVersion", errors, 1, 1_000_000),
  };

  if (action === "start_review" || action === "complete") {
    exactKeys(input, ["requestId", "expectedVersion", "action"], errors);
    return finish(errors, { ...common, action });
  }
  if (action === "reject") {
    exactKeys(input, ["requestId", "expectedVersion", "action", "reason"], errors);
    const reason = readRequiredText(input.reason, "reason", errors, 500);
    return finish(errors, { ...common, action, reason });
  }

  if (action === "issue") {
    exactKeys(input, ["requestId", "expectedVersion", "action", "issuedAt", "dueAt", "items"], errors);
    return finish(errors, {
      ...common,
      action,
      issuedAt: readRequiredDate(input.issuedAt, "issuedAt", errors),
      dueAt: readNullableDate(input.dueAt, "dueAt", errors),
      items: readReservationQuantities(input.items, errors),
    });
  }

  if (action === "release") {
    exactKeys(input, ["requestId", "expectedVersion", "action", "reason", "items"], errors);
    return finish(errors, {
      ...common,
      action,
      reason: readRequiredText(input.reason, "reason", errors, 500),
      items: readReservationQuantities(input.items, errors),
    });
  }

  exactKeys(
    input,
    ["requestId", "expectedVersion", "action", "pickupLocationId", "dueAt", "items"],
    errors,
  );
  const pickupLocationId = readResourceId(input.pickupLocationId, "pickupLocationId", errors);
  const dueAt = readNullableDate(input.dueAt, "dueAt", errors);
  const items: MaterialRequestReadyItem[] = [];
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > MATERIAL_REQUEST_MAX_ITEMS) {
    errors.items = `Додайте від 1 до ${MATERIAL_REQUEST_MAX_ITEMS} позицій.`;
  } else {
    const seen = new Set<string>();
    input.items.forEach((raw, index) => {
      const prefix = `items.${index}`;
      if (!isRecord(raw)) {
        errors[prefix] = "Некоректна позиція підготовки.";
        return;
      }
      exactKeys(
        raw,
        ["itemId", "approvedQuantity", "sourceLocationId", "condition", "expectedAvailableQuantity"],
        errors,
        `${prefix}.`,
      );
      const itemId = readResourceId(raw.itemId, `${prefix}.itemId`, errors);
      const approvedQuantity = readInteger(
        raw.approvedQuantity,
        `${prefix}.approvedQuantity`,
        errors,
        1,
        MATERIAL_REQUEST_MAX_QUANTITY,
      );
      const sourceLocationId = readResourceId(raw.sourceLocationId, `${prefix}.sourceLocationId`, errors);
      const condition = readCondition(raw.condition, `${prefix}.condition`, errors);
      const expectedAvailableQuantity = readInteger(
        raw.expectedAvailableQuantity,
        `${prefix}.expectedAvailableQuantity`,
        errors,
        0,
        MATERIAL_REQUEST_MAX_QUANTITY,
      );
      // approvedQuantity is the cumulative target. The store validates only
      // its delta against the current effective (reservation-aware) stock.
      if (itemId && seen.has(itemId)) {
        errors[`${prefix}.itemId`] = "Позиція повторюється.";
      }
      if (itemId) seen.add(itemId);
      items.push({
        itemId,
        approvedQuantity,
        sourceLocationId,
        condition,
        expectedAvailableQuantity,
      });
    });
  }
  return finish(errors, {
    ...common,
    action: "ready",
    pickupLocationId,
    dueAt,
    items,
  });
}

export function validateNotificationReadInput(
  input: unknown,
): ValidationResult<NotificationReadInput> {
  const errors: Record<string, string> = {};
  if (!isRecord(input)) return invalid("body", "Очікується підтвердження прочитання.");
  exactKeys(input, ["requestId", "expectedVersion", "read"], errors);
  const requestId = readUuid(input.requestId, "requestId", errors);
  const expectedVersion = readInteger(input.expectedVersion, "expectedVersion", errors, 1, 1_000_000);
  if (input.read !== true) errors.read = "Підтвердіть прочитання.";
  return finish(errors, { requestId, expectedVersion, read: true });
}

function exactKeys(
  input: Record<string, unknown>,
  expected: string[],
  errors: Record<string, string>,
  prefix = "",
): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) errors[`${prefix}${key}`] = "Непідтримуване поле.";
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) {
      errors[`${prefix}${key}`] = "Обов’язкове поле.";
    }
  }
}

function readUuid(value: unknown, field: string, errors: Record<string, string>): string {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!UUID_RE.test(text)) errors[field] = "Некоректний request ID.";
  return text;
}

function readMaterialId(value: unknown, field: string, errors: Record<string, string>): string {
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!MATERIAL_ID_RE.test(text) || text.length > 32) errors[field] = "Оберіть матеріал із каталогу.";
  return text;
}

function readResourceId(value: unknown, field: string, errors: Record<string, string>): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!RESOURCE_ID_RE.test(text)) errors[field] = "Некоректний ідентифікатор.";
  return text;
}

function readInteger(
  value: unknown,
  field: string,
  errors: Record<string, string>,
  minimum: number,
  maximum: number,
): number {
  const number = typeof value === "number" ? value : Number.NaN;
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    errors[field] = `Вкажіть ціле число від ${minimum} до ${maximum}.`;
    return minimum;
  }
  return number;
}

function readCondition(value: unknown, field: string, errors: Record<string, string>): MaterialCondition {
  if (typeof value === "string" && (CONDITIONS as readonly string[]).includes(value)) {
    return value as MaterialCondition;
  }
  errors[field] = "Оберіть стан примірника.";
  return "unspecified";
}

function readNullableText(
  value: unknown,
  field: string,
  errors: Record<string, string>,
  maximum: number,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    errors[field] = "Поле має бути текстом або null.";
    return null;
  }
  const text = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (text.length > maximum || containsControl(text)) errors[field] = `Не більше ${maximum} символів.`;
  return text || null;
}

function readRequiredText(
  value: unknown,
  field: string,
  errors: Record<string, string>,
  maximum: number,
): string {
  const text = readNullableText(value, field, errors, maximum) ?? "";
  if (!text) errors[field] = "Заповніть поле.";
  return text;
}

function readNullableDate(value: unknown, field: string, errors: Record<string, string>): string | null {
  if (value === null) return null;
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text) || !isCalendarDate(text)) {
    errors[field] = "Вкажіть коректну дату або null.";
    return null;
  }
  return text;
}

function readRequiredDate(value: unknown, field: string, errors: Record<string, string>): string {
  const date = readNullableDate(value, field, errors);
  if (!date) errors[field] = "Вкажіть коректну дату.";
  return date ?? "";
}

function readReservationQuantities(
  value: unknown,
  errors: Record<string, string>,
): MaterialRequestReservationQuantity[] {
  const items: MaterialRequestReservationQuantity[] = [];
  if (!Array.isArray(value) || value.length < 1 || value.length > MATERIAL_REQUEST_MAX_ITEMS) {
    errors.items = `Додайте від 1 до ${MATERIAL_REQUEST_MAX_ITEMS} резервів.`;
    return items;
  }
  const seen = new Set<string>();
  value.forEach((raw, index) => {
    const prefix = `items.${index}`;
    if (!isRecord(raw)) {
      errors[prefix] = "Некоректний резерв.";
      return;
    }
    exactKeys(raw, ["reservationId", "quantity"], errors, `${prefix}.`);
    const reservationId = readResourceId(raw.reservationId, `${prefix}.reservationId`, errors);
    const quantity = readInteger(
      raw.quantity,
      `${prefix}.quantity`,
      errors,
      1,
      MATERIAL_REQUEST_MAX_QUANTITY,
    );
    if (reservationId && seen.has(reservationId)) {
      errors[`${prefix}.reservationId`] = "Резерв повторюється.";
    }
    if (reservationId) seen.add(reservationId);
    items.push({ reservationId, quantity });
  });
  return items;
}

function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function containsControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid<T>(field: string, message: string): ValidationResult<T> {
  return { ok: false, fieldErrors: { [field]: message } };
}

function finish<T>(errors: Record<string, string>, value: T): ValidationResult<T> {
  return Object.keys(errors).length > 0
    ? { ok: false, fieldErrors: errors }
    : { ok: true, value };
}
