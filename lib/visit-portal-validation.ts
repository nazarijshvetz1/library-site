import {
  validateVisitBookingCreateInput,
  type ValidationResult,
  type VisitBookingCreateInput,
} from "./visit-schedule-validation.ts";

export type GuestVisitCreateInput = VisitBookingCreateInput & {
  teacherRef: string;
  publicTeacherNameConsent: boolean;
};
export type VisitBookingUpdateInput = VisitBookingCreateInput & { expectedVersion: number };
export type GuestVisitUpdateInput = VisitBookingUpdateInput & { publicTeacherNameConsent: boolean };
export type GuestVisitCancelInput = { requestId: string; expectedVersion: number; reason: string | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TEACHER_REF_RE = /^[0-9a-f]{64}$/u;

export function validateGuestVisitCreateInput(input: unknown): ValidationResult<GuestVisitCreateInput> {
  if (!record(input)) return invalid("body", "Очікуються дані бронювання.");
  const errors: Record<string, string> = {};
  exact({ ...input, publicTeacherNameConsent: input.publicTeacherNameConsent ?? false }, ["requestId", "teacherRef", "date", "startTime", "endTime", "publicDisplayConsent", "publicTeacherNameConsent", "classYearId", "purpose"], errors);
  const base = validateVisitBookingCreateInput({
    requestId: input.requestId,
    date: input.date,
    startTime: input.startTime,
    endTime: input.endTime,
    publicDisplayConsent: input.publicDisplayConsent,
    classYearId: input.classYearId,
    purpose: input.purpose,
  });
  if (!base.ok) Object.assign(errors, base.fieldErrors);
  const teacherRef = typeof input.teacherRef === "string" ? input.teacherRef.trim().toLowerCase() : "";
  if (!TEACHER_REF_RE.test(teacherRef)) errors.teacherRef = "Оберіть учителя зі списку.";
  const publicTeacherNameConsent = optionalPublicTeacherNameConsent(input.publicTeacherNameConsent, errors);
  if (Object.keys(errors).length || !base.ok) return { ok: false, fieldErrors: errors };
  return { ok: true, value: { ...base.value, teacherRef, publicTeacherNameConsent } };
}

export function validateVisitBookingUpdateInput(input: unknown): ValidationResult<VisitBookingUpdateInput> {
  if (!record(input)) return invalid("body", "Очікуються оновлені дані бронювання.");
  const errors: Record<string, string> = {};
  exact(input, ["requestId", "expectedVersion", "date", "startTime", "endTime", "publicDisplayConsent", "classYearId", "purpose"], errors);
  const base = validateVisitBookingCreateInput({
    requestId: input.requestId,
    date: input.date,
    startTime: input.startTime,
    endTime: input.endTime,
    publicDisplayConsent: input.publicDisplayConsent,
    classYearId: input.classYearId,
    purpose: input.purpose,
  });
  if (!base.ok) Object.assign(errors, base.fieldErrors);
  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    errors.expectedVersion = "Оновіть сторінку й повторіть зміну.";
  }
  if (Object.keys(errors).length || !base.ok) return { ok: false, fieldErrors: errors };
  return { ok: true, value: { ...base.value, expectedVersion } };
}

export function validateGuestVisitUpdateInput(input: unknown): ValidationResult<GuestVisitUpdateInput> {
  if (!record(input)) return invalid("body", "Очікуються оновлені дані бронювання.");
  const errors: Record<string, string> = {};
  exact({ ...input, publicTeacherNameConsent: input.publicTeacherNameConsent ?? false }, ["requestId", "expectedVersion", "date", "startTime", "endTime", "publicDisplayConsent", "publicTeacherNameConsent", "classYearId", "purpose"], errors);
  const base = validateVisitBookingUpdateInput({
    requestId: input.requestId,
    expectedVersion: input.expectedVersion,
    date: input.date,
    startTime: input.startTime,
    endTime: input.endTime,
    publicDisplayConsent: input.publicDisplayConsent,
    classYearId: input.classYearId,
    purpose: input.purpose,
  });
  if (!base.ok) Object.assign(errors, base.fieldErrors);
  const publicTeacherNameConsent = optionalPublicTeacherNameConsent(input.publicTeacherNameConsent, errors);
  if (Object.keys(errors).length || !base.ok) return { ok: false, fieldErrors: errors };
  return { ok: true, value: { ...base.value, publicTeacherNameConsent } };
}

export function validateGuestVisitCancelInput(input: unknown): ValidationResult<GuestVisitCancelInput> {
  if (!record(input)) return invalid("body", "Очікується підтвердження скасування.");
  const errors: Record<string, string> = {};
  exact(input, ["requestId", "expectedVersion", "reason"], errors);
  const requestId = typeof input.requestId === "string" ? input.requestId.trim() : "";
  if (!UUID_RE.test(requestId)) errors.requestId = "Некоректний requestId.";
  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    errors.expectedVersion = "Оновіть сторінку й повторіть дію.";
  }
  const reason = optionalText(input.reason, "reason", errors, 160);
  return Object.keys(errors).length
    ? { ok: false, fieldErrors: errors }
    : { ok: true, value: { requestId, expectedVersion, reason } };
}

function optionalText(value: unknown, key: string, errors: Record<string, string>, max: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    errors[key] = "Некоректний текст.";
    return null;
  }
  const hasControl = Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  const result = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (result.length > max || hasControl) errors[key] = `Не більше ${max} символів без службових знаків.`;
  return result || null;
}

function optionalPublicTeacherNameConsent(value: unknown, errors: Record<string, string>): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    errors.publicTeacherNameConsent = "Некоректне підтвердження публічного показу ПІБ.";
    return false;
  }
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(input: Record<string, unknown>, allowed: string[], errors: Record<string, string>): void {
  if (Object.keys(input).length !== allowed.length || allowed.some((key) => !Object.hasOwn(input, key))) {
    for (const key of Object.keys(input)) if (!allowed.includes(key)) errors[key] = "Невідоме поле.";
    for (const key of allowed) if (!Object.hasOwn(input, key)) errors[key] = "Обов’язкове поле.";
  }
}

function invalid(key: string, message: string): ValidationResult<never> {
  return { ok: false, fieldErrors: { [key]: message } };
}
