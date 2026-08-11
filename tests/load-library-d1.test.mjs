import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { importCanonicalExport } from "../scripts/import-library-core.mjs";
import {
  buildD1LoadPlan,
  createNodeSqliteD1Adapter,
  loadD1Plan,
} from "../scripts/load-library-d1.mjs";

const fixturePath = fileURLToPath(new URL("./fixtures/library-core-canonical.json", import.meta.url));
const migrationPath = fileURLToPath(new URL("../drizzle/0003_odd_the_order.sql", import.meta.url));
const loaderPath = fileURLToPath(new URL("../scripts/load-library-d1.mjs", import.meta.url));

async function fixtureBundle() {
  const canonical = JSON.parse(await readFile(fixturePath, "utf8"));
  const { bundle, report } = importCanonicalExport(canonical);
  assert.equal(report.ok, true);
  return bundle;
}

async function databaseWithSchema(t) {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  const migration = await readFile(migrationPath, "utf8");
  for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
    database.exec(statement);
  }
  return database;
}

function count(database, table) {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count);
}

test("maps the complete staging fixture to schema 0003 without inventing ebook links", async () => {
  const bundle = await fixtureBundle();
  const { plan, report } = buildD1LoadPlan(bundle);

  assert.equal(report.ok, true, JSON.stringify(report.diagnostics));
  assert.equal(report.target_schema, "0003");
  assert.equal(report.target_counts.materials, 4);
  assert.equal(report.target_counts.inventory_transactions, 5);
  assert.equal(report.target_counts.inventory_transaction_lines, 5);
  assert.equal(report.target_counts.audit_events, 3);
  assert.equal(report.stock.staging_total, 165);
  assert.equal(report.stock.countable_total, 165);
  assert.equal(report.revisions.audit_rows, 3);

  const links = new Map(plan.tables.material_links.map((row) => [row.material_id, row.kind]));
  assert.equal(links.get("CAT-0590"), "store");
  assert.equal(links.get("CAT-0591"), "ebook");
  assert.equal(links.get("CAT-0599"), "preview");
  assert.equal([...links.values()].filter((kind) => kind === "ebook").length, 1);
});

test("dry-run reconciles an empty schema without writing", async (t) => {
  const database = await databaseWithSchema(t);
  const adapter = createNodeSqliteD1Adapter(database);
  const { plan } = buildD1LoadPlan(await fixtureBundle(), { throwOnError: true });

  const result = await loadD1Plan(adapter, plan, { dryRun: true });

  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
  assert.equal(result.applied, false);
  assert.equal(result.before.total_new > 0, true);
  assert.equal(count(database, "materials"), 0);
  assert.equal(count(database, "holdings"), 0);
  assert.equal(count(database, "inventory_transactions"), 0);
});

test("dry-run refuses a schema without the FTS table before any writes", async (t) => {
  const database = await databaseWithSchema(t);
  database.exec("DROP TABLE materials_fts");
  const adapter = createNodeSqliteD1Adapter(database);
  const { plan } = buildD1LoadPlan(await fixtureBundle(), { throwOnError: true });

  await assert.rejects(
    loadD1Plan(adapter, plan, { dryRun: true }),
    (error) => error?.code === "D1_SCHEMA_MISSING"
      && error.missingTables.includes("materials_fts"),
  );
  assert.equal(count(database, "materials"), 0);
  assert.equal(count(database, "users"), 0);
});

