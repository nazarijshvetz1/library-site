import { validCoverPhotoKey } from "./cover-upload.ts";
import { normalizeIsbn as normalizeIsbnValue } from "./isbn.ts";

export const DRAFT_KINDS = [
  "material.create",
  "material.update",
  "receipt.create",
  "transfer.create",
  "writeoff.create",
  "revision.count",
  "academic-year.create",
  "class-year.create",
  "class-year.update",
  "class-year.close",
  "academic-year.rollover",
] as const;

export type DraftKind = (typeof DRAFT_KINDS)[number];

export const DRAFT_STATUSES = [
  "draft",
  "ready_for_review",
  "cancelled",
  "approved_pending_apply",
  "applied",
  "failed",
] as const;

export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export const DRAFT_ACTIONS = ["submit", "cancel"] as const;
export type DraftAction = (typeof DRAFT_ACTIONS)[number];

export type ValidatedDraftInput = {
  id?: string;
  revision?: number;
  groupId?: string;
  kind: DraftKind;
  payload: Record<string, unknown>;
};

export type ValidatedDraftActionInput = {
  id: string;
  revision: number;
  action: DraftAction;
};

export type DraftValidationResult =
  | { ok: true; value: ValidatedDraftInput }
  | { ok: false; fieldErrors: Record<string, string> };

export type DraftActionValidationResult =
  | { ok: true; value: ValidatedDraftActionInput }
  | { ok: false; fieldErrors: Record<string, string> };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isDraftId(value: string): boolean {
  return UUID_PATTERN.test(value);
}
const CAT_ID_PATTERN = /^CAT-\d{4,}$/;
const LOCATION_ID_PATTERN = /^LOC-\d{3,}$/;
const USER_ID_PATTERN = /^USR-\d{3,}$/;
const ACADEMIC_YEAR_ID_PATTERN = /^YR-(20\d{2})-(20\d{2})$/;
const CLASS_YEAR_ID_PATTERN = /^CY-20\d{2}-\d{3,}$/;
const COHORT_ID_PATTERN = /^COH-\d{3,}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const ACADEMIC_YEAR_LABEL_PATTERN = /^(20\d{2})\/(20\d{2})$/;
const CLASS_CODE_PATTERN = /^[\p{L}\p{N}()'’._-]{1,16}$/u;
const FORMULA_PREFIX_PATTERN = /^[=+\-@]/;

type StringRule = {
  required?: boolean;
  max: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addUnknownFieldErrors(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix: string,
  errors: Record<string, string>,
) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      errors[`${prefix}${key}`] = "Непідтримуване поле.";
    }
  }
}

function stringValue(
  payload: Record<string, unknown>,
  field: string,
  rule: StringRule,
  errors: Record<string, string>,
): string | undefined {
  const raw = payload[field];
  if (raw === undefined || raw === null || raw === "") {
    if (rule.required) errors[`payload.${field}`] = "Обов’язкове поле.";
    return undefined;
  }
  if (typeof raw !== "string") {
    errors[`payload.${field}`] = "Очікується текстове значення.";
    return undefined;
  }

  const value = raw.trim();
  if (!value) {
    if (rule.required) errors[`payload.${field}`] = "Обов’язкове поле.";
    return undefined;
  }
  if (value.length > rule.max) {
    errors[`payload.${field}`] = `Не більше ${rule.max} символів.`;
    return undefined;
  }
  return value;
}

function integerValue(
  payload: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
  required: boolean,
  errors: Record<string, string>,
): number | undefined {
  const raw = payload[field];
  if (raw === undefined || raw === null || raw === "") {
    if (required) errors[`payload.${field}`] = "Обов’язкове поле.";
    return undefined;
  }

  const value = typeof raw === "string" && /^\d+$/.test(raw.trim())
    ? Number(raw.trim())
    : raw;
  if (typeof value !== "number" ||
      !Number.isInteger(value) || value < min || value > max) {
    errors[`payload.${field}`] = `Вкажіть ціле число від ${min} до ${max}.`;
    return undefined;
  }
  return Number(value);
}

function booleanValue(
  payload: Record<string, unknown>,
  field: string,
  required: boolean,
  errors: Record<string, string>,
): boolean | undefined {
  const raw = payload[field];
  if (raw === undefined || raw === null || raw === "") {
    if (required) errors[`payload.${field}`] = "Обов’язкове поле.";
    return undefined;
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (typeof raw !== "boolean") {
    errors[`payload.${field}`] = "Очікується логічне значення.";
    return undefined;
  }
  return raw;
}

function enumValue<const T extends string>(
  payload: Record<string, unknown>,
  field: string,
  values: readonly T[],
  required: boolean,
  errors: Record<string, string>,
): T | undefined {
  const value = stringValue(payload, field, { required, max: 80 }, errors);
  if (!value) return undefined;
  if (!values.includes(value as T)) {
    errors[`payload.${field}`] = "Оберіть підтримуване значення.";
    return undefined;
  }
  return value as T;
}

function identifierValue(
  payload: Record<string, unknown>,
  field: string,
  pattern: RegExp,
  example: string,
  required: boolean,
  errors: Record<string, string>,
): string | undefined {
  const value = stringValue(payload, field, { required, max: 64 }, errors);
  if (!value) return undefined;
  const normalized = value.toUpperCase();
  if (!pattern.test(normalized)) {
    errors[`payload.${field}`] = `Очікується ідентифікатор у форматі ${example}.`;
    return undefined;
  }
  return normalized;
}

function recordValue(
  payload: Record<string, unknown>,
  field: string,
  required: boolean,
  errors: Record<string, string>,
): Record<string, unknown> | undefined {
  const raw = payload[field];
  if (raw === undefined || raw === null) {
    if (required) errors[`payload.${field}`] = "Обов’язкове поле.";
    return undefined;
  }
  if (!isRecord(raw)) {
    errors[`payload.${field}`] = "Очікується JSON-об’єкт.";
    return undefined;
  }
  return raw;
}

function copyNestedErrors(
  nested: Record<string, string>,
  field: string,
  errors: Record<string, string>,
) {
  for (const [path, message] of Object.entries(nested)) {
    const target = path === "payload"
      ? `payload.${field}`
      : path.replace(/^payload\./, `payload.${field}.`);
    errors[target] = message;
  }
}

function directoryPair(
  payload: Record<string, unknown>,
  idField: string,
  nameField: string,
  pattern: RegExp,
  example: string,
  required: boolean,
  allowNull: boolean,
  errors: Record<string, string>,
): Record<string, string | null> {
  const hasId = Object.hasOwn(payload, idField);
  const hasName = Object.hasOwn(payload, nameField);
  if (allowNull && hasId && payload[idField] === null) {
    if (hasName && payload[nameField] !== null) {
      errors[`payload.${nameField}`] =
        "Для очищення значення передайте null в обох полях.";
      return {};
    }
    return { [idField]: null, [nameField]: null };
  }

  const id = identifierValue(
    payload, idField, pattern, example, false, errors,
  );
  const name = stringValue(payload, nameField, { max: 200 }, errors);
  if ((id && !name) || (!id && name)) {
    errors[`payload.${id ? nameField : idField}`] =
      "Збережіть службовий ID разом із назвою зі списку.";
  }
  if (required && (!id || !name)) {
    errors[`payload.${idField}`] = "Обов’язкове поле.";
  }
  return id && name ? { [idField]: id, [nameField]: name } : {};
}

function normalizedDate(
  payload: Record<string, unknown>,
  field: string,
  errors: Record<string, string>,
  required = false,
): string | undefined {
  const value = stringValue(payload, field, { required, max: 10 }, errors);
  if (!value) return undefined;
  if (!DATE_PATTERN.test(value)) {
    errors[`payload.${field}`] = "Дата має бути у форматі РРРР-ММ-ДД.";
    return undefined;
  }

  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    errors[`payload.${field}`] = "Вкажіть реальну календарну дату.";
    return undefined;
  }
  return value;
}

