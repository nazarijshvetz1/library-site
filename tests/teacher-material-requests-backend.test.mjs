import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const store = await import(
  pathToFileURL(path.join(root, "lib/teacher-material-request-store.ts")).href
);
const validation = await import(
  pathToFileURL(path.join(root, "lib/teacher-material-request-validation.ts")).href
);
const profileStore = await import(
  pathToFileURL(path.join(root, "lib/teacher-profile-store.ts")).href
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
    this.database.queryCount += 1;
    return this.database.sqlite.prepare(this.sql).get(...this.bindings) ?? null;
  }

  async all() {
    this.database.queryCount += 1;
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
    this.beforeBatch = null;
    this.queryCount = 0;
    this.batchStatementCounts = [];
  }

  prepare(sql) {
    return new PreparedStatement(this, sql);
  }

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
  const now = "2026-08-13T08:00:00.000Z";
  sqlite.prepare(`INSERT INTO users
    (id,full_name,sort_name,email,auth_user_id,role,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'active',?,?)`)
    .run("USR-LIB", "Бібліотекар", "бібліотекар", "library@example.test", "auth-library", "librarian", now, now);
  sqlite.prepare(`INSERT INTO users
    (id,full_name,sort_name,email,auth_user_id,role,status,created_at,updated_at)
    VALUES (?,?,?,NULL,NULL,'teacher','active',?,?)`)
    .run("USR-T1", "Шевченко Олена", "шевченко олена", now, now);
  sqlite.prepare(`INSERT INTO teacher_profiles(
    teacher_user_id,subject_position,primary_location_id,service_contact,librarian_note,version,
    last_mutation_request_id,closed_at,closed_by_user_id,created_by_user_id,updated_by_user_id,created_at,updated_at
  ) VALUES(?, '', NULL, '', '', 1, NULL, NULL, NULL, 'USR-LIB', 'USR-LIB', ?, ?)`)
    .run("USR-T1", now, now);
  sqlite.prepare(`INSERT INTO visit_teacher_credentials (
    teacher_user_id,login_id,code_hmac,status,version,failed_attempts,
    failure_window_started_at,locked_until,last_login_at,code_rotated_at,
    last_access_command_id,created_by_user_id,updated_by_user_id,created_at,updated_at
  ) VALUES ('USR-T1','teacher-login-0001',?,'active',1,0,NULL,NULL,NULL,?,NULL,'USR-LIB','USR-LIB',?,?)`)
    .run("b".repeat(64), now, now, now);
  sqlite.prepare(`INSERT INTO visit_teacher_sessions (
    token_hash,teacher_user_id,credential_version,pending_scope,ip_scope_hash,
    expires_at,last_seen_at,revoked_at,created_at
  ) VALUES (?,'USR-T1',1,'teacher-pending-scope',?,'2999-01-01T00:00:00.000Z',?,NULL,?)`)
    .run("a".repeat(64), "c".repeat(64), now, now);
  sqlite.prepare(`INSERT INTO materials (
    id,catalog_number,title,sort_title,search_text,rubric,publication_type,
    subject,class_from,class_to,author,publication_year,isbn,isbn_normalized,
    publisher,notes,status,version,created_at,updated_at,archived_at
  ) VALUES (
    'CAT-0001',1,'Алгебра 7 клас','алгебра 7 клас','алгебра 7 клас автор',
    'Підручники','Підручник','Математика',7,7,'Автор',2024,'','','','',
    'active',1,?,?,NULL
  )`).run(now, now);
  sqlite.prepare(`INSERT INTO locations
    (id,name,type,status,is_public,sort_order,created_at,updated_at)
    VALUES ('LOC-LIB','Бібліотека','library','active',1,1,?,?)`)
    .run(now, now);
  sqlite.prepare(`INSERT INTO locations
    (id,name,type,status,is_public,sort_order,created_at,updated_at)
    VALUES ('LOC-205','Кабінет 205','classroom','active',1,2,?,?)`)
    .run(now, now);
  sqlite.prepare(`INSERT INTO holdings
    (material_id,location_id,condition,quantity,version,updated_at)
    VALUES ('CAT-0001','LOC-LIB','good',5,1,?)`).run(now);
  sqlite.prepare(`INSERT INTO material_stock_totals
    (material_id,total_quantity,library_quantity,other_location_quantity,loaned_quantity,updated_at)
    VALUES ('CAT-0001',5,5,0,0,?)`).run(now);
}

const teacher = {
  teacherUserId: "USR-T1",
  fullName: "Шевченко Олена",
  credentialVersion: 1,
  tokenHash: "a".repeat(64),
  pendingScope: "teacher-pending-scope",
  expiresAt: "2999-01-01T00:00:00.000Z",
};
const librarian = {
  userId: "auth-library",
  email: "library@example.test",
  displayName: "Бібліотекар",
  fullName: "Бібліотекар",
};

function commandId() {
  return crypto.randomUUID();
}

async function createRequest(context, quantity = 3) {
  return store.createTeacherMaterialRequest(context.db, teacher, {
    requestId: commandId(),
    notes: "Для уроку",
    items: [{ materialId: "CAT-0001", quantity }],
  });
}

test("frozen request, ready and notification payloads validate with exact keys", () => {
  assert.equal(validation.validateMaterialRequestCreateInput({
    requestId: commandId(),
    notes: null,
    items: [{ materialId: "CAT-0001", quantity: 2 }],
  }).ok, true);
  assert.equal(validation.validateMaterialRequestCreateInput({
    requestId: commandId(),
    notes: null,
    items: [{ materialId: "CAT-0001", qty: 2 }],
  }).ok, false);
  assert.equal(validation.validateMaterialRequestActionInput({
    requestId: commandId(), expectedVersion: 1, action: "start_review",
  }).ok, true);
  assert.equal(validation.validateMaterialRequestActionInput({
    requestId: commandId(), expectedVersion: 2, action: "issue",
    issuedAt: "2026-08-13", dueAt: "2026-09-30",
    items: [{ reservationId: "MRR-one", quantity: 1 }],
  }).ok, true);
  assert.equal(validation.validateMaterialRequestActionInput({
    requestId: commandId(), expectedVersion: 2, action: "release",
    reason: "Не забрано",
    items: [{ reservationId: "MRR-one", quantity: 1 }],
  }).ok, true);
  assert.equal(validation.validateMaterialRequestActionInput({
    requestId: commandId(), expectedVersion: 1, action: "ready",
    pickupLocationId: "LOC-205", dueAt: null,
    items: [{
      itemId: "MRI-one", approvedQuantity: 1, sourceLocationId: "LOC-LIB",
      condition: "good", expectedAvailableQuantity: 5,
    }],
  }).ok, true);
  assert.equal(validation.validateNotificationReadInput({
    requestId: commandId(), expectedVersion: 1, read: true,
  }).ok, true);
  assert.equal(validation.validateNotificationDeleteInput({
    requestId: commandId(), expectedVersion: 1,
  }).ok, true);
  assert.equal(validation.validateNotificationDeleteInput({
    requestId: commandId(), expectedVersion: 1, confirmation: true,
  }).ok, false);
});

