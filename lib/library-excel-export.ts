import type {
  ExportClassLoan,
  ExportMaterial,
  ExportTeacherLoan,
  LibraryExportSnapshot,
} from "./library-export-store.ts";

export type ExcelColumnKind = "text" | "number" | "date" | "datetime";
export type ExcelColumn = { header: string; width: number; kind?: ExcelColumnKind; hidden?: boolean };
type FormulaCell = { formula: string; value: number; kind?: ColumnKind };
type TypedCell = { value: string | number; kind: ColumnKind };
export type ExcelCell = string | number | null | FormulaCell | TypedCell;
export type ExcelSheet = {
  name: string;
  columns: ExcelColumn[];
  rows: ExcelCell[][];
  metadata?: Array<[label: string, value: string]>;
  reportTitle?: string;
  emptyMessage?: string;
  printLandscape?: boolean;
  printFitToHeight?: number;
  compactRows?: boolean;
  printFooter?: string;
};

type ColumnKind = ExcelColumnKind;
type Column = ExcelColumn;
type Cell = ExcelCell;
type Sheet = ExcelSheet;

export type LibraryExcelExport = {
  bytes: Uint8Array<ArrayBuffer>;
  fileName: string;
  sheetCount: number;
  rowCount: number;
};

const MAX_WORKBOOK_BYTES = 48 * 1024 * 1024;
const MAX_SUBJECT_SHEETS = 100;
const EXCEL_CELL_TEXT_LIMIT = 32_767;
const CORE_SHEET_NAMES = new Set([
  "Зведення", "Каталог", "Залишки", "За класами", "Вчителі", "Класи",
  "Видачі вчителям", "Видачі класам", "Заявки вчителів", "Предмети",
  "Довідники", "Контроль",
].map((value) => value.toLocaleLowerCase("uk-UA")));

export function createLibraryExcelExport(snapshot: LibraryExportSnapshot): LibraryExcelExport {
  const sheets = buildSheets(snapshot);
  const entries = workbookEntries(sheets, snapshot.generatedAt);
  const bytes = zipStore(entries, snapshot.generatedAt);
  if (bytes.byteLength > MAX_WORKBOOK_BYTES) {
    throw new Error("Excel-файл перевищує безпечний ліміт 48 МіБ.");
  }
  return {
    bytes,
    fileName: exportFileName(snapshot.generatedAt),
    sheetCount: sheets.length,
    rowCount: sheets.reduce((total, sheet) => total + sheet.rows.length, 0),
  };
}

export function createExcelWorkbookBytes(
  sheets: ExcelSheet[],
  generatedAt: string,
  workbookTitle = "Єдина бібліотека — повний експорт",
): Uint8Array<ArrayBuffer> {
  return zipStore(workbookEntries(sheets, generatedAt, workbookTitle), generatedAt);
}

export function createStoredZipArchive(
  entries: Array<{ name: string; data: Uint8Array }>,
  generatedAt: string,
): Uint8Array<ArrayBuffer> {
  return zipStore(entries, generatedAt);
}

export function exportFileName(isoDate: string): string {
  const parsed = new Date(isoDate);
  const safe = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(safe);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "00";
  return `Єдина бібліотека — повний експорт — ${part("year")}-${part("month")}-${part("day")} ${part("hour")}-${part("minute")}.xlsx`;
}

