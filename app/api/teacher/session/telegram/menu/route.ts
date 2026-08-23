import { env } from "cloudflare:workers";

import { isSameOriginRequest } from "@/lib/librarian-api";
import { telegramError, telegramJson, telegramStoreError } from "@/lib/telegram-api";
import {
  refreshConnectedTeacherTelegramMenu,
  type TelegramDatabase,
} from "@/lib/telegram-notifications";
import { teacherPortalGate } from "@/lib/visit-schedule-api";
import type { VisitD1Database } from "@/lib/visit-schedule-store";
import { requireVisitTeacherSession } from "@/lib/visit-teacher-auth";

export const dynamic = "force-dynamic";

/** Refresh the rich bot menu only after the browser already owns a valid session cookie. */
export async function POST(request: Request): Promise<Response> {
  const gate = teacherPortalGate(); if (gate) return gate;
  if (!isSameOriginRequest(request)) {
    return telegramError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.");
  }
  const db = env.DB as unknown as TelegramDatabase & VisitD1Database;
  try {
    const teacher = await requireVisitTeacherSession(db, request);
    const menuMessageDelivered = await refreshConnectedTeacherTelegramMenu(
      db,
      {
        teacherUserId: teacher.teacherUserId,
        siteOrigin: new URL(request.url).origin,
      },
    );
    return telegramJson({ schemaVersion: 1, success: true, menuMessageDelivered });
  } catch (error) {
    return telegramStoreError(error);
  }
}
