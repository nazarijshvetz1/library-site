import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

globalThis.__VISIT_TEST_ENV = {
  VISIT_TEACHER_CODE_AUTH_ENABLED: "true",
  VISIT_TEACHER_AUTH_PEPPER: "test-only-pepper-that-is-at-least-32-characters-long",
  VISIT_GUEST_AUTH_PEPPER: "guest-test-pepper-that-is-at-least-32-characters-long",
  TELEGRAM_MINI_APP_ENABLED: "true",
  TELEGRAM_BOT_TOKEN: "123456789:test-token-for-mini-app-tests",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return {
        url: "data:text/javascript,export const env=globalThis.__VISIT_TEST_ENV",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const auth = await import("../lib/visit-teacher-auth.ts");
const miniAppAuth = await import("../lib/telegram-mini-app-auth.ts");
const guestAuth = await import("../lib/visit-guest-auth.ts");
const guestStore = await import("../lib/visit-guest-store.ts");
const store = await import("../lib/visit-schedule-store.ts");
const validation = await import("../lib/visit-schedule-validation.ts");

class PreparedStatement {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }
  bind(...values) { return new PreparedStatement(this.database, this.sql, values); }
  async first() { return this.database.sqlite.prepare(this.sql).get(...this.bindings) ?? null; }
  async all() { return { success: true, results: this.database.sqlite.prepare(this.sql).all(...this.bindings) }; }
  execute() { return { success: true, results: this.database.sqlite.prepare(this.sql).all(...this.bindings) }; }
}

class TestD1 {
  constructor(sqlite) {
    this.sqlite = sqlite;
    this.beforeBatch = null;
    this.batchStatementCounts = [];
  }
  prepare(sql) { return new PreparedStatement(this, sql); }
  async batch(statements) {
    if (this.beforeBatch) {
      const hook = this.beforeBatch;
      this.beforeBatch = null;
      await hook(statements);
    }
    this.batchStatementCounts.push(statements.length);
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.execute());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

async function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const file of [
    "0000_librarian_drafts.sql", "0001_draft_workflow.sql", "0002_remove_legacy_audit_triggers.sql",
    "0003_odd_the_order.sql", "0004_staging_import_runs.sql", "0005_young_night_nurse.sql",
    "0006_pale_sauron.sql", "0007_cold_whiplash.sql", "0008_sudden_thunderbird.sql",
    "0009_happy_silver_samurai.sql", "0010_shocking_cobalt_man.sql",
    "0011_normalize_holding_conditions.sql",
    "0012_elite_victor_mancha.sql",
    "0013_strange_dark_beast.sql",
    "0014_rich_lionheart.sql",
    "0015_glamorous_namora.sql",
    "0016_busy_jane_foster.sql",
    "0017_fresh_robbie_robertson.sql",
    "0018_yielding_skaar.sql",
    "0019_kindly_wolfsbane.sql",
  ]) sqlite.exec(await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  const now = new Date().toISOString();
  insertUser(sqlite, "USR-LIB", "Бібліотекар", "library@example.test", "auth-library", "librarian", now);
  insertUser(sqlite, "USR-T1", "Шевченко Олена", "teacher1@example.test", "auth-t1", "teacher", now);
  return { sqlite, db: new TestD1(sqlite), actor: { id: "USR-LIB", email: "library@example.test" } };
}

function insertUser(sqlite, id, fullName, email, authUserId, role, now = new Date().toISOString()) {
  sqlite.prepare(`INSERT INTO users
    (id,full_name,sort_name,email,auth_user_id,role,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'active',?,?)`)
    .run(id, fullName, fullName, email, authUserId, role, now, now);
  if (role === "teacher") {
    sqlite.prepare(`INSERT INTO teacher_profiles (
      teacher_user_id,subject_position,primary_location_id,service_contact,librarian_note,
      version,last_mutation_request_id,closed_at,closed_by_user_id,created_by_user_id,
      updated_by_user_id,created_at,updated_at
    ) VALUES (?,'',NULL,'','',1,NULL,NULL,NULL,NULL,NULL,?,?)`).run(id, now, now);
  }
}

function request(ip = "203.0.113.10", cookie = null) {
  const headers = new Headers({ "CF-Connecting-IP": ip });
  if (cookie) headers.set("Cookie", `${auth.VISIT_TEACHER_COOKIE}=${cookie}`);
  return new Request("https://library.example.test/api/visits/teacher/session", { headers });
}

function telegramRequest(ip = "203.0.113.90", cookie = null) {
  const headers = new Headers({
    "CF-Connecting-IP": ip,
    Referer: "https://library.example.test/teacher/telegram/cabinet?tab=overview",
  });
  if (cookie) headers.set("Cookie", `${auth.VISIT_TEACHER_TELEGRAM_COOKIE}=${cookie}`);
  return new Request("https://library.example.test/api/teacher/session", { headers });
}

function guestRequest(ip = "203.0.113.210", cookie = null) {
  const headers = new Headers({ "CF-Connecting-IP": ip });
  if (cookie) headers.set("Cookie", `${guestAuth.VISIT_GUEST_COOKIE}=${cookie}`);
  return new Request("https://library.example.test/api/visits/guest", { headers });
}

function commandId() { return crypto.randomUUID(); }

function assertNoExactPlaintextSecrets(value, secrets) {
  const normalizedSecrets = new Set(secrets.map((secret) => String(secret)
    .normalize("NFKC").toUpperCase().replace(/[\s-]+/gu, "")));
  const visit = (candidate) => {
    if (typeof candidate === "string") {
      const normalized = candidate.normalize("NFKC").toUpperCase().replace(/[\s-]+/gu, "");
      assert.equal(normalizedSecrets.has(normalized), false, "plaintext access secret was persisted");
      if (candidate.trimStart().startsWith("{") || candidate.trimStart().startsWith("[")) {
        try { visit(JSON.parse(candidate)); } catch { /* A non-JSON audit string is checked as a scalar. */ }
      }
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (candidate && typeof candidate === "object") Object.values(candidate).forEach(visit);
  };
  visit(value);
}

function insertBoundPersonalActivationInvite(
  context,
  { id, credentialVersion, telegramUserId = "7001", chatId = telegramUserId },
) {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const tokenHash = createHash("sha256").update(id).digest("hex");
  context.sqlite.prepare(`INSERT INTO telegram_teacher_activation_invites (
    id,kind,teacher_user_id,credential_version,token_hash,issued_by_user_id,request_id,
    bound_telegram_user_id,bound_chat_id,bound_username,bound_update_id,presented_at,
    expires_at,consumed_init_data_hash,consumed_at,revoked_at,created_at,updated_at
  ) VALUES (?,'personal','USR-T1',?,?,'USR-LIB',?, ?,?,'teacher_one',?, ?,?,NULL,NULL,NULL,?,?)`)
    .run(
      id,
      credentialVersion,
      tokenHash,
      commandId(),
      telegramUserId,
      chatId,
      `update-${id}`,
      now,
      expiresAt,
      now,
      now,
    );
  return expiresAt;
}

function insertBoundGenericActivationInvite(
  context,
  { id, telegramUserId = "7001", chatId = telegramUserId },
) {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  context.sqlite.prepare(`INSERT INTO telegram_teacher_activation_invites (
    id,kind,teacher_user_id,credential_version,token_hash,issued_by_user_id,request_id,
    bound_telegram_user_id,bound_chat_id,bound_username,bound_update_id,presented_at,
    expires_at,consumed_init_data_hash,consumed_at,revoked_at,created_at,updated_at
  ) VALUES (?,'generic',NULL,NULL,NULL,NULL,NULL, ?,?,'teacher_one',?, ?,?,NULL,NULL,NULL,?,?)`)
    .run(id, telegramUserId, chatId, `update-${id}`, now, expiresAt, now, now);
  return expiresAt;
}

function signedTelegramInitData({ telegramUserId = 7001, now = new Date(), extra = {} } = {}) {
  const entries = {
    auth_date: String(Math.floor(now.getTime() / 1000)),
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    user: JSON.stringify({ id: telegramUserId, first_name: "Олена", language_code: "uk" }),
    ...extra,
  };
  const dataCheckString = Object.entries(entries)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData")
    .update(globalThis.__VISIT_TEST_ENV.TELEGRAM_BOT_TOKEN)
    .digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  const params = new URLSearchParams(entries);
  params.set("hash", hash);
  return params.toString();
}

function futureWeekday() {
  const today = validation.kyivToday();
  for (let offset = 1; offset <= 7; offset += 1) {
    const date = validation.addDays(today, offset);
    if (validation.isoWeekday(date) <= 5) return date;
  }
  throw new Error("weekday missing");
}

async function issuedCredential(context, teacherUserId = "USR-T1") {
  return auth.issueVisitTeacherCode(context.db, context.actor, teacherUserId, {
    requestId: commandId(), expectedVersion: 0,
  });
}

function wrongCode(code) {
  const raw = code.replace("-", "");
  const last = raw.at(-1) === "2" ? "3" : "2";
  if (raw.length === 4) return `${raw.slice(0, -1)}${last}`;
  return `${raw.slice(0, 5)}-${raw.slice(5, -1)}${last}`;
}

async function permanentPinCredential(context, ip = "203.0.113.30", pin = "4826") {
  const issued = await issuedCredential(context);
  const loginId = context.sqlite.prepare("SELECT login_id FROM visit_teacher_credentials").get().login_id;
  const temporarySession = await auth.createVisitTeacherSession(
    context.db, request(ip), { loginId, code: issued.code },
  );
  const rotated = await auth.rotateVisitTeacherCode(
    context.db,
    request(ip, temporarySession.token),
    { requestId: commandId(), currentCode: issued.code, newPin: pin },
  );
  assert.ok(rotated.token);
  return { issued, loginId, pin, session: rotated };
}

test("Excel code import is atomic, idempotent and never stores plaintext", async () => {
  const context = await database();
  const now = new Date().toISOString();
  insertUser(context.sqlite, "USR-T2", "Коваль Марія", null, null, "teacher", now);
  const input = auth.validateVisitTeacherCodeImportInput({
    requestId: commandId(),
    confirmation: "IMPORT_MISSING_TEACHER_CODES",
    rows: [
      { teacherUserId: "USR-T1", fullName: "Шевченко Олена", code: "23456-789AB" },
      { teacherUserId: "USR-T2", fullName: "Коваль Марія", code: "CDEFG-HJKMN" },
    ],
  });
  const imported = await auth.importVisitTeacherCodes(context.db, context.actor, input);
  assert.equal(imported.count, 2);
  assert.deepEqual(imported.teacherUserIds, ["USR-T1", "USR-T2"]);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM visit_teacher_credentials").get().n, 2);
  assert.equal(context.sqlite.prepare("SELECT SUM(must_change_pin) AS n FROM visit_teacher_credentials").get().n, 2);
  const persisted = JSON.stringify({
    command: context.sqlite.prepare("SELECT * FROM visit_teacher_access_commands WHERE id=?").get(input.requestId),
    audits: context.sqlite.prepare("SELECT * FROM audit_events WHERE request_id=?").all(input.requestId),
  });
  assert.doesNotMatch(persisted, /23456-789AB|23456789AB|CDEFG-HJKMN|CDEFGHJKMN/u);
  const plainRequestHashInput = JSON.stringify({
    kind: "code.import",
    actor: context.actor.id,
    requestId: input.requestId,
    confirmation: input.confirmation,
    rows: input.rows,
  });
  const plainDigest = Buffer.from(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(plainRequestHashInput),
  )).toString("hex");
  assert.notEqual(
    context.sqlite.prepare("SELECT request_hash FROM visit_teacher_access_commands WHERE id=?").get(input.requestId).request_hash,
    plainDigest,
    "idempotency proof must be keyed by the server pepper, not a plain digest of teacher codes",
  );

  const replay = await auth.importVisitTeacherCodes(context.db, context.actor, input);
  assert.equal(replay.count, 2);
  assert.equal(replay.statementCount, 0);

  const directory = await auth.listVisitTeacherDirectory(context.db, "коваль", request());
  const loggedIn = await auth.createVisitTeacherSession(context.db, request(), {
    loginId: directory[0].loginId,
    code: "CDEFG-HJKMN",
  });
  assert.equal(loggedIn.identity.mustChangePin, true);
  context.sqlite.close();
});

test("Excel code import rejects malformed, duplicate and stale rows without partial writes", async () => {
  assert.throws(() => auth.validateVisitTeacherCodeImportInput({
    requestId: commandId(), confirmation: "IMPORT_MISSING_TEACHER_CODES",
    rows: [{ teacherUserId: "USR-T1", fullName: "Шевченко Олена", code: "123" }],
  }), (error) => error.code === "validation_failed");
  assert.throws(() => auth.validateVisitTeacherCodeImportInput({
    requestId: commandId(), confirmation: "IMPORT_MISSING_TEACHER_CODES",
    rows: [
      { teacherUserId: "USR-T1", fullName: "Шевченко Олена", code: "23456789AB" },
      { teacherUserId: "USR-T1", fullName: "Шевченко Олена", code: "CDEFGHJKMN" },
    ],
  }), (error) => error.code === "validation_failed");

  const context = await database();
  const now = new Date().toISOString();
  insertUser(context.sqlite, "USR-T2", "Коваль Марія", null, null, "teacher", now);
  await auth.issueVisitTeacherCode(context.db, context.actor, "USR-T2", {
    requestId: commandId(), expectedVersion: 0,
  });
  const input = auth.validateVisitTeacherCodeImportInput({
    requestId: commandId(), confirmation: "IMPORT_MISSING_TEACHER_CODES",
    rows: [
      { teacherUserId: "USR-T1", fullName: "Шевченко Олена", code: "23456789AB" },
      { teacherUserId: "USR-T2", fullName: "Коваль Марія", code: "CDEFGHJKMN" },
    ],
  });
  await assert.rejects(
    auth.importVisitTeacherCodes(context.db, context.actor, input),
    (error) => error.code === "teacher_code_import_mismatch",
  );
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM visit_teacher_credentials WHERE teacher_user_id='USR-T1'").get().n, 0);
  context.sqlite.close();
});

test("one-time code, Ukrainian directory and opaque cookie session work without email", async () => {
  const context = await database();
  const issued = await issuedCredential(context);
  assert.match(issued.code, /^\d{4}$/u);
  const directory = await auth.listVisitTeacherDirectory(context.db, "шев", request());
  assert.deepEqual(directory, [{ loginId: context.sqlite.prepare(
    "SELECT login_id FROM visit_teacher_credentials WHERE teacher_user_id='USR-T1'",
  ).get().login_id, fullName: "Шевченко Олена", publicHint: null }]);

  const loginId = directory[0].loginId;
  const loggedIn = await auth.createVisitTeacherSession(context.db, request(), { loginId, code: issued.code });
  assert.equal(loggedIn.identity.fullName, "Шевченко Олена");
  assert.equal(loggedIn.identity.mustChangePin, true);
  assert.equal(issued.credential.mustChangePin, true);
  assert.notEqual(loggedIn.token, loggedIn.identity.tokenHash);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM visit_teacher_sessions WHERE token_hash=?")
    .get(loggedIn.identity.tokenHash).n, 1);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM visit_teacher_sessions WHERE token_hash=?")
    .get(loggedIn.token).n, 0);
  await assert.rejects(
    () => auth.requireVisitTeacherSession(context.db, request("203.0.113.10", loggedIn.token)),
    (error) => error.code === "pin_change_required" && error.status === 403,
  );
  assert.equal((await auth.requireVisitTeacherSession(
    context.db,
    request("203.0.113.10", loggedIn.token),
    { allowPinSetup: true },
  )).teacherUserId, "USR-T1");
  assert.match(auth.teacherSessionCookie(loggedIn.token), /^__Host-visit_teacher=.*HttpOnly; Secure; SameSite=Lax$/u);
  assert.match(
    auth.telegramTeacherSessionCookie(loggedIn.token),
    /^__Host-visit_teacher_telegram=.*HttpOnly; Secure; SameSite=None; Partitioned$/u,
  );
  assert.match(auth.teacherSessionCookieForRequest(request(), loggedIn.token), /^__Host-visit_teacher=/u);
  assert.match(
    auth.teacherSessionCookieForRequest(telegramRequest(), loggedIn.token),
    /^__Host-visit_teacher_telegram=/u,
  );

  const persisted = JSON.stringify(context.sqlite.prepare(
    "SELECT code_hmac FROM visit_teacher_credentials WHERE teacher_user_id='USR-T1'",
  ).get()) + JSON.stringify(context.sqlite.prepare(
    "SELECT result_json FROM visit_teacher_access_commands",
  ).all());
  assert.doesNotMatch(persisted, new RegExp(issued.code.replace("-", ""), "iu"));
  await assert.rejects(
    () => issuedCredential(context),
    (error) => error.code === "credential_version_conflict",
  );
});