function buildSheets(snapshot: LibraryExportSnapshot): Sheet[] {
  const materials = snapshot.materials;
  const materialRows = materials.map((material, index) => catalogRow(material, index + 2));
  const catalogColumns = catalogSheetColumns();
  const physicalTotal = sum(snapshot.holdings, (row) => row.quantity);
  const reservedTotal = sum(snapshot.holdings, (row) => row.reservedQuantity);
  const availableTotal = sum(snapshot.holdings, (row) => row.availableQuantity);
  const teacherOutstanding = sum(snapshot.teacherLoans, (row) => row.remainingQuantity);
  const classOutstanding = sum(snapshot.classLoans, (row) => row.remainingQuantity);
  const subjects = [...new Set(materials.map((row) => row.subject.trim() || "Без предмета"))]
    .sort((a, b) => a.localeCompare(b, "uk-UA"));
  if (subjects.length > MAX_SUBJECT_SHEETS) {
    throw new Error("У базі забагато предметів для безпечного створення окремих аркушів.");
  }

  const usedSheetNames = new Set(CORE_SHEET_NAMES);
  const subjectSheets = subjects.map((subject) => ({
    subject,
    sheetName: uniqueSheetName(subject, usedSheetNames),
  }));

  const holdingsColumns: Column[] = [
    { header: "CAT-ID", width: 15 }, { header: "Назва", width: 46 },
    { header: "Предмет", width: 26 }, { header: "LOC-ID", width: 14 },
    { header: "Місце зберігання", width: 30 }, { header: "Стан", width: 18 },
    { header: "Фізична кількість", width: 19, kind: "number" },
    { header: "Зарезервовано", width: 18, kind: "number" },
    { header: "Доступно", width: 15, kind: "number" },
    { header: "Оновлено", width: 21, kind: "datetime" },
  ];
  const holdingsRows = snapshot.holdings.map((row, index) => [
    row.materialId, row.title, row.subject, row.locationId, row.locationName,
    conditionLabel(row.condition), row.quantity, row.reservedQuantity,
    formula(`G${index + 2}-H${index + 2}`, row.availableQuantity), datetime(row.updatedAt),
  ]);

  const teacherLoanColumns = teacherLoanSheetColumns();
  const teacherLoanRows = snapshot.teacherLoans.map((row, index) => teacherLoanRow(row, index + 2));
  const classLoanColumns = classLoanSheetColumns();
  const classLoanRows = snapshot.classLoans.map((row, index) => classLoanRow(row, index + 2));
  const requestRows = snapshot.materialRequests.map((row) => [
    row.requestId, row.itemId, row.teacherUserId, row.teacherName, requestStatusLabel(row.status), row.status,
    datetime(row.submittedAt), datetime(row.readyAt), datetime(row.completedAt), datetime(row.dueAt),
    row.pickupLocation, row.teacherNotes, row.librarianNote, row.rejectionReason, row.resultingLoanId,
    row.materialId, row.title, row.author, row.requestedQuantity,
    row.approvedQuantity ?? "", row.fulfilledQuantity, row.activeReservedQuantity,
  ]);

  const totalsByMaterial = exportControl(snapshot);
  const summaryRows: Cell[][] = [
    ["Сформовано", datetime(snapshot.generatedAt)],
    ["Матеріалів", formula(`COUNTA('Каталог'!$A$2:$A$${Math.max(2, materialRows.length + 1)})`, materials.length)],
    ["Предметів", formula(`COUNTA('Предмети'!$A$2:$A$${Math.max(2, subjectSheets.length + 1)})`, subjects.length)],
    ["Фізично на місцях", formula(`SUM('Залишки'!$G$2:$G$${Math.max(2, holdingsRows.length + 1)})`, physicalTotal)],
    ["Активно зарезервовано", formula(`SUM('Залишки'!$H$2:$H$${Math.max(2, holdingsRows.length + 1)})`, reservedTotal)],
    ["Доступно зараз", formula(`SUM('Залишки'!$I$2:$I$${Math.max(2, holdingsRows.length + 1)})`, availableTotal)],
    ["На руках у вчителів", formula(`SUM('Видачі вчителям'!$P$2:$P$${Math.max(2, teacherLoanRows.length + 1)})`, teacherOutstanding)],
    ["На руках у класів", formula(`SUM('Видачі класам'!$R$2:$R$${Math.max(2, classLoanRows.length + 1)})`, classOutstanding)],
    ["Загальний фонд", formula("B5+B8+B9", physicalTotal + teacherOutstanding + classOutstanding)],
    ["Заявок учителів (позицій)", formula(`COUNTA('Заявки вчителів'!$A$2:$A$${Math.max(2, requestRows.length + 1)})`, requestRows.length)],
  ];

  const sheets: Sheet[] = [
    {
      name: "Зведення",
      columns: [{ header: "Показник", width: 34 }, { header: "Значення", width: 24, kind: "number" }],
      rows: summaryRows,
    },
    { name: "Каталог", columns: catalogColumns, rows: materialRows },
    { name: "Залишки", columns: holdingsColumns, rows: holdingsRows },
    { name: "За класами", columns: classViewColumns(), rows: classViewRows(materials) },
    {
      name: "Вчителі",
      columns: [
        { header: "USR-ID", width: 15 }, { header: "Прізвище та ім’я", width: 34 },
        { header: "Статус", width: 16 }, { header: "Статус (код)", width: 15, hidden: true },
        { header: "Предмет / посада", width: 26 }, { header: "Основний кабінет", width: 28 },
        { header: "Мобільний номер", width: 28 }, { header: "Примітка бібліотекаря", width: 42 },
        { header: "Оновлено", width: 21, kind: "datetime" },
      ],
      rows: snapshot.teachers.map((row) => [
        row.id, row.fullName, directoryStatusLabel(row.status), row.status, row.subjectPosition,
        row.primaryLocation, row.serviceContact, row.librarianNote, datetime(row.updatedAt),
      ]),
    },
    {
      name: "Класи",
      columns: [
        { header: "CY-ID", width: 18 }, { header: "Навчальний рік", width: 18 },
        { header: "Назва класу", width: 18 }, { header: "Клас", width: 12, kind: "number" },
        { header: "Код", width: 12 }, { header: "Класний керівник", width: 34 },
        { header: "Кабінет", width: 28 }, { header: "Початок", width: 15, kind: "date" },
        { header: "Завершення", width: 15, kind: "date" }, { header: "Статус", width: 16 },
        { header: "Статус (код)", width: 15, hidden: true }, { header: "Примітка", width: 42 },
      ],
      rows: snapshot.classes.map((row) => [
        row.id, row.academicYear, row.className, row.grade, row.code, row.teacherName,
        row.locationName, date(row.startDate), date(row.endDate), classStatusLabel(row.status), row.status, row.notes,
      ]),
    },
    { name: "Видачі вчителям", columns: teacherLoanColumns, rows: teacherLoanRows },
    { name: "Видачі класам", columns: classLoanColumns, rows: classLoanRows },
    {
      name: "Заявки вчителів",
      columns: [
        { header: "REQUEST-ID", width: 39 }, { header: "ITEM-ID", width: 39, hidden: true },
        { header: "USR-ID", width: 15 }, { header: "Учитель", width: 34 },
        { header: "Статус", width: 20 }, { header: "Статус (код)", width: 18, hidden: true },
        { header: "Подано", width: 21, kind: "datetime" }, { header: "Підготовлено", width: 21, kind: "datetime" },
        { header: "Завершено", width: 21, kind: "datetime" }, { header: "Повернути до", width: 21, kind: "datetime" },
        { header: "Місце отримання", width: 28 }, { header: "Примітка вчителя", width: 36 },
        { header: "Примітка бібліотекаря", width: 36 }, { header: "Причина відмови", width: 34 },
        { header: "LOAN-ID", width: 39, hidden: true }, { header: "CAT-ID", width: 15 },
        { header: "Назва", width: 46 }, { header: "Автор", width: 34 },
        { header: "Запитано", width: 14, kind: "number" }, { header: "Погоджено", width: 15, kind: "number" },
        { header: "Видано", width: 13, kind: "number" }, { header: "У резерві", width: 15, kind: "number" },
      ],
      rows: requestRows,
    },
    {
      name: "Предмети",
      columns: [
        { header: "Предмет", width: 34 }, { header: "Аркуш", width: 31 },
        { header: "Матеріалів", width: 16, kind: "number" },
      ],
      rows: subjectSheets.map(({ subject, sheetName }) => [
        subject, sheetName, materials.filter((row) => (row.subject.trim() || "Без предмета") === subject).length,
      ]),
    },
    { name: "Довідники", columns: referenceColumns(), rows: referenceRows() },
    {
      name: "Контроль",
      columns: [{ header: "Перевірка", width: 48 }, { header: "Кількість розбіжностей", width: 26, kind: "number" }, { header: "Результат", width: 24 }],
      rows: [
        ["Матеріали без предмета", totalsByMaterial.withoutSubject, totalsByMaterial.withoutSubject ? "Потребує уваги" : "Добре"],
        ["Від’ємна доступність у місці", totalsByMaterial.negativeAvailability, totalsByMaterial.negativeAvailability ? "Помилка" : "Добре"],
        ["Розбіжність загального фонду", totalsByMaterial.totalMismatch, totalsByMaterial.totalMismatch ? "Помилка" : "Добре"],
        ["Розбіжність виданої кількості", totalsByMaterial.loanMismatch, totalsByMaterial.loanMismatch ? "Помилка" : "Добре"],
        ["Розбіжність резервів", totalsByMaterial.reservationMismatch, totalsByMaterial.reservationMismatch ? "Помилка" : "Добре"],
      ],
    },
  ];

  for (const { subject, sheetName } of subjectSheets) {
    const rows = materials
      .filter((row) => (row.subject.trim() || "Без предмета") === subject)
      .map((row, index) => catalogRow(row, index + 2));
    sheets.push({ name: sheetName, columns: catalogColumns, rows });
  }
  return sheets;
}

