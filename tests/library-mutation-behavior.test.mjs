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
      publication_year, '9786170000000', '9786170000000', publisher, notes,
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
        changes: { isbn: "9786170000000" },
      },
      d1,
    ),
    (error) => error instanceof mutation.LibraryMutationError
      && error.status === 409
      && error.code === "duplicate_isbn"
      && error.details.materialId === "CAT-0002",
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
  const reference = await directory.readLibraryReferenceData(d1);
  assert.deepEqual(reference.teachers, [{ id: "USR-TCH", fullName: "Ірина Вчитель" }]);
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