test("missing trusted IP fails closed and pair/IP/teacher failures use independent windows", async () => {
  const context = await database();
  const issued = await issuedCredential(context);
  const loginId = context.sqlite.prepare("SELECT login_id FROM visit_teacher_credentials").get().login_id;
  await assert.rejects(
    () => auth.createVisitTeacherSession(context.db, new Request("https://library.example.test"), { loginId, code: issued.code }),
    (error) => error.code === "client_ip_unavailable" && error.status === 503,
  );

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      () => auth.createVisitTeacherSession(context.db, request("203.0.113.20"), { loginId, code: wrongCode(issued.code) }),
      (error) => error.code === "invalid_teacher_credentials",
    );
  }
  await assert.rejects(
    () => auth.createVisitTeacherSession(context.db, request("203.0.113.20"), { loginId, code: issued.code }),
    (error) => error.code === "rate_limited",
  );
  assert.equal(context.sqlite.prepare("SELECT failed_attempts FROM visit_teacher_credentials").get().failed_attempts, 5);

  for (let ip = 21; ip <= 23; ip += 1) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await assert.rejects(() => auth.createVisitTeacherSession(
        context.db, request(`203.0.113.${ip}`), { loginId, code: wrongCode(issued.code) },
      ));
    }
  }
  const locked = context.sqlite.prepare(
    "SELECT failed_attempts,failure_window_started_at,locked_until FROM visit_teacher_credentials",
  ).get();
  assert.equal(locked.failed_attempts, 20);
  assert.ok(locked.failure_window_started_at);
  assert.ok(locked.locked_until > new Date().toISOString());

  context.sqlite.prepare(`UPDATE visit_teacher_credentials SET failed_attempts=20,
    failure_window_started_at='2000-01-01T00:00:00.000Z',locked_until='2000-01-01T01:00:00.000Z'`).run();
  await assert.rejects(() => auth.createVisitTeacherSession(
    context.db, request("203.0.113.24"), { loginId, code: wrongCode(issued.code) },
  ));
  const decayed = context.sqlite.prepare(
    "SELECT failed_attempts,failure_window_started_at,locked_until FROM visit_teacher_credentials",
  ).get();
  assert.equal(decayed.failed_attempts, 1);
  assert.equal(decayed.locked_until, null);
  assert.ok(decayed.failure_window_started_at > "2000");
});

test("directory permits a school-NAT burst through request 300 and limits request 301", async () => {
  const context = await database();
  await issuedCredential(context);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const rows = await auth.listVisitTeacherDirectory(context.db, "шев", request("203.0.113.200"));
    assert.equal(rows.length, 1);
  }
  await assert.rejects(
    () => auth.listVisitTeacherDirectory(context.db, "шев", request("203.0.113.200")),
    (error) => error.code === "rate_limited",
  );
});

test("school-NAT login limit permits 30 cross-account failures and blocks failure 301", async () => {
  const context = await database();
  const issued = await issuedCredential(context);
  const validLoginId = context.sqlite.prepare("SELECT login_id FROM visit_teacher_credentials").get().login_id;
  const sharedIp = "203.0.113.201";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await assert.rejects(
      () => auth.createVisitTeacherSession(context.db, request(sharedIp), {
        loginId: `opaque-missing-${String(attempt).padStart(3, "0")}`,
        code: "22222-22222",
      }),
      (error) => error.code === "invalid_teacher_credentials",
    );
  }
  const valid = await auth.createVisitTeacherSession(context.db, request(sharedIp), {
    loginId: validLoginId, code: issued.code,
  });
  assert.equal(valid.identity.teacherUserId, "USR-T1");
  for (let attempt = 30; attempt < 300; attempt += 1) {
    await assert.rejects(() => auth.createVisitTeacherSession(context.db, request(sharedIp), {
      loginId: `opaque-missing-${String(attempt).padStart(3, "0")}`,
      code: "22222-22222",
    }));
  }
  await assert.rejects(
    () => auth.createVisitTeacherSession(context.db, request(sharedIp), {
      loginId: "opaque-missing-301", code: "22222-22222",
    }),
    (error) => error.code === "rate_limited",
  );
});

test("fourth successful login keeps exactly three sessions by revoking the oldest", async () => {
  const context = await database();
  const credential = await permanentPinCredential(context);
  const sessions = [credential.session];
  for (let index = 0; index < 3; index += 1) {
    sessions.push(await auth.createVisitTeacherSession(
      context.db, request("203.0.113.30"), { loginId: credential.loginId, code: credential.pin },
    ));
  }
  assert.equal(context.sqlite.prepare(`SELECT COUNT(*) AS n FROM visit_teacher_sessions
    WHERE revoked_at IS NULL AND expires_at>?`).get(new Date().toISOString()).n, 3);
  await assert.rejects(
    () => auth.requireVisitTeacherSession(context.db, request("203.0.113.30", sessions[0].token)),
    (error) => error.code === "authentication_required",
  );
  assert.equal((await auth.requireVisitTeacherSession(
    context.db, request("203.0.113.30", sessions[3].token), { allowPinSetup: true },
  )).teacherUserId, "USR-T1");
});

test("session login races fail closed and do not revoke an existing oldest session", async () => {
  for (const mutation of [
    "UPDATE visit_teacher_credentials SET locked_until='2999-01-01T00:00:00.000Z' WHERE teacher_user_id='USR-T1'",
    "UPDATE visit_teacher_credentials SET version=version+1 WHERE teacher_user_id='USR-T1'",
    "UPDATE visit_teacher_credentials SET status='disabled' WHERE teacher_user_id='USR-T1'",
    "UPDATE users SET status='inactive' WHERE id='USR-T1'",
  ]) {
    const context = await database();
    const credential = await permanentPinCredential(context, "203.0.113.40");
    const previous = [credential.session];
    for (let index = 0; index < 2; index += 1) {
      previous.push(await auth.createVisitTeacherSession(
        context.db, request(`203.0.113.${41 + index}`), { loginId: credential.loginId, code: credential.pin },
      ));
    }
    context.db.beforeBatch = () => context.sqlite.exec(mutation);
    await assert.rejects(
      () => auth.createVisitTeacherSession(context.db, request("203.0.113.50"), { loginId: credential.loginId, code: credential.pin }),
      (error) => error.code === "teacher_auth_unavailable",
    );
    assert.equal(context.sqlite.prepare(`SELECT COUNT(*) AS n FROM visit_teacher_sessions
      WHERE revoked_at IS NULL AND expires_at>?`).get(new Date().toISOString()).n, 3);
    assert.equal(context.sqlite.prepare("SELECT revoked_at FROM visit_teacher_sessions WHERE token_hash=?")
      .get(previous[0].identity.tokenHash).revoked_at, null);
  }
});