test("teacher profile self-update is optimistic, audited and idempotent", async () => {
  const context = openDatabase();
  const requestId = commandId();
  const input = {
    requestId,
    expectedVersion: 1,
    fullName: "Шевченко Олена Вікторівна",
    subjectPosition: "Учитель математики",
    primaryLocationId: "LOC-205",
  };

  const updated = await profileStore.updateTeacherOwnProfile(context.db, teacher, input);
  const replay = await profileStore.updateTeacherOwnProfile(context.db, teacher, input);
  assert.deepEqual(replay, updated);
  assert.equal(updated.teacherUserId, "USR-T1");
  assert.equal(updated.profileVersion, 2);
  assert.deepEqual(
    { ...context.sqlite.prepare("SELECT full_name,sort_name FROM users WHERE id='USR-T1'").get() },
    { full_name: "Шевченко Олена Вікторівна", sort_name: "шевченко олена вікторівна" },
  );
  assert.deepEqual(
    { ...context.sqlite.prepare(`SELECT subject_position,primary_location_id,version,
      last_mutation_request_id,updated_by_user_id FROM teacher_profiles WHERE teacher_user_id='USR-T1'`).get() },
    {
      subject_position: "Учитель математики",
      primary_location_id: "LOC-205",
      version: 2,
      last_mutation_request_id: requestId,
      updated_by_user_id: "USR-T1",
    },
  );
  assert.equal(
    context.sqlite.prepare("SELECT action FROM audit_events WHERE request_id=?").get(requestId).action,
    "teacher.profile.self_updated",
  );
  assert.equal(
    context.sqlite.prepare("SELECT status FROM mutation_commands WHERE id=?").get(requestId).status,
    "completed",
  );

  await assert.rejects(
    () => profileStore.updateTeacherOwnProfile(context.db, teacher, {
      ...input,
      requestId: commandId(),
      expectedVersion: 1,
      subjectPosition: "Учитель алгебри",
    }),
    (error) => error.code === "teacher_profile_version_conflict" && error.status === 409,
  );
  await assert.rejects(
    () => profileStore.updateTeacherOwnProfile(context.db, teacher, {
      ...input,
      requestId: commandId(),
      expectedVersion: 2,
      primaryLocationId: "LOC-MISSING",
    }),
    (error) => error.code === "teacher_profile_location_invalid" && error.status === 400,
  );
});

test("teacher create is idempotent, bounded and returns the UI projection", async () => {
  const context = openDatabase();
  const command = commandId();
  const input = {
    requestId: command,
    notes: "Для уроку",
    items: [{ materialId: "CAT-0001", quantity: 3 }],
  };
  const first = await store.createTeacherMaterialRequest(context.db, teacher, input);
  const replay = await store.createTeacherMaterialRequest(context.db, teacher, input);
  assert.deepEqual(replay, first);
  assert.equal(first.teacher.fullName, "Шевченко Олена");
  assert.equal(first.items[0].material.title, "Алгебра 7 клас");
  assert.equal(first.items[0].requestedQuantity, 3);
  assert.equal(first.items[0].approvedQuantity, 0);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM material_requests").get().n, 1);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM mutation_commands WHERE id=?").get(command).n, 1);
  assert.ok(Math.max(...context.db.batchStatementCounts) < 10);

  context.db.queryCount = 0;
  const listed = await store.listTeacherMaterialRequests(context.db, "USR-T1");
  assert.equal(context.db.queryCount, 1, "request list must use one bounded joined query");
  assert.deepEqual(listed, [first]);
});

test("teacher create caps active requests and atomically reasserts the cap", async () => {
  const context = openDatabase();
  for (let index = 0; index < store.ACTIVE_MATERIAL_REQUEST_LIMIT; index += 1) {
    context.sqlite.prepare(`INSERT INTO material_requests (
      id,teacher_user_id,status,teacher_notes,librarian_note,rejection_reason,
      pickup_location_id,resulting_loan_id,reviewed_by_user_id,cancelled_by_user_id,
      version,submitted_at,ready_at,completed_at,rejected_at,cancelled_at,created_at,updated_at
    ) VALUES (?,?,'submitted','','','',NULL,NULL,NULL,NULL,1,?,NULL,NULL,NULL,NULL,?,?)`)
      .run(`MRQ-CAP-${index}`, "USR-T1", `2026-08-12T08:${String(index).padStart(2, "0")}:00.000Z`,
        `2026-08-12T08:${String(index).padStart(2, "0")}:00.000Z`,
        `2026-08-12T08:${String(index).padStart(2, "0")}:00.000Z`);
  }
  await assert.rejects(
    () => createRequest(context, 1),
    (error) => error instanceof store.TeacherMaterialRequestError
      && error.code === "request_limit_reached" && error.status === 429,
  );
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM mutation_commands").get().n, 0);

  context.sqlite.prepare("UPDATE material_requests SET status='cancelled',cancelled_at=updated_at WHERE id='MRQ-CAP-0'").run();
  const command = commandId();
  context.db.beforeBatch = () => {
    context.sqlite.prepare("UPDATE material_requests SET status='submitted',cancelled_at=NULL WHERE id='MRQ-CAP-0'").run();
  };
  await assert.rejects(
    () => store.createTeacherMaterialRequest(context.db, teacher, {
      requestId: command, notes: null, items: [{ materialId: "CAT-0001", quantity: 1 }],
    }),
    (error) => error instanceof store.TeacherMaterialRequestError
      && error.code === "request_limit_reached" && error.status === 429,
  );
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM material_requests").get().n, store.ACTIVE_MATERIAL_REQUEST_LIMIT);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM mutation_commands WHERE id=?").get(command).n, 0);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM material_request_events WHERE id LIKE 'MRE-%'").get().n, 0);
});