function catalogSheetColumns(): Column[] {
  return [
    { header: "CAT-ID", width: 15 }, { header: "Рубрика", width: 32 },
    { header: "Тип видання", width: 28 }, { header: "Предмет", width: 28 },
    { header: "Клас від", width: 12, kind: "number" }, { header: "Клас до", width: 12, kind: "number" },
    { header: "Назва", width: 48 }, { header: "Автор", width: 36 },
    { header: "Рік", width: 11, kind: "number" }, { header: "ISBN", width: 20 },
    { header: "Видавництво", width: 28 }, { header: "Електронне посилання", width: 44 },
    { header: "Примітка", width: 42 }, { header: "Статус", width: 16 },
    { header: "Загальний фонд", width: 18, kind: "number" }, { header: "У бібліотеці", width: 16, kind: "number" },
    { header: "В інших кабінетах", width: 20, kind: "number" }, { header: "Видано", width: 13, kind: "number" },
    { header: "Зарезервовано", width: 18, kind: "number" }, { header: "Доступно", width: 15, kind: "number" },
  ];
}

function catalogRow(row: ExportMaterial, excelRow: number): Cell[] {
  return [
    row.id, row.rubric, row.publicationType, row.subject, row.classFrom ?? "", row.classTo ?? "",
    row.title, row.author, row.publicationYear ?? "", row.isbn, row.publisher, row.electronicUrl,
    row.notes, materialStatusLabel(row.status), row.totalQuantity, row.libraryQuantity,
    row.otherLocationQuantity, row.loanedQuantity, row.reservedQuantity,
    formula(`O${excelRow}-R${excelRow}-S${excelRow}`, row.totalQuantity - row.loanedQuantity - row.reservedQuantity),
  ];
}

