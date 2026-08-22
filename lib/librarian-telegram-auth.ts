import { env } from "cloudflare:workers";
import { headers } from "next/headers";

import type { ChatGPTUser } from "@/app/chatgpt-auth";
import { isLibrarianEmailAllowed } from "@/lib/librarian-access";
import type { VisitD1Database } from "@/lib/visit-schedule-store";

export const LIBRARIAN_TELEGRAM_COOKIE = "__Host-librarian_telegram";
const SESSION_SECONDS = 12 * 60 * 60;
const MAX_ACTIVE_SESSIONS = 3;

export class LibrarianTelegramAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LibrarianTelegramAuthError";
  }
}

type LibrarianRow = {
  id: string;
  full_name: string;
  email: string;
  auth_user_id: string | null;
  role: "admin" | "librarian";
};

export async function createLibrarianTelegramSession(
  db: VisitD1Database,
  input: {
    telegramUserId: string;
    initDataHash: string;
    authDate: number;
  },
): Promise<{ token: string; user: ChatGPTUser; role: "admin" | "librarian"; expiresAt: string }> {
  if (!/^[1-9]\d{0,19}$/u.test(input.telegramUserId)
    || !/^[0-9a-f]{64}$/u.test(input.initDataHash)
    || !Number.isSafeInteger(input.authDate) || input.authDate <= 0) {
    throw authError();
  }
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const row = await db.prepare(`
    SELECT u.id,u.full_name,u.email,u.auth_user_id,u.role
    FROM telegram_connections c
    JOIN users u ON u.id=c.user_id
    WHERE c.telegram_user_id=? AND c.status='active'
      AND u.status='active' AND u.role IN ('admin','librarian')
      AND u.email IS NOT NULL
    LIMIT 2
  `).bind(input.telegramUserId).all<LibrarianRow>();
  const candidates = row.results ?? [];
  if (candidates.length !== 1 || !isLibrarianEmailAllowed(candidates[0].email)) {
    throw new LibrarianTelegramAuthError(
      "librarian_telegram_access_denied",
      403,
      "Цей Telegram не має чинного доступу бібліотекаря.",
    );
  }
  const librarian = candidates[0];
  const replay = await db.prepare(`
    SELECT init_data_hash FROM telegram_librarian_sessions WHERE init_data_hash=?
    UNION ALL
    SELECT init_data_hash FROM telegram_mini_app_auth_receipts WHERE init_data_hash=?
    LIMIT 1
  `).bind(input.initDataHash, input.initDataHash).first<{ init_data_hash: string }>();
  if (replay) {
    throw new LibrarianTelegramAuthError(
      "telegram_auth_replayed",
      409,
      "Це відкриття кабінету вже використано. Закрийте його й відкрийте з бота ще раз.",
    );
  }
  const token = randomOpaque(32);
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(nowDate.getTime() + SESSION_SECONDS * 1000).toISOString();
  try {
    await db.batch([
      db.prepare(`UPDATE telegram_librarian_sessions SET revoked_at=?,last_seen_at=?
        WHERE token_hash=(SELECT token_hash FROM telegram_librarian_sessions
          WHERE user_id=? AND revoked_at IS NULL AND expires_at>?
          ORDER BY created_at,token_hash LIMIT 1)
        AND (SELECT COUNT(*) FROM telegram_librarian_sessions
          WHERE user_id=? AND revoked_at IS NULL AND expires_at>?)>=?`)
        .bind(now, now, librarian.id, now, librarian.id, now, MAX_ACTIVE_SESSIONS),
      db.prepare(`INSERT INTO telegram_librarian_sessions (
          token_hash,init_data_hash,user_id,telegram_user_id,auth_date,
          expires_at,last_seen_at,revoked_at,created_at
        )
        SELECT ?,?,u.id,?, ?,?,?,NULL,?
        FROM users u JOIN telegram_connections c ON c.user_id=u.id
        WHERE u.id=? AND u.status='active' AND u.role IN ('admin','librarian')
          AND u.email=? AND c.telegram_user_id=? AND c.status='active'
          AND NOT EXISTS (SELECT 1 FROM telegram_librarian_sessions WHERE init_data_hash=?)
          AND NOT EXISTS (SELECT 1 FROM telegram_mini_app_auth_receipts WHERE init_data_hash=?)`)
        .bind(
          tokenHash,
          input.initDataHash,
          input.telegramUserId,
          input.authDate,
          expiresAt,
          now,
          now,
          librarian.id,
          librarian.email,
          input.telegramUserId,
          input.initDataHash,
          input.initDataHash,
        ),
      db.prepare(`DELETE FROM telegram_librarian_sessions
        WHERE expires_at<=? AND created_at<(SELECT COALESCE(MAX(created_at),'')
          FROM telegram_librarian_sessions)`).bind(now),
    ]);
  } catch {
    const consumed = await db.prepare(`SELECT init_data_hash FROM telegram_librarian_sessions
      WHERE init_data_hash=? LIMIT 1`).bind(input.initDataHash)
      .first<{ init_data_hash: string }>();
    if (consumed) {
      throw new LibrarianTelegramAuthError(
        "telegram_auth_replayed",
        409,
        "Це відкриття кабінету вже використано. Відкрийте його з бота ще раз.",
      );
    }
    throw new LibrarianTelegramAuthError(
      "librarian_telegram_session_unavailable",
      503,
      "Не вдалося створити захищений сеанс бібліотекаря.",
    );
  }
  const verified = await db.prepare(`SELECT token_hash FROM telegram_librarian_sessions
    WHERE token_hash=? AND user_id=? AND telegram_user_id=? AND revoked_at IS NULL
      AND expires_at>? LIMIT 1`).bind(tokenHash, librarian.id, input.telegramUserId, now)
    .first<{ token_hash: string }>();
  if (!verified) {
    throw new LibrarianTelegramAuthError(
      "librarian_telegram_session_unavailable",
      503,
      "Не вдалося підтвердити захищений сеанс бібліотекаря.",
    );
  }
  return {
    token,
    user: d1User(librarian),
    role: librarian.role,
    expiresAt,
  };
}

