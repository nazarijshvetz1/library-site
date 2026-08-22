import { env } from "cloudflare:workers";

import { validateTelegramMiniAppInitData } from "@/lib/telegram-mini-app-auth";
import { readVisitJson, teacherPortalGate, visitError, visitJson, visitStoreError } from "@/lib/visit-schedule-api";
import type { VisitD1Database } from "@/lib/visit-schedule-store";
import {
  createVisitTeacherTelegramSession,
  telegramTeacherSessionCookie,
} from "@/lib/visit-teacher-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const gate = teacherPortalGate(); if (gate) return gate;
  const body = await readVisitJson(request); if (!body.ok) return body.response;
  const keys = Object.keys(body.value);
  if (keys.length !== 1 || keys[0] !== "initData" || typeof body.value.initData !== "string") {
    return visitError(400, "validation_failed", "Telegram не передав дані для входу.");
  }
  try {
    const telegram = await validateTelegramMiniAppInitData(body.value.initData);
    const result = await createVisitTeacherTelegramSession(
      env.DB as unknown as VisitD1Database,
      request,
      {
        telegramUserId: telegram.telegramUserId,
        initDataHash: telegram.initDataHash,
        authDate: telegram.authDate,
        receiptExpiresAt: telegram.expiresAt,
      },
    );
    const responseOptions = result.token ? {
      headers: { "Set-Cookie": telegramTeacherSessionCookie(result.token) },
    } : undefined;
    return visitJson({
      schemaVersion: 1,
      success: true,
      teacher: { fullName: result.identity.fullName },
      pendingScope: result.identity.pendingScope,
      expiresAt: result.identity.expiresAt,
      mustChangePin: result.identity.mustChangePin,
    }, responseOptions);
  } catch (error) {
    return visitStoreError(error, "telegram_teacher_session_unavailable");
  }
}