function normalizedDateTime(
  payload: Record<string, unknown>,
  field: string,
  errors: Record<string, string>,
): string | undefined {
  const value = stringValue(payload, field, { max: 40 }, errors);
  if (!value) return undefined;
  if (!DATE_TIME_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    errors[`payload.${field}`] = "Вкажіть час у форматі ISO-8601 UTC.";
    return undefined;
  }
  return new Date(value).toISOString();
}

function normalizedIsbn(
  payload: Record<string, unknown>,
  field: string,
  errors: Record<string, string>,
): string | undefined {
  const raw = stringValue(payload, field, { max: 32 }, errors);
  if (!raw) return undefined;

  const isbn = normalizeIsbnValue(raw);
  if (!isbn) {
    errors[`payload.${field}`] = "ISBN має містити коректні 10 або 13 символів.";
    return undefined;
  }
  return isbn;
}

function coverSourceUrl(
  payload: Record<string, unknown>,
  errors: Record<string, string>,
): string | undefined {
  const value = stringValue(payload, "coverSourceUrl", { max: 2048 }, errors);
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") ||
        url.username || url.password) {
      throw new Error("unsupported URL");
    }
    return url.toString();
  } catch {
    errors["payload.coverSourceUrl"] = "Вкажіть коректне HTTP(S)-посилання.";
    return undefined;
  }
}

function httpUrl(
  payload: Record<string, unknown>,
  field: string,
  errors: Record<string, string>,
): string | undefined {
  const value = stringValue(payload, field, { max: 2048 }, errors);
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") ||
        url.username || url.password) {
      throw new Error("unsupported URL");
    }
    return url.toString();
  } catch {
    errors[`payload.${field}`] = "Вкажіть коректне HTTP(S)-посилання.";
    return undefined;
  }
}

function normalizeCoverFields(
  payload: Record<string, unknown>,
  errors: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const sourceUrl = coverSourceUrl(payload, errors);
  const photoKey = stringValue(payload, "coverPhotoKey", { max: 240 }, errors);
  const photoName = stringValue(payload, "coverPhotoName", { max: 255 }, errors);
  const confirmed = booleanValue(payload, "coverConfirmed", false, errors);

  if (photoKey && !validCoverPhotoKey(photoKey)) {
    errors["payload.coverPhotoKey"] = "Некоректний ключ завантаженої фотографії.";
  }
  if (sourceUrl && photoKey) {
    errors["payload.coverPhotoKey"] =
      "Оберіть одне джерело обкладинки: посилання або фотографію.";
  }
  if (photoName && !photoKey) {
    errors["payload.coverPhotoName"] =
      "Назву фотографії можна зберегти лише разом із завантаженим файлом.";
  }
  const hasCover = Boolean(sourceUrl || photoKey);
  if (hasCover && confirmed !== true) {
    errors["payload.coverConfirmed"] =
      "Підтвердьте знайдену або завантажену обкладинку.";
  }
  if (!hasCover && confirmed === true) {
    errors["payload.coverConfirmed"] =
      "Спочатку додайте посилання або фотографію обкладинки.";
  }

  if (sourceUrl) result.coverSourceUrl = sourceUrl;
  if (photoKey && validCoverPhotoKey(photoKey)) result.coverPhotoKey = photoKey;
  if (photoName) result.coverPhotoName = photoName;
  if (confirmed !== undefined) result.coverConfirmed = confirmed;
  return result;
}

