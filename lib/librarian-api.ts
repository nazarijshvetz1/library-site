import { env } from "cloudflare:workers";

import { getChatGPTUser, type ChatGPTUser } from "@/app/chatgpt-auth";
import {
  getLibrarianAccess,
  type LibrarianAccess,
} from "@/lib/librarian-access";
import {
  readLibrarianTelegramUser,
  resolveD1LibrarianUser,
} from "@/lib/librarian-telegram-auth";
import type { VisitD1Database } from "@/lib/visit-schedule-store";

export const MAX_DRAFT_BODY_BYTES = 48 * 1024;

const JSON_HEADERS = {
  "Cache-Control": "private, no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
} as const;

export type AuthorizedLibrarian = {
  user: ChatGPTUser;
  access: LibrarianAccess & { allowed: true };
};

type AuthorizationResult =
  | { ok: true; value: AuthorizedLibrarian }
  | { ok: false; response: Response };

type JsonBodyResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; response: Response };

export async function authorizeLibrarianApi(): Promise<AuthorizationResult> {
  const chatGPTUser = await getChatGPTUser();
  const db = (env as unknown as { DB?: VisitD1Database }).DB;
  let resolved: { user: ChatGPTUser; role: "admin" | "librarian" } | null = null;
  try {
    if (db && chatGPTUser) resolved = await resolveD1LibrarianUser(db, chatGPTUser);
    if (db && !chatGPTUser) resolved = await readLibrarianTelegramUser(db);
  } catch {
    return {
      ok: false,
      response: librarianError(503, "authorization_unavailable", "Не вдалося перевірити доступ бібліотекаря.", false),
    };
  }
  const user = resolved?.user ?? chatGPTUser;
  const access = getLibrarianAccess(user);

  if (!user) {
    return {
      ok: false,
      response: librarianError(
        401,
        "authentication_required",
        "Увійдіть через ChatGPT, щоб відкрити кабінет бібліотекаря.",
        false,
      ),
    };
  }

  if (!access.allowed || !resolved) {
    return {
      ok: false,
      response: librarianError(
        403,
        access.reason === "not_configured"
          ? "allowlist_not_configured"
          : "access_denied",
        access.reason === "not_configured"
          ? "Доступ до кабінету ще не налаштовано адміністратором."
          : "Цей обліковий запис не має доступу до кабінету бібліотекаря.",
        false,
      ),
    };
  }

  return {
    ok: true,
    value: {
      user,
      access: { ...access, allowed: true, role: resolved.role },
    },
  };
}

export function librarianJson(
  body: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(JSON_HEADERS);
  if (init.headers) {
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  }
  return Response.json(body, { ...init, headers });
}

export function librarianError(
  status: number,
  code: string,
  error: string,
  writesEnabled: boolean,
  fieldErrors?: Record<string, string>,
): Response {
  return librarianJson(
    {
      success: false,
      code,
      error,
      ...(fieldErrors && Object.keys(fieldErrors).length > 0
        ? { fieldErrors }
        : {}),
      writesEnabled,
    },
    { status },
  );
}

export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return false;

  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export async function readDraftJsonBody(
  request: Request,
  writesEnabled: boolean,
): Promise<JsonBodyResult> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return {
      ok: false,
      response: librarianError(
        415,
        "unsupported_media_type",
        "Надішліть дані у форматі JSON.",
        writesEnabled,
      ),
    };
  }

  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength && Number(declaredLength) > MAX_DRAFT_BODY_BYTES) {
    return {
      ok: false,
      response: librarianError(
        413,
        "body_too_large",
        "Чернетка завелика.",
        writesEnabled,
      ),
    };
  }

  if (!request.body) {
    return {
      ok: false,
      response: librarianError(
        400,
        "invalid_json",
        "Тіло запиту порожнє.",
        writesEnabled,
      ),
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
      if (total > MAX_DRAFT_BODY_BYTES) {
        await reader.cancel();
        return {
          ok: false,
          response: librarianError(
            413,
            "body_too_large",
            "Чернетка завелика.",
            writesEnabled,
          ),
        };
      }
      chunks.push(value);
    }
  } catch {
    return {
      ok: false,
      response: librarianError(
        400,
        "invalid_body",
        "Не вдалося прочитати тіло запиту.",
        writesEnabled,
      ),
    };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!isRecord(parsed)) throw new Error("Expected a JSON object");
    return { ok: true, value: parsed };
  } catch {
    return {
      ok: false,
      response: librarianError(
        400,
        "invalid_json",
        "JSON має бути коректним об’єктом.",
        writesEnabled,
      ),
    };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
