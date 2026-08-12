import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const validation = await import("../lib/visit-schedule-validation.ts");
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
    "0006_pale_sauron.sql",
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
  return { sqlite, db: new TestD1(sqlite) };
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
  return { requestId, date, startTime: "09:00", endTime: "09:20", surname: "Шевченко", classYearId: null, purpose: null };
}

test("visit validators enforce 5-minute grid, duration, control characters and exact fields", () => {
  const valid = validation.validateVisitBookingCreateInput({
    requestId: "11111111-1111-4111-8111-111111111111",
    date: "2026-09-01", startTime: "09:00", endTime: "09:20",
    surname: "Шевченко", classYearId: null, purpose: null,
  });
  assert.equal(valid.ok, true);

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
    surname: "Шев\nченко", classYearId: null, purpose: null,
  });
  assert.equal(controls.ok, false);
  assert.ok(controls.fieldErrors.surname);
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
});

test("visit migration rejects impossible local dates", async () => {
  const { sqlite } = await visitDatabase();
  const now = new Date().toISOString();
  assert.throws(() => sqlite.prepare(`
    INSERT INTO visit_bookings (
      id, owner_auth_user_id, owner_email, surname, visit_date, start_time, end_time,
      purpose, status, cancel_reason, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '', 'active', '', 1, ?, ?)
  `).run("VIS-BAD", "auth-teacher", "teacher@example.test", "Шевченко", "2026-02-30", "09:00", "09:20", now, now), /visit_bookings_date_valid/);
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
  assert.match(teacherRoute, /authorizeTeacher/);
  assert.match(teacherRoute, /readVisitJson/);
  assert.match(cancelRoute, /cancelOwnVisitBooking/);
  assert.match(api, /VISIT_TEACHER_ALLOWED_EMAILS/);
  assert.match(api, /role = 'teacher'/);
  assert.match(api, /isSameOriginRequest/);
  assert.match(store, /PRIMARY KEY|visit_slot_claims/);
  assert.match(store, /owner_auth_user_id = \?/);
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
  const teacher = { userId: "auth-teacher", email: "teacher@example.test", displayName: "Teacher", fullName: null };
  const librarian = { userId: "auth-library", email: "library@example.test", displayName: "Library", fullName: null };
  const date = futureWeekday();
  const first = await store.createVisitBooking(db, teacher, bookingInput("44444444-4444-4444-8444-444444444444", date), "directory");
  await assert.rejects(
    store.createVisitClosure(db, librarian, {
      requestId: "55555555-5555-4555-8555-555555555555", date,
      startTime: "09:00", endTime: "09:20", reason: "Нарада",
    }),
    (error) => error instanceof store.VisitScheduleError && error.code === "slot_unavailable",
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_bookings WHERE status='active'").get().total, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_schedule_closures").get().total, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_slot_claims WHERE booking_id=?").get(first.id).total, 4);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_mutation_commands").get().total, 1);
});

test("directory teacher deactivation between authorization and batch rolls back completely", async () => {
  const { sqlite, db } = await visitDatabase();
  const teacher = { userId: "auth-teacher", email: "teacher@example.test", displayName: "Teacher", fullName: null };
  db.beforeBatch = () => sqlite.prepare("UPDATE users SET status='inactive' WHERE id='USR-TEACHER'").run();
  await assert.rejects(
    store.createVisitBooking(db, teacher, bookingInput("66666666-6666-4666-8666-666666666666"), "directory"),
    (error) => error instanceof store.VisitScheduleError && error.code === "teacher_access_denied",
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_bookings").get().total, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_slot_claims").get().total, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_mutation_commands").get().total, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM audit_events WHERE entity_type='visit_booking'").get().total, 0);
});

test("booking request id replays once and rejects a changed payload", async () => {
  const { sqlite, db } = await visitDatabase();
  const teacher = { userId: "auth-teacher", email: "teacher@example.test", displayName: "Teacher", fullName: null };
  const input = bookingInput("77777777-7777-4777-8777-777777777777");
  const first = await store.createVisitBooking(db, teacher, input, "directory");
  const replay = await store.createVisitBooking(db, teacher, input, "directory");
  assert.deepEqual(replay, first);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_bookings").get().total, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM audit_events WHERE entity_type='visit_booking'").get().total, 1);
  await assert.rejects(
    store.createVisitBooking(db, teacher, { ...input, surname: "Інше" }, "directory"),
    (error) => error instanceof store.VisitScheduleError && error.code === "request_id_conflict",
  );
});

