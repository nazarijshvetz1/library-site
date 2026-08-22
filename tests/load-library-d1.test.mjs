import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { importCanonicalExport } from "../scripts/import-library-core.mjs";
import {
  buildD1LoadPlan,
  createNodeSqliteD1Adapter,
  loadD1Plan,
  runCli,
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

async function academicFixtureBundle({ dualRole = false } = {}) {
  const canonical = JSON.parse(await readFile(fixturePath, "utf8"));
  if (dualRole) {
    canonical.sheets.users.values.push([
      "USR-006", "Орел Галина Миколаївна", "Адміністрація", "", "", "Активний",
    ]);
  }
  canonical.sheets.academicYears = { rows: [
    { academic_year_id: "YR-2026-2027", label: "2026/2027", start_date: "01.09.2026", end_date: "31.05.2027", status: "closed", notes: "" },
    { academic_year_id: "YR-2027-2028", label: "2027/2028", start_date: "01.09.2027", end_date: "31.05.2028", status: "draft", notes: "" },
  ] };
  canonical.sheets.cohorts = { rows: [
    { cohort_id: "COH-001", status: "active", notes: "fixture cohort" },
  ] };
  canonical.sheets.classYears = { rows: [
    {
      class_year_id: "CY-2026-001", academic_year_id: "YR-2026-2027", cohort_id: "COH-001",
      class_name: "9-А", grade: 9, code: "А", teacher_user_id: dualRole ? "USR-006" : "USR-002", location_id: "LOC-001",
      start_date: "01.09.2026", end_date: "31.05.2027", status: "closed", actual_closed_date: "31.05.2027", notes: "",
    },
    {
      class_year_id: "CY-2027-001", academic_year_id: "YR-2027-2028", cohort_id: "COH-001",
      class_name: "10-А", grade: 10, code: "А", teacher_user_id: dualRole ? "USR-006" : "USR-002", location_id: "LOC-001",
      start_date: "01.09.2027", end_date: "31.05.2028", status: "planned", actual_closed_date: "", notes: "",
    },
  ] };
  const { bundle, report } = importCanonicalExport(canonical);
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics));
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

test("maps and atomically loads optional academic history into existing schema 0003 tables", async (t) => {
  const { plan, report } = buildD1LoadPlan(await academicFixtureBundle());

  assert.equal(report.ok, true, JSON.stringify(report.diagnostics));
  assert.equal(report.staging_counts.academic_years, 2);
  assert.equal(report.staging_counts.cohorts, 1);
  assert.equal(report.staging_counts.class_years, 2);
  assert.equal(report.target_counts.academic_years, 2);
  assert.equal(report.target_counts.cohorts, 1);
  assert.equal(report.target_counts.class_years, 2);
  assert.equal(plan.format_version, 2);

  const database = await databaseWithSchema(t);
  const result = await loadD1Plan(createNodeSqliteD1Adapter(database), plan, { dryRun: false });
  assert.equal(result.applied, true);
  assert.equal(count(database, "academic_years"), 2);
  assert.equal(count(database, "cohorts"), 1);
  assert.equal(count(database, "class_years"), 2);
  assert.deepEqual(
    { ...database.prepare("SELECT class_name, status, teacher_user_id, location_id FROM class_years WHERE id = 'CY-2026-001'").get() },
    { class_name: "9-А", status: "closed", teacher_user_id: "USR-002", location_id: "LOC-001" },
  );
});

test("loader accepts the named administrator teacher capability and keeps the admin role", async () => {
  const { plan, report } = buildD1LoadPlan(await academicFixtureBundle({ dualRole: true }));
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics));
  assert.equal(plan.tables.users.find((row) => row.id === "USR-006")?.role, "admin");
  assert.equal(plan.tables.class_years.every((row) => row.teacher_user_id === "USR-006"), true);
});

