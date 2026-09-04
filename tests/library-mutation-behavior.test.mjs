import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const mutation = await import(
  pathToFileURL(path.join(root, "lib/library-mutation-store.ts")).href
);
const catalog = await import(
  pathToFileURL(path.join(root, "lib/catalog-d1.ts")).href
);
const directory = await import(
  pathToFileURL(path.join(root, "lib/library-directory-store.ts")).href
);
const statements = await import(
  pathToFileURL(path.join(root, "lib/class-issue-statement-store.ts")).href
);
const management = await import(
  pathToFileURL(path.join(root, "lib/class-loan-management-store.ts")).href
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
    const results = this.database.sqlite.prepare(this.sql).all(...this.bindings);
    return { success: true, results };
  }

  execute() {
    const results = this.database.sqlite.prepare(this.sql).all(...this.bindings);
    return { success: true, results };
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
      const callback = this.beforeBatch;
      this.beforeBatch = null;
      callback();
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
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of [
    "0000_librarian_drafts.sql",
    "0001_draft_workflow.sql",
    "0002_remove_legacy_audit_triggers.sql",
    "0003_odd_the_order.sql",
    "0005_young_night_nurse.sql",
    "0006_pale_sauron.sql",
    "0007_cold_whiplash.sql",
    "0008_sudden_thunderbird.sql",
    "0009_happy_silver_samurai.sql",
    "0010_shocking_cobalt_man.sql",
    "0011_normalize_holding_conditions.sql",
    "0012_elite_victor_mancha.sql",
    "0013_strange_dark_beast.sql",
    "0014_rich_lionheart.sql",
    "0015_glamorous_namora.sql",
    "0016_busy_jane_foster.sql",
    "0017_fresh_robbie_robertson.sql",
    "0018_yielding_skaar.sql",
    "0019_kindly_wolfsbane.sql",
    "0028_dusty_marten_broadcloak.sql",
    "0034_worthless_big_bertha.sql",
    "0035_soft_warstar.sql",
  ]) {
    const sql = fs.readFileSync(path.join(root, "drizzle", file), "utf8");
    for (const statement of sql.split(/-->\s*statement-breakpoint/gu)) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }
  seed(sqlite);
  return { sqlite, d1: new TestD1(sqlite) };
}

function plainRow(row) {
  return { ...row };
}