test("ready reserves without a loan, then physical issue creates the loan atomically", async () => {
  const context = openDatabase();
  const request = await createRequest(context, 3);
  const command = commandId();
  const input = {
    requestId: command,
    expectedVersion: request.version,
    action: "ready",
    pickupLocationId: "LOC-205",
    dueAt: "2026-09-30",
    items: [{
      itemId: request.items[0].id,
      approvedQuantity: 2,
      sourceLocationId: "LOC-LIB",
      condition: "good",
      expectedAvailableQuantity: 5,
    }],
  };
  const first = await store.applyLibrarianMaterialRequestAction(
    context.db,
    librarian,
    request.id,
    input,
  );
  const replay = await store.applyLibrarianMaterialRequestAction(
    context.db,
    librarian,
    request.id,
    input,
  );
  assert.deepEqual(replay, first);
  assert.equal(first.status, "partially_ready");
  assert.ok(context.db.batchStatementCounts.at(-1) <= 50);
  assert.deepEqual(
    { ...context.sqlite.prepare("SELECT status,resulting_loan_id,pickup_location_id FROM material_requests").get() },
    {
      status: "partially_ready",
      resulting_loan_id: null,
      pickup_location_id: "LOC-205",
    },
  );
  assert.equal(context.sqlite.prepare("SELECT quantity FROM holdings").get().quantity, 5);
  assert.equal(context.sqlite.prepare("SELECT reserved_quantity FROM material_stock_totals").get().reserved_quantity, 2);
  assert.equal(context.sqlite.prepare("SELECT loaned_quantity FROM material_stock_totals").get().loaned_quantity, 0);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM loans").get().n, 0);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM inventory_transactions").get().n, 0);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM portal_notifications").get().n, 1);

  const prepared = await store.getMaterialRequest(context.db, request.id);
  assert.equal(prepared.items[0].reservedQuantity, 2);
  const reservation = prepared.items[0].reservations[0];
  const issued = await store.applyLibrarianMaterialRequestAction(
    context.db,
    librarian,
    request.id,
    {
      requestId: commandId(),
      expectedVersion: prepared.version,
      action: "issue",
      issuedAt: "2026-08-13",
      dueAt: "2026-09-30",
      items: [{ reservationId: reservation.id, quantity: 2 }],
    },
  );
  assert.equal(issued.status, "completed");
  assert.equal(context.sqlite.prepare("SELECT quantity FROM holdings").get().quantity, 3);
  assert.equal(context.sqlite.prepare("SELECT reserved_quantity FROM material_stock_totals").get().reserved_quantity, 0);
  assert.equal(context.sqlite.prepare("SELECT loaned_quantity FROM material_stock_totals").get().loaned_quantity, 2);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM loans").get().n, 1);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM inventory_transactions").get().n, 1);

  const notification = (await store.listTeacherNotifications(context.db, "USR-T1")).notifications
    .find((item) => item.read === false);
  assert.ok(notification);
  assert.equal(notification.read, false);
  const readInput = { requestId: commandId(), expectedVersion: notification.version, read: true };
  const marked = await store.markTeacherNotificationRead(
    context.db,
    teacher,
    notification.id,
    readInput,
  );
  const markedReplay = await store.markTeacherNotificationRead(
    context.db,
    teacher,
    notification.id,
    readInput,
  );
  assert.deepEqual(markedReplay, marked);
  assert.equal(marked.read, true);
  assert.equal(
    context.sqlite.prepare("SELECT read_at FROM portal_notifications WHERE id=?").get(notification.id).read_at,
    marked.readAt,
  );
});

test("teacher notification deletion is a hidden, idempotent soft-delete", async () => {
  const context = openDatabase();
  const request = await createRequest(context, 1);
  await store.applyLibrarianMaterialRequestAction(context.db, librarian, request.id, {
    requestId: commandId(), expectedVersion: request.version, action: "start_review",
  });
  const before = await store.listTeacherNotifications(context.db, "USR-T1");
  assert.equal(before.notifications.length, 1);
  assert.equal(before.unreadCount, 1);
  const notification = before.notifications[0];
  const input = { requestId: commandId(), expectedVersion: notification.version };

  const deleted = await store.deleteTeacherNotification(
    context.db,
    teacher,
    notification.id,
    input,
  );
  const replay = await store.deleteTeacherNotification(
    context.db,
    teacher,
    notification.id,
    input,
  );
  assert.deepEqual(replay, deleted);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.version, notification.version + 1);
  const persisted = context.sqlite.prepare(`SELECT deleted_at,read_at,version
    FROM portal_notifications WHERE id=?`).get(notification.id);
  assert.equal(persisted.deleted_at, deleted.deletedAt);
  assert.equal(persisted.read_at, null);
  assert.equal(persisted.version, deleted.version);
  assert.equal(
    context.sqlite.prepare("SELECT COUNT(*) AS n FROM portal_notifications WHERE id=?").get(notification.id).n,
    1,
    "soft-delete must retain the audited row",
  );
  assert.equal(
    context.sqlite.prepare("SELECT action FROM audit_events WHERE request_id=?").get(input.requestId).action,
    "portal_notifications.deleted",
  );

  const after = await store.listTeacherNotifications(context.db, "USR-T1");
  assert.deepEqual(after.notifications, []);
  assert.equal(after.unreadCount, 0);
  await assert.rejects(
    () => store.markTeacherNotificationRead(context.db, teacher, notification.id, {
      requestId: commandId(), expectedVersion: deleted.version, read: true,
    }),
    (error) => error instanceof store.TeacherMaterialRequestError
      && error.code === "notification_not_found" && error.status === 404,
  );
});

test("ready stock race rolls back reservation, request, command and notification", async () => {
  const context = openDatabase();
  const request = await createRequest(context, 2);
  const command = commandId();
  context.db.beforeBatch = () => {
    context.sqlite.prepare(`UPDATE holdings
      SET quantity=4,version=2,updated_at='2026-08-13T09:00:00.000Z'
      WHERE material_id='CAT-0001' AND location_id='LOC-LIB' AND condition='good'`).run();
  };
  await assert.rejects(
    () => store.applyLibrarianMaterialRequestAction(
      context.db,
      librarian,
      request.id,
      {
        requestId: command,
        expectedVersion: request.version,
        action: "ready",
        pickupLocationId: "LOC-205",
        dueAt: null,
        items: [{
          itemId: request.items[0].id,
          approvedQuantity: 2,
          sourceLocationId: "LOC-LIB",
          condition: "good",
          expectedAvailableQuantity: 5,
        }],
      },
    ),
    (error) => error instanceof store.TeacherMaterialRequestError
      && error.code === "reservation_stock_conflict",
  );
  assert.equal(context.sqlite.prepare("SELECT status FROM material_requests").get().status, "submitted");
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM loans").get().n, 0);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM material_request_reservations").get().n, 0);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM portal_notifications").get().n, 0);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM mutation_commands WHERE id=?").get(command).n, 0);
  assert.deepEqual(
    { ...context.sqlite.prepare("SELECT quantity,version FROM holdings").get() },
    { quantity: 4, version: 2 },
  );
});

