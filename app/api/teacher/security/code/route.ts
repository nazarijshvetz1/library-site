import { env } from "cloudflare:workers";

import { isSameOriginRequest } from "@/lib/librarian-api";
import { readVisitJson, teacherPortalGate, visitError, visitJson, visitStoreError } from "@/lib/visit-schedule-api";
import type { VisitD1Database } from "@/lib/visit-schedule-store";
import { rotateVisitTeacherCode, teacherSessionCookieForRequest } from "@/lib/visit-teacher-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const gate = teacherPortalGate(); if (gate) return gate;
  if (!isSameOriginRequest(request)) return visitError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.");
  const body = await readVisitJson(request); if (!body.ok) return body.response;
  const keys = Object.keys(body.value);
  if (keys.length !== 3 || !keys.includes("requestId") || !keys.includes("currentCode") || !keys.includes("newPin")
    || typeof body.value.requestId !== "string" || typeof body.value.currentCode !== "string"
    || typeof body.value.newPin !== "string") {
    return visitError(400, "validation_failed", "Перевірте поточний код і новий PIN.");
  }
  try {
    const rotated = await rotateVisitTeacherCode(env.DB as unknown as VisitD1Database, request, {
      requestId: body.value.requestId,
      currentCode: body.value.currentCode,
      newPin: body.value.newPin,
    });
    const headers = rotated.token ? { "Set-Cookie": teacherSessionCookieForRequest(request, rotated.token) } : undefined;
    return visitJson({ schemaVersion: 1, success: true, ...rotated.result }, { headers });
  } catch (error) { return visitStoreError(error, "teacher_code_rotation_unavailable"); }
}