function seed(sqlite) {
  const now = "2026-08-11T08:00:00.000Z";
  sqlite.prepare(`
    INSERT INTO users (
      id, full_name, sort_name, email, auth_user_id, role, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).run("USR-LIB", "Назарій Швець", "швець назарій", "librarian@example.com", "auth-librarian", "librarian", now, now);
  sqlite.prepare(`
    INSERT INTO users (
      id, full_name, sort_name, email, auth_user_id, role, status, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, NULL, 'teacher', 'active', ?, ?)
  `).run("USR-TCH", "Ірина Вчитель", "вчитель ірина", now, now);
  sqlite.prepare(`INSERT INTO teacher_profiles(
    teacher_user_id,subject_position,primary_location_id,service_contact,librarian_note,version,
    last_mutation_request_id,closed_at,closed_by_user_id,created_by_user_id,updated_by_user_id,created_at,updated_at
  ) VALUES(?, '', NULL, '', '', 1, NULL, NULL, NULL, 'USR-LIB', 'USR-LIB', ?, ?)`)
    .run("USR-TCH", now, now);
  sqlite.prepare(`
    INSERT INTO materials (
      id, catalog_number, title, sort_title, search_text, rubric,
      publication_type, subject, class_from, class_to, author,
      publication_year, isbn, isbn_normalized, publisher, notes,
      status, version, created_at, updated_at, archived_at
    ) VALUES (
      'CAT-0001', 1, 'Стара назва', 'стара назва', 'стара назва',
      'Підручники', 'Підручник', 'Математика', 5, 5, 'Автор',
      2020, '', '', 'Видавництво', '', 'active', 1, ?, ?, NULL
    )
  `).run(now, now);
  sqlite.prepare(`
    INSERT INTO locations (
      id, name, type, status, is_public, sort_order, created_at, updated_at
    ) VALUES ('LOC-001', 'Бібліотека', 'library', 'active', 1, 1, ?, ?)
  `).run(now, now);
  sqlite.prepare(`
    UPDATE teacher_profiles
    SET subject_position = 'Учитель математики', primary_location_id = 'LOC-001'
    WHERE teacher_user_id = 'USR-TCH'
  `).run();
  sqlite.prepare(`
    INSERT INTO material_cover_assets (
      id, material_id, storage_provider, storage_key, external_url, mime_type,
      byte_length, width, height, sha256, status, version, created_at, updated_at
    ) VALUES (
      'COVER-CAT-0001', 'CAT-0001', 'external', NULL,
      'https://example.com/covers/CAT-0001.jpg', 'image/jpeg',
      1200, 400, 600, NULL, 'ready', 1, ?, ?
    )
  `).run(now, now);
  sqlite.prepare(`
    INSERT INTO holdings (
      material_id, location_id, condition, quantity, version, updated_at
    ) VALUES ('CAT-0001', 'LOC-001', 'unspecified', 5, 1, ?)
  `).run(now);
  sqlite.prepare(`
    INSERT INTO material_stock_totals (
      material_id, total_quantity, library_quantity,
      other_location_quantity, loaned_quantity, updated_at
    ) VALUES ('CAT-0001', 5, 5, 0, 0, ?)
  `).run(now);
  sqlite.exec("INSERT INTO materials_fts(materials_fts) VALUES('rebuild')");
}

function seedActiveClassYear(sqlite) {
  const now = "2026-08-11T08:00:00.000Z";
  sqlite.prepare(`
    INSERT INTO academic_years (
      id, label, start_date, end_date, status, notes, version, created_at, updated_at
    ) VALUES ('YR-2026-2027', '2026/2027', '2026-09-01', '2027-06-30',
      'active', '', 1, ?, ?)
  `).run(now, now);
  sqlite.prepare(`
    INSERT INTO cohorts (id, status, notes, created_at, updated_at)
    VALUES ('COH-001', 'active', '', ?, ?)
  `).run(now, now);
  sqlite.prepare(`
    INSERT INTO class_years (
      id, academic_year_id, cohort_id, class_name, grade, code,
      teacher_user_id, location_id, start_date, end_date, status,
      actual_closed_date, notes, version, created_at, updated_at
    ) VALUES (
      'CY-2026-001', 'YR-2026-2027', 'COH-001', '5-А клас', 5, 'А',
      'USR-TCH', NULL, '2026-09-01', '2027-06-30', 'active',
      NULL, '', 1, ?, ?
    )
  `).run(now, now);
}

function seedActiveReservation(sqlite, quantity = 5, suffix = "RACE") {
  const now = "2026-08-11T09:00:00.000Z";
  const requestId = `MRQ-${suffix}`;
  const itemId = `MRI-${suffix}`;
  sqlite.prepare(`INSERT INTO material_requests (
    id,teacher_user_id,status,teacher_notes,librarian_note,rejection_reason,
    pickup_location_id,resulting_loan_id,due_at,reviewed_by_user_id,cancelled_by_user_id,
    version,submitted_at,ready_at,completed_at,rejected_at,cancelled_at,created_at,updated_at
  ) VALUES (?,'USR-TCH','in_review','','','',NULL,NULL,NULL,'USR-LIB',NULL,
    1,?,NULL,NULL,NULL,NULL,?,?)`).run(requestId, now, now, now);
  sqlite.prepare(`INSERT INTO material_request_items (
    id,request_id,material_id,title_snapshot,author_snapshot,requested_quantity,
    approved_quantity,fulfilled_quantity,sort_order,created_at,updated_at
  ) VALUES (?,?,'CAT-0001','Стара назва','Автор',?, ?,0,0,?,?)`)
    .run(itemId, requestId, quantity, quantity, now, now);
  sqlite.prepare(`INSERT INTO material_request_reservations (
    id,request_id,request_item_id,material_id,source_location_id,condition,
    reserved_quantity,issued_quantity,released_quantity,created_at,updated_at
  ) VALUES (?,?,?,'CAT-0001','LOC-001','unspecified',?,0,0,?,?)`)
    .run(`MRR-${suffix}`, requestId, itemId, quantity, now, now);
  return { requestId, itemId, reservationId: `MRR-${suffix}` };
}

const actor = {
  userId: "auth-librarian",
  displayName: "Назарій Швець",
  email: "librarian@example.com",
  fullName: "Назарій Швець",
};

const ids = {
  material: "10000000-0000-4000-8000-000000000001",
  stock: "10000000-0000-4000-8000-000000000002",
  loan: "10000000-0000-4000-8000-000000000003",
  partialReturn: "10000000-0000-4000-8000-000000000004",
  finalReturn: "10000000-0000-4000-8000-000000000005",
};

test("direct material edit commits once, preserves history and rejects stale versions", async () => {
  const { sqlite, d1 } = openDatabase();
  const input = {
    requestId: ids.material,
    expectedVersion: 1,
    changes: {
      title: "Нова назва",
      publicationYear: 2024,
      classTo: null,
      links: [
        {
          id: null,
          kind: "ebook",
          label: "Читати",
          url: "https://example.com/book.pdf",
          isPublic: true,
          sortOrder: 0,
        },
      ],
    },
  };
  const first = await mutation.updateMaterialDirect(actor, "CAT-0001", input, d1);
  const replay = await mutation.updateMaterialDirect(actor, "CAT-0001", input, d1);
  assert.deepEqual(replay, first);
  assert.deepEqual(
    plainRow(sqlite.prepare("SELECT title, publication_year, class_to, version FROM materials WHERE id = 'CAT-0001'").get()),
    { title: "Нова назва", publication_year: 2024, class_to: null, version: 2 },
  );
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM material_links").get().count, 1);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'material.updated'").get().count, 1);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM mutation_commands").get().count, 1);
  assert.equal(
    sqlite.prepare("SELECT count(*) AS count FROM materials_fts WHERE materials_fts MATCH '2020'").get().count,
    0,
  );
  assert.equal(
    sqlite.prepare("SELECT count(*) AS count FROM materials_fts WHERE materials_fts MATCH '2024'").get().count,
    1,
  );
  const auditAfter = JSON.parse(sqlite.prepare(`
    SELECT after_json FROM audit_events WHERE action = 'material.updated'
  `).get().after_json);
  assert.equal(auditAfter.classTo, null);
  assert.equal(auditAfter.links.length, 1);
  assert.match(auditAfter.links[0].id, /^LINK-/u);
  assert.deepEqual(
    plainRow(sqlite.prepare(`
      SELECT id, kind, label, url, is_public, sort_order, status
      FROM material_links
    `).get()),
    {
      id: auditAfter.links[0].id,
      kind: auditAfter.links[0].kind,
      label: auditAfter.links[0].label,
      url: auditAfter.links[0].url,
      is_public: auditAfter.links[0].isPublic ? 1 : 0,
      sort_order: auditAfter.links[0].sortOrder,
      status: auditAfter.links[0].status,
    },
  );
  const detail = await catalog.getCatalogMaterialDetail(d1, "CAT-0001", "librarian");
  assert.equal(detail.version, 2);
  assert.deepEqual(detail.links, [{
    id: auditAfter.links[0].id,
    kind: "ebook",
    label: "Читати",
    url: "https://example.com/book.pdf",
    isPublic: true,
    sortOrder: 0,
  }]);

  await assert.rejects(
    mutation.updateMaterialDirect(
      actor,
      "CAT-0001",
      { ...input, requestId: "10000000-0000-4000-8000-000000000099" },
      d1,
    ),
    (error) => error instanceof mutation.LibraryMutationError
      && error.code === "material_version_conflict",
  );
  sqlite.prepare(`
    INSERT INTO materials (
      id, catalog_number, title, sort_title, search_text, rubric,
      publication_type, subject, class_from, class_to, author,
      publication_year, isbn, isbn_normalized, publisher, notes,
      status, version, created_at, updated_at, archived_at
    )
    SELECT
      'CAT-0002', 2, 'Інший матеріал', 'інший матеріал', 'інший матеріал', rubric,
      publication_type, subject, class_from, class_to, author,
      publication_year, '9780306406157', '9780306406157', publisher, notes,
      status, 1, created_at, updated_at, NULL
    FROM materials WHERE id = 'CAT-0001'
  `).run();
  await assert.rejects(
    mutation.updateMaterialDirect(
      actor,
      "CAT-0001",
      {
        requestId: "10000000-0000-4000-8000-000000000098",
        expectedVersion: 2,
        changes: { isbn: "9780306406157" },
      },
      d1,
    ),
    (error) => error instanceof mutation.LibraryMutationError
      && error.status === 409
      && error.code === "duplicate_isbn"
      && error.details.materialId === "CAT-0002",
  );
});

test("a compact e-textbook link append preserves existing links and replays once", async () => {
  const { sqlite, d1 } = openDatabase();
  const now = "2026-08-11T08:00:00.000Z";
  sqlite.prepare(`
    INSERT INTO material_links (
      id, material_id, kind, label, url, is_public, sort_order,
      status, created_at, updated_at
    ) VALUES ('LINK-DETAILS', 'CAT-0001', 'details', 'Про видання',
      'https://example.com/details', 1, 0, 'active', ?, ?)
  `).run(now, now);
  const input = {
    requestId: "10000000-0000-4000-8000-000000000097",
    expectedVersion: 1,
    url: "https://example.com/textbook.pdf",
  };

  const first = await mutation.appendMaterialEbookLinkDirect(actor, "CAT-0001", input, d1);
  const replay = await mutation.appendMaterialEbookLinkDirect(actor, "CAT-0001", input, d1);
  assert.deepEqual(replay, first);
  assert.equal(first.version, 2);
  assert.deepEqual(
    sqlite.prepare("SELECT kind, label, url, sort_order FROM material_links WHERE material_id='CAT-0001' ORDER BY sort_order").all().map(plainRow),
    [
      { kind: "details", label: "Про видання", url: "https://example.com/details", sort_order: 0 },
      { kind: "ebook", label: "Електронна версія", url: input.url, sort_order: 10 },
    ],
  );
  assert.equal(sqlite.prepare("SELECT version FROM materials WHERE id='CAT-0001'").get().version, 2);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM audit_events WHERE action='material.ebook_link_added'").get().count, 1);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM mutation_commands WHERE id=?").get(input.requestId).count, 1);

  await assert.rejects(
    mutation.appendMaterialEbookLinkDirect(actor, "CAT-0001", {
      ...input,
      requestId: "10000000-0000-4000-8000-000000000096",
      expectedVersion: 2,
    }, d1),
    (error) => error instanceof mutation.LibraryMutationError
      && error.code === "material_link_exists",
  );
});

test("a material race returns a stable 409 conflict without a partial command", async () => {
  const { sqlite, d1 } = openDatabase();
  d1.beforeBatch = () => {
    sqlite.prepare(`
      UPDATE materials SET title = 'Паралельна зміна', version = 2
      WHERE id = 'CAT-0001' AND version = 1
    `).run();
  };
  await assert.rejects(
    mutation.updateMaterialDirect(
      actor,
      "CAT-0001",
      {
        requestId: "10000000-0000-4000-8000-000000000012",
        expectedVersion: 1,
        changes: { title: "Моя зміна" },
      },
      d1,
    ),
    (error) => error instanceof mutation.LibraryMutationError
      && error.status === 409
      && error.code === "material_version_conflict",
  );
  assert.equal(
    sqlite.prepare("SELECT title FROM materials WHERE id = 'CAT-0001'").get().title,
    "Паралельна зміна",
  );
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM mutation_commands").get().count, 0);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM audit_events").get().count, 0);
});

test("material archive preserves history, disappears from search and replays once", async () => {
  const { sqlite, d1 } = openDatabase();
  const input = {
    requestId: "10000000-0000-4000-8000-000000000013",
    expectedVersion: 1,
  };

  await assert.rejects(
    mutation.archiveMaterialDirect(actor, "CAT-0001", input, d1),
    (error) => error instanceof mutation.LibraryMutationError
      && error.status === 409
      && error.code === "material_has_stock"
      && error.details.totalQuantity === 5,
  );
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM mutation_commands").get().count, 0);

  await assert.rejects(
    mutation.archiveMaterialDirect(
      actor,
      "CAT-0001",
      {
        requestId: "10000000-0000-4000-8000-000000000019",
        expectedVersion: 99,
      },
      d1,
    ),
    (error) => error instanceof mutation.LibraryMutationError
      && error.status === 409
      && error.code === "material_version_conflict",
  );

  sqlite.exec("DELETE FROM holdings WHERE material_id = 'CAT-0001'");
  sqlite.exec(`
    UPDATE material_stock_totals
    SET total_quantity = 0, library_quantity = 0,
        other_location_quantity = 0, loaned_quantity = 0
    WHERE material_id = 'CAT-0001'
  `);
  const first = await mutation.archiveMaterialDirect(actor, "CAT-0001", input, d1);
  const replay = await mutation.archiveMaterialDirect(actor, "CAT-0001", input, d1);
  assert.deepEqual(replay, first);
  await assert.rejects(
    mutation.archiveMaterialDirect(
      actor,
      "CAT-0001",
      { ...input, expectedVersion: 2 },
      d1,
    ),
    (error) => error instanceof mutation.LibraryMutationError
      && error.status === 409
      && error.code === "request_id_conflict",
  );
  assert.deepEqual(
    plainRow(sqlite.prepare(`
      SELECT status, version, archived_at FROM materials WHERE id = 'CAT-0001'
    `).get()),
    { status: "archived", version: 2, archived_at: first.archivedAt },
  );
  assert.equal(
    sqlite.prepare("SELECT count(*) AS count FROM materials_fts WHERE materials_fts MATCH 'стара'").get().count,
    1,
    "external-content FTS must retain the archived content row for integrity",
  );
  assert.doesNotThrow(() => {
    sqlite.exec("INSERT INTO materials_fts(materials_fts, rank) VALUES('integrity-check', 1)");
  }, "external-content FTS must remain consistent with the retained materials row");
  assert.equal(
    sqlite.prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'material.archived'").get().count,
    1,
  );
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM mutation_commands").get().count, 1);
  const audit = sqlite.prepare(`
    SELECT before_json, after_json, metadata_json
    FROM audit_events WHERE action = 'material.archived'
  `).get();
  assert.equal(JSON.parse(audit.before_json).status, "active");
  assert.equal(JSON.parse(audit.after_json).status, "archived");
  assert.deepEqual(JSON.parse(audit.metadata_json), {
    mode: "archive",
    historyPreserved: true,
  });
  assert.equal(await catalog.getCatalogMaterialDetail(d1, "CAT-0001", "librarian"), null);
  assert.equal(
    sqlite.prepare("SELECT count(*) AS count FROM material_stock_totals WHERE material_id = 'CAT-0001'").get().count,
    1,
    "archiving must preserve the zero stock history row",
  );
});

test("an outstanding teacher loan blocks material archive even with no holding", async () => {
  const { sqlite, d1 } = openDatabase();
  sqlite.exec("DELETE FROM holdings WHERE material_id = 'CAT-0001'");
  sqlite.exec(`
    UPDATE material_stock_totals
    SET total_quantity = 0, library_quantity = 0,
        other_location_quantity = 0, loaned_quantity = 0
    WHERE material_id = 'CAT-0001'
  `);
  sqlite.prepare(`
    INSERT INTO loans (
      id, teacher_user_id, status, issued_at, due_at, closed_at, notes,
      issued_by_user_id, closed_by_user_id, version, created_at, updated_at
    ) VALUES (
      'LOAN-ARCHIVE', 'USR-TCH', 'open', '2026-08-11', NULL, NULL, '',
      'USR-LIB', NULL, 1, '2026-08-11T09:00:00.000Z', '2026-08-11T09:00:00.000Z'
    )
  `).run();
  sqlite.prepare(`
    INSERT INTO loan_items (
      id, loan_id, material_id, source_location_id, condition,
      quantity_issued, quantity_returned, notes, created_at, updated_at
    ) VALUES (
      'LI-ARCHIVE', 'LOAN-ARCHIVE', 'CAT-0001', 'LOC-001', 'good',
      1, 0, '', '2026-08-11T09:00:00.000Z', '2026-08-11T09:00:00.000Z'
    )
  `).run();

  await assert.rejects(
    mutation.archiveMaterialDirect(
      actor,
      "CAT-0001",
      {
        requestId: "10000000-0000-4000-8000-000000000015",
        expectedVersion: 1,
      },
      d1,
    ),
    (error) => error instanceof mutation.LibraryMutationError
      && error.status === 409
      && error.code === "material_has_stock"
      && error.details.totalQuantity === 1
      && error.details.loanedQuantity === 1,
  );
  assert.equal(sqlite.prepare("SELECT status FROM materials WHERE id = 'CAT-0001'").get().status, "active");
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM audit_events").get().count, 0);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM mutation_commands").get().count, 0);
});

test("a stock race aborts material archive without partial history", async () => {
  const { sqlite, d1 } = openDatabase();
  sqlite.exec("DELETE FROM holdings WHERE material_id = 'CAT-0001'");
  sqlite.exec(`
    UPDATE material_stock_totals
    SET total_quantity = 0, library_quantity = 0,
        other_location_quantity = 0, loaned_quantity = 0
    WHERE material_id = 'CAT-0001'
  `);
  d1.beforeBatch = () => {
    sqlite.prepare(`
      INSERT INTO holdings (
        material_id, location_id, condition, quantity, version, updated_at
      ) VALUES ('CAT-0001', 'LOC-001', 'good', 1, 1, '2026-08-11T09:00:00.000Z')
    `).run();
    sqlite.exec(`
      UPDATE material_stock_totals
      SET total_quantity = 1, library_quantity = 1, updated_at = '2026-08-11T09:00:00.000Z'
      WHERE material_id = 'CAT-0001'
    `);
  };

  await assert.rejects(
    mutation.archiveMaterialDirect(
      actor,
      "CAT-0001",
      {
        requestId: "10000000-0000-4000-8000-000000000014",
        expectedVersion: 1,
      },
      d1,
    ),
    (error) => error instanceof mutation.LibraryMutationError
      && error.status === 409
      && error.code === "material_archive_conflict",
  );
  assert.equal(sqlite.prepare("SELECT status FROM materials WHERE id = 'CAT-0001'").get().status, "active");
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM audit_events").get().count, 0);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM mutation_commands").get().count, 0);
});

test("an archive race aborts zero-stock counts atomically", async () => {
  for (const [index, countedQuantity] of [0, 1].entries()) {
    const { sqlite, d1 } = openDatabase();
    sqlite.exec("DELETE FROM holdings WHERE material_id = 'CAT-0001'");
    sqlite.exec(`
      UPDATE material_stock_totals
      SET total_quantity = 0, library_quantity = 0,
          other_location_quantity = 0, loaned_quantity = 0
      WHERE material_id = 'CAT-0001'
    `);
    d1.beforeBatch = () => {
      sqlite.exec(`
        UPDATE materials
        SET status = 'archived', version = 2,
            archived_at = '2026-08-11T09:00:00.000Z',
            updated_at = '2026-08-11T09:00:00.000Z'
        WHERE id = 'CAT-0001'
      `);
    };

    await assert.rejects(
      mutation.adjustHoldingToActualCount(
        actor,
        {
          requestId: `10000000-0000-4000-8000-00000000001${index + 6}`,
          materialId: "CAT-0001",
          locationId: "LOC-001",
          condition: "good",
          expectedQuantity: 0,
          countedQuantity,
          reason: "correction",
          occurredAt: "2026-08-11",
          notes: null,
        },
        d1,
      ),
      (error) => error instanceof mutation.LibraryMutationError
        && error.status === 409
        && error.code === "stock_quantity_conflict",
    );
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM holdings").get().count, 0);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM inventory_transactions").get().count, 0);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM audit_events").get().count, 0);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM mutation_commands").get().count, 0);
  }
});

test("new material with initial receipt and later receipt commit without drafts", async () => {
  const { sqlite, d1 } = openDatabase();
  const createInput = {
    requestId: "10000000-0000-4000-8000-000000000020",
    title: "Новий підручник",
    rubric: "Підручники",
    publicationType: "Підручник",
    subject: "Математика",
    classFrom: 6,
    classTo: 6,
    author: "Новий автор",
    publicationYear: 2025,
    isbn: "9786170000000",
    publisher: "Видавництво",
    notes: null,
    links: [],
    initialReceipt: {
      locationId: "LOC-001",
      condition: "good",
      quantity: 3,
      expectedQuantity: 0,
      occurredAt: "2026-08-11",
      documentNumber: "Накладна 1",
      notes: null,
    },
  };
  const created = await mutation.createMaterialDirect(actor, createInput, d1);
  const replay = await mutation.createMaterialDirect(actor, createInput, d1);
  assert.deepEqual(replay, created);
  assert.equal(created.materialId, "CAT-0002");
  assert.equal(created.receipt.quantityAfter, 3);
  assert.equal(
    sqlite.prepare("SELECT count(*) AS count FROM materials_fts WHERE materials_fts MATCH '9786170000000'").get().count,
    1,
  );
  assert.deepEqual(
    plainRow(sqlite.prepare(`
      SELECT total_quantity, library_quantity, loaned_quantity
      FROM material_stock_totals WHERE material_id = 'CAT-0002'
    `).get()),
    { total_quantity: 3, library_quantity: 3, loaned_quantity: 0 },
  );

  const received = await mutation.receiveStockDirect(
    actor,
    {
      requestId: "10000000-0000-4000-8000-000000000021",
      materialId: "CAT-0002",
      locationId: "LOC-001",
      condition: "good",
      quantity: 2,
      expectedQuantity: 3,
      occurredAt: "2026-08-12",
      documentNumber: null,
      notes: null,
    },
    d1,
  );
  assert.equal(received.quantityAfter, 5);
  assert.equal(
    sqlite.prepare(`
      SELECT quantity FROM holdings
      WHERE material_id = 'CAT-0002' AND location_id = 'LOC-001' AND condition = 'good'
    `).get().quantity,
    5,
  );
  assert.equal(
    sqlite.prepare("SELECT count(*) AS count FROM mutation_commands").get().count,
    2,
  );
  assert.equal(
    sqlite.prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'stock.received'").get().count,
    2,
  );
});

test("receipt races and inactive locations return 409 with no partial receipt", async () => {
  const first = openDatabase();
  const now = "2026-08-11T08:00:00.000Z";
  first.sqlite.prepare(`
    INSERT INTO locations (
      id, name, type, status, is_public, sort_order, created_at, updated_at
    ) VALUES ('LOC-002', 'Кабінет 2', 'classroom', 'active', 1, 2, ?, ?)
  `).run(now, now);
  first.d1.beforeBatch = () => {
    first.sqlite.prepare(`
      INSERT INTO holdings (
        material_id, location_id, condition, quantity, version, updated_at
      ) VALUES ('CAT-0001', 'LOC-002', 'good', 1, 1, ?)
    `).run(now);
  };
  await assert.rejects(
    mutation.receiveStockDirect(
      actor,
      {
        requestId: "10000000-0000-4000-8000-000000000022",
        materialId: "CAT-0001",
        locationId: "LOC-002",
        condition: "good",
        quantity: 2,
        expectedQuantity: 0,
        occurredAt: "2026-08-11",
        documentNumber: null,
        notes: null,
      },
      first.d1,
    ),
    (error) => error instanceof mutation.LibraryMutationError
      && error.status === 409
      && error.code === "stock_quantity_conflict",
  );
  assert.equal(first.sqlite.prepare("SELECT count(*) AS count FROM inventory_transactions").get().count, 0);
  assert.equal(first.sqlite.prepare("SELECT count(*) AS count FROM mutation_commands").get().count, 0);

  const second = openDatabase();
  second.d1.beforeBatch = () => {
    second.sqlite.prepare(`
      UPDATE locations SET status = 'inactive' WHERE id = 'LOC-001'
    `).run();
  };
  await assert.rejects(
    mutation.receiveStockDirect(
      actor,
      {
        requestId: "10000000-0000-4000-8000-000000000023",
        materialId: "CAT-0001",
        locationId: "LOC-001",
        condition: "unspecified",
        quantity: 1,
        expectedQuantity: 5,
        occurredAt: "2026-08-11",
        documentNumber: null,
        notes: null,
      },
      second.d1,
    ),
    (error) => error instanceof mutation.LibraryMutationError
      && error.status === 409
      && error.code === "stock_quantity_conflict",
  );
  assert.equal(second.sqlite.prepare("SELECT quantity FROM holdings").get().quantity, 5);
  assert.equal(second.sqlite.prepare("SELECT count(*) AS count FROM inventory_transactions").get().count, 0);

  const third = openDatabase();
  third.sqlite.prepare(`
    INSERT INTO locations (
      id, name, type, status, is_public, sort_order, created_at, updated_at
    ) VALUES ('LOC-003', 'Кабінет 3', 'classroom', 'active', 1, 3, ?, ?)
  `).run(now, now);
  third.d1.beforeBatch = () => {
    third.sqlite.prepare("UPDATE locations SET status = 'inactive' WHERE id = 'LOC-003'").run();
  };
  await assert.rejects(
    mutation.receiveStockDirect(
      actor,
      {
        requestId: "10000000-0000-4000-8000-000000000024",
        materialId: "CAT-0001",
        locationId: "LOC-003",
        condition: "good",
        quantity: 1,
        expectedQuantity: 0,
        occurredAt: "2026-08-11",
        documentNumber: null,
        notes: null,
      },
      third.d1,
    ),
    (error) => error instanceof mutation.LibraryMutationError
      && error.status === 409
      && error.code === "stock_quantity_conflict",
  );
  assert.equal(third.sqlite.prepare("SELECT count(*) AS count FROM holdings WHERE location_id = 'LOC-003'").get().count, 0);
  assert.equal(third.sqlite.prepare("SELECT count(*) AS count FROM inventory_transactions").get().count, 0);
});

test("actual count, teacher issue and partial/full returns keep one balanced stock total", async () => {
  const { sqlite, d1 } = openDatabase();
  const stock = await mutation.adjustHoldingToActualCount(
    actor,
    {
      requestId: ids.stock,
      materialId: "CAT-0001",
      locationId: "LOC-001",
      condition: "unspecified",
      expectedQuantity: 5,
      countedQuantity: 4,
      reason: "inventory_count",
      occurredAt: "2026-08-11",
      notes: "Фактичний перерахунок",
    },
    d1,
  );
  const stockReplay = await mutation.adjustHoldingToActualCount(
    actor,
    {
      requestId: ids.stock,
      materialId: "CAT-0001",
      locationId: "LOC-001",
      condition: "unspecified",
      expectedQuantity: 5,
      countedQuantity: 4,
      reason: "inventory_count",
      occurredAt: "2026-08-11",
      notes: "Фактичний перерахунок",
    },
    d1,
  );
  assert.deepEqual(stockReplay, stock);
  assert.equal(sqlite.prepare("SELECT quantity FROM holdings").get().quantity, 4);

  const loan = await mutation.issueLoanToTeacher(
    actor,
    {
      requestId: ids.loan,
      teacherUserId: "USR-TCH",
      issuedAt: "2026-08-11",
      dueAt: "2026-09-01",
      notes: null,
      items: [
        {
          materialId: "CAT-0001",
          sourceLocationId: "LOC-001",
          condition: "unspecified",
          quantity: 2,
          expectedAvailableQuantity: 4,
        },
      ],
    },
    d1,
  );
  assert.equal(
    sqlite.prepare("SELECT due_at FROM loans WHERE id = ?").get(loan.loanId).due_at,
    "2026-09-01",
  );
  sqlite.prepare(`UPDATE teacher_profiles
    SET photo_storage_key='teacher-photos/USR-TCH/profile.jpg',photo_version=2,photo_updated_at=?
    WHERE teacher_user_id='USR-TCH'`).run("2026-08-11T08:00:00.000Z");
  const reference = await directory.readLibraryReferenceData(d1);
  assert.deepEqual(reference.teachers, [{
    id: "USR-TCH",
    fullName: "Ірина Вчитель",
    subjectPosition: "Учитель математики",
    photoUrl: "/api/librarian/teachers/USR-TCH/photo?v=2-1786435200000",
    primaryLocation: { id: "LOC-001", name: "Бібліотека" },
  }]);
  assert.deepEqual(reference.locations, [{
    id: "LOC-001",
    name: "Бібліотека",
    type: "library",
    isPublic: true,
  }]);
  const openLoans = await directory.listOpenLoans(d1);
  assert.equal(openLoans.length, 1);
  assert.equal(openLoans[0].loanId, loan.loanId);
  assert.equal(openLoans[0].dueAt, "2026-09-01");
  assert.equal(openLoans[0].items[0].loanItemId, loan.items[0].loanItemId);
  assert.equal(openLoans[0].items[0].quantityOutstanding, 2);
  assert.equal(openLoans[0].items[0].materialCatalogNumber, 1);
  assert.equal(openLoans[0].items[0].materialAuthor, "Автор");
  assert.equal(openLoans[0].items[0].materialYear, 2020);
  assert.equal(openLoans[0].items[0].materialIsbn, "");
  assert.equal(openLoans[0].items[0].coverUrl, "https://example.com/covers/CAT-0001.jpg");
  assert.equal(openLoans[0].items[0].thumbnailUrl, "https://example.com/covers/CAT-0001.jpg");
  assert.equal(sqlite.prepare("SELECT quantity FROM holdings").get().quantity, 2);
  assert.deepEqual(
    plainRow(sqlite.prepare("SELECT total_quantity, library_quantity, loaned_quantity FROM material_stock_totals").get()),
    { total_quantity: 4, library_quantity: 2, loaned_quantity: 2 },
  );

  const loanItemId = loan.items[0].loanItemId;
  const partial = await mutation.returnLoanItems(
    actor,
    {
      requestId: ids.partialReturn,
      loanId: loan.loanId,
      returnedAt: "2026-08-20",
      notes: null,
      items: [
        {
          loanItemId,
          quantity: 1,
          returnLocationId: "LOC-001",
          condition: "unspecified",
        },
      ],
    },
    d1,
  );
  assert.equal(partial.status, "open");
  assert.deepEqual(
    plainRow(sqlite.prepare("SELECT total_quantity, library_quantity, loaned_quantity FROM material_stock_totals").get()),
    { total_quantity: 4, library_quantity: 3, loaned_quantity: 1 },
  );

  const closed = await mutation.returnLoanItems(
    actor,
    {
      requestId: ids.finalReturn,
      loanId: loan.loanId,
      returnedAt: "2026-08-21",
      notes: "Повернено повністю",
      items: [
        {
          loanItemId,
          quantity: 1,
          returnLocationId: "LOC-001",
          condition: "unspecified",
        },
      ],
    },
    d1,
  );
  assert.equal(closed.status, "closed");
  assert.equal(sqlite.prepare("SELECT status FROM loans").get().status, "closed");
  assert.deepEqual(
    plainRow(sqlite.prepare("SELECT total_quantity, library_quantity, loaned_quantity FROM material_stock_totals").get()),
    { total_quantity: 4, library_quantity: 4, loaned_quantity: 0 },
  );
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM inventory_transactions").get().count, 4);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM mutation_commands").get().count, 4);
});

test("one return can merge two loan items into the same holding atomically", async () => {
  const { sqlite, d1 } = openDatabase();
  const now = "2026-08-11T08:00:00.000Z";
  sqlite.prepare(`
    INSERT INTO locations (
      id, name, type, status, is_public, sort_order, created_at, updated_at
    ) VALUES ('LOC-002', 'Кабінет 2', 'classroom', 'active', 1, 2, ?, ?)
  `).run(now, now);
  sqlite.prepare(`
    INSERT INTO holdings (
      material_id, location_id, condition, quantity, version, updated_at
    ) VALUES ('CAT-0001', 'LOC-002', 'unspecified', 3, 1, ?)
  `).run(now);
  sqlite.prepare(`
    UPDATE material_stock_totals
    SET total_quantity = 8, other_location_quantity = 3
    WHERE material_id = 'CAT-0001'
  `).run();

  const loan = await mutation.issueLoanToTeacher(
    actor,
    {
      requestId: "10000000-0000-4000-8000-000000000010",
      teacherUserId: "USR-TCH",
      issuedAt: "2026-08-11",
      dueAt: null,
      notes: null,
      items: [
        {
          materialId: "CAT-0001",
          sourceLocationId: "LOC-001",
          condition: "unspecified",
          quantity: 1,
          expectedAvailableQuantity: 5,
        },
        {
          materialId: "CAT-0001",
          sourceLocationId: "LOC-002",
          condition: "unspecified",
          quantity: 1,
          expectedAvailableQuantity: 3,
        },
      ],
    },
    d1,
  );

  const returned = await mutation.returnLoanItems(
    actor,
    {
      requestId: "10000000-0000-4000-8000-000000000011",
      loanId: loan.loanId,
      returnedAt: "2026-08-12",
      notes: null,
      items: loan.items.map((item) => ({
        loanItemId: item.loanItemId,
        quantity: 1,
        returnLocationId: "LOC-001",
        condition: "unspecified",
      })),
    },
    d1,
  );

  assert.equal(returned.status, "closed");
  assert.equal(
    sqlite.prepare(`
      SELECT quantity FROM holdings
      WHERE material_id = 'CAT-0001' AND location_id = 'LOC-001'
        AND condition = 'unspecified'
    `).get().quantity,
    6,
  );
  assert.equal(
    sqlite.prepare(`
      SELECT count(*) AS count
      FROM inventory_transaction_lines line
      JOIN inventory_transactions tx ON tx.id = line.transaction_id
      WHERE tx.kind = 'loan_return'
    `).get().count,
    1,
  );
  assert.deepEqual(
    plainRow(sqlite.prepare(`
      SELECT total_quantity, library_quantity, other_location_quantity, loaned_quantity
      FROM material_stock_totals
    `).get()),
    {
      total_quantity: 8,
      library_quantity: 6,
      other_location_quantity: 2,
      loaned_quantity: 0,
    },
  );
});

test("class issue and partial/full return are idempotent, chronological and balanced", async () => {
  const { sqlite, d1 } = openDatabase();
  seedActiveClassYear(sqlite);
  sqlite.prepare(`
    UPDATE holdings SET quantity = 5, version = 2
    WHERE material_id = 'CAT-0001' AND location_id = 'LOC-001'
  `).run();

  const issueInput = {
    requestId: "20000000-0000-4000-8000-000000000001",
    classYearId: "CY-2026-001",
    expectedClassYearVersion: 1,
    responsibleTeacherUserId: "USR-TCH",
    issuedAt: "2026-09-10",
    dueAt: "2027-06-30",
    notes: "Комплект для класу",
    items: [{
      materialId: "CAT-0001",
      sourceLocationId: "LOC-001",
      condition: "unspecified",
      quantity: 2,
      expectedAvailableQuantity: 5,
    }],
  };
  const issued = await mutation.issueLoanToClass(actor, issueInput, d1);
  assert.deepEqual(await mutation.issueLoanToClass(actor, issueInput, d1), issued);
  assert.equal(issued.responsibleTeacherName, "Ірина Вчитель");
  assert.equal(issued.version, 1);
  assert.equal(sqlite.prepare("SELECT quantity FROM holdings").get().quantity, 3);
  assert.deepEqual(
    plainRow(sqlite.prepare(`
      SELECT total_quantity, library_quantity, loaned_quantity
      FROM material_stock_totals WHERE material_id = 'CAT-0001'
    `).get()),
    { total_quantity: 5, library_quantity: 3, loaned_quantity: 2 },
  );
  const open = await directory.listOpenClassLoans(d1, { classYearId: "CY-2026-001" });
  assert.equal(open.length, 1);
  assert.equal(open[0].responsibleTeacherUserId, "USR-TCH");
  assert.equal(open[0].curatorUserId, "USR-TCH");
  assert.equal(open[0].items[0].materialAuthor, "Автор");
  assert.equal(open[0].items[0].thumbnailUrl, "https://example.com/covers/CAT-0001.jpg");
  assert.equal(open[0].items[0].quantityOutstanding, 2);
  assert.equal((await directory.listOpenClassLoans(d1, { teacherUserId: "USR-TCH" })).length, 1);
  assert.equal((await directory.listOpenClassLoans(d1, { teacherUserId: "USR-OTHER" })).length, 0);

  const classLoanItemId = issued.items[0].classLoanItemId;
  const partial = await mutation.returnClassLoanItems(actor, {
    requestId: "20000000-0000-4000-8000-000000000002",
    classLoanId: issued.classLoanId,
    expectedVersion: 1,
    returnedAt: "2026-10-10",
    notes: null,
    items: [{
      classLoanItemId,
      quantity: 1,
      returnLocationId: "LOC-001",
      condition: "unspecified",
    }],
  }, d1);
  assert.equal(partial.status, "open");
  assert.equal(partial.version, 2);
  assert.deepEqual(
    plainRow(sqlite.prepare(`
      SELECT total_quantity, library_quantity, loaned_quantity
      FROM material_stock_totals WHERE material_id = 'CAT-0001'
    `).get()),
    { total_quantity: 5, library_quantity: 4, loaned_quantity: 1 },
  );

  const commandsBefore = sqlite.prepare("SELECT count(*) AS count FROM mutation_commands").get().count;
  await assert.rejects(
    mutation.returnClassLoanItems(actor, {
      requestId: "20000000-0000-4000-8000-000000000003",
      classLoanId: issued.classLoanId,
      expectedVersion: 2,
      returnedAt: "2026-10-09",
      notes: null,
      items: [{
        classLoanItemId,
        quantity: 1,
        returnLocationId: "LOC-001",
        condition: "unspecified",
      }],
    }, d1),
    (error) => error?.code === "return_date_before_previous_return" && error?.status === 409,
  );
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM mutation_commands").get().count, commandsBefore);
  assert.equal(sqlite.prepare("SELECT quantity_returned FROM class_loan_items").get().quantity_returned, 1);

  const closed = await mutation.returnClassLoanItems(actor, {
    requestId: "20000000-0000-4000-8000-000000000004",
    classLoanId: issued.classLoanId,
    expectedVersion: 2,
    returnedAt: "2026-10-11",
    notes: "Повернено",
    items: [{
      classLoanItemId,
      quantity: 1,
      returnLocationId: "LOC-001",
      condition: "unspecified",
    }],
  }, d1);
  assert.equal(closed.status, "closed");
  assert.equal(closed.version, 3);
  assert.equal((await directory.listOpenClassLoans(d1)).length, 0);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM class_loan_transactions").get().count, 3);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM class_loan_transaction_lines").get().count, 3);
  assert.deepEqual(
    plainRow(sqlite.prepare(`
      SELECT total_quantity, library_quantity, loaned_quantity
      FROM material_stock_totals WHERE material_id = 'CAT-0001'
    `).get()),
    { total_quantity: 5, library_quantity: 5, loaned_quantity: 0 },
  );
});

test("class loan quantity edits, removal and restoration are idempotent and stock-balanced", async () => {
  const { sqlite, d1 } = openDatabase();
  seedActiveClassYear(sqlite);
  const issued = await mutation.issueLoanToClass(actor, {
    requestId: "24000000-0000-4000-8000-000000000001",
    classYearId: "CY-2026-001",
    expectedClassYearVersion: 1,
    responsibleTeacherUserId: "USR-TCH",
    issuedAt: "2026-09-10",
    dueAt: "2027-06-30",
    notes: "Комплект для коригування",
    items: [{
      materialId: "CAT-0001",
      sourceLocationId: "LOC-001",
      condition: "unspecified",
      quantity: 2,
      expectedAvailableQuantity: 5,
    }],
  }, d1);
  const classLoanItemId = issued.items[0].classLoanItemId;
  assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM class_loan_statement_item_links
    WHERE class_loan_item_id = ?
  `).get(classLoanItemId).count, 1);

  const quantityInput = {
    requestId: "24000000-0000-4000-8000-000000000002",
    expectedVersion: 1,
    action: "set_item_quantity",
    classLoanItemId,
    expectedItemVersion: 1,
    quantity: 4,
    reason: "Уточнено кількість у класі",
  };
  const changed = await mutation.adjustClassLoanItem(
    actor,
    issued.classLoanId,
    quantityInput,
    d1,
  );
  assert.deepEqual(
    await mutation.adjustClassLoanItem(actor, issued.classLoanId, quantityInput, d1),
    changed,
  );
  assert.deepEqual(
    {
      version: changed.version,
      itemVersion: changed.itemVersion,
      quantityIssued: changed.quantityIssued,
      lifecycleStatus: changed.lifecycleStatus,
      stockDelta: changed.stockDelta,
    },
    {
      version: 2,
      itemVersion: 2,
      quantityIssued: 4,
      lifecycleStatus: "active",
      stockDelta: -2,
    },
  );
  assert.equal(sqlite.prepare("SELECT quantity FROM holdings").get().quantity, 1);
  assert.deepEqual(
    plainRow(sqlite.prepare(`
      SELECT total_quantity, library_quantity, loaned_quantity
      FROM material_stock_totals WHERE material_id = 'CAT-0001'
    `).get()),
    { total_quantity: 5, library_quantity: 1, loaned_quantity: 4 },
  );
  assert.equal((await statements.readClassIssueStatement(d1, issued.classLoanId)).lines[0].quantityIssued, 4);
  await assert.rejects(
    mutation.adjustClassLoanItem(actor, issued.classLoanId, {
      ...quantityInput,
      expectedVersion: 2,
      expectedItemVersion: 2,
      quantity: 5,
    }, d1),
    (error) => error?.code === "request_id_conflict" && error?.status === 409,
  );

  const removeInput = {
    requestId: "24000000-0000-4000-8000-000000000003",
    expectedVersion: 2,
    action: "remove_item",
    classLoanItemId,
    expectedItemVersion: 2,
    quantity: null,
    reason: "Позицію внесено помилково",
  };
  const removed = await mutation.adjustClassLoanItem(
    actor,
    issued.classLoanId,
    removeInput,
    d1,
  );
  assert.deepEqual(
    await mutation.adjustClassLoanItem(actor, issued.classLoanId, removeInput, d1),
    removed,
  );
  assert.equal(removed.version, 3);
  assert.equal(removed.itemVersion, 3);
  assert.equal(removed.lifecycleStatus, "removed");
  assert.equal(removed.stockDelta, 4);
  assert.deepEqual(
    plainRow(sqlite.prepare(`
      SELECT lifecycle_status, quantity_issued, version, removal_reason,
        removed_by_user_id, removed_at IS NOT NULL AS has_removed_at
      FROM class_loan_items WHERE id = ?
    `).get(classLoanItemId)),
    {
      lifecycle_status: "removed",
      quantity_issued: 4,
      version: 3,
      removal_reason: "Позицію внесено помилково",
      removed_by_user_id: "USR-LIB",
      has_removed_at: 1,
    },
  );
  assert.equal((await directory.listOpenClassLoans(d1)).length, 0);
  assert.equal((await statements.readClassIssueStatement(d1, issued.classLoanId)).lines.length, 0);
  assert.deepEqual(
    plainRow(sqlite.prepare(`
      SELECT total_quantity, library_quantity, loaned_quantity
      FROM material_stock_totals WHERE material_id = 'CAT-0001'
    `).get()),
    { total_quantity: 5, library_quantity: 5, loaned_quantity: 0 },
  );

  const restoreInput = {
    requestId: "24000000-0000-4000-8000-000000000004",
    expectedVersion: 3,
    action: "restore_item",
    classLoanItemId,
    expectedItemVersion: 3,
    quantity: 4,
    reason: "Позицію перевірено та повернуто",
  };
  const restored = await mutation.adjustClassLoanItem(
    actor,
    issued.classLoanId,
    restoreInput,
    d1,
  );
  assert.deepEqual(
    await mutation.adjustClassLoanItem(actor, issued.classLoanId, restoreInput, d1),
    restored,
  );
  assert.equal(restored.version, 4);
  assert.equal(restored.itemVersion, 4);
  assert.equal(restored.lifecycleStatus, "active");
  assert.equal(restored.stockDelta, -4);
  assert.deepEqual(
    plainRow(sqlite.prepare(`
      SELECT lifecycle_status, quantity_issued, version, removal_reason,
        removed_by_user_id, removed_at
      FROM class_loan_items WHERE id = ?
    `).get(classLoanItemId)),
    {
      lifecycle_status: "active",
      quantity_issued: 4,
      version: 4,
      removal_reason: "",
      removed_by_user_id: null,
      removed_at: null,
    },
  );
  assert.equal((await directory.listOpenClassLoans(d1))[0].items[0].quantityOutstanding, 4);
  assert.equal((await statements.readClassIssueStatement(d1, issued.classLoanId)).lines[0].quantityIssued, 4);
  assert.deepEqual(
    sqlite.prepare(`
      SELECT action, quantity_before, quantity_after, stock_delta
      FROM class_loan_item_adjustments
      WHERE class_loan_item_id = ?
      ORDER BY created_at, rowid
    `).all(classLoanItemId).map(plainRow),
    [
      { action: "quantity_changed", quantity_before: 2, quantity_after: 4, stock_delta: -2 },
      { action: "removed", quantity_before: 4, quantity_after: 4, stock_delta: 4 },
      { action: "restored", quantity_before: 4, quantity_after: 4, stock_delta: -4 },
    ],
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM class_loan_transactions").get().count, 4);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM class_loan_item_adjustments").get().count, 3);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM mutation_commands").get().count, 4);
  assert.deepEqual(
    plainRow(sqlite.prepare(`
      SELECT total_quantity, library_quantity, loaned_quantity
      FROM material_stock_totals WHERE material_id = 'CAT-0001'
    `).get()),
    { total_quantity: 5, library_quantity: 1, loaned_quantity: 4 },
  );
});

