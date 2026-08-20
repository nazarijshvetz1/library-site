import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

globalThis.__TEACHER_REGISTRY_ENV = {};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return { url: "data:text/javascript,export const env=globalThis.__TEACHER_REGISTRY_ENV", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const store = await import("../lib/teacher-registry-store.ts");
const validation = await import("../lib/teacher-registry-validation.ts");

const migrationFiles = [
  "0000_librarian_drafts.sql", "0001_draft_workflow.sql", "0002_remove_legacy_audit_triggers.sql",
  "0003_odd_the_order.sql", "0004_staging_import_runs.sql", "0005_young_night_nurse.sql",
  "0006_pale_sauron.sql", "0007_cold_whiplash.sql", "0008_sudden_thunderbird.sql",
  "0009_happy_silver_samurai.sql", "0010_shocking_cobalt_man.sql",
  "0011_normalize_holding_conditions.sql",
];

class PreparedStatement {
  constructor(database, sql, bindings = []) { this.database = database; this.sql = sql; this.bindings = bindings; }
  bind(...values) { return new PreparedStatement(this.database, this.sql, values); }
  async first() { return this.database.sqlite.prepare(this.sql).get(...this.bindings) ?? null; }
  async all() { return { success: true, results: this.database.sqlite.prepare(this.sql).all(...this.bindings) }; }
  execute() {
    const statement = this.database.sqlite.prepare(this.sql);
    return statement.reader
      ? { success: true, results: statement.all(...this.bindings) }
      : { success: true, meta: { changes: Number(statement.run(...this.bindings).changes) } };
  }
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

async function migratedDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const file of migrationFiles) {
    const sql = await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
    sqlite.exec(sql.replaceAll("--> statement-breakpoint", ""));
  }
  return sqlite;
}

async function context() {
  const sqlite = await migratedDatabase();
  const now = "2026-08-13T09:00:00.000Z";
  insertUser(sqlite, "USR-LIB", "Бібліотекар", "library@example.test", "auth-library", "librarian", now);
  return {
    sqlite,
    db: new TestD1(sqlite),
    user: { userId: "auth-library", email: "library@example.test" },
  };
}

function insertUser(sqlite, id, name, email, authUserId, role, now) {
  sqlite.prepare(`INSERT INTO users(id,full_name,sort_name,email,auth_user_id,role,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?, 'active',?,?)`).run(id, name, name.toLocaleLowerCase("uk-UA"), email, authUserId, role, now, now);
}

function createInput(fullName = "Шевченко Олена") {
  return {
    requestId: crypto.randomUUID(), fullName, subjectPosition: "Математика",
    primaryLocationId: null, serviceContact: "", librarianNote: "", forceDuplicate: false,
  };
}

function updateInput(expectedVersion, action, changes = {}) {
  return { requestId: crypto.randomUUID(), expectedVersion, action, changes, reason: "", forceDuplicate: false };
}

