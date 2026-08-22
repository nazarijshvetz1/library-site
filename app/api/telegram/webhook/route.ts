import { env } from "cloudflare:workers";

import { readTelegramWebhookBody, telegramError, telegramJson, telegramStoreError } from "@/lib/telegram-api";
import {
  processTelegramWebhookUpdate,
  telegramWebhookSecretMatches,
  type TelegramDatabase,
} from "@/lib/telegram-notifications";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!await telegramWebhookSecretMatches(secret)) {
    return telegramError(401, "webhook_authentication_failed", "Unauthorized.");
  }
  const body = await readTelegramWebhookBody(request); if (!body.ok) return body.response;
  try {
    const result = await processTelegramWebhookUpdate(
      env.DB as unknown as TelegramDatabase,
      body.raw,
      body.value,
      fetch,
      new URL(request.url).origin,
    );
    return telegramJson({ success: true, ...result });
  } catch (error) {
    return telegramStoreError(error, "webhook_processing_failed");
  }
}
