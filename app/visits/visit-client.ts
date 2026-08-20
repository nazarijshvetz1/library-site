export type VisitClassOption = {
  id: string;
  label: string;
  version?: number;
};

export type VisitTeacherIdentity = {
  fullName: string;
};

export type VisitTeacher = VisitTeacherIdentity & {
  loginId: string;
  publicHint?: string | null;
};

export type VisitTeacherSearchEnvelope = {
  success: true;
  teachers: VisitTeacher[];
};

export type VisitTeacherSessionEnvelope = {
  success: true;
  teacher: VisitTeacherIdentity;
  pendingScope: string;
  expiresAt?: string;
};

export type VisitGuestSessionEnvelope = {
  success: true;
  guest: { pendingScope: string; expiresAt: string };
};

export type VisitGuestTeacher = {
  teacherRef: string;
  fullName: string;
};

export type VisitGuestBooking = Omit<VisitBooking, "surname"> & {
  teacher: VisitGuestTeacher;
};

export type GuestVisitsEnvelope = Omit<TeacherVisitsEnvelope, "bookingEnabled" | "bookings"> & {
  bookings: VisitGuestBooking[];
};

export type VisitBooking = {
  id: string;
  surname: string;
  date: string;
  startTime: string;
  endTime: string;
  purpose: string | null;
  classYearId: string | null;
  classLabel: string | null;
  status: string;
  version: number;
  ownerKind?: "guest" | "teacher" | "legacy";
  identityVerified?: boolean;
  ownerEmail?: string;
  publicDisplayConsent: boolean;
};

export type VisitBusyPeriod = {
  startAt?: string;
  endAt?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  status?: string;
};

export type VisitPublicBooking = {
  date: string;
  startTime: string;
  endTime: string;
  displayName: string;
  identityVerified: boolean;
};

export type PublicVisitsEnvelope = {
  success: true;
  timeZone: string;
  slotMinutes: number;
  hours: Record<string, Array<{ startTime: string; endTime: string }>>;
  closures: Array<{ date: string; startTime: string; endTime: string; status: "closed" }>;
  busy: VisitBusyPeriod[];
  publicBookings: VisitPublicBooking[];
};

export type TeacherVisitsEnvelope = {
  success: true;
  timeZone: string;
  slotMinutes: number;
  bookingEnabled: boolean;
  hours: Record<string, Array<{ startTime: string; endTime: string }>>;
  closures: Array<{ date: string; startTime: string; endTime: string; status: "closed" }>;
  classYears: VisitClassOption[];
  bookings: VisitBooking[];
  busy: VisitBusyPeriod[];
};

export type LibrarianVisitsEnvelope = {
  success: true;
  writesEnabled: boolean;
  scheduleEnabled: boolean;
  bookingEnabled: boolean;
  bookings: VisitBooking[];
};

export type VisitCreatePayload = {
  requestId: string;
  date: string;
  startTime: string;
  endTime: string;
  purpose: string | null;
  classYearId: string | null;
  publicDisplayConsent: true;
};

export type VisitCancelPayload = {
  requestId: string;
  expectedVersion: number;
  reason?: string | null;
};

export type VisitPatchPayload = VisitCreatePayload & { expectedVersion: number };

export type VisitGuestCreatePayload = VisitCreatePayload & { teacherRef: string };

export type VisitPendingIntent =
  | { kind: "create"; requestId: string; payload: VisitCreatePayload }
  | { kind: "patch"; requestId: string; bookingId: string; payload: VisitPatchPayload }
  | {
      kind: "cancel";
      requestId: string;
      bookingId: string;
      payload: VisitCancelPayload;
    };

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type PortalPendingIntent = {
  kind: string;
  requestId: string;
  payload: object;
  resourceId?: string;
};

const STORAGE_PREFIX = "library.visit.pending.v1";

export const PERSONAL_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export type PersonalCodeStrength = {
  complete: boolean;
  diverse: boolean;
  noLongRun: boolean;
  notObvious: boolean;
  strong: boolean;
};

export function normalizedPersonalCode(value: string): string {
  return value.normalize("NFKC").toUpperCase().replace(/[^23456789ABCDEFGHJKMNPQRSTUVWXYZ]/gu, "").slice(0, 10);
}

