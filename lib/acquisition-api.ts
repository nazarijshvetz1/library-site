import { isSameOriginRequest } from "./librarian-api.ts";
import { AcquisitionStoreError } from "./acquisition-store.ts";
import { VisitScheduleError } from "./visit-schedule-store.ts";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
} as const;
const PUBLIC_HEADERS = {
  ...PRIVATE_HEADERS,
  "Cache-Control": "public, max-age=0, no-store",
  "Referrer-Policy": "same-origin",
} as const;

export function acquisitionJson(body: unknown, init: ResponseInit = {}, isPublic = false): Response {
  const headers = new Headers(isPublic ? PUBLIC_HEADERS : PRIVATE_HEADERS);
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return Response.json(body, { ...init, headers });
}

export function acquisitionError(
  status: number,
  code: string,
  error: string,
  options: { fieldErrors?: Record<string, string>; writesEnabled?: boolean; details?: Record<string, unknown> } = {},
  isPublic = false,
): Response {
  return acquisitionJson({
    schemaVersion: 1,
    success: false,
    code,
    error,
    ...(options.fieldErrors ? { fieldErrors: options.fieldErrors } : {}),
    ...(typeof options.writesEnabled === "boolean" ? { writesEnabled: options.writesEnabled } : {}),
    ...(options.details ?? {}),
  }, { status }, isPublic);
}

export async function readAcquisitionJson(
  request: Request,
  options: { maximumBytes?: number; writesEnabled?: boolean; publicForm?: boolean } = {},
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  const isPublic = options.publicForm === true;
  const origin = request.headers.get("Origin");
  if ((!isPublic || origin) && !isSameOriginRequest(request)) {
    return { ok: false, response: acquisitionError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.", { writesEnabled: options.writesEnabled }, isPublic) };
  }
  if ((request.headers.get("Content-Encoding") ?? "identity").toLowerCase() !== "identity") {
    return { ok: false, response: acquisitionError(415, "unsupported_content_encoding", "Стиснене тіло запиту не підтримується.", { writesEnabled: options.writesEnabled }, isPublic) };
  }
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
    return { ok: false, response: acquisitionError(415, "unsupported_media_type", "Надішліть дані у форматі JSON.", { writesEnabled: options.writesEnabled }, isPublic) };
  }
  const maximum = options.maximumBytes ?? 48 * 1024;
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > maximum) return { ok: false, response: acquisitionError(413, "body_too_large", "Тіло запиту завелике.", { writesEnabled: options.writesEnabled }, isPublic) };
  if (!request.body) return { ok: false, response: acquisitionError(400, "invalid_json", "Порожнє тіло запиту.", { writesEnabled: options.writesEnabled }, isPublic) };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        return { ok: false, response: acquisitionError(413, "body_too_large", "Тіло запиту завелике.", { writesEnabled: options.writesEnabled }, isPublic) };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object expected");
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, response: acquisitionError(400, "invalid_json", "Некоректне тіло JSON.", { writesEnabled: options.writesEnabled }, isPublic) };
  }
}

export function acquisitionStoreError(error: unknown, fallbackCode: string, writesEnabled?: boolean, isPublic = false): Response {
  if (error instanceof AcquisitionStoreError) {
    return acquisitionError(error.status, error.code, error.message, { details: error.details, writesEnabled }, isPublic);
  }
  if (error instanceof VisitScheduleError) {
    return acquisitionError(error.status, error.code, error.message, { writesEnabled }, isPublic);
  }
  return acquisitionError(503, fallbackCode, "Сервіс комплектування тимчасово недоступний. Спробуйте ще раз.", { writesEnabled }, isPublic);
}

export function safeAcquisitionId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}
