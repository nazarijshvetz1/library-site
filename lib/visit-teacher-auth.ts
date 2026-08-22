import { getRuntimeBoolean, getRuntimeString } from "./runtime-env.ts";
import { VisitScheduleError, type VisitD1Database } from "./visit-schedule-store.ts";

export const VISIT_TEACHER_COOKIE = "__Host-visit_teacher";
export const VISIT_TEACHER_TELEGRAM_COOKIE = "__Host-visit_teacher_telegram";
export const VISIT_TEACHER_CODE_LENGTH = 10;
export const VISIT_TEACHER_PIN_LENGTH = 4;
export const VISIT_TEACHER_SESSION_SECONDS = 12 * 60 * 60;
export const VISIT_TEACHER_BULK_LIMIT = 100;

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const LOGIN_IP_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_PAIR_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_TEACHER_WINDOW_MS = 60 * 60 * 1000;
const LOGIN_IP_LIMIT = 300;
const LOGIN_PAIR_LIMIT = 5;
const LOGIN_TEACHER_LIMIT = 20;
const DIRECTORY_IP_LIMIT = 300;
const MAX_ACTIVE_SESSIONS = 3;

type CredentialRow = {
  teacher_user_id: string;
  full_name: string;
  login_id: string;
  code_hmac: string;
  must_change_pin: number;
  status: "active" | "disabled";
  version: number;
  failed_attempts: number;
  failure_window_started_at: string | null;
  locked_until: string | null;
};

export type VisitTeacherIdentity = {
  teacherUserId: string;
  fullName: string;
  credentialVersion: number;
  tokenHash: string;
  pendingScope: string;
  expiresAt: string;
  mustChangePin: boolean;
};

export type VisitTeacherCredentialProjection = {
  status: "active" | "disabled" | "locked";
  version: number;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  activeSessions: number;
  mustChangePin: boolean;
};

export type VisitTeacherAccessRow = {
  id: string;
  fullName: string;
  status: "active" | "inactive";
  credential: VisitTeacherCredentialProjection | null;
};

export type VisitTeacherCodeImportRow = {
  teacherUserId: string;
  fullName: string;
  code: string;
};

export type VisitTeacherCodeImportInput = {
  requestId: string;
  confirmation: "IMPORT_MISSING_TEACHER_CODES";
  rows: VisitTeacherCodeImportRow[];
};

export type TeacherCodeRotationResult = {
  credentialVersion: number;
  pendingScope: string;
  expiresAt: string;
  mustChangePin: false;
};

export function teacherAuthPepper(): string {
  const pepper = getRuntimeString("VISIT_TEACHER_AUTH_PEPPER");
  if (!pepper || pepper.length < 32) {
    throw new VisitScheduleError(
      "teacher_auth_unavailable",
      503,
      "Вхід учителя тимчасово недоступний.",
    );
  }
  return pepper;
}

export function visitTeacherCodeAuthEnabled(): boolean {
  return getRuntimeBoolean("VISIT_TEACHER_CODE_AUTH_ENABLED");
}

export function requireVisitTeacherCodeAuthEnabled(): void {
  if (!visitTeacherCodeAuthEnabled()) {
    throw new VisitScheduleError("teacher_code_auth_disabled", 503, "Вхід учителя тимчасово вимкнено.");
  }
}

export async function listVisitTeacherDirectory(
  db: VisitD1Database,
  query: string,
  request?: Request,
): Promise<Array<{ loginId: string; fullName: string; publicHint: null }>> {
  requireVisitTeacherCodeAuthEnabled();
  if (request) await enforceDirectoryRateLimit(db, request);
  const normalized = query.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (normalized.length < 3 || normalized.length > 80) {
    throw new VisitScheduleError("validation_failed", 400, "Введіть від 3 до 80 символів імені.");
  }
  const rows = await db.prepare(`
    SELECT c.login_id, u.full_name
    FROM visit_teacher_credentials c
    JOIN users u ON u.id = c.teacher_user_id
    WHERE c.status = 'active' AND u.status = 'active'
      AND EXISTS (SELECT 1 FROM teacher_profiles cap WHERE cap.teacher_user_id=u.id AND cap.closed_at IS NULL)
    ORDER BY u.sort_name, u.id LIMIT 101
  `).all<{ login_id: string; full_name: string }>();
  if ((rows.results ?? []).length > 100) {
    throw new VisitScheduleError("teacher_result_limit", 409, "У базі понад 100 учителів.");
  }
  const needle = normalized.toLocaleLowerCase("uk-UA");
  const matches = (rows.results ?? []).filter((row) => row.full_name
    .normalize("NFKC").toLocaleLowerCase("uk-UA").includes(needle));
  if (matches.length > 10) {
    throw new VisitScheduleError("teacher_search_too_broad", 400, "Уточніть ім’я вчителя.");
  }
  return matches.map((row) => ({
    loginId: row.login_id,
    fullName: row.full_name,
    publicHint: null,
  }));
}

async function enforceDirectoryRateLimit(db: VisitD1Database, request: Request): Promise<void> {
  const ip = trustedClientIp(request);
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const windowStart = new Date(nowDate.getTime() - 60_000).toISOString();
  const scopeHash = await hmacHex(teacherAuthPepper(), `directory-ip:${ip}`);
  const row = await db.prepare(`SELECT attempts, window_started_at FROM visit_teacher_login_limits
    WHERE scope_hash = ? LIMIT 1`).bind(scopeHash).first<{ attempts: number; window_started_at: string }>();
  if (row && row.window_started_at >= windowStart && Number(row.attempts) >= DIRECTORY_IP_LIMIT) {
    throw new VisitScheduleError("rate_limited", 429, "Забагато запитів. Спробуйте за хвилину.");
  }
  await db.batch([db.prepare(`
    INSERT INTO visit_teacher_login_limits (scope_hash, attempts, window_started_at, blocked_until, updated_at)
    VALUES (?, 1, ?, NULL, ?)
    ON CONFLICT(scope_hash) DO UPDATE SET
      attempts = CASE WHEN visit_teacher_login_limits.window_started_at < ? THEN 1 ELSE visit_teacher_login_limits.attempts + 1 END,
      window_started_at = CASE WHEN visit_teacher_login_limits.window_started_at < ? THEN excluded.window_started_at ELSE visit_teacher_login_limits.window_started_at END,
      blocked_until = NULL, updated_at = excluded.updated_at
  `).bind(scopeHash, now, now, windowStart, windowStart),
  boundedLimitCleanup(db, nowDate)]);
}

export async function createVisitTeacherSession(
  db: VisitD1Database,
  request: Request,
  input: { loginId: string; code: string },
): Promise<{ token: string; identity: VisitTeacherIdentity }> {
  requireVisitTeacherCodeAuthEnabled();
  const pepper = teacherAuthPepper();
  const loginId = input.loginId.trim();
  const code = normalizeCode(input.code);
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const ip = trustedClientIp(request);
  const ipRateScopeHash = await hmacHex(pepper, `ip:${ip}`);
  const pairRateScopeHash = await hmacHex(pepper, `pair:${ip}:${loginId}`);
  if (await anyRateLimitBlocked(db, [ipRateScopeHash, pairRateScopeHash], now)) {
    throw new VisitScheduleError("rate_limited", 429, "Забагато спроб входу. Спробуйте пізніше.");
  }
  const safeLoginId = /^[A-Za-z0-9_-]{16,128}$/u.test(loginId);
  const credential = safeLoginId
    ? await db.prepare(`
        SELECT c.teacher_user_id, u.full_name, c.login_id, c.code_hmac, c.status,
               c.must_change_pin, c.version, c.failed_attempts,
               c.failure_window_started_at, c.locked_until
        FROM visit_teacher_credentials c
        JOIN users u ON u.id = c.teacher_user_id
        WHERE c.login_id = ? AND u.status = 'active'
          AND EXISTS (SELECT 1 FROM teacher_profiles cap WHERE cap.teacher_user_id=u.id AND cap.closed_at IS NULL) LIMIT 1
      `).bind(loginId).first<CredentialRow>()
    : null;
  const codeShapeValid = credential
    ? credentialCodeShape(code, Boolean(credential.must_change_pin))
    : temporaryCodeShape(code) || pinShape(code);
  const presented = credential
    ? await hmacHex(pepper, `code:${credential.teacher_user_id}:${code}`)
    : await hmacHex(pepper, `code:unknown:${code}`);
  const allowed = codeShapeValid && credential?.status === "active"
    && (!credential.locked_until || credential.locked_until <= now)
    && constantTimeHexEqual(presented, credential.code_hmac);

  if (!allowed || !credential) {
    await recordFailedLogin(
      db,
      ipRateScopeHash,
      pairRateScopeHash,
      credential,
      nowDate,
      presented,
    );
    throw new VisitScheduleError("invalid_teacher_credentials", 401, "Не вдалося увійти. Перевірте ім’я та код.");
  }

  const token = randomOpaque(32);
  const tokenHash = await sha256Hex(token);
  const sessionIpScopeHash = await hmacHex(pepper, `session-ip:${ip}`);
  const pendingScope = randomOpaque(18);
  const expiresAt = new Date(nowDate.getTime() + VISIT_TEACHER_SESSION_SECONDS * 1000).toISOString();
  const statements = [
    db.prepare(`UPDATE visit_teacher_sessions SET revoked_at=?
      WHERE token_hash=(SELECT token_hash FROM visit_teacher_sessions
        WHERE teacher_user_id=? AND revoked_at IS NULL AND expires_at>?
        ORDER BY created_at, token_hash LIMIT 1)
      AND (SELECT COUNT(*) FROM visit_teacher_sessions
        WHERE teacher_user_id=? AND revoked_at IS NULL AND expires_at>?) >= ?`)
      .bind(now, credential.teacher_user_id, now, credential.teacher_user_id, now, MAX_ACTIVE_SESSIONS),
    db.prepare(`
      INSERT INTO visit_teacher_sessions (
        token_hash, teacher_user_id, credential_version, pending_scope, ip_scope_hash,
        expires_at, last_seen_at, revoked_at, created_at
      )
      SELECT ?, c.teacher_user_id, c.version, ?, ?, ?, ?, NULL, ?
      FROM visit_teacher_credentials c
      JOIN users u ON u.id = c.teacher_user_id
      WHERE c.teacher_user_id = ? AND c.login_id = ? AND c.code_hmac = ?
        AND c.status = 'active' AND c.version = ?
        AND (c.locked_until IS NULL OR c.locked_until <= ?)
        AND u.status = 'active'
        AND EXISTS (SELECT 1 FROM teacher_profiles cap WHERE cap.teacher_user_id=u.id AND cap.closed_at IS NULL)
    `).bind(
      tokenHash, pendingScope, sessionIpScopeHash, expiresAt, now, now,
      credential.teacher_user_id, loginId, presented, credential.version, now,
    ),
    db.prepare(`
      UPDATE visit_teacher_credentials
      SET failed_attempts = 0, failure_window_started_at = NULL, locked_until = NULL,
          last_login_at = ?, updated_at = ?
      WHERE teacher_user_id = ? AND version = ? AND status = 'active' AND code_hmac = ?
    `).bind(now, now, credential.teacher_user_id, credential.version, presented),
    db.prepare(`INSERT INTO audit_events (
      id, actor_user_id, actor_email, action, entity_type, entity_id,
      request_id, before_json, after_json, metadata_json, created_at
    ) VALUES (?, ?, 'teacher-code@local.invalid', 'visit.teacher_session.guard',
      'visit_teacher_session',
      CASE WHEN EXISTS (
        SELECT 1 FROM visit_teacher_sessions s
        JOIN visit_teacher_credentials c ON c.teacher_user_id=s.teacher_user_id
        JOIN users u ON u.id=s.teacher_user_id
        WHERE s.token_hash=? AND s.teacher_user_id=? AND s.credential_version=?
          AND s.pending_scope=? AND s.revoked_at IS NULL AND s.expires_at=?
          AND c.login_id=? AND c.code_hmac=? AND c.status='active' AND c.version=?
          AND (c.locked_until IS NULL OR c.locked_until<=?)
          AND u.status='active'
          AND EXISTS (SELECT 1 FROM teacher_profiles cap WHERE cap.teacher_user_id=u.id AND cap.closed_at IS NULL)
      ) THEN ? ELSE NULL END,
      ?, NULL, NULL, NULL, ?)`)
      .bind(
        `AUD-${crypto.randomUUID()}`, credential.teacher_user_id,
        tokenHash, credential.teacher_user_id, credential.version, pendingScope, expiresAt,
        loginId, presented, credential.version, now, tokenHash, tokenHash, now,
      ),
  ];
  statements.push(
    db.prepare("DELETE FROM visit_teacher_login_limits WHERE scope_hash = ?").bind(pairRateScopeHash),
    boundedSessionCleanup(db, now),
    boundedLimitCleanup(db, nowDate),
  );
  try {
    await db.batch(statements);
  } catch {
    throw new VisitScheduleError("teacher_auth_unavailable", 503, "Вхід учителя тимчасово недоступний.");
  }
  const identity = await readVisitTeacherSessionByHash(db, tokenHash, now);
  if (!identity) throw new VisitScheduleError("invalid_teacher_credentials", 401, "Не вдалося увійти. Перевірте ім’я та код.");
  return { token, identity };
}