test("0010 migrates seeded parent/children with foreign keys enabled and backfills every teacher", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const file of migrationFiles.slice(0, -2)) {
    sqlite.exec((await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8")).replaceAll("--> statement-breakpoint", ""));
  }
  const now = "2026-08-13T09:00:00.000Z";
  insertUser(sqlite, "USR-LIB", "Бібліотекар", "library@example.test", "auth-library", "librarian", now);
  insertUser(sqlite, "USR-T1", "Учитель", null, null, "teacher", now);
  sqlite.exec(`
    INSERT INTO locations(id,name,type,status,is_public,sort_order,created_at,updated_at)
      VALUES('LOC-LIB','Бібліотека','library','active',1,0,'${now}','${now}');
    INSERT INTO materials(id,catalog_number,title,sort_title,search_text,rubric,publication_type,subject,
      class_from,class_to,author,publication_year,isbn,isbn_normalized,publisher,notes,status,version,created_at,updated_at,archived_at)
      VALUES('CAT-0001',1,'Алгебра','алгебра','','','','',NULL,NULL,'Автор',NULL,'','','','',
        'active',1,'${now}','${now}',NULL);
    INSERT INTO material_stock_totals(material_id,total_quantity,library_quantity,other_location_quantity,loaned_quantity,updated_at)
      VALUES('CAT-0001',5,5,0,0,'${now}');
    INSERT INTO holdings(material_id,location_id,condition,quantity,version,updated_at)
      VALUES('CAT-0001','LOC-LIB','good',5,1,'${now}');
    INSERT INTO loans(id,teacher_user_id,status,issued_at,due_at,closed_at,notes,issued_by_user_id,
      closed_by_user_id,version,created_at,updated_at)
      VALUES('LOAN-LEGACY','USR-T1','open','2026-08-12','2026-09-01',NULL,'','USR-LIB',NULL,1,'${now}','${now}');
    INSERT INTO material_requests(id,teacher_user_id,status,teacher_notes,librarian_note,rejection_reason,pickup_location_id,
      resulting_loan_id,reviewed_by_user_id,cancelled_by_user_id,version,submitted_at,ready_at,completed_at,rejected_at,
      cancelled_at,created_at,updated_at) VALUES('MR-1','USR-T1','ready','','','','LOC-LIB','LOAN-LEGACY','USR-LIB',NULL,2,'${now}','${now}',NULL,NULL,NULL,'${now}','${now}');
    INSERT INTO material_request_items(id,request_id,material_id,title_snapshot,author_snapshot,requested_quantity,
      approved_quantity,fulfilled_quantity,sort_order,created_at,updated_at)
      VALUES('MRI-1','MR-1','CAT-0001','Алгебра','Автор',2,NULL,0,0,'${now}','${now}');
    INSERT INTO material_request_events(id,request_id,actor_user_id,actor_kind,kind,from_status,to_status,metadata_json,created_at)
      VALUES('MRE-1','MR-1','USR-T1','teacher','submitted',NULL,'submitted','{}','${now}');
    INSERT INTO portal_notifications(id,teacher_user_id,dedupe_key,type,title,message,entity_type,entity_id,read_at,version,created_at,updated_at)
      VALUES('NTF-1','USR-T1','dedupe','request','Заявка','Створено','material_request','MR-1',NULL,1,'${now}','${now}');
  `);
  const migration = await readFile(new URL("../drizzle/0010_shocking_cobalt_man.sql", import.meta.url), "utf8");
  sqlite.exec(migration.replaceAll("--> statement-breakpoint", ""));
  assert.equal(sqlite.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM teacher_profiles WHERE teacher_user_id='USR-T1'").get().n, 1);
  assert.equal(sqlite.prepare("SELECT due_at FROM material_requests WHERE id='MR-1'").get().due_at, "2026-09-01");
  assert.equal(sqlite.prepare("SELECT reserved_quantity FROM material_stock_totals WHERE material_id='CAT-0001'").get().reserved_quantity, 0);
  assert.throws(() => sqlite.prepare("UPDATE material_stock_totals SET reserved_quantity=6 WHERE material_id='CAT-0001'").run(), /CHECK constraint failed/u);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM material_request_items WHERE request_id='MR-1'").get().n, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM material_request_events WHERE request_id='MR-1'").get().n, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM portal_notifications WHERE teacher_user_id='USR-T1'").get().n, 1);
  sqlite.prepare(`INSERT INTO material_request_reservations(id,request_id,request_item_id,material_id,
    source_location_id,condition,reserved_quantity,issued_quantity,released_quantity,created_at,updated_at)
    VALUES('MRR-1','MR-1','MRI-1','CAT-0001','LOC-LIB','good',2,1,0,?,?)`).run(now, now);
  assert.throws(() => sqlite.prepare("UPDATE material_request_reservations SET reserved_quantity=3 WHERE id='MRR-1'").run(), /reservation_stock_conflict/u);
  assert.throws(() => sqlite.prepare("UPDATE material_request_reservations SET issued_quantity=0 WHERE id='MRR-1'").run(), /reservation_stock_conflict/u);
  sqlite.prepare("UPDATE material_request_reservations SET released_quantity=1 WHERE id='MRR-1'").run();
  assert.throws(() => sqlite.prepare("UPDATE material_request_reservations SET released_quantity=0 WHERE id='MRR-1'").run(), /reservation_stock_conflict/u);
  sqlite.close();
});

