import { getRuntimeString } from "./runtime-env.ts";
import { VisitScheduleError, type VisitD1Database } from "./visit-schedule-store.ts";

export const VISIT_GUEST_COOKIE = "__Host-visit_guest";
export const VISIT_GUEST_SESSION_SECONDS = 30 * 24 * 60 * 60;

const SESSION_CREATE_LIMIT = 60;
const SESSION_CREATE_WINDOW_MS = 60 * 60 * 1000;
const DIRECTORY_LIMIT = 300;
const DIRECTORY_WINDOW_MS = 60 * 1000;
const MUTATION_IP_LIMIT = 60;
const MUTATION_SESSION_LIMIT = 20;
const MUTATION_WINDOW_MS = 15 * 60 * 1000;

export type VisitGuestIdentity = {
  guestOwnerId: string;
  tokenHash: string;
  pendingScope: string;
  ipScopeHash: string;
  expiresAt: string;
};

export type GuestTeacherDirectoryRow = {
  teacherRef: string;
  fullName: string;
};

type GuestSessionRow = {
  id: string;
  token_hash: string;
  pending_scope: string;
  ip_scope_hash: string;
  expires_at: string;
};

export function guestAuthPepper(): string {
  const pepper = getRuntimeString("VISIT_GUEST_AUTH_PEPPER");
  if (!pepper || pepper.length < 32) {
    throw new VisitScheduleError("guest_auth_unavailable", 503, "Гостьовий запис тимчасово недоступний.");
  }
  return pepper;
}

export async function createVisitGuestSession(
  db: VisitD1Database,
  request: Request,
): Promise<{ identity: VisitGuestIdentity; token: string }> {
  const ip = trustedClientIp(request);
  const pepper = guestAuthPepper();
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const token = randomOpaque(32);
  const tokenHash = await sha256Hex(token);
  const ipScopeHash = await hmacHex(pepper, `guest-ip:${ip}`);
  const createScopeHash = await hmacHex(pepper, `guest-session-create:${ip}`);
  await assertRateAvailable(db, createScopeHash, nowDate, SESSION_CREATE_WINDOW_MS, SESSION_CREATE_LIMIT);
  const guestOwnerId = `GST-${crypto.randomUUID()}`;
  const pendingScope = randomOpaque(24);
  const expiresAt = new Date(nowDate.getTime() + VISIT_GUEST_SESSION_SECONDS * 1000).toISOString();

  try {
    await db.batch([
      incrementRateStatement(db, createScopeHash, nowDate, SESSION_CREATE_WINDOW_MS),
      rateLimitGuardStatement(db, createScopeHash, SESSION_CREATE_LIMIT, now),
      db.prepare(`INSERT INTO visit_guest_sessions (
        id, token_hash, pending_scope, ip_scope_hash, expires_at, last_seen_at, revoked_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`).bind(
        guestOwnerId, tokenHash, pendingScope, ipScopeHash, expiresAt, now, now,
      ),
      db.prepare(`INSERT INTO audit_events (
        id, actor_user_id, actor_email, action, entity_type, entity_id,
        request_id, before_json, after_json, metadata_json, created_at
      ) VALUES (?, NULL, 'guest@local.invalid', 'visit.guest_session.create',
        'visit_guest_session', CASE WHEN EXISTS (
          SELECT 1 FROM visit_guest_sessions WHERE id=? AND token_hash=? AND revoked_at IS NULL
        ) THEN ? ELSE NULL END, NULL, NULL, NULL, NULL, ?)`)
        .bind(`AUD-${crypto.randomUUID()}`, guestOwnerId, tokenHash, guestOwnerId, now),
      boundedGuestSessionCleanup(db, now),
      boundedGuestRateCleanup(db, nowDate),
    ]);
  } catch {
    await assertRateAvailable(db, createScopeHash, nowDate, SESSION_CREATE_WINDOW_MS, SESSION_CREATE_LIMIT);
    throw new VisitScheduleError("guest_session_unavailable", 503, "Не вдалося відкрити захищену гостьову сесію.");
  }
  return {
    token,
    identity: { guestOwnerId, tokenHash, pendingScope, ipScopeHash, expiresAt },
  };
}

export async function requireVisitGuestSession(
  db: VisitD1Database,
  request: Request,
): Promise<VisitGuestIdentity> {
  const token = cookieValue(request.headers.get("Cookie"), VISIT_GUEST_COOKIE);
  if (!token) throw new VisitScheduleError("guest_session_required", 401, "Відкрийте гостьову сесію ще раз.");
  const tokenHash = await sha256Hex(token);
  const now = new Date().toISOString();
  const row = await db.prepare(`SELECT id, token_hash, pending_scope, ip_scope_hash, expires_at
    FROM visit_guest_sessions WHERE token_hash=? AND revoked_at IS NULL AND expires_at>? LIMIT 1`)
    .bind(tokenHash, now).first<GuestSessionRow>();
  if (!row) throw new VisitScheduleError("guest_session_expired", 401, "Гостьова сесія завершилася. Відкрийте її ще раз.");
  return {
    guestOwnerId: row.id,
    tokenHash: row.token_hash,
    pendingScope: row.pending_scope,
    ipScopeHash: row.ip_scope_hash,
    expiresAt: row.expires_at,
  };
}

