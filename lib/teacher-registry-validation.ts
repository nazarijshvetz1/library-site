export type TeacherProfileFields = {
  fullName: string;
  subjectPosition: string;
  primaryLocationId: string | null;
  serviceContact: string;
  librarianNote: string;
};

export type TeacherCreateInput = TeacherProfileFields & {
  requestId: string;
  forceDuplicate: boolean;
};

export type TeacherUpdateInput = {
  requestId: string;
  expectedVersion: number;
  action: "update" | "close" | "restore";
  changes: Partial<TeacherProfileFields>;
  reason: string;
  forceDuplicate: boolean;
};

export type TeacherDeleteInput = {
  requestId: string;
  expectedVersion: number;
  confirmation: "DELETE_EMPTY_TEACHER";
};

export type TeacherValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; fieldErrors: Record<string, string> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LOCATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function validateTeacherCreateInput(input: unknown): TeacherValidationResult<TeacherCreateInput> {
  if (!record(input)) return invalid("body", "Очікується об’єкт із даними вчителя.");
  const errors: Record<string, string> = {};
  exactKeys(input, [
    "requestId", "fullName", "subjectPosition", "primaryLocationId",
    "serviceContact", "librarianNote", "forceDuplicate",
  ], errors);
  const value: TeacherCreateInput = {
    requestId: requestId(input.requestId, errors),
    fullName: requiredText(input.fullName, "fullName", 120, errors),
    subjectPosition: optionalText(input.subjectPosition, "subjectPosition", 160, errors),
    primaryLocationId: nullableLocation(input.primaryLocationId, errors),
    serviceContact: optionalText(input.serviceContact, "serviceContact", 200, errors),
    librarianNote: optionalText(input.librarianNote, "librarianNote", 4_000, errors),
    forceDuplicate: booleanValue(input.forceDuplicate, "forceDuplicate", errors),
  };
  return finish(errors, value);
}

export function validateTeacherUpdateInput(input: unknown): TeacherValidationResult<TeacherUpdateInput> {
  if (!record(input)) return invalid("body", "Очікуються дані зміни картки вчителя.");
  const errors: Record<string, string> = {};
  exactKeys(input, ["requestId", "expectedVersion", "action", "changes", "reason", "forceDuplicate"], errors);
  const action = enumValue(input.action, ["update", "close", "restore"] as const, "action", errors);
  const changes: Partial<TeacherProfileFields> = {};
  if (!record(input.changes)) {
    errors.changes = "Укажіть об’єкт змін.";
  } else {
    allowOnlyKeys(input.changes, ["fullName", "subjectPosition", "primaryLocationId", "serviceContact", "librarianNote"], errors, "changes.");
    if ("fullName" in input.changes) changes.fullName = requiredText(input.changes.fullName, "changes.fullName", 120, errors);
    if ("subjectPosition" in input.changes) changes.subjectPosition = optionalText(input.changes.subjectPosition, "changes.subjectPosition", 160, errors);
    if ("primaryLocationId" in input.changes) changes.primaryLocationId = nullableLocation(input.changes.primaryLocationId, errors, "changes.primaryLocationId");
    if ("serviceContact" in input.changes) changes.serviceContact = optionalText(input.changes.serviceContact, "changes.serviceContact", 200, errors);
    if ("librarianNote" in input.changes) changes.librarianNote = optionalText(input.changes.librarianNote, "changes.librarianNote", 4_000, errors);
    if (action === "update" && Object.keys(input.changes).length === 0) errors.changes = "Укажіть хоча б одну зміну.";
    if (action !== "update" && Object.keys(input.changes).length > 0) errors.changes = "Для закриття або відновлення профільні поля не змінюються.";
  }
  const value: TeacherUpdateInput = {
    requestId: requestId(input.requestId, errors),
    expectedVersion: positiveVersion(input.expectedVersion, errors),
    action,
    changes,
    reason: optionalText(input.reason, "reason", 1_000, errors),
    forceDuplicate: booleanValue(input.forceDuplicate, "forceDuplicate", errors),
  };
  return finish(errors, value);
}

export function validateTeacherDeleteInput(input: unknown): TeacherValidationResult<TeacherDeleteInput> {
  if (!record(input)) return invalid("body", "Очікуються дані видалення картки.");
  const errors: Record<string, string> = {};
  exactKeys(input, ["requestId", "expectedVersion", "confirmation"], errors);
  const confirmation = input.confirmation === "DELETE_EMPTY_TEACHER"
    ? "DELETE_EMPTY_TEACHER"
    : (errors.confirmation = "Підтвердьте видалення порожньої картки.", "DELETE_EMPTY_TEACHER");
  return finish(errors, {
    requestId: requestId(input.requestId, errors),
    expectedVersion: positiveVersion(input.expectedVersion, errors),
    confirmation,
  });
}

export function normalizeTeacherName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function teacherSortName(value: string): string {
  return normalizeTeacherName(value).toLocaleLowerCase("uk-UA");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], errors: Record<string, string>, prefix = "") {
  allowOnlyKeys(value, allowed, errors, prefix);
  for (const key of allowed) if (!(key in value)) errors[`${prefix}${key}`] = "Поле обов’язкове.";
}

function allowOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], errors: Record<string, string>, prefix = "") {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) if (!accepted.has(key)) errors[`${prefix}${key}`] = "Невідоме поле.";
}

function requestId(value: unknown, errors: Record<string, string>): string {
  if (typeof value !== "string" || !UUID_RE.test(value.trim())) {
    errors.requestId = "Некоректний номер запиту.";
    return "";
  }
  return value.trim().toLowerCase();
}

function positiveVersion(value: unknown, errors: Record<string, string>): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    errors.expectedVersion = "Оновіть картку й повторіть дію.";
    return 1;
  }
  return Number(value);
}

function requiredText(value: unknown, key: string, max: number, errors: Record<string, string>): string {
  if (typeof value !== "string") {
    errors[key] = `Поле має містити від 1 до ${max} символів.`;
    return "";
  }
  const normalized = normalizeTeacherName(value);
  if (!normalized || normalized.length > max) errors[key] = `Поле має містити від 1 до ${max} символів.`;
  return normalized;
}

function optionalText(value: unknown, key: string, max: number, errors: Record<string, string>): string {
  if (typeof value !== "string") {
    errors[key] = `Поле має містити не більше ${max} символів.`;
    return "";
  }
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length > max) errors[key] = `Поле має містити не більше ${max} символів.`;
  return normalized;
}

function nullableLocation(value: unknown, errors: Record<string, string>, key = "primaryLocationId"): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !LOCATION_ID_RE.test(value.trim())) {
    errors[key] = "Оберіть кабінет зі списку.";
    return null;
  }
  return value.trim();
}

function booleanValue(value: unknown, key: string, errors: Record<string, string>): boolean {
  if (typeof value !== "boolean") {
    errors[key] = "Укажіть true або false.";
    return false;
  }
  return value;
}

function enumValue<const T extends readonly string[]>(value: unknown, options: T, key: string, errors: Record<string, string>): T[number] {
  if (typeof value !== "string" || !(options as readonly string[]).includes(value)) {
    errors[key] = "Оберіть дозволену дію.";
    return options[0];
  }
  return value as T[number];
}

function invalid<T>(key: string, message: string): TeacherValidationResult<T> {
  return { ok: false, fieldErrors: { [key]: message } };
}

function finish<T>(errors: Record<string, string>, value: T): TeacherValidationResult<T> {
  return Object.keys(errors).length ? { ok: false, fieldErrors: errors } : { ok: true, value };
}
