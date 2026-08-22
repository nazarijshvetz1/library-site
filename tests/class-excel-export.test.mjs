import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const generator = await import(pathToFileURL(path.join(root, "lib/class-excel-export.ts")).href);
const store = await import(pathToFileURL(path.join(root, "lib/class-excel-export-store.ts")).href);

class PreparedStatement {
  constructor(database, sql, bindings = []) { this.database = database; this.sql = sql; this.bindings = bindings; }
  bind(...values) { return new PreparedStatement(this.database, this.sql, values); }
  async all() {
    this.database.queryCount += 1;
    return { success: true, results: this.database.sqlite.prepare(this.sql).all(...this.bindings) };
  }
}

class TestD1 {
  constructor(sqlite) { this.sqlite = sqlite; this.queryCount = 0; this.batchCounts = []; }
  prepare(sql) { return new PreparedStatement(this, sql); }
  async batch(statements) {
    this.batchCounts.push(statements.length);
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.all());
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
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const file of fs.readdirSync(path.join(root, "drizzle")).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    const sql = fs.readFileSync(path.join(root, "drizzle", file), "utf8");
    for (const statement of sql.split(/-->\s*statement-breakpoint/gu)) if (statement.trim()) sqlite.exec(statement);
  }
  seed(sqlite);
  return { sqlite, db: new TestD1(sqlite) };
}

function seed(sqlite) {
  const now = "2026-08-21T09:00:00.000Z";
  sqlite.prepare(`INSERT INTO users (id,full_name,sort_name,email,auth_user_id,role,status,created_at,updated_at)
    VALUES ('USR-LIB','Бібліотекар','бібліотекар','lib@example.test','auth-lib','librarian','active',?,?),
      ('USR-TEACH','Класний Керівник','класний керівник',NULL,NULL,'teacher','active',?,?)`).run(now, now, now, now);
  sqlite.prepare(`INSERT INTO locations (id,name,type,status,is_public,sort_order,created_at,updated_at)
    VALUES ('LOC-LIB','Бібліотека','library','active',1,1,?,?),('LOC-CLASS','Кабінет № 12','classroom','active',1,2,?,?)`).run(now, now, now, now);
  sqlite.prepare(`INSERT INTO academic_years (id,label,start_date,end_date,status,notes,version,created_at,updated_at)
    VALUES ('YR-1','2026/2027','2026-09-01','2027-06-30','active','',1,?,?)`).run(now, now);
  sqlite.prepare(`INSERT INTO cohorts (id,status,notes,created_at,updated_at) VALUES ('COH-1','active','',?,?),('COH-2','active','',?,?)`).run(now, now, now, now);
  sqlite.prepare(`INSERT INTO class_years (id,academic_year_id,cohort_id,class_name,grade,code,teacher_user_id,location_id,start_date,end_date,status,notes,version,created_at,updated_at)
    VALUES ('CY-5A','YR-1','COH-1','5-А',5,'А','USR-TEACH','LOC-CLASS','2026-09-01','2027-06-30','active','',1,?,?),
      ('CY-6B','YR-1','COH-2','6-Б',6,'Б',NULL,NULL,'2026-09-01','2027-06-30','active','',1,?,?)`).run(now, now, now, now);
  sqlite.prepare(`INSERT INTO materials (id,catalog_number,title,sort_title,search_text,rubric,publication_type,subject,class_from,class_to,author,publication_year,isbn,isbn_normalized,publisher,notes,status,version,created_at,updated_at)
    VALUES ('CAT-0001',1,'Математика 5 клас','математика 5 клас','математика','Підручники','Підручник','Математика',5,5,'Автор П.',2026,'','','','', 'active',1,?,?),
      ('CAT-0002',2,'Робочий зошит','робочий зошит','зошит','Робочі зошити','Робочий зошит','Математика',5,5,'Автор З.',2025,'','','','', 'active',1,?,?)`).run(now, now, now, now);
  sqlite.prepare(`INSERT INTO class_loans (id,class_year_id,responsible_teacher_user_id,status,issued_at,due_at,notes,issued_by_user_id,version,created_at,updated_at)
    VALUES ('CLOAN-1','CY-5A','USR-TEACH','open','2026-08-20T09:00:00.000Z','2027-06-01','', 'USR-LIB',1,?,?)`).run(now, now);
  sqlite.prepare(`INSERT INTO class_loan_items (id,class_loan_id,material_id,source_location_id,condition,quantity_issued,quantity_returned,notes,created_at,updated_at)
    VALUES ('CLI-1','CLOAN-1','CAT-0001','LOC-LIB','good',10,2,'',?,?),
      ('CLI-2','CLOAN-1','CAT-0002','LOC-LIB','good',5,1,'',?,?)`).run(now, now, now, now);
}