/** Exchange one verified Telegram Mini App launch for the ordinary teacher browser session. */
export async function createVisitTeacherTelegramSession(
  db: VisitD1Database,
  request: Request,
  input: {
    telegramUserId: string;
    initDataHash: string;
    authDate: number;
    receiptExpiresAt: string;
  },
): Promise<{ token: string | null; identity: VisitTeacherIdentity }> {
  requireVisitTeacherCodeAuthEnabled();
  if (!/^[1-9]\d{0,19}$/u.test(input.telegramUserId)
    || !/^[0-9a-f]{64}$/u.test(input.initDataHash)
    || !Number.isSafeInteger(input.authDate) || input.authDate <= 0
    || !validIsoTimestamp(input.receiptExpiresAt)) {
    throw new VisitScheduleError("telegram_init_data_invalid", 401, "Не вдалося підтвердити вхід через Telegram.");
  }
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const credential = await db.prepare(`
    SELECT c.user_id AS teacher_user_id,u.full_name,v.version,v.must_change_pin,v.locked_until
    FROM telegram_connections c
    JOIN users u ON u.id=c.user_id
    JOIN visit_teacher_credentials v ON v.teacher_user_id=u.id
    WHERE c.telegram_user_id=? AND c.status='active'
      AND u.status='active'
      AND EXISTS (SELECT 1 FROM teacher_profiles cap WHERE cap.teacher_user_id=u.id AND cap.closed_at IS NULL)
      AND v.status='active'
    LIMIT 1
  `).bind(input.telegramUserId).first<{
    teacher_user_id: string;
    full_name: string;
    version: number;
    must_change_pin: number;
    locked_until: string | null;
  }>();
  if (!credential) {
    throw new VisitScheduleError(
      "telegram_connection_required",
      401,
      "Цей Telegram не підключено до активного кабінету вчителя.",
    );
  }
  if (credential.must_change_pin) {
    throw new VisitScheduleError(
      "pin_change_required",
      403,
      "Спочатку увійдіть на сайті тимчасовим кодом і створіть власний PIN.",
    );
  }
  if (credential.locked_until && credential.locked_until > now) {
    throw new VisitScheduleError("teacher_locked", 423, "Вхід тимчасово заблоковано. Спробуйте пізніше.");
  }
  for (const existingToken of readTeacherSessionTokens(request)) {
    const existingIdentity = await readVisitTeacherSessionByHash(db, await sha256Hex(existingToken), now);
    if (existingIdentity?.teacherUserId === credential.teacher_user_id) {
      return { token: null, identity: existingIdentity };
    }
  }
  const replay = await db.prepare(`SELECT init_data_hash FROM telegram_mini_app_auth_receipts
    WHERE init_data_hash=? LIMIT 1`).bind(input.initDataHash).first<{ init_data_hash: string }>();
  if (replay) {
    throw new VisitScheduleError(
      "telegram_auth_replayed",
      409,
      "Це відкриття кабінету вже використано. Закрийте його й відкрийте з бота ще раз.",
    );
  }
  const pepper = teacherAuthPepper();
  const token = randomOpaque(32);
  const tokenHash = await sha256Hex(token);
  const sessionIpScopeHash = await hmacHex(pepper, `session-ip:${trustedClientIp(request)}`);
  const pendingScope = randomOpaque(18);
  const expiresAt = new Date(nowDate.getTime() + VISIT_TEACHER_SESSION_SECONDS * 1000).toISOString();
  const auditId = `AUD-${crypto.randomUUID()}`;
  const statements = [
    db.prepare(`UPDATE visit_teacher_sessions SET revoked_at=?
      WHERE token_hash=(SELECT token_hash FROM visit_teacher_sessions
        WHERE teacher_user_id=? AND revoked_at IS NULL AND expires_at>?
        ORDER BY created_at,token_hash LIMIT 1)
      AND (SELECT COUNT(*) FROM visit_teacher_sessions
        WHERE teacher_user_id=? AND revoked_at IS NULL AND expires_at>?) >= ?`)
      .bind(now, credential.teacher_user_id, now, credential.teacher_user_id, now, MAX_ACTIVE_SESSIONS),
    db.prepare(`
      INSERT INTO telegram_mini_app_auth_receipts (
        init_data_hash,telegram_user_id,teacher_user_id,session_token_hash,
        auth_date,consumed_at,expires_at,created_at
      )
      SELECT ?,c.telegram_user_id,u.id,?,?,?,?,?
      FROM telegram_connections c
      JOIN users u ON u.id=c.user_id
      JOIN visit_teacher_credentials v ON v.teacher_user_id=u.id
      WHERE c.telegram_user_id=? AND c.status='active'
        AND u.id=? AND u.status='active'
        AND EXISTS (SELECT 1 FROM teacher_profiles cap WHERE cap.teacher_user_id=u.id AND cap.closed_at IS NULL)
        AND v.status='active' AND v.version=? AND v.must_change_pin=0
        AND (v.locked_until IS NULL OR v.locked_until<=?)
        AND NOT EXISTS (SELECT 1 FROM telegram_mini_app_auth_receipts WHERE init_data_hash=?)
    `).bind(
      input.initDataHash,
      tokenHash,
      input.authDate,
      now,
      input.receiptExpiresAt,
      now,
      input.telegramUserId,
      credential.teacher_user_id,
      credential.version,
      now,
      input.initDataHash,
    ),
    db.prepare(`
      INSERT INTO visit_teacher_sessions (
        token_hash,teacher_user_id,credential_version,pending_scope,ip_scope_hash,
        expires_at,last_seen_at,revoked_at,created_at
      )
      SELECT ?,r.teacher_user_id,v.version,?,?,?, ?,NULL,?
      FROM telegram_mini_app_auth_receipts r
      JOIN telegram_connections c ON c.telegram_user_id=r.telegram_user_id AND c.user_id=r.teacher_user_id
      JOIN users u ON u.id=r.teacher_user_id
      JOIN visit_teacher_credentials v ON v.teacher_user_id=r.teacher_user_id
      WHERE r.init_data_hash=? AND r.session_token_hash=? AND r.consumed_at=?
        AND r.teacher_user_id=? AND r.expires_at>=?
        AND c.status='active' AND u.status='active'
        AND EXISTS (SELECT 1 FROM teacher_profiles cap WHERE cap.teacher_user_id=u.id AND cap.closed_at IS NULL)
        AND v.status='active' AND v.version=? AND v.must_change_pin=0
        AND (v.locked_until IS NULL OR v.locked_until<=?)
    `).bind(
      tokenHash,
      pendingScope,
      sessionIpScopeHash,
      expiresAt,
      now,
      now,
      input.initDataHash,
      tokenHash,
      now,
      credential.teacher_user_id,
      now,
      credential.version,
      now,
    ),
    db.prepare(`UPDATE visit_teacher_credentials SET last_login_at=?,updated_at=?
      WHERE teacher_user_id=? AND version=? AND status='active'
        AND EXISTS (SELECT 1 FROM visit_teacher_sessions
          WHERE token_hash=? AND teacher_user_id=? AND revoked_at IS NULL)`)
      .bind(now, now, credential.teacher_user_id, credential.version, tokenHash, credential.teacher_user_id),
    db.prepare(`INSERT INTO audit_events (
      id,actor_user_id,actor_email,action,entity_type,entity_id,
      request_id,before_json,after_json,metadata_json,created_at
    ) VALUES (?,?,'teacher-telegram@local.invalid','visit.teacher_session.telegram',
      'visit_teacher_session',CASE WHEN EXISTS (
        SELECT 1 FROM visit_teacher_sessions s
        JOIN telegram_mini_app_auth_receipts r ON r.session_token_hash=s.token_hash
        WHERE s.token_hash=? AND s.teacher_user_id=? AND s.credential_version=?
          AND s.pending_scope=? AND s.expires_at=? AND s.revoked_at IS NULL
          AND r.init_data_hash=? AND r.telegram_user_id=? AND r.expires_at>=?
      ) THEN ? ELSE NULL END,?,NULL,NULL,NULL,?)`)
      .bind(
        auditId,
        credential.teacher_user_id,
        tokenHash,
        credential.teacher_user_id,
        credential.version,
        pendingScope,
        expiresAt,
        input.initDataHash,
        input.telegramUserId,
        now,
        tokenHash,
        input.initDataHash,
        now,
      ),
    boundedSessionCleanup(db, now),
    boundedTelegramReceiptCleanup(db, now),
  ];
  try {
    await db.batch(statements);
  } catch {
    const consumed = await db.prepare(`SELECT init_data_hash FROM telegram_mini_app_auth_receipts
      WHERE init_data_hash=? LIMIT 1`).bind(input.initDataHash).first<{ init_data_hash: string }>();
    if (consumed) {
      throw new VisitScheduleError(
        "telegram_auth_replayed",
        409,
        "Це відкриття кабінету вже використано. Закрийте його й відкрийте з бота ще раз.",
      );
    }
    throw new VisitScheduleError(
      "teacher_auth_unavailable",
      503,
      "Вхід через Telegram тимчасово недоступний.",
    );
  }
  const identity = await readVisitTeacherSessionByHash(db, tokenHash, now);
  if (!identity) {
    throw new VisitScheduleError(
      "teacher_auth_unavailable",
      503,
      "Вхід через Telegram тимчасово недоступний.",
    );
  }
  return { token, identity };
}