test("not-collected release frees stock without a loan and supports partial release", async () => {
  const context = openDatabase();
  const request = await createRequest(context, 3);
  await store.applyLibrarianMaterialRequestAction(context.db, librarian, request.id, {
    requestId: commandId(), expectedVersion: request.version, action: "ready",
    pickupLocationId: "LOC-205", dueAt: "2026-09-30",
    items: [{
      itemId: request.items[0].id, approvedQuantity: 3,
      sourceLocationId: "LOC-LIB", condition: "good", expectedAvailableQuantity: 5,
    }],
  });
  let prepared = await store.getMaterialRequest(context.db, request.id);
  const reservationId = prepared.items[0].reservations[0].id;
  const partial = await store.applyLibrarianMaterialRequestAction(context.db, librarian, request.id, {
    requestId: commandId(), expectedVersion: prepared.version, action: "release",
    reason: "Не забрано вчасно",
    items: [{ reservationId, quantity: 1 }],
  });
  assert.equal(partial.status, "partially_ready");
  assert.equal(context.sqlite.prepare("SELECT quantity FROM holdings").get().quantity, 5);
  assert.equal(context.sqlite.prepare("SELECT reserved_quantity FROM material_stock_totals").get().reserved_quantity, 2);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM loans").get().n, 0);

  prepared = await store.getMaterialRequest(context.db, request.id);
  const released = await store.applyLibrarianMaterialRequestAction(context.db, librarian, request.id, {
    requestId: commandId(), expectedVersion: prepared.version, action: "release",
    reason: "Замовлення не забрали",
    items: [{ reservationId, quantity: 2 }],
  });
  assert.equal(released.status, "cancelled");
  assert.equal(context.sqlite.prepare("SELECT reserved_quantity FROM material_stock_totals").get().reserved_quantity, 0);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM inventory_transactions").get().n, 0);
});

test("physical issue loses atomically when its reserved source is deactivated", async () => {
  const context = openDatabase();
  const request = await createRequest(context, 2);
  await store.applyLibrarianMaterialRequestAction(context.db, librarian, request.id, {
    requestId: commandId(), expectedVersion: request.version, action: "ready",
    pickupLocationId: "LOC-205", dueAt: null,
    items: [{
      itemId: request.items[0].id, approvedQuantity: 2,
      sourceLocationId: "LOC-LIB", condition: "good", expectedAvailableQuantity: 5,
    }],
  });
  const prepared = await store.getMaterialRequest(context.db, request.id);
  const reservation = prepared.items[0].reservations[0];
  const command = commandId();
  context.db.beforeBatch = () => {
    context.sqlite.prepare("UPDATE locations SET status='inactive' WHERE id='LOC-LIB'").run();
  };
  await assert.rejects(
    () => store.applyLibrarianMaterialRequestAction(context.db, librarian, request.id, {
      requestId: command, expectedVersion: prepared.version, action: "issue",
      issuedAt: "2026-08-13", dueAt: null,
      items: [{ reservationId: reservation.id, quantity: 2 }],
    }),
    (error) => error instanceof store.TeacherMaterialRequestError
      && error.code === "reservation_stock_conflict",
  );
  assert.equal(context.sqlite.prepare("SELECT issued_quantity FROM material_request_reservations").get().issued_quantity, 0);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM loans").get().n, 0);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM inventory_transactions").get().n, 0);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM mutation_commands WHERE id=?").get(command).n, 0);
  assert.equal(context.sqlite.prepare("SELECT status FROM material_requests WHERE id=?").get(request.id).status, "ready");
});

test("server rejects a future physical issue date", async () => {
  const context = openDatabase();
  const request = await createRequest(context, 1);
  await store.applyLibrarianMaterialRequestAction(context.db, librarian, request.id, {
    requestId: commandId(), expectedVersion: request.version, action: "ready",
    pickupLocationId: "LOC-205", dueAt: null,
    items: [{ itemId: request.items[0].id, approvedQuantity: 1,
      sourceLocationId: "LOC-LIB", condition: "good", expectedAvailableQuantity: 5 }],
  });
  const prepared = await store.getMaterialRequest(context.db, request.id);
  await assert.rejects(
    () => store.applyLibrarianMaterialRequestAction(context.db, librarian, request.id, {
      requestId: commandId(), expectedVersion: prepared.version, action: "issue",
      issuedAt: "2999-01-01", dueAt: null,
      items: [{ reservationId: prepared.items[0].reservations[0].id, quantity: 1 }],
    }),
    (error) => error instanceof store.TeacherMaterialRequestError
      && error.code === "invalid_issue_date" && error.status === 400,
  );
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM loans").get().n, 0);
});

test("legacy ready request completes without issuing or decrementing stock twice", async () => {
  const context = openDatabase();
  const now = "2026-08-13T08:00:00.000Z";
  context.sqlite.exec(`
    UPDATE holdings SET quantity=3,version=2 WHERE material_id='CAT-0001' AND location_id='LOC-LIB' AND condition='good';
    UPDATE material_stock_totals SET total_quantity=5,library_quantity=3,loaned_quantity=2,reserved_quantity=0
      WHERE material_id='CAT-0001';
    INSERT INTO loans(id,teacher_user_id,status,issued_at,due_at,closed_at,notes,issued_by_user_id,
      closed_by_user_id,version,created_at,updated_at)
      VALUES('LOAN-LEGACY','USR-T1','open','2026-08-12','2026-09-01',NULL,'','USR-LIB',NULL,1,'${now}','${now}');
    INSERT INTO loan_items(id,loan_id,material_id,source_location_id,condition,quantity_issued,
      quantity_returned,notes,created_at,updated_at)
      VALUES('LI-LEGACY','LOAN-LEGACY','CAT-0001','LOC-LIB','good',2,0,'','${now}','${now}');
    INSERT INTO material_requests(id,teacher_user_id,status,teacher_notes,librarian_note,rejection_reason,
      pickup_location_id,resulting_loan_id,due_at,reviewed_by_user_id,cancelled_by_user_id,version,
      submitted_at,ready_at,completed_at,rejected_at,cancelled_at,created_at,updated_at)
      VALUES('MR-LEGACY','USR-T1','ready','','','', 'LOC-205','LOAN-LEGACY','2026-09-01','USR-LIB',NULL,2,
        '${now}','${now}',NULL,NULL,NULL,'${now}','${now}');
    INSERT INTO material_request_items(id,request_id,material_id,title_snapshot,author_snapshot,
      requested_quantity,approved_quantity,fulfilled_quantity,sort_order,created_at,updated_at)
      VALUES('MRI-LEGACY','MR-LEGACY','CAT-0001','Алгебра','Автор',2,2,2,0,'${now}','${now}');
  `);
  const command = commandId();
  const result = await store.applyLibrarianMaterialRequestAction(context.db, librarian, "MR-LEGACY", {
    requestId: command, expectedVersion: 2, action: "complete",
  });
  assert.equal(result.status, "completed");
  assert.equal(context.sqlite.prepare("SELECT status FROM material_requests WHERE id='MR-LEGACY'").get().status, "completed");
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM loans WHERE teacher_user_id='USR-T1'").get().n, 1);
  assert.equal(context.sqlite.prepare("SELECT quantity FROM holdings WHERE material_id='CAT-0001' AND location_id='LOC-LIB'").get().quantity, 3);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM material_request_reservations WHERE request_id='MR-LEGACY'").get().n, 0);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE request_id=?").get(command).n, 1);
});

