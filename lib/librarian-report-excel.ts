import {
  createExcelWorkbookBytes,
  type ExcelCell,
  type ExcelColumn,
  type ExcelSheet,
} from "./library-excel-export.ts";
import type { LibrarianReportData, LibrarianReportKind } from "./librarian-report-store.ts";

type SheetDefinition = {
  title: string;
  columns: ExcelColumn[];
  row: (value: Record<string, unknown>, index: number) => ExcelCell[];
  landscape?: boolean;
};

export function createLibrarianReportExcel(data: LibrarianReportData) {
  const normalizedData = normalizeAnnualReport(data);
  const definition = REPORT_DEFINITIONS[normalizedData.kind];
  const sheets = normalizedData.sections.map((section) => {
    const sheetDefinition = definition.sections[section.key];
    if (!sheetDefinition) throw new Error("Невідома секція звіту.");
    return {
      name: safeSheetName(sheetDefinition.title),
      columns: sheetDefinition.columns,
      rows: section.rows.map(sheetDefinition.row),
      reportTitle: sheetDefinition.title,
      metadata: [["Період", `${displayDate(normalizedData.from)} — ${displayDate(normalizedData.to)}`]],
      emptyMessage: "За вибраний період записів немає.",
      printLandscape: sheetDefinition.landscape ?? true,
      printFitToHeight: 0,
      compactRows: true,
      printFooter: "Єдина бібліотека · Міжнародний ліцей МАУП",
    } satisfies ExcelSheet;
  });
  const bytes = createExcelWorkbookBytes(sheets, normalizedData.generatedAt, definition.title);
  return {
    bytes,
    rowCount: normalizedData.sections.reduce((sum, section) => sum + section.rows.length, 0),
    sheetCount: sheets.length,
    fileName: safeFileName(`${definition.title} — ${normalizedData.from} — ${normalizedData.to}.xlsx`),
  };
}

const C = (header: string, width: number, kind?: ExcelColumn["kind"]): ExcelColumn => ({ header, width, ...(kind ? { kind } : {}) });
const materialColumns = [C("Предмет", 20), C("Назва", 42), C("Автор", 28), C("Рік", 9, "number")];
const materialCells = (r: Record<string, unknown>) => [t(r.subject), t(r.title), t(r.author), nOrBlank(r.publicationYear)];