test("full import is atomic and a repeated import adds no duplicates", async (t) => {
  const database = await databaseWithSchema(t);
  const adapter = createNodeSqliteD1Adapter(database);
  const { plan } = buildD1LoadPlan(await fixtureBundle(), { throwOnError: true });

  const first = await loadD1Plan(adapter, plan, { dryRun: false });
  assert.equal(first.applied, true);
  assert.equal(first.applied_rows, Object.values(plan.tables).reduce((sum, rows) => sum + rows.length, 0));
  assert.equal(first.after.total_new, 0);
  assert.equal(first.after.total_conflicts, 0);

  assert.equal(count(database, "materials"), 4);
  assert.equal(count(database, "material_links"), 3);
  assert.equal(count(database, "material_cover_assets"), 3);
  assert.equal(count(database, "locations"), 2);
  assert.equal(count(database, "users"), 4);
  assert.equal(count(database, "holdings"), 3);
  assert.equal(count(database, "material_stock_totals"), 4);
  assert.equal(count(database, "inventory_transactions"), 5);
  assert.equal(count(database, "inventory_transaction_lines"), 5);
  assert.equal(count(database, "audit_events"), 3);
  assert.equal(count(database, "materials_fts"), 4);
  assert.equal(
    database
      .prepare("SELECT count(*) AS count FROM materials_fts WHERE materials_fts MATCH '9780306406157'")
      .get().count,
    1,
  );

  const stock = database.prepare(`
    SELECT total_quantity, library_quantity, other_location_quantity, loaned_quantity
    FROM material_stock_totals WHERE material_id = 'CAT-0590'
  `).get();
  assert.deepEqual({ ...stock }, { total_quantity: 55, library_quantity: 55, other_location_quantity: 0, loaned_quantity: 0 });

  const second = await loadD1Plan(adapter, plan, { dryRun: false });
  assert.equal(second.applied, false);
  assert.equal(second.before.total_new, 0);
  assert.equal(second.before.total_conflicts, 0);
  assert.equal(second.before.total_unchanged, first.applied_rows);
  assert.equal(count(database, "materials"), 4);
  assert.equal(count(database, "inventory_transactions"), 5);
  assert.equal(count(database, "audit_events"), 3);
});

test("target drift fails before writes instead of overwriting live data", async (t) => {
  const database = await databaseWithSchema(t);
  const adapter = createNodeSqliteD1Adapter(database);
  const { plan } = buildD1LoadPlan(await fixtureBundle(), { throwOnError: true });
  await loadD1Plan(adapter, plan, { dryRun: false });
  database.prepare("UPDATE materials SET title = 'Локальна правка' WHERE id = 'CAT-0590'").run();

  await assert.rejects(
    loadD1Plan(adapter, plan, { dryRun: false }),
    (error) => error?.code === "D1_LOAD_TARGET_CONFLICT"
      && error.report.total_conflicts === 1
      && error.report.conflicts[0].columns.includes("title"),
  );
  assert.equal(database.prepare("SELECT title FROM materials WHERE id = 'CAT-0590'").get().title, "Локальна правка");
  assert.equal(count(database, "materials"), 4);
});

test("a failing statement rolls back the entire local atomic batch", async (t) => {
  const database = await databaseWithSchema(t);
  database.exec(`
    CREATE TRIGGER fixture_abort_material
    BEFORE INSERT ON materials
    WHEN NEW.id = 'CAT-0599'
    BEGIN
      SELECT RAISE(ABORT, 'fixture atomic failure');
    END
  `);
  const adapter = createNodeSqliteD1Adapter(database);
  const { plan } = buildD1LoadPlan(await fixtureBundle(), { throwOnError: true });

  await assert.rejects(
    loadD1Plan(adapter, plan, { dryRun: false }),
    (error) => error?.code === "D1_ATOMIC_BATCH_FAILED" && /fixture atomic failure/u.test(error.message),
  );
  for (const table of ["locations", "users", "materials", "materials_fts", "material_links", "holdings", "inventory_transactions", "audit_events"]) {
    assert.equal(count(database, table), 0, `${table} must be rolled back`);
  }
});

test("invalid staging reconciliation is refused without touching the database", async (t) => {
  const database = await databaseWithSchema(t);
  const adapter = createNodeSqliteD1Adapter(database);
  const bundle = await fixtureBundle();
  bundle.reconciliation.ok = false;
  bundle.reconciliation.diagnostics.error_count = 1;
  const { plan, report } = buildD1LoadPlan(bundle);

  assert.equal(report.ok, false);
  await assert.rejects(
    loadD1Plan(adapter, plan, { dryRun: false }),
    (error) => error?.code === "D1_LOAD_VALIDATION_FAILED",
  );
  assert.equal(count(database, "materials"), 0);
  assert.equal(count(database, "users"), 0);
});

test("loader has no production or network access path", async () => {
  const source = await readFile(loaderPath, "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
  assert.doesNotMatch(source, /from\s+["']node:https?["']/u);
  assert.doesNotMatch(source, /--remote\b/u);
  assert.match(source, /--apply-local/u);
});