test("a stale class-loan item adjustment aborts atomically", async () => {
  const { sqlite, d1 } = openDatabase();
  seedActiveClassYear(sqlite);
  const issued = await mutation.issueLoanToClass(actor, {
    requestId: "25000000-0000-4000-8000-000000000001",
    classYearId: "CY-2026-001",
    expectedClassYearVersion: 1,
    responsibleTeacherUserId: "USR-TCH",
    issuedAt: "2026-09-10",
    dueAt: null,
    notes: null,
    items: [{
      materialId: "CAT-0001",
      sourceLocationId: "LOC-001",
      condition: "unspecified",
      quantity: 2,
      expectedAvailableQuantity: 5,
    }],
  }, d1);
  const classLoanItemId = issued.items[0].classLoanItemId;
  d1.beforeBatch = () => {
    sqlite.prepare(`
      UPDATE class_loan_items SET version = version + 1 WHERE id = ?
    `).run(classLoanItemId);
  };
  await assert.rejects(
    mutation.adjustClassLoanItem(actor, issued.classLoanId, {
      requestId: "25000000-0000-4000-8000-000000000002",
      expectedVersion: 1,
      action: "set_item_quantity",
      classLoanItemId,
      expectedItemVersion: 1,
      quantity: 3,
      reason: "Конкурентне уточнення",
    }, d1),
    (error) => error?.code === "class_loan_adjustment_conflict" && error?.status === 409,
  );
  assert.deepEqual(
    plainRow(sqlite.prepare(`
      SELECT quantity_issued, lifecycle_status, version FROM class_loan_items WHERE id = ?
    `).get(classLoanItemId)),
    { quantity_issued: 2, lifecycle_status: "active", version: 2 },
  );
  assert.deepEqual(
    plainRow(sqlite.prepare("SELECT version, status FROM class_loans").get()),
    { version: 1, status: "open" },
  );
  assert.equal(sqlite.prepare("SELECT quantity FROM holdings").get().quantity, 3);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM class_loan_item_adjustments").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM mutation_commands").get().count, 1);
});

