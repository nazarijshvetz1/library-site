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
];

async function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  for (const file of migrationFiles) {
    database.exec(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
  }
  return database;
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