export async function requireVisitTeacherSession(
  db: VisitD1Database,
  request: Request,
  options: { allowPinSetup?: boolean } = {},
): Promise<VisitTeacherIdentity> {
  requireVisitTeacherCodeAuthEnabled();
  const tokens = readTeacherSessionTokens(request);
  if (!tokens.length) {
    throw new VisitScheduleError("authentication_required", 401, "Увійдіть за ім’ям і особистим кодом.");
  }
  let identity: VisitTeacherIdentity | null = null;
  const now = new Date().toISOString();
  for (const token of tokens) {
    identity = await readVisitTeacherSessionByHash(db, await sha256Hex(token), now);
    if (identity) break;
  }
  if (!identity) {
    throw new VisitScheduleError("authentication_required", 401, "Сеанс завершився. Увійдіть ще раз.");
  }
  if (identity.mustChangePin && !options.allowPinSetup) {
    throw new VisitScheduleError("pin_change_required", 403, "Створіть власний PIN, щоб відкрити кабінет учителя.");
  }
  return identity;
}

export async function revokeVisitTeacherSession(
  db: VisitD1Database,
  request: Request,
): Promise<void> {
  const token = readTeacherSessionTokens(request)[0];
  if (!token) return;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`UPDATE visit_teacher_sessions SET revoked_at = ?, last_seen_at = ?
      WHERE token_hash = ? AND revoked_at IS NULL`).bind(now, now, await sha256Hex(token)),
  ]);
}

/** Change a librarian-issued temporary code or an existing PIN to a teacher-chosen 4-digit PIN. */
export async function rotateVisitTeacherCode(
  db: VisitD1Database,
  request: Request,
  input: { requestId: string; currentCode: string; newPin: string },
): Promise<{ token: string | null; identity: VisitTeacherIdentity; result: TeacherCodeRotationResult }> {
  requireVisitTeacherCodeAuthEnabled();
  const rawSessionToken = readTeacherSessionTokens(request)[0];
  if (!rawSessionToken) {
    throw new VisitScheduleError("authentication_required", 401, "Увійдіть за ім’ям і особистим кодом.");
  }
  const presentedTokenHash = await sha256Hex(rawSessionToken);
  const initialNow = new Date().toISOString();
  const presentedSession = await db.prepare(`SELECT s.token_hash,s.teacher_user_id,s.credential_version,
      s.pending_scope,s.expires_at,s.revoked_at,u.full_name,c.must_change_pin
    FROM visit_teacher_sessions s JOIN users u ON u.id=s.teacher_user_id
    JOIN visit_teacher_credentials c ON c.teacher_user_id=s.teacher_user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.status='active'
      AND EXISTS (SELECT 1 FROM teacher_profiles cap WHERE cap.teacher_user_id=u.id AND cap.closed_at IS NULL) LIMIT 1`)
    .bind(presentedTokenHash, initialNow).first<{
      token_hash: string; teacher_user_id: string; credential_version: number;
      pending_scope: string; expires_at: string; revoked_at: string | null; full_name: string;
      must_change_pin: number;
    }>();
  if (!presentedSession) {
    throw new VisitScheduleError("authentication_required", 401, "Сеанс завершився. Увійдіть ще раз.");
  }
  const teacher: VisitTeacherIdentity = {
    teacherUserId: presentedSession.teacher_user_id,
    fullName: presentedSession.full_name,
    credentialVersion: Number(presentedSession.credential_version),
    tokenHash: presentedSession.token_hash,
    pendingScope: presentedSession.pending_scope,
    expiresAt: presentedSession.expires_at,
    mustChangePin: Boolean(presentedSession.must_change_pin),
  };
  const currentCode = normalizeCode(input.currentCode);
  const newPin = normalizePin(input.newPin);
  if ((!temporaryCodeShape(currentCode) && !pinShape(currentCode)) || !pinShape(newPin)) {
    throw new VisitScheduleError("validation_failed", 400, "Введіть поточний код і новий PIN із 4 цифр.");
  }
  if (!strongTeacherPin(newPin)) {
    throw new VisitScheduleError("weak_new_pin", 400, "PIN надто простий. Оберіть інші 4 цифри.");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.requestId)) {
    throw new VisitScheduleError("validation_failed", 400, "Некоректний requestId.");
  }
  const pepper = teacherAuthPepper();
  const currentHmac = await hmacHex(pepper, `code:${teacher.teacherUserId}:${currentCode}`);
  const newHmac = await hmacHex(pepper, `code:${teacher.teacherUserId}:${newPin}`);
  if (constantTimeHexEqual(currentHmac, newHmac)) {
    throw new VisitScheduleError("new_code_unchanged", 400, "Новий код має відрізнятися від поточного.");
  }
  const ownerKey = `teacher:${teacher.teacherUserId}`;
  const requestHash = await sha256Hex(JSON.stringify({
    kind: "teacher.pin.change",
    ownerKey,
    requestId: input.requestId,
    currentHmac,
    newHmac,
  }));
  const existing = await db.prepare(`SELECT owner_auth_user_id,status,request_hash,result_json
    FROM visit_mutation_commands WHERE id=? LIMIT 1`).bind(input.requestId).first<{
      owner_auth_user_id: string; status: string; request_hash: string; result_json: string | null;
    }>();
  if (existing) {
    if (existing.owner_auth_user_id !== ownerKey || existing.request_hash !== requestHash) {
      throw new VisitScheduleError("request_id_conflict", 409, "Цей requestId уже використано для іншої зміни.");
    }
    if (existing.status !== "completed" || !existing.result_json) {
      throw new VisitScheduleError("mutation_in_progress", 409, "Зміна коду ще виконується.");
    }
    let result: TeacherCodeRotationResult;
    try { result = JSON.parse(existing.result_json) as TeacherCodeRotationResult; } catch {
      throw new VisitScheduleError("mutation_result_invalid", 503, "Збережений результат зміни коду пошкоджено.");
    }
    if (presentedSession.revoked_at === null
      && teacher.credentialVersion === result.credentialVersion
      && teacher.pendingScope === result.pendingScope
      && teacher.expiresAt === result.expiresAt) {
      return { token: null, identity: teacher, result };
    }
    const recovered = await recoverRotatedTeacherSession(
      db, request, teacher, input.requestId, requestHash, newHmac, result,
    );
    return recovered;
  }

  if (presentedSession.revoked_at !== null) {
    throw new VisitScheduleError("authentication_required", 401, "Сеанс завершився. Увійдіть ще раз.");
  }

  const credential = await db.prepare(`SELECT c.teacher_user_id,u.full_name,c.login_id,c.code_hmac,c.status,
      c.must_change_pin,c.version,c.failed_attempts,c.failure_window_started_at,c.locked_until
    FROM visit_teacher_credentials c JOIN users u ON u.id=c.teacher_user_id
    WHERE c.teacher_user_id=? AND u.status='active'
      AND EXISTS (SELECT 1 FROM teacher_profiles cap WHERE cap.teacher_user_id=u.id AND cap.closed_at IS NULL) LIMIT 1`)
    .bind(teacher.teacherUserId).first<CredentialRow>();
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const ip = trustedClientIp(request);
  const ipRateScopeHash = await hmacHex(pepper, `ip:${ip}`);
  const pairRateScopeHash = credential
    ? await hmacHex(pepper, `pair:${ip}:${credential.login_id}`)
    : null;
  if ((credential?.locked_until && credential.locked_until > now)
    || await anyRateLimitBlocked(
      db,
      pairRateScopeHash ? [ipRateScopeHash, pairRateScopeHash] : [ipRateScopeHash],
      now,
    )) {
    throw new VisitScheduleError("rate_limited", 429, "Забагато спроб зміни коду. Спробуйте пізніше.");
  }
  if (!credential || !credentialCodeShape(currentCode, Boolean(credential.must_change_pin))
    || credential.status !== "active" || credential.version !== teacher.credentialVersion
    || !constantTimeHexEqual(credential.code_hmac, currentHmac)) {
    if (credential) {
      await recordFailedLogin(
        db,
        ipRateScopeHash,
        pairRateScopeHash!,
        credential,
        nowDate,
        currentHmac,
      );
    }
    throw new VisitScheduleError("invalid_current_code", 401, "Поточний код неправильний.");
  }

  const token = randomOpaque(32);
  const tokenHash = await sha256Hex(token);
  const pendingScope = randomOpaque(18);
  const ipScopeHash = await hmacHex(pepper, `session-ip:${ip}`);
  const expiresAt = new Date(nowDate.getTime() + VISIT_TEACHER_SESSION_SECONDS * 1000).toISOString();
  const nextVersion = teacher.credentialVersion + 1;
  const result: TeacherCodeRotationResult = {
    credentialVersion: nextVersion,
    pendingScope,
    expiresAt,
    mustChangePin: false,
  };
  const statements = [
    db.prepare(`INSERT INTO visit_mutation_commands (
      id,owner_auth_user_id,kind,request_hash,status,target_id,result_json,created_at,updated_at,completed_at
    ) VALUES (?,?, 'teacher_code_rotate',?,'processing',?,NULL,?,?,NULL)`)
      .bind(input.requestId, ownerKey, requestHash, teacher.teacherUserId, now, now),
    db.prepare(`UPDATE visit_teacher_credentials SET code_hmac=?,must_change_pin=0,version=version+1,
        failed_attempts=0,failure_window_started_at=NULL,locked_until=NULL,last_login_at=?,
        code_rotated_at=?,last_access_command_id=?,updated_by_user_id=?,updated_at=?
      WHERE teacher_user_id=? AND status='active' AND version=? AND code_hmac=?
        AND must_change_pin=?
        AND (locked_until IS NULL OR locked_until<=?)
        AND NOT EXISTS (SELECT 1 FROM visit_teacher_login_limits
          WHERE scope_hash IN (?,?) AND blocked_until IS NOT NULL AND blocked_until>?)
        AND EXISTS (SELECT 1 FROM users active_user WHERE active_user.id=? AND active_user.status='active'
          AND EXISTS (SELECT 1 FROM teacher_profiles cap WHERE cap.teacher_user_id=active_user.id AND cap.closed_at IS NULL))
        AND EXISTS (SELECT 1 FROM visit_teacher_sessions WHERE token_hash=? AND teacher_user_id=?
          AND credential_version=? AND revoked_at IS NULL AND expires_at>?)`)
      .bind(newHmac, now, now, input.requestId, teacher.teacherUserId, now,
        teacher.teacherUserId, teacher.credentialVersion, currentHmac, teacher.mustChangePin ? 1 : 0,
        now, ipRateScopeHash, pairRateScopeHash, now, teacher.teacherUserId,
        teacher.tokenHash, teacher.teacherUserId, teacher.credentialVersion, now),
    db.prepare(`INSERT INTO visit_teacher_sessions (
      token_hash,teacher_user_id,credential_version,pending_scope,ip_scope_hash,
      expires_at,last_seen_at,revoked_at,created_at
    ) SELECT ?,c.teacher_user_id,c.version,?,?,?, ?,NULL,?
      FROM visit_teacher_credentials c JOIN users u ON u.id=c.teacher_user_id
      WHERE c.teacher_user_id=? AND c.status='active' AND c.version=? AND c.code_hmac=?
        AND c.must_change_pin=0
        AND c.last_access_command_id=? AND u.status='active'
        AND EXISTS (SELECT 1 FROM teacher_profiles cap WHERE cap.teacher_user_id=u.id AND cap.closed_at IS NULL)
        AND EXISTS (SELECT 1 FROM visit_teacher_sessions s WHERE s.token_hash=?
          AND s.teacher_user_id=c.teacher_user_id AND s.credential_version=?
          AND s.revoked_at IS NULL AND s.expires_at>?)`)
      .bind(tokenHash, pendingScope, ipScopeHash, expiresAt, now, now,
        teacher.teacherUserId, nextVersion, newHmac, input.requestId,
        teacher.tokenHash, teacher.credentialVersion, now),
    db.prepare(`INSERT INTO audit_events (
      id,actor_user_id,actor_email,action,entity_type,entity_id,request_id,
      before_json,after_json,metadata_json,created_at
    ) VALUES (?,?,'teacher-code@local.invalid','teacher.code.rotate.guard','visit_teacher_credential',
      CASE WHEN EXISTS (SELECT 1 FROM visit_teacher_credentials c JOIN users u ON u.id=c.teacher_user_id
        WHERE c.teacher_user_id=? AND c.status='active' AND c.version=? AND c.code_hmac=?
          AND c.must_change_pin=0
          AND c.last_access_command_id=? AND u.status='active'
          AND EXISTS (SELECT 1 FROM teacher_profiles cap WHERE cap.teacher_user_id=u.id AND cap.closed_at IS NULL))
      AND EXISTS (SELECT 1 FROM visit_teacher_sessions WHERE token_hash=? AND teacher_user_id=?
        AND credential_version=? AND pending_scope=? AND revoked_at IS NULL AND expires_at=?)
      THEN ? ELSE NULL END,?,NULL,json_object('version',?),NULL,?)`)
      .bind(`AUD-${crypto.randomUUID()}`, teacher.teacherUserId, teacher.teacherUserId,
        nextVersion, newHmac, input.requestId, tokenHash, teacher.teacherUserId,
        nextVersion, pendingScope, expiresAt, teacher.teacherUserId, input.requestId,
        nextVersion, now),
    db.prepare(`UPDATE visit_teacher_sessions SET revoked_at=?,last_seen_at=?
      WHERE teacher_user_id=? AND token_hash!=? AND revoked_at IS NULL`)
      .bind(now, now, teacher.teacherUserId, tokenHash),
    db.prepare(`UPDATE visit_mutation_commands SET status='completed',result_json=?,updated_at=?,completed_at=?
      WHERE id=? AND owner_auth_user_id=? AND request_hash=? AND status='processing'
        AND EXISTS (SELECT 1 FROM visit_teacher_sessions WHERE token_hash=? AND teacher_user_id=?
          AND credential_version=? AND revoked_at IS NULL AND expires_at=?)
        AND NOT EXISTS (SELECT 1 FROM visit_teacher_sessions WHERE teacher_user_id=?
          AND token_hash!=? AND revoked_at IS NULL)`)
      .bind(JSON.stringify(result), now, now, input.requestId, ownerKey, requestHash,
        tokenHash, teacher.teacherUserId, nextVersion, expiresAt, teacher.teacherUserId, tokenHash),
    db.prepare(`INSERT INTO audit_events (
      id,actor_user_id,actor_email,action,entity_type,entity_id,request_id,
      before_json,after_json,metadata_json,created_at
    ) VALUES (?,?,'teacher-code@local.invalid','teacher.code.rotate','visit_teacher_credential',
      CASE WHEN EXISTS (SELECT 1 FROM visit_mutation_commands WHERE id=? AND owner_auth_user_id=?
        AND request_hash=? AND status='completed') THEN ? ELSE NULL END,?,NULL,
      json_object('version',?),NULL,?)`)
      .bind(`AUD-${crypto.randomUUID()}`, teacher.teacherUserId, input.requestId, ownerKey,
        requestHash, teacher.teacherUserId, input.requestId, nextVersion, now),
    boundedSessionCleanup(db, now),
    boundedLimitCleanup(db, nowDate),
  ];
  try { await db.batch(statements); } catch {
    const replay = await db.prepare(`SELECT status,request_hash,result_json FROM visit_mutation_commands
      WHERE id=? AND owner_auth_user_id=? LIMIT 1`).bind(input.requestId, ownerKey)
      .first<{ status: string; request_hash: string; result_json: string | null }>();
    if (replay?.status === "completed" && replay.request_hash === requestHash && replay.result_json) {
      const replayResult = JSON.parse(replay.result_json) as TeacherCodeRotationResult;
      const identity = await readVisitTeacherSessionByHash(db, tokenHash, now);
      if (identity) return { token, identity, result: replayResult };
    }
    const blockedCredential = await db.prepare(`SELECT locked_until FROM visit_teacher_credentials
      WHERE teacher_user_id=? LIMIT 1`).bind(teacher.teacherUserId)
      .first<{ locked_until: string | null }>();
    if ((blockedCredential?.locked_until && blockedCredential.locked_until > now)
      || await anyRateLimitBlocked(db, [ipRateScopeHash, pairRateScopeHash!], now)) {
      throw new VisitScheduleError("rate_limited", 429, "Забагато спроб зміни коду. Спробуйте пізніше.");
    }
    throw new VisitScheduleError("credential_version_conflict", 409, "Код або сесія вже змінилися. Увійдіть ще раз.");
  }
  const identity = await readVisitTeacherSessionByHash(db, tokenHash, now);
  if (!identity) throw new VisitScheduleError("teacher_auth_unavailable", 503, "Нову сесію не вдалося підтвердити.");
  return { token, identity, result };
}