test("validation accepts partial updates and empty close changes, but rejects hidden personnel fields", () => {
  assert.equal(validation.validateTeacherCreateInput(createInput()).ok, true);
  assert.equal(validation.validateTeacherUpdateInput(updateInput(1, "update", { subjectPosition: "Фізика" })).ok, true);
  assert.equal(validation.validateTeacherUpdateInput(updateInput(1, "close", {})).ok, true);
  const invalid = validation.validateTeacherCreateInput({ ...createInput(), personnelNumber: "123" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.fieldErrors.personnelNumber, "Невідоме поле.");
});

test("registry API keeps every route librarian-only and every write same-origin gated", async () => {
  const api = await readFile(new URL("../lib/teacher-registry-api.ts", import.meta.url), "utf8");
  const collectionRoute = await readFile(new URL("../app/api/librarian/teachers/route.ts", import.meta.url), "utf8");
  const detailRoute = await readFile(new URL("../app/api/librarian/teachers/[id]/route.ts", import.meta.url), "utf8");

  assert.match(api, /authorizeLibrarianApi\(\)/u);
  assert.match(api, /authorization\.value\.access\.writesEnabled/u);
  assert.match(api, /isSameOriginRequest\(request\)/u);
  assert.match(collectionRoute, /GET[\s\S]*authorizeTeacherRegistryRead\(\)/u);
  assert.match(collectionRoute, /POST[\s\S]*authorizeTeacherRegistryWrite\(request\)/u);
  assert.match(detailRoute, /GET[\s\S]*authorizeTeacherRegistryRead\(\)/u);
  assert.match(detailRoute, /PATCH[\s\S]*authorizeTeacherRegistryWrite\(request\)/u);
  assert.match(detailRoute, /DELETE[\s\S]*authorizeTeacherRegistryWrite\(request\)/u);
});

test("registry creates email-free cards, warns on duplicate, paginates, updates and replays exactly", async () => {
  const ctx = await context();
  const input = createInput();
  const created = await store.createTeacherRegistryCard(ctx.db, ctx.user, input);
  const user = ctx.sqlite.prepare("SELECT email,auth_user_id FROM users WHERE id=?").get(created.teacherId);
  assert.deepEqual({ ...user }, { email: null, auth_user_id: null });
  assert.deepEqual(await store.createTeacherRegistryCard(ctx.db, ctx.user, input), created);
  await assert.rejects(
    () => store.createTeacherRegistryCard(ctx.db, ctx.user, createInput("  Шевченко   Олена ")),
    (error) => error.code === "teacher_duplicate_warning" && error.details.duplicates.length === 1,
  );
  const second = await store.createTeacherRegistryCard(ctx.db, ctx.user, { ...createInput("Петренко Ірина"), forceDuplicate: true });
  const firstPage = await store.listTeacherRegistry(ctx.db, { status: "all", attention: "all", query: "", limit: 1, cursor: null });
  const nextPage = await store.listTeacherRegistry(ctx.db, { status: "all", attention: "all", query: "", limit: 1, cursor: firstPage.page.nextCursor });
  assert.equal(new Set([...firstPage.teachers, ...nextPage.teachers].map((value) => value.id)).size, 2);

  const detail = await store.getTeacherRegistryDetail(ctx.db, second.teacherId);
  const changed = updateInput(detail.teacher.version, "update", { subjectPosition: "Фізика" });
  const updated = await store.updateTeacherRegistryCard(ctx.db, ctx.user, second.teacherId, changed);
  assert.equal((await store.getTeacherRegistryDetail(ctx.db, second.teacherId)).teacher.subjectPosition, "Фізика");
  assert.deepEqual(await store.updateTeacherRegistryCard(ctx.db, ctx.user, second.teacherId, changed), updated);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE request_id=?").get(changed.requestId).n, 1);
});

test("close blocks active work, preserves loans, then disables code and revokes sessions atomically", async () => {
  const ctx = await context();
  const created = await store.createTeacherRegistryCard(ctx.db, ctx.user, createInput());
  const now = "2026-08-13T09:00:00.000Z";
  ctx.sqlite.prepare(`INSERT INTO visit_teacher_credentials(teacher_user_id,login_id,code_hmac,status,version,
    failed_attempts,failure_window_started_at,locked_until,last_login_at,code_rotated_at,last_access_command_id,
    created_by_user_id,updated_by_user_id,created_at,updated_at)
    VALUES(?,? ,?,'active',1,0,NULL,NULL,NULL,?,NULL,'USR-LIB','USR-LIB',?,?)`)
    .run(created.teacherId, "opaque-login-id-123", "a".repeat(64), now, now, now);
  ctx.sqlite.prepare(`INSERT INTO visit_teacher_sessions(token_hash,teacher_user_id,credential_version,pending_scope,
    ip_scope_hash,expires_at,last_seen_at,revoked_at,created_at) VALUES(?, ?,1,?,?,?, ?,NULL,?)`)
    .run("b".repeat(64), created.teacherId, "pending-scope-1234", "c".repeat(64), "2999-01-01T00:00:00.000Z", now, now);
  ctx.sqlite.prepare(`INSERT INTO material_requests(id,teacher_user_id,status,teacher_notes,librarian_note,rejection_reason,
    pickup_location_id,resulting_loan_id,due_at,reviewed_by_user_id,cancelled_by_user_id,version,submitted_at,ready_at,
    completed_at,rejected_at,cancelled_at,created_at,updated_at) VALUES('MR-BLOCK',?,'submitted','','','',NULL,NULL,NULL,
    NULL,NULL,1,?,NULL,NULL,NULL,NULL,?,?)`).run(created.teacherId, now, now, now);
  const version = (await store.getTeacherRegistryDetail(ctx.db, created.teacherId)).teacher.version;
  await assert.rejects(
    () => store.updateTeacherRegistryCard(ctx.db, ctx.user, created.teacherId, updateInput(version, "close")),
    (error) => error.code === "teacher_close_blocked" && error.details.blockers.activeRequests === 1,
  );
  ctx.sqlite.prepare("UPDATE material_requests SET status='cancelled',cancelled_at=? WHERE id='MR-BLOCK'").run(now);
  const close = updateInput(version, "close");
  const result = await store.updateTeacherRegistryCard(ctx.db, ctx.user, created.teacherId, close);
  assert.equal(result.status, "inactive");
  assert.equal(ctx.sqlite.prepare("SELECT status FROM users WHERE id=?").get(created.teacherId).status, "inactive");
  assert.equal(ctx.sqlite.prepare("SELECT status FROM visit_teacher_credentials WHERE teacher_user_id=?").get(created.teacherId).status, "disabled");
  assert.ok(ctx.sqlite.prepare("SELECT revoked_at FROM visit_teacher_sessions WHERE teacher_user_id=?").get(created.teacherId).revoked_at);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM material_requests WHERE teacher_user_id=?").get(created.teacherId).n, 1);
});

test("mutation zero-row race rolls back command, audit and partial profile changes", async () => {
  const ctx = await context();
  const created = await store.createTeacherRegistryCard(ctx.db, ctx.user, createInput());
  const current = await store.getTeacherRegistryDetail(ctx.db, created.teacherId);
  const input = updateInput(current.teacher.version, "update", { subjectPosition: "Хімія" });
  ctx.db.beforeBatch = () => ctx.sqlite.prepare("UPDATE teacher_profiles SET version=version+1 WHERE teacher_user_id=?").run(created.teacherId);
  await assert.rejects(
    () => store.updateTeacherRegistryCard(ctx.db, ctx.user, created.teacherId, input),
    (error) => error.code === "teacher_version_conflict",
  );
  assert.equal(ctx.sqlite.prepare("SELECT subject_position FROM teacher_profiles WHERE teacher_user_id=?").get(created.teacherId).subject_position, "Математика");
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM mutation_commands WHERE id=?").get(input.requestId).n, 0);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE request_id=?").get(input.requestId).n, 0);
});