test("class export reads active classes and only outstanding class-loan quantities", async () => {
  const { sqlite, db } = openDatabase();
  const snapshot = await store.readClassExportSnapshot(db, null, "2026-08-21T12:00:00.000Z");
  assert.deepEqual(db.batchCounts, [2]);
  assert.equal(db.queryCount, 2);
  assert.equal(snapshot.classes.length, 2);
  assert.equal(snapshot.classes[0].className, "5-А");
  assert.equal(snapshot.classes[0].teacherName, "Класний Керівник");
  assert.equal(snapshot.classes[0].locationName, "Кабінет № 12");
  assert.equal(snapshot.classes[0].remainingQuantity, 12);
  assert.deepEqual(snapshot.classes[0].lines.map((line) => line.remainingQuantity), [8, 4]);
  assert.equal(snapshot.classes[1].teacherName, "Не призначено");
  assert.equal(snapshot.classes[1].lines.length, 0);
  sqlite.close();
});

test("each class workbook has the exact two sheets, requested columns and Times New Roman 14", async () => {
  const { sqlite, db } = openDatabase();
  const snapshot = await store.readClassExportSnapshot(db, "CY-5A", "2026-08-21T12:00:00.000Z");
  const workbook = generator.createClassExcelWorkbook(snapshot.classes[0], snapshot.generatedAt);
  const entries = unzipStored(workbook.bytes);
  const decode = (name) => new TextDecoder().decode(entries.get(name));
  const workbookXml = decode("xl/workbook.xml");
  const textbookSheet = decode("xl/worksheets/sheet1.xml");
  const methodicalSheet = decode("xl/worksheets/sheet2.xml");
  const styles = decode("xl/styles.xml");
  assert.match(workbookXml, /name="Підручники"/u);
  assert.match(workbookXml, /name="Методична література, зошити"/u);
  assert.equal((workbookXml.match(/<sheet /gu) ?? []).length, 2);
  for (const header of ["№", "Предмет", "Назва, автор і рік", "Залишилося у класу", "Рубрика", "Дата видачі"]) {
    assert.match(textbookSheet, new RegExp(`>${header.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}<`, "u"));
  }
  assert.match(textbookSheet, /Назва класу/u);
  assert.match(textbookSheet, /5-А/u);
  assert.match(textbookSheet, /Кабінет № 12/u);
  assert.match(textbookSheet, /Класний Керівник/u);
  assert.match(textbookSheet, /Математика 5 клас — Автор П. · 2026/u);
  assert.doesNotMatch(textbookSheet, /Робочий зошит/u);
  assert.match(methodicalSheet, /Робочий зошит — Автор З. · 2025/u);
  assert.match(textbookSheet, /orientation="landscape"/u);
  assert.match(styles, /<name val="Times New Roman"\/>/u);
  assert.match(styles, /<sz val="14"\/>/u);
  assert.equal(workbook.sheetCount, 2);
  assert.equal(workbook.rowCount, 2);
  sqlite.close();
});

test("all-classes export is a ZIP with one separate XLSX document per active class", async () => {
  const { sqlite, db } = openDatabase();
  const snapshot = await store.readClassExportSnapshot(db, null, "2026-08-21T12:00:00.000Z");
  const archive = generator.createAllClassesExcelArchive(snapshot);
  const entries = unzipStored(archive.bytes);
  assert.equal(archive.documentCount, 2);
  assert.equal(entries.size, 2);
  for (const [name, bytes] of entries) {
    assert.match(name, /\.xlsx$/u);
    assert.equal(bytes[0], 0x50);
    assert.equal(bytes[1], 0x4b);
  }
  assert.match(archive.fileName, /^Видачі класам — 2026-08-21 /u);
  sqlite.close();
});

test("protected export UI exposes one class and all-classes downloads", async () => {
  const [ui, route] = await Promise.all([
    fs.promises.readFile(path.join(root, "app/librarian/export/excel-export-workspace.tsx"), "utf8"),
    fs.promises.readFile(path.join(root, "app/api/librarian/class-excel-export/route.ts"), "utf8"),
  ]);
  assert.match(route, /authorizeLibrarianApi/u);
  assert.match(route, /private, no-store/u);
  assert.match(route, /application\/zip/u);
  assert.match(ui, /Видані матеріали по класах/u);
  assert.match(ui, /Підручники/u);
  assert.match(ui, /Методична література, зошити/u);
  assert.match(ui, /Завантажити обраний клас/u);
  assert.match(ui, /Завантажити всі класи/u);
});

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