async function recoverRotatedTeacherSession(
  db: VisitD1Database,
  request: Request,
  presented: VisitTeacherIdentity,
  requestId: string,
  requestHash: string,
  expectedNewHmac: string,
  result: TeacherCodeRotationResult,
): Promise<{ token: string; identity: VisitTeacherIdentity; result: TeacherCodeRotationResult }> {
  const credential = await db.prepare(`SELECT version,code_hmac,status,last_access_command_id,must_change_pin
    FROM visit_teacher_credentials WHERE teacher_user_id=? LIMIT 1`)
    .bind(presented.teacherUserId).first<{
      version: number; code_hmac: string; status: string; last_access_command_id: string | null;
      must_change_pin: number;
    }>();
  if (!credential || credential.status !== "active" || Number(credential.version) !== result.credentialVersion
    || credential.last_access_command_id !== requestId || Boolean(credential.must_change_pin)
    || !constantTimeHexEqual(credential.code_hmac, expectedNewHmac)) {
    throw new VisitScheduleError("authentication_required", 401, "Сеанс завершився. Увійдіть ще раз.");
  }
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const token = randomOpaque(32);
  const tokenHash = await sha256Hex(token);
  const pendingScope = randomOpaque(18);
  const expiresAt = new Date(nowDate.getTime() + VISIT_TEACHER_SESSION_SECONDS * 1000).toISOString();
  const ipScopeHash = await hmacHex(teacherAuthPepper(), `session-ip:${trustedClientIp(request)}`);
  const recoveredResult = { ...result, pendingScope, expiresAt };
  try {
    await db.batch([
      db.prepare(`UPDATE visit_teacher_sessions SET revoked_at=?,last_seen_at=?
        WHERE token_hash=(SELECT token_hash FROM visit_teacher_sessions
          WHERE teacher_user_id=? AND revoked_at IS NULL AND expires_at>?
          ORDER BY created_at,token_hash LIMIT 1)
        AND (SELECT COUNT(*) FROM visit_teacher_sessions
          WHERE teacher_user_id=? AND revoked_at IS NULL AND expires_at>?)>=?`)
        .bind(now, now, presented.teacherUserId, now,
          presented.teacherUserId, now, MAX_ACTIVE_SESSIONS),
      db.prepare(`INSERT INTO visit_teacher_sessions (
        token_hash,teacher_user_id,credential_version,pending_scope,ip_scope_hash,
        expires_at,last_seen_at,revoked_at,created_at
      ) SELECT ?,c.teacher_user_id,c.version,?,?,?, ?,NULL,?
        FROM visit_teacher_credentials c JOIN users u ON u.id=c.teacher_user_id
        WHERE c.teacher_user_id=? AND c.version=? AND c.code_hmac=? AND c.status='active'
          AND c.must_change_pin=0
          AND c.last_access_command_id=? AND u.status='active'
          AND EXISTS (SELECT 1 FROM teacher_profiles cap WHERE cap.teacher_user_id=u.id AND cap.closed_at IS NULL)`)
        .bind(tokenHash, pendingScope, ipScopeHash, expiresAt, now, now,
          presented.teacherUserId, result.credentialVersion, expectedNewHmac, requestId),
      db.prepare(`UPDATE visit_mutation_commands SET result_json=?,updated_at=?
        WHERE id=? AND owner_auth_user_id=? AND request_hash=? AND status='completed'
          AND EXISTS (SELECT 1 FROM visit_teacher_sessions WHERE token_hash=?
            AND teacher_user_id=? AND credential_version=? AND pending_scope=?
            AND revoked_at IS NULL AND expires_at=?)
          AND (SELECT COUNT(*) FROM visit_teacher_sessions
            WHERE teacher_user_id=? AND revoked_at IS NULL AND expires_at>?)<=?`)
        .bind(JSON.stringify(recoveredResult), now, requestId, `teacher:${presented.teacherUserId}`,
          requestHash, tokenHash, presented.teacherUserId, result.credentialVersion, pendingScope, expiresAt,
          presented.teacherUserId, now, MAX_ACTIVE_SESSIONS),
      db.prepare(`INSERT INTO audit_events (
        id,actor_user_id,actor_email,action,entity_type,entity_id,request_id,
        before_json,after_json,metadata_json,created_at
      ) VALUES (?,?,'teacher-code@local.invalid','teacher.code.rotate.recover_session',
        'visit_teacher_session',CASE WHEN EXISTS (
          SELECT 1 FROM visit_teacher_sessions WHERE token_hash=? AND teacher_user_id=?
            AND credential_version=? AND pending_scope=? AND revoked_at IS NULL AND expires_at=?
        ) AND (SELECT COUNT(*) FROM visit_teacher_sessions
          WHERE teacher_user_id=? AND revoked_at IS NULL AND expires_at>?)<=?
          AND EXISTS (SELECT 1 FROM visit_mutation_commands WHERE id=?
            AND owner_auth_user_id=? AND request_hash=? AND status='completed'
            AND result_json=?)
        THEN ? ELSE NULL END,?,NULL,NULL,NULL,?)`)
        .bind(`AUD-${crypto.randomUUID()}`, presented.teacherUserId, tokenHash,
          presented.teacherUserId, result.credentialVersion, pendingScope, expiresAt,
          presented.teacherUserId, now, MAX_ACTIVE_SESSIONS, requestId,
          `teacher:${presented.teacherUserId}`, requestHash, JSON.stringify(recoveredResult),
          tokenHash, requestId, now),
      boundedSessionCleanup(db, now),
    ]);
  } catch {
    throw new VisitScheduleError("teacher_auth_unavailable", 503, "Не вдалося відновити нову сесію. Увійдіть новим кодом.");
  }
  const identity = await readVisitTeacherSessionByHash(db, tokenHash, now);
  if (!identity) throw new VisitScheduleError("teacher_auth_unavailable", 503, "Не вдалося відновити нову сесію.");
  return { token, identity, result: recoveredResult };
}

