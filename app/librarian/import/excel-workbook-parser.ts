"use client";

export const MAX_EXCEL_BYTES = 10 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 160;
const MAX_XML_BYTES = 12 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 48 * 1024 * 1024;

export type WorkbookIssue = {
  severity: "error" | "warning";
  sheet?: string;
  message: string;
};

export type WorkbookSheetSummary = {
  name: string;
  columns: string[];
  dataRows: number;
  ignoredColumns: string[];
};

export type WorkbookPreview = {
  fileName: string;
  fileBytes: number;
  sheetCount: number;
  materialRows: number;
  stockRows: number;
  teacherRows: number;
  classRows: number;
  classLoanRows: number;
  teacherLoanRows: number;
  sheets: WorkbookSheetSummary[];
  issues: WorkbookIssue[];
  generatedAt: string;
};

type SheetData = { name: string; rows: string[][] };

const STANDARD_SHEETS = new Map([
  [key("Матеріали"), { label: "Матеріали", required: ["cat-id", "назва", "рубрика", "предмет", "тип видання"] }],
  [key("Залишки"), { label: "Залишки", required: ["cat-id", "місце зберігання", "стан", "кількість"] }],
  [key("Вчителі"), { label: "Вчителі", required: ["usr-id", "прізвище та ім’я", "статус"] }],
  [key("Класи"), { label: "Класи", required: ["cy-id", "навчальний рік", "назва класу", "статус"] }],
  [key("Видачі класам"), { label: "Видачі класам", required: ["cloan-id", "cy-id", "cat-id", "видано", "повернено"] }],
  [key("Видачі вчителям"), { label: "Видачі вчителям", required: ["loan-id", "usr-id", "cat-id", "видано", "повернено"] }],
]);

export async function analyzeExcelWorkbook(file: File): Promise<WorkbookPreview> {
  if (!/\.xlsx$/iu.test(file.name)) throw new Error("Оберіть файл Excel у форматі .xlsx.");
  if (file.size <= 0 || file.size > MAX_EXCEL_BYTES) {
    throw new Error("Excel-файл має бути непорожнім і не перевищувати 10 МіБ.");
  }
  const entries = await unzipXlsx(new Uint8Array(await file.arrayBuffer()));
  const sheets = readWorkbook(entries);
  if (sheets.length === 0) throw new Error("У книзі не знайдено аркушів із таблицями.");

  return summarizeWorkbookSheets(file.name, file.size, sheets);
}

export function summarizeWorkbookSheets(fileName: string, fileBytes: number, sheets: SheetData[]): WorkbookPreview {

  const issues: WorkbookIssue[] = [];
  const summaries: WorkbookSheetSummary[] = [];
  const counts = new Map<string, number>();
  let recognized = 0;

  for (const sheet of sheets) {
    const rows = sheet.rows.filter((row) => row.some((value) => clean(value)));
    const headerIndex = findHeaderRow(rows);
    const headers = headerIndex >= 0 ? rows[headerIndex].map(clean) : [];
    const normalizedHeaders = headers.map(headerKey);
    const ignoredColumns = headers.filter((header) => headerKey(header) === "вигляд");
    const standard = STANDARD_SHEETS.get(key(sheet.name));
    const legacyMaterial = !standard && normalizedHeaders.some((header) =>
      header === "назва підручника" || header.includes("назва збірника") || header === "назва");
    if (standard || legacyMaterial) recognized += 1;

    const dataRows = headerIndex < 0 ? 0 : rows.slice(headerIndex + 1).filter((row) => isDataRow(row, normalizedHeaders)).length;
    if (standard) {
      const missing = standard.required.filter((required) => !normalizedHeaders.includes(required));
      if (missing.length > 0) issues.push({
        severity: "error",
        sheet: sheet.name,
        message: `Немає обов’язкових колонок: ${missing.join(", ")}.`,
      });
      counts.set(key(standard.label), dataRows);
    } else if (legacyMaterial) {
      counts.set(key("Матеріали"), (counts.get(key("Матеріали")) ?? 0) + dataRows);
      issues.push({
        severity: "warning",
        sheet: sheet.name,
        message: "Розпізнано предметний аркуш старого шаблону. Колонку «Вигляд», службові заголовки та підсумки буде пропущено.",
      });
    }
    summaries.push({ name: sheet.name, columns: headers.filter((header) => headerKey(header) !== "вигляд"), dataRows, ignoredColumns });
  }

  if (recognized === 0) issues.push({ severity: "error", message: "Не знайдено жодного підтримуваного аркуша бібліотечної бази." });
  if (!counts.has(key("Матеріали"))) issues.push({ severity: "error", message: "Відсутній аркуш «Матеріали» або сумісні предметні аркуші." });
  if (!counts.has(key("Залишки"))) issues.push({ severity: "warning", message: "Немає аркуша «Залишки»: кількість примірників не буде підготовлено до перенесення." });
  for (const label of ["Вчителі", "Класи", "Видачі класам", "Видачі вчителям"]) {
    if (!counts.has(key(label))) issues.push({ severity: "warning", message: `Немає аркуша «${label}». Цей блок залишиться порожнім.` });
  }

  return {
    fileName,
    fileBytes,
    sheetCount: sheets.length,
    materialRows: counts.get(key("Матеріали")) ?? 0,
    stockRows: counts.get(key("Залишки")) ?? 0,
    teacherRows: counts.get(key("Вчителі")) ?? 0,
    classRows: counts.get(key("Класи")) ?? 0,
    classLoanRows: counts.get(key("Видачі класам")) ?? 0,
    teacherLoanRows: counts.get(key("Видачі вчителям")) ?? 0,
    sheets: summaries,
    issues,
    generatedAt: new Date().toISOString(),
  };
}