test("librarian revocation between pre-read and batch leaves reservation untouched", async () => {
  const context = openDatabase();
  const request = await createRequest(context, 1);
  const command = commandId();
  context.db.beforeBatch = () => {
    context.sqlite.prepare("UPDATE users SET status='inactive' WHERE id='USR-LIB'").run();
  };
  await assert.rejects(
    () => store.applyLibrarianMaterialRequestAction(context.db, librarian, request.id, {
      requestId: command, expectedVersion: request.version, action: "ready",
      pickupLocationId: "LOC-205", dueAt: null,
      items: [{
        itemId: request.items[0].id, approvedQuantity: 1,
        sourceLocationId: "LOC-LIB", condition: "good", expectedAvailableQuantity: 5,
      }],
    }),
    (error) => error instanceof store.TeacherMaterialRequestError
      && error.code === "actor_access_revoked" && error.status === 403,
  );
  assert.equal(context.sqlite.prepare("SELECT status FROM material_requests WHERE id=?").get(request.id).status, "submitted");
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM material_request_reservations").get().n, 0);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM portal_notifications").get().n, 0);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM mutation_commands WHERE id=?").get(command).n, 0);
});

test("librarian role downgrade between pre-read and batch leaves reservation untouched", async () => {
  const context = openDatabase();
  const request = await createRequest(context, 1);
  const command = commandId();
  context.db.beforeBatch = () => {
    context.sqlite.prepare("UPDATE users SET role='teacher' WHERE id='USR-LIB'").run();
  };
  await assert.rejects(
    () => store.applyLibrarianMaterialRequestAction(context.db, librarian, request.id, {
      requestId: command, expectedVersion: request.version, action: "ready",
      pickupLocationId: "LOC-205", dueAt: null,
      items: [{
        itemId: request.items[0].id, approvedQuantity: 1,
        sourceLocationId: "LOC-LIB", condition: "good", expectedAvailableQuantity: 5,
      }],
    }),
    (error) => error instanceof store.TeacherMaterialRequestError
      && error.code === "actor_access_revoked" && error.status === 403,
  );
  assert.equal(context.sqlite.prepare("SELECT status FROM material_requests WHERE id=?").get(request.id).status, "submitted");
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM material_request_reservations").get().n, 0);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM portal_notifications").get().n, 0);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM mutation_commands WHERE id=?").get(command).n, 0);
});

test("ten-item prepare and issue stay within the hosted D1 batch ceiling", async () => {
  const context = openDatabase();
  const now = "2026-08-13T08:00:00.000Z";
  for (let index = 2; index <= 10; index += 1) {
    const id = `CAT-${String(index).padStart(4, "0")}`;
    context.sqlite.prepare(`INSERT INTO materials (
      id,catalog_number,title,sort_title,search_text,rubric,publication_type,
      subject,class_from,class_to,author,publication_year,isbn,isbn_normalized,
      publisher,notes,status,version,created_at,updated_at,archived_at
    ) SELECT ?,?,title||?,sort_title||?,search_text,rubric,publication_type,
      subject,class_from,class_to,author,publication_year,'','','','',status,1,?,?,NULL
      FROM materials WHERE id='CAT-0001'`).run(id, index, ` ${index}`, ` ${index}`, now, now);
    context.sqlite.prepare(`INSERT INTO holdings
      (material_id,location_id,condition,quantity,version,updated_at)
      VALUES (?,'LOC-LIB','good',5,1,?)`).run(id, now);
    context.sqlite.prepare(`INSERT INTO material_stock_totals
      (material_id,total_quantity,library_quantity,other_location_quantity,loaned_quantity,reserved_quantity,updated_at)
      VALUES (?,5,5,0,0,0,?)`).run(id, now);
  }
  const request = await store.createTeacherMaterialRequest(context.db, teacher, {
    requestId: commandId(), notes: null,
    items: Array.from({ length: 10 }, (_, index) => ({
      materialId: `CAT-${String(index + 1).padStart(4, "0")}`,
      quantity: 1,
    })),
  });
  await store.applyLibrarianMaterialRequestAction(context.db, librarian, request.id, {
    requestId: commandId(), expectedVersion: request.version, action: "ready",
    pickupLocationId: "LOC-205", dueAt: "2026-09-30",
    items: request.items.map((item) => ({
      itemId: item.id, approvedQuantity: 1, sourceLocationId: "LOC-LIB",
      condition: "good", expectedAvailableQuantity: 5,
    })),
  });
  const prepared = await store.getMaterialRequest(context.db, request.id);
  await store.applyLibrarianMaterialRequestAction(context.db, librarian, request.id, {
    requestId: commandId(), expectedVersion: prepared.version, action: "issue",
    issuedAt: "2026-08-13", dueAt: "2026-09-30",
    items: prepared.items.map((item) => ({
      reservationId: item.reservations[0].id,
      quantity: 1,
    })),
  });
  assert.ok(Math.max(...context.db.batchStatementCounts) <= 50, context.db.batchStatementCounts);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM loan_items").get().n, 10);
  assert.equal(context.sqlite.prepare("SELECT SUM(reserved_quantity) AS n FROM material_stock_totals").get().n, 0);
});

