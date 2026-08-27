import {
  createExcelWorkbookBytes,
  type ExcelCell,
  type ExcelColumn,
  type ExcelSheet,
} from "./library-excel-export.ts";
import type { ClassIssueStatement } from "./class-issue-statement-store.ts";

const COLUMNS: ExcelColumn[] = [
  { header: "№", width: 6, kind: "number" },
  { header: "Предмет", width: 22 },
  { header: "Назва", width: 48 },
  { header: "Автор", width: 30 },
  { header: "Рік", width: 10, kind: "number" },
  { header: "Кількість", width: 13, kind: "number" },
];

export function createClassIssueStatementExcel(statement: ClassIssueStatement) {
  const sheet: ExcelSheet = {
    name: "Відомість",
    columns: COLUMNS,
    reportTitle: `Акт-відомість видачі матеріалів класу — ${statement.className}`,
    metadata: [
      ["Клас", statement.className],
      ["Навчальний рік", statement.academicYearLabel],
      ...(statement.classroomName ? [["Кабінет класу", statement.classroomName] as [string, string]] : []),
      ...(statement.curatorName ? [["Класний керівник", statement.curatorName] as [string, string]] : []),
      ["Дата видачі", displayDate(statement.issuedAt)],
      ["Повернути до", statement.dueAt ? displayDate(statement.dueAt) : "Не визначено"],
    ],
    rows: statement.lines.map((line) => [
      line.position,
      line.subject || "Не вказано",
      line.title,
      line.author,
      line.publicationYear ?? "",
      line.quantityIssued,
    ] satisfies ExcelCell[]),
    emptyMessage: "У відомості немає позицій.",
    printLandscape: true,
    printFitToHeight: 0,
    compactRows: true,
    printFooter: "Єдина бібліотека · Міжнародний ліцей МАУП",
  };
  const bytes = createExcelWorkbookBytes(
    [sheet],
    statement.createdAt,
    `Акт-відомість видачі — ${statement.className}`,
  );
  return {
    bytes,
    rowCount: statement.lines.length,
    fileName: safeName(`Акт-відомість видачі — ${statement.className} — ${fileDate(statement.createdAt)}.xlsx`),
  };
}

function displayDate(value: string): string {
  const date = new Date(value.length === 10 ? `${value}T12:00:00+03:00` : value);
  return new Intl.DateTimeFormat("uk-UA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(Number.isNaN(date.getTime()) ? new Date(0) : date);
}

function fileDate(value: string): string {
  const date = new Date(value);
  const safe = Number.isNaN(date.getTime()) ? new Date(0) : date;
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(safe);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}-${part("minute")}`;
}

function safeName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/gu, "-").replace(/\s+/gu, " ").trim().slice(0, 180);
}
