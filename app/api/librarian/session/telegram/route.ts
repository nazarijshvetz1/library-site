import { env } from "cloudflare:workers";

import {
  isSameOriginRequest,
  librarianError,
  librarianJson,
  readDraftJsonBody,
} from "@/lib/librarian-api";
import {
  createLibrarianTelegramSession,
  LibrarianTelegramAuthError,
  librarianTelegramSessionCookie,
} from "@/lib/librarian-telegram-auth";
import { validateTelegramMiniAppInitData } from "@/lib/telegram-mini-app-auth";
import type { VisitD1Database } from "@/lib/visit-schedule-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return librarianError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.", false);
  }
  const body = await readDraftJsonBody(request, false);
  if (!body.ok) return body.response;
  const keys = Object.keys(body.value);
  if (keys.length !== 1 || keys[0] !== "initData" || typeof body.value.initData !== "string") {
    return librarianError(400, "validation_failed", "Telegram не передав дані для входу.", false);
  }
  try {
    const telegram = await validateTelegramMiniAppInitData(body.value.initData);
    const result = await createLibrarianTelegramSession(
      env.DB as unknown as VisitD1Database,
      {
        telegramUserId: telegram.telegramUserId,
        initDataHash: telegram.initDataHash,
        authDate: telegram.authDate,
      },
    );
    return librarianJson({
      success: true,
      librarian: { displayName: result.user.displayName, role: result.role },
      expiresAt: result.expiresAt,
    }, {
      headers: { "Set-Cookie": librarianTelegramSessionCookie(result.token) },
    });
  } catch (error) {
    if (error instanceof LibrarianTelegramAuthError) {
      return librarianError(error.status, error.code, error.message, false);
    }
    if (error && typeof error === "object" && "status" in error && "code" in error) {
      const candidate = error as { status: unknown; code: unknown; message?: unknown };
      return librarianError(
        typeof candidate.status === "number" ? candidate.status : 503,
        typeof candidate.code === "string" ? candidate.code : "telegram_session_unavailable",
        typeof candidate.message === "string" ? candidate.message : "Вхід через Telegram тимчасово недоступний.",
        false,
      );
    }
    return librarianError(503, "telegram_session_unavailable", "Вхід через Telegram тимчасово недоступний.", false);
  }
}
