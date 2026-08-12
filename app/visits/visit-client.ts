export type VisitClassOption = {
  id: string;
  label: string;
  version?: number;
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
  ownerEmail?: string;
};

export type VisitBusyPeriod = {
  startAt?: string;
  endAt?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  status?: string;
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
  surname: string;
  date: string;
  startTime: string;
  endTime: string;
  purpose: string | null;
  classYearId: string | null;
};

export type VisitCancelPayload = {
  requestId: string;
  expectedVersion: number;
  reason?: string | null;
};

export type VisitPendingIntent =
  | { kind: "create"; requestId: string; payload: VisitCreatePayload }
  | {
      kind: "cancel";
      requestId: string;
      bookingId: string;
      payload: VisitCancelPayload;
    };

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const STORAGE_PREFIX = "library.visit.pending.v1";

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
      (candidate.kind !== "create" && candidate.kind !== "cancel") ||
      typeof candidate.requestId !== "string" ||
      !candidate.payload ||
      typeof candidate.payload !== "object"
    ) return null;
    if (candidate.kind === "cancel" && typeof candidate.bookingId !== "string") return null;
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

export function weekdayKey(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return String(dayOfWeek === 0 ? 7 : dayOfWeek);
}

export function isUncertainVisitFailure(error: unknown): boolean {
  if (!(error instanceof VisitApiError)) return true;
  const definitiveCodes = new Set([
    "authentication_required",
    "authorization_required",
    "booking_limit_reached",
    "booking_not_found",
    "booking_not_cancellable",
    "booking_version_conflict",
    "class_year_not_active",
    "cross_origin_request",
    "outside_booking_horizon",
    "outside_business_hours",
    "request_id_conflict",
    "slot_unavailable",
    "validation_failed",
    "visit_time_elapsed",
  ]);
  return !definitiveCodes.has(error.code);
}

export async function visitApi<T>(url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
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
