"use client";

import { readExcelWorkbookSheets } from "../import/excel-workbook-parser";
import type { AcquisitionImportRowInput } from "@/lib/acquisition-validation";

const SHEETS = {
  "дозамовлення": ["REQUEST-ID","CAT-ID","Назва","Автор","Рік","Кількість","Покликання","Предмет","Клас","USR-ID","Учитель","Примітка"],
  "художня та наукова література": ["REQUEST-ID","Вид літератури","Назва","Автор","Рік","Кількість","Покликання","USR-ID","Учитель","Примітка"],
  "пропозиції учнів": ["REQUEST-ID","Клас","Прізвище та ім’я","Назва","Автор","Рік","Кількість","Покликання","Примітка"],
  "довідники": ["Група","Код","Назва"],
} as const;

export type ParsedAcquisitionWorkbook = { fileName: string; fileHash: string; rows: AcquisitionImportRowInput[]; warnings: string[] };

export async function parseAcquisitionWorkbook(file: File): Promise<ParsedAcquisitionWorkbook> {
  const sheets = await readExcelWorkbookSheets(file, 8 * 1024 * 1024);
  const rows: AcquisitionImportRowInput[] = [];
  const warnings: string[] = [];
  const found = new Set<string>();
  for (const sheet of sheets) {
    const key = normalize(sheet.name);
    const required = SHEETS[key as keyof typeof SHEETS];
    if (!required) throw new Error(`Невідомий аркуш «${sheet.name}». Файл повинен містити лише 4 аркуші шаблону.`);
    if (found.has(key)) throw new Error(`Аркуш «${sheet.name}» повторюється.`);
    found.add(key);
    if (sheet.hasFormulas) throw new Error(`Аркуш «${sheet.name}» містить формули. Замініть їх значеннями.`);
    const expectedHeaders = required.map(normalize);
    const headerIndex = sheet.rows.findIndex((row) => {
      const actual = row.map(normalize).filter(Boolean);
      return actual.length === expectedHeaders.length && actual.every((header, index) => header === expectedHeaders[index]);
    });
    if (headerIndex < 0) throw new Error(`Аркуш «${sheet.name}» повинен мати точні колонки шаблону в незміненому порядку.`);
    if (key === "довідники") continue;
    const headers = sheet.rows[headerIndex].map(normalize);
    const value = (row: string[], header: string) => clean(row[headers.indexOf(normalize(header))] ?? "");
    for (let index = headerIndex + 1; index < sheet.rows.length; index += 1) {
      const row = sheet.rows[index];
      if (!row.some((cell) => clean(cell))) continue;
      const sourceRow = index + 1;
      if (key === "дозамовлення") {
        const materialId = value(row, "CAT-ID").toUpperCase() || null;
        rows.push({ sourceSheet: "Дозамовлення", sourceRow, existingRequestNumber: value(row, "REQUEST-ID"), requesterKind: "teacher", teacherUserId: value(row, "USR-ID"), teacherName: value(row, "Учитель"), studentName: "", studentClassName: "", category: "educational", sourceKind: materialId ? "catalog" : "manual", literatureKind: "none", materialId, title: value(row, "Назва"), author: value(row, "Автор"), publicationYear: integer(value(row, "Рік"), sheet.name, sourceRow), requestedQuantity: integer(value(row, "Кількість"), sheet.name, sourceRow), sourceUrl: value(row, "Покликання"), subject: value(row, "Предмет"), targetClass: value(row, "Клас"), note: value(row, "Примітка") });
      } else if (key === "художня та наукова література") {
        rows.push({ sourceSheet: "Художня та наукова література", sourceRow, existingRequestNumber: value(row, "REQUEST-ID"), requesterKind: "teacher", teacherUserId: value(row, "USR-ID"), teacherName: value(row, "Учитель"), studentName: "", studentClassName: "", category: "literature", sourceKind: "manual", literatureKind: literature(value(row, "Вид літератури"), sheet.name, sourceRow), materialId: null, title: value(row, "Назва"), author: value(row, "Автор"), publicationYear: integer(value(row, "Рік"), sheet.name, sourceRow), requestedQuantity: integer(value(row, "Кількість"), sheet.name, sourceRow), sourceUrl: value(row, "Покликання"), subject: "", targetClass: "", note: value(row, "Примітка") });
      } else {
        rows.push({ sourceSheet: "Пропозиції учнів", sourceRow, existingRequestNumber: value(row, "REQUEST-ID"), requesterKind: "student", teacherUserId: "", teacherName: "", studentName: value(row, "Прізвище та ім’я"), studentClassName: value(row, "Клас"), category: "literature", sourceKind: "manual", literatureKind: "fiction", materialId: null, title: value(row, "Назва"), author: value(row, "Автор"), publicationYear: integer(value(row, "Рік"), sheet.name, sourceRow), requestedQuantity: integer(value(row, "Кількість"), sheet.name, sourceRow), sourceUrl: value(row, "Покликання"), subject: "", targetClass: "", note: value(row, "Примітка") });
      }
    }
  }
  const missing = Object.keys(SHEETS).filter((name) => !found.has(name));
  if (missing.length) throw new Error(`Відсутні обов’язкові аркуші: ${missing.join(", ")}.`);
  if (rows.length < 1) throw new Error("У підтримуваних аркушах немає заповнених рядків.");
  if (rows.length > 500) throw new Error("Файл може містити не більше 500 рядків.");
  if (rows.filter((row) => !row.existingRequestNumber).length > 20) {
    throw new Error("За один раз можна імпортувати не більше 20 нових рядків.");
  }
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  const fileHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { fileName: file.name, fileHash, rows, warnings };
}

function literature(value: string, sheet: string, row: number): AcquisitionImportRowInput["literatureKind"] {
  const key = normalize(value);
  if (["fiction","художня"].includes(key)) return "fiction";
  if (["science","наукова"].includes(key)) return "science";
  if (["popular_science","науково популярна","науково-популярна"].includes(key)) return "popular_science";
  if (["other","інша"].includes(key)) return "other";
  throw new Error(`Аркуш «${sheet}», рядок ${row}: оберіть вид літератури.`);
}
function integer(value: string, sheet: string, row: number): number {
  const number = Number(value.replace(",", "."));
  if (!Number.isSafeInteger(number)) throw new Error(`Аркуш «${sheet}», рядок ${row}: рік і кількість мають бути цілими числами.`);
  return number;
}
function clean(value: unknown): string { return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim(); }
function normalize(value: unknown): string { return clean(value).toLocaleLowerCase("uk-UA"); }