export function teacherSessionCookie(token: string): string {
  return `${VISIT_TEACHER_COOKIE}=${token}; Path=/; Max-Age=${VISIT_TEACHER_SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export function telegramTeacherSessionCookie(token: string): string {
  return `${VISIT_TEACHER_TELEGRAM_COOKIE}=${token}; Path=/; Max-Age=${VISIT_TEACHER_SESSION_SECONDS}; HttpOnly; Secure; SameSite=None; Partitioned`;
}

export function teacherSessionCookieForRequest(request: Request, token: string): string {
  return isTelegramTeacherRequest(request)
    ? telegramTeacherSessionCookie(token)
    : teacherSessionCookie(token);
}

export function clearTeacherSessionCookie(): string {
  return `${VISIT_TEACHER_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function clearTeacherSessionCookieForRequest(request: Request): string {
  return isTelegramTeacherRequest(request)
    ? `${VISIT_TEACHER_TELEGRAM_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None; Partitioned`
    : clearTeacherSessionCookie();
}

export async function listVisitTeacherAccess(db: VisitD1Database): Promise<VisitTeacherAccessRow[]> {
  const now = new Date().toISOString();
  const rows = await db.prepare(`
    SELECT u.id, u.full_name, u.status AS user_status,
           c.status, c.version, c.last_login_at, c.locked_until, c.must_change_pin,
           (SELECT COUNT(*) FROM visit_teacher_sessions s
             WHERE s.teacher_user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_sessions
    FROM users u
    LEFT JOIN visit_teacher_credentials c ON c.teacher_user_id = u.id
    WHERE u.status = 'active'
      AND EXISTS (SELECT 1 FROM teacher_profiles cap WHERE cap.teacher_user_id=u.id AND cap.closed_at IS NULL)
    ORDER BY u.status DESC, u.sort_name, u.id LIMIT 101
  `).bind(now).all<{
    id: string; full_name: string; user_status: "active" | "inactive";
    status: "active" | "disabled" | null; version: number | null;
    last_login_at: string | null; locked_until: string | null; active_sessions: number;
    must_change_pin: number | null;
  }>();
  if ((rows.results ?? []).length > 100) throw new VisitScheduleError("teacher_result_limit", 409, "У базі понад 100 учителів.");
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    fullName: row.full_name,
    status: row.user_status,
    credential: row.status === null ? null : {
      status: row.status === "active" && row.locked_until && row.locked_until > now ? "locked" : row.status,
      version: Number(row.version),
      lastLoginAt: row.last_login_at,
      lockedUntil: row.locked_until,
      activeSessions: Number(row.active_sessions),
      mustChangePin: Boolean(row.must_change_pin),
    },
  }));
}

export async function listMissingVisitTeacherCodeRows(
  db: VisitD1Database,
): Promise<Array<{ teacherUserId: string; fullName: string }>> {
  const rows = await db.prepare(`
    SELECT u.id, u.full_name
    FROM users u
    LEFT JOIN teacher_profiles p ON p.teacher_user_id=u.id
    LEFT JOIN visit_teacher_credentials c ON c.teacher_user_id=u.id
    WHERE u.status='active' AND p.closed_at IS NULL AND p.teacher_user_id IS NOT NULL
      AND c.teacher_user_id IS NULL
    ORDER BY u.sort_name,u.id LIMIT ?
  `).bind(VISIT_TEACHER_BULK_LIMIT + 1).all<{ id: string; full_name: string }>();
  if ((rows.results ?? []).length > VISIT_TEACHER_BULK_LIMIT) {
    throw new VisitScheduleError("teacher_bulk_limit", 409, "За один раз можна підготувати не більше 100 кодів.");
  }
  return (rows.results ?? []).map((row) => ({ teacherUserId: row.id, fullName: row.full_name }));
}

export async function issueVisitTeacherCode(
  db: VisitD1Database,
  actor: { id: string; email: string },
  teacherUserId: string,
  input: { requestId: string; expectedVersion: number },
) {
  const requestHash = await sha256Hex(JSON.stringify({ kind: "code.issue", actor: actor.id, teacherUserId, ...input }));
  const existingCommand = await accessCommand(db, input.requestId);
  if (existingCommand) {
    if (existingCommand.request_hash !== requestHash) throw new VisitScheduleError("request_id_conflict", 409, "requestId уже використано.");
    throw unrecoverableCodeResult(existingCommand.request_hash);
  }
  const teacher = await db.prepare(`
    SELECT u.id, u.full_name, c.login_id, c.version
    FROM users u LEFT JOIN visit_teacher_credentials c ON c.teacher_user_id = u.id
    WHERE u.id = ? AND u.status = 'active'
      AND EXISTS (SELECT 1 FROM teacher_profiles cap WHERE cap.teacher_user_id=u.id AND cap.closed_at IS NULL) LIMIT 1
  `).bind(teacherUserId).first<{ id: string; full_name: string; login_id: string | null; version: number | null }>();
  if (!teacher) throw new VisitScheduleError("teacher_not_found", 404, "Активного вчителя не знайдено.");
  const currentVersion = teacher.version === null ? 0 : Number(teacher.version);
  if (currentVersion !== input.expectedVersion) throw new VisitScheduleError("credential_version_conflict", 409, "Доступ уже змінився. Оновіть список.");
  const code = randomTeacherCode();
  const loginId = teacher.login_id ?? randomOpaque(18);
  const codeHmac = await hmacHex(teacherAuthPepper(), `code:${teacherUserId}:${code}`);
  const nextVersion = currentVersion + 1;
  const now = new Date().toISOString();
  const publicCredential = {
    status: "active" as const,
    version: nextVersion,
    lastLoginAt: null,
    lockedUntil: null,
    activeSessions: 0,
    mustChangePin: true,
  };
  const statements = [
    insertAccessCommand(db, input.requestId, actor.id, "code.issue", teacherUserId, requestHash, now),
    db.prepare(`
      INSERT INTO visit_teacher_credentials (
        teacher_user_id, login_id, code_hmac, must_change_pin, status, version, failed_attempts,
        locked_until, last_login_at, code_rotated_at, last_access_command_id, created_by_user_id,
        updated_by_user_id, created_at, updated_at
      )
      SELECT u.id, ?, ?, 1, 'active', 1, 0, NULL, NULL, ?, ?, ?, ?, ?, ?
      FROM users u WHERE u.id = ? AND u.status = 'active'
        AND EXISTS (SELECT 1 FROM teacher_profiles cap WHERE cap.teacher_user_id=u.id AND cap.closed_at IS NULL)
      ON CONFLICT(teacher_user_id) DO UPDATE SET
        code_hmac = excluded.code_hmac, must_change_pin = 1, status = 'active', version = visit_teacher_credentials.version + 1,
        failed_attempts = 0, locked_until = NULL, last_login_at = NULL,
        code_rotated_at = excluded.code_rotated_at, updated_by_user_id = excluded.updated_by_user_id,
        last_access_command_id = excluded.last_access_command_id,
        failure_window_started_at = NULL,
        updated_at = excluded.updated_at
      WHERE visit_teacher_credentials.version = ?
    `).bind(loginId, codeHmac, now, input.requestId, actor.id, actor.id, now, now, teacherUserId, currentVersion),
    db.prepare(`UPDATE visit_teacher_sessions SET revoked_at = ?
      WHERE teacher_user_id = ? AND revoked_at IS NULL AND ? > 0`).bind(now, teacherUserId, currentVersion),
    guardedAccessAudit(db, {
      actor, requestId: input.requestId, action: "visit.teacher_code.issue", teacherUserId,
      expectedVersion: nextVersion, expectedStatus: "active", expectedCodeHmac: codeHmac,
      expectedLoginId: loginId, expectedUpdatedAt: now,
      metadata: { previousVersion: currentVersion }, now,
    }),
    activeActorGuardAudit(db, actor, input.requestId, now),
    completeAccessCommand(db, input.requestId, { teacherUserId, version: nextVersion }, now),
  ];
  try {
    await db.batch(statements);
  } catch {
    throw new VisitScheduleError("credential_version_conflict", 409, "Доступ уже змінився. Оновіть список.");
  }
  return {
    teacher: { id: teacher.id, fullName: teacher.full_name },
    credential: publicCredential,
    code: formatTeacherCode(code),
  };
}