test("zero-row races roll back cancel, transition, and notification mutations", async () => {
  const cancelContext = openDatabase();
  const cancelRequest = await createRequest(cancelContext, 1);
  const cancelCommand = commandId();
  cancelContext.db.beforeBatch = () => {
    cancelContext.sqlite.prepare("UPDATE material_requests SET version=version+1 WHERE id=?").run(cancelRequest.id);
  };
  await assert.rejects(
    () => store.cancelTeacherMaterialRequest(cancelContext.db, teacher, cancelRequest.id, {
      requestId: cancelCommand, expectedVersion: cancelRequest.version, reason: null,
    }),
    (error) => error instanceof store.TeacherMaterialRequestError
      && error.code === "request_version_conflict",
  );
  assert.equal(cancelContext.sqlite.prepare("SELECT status FROM material_requests WHERE id=?").get(cancelRequest.id).status, "submitted");
  assert.equal(cancelContext.sqlite.prepare("SELECT COUNT(*) AS n FROM mutation_commands WHERE id=?").get(cancelCommand).n, 0);

  const transitionContext = openDatabase();
  const transitionRequest = await createRequest(transitionContext, 1);
  const transitionCommand = commandId();
  transitionContext.db.beforeBatch = () => {
    transitionContext.sqlite.prepare("UPDATE material_requests SET version=version+1 WHERE id=?").run(transitionRequest.id);
  };
  await assert.rejects(
    () => store.applyLibrarianMaterialRequestAction(transitionContext.db, librarian, transitionRequest.id, {
      requestId: transitionCommand, expectedVersion: transitionRequest.version, action: "start_review",
    }),
    (error) => error instanceof store.TeacherMaterialRequestError
      && error.code === "request_version_conflict",
  );
  assert.equal(transitionContext.sqlite.prepare("SELECT status FROM material_requests WHERE id=?").get(transitionRequest.id).status, "submitted");
  assert.equal(transitionContext.sqlite.prepare("SELECT COUNT(*) AS n FROM portal_notifications").get().n, 0);
  assert.equal(transitionContext.sqlite.prepare("SELECT COUNT(*) AS n FROM mutation_commands WHERE id=?").get(transitionCommand).n, 0);

  const notificationContext = openDatabase();
  const notificationRequest = await createRequest(notificationContext, 1);
  await store.applyLibrarianMaterialRequestAction(notificationContext.db, librarian, notificationRequest.id, {
    requestId: commandId(), expectedVersion: notificationRequest.version, action: "start_review",
  });
  const notification = (await store.listTeacherNotifications(notificationContext.db, "USR-T1")).notifications[0];
  const notificationCommand = commandId();
  notificationContext.db.beforeBatch = () => {
    notificationContext.sqlite.prepare("UPDATE portal_notifications SET version=version+1 WHERE id=?").run(notification.id);
  };
  await assert.rejects(
    () => store.markTeacherNotificationRead(notificationContext.db, teacher, notification.id, {
      requestId: notificationCommand, expectedVersion: notification.version, read: true,
    }),
    (error) => error instanceof store.TeacherMaterialRequestError
      && error.code === "notification_update_conflict",
  );
  assert.equal(notificationContext.sqlite.prepare("SELECT read_at FROM portal_notifications WHERE id=?").get(notification.id).read_at, null);
  assert.equal(notificationContext.sqlite.prepare("SELECT COUNT(*) AS n FROM mutation_commands WHERE id=?").get(notificationCommand).n, 0);
});

test("teacher session revocation races roll back create, cancel, and notification read", async () => {
  const createContext = openDatabase();
  const createCommand = commandId();
  createContext.db.beforeBatch = () => {
    createContext.sqlite.prepare("UPDATE visit_teacher_sessions SET revoked_at='2026-08-13T09:00:00.000Z'").run();
  };
  await assert.rejects(
    () => store.createTeacherMaterialRequest(createContext.db, teacher, {
      requestId: createCommand, notes: null, items: [{ materialId: "CAT-0001", quantity: 1 }],
    }),
    (error) => error instanceof store.TeacherMaterialRequestError
      && error.code === "teacher_access_revoked" && error.status === 401,
  );
  assert.equal(createContext.sqlite.prepare("SELECT COUNT(*) AS n FROM material_requests").get().n, 0);
  assert.equal(createContext.sqlite.prepare("SELECT COUNT(*) AS n FROM mutation_commands WHERE id=?").get(createCommand).n, 0);

  const cancelContext = openDatabase();
  const cancellable = await createRequest(cancelContext, 1);
  const cancelCommand = commandId();
  cancelContext.db.beforeBatch = () => {
    cancelContext.sqlite.prepare("UPDATE visit_teacher_sessions SET revoked_at='2026-08-13T09:00:00.000Z'").run();
  };
  await assert.rejects(
    () => store.cancelTeacherMaterialRequest(cancelContext.db, teacher, cancellable.id, {
      requestId: cancelCommand, expectedVersion: cancellable.version, reason: null,
    }),
    (error) => error instanceof store.TeacherMaterialRequestError
      && error.code === "teacher_access_revoked" && error.status === 401,
  );
  assert.equal(cancelContext.sqlite.prepare("SELECT status FROM material_requests WHERE id=?").get(cancellable.id).status, "submitted");
  assert.equal(cancelContext.sqlite.prepare("SELECT COUNT(*) AS n FROM mutation_commands WHERE id=?").get(cancelCommand).n, 0);

  const notificationContext = openDatabase();
  const request = await createRequest(notificationContext, 1);
  await store.applyLibrarianMaterialRequestAction(notificationContext.db, librarian, request.id, {
    requestId: commandId(), expectedVersion: request.version, action: "start_review",
  });
  const notification = (await store.listTeacherNotifications(notificationContext.db, "USR-T1")).notifications[0];
  const notificationCommand = commandId();
  notificationContext.db.beforeBatch = () => {
    notificationContext.sqlite.prepare("UPDATE visit_teacher_sessions SET revoked_at='2026-08-13T09:00:00.000Z'").run();
  };
  await assert.rejects(
    () => store.markTeacherNotificationRead(notificationContext.db, teacher, notification.id, {
      requestId: notificationCommand, expectedVersion: notification.version, read: true,
    }),
    (error) => error instanceof store.TeacherMaterialRequestError
      && error.code === "teacher_access_revoked" && error.status === 401,
  );
  assert.equal(notificationContext.sqlite.prepare("SELECT read_at FROM portal_notifications WHERE id=?").get(notification.id).read_at, null);
  assert.equal(notificationContext.sqlite.prepare("SELECT COUNT(*) AS n FROM mutation_commands WHERE id=?").get(notificationCommand).n, 0);
});