export function formatPersonalCode(value: string): string {
  const normalized = normalizedPersonalCode(value);
  return normalized.length > 5 ? `${normalized.slice(0, 5)}-${normalized.slice(5)}` : normalized;
}

export function personalCodeStrength(value: string): PersonalCodeStrength {
  const normalized = normalizedPersonalCode(value);
  const complete = normalized.length === 10;
  const diverse = new Set(normalized).size >= 4;
  const noLongRun = !/(.)\1{3}/u.test(normalized);
  const reversedAlphabet = Array.from(PERSONAL_CODE_ALPHABET).reverse().join("");
  const notObvious = normalized !== Array.from(normalized).reverse().join("")
    && !/^(.{1,5})\1+$/u.test(normalized)
    && !PERSONAL_CODE_ALPHABET.includes(normalized)
    && !reversedAlphabet.includes(normalized);
  return { complete, diverse, noLongRun, notObvious, strong: complete && diverse && noLongRun && notObvious };
}

export class VisitApiError extends Error {
  status: number;
  code: string;
  fieldErrors: Record<string, string>;

  constructor(
    message: string,
    status = 0,
    code = "",
    fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = "VisitApiError";
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

export function visitPendingKey(
  scope: "teacher" | "librarian",
  pendingScope = "browser",
): string {
  return `${STORAGE_PREFIX}:${scope}:${pendingScope}`;
}

export function readVisitPendingIntent(
  storage: StorageLike,
  key: string,
): VisitPendingIntent | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const candidate = value as Partial<VisitPendingIntent>;
    if (
      (candidate.kind !== "create" && candidate.kind !== "patch" && candidate.kind !== "cancel") ||
      typeof candidate.requestId !== "string" ||
      !candidate.payload ||
      typeof candidate.payload !== "object"
    ) return null;
    if ((candidate.kind === "patch" || candidate.kind === "cancel") && typeof candidate.bookingId !== "string") return null;
    return candidate as VisitPendingIntent;
  } catch {
    return null;
  }
}

export function writeVisitPendingIntent(
  storage: StorageLike,
  key: string,
  intent: VisitPendingIntent,
): boolean {
  try {
    storage.setItem(key, JSON.stringify(intent));
    return true;
  } catch {
    return false;
  }
}

export function clearVisitPendingIntent(storage: StorageLike, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // A denied storage cleanup must not turn a confirmed request into an error.
  }
}

export function readPortalPendingIntent<T extends PortalPendingIntent>(
  storage: StorageLike,
  key: string,
  allowedKinds: readonly string[],
): T | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const candidate = value as Partial<PortalPendingIntent>;
    if (
      typeof candidate.kind !== "string"
      || !allowedKinds.includes(candidate.kind)
      || typeof candidate.requestId !== "string"
      || !candidate.payload
      || typeof candidate.payload !== "object"
    ) return null;
    if (candidate.resourceId !== undefined && typeof candidate.resourceId !== "string") return null;
    return candidate as T;
  } catch {
    return null;
  }
}

export function writePortalPendingIntent<T extends PortalPendingIntent>(
  storage: StorageLike,
  key: string,
  intent: T,
): boolean {
  try {
    storage.setItem(key, JSON.stringify(intent));
    return true;
  } catch {
    return false;
  }
}

export function clearPortalPendingIntent(storage: StorageLike, key: string): void {
  clearVisitPendingIntent(storage, key);
}

export function mergePortalPageById<T extends { id: string }>(
  current: readonly T[],
  nextPage: readonly T[],
): T[] {
  const merged = [...current];
  const positions = new Map(merged.map((item, index) => [item.id, index]));
  for (const item of nextPage) {
    const position = positions.get(item.id);
    if (position === undefined) {
      positions.set(item.id, merged.length);
      merged.push(item);
    } else {
      merged[position] = item;
    }
  }
  return merged;
}

