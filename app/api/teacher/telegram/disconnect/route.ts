import { env } from "cloudflare:workers";

import { readTelegramJson, telegramJson, telegramStoreError, telegramVersionInput } from "@/lib/telegram-api";
import { disconnectTelegram, type TelegramDatabase } from "@/lib/telegram-notifications";
import { requireVisitTeacherSession } from "@/lib/visit-teacher-auth";
import { teacherPortalGate } from "@/lib/visit-schedule-api";
import type { VisitD1Database } from "@/lib/visit-schedule-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const gate = teacherPortalGate(); if (gate) return gate;
  const body = await readTelegramJson(request); if (!body.ok) return body.response;
  const input = telegramVersionInput(body.value); if (!input.ok) return input.response;
  const db = env.DB as unknown as TelegramDatabase & VisitD1Database;
  try {
    const teacher = await requireVisitTeacherSession(db, request);
    const telegram = await disconnectTelegram(db, teacher.teacherUserId, input.value.expectedVersion, fetch);
    return telegramJson({ schemaVersion: 1, success: true, telegram });
  } catch (error) {
    return telegramStoreError(error);
  }
}