test("same-clock competing librarian transitions cannot complete the losing command", async () => {
  const fixedNow = "2026-08-13T12:00:00.000Z";
  const NativeDate = globalThis.Date;
  class FixedDate extends NativeDate {
    constructor(...args) {
      super(args.length > 0 ? args[0] : fixedNow);
    }
    static now() { return NativeDate.parse(fixedNow); }
  }
  globalThis.Date = FixedDate;
  try {
    for (const scenario of [
      { action: "start_review", winnerStatus: "in_review", extraSql: "" },
      {
        action: "reject",
        winnerStatus: "rejected",
        extraSql: ",rejected_at='2026-08-13T12:00:00.000Z',rejection_reason='Інша причина'",
      },
    ]) {
      const context = openDatabase();
      const request = await createRequest(context, 1);
      const command = commandId();
      const eventsBefore = context.sqlite.prepare("SELECT COUNT(*) AS n FROM material_request_events").get().n;
      context.db.beforeBatch = () => {
        context.sqlite.prepare(`UPDATE material_requests SET status=?,version=2,
          reviewed_by_user_id='USR-LIB',updated_at=? ${scenario.extraSql} WHERE id=?`)
          .run(scenario.winnerStatus, fixedNow, request.id);
      };
      await assert.rejects(
        () => store.applyLibrarianMaterialRequestAction(context.db, librarian, request.id, {
          requestId: command,
          expectedVersion: 1,
          action: scenario.action,
          ...(scenario.action === "reject" ? { reason: "Наша причина" } : {}),
        }),
        (error) => error instanceof store.TeacherMaterialRequestError
          && error.code === "request_version_conflict",
      );
      assert.equal(context.sqlite.prepare("SELECT status FROM material_requests WHERE id=?").get(request.id).status, scenario.winnerStatus);
      assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM material_request_events").get().n, eventsBefore);
      assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM mutation_commands WHERE id=?").get(command).n, 0);
    }

    const completeContext = openDatabase();
    const request = await createRequest(completeContext, 1);
    const ready = await store.applyLibrarianMaterialRequestAction(completeContext.db, librarian, request.id, {
      requestId: commandId(), expectedVersion: request.version, action: "ready",
      pickupLocationId: "LOC-205", dueAt: null,
      items: [{
        itemId: request.items[0].id, approvedQuantity: 1,
        sourceLocationId: "LOC-LIB", condition: "good", expectedAvailableQuantity: 5,
      }],
    });
    const completeCommand = commandId();
    const eventsBefore = completeContext.sqlite.prepare("SELECT COUNT(*) AS n FROM material_request_events").get().n;
    completeContext.db.beforeBatch = () => {
      completeContext.sqlite.prepare(`UPDATE material_requests SET status='completed',version=?,
        completed_at=?,reviewed_by_user_id='USR-LIB',updated_at=? WHERE id=?`)
        .run(ready.version + 1, fixedNow, fixedNow, request.id);
    };
    await assert.rejects(
      () => store.applyLibrarianMaterialRequestAction(completeContext.db, librarian, request.id, {
        requestId: completeCommand, expectedVersion: ready.version, action: "complete",
      }),
      (error) => error instanceof store.TeacherMaterialRequestError
        && error.code === "request_version_conflict",
    );
    assert.equal(completeContext.sqlite.prepare("SELECT status FROM material_requests WHERE id=?").get(request.id).status, "completed");
    assert.equal(completeContext.sqlite.prepare("SELECT COUNT(*) AS n FROM material_request_events").get().n, eventsBefore);
    assert.equal(completeContext.sqlite.prepare("SELECT COUNT(*) AS n FROM mutation_commands WHERE id=?").get(completeCommand).n, 0);
  } finally {
    globalThis.Date = NativeDate;
  }
});

test("ready exact-zero race rolls back without relying on sqlite changes()", async () => {
  const context = openDatabase();
  const request = await createRequest(context, 5);
  const command = commandId();
  context.db.beforeBatch = () => {
    context.sqlite.prepare("UPDATE holdings SET quantity=4,version=2 WHERE material_id='CAT-0001'").run();
  };
  await assert.rejects(
    () => store.applyLibrarianMaterialRequestAction(context.db, librarian, request.id, {
      requestId: command, expectedVersion: request.version, action: "ready",
      pickupLocationId: "LOC-205", dueAt: null,
      items: [{
        itemId: request.items[0].id, approvedQuantity: 5,
        sourceLocationId: "LOC-LIB", condition: "good", expectedAvailableQuantity: 5,
      }],
    }),
    (error) => error instanceof store.TeacherMaterialRequestError
      && error.code === "reservation_stock_conflict",
  );
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM loans").get().n, 0);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM inventory_transactions").get().n, 0);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM inventory_transaction_lines").get().n, 0);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM portal_notifications").get().n, 0);
  assert.equal(context.sqlite.prepare("SELECT status FROM material_requests WHERE id=?").get(request.id).status, "submitted");
});

