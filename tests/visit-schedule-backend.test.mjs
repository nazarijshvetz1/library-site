import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const validation = await import("../lib/visit-schedule-validation.ts");
const portalValidation = await import("../lib/visit-portal-validation.ts");
const store = await import("../lib/visit-schedule-store.ts");

class PreparedStatement {
  constructor(database, sql, bindings = []) { this.database = database; this.sql = sql; this.bindings = bindings; }
  bind(...values) { return new PreparedStatement(this.database, this.sql, values); }
  async first() { return this.database.sqlite.prepare(this.sql).get(...this.bindings) ?? null; }
  async all() { return { success: true, results: this.database.sqlite.prepare(this.sql).all(...this.bindings) }; }
  execute() { return { success: true, results: this.database.sqlite.prepare(this.sql).all(...this.bindings) }; }
}

class TestD1 {
  constructor(sqlite) { this.sqlite = sqlite; this.beforeBatch = null; }
  prepare(sql) { return new PreparedStatement(this, sql); }
  async batch(statements) {
    if (this.beforeBatch) { const hook = this.beforeBatch; this.beforeBatch = null; await hook(); }
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

async function visitDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
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
  ]) sqlite.exec(await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  const now = new Date().toISOString();
  sqlite.prepare(`INSERT INTO users
    (id, full_name, sort_name, email, auth_user_id, role, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
    .run("USR-TEACHER", "Учитель", "Учитель", "teacher@example.test", "auth-teacher", "teacher", now, now);
  sqlite.prepare(`INSERT INTO users
    (id, full_name, sort_name, email, auth_user_id, role, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
    .run("USR-LIB", "Бібліотекар", "Бібліотекар", "library@example.test", "auth-library", "librarian", now, now);
  sqlite.prepare(`INSERT INTO teacher_profiles(
    teacher_user_id,subject_position,primary_location_id,service_contact,librarian_note,version,
    last_mutation_request_id,closed_at,closed_by_user_id,created_by_user_id,updated_by_user_id,created_at,updated_at
  ) VALUES(?, '', NULL, '', '', 1, NULL, NULL, NULL, 'USR-LIB', 'USR-LIB', ?, ?)`)
    .run("USR-TEACHER", now, now);
  sqlite.prepare(`INSERT INTO visit_teacher_credentials (
    teacher_user_id, login_id, code_hmac, status, version, failed_attempts,
    locked_until, last_login_at, code_rotated_at, created_by_user_id,
    updated_by_user_id, created_at, updated_at
  ) VALUES ('USR-TEACHER','opaque-teacher-login-001',?,'active',1,0,NULL,NULL,?,
    'USR-LIB','USR-LIB',?,?)`).run("a".repeat(64), now, now, now);
  sqlite.prepare(`INSERT INTO visit_teacher_sessions (
    token_hash, teacher_user_id, credential_version, pending_scope, ip_scope_hash,
    expires_at, last_seen_at, revoked_at, created_at
  ) VALUES (?, 'USR-TEACHER', 1, 'pending-scope-teacher-001', ?,
    '2999-01-01T00:00:00.000Z', ?, NULL, ?)`)
    .run("b".repeat(64), "c".repeat(64), now, now);
  return { sqlite, db: new TestD1(sqlite) };
}

function teacherIdentity(overrides = {}) {
  return {
    teacherUserId: "USR-TEACHER",
    fullName: "Учитель",
    credentialVersion: 1,
    tokenHash: "b".repeat(64),
    pendingScope: "pending-scope-teacher-001",
    expiresAt: "2999-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function futureWeekday() {
  const today = validation.kyivToday();
  for (let offset = 1; offset <= 7; offset += 1) {
    const date = validation.addDays(today, offset);
    if (validation.isoWeekday(date) <= 5) return date;
  }
  throw new Error("weekday missing");
}

function bookingInput(requestId, date = futureWeekday()) {
  return { requestId, date, startTime: "09:00", endTime: "09:20", surname: "Шевченко", publicDisplayConsent: true, classYearId: null, purpose: null };
}

test("visit validators enforce 5-minute grid, duration, control characters and exact fields", () => {
  const valid = validation.validateVisitBookingCreateInput({
    requestId: "11111111-1111-4111-8111-111111111111",
    date: "2026-09-01", startTime: "09:00", endTime: "09:20",
    surname: "Шевченко", publicDisplayConsent: true, classYearId: null, purpose: null,
  });
  assert.equal(valid.ok, true);
  const missingConsent = validation.validateVisitBookingCreateInput({
    requestId: "11111111-1111-4111-8111-111111111111",
    date: "2026-09-01", startTime: "09:00", endTime: "09:20",
    classYearId: null, purpose: null,
  });
  assert.equal(missingConsent.ok, false);
  assert.ok(missingConsent.fieldErrors.publicDisplayConsent);
  assert.equal(validation.validateVisitBookingCreateInput({
    requestId: "11111111-1111-4111-8111-111111111111",
    date: "2026-09-01", startTime: "09:00", endTime: "09:20",
    publicDisplayConsent: false, classYearId: null, purpose: null,
  }).ok, false);

  const misalignedClosure = validation.validateVisitClosureCreateInput({
    requestId: "22222222-2222-4222-8222-222222222222",
    date: "2026-09-01", startTime: "09:03", endTime: "09:23", reason: "Нарада",
  });
  assert.equal(misalignedClosure.ok, false);
  assert.match(misalignedClosure.fieldErrors.startTime, /5/);
  assert.match(misalignedClosure.fieldErrors.endTime, /5/);

  const controls = validation.validateVisitBookingCreateInput({
    requestId: "33333333-3333-4333-8333-333333333333",
    date: "2026-09-01", startTime: "09:00", endTime: "09:20",
    surname: "Шев\nченко", publicDisplayConsent: true, classYearId: null, purpose: null,
  });
  assert.equal(controls.ok, false);
  assert.ok(controls.fieldErrors.surname);
});

test("guest and portal validators require exact versioned mutation bodies", () => {
  const guest = {
    requestId: "16161616-1616-4616-8616-161616161616",
    teacherRef: "a".repeat(64), date: "2026-09-01", startTime: "09:00", endTime: "09:20",
    publicDisplayConsent: true, classYearId: null, purpose: null,
  };
  assert.equal(portalValidation.validateGuestVisitCreateInput(guest).ok, true);
  assert.equal(portalValidation.validateGuestVisitCreateInput({ ...guest, surname: "Injected" }).ok, false);
  assert.equal(portalValidation.validateGuestVisitCreateInput(
    Object.fromEntries(Object.entries(guest).filter(([key]) => key !== "purpose")),
  ).ok, false);
  const update = {
    requestId: "17171717-1717-4717-8717-171717171717", expectedVersion: 3,
    date: "2026-09-01", startTime: "10:00", endTime: "10:20",
    publicDisplayConsent: true, classYearId: null, purpose: null,
  };
  assert.equal(portalValidation.validateVisitBookingUpdateInput(update).ok, true);
  assert.equal(portalValidation.validateVisitBookingUpdateInput({ ...update, expectedVersion: 0 }).ok, false);
  assert.equal(portalValidation.validateVisitBookingUpdateInput({ ...update, ownerId: "USR-X" }).ok, false);
  assert.equal(portalValidation.validateGuestVisitCancelInput({
    requestId: "18181818-1818-4818-8818-181818181818", expectedVersion: 1, reason: null,
  }).ok, true);
});

test("public and teacher visit ranges stay inside the booking horizon", () => {
  assert.deepEqual(
    validation.parseVisitRange(new URL("https://example.test/api?from=2026-08-12&to=2026-11-10"), "2026-08-12"),
    { from: "2026-08-12", to: "2026-11-10" },
  );
  assert.throws(
    () => validation.parseVisitRange(new URL("https://example.test/api?from=2026-08-11&to=2026-08-20"), "2026-08-12"),
    /90/,
  );
  assert.throws(
    () => validation.parseVisitRange(new URL("https://example.test/api?from=2030-01-01&to=2030-01-07"), "2026-08-12"),
    /90/,
  );
});

test("shared segment-claim schema is the atomic booking-versus-closure race guard", async () => {
  const sql = await readFile(new URL("../drizzle/0006_pale_sauron.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE `visit_slot_claims`/);
  assert.match(sql, /`segment_key` text PRIMARY KEY NOT NULL/);
  assert.match(sql, /`booking_id` text/);
  assert.match(sql, /`closure_id` text/);
  assert.match(sql, /visit_slot_claims_exactly_one_owner/);
  assert.match(sql, /between 0 and 23/);
  assert.match(sql, /% 5 = 0/);
  assert.match(sql, /substr\("visit_slot_claims"\."segment_key", 1, 10\) glob/);
  assert.doesNotMatch(sql, /T\[0-9\]\[0-9\]:\[0-5\]\[0-9\]/);
});

test("visit slot-claim migration preserves rows with foreign keys enabled", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const file of [
    "0000_librarian_drafts.sql", "0001_draft_workflow.sql", "0002_remove_legacy_audit_triggers.sql",
    "0003_odd_the_order.sql", "0004_staging_import_runs.sql", "0005_young_night_nurse.sql",
    "0006_pale_sauron.sql",
  ]) sqlite.exec(await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  const now = new Date().toISOString();
  sqlite.prepare(`INSERT INTO visit_bookings (
    id, owner_auth_user_id, owner_email, surname, visit_date, start_time, end_time,
    purpose, status, cancel_reason, version, created_at, updated_at
  ) VALUES ('VIS-UPGRADE', 'auth-upgrade', 'upgrade@example.test', 'Тестовий',
    '2026-09-01', '09:00', '09:20', '', 'active', '', 1, ?, ?)`)
    .run(now, now);
  sqlite.prepare(`INSERT INTO visit_slot_claims
    (segment_key, booking_id, closure_id, created_at)
    VALUES ('2026-09-01T09:00', 'VIS-UPGRADE', NULL, ?)`)
    .run(now);
  const migration = await readFile(new URL("../drizzle/0007_cold_whiplash.sql", import.meta.url), "utf8");
  assert.doesNotMatch(migration, /PRAGMA foreign_keys\s*=\s*OFF/i);
  sqlite.exec(migration);
  assert.equal(sqlite.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(sqlite.prepare("SELECT booking_id FROM visit_slot_claims WHERE segment_key='2026-09-01T09:00'").get().booking_id, "VIS-UPGRADE");
  assert.throws(() => sqlite.prepare(`INSERT INTO visit_slot_claims
    (segment_key, booking_id, closure_id, created_at)
    VALUES ('2026-09-01X09:05', 'VIS-UPGRADE', NULL, ?)`)
    .run(now), /visit_slot_claims_key_valid/);
});

test("teacher-code migration preserves bookings and claims with foreign keys enabled", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const file of [
    "0000_librarian_drafts.sql", "0001_draft_workflow.sql", "0002_remove_legacy_audit_triggers.sql",
    "0003_odd_the_order.sql", "0004_staging_import_runs.sql", "0005_young_night_nurse.sql",
    "0006_pale_sauron.sql", "0007_cold_whiplash.sql",
  ]) sqlite.exec(await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  const now = new Date().toISOString();
  for (const user of [
    ["USR-MIG", "Migration Teacher", "auth-owner@example.test", "auth-migration"],
    ["USR-CONFLICT", "Email Conflict", "email-conflict@example.test", "auth-conflict"],
    ["USR-FALLBACK", "Email Fallback", "fallback@example.test", "auth-fallback"],
  ]) sqlite.prepare(`INSERT INTO users
    (id, full_name, sort_name, email, auth_user_id, role, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'teacher', 'active', ?, ?)`)
    .run(user[0], user[1], user[1].toLowerCase(), user[2], user[3], now, now);
  sqlite.prepare(`INSERT INTO visit_bookings (
    id, owner_auth_user_id, owner_email, surname, visit_date, start_time, end_time,
    purpose, status, cancel_reason, version, created_at, updated_at
  ) VALUES ('VIS-MIG', 'auth-migration', 'email-conflict@example.test', 'Migration Teacher',
    '2026-09-01', '09:00', '09:20', '', 'active', '', 1, ?, ?)` ).run(now, now);
  sqlite.prepare(`INSERT INTO visit_bookings (
    id, owner_auth_user_id, owner_email, surname, visit_date, start_time, end_time,
    purpose, status, cancel_reason, cancelled_by_auth_user_id, version, created_at, updated_at, cancelled_at
  ) VALUES ('VIS-FALLBACK', 'missing-auth', 'fallback@example.test', 'Email Fallback',
    '2026-09-02', '10:00', '10:20', '', 'cancelled', 'legacy', 'legacy-canceller', 2, ?, ?, ?)`)
    .run(now, now, now);
  sqlite.prepare(`INSERT INTO visit_bookings (
    id, owner_auth_user_id, owner_email, surname, visit_date, start_time, end_time,
    purpose, status, cancel_reason, version, created_at, updated_at
  ) VALUES ('VIS-UNMATCHED', 'missing-auth-2', 'missing@example.test', 'Unmatched Teacher',
    '2026-09-03', '11:00', '11:20', '', 'active', '', 1, ?, ?)` ).run(now, now);
  sqlite.prepare(`INSERT INTO visit_slot_claims(segment_key, booking_id, closure_id, created_at)
    VALUES ('2026-09-01T09:00','VIS-MIG',NULL,?)`).run(now);
  sqlite.prepare(`INSERT INTO visit_slot_claims(segment_key, booking_id, closure_id, created_at)
    VALUES ('2026-09-03T11:00','VIS-UNMATCHED',NULL,?)`).run(now);
  const migration = await readFile(new URL("../drizzle/0008_sudden_thunderbird.sql", import.meta.url), "utf8");
  assert.doesNotMatch(migration, /PRAGMA foreign_keys\s*=\s*OFF/iu);
  sqlite.exec(migration);
  assert.equal(sqlite.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM visit_bookings").get().n, 3);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM visit_slot_claims").get().n, 2);
  const authPreferred = sqlite.prepare(`SELECT owner_user_id,owner_auth_user_id,owner_email
    FROM visit_bookings WHERE id='VIS-MIG'`).get();
  assert.deepEqual({ ...authPreferred }, { owner_user_id: "USR-MIG", owner_auth_user_id: null, owner_email: null });
  const emailFallback = sqlite.prepare(`SELECT owner_user_id,owner_auth_user_id,owner_email,status
    FROM visit_bookings WHERE id='VIS-FALLBACK'`).get();
  assert.deepEqual({ ...emailFallback }, {
    owner_user_id: "USR-FALLBACK", owner_auth_user_id: null, owner_email: null, status: "cancelled",
  });
  const unmatched = sqlite.prepare(`SELECT owner_user_id,owner_auth_user_id,owner_email
    FROM visit_bookings WHERE id='VIS-UNMATCHED'`).get();
  assert.deepEqual({ ...unmatched }, {
    owner_user_id: null, owner_auth_user_id: "missing-auth-2", owner_email: "missing@example.test",
  });
  assert.deepEqual(
    sqlite.prepare("SELECT segment_key,booking_id FROM visit_slot_claims ORDER BY segment_key").all().map((row) => ({ ...row })),
    [
      { segment_key: "2026-09-01T09:00", booking_id: "VIS-MIG" },
      { segment_key: "2026-09-03T11:00", booking_id: "VIS-UNMATCHED" },
    ],
  );
});

test("portal migration preserves teacher and legacy bookings plus claims with foreign keys enabled", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const file of [
    "0000_librarian_drafts.sql", "0001_draft_workflow.sql", "0002_remove_legacy_audit_triggers.sql",
    "0003_odd_the_order.sql", "0004_staging_import_runs.sql", "0005_young_night_nurse.sql",
    "0006_pale_sauron.sql", "0007_cold_whiplash.sql", "0008_sudden_thunderbird.sql",
  ]) sqlite.exec(await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  const now = "2026-08-13T10:00:00.000Z";
  sqlite.prepare(`INSERT INTO users
    (id,full_name,sort_name,email,auth_user_id,role,status,created_at,updated_at)
    VALUES ('USR-PORTAL-MIG','Portal Teacher','portal teacher','portal@example.test',
      'auth-portal','teacher','active',?,?)`).run(now, now);
  sqlite.prepare(`INSERT INTO visit_bookings (
    id,owner_user_id,owner_auth_user_id,owner_email,surname,visit_date,start_time,end_time,
    purpose,status,cancel_reason,version,created_at,updated_at
  ) VALUES ('VIS-PORTAL-TEACHER','USR-PORTAL-MIG',NULL,NULL,'Portal Teacher',
      '2026-09-08','09:00','09:20','','active','',2,?,?)`).run(now, now);
  sqlite.prepare(`INSERT INTO visit_bookings (
    id,owner_user_id,owner_auth_user_id,owner_email,surname,visit_date,start_time,end_time,
    purpose,status,cancel_reason,version,created_at,updated_at
  ) VALUES ('VIS-PORTAL-LEGACY',NULL,'legacy-auth','legacy@example.test','Legacy Teacher',
      '2026-09-08','10:00','10:20','','active','',1,?,?)`).run(now, now);
  sqlite.prepare(`INSERT INTO visit_slot_claims(segment_key,booking_id,closure_id,created_at)
    VALUES ('2026-09-08T09:00','VIS-PORTAL-TEACHER',NULL,?),
      ('2026-09-08T10:00','VIS-PORTAL-LEGACY',NULL,?)`).run(now, now);

  const migration = await readFile(new URL("../drizzle/0009_happy_silver_samurai.sql", import.meta.url), "utf8");
  assert.doesNotMatch(migration, /PRAGMA foreign_keys\s*=\s*OFF/iu);
  sqlite.exec(migration);

  assert.equal(sqlite.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM visit_bookings").get().n, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM visit_slot_claims").get().n, 2);
  assert.deepEqual(
    sqlite.prepare(`SELECT id,owner_kind,owner_user_id,guest_owner_id,
      selected_teacher_user_id,last_mutation_request_id,version
      FROM visit_bookings ORDER BY id`).all().map((row) => ({ ...row })),
    [
      {
        id: "VIS-PORTAL-LEGACY", owner_kind: "legacy", owner_user_id: null,
        guest_owner_id: null, selected_teacher_user_id: null,
        last_mutation_request_id: null, version: 1,
      },
      {
        id: "VIS-PORTAL-TEACHER", owner_kind: "teacher", owner_user_id: "USR-PORTAL-MIG",
        guest_owner_id: null, selected_teacher_user_id: null,
        last_mutation_request_id: null, version: 2,
      },
    ],
  );
  assert.deepEqual(
    sqlite.prepare("SELECT segment_key,booking_id FROM visit_slot_claims ORDER BY segment_key").all()
      .map((row) => ({ ...row })),
    [
      { segment_key: "2026-09-08T09:00", booking_id: "VIS-PORTAL-TEACHER" },
      { segment_key: "2026-09-08T10:00", booking_id: "VIS-PORTAL-LEGACY" },
    ],
  );
});

test("visit audits verify persisted final state without relying on changes()", async () => {
  const source = await readFile(new URL("../lib/visit-schedule-store.ts", import.meta.url), "utf8");
  assert.match(source, /claimOwner:\s*"booking", expectedClaimCount: segments\.length/);
  assert.match(source, /claimOwner:\s*"closure", expectedClaimCount: segments\.length/);
  assert.match(source, /SELECT COUNT\(\*\) FROM visit_slot_claims WHERE \$\{ownerColumn\} = \?/);
  assert.match(source, /status = 'cancelled' AND version = \? AND cancelled_at = \?/);
  assert.match(source, /NOT EXISTS \(\s*SELECT 1 FROM visit_slot_claims WHERE \$\{ownerColumn\} = \?/);
  assert.doesNotMatch(source, /changes\(\)/);
});

test("visit migration rejects impossible local dates", async () => {
  const { sqlite } = await visitDatabase();
  const now = new Date().toISOString();
  assert.throws(() => sqlite.prepare(`
    INSERT INTO visit_bookings (
      id, owner_kind, owner_auth_user_id, owner_email, surname, visit_date, start_time, end_time,
      purpose, status, cancel_reason, version, created_at, updated_at
    ) VALUES (?, 'legacy', ?, ?, ?, ?, ?, ?, '', 'active', '', 1, ?, ?)
  `).run("VIS-BAD", "auth-teacher", "teacher@example.test", "Шевченко", "2026-02-30", "09:00", "09:20", now, now), /visit_bookings_date_valid/);
});

test("public-display consent migration keeps legacy bookings private with foreign keys enabled", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const file of [
    "0000_librarian_drafts.sql", "0001_draft_workflow.sql", "0002_remove_legacy_audit_triggers.sql",
    "0003_odd_the_order.sql", "0004_staging_import_runs.sql", "0005_young_night_nurse.sql",
    "0006_pale_sauron.sql", "0007_cold_whiplash.sql", "0008_sudden_thunderbird.sql",
    "0009_happy_silver_samurai.sql", "0010_shocking_cobalt_man.sql",
    "0011_normalize_holding_conditions.sql",
  ]) sqlite.exec(await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  const now = new Date().toISOString();
  sqlite.prepare(`INSERT INTO users
    (id,full_name,sort_name,email,auth_user_id,role,status,created_at,updated_at)
    VALUES ('USR-CONSENT-MIG','Legacy Teacher','legacy teacher','legacy@example.test','auth-legacy',
      'teacher','active',?,?)`).run(now, now);
  sqlite.prepare(`INSERT INTO visit_bookings (
    id,owner_kind,owner_user_id,surname,visit_date,start_time,end_time,purpose,status,cancel_reason,
    version,created_at,updated_at
  ) VALUES ('VIS-CONSENT-MIG','teacher','USR-CONSENT-MIG','Legacy Teacher','2026-09-01',
    '09:00','09:20','','active','',1,?,?)`).run(now, now);
  sqlite.prepare(`INSERT INTO visit_slot_claims(segment_key,booking_id,closure_id,created_at)
    VALUES ('2026-09-01T09:00','VIS-CONSENT-MIG',NULL,?)`).run(now);

  const migration = await readFile(new URL("../drizzle/0012_elite_victor_mancha.sql", import.meta.url), "utf8");
  assert.doesNotMatch(migration, /PRAGMA foreign_keys\s*=\s*OFF/iu);
  sqlite.exec(migration);

  assert.equal(sqlite.prepare("SELECT public_display_consent FROM visit_bookings WHERE id='VIS-CONSENT-MIG'").get().public_display_consent, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_slot_claims WHERE booking_id='VIS-CONSENT-MIG'").get().total, 1);
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  assert.throws(
    () => sqlite.prepare("UPDATE visit_bookings SET public_display_consent=2 WHERE id='VIS-CONSENT-MIG'").run(),
    /visit_bookings\.public_display_consent|CHECK constraint failed/iu,
  );
});

test("visit routes keep public payload PII-free and protect teacher writes", async () => {
  const [publicRoute, teacherRoute, cancelRoute, store, api] = await Promise.all([
    readFile(new URL("../app/api/visits/public/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/visits/teacher/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/visits/teacher/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/visit-schedule-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/visit-schedule-api.ts", import.meta.url), "utf8"),
  ]);
  assert.match(publicRoute, /Access-Control-Allow-Origin.*\*/s);
  assert.doesNotMatch(publicRoute, /surname|ownerEmail|classLabel|purpose/);
  assert.match(teacherRoute, /requireVisitTeacherSession/);
  assert.match(teacherRoute, /isSameOriginRequest\(request\)/);
  assert.match(teacherRoute, /readVisitJson/);
  assert.match(cancelRoute, /cancelOwnVisitBooking/);
  assert.match(cancelRoute, /isSameOriginRequest\(request\)/);
  assert.doesNotMatch(api, /VISIT_TEACHER_ALLOWED_EMAILS/);
  assert.match(store, /PRIMARY KEY|visit_slot_claims/);
  assert.match(store, /owner_user_id = \?/);
  assert.match(store, /request_id_conflict/);
  assert.match(store, /visit_time_elapsed/);
  assert.match(store, /LIMIT 3001/);
});

test("visit tables are reset in FK-safe order before users and class years", async () => {
  const runtime = await readFile(new URL("../lib/d1-import-runtime.ts", import.meta.url), "utf8");
  const slot = runtime.indexOf('"visit_slot_claims"');
  const bookings = runtime.indexOf('"visit_bookings"');
  const closures = runtime.indexOf('"visit_schedule_closures"');
  const hours = runtime.indexOf('"visit_schedule_hours"');
  const classes = runtime.indexOf('"class_years"');
  const users = runtime.indexOf('"users"');
  assert.ok(slot >= 0 && bookings > slot && closures > bookings && hours > closures);
  assert.ok(classes > hours && users > classes);
});

test("atomic segment claims reject overlapping booking and closure without partial writes", async () => {
  const { sqlite, db } = await visitDatabase();
  const teacher = teacherIdentity();
  const librarian = { userId: "auth-library", email: "library@example.test", displayName: "Library", fullName: null };
  const date = futureWeekday();
  const first = await store.createVisitBooking(db, teacher, bookingInput("44444444-4444-4444-8444-444444444444", date));
  await assert.rejects(
    store.createVisitClosure(db, librarian, {
      requestId: "55555555-5555-4555-8555-555555555555", date,
      startTime: "09:00", endTime: "09:20", reason: "Нарада",
    }),
    (error) => error instanceof store.VisitScheduleError && error.code === "slot_unavailable",
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_bookings WHERE status='active'").get().total, 1);
  assert.deepEqual({ ...sqlite.prepare(
    "SELECT owner_kind,owner_user_id,guest_owner_id FROM visit_bookings WHERE id=?",
  ).get(first.id) }, { owner_kind: "teacher", owner_user_id: teacher.teacherUserId, guest_owner_id: null });
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_schedule_closures").get().total, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_slot_claims WHERE booking_id=?").get(first.id).total, 4);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_mutation_commands").get().total, 1);
});

test("directory teacher deactivation between authorization and batch rolls back completely", async () => {
  const { sqlite, db } = await visitDatabase();
  const teacher = teacherIdentity();
  db.beforeBatch = () => sqlite.prepare("UPDATE users SET status='inactive' WHERE id='USR-TEACHER'").run();
  await assert.rejects(
    store.createVisitBooking(db, teacher, bookingInput("66666666-6666-4666-8666-666666666666")),
    (error) => error instanceof store.VisitScheduleError && error.code === "teacher_access_revoked",
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_bookings").get().total, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_slot_claims").get().total, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_mutation_commands").get().total, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM audit_events WHERE entity_type='visit_booking'").get().total, 0);
});

