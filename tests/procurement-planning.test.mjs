import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const store = await import(pathToFileURL(path.join(root, "lib/procurement-planning-store.ts")).href);
const excel = await import(pathToFileURL(path.join(root, "lib/procurement-planning-excel.ts")).href);

class Statement {
  constructor(db, sql, bindings = []) { this.db = db; this.sql = sql; this.bindings = bindings; }
  bind(...values) { return new Statement(this.db, this.sql, values); }
  async first() { return this.db.sqlite.prepare(this.sql).get(...this.bindings) ?? null; }
  async all() { return this.execute(); }
  async run() { return this.execute(); }
  execute() {
    const prepared = this.db.sqlite.prepare(this.sql);
    if (/^\s*(?:select|with|pragma)/iu.test(this.sql)) return { success: true, results: prepared.all(...this.bindings), meta: { changes: 0 } };
    const result = prepared.run(...this.bindings);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class TestD1 {
  constructor(sqlite) { this.sqlite = sqlite; }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
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

class FinalizationRaceD1 extends TestD1 {
  beforeNextBatch = null;
  async batch(statements) {
    if (this.beforeNextBatch) {
      const callback = this.beforeNextBatch;
      this.beforeNextBatch = null;
      callback();
    }
    return super.batch(statements);
  }
}

function context() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const file of fs.readdirSync(path.join(root, "drizzle")).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    const sql = fs.readFileSync(path.join(root, "drizzle", file), "utf8");
    for (const statement of sql.split(/-->\s*statement-breakpoint/gu)) if (statement.trim()) sqlite.exec(statement);
  }
  const now = "2026-08-28T10:00:00.000Z";
  sqlite.exec(`
    INSERT INTO users (id,full_name,sort_name,email,auth_user_id,role,status,created_at,updated_at)
      VALUES ('USR-PLAN-LIB','Бібліотекар','бібліотекар','planning@example.test','auth-planning','librarian','active','${now}','${now}');
    INSERT INTO academic_years (id,label,start_date,end_date,status,notes,version,created_at,updated_at)
      VALUES ('YR-CURRENT','2026/2027','2026-09-01','2027-05-31','active','',1,'${now}','${now}');
    INSERT INTO cohorts (id,status,notes,created_at,updated_at)
      VALUES ('COH-7A','active','','${now}','${now}');
    INSERT INTO class_years (id,academic_year_id,cohort_id,class_name,grade,code,start_date,end_date,status,notes,version,created_at,updated_at)
      VALUES ('CY-7A','YR-CURRENT','COH-7A','7-А',7,'А','2026-09-01','2027-05-31','active','',1,'${now}','${now}');
    INSERT INTO locations (id,name,type,status,is_public,sort_order,created_at,updated_at)
      VALUES ('LOC-LIB','Бібліотека','library','active',1,1,'${now}','${now}');
    INSERT INTO materials (id,catalog_number,title,sort_title,search_text,rubric,publication_type,subject,class_from,class_to,author,publication_year,isbn,isbn_normalized,publisher,notes,status,version,created_at,updated_at)
      VALUES ('CAT-9001',9001,'Алгебра — 8 клас','алгебра 8 клас','алгебра 8 клас','Підручники','Підручник','Математика',8,8,'Автор Алгебри',2025,'','','Освіта','','active',1,'${now}','${now}');
    INSERT INTO holdings (material_id,location_id,condition,quantity,version,updated_at) VALUES
      ('CAT-9001','LOC-LIB','good',20,1,'${now}'),
      ('CAT-9001','LOC-LIB','damaged',5,1,'${now}');
    INSERT INTO material_stock_totals (material_id,total_quantity,library_quantity,other_location_quantity,loaned_quantity,reserved_quantity,updated_at)
      VALUES ('CAT-9001',25,25,0,0,2,'${now}');
    INSERT INTO material_links (id,material_id,kind,label,url,is_public,sort_order,status,created_at,updated_at) VALUES
      ('ML-DETAILS','CAT-9001','details','Опис','https://example.test/details',1,0,'active','${now}','${now}'),
      ('ML-EBOOK','CAT-9001','ebook','Електронна версія','https://example.test/ebook',1,5,'active','${now}','${now}');
  `);
  return { sqlite, db: new TestD1(sqlite) };
}

const librarian = { userId: "auth-planning", d1UserId: "USR-PLAN-LIB", displayName: "Бібліотекар", email: "planning@example.test", fullName: "Бібліотекар" };

test("planning keeps missing pupil counts explicit and deducts shared reusable stock once", async () => {
  const { sqlite, db } = context();
  let plan = await store.createProcurementPlan(db, librarian, { academicYearLabel: "2027/2028", title: "Потреба фонду", defaultReserve: 0, notes: "" });
  plan = await store.mutateProcurementPlan(db, librarian, plan.id, { action: "prefill_classes" });
  assert.deepEqual(plan.classes.map((item) => [item.className, item.studentCount]), [["8-А", null]]);
  const firstClass = plan.classes[0];
  plan = await store.mutateProcurementPlan(db, librarian, plan.id, { action: "upsert_class", id: firstClass.id, expectedVersion: firstClass.version, className: "8-А", grade: 8, studentCount: 25, notes: "", sortOrder: 800 });
  plan = await store.mutateProcurementPlan(db, librarian, plan.id, { action: "upsert_class", className: "8-Б", grade: 8, studentCount: 20, notes: "", sortOrder: 801 });
  plan = await store.mutateProcurementPlan(db, librarian, plan.id, { action: "upsert_resource", materialId: "CAT-9001", category: "textbook", stockMode: "reusable", title: "Алгебра — 8 клас", subject: "Математика", author: "", publisher: "", publicationYear: 2025, sourceUrl: "", notes: "", usableQuantityOverride: null, additionalIncomingQuantity: 0, sortOrder: 0 });
  const reusable = plan.resources[0];
  assert.equal(reusable.sourceUrl, "https://example.test/ebook");
  for (const planClass of plan.classes) plan = await store.mutateProcurementPlan(db, librarian, plan.id, { action: "upsert_allocation", resourceId: reusable.id, classId: planClass.id, demandMode: "per_student", copiesPerUnit: 1, fixedQuantity: 0, reserveQuantity: 0, notes: "" });
  const calculated = plan.resources.find((item) => item.id === reusable.id);
  assert.equal(calculated.demandQuantity, 45);
  assert.equal(calculated.usableQuantity, 18);
  assert.equal(calculated.toOrderQuantity, 27);
  assert.equal(calculated.surplusQuantity, 0);

  plan = await store.mutateProcurementPlan(db, librarian, plan.id, { action: "upsert_resource", materialId: null, category: "workbook", stockMode: "consumable", title: "Робочий зошит з алгебри", subject: "Математика", author: "Автор", publisher: "Освіта", publicationYear: 2025, sourceUrl: "https://example.test/workbook", notes: "", usableQuantityOverride: null, additionalIncomingQuantity: 0, sortOrder: 1 });
  const consumable = plan.resources.find((item) => item.stockMode === "consumable");
  for (const planClass of plan.classes) plan = await store.mutateProcurementPlan(db, librarian, plan.id, { action: "upsert_allocation", resourceId: consumable.id, classId: planClass.id, demandMode: "per_student", copiesPerUnit: 1, fixedQuantity: 0, reserveQuantity: 0, notes: "" });
  const workbook = plan.resources.find((item) => item.id === consumable.id);
  assert.equal(workbook.usableQuantity, 0);
  assert.equal(workbook.toOrderQuantity, 45);

  plan = await store.mutateProcurementPlan(db, librarian, plan.id, { action: "update_plan", expectedVersion: plan.version, title: plan.title, defaultReserve: 0, notes: "", revisionConfirmed: true });
  plan = await store.mutateProcurementPlan(db, librarian, plan.id, { action: "set_status", status: "finalized", expectedVersion: plan.version });
  assert.equal(plan.status, "finalized");
  assert.equal(plan.snapshotCount, 1);
  const frozenPlan = await store.readLatestProcurementPlanSnapshot(db, plan.id);
  assert.equal(frozenPlan.totals.demandQuantity, 90);
  assert.equal(frozenPlan.totals.toOrderQuantity, 72);
  assert.throws(() => sqlite.prepare("UPDATE procurement_plan_classes SET student_count=30 WHERE id=?").run(firstClass.id), /procurement_plan_locked/u);
  const snapshotId = sqlite.prepare("SELECT id FROM procurement_plan_snapshots WHERE plan_id=?").get(plan.id).id;
  assert.throws(() => sqlite.prepare("UPDATE procurement_plan_snapshots SET inventory_cutoff_at=? WHERE id=?").run("2027-01-01", snapshotId), /procurement_plan_snapshot_immutable/u);
  assert.throws(() => sqlite.prepare("DELETE FROM procurement_plan_snapshots WHERE id=?").run(snapshotId), /procurement_plan_snapshot_immutable/u);
  plan = await store.mutateProcurementPlan(db, librarian, plan.id, { action: "set_status", status: "draft", expectedVersion: plan.version });
  const reopenedClass = plan.classes.find((item) => item.id === firstClass.id);
  plan = await store.mutateProcurementPlan(db, librarian, plan.id, { action: "upsert_class", id: reopenedClass.id, expectedVersion: reopenedClass.version, className: reopenedClass.className, grade: reopenedClass.grade, studentCount: 30, notes: "", sortOrder: reopenedClass.sortOrder });
  assert.equal(plan.totals.demandQuantity, 100);
  assert.equal((await store.readLatestProcurementPlanSnapshot(db, plan.id)).totals.demandQuantity, 90);
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("finalization rejects a concurrent child change without creating an orphan snapshot", async () => {
  const { sqlite } = context();
  const db = new FinalizationRaceD1(sqlite);
  let plan = await store.createProcurementPlan(db, librarian, { academicYearLabel: "2028/2029", title: "Перевірка гонки", defaultReserve: 0, notes: "" });
  plan = await store.mutateProcurementPlan(db, librarian, plan.id, { action: "upsert_class", className: "1-А", grade: 1, studentCount: 20, notes: "", sortOrder: 100 });
  plan = await store.mutateProcurementPlan(db, librarian, plan.id, { action: "update_plan", expectedVersion: plan.version, title: plan.title, defaultReserve: 0, notes: "", revisionConfirmed: true });
  const planClass = plan.classes[0];
  db.beforeNextBatch = () => sqlite.prepare("UPDATE procurement_plan_classes SET student_count=21, version=version+1 WHERE id=?").run(planClass.id);
  await assert.rejects(
    store.mutateProcurementPlan(db, librarian, plan.id, { action: "set_status", status: "finalized", expectedVersion: plan.version }),
    (error) => error instanceof store.ProcurementPlanningError && error.code === "version_conflict",
  );
  assert.equal(sqlite.prepare("SELECT status FROM procurement_plans WHERE id=?").get(plan.id).status, "draft");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM procurement_plan_snapshots WHERE plan_id=?").get(plan.id).count, 0);
  assert.equal(sqlite.prepare("SELECT student_count FROM procurement_plan_classes WHERE id=?").get(planClass.id).student_count, 21);
});

test("planning workbook follows the reference columns and leaks no internal identifiers", async () => {
  const { db } = context();
  let plan = await store.createProcurementPlan(db, librarian, { academicYearLabel: "2027/2028", title: "Потреба фонду", defaultReserve: 0, notes: "" });
  plan = await store.mutateProcurementPlan(db, librarian, plan.id, { action: "upsert_class", className: "1-А", grade: 1, studentCount: null, notes: "", sortOrder: 100 });
  plan = await store.mutateProcurementPlan(db, librarian, plan.id, { action: "upsert_resource", materialId: null, category: "other", stockMode: "consumable", title: "=НЕ ФОРМУЛА", subject: "Навчання грамоти", author: "Автор", publisher: "Видавництво", publicationYear: 2027, sourceUrl: "https://example.test/book", notes: "Примітка", usableQuantityOverride: null, additionalIncomingQuantity: 0, sortOrder: 0 });
  const workbook = excel.createProcurementPlanExcel(plan);
  const raw = new TextDecoder().decode(workbook.bytes);
  for (const header of ["Назва видання/підручника", "Автор", "Видавництво", "Рік", "К-сть", "Електронна версія", "Примітки"]) assert.match(raw, new RegExp(header, "u"));
  assert.doesNotMatch(raw, /CAT-9001|PPLAN-|PRES-|PCLASS-/u);
  assert.match(raw, /НЕ ФОРМУЛА/u);
  assert.ok(workbook.sheetCount >= 5);
});

test("planning UI is reachable from acquisitions, reports and Telegram", () => {
  const workspace = fs.readFileSync(path.join(root, "app/librarian/acquisitions/planning/procurement-planning-workspace.tsx"), "utf8");
  const acquisition = fs.readFileSync(path.join(root, "app/librarian/acquisitions/acquisition-workspace.tsx"), "utf8");
  const reports = fs.readFileSync(path.join(root, "app/librarian/reports/reports-workspace.tsx"), "utf8");
  const telegram = fs.readFileSync(path.join(root, "app/librarian/telegram/cabinet/page.tsx"), "utf8");
  const printPage = fs.readFileSync(path.join(root, "app/librarian/acquisitions/planning/[planId]/print/page.tsx"), "utf8");
  assert.match(workspace, /Кількість учнів можна внести пізніше/u);
  assert.match(workspace, /Підготувати з чинних класів/u);
  assert.match(workspace, /Завершити план/u);
  assert.match(acquisition, /acquisitionSubsections/u);
  assert.match(reports, /Потреба на новий навчальний рік/u);
  assert.match(telegram, /boundedAcquisitionView\(params\?\.view\)/u);
  assert.match(printPage, /resolveD1LibrarianUser/u);
  assert.match(printPage, /readLatestProcurementPlanSnapshot/u);
});