test("owner isolation, cancellation claim release and rebooking are atomic", async () => {
  const { sqlite, db } = await visitDatabase();
  const teacher = { userId: "auth-teacher", email: "teacher@example.test", displayName: "Teacher", fullName: null };
  const stranger = { userId: "auth-stranger", email: "stranger@example.test", displayName: "Stranger", fullName: null };
  const date = futureWeekday();
  const first = await store.createVisitBooking(db, teacher, bookingInput("88888888-8888-4888-8888-888888888888", date), "directory");
  await assert.rejects(
    store.cancelOwnVisitBooking(db, stranger, first.id, {
      requestId: "99999999-9999-4999-8999-999999999999", expectedVersion: 1, reason: null,
    }, "allowlist"),
    (error) => error instanceof store.VisitScheduleError && error.code === "booking_not_found",
  );
  const cancelled = await store.cancelOwnVisitBooking(db, teacher, first.id, {
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", expectedVersion: 1, reason: null,
  }, "directory");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_slot_claims").get().total, 0);
  const second = await store.createVisitBooking(db, teacher, bookingInput("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", date), "directory");
  assert.notEqual(second.id, first.id);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_slot_claims WHERE booking_id=?").get(second.id).total, 4);
});

test("teacher and librarian revocation during cancellation roll back every write", async () => {
  const { sqlite, db } = await visitDatabase();
  const teacher = { userId: "auth-teacher", email: "teacher@example.test", displayName: "Teacher", fullName: null };
  const librarian = { userId: "auth-library", email: "library@example.test", displayName: "Library", fullName: null };
  const first = await store.createVisitBooking(db, teacher, bookingInput("dddddddd-dddd-4ddd-8ddd-dddddddddddd"), "directory");
  db.beforeBatch = () => sqlite.prepare("UPDATE users SET status='inactive' WHERE id='USR-TEACHER'").run();
  await assert.rejects(
    store.cancelOwnVisitBooking(db, teacher, first.id, {
      requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", expectedVersion: 1, reason: null,
    }, "directory"),
    (error) => error instanceof store.VisitScheduleError && error.code === "teacher_access_denied",
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

test("public schedule projection contains generic busy intervals without private booking fields", async () => {
  const { db } = await visitDatabase();
  const teacher = { userId: "auth-teacher", email: "teacher@example.test", displayName: "Teacher", fullName: null };
  const date = futureWeekday();
  await store.createVisitBooking(db, teacher, {
    ...bookingInput("cccccccc-cccc-4ccc-8ccc-cccccccccccc", date), purpose: "Приватна мета",
  }, "directory");
  const schedule = await store.readVisitSchedule(db, { from: date, to: date });
  assert.deepEqual(schedule.busy, [{ date, startTime: "09:00", endTime: "09:20", status: "busy" }]);
  assert.equal("bookings" in schedule, false);
  assert.doesNotMatch(JSON.stringify(schedule), /Шевченко|Приватна мета|teacher@example|VIS-/);
});

test("teacher list omits elapsed visits and teacher cannot cancel visit history", async () => {
  const { sqlite, db } = await visitDatabase();
  const teacher = { userId: "auth-teacher", email: "teacher@example.test", displayName: "Teacher", fullName: null };
  const localNow = validation.kyivLocalNow();
  const createdAt = new Date().toISOString();
  sqlite.prepare(`INSERT INTO visit_bookings (
    id, owner_auth_user_id, owner_email, surname, visit_date, start_time, end_time,
    purpose, status, cancel_reason, version, created_at, updated_at
  ) VALUES ('VIS-PAST', ?, ?, 'Шевченко', ?, '00:00', '00:20', '', 'active', '', 1, ?, ?)`)
    .run(teacher.userId, teacher.email, localNow.date, createdAt, createdAt);
  for (const time of ["00:00", "00:05", "00:10", "00:15"]) {
    sqlite.prepare("INSERT INTO visit_slot_claims(segment_key, booking_id, closure_id, created_at) VALUES (?, 'VIS-PAST', NULL, ?)")
      .run(`${localNow.date}T${time}`, createdAt);
  }
  const own = await store.readVisitSchedule(db, { from: localNow.date, to: localNow.date }, {
    ownerAuthUserId: teacher.userId, status: "active", futureOnly: localNow,
  });
  assert.deepEqual(own.bookings, []);
  await assert.rejects(
    store.cancelOwnVisitBooking(db, teacher, "VIS-PAST", {
      requestId: "12121212-1212-4212-8212-121212121212", expectedVersion: 1, reason: null,
    }, "directory"),
    (error) => error instanceof store.VisitScheduleError && error.code === "booking_not_cancellable",
  );
  assert.equal(sqlite.prepare("SELECT status FROM visit_bookings WHERE id='VIS-PAST'").get().status, "active");
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_slot_claims WHERE booking_id='VIS-PAST'").get().total, 4);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_mutation_commands WHERE id='12121212-1212-4212-8212-121212121212'").get().total, 0);
});
