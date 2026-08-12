import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  classifyResourceUrl,
  importCanonicalExport,
  normalizeSearchText,
  stableStringify,
} from "../scripts/import-library-core.mjs";

const fixturePath = fileURLToPath(new URL("./fixtures/library-core-canonical.json", import.meta.url));
const scriptPath = fileURLToPath(new URL("../scripts/import-library-core.mjs", import.meta.url));

async function fixture() {
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

function addAcademicSheets(input) {
  input.sheets.academicYears = { rows: [
    { academic_year_id: "YR-2026-2027", label: "2026/2027", start_date: "01.09.2026", end_date: "30.06.2027", status: "closed", notes: "" },
    { academic_year_id: "YR-2027-2028", label: "2027/2028", start_date: "01.09.2027", end_date: "30.06.2028", status: "draft", notes: "" },
  ] };
  input.sheets.cohorts = { rows: [
    { cohort_id: "COH-001", status: "active", notes: "fixture cohort" },
  ] };
  input.sheets.classYears = { rows: [
    {
      class_year_id: "CY-2026-001", academic_year_id: "YR-2026-2027", cohort_id: "COH-001",
      class_name: "9-А", grade: 9, code: "А", teacher_user_id: "USR-002", location_id: "LOC-001",
      start_date: "01.09.2026", end_date: "30.06.2027", status: "closed", actual_closed_date: "30.06.2027", notes: "",
    },
    {
      class_year_id: "CY-2027-001", academic_year_id: "YR-2027-2028", cohort_id: "COH-001",
      class_name: "10-А", grade: 10, code: "А", teacher_user_id: "USR-002", location_id: "LOC-001",
      start_date: "01.09.2027", end_date: "30.06.2028", status: "planned", actual_closed_date: "", notes: "",
    },
  ] };
  return input;
}

test("normalizes canonical sheet wrappers and derives balances without formula sheets", async () => {
  const input = await fixture();
  const { bundle, report } = importCanonicalExport(input);

  assert.equal(report.ok, true, stableStringify(report.diagnostics));
  assert.equal(bundle.tables.materials.length, 4);
  assert.equal(bundle.tables.material_links.length, 3);
  assert.equal(bundle.tables.cover_assets.length, 3);
  assert.equal(bundle.tables.revision_checks.length, 3);
  assert.equal(bundle.tables.operations.length, 3);
  assert.deepEqual(report.ignored_sheets, ["balances", "revisionSheet", "themeCatalog"]);

  const balances = new Map(bundle.tables.stock_balances.map((row) => [row.balance_id, row.quantity]));
  assert.equal(balances.get("CAT-0590:LOC-001"), 55);
  assert.equal(balances.get("CAT-0591:LOC-001"), 55);
  assert.equal(balances.get("CAT-0599:LOC-001"), 55);
  assert.equal(report.stock.opening_total, 108);
  assert.equal(report.stock.final_total, 165);
  assert.equal(report.stock.negative_balance_rows, 0);
  assert.equal([...balances.values()].includes(999999), false, "ignored formula/theme values must not affect stock");

  assert.equal(bundle.tables.users[0].email, "librarian@example.com");
  assert.match(bundle.tables.materials[0].search_text, /cat 0590/u);
  assert.match(bundle.tables.materials[0].search_text, /українська література/u);
});

test("normalizes optional academic year, cohort and class history sheets", async () => {
  const input = addAcademicSheets(await fixture());
  input.sheets.cohorts.rows.push({ cohort_id: "COH-002", status: "Завершена", notes: "legacy status" });
  const { bundle, report } = importCanonicalExport(input);

  assert.equal(report.ok, true, stableStringify(report.diagnostics));
  assert.equal(report.counts.academic_years, 2);
  assert.equal(report.counts.cohorts, 2);
  assert.equal(report.counts.class_years, 2);
  assert.deepEqual(bundle.tables.academic_years.map((row) => [row.academic_year_id, row.status]), [
    ["YR-2026-2027", "closed"],
    ["YR-2027-2028", "draft"],
  ]);
  assert.deepEqual(bundle.tables.class_years.map((row) => [row.class_year_id, row.class_name, row.status]), [
    ["CY-2026-001", "9-А", "closed"],
    ["CY-2027-001", "10-А", "planned"],
  ]);
  assert.equal(bundle.tables.cohorts.find((row) => row.cohort_id === "COH-002").status, "closed");
  assert.equal(report.ignored_sheets.includes("academicYears"), false);
  assert.equal(report.ignored_sheets.includes("cohorts"), false);
  assert.equal(report.ignored_sheets.includes("classYears"), false);
});

test("rejects more than one active academic year before building a D1 plan", async () => {
  const input = addAcademicSheets(await fixture());
  input.sheets.academicYears.rows.forEach((row) => {
    row.status = "active";
  });
  const { report } = importCanonicalExport(input);

  assert.equal(report.ok, false);
  assert.equal(report.diagnostics.errors.some((item) => item.code === "academic_year_active_duplicate"), true);
});

test("classifies a store as a commercial page, never as an ebook", async () => {
  const { bundle, report } = importCanonicalExport(await fixture());
  const byMaterial = new Map(bundle.tables.material_links.map((row) => [row.material_id, row]));

  assert.equal(byMaterial.get("CAT-0590").classification, "commercial_page");
  assert.equal(byMaterial.get("CAT-0590").is_direct_file, 0);
  assert.equal(byMaterial.get("CAT-0591").classification, "direct_document");
  assert.equal(byMaterial.get("CAT-0591").file_format, "pdf");
  assert.equal(byMaterial.get("CAT-0599").classification, "cloud_document");
  assert.deepEqual(report.links.by_classification, {
    cloud_document: 1,
    commercial_page: 1,
    direct_document: 1,
  });
  assert.deepEqual(classifyResourceUrl("https://yakaboo.ua/book"), {
    classification: "commercial_page",
    host: "yakaboo.ua",
    file_format: null,
    is_direct_file: false,
  });
});

test("keeps authentication enrollment separate from staff borrowing status", async () => {
  const { bundle, report } = importCanonicalExport(await fixture());
  const users = new Map(bundle.tables.users.map((row) => [row.user_id, row]));

  assert.equal(report.ok, true, stableStringify(report.diagnostics));
  assert.equal(users.get("USR-001").is_active, 1);
  assert.equal(users.get("USR-002").status, "Доступ не активовано");
  assert.equal(users.get("USR-002").is_active, 1, "a current teacher remains available for borrowing");
  assert.equal(users.get("USR-003").is_active, 1, "a current administrator remains active without login enrollment");
  assert.equal(users.get("USR-004").is_active, 0, "a former employee remains inactive");
});

test("reports ISBN formula failures and validation diagnostics without blocking migration", async () => {
  const { bundle, report } = importCanonicalExport(await fixture());
  const material = bundle.tables.materials.find((row) => row.material_id === "CAT-0590");

  assert.equal(material.isbn_normalized, "9780306406157");
  assert.equal(material.isbn_valid, 1);
  assert.equal(report.isbn.formula_errors, 2);
  assert.equal(report.isbn.valid, 1);
  assert.equal(report.isbn.invalid, 1);
  assert.equal(report.diagnostics.warnings.some((item) => item.code === "isbn_formula_error"), true);
  assert.equal(report.diagnostics.warnings.some((item) => item.code === "isbn_invalid"), true);
});

test("rejects duplicate CAT IDs", async () => {
  const input = await fixture();
  input.sheets.materials.values.push([...input.sheets.materials.values[1]]);
  const { report } = importCanonicalExport(input);

  assert.equal(report.ok, false);
  assert.equal(report.diagnostics.errors.some((item) => item.code === "material_id_duplicate"), true);
});

test("rejects operations that would create negative stock", async () => {
  const input = await fixture();
  input.sheets.operations.values.push([
    "OP-000013",
    "11.08.2026",
    "CAT-0591",
    "Переміщення",
    "Бібліотека",
    "Списано",
    "Не перевірено",
    100,
    "Підтверджено",
    "Бібліотекар Тестовий",
    "bad fixture",
    "CAT-0591",
    "LOC-001",
    "LOC-007",
    "USR-001",
    "negative-stock-fixture"
  ]);
  const { report } = importCanonicalExport(input);

  assert.equal(report.ok, false);
  assert.equal(report.stock.negative_balance_rows, 1);
  assert.equal(report.diagnostics.errors.some((item) => item.code === "stock_negative"), true);
});

test("preserves all three revision checks and their correction links", async () => {
  const { bundle, report } = importCanonicalExport(await fixture());
  assert.equal(report.revisions.count, 3);
  assert.equal(report.revisions.with_operation, 3);
  assert.deepEqual(
    bundle.tables.revision_checks.map((row) => [row.material_id, row.expected_quantity, row.counted_quantity, row.difference, row.operation_id]),
    [
      ["CAT-0591", 54, 55, 1, "OP-000002"],
      ["CAT-0599", 54, 55, 1, "OP-000012"],
      ["CAT-0590", 0, 55, 55, "OP-000003"],
    ],
  );
});

test("search normalization matches the D1 read path contract", () => {
  assert.equal(
    normalizeSearchText("  П’ЄСА—2026 / CAT-0012  "),
    "п єса 2026 cat 0012",
  );
});

test("output is deterministic and the CLI only reads local JSON", async (t) => {
  const input = await fixture();
  const first = importCanonicalExport(input);
  const second = importCanonicalExport(JSON.parse(JSON.stringify(input)));
  assert.equal(stableStringify(first.bundle), stableStringify(second.bundle));
  assert.equal(stableStringify(first.report), stableStringify(second.report));

  const directory = await mkdtemp(path.join(tmpdir(), "library-core-import-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputOne = path.join(directory, "one.json");
  const outputTwo = path.join(directory, "two.json");
  const reportPath = path.join(directory, "report.json");

  for (const output of [outputOne, outputTwo]) {
    const result = spawnSync(process.execPath, [
      scriptPath,
      "--input",
      fixturePath,
      "--output",
      output,
      "--report",
      reportPath,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(await readFile(outputOne, "utf8"), await readFile(outputTwo, "utf8"));

  const remote = spawnSync(process.execPath, [scriptPath, "--input", "https://example.com/export.json"], { encoding: "utf8" });
  assert.equal(remote.status, 1);
  assert.match(remote.stderr, /лише локальний JSON/u);
});

test("implementation has no network call path", async () => {
  const source = await readFile(scriptPath, "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
  assert.doesNotMatch(source, /from\s+["']node:https?["']/u);
});