test("a removed item cannot be restored after or concurrently with class closure", async () => {
  for (const [index, scenario] of ["already-closed", "closure-race"].entries()) {
    const { sqlite, d1 } = openDatabase();
    seedActiveClassYear(sqlite);
    const issued = await mutation.issueLoanToClass(actor, {
      requestId: `25500000-0000-4000-8000-00000000000${index * 3 + 1}`,
      classYearId: "CY-2026-001",
      expectedClassYearVersion: 1,
      expectedClassLoanId: null,
      responsibleTeacherUserId: "USR-TCH",
      issuedAt: "2026-09-10",
      dueAt: null,
      notes: null,
      items: [{
        materialId: "CAT-0001",
        sourceLocationId: "LOC-001",
        condition: "unspecified",
        quantity: 2,
        expectedAvailableQuantity: 5,
      }],
    }, d1);
    const classLoanItemId = issued.items[0].classLoanItemId;
    const removed = await mutation.adjustClassLoanItem(actor, issued.classLoanId, {
      requestId: `25500000-0000-4000-8000-00000000000${index * 3 + 2}`,
      expectedVersion: 1,
      action: "remove_item",
      classLoanItemId,
      expectedItemVersion: 1,
      quantity: null,
      reason: "Позицію додано помилково",
    }, d1);
    if (scenario === "already-closed") {
      sqlite.exec(`
        UPDATE class_years
        SET status = 'closed', actual_closed_date = '2027-06-30'
        WHERE id = 'CY-2026-001'
      `);
    } else {
      d1.beforeBatch = () => {
        sqlite.exec(`
          UPDATE class_years
          SET status = 'closed', actual_closed_date = '2027-06-30'
          WHERE id = 'CY-2026-001'
        `);
      };
    }

    await assert.rejects(
      mutation.adjustClassLoanItem(actor, issued.classLoanId, {
        requestId: `25500000-0000-4000-8000-00000000000${index * 3 + 3}`,
        expectedVersion: removed.version,
        action: "restore_item",
        classLoanItemId,
        expectedItemVersion: removed.itemVersion,
        quantity: 2,
        reason: "Спроба відновлення після закриття класу",
      }, d1),
      (error) => error?.code === (
        scenario === "already-closed"
          ? "class_loan_class_closed"
          : "class_loan_adjustment_conflict"
      ) && error?.status === 409,
    );
    assert.deepEqual(
      plainRow(sqlite.prepare(`
        SELECT lifecycle_status, quantity_issued, version
        FROM class_loan_items WHERE id = ?
      `).get(classLoanItemId)),
      { lifecycle_status: "removed", quantity_issued: 2, version: 2 },
    );
    assert.equal(sqlite.prepare("SELECT quantity FROM holdings WHERE material_id = 'CAT-0001'").get().quantity, 5);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM class_loan_item_adjustments").get().count, 1);
  }
});

