import { isSameOriginRequest } from "./librarian-api.ts";
import { TelegramIntegrationError } from "./telegram-notifications.ts";

const JSON_HEADERS = {
  "Cache-Control": "private, no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
} as const;

export function telegramJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(JSON_HEADERS);
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return Response.json(body, { ...init, headers });
}

export function telegramError(status: number, code: string, error: string): Response {
  return telegramJson({ schemaVersion: 1, success: false, code, error }, { status });
}

export function telegramStoreError(error: unknown, fallbackCode = "telegram_unavailable"): Response {
  if (error instanceof TelegramIntegrationError) {
    return telegramError(error.status, error.code, error.message);
  }
  return telegramError(503, fallbackCode, "Telegram-сповіщення тимчасово недоступні.");
}

export async function readTelegramJson(
  request: Request,
  maximumBytes = 8 * 1024,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  if (!isSameOriginRequest(request)) {
    return { ok: false, response: telegramError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.") };
  }
  if ((request.headers.get("Content-Encoding") ?? "identity").toLowerCase() !== "identity") {
    return { ok: false, response: telegramError(415, "unsupported_content_encoding", "Стиснене тіло не підтримується.") };
  }
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
    return { ok: false, response: telegramError(415, "unsupported_media_type", "Надішліть JSON.") };
  }
  const body = await readBoundedText(request, maximumBytes);
  if (!body.ok) return body;
  try {
    const value = JSON.parse(body.value) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object expected");
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, response: telegramError(400, "invalid_json", "Некоректне тіло JSON.") };
  }
}

export async function readTelegramWebhookBody(
  request: Request,
  maximumBytes = 64 * 1024,
): Promise<{ ok: true; raw: string; value: unknown } | { ok: false; response: Response }> {
  if ((request.headers.get("Content-Encoding") ?? "identity").toLowerCase() !== "identity") {
    return { ok: false, response: telegramError(415, "unsupported_content_encoding", "Unsupported encoding.") };
  }
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
    return { ok: false, response: telegramError(415, "unsupported_media_type", "JSON required.") };
  }
  const body = await readBoundedText(request, maximumBytes);
  if (!body.ok) return body;
  try {
    return { ok: true, raw: body.value, value: JSON.parse(body.value) as unknown };
  } catch {
    return { ok: false, response: telegramError(400, "invalid_json", "Invalid JSON.") };
  }
}

export function telegramPreferencesInput(value: Record<string, unknown>):
  | { ok: true; value: { notifyOrders: boolean; notifyVisits: boolean; expectedVersion: number } }
  | { ok: false; response: Response } {
  if (!exactKeys(value, ["notifyOrders", "notifyVisits", "expectedVersion"])
    || typeof value.notifyOrders !== "boolean" || typeof value.notifyVisits !== "boolean"
    || value.notifyOrders !== value.notifyVisits
    || !positiveInteger(value.expectedVersion)) {
    return { ok: false, response: telegramError(400, "validation_failed", "Некоректні налаштування Telegram.") };
  }
  return {
    ok: true,
    value: {
      notifyOrders: value.notifyOrders,
      notifyVisits: value.notifyVisits,
      expectedVersion: value.expectedVersion,
    },
  };
}

export function telegramDisconnectInput(value: Record<string, unknown>):
  | { ok: true; value: { expectedVersion: number; confirmation: "disconnect_telegram" } }
  | { ok: false; response: Response } {
  if (!exactKeys(value, ["confirmation", "expectedVersion"])
    || !positiveInteger(value.expectedVersion) || value.confirmation !== "disconnect_telegram") {
    return { ok: false, response: telegramError(400, "validation_failed", "Підтвердіть повне від’єднання Telegram.") };
  }
  return {
    ok: true,
    value: { expectedVersion: value.expectedVersion, confirmation: "disconnect_telegram" },
  };
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

async function readBoundedText(
  request: Request,
  maximumBytes: number,
): Promise<{ ok: true; value: string } | { ok: false; response: Response }> {
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) {
    return { ok: false, response: telegramError(413, "body_too_large", "Тіло запиту завелике.") };
  }
  if (!request.body) return { ok: false, response: telegramError(400, "invalid_json", "Порожнє тіло запиту.") };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        return { ok: false, response: telegramError(413, "body_too_large", "Тіло запиту завелике.") };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { ok: true, value: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, response: telegramError(400, "invalid_json", "Некоректне тіло запиту.") };
  }
}
