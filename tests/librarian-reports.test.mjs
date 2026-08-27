import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const statementExcel = await import(pathToFileURL(path.join(root, "lib/class-issue-statement-excel.ts")).href);
const reportExcel = await import(pathToFileURL(path.join(root, "lib/librarian-report-excel.ts")).href);
const reportStore = await import(pathToFileURL(path.join(root, "lib/librarian-report-store.ts")).href);

test("class issue statement contains only compact reader-facing fields", () => {
  const workbook = statementExcel.createClassIssueStatementExcel({
    classLoanId: "CLOAN-INTERNAL-SECRET",
    schemaVersion: 1,
    origin: "issued",
    currentStatus: "open",
    className: "7-А",
    academicYearLabel: "2026/2027",
    classroomName: "Кабінет №108",
    curatorName: "Ірина Класна",
    issuedAt: "2026-08-28T08:00:00.000Z",
    dueAt: "2027-05-31",
    createdAt: "2026-08-28T08:00:00.000Z",
    lines: [{
      position: 1,
      subject: "Математика",
      title: "Алгебра — 7 клас",
      author: "Автор",
      publicationYear: 2024,
      rubric: "Підручники",
      quantityIssued: 25,
      materialId: "CAT-9999",
      sourceLocation: "Секретне сховище",
      condition: "good",
    }],
  });
  const xml = workbookXml(workbook.bytes);
  for (const label of ["№", "Предмет", "Назва", "Автор", "Рік", "Кількість", "Кабінет класу", "Класний керівник"]) {
    assert.match(xml, new RegExp(label, "u"));
  }
  assert.doesNotMatch(xml, /Номер документа|Фактичний відповідальний|Відповідальний учитель|CAT-ID|CAT-9999|Місце зберігання|Стан примірників|Секретне сховище|CLOAN-INTERNAL-SECRET/iu);
});

test("all operational report queries compile on the migrated schema", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const file of fs.readdirSync(path.join(root, "drizzle")).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    const sql = fs.readFileSync(path.join(root, "drizzle", file), "utf8");
    for (const statement of sql.split(/-->\s*statement-breakpoint/gu)) if (statement.trim()) sqlite.exec(statement);
  }
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return { all: async () => ({ results: sqlite.prepare(sql).all(...values) }) };
        },
      };
    },
  };
  for (const kind of reportStore.LIBRARIAN_REPORT_KINDS) {
    const report = await reportStore.readLibrarianReport(db, kind, "2026-01-01", "2026-12-31", "2026-08-28T08:00:00.000Z");
    assert.equal(report.kind, kind);
    const workbook = reportExcel.createLibrarianReportExcel(report);
    assert.ok(workbook.bytes.length > 0);
    assert.doesNotMatch(workbookXml(workbook.bytes), /CAT-ID|CAT-\d{4,}|catalog_number|catalogNumber/iu);
  }
  sqlite.close();
});

test("reports center exposes class statement history and protected report downloads", () => {
  const ui = fs.readFileSync(path.join(root, "app/librarian/reports/reports-workspace.tsx"), "utf8");
  const printPage = fs.readFileSync(path.join(root, "app/librarian/class-loans/[classLoanId]/statement/page.tsx"), "utf8");
  assert.match(ui, /Видані матеріали по класах/u);
  assert.match(ui, /Акт-відомості окремих видач/u);
  assert.match(ui, /\/api\/librarian\/reports\/\$\{item\.kind\}/u);
  assert.match(printPage, /Акт-відомість видачі матеріалів класу/u);
  assert.doesNotMatch(printPage, /CAT-ID|catalogNumber|catalog_number|Номер документа|Фактичний відповідальний|Місце зберігання|Стан примірників/iu);
});

function workbookXml(bytes) {
  return [...unzipStored(bytes).values()].map((value) => new TextDecoder().decode(value)).join("\n");
}

function unzipStored(bytes) {
  const entries = new Map();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    assert.equal(view.getUint16(offset + 8, true), 0);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    entries.set(name, bytes.slice(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return entries;
}
