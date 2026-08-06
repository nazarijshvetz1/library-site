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
const CLASS_CODE_PATTERN = /^[\p{L}\p{N}()'â€™._-]{1,16}$/u;
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
      errors[`${prefix}${key}`] = "ĞĞµĞ¿Ñ–Ğ´Ñ‚Ñ€Ğ¸Ğ¼ÑƒĞ²Ğ°Ğ½Ğµ Ğ¿Ğ¾Ğ»Ğµ.";
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
    if (rule.required) errors[`payload.${field}`] = "ĞĞ±Ğ¾Ğ²â€™ÑĞ·ĞºĞ¾Ğ²Ğµ Ğ¿Ğ¾Ğ»Ğµ.";
    return undefined;
  }
  if (typeof raw !== "string") {
    errors[`payload.${field}`] = "ĞÑ‡Ñ–ĞºÑƒÑ”Ñ‚ÑŒÑÑ Ñ‚ĞµĞºÑÑ‚Ğ¾Ğ²Ğµ Ğ·Ğ½Ğ°Ñ‡ĞµĞ½Ğ½Ñ.";
    return undefined;
  }

  const value = raw.trim();
  if (!value) {
    if (rule.required) errors[`payload.${field}`] = "ĞĞ±Ğ¾Ğ²â€™ÑĞ·ĞºĞ¾Ğ²Ğµ Ğ¿Ğ¾Ğ»Ğµ.";
    return undefined;
  }
  if (value.length > rule.max) {
    errors[`payload.${field}`] = `ĞĞµ Ğ±Ñ–Ğ»ÑŒÑˆĞµ ${rule.max} ÑĞ¸Ğ¼Ğ²Ğ¾Ğ»Ñ–Ğ².`;
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
    if (required) errors[`payload.${field}`] = "ĞĞ±Ğ¾Ğ²â€™ÑĞ·ĞºĞ¾Ğ²Ğµ Ğ¿Ğ¾Ğ»Ğµ.";
    return undefined;
  }

  const value = typeof raw === "string" && /^\d+$/.test(raw.trim())
    ? Number(raw.trim())
    : raw;
  if (typeof value !== "number" ||
      !Number.isInteger(value) || value < min || value > max) {
    errors[`payload.${field}`] = `Ğ’ĞºĞ°Ğ¶Ñ–Ñ‚ÑŒ Ñ†Ñ–Ğ»Ğµ Ñ‡Ğ¸ÑĞ»Ğ¾ Ğ²Ñ–Ğ´ ${min} Ğ´Ğ¾ ${max}.`;
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
    if (required) errors[`payload.${field}`] = "ĞĞ±Ğ¾Ğ²â€™ÑĞ·ĞºĞ¾Ğ²Ğµ Ğ¿Ğ¾Ğ»Ğµ.";
    return undefined;
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (typeof raw !== "boolean") {
    errors[`payload.${field}`] = "ĞÑ‡Ñ–ĞºÑƒÑ”Ñ‚ÑŒÑÑ Ğ»Ğ¾Ğ³Ñ–Ñ‡Ğ½Ğµ Ğ·Ğ½Ğ°Ñ‡ĞµĞ½Ğ½Ñ.";
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
    errors[`payload.${field}`] = "ĞĞ±ĞµÑ€Ñ–Ñ‚ÑŒ Ğ¿Ñ–Ğ´Ñ‚Ñ€Ğ¸Ğ¼ÑƒĞ²Ğ°Ğ½Ğµ Ğ·Ğ½Ğ°Ñ‡ĞµĞ½Ğ½Ñ.";
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
    errors[`payload.${field}`] = `ĞÑ‡Ñ–ĞºÑƒÑ”Ñ‚ÑŒÑÑ Ñ–Ğ´ĞµĞ½Ñ‚Ğ¸Ñ„Ñ–ĞºĞ°Ñ‚Ğ¾Ñ€ Ñƒ Ñ„Ğ¾Ñ€Ğ¼Ğ°Ñ‚Ñ– ${example}.`;
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
    if (required) errors[`payload.${field}`] = "ĞĞ±Ğ¾Ğ²â€™ÑĞ·ĞºĞ¾Ğ²Ğµ Ğ¿Ğ¾Ğ»Ğµ.";
    return undefined;
  }
  if (!isRecord(raw)) {
    errors[`payload.${field}`] = "ĞÑ‡Ñ–ĞºÑƒÑ”Ñ‚ÑŒÑÑ JSON-Ğ¾Ğ±â€™Ñ”ĞºÑ‚.";
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
        "Ğ”Ğ»Ñ Ğ¾Ñ‡Ğ¸Ñ‰ĞµĞ½Ğ½Ñ Ğ·Ğ½Ğ°Ñ‡ĞµĞ½Ğ½Ñ Ğ¿ĞµÑ€ĞµĞ´Ğ°Ğ¹Ñ‚Ğµ null Ğ² Ğ¾Ğ±Ğ¾Ñ… Ğ¿Ğ¾Ğ»ÑÑ….";
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
      "Ğ—Ğ±ĞµÑ€ĞµĞ¶Ñ–Ñ‚ÑŒ ÑĞ»ÑƒĞ¶Ğ±Ğ¾Ğ²Ğ¸Ğ¹ ID Ñ€Ğ°Ğ·Ğ¾Ğ¼ Ñ–Ğ· Ğ½Ğ°Ğ·Ğ²Ğ¾Ñ Ğ·Ñ– ÑĞ¿Ğ¸ÑĞºÑƒ.";
  }
  if (required && (!id || !name)) {
    errors[`payload.${idField}`] = "ĞĞ±Ğ¾Ğ²â€™ÑĞ·ĞºĞ¾Ğ²Ğµ Ğ¿Ğ¾Ğ»Ğµ.";
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
    errors[`payload.${field}`] = "Ğ”Ğ°Ñ‚Ğ° Ğ¼Ğ°Ñ” Ğ±ÑƒÑ‚Ğ¸ Ñƒ Ñ„Ğ¾Ñ€Ğ¼Ğ°Ñ‚Ñ– Ğ Ğ Ğ Ğ -ĞœĞœ-Ğ”Ğ”.";
    return undefined;
  }

  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    errors[`payload.${field}`] = "Ğ’ĞºĞ°Ğ¶Ñ–Ñ‚ÑŒ Ñ€ĞµĞ°Ğ»ÑŒĞ½Ñƒ ĞºĞ°Ğ»ĞµĞ½Ğ´Ğ°Ñ€Ğ½Ñƒ Ğ´Ğ°Ñ‚Ñƒ.";
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
    errors[`payload.${field}`] = "Ğ’ĞºĞ°Ğ¶Ñ–Ñ‚ÑŒ Ñ‡Ğ°Ñ Ñƒ Ñ„Ğ¾Ñ€Ğ¼Ğ°Ñ‚Ñ– ISO-8601 UTC.";
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
    errors[`payload.${field}`] = "ISBN Ğ¼Ğ°Ñ” Ğ¼Ñ–ÑÑ‚Ğ¸Ñ‚Ğ¸ ĞºĞ¾Ñ€ĞµĞºÑ‚Ğ½Ñ– 10 Ğ°Ğ±Ğ¾ 13 ÑĞ¸Ğ¼Ğ²Ğ¾Ğ»Ñ–Ğ².";
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
    errors["payload.coverSourceUrl"] = "Ğ’ĞºĞ°Ğ¶Ñ–Ñ‚ÑŒ ĞºĞ¾Ñ€ĞµĞºÑ‚Ğ½Ğµ HTTP(S)-Ğ¿Ğ¾ÑĞ¸Ğ»Ğ°Ğ½Ğ½Ñ.";
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
    errors[`payload.${field}`] = "Ğ’ĞºĞ°Ğ¶Ñ–Ñ‚ÑŒ ĞºĞ¾Ñ€ĞµĞºÑ‚Ğ½Ğµ HTTP(S)-Ğ¿Ğ¾ÑĞ¸Ğ»Ğ°Ğ½Ğ½Ñ.";
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
    errors["payload.coverPhotoKey"] = "ĞĞµĞºĞ¾Ñ€ĞµĞºÑ‚Ğ½Ğ¸Ğ¹ ĞºĞ»ÑÑ‡ Ğ·Ğ°Ğ²Ğ°Ğ½Ñ‚Ğ°Ğ¶ĞµĞ½Ğ¾Ñ— Ñ„Ğ¾Ñ‚Ğ¾Ğ³Ñ€Ğ°Ñ„Ñ–Ñ—.";
  }
  if (sourceUrl && photoKey) {
    errors["payload.coverPhotoKey"] =
      "ĞĞ±ĞµÑ€Ñ–Ñ‚ÑŒ Ğ¾Ğ´Ğ½Ğµ Ğ´Ğ¶ĞµÑ€ĞµĞ»Ğ¾ Ğ¾Ğ±ĞºĞ»Ğ°Ğ´Ğ¸Ğ½ĞºĞ¸: Ğ¿Ğ¾ÑĞ¸Ğ»Ğ°Ğ½Ğ½Ñ Ğ°Ğ±Ğ¾ Ñ„Ğ¾Ñ‚Ğ¾Ğ³Ñ€Ğ°Ñ„Ñ–Ñ.";
  }
  if (photoName && !photoKey) {
    errors["payload.coverPhotoName"] =
      "ĞĞ°Ğ·Ğ²Ñƒ Ñ„Ğ¾Ñ‚Ğ¾Ğ³Ñ€Ğ°Ñ„Ñ–Ñ— Ğ¼Ğ¾Ğ¶Ğ½Ğ° Ğ·Ğ±ĞµÑ€ĞµĞ³Ñ‚Ğ¸ Ğ»Ğ¸ÑˆĞµ Ñ€Ğ°Ğ·Ğ¾Ğ¼ Ñ–Ğ· Ğ·Ğ°Ğ²Ğ°Ğ½Ñ‚Ğ°Ğ¶ĞµĞ½Ğ¸Ğ¼ Ñ„Ğ°Ğ¹Ğ»Ğ¾Ğ¼.";
  }
  const hasCover = Boolean(sourceUrl || photoKey);
  if (hasCover && confirmed !== true) {
    errors["payload.coverConfirmed"] =
      "ĞŸÑ–Ğ´Ñ‚Ğ²ĞµÑ€Ğ´ÑŒÑ‚Ğµ Ğ·Ğ½Ğ°Ğ¹Ğ´ĞµĞ½Ñƒ Ğ°Ğ±Ğ¾ Ğ·Ğ°Ğ²Ğ°Ğ½Ñ‚Ğ°Ğ¶ĞµĞ½Ñƒ Ğ¾Ğ±ĞºĞ»Ğ°Ğ´Ğ¸Ğ½ĞºÑƒ.";
  }
  if (!hasCover && confirmed === true) {
    errors["payload.coverConfirmed"] =
      "Ğ¡Ğ¿Ğ¾Ñ‡Ğ°Ñ‚ĞºÑƒ Ğ´Ğ¾Ğ´Ğ°Ğ¹Ñ‚Ğµ Ğ¿Ğ¾ÑĞ¸Ğ»Ğ°Ğ½Ğ½Ñ Ğ°Ğ±Ğ¾ Ñ„Ğ¾Ñ‚Ğ¾Ğ³Ñ€Ğ°Ñ„Ñ–Ñ Ğ¾Ğ±ĞºĞ»Ğ°Ğ´Ğ¸Ğ½ĞºĞ¸.";
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
        "CAT-ID Ğ½Ğ¾Ğ²Ğ¾Ğ¼Ñƒ Ğ¼Ğ°Ñ‚ĞµÑ€Ñ–Ğ°Ğ»Ñƒ Ğ¿Ñ€Ğ¸Ğ·Ğ½Ğ°Ñ‡Ğ°Ñ” ÑĞ¸ÑÑ‚ĞµĞ¼Ğ°; Ğ½Ğµ Ğ²Ğ²Ğ¾Ğ´ÑŒÑ‚Ğµ Ğ¹Ğ¾Ğ³Ğ¾ Ğ²Ñ€ÑƒÑ‡Ğ½Ñƒ.";
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
  ïMw¶‰ËkºwµçE‘”€„ôôÕ¹‘•™¥¹•¤¹½Éµ…±¥é•¹É…‘”€ôÉ…‘”ì(€¥˜€¡½‘”¤¹½Éµ…±¥é•¹½‘”€ô½‘”ì(€=‰©•Ğ¹…ÍÍ¥¸¡¹½Éµ…±¥é•°Ñ•…¡•È°±½…Ñ¥½¸¤ì(€¥˜€¡¹½Ñ•Ì¤¹½Éµ…±¥é•¹¹½Ñ•Ì€ô¹½Ñ•Ìì(€É•ÑÕÉ¸¹½Éµ…±¥é•ì)ô()™Õ¹Ñ¥½¸Ù…±¥‘…Ñ•±…ÍÍe•…ÉUÁ‘…Ñ” (€Á…å±½…èI•½ÉñÍÑÉ¥¹œ°Õ¹­¹½İ¸ø°(€•ÉÉ½ÉÌèI•½ÉñÍÑÉ¥¹œ°ÍÑÉ¥¹œø°(¤èI•½ÉñÍÑÉ¥¹œ°Õ¹­¹½İ¸øì(€½¹ÍĞ…±±½İ•€ô¹•ÜM•Ğ¡l‰±…ÍÍe•…É%ˆ°€‰……‘•µ¥e•…É%ˆ°€‰¡…¹•Ìˆ°€‰É•…Í½¸‰t¤ì(€…‘‘U¹­¹½İ¹¥•±‘ÉÉ½ÉÌ¡Á…å±½…°…±±½İ•°€‰Á…å±½…¸ˆ°•ÉÉ½ÉÌ¤ì(€½¹ÍĞ¹½Éµ…±¥é•èI•½ÉñÍÑÉ¥¹œ°Õ¹­¹½İ¸ø€ôíôì(€½¹ÍĞ±…ÍÍe•…É%€ô¥‘•¹Ñ¥™¥•ÉY…±Õ” (€€€Á…å±½…°€‰±…ÍÍe•…É%ˆ°1MM}eI}%}AQQI8°€‰d´ÈÀÈØ´ÀÀÄˆ°ÑÉÕ”°•ÉÉ½ÉÌ°(€€¤ì(€½¹ÍĞ……‘•µ¥e•…É%€ôÙ…±¥‘…Ñ•…‘•µ¥e•…É% (€€€Á…å±½…°€‰……‘•µ¥e•…É%ˆ°ÑÉÕ”°•ÉÉ½ÉÌ°(€€¤ì(€½¹ÍĞÉ•…Í½¸€ôÍÑÉ¥¹Y…±Õ”¡Á…å±½…°€‰É•…Í½¸ˆ°ìµ…àè€Å|ÀÀÀô°•ÉÉ½ÉÌ¤ì(€½¹ÍĞ¡…¹•Ì€ôÉ•½É‘Y…±Õ”¡Á…å±½…°€‰¡…¹•Ìˆ°ÑÉÕ”°•ÉÉ½ÉÌ¤ì(€¥˜€¡±…ÍÍe•…É%¤¹½Éµ…±¥é•¹±…ÍÍe•…É%€ô±…ÍÍe•…É%ì(€¥˜€¡……‘•µ¥e•…É%¤¹½Éµ…±¥é•¹……‘•µ¥e•…É%€ô……‘•µ¥e•…É%ì(€¥˜€¡É•…Í½¸¤¹½Éµ…±¥é•¹É•…Í½¸€ôÉ•…Í½¸ì(€¥˜€ …¡…¹•Ì¤É•ÑÕÉ¸¹½Éµ…±¥é•ì((€½¹ÍĞ¹•ÍÑ•‘ÉÉ½ÉÌèI•½ÉñÍÑÉ¥¹œ°ÍÑÉ¥¹œø€ôíôì(€…‘‘U¹­¹½İ¹¥•±‘ÉÉ½ÉÌ (€€€¡…¹•Ì°(€€€¹•ÜM•Ğ¡l(€€€€€€‰É…‘”ˆ°€‰½‘”ˆ°€‰Ñ•…¡•ÉUÍ•É%ˆ°€‰Ñ•…¡•É9…µ”ˆ°€‰±½…Ñ¥½¹%ˆ°(€€€€€€‰±½…Ñ¥½¹9…µ”ˆ°€‰¹½Ñ•Ìˆ°(€€€t¤°(€€€€‰Á…å±½…¸ˆ°(€€€¹•ÍÑ•‘ÉÉ½ÉÌ°(€€¤ì(€¥˜€¡=‰©•Ğ¹­•åÌ¡¡…¹•Ì¤¹±•¹Ñ €ôôô€À¤¹•ÍÑ•‘ÉÉ½ÉÌ¹Á…å±½…€ô€‹BKBëBÃBÛF[FF0ƒFBûFBÀƒBÄƒBûBÓB÷FƒBßBóF[B÷F¸ˆì(€½¹ÍĞÉ•ÍÕ±ĞèI•½ÉñÍÑÉ¥¹œ°Õ¹­¹½İ¸ø€ôíôì(€½¹ÍĞÉ…‘”€ô¥¹Ñ••ÉY…±Õ”¡¡…¹•Ì°€‰É…‘”ˆ°€Ä°€ÄÄ°™…±Í”°¹•ÍÑ•‘ÉÉ½ÉÌ¤ì(€½¹ÍĞ½‘”€ôÙ…±¥‘…Ñ•±…ÍÍ½‘”¡¡…¹•Ì°€‰½‘”ˆ°™…±Í”°¹•ÍÑ•‘ÉÉ½ÉÌ¤ì(€½¹ÍĞÑ•…¡•È€ô‘¥É•Ñ½ÉåA…¥È (€€€¡…¹•Ì°€‰Ñ•…¡•ÉUÍ•É%ˆ°€‰Ñ•…¡•É9…µ”ˆ°UMI}%}AQQI8°€‰UMH´ÀÀÄˆ°(€€€™…±Í”°ÑÉÕ”°¹•ÍÑ•‘ÉÉ½ÉÌ°(€€¤ì(€½¹ÍĞ±½…Ñ¥½¸€ô‘¥É•Ñ½ÉåA…¥È (€€€¡…¹•Ì°€‰±½…Ñ¥½¹%ˆ°€‰±½…Ñ¥½¹9…µ”ˆ°1=Q%=9}%}AQQI8°€‰1=´ÀÀÄˆ°(€€€™…±Í”°ÑÉÕ”°¹•ÍÑ•‘ÉÉ½ÉÌ°(€€¤ì(€½¹ÍĞ¹½Ñ•Ì€ôÍÑÉ¥¹Y…±Õ”¡¡…¹•Ì°€‰¹½Ñ•Ìˆ°ìµ…àè€É|ÀÀÀô°¹•ÍÑ•‘ÉÉ½ÉÌ¤ì(€¥˜€¡±½…Ñ¥½¸¹±½…Ñ¥½¹%€ôôô€‰1=´ÀÀÜˆñğ±½…Ñ¥½¸¹±½…Ñ¥½¹%€ôôô€‰1=´ÀÀàˆ¤ì(€€€¹•ÍÑ•‘ÉÉ½ÉÍl‰Á…å±½…¹±½…Ñ¥½¹%‰t€ô€‹B‡BïFBÛBÇBûBËBÔƒBóF[FFBÔƒB÷BÔƒBóBûBÛBÔƒBÇFFBàƒBëBÃBÇF[B÷B×FBûBğƒBëBïBÃFF¸ˆì(€ô(€¥˜€¡É…‘”€„ôôÕ¹‘•™¥¹•¤É•ÍÕ±Ğ¹É…‘”€ôÉ…‘”ì(€¥˜€¡½‘”¤É•ÍÕ±Ğ¹½‘”€ô½‘”ì(€=‰©•Ğ¹…ÍÍ¥¸¡É•ÍÕ±Ğ°Ñ•…¡•È°±½…Ñ¥½¸¤ì(€¥˜€¡¹½Ñ•Ì¤É•ÍÕ±Ğ¹¹½Ñ•Ì€ô¹½Ñ•Ìì(€¥˜€¡=‰©•Ğ¹­•åÌ¡É•ÍÕ±Ğ¤¹±•¹Ñ €ôôô€À€˜˜=‰©•Ğ¹­•åÌ¡¹•ÍÑ•‘ÉÉ½ÉÌ¤¹±•¹Ñ €ôôô€À¤ì(€€€¹•ÍÑ•‘ÉÉ½ÉÌ¹Á…å±½…€ô€‹BKBëBÃBÛF[FF0ƒFBûFBÀƒBÄƒBûBÓB÷FƒB÷B×BÿBûFBûBÛB÷F8ƒBßBóF[B÷F¸ˆì(€ô(€½Áå9•ÍÑ•‘ÉÉ½ÉÌ¡¹•ÍÑ•‘ÉÉ½ÉÌ°€‰¡…¹•Ìˆ°•ÉÉ½ÉÌ¤ì(€¹½Éµ…±¥é•¹¡…¹•Ì€ôÉ•ÍÕ±Ğì(€É•ÑÕÉ¸¹½Éµ…±¥é•ì)ô()™Õ¹Ñ¥½¸Ù…±¥‘…Ñ•±…ÍÍe•…É±½Í” (€Á…å±½…èI•½ÉñÍÑÉ¥¹œ°Õ¹­¹½İ¸ø°(€•ÉÉ½ÉÌèI•½ÉñÍÑÉ¥¹œ°ÍÑÉ¥¹œø°(¤èI•½ÉñÍÑÉ¥¹œ°Õ¹­¹½İ¸øì(€½¹ÍĞ…±±½İ•€ô¹•ÜM•Ğ¡l(€€€€‰±…ÍÍe•…É%ˆ°€‰…ÑÕ…±±½Í•‘…Ñ”ˆ°€‰É•…Í½¸ˆ°€‰±½Í•½¡½ÉĞˆ°€‰¹½Ñ•Ìˆ°(€t¤ì(€…‘‘U¹­¹½İ¹¥•±‘ÉÉ½ÉÌ¡Á…å±½…°…±±½İ•°€‰Á…å±½…¸ˆ°•ÉÉ½ÉÌ¤ì(€½¹ÍĞ¹½Éµ…±¥é•èI•½ÉñÍÑÉ¥¹œ°Õ¹­¹½İ¸ø€ôíôì(€½¹ÍĞ±…ÍÍe•…É%€ô¥‘•¹Ñ¥™¥•ÉY…±Õ” (€€€Á…å±½…°€‰±…ÍÍe•…É%ˆ°1MM}eI}%}AQQI8°€‰d´ÈÀÈØ´ÀÀÄˆ°ÑÉÕ”°•ÉÉ½ÉÌ°(€€¤ì(€½¹ÍĞ…ÑÕ…±±½Í•‘…Ñ”€ô¹½Éµ…±¥é•‘…Ñ” (€€€Á…å±½…°€‰…ÑÕ…±±½Í•‘…Ñ”ˆ°•ÉÉ½ÉÌ°ÑÉÕ”°(€€¤ì(€½¹ÍĞÉ•…Í½¸€ô•¹ÕµY…±Õ” (€€€Á…å±½…°(€€€€‰É•…Í½¸ˆ°(€€€l‰±½Í•ˆ°€‰µ•É•ˆ°€‰É…‘Õ…Ñ•ˆ°€‰É•½É…¹¥é•ˆ°€‰½Ñ¡•È‰t…Ì½¹ÍĞ°(€€€ÑÉÕ”°(€€€•ÉÉ½ÉÌ°(€€¤ì(€½¹ÍĞ±½Í•½¡½ÉĞ€ô‰½½±•…¹Y…±Õ”¡Á…å±½…°€‰±½Í•½¡½ÉĞˆ°ÑÉÕ”°•ÉÉ½ÉÌ¤ì(€½¹ÍĞ¹½Ñ•Ì€ôÍÑÉ¥¹Y…±Õ”¡Á…å±½…°€‰¹½Ñ•Ìˆ°ìµ…àè€É|ÀÀÀô°•ÉÉ½ÉÌ¤ì(€¥˜€¡É•…Í½¸€ôôô€‰½Ñ¡•Èˆ€˜˜€…¹½Ñ•Ì¤ì(€€€•ÉÉ½ÉÍl‰Á…å±½…¹¹½Ñ•Ì‰t€ô€‹B{BÿBãF#F[FF0ƒF[B÷F#FƒBÿFBãFBãB÷FƒBßBÃBëFBãFFF<ƒBëBïBÃFF¸ˆì(€ô(€¥˜€¡±…ÍÍe•…É%¤¹½Éµ…±¥é•¹±…ÍÍe•…É%€ô±…ÍÍe•…É%ì(€¥˜€¡…ÑÕ…±±½Í•‘…Ñ”¤¹½Éµ…±¥é•¹…ÑÕ…±±½Í•‘…Ñ”€ô…ÑÕ…±±½Í•‘…Ñ”ì(€¥˜€¡É•…Í½¸¤¹½Éµ…±¥é•¹É•…Í½¸€ôÉ•…Í½¸ì(€¥˜€¡±½Í•½¡½ÉĞ€„ôôÕ¹‘•™¥¹•¤¹½Éµ…±¥é•¹±½Í•½¡½ÉĞ€ô±½Í•½¡½ÉĞì(€¥˜€¡¹½Ñ•Ì¤¹½Éµ…±¥é•¹¹½Ñ•Ì€ô¹½Ñ•Ìì(€É•ÑÕÉ¸¹½Éµ…±¥é•ì)ô()™Õ¹Ñ¥½¸Ù…±¥‘…Ñ•I½±±½Ù•É±…ÍÌ (€¥Ñ•´èI•½ÉñÍÑÉ¥¹œ°Õ¹­¹½İ¸ø°(€•ÉÉ½ÉÌèI•½ÉñÍÑÉ¥¹œ°ÍÑÉ¥¹œø°(¤èI•½ÉñÍÑÉ¥¹œ°Õ¹­¹½İ¸øì(€½¹ÍĞ…±±½İ•€ô¹•ÜM•Ğ¡l(€€€€‰Í½ÕÉ•±…ÍÍe•…É%ˆ°€‰½¡½ÉÑ%ˆ°€‰Í½ÕÉ•É…‘”ˆ°€‰…Ñ¥½¸ˆ°€‰Ñ…É•ÑÉ…‘”ˆ°(€€€€‰Ñ…É•Ñ½‘”ˆ°€‰Ñ•…¡•ÉUÍ•É%ˆ°€‰Ñ•…¡•É9…µ”ˆ°€‰±½…Ñ¥½¹%ˆ°€‰±½…Ñ¥½¹9…µ”ˆ°(€€€€‰½Ù•ÉÉ¥‘•I•…Í½¸ˆ°€‰¹½Ñ•Ìˆ°(€t¤ì(€…‘‘U¹­¹½İ¹¥•±‘ÉÉ½ÉÌ¡¥Ñ•´°…±±½İ•°€‰Á…å±½…¸ˆ°•ÉÉ½ÉÌ¤ì(€½¹ÍĞÉ•ÍÕ±ĞèI•½ÉñÍÑÉ¥¹œ°Õ¹­¹½İ¸ø€ôíôì(€½¹ÍĞÍ½ÕÉ•±…ÍÍe•…É%€ô¥‘•¹Ñ¥™¥•ÉY…±Õ” (€€€¥Ñ•´°€‰Í½ÕÉ•±…ÍÍe•…É%ˆ°1MM}eI}%}AQQI8°€‰d´ÈÀÈØ´ÀÀÄˆ°ÑÉÕ”°•ÉÉ½ÉÌ°(€€¤ì(€½¹ÍĞ½¡½ÉÑ%€ô¥‘•¹Ñ¥™¥•ÉY…±Õ” (€€€¥Ñ•´°€‰½¡½ÉÑ%ˆ°=!=IQ}%}AQQI8°€‰= ´ÀÀÄˆ°ÑÉÕ”°•ÉÉ½ÉÌ°(€€¤ì(€½¹ÍĞÍ½ÕÉ•É…‘”€ô¥¹Ñ••ÉY…±Õ”¡¥Ñ•´°€‰Í½ÕÉ•É…‘”ˆ°€Ä°€ÄÄ°ÑÉÕ”°•ÉÉ½ÉÌ¤ì(€½¹ÍĞ…Ñ¥½¸€ô•¹ÕµY…±Õ” (€€€¥Ñ•´°€‰…Ñ¥½¸ˆ°l‰ÁÉ½µ½Ñ”ˆ°€‰É…‘Õ…Ñ”ˆ°€‰±½Í”ˆ°€‰Í­¥À‰t…Ì½¹ÍĞ°ÑÉÕ”°•ÉÉ½ÉÌ°(€€¤ì(€½¹ÍĞÑ…É•ÑÉ…‘”€ô¥¹Ñ••ÉY…±Õ”¡¥Ñ•´°€‰Ñ…É•ÑÉ…‘”ˆ°€Ä°€ÄÄ°™…±Í”°•ÉÉ½ÉÌ¤ì(€½¹ÍĞÑ…É•Ñ½‘”€ôÙ…±¥‘…Ñ•±…ÍÍ½‘”¡¥Ñ•´°€‰Ñ…É•Ñ½‘”ˆ°™…±Í”°•ÉÉ½ÉÌ¤ì(€½¹ÍĞÑ•…¡•È€ô‘¥É•Ñ½ÉåA…¥È (€€€¥Ñ•´°€‰Ñ•…¡•ÉUÍ•É%ˆ°€‰Ñ•…¡•É9…µ”ˆ°UMI}%}AQQI8°€‰UMH´ÀÀÄˆ°(€€€™…±Í”°™…±Í”°•ÉÉ½ÉÌ°(€€¤ì(€½¹ÍĞ±½…Ñ¥½¸€ô‘¥É•Ñ½ÉåA…¥È (€€€¥Ñ•´°€‰±½…Ñ¥½¹%ˆ°€‰±½…Ñ¥½¹9…µ”ˆ°1=Q%=9}%}AQQI8°€‰1=´ÀÀÄˆ°(€€€™…±Í”°™…±Í”°•ÉÉ½ÉÌ°(€€¤ì(€½¹ÍĞ½Ù•ÉÉ¥‘•I•…Í½¸€ôÍÑÉ¥¹Y…±Õ”¡¥Ñ•´°€‰½Ù•ÉÉ¥‘•I•…Í½¸ˆ°ìµ…àè€Å|ÀÀÀô°•ÉÉ½ÉÌ¤ì(€½¹ÍĞ¹½Ñ•Ì€ôÍÑÉ¥¹Y…±Õ”¡¥Ñ•´°€‰¹½Ñ•Ìˆ°ìµ…àè€É|ÀÀÀô°•ÉÉ½ÉÌ¤ì((€¥˜€¡…Ñ¥½¸€ôôô€‰ÁÉ½µ½Ñ”ˆ¤ì(€€€¥˜€¡Í½ÕÉ•É…‘”€ôôô€ÄÄ¤ì(€€€€€•ÉÉ½ÉÍl‰Á…å±½…¹…Ñ¥½¸‰t€ô€ˆÄÄƒBëBïBÃFƒB÷BÔƒBóBûBÛB÷BÀƒBÿB×FB×BËBûBÓBãFBàƒBÓBø€ÄÈƒBëBïBÃFF¸ˆì(€€€ô(€€€¥˜€¡Ñ…É•ÑÉ…‘”€ôôôÕ¹‘•™¥¹•¤•ÉÉ½ÉÍl‰Á…å±½…¹Ñ…É•ÑÉ…‘”‰t€ô€‹BKBëBÃBÛF[FF0ƒB÷BûBËFƒBÿBÃFBÃBïB×BïF0¸ˆì(€€€¥˜€ …Ñ…É•Ñ½‘”¤•ÉÉ½ÉÍl‰Á…å±½…¹Ñ…É•Ñ½‘”‰t€ô€‹BKBëBÃBÛF[FF0ƒBëBûBĞƒB÷BûBËBûBÏBøƒBëBïBÃFF¸ˆì(€€€¥˜€ (€€€€€Í½ÕÉ•É…‘”€„ôôÕ¹‘•™¥¹•€˜˜Ñ…É•ÑÉ…‘”€„ôôÕ¹‘•™¥¹•€˜˜(€€€€€Ñ…É•ÑÉ…‘”€„ôôÍ½ÕÉ•É…‘”€¬€Ä€˜˜€…½Ù•ÉÉ¥‘•I•…Í½¸(€€€€¤ì(€€€€€•ÉÉ½ÉÍl‰Á…å±½…¹½Ù•ÉÉ¥‘•I•…Í½¸‰t€ô(€€€€€€€€‹BBûF?FB÷F[FF0ƒBÿB×FB×FF[BĞƒB÷BÔƒBÓBøƒB÷BÃFFFBÿB÷BûF\ƒBÿBÃFBÃBïB×BïFX¸ˆì(€€€ô(€ô•±Í”¥˜€¡Ñ…É•ÑÉ…‘”€„ôôÕ¹‘•™¥¹•ñğÑ…É•Ñ½‘”¤ì(€€€•ÉÉ½ÉÍl‰Á…å±½…¹Ñ…É•ÑÉ…‘”‰t€ô(€€€€€€‹B›F[BïF3BûBËBãBäƒBëBïBÃFƒBßBÃBÓBÃFSFF3FF<ƒBïBãF#BÔƒBÓBïF<ƒBÓF[F\ƒ
¯BB×FB×BËB×FFBã
ì¸ˆì(€ô(€¥˜€¡…Ñ¥½¸€ôôô€‰É…‘Õ…Ñ”ˆ€˜˜Í½ÕÉ•É…‘”€„ôôÕ¹‘•™¥¹•€˜˜Í½ÕÉ•É…‘”€„ôô€ÄÄ¤ì(€€€•ÉÉ½ÉÍl‰Á…å±½…¹…Ñ¥½¸‰t€ô€‹BKBãBÿFFBèƒBßBÃFFBûFBûBËFFSFF3FF<ƒBïBãF#BÔƒBÓBø€ÄÄƒBëBïBÃFF¸ˆì(€ô(€¥˜€¡±½…Ñ¥½¸¹±½…Ñ¥½¹%€ôôô€‰1=´ÀÀÜˆñğ±½…Ñ¥½¸¹±½…Ñ¥½¹%€ôôô€‰1=´ÀÀàˆ¤ì(€€€•ÉÉ½ÉÍl‰Á…å±½…¹±½…Ñ¥½¹%‰t€ô€‹B‡BïFBÛBÇBûBËBÔƒBóF[FFBÔƒB÷BÔƒBóBûBÛBÔƒBÇFFBàƒBëBÃBÇF[B÷B×FBûBğƒBëBïBÃFF¸ˆì(€ô((€¥˜€¡Í½ÕÉ•±…ÍÍe•…É%¤É•ÍÕ±Ğ¹Í½ÕÉ•±…ÍÍe•…É%€ôÍ½ÕÉ•±…ÍÍe•…É%ì(€¥˜€¡½¡½ÉÑ%¤É•ÍÕ±Ğ¹½¡½ÉÑ%€ô½¡½ÉÑ%ì(€¥˜€¡Í½ÕÉ•É…‘”€„ôôÕ¹‘•™¥¹•¤É•ÍÕ±Ğ¹Í½ÕÉ•É…‘”€ôÍ½ÕÉ•É…‘”ì(€¥˜€¡…Ñ¥½¸¤É•ÍÕ±Ğ¹…Ñ¥½¸€ô…Ñ¥½¸ì(€¥˜€¡Ñ…É•ÑÉ…‘”€„ôôÕ¹‘•™¥¹•¤É•ÍÕ±Ğ¹Ñ…É•ÑÉ…‘”€ôÑ…É•ÑÉ…‘”ì(€¥˜€¡Ñ…É•Ñ½‘”¤É•ÍÕ±Ğ¹Ñ…É•Ñ½‘”€ôÑ…É•Ñ½‘”ì(€=‰©•Ğ¹…ÍÍ¥¸¡É•ÍÕ±Ğ°Ñ•…¡•È°±½…Ñ¥½¸¤ì(€¥˜€¡½Ù•ÉÉ¥‘•I•…Í½¸¤É•ÍÕ±Ğ¹½Ù•ÉÉ¥‘•I•…Í½¸€ô½Ù•ÉÉ¥‘•I•…Í½¸ì(€¥˜€¡¹½Ñ•Ì¤É•ÍÕ±Ğ¹¹½Ñ•Ì€ô¹½Ñ•Ìì(€É•ÑÕÉ¸É•ÍÕ±Ğì)ô()™Õ¹Ñ¥½¸Ù…±¥‘…Ñ•…‘•µ¥e•…ÉI½±±½Ù•È (€Á…å±½…èI•½ÉñÍÑÉ¥¹œ°Õ¹­¹½İ¸ø°(€•ÉÉ½ÉÌèI•½ÉñÍÑÉ¥¹œ°ÍÑÉ¥¹œø°(¤èI•½ÉñÍÑÉ¥¹œ°Õ¹­¹½İ¸øì(€½¹ÍĞ…±±½İ•€ô¹•ÜM•Ğ¡l(€€€€‰Í½ÕÉ•e•…É%ˆ°€‰Ñ…É•Ñe•…É%ˆ°€‰•™™•Ñ¥Ù•…Ñ”ˆ°€‰±…ÍÍ•Ìˆ°€‰¹½Ñ•Ìˆ°(€t¤ì(€…‘‘U¹­¹½İ¹¥•±‘ÉÉ½ÉÌ¡Á…å±½…°…±±½İ•°€‰Á…å±½…¸ˆ°•ÉÉ½ÉÌ¤ì(€½¹ÍĞ¹½Éµ…±¥é•èI•½ÉñÍÑÉ¥¹œ°Õ¹­¹½İ¸ø€ôíôì(€½¹ÍĞÍ½ÕÉ•e•…É%€ôÙ…±¥‘…Ñ•…‘•µ¥e•…É%¡Á…å±½…°€‰Í½ÕÉ•e•…É%ˆ°ÑÉÕ”°•ÉÉ½ÉÌ¤ì(€½¹ÍĞÑ…É•Ñe•…É%€ôÙ…±¥‘…Ñ•…‘•µ¥e•…É%¡Á…å±½…°€‰Ñ…É•Ñe•…É%ˆ°ÑÉÕ”°•ÉÉ½ÉÌ¤ì(€½¹ÍĞ•™™•Ñ¥Ù•…Ñ”€ô¹½Éµ…±¥é•‘…Ñ”¡Á…å±½…°€‰•™™•Ñ¥Ù•…Ñ”ˆ°•ÉÉ½ÉÌ°ÑÉÕ”¤ì(€½¹ÍĞ¹½Ñ•Ì€ôÍÑÉ¥¹Y…±Õ”¡Á…å±½…°€‰¹½Ñ•Ìˆ°ìµ…àè€É|ÀÀÀô°•ÉÉ½ÉÌ¤ì(€½¹ÍĞÉ…İ±…ÍÍ•Ì€ôÁ…å±½…¹±…ÍÍ•Ìì(€½¹ÍĞ±…ÍÍ•ÌèI•½ÉñÍÑÉ¥¹œ°Õ¹­¹½İ¸ùmt€ômtì((€¥˜€ …ÉÉ…ä¹¥ÍÉÉ…ä¡É…İ±…ÍÍ•Ì¤ñğÉ…İ±…ÍÍ•Ì¹±•¹Ñ €ôôô€ÀñğÉ…İ±…ÍÍ•Ì¹±•¹Ñ €ø€ÄÀÀ¤ì(€€€•ÉÉ½ÉÍl‰Á…å±½…¹±…ÍÍ•Ì‰t€ô€‹BSBûBÓBÃBçFBÔƒBËF[BĞ€ÄƒBÓBø€ÄÀÀƒBëBïBÃFF[BÈƒBÓBïF<ƒBÿB×FB×FBûBÓF¸ˆì(€ô•±Í”ì(€€€½¹ÍĞÍ½ÕÉ•%‘Ì€ô¹•ÜM•ĞñÍÑÉ¥¹œø ¤ì(€€€½¹ÍĞ½¡½ÉÑÌ€ô¹•ÜM•ĞñÍÑÉ¥¹œø ¤ì(€€€½¹ÍĞÑ…É•Ñ9…µ•Ì€ô¹•ÜM•ĞñÍÑÉ¥¹œø ¤ì(€€€É…İ±…ÍÍ•Ì¹™½É…  ¡É…Ü°¥¹‘•à¤€ôøì(€€€€€¥˜€ …¥ÍI•½É¡É…Ü¤¤ì(€€€€€€€•ÉÉ½ÉÍmÁ…å±½…¹±…ÍÍ•Ì¸‘í¥¹‘•áõt€ô€‹B{FF[BëFFSFF3FF<)M=8·BûBÇŠgFSBëF¸ˆì(€€€€€€€É•ÑÕÉ¸ì(€€€€€ô(€€€€€½¹ÍĞ¹•ÍÑ•‘ÉÉ½ÉÌèI•½ÉñÍÑÉ¥¹œ°ÍÑÉ¥¹œø€ôíôì(€€€€€½¹ÍĞ¥Ñ•´€ôÙ…±¥‘…Ñ•I½±±½Ù•É±…ÍÌ¡É…Ü°¹•ÍÑ•‘ÉÉ½ÉÌ¤ì(€€€€€½¹ÍĞÍ½ÕÉ•%€ô¥Ñ•´¹Í½ÕÉ•±…ÍÍe•…É%ì(€€€€€½¹ÍĞ½¡½ÉÑ%€ô¥Ñ•´¹½¡½ÉÑ%ì(€€€€€¥˜€¡ÑåÁ•½˜Í½ÕÉ•%€ôôô€‰ÍÑÉ¥¹œˆ¤ì(€€€€€€€¥˜€¡Í½ÕÉ•%‘Ì¹¡…Ì¡Í½ÕÉ•%¤¤¹•ÍÑ•‘ÉÉ½ÉÍl‰Á…å±½…¹Í½ÕÉ•±…ÍÍe•…É%‰t€ô€‹BkBïBÃFƒBÿBûBËFBûFF;FSFF3FF<¸ˆì(€€€€€€€Í½ÕÉ•%‘Ì¹…‘¡Í½ÕÉ•%¤ì(€€€€€ô(€€€€€¥˜€¡ÑåÁ•½˜½¡½ÉÑ%€ôôô€‰ÍÑÉ¥¹œˆ¤ì(€€€€€€€¥˜€¡½¡½ÉÑÌ¹¡…Ì¡½¡½ÉÑ%¤¤¹•ÍÑ•‘ÉÉ½ÉÍl‰Á…å±½…¹½¡½ÉÑ%‰t€ô€‹BkBïBÃFB÷BÀƒBÏFFBÿBÀƒBÿBûBËFBûFF;FSFF3FF<¸ˆì(€€€€€€€½¡½ÉÑÌ¹…‘¡½¡½ÉÑ%¤ì(€€€€€ô(€€€€€¥˜€¡¥Ñ•´¹…Ñ¥½¸€ôôô€‰ÁÉ½µ½Ñ”ˆ¤ì(€€€€€€€½¹ÍĞÑ…É•Ñ9…µ”€ô€‘í¥Ñ•´¹Ñ…É•ÑÉ…‘•ô´‘íMÑÉ¥¹œ¡¥Ñ•´¹Ñ…É•Ñ½‘”¤¹Ñ½1½…±•UÁÁ•É…Í” ‰Õ¬µUˆ¥õ€ì(€€€€€€€¥˜€¡Ñ…É•Ñ9…µ•Ì¹¡…Ì¡Ñ…É•Ñ9…µ”¤¤¹•ÍÑ•‘ÉÉ½ÉÍl‰Á…å±½…¹Ñ…É•Ñ½‘”‰t€ô€‹B›F[BïF3BûBËBÀƒB÷BÃBßBËBÀƒBëBïBÃFFƒBÿBûBËFBûFF;FSFF3FF<¸ˆì(€€€€€€€Ñ…É•Ñ9…µ•Ì¹…‘¡Ñ…É•Ñ9…µ”¤ì(€€€€€ô(€€€€€½Áå9•ÍÑ•‘ÉÉ½ÉÌ¡¹•ÍÑ•‘ÉÉ½ÉÌ°±…ÍÍ•Ì¸‘í¥¹‘•áõ€°•ÉÉ½ÉÌ¤ì(€€€€€±…ÍÍ•Ì¹ÁÕÍ ¡¥Ñ•´¤ì(€€€ô¤ì(€ô((€¥˜€¡Í½ÕÉ•e•…É%€˜˜Ñ…É•Ñe•…É%€˜˜Í½ÕÉ•e•…É%€ôôôÑ…É•Ñe•…É%¤ì(€€€•ÉÉ½ÉÍl‰Á…å±½…¹Ñ…É•Ñe•…É%‰t€ô€‹B›F[BïF3BûBËBãBäƒB÷BÃBËFBÃBïF3B÷BãBäƒFF[BèƒBóBÃFPƒBËF[BÓFF[BßB÷F?FBãFF<¸ˆì(€ô(€½¹ÍĞÍ½ÕÉ•5…Ñ €ôÍ½ÕÉ•e•…É%ü¹µ…Ñ ¡5%}eI}%}AQQI8¤ì(€½¹ÍĞÑ…É•Ñ5…Ñ €ôÑ…É•Ñe•…É%ü¹µ…Ñ ¡5%}eI}%}AQQI8¤ì(€¥˜€¡Í½ÕÉ•5…Ñ €˜˜Ñ…É•Ñ5…Ñ €˜˜9Õµ‰•È¡Ñ…É•Ñ5…Ñ¡lÅt¤€„ôô9Õµ‰•È¡Í½ÕÉ•5…Ñ¡lÅt¤€¬€Ä¤ì(€€€•ÉÉ½ÉÍl‰Á…å±½…¹Ñ…É•Ñe•…É%‰t€ô€‹B›F[BïF3BûBËBãBäƒB÷BÃBËFBÃBïF3B÷BãBäƒFF[BèƒBóBÃFPƒBÇFFBàƒB÷BÃFFFBÿB÷BãBğ¸ˆì(€ô((€¥˜€¡Í½ÕÉ•e•…É%¤¹½Éµ…±¥é•¹Í½ÕÉ•e•…É%€ôÍ½ÕÉ•e•…É%ì(€¥˜€¡Ñ…É•Ñe•…É%¤¹½Éµ…±¥é•¹Ñ…É•Ñe•…É%€ôÑ…É•Ñe•…É%ì(€¥˜€¡•™™•Ñ¥Ù•…Ñ”¤¹½Éµ…±¥é•¹•™™•Ñ¥Ù•…Ñ”€ô•™™•Ñ¥Ù•…Ñ”ì(€¥˜€¡±…ÍÍ•Ì¹±•¹Ñ €ø€À¤¹½Éµ…±¥é•¹±…ÍÍ•Ì€ô±…ÍÍ•Ìì(€¥˜€¡¹½Ñ•Ì¤¹½Éµ…±¥é•¹¹½Ñ•Ì€ô¹½Ñ•Ìì(€É•ÑÕÉ¸¹½Éµ…±¥é•ì)ô()•áÁ½ÉĞ™Õ¹Ñ¥½¸Ù…±¥‘…Ñ•É…™Ñ%¹ÁÕĞ (€¥¹ÁÕĞèI•½ÉñÍÑÉ¥¹œ°Õ¹­¹½İ¸ø°(¤èÉ…™ÑY…±¥‘…Ñ¥½¹I•ÍÕ±Ğì(€½¹ÍĞ•ÉÉ½ÉÌèI•½ÉñÍÑÉ¥¹œ°ÍÑÉ¥¹œø€ôíôì(€…‘‘U¹­¹½İ¹¥•±‘ÉÉ½ÉÌ (€€€¥¹ÁÕĞ°(€€€¹•ÜM•Ğ¡l‰¥ˆ°€‰É•Ù¥Í¥½¸ˆ°€‰É½ÕÁ%ˆ°€‰­¥¹ˆ°€‰Á…å±½…‰t¤°(€€€€ˆˆ°(€€€•ÉÉ½ÉÌ°(€€¤ì((€½¹ÍĞ¥€ô¥¹ÁÕĞ¹¥ì(€¥˜€¡¥€„ôôÕ¹‘•™¥¹•€˜˜€¡ÑåÁ•½˜¥€„ôô€‰ÍÑÉ¥¹œˆñğ€…¥ÍÉ…™Ñ%¡¥¤¤¤ì(€€€•ÉÉ½ÉÌ¹¥€ô€‹BwB×BëBûFB×BëFB÷BãBäƒF[BÓB×B÷FBãFF[BëBÃFBûF ƒFB×FB÷B×FBëBà¸ˆì(€ô((€½¹ÍĞÉ•Ù¥Í¥½¸€ô¥¹ÁÕĞ¹É•Ù¥Í¥½¸ì(€¥˜€ (€€€É•Ù¥Í¥½¸€„ôôÕ¹‘•™¥¹•€˜˜(€€€€¡ÑåÁ•½˜É•Ù¥Í¥½¸€„ôô€‰¹Õµ‰•Èˆñğ€…9Õµ‰•È¹¥Í%¹Ñ••È¡É•Ù¥Í¥½¸¤ñğÉ•Ù¥Í¥½¸€ğ€Äñğ(€€€€€É•Ù¥Í¥½¸€ø€É|ÄĞİ|ĞàÍ|ØĞÜ¤(€€¤ì(€€€•ÉÉ½ÉÌ¹É•Ù¥Í¥½¸€ô€‹BƒB×BËF[BßF[F<ƒFB×FB÷B×FBëBàƒBóBÃFPƒBÇFFBàƒBÓBûBÓBÃFB÷BãBğƒFF[BïBãBğƒFBãFBïBûBğ¸ˆì(€ô(€¥˜€¡É•Ù¥Í¥½¸€„ôôÕ¹‘•™¥¹•€˜˜¥€ôôôÕ¹‘•™¥¹•¤ì(€€€•ÉÉ½ÉÌ¹É•Ù¥Í¥½¸€ô€‹BƒB×BËF[BßF[F8ƒBóBûBÛB÷BÀƒBÿB×FB×BÓBÃFBàƒBïBãF#BÔƒBÓBïF<ƒB÷BÃF?BËB÷BûF\ƒFB×FB÷B×FBëBà¸ˆì(€ô((€½¹ÍĞÉ½ÕÁ%€ô¥¹ÁÕĞ¹É½ÕÁ%ì(€¥˜€¡É½ÕÁ%€„ôôÕ¹‘•™¥¹•€˜˜€¡ÑåÁ•½˜É½ÕÁ%€„ôô€‰ÍÑÉ¥¹œˆñğ€…¥ÍÉ…™Ñ%¡É½ÕÁ%¤¤¤ì(€€€•ÉÉ½ÉÌ¹É½ÕÁ%€ô€‹BwB×BëBûFB×BëFB÷BãBäƒF[BÓB×B÷FBãFF[BëBÃFBûF ƒBÏFFBÿBàƒFB×FB÷B×FBûBè¸ˆì(€ô((€½¹ÍĞ­¥¹€ô¥¹ÁÕĞ¹­¥¹ì(€¥˜€¡ÑåÁ•½˜­¥¹€„ôô€‰ÍÑÉ¥¹œˆñğ€…IQ}-%9L¹¥¹±Õ‘•Ì¡­¥¹…ÌÉ…™Ñ-¥¹¤¤ì(€€€•ÉÉ½ÉÌ¹­¥¹€ô€‹B{BÇB×FF[FF0ƒBÿF[BÓFFBãBóFBËBÃB÷BãBäƒFBãBüƒBûBÿB×FBÃFF[F\¸ˆì(€ô((€¥˜€ …¥ÍI•½É¡¥¹ÁÕĞ¹Á…å±½…¤¤ì(€€€•ÉÉ½ÉÌ¹Á…å±½…€ô€‹BSBÃB÷FXƒFB×FB÷B×FBëBàƒBóBÃF;FF0ƒBÇFFBà)M=8·BûBÇŠgFSBëFBûBğ¸ˆì(€ô(€¥˜€¡=‰©•Ğ¹­•åÌ¡•ÉÉ½ÉÌ¤¹±•¹Ñ €ø€Àñğ€…¥ÍI•½É¡¥¹ÁÕĞ¹Á…å±½…¤ñğ(€€€€€ÑåÁ•½˜­¥¹€„ôô€‰ÍÑÉ¥¹œˆñğ€…IQ}-%9L¹¥¹±Õ‘•Ì¡­¥¹…ÌÉ…™Ñ-¥¹¤¤ì(€€€É•ÑÕÉ¸ì½¬è™…±Í”°™¥•±‘ÉÉ½ÉÌè•ÉÉ½ÉÌôì(€ô((€½¹ÍĞ™½ÉµÕ±…A…Ñ €ô™¥¹‘½ÉµÕ±…%¹©•Ñ¥½¸¡¥¹ÁÕĞ¹Á…å±½…¤ì(€¥˜€¡™½ÉµÕ±…A…Ñ ¤ì(€€€•ÉÉ½ÉÍm™½ÉµÕ±…A…Ñ¡t€ô(€€€€€€‹B_B÷BÃFB×B÷B÷F<ƒB÷BÔƒBóBûBÛBÔƒBÿBûFBãB÷BÃFBãFF<ƒF[BÜƒFBãBóBËBûBïFƒFBûFBóFBïBà€ ô°€¬°€´° ¤¸ˆì(€ô((€±•ĞÁ…å±½…èI•½ÉñÍÑÉ¥¹œ°Õ¹­¹½İ¸ø€ôíôì(€Íİ¥Ñ €¡­¥¹…ÌÉ…™Ñ-¥¹¤ì(€€€…Í”€‰µ…Ñ•É¥…°¹É•…Ñ”ˆè(€€€€€Á…å±½…€ôÙ…±¥‘…Ñ•5…Ñ•É¥…°¡¥¹ÁÕĞ¹Á…å±½…°•ÉÉ½ÉÌ¤ì(€€€€€‰É•…¬ì(€€€…Í”€‰µ…Ñ•É¥…°¹ÕÁ‘…Ñ”ˆè(€€€€€Á…å±½…€ôÙ…±¥‘…Ñ•5…Ñ•É¥…±UÁ‘…Ñ”¡¥¹ÁÕĞ¹Á…å±½…°•ÉÉ½ÉÌ¤ì(€€€€€‰É•…¬ì(€€€…Í”€‰É••¥ÁĞ¹É•…Ñ”ˆè(€€€€€Á…å±½…€ôÙ…±¥‘…Ñ•I••¥ÁĞ¡¥¹ÁÕĞ¹Á…å±½…°•ÉÉ½ÉÌ¤ì(€€€€€‰É•…¬ì(€€€…Í”€‰ÑÉ…¹Í™•È¹É•…Ñ”ˆè(€€€€€Á…å±½…€ôÙ…±¥‘…Ñ•QÉ…¹Í™•È¡¥¹ÁÕĞ¹Á…å±½…°•ÉÉ½ÉÌ¤ì(€€€€€‰É•…¬ì(€€€…Í”€‰İÉ¥Ñ•½™˜¹É•…Ñ”ˆè(€€€€€Á…å±½…€ôÙ…±¥‘…Ñ•]É¥Ñ•½™˜¡¥¹ÁÕĞ¹Á…å±½…°•ÉÉ½ÉÌ¤ì(€€€€€‰É•…¬ì(€€€…Í”€‰É•Ù¥Í¥½¸¹½Õ¹Ğˆè(€€€€€Á…å±½…€ôÙ…±¥‘…Ñ•I•Ù¥Í¥½¸¡¥¹ÁÕĞ¹Á…å±½…°•ÉÉ½ÉÌ¤ì(€€€€€‰É•…¬ì(€€€…Í”€‰……‘•µ¥Œµå•…È¹É•…Ñ”ˆè(€€€€€Á…å±½…€ôÙ…±¥‘…Ñ•…‘•µ¥e•…È¡¥¹ÁÕĞ¹Á…å±½…°•ÉÉ½ÉÌ¤ì(€€€€€‰É•…¬ì(€€€…Í”€‰±…ÍÌµå•…È¹É•…Ñ”ˆè(€€€€€Á…å±½…€ôÙ…±¥‘…Ñ•±…ÍÍe•…ÉÉ•…Ñ”¡¥¹ÁÕĞ¹Á…å±½…°•ÉÉ½ÉÌ¤ì(€€€€€‰É•…¬ì(€€€…Í”€‰±…ÍÌµå•…È¹ÕÁ‘…Ñ”ˆè(€€€€€Á…å±½…€ôÙ…±¥‘…Ñ•±…ÍÍe•…ÉUÁ‘…Ñ”¡¥¹ÁÕĞ¹Á…å±½…°•ÉÉ½ÉÌ¤ì(€€€€€‰É•…¬ì(€€€…Í”€‰±…ÍÌµå•…È¹±½Í”ˆè(€€€€€Á…å±½…€ôÙ…±¥‘…Ñ•±…ÍÍe•…É±½Í”¡¥¹ÁÕĞ¹Á…å±½…°•ÉÉ½ÉÌ¤ì(€€€€€‰É•…¬ì(€€€…Í”€‰……‘•µ¥Œµå•…È¹É½±±½Ù•Èˆè(€€€€€Á…å±½…€ôÙ…±¥‘…Ñ•…‘•µ¥e•…ÉI½±±½Ù•È¡¥¹ÁÕĞ¹Á…å±½…°•ÉÉ½ÉÌ¤ì(€€€€€‰É•…¬ì(€ô((€¥˜€¡=‰©•Ğ¹­•åÌ¡•ÉÉ½ÉÌ¤¹±•¹Ñ €ø€À¤ì(€€€É•ÑÕÉ¸ì½¬è™…±Í”°™¥•±‘ÉÉ½ÉÌè•ÉÉ½ÉÌôì(€ô((€É•ÑÕÉ¸ì(€€€½¬èÑÉÕ”°(€€€Ù…±Õ”èì(€€€€€€¸¸¸¡ÑåÁ•½˜¥€ôôô€‰ÍÑÉ¥¹œˆ€üì¥ô€èíô¤°(€€€€€€¸¸¸¡ÑåÁ•½˜É•Ù¥Í¥½¸€ôôô€‰¹Õµ‰•Èˆ€üìÉ•Ù¥Í¥½¸ô€èíô¤°(€€€€€€¸¸¸¡ÑåÁ•½˜É½ÕÁ%€ôôô€‰ÍÑÉ¥¹œˆ€üìÉ½ÕÁ%ô€èíô¤°(€€€€€­¥¹è­¥¹…ÌÉ…™Ñ-¥¹°(€€€€€Á…å±½…°(€€€ô°(€ôì)ô()•áÁ½ÉĞ™Õ¹Ñ¥½¸Ù…±¥‘…Ñ•É…™ÑÑ¥½¹%¹ÁÕĞ (€¥¹ÁÕĞèI•½ÉñÍÑÉ¥¹œ°Õ¹­¹½İ¸ø°(¤èÉ…™ÑÑ¥½¹Y…±¥‘…Ñ¥½¹I•ÍÕ±Ğì(€½¹ÍĞ•ÉÉ½ÉÌèI•½ÉñÍÑÉ¥¹œ°ÍÑÉ¥¹œø€ôíôì(€…‘‘U¹­¹½İ¹¥•±‘ÉÉ½ÉÌ¡¥¹ÁÕĞ°¹•ÜM•Ğ¡l‰¥ˆ°€‰É•Ù¥Í¥½¸ˆ°€‰…Ñ¥½¸‰t¤°€ˆˆ°•ÉÉ½ÉÌ¤ì((€½¹ÍĞ¥€ô¥¹ÁÕĞ¹¥ì(€¥˜€¡ÑåÁ•½˜¥€„ôô€‰ÍÑÉ¥¹œˆñğ€…¥ÍÉ…™Ñ%¡¥¤¤ì(€€€•ÉÉ½ÉÌ¹¥€ô€‹BwB×BëBûFB×BëFB÷BãBäƒF[BÓB×B÷FBãFF[BëBÃFBûF ƒFB×FB÷B×FBëBà¸ˆì(€ô(€½¹ÍĞÉ•Ù¥Í¥½¸€ô¥¹ÁÕĞ¹É•Ù¥Í¥½¸ì(€¥˜€ (€€€ÑåÁ•½˜É•Ù¥Í¥½¸€„ôô€‰¹Õµ‰•Èˆñğ€…9Õµ‰•È¹¥Í%¹Ñ••È¡É•Ù¥Í¥½¸¤ñğÉ•Ù¥Í¥½¸€ğ€Äñğ(€€€É•Ù¥Í¥½¸€ø€É|ÄĞİ|ĞàÍ|ØĞÜ(€€¤ì(€€€•ÉÉ½ÉÌ¹É•Ù¥Í¥½¸€ô€‹BƒB×BËF[BßF[F<ƒFB×FB÷B×FBëBàƒBóBÃFPƒBÇFFBàƒBÓBûBÓBÃFB÷BãBğƒFF[BïBãBğƒFBãFBïBûBğ¸ˆì(€ô(€½¹ÍĞ…Ñ¥½¸€ô¥¹ÁÕĞ¹…Ñ¥½¸ì(€¥˜€¡ÑåÁ•½˜…Ñ¥½¸€„ôô€‰ÍÑÉ¥¹œˆñğ€…IQ}Q%=9L¹¥¹±Õ‘•Ì¡…Ñ¥½¸…ÌÉ…™ÑÑ¥½¸¤¤ì(€€€•ÉÉ½ÉÌ¹…Ñ¥½¸€ô€‹BF[BÓFFBãBóFF;FF3FF<ƒBïBãF#BÔƒBÓF[F\ÍÕ‰µ¥ĞƒFX…¹•°¸ˆì(€ô((€¥˜€¡=‰©•Ğ¹­•åÌ¡•ÉÉ½ÉÌ¤¹±•¹Ñ €ø€À¤É•ÑÕÉ¸ì½¬è™…±Í”°™¥•±‘ÉÉ½ÉÌè•ÉÉ½ÉÌôì(€É•ÑÕÉ¸ì(€€€½¬èÑÉÕ”°(€€€Ù…±Õ”èì(€€€€€¥è¥…ÌÍÑÉ¥¹œ°(€€€€€É•Ù¥Í¥½¸èÉ•Ù¥Í¥½¸…Ì¹Õµ‰•È°(€€€€€…Ñ¥½¸è…Ñ¥½¸…ÌÉ…™ÑÑ¥½¸°(€€€ô°(€ôì)ô(