import { env } from "cloudflare:workers";

import { isSameOriginRequest } from "@/lib/librarian-api";
import { telegramError, telegramJson, telegramStoreError } from "@/lib/telegram-api";
import { sendTelegramTestMessage, type TelegramDatabase } from "@/lib/telegram-notifications";
import { requireVisitTeacherSession } from "@/lib/visit-teacher-auth";
import { teacherPortalGate } from "@/lib/visit-schedule-api";
import type { VisitD1Database } from "@/lib/visit-schedule-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const gate = teacherPortalGate(); if (gate) return gate;
  if (!isSameOriginRequest(request)) return telegramError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.");
  const db = env.DB as unknown as TelegramDatabase & VisitD1Database;
  try {
    const teacher = await requireVisitTeacherSession(db, request);
    await sendTelegramTestMessage(db, teacher.teacherUserId, new URL(request.url).origin);
    return telegramJson({ schemaVersion: 1, success: true });
  } catch (error) {
    return telegramStoreError(error);
  }
}