test("booking request id replays once and rejects a changed payload", async () => {
  const { sqlite, db } = await visitDatabase();
  const teacher = teacherIdentity();
  const input = bookingInput("77777777-7777-4777-8777-777777777777");
  const first = await store.createVisitBooking(db, teacher, input);
  const replay = await store.createVisitBooking(db, teacher, input);
  assert.deepEqual(replay, first);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_bookings").get().total, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM audit_events WHERE entity_type='visit_booking'").get().total, 1);
  await assert.rejects(
    store.createVisitBooking(db, teacher, { ...input, purpose: "Інше" }),
    (error) => error instanceof store.VisitScheduleError && error.code === "request_id_conflict",
  );
});

test("authenticated teacher reschedule moves claims atomically and rejects a concurrent overlap", async () => {
  const { sqlite, db } = await visitDatabase();
  const teacher = teacherIdentity();
  const date = futureWeekday();
  const created = await store.createVisitBooking(
    db, teacher, bookingInput("13131313-1313-4313-8313-131313131313", date),
  );
  const moved = await store.updateOwnVisitBooking(db, teacher, created.id, {
    requestId: "14141414-1414-4414-8414-141414141414", expectedVersion: 1,
    date, startTime: "10:00", endTime: "10:20", publicDisplayConsent: true, classYearId: null, purpose: "Moved",
  });
  assert.equal(moved.version, 2);
  assert.deepEqual(sqlite.prepare(
    "SELECT segment_key FROM visit_slot_claims WHERE booking_id=? ORDER BY segment_key",
  ).all(created.id).map((row) => row.segment_key), [
    `${date}T10:00`, `${date}T10:05`, `${date}T10:10`, `${date}T10:15`,
  ]);
  assert.deepEqual(await store.updateOwnVisitBooking(db, teacher, created.id, {
    requestId: "14141414-1414-4414-8414-141414141414", expectedVersion: 1,
    date, startTime: "10:00", endTime: "10:20", publicDisplayConsent: true, classYearId: null, purpose: "Moved",
  }), moved);

  const oldClaims = sqlite.prepare(
    "SELECT segment_key FROM visit_slot_claims WHERE booking_id=? ORDER BY segment_key",
  ).all(created.id).map((row) => row.segment_key);
  db.beforeBatch = () => {
    const now = new Date().toISOString();
    sqlite.prepare(`INSERT INTO visit_schedule_closures (
      id,visit_date,start_time,end_time,status,reason,created_by_user_id,cancelled_by_user_id,
      version,created_at,updated_at,cancelled_at
    ) VALUES ('CLO-TEACHER-RACE',?,'11:00','11:20','active','','USR-LIB',NULL,1,?,?,NULL)`)
      .run(date, now, now);
    sqlite.prepare(`INSERT INTO visit_slot_claims(segment_key,booking_id,closure_id,created_at)
      VALUES (?,NULL,'CLO-TEACHER-RACE',?)`).run(`${date}T11:00`, now);
  };
  await assert.rejects(
    () => store.updateOwnVisitBooking(db, teacher, created.id, {
      requestId: "15151515-1515-4515-8515-151515151515", expectedVersion: 2,
      date, startTime: "11:00", endTime: "11:20", publicDisplayConsent: true, classYearId: null, purpose: null,
    }),
    (error) => error.code === "slot_unavailable",
  );
  assert.deepEqual(sqlite.prepare(
    "SELECT segment_key FROM visit_slot_claims WHERE booking_id=? ORDER BY segment_key",
  ).all(created.id).map((row) => row.segment_key), oldClaims);
  assert.deepEqual({ ...sqlite.prepare(
    "SELECT start_time,end_time,version,last_mutation_request_id FROM visit_bookings WHERE id=?",
  ).get(created.id) }, {
    start_time: "10:00", end_time: "10:20", version: 2,
    last_mutation_request_id: "14141414-1414-4414-8414-141414141414",
  });
});