test("a legacy item keeps its original issue date after a quantity correction", async () => {
  const { sqlite, d1 } = openDatabase();
  seedActiveClassYear(sqlite);
  const issuedAt = "2026-09-01";
  const adjustedAt = "2026-09-10T10:00:00.000Z";
  sqlite.prepare(`
    INSERT INTO class_loans (
      id,class_year_id,responsible_teacher_user_id,status,issued_at,due_at,closed_at,notes,
      issue_statement_schema_version,issue_statement_json,issue_statement_origin,
      issued_by_user_id,closed_by_user_id,version,created_at,updated_at
    ) VALUES (
      'CLOAN-MANAGEMENT-DATE','CY-2026-001','USR-TCH','open',?,'2027-06-30',NULL,'',
      0,'','legacy','USR-LIB',NULL,2,?,?
    )
  `).run(issuedAt, issuedAt, adjustedAt);
  sqlite.prepare(`
    INSERT INTO class_loan_items (
      id,class_loan_id,material_id,source_location_id,condition,quantity_issued,
      quantity_returned,lifecycle_status,version,notes,created_at,updated_at
    ) VALUES (
      'CLI-MANAGEMENT-DATE','CLOAN-MANAGEMENT-DATE','CAT-0001','LOC-001',
      'unspecified',3,0,'active',2,'',?,?
    )
  `).run(issuedAt, adjustedAt);
  sqlite.prepare(`
    INSERT INTO class_loan_statement_lines (
      id,class_loan_id,transaction_id,position,subject,title,author,
      publication_year,rubric,quantity_issued,created_at
    ) VALUES (
      'CLSL-MANAGEMENT-DATE','CLOAN-MANAGEMENT-DATE',NULL,1,'Математика',
      'Стара назва','Автор',2020,'Підручники',2,?
    )
  `).run(issuedAt);
  sqlite.prepare(`
    INSERT INTO class_loan_statement_item_links (
      statement_line_id,class_loan_item_id,origin,created_at
    ) VALUES (
      'CLSL-MANAGEMENT-DATE','CLI-MANAGEMENT-DATE','legacy_exact',?
    )
  `).run(issuedAt);
  sqlite.prepare(`
    INSERT INTO class_loan_transactions (
      id,request_id,class_loan_id,kind,occurred_at,notes,actor_user_id,created_at
    ) VALUES (
      'CLTX-MANAGEMENT-ADJUST','REQ-MANAGEMENT-ADJUST-TX','CLOAN-MANAGEMENT-DATE',
      'issue','2026-09-10','Коригування відомості','USR-LIB',?
    )
  `).run(adjustedAt);
  sqlite.prepare(`
    INSERT INTO class_loan_transaction_lines (
      id,transaction_id,class_loan_item_id,material_id,location_id,condition,
      quantity_delta,quantity_before,quantity_after,created_at
    ) VALUES (
      'CLINE-MANAGEMENT-ADJUST','CLTX-MANAGEMENT-ADJUST','CLI-MANAGEMENT-DATE',
      'CAT-0001','LOC-001','unspecified',-1,4,3,?
    )
  `).run(adjustedAt);
  sqlite.prepare(`
    INSERT INTO class_loan_item_adjustments (
      id,request_id,class_loan_id,class_loan_item_id,statement_line_id,transaction_id,
      action,quantity_before,quantity_after,quantity_returned_snapshot,stock_delta,
      location_id,condition,reason,actor_user_id,created_at
    ) VALUES (
      'CLADJ-MANAGEMENT-DATE','REQ-MANAGEMENT-ADJUST','CLOAN-MANAGEMENT-DATE',
      'CLI-MANAGEMENT-DATE','CLSL-MANAGEMENT-DATE','CLTX-MANAGEMENT-ADJUST',
      'quantity_changed',2,3,0,-1,'LOC-001','unspecified',
      'Звірено з класним журналом','USR-LIB',?
    )
  `).run(adjustedAt);

  const detail = await management.readClassLoanManagement(d1, "CLOAN-MANAGEMENT-DATE");
  assert.equal(detail.items[0].itemIssuedAt, issuedAt);
  assert.deepEqual(detail.history.map((event) => event.kind), ["adjustment"]);
});

test("a librarian can review and link an ambiguous legacy item before editing it", async () => {
  const { sqlite, d1 } = openDatabase();
  seedActiveClassYear(sqlite);
  const createdAt = "2026-09-01T08:00:00.000Z";
  sqlite.prepare(`
    INSERT INTO class_loans (
      id,class_year_id,responsible_teacher_user_id,status,issued_at,due_at,closed_at,notes,
      issue_statement_schema_version,issue_statement_json,issue_statement_origin,
      issued_by_user_id,closed_by_user_id,version,created_at,updated_at
    ) VALUES (
      'CLOAN-LEGACY-REVIEW','CY-2026-001','USR-TCH','open','2026-09-01','2027-06-30',NULL,'',
      0,'','legacy','USR-LIB',NULL,1,?,?
    )
  `).run(createdAt, createdAt);
  sqlite.prepare(`
    INSERT INTO class_loan_items (
      id,class_loan_id,material_id,source_location_id,condition,quantity_issued,
      quantity_returned,lifecycle_status,version,notes,created_at,updated_at
    ) VALUES (
      'CLI-LEGACY-REVIEW','CLOAN-LEGACY-REVIEW','CAT-0001','LOC-001',
      'unspecified',2,0,'active',1,'',?,?
    )
  `).run(createdAt, createdAt);
  sqlite.prepare(`
    INSERT INTO class_loan_statement_lines (
      id,class_loan_id,transaction_id,position,subject,title,author,
      publication_year,rubric,quantity_issued,created_at
    ) VALUES (
      'CLSL-LEGACY-REVIEW','CLOAN-LEGACY-REVIEW',NULL,1,'Математика',
      'Стара назва підручника','Автор',2020,'Підручники',2,?
    )
  `).run(createdAt);

  const before = await management.readClassLoanManagement(d1, "CLOAN-LEGACY-REVIEW");
  assert.equal(before.items[0].editable, false);
  assert.equal(before.items[0].editBlockedReason, "statement_item_link_missing");
  assert.equal(before.legacyStatementCandidates[0].statementLineId, "CLSL-LEGACY-REVIEW");

  const input = {
    requestId: "25800000-0000-4000-8000-000000000001",
    expectedVersion: 1,
    action: "link_legacy_item",
    classLoanItemId: "CLI-LEGACY-REVIEW",
    expectedItemVersion: 1,
    statementLineId: "CLSL-LEGACY-REVIEW",
    reason: "Зіставлено бібліотекарем із паперовою відомістю",
  };
  const linked = await mutation.linkLegacyClassLoanItem(
    actor,
    "CLOAN-LEGACY-REVIEW",
    input,
    d1,
  );
  assert.deepEqual(
    await mutation.linkLegacyClassLoanItem(actor, "CLOAN-LEGACY-REVIEW", input, d1),
    linked,
  );
  assert.equal(linked.version, 2);
  assert.deepEqual(
    plainRow(sqlite.prepare(`
      SELECT statement_line_id, class_loan_item_id, origin
      FROM class_loan_statement_item_links
    `).get()),
    {
      statement_line_id: "CLSL-LEGACY-REVIEW",
      class_loan_item_id: "CLI-LEGACY-REVIEW",
      origin: "legacy_reviewed",
    },
  );
  const after = await management.readClassLoanManagement(d1, "CLOAN-LEGACY-REVIEW");
  assert.equal(after.items[0].editable, true);
  assert.equal(after.legacyStatementCandidates.length, 0);
  assert.equal(after.history[0].action, "class_loan.legacy_item_linked");
});

test("later class issues append to one cumulative loan and statement", async () => {
  const { sqlite, d1 } = openDatabase();
  seedActiveClassYear(sqlite);
  const now = "2026-08-11T08:00:00.000Z";
  sqlite.prepare(`
    UPDATE holdings SET quantity = 5, version = 2
    WHERE material_id = 'CAT-0001' AND location_id = 'LOC-001'
  `).run();
  sqlite.prepare(`
    INSERT INTO materials (
      id, catalog_number, title, sort_title, search_text, rubric,
      publication_type, subject, author, publication_year, isbn,
      isbn_normalized, publisher, notes, status, version,
      created_at, updated_at, archived_at
    ) VALUES (
      'CAT-0002', 2, 'Українська література', 'українська література',
      'українська література автор', 'Підручники', 'Підручник',
      'Українська література', 'Другий автор', 2025, '', '', '', '',
      'active', 1, ?, ?, NULL
    )
  `).run(now, now);
  sqlite.prepare(`
    INSERT INTO holdings (material_id, location_id, condition, quantity, version, updated_at)
    VALUES ('CAT-0002', 'LOC-001', 'unspecified', 20, 1, ?)
  `).run(now);

  const firstInput = {
    requestId: "21000000-0000-4000-8000-000000000001",
    classYearId: "CY-2026-001",
    expectedClassYearVersion: 1,
    responsibleTeacherUserId: "USR-TCH",
    issuedAt: "2026-09-01",
    dueAt: "2027-06-30",
    notes: "Перший список",
    items: [{
      materialId: "CAT-0001",
      sourceLocationId: "LOC-001",
      condition: "unspecified",
      quantity: 1,
      expectedAvailableQuantity: 5,
    }],
  };
  const first = await mutation.issueLoanToClass(actor, firstInput, d1);
  assert.equal(first.appended, false);
  assert.equal(first.version, 1);

  const second = await mutation.issueLoanToClass(actor, {
    ...firstInput,
    requestId: "21000000-0000-4000-8000-000000000002",
    issuedAt: "2026-09-02",
    notes: "Додано до списку",
    items: [{
      materialId: "CAT-0002",
      sourceLocationId: "LOC-001",
      condition: "unspecified",
      quantity: 17,
      expectedAvailableQuantity: 20,
    }],
  }, d1);
  assert.equal(second.classLoanId, first.classLoanId);
  assert.equal(second.appended, true);
  assert.equal(second.version, 2);

  const thirdInput = {
    ...firstInput,
    requestId: "21000000-0000-4000-8000-000000000003",
    issuedAt: "2026-09-03",
    notes: "Ще примірники першої назви",
    items: [{
      materialId: "CAT-0001",
      sourceLocationId: "LOC-001",
      condition: "unspecified",
      quantity: 2,
      expectedAvailableQuantity: 4,
    }],
  };
  const third = await mutation.issueLoanToClass(actor, thirdInput, d1);
  assert.equal(third.classLoanId, first.classLoanId);
  assert.equal(third.version, 3);
  assert.deepEqual(await mutation.issueLoanToClass(actor, thirdInput, d1), third);

  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM class_loans").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM class_loan_transactions").get().count, 3);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM class_loan_items").get().count, 3);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM class_loan_statement_lines").get().count, 3);
  const statement = await statements.readClassIssueStatement(d1, first.classLoanId);
  assert.equal(statement.classLoanId, first.classLoanId);
  assert.deepEqual(statement.lines.map((line) => ({
    title: line.title,
    quantityIssued: line.quantityIssued,
  })), [
    { title: "Стара назва", quantityIssued: 3 },
    { title: "Українська література", quantityIssued: 17 },
  ]);
  await assert.rejects(
    mutation.returnClassLoanItems(actor, {
      requestId: "21000000-0000-4000-8000-000000000004",
      classLoanId: first.classLoanId,
      expectedVersion: 3,
      returnedAt: "2026-09-01",
      notes: null,
      items: [{
        classLoanItemId: second.items[0].classLoanItemId,
        quantity: 1,
        returnLocationId: "LOC-001",
        condition: "unspecified",
      }],
    }, d1),
    (error) => error?.code === "return_date_invalid"
      && error?.details?.issuedAt === "2026-09-02",
  );
  assert.equal(sqlite.prepare("SELECT version FROM class_loans").get().version, 3);
});

