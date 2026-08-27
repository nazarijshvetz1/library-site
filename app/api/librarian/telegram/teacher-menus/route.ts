import { env } from "cloudflare:workers";

import { authorizeLibrarianApi, isSameOriginRequest } from "@/lib/librarian-api";
import { scheduleTelegramOutboxDrain } from "@/lib/telegram-delivery-runtime";
import {
  queueTelegramTeacherMenuRefresh,
  readTelegramTeacherMenuRollout,
  resolveLibrarianTelegramUserId,
  telegramConfigurationStatus,
  type TelegramDatabase,
} from "@/lib/telegram-notifications";
import {
  readTelegramJson,
  telegramError,
  telegramJson,
  telegramStoreError,
  telegramTeacherMenuRefreshInput,
} from "@/lib/telegram-api";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  const db = env.DB as unknown as TelegramDatabase;
  try {
    const rollout = await readTelegramTeacherMenuRollout(db);
    scheduleTelegramOutboxDrain(db, request.url, { maxBatches: 2 });
    return telegramJson({
      schemaVersion: 1,
      success: true,
      rollout,
      writesEnabled: authorization.value.access.writesEnabled,
    });
  } catch (error) {
    return telegramStoreError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  if (!authorization.value.access.writesEnabled) {
    return telegramError(503, "writes_disabled", "Зміни тимчасово вимкнено.");
  }
  if (!isSameOriginRequest(request)) {
    return telegramError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.");
  }
  const configuration = telegramConfigurationStatus();
  if (!configuration.configured || !configuration.linkingEnabled) {
    return telegramError(503, "telegram_linking_unavailable", "Telegram-бот зараз не готовий до оновлення меню.");
  }
  const body = await readTelegramJson(request);
  if (!body.ok) return body.response;
  const input = telegramTeacherMenuRefreshInput(body.value);
  if (!input.ok) return input.response;
  const db = env.DB as unknown as TelegramDatabase;
  try {
    const actorId = await resolveLibrarianTelegramUserId(db, authorization.value.user);
    const result = await queueTelegramTeacherMenuRefresh(
      db,
      { id: actorId, email: authorization.value.user.email },
      input.value,
    );
    scheduleTelegramOutboxDrain(db, request.url, { maxBatches: 6 });
    return telegramJson({
      schemaVersion: 1,
      success: true,
      rollout: result.rollout,
      queuedNow: result.queuedNow,
      writesEnabled: true,
    });
  } catch (error) {
    return telegramStoreError(error);
  }
}