test("rejects inconsistent academic lifecycle in plan construction and direct local loading", async () => {
  const bundle = await academicFixtureBundle();
  bundle.tables.academic_years.forEach((row) => { row.status = "active"; });
  const invalidBuild = buildD1LoadPlan(bundle);
  assert.equal(invalidBuild.report.ok, false);
  assert.equal(
    invalidBuild.report.diagnostics.errors.some((item) => item.code === "target_academic_year_active_duplicate"),
    true,
  );

  const valid = buildD1LoadPlan(await academicFixtureBundle(), { throwOnError: true }).plan;
  valid.tables.academic_years.forEach((row) => { row.status = "active"; });
  await assert.rejects(
    loadD1Plan({}, valid, { dryRun: true }),
    (error) => error?.code === "D1_PLAN_INVALID"
      && error.report.diagnostics.some((item) => item.code === "target_academic_year_active_duplicate"),
  );

  const invalidTeacher = buildD1LoadPlan(await academicFixtureBundle(), { throwOnError: true }).plan;
  invalidTeacher.tables.class_years[0].teacher_user_id = invalidTeacher.tables.users.find(
    (row) => row.role === "admin" || row.role === "librarian",
  ).id;
  await assert.rejects(
    loadD1Plan({}, invalidTeacher, { dryRun: true }),
    (error) => error?.code === "D1_PLAN_INVALID"
      && error.report.diagnostics.some((item) => item.code === "target_class_teacher_invalid"),
  );

  const invalidDates = buildD1LoadPlan(await academicFixtureBundle(), { throwOnError: true }).plan;
  invalidDates.tables.academic_years[0].start_date = "2030-09-01";
  await assert.rejects(
    loadD1Plan({}, invalidDates, { dryRun: true }),
    (error) => error?.code === "D1_PLAN_INVALID"
      && error.report.diagnostics.some((item) => item.code === "target_academic_year_invalid"),
  );

  const invalidEndDate = buildD1LoadPlan(await academicFixtureBundle(), { throwOnError: true }).plan;
  invalidEndDate.tables.academic_years[0].end_date = "2027-08-31";
  await assert.rejects(
    loadD1Plan({}, invalidEndDate, { dryRun: true }),
    (error) => error?.code === "D1_PLAN_INVALID"
      && error.report.diagnostics.some((item) => item.code === "target_academic_year_invalid"),
  );
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
  assert.match(source, /--plan/u);
});

test("CLI exports reproducible compact hosted plan bytes with an exact hash report", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "library-d1-plan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, "staging.json");
  const firstPlan = path.join(directory, "plan-1.json");
  const secondPlan = path.join(directory, "plan-2.json");
  const firstReport = path.join(directory, "report-1.json");
  const secondReport = path.join(directory, "report-2.json");
  await writeFile(input, JSON.stringify(await fixtureBundle()), "utf8");

  await runCli(["--input", input, "--plan", firstPlan, "--report", firstReport]);
  await runCli(["--input", input, "--plan", secondPlan, "--report", secondReport]);

  const [firstBytes, secondBytes] = await Promise.all([readFile(firstPlan), readFile(secondPlan)]);
  assert.deepEqual(firstBytes, secondBytes);
  assert.equal(firstBytes.at(-1), 0x0a, "hosted plan has one documented trailing newline");
  assert.doesNotMatch(firstBytes.toString("utf8", 0, 200), /\n\s{2}/u, "plan is compact, not pretty-printed");
  const digest = createHash("sha256").update(firstBytes).digest("hex");
  const report = JSON.parse(await readFile(firstReport, "utf8"));
  const repeated = JSON.parse(await readFile(secondReport, "utf8"));
  assert.equal(report.hosted_plan.written, true);
  assert.equal(report.hosted_plan.byte_length, firstBytes.byteLength);
  assert.equal(report.hosted_plan.sha256, digest);
  assert.deepEqual(report.hosted_plan, repeated.hosted_plan);
  assert.equal(JSON.parse(firstBytes).format, "library-d1-load-plan");
});