const REPORT_DEFINITIONS: Record<LibrarianReportKind, { title: string; sections: Record<string, SheetDefinition> }> = {
  returns: {
    title: "Неповернуті матеріали",
    sections: {
      teachers: {
        title: "Учителі",
        columns: [C("Учитель", 30), C("Видано", 13, "date"), C("Повернути до", 13, "date"), ...materialColumns, C("Видано", 10, "number"), C("Повернуто", 12, "number"), C("Не повернуто", 14, "number")],
        row: (r) => [t(r.borrower), date(r.issuedAt), date(r.dueAt), ...materialCells(r), n(r.quantityIssued), n(r.quantityReturned), n(r.outstanding)],
      },
      classes: {
        title: "Класи",
        columns: [C("Клас", 14), C("Навчальний рік", 16), C("Видано", 13, "date"), C("Повернути до", 13, "date"), ...materialColumns, C("Видано", 10, "number"), C("Повернуто", 12, "number"), C("Не повернуто", 14, "number")],
        row: (r) => [t(r.borrower), t(r.academicYear), date(r.issuedAt), date(r.dueAt), ...materialCells(r), n(r.quantityIssued), n(r.quantityReturned), n(r.outstanding)],
      },
    },
  },
  provision: {
    title: "Розподіл матеріалів по класах",
    sections: { distribution: {
      title: "Розподіл по класах",
      columns: [C("Навчальний рік", 16), C("Клас", 14), C("Класний керівник", 30), ...materialColumns, C("Видано", 10, "number"), C("Повернуто", 12, "number"), C("Залишається", 12, "number"), C("Доступно зараз", 14, "number")],
      row: (r) => [t(r.academicYear), t(r.className), t(r.curatorName), ...materialCells(r), n(r.issued), n(r.returned), n(r.outstanding), n(r.availableNow)],
    } },
  },
  movement: {
    title: "Рух бібліотечного фонду",
    sections: {
      fund: {
        title: "Операції фонду",
        columns: [C("Дата", 18, "datetime"), C("Операція", 18), C("Документ", 18), C("Назва", 40), C("Автор", 26), C("Предмет", 20), C("Місце", 22), C("Стан", 14), C("Зміна", 10, "number"), C("Було", 9, "number"), C("Стало", 9, "number"), C("Підстава / примітка", 34)],
        row: (r) => [datetime(r.occurredAt), transactionKind(r.kind), t(r.documentNumber), t(r.title), t(r.author), t(r.subject), t(r.locationName), condition(r.condition), n(r.quantityDelta), n(r.quantityBefore), n(r.quantityAfter), t(r.reason)],
      },
      classes: {
        title: "Рух по класах",
        columns: [C("Дата", 18, "datetime"), C("Операція", 15), C("Клас", 13), C("Назва", 40), C("Автор", 26), C("Предмет", 20), C("Місце", 22), C("Стан", 14), C("Зміна", 10, "number"), C("Було", 9, "number"), C("Стало", 9, "number"), C("Примітка", 30)],
        row: (r) => [datetime(r.occurredAt), classTransactionKind(r.kind), t(r.className), t(r.title), t(r.author), t(r.subject), t(r.locationName), condition(r.condition), n(r.quantityDelta), n(r.quantityBefore), n(r.quantityAfter), t(r.reason)],
      },
    },
  },
  inventory: {
    title: "Інвентаризаційна відомість",
    sections: { inventory: {
      title: "Інвентаризація",
      columns: [C("№", 6, "number"), C("Предмет", 20), C("Назва", 42), C("Автор", 27), C("Рік", 9, "number"), C("Місце", 24), C("Стан", 14), C("За системою", 14, "number"), C("Останній підрахунок", 17, "number"), C("Різниця", 11, "number"), C("Дата підрахунку", 15, "date")],
      row: (r, index) => [index + 1, ...materialCells(r), t(r.locationName), condition(r.condition), n(r.systemQuantity), nOrBlank(r.lastCountedQuantity), r.lastCountedQuantity == null ? "" : n(r.lastCountedQuantity) - n(r.systemQuantity), date(r.lastCountedAt)],
    } },
  },
  acquisitions: {
    title: "Комплектування фонду",
    sections: { acquisitions: {
      title: "Заявки на придбання",
      columns: [C("Номер заявки", 20), C("Подано", 18, "datetime"), C("Хто запропонував", 28), C("Клас", 13), C("Категорія", 18), C("Назва", 38), C("Автор", 26), C("Рік", 9, "number"), C("Предмет", 20), C("Для класу", 13), C("Запитано", 11, "number"), C("Погоджено", 12, "number"), C("Замовлено", 12, "number"), C("Отримано", 11, "number"), C("Статус", 17), C("Покликання", 36), C("Примітки", 36)],
      row: (r) => [t(r.requestNumber), datetime(r.submittedAt), t(r.requesterName), t(r.requesterClassName), acquisitionCategory(r.category, r.literatureKind), t(r.title), t(r.author), nOrBlank(r.publicationYear), t(r.subject), t(r.targetClass), n(r.requestedQuantity), nOrBlank(r.approvedQuantity), n(r.orderedQuantity), n(r.receivedQuantity), acquisitionStatus(r.status), t(r.sourceUrl), [t(r.requesterNote), t(r.librarianNote)].filter(Boolean).join(" · ")],
    } },
  },
  visits: {
    title: "Записи на відвідування бібліотеки",
    sections: { visits: {
      title: "Записи на відвідування",
      columns: [C("Дата", 13, "date"), C("Початок", 10), C("Завершення", 11), C("Учитель", 30), C("Клас", 13), C("Мета", 34), C("Статус", 15), C("Причина скасування", 32)],
      row: (r) => [date(r.visitDate), t(r.startTime), t(r.endTime), t(r.teacherName), t(r.className), t(r.purpose), t(r.status) === "cancelled" ? "Скасовано" : "Активний запис", t(r.cancelReason)],
    } },
  },
  annual: {
    title: "Річний звіт за даними системи",
    sections: { annual: {
      title: "Річне зведення",
      landscape: false,
      columns: [C("Показник", 48), C("Значення", 18, "number"), C("Пояснення", 52)],
      row: (r) => [t(r.indicator), n(r.value), t(r.explanation)],
    } },
  },
};

