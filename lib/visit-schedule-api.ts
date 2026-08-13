import { getRuntimeBoolean } from "@/lib/runtime-env";
import { isSameOriginRequest } from "@/lib/librarian-api";
import { VisitScheduleError } from "@/lib/visit-schedule-store";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
} as const;

export function visitScheduleEnabled(): boolean { return getRuntimeBoolean("VISIT_SCHEDULE_ENABLED"); }
export function visitBookingEnabled(): boolean { return getRuntimeBoolean("VISIT_BOOKING_ENABLED"); }
export function visitGuestBookingEnabled(): boolean { return getRuntimeBoolean("VISIT_GUEST_BOOKING_ENABLED"); }
export function teacherPortalEnabled(): boolean { return getRuntimeBoolean("TEACHER_PORTAL_ENABLED"); }

export function visitJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(PRIVATE_HEADERS);
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return Response.json(body, { ...init, headers });
}

export function visitError(status: number, code: string, error: string, details?: Record<string, unknown>): Response {
  return visitJson({ schemaVersion: 1, success: false, code, error, ...details }, { status });
}

export function featureGate(write = false): Response | null {
  if (!visitScheduleEnabled()) return visitError(503, "feature_disabled", "Розклад відвідувань тимчасово вимкнено.");
  if (write && !visitBookingEnabled()) return visitError(503, "booking_disabled", "Бронювання тимчасово вимкнено.");
  return null;
}

export function guestFeatureGate(write = false): Response | null {
  if (!visitScheduleEnabled()) return visitError(503, "feature_disabled", "Розклад відвідувань тимчасово вимкнено.");
  if (!visitGuestBookingEnabled()) return visitError(503, "guest_booking_disabled", "Гостьовий запис тимчасово вимкнено.");
  if (write && !visitBookingEnabled()) return visitError(503, "booking_disabled", "Бронювання тимчасово вимкнено.");
  return null;
}

export function teacherPortalGate(): Response | null {
  if (!teacherPortalEnabled()) return visitError(503, "teacher_portal_disabled", "Кабінет учителя тимчасово вимкнено.");
  return null;
}

export async function readVisitJson(request: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  if (!isSameOriginRequest(request)) return { ok: false, response: visitError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.") };
  if ((request.headers.get("Content-Encoding") ?? "identity").toLowerCase() !== "identity") {
    return { ok: false, response: visitError(415, "unsupported_content_encoding", "Стиснене тіло запиту не підтримується.") };
  }
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
    return { ok: false, response: visitError(415, "unsupported_media_type", "Надішліть JSON.") };
  }
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > 16 * 1024) return { ok: false, response: visitError(413, "body_too_large", "Тіло запиту завелике.") };
  if (!request.body) return { ok: false, response: visitError(400, "invalid_json", "Порожнє тіло запиту.") };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 16 * 1024) {
        await reader.cancel();
        return { ok: false, response: visitError(413, "body_too_large", "Тіло запиту завелике.") };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object expected");
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, response: visitError(400, "invalid_json", "Некоректне тіло JSON.") };
  }
}

export function visitStoreError(error: unknown, fallbackCode: string): Response {
  if (error instanceof VisitScheduleError) return visitError(error.status, error.code, error.message);
  return visitError(503, fallbackCode, "Сервіс розкладу тимчасово недоступний. Спробуйте ще раз.");
}

export function safeResourceId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}
