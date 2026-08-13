import { env } from "cloudflare:workers";

import { authorizeLibrarianApi, isSameOriginRequest, librarianError } from "@/lib/librarian-api";
import { readVisitJson, safeResourceId, visitError, visitJson, visitStoreError } from "@/lib/visit-schedule-api";
import { type VisitD1Database } from "@/lib/visit-schedule-store";
import { VisitScheduleError } from "@/lib/visit-schedule-store";
import type { ChatGPTUser } from "@/app/chatgpt-auth";

export async function authorizeVisitTeacherAccessApi(request?: Request) {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization;
  if (request && !isSameOriginRequest(request)) {
    return { ok: false as const, response: visitError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.") };
  }
  if (request && !authorization.value.access.writesEnabled) {
    return { ok: false as const, response: librarianError(503, "writes_disabled", "Зміни тимчасово вимкнено.", false) };
  }
  return {
    ok: true as const,
    value: {
      db: env.DB as unknown as VisitD1Database,
      user: authorization.value.user,
      access: authorization.value.access,
    },
  };
}

export async function visitTeacherAccessBody(request: Request) {
  return readVisitJson(request);
}

export async function resolveVisitLibrarianActor(db: VisitD1Database, user: ChatGPTUser) {
  const rows = await db.prepare(`SELECT id FROM users WHERE status='active'
    AND role IN ('admin','librarian') AND (auth_user_id=? OR lower(email)=lower(?))
    ORDER BY id LIMIT 2`).bind(user.userId, user.email).all<{ id: string }>();
  if ((rows.results ?? []).length !== 1) {
    throw new VisitScheduleError("actor_not_mapped", 403, "Обліковий запис не прив’язаний до одного активного бібліотекаря.");
  }
  return { id: rows.results![0].id, email: user.email };
}

export function exactBodyKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

export function validRequestId(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

export { safeResourceId, visitError, visitJson, visitStoreError };
