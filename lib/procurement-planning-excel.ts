import { createExcelWorkbookBytes, type ExcelCell, type ExcelColumn, type ExcelSheet } from "./library-excel-export.ts";
import type { ProcurementCategory, ProcurementPlanDetail, ProcurementPlanResource } from "./procurement-planning-store.ts";

const CATEGORY_LABELS: Record<ProcurementCategory, string> = {
  textbook: "Підручники",
  workbook: "Робочі зошити",
  assessment: "Контрольні роботи",
  exercises: "Збірники вправ",
  atlas: "Атласи й контурні карти",
  other: "Інше",
};

export function createProcurementPlanExcel(plan: ProcurementPlanDetail): { bytes: Uint8Array<ArrayBuffer>; fileName: string; sheetCount: number } {
  const generatedAt = new Date().toISOString();
  const sheets = buildSheets(plan);
  const bytes = createExcelWorkbookBytes(sheets, generatedAt, `Потреба фонду на ${plan.academicYearLabel}`);
  return {
    bytes,
    fileName: `Потреба фонду — ${safeFileName(plan.academicYearLabel)}${plan.status === "finalized" ? "" : " — чернетка"}.xlsx`,
    sheetCount: sheets.length,
  };
}

function buildSheets(plan: ProcurementPlanDetail): ExcelSheet[] {
  const metadata: Array<[string, string]> = [
    ["Навчальний рік", plan.academicYearLabel],
    ["Статус", plan.status === "finalized" ? "Завершено" : "Робоча чернетка"],
    ["Ревізію підтверджено", plan.revisionConfirmedAt ? displayDate(plan.revisionConfirmedAt) : "Ні"],
    ["Класів без кількості учнів", String(plan.classCountsMissing)],
    ["Позицій із неповним розрахунком", String(plan.totals.incompleteResources)],
  ];
  const summary: ExcelSheet = {
    name: "Підсумок",
    reportTitle: `Потреба фонду на ${plan.academicYearLabel}`,
    metadata,
    printLandscape: true,
    columns: [
      { header: "Категорія", width: 30 },
      { header: "Найменувань", width: 15, kind: "number" },
      { header: "Потреба", width: 15, kind: "number" },
      { header: "Придатно у фонді", width: 19, kind: "number" },
      { header: "Очікується", width: 15, kind: "number" },
      { header: "Треба замовити", width: 19, kind: "number" },
      { header: "Неповні позиції", width: 18, kind: "number" },
    ],
    rows: plan.categorySummary.map((row) => [CATEGORY_LABELS[row.category], row.resourceCount, row.demandQuantity, row.usableQuantity, row.incomingQuantity, row.toOrderQuantity, row.incompleteResources]),
    emptyMessage: "У плані ще немає видань.",
  };
  const classes: ExcelSheet = {
    name: "Майбутні класи",
    reportTitle: "Майбутні класи",
    metadata,
    columns: [
      { header: "Клас", width: 18 },
      { header: "Паралель", width: 12, kind: "number" },
      { header: "Майбутня кількість учнів", width: 27, kind: "number" },
      { header: "Примітки", width: 46 },
    ],
    rows: plan.classes.map((item) => [item.className, item.grade, item.studentCount ?? "", item.notes]),
    emptyMessage: "Класи ще не додані.",
  };
  const consolidated: ExcelSheet = {
    name: "Зведене замовлення",
    reportTitle: "Зведене замовлення",
    metadata,
    printLandscape: true,
    columns: resourceColumns(),
    rows: plan.resources.map(resourceRow),
    emptyMessage: "Позиції плану ще не додані.",
  };
  const details: ExcelSheet = {
    name: "Детальний розрахунок",
    reportTitle: "Детальний розрахунок за класами",
    metadata,
    printLandscape: true,
    columns: detailColumns(),
    rows: plan.resources.flatMap((resource) => resource.allocations.map((allocation) => [
      allocation.className,
      allocation.studentCount ?? "",
      CATEGORY_LABELS[resource.category],
      resource.subject,
      resource.title,
      resource.author,
      resource.publisher,
      resource.publicationYear ?? "",
      demandModeLabel(allocation.demandMode),
      allocation.copiesPerUnit,
      allocation.demandMode === "fixed" ? allocation.fixedQuantity : "",
      allocation.reserveQuantity,
      allocation.demandQuantity ?? "",
      resource.sourceUrl,
      [allocation.notes, resource.notes].filter(Boolean).join("; "),
    ])),
    emptyMessage: "Розрахунки за класами ще не додані.",
  };
  const classSheets = plan.classes.slice(0, 80).map((planClass) => ({
    name: uniqueSheetName(`Клас ${planClass.className}`),
    reportTitle: `Потреба для ${planClass.className}`,
    metadata: [...metadata, ["Клас", planClass.className], ["Кількість учнів", planClass.studentCount == null ? "Ще не внесено" : String(planClass.studentCount)]] as Array<[string, string]>,
    printLandscape: true,
    columns: classResourceColumns(),
    rows: plan.resources.flatMap((resource) => {
      const allocation = resource.allocations.find((item) => item.classId === planClass.id);
      return allocation ? [[resource.title, resource.author, resource.publisher, resource.publicationYear ?? "", CATEGORY_LABELS[resource.category], resource.subject, allocation.demandQuantity ?? "", resource.sourceUrl, [allocation.notes, resource.notes].filter(Boolean).join("; ")] as ExcelCell[]] : [];
    }),
    emptyMessage: "Для цього класу ще немає позицій.",
  } satisfies ExcelSheet));
  return [summary, classes, consolidated, details, ...classSheets];
}