function classViewColumns(): Column[] {
  return [
    { header: "Клас", width: 15 }, { header: "CAT-ID", width: 15 },
    { header: "Предмет", width: 28 }, { header: "Тип видання", width: 28 },
    { header: "Назва", width: 48 }, { header: "Автор", width: 36 },
    { header: "Рік", width: 11, kind: "number" }, { header: "Загальний фонд", width: 18, kind: "number" },
    { header: "Доступно", width: 15, kind: "number" },
  ];
}

function classViewRows(materials: ExportMaterial[]): Cell[][] {
  const rows: Cell[][] = [];
  for (const material of materials) {
    const grades = material.classFrom && material.classTo
      ? Array.from({ length: material.classTo - material.classFrom + 1 }, (_, index) => material.classFrom! + index)
      : [null];
    for (const grade of grades) {
      rows.push([
        grade ? `${grade} клас` : "Без класу", material.id, material.subject, material.publicationType,
        material.title, material.author, material.publicationYear ?? "", material.totalQuantity,
        material.totalQuantity - material.loanedQuantity - material.reservedQuantity,
      ]);
    }
  }
  return rows.sort((a, b) => String(a[0]).localeCompare(String(b[0]), "uk-UA", { numeric: true })
    || String(a[2]).localeCompare(String(b[2]), "uk-UA") || String(a[4]).localeCompare(String(b[4]), "uk-UA"));
}

function teacherLoanSheetColumns(): Column[] {
  return [
    { header: "LOAN-ID", width: 39 }, { header: "ITEM-ID", width: 39, hidden: true },
    { header: "USR-ID", width: 15 }, { header: "Учитель", width: 34 },
    { header: "Статус", width: 16 }, { header: "Видано", width: 21, kind: "datetime" },
    { header: "Повернути до", width: 21, kind: "datetime" }, { header: "Закрито", width: 21, kind: "datetime" },
    { header: "CAT-ID", width: 15 }, { header: "Назва", width: 46 }, { header: "Предмет", width: 28 },
    { header: "Місце видачі", width: 28 }, { header: "Стан", width: 18 },
    { header: "Видано", width: 13, kind: "number" }, { header: "Повернено", width: 15, kind: "number" },
    { header: "Залишилося на руках", width: 22, kind: "number" },
    { header: "Примітка до видачі", width: 38 }, { header: "Примітка до позиції", width: 38 },
  ];
}

function teacherLoanRow(row: ExportTeacherLoan, excelRow: number): Cell[] {
  return [
    row.loanId, row.itemId, row.teacherUserId, row.teacherName, loanStatusLabel(row.status),
    datetime(row.issuedAt), datetime(row.dueAt), datetime(row.closedAt), row.materialId,
    row.title, row.subject, row.sourceLocation, conditionLabel(row.condition), row.quantityIssued,
    row.quantityReturned, formula(`N${excelRow}-O${excelRow}`, row.remainingQuantity), row.loanNotes, row.itemNotes,
  ];
}

function classLoanSheetColumns(): Column[] {
  return [
    { header: "CLOAN-ID", width: 39 }, { header: "ITEM-ID", width: 39, hidden: true },
    { header: "CY-ID", width: 18 }, { header: "Навчальний рік", width: 18 },
    { header: "Клас", width: 18 }, { header: "Відповідальний учитель", width: 34 },
    { header: "Статус", width: 16 }, { header: "Видано", width: 21, kind: "datetime" },
    { header: "Повернути до", width: 21, kind: "datetime" }, { header: "Закрито", width: 21, kind: "datetime" },
    { header: "CAT-ID", width: 15 }, { header: "Назва", width: 46 }, { header: "Предмет", width: 28 },
    { header: "Місце видачі", width: 28 }, { header: "Стан", width: 18 },
    { header: "Видано", width: 13, kind: "number" }, { header: "Повернено", width: 15, kind: "number" },
    { header: "Залишилося у класу", width: 22, kind: "number" },
    { header: "Примітка до видачі", width: 38 }, { header: "Примітка до позиції", width: 38 },
  ];
}

function classLoanRow(row: ExportClassLoan, excelRow: number): Cell[] {
  return [
    row.classLoanId, row.itemId, row.classYearId, row.academicYear, row.className,
    row.responsibleTeacher, loanStatusLabel(row.status), datetime(row.issuedAt), datetime(row.dueAt),
    datetime(row.closedAt), row.materialId, row.title, row.subject, row.sourceLocation,
    conditionLabel(row.condition), row.quantityIssued, row.quantityReturned,
    formula(`P${excelRow}-Q${excelRow}`, row.remainingQuantity), row.loanNotes, row.itemNotes,
  ];
}

