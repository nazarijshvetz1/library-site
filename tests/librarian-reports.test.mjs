import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { runAssistantLibraryTool } from "../lib/assistant-library.ts";

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
  const { sqlite, db } = openReportDatabase();
  for (const kind of reportStore.LIBRARIAN_REPORT_KINDS) {
    const report = await reportStore.readLibrarianReport(db, kind, "2026-01-01", "2026-12-31", "2026-08-28T08:00:00.000Z");
    assert.equal(report.kind, kind);
    const workbook = reportExcel.createLibrarianReportExcel(report);
    assert.ok(workbook.bytes.length > 0);
    const xml = workbookXml(workbook.bytes);
    assert.doesNotMatch(xml, /CAT-ID|CAT-\d{4,}|catalog_number|catalogNumber/iu);
    if (kind === "inventory") {
      assert.match(xml, /Станом на/u);
      assert.doesNotMatch(xml, /Період/u);
    }
  }
  sqlite.close();
});

test("Jarvis report tool uses existing queries and returns authorized download routes", async () => {
  const { sqlite, db } = openReportDatabase();
  const context = { role: "librarian", actorKey: "librarian:test", sessionId: "test", bookingEnabled: false, scheduleEnabled: false };
  for (const report of reportStore.LIBRARIAN_REPORT_KINDS) {
    const result = await runAssistantLibraryTool(db, context, "librarian_report", { report, from: "2026-08-01", to: "2026-09-05" });
    assert.equal(result.success, true);
    assert.match(result.cards[0].href, /^\/api\/librarian\/reports\//u);
  }
  await assert.rejects(runAssistantLibraryTool(db, { ...context, role: "teacher" }, "librarian_report", { report: "inventory", from: "2026-08-01", to: "2026-09-05" }), { code: "assistant_tool_denied" });
  sqlite.close();
});

test("class reports date appended items by their issue transaction", async () => {
  const { sqlite, db } = openReportDatabase();
  const createdAt = "2026-08-20T09:00:00.000Z";
  sqlite.prepare(`INSERT INTO users (id,full_name,sort_name,email,auth_user_id,role,status,created_at,updated_at)
    VALUES ('USR-REPORT-LIB','Бібліотекар','бібліотекар',NULL,NULL,'librarian','active',?,?),
      ('USR-REPORT-TEACH','Учитель Тестовий','учитель тестовий',NULL,NULL,'teacher','active',?,?)`).run(createdAt, createdAt, createdAt, createdAt);
  sqlite.prepare(`INSERT INTO locations (id,name,type,status,is_public,sort_order,created_at,updated_at)
    VALUES ('LOC-REPORT','Бібліотека','library','active',1,1,?,?)`).run(createdAt, createdAt);
  sqlite.prepare(`INSERT INTO academic_years (id,label,start_date,end_date,status,notes,version,created_at,updated_at)
    VALUES ('YR-REPORT','2026/2027','2026-09-01','2027-06-30','active','',1,?,?)`).run(createdAt, createdAt);
  sqlite.prepare(`INSERT INTO cohorts (id,status,notes,created_at,updated_at)
    VALUES ('COH-REPORT','active','',?,?)`).run(createdAt, createdAt);
  sqlite.prepare(`INSERT INTO class_years (id,academic_year_id,cohort_id,class_name,grade,code,teacher_user_id,location_id,start_date,end_date,status,notes,version,created_at,updated_at)
    VALUES ('CY-REPORT','YR-REPORT','COH-REPORT','5-А',5,'А','USR-REPORT-TEACH',NULL,'2026-09-01','2027-06-30','active','',1,?,?)`).run(createdAt, createdAt);
  sqlite.prepare(`INSERT INTO materials (id,catalog_number,title,sort_title,search_text,rubric,publication_type,subject,class_from,class_to,author,publication_year,isbn,isbn_normalized,publisher,notes,status,version,created_at,updated_at)
    VALUES ('CAT-9101',9101,'Старий підручник','старий підручник','старий підручник','Підручники','Підручник','Математика',5,5,'Автор',2025,'','','','', 'active',1,?,?),
      ('CAT-9102',9102,'Доданий підручник','доданий підручник','доданий підручник','Підручники','Підручник','Математика',5,5,'Автор',2026,'','','','', 'active',1,?,?)`).run(createdAt, createdAt, createdAt, createdAt);
  sqlite.prepare(`INSERT INTO class_loans (id,class_year_id,responsible_teacher_user_id,status,issued_at,due_at,notes,issued_by_user_id,version,created_at,updated_at)
    VALUES ('CLOAN-REPORT','CY-REPORT','USR-REPORT-TEACH','open','2026-08-20T09:00:00.000Z','2027-06-01','', 'USR-REPORT-LIB',1,?,?)`).run(createdAt, createdAt);
  sqlite.prepare(`INSERT INTO class_loan_items (id,class_loan_id,material_id,source_location_id,condition,quantity_issued,quantity_returned,notes,created_at,updated_at)
    VALUES ('CLI-REPORT-OLD','CLOAN-REPORT','CAT-9101','LOC-REPORT','good',2,0,'',?,?),
      ('CLI-REPORT-NEW','CLOAN-REPORT','CAT-9102','LOC-REPORT','good',3,0,'','2026-09-05T10:00:00.000Z','2026-09-05T10:00:00.000Z')`).run(createdAt, createdAt);
  sqlite.prepare(`INSERT INTO class_loan_items (
      id,class_loan_id,material_id,source_location_id,condition,quantity_issued,quantity_returned,
      lifecycle_status,version,removed_at,removed_by_user_id,removal_reason,notes,created_at,updated_at)
    VALUES ('CLI-REPORT-REMOVED','CLOAN-REPORT','CAT-9101','LOC-REPORT','good',10,0,
      'removed',2,?,'USR-REPORT-LIB','Помилковий рядок','',?,?)`).run(createdAt, createdAt, createdAt);
  sqlite.prepare(`INSERT INTO class_loan_transactions (id,request_id,class_loan_id,kind,occurred_at,notes,actor_user_id,created_at)
    VALUES ('CLTX-REPORT-NEW','REQ-REPORT-NEW','CLOAN-REPORT','issue','2026-09-05T10:00:00.000Z','', 'USR-REPORT-LIB','2026-09-05T10:00:00.000Z')`).run();
  sqlite.prepare(`INSERT INTO class_loan_transactions (id,request_id,class_loan_id,kind,occurred_at,notes,actor_user_id,created_at)
    VALUES ('CLTX-REPORT-ADJUST','REQ-REPORT-ADJUST-TX','CLOAN-REPORT','issue','2026-09-10T10:00:00.000Z','Коригування відомості','USR-REPORT-LIB','2026-09-10T10:00:00.000Z')`).run();
  sqlite.prepare(`INSERT INTO class_loan_transaction_lines (id,transaction_id,class_loan_item_id,material_id,location_id,condition,quantity_delta,quantity_before,quantity_after,created_at)
    VALUES ('CLTL-REPORT-NEW','CLTX-REPORT-NEW','CLI-REPORT-NEW','CAT-9102','LOC-REPORT','good',-2,5,3,'2026-09-05T10:00:00.000Z')`).run();
  sqlite.prepare(`INSERT INTO class_loan_transaction_lines (id,transaction_id,class_loan_item_id,material_id,location_id,condition,quantity_delta,quantity_before,quantity_after,created_at)
    VALUES ('CLTL-REPORT-ADJUST','CLTX-REPORT-ADJUST','CLI-REPORT-NEW','CAT-9102','LOC-REPORT','good',-1,3,2,'2026-09-10T10:00:00.000Z')`).run();
  sqlite.prepare(`INSERT INTO class_loan_item_adjustments (
      id,request_id,class_loan_id,class_loan_item_id,statement_line_id,transaction_id,action,
      quantity_before,quantity_after,quantity_returned_snapshot,stock_delta,location_id,condition,reason,actor_user_id,created_at)
    VALUES ('CLADJ-REPORT','REQ-REPORT-ADJUST','CLOAN-REPORT','CLI-REPORT-NEW',NULL,'CLTX-REPORT-ADJUST','quantity_changed',
      2,3,0,-1,'LOC-REPORT','good','Звірено з класним журналом','USR-REPORT-LIB','2026-09-10T10:00:00.000Z')`).run();

  const septemberReturns = await reportStore.readLibrarianReport(db, "returns", "2026-09-01", "2026-09-30");
  const classRows = septemberReturns.sections.find((section) => section.key === "classes").rows;
  assert.deepEqual(classRows.map((row) => ({ title: row.title, issuedAt: row.issuedAt })), [
    { title: "Доданий підручник", issuedAt: "2026-09-05T10:00:00.000Z" },
  ]);
  const septemberProvision = await reportStore.readLibrarianReport(db, "provision", "2026-09-01", "2026-09-30");
  assert.deepEqual(septemberProvision.sections[0].rows.map((row) => ({ title: row.title, issued: row.issued })), [
    { title: "Доданий підручник", issued: 3 },
  ]);
  const septemberAnnual = await reportStore.readLibrarianReport(db, "annual", "2026-09-01", "2026-09-30");
  assert.equal(septemberAnnual.sections[0].rows[0].issuedToClasses, 3);
  const septemberMovement = await reportStore.readLibrarianReport(db, "movement", "2026-09-01", "2026-09-30");
  const classMovementRows = septemberMovement.sections.find((section) => section.key === "classes").rows;
  assert.deepEqual(classMovementRows.map((row) => ({
    kind: row.kind,
    title: row.title,
    quantityDelta: row.quantityDelta,
    reason: row.reason,
  })), [
    {
      kind: "adjustment_quantity",
      title: "Доданий підручник",
      quantityDelta: -1,
      reason: "Звірено з класним журналом",
    },
    { kind: "issue", title: "Доданий підручник", quantityDelta: -2, reason: "" },
  ]);
  const movementXml = workbookXml(reportExcel.createLibrarianReportExcel(septemberMovement).bytes);
  assert.match(movementXml, /Уточнення кількості/u);
  assert.match(movementXml, /Звірено з класним журналом/u);

  const augustReturns = await reportStore.readLibrarianReport(db, "returns", "2026-08-01", "2026-08-31");
  const legacyRows = augustReturns.sections.find((section) => section.key === "classes").rows;
  assert.deepEqual(legacyRows.map((row) => ({ title: row.title, issuedAt: row.issuedAt })), [
    { title: "Старий підручник", issuedAt: "2026-08-20T09:00:00.000Z" },
  ]);
  assert.equal(legacyRows[0].outstanding, 2);
  const augustAnnual = await reportStore.readLibrarianReport(db, "annual", "2026-08-01", "2026-08-31");
  assert.equal(augustAnnual.sections[0].rows[0].issuedToClasses, 2);

  sqlite.prepare(`UPDATE class_loan_items
    SET lifecycle_status='removed',version=version+1,removed_at=?,removed_by_user_id='USR-REPORT-LIB',
      removal_reason='Помилкову видачу вилучено',updated_at=?
    WHERE id='CLI-REPORT-NEW'`).run("2026-09-20T10:00:00.000Z", "2026-09-20T10:00:00.000Z");
  const afterRemovalAnnual = await reportStore.readLibrarianReport(db, "annual", "2026-09-01", "2026-09-30");
  assert.equal(afterRemovalAnnual.sections[0].rows[0].issuedToClasses, 0);
  const afterRemovalProvision = await reportStore.readLibrarianReport(db, "provision", "2026-09-01", "2026-09-30");
  assert.equal(afterRemovalProvision.sections[0].rows.length, 0);
  sqlite.close();
});

test("reports center exposes class statement history and protected report downloads", () => {
  const ui = fs.readFileSync(path.join(root, "app/librarian/reports/reports-workspace.tsx"), "utf8");
  const printPage = fs.readFileSync(path.join(root, "app/librarian/class-loans/[classLoanId]/statement/page.tsx"), "utf8");
  const manager = fs.readFileSync(path.join(root, "app/librarian/class-loans/[classLoanId]/statement/statement-manager.tsx"), "utf8");
  const workspace = fs.readFileSync(path.join(root, "app/librarian/d1-workspace.tsx"), "utf8");
  assert.match(ui, /Видані матеріали по класах/u);
  assert.match(ui, /aria-label="Найчастіші документи"/u);
  assert.match(ui, /Потреба на новий навчальний рік/u);
  assert.match(ui, /Акт-відомості окремих видач/u);
  assert.match(ui, /<details className=\{styles\.statementList\}>/u);
  assert.match(ui, /window\.addEventListener\("hashchange", syncHash\)/u);
  assert.match(ui, /activeSubsection=\{activeSubsection\}/u);
  assert.match(ui, /currentSnapshot = item\.kind === "inventory"/u);
  assert.match(ui, /Стан на момент формування/u);
  assert.match(ui, /Показано \$\{visibleStatements\.length\} із \$\{filteredStatements\.length\}/u);
  assert.match(ui, /\/api\/librarian\/reports\/\$\{item\.kind\}/u);
  assert.match(printPage, /Акт-відомість видачі матеріалів класу/u);
  assert.doesNotMatch(printPage, /CAT-ID|catalogNumber|catalog_number|Номер документа|Фактичний відповідальний|Місце зберігання|Стан примірників/iu);
  assert.match(manager, /role="tablist"/u);
  assert.ok(manager.includes('aria-controls={`statement-manager-${id}`}'));
  assert.match(manager, /historyLimit/u);
  assert.match(manager, /sessionStorage\.setItem\(key, JSON\.stringify\(payload\)\)/u);
  assert.match(manager, /link_legacy_item/u);
  assert.match(manager, /Підтвердити зв’язок/u);
  assert.match(workspace, /query\.get\("issuedAt"\)/u);
  assert.match(workspace, /актуальні дані спільної відомості/u);
});

function workbookXml(bytes) {
  return [...unzipStored(bytes).values()].map((value) => new TextDecoder().decode(value)).join("\n");
}

function openReportDatabase() {
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
  return { sqlite, db };
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