test("append targets the same loan and ignores later technical correction dates", async () => {
  const { sqlite, d1 } = openDatabase();
  seedActiveClassYear(sqlite);
  const now = "2026-08-11T08:00:00.000Z";
  sqlite.prepare(`
    INSERT INTO materials (
      id, catalog_number, title, sort_title, search_text, rubric,
      publication_type, subject, author, publication_year, isbn,
      isbn_normalized, publisher, notes, status, version,
      created_at, updated_at, archived_at
    ) VALUES (
      'CAT-0002', 2, 'Другий підручник', 'другий підручник',
      'другий підручник', 'Підручники', 'Підручник', 'Математика',
      'Другий автор', 2025, '', '', '', '', 'active', 1, ?, ?, NULL
    )
  `).run(now, now);
  sqlite.prepare(`
    INSERT INTO holdings (material_id, location_id, condition, quantity, version, updated_at)
    VALUES ('CAT-0002', 'LOC-001', 'unspecified', 3, 1, ?)
  `).run(now);

  const first = await mutation.issueLoanToClass(actor, {
    requestId: "21500000-0000-4000-8000-000000000001",
    classYearId: "CY-2026-001",
    expectedClassYearVersion: 1,
    expectedClassLoanId: null,
    responsibleTeacherUserId: "USR-TCH",
    issuedAt: "2026-09-01",
    dueAt: "2027-06-30",
    notes: null,
    items: [{
      materialId: "CAT-0001",
      sourceLocationId: "LOC-001",
      condition: "unspecified",
      quantity: 1,
      expectedAvailableQuantity: 5,
    }],
  }, d1);
  const firstItemId = first.items[0].classLoanItemId;
  const correctionCreatedAt = "2026-09-20T08:00:00.000Z";
  sqlite.prepare(`
    INSERT INTO class_loan_transactions (
      id, request_id, class_loan_id, kind, occurred_at, notes,
      actor_user_id, created_at
    ) VALUES (
      'CLTX-LATER-CORRECTION', 'REQ-LATER-CORRECTION', ?, 'issue',
      '2026-09-20', 'Технічне коригування', 'USR-LIB', ?
    )
  `).run(first.classLoanId, correctionCreatedAt);
  sqlite.prepare(`
    INSERT INTO class_loan_transaction_lines (
      id, transaction_id, class_loan_item_id, material_id, location_id,
      condition, quantity_delta, quantity_before, quantity_after, created_at
    ) VALUES (
      'CLINE-LATER-CORRECTION', 'CLTX-LATER-CORRECTION', ?, 'CAT-0001',
      'LOC-001', 'unspecified', -1, 4, 3, ?
    )
  `).run(firstItemId, correctionCreatedAt);
  sqlite.prepare(`
    INSERT INTO class_loan_item_adjustments (
      id, request_id, class_loan_id, class_loan_item_id, statement_line_id,
      transaction_id, action, quantity_before, quantity_after,
      quantity_returned_snapshot, stock_delta, location_id, condition,
      reason, actor_user_id, created_at
    ) VALUES (
      'CLADJ-LATER-CORRECTION', 'REQ-LATER-CORRECTION', ?, ?, NULL,
      'CLTX-LATER-CORRECTION', 'quantity_changed', 1, 2, 0, -1,
      'LOC-001', 'unspecified', 'Уточнена кількість', 'USR-LIB', ?
    )
  `).run(first.classLoanId, firstItemId, correctionCreatedAt);

  const appendInput = {
    requestId: "21500000-0000-4000-8000-000000000002",
    classYearId: "CY-2026-001",
    expectedClassYearVersion: 1,
    expectedClassLoanId: first.classLoanId,
    responsibleTeacherUserId: "USR-TCH",
    issuedAt: "2026-09-02",
    dueAt: "2027-06-30",
    notes: "Додано до чинної відомості",
    items: [{
      materialId: "CAT-0002",
      sourceLocationId: "LOC-001",
      condition: "unspecified",
      quantity: 1,
      expectedAvailableQuantity: 3,
    }],
  };
  await assert.rejects(
    mutation.issueLoanToClass(actor, {
      ...appendInput,
      requestId: "21500000-0000-4000-8000-000000000003",
      expectedClassLoanId: "CLOAN-OTHER",
    }, d1),
    (error) => error?.code === "class_loan_target_conflict" && error?.status === 409,
  );

  const appended = await mutation.issueLoanToClass(actor, appendInput, d1);
  assert.equal(appended.classLoanId, first.classLoanId);
  assert.equal(appended.appended, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM class_loans").get().count, 1);
});

test("a concurrent append cannot use the version written by another class issue", async () => {
  const { sqlite, d1 } = openDatabase();
  seedActiveClassYear(sqlite);
  const first = await mutation.issueLoanToClass(actor, {
    requestId: "22000000-0000-4000-8000-000000000001",
    classYearId: "CY-2026-001",
    expectedClassYearVersion: 1,
    responsibleTeacherUserId: "USR-TCH",
    issuedAt: "2026-09-01",
    dueAt: "2027-06-30",
    notes: null,
    items: [{
      materialId: "CAT-0001",
      sourceLocationId: "LOC-001",
      condition: "unspecified",
      quantity: 1,
      expectedAvailableQuantity: 5,
    }],
  }, d1);
  d1.beforeBatch = () => {
    sqlite.prepare("UPDATE class_loans SET version=version+1 WHERE id=?").run(first.classLoanId);
  };
  await assert.rejects(
    mutation.issueLoanToClass(actor, {
      requestId: "22000000-0000-4000-8000-000000000002",
      classYearId: "CY-2026-001",
      expectedClassYearVersion: 1,
      responsibleTeacherUserId: "USR-TCH",
      issuedAt: "2026-09-02",
      dueAt: "2027-06-30",
      notes: null,
      items: [{
        materialId: "CAT-0001",
        sourceLocationId: "LOC-001",
        condition: "unspecified",
        quantity: 1,
        expectedAvailableQuantity: 4,
      }],
    }, d1),
    (error) => error?.code === "class_loan_version_conflict" && error?.status === 409,
  );
  assert.equal(sqlite.prepare("SELECT version FROM class_loans").get().version, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM class_loan_transactions").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM class_loan_items").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM class_loan_statement_lines").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM mutation_commands").get().count, 1);
  assert.equal(sqlite.prepare("SELECT quantity FROM holdings WHERE material_id='CAT-0001'").get().quantity, 4);
});

test("the first append backfills a post-migration legacy class issue into the cumulative statement", async () => {
  const { sqlite, d1 } = openDatabase();
  seedActiveClassYear(sqlite);
  const createdAt = "2026-09-01T08:00:00.000Z";
  sqlite.prepare(`
    INSERT INTO class_loans (
      id,class_year_id,responsible_teacher_user_id,status,issued_at,due_at,closed_at,notes,
      issue_statement_schema_version,issue_statement_json,issue_statement_origin,
      issued_by_user_id,closed_by_user_id,version,created_at,updated_at
    ) VALUES (
      'CLOAN-POST-MIGRATION-LEGACY','CY-2026-001','USR-TCH','open','2026-09-01',
      '2027-06-30',NULL,'',0,'','legacy','USR-LIB',NULL,1,?,?
    )
  `).run(createdAt, createdAt);
  sqlite.prepare(`
    INSERT INTO class_loan_items (
      id,class_loan_id,material_id,source_location_id,condition,quantity_issued,
      quantity_returned,notes,created_at,updated_at
    ) VALUES (
      'CLI-POST-MIGRATION-LEGACY','CLOAN-POST-MIGRATION-LEGACY','CAT-0001',
      'LOC-001','unspecified',1,0,'',?,?
    )
  `).run(createdAt, createdAt);

  const appended = await mutation.issueLoanToClass(actor, {
    requestId: "23000000-0000-4000-8000-000000000001",
    classYearId: "CY-2026-001",
    expectedClassYearVersion: 1,
    responsibleTeacherUserId: "USR-TCH",
    issuedAt: "2026-09-02",
    dueAt: "2027-06-30",
    notes: null,
    items: [{
      materialId: "CAT-0001",
      sourceLocationId: "LOC-001",
      condition: "unspecified",
      quantity: 1,
      expectedAvailableQuantity: 5,
    }],
  }, d1);
  assert.equal(appended.classLoanId, "CLOAN-POST-MIGRATION-LEGACY");
  assert.equal(appended.appended, true);
  const statement = await statements.readClassIssueStatement(d1, appended.classLoanId);
  assert.equal(statement.lines.length, 1);
  assert.equal(statement.lines[0].title, "Стара назва");
  assert.equal(statement.lines[0].quantityIssued, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM class_loan_statement_lines").get().count, 2);
});

test("class circulation keeps a constant D1 query and batch budget for 100 items", async () => {
  const { sqlite, d1 } = openDatabase();
  seedActiveClassYear(sqlite);
  const now = "2026-08-11T08:00:00.000Z";
  const items = [];
  for (let index = 0; index < 100; index += 1) {
    const catalogNumber = 1000 + index;
    const materialId = `CAT-${catalogNumber}`;
    sqlite.prepare(`
      INSERT INTO materials (
        id, catalog_number, title, sort_title, search_text, rubric,
        publication_type, subject, author, publication_year, isbn,
        isbn_normalized, publisher, notes, status, version,
        created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, 'Підручники', 'Підручник', '', '', 2026,
        '', '', '', '', 'active', 1, ?, ?, NULL)
    `).run(materialId, catalogNumber, `Книга ${index}`, `книга ${index}`, `книга ${index}`, now, now);
    sqlite.prepare(`
      INSERT INTO holdings (material_id, location_id, condition, quantity, version, updated_at)
      VALUES (?, 'LOC-001', 'good', 1, 1, ?)
    `).run(materialId, now);
    items.push({
      materialId,
      sourceLocationId: "LOC-001",
      condition: "good",
      quantity: 1,
      expectedAvailableQuantity: 1,
    });
  }
  d1.queryCount = 0;
  d1.batchStatementCounts = [];
  const issued = await mutation.issueLoanToClass(actor, {
    requestId: "20000000-0000-4000-8000-000000000010",
    classYearId: "CY-2026-001",
    expectedClassYearVersion: 1,
    responsibleTeacherUserId: "USR-TCH",
    issuedAt: "2026-09-10",
    dueAt: null,
    notes: null,
    items,
  }, d1);
  assert.equal(issued.items.length, 100);
  assert.ok(d1.queryCount <= 10, `issue query count ${d1.queryCount}`);
  assert.ok(Math.max(...d1.batchStatementCounts) <= 15, d1.batchStatementCounts);

  d1.queryCount = 0;
  d1.batchStatementCounts = [];
  const returned = await mutation.returnClassLoanItems(actor, {
    requestId: "20000000-0000-4000-8000-000000000011",
    classLoanId: issued.classLoanId,
    expectedVersion: 1,
    returnedAt: "2026-10-01",
    notes: null,
    items: issued.items.map((item) => ({
      classLoanItemId: item.classLoanItemId,
      quantity: 1,
      returnLocationId: "LOC-001",
      condition: "good",
    })),
  }, d1);
  assert.equal(returned.status, "closed");
  assert.ok(d1.queryCount <= 10, `return query count ${d1.queryCount}`);
  assert.ok(Math.max(...d1.batchStatementCounts) <= 15, d1.batchStatementCounts);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM holdings WHERE quantity = 1").get().count, 100);
});

test("class issue enforces class-year dates and outstanding class stock blocks archive", async () => {
  const { sqlite, d1 } = openDatabase();
  seedActiveClassYear(sqlite);
  const base = {
    classYearId: "CY-2026-001",
    expectedClassYearVersion: 1,
    responsibleTeacherUserId: "USR-TCH",
    notes: null,
    items: [{
      materialId: "CAT-0001",
      sourceLocationId: "LOC-001",
      condition: "unspecified",
      quantity: 1,
      expectedAvailableQuantity: 5,
    }],
  };
  await assert.rejects(
    mutation.issueLoanToClass(actor, {
      ...base,
      requestId: "20000000-0000-4000-8000-000000000020",
      issuedAt: "2026-08-31",
      dueAt: null,
    }, d1),
    (error) => error?.code === "issue_date_outside_class_year",
  );
  await assert.rejects(
    mutation.issueLoanToClass(actor, {
      ...base,
      requestId: "20000000-0000-4000-8000-000000000021",
      issuedAt: "2026-09-01",
      dueAt: "2027-07-01",
    }, d1),
    (error) => error?.code === "due_date_outside_class_year",
  );
  sqlite.prepare("UPDATE holdings SET quantity = 1, version = 2 WHERE material_id = 'CAT-0001'").run();
  const issued = await mutation.issueLoanToClass(actor, {
    ...base,
    requestId: "20000000-0000-4000-8000-000000000022",
    issuedAt: "2026-09-01",
    dueAt: "2027-06-30",
    items: [{ ...base.items[0], expectedAvailableQuantity: 1 }],
  }, d1);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM holdings WHERE material_id = 'CAT-0001'").get().count, 0);
  await assert.rejects(
    mutation.archiveMaterialDirect(actor, "CAT-0001", {
      requestId: "20000000-0000-4000-8000-000000000023",
      expectedVersion: 1,
    }, d1),
    (error) => error?.code === "material_has_stock"
      && error.details.totalQuantity === 1
      && error.details.loanedQuantity === 1,
  );
  assert.equal(sqlite.prepare("SELECT status FROM class_loans WHERE id = ?").get(issued.classLoanId).status, "open");
});

test("removed class-loan history does not block a zero-stock material archive", async () => {
  const { sqlite, d1 } = openDatabase();
  seedActiveClassYear(sqlite);
  const now = "2026-09-10T08:00:00.000Z";
  sqlite.exec("DELETE FROM holdings WHERE material_id = 'CAT-0001'");
  sqlite.exec(`
    UPDATE material_stock_totals
    SET total_quantity = 0, library_quantity = 0,
        other_location_quantity = 0, loaned_quantity = 0
    WHERE material_id = 'CAT-0001'
  `);
  sqlite.prepare(`
    INSERT INTO class_loans (
      id, class_year_id, responsible_teacher_user_id, status,
      issued_at, due_at, closed_at, notes, issued_by_user_id,
      closed_by_user_id, version, created_at, updated_at
    ) VALUES (
      'CLOAN-ARCHIVE-REMOVED', 'CY-2026-001', 'USR-TCH', 'open',
      '2026-09-10', NULL, NULL, '', 'USR-LIB', NULL, 1, ?, ?
    )
  `).run(now, now);
  sqlite.prepare(`
    INSERT INTO class_loan_items (
      id, class_loan_id, material_id, source_location_id, condition,
      quantity_issued, quantity_returned, lifecycle_status, version,
      removed_at, removed_by_user_id, removal_reason, notes, created_at, updated_at
    ) VALUES (
      'CLI-ARCHIVE-REMOVED', 'CLOAN-ARCHIVE-REMOVED', 'CAT-0001', 'LOC-001',
      'unspecified', 1, 0, 'removed', 2, ?, 'USR-LIB', 'Помилкова позиція', '', ?, ?
    )
  `).run(now, now, now);

  const archived = await mutation.archiveMaterialDirect(actor, "CAT-0001", {
    requestId: "20000000-0000-4000-8000-000000000026",
    expectedVersion: 1,
  }, d1);

  assert.equal(archived.version, 2);
  assert.equal(sqlite.prepare("SELECT status FROM materials WHERE id = 'CAT-0001'").get().status, "archived");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM class_loan_items WHERE id = 'CLI-ARCHIVE-REMOVED'").get().count, 1);
});

test("class issue loses atomically when its source material or location is deactivated", async () => {
  const issueInput = {
    classYearId: "CY-2026-001",
    expectedClassYearVersion: 1,
    responsibleTeacherUserId: "USR-TCH",
    issuedAt: "2026-09-10",
    dueAt: null,
    notes: null,
    items: [{
      materialId: "CAT-0001",
      sourceLocationId: "LOC-001",
      condition: "unspecified",
      quantity: 1,
      expectedAvailableQuantity: 5,
    }],
  };

  for (const scenario of ["material", "location"]) {
    const { sqlite, d1 } = openDatabase();
    seedActiveClassYear(sqlite);
    d1.beforeBatch = () => {
      if (scenario === "material") {
        sqlite.prepare(`
          UPDATE materials
          SET status = 'archived', archived_at = '2026-09-10T00:00:00.000Z'
          WHERE id = 'CAT-0001'
        `).run();
      } else {
        sqlite.prepare("UPDATE locations SET status = 'inactive' WHERE id = 'LOC-001'").run();
      }
    };
    await assert.rejects(
      mutation.issueLoanToClass(actor, {
        ...issueInput,
        requestId: scenario === "material"
          ? "20000000-0000-4000-8000-000000000024"
          : "20000000-0000-4000-8000-000000000025",
      }, d1),
      (error) => error?.code === "stock_quantity_conflict" && error?.status === 409,
    );
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM class_loans").get().count, 0);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM class_loan_items").get().count, 0);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM class_loan_transactions").get().count, 0);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM class_loan_transaction_lines").get().count, 0);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM mutation_commands").get().count, 0);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM audit_events").get().count, 0);
    assert.equal(sqlite.prepare("SELECT quantity FROM holdings WHERE material_id = 'CAT-0001'").get().quantity, 5);
  }
});

