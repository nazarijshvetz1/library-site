import { getChatGPTUser, type ChatGPTUser } from "@/app/chatgpt-auth";
import { getRuntimeBoolean, getRuntimeString } from "@/lib/runtime-env";
import { isSameOriginRequest } from "@/lib/librarian-api";
import { VisitScheduleError, type VisitD1Database } from "@/lib/visit-schedule-store";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
} as const;

export function visitScheduleEnabled(): boolean { return getRuntimeBoolean("VISIT_SCHEDULE_ENABLED"); }
export function visitBookingEnabled(): boolean { return getRuntimeBoolean("VISIT_BOOKING_ENABLED"); }

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

export type TeacherAccessMode = "allowlist" | "directory";

export async function authorizeTeacher(db: VisitD1Database): Promise<{ ok: true; user: ChatGPTUser; accessMode: TeacherAccessMode } | { ok: false; response: Response }> {
  const user = await getChatGPTUser();
  if (!user) return { ok: false, response: visitError(401, "authentication_required", "Увійдіть через ChatGPT.") };
  const email = user.email.trim().toLowerCase();
  const allowlist = (getRuntimeString("VISIT_TEACHER_ALLOWED_EMAILS") ?? "")
    .split(/[\s,;]+/u).map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (allowlist.includes(email)) return { ok: true, user, accessMode: "allowlist" };
  let rows: { results?: Array<{ id: string }> };
  try {
    rows = await db.prepare(`
      SELECT id FROM users
      WHERE status = 'active' AND role = 'teacher'
        AND (auth_user_id = ? OR lower(email) = ?)
      ORDER BY CASE WHEN auth_user_id = ? THEN 0 ELSE 1 END, id LIMIT 2
    `).bind(user.userId, email, user.userId).all<{ id: string }>();
  } catch {
    return { ok: false, response: visitError(503, "teacher_access_unavailable", "Не вдалося перевірити доступ учителя. Спробуйте ще раз.") };
  }
  if ((rows.results ?? []).length !== 1) {
    return { ok: false, response: visitError(403, "teacher_access_denied", "Бібліотекар ще не надав цьому обліковому запису доступ до бронювання.") };
  }
  return { ok: true, user, accessMode: "directory" };
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
