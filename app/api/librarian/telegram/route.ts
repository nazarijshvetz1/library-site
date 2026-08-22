import { env } from "cloudflare:workers";

import { authorizeLibrarianApi, isSameOriginRequest } from "@/lib/librarian-api";
import { scheduleTelegramOutboxDrain } from "@/lib/telegram-delivery-runtime";
import {
  readTelegramConnectionStatus,
  resolveLibrarianTelegramUserId,
  type TelegramDatabase,
  updateTelegramPreferences,
} from "@/lib/telegram-notifications";
import {
  readTelegramJson,
  telegramError,
  telegramJson,
  telegramPreferencesInput,
  telegramStoreError,
} from "@/lib/telegram-api";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi(); if (!authorization.ok) return authorization.response;
  const db = env.DB as unknown as TelegramDatabase;
  try {
    const userId = await resolveLibrarianTelegramUserId(db, authorization.value.user);
    const telegram = await readTelegramConnectionStatus(db, userId);
    scheduleTelegramOutboxDrain(db, request.url);
    return telegramJson({ schemaVersion: 1, success: true, telegram, writesEnabled: authorization.value.access.writesEnabled });
  } catch (error) {
    return telegramStoreError(error);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi(); if (!authorization.ok) return authorization.response;
  if (!authorization.value.access.writesEnabled) return telegramError(503, "writes_disabled", "Зміни тимчасово вимкнено.");
  if (!isSameOriginRequest(request)) return telegramError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.");
  const body = await readTelegramJson(request); if (!body.ok) return body.response;
  const input = telegramPreferencesInput(body.value); if (!input.ok) return input.response;
  const db = env.DB as unknown as TelegramDatabase;
  try {
    const userId = await resolveLibrarianTelegramUserId(db, authorization.value.user);
    const telegram = await updateTelegramPreferences(db, userId, input.value);
    return telegramJson({ schemaVersion: 1, success: true, telegram, writesEnabled: true });
  } catch (error) {
    return telegramStoreError(error);
  }
}