export async function revokeVisitGuestSession(db: VisitD1Database, request: Request): Promise<void> {
  const token = cookieValue(request.headers.get("Cookie"), VISIT_GUEST_COOKIE);
  if (!token) return;
  const now = new Date().toISOString();
  await db.batch([db.prepare(`UPDATE visit_guest_sessions SET revoked_at=?, last_seen_at=?
    WHERE token_hash=? AND revoked_at IS NULL`).bind(now, now, await sha256Hex(token))]);
}

export async function enforceGuestMutationRate(
  db: VisitD1Database,
  request: Request,
  identity: VisitGuestIdentity,
): Promise<void> {
  const nowDate = new Date();
  const ip = trustedClientIp(request);
  const pepper = guestAuthPepper();
  const currentIpHash = await hmacHex(pepper, `guest-ip:${ip}`);
  const sessionHash = await hmacHex(pepper, `guest-mutation-session:${identity.guestOwnerId}`);
  await assertRateAvailable(db, currentIpHash, nowDate, MUTATION_WINDOW_MS, MUTATION_IP_LIMIT);
  await assertRateAvailable(db, sessionHash, nowDate, MUTATION_WINDOW_MS, MUTATION_SESSION_LIMIT);
  try {
    await db.batch([
      incrementRateStatement(db, currentIpHash, nowDate, MUTATION_WINDOW_MS),
      rateLimitGuardStatement(db, currentIpHash, MUTATION_IP_LIMIT, nowDate.toISOString()),
      incrementRateStatement(db, sessionHash, nowDate, MUTATION_WINDOW_MS),
      rateLimitGuardStatement(db, sessionHash, MUTATION_SESSION_LIMIT, nowDate.toISOString()),
      db.prepare(`UPDATE visit_guest_sessions SET last_seen_at=?
        WHERE id=? AND token_hash=? AND revoked_at IS NULL AND expires_at>?`)
        .bind(nowDate.toISOString(), identity.guestOwnerId, identity.tokenHash, nowDate.toISOString()),
    ]);
  } catch {
    await assertRateAvailable(db, currentIpHash, nowDate, MUTATION_WINDOW_MS, MUTATION_IP_LIMIT);
    await assertRateAvailable(db, sessionHash, nowDate, MUTATION_WINDOW_MS, MUTATION_SESSION_LIMIT);
    throw new VisitScheduleError("guest_session_expired", 401, "Р“РѕСЃС‚СЊРѕРІР° СЃРµСЃС–СЏ Р·Р°РІРµСЂС€РёР»Р°СЃСЏ.");
  }
}

export async function listGuestTeacherDirectory(
  db: VisitD1Database,
  request: Request,
  query: string,
): Promise<GuestTeacherDirectoryRow[]> {
  const ip = trustedClientIp(request);
  const pepper = guestAuthPepper();
  const nowDate = new Date();
  const scopeHash = await hmacHex(pepper, `guest-directory:${ip}`);
  await assertRateAvailable(db, scopeHash, nowDate, DIRECTORY_WINDOW_MS, DIRECTORY_LIMIT);
  try {
    await db.batch([
      incrementRateStatement(db, scopeHash, nowDate, DIRECTORY_WINDOW_MS),
      rateLimitGuardStatement(db, scopeHash, DIRECTORY_LIMIT, nowDate.toISOString()),
    ]);
  } catch {
    await assertRateAvailable(db, scopeHash, nowDate, DIRECTORY_WINDOW_MS, DIRECTORY_LIMIT);
    throw new VisitScheduleError("teacher_directory_unavailable", 503, "Р”РѕРІС–РґРЅРёРє С‚РёРјС‡Р°СЃРѕРІРѕ РЅРµРґРѕСЃС‚СѓРїРЅРёР№.");
  }
  const normalized = query.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (normalized.length < 3 || normalized.length > 80) {
    throw new VisitScheduleError("validation_failed", 400, "Введіть від 3 до 80 символів імені.");
  }
  const rows = await db.prepare(`SELECT id, full_name FROM users
    WHERE role='teacher' AND status='active' ORDER BY sort_name,id LIMIT 101`)
    .all<{ id: string; full_name: string }>();
  if ((rows.results ?? []).length > 100) {
    throw new VisitScheduleError("teacher_result_limit", 409, "У довіднику понад 100 активних учителів.");
  }
  const needle = normalized.toLocaleLowerCase("uk-UA");
  const matches = (rows.results ?? []).filter((row) => row.full_name.normalize("NFKC")
    .toLocaleLowerCase("uk-UA").includes(needle));
  if (matches.length > 10) {
    throw new VisitScheduleError("teacher_search_too_broad", 400, "Уточніть ім’я вчителя.");
  }
  return Promise.all(matches.map(async (row) => ({
    teacherRef: await guestTeacherRef(row.id),
    fullName: row.full_name,
  })));
}

