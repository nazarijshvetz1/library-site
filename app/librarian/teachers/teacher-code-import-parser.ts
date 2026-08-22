"use client";

import { readExcelWorkbookSheets } from "@/app/librarian/import/excel-workbook-parser";

export const TEACHER_CODE_IMPORT_MAX_BYTES = 1024 * 1024;
export const TEACHER_CODE_IMPORT_MAX_ROWS = 100;
export const TEACHER_CODE_IMPORT_SHEET = "Коди вчителів";

const HEADERS = ["USR-ID", "Прізвище та ім’я", "Тимчасовий код"] as const;
const TEMPORARY_CODE_ALPHABET = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$/u;

export type TeacherCodeImportRow = {
  teacherUserId: string;
  fullName: string;
  code: string;
  sourceRow: number;
};

export type TeacherCodeImportPreview = {
  fileName: string;
  rows: TeacherCodeImportRow[];
};

export async function parseTeacherCodeImport(file: File): Promise<TeacherCodeImportPreview> {
  const sheets = await readExcelWorkbookSheets(file, TEACHER_CODE_IMPORT_MAX_BYTES);
  if (sheets.length !== 1 || clean(sheets[0]?.name) !== TEACHER_CODE_IMPORT_SHEET) {
    throw new Error(`Файл має містити лише один аркуш «${TEACHER_CODE_IMPORT_SHEET}».`);
  }
  const sheet = sheets[0];
  if (sheet.hasFormulas) {
    throw new Error("Формули в імпорті кодів не підтримуються. Уведіть значення як звичайний текст.");
  }
  const headerIndex = sheet.rows.findIndex((row, index) => index < 15 && exactHeader(row));
  if (headerIndex < 0) {
    throw new Error(`Не знайдено точних колонок: ${HEADERS.join(", ")}.`);
  }
  const candidateRows = sheet.rows.slice(headerIndex + 1)
    .map((row, index) => ({ values: row.map(clean), sourceRow: headerIndex + index + 2 }))
    .filter(({ values }) => values.some(Boolean));
  if (candidateRows.length > TEACHER_CODE_IMPORT_MAX_ROWS) {
    throw new Error(`Шаблон може містити не більше ${TEACHER_CODE_IMPORT_MAX_ROWS} рядків учителів.`);
  }
  for (const { values, sourceRow } of candidateRows) {
    if (values.slice(HEADERS.length).some(Boolean)) {
      throw new Error(`Рядок ${sourceRow}: у файлі є непідтримувані додаткові колонки.`);
    }
  }
  const dataRows = candidateRows.filter(({ values }) => Boolean(normalizeTemporaryCode(values[2] ?? "")));
  if (dataRows.length === 0) throw new Error("У файлі немає заповнених кодів для імпорту.");

  const rows: TeacherCodeImportRow[] = [];
  const ids = new Set<string>();
  const codes = new Set<string>();
  for (const { values, sourceRow } of dataRows) {
    const teacherUserId = values[0] ?? "";
    const fullName = normalizeName(values[1] ?? "");
    const code = normalizeTemporaryCode(values[2] ?? "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(teacherUserId)) {
      throw new Error(`Рядок ${sourceRow}: некоректний USR-ID.`);
    }
    if (fullName.length < 3 || fullName.length > 160) {
      throw new Error(`Рядок ${sourceRow}: некоректне прізвище та ім’я.`);
    }
    if (!TEMPORARY_CODE_ALPHABET.test(code)) {
      throw new Error(`Рядок ${sourceRow}: тимчасовий код має містити 10 дозволених символів без 0, 1, I, L та O.`);
    }
    if (ids.has(teacherUserId)) throw new Error(`Рядок ${sourceRow}: USR-ID повторюється у файлі.`);
    if (codes.has(code)) throw new Error(`Рядок ${sourceRow}: тимчасовий код повторюється у файлі.`);
    ids.add(teacherUserId);
    codes.add(code);
    rows.push({ teacherUserId, fullName, code, sourceRow });
  }
  return { fileName: file.name, rows };
}

export function normalizeTemporaryCode(value: string): string {
  return clean(value).toUpperCase().replace(/[\s-]+/gu, "");
}

function exactHeader(row: string[]): boolean {
  const values = row.map(clean);
  return HEADERS.every((header, index) => values[index] === header)
    && !values.slice(HEADERS.length).some(Boolean);
}

function normalizeName(value: string): string {
  return clean(value).normalize("NFKC");
}

function clean(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}
