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
