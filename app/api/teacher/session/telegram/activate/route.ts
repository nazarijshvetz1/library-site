import { env } from "cloudflare:workers";

import { isSameOriginRequest } from "@/lib/librarian-api";
import { validateTelegramMiniAppInitData } from "@/lib/telegram-mini-app-auth";
import {
  readVisitJson,
  teacherPortalGate,
  visitError,
  visitJson,
  visitStoreError,
} from "@/lib/visit-schedule-api";
import type { VisitD1Database } from "@/lib/visit-schedule-store";
import {
  activateVisitTeacherTelegramSession,
  telegramTeacherSessionCookie,
} from "@/lib/visit-teacher-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const gate = teacherPortalGate(); if (gate) return gate;
  if (!isSameOriginRequest(request)) {
    return visitError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.");
  }
  const body = await readVisitJson(request); if (!body.ok) return body.response;
  const expectedKeys = ["initData", "requestId", "intent", "loginId", "code", "newPin"];
  const keys = Object.keys(body.value);
  if (keys.length !== expectedKeys.length || !expectedKeys.every((key) => keys.includes(key))
    || expectedKeys.some((key) => typeof body.value[key] !== "string")
    || (body.value.intent !== "login" && body.value.intent !== "activate")) {
    return visitError(400, "validation_failed", "Перевірте ім’я, код і новий PIN.");
  }
  try {
    const telegram = await validateTelegramMiniAppInitData(body.value.initData as string);
    const result = await activateVisitTeacherTelegramSession(
      env.DB as unknown as VisitD1Database,
      request,
      {
        telegramUserId: telegram.telegramUserId,
        initDataHash: telegram.initDataHash,
        authDate: telegram.authDate,
        receiptExpiresAt: telegram.expiresAt,
        requestId: body.value.requestId as string,
        intent: body.value.intent as "login" | "activate",
        loginId: body.value.loginId as string,
        code: body.value.code as string,
        newPin: body.value.newPin as string,
      },
    );
    return visitJson({
      schemaVersion: 1,
      success: true,
      teacher: { fullName: result.identity.fullName },
      pendingScope: result.identity.pendingScope,
      expiresAt: result.identity.expiresAt,
      mustChangePin: false,
    }, {
      headers: { "Set-Cookie": telegramTeacherSessionCookie(result.token) },
    });
  } catch (error) {
    return visitStoreError(error, "telegram_teacher_activation_unavailable");
  }
}