function resourceColumns(): ExcelColumn[] {
  return [
    { header: "Назва видання/підручника", width: 48 },
    { header: "Автор", width: 28 },
    { header: "Видавництво", width: 24 },
    { header: "Рік", width: 10, kind: "number" },
    { header: "К-сть", width: 12, kind: "number" },
    { header: "Електронна версія", width: 42 },
    { header: "Примітки", width: 42 },
    { header: "Категорія", width: 27 },
    { header: "Предмет", width: 24 },
    { header: "Класи", width: 26 },
    { header: "Потреба", width: 13, kind: "number" },
    { header: "Придатно у фонді", width: 19, kind: "number" },
    { header: "Очікується", width: 15, kind: "number" },
    { header: "Надлишок", width: 13, kind: "number" },
  ];
}

function resourceRow(resource: ProcurementPlanResource): ExcelCell[] {
  return [
    resource.title,
    resource.author,
    resource.publisher,
    resource.publicationYear ?? "",
    resource.toOrderQuantity ?? "",
    resource.sourceUrl,
    resource.notes,
    CATEGORY_LABELS[resource.category],
    resource.subject,
    resource.allocations.map((item) => item.className).join(", "),
    resource.demandQuantity ?? "",
    resource.usableQuantity,
    resource.confirmedIncomingQuantity,
    resource.surplusQuantity ?? "",
  ];
}

function detailColumns(): ExcelColumn[] {
  return [
    { header: "Клас", width: 16 }, { header: "Учнів", width: 11, kind: "number" },
    { header: "Категорія", width: 26 }, { header: "Предмет", width: 24 },
    { header: "Назва", width: 46 }, { header: "Автор", width: 28 },
    { header: "Видавництво", width: 24 }, { header: "Рік", width: 10, kind: "number" },
    { header: "Правило", width: 20 }, { header: "Норма", width: 11, kind: "number" },
    { header: "Фіксована кількість", width: 20, kind: "number" }, { header: "Резерв", width: 11, kind: "number" },
    { header: "Потреба класу", width: 18, kind: "number" }, { header: "Електронна версія", width: 40 },
    { header: "Примітки", width: 40 },
  ];
}

function classResourceColumns(): ExcelColumn[] {
  return [
    { header: "Назва", width: 48 }, { header: "Автор", width: 28 }, { header: "Видавництво", width: 24 },
    { header: "Рік", width: 10, kind: "number" }, { header: "Категорія", width: 26 }, { header: "Предмет", width: 24 },
    { header: "Потреба", width: 14, kind: "number" }, { header: "Електронна версія", width: 40 }, { header: "Примітки", width: 42 },
  ];
}

function demandModeLabel(value: "per_student" | "per_class" | "fixed"): string {
  return value === "per_student" ? "На учня" : value === "per_class" ? "На клас" : "Фіксовано";
}
function displayDate(value: string): string { return value.slice(0, 10).split("-").reverse().join("."); }
function safeFileName(value: string): string { return value.replace(/[\\/:*?"<>|]/gu, "-").slice(0, 80); }
function uniqueSheetName(value: string): string { return value.replace(/[\\/*?:\u005B\u005D]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 31) || "Клас"; }