function referenceColumns(): Column[] {
  return [{ header: "Група", width: 26 }, { header: "Код", width: 24 }, { header: "Назва", width: 34 }];
}

function referenceRows(): Cell[][] {
  return [
    ["Стан примірника", "good", "Добрий стан"], ["Стан примірника", "worn", "Зношений"],
    ["Стан примірника", "damaged", "Пошкоджений"], ["Стан примірника", "unspecified", "Не вказано"],
    ["Видача", "open", "Відкрито"], ["Видача", "closed", "Закрито"], ["Видача", "cancelled", "Скасовано"],
    ["Матеріал", "active", "Активний"], ["Матеріал", "archived", "Архівний"],
    ["Клас", "planned", "Запланований"], ["Клас", "active", "Активний"], ["Клас", "closed", "Закритий"],
  ];
}

function exportControl(snapshot: LibraryExportSnapshot) {
  const physical = totalsByMaterial(snapshot.holdings, (row) => row.materialId, (row) => row.quantity);
  const reservations = totalsByMaterial(snapshot.holdings, (row) => row.materialId, (row) => row.reservedQuantity);
  const teacherLoans = totalsByMaterial(snapshot.teacherLoans, (row) => row.materialId, (row) => row.remainingQuantity);
  const classLoans = totalsByMaterial(snapshot.classLoans, (row) => row.materialId, (row) => row.remainingQuantity);
  let totalMismatch = 0;
  let loanMismatch = 0;
  let reservationMismatch = 0;
  for (const material of snapshot.materials) {
    const loaned = (teacherLoans.get(material.id) ?? 0) + (classLoans.get(material.id) ?? 0);
    if ((physical.get(material.id) ?? 0) + loaned !== material.totalQuantity) totalMismatch += 1;
    if (loaned !== material.loanedQuantity) loanMismatch += 1;
    if ((reservations.get(material.id) ?? 0) !== material.reservedQuantity) reservationMismatch += 1;
  }
  return {
    withoutSubject: snapshot.materials.filter((row) => !row.subject.trim()).length,
    negativeAvailability: snapshot.holdings.filter((row) => row.availableQuantity < 0).length,
    totalMismatch, loanMismatch, reservationMismatch,
  };
}

function totalsByMaterial<T>(rows: T[], key: (row: T) => string, value: (row: T) => number): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(key(row), (totals.get(key(row)) ?? 0) + value(row));
  return totals;
}

function sum<T>(rows: T[], value: (row: T) => number): number {
  return rows.reduce((total, row) => total + value(row), 0);
}

function date(value: string): Cell {
  const parsed = excelDate(value);
  return parsed == null ? "" : { value: parsed, kind: "date" };
}

function datetime(value: string): Cell {
  const parsed = excelDate(value);
  return parsed == null ? "" : { value: parsed, kind: "datetime" };
}

function excelDate(value: string): number | null {
  if (!value) return null;
  const parsed = /^\d{4}-\d{2}-\d{2}$/u.test(value)
    ? new Date(`${value}T00:00:00.000Z`)
    : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.getTime() / 86_400_000 + 25_569;
}

function formula(formulaText: string, value: number): FormulaCell {
  return { formula: formulaText, value, kind: "number" };
}

function uniqueSheetName(raw: string, used: Set<string>): string {
  const cleaned = cleanXmlText(raw).replace(/[\\/?*:[\]]/gu, " ").replace(/\s+/gu, " ").trim() || "Без предмета";
  let candidate = cleaned.slice(0, 31);
  let suffix = 2;
  while (used.has(candidate.toLocaleLowerCase("uk-UA"))) {
    const addition = ` (${suffix})`;
    candidate = `${cleaned.slice(0, 31 - addition.length)}${addition}`;
    suffix += 1;
  }
  used.add(candidate.toLocaleLowerCase("uk-UA"));
  return candidate;
}

function materialStatusLabel(value: string) { return value === "archived" ? "Архівний" : "Активний"; }
function directoryStatusLabel(value: string) { return value === "inactive" ? "Закритий" : "Активний"; }
function classStatusLabel(value: string) { return ({ planned: "Запланований", active: "Активний", closed: "Закритий" } as Record<string, string>)[value] ?? value; }
function loanStatusLabel(value: string) { return ({ open: "Відкрито", closed: "Закрито", cancelled: "Скасовано" } as Record<string, string>)[value] ?? value; }
function requestStatusLabel(value: string) {
  return ({ submitted: "Нова", in_review: "На розгляді", ready: "Підготовлено", partially_ready: "Підготовлено частково", completed: "Видано", rejected: "Відхилено", cancelled: "Скасовано" } as Record<string, string>)[value] ?? value;
}
function conditionLabel(value: string) { return ({ good: "Добрий стан", worn: "Зношений", damaged: "Пошкоджений", unspecified: "Не вказано" } as Record<string, string>)[value] ?? value; }

