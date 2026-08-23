import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { summarizeWorkbookSheets } from "../app/librarian/import/excel-workbook-parser.ts";

test("standard workbook blocks are counted and the image column is ignored", () => {
  const preview = summarizeWorkbookSheets("library.xlsx", 1024, [
    { name: "Матеріали", rows: [
      ["CAT-ID", "Вигляд", "Рубрика", "Предмет", "Тип видання", "Назва"],
      ["CAT-0001", "image", "Підручники", "Математика", "Підручник", "Алгебра"],
      ["Разом", "", "", "", "", ""],
    ] },
    { name: "Залишки", rows: [
      ["CAT-ID", "Місце зберігання", "Стан", "Кількість"],
      ["CAT-0001", "Бібліотека", "good", "2"],
    ] },
    { name: "Вчителі", rows: [["USR-ID", "Прізвище та ім’я", "Статус"], ["USR-001", "Учитель", "active"]] },
    { name: "Класи", rows: [["CY-ID", "Навчальний рік", "Назва класу", "Статус"], ["CY-2026-001", "2026/2027", "5-А", "active"]] },
    { name: "Видачі класам", rows: [["CLOAN-ID", "CY-ID", "CAT-ID", "Видано", "Повернено"], ["CLOAN-1", "CY-2026-001", "CAT-0001", "2", "0"]] },
    { name: "Видачі вчителям", rows: [["LOAN-ID", "USR-ID", "CAT-ID", "Видано", "Повернено"], ["LOAN-1", "USR-001", "CAT-0001", "1", "0"]] },
  ]);
  assert.equal(preview.materialRows, 1);
  assert.equal(preview.stockRows, 1);
  assert.equal(preview.teacherRows, 1);
  assert.equal(preview.classRows, 1);
  assert.equal(preview.classLoanRows, 1);
  assert.equal(preview.teacherLoanRows, 1);
  assert.deepEqual(preview.sheets[0].ignoredColumns, ["Вигляд"]);
  assert.equal(preview.sheets[0].columns.includes("Вигляд"), false);
  assert.equal(preview.issues.some((issue) => issue.severity === "error"), false);
});

test("legacy subject sheets are recognized without importing totals or NUSH labels", () => {
  const preview = summarizeWorkbookSheets("legacy.xlsx", 2048, [{
    name: "Математика, логіка (збірники, зошити)",
    rows: [
      ["Вигляд", "Назва підручника", "Автор", "Рік", "К-сть", "Примітки"],
      ["image", "НУШ", "", "", "", ""],
      ["image", "Збірник задач", "Автор", "2024", "20", "Бібл."],
      ["", "Разом", "", "", "20", ""],
    ],
  }]);
  assert.equal(preview.materialRows, 1);
  assert.equal(preview.issues.some((issue) => issue.message.includes("старого шаблону")), true);
  assert.equal(preview.issues.some((issue) => issue.severity === "error"), false);
});

test("protected page and shared librarian navigation expose Excel import and template", async () => {
  const [page, shell, routes, ui, parser] = await Promise.all([
    readFile(new URL("../app/librarian/import/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/librarian/_components/librarian-shell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/librarian/_components/librarian-routes.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/librarian/import/excel-import-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/librarian/import/excel-workbook-parser.ts", import.meta.url), "utf8"),
  ]);
  assert.match(page, /requireChatGPTUser\("\/librarian\/import"\)/u);
  assert.match(page, /getLibrarianAccess/u);
  assert.match(shell, /excelImportHref/u);
  assert.match(routes, /"\/librarian\/import"/u);
  assert.match(ui, /Імпорт з Excel/u);
  assert.match(ui, /library-import-template\.xlsx/u);
  assert.match(ui, /Спочатку — лише перевірка/u);
  assert.match(parser, /MAX_EXCEL_BYTES/u);
  assert.match(parser, /MAX_ARCHIVE_BYTES/u);
  assert.match(parser, /\.\.\//u);
  assert.match(parser, /DecompressionStream\("deflate-raw"\)/u);
  assert.match(parser, /while \(true\)[\s\S]*reader\.read\(\)[\s\S]*total > maxBytes/u);
});

test("teacher cards expose a preview-first bounded Excel code import", async () => {
  const [ui, parser, route, template] = await Promise.all([
    readFile(new URL("../app/librarian/teachers/teacher-code-import.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/librarian/teachers/teacher-code-import-parser.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/librarian/visits/teacher-access/import/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/teacher-code-import-excel.ts", import.meta.url), "utf8"),
  ]);
  assert.match(ui, /Імпорт тимчасових кодів/u);
  assert.match(ui, /import-template/u);
  assert.match(ui, /IMPORT_MISSING_TEACHER_CODES/u);
  assert.match(ui, /preview\.rows\.map/u);
  assert.match(ui, /const \[requestId, setRequestId\]/u);
  assert.match(ui, /body: JSON\.stringify\(\{[\s\S]*requestId,/u);
  assert.doesNotMatch(ui, /requestId:\s*crypto\.randomUUID\(\)/u);
  assert.doesNotMatch(ui, /localStorage|sessionStorage/u);
  assert.match(parser, /TEACHER_CODE_IMPORT_MAX_BYTES = 1024 \* 1024/u);
  assert.match(parser, /TEACHER_CODE_IMPORT_MAX_ROWS = 100/u);
  assert.match(parser, /sheet\.hasFormulas/u);
  assert.match(parser, /candidateRows\.filter[\s\S]*normalizeTemporaryCode/u);
  assert.match(parser, /USR-ID/u);
  assert.match(parser, /Тимчасовий код/u);
  assert.match(route, /visitTeacherCodeImportBody/u);
  assert.match(template, /Чинні PIN-коди не переглядаються і не змінюються/u);
});
