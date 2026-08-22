import { env } from "cloudflare:workers";

import { scheduleTelegramOutboxDrain } from "@/lib/telegram-delivery-runtime";
import {
  readTelegramConnectionStatus,
  type TelegramDatabase,
  updateTelegramPreferences,
} from "@/lib/telegram-notifications";
import {
  readTelegramJson,
  telegramJson,
  telegramPreferencesInput,
  telegramStoreError,
} from "@/lib/telegram-api";
import { requireVisitTeacherSession } from "@/lib/visit-teacher-auth";
import { teacherPortalGate } from "@/lib/visit-schedule-api";
import type { VisitD1Database } from "@/lib/visit-schedule-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const gate = teacherPortalGate(); if (gate) return gate;
  const db = env.DB as unknown as TelegramDatabase & VisitD1Database;
  try {
    const teacher = await requireVisitTeacherSession(db, request);
    const telegram = await readTelegramConnectionStatus(db, teacher.teacherUserId);
    scheduleTelegramOutboxDrain(db, request.url);
    return telegramJson({ schemaVersion: 1, success: true, telegram });
  } catch (error) {
    return telegramStoreError(error);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const gate = teacherPortalGate(); if (gate) return gate;
  const body = await readTelegramJson(request); if (!body.ok) return body.response;
  const input = telegramPreferencesInput(body.value); if (!input.ok) return input.response;
  const db = env.DB as unknown as TelegramDatabase & VisitD1Database;
  try {
    const teacher = await requireVisitTeacherSession(db, request);
    const telegram = await updateTelegramPreferences(db, teacher.teacherUserId, input.value);
    return telegramJson({ schemaVersion: 1, success: true, telegram });
  } catch (error) {
    return telegramStoreError(error);
  }
}
