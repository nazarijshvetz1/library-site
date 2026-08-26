import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationFiles = [
  "drizzle/0000_librarian_drafts.sql",
  "drizzle/0001_draft_workflow.sql",
  "drizzle/0002_remove_legacy_audit_triggers.sql",
  "drizzle/0003_odd_the_order.sql",
  "drizzle/0004_staging_import_runs.sql",
  "drizzle/0005_young_night_nurse.sql",
  "drizzle/0006_pale_sauron.sql",
  "drizzle/0007_cold_whiplash.sql",
  "drizzle/0008_sudden_thunderbird.sql",
  "drizzle/0009_happy_silver_samurai.sql",
  "drizzle/0010_shocking_cobalt_man.sql",
  "drizzle/0011_normalize_holding_conditions.sql",
  "drizzle/0012_elite_victor_mancha.sql",
  "drizzle/0013_strange_dark_beast.sql",
  "drizzle/0014_rich_lionheart.sql",
  "drizzle/0015_glamorous_namora.sql",
  "drizzle/0016_busy_jane_foster.sql",
  "drizzle/0017_fresh_robbie_robertson.sql",
  "drizzle/0018_yielding_skaar.sql",
  "drizzle/0019_kindly_wolfsbane.sql",
  "drizzle/0020_pretty_squadron_sinister.sql",
  "drizzle/0021_optional_student_acquisition_metadata.sql",
  "drizzle/0022_teacher_curator_change_requests.sql",
  "drizzle/0023_guest_public_teacher_name_consent.sql",
  "drizzle/0024_watery_miss_america.sql",
  "drizzle/0025_lying_lucky_pierre.sql",
  "drizzle/0026_typical_scalphunter.sql",
];

async function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  for (const file of migrationFiles) {
    database.exec(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
  }
  return database;
}