async function unzipXlsx(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error("Файл не є коректною книгою Excel.");
  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (entryCount <= 0 || entryCount > MAX_ARCHIVE_FILES) throw new Error("Excel-файл містить забагато внутрішніх частин.");
  const entries = new Map<string, Uint8Array>();
  let total = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Пошкоджена структура Excel-файла.");
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength)).replace(/\\/gu, "/");
    if (name.includes("../") || name.startsWith("/") || uncompressed > MAX_XML_BYTES) throw new Error("Excel-файл містить небезпечний або надмірний внутрішній запис.");
    total += uncompressed;
    if (total > MAX_ARCHIVE_BYTES) throw new Error("Розпакований Excel-файл перевищує безпечний ліміт.");
    if (wantedEntry(name)) {
      if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("Пошкоджена локальна структура Excel-файла.");
      const localName = view.getUint16(localOffset + 26, true);
      const localExtra = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + localName + localExtra;
      const payload = bytes.slice(start, start + compressed);
      const value = method === 0 ? payload : method === 8 ? await inflateRaw(payload) : null;
      if (!value || value.byteLength !== uncompressed) throw new Error("Excel-файл використовує непідтримуваний спосіб стиснення.");
      entries.set(name, value);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function wantedEntry(name: string): boolean {
  return name === "xl/workbook.xml" || name === "xl/sharedStrings.xml"
    || name === "xl/_rels/workbook.xml.rels" || /^xl\/worksheets\/sheet\d+\.xml$/u.test(name);
}

function readWorkbook(entries: Map<string, Uint8Array>): SheetData[] {
  const xml = (name: string) => {
    const bytes = entries.get(name);
    if (!bytes) return null;
    const doc = new DOMParser().parseFromString(new TextDecoder("utf-8", { fatal: true }).decode(bytes), "application/xml");
    if (doc.querySelector("parsererror")) throw new Error(`Не вдалося прочитати ${name}.`);
    return doc;
  };
  const workbook = xml("xl/workbook.xml");
  const rels = xml("xl/_rels/workbook.xml.rels");
  if (!workbook || !rels) throw new Error("У книзі відсутній опис аркушів.");
  const shared = [...(xml("xl/sharedStrings.xml")?.querySelectorAll("si") ?? [])].map((node) => node.textContent ?? "");
  const targets = new Map([...rels.querySelectorAll("Relationship")].map((node) => [node.getAttribute("Id") ?? "", node.getAttribute("Target") ?? ""]));
  return [...workbook.querySelectorAll("sheet")].map((sheet) => {
    const id = sheet.getAttribute("r:id") ?? sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ?? "";
    const target = targets.get(id) ?? "";
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//u, "")}`;
    const doc = xml(path.replace(/\/+/gu, "/"));
    return { name: sheet.getAttribute("name") ?? "Аркуш", rows: doc ? readRows(doc, shared) : [] };
  });
}

function readRows(doc: Document, shared: string[]): string[][] {
  const rows: string[][] = [];
  for (const row of doc.querySelectorAll("sheetData > row")) {
    const values: string[] = [];
    for (const cell of row.querySelectorAll("c")) {
      const reference = cell.getAttribute("r") ?? "A1";
      const column = columnIndex(reference);
      const type = cell.getAttribute("t");
      const raw = cell.querySelector("v")?.textContent ?? cell.querySelector("is")?.textContent ?? "";
      values[column] = type === "s" ? shared[Number(raw)] ?? "" : raw;
    }
    rows.push(values.map((value) => value ?? ""));
  }
  return rows;
}

function columnIndex(reference: string): number {
  const letters = reference.match(/^[A-Z]+/u)?.[0] ?? "A";
  return [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function findHeaderRow(rows: string[][]): number {
  return rows.findIndex((row, index) => index < 20 && row.filter((value) => clean(value)).length >= 2);
}

function isDataRow(row: string[], headers: string[]): boolean {
  const values = row.map(clean);
  if (!values.some(Boolean)) return false;
  const titleIndex = headers.findIndex((header) => header === "назва" || header === "назва підручника" || header.includes("назва збірника"));
  const idIndex = headers.findIndex((header) => ["cat-id", "usr-id", "cy-id", "loan-id", "cloan-id"].includes(header));
  const candidate = clean(values[idIndex >= 0 ? idIndex : titleIndex >= 0 ? titleIndex : 0]);
  if (!candidate) return false;
  return !/^(усього|всього|разом|підсумок|нуш)$/iu.test(candidate);
}

function clean(value: unknown): string { return String(value ?? "").replace(/\s+/gu, " ").trim(); }
function key(value: string): string { return clean(value).toLocaleLowerCase("uk-UA"); }
function headerKey(value: string): string { return key(value).replace(/[‐‑‒–—]/gu, "-"); }