function workbookEntries(
  sheets: Sheet[],
  generatedAt: string,
  workbookTitle = "Єдина бібліотека — повний експорт",
): Array<{ name: string; data: Uint8Array }> {
  const encoder = new TextEncoder();
  const xml = (name: string, value: string) => ({ name, data: encoder.encode(value) });
  const entries = [
    xml("[Content_Types].xml", contentTypesXml(sheets.length)),
    xml("_rels/.rels", rootRelationshipsXml()),
    xml("docProps/app.xml", appPropertiesXml(sheets)),
    xml("docProps/core.xml", corePropertiesXml(generatedAt, workbookTitle)),
    xml("xl/workbook.xml", workbookXml(sheets)),
    xml("xl/_rels/workbook.xml.rels", workbookRelationshipsXml(sheets.length)),
    xml("xl/styles.xml", stylesXml()),
  ];
  sheets.forEach((sheet, index) => entries.push(xml(`xl/worksheets/sheet${index + 1}.xml`, worksheetXml(sheet))));
  return entries;
}

type WorksheetLayout = {
  bodyStartRow: number;
  compactMetadataRows: Array<Array<[label: string, value: string]>>;
  hasEmptyMessage: boolean;
  headerRow: number;
  lastColumn: string;
  lastRow: number;
};

function worksheetLayout(sheet: Sheet): WorksheetLayout {
  const metadata = sheet.metadata ?? [];
  const compactMetadataRows: Array<Array<[label: string, value: string]>> = [];
  if (sheet.reportTitle && metadata.length > 0) {
    compactMetadataRows.push(metadata.slice(0, 3));
    for (let index = 3; index < metadata.length; index += 2) {
      compactMetadataRows.push(metadata.slice(index, index + 2));
    }
  }
  const headerRow = sheet.reportTitle
    ? compactMetadataRows.length + 2
    : metadata.length > 0 ? metadata.length + 2 : 1;
  const bodyStartRow = headerRow + 1;
  const hasEmptyMessage = sheet.rows.length === 0 && Boolean(sheet.emptyMessage);
  const lastRow = Math.max(
    headerRow,
    sheet.rows.length + headerRow,
    hasEmptyMessage ? bodyStartRow : headerRow,
  );
  return {
    bodyStartRow,
    compactMetadataRows,
    hasEmptyMessage,
    headerRow,
    lastColumn: columnName(sheet.columns.length),
    lastRow,
  };
}