test("owner isolation, cancellation claim release and rebooking are atomic", async () => {
  const { sqlite, db } = await visitDatabase();
  const teacher = teacherIdentity();
  const stranger = teacherIdentity({ teacherUserId: "USR-STRANGER", tokenHash: "d".repeat(64) });
  const date = futureWeekday();
  const first = await store.createVisitBooking(db, teacher, bookingInput("88888888-8888-4888-8888-888888888888", date));
  await assert.rejects(
    store.cancelOwnVisitBooking(db, stranger, first.id, {
      requestId: "99999999-9999-4999-8999-999999999999", expectedVersion: 1, reason: null,
    }),
    (error) => error instanceof store.VisitScheduleError && error.code === "booking_not_found",
  );
  const cancelled = await store.cancelOwnVisitBooking(db, teacher, first.id, {
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", expectedVersion: 1, reason: null,
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_slot_claims").get().total, 0);
  const second = await store.createVisitBooking(db, teacher, bookingInput("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", date));
  assert.notEqual(second.id, first.id);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_slot_claims WHERE booking_id=?").get(second.id).total, 4);
});

test("teacher and librarian revocation during cancellation roll back every write", async () => {
  const { sqlite, db } = await visitDatabase();
  const teacher = teacherIdentity();
  const librarian = { userId: "auth-library", email: "library@example.test", displayName: "Library", fullName: null };
  const first = await store.createVisitBooking(db, teacher, bookingInput("dddddddd-dddd-4ddd-8ddd-dddddddddddd"));
  db.beforeBatch = () => sqlite.prepare("UPDATE users SET status='inactive' WHERE id='USR-TEACHER'").run();
  await assert.rejects(
    store.cancelOwnVisitBooking(db, teacher, first.id, {
      requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", expectedVersion: 1, reason: null,
    }),
    (error) => error instanceof store.VisitScheduleError && error.code === "teacher_access_revoked",
  );
  let row = sqlite.prepare("SELECT status, version FROM visit_bookings WHERE id=?").get(first.id);
  assert.equal(row.status, "active");
  assert.equal(row.version, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_slot_claims WHERE booking_id=?").get(first.id).total, 4);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_mutation_commands").get().total, 1);

  sqlite.prepare("UPDATE users SET status='active' WHERE id='USR-TEACHER'").run();
  db.beforeBatch = () => sqlite.prepare("UPDATE users SET status='inactive' WHERE id='USR-LIB'").run();
  await assert.rejects(
    store.cancelAdminVisitBooking(db, librarian, first.id, {
      requestId: "ffffffff-ffff-4fff-8fff-ffffffffffff", expectedVersion: 1, reason: "Скасовано",
    }),
    (error) => error instanceof store.VisitScheduleError && error.code === "actor_not_mapped",
  );
  row = sqlite.prepare("SELECT status, version FROM visit_bookings WHERE id=?").get(first.id);
  assert.equal(row.status, "active");
  assert.equal(row.version, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_slot_claims WHERE booking_id=?").get(first.id).total, 4);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_mutation_commands").get().total, 1);
});