test("0026 adds reversible teacher history visibility without changing existing requests", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  for (const file of migrationFiles.slice(0, migrationFiles.indexOf("drizzle/0026_typical_scalphunter.sql"))) {
    database.exec(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
  }
  const now = "2026-08-26T08:00:00.000Z";
  database.exec(`
    INSERT INTO users (id,full_name,sort_name,email,auth_user_id,role,status,created_at,updated_at)
      VALUES ('USR-T','Учитель Тестовий','учитель тестовий',NULL,NULL,'teacher','active','${now}','${now}');
    INSERT INTO materials (id,catalog_number,title,sort_title,search_text,rubric,publication_type,subject,class_from,class_to,author,publication_year,isbn,isbn_normalized,publisher,notes,status,version,created_at,updated_at)
      VALUES ('CAT-0001',1,'Матеріал','матеріал','матеріал','Підручники','Підручник','',NULL,NULL,'',NULL,'','','','','active',1,'${now}','${now}');
    INSERT INTO material_requests (id,teacher_user_id,status,teacher_notes,librarian_note,rejection_reason,version,submitted_at,created_at,updated_at)
      VALUES ('MR-1','USR-T','submitted','','','',1,'${now}','${now}','${now}');
    INSERT INTO material_request_items (id,request_id,material_id,title_snapshot,author_snapshot,requested_quantity,approved_quantity,fulfilled_quantity,sort_order,created_at,updated_at)
      VALUES ('MRI-1','MR-1','CAT-0001','Матеріал','',1,1,1,0,'${now}','${now}');
    INSERT INTO material_request_events (id,request_id,actor_user_id,actor_kind,kind,from_status,to_status,metadata_json,created_at)
      VALUES ('MRE-1','MR-1','USR-T','teacher','submitted',NULL,'submitted',NULL,'${now}');
  `);
  database.exec(await readFile(new URL("../drizzle/0026_typical_scalphunter.sql", import.meta.url), "utf8"));
  assert.deepEqual(
    { ...database.prepare("SELECT id,teacher_hidden_at FROM material_requests WHERE id='MR-1'").get() },
    { id: "MR-1", teacher_hidden_at: null },
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM material_request_items WHERE request_id='MR-1'").get().n, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM material_request_events WHERE request_id='MR-1'").get().n, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM pragma_index_list('material_requests') WHERE name='idx_material_requests_teacher_hidden'").get().n, 1);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});

test("0021 keeps existing acquisition requests and child events while loosening only student metadata", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  for (const file of migrationFiles.slice(
    0,
    migrationFiles.indexOf("drizzle/0021_optional_student_acquisition_metadata.sql"),
  )) {
    database.exec(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
  }
  const now = "2026-08-23T10:00:00.000Z";
  database.prepare(`INSERT INTO users (id,full_name,sort_name,email,auth_user_id,role,status,created_at,updated_at)
    VALUES ('USR-ACQ-TEACHER','Учитель','учитель',NULL,NULL,'teacher','active',?,?)`).run(now, now);
  database.prepare(`INSERT INTO academic_years (id,label,start_date,end_date,status,notes,version,created_at,updated_at)
    VALUES ('YR-ACQ','2026/2027','2026-09-01','2027-05-31','active','',1,?,?)`).run(now, now);
  database.prepare(`INSERT INTO acquisition_requests (
    id,public_number,submission_key,submission_hash,requester_kind,teacher_user_id,requester_name,
    category,source_kind,title,author,publication_year,requested_quantity,source_url,subject,target_class,
    duplicate_key,academic_year_id,academic_year_label,submitted_at,created_at,updated_at
  ) VALUES ('ACQ-PRE-MIGRATION','ACQ-OLD','teacher:old','${"a".repeat(64)}','teacher','USR-ACQ-TEACHER','Учитель',
    'educational','manual','Алгебра','Автор',2024,2,'https://example.test/book','Математика','7-А',
    'text:алгебра|автор|2024','YR-ACQ','2026/2027',?,?,?)`).run(now, now, now);
  database.prepare(`INSERT INTO acquisition_request_events (id,request_id,actor_user_id,actor_kind,kind,from_status,to_status,metadata_json,created_at)
    VALUES ('AQE-PRE-MIGRATION','ACQ-PRE-MIGRATION','USR-ACQ-TEACHER','teacher','submitted',NULL,'submitted','{}',?)`).run(now);

  database.exec(await readFile(new URL("../drizzle/0021_optional_student_acquisition_metadata.sql", import.meta.url), "utf8"));
  assert.equal(database.prepare("SELECT COUNT(*) count FROM acquisition_requests WHERE id='ACQ-PRE-MIGRATION'").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) count FROM acquisition_request_events WHERE request_id='ACQ-PRE-MIGRATION'").get().count, 1);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  const yearColumn = database.prepare("SELECT * FROM pragma_table_info('acquisition_requests') WHERE name='publication_year'").get();
  assert.equal(yearColumn.notnull, 0);
  database.close();
});

async function databaseBeforeConditionNormalization() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  for (const file of migrationFiles.slice(0, migrationFiles.indexOf("drizzle/0011_normalize_holding_conditions.sql"))) {
    database.exec(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
  }
  return database;
}

async function databaseBeforeVersion35() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  for (const file of migrationFiles.slice(0, migrationFiles.indexOf("drizzle/0016_busy_jane_foster.sql"))) {
    database.exec(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
  }
  return database;
}

function seedVersion35ProductionShape(database, { driftName = false } = {}) {
  const now = "2026-08-22T10:00:00.000Z";
  database.exec(`
    INSERT INTO users (id, full_name, sort_name, email, auth_user_id, role, status, created_at, updated_at) VALUES
      ('USR-006', 'Орел Галина Миколаївна', 'орел галина миколаївна', NULL, NULL, 'admin', 'active', '${now}', '${now}'),
      ('USR-007', 'Галака Наталія Григорівна', 'галака наталія григорівна', NULL, NULL, 'admin', 'active', '${now}', '${now}'),
      ('USR-008', 'Єгорова Олена Ігорівна', 'єгорова олена ігорівна', NULL, NULL, 'admin', 'active', '${now}', '${now}'),
      ('USR-009', '${driftName ? "Інша Особа" : "Плахотнюк Володимир Віталійович"}', 'плахотнюк володимир віталійович', NULL, NULL, 'admin', 'active', '${now}', '${now}');
    INSERT INTO academic_years (id, label, start_date, end_date, status, notes, version, created_at, updated_at) VALUES
      ('YR-2026-2027', '2026/2027', '2026-09-01', '2027-08-31', 'active', '', 1, '${now}', '${now}'),
      ('YR-2027-2028', '2027/2028', '2027-09-01', '2028-08-31', 'draft', '', 1, '${now}', '${now}');
    INSERT INTO cohorts (id, status, notes, created_at, updated_at) VALUES
      ('COH-035', 'active', '', '${now}', '${now}'),
      ('COH-036', 'active', '', '${now}', '${now}');
    INSERT INTO class_years (
      id, academic_year_id, cohort_id, class_name, grade, code, teacher_user_id,
      location_id, start_date, end_date, status, actual_closed_date, notes,
      version, created_at, updated_at
    ) VALUES
      ('CY-2026-035', 'YR-2026-2027', 'COH-035', '10-U(1)', 10, 'U(1)', 'USR-008', NULL,
       '2026-09-01', '2027-08-31', 'active', NULL, 'Куратор: Єгорова Олена Ігорівна', 1, '${now}', '${now}'),
      ('CY-2027-036', 'YR-2027-2028', 'COH-036', '11-U(1)', 11, 'U(1)', 'USR-008', NULL,
       '2027-09-01', '2028-08-31', 'planned', NULL, '', 1, '${now}', '${now}');
  `);
}

async function applyVersion35(database) {
  const sql = await readFile(new URL("../drizzle/0016_busy_jane_foster.sql", import.meta.url), "utf8");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(sql);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

async function databaseBeforeVersion38Data() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  for (const file of migrationFiles.slice(0, migrationFiles.indexOf("drizzle/0019_kindly_wolfsbane.sql"))) {
    database.exec(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
  }
  return database;
}

function seedVersion38ProductionShape(database, { driftClassVersion = false } = {}) {
  const now = "2026-08-22T21:00:00.000Z";
  database.exec(`
    INSERT INTO users (id,full_name,sort_name,email,auth_user_id,role,status,created_at,updated_at) VALUES
      ('USR-001','Швець Назарій Миколайович','швець назарій миколайович','nazarijshvetz1@gmail.com',NULL,'admin','active','${now}','${now}'),
      ('USR-006','Орел Галина Миколаївна','орел галина миколаївна',NULL,NULL,'admin','active','${now}','${now}'),
      ('USR-007','Галака Наталія Григорівна','галака наталія григорівна',NULL,NULL,'admin','active','${now}','${now}'),
      ('USR-008','Єгорова Альона Ігорівна','єгорова альона ігорівна',NULL,NULL,'admin','active','${now}','${now}'),
      ('USR-009','Плахотнюк Володимир Віталійович','плахотнюк володимир віталійович','w.plah@ukr.net',NULL,'admin','active','${now}','${now}');
    INSERT INTO teacher_profiles (teacher_user_id,created_at,updated_at) VALUES
      ('USR-006','${now}','${now}'),('USR-007','${now}','${now}'),
      ('USR-008','${now}','${now}'),('USR-009','${now}','${now}');
    INSERT INTO academic_years (id,label,start_date,end_date,status,notes,version,created_at,updated_at)
      VALUES ('YR-2026-2027','2026/2027','2026-09-01','2027-05-31','active','Поточний навчальний рік',2,'${now}','${now}');
    INSERT INTO cohorts (id,status,notes,created_at,updated_at)
      VALUES ('COH-001','closed','2026/2027: 1-А','${now}','${now}');
    INSERT INTO class_years (id,academic_year_id,cohort_id,class_name,grade,code,teacher_user_id,
      location_id,start_date,end_date,status,actual_closed_date,notes,version,created_at,updated_at)
      VALUES ('CY-2026-001','YR-2026-2027','COH-001','1-А',1,'А',NULL,NULL,
        '2026-09-01','2027-05-31','closed','2026-09-01','',${driftClassVersion ? 4 : 3},'${now}','${now}');
    INSERT INTO telegram_librarian_sessions (token_hash,init_data_hash,user_id,telegram_user_id,
      auth_date,expires_at,last_seen_at,revoked_at,created_at)
      VALUES ('${"a".repeat(64)}','${"b".repeat(64)}','USR-006','7001',1787432400,
        '2026-08-23T09:00:00.000Z','${now}',NULL,'${now}');
    INSERT INTO telegram_delivery_outbox (id,recipient_user_id,dedupe_key,category,type,title,message,
      target_path,entity_type,entity_id,status,attempts,next_attempt_at,created_at,updated_at)
      VALUES ('TGO-V38-STAFF','USR-006','version38:staff','system','test','Службове','Службове',
        '/librarian','user','USR-006','pending',0,'${now}','${now}','${now}');
  `);
}

async function applyVersion38Data(database) {
  const sql = await readFile(new URL("../drizzle/0019_kindly_wolfsbane.sql", import.meta.url), "utf8");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(sql);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

async function applyConditionNormalization(database) {
  const sql = await readFile(
    new URL("../drizzle/0011_normalize_holding_conditions.sql", import.meta.url),
    "utf8",
  );
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(sql);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function seedDirectories(database) {
  const now = "2026-08-11T10:00:00.000Z";
  database.exec(`
    INSERT INTO users (
      id, full_name, sort_name, email, auth_user_id, role, status, created_at, updated_at
    ) VALUES
      ('USR-001', 'Бібліотекар', 'Бібліотекар', 'library@example.test', 'auth-library', 'librarian', 'active', '${now}', '${now}'),
      ('USR-002', 'Учитель', 'Учитель', 'teacher@example.test', 'auth-teacher', 'teacher', 'active', '${now}', '${now}');

    INSERT INTO locations (
      id, name, type, status, is_public, sort_order, created_at, updated_at
    ) VALUES ('LOC-001', 'Бібліотека', 'library', 'active', 1, 1, '${now}', '${now}');

    INSERT INTO materials (
      id, catalog_number, title, sort_title, search_text, rubric,
      publication_type, subject, class_from, class_to, author,
      publication_year, isbn, isbn_normalized, publisher, notes,
      status, version, created_at, updated_at
    ) VALUES (
      'CAT-0001', 1, 'Algebra basics', 'algebra basics',
      'algebra basics math', 'Підручники', 'Підручник', 'Математика',
      5, 5, 'Author', 2024, '9780000000001', '9780000000001',
      'Publisher', '', 'active', 1, '${now}', '${now}'
    );
  `);
}

test("version 35 adds teacher capability without removing administrator access and closes the year on May 31", async () => {
  const database = await databaseBeforeVersion35();
  seedVersion35ProductionShape(database);
  await applyVersion35(database);

  assert.deepEqual(
    database.prepare("SELECT id, role, full_name FROM users ORDER BY id").all().map((row) => ({ ...row })),
    [
      { id: "USR-006", role: "admin", full_name: "Орел Галина Миколаївна" },
      { id: "USR-007", role: "admin", full_name: "Галака Наталія Григорівна" },
      { id: "USR-008", role: "admin", full_name: "Єгорова Альона Ігорівна" },
      { id: "USR-009", role: "admin", full_name: "Плахотнюк Володимир Віталійович" },
    ],
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM teacher_profiles WHERE closed_at IS NULL").get().count, 4);
  assert.deepEqual(
    database.prepare("SELECT id, end_date FROM academic_years ORDER BY id").all().map((row) => ({ ...row })),
    [
      { id: "YR-2026-2027", end_date: "2027-05-31" },
      { id: "YR-2027-2028", end_date: "2028-05-31" },
    ],
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM class_years WHERE end_date LIKE '%-05-31'").get().count, 2);
  assert.equal(database.prepare("SELECT notes FROM class_years WHERE id='CY-2026-035'").get().notes, "Куратор: Єгорова Альона Ігорівна");
});

test("version 35 preflight rolls back every change when the audited administrator identities drift", async () => {
  const database = await databaseBeforeVersion35();
  seedVersion35ProductionShape(database, { driftName: true });
  await assert.rejects(() => applyVersion35(database));
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM teacher_profiles").get().count, 0);
  assert.equal(database.prepare("SELECT end_date FROM academic_years WHERE id='YR-2026-2027'").get().end_date, "2027-08-31");
  assert.equal(database.prepare("SELECT full_name FROM users WHERE id='USR-008'").get().full_name, "Єгорова Олена Ігорівна");
});

test("version 38 demotes the four audited staff profiles and reopens 1-А", async () => {
  const database = await databaseBeforeVersion38Data();
  seedVersion38ProductionShape(database);
  await applyVersion38Data(database);

  assert.deepEqual(
    database.prepare(`SELECT id,role,status FROM users
      WHERE id IN ('USR-006','USR-007','USR-008','USR-009') ORDER BY id`).all().map((row) => ({ ...row })),
    ["USR-006", "USR-007", "USR-008", "USR-009"].map((id) => ({ id, role: "teacher", status: "active" })),
  );
  assert.equal(database.prepare("SELECT role FROM users WHERE id='USR-001'").get().role, "admin");
  assert.equal(database.prepare("SELECT count(*) AS count FROM teacher_profiles WHERE closed_at IS NULL").get().count, 4);
  assert.deepEqual(
    { ...database.prepare("SELECT status,actual_closed_date,version FROM class_years WHERE id='CY-2026-001'").get() },
    { status: "active", actual_closed_date: null, version: 4 },
  );
  assert.equal(database.prepare("SELECT status FROM cohorts WHERE id='COH-001'").get().status, "active");
  assert.notEqual(database.prepare("SELECT revoked_at FROM telegram_librarian_sessions WHERE user_id='USR-006'").get().revoked_at, null);
  assert.deepEqual(
    { ...database.prepare("SELECT status,last_error_code FROM telegram_delivery_outbox WHERE id='TGO-V38-STAFF'").get() },
    { status: "dead", last_error_code: "recipient_role_changed" },
  );
  assert.equal(database.prepare("SELECT count(*) AS count FROM audit_events WHERE request_id LIKE 'VERSION-38-%'").get().count, 5);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(database.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name='__version38_production_guard'").get().count, 0);
  database.close();
});

test("version 38 preflight rolls back roles, class and Telegram state when live data drifts", async () => {
  const database = await databaseBeforeVersion38Data();
  seedVersion38ProductionShape(database, { driftClassVersion: true });
  await assert.rejects(() => applyVersion38Data(database), /constraint/i);

  assert.equal(database.prepare("SELECT count(*) AS count FROM users WHERE role='admin'").get().count, 5);
  assert.deepEqual(
    { ...database.prepare("SELECT status,actual_closed_date,version FROM class_years WHERE id='CY-2026-001'").get() },
    { status: "closed", actual_closed_date: "2026-09-01", version: 4 },
  );
  assert.equal(database.prepare("SELECT status FROM cohorts WHERE id='COH-001'").get().status, "closed");
  assert.equal(database.prepare("SELECT revoked_at FROM telegram_librarian_sessions WHERE user_id='USR-006'").get().revoked_at, null);
  assert.equal(database.prepare("SELECT status FROM telegram_delivery_outbox WHERE id='TGO-V38-STAFF'").get().status, "pending");
  assert.equal(database.prepare("SELECT count(*) AS count FROM audit_events WHERE request_id LIKE 'VERSION-38-%'").get().count, 0);
  database.close();
});

test("condition normalization moves every current holding to good with balanced history", async () => {
  const database = await databaseBeforeConditionNormalization();
  const now = "2026-08-20T10:00:00.000Z";
  database.exec(`
    INSERT INTO users (
      id, full_name, sort_name, email, auth_user_id, role, status, created_at, updated_at
    ) VALUES (
      'USR-001', 'Бібліотекар', 'Бібліотекар', 'library@example.test',
      'auth-library', 'librarian', 'active', '${now}', '${now}'
    );
    INSERT INTO locations (
      id, name, type, status, is_public, sort_order, created_at, updated_at
    ) VALUES ('LOC-001', 'Бібліотека', 'library', 'active', 1, 1, '${now}', '${now}');
  `);

  const insertMaterial = database.prepare(`
    INSERT INTO materials (
      id, catalog_number, title, sort_title, search_text, rubric,
      publication_type, subject, class_from, class_to, author,
      status, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '', '', '', '', NULL, NULL, '', 'active', 1, ?, ?)
  `);
  const insertHolding = database.prepare(`
    INSERT INTO holdings (material_id, location_id, condition, quantity, version, updated_at)
    VALUES (?, 'LOC-001', ?, ?, 1, ?)
  `);
  const insertStockTotal = database.prepare(`
    INSERT INTO material_stock_totals (
      material_id, total_quantity, library_quantity, other_location_quantity,
      loaned_quantity, reserved_quantity, updated_at
    ) VALUES (?, ?, ?, 0, 0, 0, ?)
  `);

  for (let index = 0; index < 1109; index += 1) {
    const materialId = `CAT-${String(index + 1).padStart(4, "0")}`;
    const title = `Матеріал ${index + 1}`;
    const target = index < 1088;
    const quantity = target
      ? (index === 0 ? 18054 : 1)
      : (index === 1088 ? 618 : 1);
    insertMaterial.run(materialId, index + 1, title, title.toLocaleLowerCase("uk-UA"), now, now);
    insertHolding.run(materialId, target ? "unspecified" : "good", quantity, now);
    insertStockTotal.run(materialId, quantity, quantity, now);
  }

  await applyConditionNormalization(database);

  assert.deepEqual(
    { ...database.prepare(`
      SELECT count(*) AS rows, sum(quantity) AS copies
      FROM holdings WHERE condition = 'good'
    `).get() },
    { rows: 1109, copies: 19779 },
  );
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM holdings WHERE condition <> 'good'").get().count,
    0,
  );
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM holdings WHERE version = 2").get().count,
    1088,
  );
  assert.deepEqual(
    { ...database.prepare(`
      SELECT
        count(*) AS rows,
        -sum(quantity_delta) AS copies
      FROM inventory_transaction_lines
      WHERE transaction_id = 'ITX-CONDITION-GOOD-20260820' AND quantity_delta < 0
    `).get() },
    { rows: 1088, copies: 19141 },
  );
  assert.deepEqual(
    database.prepare(`
      SELECT material_id, location_id, sum(quantity_delta) AS delta
      FROM inventory_transaction_lines
      WHERE transaction_id = 'ITX-CONDITION-GOOD-20260820'
      GROUP BY material_id, location_id
      HAVING sum(quantity_delta) <> 0
    `).all(),
    [],
  );
  const audit = database.prepare(`
    SELECT action, before_json, after_json
    FROM audit_events WHERE id = 'AUDIT-CONDITION-GOOD-20260820'
  `).get();
  assert.equal(audit.action, "holdings.condition_normalized");
  assert.deepEqual(JSON.parse(audit.before_json), {
    condition: "mixed",
    changedRows: 1088,
    changedCopies: 19141,
    totalRows: 1109,
    totalCopies: 19779,
  });
  assert.equal(JSON.parse(audit.after_json).condition, "good");
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.deepEqual(
    database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE name IN ('__condition_normalization_targets', '__condition_normalization_guard')
    `).all(),
    [],
  );
  database.close();
});

test("condition normalization fails closed when the audited production scope drifts", async () => {
  const database = await databaseBeforeConditionNormalization();
  seedDirectories(database);
  database.exec(`
    INSERT INTO holdings (material_id, location_id, condition, quantity, version, updated_at)
    VALUES ('CAT-0001', 'LOC-001', 'unspecified', 1, 1, '2026-08-20T10:00:00.000Z')
  `);

  await assert.rejects(() => applyConditionNormalization(database), /constraint/i);
  assert.deepEqual(
    { ...database.prepare("SELECT condition, quantity, version FROM holdings").get() },
    { condition: "unspecified", quantity: 1, version: 1 },
  );
  assert.equal(database.prepare("SELECT count(*) AS count FROM inventory_transactions").get().count, 0);
  assert.equal(database.prepare("SELECT count(*) AS count FROM audit_events").get().count, 0);
  assert.deepEqual(
    database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE name IN ('__condition_normalization_targets', '__condition_normalization_guard')
    `).all(),
    [],
  );
  database.close();
});

test("core migration extends the existing draft database without recreating it", async () => {
  const database = await migratedDatabase();
  const tableNames = database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);

  for (const name of [
    "academic_years",
    "audit_events",
    "class_years",
    "class_loan_items",
    "class_loan_transaction_lines",
    "class_loan_transactions",
    "class_loans",
    "class_loan_items",
    "class_loan_transaction_lines",
    "class_loan_transactions",
    "class_loans",
    "cohorts",
    "holdings",
    "inventory_transaction_lines",
    "inventory_transactions",
    "librarian_draft_events",
    "librarian_drafts",
    "loan_items",
    "loans",
    "locations",
    "material_cover_assets",
    "material_links",
    "material_request_events",
    "material_request_items",
    "material_requests",
    "material_stock_totals",
    "materials",
    "materials_fts",
    "migration_import_runs",
    "mutation_commands",
    "portal_notifications",
    "public_library_profile",
    "telegram_connections",
    "telegram_delivery_outbox",
    "telegram_librarian_sessions",
    "telegram_link_tokens",
    "telegram_mini_app_auth_receipts",
    "telegram_teacher_activation_invites",
    "telegram_webhook_updates",
    "teacher_profiles",
    "material_request_reservations",
    "users",
    "visit_bookings",
    "visit_guest_rate_limits",
    "visit_guest_sessions",
    "visit_mutation_commands",
    "visit_schedule_closures",
    "visit_schedule_hours",
    "visit_slot_claims",
    "visit_teacher_credentials",
    "visit_teacher_sessions",
    "visit_teacher_login_limits",
    "visit_teacher_access_commands",
  ]) {
    assert.ok(tableNames.includes(name), `missing table ${name}`);
  }

  assert.deepEqual(
    { ...database.prepare(`SELECT id,version FROM public_library_profile WHERE id='primary'`).get() },
    { id: "primary", version: 1 },
  );
  assert.equal(
    database.prepare("PRAGMA table_info('teacher_profiles')").all()
      .some((column) => column.name === "photo_storage_key"),
    true,
  );
  assert.equal(
    database.prepare("PRAGMA table_info('visit_teacher_credentials')").all()
      .some((column) => column.name === "code_expires_at"),
    true,
  );
  const publicTeacherNameConsent = database.prepare("PRAGMA table_info('visit_bookings')").all()
    .find((column) => column.name === "public_teacher_name_consent");
  assert.ok(publicTeacherNameConsent, "guest-name publication requires an explicit consent column");
  assert.equal(publicTeacherNameConsent.notnull, 1);
  assert.equal(publicTeacherNameConsent.dflt_value, "0");
  const notificationDeletedAt = database.prepare("PRAGMA table_info('portal_notifications')").all()
    .find((column) => column.name === "deleted_at");
  assert.ok(notificationDeletedAt, "portal notification soft-delete requires deleted_at");
  assert.equal(notificationDeletedAt.notnull, 0, "deleted_at must remain nullable for visible notifications");
  assert.equal(notificationDeletedAt.dflt_value, null, "existing notifications must remain visible after migration");

  const phaseOneSql = await readFile(
    new URL("../drizzle/0003_odd_the_order.sql", import.meta.url),
    "utf8",
  );
  const importRunSql = await readFile(
    new URL("../drizzle/0004_staging_import_runs.sql", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(phaseOneSql, /CREATE TABLE `librarian_drafts`/);
  assert.doesNotMatch(phaseOneSql, /CREATE TABLE `librarian_draft_events`/);
  assert.doesNotMatch(phaseOneSql, /CREATE\s+TRIGGER/iu);
  assert.deepEqual(
    database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'materials_fts_%'")
      .all(),
    [],
  );
  database.close();

  const tokenizedDatabase = new DatabaseSync(":memory:");
  tokenizedDatabase.exec("PRAGMA foreign_keys = ON;");
  for (const file of migrationFiles.slice(0, 3)) {
    tokenizedDatabase.exec(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
  }
  for (const token of phaseOneSql.split(";").map((value) => value.trim()).filter(Boolean)) {
    tokenizedDatabase.exec(`${token};`);
  }
  for (const token of importRunSql.split(";").map((value) => value.trim()).filter(Boolean)) {
    tokenizedDatabase.exec(`${token};`);
  }
  assert.equal(
    tokenizedDatabase
      .prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'materials_fts'")
      .get().count,
    1,
  );
  assert.equal(
    tokenizedDatabase
      .prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'migration_import_runs'")
      .get().count,
    1,
  );
  assert.deepEqual(
    tokenizedDatabase
      .prepare(`
        SELECT name FROM sqlite_schema
        WHERE type = 'index' AND tbl_name = 'migration_import_runs' AND sql IS NOT NULL
        ORDER BY name
      `)
      .all()
      .map((row) => row.name),
    [
      "idx_migration_import_runs_plan_sha256",
      "idx_migration_import_runs_status_expires",
    ],
  );
  tokenizedDatabase.close();
});

test("Telegram teacher activation grants keep personal tokens hashed and enforce terminal states", async () => {
  const database = await migratedDatabase();
  const now = "2026-08-22T10:00:00.000Z";
  const future = "2026-08-22T10:30:00.000Z";
  database.exec(`
    INSERT INTO users (id,full_name,sort_name,email,auth_user_id,role,status,created_at,updated_at) VALUES
      ('USR-LIB-TGA','Бібліотекар','бібліотекар','lib-tga@example.test','auth-lib-tga','librarian','active','${now}','${now}'),
      ('USR-TEACHER-TGA','Учитель','учитель',NULL,NULL,'teacher','active','${now}','${now}');
    INSERT INTO teacher_profiles (teacher_user_id,created_at,updated_at)
      VALUES ('USR-TEACHER-TGA','${now}','${now}');
    INSERT INTO visit_teacher_credentials (
      teacher_user_id,login_id,code_hmac,must_change_pin,status,version,failed_attempts,
      failure_window_started_at,locked_until,last_login_at,code_rotated_at,last_access_command_id,
      created_by_user_id,updated_by_user_id,created_at,updated_at
    ) VALUES ('USR-TEACHER-TGA','teacher-login-tga-0001','${"a".repeat(64)}',1,'active',1,0,
      NULL,NULL,NULL,'${now}',NULL,'USR-LIB-TGA','USR-LIB-TGA','${now}','${now}');
  `);
  database.prepare(`INSERT INTO telegram_teacher_activation_invites (
    id,kind,teacher_user_id,credential_version,token_hash,issued_by_user_id,request_id,
    bound_telegram_user_id,bound_chat_id,bound_username,bound_update_id,presented_at,
    expires_at,consumed_init_data_hash,consumed_at,revoked_at,created_at,updated_at
  ) VALUES ('TGA-schema-personal','personal','USR-TEACHER-TGA',1,?,'USR-LIB-TGA',?,
    NULL,NULL,NULL,NULL,NULL,?,NULL,NULL,NULL,?,?)`)
    .run("b".repeat(64), crypto.randomUUID(), future, now, now);
  database.prepare(`INSERT INTO telegram_teacher_activation_invites (
    id,kind,teacher_user_id,credential_version,token_hash,issued_by_user_id,request_id,
    bound_telegram_user_id,bound_chat_id,bound_username,bound_update_id,presented_at,
    expires_at,consumed_init_data_hash,consumed_at,revoked_at,created_at,updated_at
  ) VALUES ('TGA-schema-generic','generic',NULL,NULL,NULL,NULL,NULL,
    '7001','7001',NULL,'701','${now}',?,NULL,NULL,NULL,?,?)`)
    .run(future, now, now);
  assert.throws(() => database.prepare(`INSERT INTO telegram_teacher_activation_invites (
    id,kind,teacher_user_id,credential_version,token_hash,issued_by_user_id,request_id,
    expires_at,created_at,updated_at
  ) VALUES ('TGA-bad-token','personal','USR-TEACHER-TGA',1,'plain-token','USR-LIB-TGA',?,?,?,?)`)
    .run(crypto.randomUUID(), future, now, now), /telegram_teacher_activation_token_valid/u);
  assert.throws(() => database.prepare(`UPDATE telegram_teacher_activation_invites SET
    consumed_at=?,consumed_init_data_hash=NULL WHERE id='TGA-schema-generic'`).run(now),
  /telegram_teacher_activation_consumption_consistent/u);
  assert.throws(() => database.prepare(`UPDATE telegram_teacher_activation_invites SET
    consumed_at=?,consumed_init_data_hash=?,revoked_at=? WHERE id='TGA-schema-generic'`)
    .run(now, "c".repeat(64), now), /telegram_teacher_activation_terminal_state/u);
  const indexes = database.prepare("PRAGMA index_list('telegram_teacher_activation_invites')").all();
  assert.equal(indexes.some((index) => index.name === "idx_telegram_teacher_activation_token" && index.unique === 1), true);
  assert.equal(indexes.some((index) => index.name === "idx_telegram_teacher_activation_request" && index.unique === 1), true);
  database.close();
});

test("catalog and sparse stock constraints support an explicit FTS rebuild", async () => {
  const database = await migratedDatabase();
  seedDirectories(database);

  database.exec("INSERT INTO materials_fts(materials_fts) VALUES('rebuild')");

  assert.equal(
    database
      .prepare("SELECT count(*) AS count FROM materials_fts WHERE materials_fts MATCH 'algebra*'")
      .get().count,
    1,
  );

  assert.throws(() => database.exec(`
    INSERT INTO materials (
      id, catalog_number, title, sort_title, class_from, class_to,
      status, version, created_at, updated_at
    ) VALUES ('CAT-0002', 2, 'Bad range', 'bad range', 8, 5, 'active', 1, 'now', 'now')
  `), /constraint/i);

  assert.throws(() => database.exec(`
    INSERT INTO holdings (material_id, location_id, condition, quantity, version, updated_at)
    VALUES ('CAT-0001', 'LOC-001', 'good', 0, 1, 'now')
  `), /constraint/i);

  database.exec(`
    INSERT INTO holdings (material_id, location_id, condition, quantity, version, updated_at)
    VALUES ('CAT-0001', 'LOC-001', 'good', 4, 1, 'now');
    INSERT INTO material_stock_totals (
      material_id, total_quantity, library_quantity,
      other_location_quantity, loaned_quantity, updated_at
    ) VALUES ('CAT-0001', 5, 4, 0, 1, 'now');
  `);
  assert.throws(() => database.exec(`
    UPDATE material_stock_totals SET total_quantity = 6 WHERE material_id = 'CAT-0001'
  `), /constraint/i);

  database.exec(`
    INSERT INTO material_links (
      id, material_id, kind, label, url, is_public, sort_order, status, created_at, updated_at
    ) VALUES (
      'LINK-1', 'CAT-0001', 'ebook', 'Читати', 'https://example.test/book',
      1, 0, 'active', 'now', 'now'
    ), (
      'LINK-STORE', 'CAT-0001', 'store', 'Магазин', 'https://example.test/store',
      1, 1, 'active', 'now', 'now'
    ), (
      'LINK-PREVIEW', 'CAT-0001', 'preview', 'Уривок', 'https://example.test/preview',
      1, 2, 'active', 'now', 'now'
    );
  `);
  assert.throws(() => database.exec(`
    INSERT INTO material_links (
      id, material_id, kind, label, url, is_public, sort_order, status, created_at, updated_at
    ) VALUES ('LINK-2', 'CAT-0001', 'other', 'Unsafe', 'file:///book', 1, 0, 'active', 'now', 'now')
  `), /constraint/i);
  database.close();
});

test("loans, immutable inventory lines, commands and audit enforce invariants", async () => {
  const database = await migratedDatabase();
  seedDirectories(database);
  database.exec(`
    INSERT INTO loans (
      id, teacher_user_id, status, issued_at, due_at, notes,
      issued_by_user_id, version, created_at, updated_at
    ) VALUES (
      'LOAN-1', 'USR-002', 'open', '2026-08-11', '2026-09-01', '',
      'USR-001', 1, 'now', 'now'
    );
    INSERT INTO loan_items (
      id, loan_id, material_id, source_location_id, condition,
      quantity_issued, quantity_returned, notes, created_at, updated_at
    ) VALUES (
      'LOAN-ITEM-1', 'LOAN-1', 'CAT-0001', 'LOC-001', 'good',
      2, 0, '', 'now', 'now'
    );
    INSERT INTO inventory_transactions (
      id, request_id, kind, occurred_at, notes, loan_id,
      actor_user_id, status, created_at
    ) VALUES (
      'TX-1', 'REQUEST-1', 'loan_issue', '2026-08-11', '', 'LOAN-1',
      'USR-001', 'posted', 'now'
    );
    INSERT INTO inventory_transaction_lines (
      id, transaction_id, material_id, location_id, condition,
      quantity_delta, quantity_before, quantity_after, loan_item_id, created_at
    ) VALUES (
      'TX-LINE-1', 'TX-1', 'CAT-0001', 'LOC-001', 'good',
      -2, 4, 2, 'LOAN-ITEM-1', 'now'
    );
  `);

  assert.throws(() => database.exec(`
    UPDATE loan_items SET quantity_returned = 3 WHERE id = 'LOAN-ITEM-1'
  `), /constraint/i);
  assert.throws(() => database.exec(`
    INSERT INTO inventory_transaction_lines (
      id, transaction_id, material_id, location_id, condition,
      quantity_delta, quantity_before, quantity_after, created_at
    ) VALUES ('TX-LINE-BAD', 'TX-1', 'CAT-0001', 'LOC-001', 'good', 0, 2, 2, 'now')
  `), /constraint/i);

  database.exec(`
    INSERT INTO mutation_commands (
      id, kind, actor_user_id, status, request_hash, created_at, updated_at
    ) VALUES (
      'REQUEST-1', 'loan.issue', 'USR-001', 'processing',
      '0000000000000000000000000000000000000000000000000000000000000000',
      'now', 'now'
    );
    INSERT INTO audit_events (
      id, actor_user_id, actor_email, action, entity_type,
      entity_id, request_id, after_json, created_at
    ) VALUES (
      'AUDIT-1', 'USR-001', 'library@example.test', 'loan.issue', 'loan',
      'LOAN-1', 'REQUEST-1', '{"status":"open"}', 'now'
    );
  `);
  assert.throws(() => database.exec(`
    INSERT INTO audit_events (
      id, actor_email, action, entity_type, entity_id, after_json, created_at
    ) VALUES ('AUDIT-BAD', 'system', 'bad', 'material', 'CAT-0001', '{', 'now')
  `), /constraint/i);
  database.close();
});

test("0013 preserves existing teacher credentials and requires first-login PIN setup", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  for (const file of migrationFiles.slice(0, migrationFiles.indexOf("drizzle/0013_strange_dark_beast.sql"))) {
    database.exec(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
  }
  const now = "2026-08-20T10:00:00.000Z";
  database.prepare(`INSERT INTO users (
    id,full_name,sort_name,email,auth_user_id,role,status,created_at,updated_at
  ) VALUES ('USR-LIB-PIN','Бібліотекар','Бібліотекар','lib-pin@example.test',NULL,
    'librarian','active',?,?),('USR-TEA-PIN','Учитель','Учитель',NULL,NULL,
    'teacher','active',?,?)`).run(now, now, now, now);
  database.prepare(`INSERT INTO visit_teacher_credentials (
    teacher_user_id,login_id,code_hmac,status,version,failed_attempts,
    code_rotated_at,created_by_user_id,updated_by_user_id,created_at,updated_at
  ) VALUES ('USR-TEA-PIN','pin-migration-login-id-001',?,'active',1,0,?,
    'USR-LIB-PIN','USR-LIB-PIN',?,?)`).run("a".repeat(64), now, now, now);

  database.exec(await readFile(
    new URL("../drizzle/0013_strange_dark_beast.sql", import.meta.url),
    "utf8",
  ));
  assert.equal(database.prepare(`SELECT must_change_pin FROM visit_teacher_credentials
    WHERE teacher_user_id='USR-TEA-PIN'`).get().must_change_pin, 1);
  assert.throws(() => database.prepare(`UPDATE visit_teacher_credentials SET must_change_pin=2
    WHERE teacher_user_id='USR-TEA-PIN'`).run(), /constraint/i);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});