test("session login reasserts rate limits inside the successful batch", async () => {
  const context = await database();
  const credential = await permanentPinCredential(context, "203.0.113.60");
  const previous = [credential.session];
  for (let index = 0; index < 2; index += 1) {
    previous.push(await auth.createVisitTeacherSession(
      context.db,
      request(`203.0.113.${61 + index}`),
      { loginId: credential.loginId, code: credential.pin },
    ));
  }
  const racedIp = "203.0.113.70";
  const pairScope = createHmac("sha256", globalThis.__VISIT_TEST_ENV.VISIT_TEACHER_AUTH_PEPPER)
    .update(`pair:${racedIp}:${credential.loginId}`)
    .digest("hex");
  context.db.beforeBatch = () => context.sqlite.prepare(`INSERT INTO visit_teacher_login_limits (
    scope_hash,attempts,window_started_at,blocked_until,updated_at
  ) VALUES (?,1,?,?,?)`).run(
    pairScope,
    new Date().toISOString(),
    "2999-01-01T00:00:00.000Z",
    new Date().toISOString(),
  );
  await assert.rejects(
    () => auth.createVisitTeacherSession(context.db, request(racedIp), { loginId: credential.loginId, code: credential.pin }),
    (error) => error.code === "rate_limited" && error.status === 429,
  );
  assert.equal(context.sqlite.prepare(`SELECT COUNT(*) AS n FROM visit_teacher_sessions
    WHERE revoked_at IS NULL AND expires_at>?`).get(new Date().toISOString()).n, 3);
  assert.equal(context.sqlite.prepare("SELECT revoked_at FROM visit_teacher_sessions WHERE token_hash=?")
    .get(previous[0].identity.tokenHash).revoked_at, null);
});

test("credential lock blocks only new login, while established session remains usable", async () => {
  const context = await database();
  const issued = await issuedCredential(context);
  const loginId = context.sqlite.prepare("SELECT login_id FROM visit_teacher_credentials").get().login_id;
  const session = await auth.createVisitTeacherSession(context.db, request(), { loginId, code: issued.code });
  context.sqlite.prepare("UPDATE visit_teacher_credentials SET locked_until='2999-01-01T00:00:00.000Z'").run();
  assert.equal((await auth.requireVisitTeacherSession(
    context.db,
    request("203.0.113.10", session.token),
    { allowPinSetup: true },
  )).teacherUserId, "USR-T1");
  const booking = await store.createVisitBooking(context.db, session.identity, {
    requestId: commandId(), date: futureWeekday(), startTime: "09:00", endTime: "09:20",
    publicDisplayConsent: true, classYearId: null, purpose: null,
  });
  const cancelled = await store.cancelOwnVisitBooking(context.db, session.identity, booking.id, {
    requestId: commandId(), expectedVersion: booking.version, reason: null,
  });
  assert.equal(cancelled.status, "cancelled");
  await assert.rejects(
    () => auth.createVisitTeacherSession(context.db, request("203.0.113.11"), { loginId, code: issued.code }),
    (error) => error.code === "invalid_teacher_credentials",
  );
});

test("guest token owns unverified canonical bookings and atomic reschedule rolls back on overlap", async () => {
  const context = await database();
  const opened = await guestAuth.createVisitGuestSession(context.db, guestRequest());
  assert.notEqual(opened.token, opened.identity.tokenHash);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM visit_guest_sessions WHERE token_hash=?")
    .get(opened.token).n, 0);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM visit_guest_sessions WHERE token_hash=?")
    .get(opened.identity.tokenHash).n, 1);
  assert.match(guestAuth.guestSessionCookie(opened.token), /^__Host-visit_guest=.*Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/u);

  const fullName = context.sqlite.prepare("SELECT full_name FROM users WHERE id='USR-T1'").get().full_name;
  const query = Array.from(fullName).slice(0, 3).join("").toLocaleLowerCase("uk-UA");
  const directory = await guestAuth.listGuestTeacherDirectory(context.db, guestRequest(), query);
  assert.equal(directory.length, 1);
  assert.equal(directory[0].fullName, fullName);
  assert.match(directory[0].teacherRef, /^[0-9a-f]{64}$/u);

  const date = futureWeekday();
  const input = {
    requestId: commandId(), teacherRef: directory[0].teacherRef, date,
    startTime: "09:00", endTime: "09:20", publicDisplayConsent: true, classYearId: null, purpose: "Lesson",
  };
  const created = await guestStore.createGuestVisitBooking(context.db, opened.identity, input);
  assert.deepEqual(await guestStore.createGuestVisitBooking(context.db, opened.identity, input), created);
  const persisted = context.sqlite.prepare(`SELECT owner_kind,owner_user_id,owner_auth_user_id,
    owner_email,guest_owner_id,selected_teacher_user_id,surname,public_display_consent,status,version
    FROM visit_bookings WHERE id=?`).get(created.id);
  assert.deepEqual({ ...persisted }, {
    owner_kind: "guest", owner_user_id: null, owner_auth_user_id: null, owner_email: null,
    guest_owner_id: opened.identity.guestOwnerId, selected_teacher_user_id: "USR-T1",
    surname: fullName, public_display_consent: 1, status: "active", version: 1,
  });
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM visit_slot_claims WHERE booking_id=?")
    .get(created.id).n, 4);

  context.sqlite.prepare(`INSERT INTO visit_bookings (
    id,owner_kind,owner_user_id,owner_auth_user_id,owner_email,guest_owner_id,
    selected_teacher_user_id,surname,class_year_id,class_label,visit_date,start_time,end_time,
    purpose,status,cancel_reason,cancelled_by_auth_user_id,cancelled_by_user_id,
    cancelled_by_guest_owner_id,last_mutation_request_id,version,created_at,updated_at,cancelled_at
  ) VALUES ('VIS-VERIFIED','teacher','USR-T1',NULL,NULL,NULL,NULL,?,NULL,NULL,
    ?,'12:00','12:20','','active','',NULL,NULL,NULL,NULL,1,?,?,NULL)`)
    .run(fullName, date, new Date().toISOString(), new Date().toISOString());
  const privateSchedule = await store.readVisitSchedule(context.db, { from: date, to: date }, {
    includePrivateBookings: true,
  });
  assert.deepEqual(privateSchedule.bookings.map((booking) => ({
    id: booking.id, ownerKind: booking.ownerKind, identityVerified: booking.identityVerified,
  })), [
    { id: created.id, ownerKind: "guest", identityVerified: false },
    { id: "VIS-VERIFIED", ownerKind: "teacher", identityVerified: true },
  ]);
  const publicSchedule = await store.readVisitSchedule(context.db, { from: date, to: date });
  assert.deepEqual(publicSchedule.publicBookings, [{
    date,
    startTime: "09:00",
    endTime: "09:20",
    displayName: "Непідтверджений гостьовий запис",
    identityVerified: false,
  }]);
  const publicJson = JSON.stringify(publicSchedule.publicBookings);
  assert.doesNotMatch(publicJson, /Portal Teacher|guest_owner|USR-T1|Lesson/iu);

  const other = await guestAuth.createVisitGuestSession(context.db, guestRequest("203.0.113.211"));
  assert.deepEqual(await guestStore.listOwnGuestVisits(context.db, other.identity, { from: date, to: date }), []);
  await assert.rejects(
    () => guestStore.updateGuestVisitBooking(context.db, other.identity, created.id, {
      requestId: commandId(), expectedVersion: 1, date,
      startTime: "09:30", endTime: "09:50", publicDisplayConsent: true, classYearId: null, purpose: null,
    }),
    (error) => error.code === "booking_not_found",
  );

  const oldClaims = context.sqlite.prepare(
    "SELECT segment_key FROM visit_slot_claims WHERE booking_id=? ORDER BY segment_key",
  ).all(created.id).map((row) => row.segment_key);
  context.db.beforeBatch = () => {
    const now = new Date().toISOString();
    context.sqlite.prepare(`INSERT INTO visit_schedule_closures (
      id,visit_date,start_time,end_time,status,reason,created_by_user_id,cancelled_by_user_id,
      version,created_at,updated_at,cancelled_at
    ) VALUES ('CLO-GUEST-RACE',?,'09:30','09:50','active','','USR-LIB',NULL,1,?,?,NULL)`)
      .run(date, now, now);
    context.sqlite.prepare(`INSERT INTO visit_slot_claims(segment_key,booking_id,closure_id,created_at)
      VALUES (?,NULL,'CLO-GUEST-RACE',?)`).run(`${date}T09:30`, now);
  };
  await assert.rejects(
    () => guestStore.updateGuestVisitBooking(context.db, opened.identity, created.id, {
      requestId: commandId(), expectedVersion: 1, date,
      startTime: "09:30", endTime: "09:50", publicDisplayConsent: true, classYearId: null, purpose: "Changed",
    }),
    (error) => error.code === "slot_unavailable",
  );
  assert.deepEqual(context.sqlite.prepare(
    "SELECT segment_key FROM visit_slot_claims WHERE booking_id=? ORDER BY segment_key",
  ).all(created.id).map((row) => row.segment_key), oldClaims);
  assert.deepEqual({ ...context.sqlite.prepare(
    "SELECT start_time,end_time,version FROM visit_bookings WHERE id=?",
  ).get(created.id) }, { start_time: "09:00", end_time: "09:20", version: 1 });

  const cancelled = await guestStore.cancelGuestVisitBooking(context.db, opened.identity, created.id, {
    requestId: commandId(), expectedVersion: 1, reason: "Changed plans",
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.version, 2);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM visit_slot_claims WHERE booking_id=?")
    .get(created.id).n, 0);
  assert.equal(context.sqlite.prepare(
    "SELECT cancelled_by_guest_owner_id FROM visit_bookings WHERE id=?",
  ).get(created.id).cancelled_by_guest_owner_id, opened.identity.guestOwnerId);
  const serialized = JSON.stringify(context.sqlite.prepare("SELECT * FROM visit_guest_sessions").all())
    + JSON.stringify(context.sqlite.prepare("SELECT * FROM visit_mutation_commands").all());
  assert.doesNotMatch(serialized, new RegExp(opened.token, "u"));
});

test("guest create reasserts the 20-active-booking cap inside the atomic batch", async () => {
  const context = await database();
  const opened = await guestAuth.createVisitGuestSession(context.db, guestRequest());
  const teacherRef = await guestAuth.guestTeacherRef("USR-T1");
  const date = futureWeekday();
  const now = new Date().toISOString();
  for (let index = 0; index < 19; index += 1) {
    context.sqlite.prepare(`INSERT INTO visit_bookings (
      id,owner_kind,owner_user_id,owner_auth_user_id,owner_email,guest_owner_id,
      selected_teacher_user_id,surname,class_year_id,class_label,visit_date,start_time,end_time,
      purpose,status,cancel_reason,cancelled_by_auth_user_id,cancelled_by_user_id,
      cancelled_by_guest_owner_id,last_mutation_request_id,version,created_at,updated_at,cancelled_at
    ) VALUES (?,'guest',NULL,NULL,NULL,?,'USR-T1','Guest Teacher',NULL,NULL,?,'08:00','08:05',
      '','active','',NULL,NULL,NULL,NULL,1,?,?,NULL)`)
      .run(`VIS-CAP-${String(index).padStart(2, "0")}`, opened.identity.guestOwnerId, date, now, now);
  }
  const requestId = commandId();
  context.db.beforeBatch = () => context.sqlite.prepare(`INSERT INTO visit_bookings (
    id,owner_kind,owner_user_id,owner_auth_user_id,owner_email,guest_owner_id,
    selected_teacher_user_id,surname,class_year_id,class_label,visit_date,start_time,end_time,
    purpose,status,cancel_reason,cancelled_by_auth_user_id,cancelled_by_user_id,
    cancelled_by_guest_owner_id,last_mutation_request_id,version,created_at,updated_at,cancelled_at
  ) VALUES ('VIS-CAP-RACE','guest',NULL,NULL,NULL,?,'USR-T1','Guest Teacher',NULL,NULL,
    ?,'08:05','08:10','','active','',NULL,NULL,NULL,NULL,1,?,?,NULL)`)
    .run(opened.identity.guestOwnerId, date, now, now);
  await assert.rejects(
    () => guestStore.createGuestVisitBooking(context.db, opened.identity, {
      requestId, teacherRef, date, startTime: "11:00", endTime: "11:20",
      publicDisplayConsent: true, classYearId: null, purpose: null,
    }),
    (error) => error.code === "booking_limit_reached",
  );
  assert.equal(context.sqlite.prepare(
    "SELECT COUNT(*) AS n FROM visit_bookings WHERE guest_owner_id=? AND status='active'",
  ).get(opened.identity.guestOwnerId).n, 20);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM visit_mutation_commands WHERE id=?")
    .get(requestId).n, 0);
});