test("public schedule exposes only consented verified names alongside generic busy intervals", async () => {
  const { db } = await visitDatabase();
  const teacher = teacherIdentity();
  const date = futureWeekday();
  await store.createVisitBooking(db, teacher, {
    ...bookingInput("cccccccc-cccc-4ccc-8ccc-cccccccccccc", date), purpose: "Приватна мета",
  });
  const schedule = await store.readVisitSchedule(db, { from: date, to: date });
  assert.deepEqual(schedule.busy, [{ date, startTime: "09:00", endTime: "09:20", status: "busy" }]);
  assert.deepEqual(schedule.publicBookings, [{
    date, startTime: "09:00", endTime: "09:20", displayName: "Учитель", identityVerified: true,
  }]);
  assert.equal("bookings" in schedule, false);
  assert.doesNotMatch(JSON.stringify(schedule), /Шевченко|Приватна мета|teacher@example|VIS-|classLabel|purpose/);
});

test("public schedule never attributes an unverified guest booking to the selected teacher", async () => {
  const { sqlite, db } = await visitDatabase();
  const date = futureWeekday();
  const now = new Date().toISOString();
  sqlite.prepare(`INSERT INTO visit_guest_sessions (
    id,token_hash,pending_scope,ip_scope_hash,expires_at,last_seen_at,revoked_at,created_at
  ) VALUES ('GUEST-PUBLIC',?,?,?,'2999-01-01T00:00:00.000Z',?,NULL,?)`)
    .run("d".repeat(64), "guest-public-scope", "e".repeat(64), now, now);
  sqlite.prepare(`INSERT INTO visit_bookings (
    id,owner_kind,guest_owner_id,selected_teacher_user_id,surname,visit_date,start_time,end_time,
    public_display_consent,purpose,status,cancel_reason,version,created_at,updated_at
  ) VALUES ('VIS-GUEST-PUBLIC','guest','GUEST-PUBLIC','USR-TEACHER','Учитель',?,'09:00','09:20',
    1,'Приватна мета','active','',1,?,?)`).run(date, now, now);

  const schedule = await store.readVisitSchedule(db, { from: date, to: date });
  assert.deepEqual(schedule.publicBookings, [{
    date,
    startTime: "09:00",
    endTime: "09:20",
    displayName: "Непідтверджений гостьовий запис",
    identityVerified: false,
  }]);
  assert.doesNotMatch(JSON.stringify(schedule.publicBookings), /Учитель|Приватна мета|GUEST|VIS-/u);
});

