import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

globalThis.__VISIT_TEST_ENV = {
  VISIT_TEACHER_CODE_AUTH_ENABLED: "true",
  VISIT_TEACHER_AUTH_PEPPER: "test-only-pepper-that-is-at-least-32-characters-long",
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
}

function request(ip = "203.0.113.10", cookie = null) {
  const headers = new Headers({ "CF-Connecting-IP": ip });
  if (cookie) headers.set("Cookie", `${auth.VISIT_TEACHER_COOKIE}=${cookie}`);
  return new Request("https://library.example.test/api/visits/teacher/session", { headers });
}

function commandId() { return crypto.randomUUID(); }

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
  return `${raw.slice(0, 5)}-${raw.slice(5, -1)}${last}`;
}

test("one-time code, Ukrainian directory and opaque cookie session work without email", async () => {
  const context = await database();
  const issued = await issuedCredential(context);
  assert.match(issued.code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/u);
  const directory = await auth.listVisitTeacherDirectory(context.db, "шев", request());
  assert.deepEqual(directory, [{ loginId: context.sqlite.prepare(
    "SELECT login_id FROM visit_teacher_credentials WHERE teacher_user_id='USR-T1'",
  ).get().login_id, fullName: "Шевченко Олена", publicHint: null }]);

  const loginId = directory[0].loginId;
  const loggedIn = await auth.createVisitTeacherSession(context.db, request(), { loginId, code: issued.code });
  assert.equal(loggedIn.identity.fullName, "Шевченко Олена");
  assert.notEqual(loggedIn.token, loggedIn.identity.tokenHash);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM visit_teacher_sessions WHERE token_hash=?")
    .get(loggedIn.identity.tokenHash).n, 1);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM visit_teacher_sessions WHERE token_hash=?")
    .get(loggedIn.token).n, 0);
  assert.equal((await auth.requireVisitTeacherSession(context.db, request("203.0.113.10", loggedIn.token))).teacherUserId, "USR-T1");
  assert.match(auth.teacherSessionCookie(loggedIn.token), /^__Host-visit_teacher=.*HttpOnly; Secure; SameSite=Lax$/u);

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
  const issued = await issuedCredential(context);
  const loginId = context.sqlite.prepare("SELECT login_id FROM visit_teacher_credentials").get().login_id;
  const sessions = [];
  for (let index = 0; index < 4; index += 1) {
    sessions.push(await auth.createVisitTeacherSession(
      context.db, request("203.0.113.30"), { loginId, code: issued.code },
    ));
  }
  assert.equal(context.sqlite.prepare(`SELECT COUNT(*) AS n FROM visit_teacher_sessions
    WHERE revoked_at IS NULL AND expires_at>?`).get(new Date().toISOString()).n, 3);
  await assert.rejects(
    () => auth.requireVisitTeacherSession(context.db, request("203.0.113.30", sessions[0].token)),
    (error) => error.code === "authentication_required",
  );
  assert.equal((await auth.requireVisitTeacherSession(
    context.db, request("203.0.113.30", sessions[3].token),
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
    const issued = await issuedCredential(context);
    const loginId = context.sqlite.prepare("SELECT login_id FROM visit_teacher_credentials").get().login_id;
    const previous = [];
    for (let index = 0; index < 3; index += 1) {
      previous.push(await auth.createVisitTeacherSession(
        context.db, request(`203.0.113.${40 + index}`), { loginId, code: issued.code },
      ));
    }
    context.db.beforeBatch = () => context.sqlite.exec(mutation);
    await assert.rejects(
      () => auth.createVisitTeacherSession(context.db, request("203.0.113.50"), { loginId, code: issued.code }),
      (error) => error.code === "teacher_auth_unavailable",
    );
    assert.equal(context.sqlite.prepare(`SELECT COUNT(*) AS n FROM visit_teacher_sessions
      WHERE revoked_at IS NULL AND expires_at>?`).get(new Date().toISOString()).n, 3);
    assert.equal(context.sqlite.prepare("SELECT revoked_at FROM visit_teacher_sessions WHERE token_hash=?")
      .get(previous[0].identity.tokenHash).revoked_at, null);
  }
});

test("credential lock blocks only new login, while established session remains usable", async () => {
  const context = await database();
  const issued = await issuedCredential(context);
  const loginId = context.sqlite.prepare("SELECT login_id FROM visit_teacher_credentials").get().login_id;
  const session = await auth.createVisitTeacherSession(context.db, request(), { loginId, code: issued.code });
  context.sqlite.prepare("UPDATE visit_teacher_credentials SET locked_until='2999-01-01T00:00:00.000Z'").run();
  assert.equal((await auth.requireVisitTeacherSession(context.db, request("203.0.113.10", session.token))).teacherUserId, "USR-T1");
  const booking = await store.createVisitBooking(context.db, session.identity, {
    requestId: commandId(), date: futureWeekday(), startTime: "09:00", endTime: "09:20",
    classYearId: null, purpose: null,
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
  for (const row of result.issued) assert.doesNotMatch(stored, new RegExp(row.code.replace("-", ""), "iu"));

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
  assert.match(api, /isSameOriginRequest\(request\)/u);
  assert.match(api, /expected\.every\(\(key\) => keys\.includes\(key\)\)/u);
  assert.match(api, /\^\[0-9a-f\]\{8\}/u);
  for (const route of routes) {
    assert.match(route, /exactBodyKeys/u);
    assert.match(route, /validRequestId/u);
  }
  const scheduleApi = await readFile(new URL("../lib/visit-schedule-api.ts", import.meta.url), "utf8");
  assert.match(scheduleApi, /"Cache-Control": "private, no-store"/u);
});