function findFormulaInjection(
  payload: Record<string, unknown>,
): string | null {
  const pending: Array<{ path: string; value: unknown }> = [
    { path: "payload", value: payload },
  ];
  let visited = 0;

  while (pending.length > 0 && visited < 2_000) {
    visited += 1;
    const current = pending.pop()!;
    if (typeof current.value === "string") {
      if (FORMULA_PREFIX_PATTERN.test(current.value.trimStart())) {
        return current.path;
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      current.value.forEach((value, index) =>
        pending.push({ path: `${current.path}.${index}`, value }),
      );
      continue;
    }
    if (isRecord(current.value)) {
      for (const [key, value] of Object.entries(current.value)) {
        pending.push({ path: `${current.path}.${key}`, value });
      }
    }
  }
  return null;
}

function validateMaterial(
  payload: Record<string, unknown>,
  errors: Record<string, string>,
): Record<string, unknown> {
  const allowed = new Set([
    "title", "rubric", "isbn", "author", "year", "grade", "classFrom",
    "classTo", "subject", "publicationType", "publisher", "electronicUrl",
    "coverSourceUrl", "coverPhotoKey", "coverPhotoName", "coverConfirmed",
    "notes",
  ]);
  addUnknownFieldErrors(payload, allowed, "payload.", errors);

  for (const key of Object.keys(payload)) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
    if (["id", "catid", "catalogid", "materialid"].includes(normalized)) {
      errors[`payload.${key}`] =
        "CAT-ID новому матеріалу призначає система; не вводьте його вручну.";
    }
  }

  const normalized: Record<string, unknown> = {};
  const title = stringValue(payload, "title", { required: true, max: 300 }, errors);
  const rubric = stringValue(payload, "rubric", { required: true, max: 160 }, errors);
  const author = stringValue(payload, "author", { max: 240 }, errors);
  const grade = stringValue(payload, "grade", { max: 50 }, errors);
  const classFrom = integerValue(payload, "classFrom", 1, 11, false, errors);
  let classTo = integerValue(payload, "classTo", 1, 11, false, errors);
  const subject = stringValue(payload, "subject", { max: 160 }, errors);
  const publicationType = stringValue(payload, "publicationType", { max: 160 }, errors);
  const publisher = stringValue(payload, "publisher", { max: 240 }, errors);
  const notes = stringValue(payload, "notes", { max: 2_000 }, errors);
  const year = integerValue(
    payload,
    "year",
    1500,
    new Date().getUTCFullYear() + 1,
    false,
    errors,
  );
  const isbn = normalizedIsbn(payload, "isbn", errors);
  const electronicUrl = httpUrl(payload, "electronicUrl", errors);
  const coverFields = normalizeCoverFields(payload, errors);

  if (classFrom !== undefined && classTo === undefined) classTo = classFrom;
  if (classFrom === undefined && classTo !== undefined) {
    errors["payload.classFrom"] = "Спочатку вкажіть початковий клас.";
  }
  if (classFrom !== undefined && classTo !== undefined && classFrom > classTo) {
    errors["payload.classTo"] = "Кінцевий клас не може бути меншим за початковий.";
  }
  if (grade && (classFrom !== undefined || classTo !== undefined)) {
    errors["payload.grade"] =
      "Старе поле «Клас» не можна поєднувати з полями «Клас від/до».";
  }

  if (title) normalized.title = title;
  if (rubric) normalized.rubric = rubric;
  if (isbn) normalized.isbn = isbn;
  if (author) normalized.author = author;
  if (year !== undefined) normalized.year = year;
  if (grade) normalized.grade = grade;
  if (classFrom !== undefined) normalized.classFrom = classFrom;
  if (classTo !== undefined) normalized.classTo = classTo;
  if (subject) normalized.subject = subject;
  if (publicationType) normalized.publicationType = publicationType;
  if (publisher) normalized.publisher = publisher;
  if (electronicUrl) normalized.electronicUrl = electronicUrl;
  Object.assign(normalized, coverFields);
  if (notes) normalized.notes = notes;
  return normalized;
}

function validateMaterialUpdate(
  payload: Record<string, unknown>,
  errors: Record<string, string>,
): Record<string, unknown> {
  const allowed = new Set([
    "materialId", "sourceGeneratedAt", "changes", "reason",
  ]);
  addUnknownFieldErrors(payload, allowed, "payload.", errors);

  const normalized: Record<string, unknown> = {};
  const materialId = identifierValue(
    payload, "materialId", CAT_ID_PATTERN, "CAT-0001", true, errors,
  );
  const sourceGeneratedAt = normalizedDateTime(payload, "sourceGeneratedAt", errors);
  const reason = stringValue(payload, "reason", { max: 1_000 }, errors);
  const changes = recordValue(payload, "changes", true, errors);

  if (materialId) normalized.materialId = materialId;
  if (sourceGeneratedAt) normalized.sourceGeneratedAt = sourceGeneratedAt;
  if (reason) normalized.reason = reason;
  if (!changes) return normalized;

  const allowedChanges = new Set([
    "title", "rubric", "publicationType", "subject", "classFrom", "classTo",
    "author", "year", "isbn", "publisher", "electronicUrl",
    "coverSourceUrl", "coverPhotoKey", "coverPhotoName", "coverConfirmed",
    "notes",
  ]);
  const nestedErrors: Record<string, string> = {};
  addUnknownFieldErrors(changes, allowedChanges, "payload.", nestedErrors);
  if (Object.keys(changes).length === 0) {
    nestedErrors.payload = "Вкажіть хоча б одну зміну.";
  }

  const result: Record<string, unknown> = {};
  const title = stringValue(changes, "title", { max: 300 }, nestedErrors);
  const rubric = stringValue(changes, "rubric", { max: 160 }, nestedErrors);
  const publicationType = stringValue(
    changes, "publicationType", { max: 160 }, nestedErrors,
  );
  const subject = stringValue(changes, "subject", { max: 160 }, nestedErrors);
  const author = stringValue(changes, "author", { max: 240 }, nestedErrors);
  const publisher = stringValue(changes, "publisher", { max: 240 }, nestedErrors);
  const notes = stringValue(changes, "notes", { max: 2_000 }, nestedErrors);
  const classFrom = integerValue(changes, "classFrom", 1, 11, false, nestedErrors);
  const classTo = integerValue(changes, "classTo", 1, 11, false, nestedErrors);
  const year = integerValue(
    changes, "year", 1500, new Date().getUTCFullYear() + 1, false, nestedErrors,
  );
  const isbn = normalizedIsbn(changes, "isbn", nestedErrors);
  const electronicUrl = httpUrl(changes, "electronicUrl", nestedErrors);
  const hasCoverChange = [
    "coverSourceUrl", "coverPhotoKey", "coverPhotoName", "coverConfirmed",
  ].some((field) => Object.hasOwn(changes, field));
  const coverFields = hasCoverChange
    ? normalizeCoverFields(changes, nestedErrors)
    : {};

  if ((classFrom === undefined) !== (classTo === undefined)) {
    nestedErrors[classFrom === undefined ? "payload.classFrom" : "payload.classTo"] =
      "Змінюйте обидві межі класів разом.";
  }
  if (classFrom !== undefined && classTo !== undefined && classFrom > classTo) {
    nestedErrors["payload.classTo"] =
      "Кінцевий клас не може бути меншим за початковий.";
  }

  if (title) result.title = title;
  if (rubric) result.rubric = rubric;
  if (publicationType) result.publicationType = publicationType;
  if (subject) result.subject = subject;
  if (author) result.author = author;
  if (publisher) result.publisher = publisher;
  if (notes) result.notes = notes;
  if (classFrom !== undefined) result.classFrom = classFrom;
  if (classTo !== undefined) result.classTo = classTo;
  if (year !== undefined) result.year = year;
  if (isbn) result.isbn = isbn;
  if (electronicUrl) result.electronicUrl = electronicUrl;
  Object.assign(result, coverFields);

  if (Object.keys(result).length === 0 && Object.keys(nestedErrors).length === 0) {
    nestedErrors.payload = "Вкажіть хоча б одну непорожню зміну.";
  }
  copyNestedErrors(nestedErrors, "changes", errors);
  normalized.changes = result;
  return normalized;
}

