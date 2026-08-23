import { createExcelWorkbookBytes, type ExcelCell, type ExcelColumn, type ExcelSheet } from "./library-excel-export.ts";
import type { AcquisitionProjection } from "./acquisition-store.ts";

const RESTOCK_COLUMNS: ExcelColumn[] = [
  { header: "REQUEST-ID", width: 22 }, { header: "CAT-ID", width: 15 }, { header: "Назва", width: 42 },
  { header: "Автор", width: 30 }, { header: "Рік", width: 12, kind: "number" }, { header: "Кількість", width: 14, kind: "number" },
  { header: "Покликання", width: 45 }, { header: "Предмет", width: 24 }, { header: "Клас", width: 16 },
  { header: "USR-ID", width: 18 }, { header: "Учитель", width: 34 }, { header: "Примітка", width: 42 },
];
const LITERATURE_COLUMNS: ExcelColumn[] = [
  { header: "REQUEST-ID", width: 22 }, { header: "Вид літератури", width: 24 }, { header: "Назва", width: 42 },
  { header: "Автор", width: 30 }, { header: "Рік", width: 12, kind: "number" }, { header: "Кількість", width: 14, kind: "number" },
  { header: "Покликання", width: 45 }, { header: "USR-ID", width: 18 }, { header: "Учитель", width: 34 }, { header: "Примітка", width: 42 },
];
const STUDENT_COLUMNS: ExcelColumn[] = [
  { header: "REQUEST-ID", width: 22 }, { header: "Клас", width: 16 }, { header: "Прізвище та ім’я", width: 34 },
  { header: "Назва", width: 42 }, { header: "Автор", width: 30 }, { header: "Рік", width: 12, kind: "number" },
  { header: "Кількість", width: 14, kind: "number" }, { header: "Покликання", width: 45 }, { header: "Примітка", width: 42 },
];
const REFERENCE_COLUMNS: ExcelColumn[] = [
  { header: "Група", width: 28 }, { header: "Код", width: 24 }, { header: "Назва", width: 36 },
];

const REFERENCE_ROWS: ExcelCell[][] = [
  ["Вид літератури", "fiction", "Художня"], ["Вид літератури", "science", "Наукова"],
  ["Вид літератури", "popular_science", "Науково-популярна"], ["Вид літератури", "other", "Інша"],
  ["Статус", "submitted", "Нова"], ["Статус", "in_review", "На розгляді"],
  ["Статус", "clarification", "Потрібне уточнення"], ["Статус", "approved", "Погоджено"],
  ["Статус", "planned", "Заплановано"], ["Статус", "ordered", "Замовлено"],
  ["Статус", "partially_received", "Частково отримано"], ["Статус", "received", "Отримано"],
  ["Статус", "rejected", "Відхилено"], ["Статус", "cancelled", "Скасовано"],
  ["Правило", "CAT-ID", "Залиште порожнім, якщо матеріалу ще немає в каталозі"],
  ["Правило", "REQUEST-ID", "Залиште порожнім для нової заявки; наявний номер не імпортується повторно"],
];

export function createAcquisitionImportTemplate(generatedAt = new Date().toISOString()): { bytes: Uint8Array; fileName: string } {
  const sheets: ExcelSheet[] = [
    requestSheet("Дозамовлення", "Дозамовлення навчальних матеріалів", RESTOCK_COLUMNS, [["", "", "", "", "", "", "", "", "", "", "", ""]]),
    requestSheet("Художня та наукова література", "Замовлення художньої та наукової літератури", LITERATURE_COLUMNS, [["", "", "", "", "", "", "", "", "", ""]]),
    requestSheet("Пропозиції учнів", "Пропозиції книг від учнів", STUDENT_COLUMNS, [["", "", "", "", "", "", "", "", ""]]),
    {
      name: "Довідники", reportTitle: "Довідники для заповнення", compactRows: true,
      columns: REFERENCE_COLUMNS,
      rows: REFERENCE_ROWS,
    },
  ];
  return { bytes: createExcelWorkbookBytes(sheets, generatedAt, "Єдина бібліотека — комплектування фонду"), fileName: `Шаблон комплектування фонду — ${kyivStamp(generatedAt)}.xlsx` };
}

export function createAcquisitionExport(requests: AcquisitionProjection[], generatedAt = new Date().toISOString()): { bytes: Uint8Array; fileName: string; rowCount: number } {
  const teacherEducational = requests.filter((row) => row.requesterKind === "teacher" && row.category === "educational");
  const teacherLiterature = requests.filter((row) => row.requesterKind === "teacher" && row.category === "literature");
  const students = requests.filter((row) => row.requesterKind === "student");
  const sheets: ExcelSheet[] = [
    requestSheet("Дозамовлення", "Дозамовлення навчальних матеріалів", RESTOCK_COLUMNS, teacherEducational.map((row) => [row.publicNumber, row.materialId ?? "", row.title, row.author, row.publicationYear, row.requestedQuantity, row.sourceUrl, row.subject, row.targetClass, row.teacherUserId ?? "", row.requesterName, row.requesterNote])),
    requestSheet("Художня та наукова література", "Замовлення художньої та наукової літератури", LITERATURE_COLUMNS, teacherLiterature.map((row) => [row.publicNumber, literatureLabel(row.literatureKind), row.title, row.author, row.publicationYear, row.requestedQuantity, row.sourceUrl, row.teacherUserId ?? "", row.requesterName, row.requesterNote])),
    requestSheet("Пропозиції учнів", "Пропозиції книг від учнів", STUDENT_COLUMNS, students.map((row) => [row.publicNumber, row.requesterClassName, row.requesterName, row.title, row.author, row.publicationYear, row.requestedQuantity, row.sourceUrl, row.requesterNote])),
    { name: "Довідники", reportTitle: "Довідники для заповнення", compactRows: true, columns: REFERENCE_COLUMNS, rows: REFERENCE_ROWS },
  ];
  return { bytes: createExcelWorkbookBytes(sheets, generatedAt, "Єдина бібліотека — комплектування фонду"), fileName: `Комплектування фонду — ${kyivStamp(generatedAt)}.xlsx`, rowCount: requests.length };
}

function requestSheet(name: string, title: string, columns: ExcelColumn[], rows: ExcelCell[][]): ExcelSheet {
  return { name, reportTitle: title, columns, rows, compactRows: true, printLandscape: true, printFitToHeight: 0, printFooter: "Єдина бібліотека • Комплектування фонду" };
}
function literatureLabel(value: AcquisitionProjection["literatureKind"]): string {
  return ({ none: "", fiction: "Художня", science: "Наукова", popular_science: "Науково-популярна", other: "Інша" } as const)[value];
}
function kyivStamp(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(Number.isNaN(date.getTime()) ? new Date() : date).replace(":", "-");
}
