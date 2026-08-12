import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const academic = await import(
  pathToFileURL(path.join(root, "lib/academic-admin-store.ts")).href
);
const validation = await import(
  pathToFileURL(path.join(root, "lib/academic-admin-validation.ts")).href
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
    return { success: true, results: this.database.sqlite.prepare(this.sql).all(...this.bindings) };
  }

  execute() {
    this.database.queryCount += 1;
    return { success: true, results: this.database.sqlite.prepare(this.sql).all(...this.bindings) };
  }
}

class TestD1 {
  constructor(sqlite) {
    this.sqlite = sqlite;
    this.beforeBatch = null;
    this.lastBatchStatementCount = 0;
    this.queryCount = 0;
  }

  prepare(sql) {
    return new PreparedStatement(this, sql);
  }

  async batch(statements) {
    this.lastBatchStatementCount = statements.length;
    if (this.beforeBatch) {
      const callback = this.beforeBatch;
      this.beforeBatch = null;
      callback();
    }
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
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of [
    "0000_librarian_drafts.sql",
    "0001_draft_workflow.sql",
    "0002_remove_legacy_audit_triggers.sql",
    "0003_odd_the_order.sql",
    "0005_young_night_nurse.sql",
  ]) {
    const sql = fs.readFileSync(path.join(root, "drizzle", file), "utf8");
    for (const statement of sql.split(/-->\s*statement-breakpoint/gu)) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }
  seedDirectory(sqlite);
  return { sqlite, d1: new TestD1(sqlite) };
}

function seedDirectory(sqlite) {
  const now = "2026-08-11T08:00:00.000Z";
  sqlite.prepare(`
    INSERT INTO users (
      id, full_name, sort_name, email, auth_user_id, role, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'librarian', 'active', ?, ?)
  `).run("USR-LIB", "Назарій Швець", "швець назарій", "librarian@example.com", "auth-librarian", now, now);
  sqlite.prepare(`
    INSERT INTO users (
      id, full_name, sort_name, email, auth_user_id, role, status, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, NULL, 'teacher', 'active', ?, ?)
  `).run("USR-TCH", "Ірина Вчитель", "вчитель ірина", now, now);
  sqlite.prepare(`
    INSERT INTO locations (
      id, name, type, status, is_public, sort_order, created_at, updated_at
    ) VALUES ('LOC-002', 'Кабінет 2', 'classroom', 'active', 1, 2, ?, ?)
  `).run(now, now);
}

function seedRollover(sqlite) {
  const now = "2026-08-11T08:00:00.000Z";
  sqlite.exec(`
    INSERT INTO academic_years (
      id, label, start_date, end_date, status, notes, version, created_at, updated_at
    ) VALUES
      ('YR-2026-2027', '2026/2027', '2026-09-01', '2027-08-31', 'active', '', 1, '${now}', '${now}'),
      ('YR-2027-2028', '2027/2028', '2027-09-01', '2028-08-31', 'draft', '', 1, '${now}', '${now}');
    INSERT INTO cohorts (id, status, notes, created_at, updated_at) VALUES
      ('COH-001', 'active', '', '${now}', '${now}'),
      ('COH-002', 'active', '', '${now}', '${now}');
    INSERT INTO class_years (
      id, academic_year_id, cohort_id, class_name, grade, code,
      teacher_user_id, location_id, start_date, end_date, status,
      actual_closed_date, notes, version, created_at, updated_at
    ) VALUES
      ('CY-2026-001', 'YR-2026-2027', 'COH-001', '10-А', 10, 'А',
       'USR-TCH', 'LOC-002', '2026-09-01', '2027-08-31', 'active', NULL, '', 1, '${now}', '${now}'),
      ('CY-2026-002', 'YR-2026-2027', 'COH-002', '11-Б', 11, 'Б',
       'USR-TCH', 'LOC-002', '2026-09-01', '2027-08-31', 'active', NULL, '', 1, '${now}', '${now}');
  `);
}

function seedOpenClassLoan(sqlite, classYearId, id = "CLOAN-BLOCK") {
  const now = "2026-09-10T08:00:00.000Z";
  sqlite.prepare(`
    INSERT INTO class_loans (
      id, class_year_id, responsible_teacher_user_id, status,
      issued_at, due_at, closed_at, notes, issued_by_user_id,
      closed_by_user_id, version, created_at, updated_at
    ) VALUES (?, ?, 'USR-TCH', 'open', '2026-09-10', NULL, NULL, '',
      'USR-LIB', NULL, 1, ?, ?)
  `).run(id, classYearId, now, now);
}