function validateReceipt(
  payload: Record<string, unknown>,
  errors: Record<string, string>,
): Record<string, unknown> {
  const allowed = new Set([
    "materialId", "quantity", "location", "locationId", "locationName",
    "condition", "documentNumber", "date", "notes", "sourceGeneratedAt",
  ]);
  addUnknownFieldErrors(payload, allowed, "payload.", errors);
  const normalized: Record<string, unknown> = {};
  const materialId = stringValue(payload, "materialId", { required: true, max: 32 }, errors);
  const quantity = integerValue(payload, "quantity", 1, 100_000, true, errors);
  const location = stringValue(payload, "location", { max: 160 }, errors);
  const locationId = identifierValue(
    payload, "locationId", LOCATION_ID_PATTERN, "LOC-001", false, errors,
  );
  const locationName = stringValue(payload, "locationName", { max: 160 }, errors);
  const condition = stringValue(payload, "condition", { max: 80 }, errors);
  const documentNumber = stringValue(payload, "documentNumber", { max: 100 }, errors);
  const date = normalizedDate(payload, "date", errors, true);
  const notes = stringValue(payload, "notes", { max: 2_000 }, errors);
  const sourceGeneratedAt = normalizedDateTime(payload, "sourceGeneratedAt", errors);
  if (!location && (!locationId || !locationName)) {
    errors["payload.locationId"] =
      "Оберіть розміщення зі службового довідника.";
  }
  if (materialId && !CAT_ID_PATTERN.test(materialId)) {
    errors["payload.materialId"] = "Очікується CAT-ID у форматі CAT-0001.";
  } else if (materialId) normalized.materialId = materialId;
  if (quantity !== undefined) normalized.quantity = quantity;
  if (location) normalized.location = location;
  if (locationId) normalized.locationId = locationId;
  if (locationName) normalized.locationName = locationName;
  if (condition) normalized.condition = condition;
  if (documentNumber) normalized.documentNumber = documentNumber;
  if (date) normalized.date = date;
  if (notes) normalized.notes = notes;
  if (sourceGeneratedAt) normalized.sourceGeneratedAt = sourceGeneratedAt;
  return normalized;
}

function validateTransfer(
  payload: Record<string, unknown>,
  errors: Record<string, string>,
): Record<string, unknown> {
  const allowed = new Set([
    "materialId", "quantity", "fromLocation", "toLocation", "fromLocationId",
    "fromLocationName", "toLocationId", "toLocationName", "condition", "date",
    "notes", "sourceGeneratedAt", "observedAvailableQuantity",
  ]);
  addUnknownFieldErrors(payload, allowed, "payload.", errors);
  const normalized: Record<string, unknown> = {};
  const materialId = stringValue(payload, "materialId", { required: true, max: 32 }, errors);
  const quantity = integerValue(payload, "quantity", 1, 100_000, true, errors);
  const from = stringValue(payload, "fromLocation", { max: 160 }, errors);
  const to = stringValue(payload, "toLocation", { max: 160 }, errors);
  const fromLocationId = identifierValue(
    payload, "fromLocationId", LOCATION_ID_PATTERN, "LOC-001", false, errors,
  );
  const fromLocationName = stringValue(payload, "fromLocationName", { max: 160 }, errors);
  const toLocationId = identifierValue(
    payload, "toLocationId", LOCATION_ID_PATTERN, "LOC-001", false, errors,
  );
  const toLocationName = stringValue(payload, "toLocationName", { max: 160 }, errors);
  const condition = stringValue(payload, "condition", { max: 80 }, errors);
  const date = normalizedDate(payload, "date", errors, true);
  const notes = stringValue(payload, "notes", { max: 2_000 }, errors);
  const sourceGeneratedAt = normalizedDateTime(payload, "sourceGeneratedAt", errors);
  const observedAvailableQuantity = integerValue(
    payload, "observedAvailableQuantity", 0, 100_000, false, errors,
  );
  if (!from && (!fromLocationId || !fromLocationName)) {
    errors["payload.fromLocationId"] =
      "Оберіть поточне розміщення зі службового довідника.";
  }
  if (!to && (!toLocationId || !toLocationName)) {
    errors["payload.toLocationId"] =
      "Оберіть нове розміщення зі службового довідника.";
  }
  if (materialId && !CAT_ID_PATTERN.test(materialId)) {
    errors["payload.materialId"] = "Очікується CAT-ID у форматі CAT-0001.";
  } else if (materialId) normalized.materialId = materialId;
  if (quantity !== undefined) normalized.quantity = quantity;
  if (from) normalized.fromLocation = from;
  if (to) normalized.toLocation = to;
  if (fromLocationId) normalized.fromLocationId = fromLocationId;
  if (fromLocationName) normalized.fromLocationName = fromLocationName;
  if (toLocationId) normalized.toLocationId = toLocationId;
  if (toLocationName) normalized.toLocationName = toLocationName;
  if (condition) normalized.condition = condition;
  if (from && to && from.toLowerCase() === to.toLowerCase()) {
    errors["payload.toLocation"] = "Нове розміщення має відрізнятися від попереднього.";
  }
  if (fromLocationId && toLocationId && fromLocationId === toLocationId) {
    errors["payload.toLocationId"] =
      "Нове розміщення має відрізнятися від попереднього.";
  }
  if (date) normalized.date = date;
  if (notes) normalized.notes = notes;
  if (sourceGeneratedAt) normalized.sourceGeneratedAt = sourceGeneratedAt;
  if (observedAvailableQuantity !== undefined) {
    normalized.observedAvailableQuantity = observedAvailableQuantity;
  }
  return normalized;
}