test("guest session and mutation rate caps are reasserted atomically", async () => {
  const sessionContext = await database();
  for (let attempt = 0; attempt < 59; attempt += 1) {
    await guestAuth.createVisitGuestSession(sessionContext.db, guestRequest("203.0.113.220"));
  }
  const sessionScope = sessionContext.sqlite.prepare(
    "SELECT scope_hash FROM visit_guest_rate_limits WHERE attempts=59",
  ).get().scope_hash;
  sessionContext.db.beforeBatch = () => sessionContext.sqlite.prepare(
    "UPDATE visit_guest_rate_limits SET attempts=60 WHERE scope_hash=?",
  ).run(sessionScope);
  await assert.rejects(
    () => guestAuth.createVisitGuestSession(sessionContext.db, guestRequest("203.0.113.220")),
    (error) => error.code === "rate_limited",
  );
  assert.equal(sessionContext.sqlite.prepare(
    "SELECT attempts FROM visit_guest_rate_limits WHERE scope_hash=?",
  ).get(sessionScope).attempts, 60);
  assert.equal(sessionContext.sqlite.prepare("SELECT COUNT(*) AS n FROM visit_guest_sessions").get().n, 59);

  const mutationContext = await database();
  const opened = await guestAuth.createVisitGuestSession(mutationContext.db, guestRequest("203.0.113.221"));
  for (let attempt = 0; attempt < 19; attempt += 1) {
    await guestAuth.enforceGuestMutationRate(
      mutationContext.db, guestRequest("203.0.113.221", opened.token), opened.identity,
    );
  }
  mutationContext.db.beforeBatch = () => mutationContext.sqlite.prepare(
    "UPDATE visit_guest_rate_limits SET attempts=20 WHERE attempts=19",
  ).run();
  await assert.rejects(
    () => guestAuth.enforceGuestMutationRate(
      mutationContext.db, guestRequest("203.0.113.221", opened.token), opened.identity,
    ),
    (error) => error.code === "rate_limited",
  );
  assert.deepEqual(mutationContext.sqlite.prepare(
    "SELECT attempts FROM visit_guest_rate_limits WHERE attempts>=20 ORDER BY scope_hash",
  ).all().map((row) => row.attempts), [20, 20]);
});

test("first login changes the temporary code to a four-digit PIN and replay recovery stays capped at three", async () => {
  const context = await database();
  const issued = await issuedCredential(context);
  const loginId = context.sqlite.prepare("SELECT login_id FROM visit_teacher_credentials").get().login_id;
  const loggedIn = await auth.createVisitTeacherSession(context.db, request(), { loginId, code: issued.code });
  const requestId = commandId();
  const newPin = "4826";
  const rotated = await auth.rotateVisitTeacherCode(
    context.db, request("203.0.113.10", loggedIn.token), { requestId, currentCode: issued.code, newPin },
  );
  assert.ok(rotated.token);
  assert.equal(rotated.result.credentialVersion, 2);
  assert.equal(rotated.result.mustChangePin, false);
  assert.equal(rotated.identity.mustChangePin, false);
  await assert.rejects(
    () => auth.requireVisitTeacherSession(context.db, request("203.0.113.10", loggedIn.token)),
    (error) => error.code === "authentication_required",
  );
  assert.equal((await auth.requireVisitTeacherSession(
    context.db, request("203.0.113.10", rotated.token),
  )).credentialVersion, 2);
  const beforeActiveReplay = context.sqlite.prepare(
    "SELECT COUNT(*) AS n FROM visit_teacher_sessions",
  ).get().n;
  const activeReplay = await auth.rotateVisitTeacherCode(
    context.db, request("203.0.113.10", rotated.token), { requestId, currentCode: issued.code, newPin },
  );
  assert.equal(activeReplay.token, null);
  assert.deepEqual(activeReplay.result, rotated.result);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM visit_teacher_sessions").get().n, beforeActiveReplay);

  for (let replay = 0; replay < 5; replay += 1) {
    const recovered = await auth.rotateVisitTeacherCode(
      context.db, request("203.0.113.10", loggedIn.token), { requestId, currentCode: issued.code, newPin },
    );
    assert.ok(recovered.token);
  }
  assert.equal(context.sqlite.prepare(`SELECT COUNT(*) AS n FROM visit_teacher_sessions
    WHERE teacher_user_id='USR-T1' AND revoked_at IS NULL AND expires_at>?`)
    .get(new Date().toISOString()).n, 3);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM visit_mutation_commands WHERE id=?")
    .get(requestId).n, 1);
  const secretDump = JSON.stringify(context.sqlite.prepare(
    "SELECT request_hash,result_json FROM visit_mutation_commands WHERE id=?",
  ).all(requestId)) + JSON.stringify(context.sqlite.prepare(
    "SELECT before_json,after_json,metadata_json FROM audit_events WHERE request_id=?",
  ).all(requestId));
  assert.doesNotMatch(secretDump, /4826/u);

  await assert.rejects(
    () => auth.createVisitTeacherSession(context.db, request("203.0.113.12"), { loginId, code: issued.code }),
    (error) => error.code === "invalid_teacher_credentials",
  );
  const pinLogin = await auth.createVisitTeacherSession(
    context.db, request("203.0.113.13"), { loginId, code: newPin },
  );
  assert.equal(pinLogin.identity.mustChangePin, false);

  const before = context.sqlite.prepare(`SELECT token_hash,revoked_at FROM visit_teacher_sessions
    WHERE teacher_user_id='USR-T1' AND revoked_at IS NULL ORDER BY token_hash`).all()
    .map((row) => ({ ...row }));
  context.db.beforeBatch = () => context.sqlite.prepare(
    "UPDATE visit_teacher_credentials SET status='disabled' WHERE teacher_user_id='USR-T1'",
  ).run();
  await assert.rejects(
    () => auth.rotateVisitTeacherCode(
      context.db, request("203.0.113.10", loggedIn.token), { requestId, currentCode: issued.code, newPin },
    ),
    (error) => error.code === "teacher_auth_unavailable",
  );
  assert.deepEqual(context.sqlite.prepare(`SELECT token_hash,revoked_at FROM visit_teacher_sessions
    WHERE teacher_user_id='USR-T1' AND revoked_at IS NULL ORDER BY token_hash`).all()
    .map((row) => ({ ...row })), before);
});

test("teacher PIN accepts repeated digits, repeated pairs and simple sequences", async () => {
  for (const [index, pin] of ["1111", "1212", "1122", "1234"].entries()) {
    let context;
    let issued;
    do {
      context = await database();
      issued = await issuedCredential(context);
    } while (issued.code === pin);

    const loginId = context.sqlite.prepare("SELECT login_id FROM visit_teacher_credentials").get().login_id;
    const ip = `203.0.113.${140 + index}`;
    const temporarySession = await auth.createVisitTeacherSession(
      context.db,
      request(ip),
      { loginId, code: issued.code },
    );
    const rotated = await auth.rotateVisitTeacherCode(
      context.db,
      request(ip, temporarySession.token),
      { requestId: commandId(), currentCode: issued.code, newPin: pin },
    );
    assert.equal(rotated.identity.mustChangePin, false);

    const pinLogin = await auth.createVisitTeacherSession(
      context.db,
      request(`203.0.113.${150 + index}`),
      { loginId, code: pin },
    );
    assert.equal(pinLogin.identity.mustChangePin, false);
  }

  const invalidContext = await database();
  const invalidIssued = await issuedCredential(invalidContext);
  const invalidLoginId = invalidContext.sqlite.prepare(
    "SELECT login_id FROM visit_teacher_credentials",
  ).get().login_id;
  const invalidSession = await auth.createVisitTeacherSession(
    invalidContext.db,
    request("203.0.113.160"),
    { loginId: invalidLoginId, code: invalidIssued.code },
  );
  await assert.rejects(
    () => auth.rotateVisitTeacherCode(
      invalidContext.db,
      request("203.0.113.160", invalidSession.token),
      { requestId: commandId(), currentCode: invalidIssued.code, newPin: "12a34" },
    ),
    (error) => error.code === "validation_failed" && error.status === 400,
  );
});

test("teacher PIN setup honors failed-attempt limits and an atomic credential lock", async () => {
  const context = await database();
  const issued = await issuedCredential(context);
  const loginId = context.sqlite.prepare("SELECT login_id FROM visit_teacher_credentials").get().login_id;
  const loggedIn = await auth.createVisitTeacherSession(
    context.db, request("203.0.113.70"), { loginId, code: issued.code },
  );
  const newPin = "4826";

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      () => auth.rotateVisitTeacherCode(
        context.db,
        request("203.0.113.70", loggedIn.token),
        { requestId: commandId(), currentCode: wrongCode(issued.code), newPin },
      ),
      (error) => error.code === "invalid_current_code",
    );
  }
  await assert.rejects(
    () => auth.rotateVisitTeacherCode(
      context.db,
      request("203.0.113.70", loggedIn.token),
      { requestId: commandId(), currentCode: issued.code, newPin },
    ),
    (error) => error.code === "rate_limited" && error.status === 429,
  );
  assert.equal(context.sqlite.prepare(
    "SELECT version FROM visit_teacher_credentials WHERE teacher_user_id='USR-T1'",
  ).get().version, 1);
  assert.equal(context.sqlite.prepare(
    "SELECT revoked_at FROM visit_teacher_sessions WHERE token_hash=?",
  ).get(loggedIn.identity.tokenHash).revoked_at, null);

  context.sqlite.prepare("DELETE FROM visit_teacher_login_limits").run();
  context.sqlite.prepare(`UPDATE visit_teacher_credentials
    SET failed_attempts=0,failure_window_started_at=NULL,locked_until=NULL`).run();
  const racedRequestId = commandId();
  context.db.beforeBatch = () => context.sqlite.prepare(`UPDATE visit_teacher_credentials
    SET locked_until='2999-01-01T00:00:00.000Z' WHERE teacher_user_id='USR-T1'`).run();
  await assert.rejects(
    () => auth.rotateVisitTeacherCode(
      context.db,
      request("203.0.113.71", loggedIn.token),
      { requestId: racedRequestId, currentCode: issued.code, newPin },
    ),
    (error) => error.code === "rate_limited" && error.status === 429,
  );
  assert.equal(context.sqlite.prepare(
    "SELECT version FROM visit_teacher_credentials WHERE teacher_user_id='USR-T1'",
  ).get().version, 1);
  assert.equal(context.sqlite.prepare(
    "SELECT COUNT(*) AS n FROM visit_mutation_commands WHERE id=?",
  ).get(racedRequestId).n, 0);
  assert.equal(context.sqlite.prepare(
    "SELECT revoked_at FROM visit_teacher_sessions WHERE token_hash=?",
  ).get(loggedIn.identity.tokenHash).revoked_at, null);
});

test("librarian reset revokes a forgotten PIN and restores one-time setup", async () => {
  const context = await database();
  const issued = await issuedCredential(context);
  const loginId = context.sqlite.prepare("SELECT login_id FROM visit_teacher_credentials").get().login_id;
  const firstSession = await auth.createVisitTeacherSession(
    context.db, request("203.0.113.80"), { loginId, code: issued.code },
  );
  const pin = "4826";
  const rotated = await auth.rotateVisitTeacherCode(
    context.db,
    request("203.0.113.80", firstSession.token),
    { requestId: commandId(), currentCode: issued.code, newPin: pin },
  );
  insertBoundPersonalActivationInvite(context, {
    id: "TGA-reset-personal",
    credentialVersion: rotated.result.credentialVersion,
  });
  const reset = await auth.issueVisitTeacherCode(context.db, context.actor, "USR-T1", {
    requestId: commandId(),
    expectedVersion: rotated.result.credentialVersion,
  });
  assert.equal(reset.credential.mustChangePin, true);
  assert.equal(reset.credential.version, 3);
  assert.equal(context.sqlite.prepare(`SELECT must_change_pin FROM visit_teacher_credentials
    WHERE teacher_user_id='USR-T1'`).get().must_change_pin, 1);
  assert.equal(context.sqlite.prepare(`SELECT COUNT(*) AS n FROM visit_teacher_sessions
    WHERE teacher_user_id='USR-T1' AND revoked_at IS NULL`).get().n, 0);
  assert.ok(context.sqlite.prepare(`SELECT revoked_at FROM telegram_teacher_activation_invites
    WHERE id='TGA-reset-personal'`).get().revoked_at);
  await assert.rejects(
    () => auth.createVisitTeacherSession(context.db, request("203.0.113.81"), { loginId, code: pin }),
    (error) => error.code === "invalid_teacher_credentials",
  );
  const recovered = await auth.createVisitTeacherSession(
    context.db, request("203.0.113.82"), { loginId, code: reset.code },
  );
  assert.equal(recovered.identity.mustChangePin, true);
});