function seedLargeRollover(sqlite, count = 26) {
  const now = "2026-08-11T08:00:00.000Z";
  sqlite.prepare(`
    INSERT INTO academic_years (
      id, label, start_date, end_date, status, notes, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, '', 1, ?, ?)
  `).run("YR-2026-2027", "2026/2027", "2026-09-01", "2027-08-31", "active", now, now);
  sqlite.prepare(`
    INSERT INTO academic_years (
      id, label, start_date, end_date, status, notes, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, '', 1, ?, ?)
  `).run("YR-2027-2028", "2027/2028", "2027-09-01", "2028-08-31", "draft", now, now);
  const insertCohort = sqlite.prepare(`
    INSERT INTO cohorts (id, status, notes, created_at, updated_at)
    VALUES (?, 'active', '', ?, ?)
  `);
  const insertClass = sqlite.prepare(`
    INSERT INTO class_years (
      id, academic_year_id, cohort_id, class_name, grade, code,
      teacher_user_id, location_id, start_date, end_date, status,
      actual_closed_date, notes, version, created_at, updated_at
    ) VALUES (?, 'YR-2026-2027', ?, ?, ?, ?, 'USR-TCH', 'LOC-002',
      '2026-09-01', '2027-08-31', 'active', NULL, '', 1, ?, ?)
  `);
  const classes = [];
  for (let index = 1; index <= count; index += 1) {
    const suffix = String(index).padStart(3, "0");
    const cohortId = `COH-${suffix}`;
    const sourceClassYearId = `CY-2026-${suffix}`;
    const grade = 1 + ((index - 1) % 10);
    const code = `G${suffix}`;
    insertCohort.run(cohortId, now, now);
    insertClass.run(sourceClassYearId, cohortId, `${grade}-${code}`, grade, code, now, now);
    classes.push({
      sourceClassYearId,
      expectedVersion: 1,
      cohortId,
      sourceGrade: grade,
      action: "promote",
      targetGrade: grade + 1,
      targetCode: code,
    });
  }
  return classes;
}

const actor = {
  userId: "auth-librarian",
  displayName: "Назарій Швець",
  email: "librarian@example.com",
  fullName: "Назарій Швець",
};