function validateRevision(
  payload: Record<string, unknown>,
  errors: Record<string, string>,
): Record<string, unknown> {
  const allowed = new Set([
    "materialId", "location", "locationId", "locationName", "countedQuantity",
    "expectedQuantity", "sessionId", "date", "notes", "sourceGeneratedAt",
  ]);
  addUnknownFieldErrors(payload, allowed, "payload.", errors);
  const normalized: Record<string, unknown> = {};
  const materialId = stringValue(payload, "materialId", { required: true, max: 32 }, errors);
  const location = stringValue(payload, "location", { max: 160 }, errors);
  const locationId = identifierValue(
    payload, "locationId", LOCATION_ID_PATTERN, "LOC-001", false, errors,
  );
  const locationName = stringValue(payload, "locationName", { max: 160 }, errors);
  const count = integerValue(payload, "countedQuantity", 0, 100_000, true, errors);
  const expectedQuantity = integerValue(
    payload, "expectedQuantity", 0, 100_000, false, errors,
  );
  const sessionId = stringValue(payload, "sessionId", { max: 80 }, errors);
  const date = normalizedDate(payload, "date", errors, true);
  const notes = stringValue(payload, "notes", { max: 2_000 }, errors);
  const sourceGeneratedAt = normalizedDateTime(payload, "sourceGeneratedAt", errors);
  if (!location && (!locationId || !locationName)) {
    errors["payload.locationId"] =
      "Оберіть розміщення зі службового довідника.";
  }
  if (materialId && !CAT_ID_PATTERN.test(materialId)) {
    errors["payload.materialId"] = "Очікується CAT-ID у форматі CAT-0001.";
  } else if (materialId) normalized.materialId = materialId;
  if (location) normalized.location = location;
  if (locationId) normalized.locationId = locationId;
  if (locationName) normalized.locationName = locationName;
  if (count !== undefined) normalized.countedQuantity = count;
  if (expectedQuantity !== undefined) normalized.expectedQuantity = expectedQuantity;
  if (sessionId) normalized.sessionId = sessionId;
  if (date) normalized.date = date;
  if (notes) normalized.notes = notes;
  if (sourceGeneratedAt) normalized.sourceGeneratedAt = sourceGeneratedAt;
  return normalized;
}

function validateWriteoff(
  payload: Record<string, unknown>,
  errors: Record<string, string>,
): Record<string, unknown> {
  const allowed = new Set([
    "materialId", "fromLocationId", "fromLocationName", "quantity",
    "destination", "reason", "condition", "actNumber", "date", "notes",
    "sourceGeneratedAt", "observedAvailableQuantity",
  ]);
  addUnknownFieldErrors(payload, allowed, "payload.", errors);
  const normalized: Record<string, unknown> = {};
  const materialId = identifierValue(
    payload, "materialId", CAT_ID_PATTERN, "CAT-0001", true, errors,
  );
  const location = directoryPair(
    payload, "fromLocationId", "fromLocationName", LOCATION_ID_PATTERN,
    "LOC-001", true, false, errors,
  );
  const quantity = integerValue(payload, "quantity", 1, 100_000, true, errors);
  const destination = enumValue(
    payload, "destination", ["written_off", "lost"] as const, true, errors,
  );
  const reason = enumValue(
    payload,
    "reason",
    ["worn", "obsolete", "damaged", "lost", "other"] as const,
    true,
    errors,
  );
  const condition = stringValue(payload, "condition", { max: 80 }, errors);
  const actNumber = stringValue(payload, "actNumber", { max: 100 }, errors);
  const date = normalizedDate(payload, "date", errors, true);
  const notes = stringValue(payload, "notes", { max: 2_000 }, errors);
  const sourceGeneratedAt = normalizedDateTime(payload, "sourceGeneratedAt", errors);
  const observedAvailableQuantity = integerValue(
    payload, "observedAvailableQuantity", 0, 100_000, false, errors,
  );

  if (location.fromLocationId === "LOC-007" || location.fromLocationId === "LOC-008") {
    errors["payload.fromLocationId"] =
      "Не можна списувати матеріал зі службового місця «Списано» або «Втрачено».";
  }
  if (reason === "lost" && destination && destination !== "lost") {
    errors["payload.destination"] =
      "Для втрати оберіть службове призначення «Втрачено».";
  }
  if (destination === "lost" && reason && reason !== "lost") {
    errors["payload.reason"] = "Для призначення «Втрачено» вкажіть причину «Втрачено».";
  }
  if (reason === "other" && !notes) {
    errors["payload.notes"] = "Опишіть іншу причину списання.";
  }

  if (materialId) normalized.materialId = materialId;
  Object.assign(normalized, location);
  if (quantity !== undefined) normalized.quantity = quantity;
  if (destination) normalized.destination = destination;
  if (reason) normalized.reason = reason;
  if (condition) normalized.condition = condition;
  if (actNumber) normalized.actNumber = actNumber;
  if (date) normalized.date = date;
  if (notes) normalized.notes = notes;
  if (sourceGeneratedAt) normalized.sourceGeneratedAt = sourceGeneratedAt;
  if (observedAvailableQuantity !== undefined) {
    normalized.observedAvailableQuantity = observedAvailableQuantity;
  }
  return normalized;
}

