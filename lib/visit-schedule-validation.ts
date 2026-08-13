export const VISIT_TIME_ZONE = "Europe/Kyiv" as const;
export const VISIT_SLOT_MINUTES = 5;
export const VISIT_MIN_DURATION_MINUTES = 20;
export const VISIT_MAX_DURATION_MINUTES = 240;
export const VISIT_MAX_HORIZON_DAYS = 90;
export const VISIT_MAX_ACTIVE_BOOKINGS = 20;

export type VisitBookingCreateInput = {
  requestId: string;
  date: string;
  startTime: string;
  endTime: string;
  classYearId: string | null;
  purpose: string | null;
};

export type VisitCancelInput = {
  requestId: string;
  expectedVersion: number;
  reason: string | null;
};

export type VisitClosureCreateInput = {
  requestId: string;
  date: string;
  startTime: string;
  endTime: string;
  reason: string;
};

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; fieldErrors: Record<string, string> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function validateVisitBookingCreateInput(input: unknown): ValidationResult<VisitBookingCreateInput> {
  const errors: Record<string, string> = {};
  if (!isRecord(input)) return invalid("body", "Очікуються дані бронювання.");
  // `surname` is accepted only as a transition field. The server always uses
  // canonical `users.full_name` and never trusts this browser value.
  exactKeys(input, ["requestId", "date", "startTime", "endTime", "surname", "classYearId", "purpose"], errors);
  const requestId = uuid(input.requestId, "requestId", errors);
  const date = isoDate(input.date, "date", errors);
  const startTime = time(input.startTime, "startTime", errors);
  const endTime = time(input.endTime, "endTime", errors);
  validateDuration(startTime, endTime, errors);
  if (input.surname !== undefined) text(input.surname, "surname", errors, 2, 80, false);
  const classYearId = input.classYearId === null
    ? null
    : pattern(input.classYearId, "classYearId", SAFE_ID_RE, errors);
  const purpose = nullableText(input.purpose, "purpose", errors, 160);
  return finish(errors, { requestId, date, startTime, endTime, classYearId, purpose });
}

export function validateVisitCancelInput(input: unknown, admin = false): ValidationResult<VisitCancelInput> {
  const errors: Record<string, string> = {};
  if (!isRecord(input)) return invalid("body", "Очікується підтвердження скасування.");
  exactKeys(input, admin ? ["requestId", "expectedVersion", "reason"] : ["requestId", "expectedVersion"], errors);
  const requestId = uuid(input.requestId, "requestId", errors);
  const expectedVersion = integer(input.expectedVersion, "expectedVersion", errors, 1, Number.MAX_SAFE_INTEGER);
  const reason = admin ? nullableText(input.reason, "reason", errors, 160) : null;
  return finish(errors, { requestId, expectedVersion, reason });
}

export function validateVisitClosureCreateInput(input: unknown): ValidationResult<VisitClosureCreateInput> {
  const errors: Record<string, string> = {};
  if (!isRecord(input)) return invalid("body", "Очікуються дані закриття розкладу.");
  exactKeys(input, ["requestId", "date", "startTime", "endTime", "reason"], errors);
  const requestId = uuid(input.requestId, "requestId", errors);
  const date = isoDate(input.date, "date", errors);
  const startTime = time(input.startTime, "startTime", errors);
  const endTime = time(input.endTime, "endTime", errors);
  if (startTime && endTime) {
    const start = minutes(startTime);
    const end = minutes(endTime);
    if (start >= end) errors.endTime = "Час завершення має бути пізнішим.";
    if (start % VISIT_SLOT_MINUTES) errors.startTime = "Час має бути кратним 5 хвилинам.";
    if (end % VISIT_SLOT_MINUTES) errors.endTime = "Час має бути кратним 5 хвилинам.";
  }
  const reason = text(input.reason, "reason", errors, 2, 160, false);
  return finish(errors, { requestId, date, startTime, endTime, reason });
}

export function parseVisitRange(url: URL, today: string, defaultDays = 30) {
  const from = url.searchParams.get("from") || today;
  const defaultTo = addDays(today, defaultDays);
  const to = url.searchParams.get("to") || defaultTo;
  if (
    !validDate(from)
    || !validDate(to)
    || from > to
    || from < today
    || to > addDays(today, VISIT_MAX_HORIZON_DAYS)
    || daysBetween(from, to) > VISIT_MAX_HORIZON_DAYS
  ) {
    throw new VisitValidationError("invalid_visit_range", "Діапазон має містити не більше 90 днів.");
  }
  return { from, to };
}