test("material request store contains no cross-statement changes() dependency", () => {
  const source = fs.readFileSync(path.join(root, "lib/teacher-material-request-store.ts"), "utf8");
  assert.doesNotMatch(source, /changes\s*\(/u);
});

test("teacher requests, librarian queue, and notifications paginate without gaps", async () => {
  const requestContext = openDatabase();
  const now = "2026-08-13T10:00:00.000Z";
  for (let index = 0; index < 5; index += 1) {
    const requestId = `MRQ-PAGE-${String(index).padStart(2, "0")}`;
    requestContext.sqlite.prepare(`INSERT INTO material_requests (
      id,teacher_user_id,status,teacher_notes,librarian_note,rejection_reason,
      pickup_location_id,resulting_loan_id,reviewed_by_user_id,cancelled_by_user_id,
      version,submitted_at,ready_at,completed_at,rejected_at,cancelled_at,created_at,updated_at
    ) VALUES (?,?,'submitted','','','',NULL,NULL,NULL,NULL,1,?,NULL,NULL,NULL,NULL,?,?)`)
      .run(requestId, "USR-T1", now, now, now);
    requestContext.sqlite.prepare(`INSERT INTO material_request_items (
      id,request_id,material_id,title_snapshot,author_snapshot,requested_quantity,
      approved_quantity,fulfilled_quantity,sort_order,created_at,updated_at
    ) VALUES (?,?,'CAT-0001',?,'Автор',?,NULL,0,?, ?, ?)`)
      .run(`MRI-PAGE-${index}`, requestId, `Назва ${index}`, index + 1, index, now, now);
  }
  const teacherFirst = await store.listTeacherMaterialRequestPage(
    requestContext.db, "USR-T1", { limit: 2 },
  );
  const teacherSecond = await store.listTeacherMaterialRequestPage(
    requestContext.db, "USR-T1", { limit: 2, cursor: teacherFirst.page.nextCursor },
  );
  const teacherThird = await store.listTeacherMaterialRequestPage(
    requestContext.db, "USR-T1", { limit: 2, cursor: teacherSecond.page.nextCursor },
  );
  const teacherIds = [...teacherFirst.requests, ...teacherSecond.requests, ...teacherThird.requests]
    .map((request) => request.id);
  assert.equal(new Set(teacherIds).size, 5);
  assert.equal(teacherThird.page.hasMore, false);
  assert.equal(teacherThird.page.nextCursor, null);
  const teacherQuantitySort = await store.listTeacherMaterialRequestPage(
    requestContext.db, "USR-T1", { limit: 2, sort: "quantity_desc" },
  );
  assert.deepEqual(
    teacherQuantitySort.requests.map((request) => request.items[0].requestedQuantity),
    [5, 4],
  );
  const teacherSearch = await store.listTeacherMaterialRequestPage(
    requestContext.db, "USR-T1", { query: "Назва 4" },
  );
  assert.deepEqual(teacherSearch.requests.map((request) => request.id), ["MRQ-PAGE-04"]);

  const librarianFirst = await store.listLibrarianMaterialRequests(requestContext.db, { limit: 2 });
  const librarianSecond = await store.listLibrarianMaterialRequests(requestContext.db, {
    limit: 2, cursor: librarianFirst.page.nextCursor,
  });
  const librarianThird = await store.listLibrarianMaterialRequests(requestContext.db, {
    limit: 2, cursor: librarianSecond.page.nextCursor,
  });
  const librarianIds = [...librarianFirst.requests, ...librarianSecond.requests, ...librarianThird.requests]
    .map((request) => request.id);
  assert.equal(new Set(librarianIds).size, 5);
  assert.equal(librarianThird.page.hasMore, false);

  requestContext.sqlite.prepare("UPDATE material_requests SET status='rejected',rejected_at=? WHERE id='MRQ-PAGE-00'").run(now);
  const hidden = await store.setLibrarianMaterialRequestVisibility(
    requestContext.db, librarian, "MRQ-PAGE-00", true, commandId(),
  );
  assert.equal(hidden.hidden, true);
  assert.equal((await store.listLibrarianMaterialRequests(requestContext.db, { visibility: "visible" })).requests.some((request) => request.id === "MRQ-PAGE-00"), false);
  assert.equal((await store.listLibrarianMaterialRequests(requestContext.db, { visibility: "all" })).requests.some((request) => request.id === "MRQ-PAGE-00"), true);
  await store.setLibrarianMaterialRequestVisibility(requestContext.db, librarian, "MRQ-PAGE-00", false, commandId());
  await assert.rejects(
    () => store.setLibrarianMaterialRequestVisibility(requestContext.db, librarian, "MRQ-PAGE-01", true, commandId()),
    (error) => error instanceof store.TeacherMaterialRequestError && error.code === "request_not_terminal",
  );

  for (let index = 0; index < 5; index += 1) {
    requestContext.sqlite.prepare(`INSERT INTO portal_notifications (
      id,teacher_user_id,dedupe_key,type,title,message,entity_type,entity_id,
      read_at,version,created_at,updated_at
    ) VALUES (?,? ,?,'test','Title','Message','material_request',?,NULL,1,?,?)`)
      .run(`NTF-PAGE-${index}`, "USR-T1", `page-${index}`, `MRQ-PAGE-${index}`, now, now);
  }
  const notificationFirst = await store.listTeacherNotifications(requestContext.db, "USR-T1", { limit: 2 });
  const notificationSecond = await store.listTeacherNotifications(requestContext.db, "USR-T1", {
    limit: 2, cursor: notificationFirst.page.nextCursor,
  });
  const notificationThird = await store.listTeacherNotifications(requestContext.db, "USR-T1", {
    limit: 2, cursor: notificationSecond.page.nextCursor,
  });
  const notificationIds = [
    ...notificationFirst.notifications,
    ...notificationSecond.notifications,
    ...notificationThird.notifications,
  ].map((notification) => notification.id);
  assert.equal(new Set(notificationIds).size, 5);
  assert.equal(notificationThird.page.hasMore, false);
  await assert.rejects(
    () => store.listTeacherMaterialRequestPage(requestContext.db, "USR-T1", { cursor: "bad" }),
    (error) => error.code === "invalid_cursor" && error.status === 400,
  );
});

test("omitted ready items become zero and teacher cancellation is owner scoped", async () => {
  const context = openDatabase();
  context.sqlite.prepare(`INSERT INTO materials (
    id,catalog_number,title,sort_title,search_text,rubric,publication_type,
    subject,class_from,class_to,author,publication_year,isbn,isbn_normalized,
    publisher,notes,status,version,created_at,updated_at,archived_at
  ) SELECT 'CAT-0002',2,'Геометрія','геометрія','геометрія',rubric,publication_type,
    subject,7,7,author,publication_year,'','','','',status,1,created_at,updated_at,NULL
    FROM materials WHERE id='CAT-0001'`).run();
  context.sqlite.prepare(`INSERT INTO material_stock_totals
    (material_id,total_quantity,library_quantity,other_location_quantity,loaned_quantity,updated_at)
    VALUES ('CAT-0002',0,0,0,0,'2026-08-13T08:00:00.000Z')`).run();
  const request = await store.createTeacherMaterialRequest(context.db, teacher, {
    requestId: commandId(), notes: null,
    items: [
      { materialId: "CAT-0001", quantity: 2 },
      { materialId: "CAT-0002", quantity: 1 },
    ],
  });
  await store.applyLibrarianMaterialRequestAction(context.db, librarian, request.id, {
    requestId: commandId(), expectedVersion: 1, action: "ready",
    pickupLocationId: "LOC-205", dueAt: null,
    items: [{
      itemId: request.items[0].id, approvedQuantity: 2,
      sourceLocationId: "LOC-LIB", condition: "good", expectedAvailableQuantity: 5,
    }],
  });
  const rows = context.sqlite.prepare(`SELECT material_id,approved_quantity,fulfilled_quantity
    FROM material_request_items ORDER BY sort_order`).all();
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { material_id: "CAT-0001", approved_quantity: 2, fulfilled_quantity: 0 },
    { material_id: "CAT-0002", approved_quantity: 0, fulfilled_quantity: 0 },
  ]);

  const cancellable = await createRequest(context, 1);
  const cancelled = await store.cancelTeacherMaterialRequest(context.db, teacher, cancellable.id, {
    requestId: commandId(), expectedVersion: cancellable.version, reason: null,
  });
  assert.equal(cancelled.status, "cancelled");
  await assert.rejects(
    () => store.cancelTeacherMaterialRequest(
      context.db,
      { ...teacher, teacherUserId: "USR-OTHER" },
      cancellable.id,
      { requestId: commandId(), expectedVersion: cancelled.version, reason: null },
    ),
    (error) => error.code === "teacher_access_revoked",
  );
});