function validateAcademicYear(
  payload: Record<string, unknown>,
  errors: Record<string, string>,
): Record<string, unknown> {
  const allowed = new Set(["label", "startDate", "endDate", "notes"]);
  addUnknownFieldErrors(payload, allowed, "payload.", errors);
  const normalized: Record<string, unknown> = {};
  const label = stringValue(payload, "label", { required: true, max: 9 }, errors);
  const startDate = normalizedDate(payload, "startDate", errors, true);
  const endDate = normalizedDate(payload, "endDate", errors, true);
  const notes = stringValue(payload, "notes", { max: 2_000 }, errors);

  const match = label?.match(ACADEMIC_YEAR_LABEL_PATTERN);
  if (label && (!match || Number(match[2]) !== Number(match[1]) + 1)) {
    errors["payload.label"] = "Навчальний рік має формат 2026/2027.";
  }
  if (startDate && endDate && startDate >= endDate) {
    errors["payload.endDate"] = "Дата завершення має бути пізнішою за дату початку.";
  }
  if (match && startDate && !startDate.startsWith(match[1])) {
    errors["payload.startDate"] = "Дата початку має належати першому року в назві.";
  }
  if (match && endDate && !endDate.startsWith(match[2])) {
    errors["payload.endDate"] = "Дата завершення має належати другому року в назві.";
  }

  if (label && match) normalized.label = label;
  if (startDate) normalized.startDate = startDate;
  if (endDate) normalized.endDate = endDate;
  if (notes) normalized.notes = notes;
  return normalized;
}

function validateClassCode(
  payload: Record<string, unknown>,
  field: string,
  required: boolean,
  errors: Record<string, string>,
): string | undefined {
  const code = stringValue(payload, field, { required, max: 16 }, errors);
  if (!code) return undefined;
  if (!CLASS_CODE_PATTERN.test(code)) {
    errors[`payload.${field}`] =
      "Код класу може містити літери, цифри, дужки, крапку, апостроф, дефіс або підкреслення.";
    return undefined;
  }
  return code;
}

function validateAcademicYearId(
  payload: Record<string, unknown>,
  field: string,
  required: boolean,
  errors: Record<string, string>,
): string | undefined {
  const id = identifierValue(
    payload, field, ACADEMIC_YEAR_ID_PATTERN, "YR-2026-2027", required, errors,
  );
  const match = id?.match(ACADEMIC_YEAR_ID_PATTERN);
  if (match && Number(match[2]) !== Number(match[1]) + 1) {
    errors[`payload.${field}`] = "Роки в ID мають бути послідовними.";
    return undefined;
  }
  return id;
}

function validateClassYearCreate(
  payload: Record<string, unknown>,
  errors: Record<string, string>,
): Record<string, unknown> {
  const allowed = new Set([
    "academicYearId", "cohortMode", "cohortId", "grade", "code",
    "teacherUserId", "teacherName", "locationId", "locationName", "notes",
  ]);
  addUnknownFieldErrors(payload, allowed, "payload.", errors);
  const normalized: Record<string, unknown> = {};
  const academicYearId = validateAcademicYearId(
    payload, "academicYearId", true, errors,
  );
  const cohortMode = enumValue(
    payload, "cohortMode", ["existing", "new"] as const, true, errors,
  );
  const cohortId = identifierValue(
    payload, "cohortId", COHORT_ID_PATTERN, "COH-001", false, errors,
  );
  const grade = integerValue(payload, "grade", 1, 11, true, errors);
  const code = validateClassCode(payload, "code", true, errors);
  const teacher = directoryPair(
    payload, "teacherUserId", "teacherName", USER_ID_PATTERN, "USR-001",
    false, false, errors,
  );
  const location = directoryPair(
    payload, "locationId", "locationName", LOCATION_ID_PATTERN, "LOC-001",
    false, false, errors,
  );
  const notes = stringValue(payload, "notes", { max: 2_000 }, errors);

  if (cohortMode === "existing" && !cohortId) {
    errors["payload.cohortId"] = "Оберіть наявну класну групу.";
  }
  if (cohortMode === "new" && cohortId) {
    errors["payload.cohortId"] = "ID нової групи призначає система.";
  }
  if (location.locationId === "LOC-007" || location.locationId === "LOC-008") {
    errors["payload.locationId"] = "Службове місце не може бути кабінетом класу.";
  }

  if (academicYearId) normalized.academicYearId = academicYearId;
  if (cohortMode) normalized.cohortMode = cohortMode;
  if (cohortId) normalized.cohortId = cohortId;
  if (grade !== undefined) normalized.grade = grade;
  if (code) normalized.code = code;
  Object.assign(normalized, teacher, location);
  if (notes) normalized.notes = notes;
  return normalized;
}

function validateClassYearUpdate(
  payload: Record<string, unknown>,
  errors: Record<string, string>,
): Record<string, unknown> {
  const allowed = new Set(["classYearId", "academicYearId", "changes", "reason"]);
  addUnknownFieldErrors(payload, allowed, "payload.", errors);
  const normalized: Record<string, unknown> = {};
  const classYearId = identifierValue(
    payload, "classYearId", CLASS_YEAR_ID_PATTERN, "CY-2026-001", true, errors,
  );
  const academicYearId = validateAcademicYearId(
    payload, "academicYearId", true, errors,
  );
  const reason = stringValue(payload, "reason", { max: 1_000 }, errors);
  const changes = recordValue(payload, "changes", true, errors);
  if (classYearId) normalized.classYearId = classYearId;
  if (academicYearId) normalized.academicYearId = academicYearId;
  if (reason) normalized.reason = reason;
  if (!changes) return normalized;

  const nestedErrors: Record<string, string> = {};
  addUnknownFieldErrors(
    changes,
    new Set([
      "grade", "code", "teacherUserId", "teacherName", "locationId",
      "locationName", "notes",
    ]),
    "payload.",
    nestedErrors,
  );
  if (Object.keys(changes).length === 0) nestedErrors.payload = "Вкажіть хоча б одну зміну.";
  const result: Record<string, unknown> = {};
  const grade = integerValue(changes, "grade", 1, 11, false, nestedErrors);
  const code = validateClassCode(changes, "code", false, nestedErrors);
  const teacher = directoryPair(
    changes, "teacherUserId", "teacherName", USER_ID_PATTERN, "USR-001",
    false, true, nestedErrors,
  );
  const location = directoryPair(
    changes, "locationId", "locationName", LOCATION_ID_PATTERN, "LOC-001",
    false, true, nestedErrors,
  );
  const notes = stringValue(changes, "notes", { max: 2_000 }, nestedErrors);
  if (location.locationId === "LOC-007" || location.locationId === "LOC-008") {
    nestedErrors["payload.locationId"] = "Службове місце не може бути кабінетом класу.";
  }
  if (grade !== undefined) result.grade = grade;
  if (code) result.code = code;
  Object.assign(result, teacher, location);
  if (notes) result.notes = notes;
  if (Object.keys(result).length === 0 && Object.keys(nestedErrors).length === 0) {
    nestedErrors.payload = "Вкажіть хоча б одну непорожню зміну.";
  }
  copyNestedErrors(nestedErrors, "changes", errors);
  normalized.changes = result;
  return normalized;
}

