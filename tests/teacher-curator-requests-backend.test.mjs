import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const store = await import(
  pathToFileURL(path.join(root, "lib/teacher-curator-request-store.ts")).href
);

class PreparedStatement {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...values) {
    return new PreparedStatement(this.database, this.sql, values);
  }

  async first() {
    return this.database.sqlite.prepare(this.sql).get(...this.bindings) ?? null;
  }

  async all() {
    return {
      success: true,
      results: this.database.sqlite.prepare(this.sql).all(...this.bindings),
    };
  }

  execute() {
    return {
      success: true,
      results: this.database.sqlite.prepare(this.sql).all(...this.bindings),
    };
  }
}

class TestD1 {
  constructor(sqlite) {
    this.sqlite = sqlite;
  }

  prepare(sql) {
    return new PreparedStatement(this, sql);
  }

  async batch(statements) {
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

function openDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const file of fs.readdirSync(path.join(root, "drizzle"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    const sql = fs.readFileSync(path.join(root, "drizzle", file), "utf8");
    for (const statement of sql.split(/-->\s*statement-breakpoint/gu)) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }
  seed(sqlite);
  return { sqlite, db: new TestD1(sqlite) };
}

function seed(sqlite) {
  const now = "2026-08-24T08:00:00.000Z";
  sqlite.exec(`
    INSERT INTO users
      (id,full_name,sort_name,email,auth_user_id,role,status,created_at,updated_at)
    VALUES
      ('USR-LIB','Бібліотекар','бібліотекар','library@example.test','auth-library','librarian','active','${now}','${now}'),
      ('USR-T1','Учитель Перший','учитель перший',NULL,NULL,'teacher','active','${now}','${now}'),
      ('USR-T2','Учитель Другий','учитель другий',NULL,NULL,'teacher','active','${now}','${now}');

    INSERT INTO teacher_profiles (teacher_user_id,created_at,updated_at)
    VALUES ('USR-T1','${now}','${now}'),('USR-T2','${now}','${now}');

    INSERT INTO visit_teacher_credentials (
      teacher_user_id,login_id,code_hmac,must_change_pin,status,version,failed_attempts,
      code_rotated_at,created_by_user_id,updated_by_user_id,created_at,updated_at
    ) VALUES (
      'USR-T1','teacher-login-0001','${"b".repeat(64)}',0,'active',1,0,
      '${now}','USR-LIB','USR-LIB','${now}','${now}'
    );

    INSERT INTO visit_teacher_sessions (
      token_hash,teacher_user_id,credential_version,pending_scope,ip_scope_hash,
      expires_at,last_seen_at,revoked_at,created_at
    ) VALUES (
      '${"a".repeat(64)}','USR-T1',1,'${"d".repeat(32)}','${"c".repeat(64)}',
      '2999-01-01T00:00:00.000Z','${now}',NULL,'${now}'
    );

    INSERT INTO academic_years
      (id,label,start_date,end_date,status,notes,version,created_at,updated_at)
    VALUES
      ('YR-1','2026/2027','2026-09-01','2027-05-31','active','',1,'${now}','${now}'),
      ('YR-OLD','2025/2026','2025-09-01','2026-05-31','closed','',1,'${now}','${now}');

    INSERT INTO cohorts (id,status,notes,created_at,updated_at)
    VALUES
      ('COH-A','active','','${now}','${now}'),
      ('COH-B','active','','${now}','${now}'),
      ('COH-C','active','','${now}','${now}'),
      ('COH-D','active','','${now}','${now}'),
      ('COH-OLD','closed','','${now}','${now}');

    INSERT INTO class_years (
      id,academic_year_id,cohort_id,class_name,grade,code,teacher_user_id,
      location_id,start_date,end_date,status,actual_closed_date,notes,version,created_at,updated_at
    ) VALUES
      ('CY-A','YR-1','COH-A','5-А',5,'А','USR-T1',NULL,'2026-09-01','2027-05-31','active',NULL,'',1,'${now}','${now}'),
      ('CY-B','YR-1','COH-B','5-Б',5,'Б',NULL,NULL,'2026-09-01','2027-05-31','active',NULL,'',1,'${now}','${now}'),
      ('CY-C','YR-1','COH-C','5-В',5,'В',NULL,NULL,'2026-09-01','2027-05-31','active',NULL,'',1,'${now}','${now}'),
      ('CY-D','YR-1','COH-D','5-Г',5,'Г','USR-T2',NULL,'2026-09-01','2027-05-31','active',NULL,'',1,'${now}','${now}'),
      ('CY-OLD','YR-OLD','COH-OLD','4-А',4,'А',NULL,NULL,'2025-09-01','2026-05-31','active',NULL,'',1,'${now}','${now}');
  `);
}

const teacher = {
  teacherUserId: "USR-T1",
  fullName: "Учитель Перший",
  credentialVersion: 1,
  tokenHash: "a".repeat(64),
  pendingScope: "d".repeat(32),
  expiresAt: "2999-01-01T00:00:00.000Z",
  mustChangePin: false,
};

const librarian = {
  userId: "auth-library",
  d1UserId: "USR-LIB",
  email: "library@example.test",
  displayName: "Бібліотекар",
  fullName: "Бібліотекар",
};

function commandId() {
  return crypto.randomUUID();
}

async function submit(context, target = "CY-B") {
  return store.submitTeacherCuratorRequest(context.db, teacher, {
    mutationRequestId: commandId(),
    expectedVersion: null,
    requestedClassYearId: target,
    teacherNote: "Прошу змінити клас",
  });
}

test("teacher curator request create is replay-safe and librarian list returns the frozen projection", async () => {
  const context = openDatabase();
  const mutationRequestId = commandId();
  const input = {
    mutationRequestId,
    expectedVersion: null,
    requestedClassYearId: "CY-B",
    teacherNote: "Прошу змінити клас",
  };
  const created = await store.submitTeacherCuratorRequest(context.db, teacher, input);
  const replay = await store.submitTeacherCuratorRequest(context.db, teacher, input);
  assert.deepEqual(replay, created);
  assert.equal(created.status, "submitted");
  assert.equal(created.currentClass.id, "CY-A");
  assert.equal(created.requestedClass.id, "CY-B");
  assert.equal(created.version, 1);

  const listed = await store.listTeacherCuratorRequests(context.db, { status: "submitted" });
  assert.deepEqual(listed, [created]);
  assert.equal(context.sqlite.prepare(
    "SELECT COUNT(*) count FROM mutation_commands WHERE id=? AND status='completed'",
  ).get(mutationRequestId).count, 1);
  assert.equal(context.sqlite.prepare(
    "SELECT COUNT(*) count FROM audit_events WHERE request_id=? AND entity_type='teacher_curator_request'",
  ).get(mutationRequestId).count, 1);
});

test("librarian approval atomically moves the curator and is idempotent for the same actor", async () => {
  const context = openDatabase();
  const created = await submit(context);
  const decision = { requestId: created.id, expectedVersion: 1, decision: "approve" };
  const approved = await store.decideTeacherCuratorRequest(context.db, librarian, decision);
  const replay = await store.decideTeacherCuratorRequest(context.db, librarian, decision);
  assert.deepEqual(replay, approved);
  assert.equal(approved.status, "approved");
  assert.equal(approved.version, 2);
  assert.equal(context.sqlite.prepare("SELECT teacher_user_id FROM class_years WHERE id='CY-A'").get().teacher_user_id, null);
  assert.equal(context.sqlite.prepare("SELECT teacher_user_id FROM class_years WHERE id='CY-B'").get().teacher_user_id, "USR-T1");
  assert.equal(context.sqlite.prepare(
    "SELECT COUNT(*) count FROM audit_events WHERE request_id LIKE 'TCRD-%'",
  ).get().count, 3);
});

test("approval refuses a class taken after submission and stale expectedVersion is rejected", async () => {
  const conflictContext = openDatabase();
  const created = await submit(conflictContext);
  conflictContext.sqlite.prepare("UPDATE class_years SET teacher_user_id='USR-T2',version=version+1 WHERE id='CY-B'").run();
  await assert.rejects(
    () => store.decideTeacherCuratorRequest(conflictContext.db, librarian, {
      requestId: created.id,
      expectedVersion: 1,
      decision: "approve",
    }),
    (error) => error instanceof store.TeacherCuratorRequestError && error.code === "curator_class_taken",
  );
  assert.equal(conflictContext.sqlite.prepare("SELECT teacher_user_id FROM class_years WHERE id='CY-A'").get().teacher_user_id, "USR-T1");
  assert.equal(conflictContext.sqlite.prepare("SELECT status FROM teacher_curator_change_requests WHERE id=?").get(created.id).status, "submitted");

  const versionContext = openDatabase();
  const versioned = await submit(versionContext);
  await assert.rejects(
    () => store.decideTeacherCuratorRequest(versionContext.db, librarian, {
      requestId: versioned.id,
      expectedVersion: 2,
      decision: "reject",
    }),
    (error) => error instanceof store.TeacherCuratorRequestError && error.code === "curator_request_version_conflict",
  );
});

test("teacher capability roles remain valid and closed academic-year classes stay unavailable", async () => {
  const capabilityContext = openDatabase();
  capabilityContext.sqlite.prepare("UPDATE users SET role='admin' WHERE id='USR-T1'").run();
  const submitted = await submit(capabilityContext);
  assert.equal(submitted.status, "submitted");

  const closedContext = openDatabase();
  await assert.rejects(
    () => submit(closedContext, "CY-OLD"),
    (error) => error instanceof store.TeacherCuratorRequestError && error.code === "requested_class_unavailable",
  );
});

test("route source freezes the teacher and librarian JSON contracts", () => {
  const teacherRoute = fs.readFileSync(
    path.join(root, "app/api/teacher/profile/curator-request/route.ts"),
    "utf8",
  );
  const librarianRoute = fs.readFileSync(
    path.join(root, "app/api/librarian/teacher-curator-requests/route.ts"),
    "utf8",
  );
  assert.match(teacherRoute, /const expected = \["requestId", "expectedVersion", "requestedClassYearId", "teacherNote"\]/u);
  assert.match(teacherRoute, /export async function DELETE\(request: Request\)/u);
  assert.match(teacherRoute, /typeof expectedVersion !== "number"/u);
  assert.match(librarianRoute, /keys\.length !== 3/u);
  assert.match(librarianRoute, /typeof expectedVersion !== "number"/u);
  assert.match(librarianRoute, /decision !== "approve" && decision !== "reject"/u);
  assert.match(librarianRoute, /writesEnabled/u);
});
