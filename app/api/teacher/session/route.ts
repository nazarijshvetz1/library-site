import { env } from "cloudflare:workers";

import { isSameOriginRequest } from "@/lib/librarian-api";
import { readVisitJson, teacherPortalGate, visitError, visitJson, visitStoreError } from "@/lib/visit-schedule-api";
import type { VisitD1Database } from "@/lib/visit-schedule-store";
import {
  clearTeacherSessionCookie,
  createVisitTeacherSession,
  requireVisitTeacherSession,
  revokeVisitTeacherSession,
  teacherSessionCookie,
} from "@/lib/visit-teacher-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const gate = teacherPortalGate(); if (gate) return gate;
  try {
    const identity = await requireVisitTeacherSession(env.DB as unknown as VisitD1Database, request);
    return visitJson({ schemaVersion: 1, success: true, teacher: { fullName: identity.fullName },
      pendingScope: identity.pendingScope, expiresAt: identity.expiresAt });
  } catch (error) { return visitStoreError(error, "teacher_session_unavailable"); }
}

export async function POST(request: Request): Promise<Response> {
  const gate = teacherPortalGate(); if (gate) return gate;
  if (!isSameOriginRequest(request)) return visitError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.");
  const body = await readVisitJson(request); if (!body.ok) return body.response;
  const keys = Object.keys(body.value);
  if (keys.length !== 2 || !keys.includes("loginId") || !keys.includes("code")
    || typeof body.value.loginId !== "string" || typeof body.value.code !== "string") {
    return visitError(400, "validation_failed", "Оберіть учителя та введіть особистий код.");
  }
  try {
    const result = await createVisitTeacherSession(env.DB as unknown as VisitD1Database, request, {
      loginId: body.value.loginId, code: body.value.code,
    });
    return visitJson({ schemaVersion: 1, success: true, teacher: { fullName: result.identity.fullName },
      pendingScope: result.identity.pendingScope, expiresAt: result.identity.expiresAt }, {
      headers: { "Set-Cookie": teacherSessionCookie(result.token) },
    });
  } catch (error) { return visitStoreError(error, "teacher_session_unavailable"); }
}

export async function DELETE(request: Request): Promise<Response> {
  const gate = teacherPortalGate(); if (gate) return gate;
  if (!isSameOriginRequest(request)) return visitError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.");
  try {
    await revokeVisitTeacherSession(env.DB as unknown as VisitD1Database, request);
    return visitJson({ schemaVersion: 1, success: true }, {
      headers: { "Set-Cookie": clearTeacherSessionCookie() },
    });
  } catch (error) { return visitStoreError(error, "teacher_session_unavailable"); }
}
