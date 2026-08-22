import {
  createExcelWorkbookBytes,
  createStoredZipArchive,
  type ExcelCell,
  type ExcelColumn,
  type ExcelSheet,
} from "./library-excel-export.ts";
import type {
  ClassExportDocument,
  ClassExportLine,
  ClassExportSnapshot,
} from "./class-excel-export-store.ts";

export type ClassExcelWorkbook = {
  bytes: Uint8Array;
  fileName: string;
  sheetCount: 2;
  rowCount: number;
};

export type ClassExcelArchive = {
  bytes: Uint8Array;
  fileName: string;
  documentCount: number;
  rowCount: number;
};

const MAX_ARCHIVE_BYTES = 48 * 1024 * 1024;

const COLUMNS: ExcelColumn[] = [
  { header: "№", width: 5, kind: "number" },
  { header: "Предмет", width: 18 },
  { header: "Назва, автор і рік", width: 46 },
  { header: "Залишилося у класу", width: 16, kind: "number" },
  { header: "Рубрика", width: 22 },
  { header: "Дата видачі", width: 13, kind: "date" },
];

export function createClassExcelWorkbook(
  document: ClassExportDocument,
  generatedAt: string,
): ClassExcelWorkbook {
  const textbooks = document.lines.filter(isTextbook);
  const methodical = document.lines.filter((line) => !isTextbook(line));
  const sheets: ExcelSheet[] = [
    classSheet("Підручники", document, textbooks, generatedAt,
      "У цього класу немає виданих підручників."),
    classSheet("Методична література, зошити", document, methodical, generatedAt,
      "У цього класу немає виданої методичної літератури або зошитів."),
  ];
  const bytes = createExcelWorkbookBytes(
    sheets,
    generatedAt,
    `Видані матеріали — ${document.className}`,
  );
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error("Excel-документ класу перевищує безпечний ліміт 48 МіБ.");
  }
  return {
    bytes,
    fileName: classWorkbookFileName(document),
    sheetCount: 2,
    rowCount: document.lines.length,
  };
}

export function createAllClassesExcelArchive(snapshot: ClassExportSnapshot): ClassExcelArchive {
  const usedNames = new Set<string>();
  let rowCount = 0;
  const entries = snapshot.classes.map((document) => {
    const workbook = createClassExcelWorkbook(document, snapshot.generatedAt);
    rowCount += workbook.rowCount;
    const name = uniqueArchiveName(workbook.fileName, usedNames);
    return { name, data: workbook.bytes };
  });
  const bytes = createStoredZipArchive(entries, snapshot.generatedAt);
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error("Архів документів класів перевищує безпечний ліміт 48 МіБ.");
  }
  return {
    bytes,
    fileName: classArchiveFileName(snapshot.generatedAt),
    documentCount: entries.length,
    rowCount,
  };
}

export function classWorkbookFileName(document: ClassExportDocument): string {
  return safeName(`${document.academicYear} — ${document.className} — видані матеріали.xlsx`);
}

export function classArchiveFileName(generatedAt: string): string {
  return `Видачі класам — ${kyivDateTime(generatedAt)}.zip`;
}

function classSheet(
  name: string,
  document: ClassExportDocument,
  lines: ClassExportLine[],
  generatedAt: string,
  emptyMessage: string,
): ExcelSheet {
  return {
    name,
    columns: COLUMNS,
    reportTitle: `${name} — ${document.className}`,
    metadata: [
      ["Клас", document.className],
      ["Кабінет", document.locationName],
      ["Куратор класу", document.teacherName],
      ["Навчальний рік", document.academicYear],
      ["Сформовано", kyivDisplayDate(generatedAt)],
    ],
    rows: lines.map((line, index) => [
      index + 1,
      line.subject,
      materialLabel(line),
      line.remainingQuantity,
      line.rubric,
      dateCell(line.issuedAt),
    ]),
    emptyMessage,
    printLandscape: true,
    printFitToHeight: 1,
    compactRows: true,
    printFooter: `Сформовано ${kyivDisplayDate(generatedAt)}`,
  };
}

function isTextbook(line: ClassExportLine): boolean {
  const source = `${line.rubric} ${line.publicationType}`.normalize("NFKC").toLocaleLowerCase("uk-UA");
  return source.includes("підруч");
}

function materialLabel(line: ClassExportLine): string {
  const details = [line.author, line.publicationYear == null ? "" : String(line.publicationYear)]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" · ");
  return details ? `${line.title} — ${details}` : line.title;
}

function dateCell(value: string): ExcelCell {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return value;
  const serial = Math.round((Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - Date.UTC(1899, 11, 30)) / 86_400_000);
  return { value: serial, kind: "date" };
}

function kyivDisplayDate(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat("uk-UA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(Number.isNaN(date.getTime()) ? new Date() : date);
}

function kyivDateTime(value: string): string {
  const date = new Date(value);
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(safe);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}-${part("minute")}`;
}

function safeName(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|]/gu, "-").replace(/\s+/gu, " ").trim();
  return cleaned.slice(0, 180) || "Документ класу.xlsx";
}

function uniqueArchiveName(value: string, used: Set<string>): string {
  const normalized = value.toLocaleLowerCase("uk-UA");
  if (!used.has(normalized)) {
    used.add(normalized);
    return value;
  }
  const stem = value.replace(/\.xlsx$/iu, "");
  let suffix = 2;
  while (used.has(`${stem} (${suffix}).xlsx`.toLocaleLowerCase("uk-UA"))) suffix += 1;
  const result = `${stem} (${suffix}).xlsx`;
  used.add(result.toLocaleLowerCase("uk-UA"));
  return result;
}