export function parseAdminVisitRange(url: URL, today: string, defaultDays = 30) {
  const from = url.searchParams.get("from") || today;
  const to = url.searchParams.get("to") || addDays(today, defaultDays);
  if (!validDate(from) || !validDate(to) || from > to || daysBetween(from, to) > VISIT_MAX_HORIZON_DAYS) {
    throw new VisitValidationError("invalid_visit_range", "Діапазон має містити не більше 90 днів.");
  }
  return { from, to };
}

export function visitSegments(date: string, startTime: string, endTime: string): string[] {
  const start = minutes(startTime);
  const end = minutes(endTime);
  const values: string[] = [];
  for (let current = start; current < end; current += VISIT_SLOT_MINUTES) {
    values.push(`${date}T${formatMinutes(current)}`);
  }
  return values;
}

export function visitDateInHorizon(date: string, today: string): boolean {
  return validDate(date) && date >= today && daysBetween(today, date) <= VISIT_MAX_HORIZON_DAYS;
}

export function kyivToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: VISIT_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

export function kyivLocalNow(now = new Date()): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: VISIT_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { date: `${value.year}-${value.month}-${value.day}`, time: `${value.hour}:${value.minute}` };
}

export function isoWeekday(date: string): number {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

export function addDays(date: string, count: number): string {
  const instant = new Date(`${date}T12:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + count);
  return instant.toISOString().slice(0, 10);
}

export class VisitValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

function validateDuration(startTime: string, endTime: string, errors: Record<string, string>) {
  if (!startTime || !endTime) return;
  const start = minutes(startTime);
  const end = minutes(endTime);
  if (start % 5) errors.startTime = "Час має бути кратним 5 хвилинам.";
  if (end % 5) errors.endTime = "Час має бути кратним 5 хвилинам.";
  const duration = end - start;
  if (duration < VISIT_MIN_DURATION_MINUTES || duration > VISIT_MAX_DURATION_MINUTES) {
    errors.endTime = "Тривалість відвідування має бути від 20 хвилин до 4 годин.";
  }
}

function minutes(value: string): number { const [h, m] = value.split(":").map(Number); return h * 60 + m; }
function formatMinutes(value: number): string { return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`; }
function daysBetween(left: string, right: string): number { return Math.round((Date.parse(`${right}T12:00:00Z`) - Date.parse(`${left}T12:00:00Z`)) / 86400000); }
function validDate(value: string): boolean { return DATE_RE.test(value) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(input: Record<string, unknown>, allowed: string[], errors: Record<string, string>) { for (const key of Object.keys(input)) if (!allowed.includes(key)) errors[key] = "Невідоме поле."; }
function uuid(value: unknown, key: string, errors: Record<string, string>) { return pattern(value, key, UUID_RE, errors); }
function isoDate(value: unknown, key: string, errors: Record<string, string>) { const result = String(value ?? "").trim(); if (!validDate(result)) errors[key] = "Укажіть коректну дату."; return result; }
function time(value: unknown, key: string, errors: Record<string, string>) { const result = String(value ?? "").trim(); if (!TIME_RE.test(result)) errors[key] = "Укажіть час у форматі ГГ:ХХ."; return result; }
function pattern(value: unknown, key: string, re: RegExp, errors: Record<string, string>) { const result = String(value ?? "").trim(); if (!re.test(result)) errors[key] = "Некоректне значення."; return result; }
function text(value: unknown, key: string, errors: Record<string, string>, min: number, max: number, allowEmpty: boolean) { const raw = String(value ?? ""); const hasControl = Array.from(raw).some((character) => { const code = character.charCodeAt(0); return code <= 31 || code === 127; }); const result = raw.trim().replace(/\s+/gu, " "); if ((!allowEmpty && result.length < min) || result.length > max || hasControl) errors[key] = `Укажіть від ${min} до ${max} символів без службових символів.`; return result; }
function nullableText(value: unknown, key: string, errors: Record<string, string>, max: number) { if (value === null) return null; const result = text(value, key, errors, 0, max, true); return result || null; }
function integer(value: unknown, key: string, errors: Record<string, string>, min: number, max: number) { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) errors[key] = "Некоректне ціле число."; return Number(value) || 0; }
function invalid(key: string, message: string): ValidationResult<never> { return { ok: false, fieldErrors: { [key]: message } }; }
function finish<T>(errors: Record<string, string>, value: T): ValidationResult<T> { return Object.keys(errors).length ? { ok: false, fieldErrors: errors } : { ok: true, value }; }