export async function bulkIssueVisitTeacherCodes(
  db: VisitD1Database,
  actor: { id: string; email: string },
  input: { requestId: string; confirmation: "ISSUE_MISSING_ONLY" },
) {
  const requestHash = await sha256Hex(JSON.stringify({ kind: "code.bulk_issue", actor: actor.id, ...input }));
  const existingCommand = await accessCommand(db, input.requestId);
  if (existingCommand) {
    if (existingCommand.request_hash !== requestHash) throw new VisitScheduleError("request_id_conflict", 409, "requestId уже використано.");
    throw unrecoverableCodeResult(existingCommand.request_hash);
  }
  const rows = await db.prepare(`
    SELECT u.id, u.full_name FROM users u
    LEFT JOIN visit_teacher_credentials c ON c.teacher_user_id = u.id
    WHERE u.status = 'active' AND c.teacher_user_id IS NULL
      AND EXISTS (SELECT 1 FROM teacher_profiles cap WHERE cap.teacher_user_id=u.id AND cap.closed_at IS NULL)
    ORDER BY u.sort_name, u.id LIMIT 101
  `).all<{ id: string; full_name: string }>();
  const teachers = rows.results ?? [];
  if (teachers.length > VISIT_TEACHER_BULK_LIMIT) {
    throw new VisitScheduleError("teacher_bulk_limit", 409, "За один раз можна створити не більше 100 кодів.");
  }
  const pepper = teacherAuthPepper();
  const now = new Date().toISOString();
  const issued = await Promise.all(teachers.map(async (teacher) => {
    const code = randomTeacherCode();
    return {
      teacherUserId: teacher.id,
      fullName: teacher.full_name,
      code,
      loginId: randomOpaque(18),
      codeHmac: await hmacHex(pepper, `code:${teacher.id}:${code}`),
      auditId: `AUD-${crypto.randomUUID()}`,
      version: 1,
    };
  }));
  const credentialRows = issued.map(({ teacherUserId, loginId, codeHmac }) => ({ teacherUserId, loginId, codeHmac }));
  const auditRows = issued.map(({ teacherUserId, auditId, loginId, codeHmac }) => ({ teacherUserId, auditId, loginId, codeHmac }));
  const safeResult = { teacherUserIds: issued.map((row) => row.teacherUserId), count: issued.length };
  const statements = [
    insertAccessCommand(db, input.requestId, actor.id, "code.bulk_issue", null, requestHash, now),
    db.prepare(`
      INSERT INTO visit_teacher_credentials (
        teacher_user_id, login_id, code_hmac, must_change_pin, status, version, failed_attempts,
        locked_until, last_login_at, code_rotated_at, last_access_command_id, created_by_user_id,
        updated_by_user_id, created_at, updated_at
      )
      SELECT json_extract(value,'$.teacherUserId'), json_extract(value,'$.loginId'),
             json_extract(value,'$.codeHmac'), 1, 'active', 1, 0, NULL, NULL, ?, ?, ?, ?, ?, ?
      FROM json_each(?) j
      WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = json_extract(j.value,'$.teacherUserId')
        AND u.status='active' AND EXISTS (SELECT 1 FROM teacher_profiles cap
          WHERE cap.teacher_user_id=u.id AND cap.closed_at IS NULL))
        AND NOT EXISTS (SELECT 1 FROM visit_teacher_credentials c
          WHERE c.teacher_user_id = json_extract(j.value,'$.teacherUserId'))
    `).bind(now, input.requestId, actor.id, actor.id, now, now, JSON.stringify(credentialRows)),
    db.prepare(`
      INSERT INTO audit_events (
        id, actor_user_id, actor_email, action, entity_type, entity_id,
        request_id, before_json, after_json, metadata_json, created_at
      )
      SELECT json_extract(value,'$.auditId'), ?, ?, 'visit.teacher_code.bulk_issue',
             'visit_teacher_credential', json_extract(value,'$.teacherUserId'), ?, NULL,
             json_object('version',1,'status','active'), NULL, ?
      FROM json_each(?) j
      WHERE EXISTS (SELECT 1 FROM visit_teacher_credentials c
        WHERE c.teacher_user_id = json_extract(j.value,'$.teacherUserId') AND c.version = 1
          AND c.login_id = json_extract(j.value,'$.loginId')
          AND c.code_hmac = json_extract(j.value,'$.codeHmac') AND c.must_change_pin=1
          AND c.last_access_command_id = ?)
    `).bind(actor.id, actor.email.toLowerCase(), input.requestId, now, JSON.stringify(auditRows), input.requestId),
    db.prepare(`UPDATE visit_teacher_access_commands SET status='completed', result_json=?,
      updated_at=?, completed_at=?
      WHERE id=? AND status='processing'
        AND (SELECT COUNT(*) FROM visit_teacher_credentials c JOIN json_each(?) j
          ON c.teacher_user_id=json_extract(j.value,'$.teacherUserId')
           AND c.login_id=json_extract(j.value,'$.loginId')
           AND c.code_hmac=json_extract(j.value,'$.codeHmac') AND c.version=1
           AND c.must_change_pin=1
           AND c.last_access_command_id=?) = ?`)
      .bind(JSON.stringify(safeResult), now, now, input.requestId, JSON.stringify(credentialRows), input.requestId, issued.length),
    db.prepare(`INSERT INTO audit_events (
      id, actor_user_id, actor_email, action, entity_type, entity_id, request_id,
      before_json, after_json, metadata_json, created_at
    ) VALUES (?, ?, ?, 'visit.teacher_code.bulk_guard', 'visit_teacher_bulk',
      CASE WHEN EXISTS (SELECT 1 FROM visit_teacher_access_commands
        WHERE id=? AND status='completed') THEN ? ELSE NULL END,
      ?, NULL, json_object('count',?), NULL, ?)`)
      .bind(`AUD-${crypto.randomUUID()}`, actor.id, actor.email.toLowerCase(), input.requestId,
        input.requestId, input.requestId, issued.length, now),
    activeActorGuardAudit(db, actor, input.requestId, now),
  ];
  try {
    await db.batch(statements);
  } catch {
    throw new VisitScheduleError("teacher_access_update_failed", 409, "Список учителів змінився. Оновіть сторінку.");
  }
  return {
    issued: issued.map(({ teacherUserId, fullName, code, version }) => ({ teacherUserId, fullName, code: formatTeacherCode(code), version })),
    skippedExisting: 0,
    statementCount: statements.length,
  };
}

export function validateVisitTeacherCodeImportInput(input: unknown): VisitTeacherCodeImportInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new VisitScheduleError("validation_failed", 400, "Очікуються дані імпорту кодів.");
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !["requestId", "confirmation", "rows"].every((key) => keys.includes(key))) {
    throw new VisitScheduleError("validation_failed", 400, "Формат імпорту кодів не підтримується.");
  }
  if (typeof value.requestId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.requestId)
    || value.confirmation !== "IMPORT_MISSING_TEACHER_CODES"
    || !Array.isArray(value.rows)
    || value.rows.length < 1
    || value.rows.length > VISIT_TEACHER_BULK_LIMIT) {
    throw new VisitScheduleError("validation_failed", 400, "Перевірте підтвердження та кількість рядків імпорту.");
  }
  const ids = new Set<string>();
  const codes = new Set<string>();
  const rows = value.rows.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new VisitScheduleError("validation_failed", 400, "Некоректний рядок імпорту кодів.");
    }
    const row = candidate as Record<string, unknown>;
    const rowKeys = Object.keys(row);
    if (rowKeys.length !== 3 || !["teacherUserId", "fullName", "code"].every((key) => rowKeys.includes(key))) {
      throw new VisitScheduleError("validation_failed", 400, "Рядок імпорту має містити лише USR-ID, ім’я та тимчасовий код.");
    }
    const teacherUserId = typeof row.teacherUserId === "string" ? row.teacherUserId.trim() : "";
    const fullName = typeof row.fullName === "string"
      ? row.fullName.normalize("NFKC").trim().replace(/\s+/gu, " ")
      : "";
    const code = typeof row.code === "string" ? normalizeCode(row.code) : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(teacherUserId)
      || fullName.length < 3 || fullName.length > 160 || !temporaryCodeShape(code)) {
      throw new VisitScheduleError("validation_failed", 400, "Один або кілька рядків містять некоректні дані.");
    }
    if (ids.has(teacherUserId) || codes.has(code)) {
      throw new VisitScheduleError("validation_failed", 400, "USR-ID і тимчасові коди не можуть повторюватися.");
    }
    ids.add(teacherUserId);
    codes.add(code);
    return { teacherUserId, fullName, code };
  });
  return {
    requestId: value.requestId,
    confirmation: "IMPORT_MISSING_TEACHER_CODES",
    rows,
  };
}

export async function importVisitTeacherCodes(
  db: VisitD1Database,
  actor: { id: string; email: string },
  input: VisitTeacherCodeImportInput,
): Promise<{ teacherUserIds: string[]; count: number; statementCount: number }> {
  const pepper = teacherAuthPepper();
  const canonical = input.rows.map((row) => ({
    teacherUserId: row.teacherUserId,
    fullName: row.fullName,
    code: normalizeCode(row.code),
  }));
  const requestHash = await hmacHex(pepper, `code-import:${JSON.stringify({
    kind: "code.import",
    actor: actor.id,
    requestId: input.requestId,
    confirmation: input.confirmation,
    rows: canonical,
  })}`);
  const existingCommand = await accessCommand(db, input.requestId);
  if (existingCommand) {
    if (existingCommand.request_hash !== requestHash) {
      throw new VisitScheduleError("request_id_conflict", 409, "requestId уже використано.");
    }
    if (existingCommand.status === "completed" && existingCommand.result_json) {
      const replay = JSON.parse(existingCommand.result_json) as { teacherUserIds: string[]; count: number };
      return { ...replay, statementCount: 0 };
    }
    throw new VisitScheduleError("mutation_in_progress", 409, "Імпорт ще виконується. Оновіть сторінку.");
  }

  const requestedRows = JSON.stringify(canonical.map(({ teacherUserId, fullName }) => ({ teacherUserId, fullName })));
  const matches = await db.prepare(`
    SELECT u.id,u.full_name,u.status,u.role,p.teacher_user_id AS profile_id,p.closed_at,
      c.teacher_user_id AS credential_id
    FROM json_each(?) j
    LEFT JOIN users u ON u.id=json_extract(j.value,'$.teacherUserId')
    LEFT JOIN teacher_profiles p ON p.teacher_user_id=u.id
    LEFT JOIN visit_teacher_credentials c ON c.teacher_user_id=u.id
    ORDER BY CAST(j.key AS INTEGER)
  `).bind(requestedRows).all<{
    id: string | null; full_name: string | null; status: string | null; role: string | null;
    profile_id: string | null; closed_at: string | null; credential_id: string | null;
  }>();
  const checked = matches.results ?? [];
  if (checked.length !== canonical.length || checked.some((row, index) => !row.id
    || row.status !== "active" || row.profile_id === null || row.closed_at !== null
    || row.credential_id !== null
    || normalizeTeacherImportName(row.full_name ?? "") !== canonical[index].fullName)) {
    throw new VisitScheduleError(
      "teacher_code_import_mismatch",
      409,
      "Файл не збігається з актуальними картками вчителів або для когось код уже створено. Завантажте новий шаблон.",
    );
  }

  const now = new Date().toISOString();
  const prepared = await Promise.all(canonical.map(async (row) => ({
    teacherUserId: row.teacherUserId,
    fullName: row.fullName,
    loginId: randomOpaque(18),
    codeHmac: await hmacHex(pepper, `code:${row.teacherUserId}:${row.code}`),
    auditId: `AUD-${crypto.randomUUID()}`,
  })));
  const safeResult = { teacherUserIds: prepared.map((row) => row.teacherUserId), count: prepared.length };
  const rowsJson = JSON.stringify(prepared);
  const statements = [
    insertAccessCommand(db, input.requestId, actor.id, "code.import", null, requestHash, now),
    db.prepare(`
      INSERT INTO visit_teacher_credentials (
        teacher_user_id,login_id,code_hmac,must_change_pin,status,version,failed_attempts,
        locked_until,last_login_at,code_rotated_at,last_access_command_id,created_by_user_id,
        updated_by_user_id,created_at,updated_at
      )
      SELECT json_extract(j.value,'$.teacherUserId'),json_extract(j.value,'$.loginId'),
        json_extract(j.value,'$.codeHmac'),1,'active',1,0,NULL,NULL,?,?,?,?,?,?
      FROM json_each(?) j
      JOIN users u ON u.id=json_extract(j.value,'$.teacherUserId')
      LEFT JOIN teacher_profiles p ON p.teacher_user_id=u.id
      WHERE u.status='active' AND u.full_name=json_extract(j.value,'$.fullName')
        AND p.teacher_user_id IS NOT NULL AND p.closed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM visit_teacher_credentials c WHERE c.teacher_user_id=u.id)
    `).bind(now, input.requestId, actor.id, actor.id, now, now, rowsJson),
    db.prepare(`
      INSERT INTO audit_events (
        id,actor_user_id,actor_email,action,entity_type,entity_id,request_id,
        before_json,after_json,metadata_json,created_at
      )
      SELECT json_extract(j.value,'$.auditId'),?,?,'visit.teacher_code.import',
        'visit_teacher_credential',json_extract(j.value,'$.teacherUserId'),?,NULL,
        json_object('version',1,'status','active'),json_object('source','excel'),?
      FROM json_each(?) j
      JOIN visit_teacher_credentials c ON c.teacher_user_id=json_extract(j.value,'$.teacherUserId')
      WHERE c.login_id=json_extract(j.value,'$.loginId')
        AND c.code_hmac=json_extract(j.value,'$.codeHmac') AND c.version=1
        AND c.must_change_pin=1 AND c.last_access_command_id=?
    `).bind(actor.id, actor.email.toLowerCase(), input.requestId, now, rowsJson, input.requestId),
    db.prepare(`UPDATE visit_teacher_access_commands SET status='completed',result_json=?,
      updated_at=?,completed_at=? WHERE id=? AND status='processing'
      AND (SELECT COUNT(*) FROM visit_teacher_credentials c JOIN json_each(?) j
        ON c.teacher_user_id=json_extract(j.value,'$.teacherUserId')
        AND c.login_id=json_extract(j.value,'$.loginId')
        AND c.code_hmac=json_extract(j.value,'$.codeHmac') AND c.version=1
        AND c.must_change_pin=1 AND c.last_access_command_id=?)=?`)
      .bind(JSON.stringify(safeResult), now, now, input.requestId, rowsJson, input.requestId, prepared.length),
    db.prepare(`INSERT INTO audit_events (
      id,actor_user_id,actor_email,action,entity_type,entity_id,request_id,
      before_json,after_json,metadata_json,created_at
    ) VALUES (?,?,?,'visit.teacher_code.import_guard','visit_teacher_code_import',
      CASE WHEN EXISTS (SELECT 1 FROM visit_teacher_access_commands
        WHERE id=? AND status='completed') THEN ? ELSE NULL END,
      ?,NULL,json_object('count',?),NULL,?)`)
      .bind(`AUD-${crypto.randomUUID()}`, actor.id, actor.email.toLowerCase(), input.requestId,
        input.requestId, input.requestId, prepared.length, now),
    activeActorGuardAudit(db, actor, input.requestId, now),
  ];
  try {
    await db.batch(statements);
  } catch {
    throw new VisitScheduleError(
      "teacher_code_import_conflict",
      409,
      "Картки або коди змінилися під час імпорту. Дані не змінено; завантажте новий шаблон.",
    );
  }
  return { ...safeResult, statementCount: statements.length };
}