test("class return loses atomically when a later return wins the chronology race", async () => {
  const { sqlite, d1 } = openDatabase();
  seedActiveClassYear(sqlite);
  const issued = await mutation.issueLoanToClass(actor, {
    requestId: "20000000-0000-4000-8000-000000000026",
    classYearId: "CY-2026-001",
    expectedClassYearVersion: 1,
    responsibleTeacherUserId: "USR-TCH",
    issuedAt: "2026-09-10",
    dueAt: null,
    notes: null,
    items: [{
      materialId: "CAT-0001",
      sourceLocationId: "LOC-001",
      condition: "unspecified",
      quantity: 2,
      expectedAvailableQuantity: 5,
    }],
  }, d1);
  d1.beforeBatch = () => {
    sqlite.prepare(`
      INSERT INTO class_loan_transactions (
        id, request_id, class_loan_id, kind, occurred_at, notes,
        actor_user_id, created_at
      ) VALUES (
        'CLTX-CONCURRENT', '20000000-0000-4000-8000-000000000027', ?,
        'return', '2026-10-06', '', 'USR-LIB', '2026-10-06T00:00:00.000Z'
      )
    `).run(issued.classLoanId);
  };
  await assert.rejects(
    mutation.returnClassLoanItems(actor, {
      requestId: "20000000-0000-4000-8000-000000000028",
      classLoanId: issued.classLoanId,
      expectedVersion: 1,
      returnedAt: "2026-10-05",
      notes: null,
      items: [{
        classLoanItemId: issued.items[0].classLoanItemId,
        quantity: 1,
        returnLocationId: "LOC-001",
        condition: "unspecified",
      }],
    }, d1),
    (error) => error?.code === "class_loan_return_conflict" && error?.status === 409,
  );
  assert.equal(sqlite.prepare("SELECT quantity_returned FROM class_loan_items").get().quantity_returned, 0);
  assert.deepEqual(
    plainRow(sqlite.prepare("SELECT status, version FROM class_loans").get()),
    { status: "open", version: 1 },
  );
  assert.equal(sqlite.prepare("SELECT quantity FROM holdings WHERE material_id = 'CAT-0001'").get().quantity, 3);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM class_loan_transactions").get().count, 2);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM class_loan_transaction_lines").get().count, 1);
  assert.equal(sqlite.prepare(`
    SELECT count(*) AS count FROM mutation_commands
    WHERE id = '20000000-0000-4000-8000-000000000028'
  `).get().count, 0);
});

test("class return merges destinations and destination deactivation aborts atomically", async () => {
  const { sqlite, d1 } = openDatabase();
  seedActiveClassYear(sqlite);
  const now = "2026-08-11T08:00:00.000Z";
  sqlite.prepare(`
    INSERT INTO locations (
      id, name, type, status, is_public, sort_order, created_at, updated_at
    ) VALUES ('LOC-002', 'Кабінет 2', 'classroom', 'active', 1, 2, ?, ?)
  `).run(now, now);
  sqlite.prepare(`
    INSERT INTO holdings (
      material_id, location_id, condition, quantity, version, updated_at
    ) VALUES ('CAT-0001', 'LOC-002', 'unspecified', 3, 1, ?)
  `).run(now);
  sqlite.prepare(`
    UPDATE material_stock_totals
    SET total_quantity = 8, library_quantity = 5, other_location_quantity = 3
    WHERE material_id = 'CAT-0001'
  `).run();
  const issued = await mutation.issueLoanToClass(actor, {
    requestId: "20000000-0000-4000-8000-000000000030",
    classYearId: "CY-2026-001",
    expectedClassYearVersion: 1,
    responsibleTeacherUserId: "USR-TCH",
    issuedAt: "2026-09-10",
    dueAt: null,
    notes: null,
    items: [
      {
        materialId: "CAT-0001",
        sourceLocationId: "LOC-001",
        condition: "unspecified",
        quantity: 1,
        expectedAvailableQuantity: 5,
      },
      {
        materialId: "CAT-0001",
        sourceLocationId: "LOC-002",
        condition: "unspecified",
        quantity: 1,
        expectedAvailableQuantity: 3,
      },
    ],
  }, d1);
  const returned = await mutation.returnClassLoanItems(actor, {
    requestId: "20000000-0000-4000-8000-000000000031",
    classLoanId: issued.classLoanId,
    expectedVersion: 1,
    returnedAt: "2026-10-01",
    notes: null,
    items: issued.items.map((item) => ({
      classLoanItemId: item.classLoanItemId,
      quantity: 1,
      returnLocationId: "LOC-001",
      condition: "unspecified",
    })),
  }, d1);
  assert.equal(returned.status, "closed");
  assert.equal(sqlite.prepare(`
    SELECT quantity FROM holdings
    WHERE material_id = 'CAT-0001' AND location_id = 'LOC-001'
  `).get().quantity, 6);
  assert.deepEqual(
    sqlite.prepare(`
      SELECT quantity_before, quantity_after
      FROM class_loan_transaction_lines line
      JOIN class_loan_transactions tx ON tx.id = line.transaction_id
      WHERE tx.kind = 'return'
      ORDER BY line.rowid
    `).all().map(plainRow),
    [
      { quantity_before: 4, quantity_after: 5 },
      { quantity_before: 5, quantity_after: 6 },
    ],
  );

  sqlite.prepare("UPDATE locations SET status = 'active' WHERE id = 'LOC-001'").run();
  sqlite.prepare("UPDATE holdings SET quantity = 5, version = version + 1 WHERE material_id = 'CAT-0001' AND location_id = 'LOC-001'").run();
  const second = await mutation.issueLoanToClass(actor, {
    requestId: "20000000-0000-4000-8000-000000000032",
    classYearId: "CY-2026-001",
    expectedClassYearVersion: 1,
    responsibleTeacherUserId: "USR-TCH",
    issuedAt: "2026-10-02",
    dueAt: null,
    notes: null,
    items: [{
      materialId: "CAT-0001",
      sourceLocationId: "LOC-001",
      condition: "unspecified",
      quantity: 1,
      expectedAvailableQuantity: 5,
    }],
  }, d1);
  d1.beforeBatch = () => {
    sqlite.prepare("UPDATE locations SET status = 'inactive' WHERE id = 'LOC-001'").run();
  };
  await assert.rejects(
    mutation.returnClassLoanItems(actor, {
      requestId: "20000000-0000-4000-8000-000000000033",
      classLoanId: second.classLoanId,
      expectedVersion: 1,
      returnedAt: "2026-10-03",
      notes: null,
      items: [{
        classLoanItemId: second.items[0].classLoanItemId,
        quantity: 1,
        returnLocationId: "LOC-001",
        condition: "unspecified",
      }],
    }, d1),
    (error) => error?.code === "class_loan_return_conflict" && error?.status === 409,
  );
  assert.equal(sqlite.prepare("SELECT quantity_returned FROM class_loan_items WHERE id = ?").get(second.items[0].classLoanItemId).quantity_returned, 0);
  assert.equal(sqlite.prepare("SELECT status FROM class_loans WHERE id = ?").get(second.classLoanId).status, "open");
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM class_loan_transactions WHERE class_loan_id = ?").get(second.classLoanId).count, 1);
});