function validateClassYearClose(
  payload: Record<string, unknown>,
  errors: Record<string, string>,
): Record<string, unknown> {
  const allowed = new Set([
    "classYearId", "actualClosedDate", "reason", "closeCohort", "notes",
  ]);
  addUnknownFieldErrors(payload, allowed, "payload.", errors);
  const normalized: Record<string, unknown> = {};
  const classYearId = identifierValue(
    payload, "classYearId", CLASS_YEAR_ID_PATTERN, "CY-2026-001", true, errors,
  );
  const actualClosedDate = normalizedDate(
    payload, "actualClosedDate", errors, true,
  );
  const reason = enumValue(
    payload,
    "reason",
    ["closed", "merged", "graduated", "reorganized", "other"] as const,
    true,
    errors,
  );
  const closeCohort = booleanValue(payload, "closeCohort", true, errors);
  const notes = stringValue(payload, "notes", { max: 2_000 }, errors);
  if (reason === "other" && !notes) {
    errors["payload.notes"] = "Опишіть іншу причину закриття класу.";
  }
  if (classYearId) normalized.classYearId = classYearId;
  if (actualClosedDate) normalized.actualClosedDate = actualClosedDate;
  if (reason) normalized.reason = reason;
  if (closeCohort !== undefined) normalized.closeCohort = closeCohort;
  if (notes) normalized.notes = notes;
  return normalized;
}

function validateRolloverClass(
  item: Record<string, unknown>,
  errors: Record<string, string>,
): Record<string, unknown> {
  const allowed = new Set([
    "sourceClassYearId", "cohortId", "sourceGrade", "action", "targetGrade",
    "targetCode", "teacherUserId", "teacherName", "locationId", "locationName",
    "overrideReason", "notes",
  ]);
  addUnknownFieldErrors(item, allowed, "payload.", errors);
  const result: Record<string, unknown> = {};
  const sourceClassYearId = identifierValue(
    item, "sourceClassYearId", CLASS_YEAR_ID_PATTERN, "CY-2026-001", true, errors,
  );
  const cohortId = identifierValue(
    item, "cohortId", COHORT_ID_PATTERN, "COH-001", true, errors,
  );
  const sourceGrade = integerValue(item, "sourceGrade", 1, 11, true, errors);
  const action = enumValue(
    item, "action", ["promote", "graduate", "close", "skip"] as const, true, errors,
  );
  const targetGrade = integerValue(item, "targetGrade", 1, 11, false, errors);
  const targetCode = validateClassCode(item, "targetCode", false, errors);
  const teacher = directoryPair(
    item, "teacherUserId", "teacherName", USER_ID_PATTERN, "USR-001",
    false, false, errors,
  );
  const location = directoryPair(
    item, "locationId", "locationName", LOCATION_ID_PATTERN, "LOC-001",
    false, false, errors,
  );
  const overrideReason = stringValue(item, "overrideReason", { max: 1_000 }, errors);
  const notes = stringValue(item, "notes", { max: 2_000 }, errors);

  if (action === "promote") {
    if (sourceGrade === 11) {
      errors["payload.action"] = "11 клас не можна переводити до 12 класу.";
    }
    if (targetGrade === undefined) errors["payload.targetGrade"] = "Вкажіть нову паралель.";
    if (!targetCode) errors["payload.targetCode"] = "Вкажіть код нового класу.";
    if (
      sourceGrade !== undefined && targetGrade !== undefined &&
      targetGrade !== sourceGrade + 1 && !overrideReason
    ) {
      errors["payload.overrideReason"] =
        "Поясніть перехід не до наступної паралелі.";
    }
  } else if (targetGrade !== undefined || targetCode) {
    errors["payload.targetGrade"] =
      "Цільовий клас задається лише для дії «Перевести».";
  }
  if (action === "graduate" && sourceGrade !== undefined && sourceGrade !== 11) {
    errors["payload.action"] = "Випуск застосовується лише до 11 класу.";
  }
  if (location.locationId === "LOC-007" || location.locationId === "LOC-008") {
    errors["payload.locationId"] = "Службове місце не може бути кабінетом класу.";
  }

  if (sourceClassYearId) result.sourceClassYearId = sourceClassYearId;
  if (cohortId) result.cohortId = cohortId;
  if (sourceGrade !== undefined) result.sourceGrade = sourceGrade;
  if (action) result.action = action;
  if (targetGrade !== undefined) result.targetGrade = targetGrade;
  if (targetCode) result.targetCode = targetCode;
  Object.assign(result, teacher, location);
  if (overrideReason) result.overrideReason = overrideReason;
  if (notes) result.notes = notes;
  return result;
}

