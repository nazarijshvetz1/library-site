import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const { teacherCodeCsvCell, teacherCodesCsv } = await import(
  "../app/librarian/visits/teacher-code-csv.ts"
);

test("librarian visit page exposes protected teacher-code management", async () => {
  const [workspace, access] = await Promise.all([
    read("app/librarian/visits/visit-admin-workspace.tsx"),
    read("app/librarian/visits/teacher-access-admin.tsx"),
  ]);

  assert.match(workspace, /<TeacherAccessAdmin writesEnabled=\{writesEnabled\} \/>/u);
  assert.match(workspace, /<th>Учитель<\/th>/u);
  assert.doesNotMatch(workspace, /booking\.ownerEmail|<th>Акаунт<\/th>/u);
  assert.match(access, /\/api\/librarian\/visits\/teacher-access/u);
  assert.match(access, /teacher\.status === "active"/u);
  assert.match(access, /expectedVersion: teacher\.credential\?\.version \?\? 0/u);
  assert.match(access, /action: TeacherAccessAction/u);
  assert.match(access, /"enable" \| "disable" \| "unlock" \| "revoke_sessions"/u);
  assert.match(access, /disabled=\{!canWrite/u);
});

test("teacher codes are one-time values and never enter browser persistence", async () => {
  const [access, csv] = await Promise.all([
    read("app/librarian/visits/teacher-access-admin.tsx"),
    read("app/librarian/visits/teacher-code-csv.ts"),
  ]);

  assert.match(access, /setOneTimeCodes/u);
  assert.match(access, /Закрити й забути/u);
  assert.match(access, /Сайт не зберігає ці коди у відкритому вигляді/u);
  assert.match(access, /navigator\.clipboard\.writeText/u);
  assert.match(access, /copyTextWithFallback/u);
  assert.match(access, /document\.createElement\("textarea"\)/u);
  assert.match(access, /textarea\.setSelectionRange\(0, text\.length\)/u);
  assert.match(access, /document\.execCommand\("copy"\)/u);
  assert.match(access, /textarea\.remove\(\)/u);
  assert.match(access, /new Blob\(\["\\uFEFF", csv\]/u);
  assert.match(csv, /ПІБ,Код/u);
  assert.match(access, /type: "text\/csv;charset=utf-8"/u);
  assert.match(access, /\.csv`/u);
  assert.match(access, /document\.body\.classList\.add/u);
  assert.match(access, /window\.addEventListener\("afterprint"/u);
  assert.match(access, /window\.print\(\)/u);
  assert.doesNotMatch(access, /localStorage|sessionStorage|document\.cookie|console\./u);
  assert.doesNotMatch(access, /code.*URLSearchParams|searchParams.*code/iu);
});

test("teacher-code CSV neutralizes spreadsheet formulas and preserves normal names", () => {
  assert.equal(
    teacherCodeCsvCell('=HYPERLINK("https://evil.example","open")'),
    '"\'=HYPERLINK(""https://evil.example"",""open"")"',
  );
  assert.equal(teacherCodeCsvCell("\t@SUM(A1:A2)"), '"\'\t@SUM(A1:A2)"');
  assert.equal(teacherCodeCsvCell("Шевченко Олена"), '"Шевченко Олена"');

  const csv = teacherCodesCsv([
    { fullName: "Шевченко Олена", code: "23456-789AB" },
    { fullName: '=HYPERLINK("https://evil.example","open")', code: "CDEFG-HJKMN" },
  ]);
  assert.equal(
    csv,
    'ПІБ,Код\r\n"Шевченко Олена","23456-789AB"\r\n"\'=HYPERLINK(""https://evil.example"",""open"")","CDEFG-HJKMN"',
  );
  assert.match(csv, /"[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}"/u);
});

test("bulk issue is bounded to missing credentials and uses exact confirmation", async () => {
  const access = await read("app/librarian/visits/teacher-access-admin.tsx");

  assert.match(access, /const BULK_CONFIRMATION = "ISSUE_MISSING_ONLY"/u);
  assert.match(access, /teacher\.credential === null/u);
  assert.match(access, /\/bulk-issue/u);
  assert.match(access, /confirmation: BULK_CONFIRMATION/u);
  assert.match(access, /Існуючі коди не зміняться/u);
});

test("teacher access table has accessible controls and a mobile layout", async () => {
  const [access, css] = await Promise.all([
    read("app/librarian/visits/teacher-access-admin.tsx"),
    read("app/librarian/visits/visit-access-admin.module.css"),
  ]);

  assert.match(access, /aria-labelledby="teacher-access-title"/u);
  assert.match(access, /aria-live="polite"/u);
  assert.match(access, /<th scope="row">/u);
  assert.match(access, /aria-label=\{`Скопіювати код для/u);
  assert.match(css, /@media \(max-width: 760px\)/u);
  assert.match(css, /@media print/u);
});
