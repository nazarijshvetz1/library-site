import { isSameOriginRequest } from "./librarian-api.ts";
import { TeacherMaterialRequestError } from "./teacher-material-request-store.ts";
import { VisitScheduleError } from "./visit-schedule-store.ts";

const MAX_BODY_BYTES = 32 * 1024;
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
} as const;

export function materialRequestJson(
  body: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(PRIVATE_HEADERS);
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return Response.json(body, { ...init, headers });
}

export function materialRequestError(
  status: number,
  code: string,
  error: string,
  options: {
    fieldErrors?: Record<string, string>;
    details?: Record<string, unknown>;
    writesEnabled?: boolean;
  } = {},
): Response {
  return materialRequestJson(
    {
      schemaVersion: 1,
      success: false,
      code,
      error,
      ...(options.fieldErrors ? { fieldErrors: options.fieldErrors } : {}),
      ...(options.details ?? {}),
      ...(typeof options.writesEnabled === "boolean"
        ? { writesEnabled: options.writesEnabled }
        : {}),
    },
    { status },
  );
}

export async function readMaterialRequestJson(
  request: Request,
  writesEnabled?: boolean,
): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; response: Response }
> {
  if (!isSameOriginRequest(request)) {
    return {
      ok: false,
      response: materialRequestError(
        403,
        "cross_origin_request",
        "Запит має надійти з цього самого сайту.",
        { writesEnabled },
      ),
    };
  }
  if ((request.headers.get("Content-Encoding") ?? "identity").toLowerCase() !== "identity") {
    return {
      ok: false,
      response: materialRequestError(
        415,
        "unsupported_content_encoding",
        "Стиснене тіло запиту не підтримується.",
        { writesEnabled },
      ),
    };
  }
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
    return {
      ok: false,
      response: materialRequestError(
        415,
        "unsupported_media_type",
        "Надішліть дані у форматі JSON.",
        { writesEnabled },
      ),
    };
  }
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return {
      ok: false,
      response: materialRequestError(413, "body_too_large", "Тіло запиту завелике.", { writesEnabled }),
    };
  }
  if (!request.body) {
    return {
      ok: false,
      response: materialRequestError(400, "invalid_json", "Порожнє тіло запиту.", { writesEnabled }),
    };
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return {
          ok: false,
          response: materialRequestError(413, "body_too_large", "Тіло запиту завелике.", { writesEnabled }),
        };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON object expected");
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      response: materialRequestError(400, "invalid_json", "Некоректне тіло JSON.", { writesEnabled }),
    };
  }
}

export function materialRequestStoreError(
  error: unknown,
  fallbackCode: string,
  writesEnabled?: boolean,
): Response {
  if (error instanceof TeacherMaterialRequestError) {
    return materialRequestError(error.status, error.code, error.message, {
      details: error.details,
      writesEnabled,
    });
  }
  if (error instanceof VisitScheduleError) {
    return materialRequestError(error.status, error.code, error.message, { writesEnabled });
  }
  return materialRequestError(
    503,
    fallbackCode,
    "Сервіс заявок тимчасово недоступний. Спробуйте ще раз.",
    { writesEnabled },
  );
}

export function safePortalResourceId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

export function parseBoundedLimit(
  value: string | null,
  fallback: number,
  maximum: number,
): number | null {
  if (value === null || value.trim() === "") return fallback;
  if (!/^\d{1,3}$/u.test(value.trim())) return null;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= maximum
    ? limit
    : null;
}