export async function updateVisitTeacherAccess(
  db: VisitD1Database,
  actor: { id: string; email: string },
  teacherUserId: string,
  input: { requestId: string; expectedVersion: number; action: "enable" | "disable" | "unlock" | "revoke_sessions" },
) {
  const existing = await accessCommand(db, input.requestId);
  const requestHash = await sha256Hex(JSON.stringify({ kind: input.action, actor: actor.id, teacherUserId, ...input }));
  if (existing) {
    if (existing.request_hash !== requestHash) throw new VisitScheduleError("request_id_conflict", 409, "requestId уже використано.");
    if (existing.result_json) return JSON.parse(existing.result_json) as { teacher: { id: string; fullName: string }; credential: VisitTeacherCredentialProjection };
    throw new VisitScheduleError("mutation_in_progress", 409, "Зміна ще виконується.");
  }
  const row = await db.prepare(`
    SELECT u.id, u.full_name, c.status, c.version, c.last_login_at, c.locked_until,
           c.must_change_pin
    FROM users u JOIN visit_teacher_credentials c ON c.teacher_user_id = u.id
    WHERE u.id = ? AND u.status='active'
      AND EXISTS (SELECT 1 FROM teacher_profiles cap WHERE cap.teacher_user_id=u.id AND cap.closed_at IS NULL) LIMIT 1
  `).bind(teacherUserId).first<{
    id: string; full_name: string; status: "active" | "disabled"; version: number;
    last_login_at: string | null; locked_until: string | null; must_change_pin: number;
  }>();
  if (!row) throw new VisitScheduleError("credential_not_found", 404, "Код доступу вчителя не створено.");
  if (Number(row.version) !== input.expectedVersion) throw new VisitScheduleError("credential_version_conflict", 409, "Доступ уже змінився. Оновіть список.");
  const now = new Date().toISOString();
  const nextVersion = input.expectedVersion + 1;
  const nextStatus = input.action === "disable" ? "disabled" : input.action === "enable" ? "active" : row.status;
  const nextLockedUntil = input.action === "unlock" ? null : row.locked_until;
  const credential: VisitTeacherCredentialProjection = {
    status: nextStatus === "active" && nextLockedUntil && nextLockedUntil > now ? "locked" : nextStatus,
    version: nextVersion,
    lastLoginAt: row.last_login_at,
    lockedUntil: nextLockedUntil,
    activeSessions: 0,
    mustChangePin: Boolean(row.must_change_pin),
  };
  const result = { teacher: { id: row.id, fullName: row.full_name }, credential };
  const commandKind = ({
    enable: "credential.enable", disable: "credential.disable", unlock: "credential.unlock", revoke_sessions: "sessions.revoke",
  } as const)[input.action];
  const statements = [
    insertAccessCommand(db, input.requestId, actor.id, commandKind, teacherUserId, requestHash, now),
    db.prepare(`
      UPDATE visit_teacher_credentials SET status = ?,
        failed_attempts = CASE WHEN ? = 'unlock' THEN 0 ELSE failed_attempts END,
        failure_window_started_at = CASE WHEN ? = 'unlock' THEN NULL ELSE failure_window_started_at END,
        locked_until = CASE WHEN ? = 'unlock' THEN NULL ELSE locked_until END,
        version = version + 1, updated_by_user_id = ?, updated_at = ?,
        last_access_command_id = ?
      WHERE teacher_user_id = ? AND version = ?
        AND EXISTS (SELECT 1 FROM users active_user WHERE active_user.id=? AND active_user.status='active'
          AND EXISTS (SELECT 1 FROM teacher_profiles cap WHERE cap.teacher_user_id=active_user.id AND cap.closed_at IS NULL))
    `).bind(
      nextStatus, input.action, input.action, input.action, actor.id, now,
      input.requestId, teacherUserId, input.expectedVersion, teacherUserId,
    ),
    db.prepare(`UPDATE visit_teacher_sessions SET revoked_at = ?
      WHERE teacher_user_id = ? AND revoked_at IS NULL`).bind(now, teacherUserId),
    guardedAccessAudit(db, {
      actor, requestId: input.requestId, action: `visit.teacher_access.${input.action}`,
      teacherUserId, expectedVersion: nextVersion, expectedStatus: nextStatus,
      expectedLockedUntil: nextLockedUntil, checkLockedUntil: input.action === "unlock",
      expectedUpdatedAt: now,
      metadata: { previousVersion: input.expectedVersion }, now,
    }),
    activeActorGuardAudit(db, actor, input.requestId, now),
    completeAccessCommand(db, input.requestId, result, now),
  ];
  try {
    await db.batch(statements);
  } catch {
    throw new VisitScheduleError("credential_version_conflict", 409, "Доступ уже змінився. Оновіть список.");
  }
  return result;
}

function insertAccessCommand(
  db: VisitD1Database,
  id: string,
  actorUserId: string,
  kind: string,
  teacherUserId: string | null,
  requestHash: string,
  now: string,
) {
  return db.prepare(`INSERT INTO visit_teacher_access_commands (
    id, actor_user_id, kind, teacher_user_id, request_hash, status,
    result_json, created_at, updated_at, completed_at
  ) VALUES (?, ?, ?, ?, ?, 'processing', NULL, ?, ?, NULL)`)
    .bind(id, actorUserId, kind, teacherUserId, requestHash, now, now);
}

function completeAccessCommand(db: VisitD1Database, id: string, result: unknown, now: string) {
  return db.prepare(`UPDATE visit_teacher_access_commands SET status='completed', result_json=?,
    updated_at=?, completed_at=? WHERE id=? AND status='processing'`)
    .bind(JSON.stringify(result), now, now, id);
}

function guardedAccessAudit(db: VisitD1Database, input: {
  actor: { id: string; email: string }; requestId: string; action: string;
  teacherUserId: string; expectedVersion: number; expectedStatus?: "active" | "disabled";
  expectedCodeHmac?: string; expectedLoginId?: string; expectedLockedUntil?: string | null;
  checkLockedUntil?: boolean;
  expectedUpdatedAt?: string; metadata: unknown; now: string;
}) {
  return db.prepare(`INSERT INTO audit_events (
    id, actor_user_id, actor_email, action, entity_type, entity_id,
    request_id, before_json, after_json, metadata_json, created_at
  ) VALUES (?, ?, ?, ?, 'visit_teacher_credential',
    CASE WHEN EXISTS (SELECT 1 FROM visit_teacher_credentials
      WHERE teacher_user_id = ? AND version = ?
        AND last_access_command_id = ?
        AND (? IS NULL OR status = ?)
        AND (? IS NULL OR code_hmac = ?)
        AND (? IS NULL OR login_id = ?)
        AND (? IS NULL OR updated_at = ?)
        AND (? = 0 OR ((? IS NULL AND locked_until IS NULL) OR (? IS NOT NULL AND locked_until = ?)))
    ) THEN ? ELSE NULL END,
    ?, NULL, json_object('version', ?), ?, ?)`)
    .bind(
      `AUD-${crypto.randomUUID()}`, input.actor.id, input.actor.email.toLowerCase(), input.action,
      input.teacherUserId, input.expectedVersion,
      input.requestId,
      input.expectedStatus ?? null, input.expectedStatus ?? null,
      input.expectedCodeHmac ?? null, input.expectedCodeHmac ?? null,
      input.expectedLoginId ?? null, input.expectedLoginId ?? null,
      input.expectedUpdatedAt ?? null, input.expectedUpdatedAt ?? null,
      input.checkLockedUntil ? 1 : 0,
      input.expectedLockedUntil ?? null, input.expectedLockedUntil ?? null, input.expectedLockedUntil ?? null,
      input.teacherUserId, input.requestId,
      input.expectedVersion, JSON.stringify(input.metadata), input.now,
    );
}