test("transfer and writeoff commit atomically, rebuild totals and replay once", async () => {
  const { sqlite, d1 } = openDatabase();
  const now = "2026-08-11T08:00:00.000Z";
  sqlite.prepare(`
    INSERT INTO locations (
      id, name, type, status, is_public, sort_order, created_at, updated_at
    ) VALUES ('LOC-002', 'Кабінет 2', 'classroom', 'active', 1, 2, ?, ?)
  `).run(now, now);

  const transferInput = {
    requestId: "10000000-0000-4000-8000-000000000030",
    materialId: "CAT-0001",
    sourceLocationId: "LOC-001",
    destinationLocationId: "LOC-002",
    condition: "unspecified",
    quantity: 2,
    expectedSourceQuantity: 5,
    expectedDestinationQuantity: 0,
    occurredAt: "2026-08-12",
    documentNumber: "Накладна 30",
    notes: null,
  };
  const transferred = await mutation.transferStockDirect(actor, transferInput, d1);
  const transferReplay = await mutation.transferStockDirect(actor, transferInput, d1);
  assert.deepEqual(transferReplay, transferred);
  assert.deepEqual(
    sqlite.prepare(`
      SELECT location_id, quantity, version FROM holdings
      WHERE material_id = 'CAT-0001' AND condition = 'unspecified'
      ORDER BY location_id
    `).all().map(plainRow),
    [
      { location_id: "LOC-001", quantity: 3, version: 2 },
      { location_id: "LOC-002", quantity: 2, version: 1 },
    ],
  );
  assert.deepEqual(
    plainRow(sqlite.prepare(`
      SELECT total_quantity, library_quantity, other_location_quantity, loaned_quantity
      FROM material_stock_totals WHERE material_id = 'CAT-0001'
    `).get()),
    {
      total_quantity: 5,
      library_quantity: 3,
      other_location_quantity: 2,
      loaned_quantity: 0,
    },
  );
  assert.deepEqual(
    sqlite.prepare(`
      SELECT line.location_id, line.quantity_delta, line.quantity_before, line.quantity_after
      FROM inventory_transaction_lines line
      JOIN inventory_transactions tx ON tx.id = line.transaction_id
      WHERE tx.kind = 'transfer'
      ORDER BY line.location_id
    `).all().map(plainRow),
    [
      { location_id: "LOC-001", quantity_delta: -2, quantity_before: 5, quantity_after: 3 },
      { location_id: "LOC-002", quantity_delta: 2, quantity_before: 0, quantity_after: 2 },
    ],
  );
  assert.equal(
    sqlite.prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'stock.transferred'").get().count,
    1,
  );

  await assert.rejects(
    mutation.transferStockDirect(
      actor,
      { ...transferInput, notes: "Інший запит із тим самим requestId" },
      d1,
    ),
    (error) => error instanceof mutation.LibraryMutationError
      && error.code === "request_id_conflict",
  );

  const writeoffInput = {
    requestId: "10000000-0000-4000-8000-000000000031",
    materialId: "CAT-0001",
    locationId: "LOC-002",
    condition: "unspecified",
    quantity: 2,
    expectedQuantity: 2,
    reason: "obsolete",
    occurredAt: "2026-08-13",
    documentNumber: "Акт 31",
    notes: "Затверджене списання",
  };
  const writtenOff = await mutation.writeOffStockDirect(actor, writeoffInput, d1);
  const writeoffReplay = await mutation.writeOffStockDirect(actor, writeoffInput, d1);
  assert.deepEqual(writeoffReplay, writtenOff);
  assert.equal(writtenOff.quantityAfter, 0);
  assert.equal(writtenOff.holdingVersion, null);
  assert.equal(
    sqlite.prepare("SELECT count(*) AS count FROM holdings WHERE location_id = 'LOC-002'").get().count,
    0,
  );
  assert.deepEqual(
    plainRow(sqlite.prepare(`
      SELECT total_quantity, library_quantity, other_location_quantity, loaned_quantity
      FROM material_stock_totals WHERE material_id = 'CAT-0001'
    `).get()),
    {
      total_quantity: 3,
      library_quantity: 3,
      other_location_quantity: 0,
      loaned_quantity: 0,
    },
  );
  assert.deepEqual(
    plainRow(sqlite.prepare(`
      SELECT tx.kind, tx.reason, tx.document_number, line.quantity_delta,
             line.quantity_before, line.quantity_after
      FROM inventory_transactions tx
      JOIN inventory_transaction_lines line ON line.transaction_id = tx.id
      WHERE tx.kind = 'writeoff'
    `).get()),
    {
      kind: "writeoff",
      reason: "obsolete",
      document_number: "Акт 31",
      quantity_delta: -2,
      quantity_before: 2,
      quantity_after: 0,
    },
  );
  assert.equal(
    sqlite.prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'stock.written_off'").get().count,
    1,
  );
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM mutation_commands").get().count, 2);
});

test("transfer and writeoff races return 409 without partial inventory history", async () => {
  const transferDb = openDatabase();
  const now = "2026-08-11T08:00:00.000Z";
  transferDb.sqlite.prepare(`
    INSERT INTO locations (
      id, name, type, status, is_public, sort_order, created_at, updated_at
    ) VALUES ('LOC-002', 'Кабінет 2', 'classroom', 'active', 1, 2, ?, ?)
  `).run(now, now);
  transferDb.d1.beforeBatch = () => {
    transferDb.sqlite.prepare(`
      UPDATE holdings SET quantity = 4, version = 2
      WHERE material_id = 'CAT-0001' AND location_id = 'LOC-001'
        AND condition = 'unspecified' AND quantity = 5 AND version = 1
    `).run();
  };
  await assert.rejects(
    mutation.transferStockDirect(
      actor,
      {
        requestId: "10000000-0000-4000-8000-000000000032",
        materialId: "CAT-0001",
        sourceLocationId: "LOC-001",
        destinationLocationId: "LOC-002",
        condition: "unspecified",
        quantity: 2,
        expectedSourceQuantity: 5,
        expectedDestinationQuantity: 0,
        occurredAt: "2026-08-12",
        documentNumber: null,
        notes: null,
      },
      transferDb.d1,
    ),
    (error) => error instanceof mutation.LibraryMutationError
      && error.status === 409
      && error.code === "stock_quantity_conflict",
  );
  assert.equal(transferDb.sqlite.prepare("SELECT quantity FROM holdings WHERE location_id = 'LOC-001'").get().quantity, 4);
  assert.equal(transferDb.sqlite.prepare("SELECT count(*) AS count FROM holdings WHERE location_id = 'LOC-002'").get().count, 0);
  assert.equal(transferDb.sqlite.prepare("SELECT count(*) AS count FROM inventory_transactions").get().count, 0);
  assert.equal(transferDb.sqlite.prepare("SELECT count(*) AS count FROM mutation_commands").get().count, 0);
  assert.equal(transferDb.sqlite.prepare("SELECT count(*) AS count FROM audit_events").get().count, 0);

  const destinationRaceDb = openDatabase();
  destinationRaceDb.sqlite.prepare(`
    INSERT INTO locations (
      id, name, type, status, is_public, sort_order, created_at, updated_at
    ) VALUES ('LOC-002', 'Кабінет 2', 'classroom', 'active', 1, 2, ?, ?)
  `).run(now, now);
  destinationRaceDb.d1.beforeBatch = () => {
    destinationRaceDb.sqlite.prepare(`
      INSERT INTO holdings (
        material_id, location_id, condition, quantity, version, updated_at
      ) VALUES ('CAT-0001', 'LOC-002', 'unspecified', 1, 1, ?)
    `).run(now);
  };
  await assert.rejects(
    mutation.transferStockDirect(
      actor,
      {
        requestId: "10000000-0000-4000-8000-000000000034",
        materialId: "CAT-0001",
        sourceLocationId: "LOC-001",
        destinationLocationId: "LOC-002",
        condition: "unspecified",
        quantity: 2,
        expectedSourceQuantity: 5,
        expectedDestinationQuantity: 0,
        occurredAt: "2026-08-12",
        documentNumber: null,
        notes: null,
      },
      destinationRaceDb.d1,
    ),
    (error) => error instanceof mutation.LibraryMutationError
      && error.status === 409
      && error.code === "stock_quantity_conflict",
  );
  assert.equal(destinationRaceDb.sqlite.prepare("SELECT quantity FROM holdings WHERE location_id = 'LOC-001'").get().quantity, 5);
  assert.equal(destinationRaceDb.sqlite.prepare("SELECT quantity FROM holdings WHERE location_id = 'LOC-002'").get().quantity, 1);
  assert.equal(destinationRaceDb.sqlite.prepare("SELECT count(*) AS count FROM inventory_transactions").get().count, 0);
  assert.equal(destinationRaceDb.sqlite.prepare("SELECT count(*) AS count FROM mutation_commands").get().count, 0);
  assert.equal(destinationRaceDb.sqlite.prepare("SELECT count(*) AS count FROM audit_events").get().count, 0);

  const writeoffDb = openDatabase();
  writeoffDb.d1.beforeBatch = () => {
    writeoffDb.sqlite.prepare(`
      UPDATE holdings SET quantity = 4, version = 2
      WHERE material_id = 'CAT-0001' AND location_id = 'LOC-001'
        AND condition = 'unspecified' AND quantity = 5 AND version = 1
    `).run();
  };
  await assert.rejects(
    mutation.writeOffStockDirect(
      actor,
      {
        requestId: "10000000-0000-4000-8000-000000000033",
        materialId: "CAT-0001",
        locationId: "LOC-001",
        condition: "unspecified",
        quantity: 2,
        expectedQuantity: 5,
        reason: "damaged",
        occurredAt: "2026-08-12",
        documentNumber: "Акт 33",
        notes: null,
      },
      writeoffDb.d1,
    ),
    (error) => error instanceof mutation.LibraryMutationError
      && error.status === 409
      && error.code === "stock_quantity_conflict",
  );
  assert.equal(writeoffDb.sqlite.prepare("SELECT quantity FROM holdings").get().quantity, 4);
  assert.equal(writeoffDb.sqlite.prepare("SELECT count(*) AS count FROM inventory_transactions").get().count, 0);
  assert.equal(writeoffDb.sqlite.prepare("SELECT count(*) AS count FROM mutation_commands").get().count, 0);
  assert.equal(writeoffDb.sqlite.prepare("SELECT count(*) AS count FROM audit_events").get().count, 0);
});

test("a reservation committed after mutation pre-read blocks every holding-decrease path", async () => {
  const scenarios = [
    {
      name: "stock count",
      prepare: () => {},
      mutate: ({ d1 }) => mutation.adjustHoldingToActualCount(actor, {
        requestId: "30000000-0000-4000-8000-000000000001",
        materialId: "CAT-0001", locationId: "LOC-001", condition: "unspecified",
        expectedQuantity: 5, countedQuantity: 4, reason: "inventory_count",
        occurredAt: "2026-08-13", notes: null,
      }, d1),
    },
    {
      name: "transfer",
      prepare: ({ sqlite }) => sqlite.prepare(`INSERT INTO locations
        (id,name,type,status,is_public,sort_order,created_at,updated_at)
        VALUES ('LOC-002','Кабінет','classroom','active',1,2,?,?)`)
        .run("2026-08-11T08:00:00.000Z", "2026-08-11T08:00:00.000Z"),
      mutate: ({ d1 }) => mutation.transferStockDirect(actor, {
        requestId: "30000000-0000-4000-8000-000000000002",
        materialId: "CAT-0001", sourceLocationId: "LOC-001",
        destinationLocationId: "LOC-002", condition: "unspecified", quantity: 1,
        expectedSourceQuantity: 5, expectedDestinationQuantity: 0,
        occurredAt: "2026-08-13", documentNumber: null, notes: null,
      }, d1),
    },
    {
      name: "writeoff",
      prepare: () => {},
      mutate: ({ d1 }) => mutation.writeOffStockDirect(actor, {
        requestId: "30000000-0000-4000-8000-000000000003",
        materialId: "CAT-0001", locationId: "LOC-001", condition: "unspecified",
        quantity: 1, expectedQuantity: 5, reason: "damaged",
        occurredAt: "2026-08-13", documentNumber: "Акт", notes: null,
      }, d1),
    },
    {
      name: "teacher issue",
      prepare: () => {},
      mutate: ({ d1 }) => mutation.issueLoanToTeacher(actor, {
        requestId: "30000000-0000-4000-8000-000000000004",
        teacherUserId: "USR-TCH", issuedAt: "2026-08-13", dueAt: null, notes: null,
        items: [{ materialId: "CAT-0001", sourceLocationId: "LOC-001",
          condition: "unspecified", quantity: 1, expectedAvailableQuantity: 5 }],
      }, d1),
    },
    {
      name: "class issue",
      prepare: ({ sqlite }) => seedActiveClassYear(sqlite),
      mutate: ({ d1 }) => mutation.issueLoanToClass(actor, {
        requestId: "30000000-0000-4000-8000-000000000005",
        classYearId: "CY-2026-001", expectedClassYearVersion: 1,
        responsibleTeacherUserId: "USR-TCH", issuedAt: "2026-09-01",
        dueAt: null, notes: null,
        items: [{ materialId: "CAT-0001", sourceLocationId: "LOC-001",
          condition: "unspecified", quantity: 1, expectedAvailableQuantity: 5 }],
      }, d1),
    },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    const context = openDatabase();
    scenario.prepare(context);
    context.d1.beforeBatch = () => seedActiveReservation(
      context.sqlite,
      5,
      `RACE-${index}`,
    );
    await assert.rejects(
      scenario.mutate(context),
      (error) => error instanceof mutation.LibraryMutationError
        && error.status === 409 && error.code === "reserved_stock_conflict",
      scenario.name,
    );
    assert.equal(context.sqlite.prepare("SELECT quantity FROM holdings WHERE material_id='CAT-0001' AND location_id='LOC-001'").get().quantity, 5, scenario.name);
    assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM inventory_transactions").get().n, 0, scenario.name);
    assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM class_loan_transactions").get().n, 0, scenario.name);
    assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM mutation_commands").get().n, 0, scenario.name);
    assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_events").get().n, 0, scenario.name);
  }
});

test("a concurrent active reservation prevents material archive", async () => {
  const context = openDatabase();
  context.sqlite.prepare("DELETE FROM holdings WHERE material_id='CAT-0001'").run();
  context.sqlite.prepare(`UPDATE material_stock_totals SET total_quantity=0,
    library_quantity=0,other_location_quantity=0,loaned_quantity=0,reserved_quantity=0
    WHERE material_id='CAT-0001'`).run();
  context.d1.beforeBatch = () => {
    context.sqlite.prepare(`INSERT INTO holdings
      (material_id,location_id,condition,quantity,version,updated_at)
      VALUES ('CAT-0001','LOC-001','unspecified',1,1,'2026-08-13T08:00:00.000Z')`).run();
    seedActiveReservation(context.sqlite, 1, "ARCHIVE");
  };
  await assert.rejects(
    mutation.archiveMaterialDirect(actor, "CAT-0001", {
      requestId: "30000000-0000-4000-8000-000000000006",
      expectedVersion: 1,
    }, context.d1),
    (error) => error instanceof mutation.LibraryMutationError
      && error.status === 409 && error.code === "material_reserved_conflict",
  );
  assert.equal(context.sqlite.prepare("SELECT status FROM materials WHERE id='CAT-0001'").get().status, "active");
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM mutation_commands").get().n, 0);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_events").get().n, 0);
});
