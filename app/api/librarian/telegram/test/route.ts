import { env } from "cloudflare:workers";

import { authorizeLibrarianApi, isSameOriginRequest } from "@/lib/librarian-api";
import { telegramError, telegramJson, telegramStoreError } from "@/lib/telegram-api";
import {
  repairTelegramWebhookAndSendTestMessage,
  resolveLibrarianTelegramUserId,
  type TelegramDatabase,
} from "@/lib/telegram-notifications";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi(); if (!authorization.ok) return authorization.response;
  if (!authorization.value.access.writesEnabled) return telegramError(503, "writes_disabled", "Зміни тимчасово вимкнено.");
  if (!isSameOriginRequest(request)) return telegramError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.");
  const db = env.DB as unknown as TelegramDatabase;
  try {
    const userId = await resolveLibrarianTelegramUserId(db, authorization.value.user);
    await repairTelegramWebhookAndSendTestMessage(db, userId, new URL(request.url).origin);
    return telegramJson({ schemaVersion: 1, success: true, writesEnabled: true });
  } catch (error) {
    return telegramStoreError(error);
  }
}