function activeActorGuardAudit(
  db: VisitD1Database,
  actor: { id: string; email: string },
  requestId: string,
  now: string,
) {
  return db.prepare(`INSERT INTO audit_events (
    id, actor_user_id, actor_email, action, entity_type, entity_id,
    request_id, before_json, after_json, metadata_json, created_at
  ) VALUES (?, ?, ?, 'visit.teacher_access.actor_guard', 'visit_teacher_access',
    CASE WHEN EXISTS (SELECT 1 FROM users WHERE id=? AND status='active'
      AND role IN ('admin','librarian')) THEN ? ELSE NULL END,
    ?, NULL, NULL, NULL, ?)`)
    .bind(`AUD-${crypto.randomUUID()}`, actor.id, actor.email.toLowerCase(), actor.id,
      requestId, requestId, now);
}

async function readVisitTeacherSessionByHash(
  db: VisitD1Database,
  tokenHash: string,
  now: string,
): Promise<VisitTeacherIdentity | null> {
  const row = await db.prepare(`
    SELECT s.token_hash, s.teacher_user_id, s.credential_version, s.pending_scope,
           s.expires_at, u.full_name, c.must_change_pin
    FROM visit_teacher_sessions s
    JOIN visit_teacher_credentials c ON c.teacher_user_id = s.teacher_user_id
    JOIN users u ON u.id = s.teacher_user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
      AND c.status = 'active' AND c.version = s.credential_version
      AND u.status = 'active'
      AND EXISTS (SELECT 1 FROM teacher_profiles cap WHERE cap.teacher_user_id=u.id AND cap.closed_at IS NULL) LIMIT 1
  `).bind(tokenHash, now).first<{
    token_hash: string; teacher_user_id: string; credential_version: number;
    pending_scope: string; expires_at: string; full_name: string; must_change_pin: number;
  }>();
  return row ? {
    teacherUserId: row.teacher_user_id,
    fullName: row.full_name,
    credentialVersion: Number(row.credential_version),
    tokenHash: row.token_hash,
    pendingScope: row.pending_scope,
    expiresAt: row.expires_at,
    mustChangePin: Boolean(row.must_change_pin),
  } : null;
}

async function recordFailedLogin(
  db: VisitD1Database,
  ipScopeHash: string,
  pairScopeHash: string,
  credential: CredentialRow | null,
  nowDate: Date,
  presentedHmac: string,
) {
  const now = nowDate.toISOString();
  const teacherWindowStart = new Date(nowDate.getTime() - LOGIN_TEACHER_WINDOW_MS).toISOString();
  const teacherBlockedUntil = new Date(nowDate.getTime() + LOGIN_TEACHER_WINDOW_MS).toISOString();
  const statements = [
    rateLimitFailureStatement(db, ipScopeHash, nowDate, LOGIN_IP_WINDOW_MS, LOGIN_IP_LIMIT),
    rateLimitFailureStatement(db, pairScopeHash, nowDate, LOGIN_PAIR_WINDOW_MS, LOGIN_PAIR_LIMIT),
  ];
  if (credential) {
    statements.push(db.prepare(`
      UPDATE visit_teacher_credentials SET
        failed_attempts = CASE WHEN failure_window_started_at IS NULL OR failure_window_started_at<?
          THEN 1 ELSE failed_attempts+1 END,
        failure_window_started_at = CASE WHEN failure_window_started_at IS NULL OR failure_window_started_at<?
          THEN ? ELSE failure_window_started_at END,
        locked_until = CASE
          WHEN failure_window_started_at IS NOT NULL AND failure_window_started_at>=?
            AND failed_attempts+1>=? THEN ?
          ELSE NULL END,
        updated_at = ?
      WHERE teacher_user_id = ? AND version = ? AND code_hmac != ?
    `).bind(
      teacherWindowStart,
      teacherWindowStart,
      now,
      teacherWindowStart,
      LOGIN_TEACHER_LIMIT,
      teacherBlockedUntil,
      now,
      credential.teacher_user_id,
      credential.version,
      presentedHmac,
    ));
  }
  statements.push(boundedLimitCleanup(db, nowDate));
  try { await db.batch(statements); } catch { /* Keep the public failure generic. */ }
}

function rateLimitFailureStatement(
  db: VisitD1Database,
  scopeHash: string,
  nowDate: Date,
  windowMs: number,
  limit: number,
) {
  const now = nowDate.toISOString();
  const windowStart = new Date(nowDate.getTime() - windowMs).toISOString();
  const blockedUntil = new Date(nowDate.getTime() + windowMs).toISOString();
  return db.prepare(`
    INSERT INTO visit_teacher_login_limits (scope_hash, attempts, window_started_at, blocked_until, updated_at)
    VALUES (?, 1, ?, NULL, ?)
    ON CONFLICT(scope_hash) DO UPDATE SET
      attempts = CASE WHEN visit_teacher_login_limits.window_started_at < ? THEN 1 ELSE visit_teacher_login_limits.attempts + 1 END,
      window_started_at = CASE WHEN visit_teacher_login_limits.window_started_at < ? THEN excluded.window_started_at ELSE visit_teacher_login_limits.window_started_at END,
      blocked_until = CASE
        WHEN visit_teacher_login_limits.window_started_at < ? THEN NULL
        WHEN visit_teacher_login_limits.attempts + 1 >= ? THEN ?
        ELSE visit_teacher_login_limits.blocked_until END,
      updated_at = excluded.updated_at
  `).bind(scopeHash, now, now, windowStart, windowStart, windowStart, limit, blockedUntil);
}

async function anyRateLimitBlocked(
  db: VisitD1Database,
  hashes: Array<string | null>,
  now: string,
): Promise<boolean> {
  for (const hash of hashes) {
    if (!hash) continue;
    const row = await db.prepare(`SELECT blocked_until FROM visit_teacher_login_limits
      WHERE scope_hash=? LIMIT 1`).bind(hash).first<{ blocked_until: string | null }>();
    if (row?.blocked_until && row.blocked_until > now) return true;
  }
  return false;
}

function boundedLimitCleanup(db: VisitD1Database, nowDate: Date) {
  return db.prepare(`DELETE FROM visit_teacher_login_limits WHERE scope_hash IN (
    SELECT scope_hash FROM visit_teacher_login_limits WHERE updated_at<? ORDER BY updated_at LIMIT 100
  )`).bind(new Date(nowDate.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString());
}

function boundedSessionCleanup(db: VisitD1Database, now: string) {
  const revokedBefore = new Date(new Date(now).getTime() - 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(`DELETE FROM visit_teacher_sessions WHERE token_hash IN (
    SELECT token_hash FROM visit_teacher_sessions
    WHERE expires_at<=? OR (revoked_at IS NOT NULL AND revoked_at<=?)
    ORDER BY expires_at LIMIT 100
  )`).bind(now, revokedBefore);
}

function boundedTelegramReceiptCleanup(db: VisitD1Database, now: string) {
  return db.prepare(`DELETE FROM telegram_mini_app_auth_receipts WHERE init_data_hash IN (
    SELECT init_data_hash FROM telegram_mini_app_auth_receipts
    WHERE expires_at<=? ORDER BY expires_at,init_data_hash LIMIT 100
  )`).bind(now);
}

function validIsoTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

async function accessCommand(db: VisitD1Database, requestId: string) {
  return db.prepare(`SELECT request_hash, status, result_json FROM visit_teacher_access_commands WHERE id=? LIMIT 1`)
    .bind(requestId).first<{ request_hash: string; status: string; result_json: string | null }>();
}

function unrecoverableCodeResult(requestHash: string) {
  void requestHash;
  return new VisitScheduleError(
    "code_result_unrecoverable",
    409,
    "Код уже було створено й показано один раз. Створіть новий код окремою підтвердженою дією.",
  );
}

function trustedClientIp(request: Request): string {
  const value = request.headers.get("CF-Connecting-IP")?.trim();
  if (!value) {
    throw new VisitScheduleError("client_ip_unavailable", 503, "Не вдалося безпечно перевірити запит. Спробуйте пізніше.");
  }
  return value.slice(0, 128);
}

function normalizeCode(value: string): string {
  return value.normalize("NFKC").toUpperCase().replace(/[\s-]+/gu, "");
}

function normalizeTeacherImportName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function normalizePin(value: string): string {
  return value.normalize("NFKC").replace(/\D+/gu, "").slice(0, VISIT_TEACHER_PIN_LENGTH);
}

function temporaryCodeShape(value: string): boolean {
  return new RegExp(`^[${CODE_ALPHABET}]{${VISIT_TEACHER_CODE_LENGTH}}$`, "u").test(value);
}

function pinShape(value: string): boolean {
  return new RegExp(`^\\d{${VISIT_TEACHER_PIN_LENGTH}}$`, "u").test(value);
}

function credentialCodeShape(value: string, mustChangePin: boolean): boolean {
  return mustChangePin ? temporaryCodeShape(value) : pinShape(value);
}

function strongTeacherPin(value: string): boolean {
  if (!pinShape(value)) return false;
  if (/^(\d)\1{3}$/u.test(value)) return false;
  if (/^(\d{2})\1$/u.test(value)) return false;
  if (["0123", "1234", "2345", "3456", "4567", "5678", "6789", "9876", "8765", "7654", "6543", "5432", "4321", "3210", "2580"].includes(value)) return false;
  return true;
}

function formatTeacherCode(value: string): string {
  return `${value.slice(0, 5)}-${value.slice(5)}`;
}

function randomTeacherCode(): string {
  const result: string[] = [];
  const unbiasedLimit = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;
  while (result.length < VISIT_TEACHER_CODE_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(VISIT_TEACHER_CODE_LENGTH * 2));
    for (const byte of bytes) {
      if (byte >= unbiasedLimit) continue;
      result.push(CODE_ALPHABET[byte % CODE_ALPHABET.length]);
      if (result.length === VISIT_TEACHER_CODE_LENGTH) break;
    }
  }
  return result.join("");
}

function randomOpaque(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function bytesToHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) return rawValue.join("=") || null;
  }
  return null;
}

function readTeacherSessionTokens(request: Request): string[] {
  const header = request.headers.get("Cookie");
  const standard = readCookie(header, VISIT_TEACHER_COOKIE);
  const telegram = readCookie(header, VISIT_TEACHER_TELEGRAM_COOKIE);
  const token = isTelegramTeacherRequest(request) ? telegram : standard;
  return token && /^[A-Za-z0-9_-]{40,128}$/u.test(token) ? [token] : [];
}

function isTelegramTeacherRequest(request: Request): boolean {
  const referer = request.headers.get("Referer");
  if (!referer) return false;
  try {
    const source = new URL(referer);
    return source.origin === new URL(request.url).origin
      && (source.pathname === "/teacher/telegram" || source.pathname.startsWith("/teacher/telegram/"));
  } catch {
    return false;
  }
}