test("lost-phone protection atomically disconnects Telegram and returns one replacement code", async () => {
  const context = await database();
  const issued = await issuedCredential(context);
  const loginId = context.sqlite.prepare("SELECT login_id FROM visit_teacher_credentials WHERE teacher_user_id='USR-T1'").get().login_id;
  const oldSession = await auth.createVisitTeacherSession(context.db, request(), { loginId, code: issued.code });
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 30 * 60_000).toISOString();
  context.sqlite.prepare(`INSERT INTO telegram_connections (
    user_id,telegram_user_id,chat_id,username,status,notify_orders,notify_visits,version,
    linked_at,disabled_at,created_at,updated_at
  ) VALUES ('USR-T1','7001','7001','olena','active',1,1,1,?,NULL,?,?)`).run(now, now, now);
  context.sqlite.prepare(`INSERT INTO telegram_link_tokens (
    id,user_id,token_hash,expires_at,consumed_at,consumed_update_id,revoked_at,created_at
  ) VALUES ('TGL-lost','USR-T1',?, ?,NULL,NULL,NULL,?)`).run("b".repeat(64), future, now);
  context.sqlite.prepare(`INSERT INTO telegram_teacher_activation_invites (
    id,kind,teacher_user_id,credential_version,token_hash,issued_by_user_id,request_id,
    bound_telegram_user_id,bound_chat_id,bound_username,bound_update_id,presented_at,
    expires_at,consumed_init_data_hash,consumed_at,revoked_at,created_at,updated_at
  ) VALUES ('TGA-lost-personal','personal','USR-T1',1,?,'USR-LIB',?,
    NULL,NULL,NULL,NULL,NULL,?,NULL,NULL,NULL,?,?)`)
    .run("c".repeat(64), commandId(), future, now, now);
  const protectedAccess = await auth.protectLostVisitTeacherPhone(
    context.db,
    context.actor,
    "USR-T1",
    { requestId: commandId(), expectedCredentialVersion: 1, expectedTelegramVersion: 1 },
  );
  assert.match(protectedAccess.code, /^\d{4}$/u);
  assert.deepEqual(protectedAccess.telegram, { connected: false, status: "disabled", version: 2 });
  assert.deepEqual(
    { ...context.sqlite.prepare(`SELECT version,must_change_pin,status,last_login_at
      FROM visit_teacher_credentials WHERE teacher_user_id='USR-T1'`).get() },
    { version: 2, must_change_pin: 1, status: "active", last_login_at: null },
  );
  assert.deepEqual(
    { ...context.sqlite.prepare(`SELECT status,version FROM telegram_connections WHERE user_id='USR-T1'`).get() },
    { status: "disabled", version: 2 },
  );
  assert.ok(context.sqlite.prepare("SELECT revoked_at FROM visit_teacher_sessions WHERE token_hash=?")
    .get(oldSession.identity.tokenHash).revoked_at);
  assert.ok(context.sqlite.prepare("SELECT revoked_at FROM telegram_link_tokens WHERE id='TGL-lost'").get().revoked_at);
  assert.ok(context.sqlite.prepare("SELECT revoked_at FROM telegram_teacher_activation_invites WHERE id='TGA-lost-personal'").get().revoked_at);
  await assert.rejects(
    () => auth.createVisitTeacherSession(context.db, request("203.0.113.33"), { loginId, code: issued.code }),
    (error) => error.code === "invalid_teacher_credentials",
  );
  const replacementLogin = await auth.createVisitTeacherSession(
    context.db,
    request("203.0.113.34"),
    { loginId, code: protectedAccess.code },
  );
  assert.equal(replacementLogin.identity.mustChangePin, true);
  const persisted = JSON.stringify({
    credential: context.sqlite.prepare("SELECT * FROM visit_teacher_credentials WHERE teacher_user_id='USR-T1'").get(),
    command: context.sqlite.prepare("SELECT * FROM visit_teacher_access_commands ORDER BY created_at DESC LIMIT 1").get(),
    audits: context.sqlite.prepare("SELECT * FROM audit_events").all(),
  });
  assert.doesNotMatch(persisted, new RegExp(protectedAccess.code.replace("-", ""), "u"));
  context.sqlite.close();
});

test("same-millisecond reset and access-action losers roll back by exact command marker", async () => {
  const context = await database();
  await issuedCredential(context);
  const fixed = "2026-08-13T10:00:00.000Z";
  const OriginalDate = globalThis.Date;
  globalThis.Date = class FrozenDate extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return new OriginalDate(fixed).getTime(); }
  };
  try {
    context.db.beforeBatch = () => context.sqlite.prepare(`UPDATE visit_teacher_credentials
      SET version=2,code_hmac=?,last_access_command_id=?,updated_at=? WHERE teacher_user_id='USR-T1'`)
      .run("f".repeat(64), "11111111-1111-4111-8111-111111111111", fixed);
    await assert.rejects(
      () => auth.issueVisitTeacherCode(context.db, context.actor, "USR-T1", {
        requestId: commandId(), expectedVersion: 1,
      }),
      (error) => error.code === "credential_version_conflict",
    );
    assert.equal(context.sqlite.prepare("SELECT code_hmac FROM visit_teacher_credentials").get().code_hmac, "f".repeat(64));

    context.db.beforeBatch = () => context.sqlite.prepare(`UPDATE visit_teacher_credentials
      SET version=3,status='disabled',last_access_command_id=?,updated_at=? WHERE teacher_user_id='USR-T1'`)
      .run("22222222-2222-4222-8222-222222222222", fixed);
    await assert.rejects(
      () => auth.updateVisitTeacherAccess(context.db, context.actor, "USR-T1", {
        requestId: commandId(), expectedVersion: 2, action: "disable",
      }),
      (error) => error.code === "credential_version_conflict",
    );
    assert.equal(context.sqlite.prepare("SELECT version FROM visit_teacher_credentials").get().version, 3);
  } finally {
    globalThis.Date = OriginalDate;
  }
});

test("Telegram Mini App validates signed initData and rejects tampering, expiry and duplicate fields", async () => {
  const now = new Date();
  const raw = signedTelegramInitData({ now });
  const valid = await miniAppAuth.validateTelegramMiniAppInitData(raw, {
    now,
    botToken: globalThis.__VISIT_TEST_ENV.TELEGRAM_BOT_TOKEN,
    requireEnabled: false,
  });
  assert.equal(valid.telegramUserId, "7001");
  assert.match(valid.initDataHash, /^[0-9a-f]{64}$/u);
  assert.equal(valid.authDate, Math.floor(now.getTime() / 1000));

  const reordered = new URLSearchParams();
  for (const [key, value] of [...new URLSearchParams(raw).entries()].reverse()) {
    reordered.append(key, key === "hash" ? value.toUpperCase() : value);
  }
  const equivalentRaw = reordered.toString().replace(/%[0-9A-F]{2}/gu, (value) => value.toLowerCase());
  const equivalent = await miniAppAuth.validateTelegramMiniAppInitData(equivalentRaw, {
    now,
    botToken: globalThis.__VISIT_TEST_ENV.TELEGRAM_BOT_TOKEN,
    requireEnabled: false,
  });
  assert.equal(equivalent.initDataHash, valid.initDataHash);

  const tampered = new URLSearchParams(raw);
  tampered.set("user", JSON.stringify({ id: 7002, first_name: "Олена" }));
  await assert.rejects(
    () => miniAppAuth.validateTelegramMiniAppInitData(tampered.toString(), {
      now, botToken: globalThis.__VISIT_TEST_ENV.TELEGRAM_BOT_TOKEN, requireEnabled: false,
    }),
    (error) => error.code === "telegram_init_data_invalid" && error.status === 401,
  );

  await assert.rejects(
    () => miniAppAuth.validateTelegramMiniAppInitData(`${raw}&auth_date=1`, {
      now, botToken: globalThis.__VISIT_TEST_ENV.TELEGRAM_BOT_TOKEN, requireEnabled: false,
    }),
    (error) => error.code === "telegram_init_data_invalid",
  );
  const expired = signedTelegramInitData({ now: new Date(now.getTime() - 301_000) });
  await assert.rejects(
    () => miniAppAuth.validateTelegramMiniAppInitData(expired, {
      now, botToken: globalThis.__VISIT_TEST_ENV.TELEGRAM_BOT_TOKEN, requireEnabled: false,
    }),
    (error) => error.code === "telegram_init_data_expired",
  );
  const exactNow = new Date("2026-08-22T10:00:00.000Z");
  const exactBoundary = signedTelegramInitData({ now: new Date(exactNow.getTime() - 300_000) });
  await assert.rejects(
    () => miniAppAuth.validateTelegramMiniAppInitData(exactBoundary, {
      now: exactNow, botToken: globalThis.__VISIT_TEST_ENV.TELEGRAM_BOT_TOKEN, requireEnabled: false,
    }),
    (error) => error.code === "telegram_init_data_expired",
  );
  const future = signedTelegramInitData({ now: new Date(now.getTime() + 61_000) });
  await assert.rejects(
    () => miniAppAuth.validateTelegramMiniAppInitData(future, {
      now, botToken: globalThis.__VISIT_TEST_ENV.TELEGRAM_BOT_TOKEN, requireEnabled: false,
    }),
    (error) => error.code === "telegram_init_data_expired",
  );
});

