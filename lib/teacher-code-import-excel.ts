import { createExcelWorkbookBytes, type ExcelSheet } from "./library-excel-export.ts";

export type TeacherCodeTemplateRow = {
  teacherUserId: string;
  fullName: string;
};

export type TeacherCodeImportTemplate = {
  bytes: Uint8Array;
  fileName: string;
  rowCount: number;
};

export function createTeacherCodeImportTemplate(
  rows: TeacherCodeTemplateRow[],
  generatedAt = new Date().toISOString(),
): TeacherCodeImportTemplate {
  const sheet: ExcelSheet = {
    name: "Коди вчителів",
    reportTitle: "Імпорт тимчасових кодів учителів",
    metadata: [
      ["Призначення", "Лише для вчителів без чинного коду"],
      ["Формат коду", "10 символів; дозволені 2–9 та великі латинські літери без I, L, O"],
      ["Безпека", "Чинні PIN-коди не переглядаються і не змінюються"],
      ["Сформовано", kyivDisplayDate(generatedAt)],
    ],
    columns: [
      { header: "USR-ID", width: 22 },
      { header: "Прізвище та ім’я", width: 42 },
      { header: "Тимчасовий код", width: 24 },
    ],
    rows: rows.map((row) => [row.teacherUserId, row.fullName, ""]),
    emptyMessage: "Усі активні вчителі вже мають код доступу.",
    printLandscape: true,
    compactRows: true,
    printFooter: "Після імпорту безпечно видаліть файл із заповненими кодами.",
  };
  return {
    bytes: createExcelWorkbookBytes([sheet], generatedAt, "Єдина бібліотека — імпорт кодів учителів"),
    fileName: `Шаблон кодів учителів — ${kyivDate(generatedAt)}.xlsx`,
    rowCount: rows.length,
  };
}

function kyivDate(value: string): string {
  const parsed = new Date(value);
  const safe = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(safe);
}

function kyivDisplayDate(value: string): string {
  const parsed = new Date(value);
  const safe = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return new Intl.DateTimeFormat("uk-UA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(safe);
}