test("librarian deactivation before a batch aborts every registry mutation", async () => {
  const ctx = await context();
  ctx.db.beforeBatch = () => ctx.sqlite.prepare("UPDATE users SET status='inactive' WHERE id='USR-LIB'").run();
  const input = createInput();
  await assert.rejects(() => store.createTeacherRegistryCard(ctx.db, ctx.user, input), /NOT NULL constraint failed/u);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE role='teacher'").get().n, 0);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM mutation_commands WHERE id=?").get(input.requestId).n, 0);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE request_id=?").get(input.requestId).n, 0);
});

test("list exposes exact counters, private note only in detail, and nested material titles", async () => {
  const ctx = await context();
  const created = await store.createTeacherRegistryCard(ctx.db, ctx.user, {
    ...createInput(), librarianNote: "Лише бібліотекарю",
  });
  const list = await store.listTeacherRegistry(ctx.db, {
    status: "all", attention: "all", query: "шевченко", limit: 30, cursor: null,
  });
  assert.equal(list.counters.total, 1);
  assert.equal(list.counters.active, 1);
  assert.equal(list.counters.withoutCode, 1);
  assert.equal(list.teachers.length, 1);
  assert.equal(Object.hasOwn(list.teachers[0], "librarianNote"), false);
  const detail = await store.getTeacherRegistryDetail(ctx.db, created.teacherId);
  assert.equal(detail.teacher.librarianNote, "Лише бібліотекарю");
  assert.deepEqual(detail.requests, []);
  assert.deepEqual(detail.loans, []);
});

test("Kyiv date remains deterministic across UTC midnight", () => {
  assert.equal(store.kyivDate("2026-03-28T22:30:00.000Z"), "2026-03-29");
  assert.equal(store.kyivDate("2026-10-24T21:30:00.000Z"), "2026-10-25");
});
