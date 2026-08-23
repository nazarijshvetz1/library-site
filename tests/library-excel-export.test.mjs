import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const generator = await import(pathToFileURL(path.join(root, "lib/library-excel-export.ts")).href);
const store = await import(pathToFileURL(path.join(root, "lib/library-export-store.ts")).href);
const codeTemplate = await import(pathToFileURL(path.join(root, "lib/teacher-code-import-excel.ts")).href);
const acquisitionExcel = await import(pathToFileURL(path.join(root, "lib/acquisition-excel.ts")).href);

class PreparedStatement {
  constructor(database, sql, bindings = []) { this.database = database; this.sql = sql; this.bindings = bindings; }
  bind(...values) { return new PreparedStatement(this.database, this.sql, values); }
  async all() { return this.execute(); }
  execute() {
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
      const result = statements.map((statement) => statement.execute());
      this.sqlite.exec("COMMIT");
      return result;
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
  const now = "2026-08-21T12:34:00.000Z";
  sqlite.prepare(`INSERT INTO users (id,full_name,sort_name,email,auth_user_id,role,status,created_at,updated_at)
    VALUES (?,?,?,?,?,'librarian','active',?,?)`).run("USR-LIB", "Бібліотекар", "бібліотекар", "private@example.test", "auth-lib", now, now);
  sqlite.prepare(`INSERT INTO users (id,full_name,sort_name,email,auth_user_id,role,status,created_at,updated_at)
    VALUES (?,?,?,?,?,'teacher','active',?,?)`).run("USR-TEACH", "Учитель Тестовий", "учитель тестовий", "teacher@example.test", null, now, now);
  sqlite.prepare(`INSERT INTO locations (id,name,type,status,is_public,sort_order,created_at,updated_at)
    VALUES ('LOC-001','Бібліотека','library','active',1,1,?,?),('LOC-002','Кабінет № 5','classroom','active',1,2,?,?)`).run(now, now, now, now);
  sqlite.prepare(`INSERT INTO teacher_profiles (teacher_user_id,subject_position,primary_location_id,service_contact,librarian_note,version,created_by_user_id,updated_by_user_id,created_at,updated_at)
    VALUES ('USR-TEACH','Математика','LOC-002','службовий контакт','примітка',1,'USR-LIB','USR-LIB',?,?)`).run(now, now);
  sqlite.prepare(`INSERT INTO materials (id,catalog_number,title,sort_title,search_text,rubric,publication_type,subject,class_from,class_to,author,publication_year,isbn,isbn_normalized,publisher,notes,status,version,created_at,updated_at)
    VALUES ('CAT-0001',1,'=HYPERLINK(""https://example.test"")','математика','математика','Підручники','Підручник','Математика',5,5,'Автор',2026,'9780000000001','9780000000001','Видавництво','Тест','active',1,?,?)`).run(now, now);
  sqlite.prepare(`INSERT INTO material_links (id,material_id,kind,label,url,is_public,sort_order,status,created_at,updated_at)
    VALUES ('LINK-1','CAT-0001','ebook','Електронна версія','https://example.test/book',1,1,'active',?,?)`).run(now, now);
  sqlite.prepare(`INSERT INTO holdings (material_id,location_id,condition,quantity,version,updated_at)
    VALUES ('CAT-0001','LOC-001','good',4,1,?)`).run(now);
  sqlite.prepare(`INSERT INTO material_stock_totals (material_id,total_quantity,library_quantity,other_location_quantity,loaned_quantity,reserved_quantity,updated_at)
    VALUES ('CAT-0001',6,4,0,2,1,?)`).run(now);
  sqlite.prepare(`INSERT INTO academic_years (id,label,start_date,end_date,status,notes,version,created_at,updated_at)
    VALUES ('YR-2026','2026/2027','2026-09-01','2027-06-30','active','',1,?,?)`).run(now, now);
  sqlite.prepare(`INSERT INTO cohorts (id,status,notes,created_at,updated_at) VALUES ('COH-001','active','',?,?)`).run(now, now);
  sqlite.prepare(`INSERT INTO class_years (id,academic_year_id,cohort_id,class_name,grade,code,teacher_user_id,location_id,start_date,end_date,status,notes,version,created_at,updated_at)
    VALUES ('CY-2026-001','YR-2026','COH-001','5-А',5,'А','USR-TEACH','LOC-002','2026-09-01','2027-06-30','active','',1,?,?)`).run(now, now);
  sqlite.prepare(`INSERT INTO loans (id,teacher_user_id,status,issued_at,due_at,notes,issued_by_user_id,version,created_at,updated_at)
    VALUES ('LOAN-1','USR-TEACH','open',?,'2027-06-01','', 'USR-LIB',1,?,?)`).run(now, now, now);
  sqlite.prepare(`INSERT INTO loan_items (id,loan_id,material_id,source_location_id,condition,quantity_issued,quantity_returned,notes,created_at,updated_at)
    VALUES ('LI-1','LOAN-1','CAT-0001','LOC-001','good',1,0,'',?,?)`).run(now, now);
  sqlite.prepare(`INSERT INTO class_loans (id,class_year_id,responsible_teacher_user_id,status,issued_at,due_at,notes,issued_by_user_id,version,created_at,updated_at)
    VALUES ('CLOAN-1','CY-2026-001','USR-TEACH','open',?,'2027-06-01','', 'USR-LIB',1,?,?)`).run(now, now, now);
  sqlite.prepare(`INSERT INTO class_loan_items (id,class_loan_id,material_id,source_location_id,condition,quantity_issued,quantity_returned,notes,created_at,updated_at)
    VALUES ('CLI-1','CLOAN-1','CAT-0001','LOC-001','good',1,0,'',?,?)`).run(now, now);
  sqlite.prepare(`INSERT INTO material_requests (id,teacher_user_id,status,teacher_notes,librarian_note,rejection_reason,pickup_location_id,due_at,reviewed_by_user_id,version,submitted_at,ready_at,created_at,updated_at)
    VALUES ('REQ-1','USR-TEACH','ready','Для уроку','Готово','','LOC-001','2027-06-01','USR-LIB',1,?,?,?,?)`).run(now, now, now, now);
  sqlite.prepare(`INSERT INTO material_request_items (id,request_id,material_id,title_snapshot,author_snapshot,requested_quantity,approved_quantity,fulfilled_quantity,sort_order,created_at,updated_at)
    VALUES ('MRI-1','REQ-1','CAT-0001','Математика','Автор',1,1,0,0,?,?)`).run(now, now);
  sqlite.prepare(`INSERT INTO material_request_reservations (id,request_id,request_item_id,material_id,source_location_id,condition,reserved_quantity,issued_quantity,released_quantity,created_at,updated_at)
    VALUES ('RES-1','REQ-1','MRI-1','CAT-0001','LOC-001','good',1,0,0,?,?)`).run(now, now);
}

test("export reads all requested blocks in one bounded batch and excludes authentication secrets", async () => {
  const { sqlite, db } = openDatabase();
  const snapshot = await store.readLibraryExportSnapshot(db, "2026-08-21T12:34:00.000Z");
  assert.equal(db.queryCount, 7);
  assert.deepEqual(db.batchCounts, [7]);
  assert.equal(snapshot.materials.length, 1);
  assert.equal(snapshot.holdings[0].reservedQuantity, 1);
  assert.equal(snapshot.holdings[0].availableQuantity, 3);
  assert.equal(snapshot.teacherLoans[0].remainingQuantity, 1);
  assert.equal(snapshot.classLoans[0].remainingQuantity, 1);
  assert.equal(snapshot.materialRequests[0].activeReservedQuantity, 1);
  assert.equal(Object.hasOwn(snapshot.teachers[0], "email"), false);
  assert.equal(JSON.stringify(snapshot).includes("teacher@example.test"), false);
  assert.equal(JSON.stringify(snapshot).includes("code_hmac"), false);
  sqlite.close();
});

test("generated XLSX has the full workbook structure, subject sheets and safe inline text", async () => {
  const { sqlite, db } = openDatabase();
  const snapshot = await store.readLibraryExportSnapshot(db, "2026-08-21T12:34:00.000Z");
  const workbook = generator.createLibraryExcelExport(snapshot);
  const entries = unzipStored(workbook.bytes);
  const decode = (name) => new TextDecoder().decode(entries.get(name));
  const workbookXml = decode("xl/workbook.xml");
  const styles = decode("xl/styles.xml");
  const catalog = decode("xl/worksheets/sheet2.xml");
  assert.equal(workbook.bytes[0], 0x50);
  assert.equal(workbook.bytes[1], 0x4b);
  for (const sheet of ["Зведення", "Каталог", "Залишки", "За класами", "Видачі вчителям", "Видачі класам", "Заявки вчителів", "Математика"]) {
    assert.match(workbookXml, new RegExp(`name="${sheet}"`, "u"));
  }
  assert.match(styles, /<name val="Times New Roman"\/>/u);
  assert.match(styles, /sz val="14"/u);
  assert.match(catalog, /t="inlineStr"/u);
  assert.match(catalog, /=HYPERLINK/u);
  assert.doesNotMatch(catalog, /<f>HYPERLINK/u);
  assert.doesNotMatch(decode("xl/worksheets/sheet2.xml"), /Вигляд/u);
  assert.doesNotMatch([...entries.values()].map((bytes) => new TextDecoder().decode(bytes)).join("\n"), /private@example\.test|teacher@example\.test|code_hmac|token_hash/u);
  assert.match(decode("xl/worksheets/sheet1.xml"), /<f>SUM\(&apos;Залишки&apos;!/u);
  assert.match(workbook.fileName, /^Єдина бібліотека — повний експорт — 2026-08-21 /u);
  sqlite.close();
});

test("teacher-code Excel template is styled, bounded and contains no secret codes", () => {
  const workbook = codeTemplate.createTeacherCodeImportTemplate([
    { teacherUserId: "USR-T1", fullName: "Шевченко Олена" },
    { teacherUserId: "USR-T2", fullName: "Коваль Марія" },
  ], "2026-08-22T09:15:00.000Z");
  const entries = unzipStored(workbook.bytes);
  const decode = (name) => new TextDecoder().decode(entries.get(name));
  const workbookXml = decode("xl/workbook.xml");
  const sheet = decode("xl/worksheets/sheet1.xml");
  const styles = decode("xl/styles.xml");
  assert.match(workbookXml, /name="Коди вчителів"/u);
  for (const header of ["USR-ID", "Прізвище та ім’я", "Тимчасовий код"]) assert.match(sheet, new RegExp(`>${header}<`, "u"));
  assert.match(sheet, /USR-T1/u);
  assert.match(sheet, /Шевченко Олена/u);
  assert.match(sheet, /Лише для вчителів без чинного коду/u);
  assert.doesNotMatch(sheet, /23456-789AB|code_hmac|PIN-код: \d/u);
  assert.match(styles, /<name val="Times New Roman"\/>/u);
  assert.equal(workbook.rowCount, 2);
  assert.match(workbook.fileName, /^Шаблон кодів учителів — 2026-08-22\.xlsx$/u);
});

test("acquisition template and export keep the exact four-sheet contract without ISBN", () => {
  for (const workbook of [
    acquisitionExcel.createAcquisitionImportTemplate("2026-08-23T09:15:00.000Z"),
    acquisitionExcel.createAcquisitionExport([], "2026-08-23T09:15:00.000Z"),
  ]) {
    const entries = unzipStored(workbook.bytes);
    const workbookXml = new TextDecoder().decode(entries.get("xl/workbook.xml"));
    const allXml = [...entries.values()].map((bytes) => new TextDecoder().decode(bytes)).join("\n");
    assert.equal((workbookXml.match(/<sheet\s/gu) ?? []).length, 4);
    for (const sheet of ["Дозамовлення", "Художня та наукова література", "Пропозиції учнів", "Довідники"]) {
      assert.match(workbookXml, new RegExp(`name="${sheet}"`, "u"));
    }
    assert.doesNotMatch(workbookXml, /name="Стани"/u);
    assert.doesNotMatch(allXml, /ISBN/iu);
  }
});

test("protected export page and navigation expose one-click full Excel download", async () => {
  const [page, ui, route, workspace, teachers, visits] = await Promise.all([
    fs.promises.readFile(path.join(root, "app/librarian/export/page.tsx"), "utf8"),
    fs.promises.readFile(path.join(root, "app/librarian/export/excel-export-workspace.tsx"), "utf8"),
    fs.promises.readFile(path.join(root, "app/api/librarian/excel-export/route.ts"), "utf8"),
    fs.promises.readFile(path.join(root, "app/librarian/d1-workspace.tsx"), "utf8"),
    fs.promises.readFile(path.join(root, "app/librarian/teachers/teacher-management-workspace.tsx"), "utf8"),
    fs.promises.readFile(path.join(root, "app/librarian/visits/visit-admin-workspace.tsx"), "utf8"),
  ]);
  assert.match(page, /requireChatGPTUser\("\/librarian\/export"\)/u);
  assert.match(route, /authorizeLibrarianApi/u);
  assert.match(route, /private, no-store/u);
  assert.match(route, /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/u);
  assert.match(ui, /Сформувати й завантажити Excel/u);
  assert.match(ui, /Коди доступу не експортуються/u);
  for (const source of [workspace, teachers, visits]) {
    assert.match(source, /href="\/librarian\/export"/u);
    assert.match(source, /Експорт в Excel/u);
  }
});

function unzipStored(bytes) {
  const entries = new Map();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    assert.equal(method, 0);
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