export async function readLibrarianTelegramUser(
  db: VisitD1Database = (env as unknown as { DB: VisitD1Database }).DB,
): Promise<{ user: ChatGPTUser; role: "admin" | "librarian" } | null> {
  const requestHeaders = await headers();
  const token = cookieValue(requestHeaders.get("cookie") ?? "", LIBRARIAN_TELEGRAM_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const now = new Date().toISOString();
  const row = await db.prepare(`
    SELECT u.id,u.full_name,u.email,u.auth_user_id,u.role
    FROM telegram_librarian_sessions s
    JOIN users u ON u.id=s.user_id
    JOIN telegram_connections c ON c.user_id=u.id
    WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>?
      AND s.telegram_user_id=c.telegram_user_id AND c.status='active'
      AND u.status='active' AND u.role IN ('admin','librarian')
      AND u.email IS NOT NULL
    LIMIT 2
  `).bind(tokenHash, now).all<LibrarianRow>();
  const candidates = row.results ?? [];
  if (candidates.length !== 1 || !isLibrarianEmailAllowed(candidates[0].email)) return null;
  return { user: d1User(candidates[0]), role: candidates[0].role };
}

export async function resolveD1LibrarianUser(
  db: VisitD1Database,
  user: ChatGPTUser,
): Promise<{ user: ChatGPTUser; role: "admin" | "librarian" } | null> {
  if (!isLibrarianEmailAllowed(user.email)) return null;
  const exactId = user.d1UserId ?? null;
  const rows = await db.prepare(`
    SELECT id,full_name,email,auth_user_id,role FROM users
    WHERE status='active' AND role IN ('admin','librarian') AND email IS NOT NULL
      AND ((? IS NOT NULL AND id=?)
        OR (? IS NULL AND (auth_user_id=? OR lower(email)=lower(?))))
    ORDER BY id LIMIT 2
  `).bind(exactId, exactId, exactId, user.userId, user.email).all<LibrarianRow>();
  const candidates = rows.results ?? [];
  if (candidates.length !== 1 || !isLibrarianEmailAllowed(candidates[0].email)) return null;
  return { user: d1User(candidates[0]), role: candidates[0].role };
}

export function librarianTelegramSessionCookie(token: string): string {
  return `${LIBRARIAN_TELEGRAM_COOKIE}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=None; Partitioned`;
}

export function clearLibrarianTelegramSessionCookie(): string {
  return `${LIBRARIAN_TELEGRAM_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None; Partitioned`;
}

function d1User(row: LibrarianRow): ChatGPTUser {
  return {
    userId: row.auth_user_id ?? `d1:${row.id}`,
    d1UserId: row.id,
    email: row.email,
    displayName: row.full_name,
    fullName: row.full_name,
  };
}

function cookieValue(header: string, name: string): string | null {
  for (const chunk of header.split(";")) {
    const separator = chunk.indexOf("=");
    if (separator < 0 || chunk.slice(0, separator).trim() !== name) continue;
    const value = chunk.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{32,128}$/u.test(value) ? value : null;
  }
  return null;
}

function authError(): LibrarianTelegramAuthError {
  return new LibrarianTelegramAuthError(
    "telegram_init_data_invalid",
    401,
    "Не вдалося підтвердити вхід через Telegram.",
  );
}

function randomOpaque(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