test("a linked Telegram creates one ordinary teacher session and cannot be replayed", async () => {
  const context = await database();
  const issued = await issuedCredential(context);
  const loginId = context.sqlite.prepare("SELECT login_id FROM visit_teacher_credentials").get().login_id;
  const first = await auth.createVisitTeacherSession(context.db, request(), { loginId, code: issued.code });
  const rotated = await auth.rotateVisitTeacherCode(
    context.db,
    request("203.0.113.10", first.token),
    { requestId: commandId(), currentCode: issued.code, newPin: "4826" },
  );
  const now = new Date().toISOString();
  context.sqlite.prepare(`INSERT INTO telegram_connections (
    user_id,telegram_user_id,chat_id,username,status,notify_orders,notify_visits,version,
    linked_at,disabled_at,created_at,updated_at
  ) VALUES ('USR-T1','7001','7001',NULL,'active',1,1,1,?,NULL,?,?)`).run(now, now, now);
  const raw = signedTelegramInitData();
  const validated = await miniAppAuth.validateTelegramMiniAppInitData(raw, {
    botToken: globalThis.__VISIT_TEST_ENV.TELEGRAM_BOT_TOKEN,
    requireEnabled: false,
  });
  const opened = await auth.createVisitTeacherTelegramSession(context.db, telegramRequest(), {
    telegramUserId: validated.telegramUserId,
    initDataHash: validated.initDataHash,
    authDate: validated.authDate,
    receiptExpiresAt: validated.expiresAt,
  });
  assert.equal(opened.kind, "session");
  assert.equal(opened.identity.teacherUserId, "USR-T1");
  assert.equal(opened.identity.mustChangePin, false);
  assert.equal((await auth.requireVisitTeacherSession(
    context.db,
    telegramRequest("203.0.113.90", opened.token),
  )).credentialVersion, rotated.result.credentialVersion);
  const receipt = context.sqlite.prepare(`SELECT init_data_hash,telegram_user_id,teacher_user_id,
    session_token_hash FROM telegram_mini_app_auth_receipts`).get();
  assert.equal(receipt.init_data_hash, validated.initDataHash);
  assert.equal(receipt.telegram_user_id, "7001");
  assert.equal(receipt.teacher_user_id, "USR-T1");
  assert.equal(receipt.session_token_hash, opened.identity.tokenHash);
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  const freshRaw = signedTelegramInitData({ extra: { query_id: "AAHdF6IQAAAAAN0XohDhrFresh" } });
  const freshValidated = await miniAppAuth.validateTelegramMiniAppInitData(freshRaw, {
    botToken: globalThis.__VISIT_TEST_ENV.TELEGRAM_BOT_TOKEN,
    requireEnabled: false,
  });
  const reopened = await auth.createVisitTeacherTelegramSession(
    context.db,
    telegramRequest("203.0.113.90", opened.token),
    {
      telegramUserId: freshValidated.telegramUserId,
      initDataHash: freshValidated.initDataHash,
      authDate: freshValidated.authDate,
      receiptExpiresAt: freshValidated.expiresAt,
    },
  );
  assert.equal(reopened.kind, "session");
  assert.equal(typeof reopened.token, "string");
  assert.equal(reopened.identity.teacherUserId, "USR-T1");
  assert.notEqual(reopened.token, opened.token);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_mini_app_auth_receipts").get().count, 2);
  await assert.rejects(
    () => auth.createVisitTeacherTelegramSession(context.db, telegramRequest("203.0.113.90"), {
      telegramUserId: freshValidated.telegramUserId,
      initDataHash: freshValidated.initDataHash,
      authDate: freshValidated.authDate,
      receiptExpiresAt: freshValidated.expiresAt,
    }),
    (error) => error.code === "telegram_auth_replayed" && error.status === 409,
  );

  insertUser(context.sqlite, "USR-T2", "Коваленко Марія", "teacher2@example.test", "auth-t2", "teacher", now);
  context.sqlite.prepare(`INSERT INTO visit_teacher_credentials (
    teacher_user_id,login_id,code_hmac,status,version,failed_attempts,failure_window_started_at,
    locked_until,last_login_at,code_rotated_at,last_access_command_id,created_by_user_id,
    updated_by_user_id,created_at,updated_at,must_change_pin
  ) VALUES ('USR-T2','teacher-login-id-0002',?,'active',1,0,NULL,NULL,NULL,?,NULL,
    'USR-LIB','USR-LIB',?,?,0)`).run("a".repeat(64), now, now, now);
  const standardToken = "S".repeat(43);
  const standardTokenHash = createHash("sha256").update(standardToken).digest("hex");
  context.sqlite.prepare(`INSERT INTO visit_teacher_sessions (
    token_hash,teacher_user_id,credential_version,pending_scope,ip_scope_hash,
    expires_at,last_seen_at,revoked_at,created_at
  ) VALUES (?,'USR-T2',1,'pending-scope-t2-0002',?, ?,?,NULL,?)`).run(
    standardTokenHash,
    "b".repeat(64),
    new Date(Date.now() + 60_000).toISOString(),
    now,
    now,
  );
  const mixedHeaders = new Headers({
    "CF-Connecting-IP": "203.0.113.90",
    Cookie: `${auth.VISIT_TEACHER_COOKIE}=${standardToken}; ${auth.VISIT_TEACHER_TELEGRAM_COOKIE}=${opened.token}`,
  });
  const ordinaryMixedRequest = new Request("https://library.example.test/api/teacher/session", { headers: mixedHeaders });
  assert.equal((await auth.requireVisitTeacherSession(context.db, ordinaryMixedRequest)).teacherUserId, "USR-T2");
  mixedHeaders.set("Referer", "https://library.example.test/teacher/telegram/cabinet?tab=overview");
  const telegramMixedRequest = new Request("https://library.example.test/api/teacher/session", { headers: mixedHeaders });
  assert.equal((await auth.requireVisitTeacherSession(context.db, telegramMixedRequest)).teacherUserId, "USR-T1");
  context.sqlite.prepare("UPDATE visit_teacher_sessions SET expires_at=? WHERE token_hash=?")
    .run(new Date(Date.now() - 1_000).toISOString(), opened.identity.tokenHash);
  await assert.rejects(
    () => auth.requireVisitTeacherSession(context.db, telegramMixedRequest),
    (error) => error.code === "authentication_required" && error.status === 401,
  );
  await assert.rejects(
    () => auth.createVisitTeacherTelegramSession(context.db, telegramRequest(), {
      telegramUserId: validated.telegramUserId,
      initDataHash: validated.initDataHash,
      authDate: validated.authDate,
      receiptExpiresAt: validated.expiresAt,
    }),
    (error) => error.code === "telegram_auth_replayed" && error.status === 409,
  );
});

test("Telegram generic onboarding activates an existing teacher and rotates the temporary code", async () => {
  const context = await database();
  const issued = await issuedCredential(context);
  const credentialBefore = context.sqlite.prepare(`SELECT login_id,version,must_change_pin
    FROM visit_teacher_credentials WHERE teacher_user_id='USR-T1'`).get();
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + 30 * 60_000).toISOString();
  context.sqlite.prepare(`INSERT INTO telegram_teacher_activation_invites (
    id,kind,teacher_user_id,credential_version,token_hash,issued_by_user_id,request_id,
    bound_telegram_user_id,bound_chat_id,bound_username,bound_update_id,presented_at,
    expires_at,consumed_init_data_hash,consumed_at,revoked_at,created_at,updated_at
  ) VALUES ('TGA-generic-test','generic',NULL,NULL,NULL,NULL,NULL,
    '7001','7001','teacher_one','501',?, ?,NULL,NULL,NULL,?,?)`)
    .run(nowIso, expiresAt, nowIso, nowIso);
  context.sqlite.prepare(`INSERT INTO telegram_connections (
    user_id,telegram_user_id,chat_id,username,status,notify_orders,notify_visits,version,
    linked_at,disabled_at,created_at,updated_at
  ) VALUES ('USR-T1','6999','6999','old_activation_profile','active',1,1,3,?,NULL,?,?)`)
    .run(nowIso, nowIso, nowIso);
  context.sqlite.prepare(`INSERT INTO telegram_librarian_sessions (
    token_hash,init_data_hash,user_id,telegram_user_id,auth_date,expires_at,last_seen_at,revoked_at,created_at
  ) VALUES (?,?, 'USR-T1','6999',1787432400,'2999-01-01T00:00:00.000Z',?,NULL,?)`)
    .run("9".repeat(64), "8".repeat(64), nowIso, nowIso);
  const validated = await miniAppAuth.validateTelegramMiniAppInitData(signedTelegramInitData({ now }), {
    now,
    botToken: globalThis.__VISIT_TEST_ENV.TELEGRAM_BOT_TOKEN,
    requireEnabled: false,
  });
  const bootstrap = await auth.createVisitTeacherTelegramSession(context.db, telegramRequest(), {
    telegramUserId: validated.telegramUserId,
    initDataHash: validated.initDataHash,
    authDate: validated.authDate,
    receiptExpiresAt: validated.expiresAt,
  });
  assert.deepEqual(bootstrap, {
    kind: "activation",
    mode: "generic",
    teacher: null,
    requiresCode: true,
    requiresNewPin: true,
    grantExpiresAt: expiresAt,
  });
  const activated = await auth.activateVisitTeacherTelegramSession(
    context.db,
    telegramRequest(),
    {
      telegramUserId: validated.telegramUserId,
      initDataHash: validated.initDataHash,
      authDate: validated.authDate,
      receiptExpiresAt: validated.expiresAt,
      requestId: commandId(),
      intent: "activate",
      loginId: credentialBefore.login_id,
      code: issued.code,
      newPin: "1111",
    },
  );
  assert.equal(activated.identity.teacherUserId, "USR-T1");
  assert.equal(activated.identity.mustChangePin, false);
  assert.deepEqual(
    { ...context.sqlite.prepare(`SELECT version,must_change_pin,status
      FROM visit_teacher_credentials WHERE teacher_user_id='USR-T1'`).get() },
    { version: credentialBefore.version + 1, must_change_pin: 0, status: "active" },
  );
  assert.deepEqual(
    { ...context.sqlite.prepare(`SELECT user_id,telegram_user_id,chat_id,status
      FROM telegram_connections WHERE user_id='USR-T1'`).get() },
    { user_id: "USR-T1", telegram_user_id: "7001", chat_id: "7001", status: "active" },
  );
  assert.ok(context.sqlite.prepare(`SELECT revoked_at FROM telegram_librarian_sessions
    WHERE token_hash=?`).get("9".repeat(64)).revoked_at);
  const grant = context.sqlite.prepare(`SELECT consumed_at,consumed_init_data_hash,revoked_at
    FROM telegram_teacher_activation_invites WHERE id='TGA-generic-test'`).get();
  assert.ok(grant.consumed_at);
  assert.equal(grant.consumed_init_data_hash, validated.initDataHash);
  assert.equal(grant.revoked_at, null);
  assert.equal((await auth.requireVisitTeacherSession(
    context.db,
    telegramRequest("203.0.113.90", activated.token),
  )).teacherUserId, "USR-T1");
  const persisted = {
    credentials: context.sqlite.prepare("SELECT * FROM visit_teacher_credentials").all(),
    receipts: context.sqlite.prepare("SELECT * FROM telegram_mini_app_auth_receipts").all(),
    grants: context.sqlite.prepare("SELECT * FROM telegram_teacher_activation_invites").all(),
    audits: context.sqlite.prepare("SELECT * FROM audit_events").all(),
  };
  assertNoExactPlaintextSecrets(persisted, ["1111", issued.code]);
});

test("Telegram activation cannot reuse a temporary code consumed after precheck", async () => {
  const context = await database();
  const issued = await issuedCredential(context);
  const credential = context.sqlite.prepare(`SELECT login_id FROM visit_teacher_credentials
    WHERE teacher_user_id='USR-T1'`).get();
  insertBoundGenericActivationInvite(context, { id: "TGA-expired-between-check-and-batch" });
  const validated = await miniAppAuth.validateTelegramMiniAppInitData(signedTelegramInitData(), {
    botToken: globalThis.__VISIT_TEST_ENV.TELEGRAM_BOT_TOKEN,
    requireEnabled: false,
  });
  context.db.beforeBatch = () => context.sqlite.prepare(`UPDATE visit_teacher_credentials
    SET code_expires_at='2000-01-01T00:00:00.000Z'
    WHERE teacher_user_id='USR-T1'`).run();
  await assert.rejects(
    () => auth.activateVisitTeacherTelegramSession(context.db, telegramRequest(), {
      telegramUserId: validated.telegramUserId,
      initDataHash: validated.initDataHash,
      authDate: validated.authDate,
      receiptExpiresAt: validated.expiresAt,
      requestId: commandId(),
      intent: "activate",
      loginId: credential.login_id,
      code: issued.code,
      newPin: "4826",
    }),
    (error) => error.code === "telegram_activation_conflict" && error.status === 409,
  );
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_mini_app_auth_receipts").get().n, 0);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_connections").get().n, 0);
  context.sqlite.close();
});