export function busyPeriodParts(period: VisitBusyPeriod): {
  date: string;
  startTime: string;
  endTime: string;
} {
  return {
    date: period.date ?? period.startAt?.slice(0, 10) ?? "",
    startTime: period.startTime ?? period.startAt?.slice(11, 16) ?? "",
    endTime: period.endTime ?? period.endAt?.slice(11, 16) ?? "",
  };
}

export function formatVisitDateTime(value: string): string {
  const [date, rawTime = ""] = value.split("T");
  const [year, month, day] = date.split("-");
  return year && month && day
    ? `${day}.${month}.${year}${rawTime ? ` о ${rawTime.slice(0, 5)}` : ""}`
    : value;
}

export function visitDateRange(today: string, days = 90): { from: string; to: string } {
  const [year, month, day] = today.split("-").map(Number);
  const end = new Date(Date.UTC(year, month - 1, day + days));
  return { from: today, to: end.toISOString().slice(0, 10) };
}

export function visitHorizonEnd(today: string): string {
  return visitDateRange(today).to;
}

export function validVisitDuration(startTime: string, endTime: string): boolean {
  const minutes = (value: string) => {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) return Number.NaN;
    const [hours, mins] = value.split(":").map(Number);
    return hours * 60 + mins;
  };
  const startMinutes = minutes(startTime);
  const endMinutes = minutes(endTime);
  const duration = endMinutes - startMinutes;
  return Number.isFinite(duration)
    && duration >= 20
    && duration <= 240
    && startMinutes % 5 === 0
    && endMinutes % 5 === 0;
}

export function teacherVisitsUrl(today: string): string {
  const range = visitDateRange(today);
  const params = new URLSearchParams(range);
  return `/api/visits/teacher?${params.toString()}`;
}

export function publicVisitsUrl(from: string, to: string): string {
  const params = new URLSearchParams({ from, to });
  return `/api/visits/public?${params.toString()}`;
}

export function teacherSearchUrl(query: string): string {
  const params = new URLSearchParams({ q: query.trim() });
  return `/api/teacher/directory?${params.toString()}`;
}

export const teacherSessionUrl = "/api/teacher/session";

export function weekdayKey(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return String(dayOfWeek === 0 ? 7 : dayOfWeek);
}

export function isUncertainVisitFailure(error: unknown): boolean {
  if (!(error instanceof VisitApiError)) return true;
  const definitiveCodes = new Set([
    "actor_not_mapped",
    "authentication_required",
    "authorization_required",
    "booking_limit_reached",
    "booking_not_editable",
    "booking_not_found",
    "booking_not_cancellable",
    "booking_version_conflict",
    "class_year_not_active",
    "credential_version_conflict",
    "cross_origin_request",
    "fulfillment_source_not_found",
    "guest_session_expired",
    "guest_session_required",
    "insufficient_stock",
    "invalid_current_code",
    "invalid_due_date",
    "invalid_request_transition",
    "material_not_found",
    "mutation_failed",
    "new_code_unchanged",
    "notification_already_read",
    "notification_not_found",
    "notification_version_conflict",
    "outside_booking_horizon",
    "outside_business_hours",
    "pickup_location_not_found",
    "rate_limited",
    "request_id_conflict",
    "request_items_mismatch",
    "request_not_cancellable",
    "request_not_found",
    "request_too_large",
    "request_version_conflict",
    "slot_unavailable",
    "stock_quantity_conflict",
    "teacher_access_revoked",
    "teacher_not_found",
    "validation_failed",
    "visit_time_elapsed",
    "weak_new_code",
    "writes_disabled",
  ]);
  return !definitiveCodes.has(error.code);
}

export async function visitApi<T>(url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });
  } catch (error) {
    throw new VisitApiError(
      error instanceof Error ? error.message : "Немає зв’язку із сервером.",
    );
  }
  const body = await response.json().catch(() => null) as
    | (T & {
        success?: boolean;
        error?: string;
        message?: string;
        code?: string;
        fieldErrors?: Record<string, string>;
      })
    | null;
  if (!response.ok || !body || body.success === false) {
    throw new VisitApiError(
      body?.error || body?.message || `Запит не виконано (${response.status}).`,
      response.status,
      body?.code || "",
      body?.fieldErrors || {},
    );
  }
  return body;
}