export function normalizeAnnualReport(data: LibrarianReportData): LibrarianReportData {
  if (data.kind !== "annual") return data;
  const source = data.sections[0]?.rows[0] ?? {};
  const rows = [
    ["Матеріалів у каталозі", source.activeMaterials, "Активні назви на дату формування"],
    ["Примірників у фонді", source.totalCopies, "Поточна загальна кількість"],
    ["Надійшло примірників", source.receivedCopies, "Надходження та імпорт за період"],
    ["Списано примірників", source.writtenOffCopies, "Списання за період"],
    ["Видано вчителям", source.issuedToTeachers, "Примірники у видачах учителям за період"],
    ["Видано класам", source.issuedToClasses, "Примірники у видачах класам за період"],
    ["Активних записів на відвідування", source.activeVisitBookings, "Записи, а не підтверджені фактичні відвідування"],
    ["Скасованих записів", source.cancelledVisitBookings, "Скасовані записи на відвідування"],
    ["Пропозицій придбання", source.acquisitionRequests, "Усі заявки за період"],
    ["Повністю отриманих заявок", source.receivedAcquisitions, "Заявки зі статусом «Отримано»"],
    ["Активних учителів", source.activeTeachers, "Поточні активні картки"],
    ["Активних класів", source.activeClasses, "Поточний активний навчальний рік"],
  ].map(([indicator, value, explanation]) => ({ indicator, value, explanation }));
  return { ...data, sections: [{ key: "annual", rows }] };
}

function t(value: unknown): string { return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim(); }
function n(value: unknown): number { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? Math.trunc(parsed) : 0; }
function nOrBlank(value: unknown): number | "" { return value == null || value === "" ? "" : n(value); }
function date(value: unknown): ExcelCell { const v = t(value).slice(0, 10); const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(v); if (!match) return v; return { value: Math.round((Date.UTC(+match[1], +match[2] - 1, +match[3]) - Date.UTC(1899, 11, 30)) / 86_400_000), kind: "date" }; }
function datetime(value: unknown): ExcelCell { const v = t(value); const parsed = Date.parse(v); return Number.isFinite(parsed) ? { value: (parsed - Date.UTC(1899, 11, 30)) / 86_400_000, kind: "datetime" } : v; }
function displayDate(value: string): string { return value.split("-").reverse().join("."); }
function safeSheetName(value: string): string { return value.replace(/[\\/?*:[\]]/gu, "-").slice(0, 31); }
function safeFileName(value: string): string { return value.replace(/[\\/:*?"<>|]/gu, "-").replace(/\s+/gu, " ").trim().slice(0, 180); }
function condition(value: unknown): string { return ({ good: "Добрий", worn: "Зношений", damaged: "Пошкоджений", unspecified: "Не вказано" } as Record<string, string>)[t(value)] ?? t(value); }
function transactionKind(value: unknown): string { return ({ receipt: "Надходження", transfer: "Переміщення", writeoff: "Списання", stock_count: "Інвентаризація", loan_issue: "Видача вчителю", loan_return: "Повернення від учителя", reversal: "Сторнування", import: "Імпорт" } as Record<string, string>)[t(value)] ?? t(value); }
function classTransactionKind(value: unknown): string { return t(value) === "return" ? "Повернення класу" : "Видача класу"; }
function acquisitionCategory(category: unknown, literatureKind: unknown): string { if (t(category) === "educational") return "Навчальні матеріали"; return ({ fiction: "Художня література", science: "Наукова література", popular_science: "Науково-популярна", other: "Інша література" } as Record<string, string>)[t(literatureKind)] ?? "Література"; }
function acquisitionStatus(value: unknown): string { return ({ submitted: "Подано", in_review: "На розгляді", clarification: "Потрібне уточнення", approved: "Погоджено", planned: "Заплановано", ordered: "Замовлено", partially_received: "Частково отримано", received: "Отримано", rejected: "Відхилено", cancelled: "Скасовано" } as Record<string, string>)[t(value)] ?? t(value); }