test("Telegram activation reasserts rate limits inside the successful batch", async () => {
  const context = await database();
  const issued = await issuedCredential(context);
  const credential = context.sqlite.prepare(`SELECT login_id,version FROM visit_teacher_credentials
    WHERE teacher_user_id='USR-T1'`).get();
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + 30 * 60_000).toISOString();
  context.sqlite.prepare(`INSERT INTO telegram_teacher_activation_invites (
    id,kind,teacher_user_id,credential_version,token_hash,issued_by_user_id,request_id,
    bound_telegram_user_id,bound_chat_id,bound_username,bound_update_id,presented_at,
    expires_at,consumed_init_data_hash,consumed_at,revoked_at,created_at,updated_at
  ) VALUES ('TGA-rate-race','generic',NULL,NULL,NULL,NULL,NULL,
    '7001','7001','teacher_one','rate-race-update',?,?,NULL,NULL,NULL,?,?)`)
    .run(nowIso, expiresAt, nowIso, nowIso);
  const validated = await miniAppAuth.validateTelegramMiniAppInitData(signedTelegramInitData({
    now,
    extra: { query_id: "AAHdF6IQAAAAAN0XohDRateRace" },
  }), {
    now,
    botToken: globalThis.__VISIT_TEST_ENV.TELEGRAM_BOT_TOKEN,
    requireEnabled: false,
  });
  const telegramScope = createHmac("sha256", globalThis.__VISIT_TEST_ENV.VISIT_TEACHER_AUTH_PEPPER)
    .update(`telegram-activation-user:${validated.telegramUserId}`)
    .digest("hex");
  context.db.beforeBatch = () => context.sqlite.prepare(`INSERT INTO visit_teacher_login_limits (
    scope_hash,attempts,window_started_at,blocked_until,updated_at
  ) VALUES (?,1,?,?,?)`).run(
    telegramScope,
    new Date().toISOString(),
    "2999-01-01T00:00:00.000Z",
    new Date().toISOString(),
  );
  await assert.rejects(
    () => auth.activateVisitTeacherTelegramSession(context.db, telegramRequest(), {
      telegramUserId: validated.telegramUserId,
      initDataHash: validated.initDataHash,
      authDate: validated.authDate,
      receiptExpiresAt: validated.expiresAt,
      requestId: commandId(),
      intent: "activate",
      loginId: credential.login_id,
      code: issued.code,
      newPin: "4826",
    }),
    (error) => error.code === "rate_limited" && error.status === 429,
  );
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_mini_app_auth_receipts").get().n, 0);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_connections").get().n, 0);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM visit_teacher_sessions").get().n, 0);
  assert.deepEqual(
    { ...context.sqlite.prepare(`SELECT version,must_change_pin FROM visit_teacher_credentials
      WHERE teacher_user_id='USR-T1'`).get() },
    { version: credential.version, must_change_pin: 1 },
  );
  assert.equal(context.sqlite.prepare(`SELECT consumed_at FROM telegram_teacher_activation_invites
    WHERE id='TGA-rate-race'`).get().consumed_at, null);
});

test("Telegram personal invite requires the temporary code and creates the first PIN", async () => {
  const context = await database();
  const issued = await issuedCredential(context);
  const expiresAt = insertBoundPersonalActivationInvite(context, {
    id: "TGA-personal-first-pin",
    credentialVersion: 1,
  });
  const now = new Date();
  const validated = await miniAppAuth.validateTelegramMiniAppInitData(signedTelegramInitData({ now }), {
    now,
    botToken: globalThis.__VISIT_TEST_ENV.TELEGRAM_BOT_TOKEN,
    requireEnabled: false,
  });
  assert.deepEqual(await auth.createVisitTeacherTelegramSession(context.db, telegramRequest(), {
    telegramUserId: validated.telegramUserId,
    initDataHash: validated.initDataHash,
    authDate: validated.authDate,
    receiptExpiresAt: validated.expiresAt,
  }), {
    kind: "activation",
    mode: "personal",
    teacher: { fullName: "Шевченко Олена" },
    requiresCode: true,
    requiresNewPin: true,
    grantExpiresAt: expiresAt,
  });
  const activated = await auth.activateVisitTeacherTelegramSession(context.db, telegramRequest(), {
    telegramUserId: validated.telegramUserId,
    initDataHash: validated.initDataHash,
    authDate: validated.authDate,
    receiptExpiresAt: validated.expiresAt,
    requestId: commandId(),
    intent: "activate",
    loginId: "",
    code: issued.code,
    newPin: "4826",
  });
  assert.equal(activated.identity.teacherUserId, "USR-T1");
  assert.equal(activated.identity.credentialVersion, 2);
  assert.deepEqual(
    { ...context.sqlite.prepare(`SELECT version,must_change_pin FROM visit_teacher_credentials
      WHERE teacher_user_id='USR-T1'`).get() },
    { version: 2, must_change_pin: 0 },
  );
  assert.ok(context.sqlite.prepare(`SELECT consumed_at FROM telegram_teacher_activation_invites
    WHERE id='TGA-personal-first-pin'`).get().consumed_at);
  assert.equal(context.sqlite.prepare(`SELECT COUNT(*) AS n FROM telegram_connections
    WHERE user_id='USR-T1' AND telegram_user_id='7001' AND status='active'`).get().n, 1);
  context.sqlite.close();
});

test("Telegram personal invite for an existing cabinet requires the current PIN", async () => {
  const context = await database();
  const issued = await issuedCredential(context);
  const loginId = context.sqlite.prepare("SELECT login_id FROM visit_teacher_credentials").get().login_id;
  const first = await auth.createVisitTeacherSession(context.db, request(), { loginId, code: issued.code });
  await auth.rotateVisitTeacherCode(
    context.db,
    request("203.0.113.10", first.token),
    { requestId: commandId(), currentCode: issued.code, newPin: "4826" },
  );
  const expiresAt = insertBoundPersonalActivationInvite(context, {
    id: "TGA-personal-existing-pin",
    credentialVersion: 2,
    telegramUserId: "7002",
  });
  const now = new Date();
  const validated = await miniAppAuth.validateTelegramMiniAppInitData(
    signedTelegramInitData({ telegramUserId: 7002, now }),
    { now, botToken: globalThis.__VISIT_TEST_ENV.TELEGRAM_BOT_TOKEN, requireEnabled: false },
  );
  assert.deepEqual(await auth.createVisitTeacherTelegramSession(context.db, telegramRequest(), {
    telegramUserId: validated.telegramUserId,
    initDataHash: validated.initDataHash,
    authDate: validated.authDate,
    receiptExpiresAt: validated.expiresAt,
  }), {
    kind: "activation",
    mode: "personal",
    teacher: { fullName: "Шевченко Олена" },
    requiresCode: true,
    requiresNewPin: false,
    grantExpiresAt: expiresAt,
  });
  await assert.rejects(
    () => auth.activateVisitTeacherTelegramSession(context.db, telegramRequest(), {
      telegramUserId: validated.telegramUserId,
      initDataHash: validated.initDataHash,
      authDate: validated.authDate,
      receiptExpiresAt: validated.expiresAt,
      requestId: commandId(),
      intent: "login",
      loginId: "",
      code: "5937",
      newPin: "",
    }),
    (error) => error.code === "invalid_teacher_credentials" && error.status === 401,
  );
  const activated = await auth.activateVisitTeacherTelegramSession(context.db, telegramRequest(), {
    telegramUserId: validated.telegramUserId,
    initDataHash: validated.initDataHash,
    authDate: validated.authDate,
    receiptExpiresAt: validated.expiresAt,
    requestId: commandId(),
    intent: "login",
    loginId: "",
    code: "4826",
    newPin: "",
  });
  assert.equal(activated.identity.credentialVersion, 2);
  assert.equal(context.sqlite.prepare(`SELECT version FROM visit_teacher_credentials
    WHERE teacher_user_id='USR-T1'`).get().version, 2);
  assert.ok(context.sqlite.prepare(`SELECT consumed_at FROM telegram_teacher_activation_invites
    WHERE id='TGA-personal-existing-pin'`).get().consumed_at);
  context.sqlite.close();
});