const request = (suffix) => `10000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

test("academic validation is exact, optimistic and rollover-complete", () => {
  const year = validation.validateAcademicYearCreateInput({
    requestId: request(1),
    label: "2027/2028",
    startDate: "2027-09-01",
    endDate: "2028-08-31",
    notes: "",
  });
  assert.equal(year.ok, true);
  const invalidYear = validation.validateAcademicYearCreateInput({
    requestId: request(2),
    label: "2027/2029",
    startDate: "2027-09-01",
    endDate: "2029-08-31",
    notes: "",
    unsafe: true,
  });
  assert.equal(invalidYear.ok, false);
  assert.ok(invalidYear.fieldErrors.label);
  assert.ok(invalidYear.fieldErrors.unsafe);

  const rollover = validation.validateAcademicYearRolloverInput({
    requestId: request(3),
    sourceYearId: "YR-2026-2027",
    sourceYearVersion: 1,
    targetYearId: "YR-2027-2028",
    targetYearVersion: 1,
    effectiveDate: "2027-09-01",
    notes: "",
    classes: [{
      sourceClassYearId: "cy-2026-001",
      expectedVersion: 1,
      cohortId: "coh-001",
      sourceGrade: 10,
      action: "promote",
      targetGrade: 11,
      targetCode: "А",
    }],
  });
  assert.equal(rollover.ok, true);
  assert.equal(rollover.value.classes[0].sourceClassYearId, "CY-2026-001");
  assert.equal(rollover.value.classes[0].cohortId, "COH-001");
});

test("year and class mutations write directly, replay once and preserve audit", async () => {
  const { sqlite, d1 } = openDatabase();
  const yearInput = {
    requestId: request(10),
    label: "2026/2027",
    startDate: "2026-09-01",
    endDate: "2027-08-31",
    notes: "Перший рік",
  };
  const year = await academic.createAcademicYearDirect(actor, yearInput, d1);
  assert.deepEqual(await academic.createAcademicYearDirect(actor, yearInput, d1), year);
  assert.equal(year.status, "active");
  const nextYear = await academic.createAcademicYearDirect(actor, {
    requestId: request(8),
    label: "2027/2028",
    startDate: "2027-09-01",
    endDate: "2028-08-31",
    notes: "Наступний рік",
  }, d1);
  assert.equal(nextYear.status, "draft");
  await assert.rejects(
    academic.createClassYearDirect(actor, {
      requestId: request(9),
      academicYearId: nextYear.academicYearId,
      cohortMode: "new",
      cohortId: null,
      grade: 1,
      code: "А",
      teacherUserId: "USR-TCH",
      locationId: "LOC-002",
      notes: "",
    }, d1),
    (error) => error instanceof academic.AcademicAdminError
      && error.code === "academic_year_not_active",
  );
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM class_years").get().count, 0);

  const classInput = {
    requestId: request(11),
    academicYearId: year.academicYearId,
    cohortMode: "new",
    cohortId: null,
    grade: 11,
    code: "А",
    teacherUserId: "USR-TCH",
    locationId: "LOC-002",
    notes: "",
  };
  const created = await academic.createClassYearDirect(actor, classInput, d1);
  assert.deepEqual(await academic.createClassYearDirect(actor, classInput, d1), created);
  assert.equal(created.className, "11-А");
  assert.equal(created.status, "active");

  const updated = await academic.updateClassYearDirect(actor, created.classYearId, {
    requestId: request(12),
    expectedVersion: 1,
    reason: "Зміна кабінету",
    changes: { code: "Б", locationId: null, notes: "Оновлено" },
  }, d1);
  assert.equal(updated.className, "11-Б");
  assert.equal(updated.version, 2);
  assert.deepEqual(
    { ...sqlite.prepare("SELECT class_name, location_id, notes, version FROM class_years WHERE id = ?").get(created.classYearId) },
    { class_name: "11-Б", location_id: null, notes: "Оновлено", version: 2 },
  );

  const closed = await academic.closeClassYearDirect(actor, created.classYearId, {
    requestId: request(13),
    expectedVersion: 2,
    actualClosedDate: "2027-06-30",
    reason: "graduated",
    closeCohort: true,
    notes: "Завершено",
  }, d1);
  assert.equal(closed.status, "closed");
  assert.equal(sqlite.prepare("SELECT status FROM cohorts WHERE id = ?").get(created.cohortId).status, "graduated");
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM mutation_commands").get().count, 5);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM audit_events").get().count, 7);

  const reference = await academic.readAcademicReferenceData(d1);
  assert.equal(reference.academicYears.find((item) => item.id === year.academicYearId).version, 1);
  assert.equal(reference.classYears[0].teacherName, "Ірина Вчитель");
  assert.equal(reference.classYears[0].status, "closed");
});

test("first-year activation is atomic when another first year wins the race", async () => {
  const { sqlite, d1 } = openDatabase();
  d1.beforeBatch = () => {
    const now = "2026-08-11T08:00:00.000Z";
    sqlite.prepare(`
      INSERT INTO academic_years (
        id, label, start_date, end_date, status, notes, version, created_at, updated_at
      ) VALUES ('YR-2025-2026', '2025/2026', '2025-09-01', '2026-08-31', 'active', '', 1, ?, ?)
    `).run(now, now);
  };
  await assert.rejects(
    academic.createAcademicYearDirect(actor, {
      requestId: request(14),
      label: "2026/2027",
      startDate: "2026-09-01",
      endDate: "2027-08-31",
      notes: "",
    }, d1),
    (error) => error instanceof academic.AcademicAdminError
      && error.code === "academic_year_conflict",
  );
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM academic_years").get().count, 1);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM mutation_commands").get().count, 0);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM audit_events").get().count, 0);
});

test("an active year with no open classes can roll over to an empty draft year", async () => {
  const { sqlite, d1 } = openDatabase();
  seedLargeRollover(sqlite, 0);
  const parsed = validation.validateAcademicYearRolloverInput({
    requestId: request(15),
    sourceYearId: "YR-2026-2027",
    sourceYearVersion: 1,
    targetYearId: "YR-2027-2028",
    targetYearVersion: 1,
    effectiveDate: "2027-09-01",
    notes: "empty rollover",
    classes: [],
  });
  assert.equal(parsed.ok, true);
  const result = await academic.rolloverAcademicYearDirect(actor, parsed.value, d1);
  assert.deepEqual(result.promoted, []);
  assert.equal(sqlite.prepare("SELECT status FROM academic_years WHERE id = 'YR-2026-2027'").get().status, "closed");
  assert.equal(sqlite.prepare("SELECT status FROM academic_years WHERE id = 'YR-2027-2028'").get().status, "active");
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM audit_events").get().count, 2);
});

test("manual class close loses atomically to a concurrent open class loan", async () => {
  const { sqlite, d1 } = openDatabase();
  seedRollover(sqlite);
  d1.beforeBatch = () => seedOpenClassLoan(sqlite, "CY-2026-001");
  await assert.rejects(
    academic.closeClassYearDirect(actor, "CY-2026-001", {
      requestId: request(16),
      expectedVersion: 1,
      actualClosedDate: "2027-06-30",
      reason: "manual",
      closeCohort: false,
      notes: "",
    }, d1),
    (error) => error instanceof academic.AcademicAdminError
      && error.code === "class_has_open_loans"
      && error.details.classYearId === "CY-2026-001",
  );
  assert.equal(sqlite.prepare("SELECT status FROM class_years WHERE id = 'CY-2026-001'").get().status, "active");
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM mutation_commands").get().count, 0);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM audit_events").get().count, 0);
});

test("rollover loses atomically to a concurrent open class loan", async () => {
  const { sqlite, d1 } = openDatabase();
  seedRollover(sqlite);
  d1.beforeBatch = () => seedOpenClassLoan(sqlite, "CY-2026-002");
  await assert.rejects(
    academic.rolloverAcademicYearDirect(actor, {
      requestId: request(17),
      sourceYearId: "YR-2026-2027",
      sourceYearVersion: 1,
      targetYearId: "YR-2027-2028",
      targetYearVersion: 1,
      effectiveDate: "2027-09-01",
      notes: "",
      classes: [
        {
          sourceClassYearId: "CY-2026-001",
          expectedVersion: 1,
          cohortId: "COH-001",
          sourceGrade: 10,
          action: "promote",
          targetGrade: 11,
          targetCode: "А",
        },
        {
          sourceClassYearId: "CY-2026-002",
          expectedVersion: 1,
          cohortId: "COH-002",
          sourceGrade: 11,
          action: "graduate",
        },
      ],
    }, d1),
    (error) => error instanceof academic.AcademicAdminError
      && error.code === "class_has_open_loans"
      && error.details.classYearId === "CY-2026-002",
  );
  assert.equal(sqlite.prepare("SELECT status FROM academic_years WHERE id = 'YR-2026-2027'").get().status, "active");
  assert.equal(sqlite.prepare("SELECT status FROM academic_years WHERE id = 'YR-2027-2028'").get().status, "draft");
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM class_years WHERE academic_year_id = 'YR-2027-2028'").get().count, 0);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM mutation_commands").get().count, 0);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM audit_events").get().count, 0);
});

test("rollover covers every class in one atomic replayable command", async () => {
  const { sqlite, d1 } = openDatabase();
  seedRollover(sqlite);
  const input = {
    requestId: request(20),
    sourceYearId: "YR-2026-2027",
    sourceYearVersion: 1,
    targetYearId: "YR-2027-2028",
    targetYearVersion: 1,
    effectiveDate: "2027-09-01",
    notes: "Плановий перехід",
    classes: [
      {
        sourceClassYearId: "CY-2026-001",
        expectedVersion: 1,
        cohortId: "COH-001",
        sourceGrade: 10,
        action: "promote",
        targetGrade: 11,
        targetCode: "А",
      },
      {
        sourceClassYearId: "CY-2026-002",
        expectedVersion: 1,
        cohortId: "COH-002",
        sourceGrade: 11,
        action: "graduate",
      },
    ],
  };
  const first = await academic.rolloverAcademicYearDirect(actor, input, d1);
  const replay = await academic.rolloverAcademicYearDirect(actor, input, d1);
  assert.deepEqual(replay, first);
  assert.equal(first.promoted.length, 1);
  assert.deepEqual(first.graduated, ["CY-2026-002"]);
  assert.deepEqual(
    sqlite.prepare("SELECT status FROM academic_years WHERE id = 'YR-2026-2027'").get().status,
    "closed",
  );
  assert.equal(sqlite.prepare("SELECT status FROM academic_years WHERE id = 'YR-2027-2028'").get().status, "active");
  assert.deepEqual(
    { ...sqlite.prepare("SELECT class_name, grade, cohort_id, status FROM class_years WHERE academic_year_id = 'YR-2027-2028'").get() },
    { class_name: "11-А", grade: 11, cohort_id: "COH-001", status: "active" },
  );
  assert.equal(sqlite.prepare("SELECT status FROM cohorts WHERE id = 'COH-002'").get().status, "graduated");
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM mutation_commands").get().count, 1);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM audit_events").get().count, 6);
});

test("a rollover race rolls back its command and every partial academic write", async () => {
  const { sqlite, d1 } = openDatabase();
  seedRollover(sqlite);
  d1.beforeBatch = () => {
    sqlite.prepare("UPDATE class_years SET notes = 'Паралельна зміна', version = 2 WHERE id = 'CY-2026-001'").run();
  };
  await assert.rejects(
    academic.rolloverAcademicYearDirect(actor, {
      requestId: request(30),
      sourceYearId: "YR-2026-2027",
      sourceYearVersion: 1,
      targetYearId: "YR-2027-2028",
      targetYearVersion: 1,
      effectiveDate: "2027-09-01",
      notes: "",
      classes: [
        {
          sourceClassYearId: "CY-2026-001",
          expectedVersion: 1,
          cohortId: "COH-001",
          sourceGrade: 10,
          action: "promote",
          targetGrade: 11,
          targetCode: "А",
        },
        {
          sourceClassYearId: "CY-2026-002",
          expectedVersion: 1,
          cohortId: "COH-002",
          sourceGrade: 11,
          action: "graduate",
        },
      ],
    }, d1),
    (error) => error instanceof academic.AcademicAdminError
      && error.code === "rollover_conflict",
  );
  assert.equal(sqlite.prepare("SELECT status FROM academic_years WHERE id = 'YR-2026-2027'").get().status, "active");
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM class_years WHERE academic_year_id = 'YR-2027-2028'").get().count, 0);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM mutation_commands").get().count, 0);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM audit_events").get().count, 0);
});

test("a concurrent target-year class is preserved but aborts the entire rollover", async () => {
  const { sqlite, d1 } = openDatabase();
  seedRollover(sqlite);
  d1.beforeBatch = () => {
    const now = "2027-08-31T23:59:59.000Z";
    sqlite.prepare("INSERT INTO cohorts (id, status, notes, created_at, updated_at) VALUES ('COH-003', 'active', '', ?, ?)").run(now, now);
    sqlite.prepare(`
      INSERT INTO class_years (
        id, academic_year_id, cohort_id, class_name, grade, code,
        teacher_user_id, location_id, start_date, end_date, status,
        actual_closed_date, notes, version, created_at, updated_at
      ) VALUES (
        'CY-2027-099', 'YR-2027-2028', 'COH-003', '7-В', 7, 'В',
        'USR-TCH', 'LOC-002', '2027-09-01', '2028-08-31', 'planned',
        NULL, 'Паралельне створення', 1, ?, ?
      )
    `).run(now, now);
  };

  await assert.rejects(
    academic.rolloverAcademicYearDirect(actor, {
      requestId: request(31),
      sourceYearId: "YR-2026-2027",
      sourceYearVersion: 1,
      targetYearId: "YR-2027-2028",
      targetYearVersion: 1,
      effectiveDate: "2027-09-01",
      notes: "",
      classes: [
        {
          sourceClassYearId: "CY-2026-001",
          expectedVersion: 1,
          cohortId: "COH-001",
          sourceGrade: 10,
          action: "promote",
          targetGrade: 11,
          targetCode: "А",
        },
        {
          sourceClassYearId: "CY-2026-002",
          expectedVersion: 1,
          cohortId: "COH-002",
          sourceGrade: 11,
          action: "graduate",
        },
      ],
    }, d1),
    (error) => error instanceof academic.AcademicAdminError
      && error.code === "rollover_conflict",
  );
  assert.equal(sqlite.prepare("SELECT status FROM academic_years WHERE id = 'YR-2026-2027'").get().status, "active");
  assert.equal(sqlite.prepare("SELECT status FROM academic_years WHERE id = 'YR-2027-2028'").get().status, "draft");
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM class_years WHERE academic_year_id = 'YR-2027-2028'").get().count, 1);
  assert.equal(sqlite.prepare("SELECT notes FROM class_years WHERE id = 'CY-2027-099'").get().notes, "Паралельне створення");
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM mutation_commands").get().count, 0);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM audit_events").get().count, 0);
});

test("a concurrent cross-year open class for the same cohort aborts rollover atomically", async () => {
  const { sqlite, d1 } = openDatabase();
  seedRollover(sqlite);
  d1.beforeBatch = () => {
    const now = "2027-08-31T23:59:59.000Z";
    sqlite.prepare(`
      INSERT INTO academic_years (
        id, label, start_date, end_date, status, notes, version, created_at, updated_at
      ) VALUES ('YR-2028-2029', '2028/2029', '2028-09-01', '2029-08-31', 'draft', '', 1, ?, ?)
    `).run(now, now);
    sqlite.prepare(`
      INSERT INTO class_years (
        id, academic_year_id, cohort_id, class_name, grade, code,
        teacher_user_id, location_id, start_date, end_date, status,
        actual_closed_date, notes, version, created_at, updated_at
      ) VALUES (
        'CY-2028-099', 'YR-2028-2029', 'COH-001', '11-X', 11, 'X',
        'USR-TCH', 'LOC-002', '2028-09-01', '2029-08-31', 'planned',
        NULL, 'concurrent cross-year class', 1, ?, ?
      )
    `).run(now, now);
  };

  await assert.rejects(
    academic.rolloverAcademicYearDirect(actor, {
      requestId: request(32),
      sourceYearId: "YR-2026-2027",
      sourceYearVersion: 1,
      targetYearId: "YR-2027-2028",
      targetYearVersion: 1,
      effectiveDate: "2027-09-01",
      notes: "",
      classes: [
        {
          sourceClassYearId: "CY-2026-001",
          expectedVersion: 1,
          cohortId: "COH-001",
          sourceGrade: 10,
          action: "promote",
          targetGrade: 11,
          targetCode: "Рђ",
        },
        {
          sourceClassYearId: "CY-2026-002",
          expectedVersion: 1,
          cohortId: "COH-002",
          sourceGrade: 11,
          action: "graduate",
        },
      ],
    }, d1),
    (error) => error instanceof academic.AcademicAdminError
      && error.code === "rollover_conflict",
  );
  assert.equal(sqlite.prepare("SELECT status FROM academic_years WHERE id = 'YR-2026-2027'").get().status, "active");
  assert.equal(sqlite.prepare("SELECT status FROM academic_years WHERE id = 'YR-2027-2028'").get().status, "draft");
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM class_years WHERE id = 'CY-2028-099'").get().count, 1);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM mutation_commands").get().count, 0);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM audit_events").get().count, 0);
});

test("real 26-class and maximum 100-class rollovers stay within the D1 Free query budget", async () => {
  const { sqlite, d1 } = openDatabase();
  const classes = seedLargeRollover(sqlite, 26);
  const result = await academic.rolloverAcademicYearDirect(actor, {
    requestId: request(33),
    sourceYearId: "YR-2026-2027",
    sourceYearVersion: 1,
    targetYearId: "YR-2027-2028",
    targetYearVersion: 1,
    effectiveDate: "2027-09-01",
    notes: "26-class budget fixture",
    classes,
  }, d1);

  assert.equal(result.promoted.length, 26);
  assert.ok(d1.lastBatchStatementCount <= 16, `batch used ${d1.lastBatchStatementCount} statements`);
  assert.ok(d1.queryCount <= 50, `request used ${d1.queryCount} D1 queries`);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM audit_events").get().count, 54);

  const maximum = openDatabase();
  const maximumClasses = seedLargeRollover(maximum.sqlite, 100);
  const maximumResult = await academic.rolloverAcademicYearDirect(actor, {
    requestId: request(34),
    sourceYearId: "YR-2026-2027",
    sourceYearVersion: 1,
    targetYearId: "YR-2027-2028",
    targetYearVersion: 1,
    effectiveDate: "2027-09-01",
    notes: "100-class budget fixture",
    classes: maximumClasses,
  }, maximum.d1);
  assert.equal(maximumResult.promoted.length, 100);
  assert.ok(maximum.d1.lastBatchStatementCount <= 16, `maximum batch used ${maximum.d1.lastBatchStatementCount} statements`);
  assert.ok(maximum.d1.queryCount <= 50, `maximum request used ${maximum.d1.queryCount} D1 queries`);
});

test("academic routes keep authentication, same-origin, write and bounded-body gates", () => {
  const routes = [
    "app/api/librarian/academic-years/route.ts",
    "app/api/librarian/class-years/route.ts",
    "app/api/librarian/class-years/[id]/route.ts",
    "app/api/librarian/class-years/[id]/close/route.ts",
    "app/api/librarian/academic-years/rollover/route.ts",
  ];
  for (const relative of routes) {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    assert.match(source, /authorizeLibrarianApi\(\)/u);
    assert.match(source, /if \(!access\.writesEnabled\)/u);
    assert.match(source, /isSameOriginRequest\(request\)/u);
    assert.match(source, /readDraftJsonBody\(request/u);
  }
});