function validateAcademicYearRollover(
  payload: Record<string, unknown>,
  errors: Record<string, string>,
): Record<string, unknown> {
  const allowed = new Set([
    "sourceYearId", "targetYearId", "effectiveDate", "classes", "notes",
  ]);
  addUnknownFieldErrors(payload, allowed, "payload.", errors);
  const normalized: Record<string, unknown> = {};
  const sourceYearId = validateAcademicYearId(payload, "sourceYearId", true, errors);
  const targetYearId = validateAcademicYearId(payload, "targetYearId", true, errors);
  const effectiveDate = normalizedDate(payload, "effectiveDate", errors, true);
  const notes = stringValue(payload, "notes", { max: 2_000 }, errors);
  const rawClasses = payload.classes;
  const classes: Record<string, unknown>[] = [];

  if (!Array.isArray(rawClasses) || rawClasses.length === 0 || rawClasses.length > 100) {
    errors["payload.classes"] = "Додайте від 1 до 100 класів для переходу.";
  } else {
    const sourceIds = new Set<string>();
    const cohorts = new Set<string>();
    const targetNames = new Set<string>();
    rawClasses.forEach((raw, index) => {
      if (!isRecord(raw)) {
        errors[`payload.classes.${index}`] = "Очікується JSON-об’єкт.";
        return;
      }
      const nestedErrors: Record<string, string> = {};
      const item = validateRolloverClass(raw, nestedErrors);
      const sourceId = item.sourceClassYearId;
      const cohortId = item.cohortId;
      if (typeof sourceId === "string") {
        if (sourceIds.has(sourceId)) nestedErrors["payload.sourceClassYearId"] = "Клас повторюється.";
        sourceIds.add(sourceId);
      }
      if (typeof cohortId === "string") {
        if (cohorts.has(cohortId)) nestedErrors["payload.cohortId"] = "Класна група повторюється.";
        cohorts.add(cohortId);
      }
      if (item.action === "promote") {
        const targetName = `${item.targetGrade}-${String(item.targetCode).toLocaleUpperCase("uk-UA")}`;
        if (targetNames.has(targetName)) nestedErrors["payload.targetCode"] = "Цільова назва класу повторюється.";
        targetNames.add(targetName);
      }
      copyNestedErrors(nestedErrors, `classes.${index}`, errors);
      classes.push(item);
    });
  }

  if (sourceYearId && targetYearId && sourceYearId === targetYearId) {
    errors["payload.targetYearId"] = "Цільовий навчальний рік має відрізнятися.";
  }
  const sourceMatch = sourceYearId?.match(ACADEMIC_YEAR_ID_PATTERN);
  const targetMatch = targetYearId?.match(ACADEMIC_YEAR_ID_PATTERN);
  if (sourceMatch && targetMatch && Number(targetMatch[1]) !== Number(sourceMatch[1]) + 1) {
    errors["payload.targetYearId"] = "Цільовий навчальний рік має бути наступним.";
  }

  if (sourceYearId) normalized.sourceYearId = sourceYearId;
  if (targetYearId) normalized.targetYearId = targetYearId;
  if (effectiveDate) normalized.effectiveDate = effectiveDate;
  if (classes.length > 0) normalized.classes = classes;
  if (notes) normalized.notes = notes;
  return normalized;
}

export function validateDraftInput(
  input: Record<string, unknown>,
): DraftValidationResult {
  const errors: Record<string, string> = {};
  addUnknownFieldErrors(
    input,
    new Set(["id", "revision", "groupId", "kind", "payload"]),
    "",
    errors,
  );

  const id = input.id;
  if (id !== undefined && (typeof id !== "string" || !isDraftId(id))) {
    errors.id = "Некоректний ідентифікатор чернетки.";
  }

  const revision = input.revision;
  if (
    revision !== undefined &&
    (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1 ||
      revision > 2_147_483_647)
  ) {
    errors.revision = "Ревізія чернетки має бути додатним цілим числом.";
  }
  if (revision !== undefined && id === undefined) {
    errors.revision = "Ревізію можна передати лише для наявної чернетки.";
  }

  const groupId = input.groupId;
  if (groupId !== undefined && (typeof groupId !== "string" || !isDraftId(groupId))) {
    errors.groupId = "Некоректний ідентифікатор групи чернеток.";
  }

  const kind = input.kind;
  if (typeof kind !== "string" || !DRAFT_KINDS.includes(kind as DraftKind)) {
    errors.kind = "Оберіть підтримуваний тип операції.";
  }

  if (!isRecord(input.payload)) {
    errors.payload = "Дані чернетки мають бути JSON-об’єктом.";
  }
  if (Object.keys(errors).length > 0 || !isRecord(input.payload) ||
      typeof kind !== "string" || !DRAFT_KINDS.includes(kind as DraftKind)) {
    return { ok: false, fieldErrors: errors };
  }

  const formulaPath = findFormulaInjection(input.payload);
  if (formulaPath) {
    errors[formulaPath] =
      "Значення не може починатися із символу формули (=, +, -, @).";
  }

  let payload: Record<string, unknown> = {};
  switch (kind as DraftKind) {
    case "material.create":
      payload = validateMaterial(input.payload, errors);
      break;
    case "material.update":
      payload = validateMaterialUpdate(input.payload, errors);
      break;
    case "receipt.create":
      payload = validateReceipt(input.payload, errors);
      break;
    case "transfer.create":
      payload = validateTransfer(input.payload, errors);
      break;
    case "writeoff.create":
      payload = validateWriteoff(input.payload, errors);
      break;
    case "revision.count":
      payload = validateRevision(input.payload, errors);
      break;
    case "academic-year.create":
      payload = validateAcademicYear(input.payload, errors);
      break;
    case "class-year.create":
      payload = validateClassYearCreate(input.payload, errors);
      break;
    case "class-year.update":
      payload = validateClassYearUpdate(input.payload, errors);
      break;
    case "class-year.close":
      payload = validateClassYearClose(input.payload, errors);
      break;
    case "academic-year.rollover":
      payload = validateAcademicYearRollover(input.payload, errors);
      break;
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, fieldErrors: errors };
  }

  return {
    ok: true,
    value: {
      ...(typeof id === "string" ? { id } : {}),
      ...(typeof revision === "number" ? { revision } : {}),
      ...(typeof groupId === "string" ? { groupId } : {}),
      kind: kind as DraftKind,
      payload,
    },
  };
}

export function validateDraftActionInput(
  input: Record<string, unknown>,
): DraftActionValidationResult {
  const errors: Record<string, string> = {};
  addUnknownFieldErrors(input, new Set(["id", "revision", "action"]), "", errors);

  const id = input.id;
  if (typeof id !== "string" || !isDraftId(id)) {
    errors.id = "Некоректний ідентифікатор чернетки.";
  }
  const revision = input.revision;
  if (
    typeof revision !== "number" || !Number.isInteger(revision) || revision < 1 ||
    revision > 2_147_483_647
  ) {
    errors.revision = "Ревізія чернетки має бути додатним цілим числом.";
  }
  const action = input.action;
  if (typeof action !== "string" || !DRAFT_ACTIONS.includes(action as DraftAction)) {
    errors.action = "Підтримуються лише дії submit і cancel.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors };
  return {
    ok: true,
    value: {
      id: id as string,
      revision: revision as number,
      action: action as DraftAction,
    },
  };
}
