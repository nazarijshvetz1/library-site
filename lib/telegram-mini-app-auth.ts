import { getRuntimeBoolean, getRuntimeString } from "./runtime-env.ts";
import { VisitScheduleError } from "./visit-schedule-store.ts";

const TELEGRAM_INIT_DATA_MAX_BYTES = 16 * 1024;
const TELEGRAM_INIT_DATA_MAX_AGE_SECONDS = 5 * 60;
const TELEGRAM_INIT_DATA_FUTURE_SKEW_SECONDS = 60;
const TELEGRAM_INIT_DATA_RECEIPT_GRACE_SECONDS = 2 * 60;

export type TelegramMiniAppIdentity = {
  telegramUserId: string;
  initDataHash: string;
  authDate: number;
  expiresAt: string;
};

export function telegramMiniAppEnabled(): boolean {
  return getRuntimeBoolean("TELEGRAM_MINI_APP_ENABLED");
}

export function telegramMiniAppPublicConfiguration(): {
  enabled: boolean;
  botUsername: string | null;
} {
  const username = getRuntimeString("TELEGRAM_BOT_USERNAME")?.replace(/^@/u, "") ?? "";
  return {
    enabled: telegramMiniAppEnabled(),
    botUsername: /^[A-Za-z0-9_]{5,32}$/u.test(username) ? username : null,
  };
}

export async function validateTelegramMiniAppInitData(
  rawInitData: string,
  options: { now?: Date; botToken?: string; requireEnabled?: boolean } = {},
): Promise<TelegramMiniAppIdentity> {
  if (options.requireEnabled !== false && !telegramMiniAppEnabled()) {
    throw new VisitScheduleError(
      "telegram_mini_app_disabled",
      503,
      "Кабінет учителя в Telegram ще не ввімкнено.",
    );
  }
  const byteLength = new TextEncoder().encode(rawInitData).byteLength;
  if (!rawInitData || byteLength > TELEGRAM_INIT_DATA_MAX_BYTES) {
    throw invalidInitData();
  }
  const entries = [...new URLSearchParams(rawInitData).entries()];
  const seen = new Set<string>();
  for (const [key] of entries) {
    if (!key || seen.has(key)) throw invalidInitData();
    seen.add(key);
  }
  const suppliedHash = entries.find(([key]) => key === "hash")?.[1] ?? "";
  if (!/^[0-9a-f]{64}$/iu.test(suppliedHash)) throw invalidInitData();
  const botToken = options.botToken ?? getRuntimeString("TELEGRAM_BOT_TOKEN");
  if (!botToken) {
    throw new VisitScheduleError(
      "telegram_mini_app_unavailable",
      503,
      "Вхід через Telegram тимчасово недоступний.",
    );
  }
  const dataCheckString = entries
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const encoder = new TextEncoder();
  const derivationKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const secret = await crypto.subtle.sign("HMAC", derivationKey, encoder.encode(botToken));
  const verificationKey = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    verificationKey,
    hexBytes(suppliedHash).buffer as ArrayBuffer,
    encoder.encode(dataCheckString),
  );
  if (!valid) throw invalidInitData();

  const params = new URLSearchParams(rawInitData);
  const authDateText = params.get("auth_date") ?? "";
  if (!/^\d{1,12}$/u.test(authDateText)) throw invalidInitData();
  const authDate = Number(authDateText);
  const nowDate = options.now ?? new Date();
  const authTimeMs = authDate * 1000;
  const nowMs = nowDate.getTime();
  if (!Number.isSafeInteger(authDate) || authDate <= 0
    || authTimeMs > nowMs + TELEGRAM_INIT_DATA_FUTURE_SKEW_SECONDS * 1000
    || nowMs - authTimeMs >= TELEGRAM_INIT_DATA_MAX_AGE_SECONDS * 1000) {
    throw new VisitScheduleError(
      "telegram_init_data_expired",
      401,
      "Сеанс Telegram застарів. Закрийте кабінет і відкрийте його з бота ще раз.",
    );
  }
  const chatType = params.get("chat_type");
  if (chatType && chatType !== "private" && chatType !== "sender") throw invalidInitData();
  const userRaw = params.get("user");
  if (!userRaw || userRaw.length > 4096) throw invalidInitData();
  let user: Record<string, unknown>;
  try {
    const parsed = JSON.parse(userRaw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object expected");
    user = parsed as Record<string, unknown>;
  } catch {
    throw invalidInitData();
  }
  if (!Number.isSafeInteger(user.id) || Number(user.id) <= 0) throw invalidInitData();
  const expiresAt = new Date((
    authDate + TELEGRAM_INIT_DATA_MAX_AGE_SECONDS + TELEGRAM_INIT_DATA_RECEIPT_GRACE_SECONDS
  ) * 1000).toISOString();
  return {
    telegramUserId: String(user.id),
    // Telegram signs the canonicalized parameter set, so use the verified HMAC itself as the
    // one-use receipt key. Hashing the raw query string would allow the same signed launch to be
    // replayed after harmless reordering or percent-encoding changes.
    initDataHash: suppliedHash.toLowerCase(),
    authDate,
    expiresAt,
  };
}

function invalidInitData(): VisitScheduleError {
  return new VisitScheduleError(
    "telegram_init_data_invalid",
    401,
    "Не вдалося підтвердити вхід через Telegram. Відкрийте кабінет із бота ще раз.",
  );
}

function hexBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