function worksheetXml(sheet: Sheet): string {
  const metadata = sheet.metadata ?? [];
  const layout = worksheetLayout(sheet);
  const {
    bodyStartRow,
    compactMetadataRows,
    hasEmptyMessage,
    headerRow,
    lastColumn,
    lastRow,
  } = layout;
  const cols = sheet.columns.map((column, index) => `<col min="${index + 1}" max="${index + 1}" width="${column.width}" customWidth="1"${column.hidden ? ' hidden="1"' : ""}/>`).join("");
  const titleRow = sheet.reportTitle
    ? `<row r="1" ht="32" customHeight="1">${styledTextCellXml(1, 1, sheet.reportTitle, 8)}</row>`
    : "";
  const metadataRows = sheet.reportTitle
    ? compactMetadataRows.map((items, rowIndex) => {
      const row = rowIndex + 2;
      const cells = items.map(([label, value], itemIndex) => {
        const startColumn = Math.floor((itemIndex * sheet.columns.length) / items.length) + 1;
        return styledTextCellXml(startColumn, row, `${label}: ${value}`, 9);
      }).join("");
      return `<row r="${row}" ht="25" customHeight="1">${cells}</row>`;
    }).join("")
    : metadata.map(([label, value], index) => {
      const row = index + 1;
      return `<row r="${row}" ht="25" customHeight="1">${styledTextCellXml(1, row, label, 6)}${styledTextCellXml(2, row, value, 7)}</row>`;
    }).join("");
  const header = `<row r="${headerRow}" ht="30" customHeight="1">${sheet.columns.map((column, index) => cellXml(index + 1, headerRow, column.header, "text", true)).join("")}</row>`;
  const body = sheet.rows.map((row, rowIndex) => {
    const excelRow = rowIndex + bodyStartRow;
    const cells = sheet.columns.map((column, columnIndex) => cellXml(columnIndex + 1, excelRow, row[columnIndex] ?? "", column.kind ?? "text", false)).join("");
    const rowHeight = sheet.compactRows ? compactRowHeight(row, sheet.columns) : 32;
    return `<row r="${excelRow}" ht="${rowHeight}" customHeight="1">${cells}</row>`;
  }).join("");
  const emptyRow = hasEmptyMessage
    ? `<row r="${bodyStartRow}" ht="${sheet.compactRows ? 24 : 32}" customHeight="1">${styledTextCellXml(1, bodyStartRow, sheet.emptyMessage ?? "", 7)}</row>`
    : "";
  const reportMerges = sheet.reportTitle
    ? [
      `A1:${lastColumn}1`,
      ...compactMetadataRows.flatMap((items, rowIndex) => items.map((_, itemIndex) => {
        const startColumn = Math.floor((itemIndex * sheet.columns.length) / items.length) + 1;
        const endColumn = Math.floor(((itemIndex + 1) * sheet.columns.length) / items.length);
        return `${columnName(startColumn)}${rowIndex + 2}:${columnName(endColumn)}${rowIndex + 2}`;
      })),
    ]
    : [];
  const mergeRanges = [
    ...reportMerges,
    ...(!sheet.reportTitle ? metadata.map((_, index) => `B${index + 1}:${lastColumn}${index + 1}`) : []),
    ...(hasEmptyMessage ? [`A${bodyStartRow}:${lastColumn}${bodyStartRow}`] : []),
  ];
  const merges = mergeRanges.length > 0
    ? `<mergeCells count="${mergeRanges.length}">${mergeRanges.map((range) => `<mergeCell ref="${range}"/>`).join("")}</mergeCells>`
    : "";
  const filterEnd = Math.max(headerRow, sheet.rows.length + headerRow);
  const printSettings = sheet.printLandscape
    ? `<printOptions horizontalCentered="1"/><pageMargins left="0.25" right="0.25" top="0.25" bottom="0.25" header="0.15" footer="0.15"/><pageSetup paperSize="9" orientation="landscape" pageOrder="overThenDown" fitToWidth="1" fitToHeight="${sheet.printFitToHeight ?? 0}"/>${printFooterXml(sheet.printFooter)}`
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  ${sheet.printLandscape ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : ""}
  <dimension ref="A1:${lastColumn}${lastRow}"/>
  <sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="${headerRow}" topLeftCell="A${bodyStartRow}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${bodyStartRow}" sqref="A${bodyStartRow}"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="${sheet.compactRows ? 22 : 24}"/>
  <cols>${cols}</cols>
  <sheetData>${titleRow}${metadataRows}${header}${body}${emptyRow}</sheetData>
  <autoFilter ref="A${headerRow}:${lastColumn}${filterEnd}"/>
  ${merges}
  ${printSettings}
</worksheet>`;
}

function compactRowHeight(row: Cell[], columns: Column[]): number {
  let lineCount = 1;
  for (let index = 0; index < columns.length; index += 1) {
    const text = cellDisplayText(row[index] ?? "");
    if (!text) continue;
    lineCount = Math.max(lineCount, Math.ceil(text.length / Math.max(columns[index].width, 1)));
  }
  return Math.min(54, 22 + Math.max(0, lineCount - 1) * 16);
}

function cellDisplayText(cell: Cell): string {
  if (isFormula(cell) || isTypedCell(cell)) return String(cell.value ?? "");
  return cell == null ? "" : String(cell);
}

function printFooterXml(value?: string): string {
  const left = value ? `&amp;L${escapeXml(value)}` : "";
  return `<headerFooter><oddFooter>${left}&amp;RСторінка &amp;P з &amp;N</oddFooter></headerFooter>`;
}

function styledTextCellXml(column: number, row: number, value: string, style: number): string {
  const safe = cleanXmlText(value);
  return `<c r="${columnName(column)}${row}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(safe)}</t></is></c>`;
}

function cellXml(column: number, row: number, cell: Cell, fallbackKind: ColumnKind, header: boolean): string {
  const reference = `${columnName(column)}${row}`;
  if (isFormula(cell)) {
    return `<c r="${reference}" s="${styleIndex(cell.kind ?? fallbackKind, false)}"><f>${escapeXml(cell.formula)}</f><v>${finiteNumber(cell.value)}</v></c>`;
  }
  const kind = isTypedCell(cell) ? cell.kind : fallbackKind;
  const value = isTypedCell(cell) ? cell.value : cell;
  const style = styleIndex(kind, header);
  if (typeof value === "number") return `<c r="${reference}" s="${style}"><v>${finiteNumber(value)}</v></c>`;
  const safe = cleanXmlText(value == null ? "" : String(value));
  return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(safe)}</t></is></c>`;
}

function styleIndex(kind: ColumnKind, header: boolean): number {
  if (header) return 1;
  if (kind === "number") return 3;
  if (kind === "date") return 4;
  if (kind === "datetime") return 5;
  return 2;
}

function isFormula(value: Cell): value is FormulaCell {
  return typeof value === "object" && value !== null && "formula" in value;
}

function isTypedCell(value: Cell): value is TypedCell {
  return typeof value === "object" && value !== null && "value" in value && "kind" in value && !("formula" in value);
}

function finiteNumber(value: number): string { return Number.isFinite(value) ? String(value) : "0"; }
function cleanXmlText(value: string): string {
  let cleaned = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    cleaned += code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) ? " " : character;
    if (cleaned.length >= EXCEL_CELL_TEXT_LIMIT) break;
  }
  return cleaned.slice(0, EXCEL_CELL_TEXT_LIMIT);
}
function escapeXml(value: string): string { return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&apos;"); }

function columnName(index: number): string {
  let value = index;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result || "A";
}

function contentTypesXml(sheetCount: number): string {
  const sheets = Array.from({ length: sheetCount }, (_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${sheets}</Types>`;
}

function rootRelationshipsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
}

function workbookXml(sheets: Sheet[]): string {
  const rows = sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("");
  const definedNames = sheets.flatMap((sheet, index) => {
    if (!sheet.printLandscape) return [];
    const layout = worksheetLayout(sheet);
    const sheetName = `'${sheet.name.replace(/'/gu, "''")}'`;
    return [
      `<definedName name="_xlnm.Print_Area" localSheetId="${index}">${escapeXml(`${sheetName}!$A$1:$${layout.lastColumn}$${layout.lastRow}`)}</definedName>`,
      `<definedName name="_xlnm.Print_Titles" localSheetId="${index}">${escapeXml(`${sheetName}!$1:$${layout.headerRow}`)}</definedName>`,
    ];
  }).join("");
  const definitions = definedNames ? `<definedNames>${definedNames}</definedNames>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${rows}</sheets>${definitions}<calcPr calcId="191029" calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`;
}

function workbookRelationshipsXml(sheetCount: number): string {
  const sheets = Array.from({ length: sheetCount }, (_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets}<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}

function corePropertiesXml(generatedAt: string, title: string): string {
  const created = Number.isNaN(new Date(generatedAt).getTime()) ? new Date().toISOString() : new Date(generatedAt).toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(title)}</dc:title><dc:creator>Єдина бібліотека</dc:creator><cp:lastModifiedBy>Єдина бібліотека</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${escapeXml(created)}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${escapeXml(created)}</dcterms:modified></cp:coreProperties>`;
}

function appPropertiesXml(sheets: Sheet[]): string {
  const names = sheets.map((sheet) => `<vt:lpstr>${escapeXml(sheet.name)}</vt:lpstr>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Єдина бібліотека</Application><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Аркуші</vt:lpstr></vt:variant><vt:variant><vt:i4>${sheets.length}</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="${sheets.length}" baseType="lpstr">${names}</vt:vector></TitlesOfParts></Properties>`;
}

function stylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm"/></numFmts>
  <fonts count="4"><font><sz val="14"/><name val="Times New Roman"/><family val="1"/><charset val="204"/></font><font><b/><sz val="14"/><color rgb="FFFFFFFF"/><name val="Times New Roman"/><family val="1"/><charset val="204"/></font><font><b/><sz val="14"/><color rgb="FF163420"/><name val="Times New Roman"/><family val="1"/><charset val="204"/></font><font><b/><sz val="18"/><color rgb="FFFFFFFF"/><name val="Times New Roman"/><family val="1"/><charset val="204"/></font></fonts>
  <fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF215732"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEAF2E7"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD7E0D5"/></left><right style="thin"><color rgb="FFD7E0D5"/></right><top style="thin"><color rgb="FFD7E0D5"/></top><bottom style="thin"><color rgb="FFD7E0D5"/></bottom><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="10">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function zipStore(entries: Array<{ name: string; data: Uint8Array }>, timestamp: string): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  const { time, date } = dosDateTime(timestamp);
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x0800, true);
    view.setUint16(8, 0, true); view.setUint16(10, time, true); view.setUint16(12, date, true);
    view.setUint32(14, crc, true); view.setUint32(18, entry.data.length, true); view.setUint32(22, entry.data.length, true);
    view.setUint16(26, name.length, true); view.setUint16(28, 0, true); local.set(name, 30);
    localParts.push(local, entry.data);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true); centralView.setUint16(4, 20, true); centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true); centralView.setUint16(10, 0, true); centralView.setUint16(12, time, true); centralView.setUint16(14, date, true);
    centralView.setUint32(16, crc, true); centralView.setUint32(20, entry.data.length, true); centralView.setUint32(24, entry.data.length, true);
    centralView.setUint16(28, name.length, true); centralView.setUint16(30, 0, true); centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true); centralView.setUint16(36, 0, true); centralView.setUint32(38, 0, true); centralView.setUint32(42, offset, true);
    central.set(name, 46); centralParts.push(central);
    offset += local.length + entry.data.length;
  }
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true); endView.setUint16(4, 0, true); endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true); endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true); endView.setUint32(16, offset, true); endView.setUint16(20, 0, true);
  return concatBytes([...localParts, ...centralParts, end]);
}

function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(value: string): { time: number; date: number } {
  const parsed = new Date(value);
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}