export async function resolveGuestTeacherRef(
  db: VisitD1Database,
  teacherRef: string,
): Promise<{ id: string; fullName: string } | null> {
  const rows = await db.prepare(`SELECT id, full_name FROM users
    WHERE role='teacher' AND status='active' ORDER BY id LIMIT 101`)
    .all<{ id: string; full_name: string }>();
  if ((rows.results ?? []).length > 100) {
    throw new VisitScheduleError("teacher_result_limit", 409, "У довіднику понад 100 активних учителів.");
  }
  for (const row of rows.results ?? []) {
    if (constantTimeEqual(await guestTeacherRef(row.id), teacherRef)) {
      return { id: row.id, fullName: row.full_name };
    }
  }
  return null;
}

export async function guestTeacherRef(teacherUserId: string): Promise<string> {
  return hmacHex(guestAuthPepper(), `guest-teacher-ref:${teacherUserId}`);
}

export function guestSessionCookie(token: string): string {
  return `${VISIT_GUEST_COOKIE}=${token}; Path=/; Max-Age=${VISIT_GUEST_SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearGuestSessionCookie(): string {
  return `${VISIT_GUEST_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function incrementRateStatement(
  db: VisitD1Database,
  scopeHash: string,
  nowDate: Date,
  windowMs: number,
) {
  const now = nowDate.toISOString();
  const windowStart = new Date(nowDate.getTime() - windowMs).toISOString();
  return db.prepare(`INSERT INTO visit_guest_rate_limits (
      scope_hash,attempts,window_started_at,blocked_until,updated_at
    ) VALUES (?,1,?,NULL,?) ON CONFLICT(scope_hash) DO UPDATE SET
      attempts=CASE WHEN window_started_at<? THEN 1 ELSE attempts+1 END,
      window_started_at=CASE WHEN window_started_at<? THEN excluded.window_started_at ELSE window_started_at END,
      blocked_until=NULL, updated_at=excluded.updated_at`)
    .bind(scopeHash, now, now, windowStart, windowStart);
}

function rateLimitGuardStatement(
  db: VisitD1Database,
  scopeHash: string,
  limit: number,
  now: string,
) {
  return db.prepare(`INSERT INTO visit_guest_rate_limits (
      scope_hash,attempts,window_started_at,blocked_until,updated_at
    ) SELECT CASE WHEN (SELECT attempts FROM visit_guest_rate_limits WHERE scope_hash=?)<=?
        THEN ? ELSE NULL END,0,?,NULL,?
      ON CONFLICT(scope_hash) DO NOTHING`)
    .bind(scopeHash, limit, scopeHash, now, now);
}

async function assertRateAvailable(
  db: VisitD1Database,
  scopeHash: string,
  nowDate: Date,
  windowMs: number,
  limit: number,
): Promise<void> {
  const windowStart = new Date(nowDate.getTime() - windowMs).toISOString();
  const row = await db.prepare(`SELECT attempts,window_started_at,blocked_until
    FROM visit_guest_rate_limits WHERE scope_hash=? LIMIT 1`).bind(scopeHash)
    .first<{ attempts: number; window_started_at: string; blocked_until: string | null }>();
  if (row && row.window_started_at >= windowStart && Number(row.attempts) >= limit) {
    throw new VisitScheduleError("rate_limited", 429, "Забагато запитів. Спробуйте пізніше.");
  }
}

function boundedGuestSessionCleanup(db: VisitD1Database, now: string) {
  return db.prepare(`DELETE FROM visit_guest_sessions WHERE id IN (
    SELECT s.id FROM visit_guest_sessions s WHERE (s.expires_at<=? OR s.revoked_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM visit_bookings b WHERE b.guest_owner_id=s.id OR b.cancelled_by_guest_owner_id=s.id)
    ORDER BY s.expires_at LIMIT 100
  )`).bind(now);
}

function boundedGuestRateCleanup(db: VisitD1Database, nowDate: Date) {
  return db.prepare(`DELETE FROM visit_guest_rate_limits WHERE scope_hash IN (
    SELECT scope_hash FROM visit_guest_rate_limits WHERE updated_at<? ORDER BY updated_at LIMIT 100
  )`).bind(new Date(nowDate.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString());
}

function trustedClientIp(request: Request): string {
  const value = request.headers.get("CF-Connecting-IP")?.trim();
  if (!value) throw new VisitScheduleError("client_ip_unavailable", 503, "Не вдалося безпечно перевірити запит.");
  return value.slice(0, 128);
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{40,180}$/u.test(value) ? value : null;
  }
  return null;
}

function randomOpaque(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function bytesToHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let different = 0;
  for (let index = 0; index < left.length; index += 1) {
    different |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return different === 0;
}
