import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const store = await import("../lib/location-registry-store.ts");

const migrationFiles = [
  "0000_librarian_drafts.sql", "0001_draft_workflow.sql", "0002_remove_legacy_audit_triggers.sql",
  "0003_odd_the_order.sql", "0004_staging_import_runs.sql", "0005_young_night_nurse.sql",
  "0006_pale_sauron.sql", "0007_cold_whiplash.sql", "0008_sudden_thunderbird.sql",
  "0009_happy_silver_samurai.sql", "0010_shocking_cobalt_man.sql",
  "0011_normalize_holding_conditions.sql", "0012_elite_victor_mancha.sql",
  "0013_strange_dark_beast.sql",
  "0014_rich_lionheart.sql",
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
    if (this.beforeBatch) {
      const hook = this.beforeBatch;
      this.beforeBatch = null;
      await hook();
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

async function context() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const file of migrationFiles) {
    const sql = await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
    sqlite.exec(sql.replaceAll("--> statement-breakpoint", ""));
  }
  const now = "2026-08-22T09:00:00.000Z";
  sqlite.prepare(`INSERT INTO users(id,full_name,sort_name,email,auth_user_id,role,status,created_at,updated_at)
    VALUES('USR-LIB','Бібліотекар','бібліотекар','library@example.test','auth-library','librarian','active',?,?)`).run(now, now);
  sqlite.prepare(`INSERT INTO locations(id,name,type,status,is_public,sort_order,created_at,updated_at)
    VALUES('LOC-LIB','Бібліотека','library','active',1,0,?,?)`).run(now, now);
  return {
    sqlite,
    db: new TestD1(sqlite),
    user: { userId: "auth-library", email: "library@example.test" },
  };
}

test("cabinet create, edit, close and delete are audited and version-safe", async () => {
  const { sqlite, db, user } = await context();
  const created = await store.createManagedLocation(db, user, {
    requestId: crypto.randomUUID(), name: "Кабінет № 215", isPublic: true, sortOrder: 215,
  });
  assert.equal(created.status, "active");
  assert.equal(created.canDelete, true);

  const edited = await store.updateManagedLocation(db, user, created.id, {
    requestId: crypto.randomUUID(), expectedUpdatedAt: created.updatedAt,
    changes: { name: "Кабінет № 216", isPublic: false, sortOrder: 216 },
  });
  assert.equal(edited.name, "Кабінет № 216");
  assert.equal(edited.isPublic, false);
  assert.notEqual(edited.updatedAt, created.updatedAt);

  const closed = await store.updateManagedLocation(db, user, edited.id, {
    requestId: crypto.randomUUID(), expectedUpdatedAt: edited.updatedAt, changes: { status: "inactive" },
  });
  assert.equal(closed.status, "inactive");

  await store.deleteManagedLocation(db, user, closed.id, {
    requestId: crypto.randomUUID(), expectedUpdatedAt: closed.updatedAt, confirmation: closed.name,
  });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM locations WHERE id=?").get(closed.id).total, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM audit_events WHERE entity_type='location'").get().total, 4);
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("library and cabinets with inventory history cannot be removed", async () => {
  const { sqlite, db, user } = await context();
  const library = (await store.listManagedLocations(db))[0];
  assert.equal(library.id, "LOC-LIB");
  assert.equal(library.canDelete, false);
  assert.equal(library.canDeactivate, false);

  const cabinet = await store.createManagedLocation(db, user, {
    requestId: crypto.randomUUID(), name: "Кабінет № 301", isPublic: true, sortOrder: 301,
  });
  const now = "2026-08-22T09:01:00.000Z";
  sqlite.prepare(`INSERT INTO materials(id,catalog_number,title,sort_title,search_text,rubric,publication_type,subject,
    class_from,class_to,author,publication_year,isbn,isbn_normalized,publisher,notes,status,version,created_at,updated_at,archived_at)
    VALUES('CAT-9001',9001,'Тестова книга','тестова книга','','Підручники','Підручник','Математика',
      5,5,'Автор',2026,'','','Видавництво','','active',1,?,?,NULL)`).run(now, now);
  sqlite.prepare(`INSERT INTO material_stock_totals(material_id,total_quantity,library_quantity,other_location_quantity,loaned_quantity,reserved_quantity,updated_at)
    VALUES('CAT-9001',2,0,2,0,0,?)`).run(now);
  sqlite.prepare(`INSERT INTO holdings(material_id,location_id,condition,quantity,version,updated_at)
    VALUES('CAT-9001',?,'good',2,1,?)`).run(cabinet.id, now);

  const inUse = (await store.listManagedLocations(db)).find((item) => item.id === cabinet.id);
  assert.equal(inUse.canDelete, false);
  assert.equal(inUse.canDeactivate, false);
  assert.equal(inUse.dependencies.stockQuantity, 2);
  await assert.rejects(
    store.updateManagedLocation(db, user, cabinet.id, {
      requestId: crypto.randomUUID(), expectedUpdatedAt: inUse.updatedAt, changes: { status: "inactive" },
    }),
    (error) => error instanceof store.LocationRegistryError && error.code === "location_in_use",
  );
  await assert.rejects(
    store.deleteManagedLocation(db, user, cabinet.id, {
      requestId: crypto.randomUUID(), expectedUpdatedAt: inUse.updatedAt, confirmation: inUse.name,
    }),
    (error) => error instanceof store.LocationRegistryError && error.code === "location_has_history",
  );
});

test("a concurrent receipt prevents cabinet deactivation atomically", async () => {
  const { sqlite, db, user } = await context();
  const cabinet = await store.createManagedLocation(db, user, {
    requestId: crypto.randomUUID(), name: "Кабінет № 302", isPublic: true, sortOrder: 302,
  });
  const now = "2026-08-22T09:02:00.000Z";
  sqlite.prepare(`INSERT INTO materials(id,catalog_number,title,sort_title,search_text,rubric,publication_type,subject,
    class_from,class_to,author,publication_year,isbn,isbn_normalized,publisher,notes,status,version,created_at,updated_at,archived_at)
    VALUES('CAT-9002',9002,'Конкурентна книга','конкурентна книга','','Підручники','Підручник','Математика',
      6,6,'Автор',2026,'','','Видавництво','','active',1,?,?,NULL)`).run(now, now);
  sqlite.prepare(`INSERT INTO material_stock_totals(material_id,total_quantity,library_quantity,other_location_quantity,loaned_quantity,reserved_quantity,updated_at)
    VALUES('CAT-9002',1,0,1,0,0,?)`).run(now);
  db.beforeBatch = () => {
    sqlite.prepare(`INSERT INTO holdings(material_id,location_id,condition,quantity,version,updated_at)
      VALUES('CAT-9002',?,'good',1,1,?)`).run(cabinet.id, now);
  };
  await assert.rejects(
    store.updateManagedLocation(db, user, cabinet.id, {
      requestId: crypto.randomUUID(), expectedUpdatedAt: cabinet.updatedAt, changes: { status: "inactive" },
    }),
    (error) => error instanceof store.LocationRegistryError && error.code === "location_in_use",
  );
  assert.equal(sqlite.prepare("SELECT status FROM locations WHERE id=?").get(cabinet.id).status, "active");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM audit_events WHERE action='location.updated'").get().total, 0);
});