test("teacher list omits elapsed visits and teacher cannot cancel visit history", async () => {
  const { sqlite, db } = await visitDatabase();
  const teacher = teacherIdentity();
  const localNow = validation.kyivLocalNow();
  const createdAt = new Date().toISOString();
  sqlite.prepare(`INSERT INTO visit_bookings (
    id, owner_user_id, surname, visit_date, start_time, end_time,
    purpose, status, cancel_reason, version, created_at, updated_at
  ) VALUES ('VIS-PAST', ?, 'Учитель', ?, '00:00', '00:20', '', 'active', '', 1, ?, ?)`)
    .run(teacher.teacherUserId, localNow.date, createdAt, createdAt);
  for (const time of ["00:00", "00:05", "00:10", "00:15"]) {
    sqlite.prepare("INSERT INTO visit_slot_claims(segment_key, booking_id, closure_id, created_at) VALUES (?, 'VIS-PAST', NULL, ?)")
      .run(`${localNow.date}T${time}`, createdAt);
  }
  const own = await store.readVisitSchedule(db, { from: localNow.date, to: localNow.date }, {
    ownerUserId: teacher.teacherUserId, status: "active", futureOnly: localNow,
  });
  assert.deepEqual(own.bookings, []);
  await assert.rejects(
    store.cancelOwnVisitBooking(db, teacher, "VIS-PAST", {
      requestId: "12121212-1212-4212-8212-121212121212", expectedVersion: 1, reason: null,
    }),
    (error) => error instanceof store.VisitScheduleError && error.code === "booking_not_cancellable",
  );
  assert.equal(sqlite.prepare("SELECT status FROM visit_bookings WHERE id='VIS-PAST'").get().status, "active");
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_slot_claims WHERE booking_id='VIS-PAST'").get().total, 4);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_mutation_commands WHERE id='12121212-1212-4212-8212-121212121212'").get().total, 0);
});