test("Telegram login and first activation fail closed across credential modes", async () => {
  const temporary = await database();
  const temporaryIssued = await issuedCredential(temporary);
  const temporaryLoginId = temporary.sqlite.prepare("SELECT login_id FROM visit_teacher_credentials").get().login_id;
  insertBoundGenericActivationInvite(temporary, { id: "TGA-login-cannot-use-temp" });
  const temporaryValidated = await miniAppAuth.validateTelegramMiniAppInitData(signedTelegramInitData(), {
    botToken: globalThis.__VISIT_TEST_ENV.TELEGRAM_BOT_TOKEN,
    requireEnabled: false,
  });
  await assert.rejects(
    () => auth.activateVisitTeacherTelegramSession(temporary.db, telegramRequest(), {
      telegramUserId: temporaryValidated.telegramUserId,
      initDataHash: temporaryValidated.initDataHash,
      authDate: temporaryValidated.authDate,
      receiptExpiresAt: temporaryValidated.expiresAt,
      requestId: commandId(),
      intent: "login",
      loginId: temporaryLoginId,
      code: temporaryIssued.code,
      newPin: "",
    }),
    (error) => error.code === "invalid_teacher_credentials" && error.status === 401,
  );
  assert.equal(temporary.sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_mini_app_auth_receipts").get().n, 0);
  assert.equal(temporary.sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_connections").get().n, 0);
  assert.deepEqual(
    { ...temporary.sqlite.prepare(`SELECT version,must_change_pin FROM visit_teacher_credentials
      WHERE teacher_user_id='USR-T1'`).get() },
    { version: 1, must_change_pin: 1 },
  );
  temporary.sqlite.close();

  const permanent = await database();
  const permanentCredential = await permanentPinCredential(permanent);
  insertBoundGenericActivationInvite(permanent, {
    id: "TGA-activate-cannot-use-pin",
    telegramUserId: "7012",
  });
  const permanentValidated = await miniAppAuth.validateTelegramMiniAppInitData(
    signedTelegramInitData({ telegramUserId: 7012 }),
    { botToken: globalThis.__VISIT_TEST_ENV.TELEGRAM_BOT_TOKEN, requireEnabled: false },
  );
  await assert.rejects(
    () => auth.activateVisitTeacherTelegramSession(permanent.db, telegramRequest(), {
      telegramUserId: permanentValidated.telegramUserId,
      initDataHash: permanentValidated.initDataHash,
      authDate: permanentValidated.authDate,
      receiptExpiresAt: permanentValidated.expiresAt,
      requestId: commandId(),
      intent: "activate",
      loginId: permanentCredential.loginId,
      code: permanentCredential.pin,
      newPin: "5937",
    }),
    (error) => error.code === "invalid_teacher_credentials" && error.status === 401,
  );
  assert.equal(permanent.sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_mini_app_auth_receipts").get().n, 0);
  assert.equal(permanent.sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_connections").get().n, 0);
  assert.deepEqual(
    { ...permanent.sqlite.prepare(`SELECT version,must_change_pin FROM visit_teacher_credentials
      WHERE teacher_user_id='USR-T1'`).get() },
    { version: 2, must_change_pin: 0 },
  );
  permanent.sqlite.close();
});

test("Telegram activation core rejects an unknown intent before reading grants", async () => {
  const context = await database();
  await assert.rejects(
    () => auth.activateVisitTeacherTelegramSession(context.db, telegramRequest(), {
      telegramUserId: "7001",
      initDataHash: "a".repeat(64),
      authDate: Math.floor(Date.now() / 1000),
      receiptExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      requestId: commandId(),
      intent: "unknown",
      loginId: "",
      code: "",
      newPin: "",
    }),
    (error) => error.code === "telegram_init_data_invalid" && error.status === 401,
  );
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_mini_app_auth_receipts").get().n, 0);
  context.sqlite.close();
});

test("valid PIN moves one teacher binding to a new Telegram and revokes old sessions", async () => {
  const context = await database();
  const credential = await permanentPinCredential(context);
  const before = context.sqlite.prepare(`SELECT version,code_hmac FROM visit_teacher_credentials
    WHERE teacher_user_id='USR-T1'`).get();
  const now = new Date().toISOString();
  context.sqlite.prepare(`INSERT INTO telegram_connections (
    user_id,telegram_user_id,chat_id,username,status,notify_orders,notify_visits,version,
    linked_at,disabled_at,created_at,updated_at
  ) VALUES ('USR-T1','7001','7001','old_profile','active',0,1,3,?,NULL,?,?)`)
    .run(now, now, now);
  context.sqlite.prepare(`INSERT INTO telegram_librarian_sessions (
    token_hash,init_data_hash,user_id,telegram_user_id,auth_date,expires_at,last_seen_at,revoked_at,created_at
  ) VALUES (?,?, 'USR-T1','7001',1787432400,'2999-01-01T00:00:00.000Z',?,NULL,?)`)
    .run("c".repeat(64), "d".repeat(64), now, now);
  context.sqlite.prepare(`INSERT INTO telegram_link_tokens (
    id,user_id,token_hash,expires_at,consumed_at,consumed_update_id,revoked_at,created_at
  ) VALUES ('TGL-rebind-pending','USR-T1',?,'2999-01-01T00:00:00.000Z',NULL,NULL,NULL,?)`)
    .run("e".repeat(64), now);
  insertBoundGenericActivationInvite(context, {
    id: "TGA-rebind-new-profile",
    telegramUserId: "7002",
  });
  const validated = await miniAppAuth.validateTelegramMiniAppInitData(
    signedTelegramInitData({ telegramUserId: 7002 }),
    { botToken: globalThis.__VISIT_TEST_ENV.TELEGRAM_BOT_TOKEN, requireEnabled: false },
  );
  const activated = await auth.activateVisitTeacherTelegramSession(context.db, telegramRequest(), {
    telegramUserId: validated.telegramUserId,
    initDataHash: validated.initDataHash,
    authDate: validated.authDate,
    receiptExpiresAt: validated.expiresAt,
    requestId: commandId(),
    intent: "login",
    loginId: credential.loginId,
    code: credential.pin,
    newPin: "",
  });
  assert.equal(activated.identity.teacherUserId, "USR-T1");
  assert.deepEqual(
    { ...context.sqlite.prepare(`SELECT telegram_user_id,chat_id,status,notify_orders,notify_visits
      FROM telegram_connections WHERE user_id='USR-T1'`).get() },
    { telegram_user_id: "7002", chat_id: "7002", status: "active", notify_orders: 1, notify_visits: 1 },
  );
  assert.deepEqual(
    { ...context.sqlite.prepare(`SELECT version,code_hmac FROM visit_teacher_credentials
      WHERE teacher_user_id='USR-T1'`).get() },
    { version: before.version, code_hmac: before.code_hmac },
  );
  const oldTokenHash = createHash("sha256").update(credential.session.token).digest("hex");
  assert.ok(context.sqlite.prepare(`SELECT revoked_at FROM visit_teacher_sessions
    WHERE token_hash=?`).get(oldTokenHash).revoked_at);
  assert.ok(context.sqlite.prepare(`SELECT revoked_at FROM telegram_librarian_sessions
    WHERE token_hash=?`).get("c".repeat(64)).revoked_at);
  assert.ok(context.sqlite.prepare(`SELECT revoked_at FROM telegram_link_tokens
    WHERE id='TGL-rebind-pending'`).get().revoked_at);
  assert.equal(context.sqlite.prepare(`SELECT COUNT(*) AS n FROM visit_teacher_sessions
    WHERE teacher_user_id='USR-T1' AND revoked_at IS NULL`).get().n, 1);
  context.sqlite.close();
});

test("connected Telegram with a reset credential still requires its temporary code", async () => {
  const context = await database();
  const issued = await issuedCredential(context);
  const nowIso = new Date().toISOString();
  context.sqlite.prepare(`INSERT INTO telegram_connections (
    user_id,telegram_user_id,chat_id,username,status,notify_orders,notify_visits,version,
    linked_at,disabled_at,created_at,updated_at
  ) VALUES ('USR-T1','7003','7003','teacher_one','active',1,1,1,?,NULL,?,?)`)
    .run(nowIso, nowIso, nowIso);
  const now = new Date();
  const validated = await miniAppAuth.validateTelegramMiniAppInitData(
    signedTelegramInitData({ telegramUserId: 7003, now }),
    { now, botToken: globalThis.__VISIT_TEST_ENV.TELEGRAM_BOT_TOKEN, requireEnabled: false },
  );
  assert.deepEqual(await auth.createVisitTeacherTelegramSession(context.db, telegramRequest(), {
    telegramUserId: validated.telegramUserId,
    initDataHash: validated.initDataHash,
    authDate: validated.authDate,
    receiptExpiresAt: validated.expiresAt,
  }), {
    kind: "activation",
    mode: "connected",
    teacher: { fullName: "Шевченко Олена" },
    requiresCode: true,
    requiresNewPin: true,
    grantExpiresAt: null,
  });
  await assert.rejects(
    () => auth.activateVisitTeacherTelegramSession(context.db, telegramRequest(), {
      telegramUserId: validated.telegramUserId,
      initDataHash: validated.initDataHash,
      authDate: validated.authDate,
      receiptExpiresAt: validated.expiresAt,
      requestId: commandId(),
      intent: "activate",
      loginId: "",
      code: "",
      newPin: "5937",
    }),
    (error) => error.code === "invalid_teacher_credentials" && error.status === 401,
  );
  const activated = await auth.activateVisitTeacherTelegramSession(context.db, telegramRequest(), {
    telegramUserId: validated.telegramUserId,
    initDataHash: validated.initDataHash,
    authDate: validated.authDate,
    receiptExpiresAt: validated.expiresAt,
    requestId: commandId(),
    intent: "activate",
    loginId: "",
    code: issued.code,
    newPin: "5937",
  });
  assert.equal(activated.identity.credentialVersion, 2);
  assert.equal(activated.identity.mustChangePin, false);
  assert.equal(context.sqlite.prepare(`SELECT status FROM telegram_connections
    WHERE user_id='USR-T1'`).get().status, "active");
  context.sqlite.close();
});

test("Telegram session exchange rolls back if the connection changes after lookup", async () => {
  const context = await database();
  const issued = await issuedCredential(context);
  const loginId = context.sqlite.prepare("SELECT login_id FROM visit_teacher_credentials").get().login_id;
  const first = await auth.createVisitTeacherSession(context.db, request(), { loginId, code: issued.code });
  await auth.rotateVisitTeacherCode(
    context.db,
    request("203.0.113.10", first.token),
    { requestId: commandId(), currentCode: issued.code, newPin: "4826" },
  );
  const now = new Date().toISOString();
  context.sqlite.prepare(`INSERT INTO telegram_connections (
    user_id,telegram_user_id,chat_id,username,status,notify_orders,notify_visits,version,
    linked_at,disabled_at,created_at,updated_at
  ) VALUES ('USR-T1','7001','7001',NULL,'active',1,1,1,?,NULL,?,?)`).run(now, now, now);
  const validated = await miniAppAuth.validateTelegramMiniAppInitData(signedTelegramInitData(), {
    botToken: globalThis.__VISIT_TEST_ENV.TELEGRAM_BOT_TOKEN,
    requireEnabled: false,
  });
  context.db.beforeBatch = () => context.sqlite.prepare(
    "UPDATE telegram_connections SET status='disabled',disabled_at=?,updated_at=? WHERE telegram_user_id='7001'",
  ).run(now, now);
  await assert.rejects(
    () => auth.createVisitTeacherTelegramSession(context.db, telegramRequest("203.0.113.91"), {
      telegramUserId: validated.telegramUserId,
      initDataHash: validated.initDataHash,
      authDate: validated.authDate,
      receiptExpiresAt: validated.expiresAt,
    }),
    (error) => error.code === "teacher_auth_unavailable" && error.status === 503,
  );
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_mini_app_auth_receipts").get().count, 0);
  assert.equal(context.sqlite.prepare(
    "SELECT COUNT(*) AS count FROM visit_teacher_sessions WHERE token_hash IN (SELECT session_token_hash FROM telegram_mini_app_auth_receipts)",
  ).get().count, 0);
});

test("bulk issue is constant-statement, stores no codes and rolls back a subset race", async () => {
  const context = await database();
  const now = new Date().toISOString();
  for (let index = 2; index <= 100; index += 1) {
    insertUser(
      context.sqlite, `USR-T${index}`, `Учитель ${String(index).padStart(3, "0")}`,
      `teacher${index}@example.test`, `auth-t${index}`, "teacher", now,
    );
  }
  const result = await auth.bulkIssueVisitTeacherCodes(context.db, context.actor, {
    requestId: commandId(), confirmation: "ISSUE_MISSING_ONLY",
  });
  assert.equal(result.issued.length, 100);
  assert.ok(result.statementCount < 10);
  const stored = JSON.stringify(context.sqlite.prepare(
    "SELECT request_hash,result_json FROM visit_teacher_access_commands",
  ).all()) + JSON.stringify(context.sqlite.prepare(
    "SELECT metadata_json,after_json FROM audit_events",
  ).all());
  for (const row of result.issued) {
    assert.equal(stored.includes(JSON.stringify(row.code.replace("-", ""))), false);
  }

  const raced = await database();
  insertUser(raced.sqlite, "USR-T2", "Учитель Другий", "teacher2@example.test", "auth-t2", "teacher");
  const raceRequestId = commandId();
  raced.db.beforeBatch = () => raced.sqlite.prepare(`INSERT INTO visit_teacher_credentials (
    teacher_user_id,login_id,code_hmac,status,version,failed_attempts,failure_window_started_at,
    locked_until,last_login_at,code_rotated_at,last_access_command_id,created_by_user_id,
    updated_by_user_id,created_at,updated_at
  ) VALUES ('USR-T1','concurrent-login-id-001',?,'active',1,0,NULL,NULL,NULL,?,NULL,
    'USR-LIB','USR-LIB',?,?)`).run("e".repeat(64), now, now, now);
  await assert.rejects(
    () => auth.bulkIssueVisitTeacherCodes(raced.db, raced.actor, {
      requestId: raceRequestId, confirmation: "ISSUE_MISSING_ONLY",
    }),
    (error) => error.code === "teacher_access_update_failed",
  );
  assert.equal(raced.sqlite.prepare("SELECT COUNT(*) AS n FROM visit_teacher_credentials").get().n, 1);
  assert.equal(raced.sqlite.prepare(
    "SELECT COUNT(*) AS n FROM visit_teacher_access_commands WHERE id=?",
  ).get(raceRequestId).n, 0);
});

test("admin actor and active teacher are reasserted inside each mutation batch", async () => {
  const context = await database();
  context.db.beforeBatch = () => context.sqlite.prepare(
    "UPDATE users SET status='inactive' WHERE id='USR-LIB'",
  ).run();
  await assert.rejects(
    () => issuedCredential(context),
    (error) => error.code === "credential_version_conflict",
  );
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM visit_teacher_credentials").get().n, 0);

  context.sqlite.prepare("UPDATE users SET status='active' WHERE id='USR-LIB'").run();
  await issuedCredential(context);
  context.db.beforeBatch = () => context.sqlite.prepare(
    "UPDATE users SET status='inactive' WHERE id='USR-T1'",
  ).run();
  await assert.rejects(
    () => auth.updateVisitTeacherAccess(context.db, context.actor, "USR-T1", {
      requestId: commandId(), expectedVersion: 1, action: "disable",
    }),
    (error) => error.code === "credential_version_conflict",
  );
  assert.equal(context.sqlite.prepare("SELECT status,version FROM visit_teacher_credentials").get().status, "active");
});

test("admin routes enforce same-origin, exact keys, UUID request IDs and private no-store", async () => {
  const api = await readFile(new URL("../lib/visit-teacher-access-api.ts", import.meta.url), "utf8");
  const routes = await Promise.all([
    "../app/api/librarian/visits/teacher-access/[teacherId]/code/route.ts",
    "../app/api/librarian/visits/teacher-access/[teacherId]/route.ts",
    "../app/api/librarian/visits/teacher-access/bulk-issue/route.ts",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  const importRoute = await readFile(new URL(
    "../app/api/librarian/visits/teacher-access/import/route.ts",
    import.meta.url,
  ), "utf8");
  const templateRoute = await readFile(new URL(
    "../app/api/librarian/visits/teacher-access/import-template/route.ts",
    import.meta.url,
  ), "utf8");
  assert.match(api, /isSameOriginRequest\(request\)/u);
  assert.match(api, /expected\.every\(\(key\) => keys\.includes\(key\)\)/u);
  assert.match(api, /\^\[0-9a-f\]\{8\}/u);
  for (const route of routes) {
    assert.match(route, /exactBodyKeys/u);
    assert.match(route, /validRequestId/u);
  }
  assert.match(importRoute, /authorizeVisitTeacherAccessApi\(request\)/u);
  assert.match(importRoute, /visitTeacherCodeImportBody/u);
  assert.match(importRoute, /validateVisitTeacherCodeImportInput/u);
  assert.doesNotMatch(importRoute, /code:\s*row\.code/u);
  assert.match(templateRoute, /private, no-store/u);
  assert.match(templateRoute, /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/u);
  const scheduleApi = await readFile(new URL("../lib/visit-schedule-api.ts", import.meta.url), "utf8");
  assert.match(scheduleApi, /"Cache-Control": "private, no-store"/u);
});
