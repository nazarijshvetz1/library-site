import { env } from "cloudflare:workers";

import { authorizeLibrarianApi, isSameOriginRequest } from "@/lib/librarian-api";
import { readTelegramJson, telegramDisconnectInput, telegramError, telegramJson, telegramStoreError } from "@/lib/telegram-api";
import {
  disconnectTelegram,
  resolveLibrarianTelegramUserId,
  type TelegramDatabase,
} from "@/lib/telegram-notifications";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi(); if (!authorization.ok) return authorization.response;
  if (!authorization.value.access.writesEnabled) return telegramError(503, "writes_disabled", "Зміни тимчасово вимкнено.");
  if (!isSameOriginRequest(request)) return telegramError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.");
  const body = await readTelegramJson(request); if (!body.ok) return body.response;
  const input = telegramDisconnectInput(body.value); if (!input.ok) return input.response;
  const db = env.DB as unknown as TelegramDatabase;
  try {
    const userId = await resolveLibrarianTelegramUserId(db, authorization.value.user);
    const telegram = await disconnectTelegram(db, userId, input.value.expectedVersion, fetch);
    return telegramJson({ schemaVersion: 1, success: true, telegram, writesEnabled: true });
  } catch (error) {
    return telegramStoreError(error);
  }
}
