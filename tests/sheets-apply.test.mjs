import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { gzipSync, gunzipSync } from "node:zlib";

import {
  SUPPORTED_DRAFT_APPLY_KINDS,
  isSupportedDraftApplyKind,
  validateDraftApplyInput,
} from "../lib/draft-apply-validation.ts";

const productionSpreadsheetId = "18SEyo-tAJ8uHoAFMrYbiaGMtmXjhiscQGcYTpJrNtEI";
const copySpreadsheetId = "1CopyTestSpreadsheetId_000000000000000000000";
const actor = { id: "USR-001", email: "librarian@example.test" };
const baseRequestId = "437e85df-1491-43b8-8831-06dc88fb12b7";
const baseDraftId = "8092f8cf-6e7b-4f4b-9e29-56dd684268f2";

const appsScriptFiles = [
  "../apps-script/LibrarianGateway.gs",
  "../apps-script/LibrarianApplyJournal.gs",
  "../apps-script/LibrarianApplyOperations.gs",
  "../apps-script/LibrarianCoverBridge.gs",
];

function uuidFrom(number, suffix = "a") {
  return `00000000-0000-4000-8000-${String(number).padStart(11, "0")}${suffix}`.slice(0, 36);
}

function display(value) {
  return Object.prototype.toString.call(value) === "[object Date]"
    ? value.toISOString().slice(0, 10)
    : String(value ?? "");
}

function columnNumber(text) {
  return [...text].reduce((value, character) => value * 26 + character.charCodeAt(0) - 64, 0);
}

function translateFormula(formula, rowDelta) {
  return String(formula || "").replace(/(\$?[A-Z]{1,3})(\$?)(\d+)/g, (match, column, absolute, row) =>
    absolute ? match : `${column}${Number(row) + rowDelta}`);
}

function createSheet(name, initialRows, maximumRows, initialFormulas = []) {
  const state = {
    name,
    rows: structuredClone(initialRows),
    formulas: structuredClone(initialFormulas),
    maxRows: maximumRows,
    hidden: false,
    hiddenColumns: new Set(),
    validations: new Map(),
  };
  const ensureCell = (row, column) => {
    while (state.rows.length < row) state.rows.push([]);
    while (state.rows[row - 1].length < column) state.rows[row - 1].push("");
    while (state.formulas.length < row) state.formulas.push([]);
    while (state.formulas[row - 1].length < column) state.formulas[row - 1].push("");
  };
  const rangeFor = (startRow, startColumn, rowCount = 1, columnCount = 1) => {
    const range = {
      _startRow: startRow,
      _startColumn: startColumn,
      _rowCount: rowCount,
      _columnCount: columnCount,
      getDisplayValues() {
        return Array.from({ length: rowCount }, (_, rowOffset) =>
          Array.from({ length: columnCount }, (_, columnOffset) => {
            ensureCell(startRow + rowOffset, startColumn + columnOffset);
            return display(state.rows[startRow + rowOffset - 1][startColumn + columnOffset - 1]);
          }));
      },
      getValues() {
        return Array.from({ length: rowCount }, (_, rowOffset) =>
          Array.from({ length: columnCount }, (_, columnOffset) => {
            ensureCell(startRow + rowOffset, startColumn + columnOffset);
            return state.rows[startRow + rowOffset - 1][startColumn + columnOffset - 1];
          }));
      },
      getFormulas() {
        return Array.from({ length: rowCount }, (_, rowOffset) =>
          Array.from({ length: columnCount }, (_, columnOffset) => {
            ensureCell(startRow + rowOffset, startColumn + columnOffset);
            return state.formulas[startRow + rowOffset - 1][startColumn + columnOffset - 1];
          }));
      },
      getValue() {
        ensureCell(startRow, startColumn);
        return state.rows[startRow - 1][startColumn - 1];
      },
      getDisplayValue() {
        return this.getDisplayValues()[0][0];
      },
      getFormula() {
        ensureCell(startRow, startColumn);
        return state.formulas[startRow - 1][startColumn - 1];
      },
      setValue(value) {
        ensureCell(startRow, startColumn);
        state.rows[startRow - 1][startColumn - 1] = value;
        state.formulas[startRow - 1][startColumn - 1] = "";
        return this;
      },
      setValues(values) {
        assert.equal(values.length, rowCount);
        values.forEach((sourceRow, rowOffset) => {
          assert.equal(sourceRow.length, columnCount);
          sourceRow.forEach((value, columnOffset) => {
            ensureCell(startRow + rowOffset, startColumn + columnOffset);
            state.rows[startRow + rowOffset - 1][startColumn + columnOffset - 1] = value;
            state.formulas[startRow + rowOffset - 1][startColumn + columnOffset - 1] = "";
          });
        });
        return this;
      },
      setFormula(formula) {
        ensureCell(startRow, startColumn);
        state.formulas[startRow - 1][startColumn - 1] = formula;
        return this;
      },
      copyTo(target) {
        const sourceFormulas = this.getFormulas();
        const rowDelta = target._startRow - startRow;
        sourceFormulas.forEach((sourceRow, rowOffset) => {
          sourceRow.forEach((formula, columnOffset) => {
            ensureCell(target._startRow + rowOffset, target._startColumn + columnOffset);
            state.formulas[target._startRow + rowOffset - 1][target._startColumn + columnOffset - 1] =
              translateFormula(formula, rowDelta);
          });
        });
        return target;
      },
      setDataValidation(rule) {
        state.validations.set(`${startRow}:${startColumn}:${rowCount}:${columnCount}`, rule);
        return this;
      },
      setFontWeight() { return this; },
      getRow() { return startRow; },
      createTextFinder(search) {
        const finder = {
          matchEntireCell() { return this; },
          matchCase() { return this; },
          findNext() {
            for (let rowOffset = 0; rowOffset < rowCount; rowOffset += 1) {
              for (let columnOffset = 0; columnOffset < columnCount; columnOffset += 1) {
                if (display(state.rows[startRow + rowOffset - 1]?.[startColumn + columnOffset - 1]) === search) {
                  return { getRow: () => startRow + rowOffset };
                }
              }
            }
            return null;
          },
        };
        return finder;
      },
    };
    return range;
  };
  const sheet = {
    _state: state,
    getName: () => name,
    getLastColumn() {
      return Math.max(1, ...state.rows.map((row) => row.length), ...state.formulas.map((row) => row.length));
    },
    getLastRow() {
      let last = 1;
      const count = Math.max(state.rows.length, state.formulas.length);
      for (let index = 0; index < count; index += 1) {
        const values = state.rows[index] ?? [];
        const formulas = state.formulas[index] ?? [];
        if (values.some((value) => display(value).trim()) || formulas.some(Boolean)) last = index + 1;
      }
      return last;
    },
    getMaxRows: () => state.maxRows,
    insertRowsAfter(_after, count) { state.maxRows += count; },
    hideSheet() { state.hidden = true; return this; },
    hideColumns(column, count = 1) {
      for (let offset = 0; offset < count; offset += 1) state.hiddenColumns.add(column + offset);
      return this;
    },
    setFrozenRows() { return this; },
    getRange(rowOrA1, column, rowCount = 1, columnCount = 1) {
      if (typeof rowOrA1 === "string") {
        const match = rowOrA1.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
        if (!match) throw new Error(`Unsupported A1 range ${rowOrA1}`);
        const startColumn = columnNumber(match[1]);
        const endColumn = columnNumber(match[3]);
        const startRow = Number(match[2]);
        const endRow = Number(match[4]);
        return rangeFor(startRow, startColumn, endRow - startRow + 1, endColumn - startColumn + 1);
      }
      return rangeFor(rowOrA1, column, rowCount, columnCount);
    },
  };
  return sheet;
}

function materialHeaders() {
  return [
    "ID матеріалу", "Розділ", "Тип видання", "Предмет / напрям", "Клас від", "Клас до",
    "Назва (з класом)", "Автор", "Рік", "ISBN", "Обкладинка", "Електронна версія",
    "Початкова кількість", "Наявність", "Статус опрацювання", "Повертається", "Джерело",
    "Примітка", "Вибір матеріалу", "Назва з класом", "Рубрика балансу", "Порядок рубрики",
    "", "Видавництво", "ISBN нормалізований",
  ];
}

function classYearHeaders() {
  return [
    "ID запису", "ID навчального року", "Навчальний рік", "ID групи", "Назва класу", "Клас",
    "Код", "Класний керівник", "ID керівника", "Кабінет", "ID кабінету", "Дата початку",
    "Дата завершення", "Статус", "Фактична дата закриття", "Примітки",
  ];
}

function operationFormulas(count = 30) {
  const formulas = [Array(16).fill("")];
  for (let row = 2; row <= count; row += 1) {
    const item = Array(16).fill("");
    item[0] = `=IF(B${row}="";"";"OP-"&TEXT(ROW()-1;"000000"))`;
    item[11] = `=IF(C${row}="","",REGEXEXTRACT(C${row},"CAT-[0-9]+"))`;
    item[12] = `=IF(E${row}="","",E${row})`;
    item[13] = `=IF(F${row}="","",F${row})`;
    item[14] = `=IF(J${row}="","",J${row})`;
    formulas.push(item);
  }
  return formulas;
}

function classFormulas(count = 30) {
  const formulas = [Array(16).fill("")];
  for (let row = 2; row <= count; row += 1) {
    const item = Array(16).fill("");
    item[2] = `=IF(B${row}="","",B${row})`;
    item[4] = `=IF(F${row}="","",F${row}&"-"&G${row})`;
    item[8] = `=IF(H${row}="","",H${row})`;
    item[10] = `=IF(J${row}="","",J${row})`;
    item[11] = `=IF(B${row}="","",B${row})`;
    item[12] = `=IF(B${row}="","",B${row})`;
    formulas.push(item);
  }
  return formulas;
}

function appsScriptFixture(options = {}) {
  const sheets = new Map();
  const add = (name, rows, maximum, formulas = []) => {
    const sheet = createSheet(name, rows, maximum, formulas);
    sheets.set(name, sheet);
    return sheet;
  };
  add("Навчальні роки", [
    ["ID навчального року", "Навчальний рік", "Дата початку", "Дата завершення", "Статус", "Примітка"],
    ["YR-2026-2027", "2026/2027", new Date("2026-09-01T12:00:00Z"), new Date("2027-08-31T12:00:00Z"), "Активний", ""],
    ["YR-2027-2028", "2027/2028", new Date("2027-09-01T12:00:00Z"), new Date("2028-08-31T12:00:00Z"), "Чернетка", ""],
  ], 200);
  add("Користувачі", [
    ["ID", "ПІБ", "Роль", "Телефон", "Email", "Статус"],
    ["USR-001", "Бібліотекар Тестова", "Бібліотекар / адміністратор", "", actor.email, "Активний"],
    ["USR-002", "Учитель Тестовий", "Учитель", "", "teacher@example.test", "Активний"],
  ], 1000);
  add("Місця", [
    ["ID", "Назва", "Тип", "Статус"],
    ["LOC-001", "Бібліотека", "Бібліотека", "Активний"],
    ["LOC-002", "Кабінет 12", "Кабінет", "Активний"],
    ["LOC-007", "Списано", "Службове", "Активний"],
    ["LOC-008", "Втрачено", "Службове", "Активний"],
  ], 1000);
  add("Матеріали", [
    materialHeaders(),
    ["CAT-0001", "Підручники", "Підручник", "Математика", 1, 1, "Математика 1 клас", "Автор", 2025, "9786170000001", "", "", "", "", "", "", "", "", "", "", "Підручники", 1, "", "Видавець", "9786170000001"],
  ], 1600);
  sheets.get("Матеріали")._state.rows[1][18] = "Математика 1 клас — 1 клас — Автор — 2025 [CAT-0001]";
  add("Обкладинки", [
    ["ID матеріалу", "Обкладинка", "URL"],
    ["CAT-0001", "", ""],
  ], 1600);
  add("Операції", [[
    "ID операції", "Дата", "Матеріал", "Тип", "Звідки", "Куди", "Стан", "Кількість",
    "Статус", "Відповідальний", "Примітки", "ID матеріалу", "ID звідки", "ID куди", "ID відповідального",
    "Request ID застосування (службове)",
  ]], 1000, operationFormulas());
  add("Баланс", [
    ["", "ID матеріалу", "", "ID місця", "Назва місця", "Кількість"],
    ["", "CAT-0001", "", "LOC-001", "Бібліотека", 10],
    ["", "CAT-0001", "", "LOC-002", "Кабінет 12", 2],
    ["", "CAT-0001", "", "LOC-007", "Списано", 0],
    ["", "CAT-0001", "", "LOC-008", "Втрачено", 0],
  ], 25000);
  add("Класні групи", [
    ["ID групи", "Назва групи", "Код", "Статус", "Примітки"],
    ["COH-001", "1-А", "А", "Активна", ""],
  ], 1000);
  const classRows = [
    classYearHeaders(),
    ["CY-2026-001", "YR-2026-2027", "2026/2027", "COH-001", "1-А", 1, "А", "Учитель Тестовий", "USR-002", "Кабінет 12", "LOC-002", "2026-09-01", "2027-08-31", "Активний", "", ""],
  ];
  add("Класи за роками", classRows, 1000, classFormulas(1000));
  add("Початкові залишки", [["ID", "Матеріал", "Місце", "Кількість"]], 2000);

  const properties = new Map([
    ["SPREADSHEET_ID", copySpreadsheetId],
    ["LIBRARIAN_WRITE_MODE", "copy_test"],
  ]);
  const cache = new Map();
  const lockStats = { acquired: 0, released: 0 };
  let flushes = 0;

  const spreadsheet = {
    getSheetByName: (name) => sheets.get(name) ?? null,
    insertSheet(name) {
      if (sheets.has(name)) throw new Error(`Sheet exists: ${name}`);
      const sheet = createSheet(name, [[]], 1000);
      sheets.set(name, sheet);
      return sheet;
    },
    getSpreadsheetTimeZone: () => "Europe/Kyiv",
  };
  const initialBalance = new Map();
  for (const row of sheets.get("Баланс")._state.rows.slice(1)) {
    initialBalance.set(`${row[1]}|${row[3]}`, Number(row[5]) || 0);
  }

  const recalculate = () => {
    const userByName = new Map(sheets.get("Користувачі")._state.rows.slice(1).map((row) => [row[1], row[0]]));
    const locationByName = new Map(sheets.get("Місця")._state.rows.slice(1).map((row) => [row[1], row[0]]));
    const yearById = new Map(sheets.get("Навчальні роки")._state.rows.slice(1).map((row) => [row[0], row]));
    const materialRows = sheets.get("Матеріали")._state.rows;
    for (const material of materialRows.slice(1)) {
      if (!/^CAT-/.test(String(material[0] ?? ""))) continue;
      const classFrom = Number(material[4]) || 0;
      const classTo = Number(material[5]) || classFrom;
      const classLabel = classFrom
        ? (classFrom === classTo ? `${classFrom} клас` : `${classFrom}–${classTo} класи`)
        : "";
      const parts = [material[6], classLabel, material[7], material[8]].filter((value) => display(value).trim());
      material[18] = `${parts.join(" — ")} [${material[0]}]`;
    }
    const cover = sheets.get("Обкладинки")._state;
    for (let row = 2; row <= materialRows.length; row += 1) {
      if (cover.formulas[row - 1]?.[0]) cover.rows[row - 1][0] = materialRows[row - 1]?.[0] ?? "";
    }
    const classState = sheets.get("Класи за роками")._state;
    for (let row = 2; row <= classState.maxRows; row += 1) {
      const values = classState.rows[row - 1] ?? [];
      if (!values[0]) continue;
      const year = yearById.get(values[1]);
      values[2] = year?.[1] ?? "";
      values[4] = values[5] ? `${values[5]}-${values[6]}` : "";
      values[8] = values[7] ? userByName.get(values[7]) ?? "" : "";
      values[10] = values[9] ? locationByName.get(values[9]) ?? "" : "";
      values[11] = year?.[2] ?? "";
      values[12] = year?.[3] ?? "";
    }
    const operations = sheets.get("Операції")._state;
    const balances = new Map(initialBalance);
    const materials = materialRows.slice(1).filter((row) => (
      /^CAT-/.test(String(row[0] ?? ""))
      && (options.expandNewMaterialBalances !== false || row[0] === "CAT-0001")
    ));
    const locations = sheets.get("Місця")._state.rows.slice(1).filter((row) => /^LOC-/.test(String(row[0] ?? "")));
    for (const material of materials) {
      for (const location of locations) {
        const key = `${material[0]}|${location[0]}`;
        if (!balances.has(key)) balances.set(key, 0);
      }
    }
    for (let row = 2; row <= operations.maxRows; row += 1) {
      const values = operations.rows[row - 1] ?? [];
      if (!values.slice(1, 11).some((value) => display(value).trim())) continue;
      const materialId = String(values[2] ?? "").match(/CAT-\d+/)?.[0] ?? "";
      values[0] = `OP-${String(row - 1).padStart(6, "0")}`;
      values[11] = materialId;
      values[12] = values[4] ? locationByName.get(values[4]) ?? "" : "";
      values[13] = values[5] ? locationByName.get(values[5]) ?? "" : "";
      values[14] = values[9] ? userByName.get(values[9]) ?? "" : "";
      const quantity = Number(values[7]) || 0;
      if (values[12]) balances.set(`${materialId}|${values[12]}`, (balances.get(`${materialId}|${values[12]}`) ?? 0) - quantity);
      if (values[13]) balances.set(`${materialId}|${values[13]}`, (balances.get(`${materialId}|${values[13]}`) ?? 0) + quantity);
    }
    const balanceState = sheets.get("Баланс")._state;
    balanceState.rows = [balanceState.rows[0]];
    for (const material of materials) {
      for (const location of locations) {
        balanceState.rows.push(["", material[0], "", location[0], location[1], balances.get(`${material[0]}|${location[0]}`) ?? 0]);
      }
    }
  };

  const scriptProperties = {
    getProperty: (key) => properties.get(key) ?? null,
    setProperty(key, value) {
      const serialized = String(value);
      if (Buffer.byteLength(serialized, "utf8") > 9000) {
        throw new Error("Script Properties per-value quota exceeded");
      }
      properties.set(key, serialized);
      return this;
    },
    deleteProperty(key) { properties.delete(key); return this; },
  };
  const lock = {
    tryLock() { lockStats.acquired += 1; return true; },
    releaseLock() { lockStats.released += 1; },
  };
  const validationBuilder = () => ({
    requireFormulaSatisfied(value) { this.formula = value; return this; },
    requireValueInList(value) { this.list = value; return this; },
    requireValueInRange(value) { this.range = value; return this; },
    setAllowInvalid(value) { this.allowInvalid = value; return this; },
    build() { return { ...this }; },
  });
  const context = vm.createContext({
    CacheService: {
      getScriptCache: () => ({
        get: (key) => cache.get(key) ?? null,
        put: (key, value) => cache.set(key, value),
      }),
    },
    ContentService: {
      MimeType: { JSON: "json" },
      createTextOutput: (text) => ({ text, setMimeType(mime) { this.mime = mime; return this; } }),
    },
    LockService: { getScriptLock: () => lock },
    PropertiesService: { getScriptProperties: () => scriptProperties },
    ScriptApp: {
      getProjectTriggers: () => [],
      newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create() {} }) }) }),
    },
    SpreadsheetApp: {
      CopyPasteType: { PASTE_FORMULA: "formula" },
      openById(id) { assert.ok(id === copySpreadsheetId || id === productionSpreadsheetId); return spreadsheet; },
      flush() { flushes += 1; recalculate(); },
      newDataValidation: validationBuilder,
    },
    UrlFetchApp: { fetch() { throw new Error("Network must not be used in copy_test"); } },
    Utilities: {
      Charset: { UTF_8: "utf8" },
      DigestAlgorithm: { SHA_256: "sha256" },
      base64Decode: (value) => [...Buffer.from(value, "base64")],
      base64Encode: (value) => Buffer.from(typeof value === "string" ? value : value.map((item) => item & 255)).toString("base64"),
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes.map((item) => item & 255)).toString("base64url"),
      computeDigest: (_algorithm, value) => [...createHash("sha256").update(typeof value === "string" ? value : Buffer.from(value.map((item) => item & 255))).digest()],
      computeHmacSha256Signature: (value, secret) => [...createHmac("sha256", secret).update(value).digest()],
      formatDate: (value) => value.toISOString().slice(0, 10),
      newBlob(value) {
        const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value.map((item) => item & 255));
        return {
          getBytes: () => [...bytes],
          getDataAsString: () => bytes.toString("utf8"),
        };
      },
      gzip(blob) {
        const bytes = gzipSync(Buffer.from(blob.getBytes().map((item) => item & 255)));
        return {
          getBytes: () => [...bytes],
          getDataAsString: () => bytes.toString("utf8"),
        };
      },
      ungzip(blob) {
        const bytes = gunzipSync(Buffer.from(blob.getBytes().map((item) => item & 255)));
        return {
          getBytes: () => [...bytes],
          getDataAsString: () => bytes.toString("utf8"),
        };
      },
    },
  });
  return {
    context,
    sheets,
    spreadsheet,
    properties,
    lockStats,
    get flushes() { return flushes; },
  };
}

async function loadAppsScripts(fixture) {
  for (const file of appsScriptFiles) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    vm.runInContext(source, fixture.context, { filename: file });
  }
}

function applyEnvelope(kind, payload, options = {}) {
  return {
    request_id: options.requestId ?? baseRequestId,
    draft_id: options.draftId ?? baseDraftId,
    revision: options.revision ?? 2,
    kind,
    payload,
    actor,
    ...(options.attachment ? { attachment: options.attachment } : {}),
  };
}

function prepareOnly(fixture, envelope) {
  const input = fixture.context.validateApplyEnvelope_(envelope);
  const resolvedActor = fixture.context.resolveGatewayActor_(fixture.spreadsheet, input.actor);
  const plan = fixture.context.prepareGatewayOperationPlan_(fixture.spreadsheet, input, resolvedActor);
  const target = { mode: "copy_test", spreadsheetId: copySpreadsheetId };
  const fingerprint = fixture.context.digestWebSafe_(JSON.stringify({
    draft_id: input.draftId,
    revision: input.revision,
    kind: input.kind,
    payload: input.payload,
    actor: input.actor,
    attachment: fixture.context.attachmentFingerprint_(input.attachment),
    write_mode: target.mode,
    spreadsheet_id: target.spreadsheetId,
  }));
  return fixture.context.prepareApplyJournalEntry_(fixture.spreadsheet, input, fingerprint, target, plan);
}

function academicEnvelope(options = {}) {
  return applyEnvelope("academic-year.create", {
    label: "2028/2029",
    startDate: "2028-09-01",
    endDate: "2029-08-31",
    notes: "Новий навчальний рік",
  }, options);
}

function balanceQuantity(fixture, materialId, locationId) {
  const row = fixture.sheets.get("Баланс")._state.rows.find((item) => item[1] === materialId && item[3] === locationId);
  return Number(row?.[5] ?? NaN);
}

function materialVersion(fixture, materialId) {
  return fixture.context.buildLibrarianMaterialVersions_(fixture.spreadsheet)
    .find((item) => item.id === materialId)?.version ?? "";
}

function classYearVersion(fixture, classYearId) {
  return fixture.context.buildLibrarianClassYearVersions_(fixture.spreadsheet)
    .find((item) => item.id === classYearId)?.version ?? "";
}

function swapSheetDataRows(sheet, leftRow, rightRow) {
  const rows = sheet._state.rows;
  while (rows.length < Math.max(leftRow, rightRow)) rows.push([]);
  [rows[leftRow - 1], rows[rightRow - 1]] = [rows[rightRow - 1], rows[leftRow - 1]];
}

function useLocaleDateDisplay(sheet) {
  const original = sheet.getRange.bind(sheet);
  sheet.getRange = (...args) => {
    const range = original(...args);
    const getDisplayValues = range.getDisplayValues.bind(range);
    range.getDisplayValues = () => {
      const raw = range.getValues();
      const values = getDisplayValues();
      return values.map((row, rowIndex) => row.map((value, columnIndex) => {
        const rawValue = raw[rowIndex][columnIndex];
        if (Object.prototype.toString.call(rawValue) !== "[object Date]") return value;
        const iso = rawValue.toISOString().slice(0, 10);
        return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
      }));
    };
    return range;
  };
}

function seedRepairTemplate(fixture) {
  const materials = fixture.sheets.get("Матеріали");
  for (let row = 327; row <= 426; row += 1) {
    materials.getRange(row, 1).setFormula(`=IFERROR(INDEX($A$427:$A$1212,ROW()-326),"")`);
  }
  const operations = fixture.sheets.get("Операції");
  operations._state.maxRows = 1400;
  operations._state.formulas = operationFormulas(1000);
  operations.getRange(1313, 1).setFormula("=LEGACY_REVISION_BRIDGE()");
  operations.getRange(1313, 2).setValue("LEGACY-SENTINEL");
  return { materials, operations };
}

function seedRolloverSourceClasses(fixture, count) {
  const groups = fixture.sheets.get("Класні групи")._state.rows;
  const classes = fixture.sheets.get("Класи за роками")._state.rows;
  for (let index = 2; index <= count; index += 1) {
    const sequence = String(index).padStart(3, "0");
    const code = `T${sequence}`;
    groups.push([`COH-${sequence}`, `1-${code}`, code, "Активна", ""]);
    classes.push([
      `CY-2026-${sequence}`, "YR-2026-2027", "2026/2027", `COH-${sequence}`,
      `1-${code}`, 1, code, "Учитель Тестовий", "USR-002", "Кабінет 12", "LOC-002",
      "2026-09-01", "2027-08-31", "Активний", "", "",
    ]);
  }
}

test("apply allowlist and input validation cover all eleven fail-closed kinds", () => {
  const expected = [
    "material.create", "material.update", "receipt.create", "transfer.create", "writeoff.create",
    "revision.count", "academic-year.create", "class-year.create", "class-year.update",
    "class-year.close", "academic-year.rollover",
  ];
  assert.deepEqual([...SUPPORTED_DRAFT_APPLY_KINDS], expected);
  expected.forEach((kind) => assert.equal(isSupportedDraftApplyKind(kind), true));
  assert.equal(isSupportedDraftApplyKind("unknown.create"), false);
  assert.equal(validateDraftApplyInput({ id: baseDraftId, revision: 2 }).ok, true);
  assert.equal(validateDraftApplyInput({ id: baseDraftId, revision: 2, requestId: baseRequestId }).ok, false);
  assert.equal(validateDraftApplyInput({ id: baseDraftId, revision: 0 }).ok, false);
});

test("configuration gates fail closed without creating a durable request", async () => {
  const fixture = appsScriptFixture();
  await loadAppsScripts(fixture);
  const disabled = fixture.context.applyGatewayDraft_(academicEnvelope());
  assert.equal(disabled.code, "writes_disabled");
  assert.equal(disabled.retryable, true);
  assert.equal(fixture.sheets.has("Журнал застосувань"), false);

  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  fixture.properties.delete("SPREADSHEET_ID");
  const missing = fixture.context.applyGatewayDraft_(academicEnvelope());
  assert.equal(missing.code, "invalid_spreadsheet_id");
  fixture.properties.set("SPREADSHEET_ID", productionSpreadsheetId);
  const unsafe = fixture.context.applyGatewayDraft_(academicEnvelope());
  assert.equal(unsafe.code, "unsafe_write_target");
  assert.equal(fixture.sheets.has("Журнал застосувань"), false);
});

test("reference data emits ISO dates even when Sheets displays locale-formatted dates", async () => {
  const fixture = appsScriptFixture();
  const years = fixture.sheets.get("Навчальні роки");
  const classes = fixture.sheets.get("Класи за роками");
  classes._state.rows[1][11] = new Date("2026-09-01T12:00:00Z");
  classes._state.rows[1][12] = new Date("2027-08-31T12:00:00Z");
  classes._state.rows[1][14] = new Date("2027-06-30T12:00:00Z");
  useLocaleDateDisplay(years);
  useLocaleDateDisplay(classes);
  await loadAppsScripts(fixture);

  const reference = fixture.context.buildLibrarianReferenceData_();
  assert.equal(reference.academicYears[0].startDate, "2026-09-01");
  assert.equal(reference.academicYears[0].endDate, "2027-08-31");
  assert.equal(reference.classYears[0].startDate, "2026-09-01");
  assert.equal(reference.classYears[0].endDate, "2027-08-31");
  assert.equal(reference.classYears[0].actualClosedDate, "2027-06-30");
});

test("academic-year apply is journaled, replayed, and target-bound", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(fixture);
  const first = fixture.context.applyGatewayDraft_(academicEnvelope());
  assert.equal(first.success, true);
  assert.equal(first.result.entity_ids.academicYearId, "YR-2028-2029");
  assert.equal(first.result.mutations[0].sheet, "Навчальні роки");
  const rows = fixture.sheets.get("Навчальні роки")._state.rows;
  assert.equal(rows.filter((row) => row[0] === "YR-2028-2029").length, 1);
  const journal = fixture.sheets.get("Журнал застосувань");
  assert.equal(journal._state.hidden, true);
  assert.equal(journal._state.rows[1][6], "applied");

  const replay = fixture.context.applyGatewayDraft_(academicEnvelope());
  assert.deepEqual(JSON.parse(JSON.stringify(replay)), JSON.parse(JSON.stringify(first)));
  assert.equal(rows.filter((row) => row[0] === "YR-2028-2029").length, 1);

  fixture.properties.set("LIBRARIAN_WRITE_MODE", "production");
  fixture.properties.set("SPREADSHEET_ID", productionSpreadsheetId);
  const conflict = fixture.context.applyGatewayDraft_(academicEnvelope());
  assert.equal(conflict.code, "request_id_conflict");
});

test("crash after domain writes resumes from applying journal without a duplicate", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  fixture.properties.set("GATEWAY_TEST_FAIL_AFTER_MUTATIONS", "once");
  await loadAppsScripts(fixture);
  assert.throws(
    () => fixture.context.applyGatewayDraft_(academicEnvelope()),
    /Injected copy-test crash/,
  );
  const rows = fixture.sheets.get("Навчальні роки")._state.rows;
  assert.equal(rows.filter((row) => row[0] === "YR-2028-2029").length, 1);
  assert.equal(fixture.sheets.get("Журнал застосувань")._state.rows[1][6], "applying");
  const replay = fixture.context.applyGatewayDraft_(academicEnvelope());
  assert.equal(replay.success, true);
  assert.equal(rows.filter((row) => row[0] === "YR-2028-2029").length, 1);
  assert.equal(fixture.sheets.get("Журнал застосувань")._state.rows[1][6], "applied");
});

test("material create allocates canonical CAT, preserves formulas, creates cover index and initial receipt", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(fixture);
  const envelope = applyEnvelope("material.create", {
    title: "Українська мова 2 клас",
    rubric: "Підручники і хрестоматії",
    publicationType: "Підручник",
    subject: "Українська мова",
    classFrom: 2,
    classTo: 2,
    author: "Авторка",
    year: 2026,
    isbn: "978-617-00-0002-8",
    publisher: "Видавництво",
    coverSourceUrl: "https://example.test/cover.png",
    coverConfirmed: true,
    initialReceipt: {
      quantity: 5,
      locationId: "LOC-001",
      locationName: "Бібліотека",
      date: "2026-08-10",
      condition: "Придатний",
      documentNumber: "Н-1",
    },
  });
  const result = fixture.context.applyGatewayDraft_(envelope);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.result.entity_ids.materialId, "CAT-0002");
  assert.match(result.result.entity_ids.operationId, /^OP-/);
  assert.equal(result.result.cover.status, "copy_test_validated");
  const material = fixture.sheets.get("Матеріали")._state;
  assert.equal(material.rows[2][0], "CAT-0002");
  assert.equal(material.rows[2][6], "Українська мова 2 клас");
  assert.equal(material.rows[2][23], "Видавництво");
  assert.equal(material.rows[2][10], "");
  assert.equal(material.rows[2][11], "");
  assert.equal(balanceQuantity(fixture, "CAT-0002", "LOC-001"), 5);
  assert.equal(
    fixture.sheets.get("Операції")._state.rows[1][2],
    material.rows[2][18],
  );
  const cover = fixture.sheets.get("Обкладинки")._state;
  assert.equal(cover.rows[2][0], "CAT-0002");
  assert.equal(cover.rows[2][2] ?? "", "");
  assert.equal(cover.formulas[2][0], "=IF('Матеріали'!A3=\"\";\"\";'Матеріали'!A3)");
  assert.equal(cover.formulas[2][1], "=IF(C3=\"\";\"\";IMAGE(C3))");

  const replay = fixture.context.applyGatewayDraft_(envelope);
  assert.equal(replay.success, true);
  assert.equal(material.rows.filter((row) => row[0] === "CAT-0002").length, 1);
  assert.equal(balanceQuantity(fixture, "CAT-0002", "LOC-001"), 5);
});

test("cover index repairs legacy comma formulas and rejects unrelated formulas", async () => {
  const fixture = appsScriptFixture();
  await loadAppsScripts(fixture);
  const cover = fixture.sheets.get("Обкладинки")._state;
  fixture.sheets.get("Матеріали")._state.rows[2] = ["CAT-0002"];
  cover.rows[2] = ["#ERROR!", "#ERROR!", ""];
  cover.formulas[2] = [
    "=IF('Матеріали'!A3=\"\",\"\",'Матеріали'!A3)",
    "=IF(C3=\"\",\"\",IMAGE(C3))",
    "",
  ];

  fixture.context.writeCoverIndexRow_(fixture.sheets.get("Обкладинки"), 3, "CAT-0002");
  fixture.context.SpreadsheetApp.flush();
  fixture.context.verifyCoverIndexRow_(fixture.sheets.get("Обкладинки"), 3, "CAT-0002");

  assert.equal(cover.rows[2][0], "CAT-0002");
  assert.equal(cover.formulas[2][0], "=IF('Матеріали'!A3=\"\";\"\";'Матеріали'!A3)");
  assert.equal(cover.formulas[2][1], "=IF(C3=\"\";\"\";IMAGE(C3))");

  cover.rows[3] = ["", "", ""];
  cover.formulas[3] = ["=OTHER_SHEET!A4", "", ""];
  assert.throws(
    () => fixture.context.writeCoverIndexRow_(fixture.sheets.get("Обкладинки"), 4, "CAT-0003"),
    /Рядок обкладинки вже належить іншому матеріалу/,
  );
  assert.equal(cover.formulas[3][0], "=OTHER_SHEET!A4");
});

test("an applying material request repairs a locale-broken checkpointed cover row", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(fixture);
  const envelope = applyEnvelope("material.create", {
    title: "Матеріал із відновленою обкладинкою",
    rubric: "Підручники",
  }, { requestId: uuidFrom(64), draftId: uuidFrom(164) });

  const first = fixture.context.applyGatewayDraft_(envelope);
  assert.equal(first.success, true, JSON.stringify(first));
  const cover = fixture.sheets.get("Обкладинки")._state;
  cover.rows[2] = ["#ERROR!", "#ERROR!", ""];
  cover.formulas[2] = [
    "=IF('Матеріали'!A3=\"\",\"\",'Матеріали'!A3)",
    "=IF(C3=\"\",\"\",IMAGE(C3))",
    "",
  ];
  const journalSheet = fixture.sheets.get("Журнал застосувань");
  journalSheet._state.rows[1][6] = "applying";
  const journal = fixture.context.readApplyJournalEntry_(journalSheet, 2);

  const resumed = fixture.context.executeMaterialCreate_(fixture.spreadsheet, journal);
  assert.equal(resumed.status, "applied");
  assert.equal(cover.rows[2][0], "CAT-0002");
  assert.equal(cover.formulas[2][0], "=IF('Матеріали'!A3=\"\";\"\";'Матеріали'!A3)");
  assert.equal(cover.formulas[2][1], "=IF(C3=\"\";\"\";IMAGE(C3))");
});

test("material create remains resumable when balance formulas do not expand for the new CAT", async () => {
  const fixtureOptions = { expandNewMaterialBalances: false };
  const fixture = appsScriptFixture(fixtureOptions);
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(fixture);
  const envelope = applyEnvelope("material.create", {
    title: "Матеріал без рядка балансу",
    rubric: "Підручники",
  }, { requestId: uuidFrom(23), draftId: uuidFrom(123) });

  const blocked = fixture.context.applyGatewayDraft_(envelope);
  assert.equal(blocked.success, false);
  assert.equal(blocked.code, "balance_missing");
  assert.equal(blocked.retryable, true);
  assert.equal(blocked.outcome_known, false);
  assert.equal(fixture.sheets.get("Журнал застосувань")._state.rows[1][6], "applying");
  assert.equal(fixture.sheets.get("Матеріали")._state.rows.filter((row) => row[0] === "CAT-0002").length, 1);

  fixtureOptions.expandNewMaterialBalances = true;
  const replay = fixture.context.applyGatewayDraft_(envelope);
  assert.equal(replay.success, true, JSON.stringify(replay));
  assert.equal(fixture.sheets.get("Матеріали")._state.rows.filter((row) => row[0] === "CAT-0002").length, 1);
});

test("material create adopts its CAT row after a sort and creates one initial receipt", async () => {
  const fixtureOptions = { expandNewMaterialBalances: false };
  const fixture = appsScriptFixture(fixtureOptions);
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(fixture);
  const envelope = applyEnvelope("material.create", {
    title: "Матеріал після сортування",
    rubric: "Підручники",
    initialReceipt: {
      quantity: 2,
      locationId: "LOC-001",
      locationName: "Бібліотека",
      date: "2026-08-10",
      condition: "Придатний",
    },
  }, { requestId: uuidFrom(35), draftId: uuidFrom(135) });

  const interrupted = fixture.context.applyGatewayDraft_(envelope);
  assert.equal(interrupted.code, "balance_missing");
  swapSheetDataRows(fixture.sheets.get("Матеріали"), 3, 4);
  fixtureOptions.expandNewMaterialBalances = true;

  const replay = fixture.context.applyGatewayDraft_(envelope);
  assert.equal(replay.success, true, JSON.stringify(replay));
  const materials = fixture.sheets.get("Матеріали")._state.rows;
  assert.equal(materials.filter((row) => row[0] === "CAT-0002").length, 1);
  assert.equal(materials[3][0], "CAT-0002");
  assert.equal(fixture.sheets.get("Обкладинки")._state.rows[3][0], "CAT-0002");
  assert.equal(fixture.sheets.get("Операції")._state.rows.filter((row) => row[15] === envelope.request_id).length, 1);
  assert.equal(balanceQuantity(fixture, "CAT-0002", "LOC-001"), 2);
});

test("prepared journal reservations prevent CAT reuse across interleaved material creates", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(fixture);
  const firstEnvelope = applyEnvelope("material.create", {
    title: "Перший зарезервований матеріал",
    rubric: "Підручники",
    initialReceipt: {
      quantity: 1, locationId: "LOC-001", locationName: "Бібліотека",
      date: "2026-08-10", condition: "Придатний",
    },
  }, { requestId: uuidFrom(46), draftId: uuidFrom(146) });
  const prepared = prepareOnly(fixture, firstEnvelope);
  assert.equal(prepared.plan.material_id, "CAT-0002");
  assert.equal(fixture.sheets.get("Матеріали")._state.rows.some((row) => row[0] === "CAT-0002"), false);

  const secondEnvelope = applyEnvelope("material.create", {
    title: "Другий матеріал",
    rubric: "Підручники",
    initialReceipt: {
      quantity: 2, locationId: "LOC-001", locationName: "Бібліотека",
      date: "2026-08-10", condition: "Придатний",
    },
  }, { requestId: uuidFrom(47), draftId: uuidFrom(147) });
  const second = fixture.context.applyGatewayDraft_(secondEnvelope);
  assert.equal(second.success, true, JSON.stringify(second));
  assert.equal(second.result.entity_ids.materialId, "CAT-0003");

  const first = fixture.context.applyGatewayDraft_(firstEnvelope);
  assert.equal(first.success, true, JSON.stringify(first));
  assert.equal(first.result.entity_ids.materialId, "CAT-0002");
  const materials = fixture.sheets.get("Матеріали")._state.rows;
  assert.equal(materials.filter((row) => row[0] === "CAT-0002").length, 1);
  assert.equal(materials.filter((row) => row[0] === "CAT-0003").length, 1);
  assert.equal(balanceQuantity(fixture, "CAT-0002", "LOC-001"), 1);
  assert.equal(balanceQuantity(fixture, "CAT-0003", "LOC-001"), 2);
});

test("material create reconciles a gateway conflict after CAT checkpoints without duplicate receipt", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(fixture);
  const envelope = applyEnvelope("material.create", {
    title: "Читанка 3 клас",
    rubric: "Підручники",
    initialReceipt: {
      quantity: 2,
      locationId: "LOC-001",
      locationName: "Бібліотека",
      date: "2026-08-10",
      condition: "Придатний",
    },
  }, { requestId: uuidFrom(24), draftId: uuidFrom(124) });
  const originalExecute = fixture.context.executeOperationRowPlan_;
  let inject = true;
  fixture.context.executeOperationRowPlan_ = function (...args) {
    if (inject && args[3] === "initial_receipt") {
      inject = false;
      throw fixture.context.gatewayApplyError_("operation_row_conflict", "Injected receipt conflict");
    }
    return originalExecute(...args);
  };

  const interrupted = fixture.context.applyGatewayDraft_(envelope);
  assert.equal(interrupted.success, false);
  assert.equal(interrupted.retryable, true);
  assert.equal(interrupted.outcome_known, false);
  assert.equal(fixture.sheets.get("Журнал застосувань")._state.rows[1][6], "applying");
  fixture.context.executeOperationRowPlan_ = originalExecute;

  const replay = fixture.context.applyGatewayDraft_(envelope);
  assert.equal(replay.success, true, JSON.stringify(replay));
  assert.equal(fixture.sheets.get("Матеріали")._state.rows.filter((row) => row[0] === "CAT-0002").length, 1);
  assert.equal(fixture.sheets.get("Операції")._state.rows.filter((row) => row[2]?.includes?.("CAT-0002")).length, 1);
  assert.equal(balanceQuantity(fixture, "CAT-0002", "LOC-001"), 2);
});

test("material update accepts a signed private image but never writes the temporary key", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(fixture);
  const bytes = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 255, 217]);
  const key = "covers/private/test-cover.jpg";
  const attachment = {
    key,
    contentType: "image/jpeg",
    originalName: "cover.jpg",
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    base64: bytes.toString("base64"),
  };
  const reviewedVersion = materialVersion(fixture, "CAT-0001");
  const result = fixture.context.applyGatewayDraft_(applyEnvelope("material.update", {
    materialId: "CAT-0001",
    expectedVersion: reviewedVersion,
    changes: {
      title: "Математика 1 клас — виправлено",
      coverPhotoKey: key,
      coverPhotoName: "cover.jpg",
      coverConfirmed: true,
    },
  }, { requestId: uuidFrom(2), draftId: uuidFrom(102), attachment }));
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.result.cover.status, "copy_test_validated");
  const material = fixture.sheets.get("Матеріали")._state.rows[1];
  assert.equal(material[6], "Математика 1 клас — виправлено");
  assert.equal(material[10], "");
  assert.equal(material.includes(key), false);

  const stale = fixture.context.applyGatewayDraft_(applyEnvelope("material.update", {
    materialId: "CAT-0001",
    expectedVersion: reviewedVersion,
    changes: { title: "Застаріле перезаписування" },
  }, { requestId: uuidFrom(22), draftId: uuidFrom(122) }));
  assert.equal(stale.success, false);
  assert.equal(stale.code, "stale_material");
  assert.equal(material[6], "Математика 1 клас — виправлено");
});

test("material update distinguishes a pre-write stale race from a post-write resumable conflict", async () => {
  const staleFixture = appsScriptFixture();
  staleFixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(staleFixture);
  const staleEnvelope = applyEnvelope("material.update", {
    materialId: "CAT-0001",
    expectedVersion: materialVersion(staleFixture, "CAT-0001"),
    changes: { title: "Запитане оновлення" },
  }, { requestId: uuidFrom(36), draftId: uuidFrom(136) });
  const originalDispatch = staleFixture.context.dispatchSafeApply_;
  staleFixture.context.dispatchSafeApply_ = function (...args) {
    staleFixture.sheets.get("Матеріали").getRange(2, 7).setValue("Зовнішня зміна перед записом");
    return originalDispatch(...args);
  };
  const stale = staleFixture.context.applyGatewayDraft_(staleEnvelope);
  assert.equal(stale.code, "stale_material");
  assert.equal(stale.retryable, false);
  assert.equal(stale.outcome_known, true);
  assert.equal(staleFixture.sheets.get("Матеріали")._state.rows[1][6], "Зовнішня зміна перед записом");
  assert.equal(staleFixture.sheets.get("Журнал застосувань")._state.rows[1][6], "failed");

  const resumeFixture = appsScriptFixture();
  resumeFixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(resumeFixture);
  const resumeEnvelope = applyEnvelope("material.update", {
    materialId: "CAT-0001",
    expectedVersion: materialVersion(resumeFixture, "CAT-0001"),
    changes: { title: "Підтверджене оновлення" },
  }, { requestId: uuidFrom(37), draftId: uuidFrom(137) });
  const originalCheckpoint = resumeFixture.context.checkpointApplyJournal_;
  let inject = true;
  resumeFixture.context.checkpointApplyJournal_ = function (journal, step) {
    if (inject && step === "material_update") {
      inject = false;
      throw resumeFixture.context.gatewayApplyError_("post_write_probe", "Injected after material write");
    }
    return originalCheckpoint(journal, step);
  };
  const interrupted = resumeFixture.context.applyGatewayDraft_(resumeEnvelope);
  assert.equal(interrupted.code, "post_write_probe");
  assert.equal(interrupted.retryable, true);
  assert.equal(interrupted.outcome_known, false);
  assert.equal(resumeFixture.sheets.get("Матеріали")._state.rows[1][6], "Підтверджене оновлення");
  resumeFixture.context.checkpointApplyJournal_ = originalCheckpoint;
  const replay = resumeFixture.context.applyGatewayDraft_(resumeEnvelope);
  assert.equal(replay.success, true, JSON.stringify(replay));
  assert.equal(resumeFixture.sheets.get("Матеріали")._state.rows.filter((row) => row[0] === "CAT-0001").length, 1);
});

test("receipt, transfer, writeoff and zero-difference revision preserve formulas and exact balance", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(fixture);
  const apply = (kind, payload, number) => fixture.context.applyGatewayDraft_(
    applyEnvelope(kind, payload, { requestId: uuidFrom(number), draftId: uuidFrom(100 + number) }),
  );
  assert.equal(apply("receipt.create", {
    materialId: "CAT-0001", quantity: 3, locationId: "LOC-001", locationName: "Бібліотека",
    condition: "Придатний", date: "2026-08-10",
  }, 3).success, true);
  assert.equal(balanceQuantity(fixture, "CAT-0001", "LOC-001"), 13);
  assert.equal(apply("transfer.create", {
    materialId: "CAT-0001", quantity: 4,
    fromLocationId: "LOC-001", fromLocationName: "Бібліотека",
    toLocationId: "LOC-002", toLocationName: "Кабінет 12",
    observedAvailableQuantity: 13, condition: "Придатний", date: "2026-08-10",
  }, 4).success, true);
  assert.equal(balanceQuantity(fixture, "CAT-0001", "LOC-001"), 9);
  assert.equal(balanceQuantity(fixture, "CAT-0001", "LOC-002"), 6);
  assert.equal(apply("writeoff.create", {
    materialId: "CAT-0001", quantity: 2,
    fromLocationId: "LOC-002", fromLocationName: "Кабінет 12",
    destination: "written_off", reason: "worn", condition: "Пошкоджений",
    observedAvailableQuantity: 6, date: "2026-08-10",
  }, 5).success, true);
  assert.equal(balanceQuantity(fixture, "CAT-0001", "LOC-002"), 4);
  assert.equal(balanceQuantity(fixture, "CAT-0001", "LOC-007"), 2);
  const revision = apply("revision.count", {
    materialId: "CAT-0001", locationId: "LOC-001", locationName: "Бібліотека",
    countedQuantity: 9, expectedQuantity: 9, sessionId: "REV-1", date: "2026-08-10",
  }, 6);
  assert.equal(revision.success, true);
  assert.equal(Object.hasOwn(revision.result.entity_ids, "operationId"), false);
  assert.equal(fixture.sheets.get("Журнал ревізій")._state.rows[1][7], 0);
  const operations = fixture.sheets.get("Операції")._state;
  for (let row = 2; row <= 4; row += 1) {
    [1, 12, 13, 14, 15].forEach((column) => assert.ok(operations.formulas[row - 1][column - 1]));
  }
});

test("operation request identity is written first and survives a sorted-row retry", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(fixture);
  const envelope = applyEnvelope("receipt.create", {
    materialId: "CAT-0001", quantity: 1,
    locationId: "LOC-001", locationName: "Бібліотека",
    condition: "Придатний", date: "2026-08-10",
  }, { requestId: uuidFrom(38), draftId: uuidFrom(138) });
  const originalCheckpoint = fixture.context.checkpointApplyJournal_;
  let inject = true;
  fixture.context.checkpointApplyJournal_ = function (journal, step) {
    originalCheckpoint(journal, step);
    if (inject && step === "operation:identity_written") {
      inject = false;
      throw new Error("Injected after operation identity");
    }
  };

  assert.throws(() => fixture.context.applyGatewayDraft_(envelope), /Injected after operation identity/);
  const operations = fixture.sheets.get("Операції")._state.rows;
  assert.equal(operations[1][15], envelope.request_id);
  assert.ok(operations[1].slice(1, 11).every((value) => !display(value).trim()));
  swapSheetDataRows(fixture.sheets.get("Операції"), 2, 3);
  fixture.context.checkpointApplyJournal_ = originalCheckpoint;

  const replay = fixture.context.applyGatewayDraft_(envelope);
  assert.equal(replay.success, true, JSON.stringify(replay));
  assert.equal(replay.result.entity_ids.operationId, "OP-000002");
  assert.equal(operations.filter((row) => row[15] === envelope.request_id).length, 1);
  assert.equal(balanceQuantity(fixture, "CAT-0001", "LOC-001"), 11);
});

test("an exact marked operation reconciles after later operations change aggregate balance", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(fixture);
  const firstEnvelope = applyEnvelope("receipt.create", {
    materialId: "CAT-0001", quantity: 1,
    locationId: "LOC-001", locationName: "Бібліотека",
    condition: "Придатний", date: "2026-08-10",
  }, { requestId: uuidFrom(39), draftId: uuidFrom(139) });
  const originalCheckpoint = fixture.context.checkpointApplyJournal_;
  let inject = true;
  fixture.context.checkpointApplyJournal_ = function (journal, step) {
    originalCheckpoint(journal, step);
    if (inject && step === "operation:row_written") {
      inject = false;
      throw new Error("Injected after operation row");
    }
  };
  assert.throws(() => fixture.context.applyGatewayDraft_(firstEnvelope), /Injected after operation row/);
  assert.equal(balanceQuantity(fixture, "CAT-0001", "LOC-001"), 11);
  fixture.context.checkpointApplyJournal_ = originalCheckpoint;

  const second = fixture.context.applyGatewayDraft_(applyEnvelope("receipt.create", {
    materialId: "CAT-0001", quantity: 2,
    locationId: "LOC-001", locationName: "Бібліотека",
    condition: "Придатний", date: "2026-08-10",
  }, { requestId: uuidFrom(40), draftId: uuidFrom(140) }));
  assert.equal(second.success, true, JSON.stringify(second));
  assert.equal(balanceQuantity(fixture, "CAT-0001", "LOC-001"), 13);

  const replay = fixture.context.applyGatewayDraft_(firstEnvelope);
  assert.equal(replay.success, true, JSON.stringify(replay));
  assert.equal(balanceQuantity(fixture, "CAT-0001", "LOC-001"), 13);
  const operations = fixture.sheets.get("Операції")._state.rows;
  assert.equal(operations.filter((row) => row[15] === firstEnvelope.request_id).length, 1);
  assert.equal(operations.filter((row) => row[15] === second.request_id).length, 1);
});

test("formula loss and stale stock reject before an operation write", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  fixture.sheets.get("Операції")._state.formulas[1][0] = "";
  await loadAppsScripts(fixture);
  const failed = fixture.context.applyGatewayDraft_(applyEnvelope("receipt.create", {
    materialId: "CAT-0001", quantity: 1, locationId: "LOC-001", locationName: "Бібліотека",
    date: "2026-08-10",
  }, { requestId: uuidFrom(7), draftId: uuidFrom(107) }));
  assert.equal(failed.success, false);
  assert.equal(failed.code, "formula_missing");
  assert.ok(fixture.sheets.get("Операції")._state.rows[1].slice(1, 11).every((value) => !display(value).trim()));

  fixture.sheets.get("Операції")._state.formulas[1][0] = `=IF(B2="";"";"OP-"&TEXT(ROW()-1;"000000"))`;
  const stale = fixture.context.applyGatewayDraft_(applyEnvelope("transfer.create", {
    materialId: "CAT-0001", quantity: 1,
    fromLocationId: "LOC-001", fromLocationName: "Бібліотека",
    toLocationId: "LOC-002", toLocationName: "Кабінет 12",
    observedAvailableQuantity: 999, date: "2026-08-10",
  }, { requestId: uuidFrom(8), draftId: uuidFrom(108) }));
  assert.equal(stale.code, "stale_stock");

  const missingTransferSnapshot = fixture.context.applyGatewayDraft_(applyEnvelope("transfer.create", {
    materialId: "CAT-0001", quantity: 1,
    fromLocationId: "LOC-001", fromLocationName: "Бібліотека",
    toLocationId: "LOC-002", toLocationName: "Кабінет 12", date: "2026-08-10",
  }, { requestId: uuidFrom(18), draftId: uuidFrom(118) }));
  assert.equal(missingTransferSnapshot.code, "stock_snapshot_missing");

  const missingRevisionSnapshot = fixture.context.applyGatewayDraft_(applyEnvelope("revision.count", {
    materialId: "CAT-0001", locationId: "LOC-001", locationName: "Бібліотека",
    countedQuantity: 10, date: "2026-08-10",
  }, { requestId: uuidFrom(19), draftId: uuidFrom(119) }));
  assert.equal(missingRevisionSnapshot.code, "stock_snapshot_missing");
});

test("wrong nonempty service formulas fail closed before operation or class writes", async () => {
  const operationFixture = appsScriptFixture();
  operationFixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  operationFixture.sheets.get("Операції").getRange(2, 12).setFormula("=C999");
  await loadAppsScripts(operationFixture);
  const operation = operationFixture.context.applyGatewayDraft_(applyEnvelope("receipt.create", {
    materialId: "CAT-0001", quantity: 1,
    locationId: "LOC-001", locationName: "Бібліотека", date: "2026-08-10",
  }, { requestId: uuidFrom(29), draftId: uuidFrom(129) }));
  assert.equal(operation.code, "operation_formula_template_invalid");
  assert.ok(operationFixture.sheets.get("Операції")._state.rows[1].slice(1, 11).every((value) => !display(value).trim()));

  const classFixture = appsScriptFixture();
  classFixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  classFixture.sheets.get("Класи за роками").getRange(3, 9).setFormula("=H999");
  await loadAppsScripts(classFixture);
  const classResult = classFixture.context.applyGatewayDraft_(applyEnvelope("class-year.create", {
    academicYearId: "YR-2027-2028", cohortMode: "existing", cohortId: "COH-001",
    grade: 2, code: "А", teacherUserId: "USR-002", teacherName: "Учитель Тестовий",
    locationId: "LOC-002", locationName: "Кабінет 12",
  }, { requestId: uuidFrom(30), draftId: uuidFrom(130) }));
  assert.equal(classResult.code, "class_formula_mismatch");
  assert.equal(classFixture.sheets.get("Класи за роками")._state.rows.filter((row) => row[0] === "CY-2027-001").length, 0);
});

test("class snapshot includes formula-derived teacher and location IDs", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(fixture);
  const reviewedVersion = classYearVersion(fixture, "CY-2026-001");
  fixture.sheets.get("Класи за роками")._state.rows[1][8] = "USR-999";
  const stale = fixture.context.applyGatewayDraft_(applyEnvelope("class-year.update", {
    classYearId: "CY-2026-001",
    academicYearId: "YR-2026-2027",
    expectedVersion: reviewedVersion,
    changes: { notes: "Не можна перезаписати" },
  }, { requestId: uuidFrom(31), draftId: uuidFrom(131) }));
  assert.equal(stale.code, "stale_class_year");
  assert.equal(stale.retryable, false);
  assert.equal(fixture.sheets.get("Журнал застосувань").getLastRow(), 1);
});

test("nonzero revision creates one confirmed correction and one durable audit row", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(fixture);
  const envelope = applyEnvelope("revision.count", {
    materialId: "CAT-0001",
    locationId: "LOC-001",
    locationName: "Бібліотека",
    countedQuantity: 8,
    expectedQuantity: 10,
    sessionId: "REV-2",
    date: "2026-08-10",
    notes: "Контрольний перерахунок",
  }, { requestId: uuidFrom(11), draftId: uuidFrom(111) });
  const result = fixture.context.applyGatewayDraft_(envelope);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.match(result.result.entity_ids.operationId, /^OP-/);
  assert.equal(balanceQuantity(fixture, "CAT-0001", "LOC-001"), 8);
  assert.equal(balanceQuantity(fixture, "CAT-0001", "LOC-007"), 2);
  const operation = fixture.sheets.get("Операції")._state.rows[1];
  assert.equal(operation[3], "Коригування");
  assert.equal(operation[4], "Бібліотека");
  assert.equal(operation[5], "Списано");
  assert.equal(operation[8], "Підтверджено");
  const audit = fixture.sheets.get("Журнал ревізій")._state.rows[1];
  assert.equal(audit[2], "CAT-0001");
  assert.equal(audit[7], -2);
  const replay = fixture.context.applyGatewayDraft_(envelope);
  assert.equal(replay.success, true);
  assert.equal(fixture.sheets.get("Журнал ревізій")._state.rows.length, 2);
  assert.equal(balanceQuantity(fixture, "CAT-0001", "LOC-001"), 8);
});

test("revision adopts a new audit row when the planned append target is occupied after correction", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(fixture);
  const originalExecute = fixture.context.executeOperationRowPlan_;
  let inject = true;
  fixture.context.executeOperationRowPlan_ = function (...args) {
    const result = originalExecute(...args);
    if (inject && args[3] === "revision_operation") {
      inject = false;
      const audit = fixture.context.ensureRevisionJournalSheet_(fixture.spreadsheet);
      audit.getRange(2, 1).setValue("foreign-request");
    }
    return result;
  };
  const result = fixture.context.applyGatewayDraft_(applyEnvelope("revision.count", {
    materialId: "CAT-0001",
    locationId: "LOC-001",
    locationName: "Бібліотека",
    countedQuantity: 9,
    expectedQuantity: 10,
    date: "2026-08-10",
  }, { requestId: uuidFrom(28), draftId: uuidFrom(128) }));
  assert.equal(result.success, true, JSON.stringify(result));
  const auditRows = fixture.sheets.get("Журнал ревізій")._state.rows;
  assert.equal(auditRows[1][0], "foreign-request");
  assert.equal(auditRows[2][0], uuidFrom(28));
  assert.equal(fixture.sheets.get("Операції")._state.rows.filter((row) => row[3] === "Коригування").length, 1);
});

test("revision audit is adopted by request ID after a sort between write and checkpoint", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(fixture);
  const envelope = applyEnvelope("revision.count", {
    materialId: "CAT-0001",
    locationId: "LOC-001",
    locationName: "Бібліотека",
    countedQuantity: 9,
    expectedQuantity: 10,
    date: "2026-08-10",
  }, { requestId: uuidFrom(41), draftId: uuidFrom(141) });
  const originalCheckpoint = fixture.context.checkpointApplyJournal_;
  let inject = true;
  fixture.context.checkpointApplyJournal_ = function (journal, step) {
    if (inject && step === "revision_journal") {
      inject = false;
      throw fixture.context.gatewayApplyError_("revision_checkpoint_probe", "Injected after revision audit write");
    }
    return originalCheckpoint(journal, step);
  };

  const interrupted = fixture.context.applyGatewayDraft_(envelope);
  assert.equal(interrupted.code, "revision_checkpoint_probe");
  assert.equal(interrupted.outcome_known, false);
  const auditSheet = fixture.sheets.get("Журнал ревізій");
  swapSheetDataRows(auditSheet, 2, 3);
  fixture.context.checkpointApplyJournal_ = originalCheckpoint;

  const replay = fixture.context.applyGatewayDraft_(envelope);
  assert.equal(replay.success, true, JSON.stringify(replay));
  assert.equal(auditSheet._state.rows.filter((row) => row[0] === envelope.request_id).length, 1);
  assert.equal(auditSheet._state.rows[2][0], envelope.request_id);
  assert.equal(fixture.sheets.get("Операції")._state.rows.filter((row) => row[15] === envelope.request_id).length, 1);
});

test("class create, update with null directory pairs, and close preserve formula columns", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(fixture);
  const created = fixture.context.applyGatewayDraft_(applyEnvelope("class-year.create", {
    academicYearId: "YR-2027-2028",
    cohortMode: "new",
    grade: 1,
    code: "Б",
    teacherUserId: "USR-002",
    teacherName: "Учитель Тестовий",
    locationId: "LOC-002",
    locationName: "Кабінет 12",
    notes: "Новий клас",
  }, { requestId: uuidFrom(12), draftId: uuidFrom(112) }));
  assert.equal(created.success, true, JSON.stringify(created));
  assert.equal(created.result.entity_ids.cohortId, "COH-002");
  assert.equal(created.result.entity_ids.classYearId, "CY-2027-001");
  const classSheet = fixture.sheets.get("Класи за роками")._state;
  const createdRow = classSheet.rows.findIndex((row) => row[0] === "CY-2027-001") + 1;
  assert.equal(classSheet.rows[createdRow - 1][8], "USR-002");
  assert.equal(classSheet.rows[createdRow - 1][10], "LOC-002");
  [3, 5, 9, 11, 12, 13].forEach((column) => assert.ok(classSheet.formulas[createdRow - 1][column - 1]));

  const updated = fixture.context.applyGatewayDraft_(applyEnvelope("class-year.update", {
    classYearId: "CY-2027-001",
    academicYearId: "YR-2027-2028",
    expectedVersion: classYearVersion(fixture, "CY-2027-001"),
    changes: {
      grade: 2,
      code: "Б",
      teacherUserId: null,
      teacherName: null,
      locationId: null,
      locationName: null,
      notes: "Без закріпленого кабінету",
    },
    reason: "Уточнення на початку року",
  }, { requestId: uuidFrom(13), draftId: uuidFrom(113) }));
  assert.equal(updated.success, true, JSON.stringify(updated));
  assert.equal(classSheet.rows[createdRow - 1][5], 2);
  assert.equal(classSheet.rows[createdRow - 1][7], "");
  assert.equal(classSheet.rows[createdRow - 1][8], "");
  assert.equal(classSheet.rows[createdRow - 1][9], "");
  assert.equal(classSheet.rows[createdRow - 1][10], "");

  const closed = fixture.context.applyGatewayDraft_(applyEnvelope("class-year.close", {
    classYearId: "CY-2027-001",
    expectedVersion: classYearVersion(fixture, "CY-2027-001"),
    actualClosedDate: "2028-06-30",
    reason: "closed",
    closeCohort: true,
    notes: "Клас закрито",
  }, { requestId: uuidFrom(14), draftId: uuidFrom(114) }));
  assert.equal(closed.success, true, JSON.stringify(closed));
  assert.equal(classSheet.rows[createdRow - 1][13], "Закритий");
  assert.equal(display(classSheet.rows[createdRow - 1][14]), "2028-06-30");
  const cohort = fixture.sheets.get("Класні групи")._state.rows.find((row) => row[0] === "COH-002");
  assert.equal(cohort[3], "Завершена");
});

test("class close remains resumable when cohort transition fails after the class checkpoint", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(fixture);
  const envelope = applyEnvelope("class-year.close", {
    classYearId: "CY-2026-001",
    expectedVersion: classYearVersion(fixture, "CY-2026-001"),
    actualClosedDate: "2027-06-30",
    reason: "closed",
    closeCohort: true,
  }, { requestId: uuidFrom(25), draftId: uuidFrom(125) });
  const originalTransition = fixture.context.writeTransitionCells_;
  let inject = true;
  fixture.context.writeTransitionCells_ = function (sheet, ...args) {
    if (inject && sheet.getName() === "Класні групи") {
      inject = false;
      throw fixture.context.gatewayApplyError_("cohort_close_conflict", "Injected cohort conflict");
    }
    return originalTransition(sheet, ...args);
  };

  const interrupted = fixture.context.applyGatewayDraft_(envelope);
  assert.equal(interrupted.success, false);
  assert.equal(interrupted.outcome_known, false);
  assert.equal(fixture.sheets.get("Класи за роками")._state.rows[1][13], "Закритий");
  assert.equal(fixture.sheets.get("Журнал застосувань")._state.rows[1][6], "applying");
  fixture.sheets.get("Класні групи")._state.rows.push(["COH-999", "Інша група", "X", "Активна", ""]);
  swapSheetDataRows(fixture.sheets.get("Класні групи"), 2, 3);
  fixture.context.writeTransitionCells_ = originalTransition;

  const replay = fixture.context.applyGatewayDraft_(envelope);
  assert.equal(replay.success, true, JSON.stringify(replay));
  const groups = fixture.sheets.get("Класні групи")._state.rows;
  assert.equal(groups.find((row) => row[0] === "COH-001")[3], "Завершена");
  assert.equal(groups.find((row) => row[0] === "COH-999")[3], "Активна");
});

test("class update adopts its ID row after a post-write sort", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(fixture);
  const envelope = applyEnvelope("class-year.update", {
    classYearId: "CY-2026-001",
    academicYearId: "YR-2026-2027",
    expectedVersion: classYearVersion(fixture, "CY-2026-001"),
    changes: { notes: "Оновлено перед сортуванням" },
  }, { requestId: uuidFrom(42), draftId: uuidFrom(142) });
  const originalCheckpoint = fixture.context.checkpointApplyJournal_;
  let inject = true;
  fixture.context.checkpointApplyJournal_ = function (journal, step) {
    if (inject && step === "class_year_update") {
      inject = false;
      throw fixture.context.gatewayApplyError_("class_checkpoint_probe", "Injected after class update");
    }
    return originalCheckpoint(journal, step);
  };

  const interrupted = fixture.context.applyGatewayDraft_(envelope);
  assert.equal(interrupted.code, "class_checkpoint_probe");
  assert.equal(interrupted.outcome_known, false);
  swapSheetDataRows(fixture.sheets.get("Класи за роками"), 2, 3);
  fixture.context.checkpointApplyJournal_ = originalCheckpoint;

  const replay = fixture.context.applyGatewayDraft_(envelope);
  assert.equal(replay.success, true, JSON.stringify(replay));
  const classes = fixture.sheets.get("Класи за роками")._state.rows;
  assert.equal(classes.filter((row) => row[0] === "CY-2026-001").length, 1);
  assert.equal(classes.find((row) => row[0] === "CY-2026-001")[15], "Оновлено перед сортуванням");
});

test("class create replans its generated row after a crash following the cohort checkpoint", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(fixture);
  const envelope = applyEnvelope("class-year.create", {
    academicYearId: "YR-2027-2028",
    cohortMode: "new",
    grade: 1,
    code: "В",
    teacherUserId: "USR-002",
    teacherName: "Учитель Тестовий",
    locationId: "LOC-002",
    locationName: "Кабінет 12",
  }, { requestId: uuidFrom(26), draftId: uuidFrom(126) });
  const originalCheckpoint = fixture.context.checkpointApplyJournal_;
  let inject = true;
  fixture.context.checkpointApplyJournal_ = function (journal, step) {
    originalCheckpoint(journal, step);
    if (inject && step === "cohort") {
      inject = false;
      fixture.sheets.get("Класи за роками").getRange(journal.plan.class_row, 1).setValue("CY-FOREIGN");
      throw new Error("Injected crash after cohort checkpoint");
    }
  };

  assert.throws(() => fixture.context.applyGatewayDraft_(envelope), /Injected crash/);
  assert.equal(fixture.sheets.get("Журнал застосувань")._state.rows[1][6], "applying");
  fixture.context.checkpointApplyJournal_ = originalCheckpoint;
  const replay = fixture.context.applyGatewayDraft_(envelope);
  assert.equal(replay.success, true, JSON.stringify(replay));
  const classes = fixture.sheets.get("Класи за роками")._state.rows;
  assert.equal(classes.filter((row) => row[0] === "CY-2027-001").length, 1);
  assert.ok(classes.findIndex((row) => row[0] === "CY-2027-001") + 1 > 2);
  assert.equal(fixture.sheets.get("Класні групи")._state.rows.filter((row) => row[0] === "COH-002").length, 1);
});

test("prepared journal reservations prevent cohort and class-year ID reuse", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(fixture);
  const firstEnvelope = applyEnvelope("class-year.create", {
    academicYearId: "YR-2027-2028", cohortMode: "new", grade: 1, code: "Б",
  }, { requestId: uuidFrom(48), draftId: uuidFrom(148) });
  const prepared = prepareOnly(fixture, firstEnvelope);
  assert.equal(prepared.plan.cohort_id, "COH-002");
  assert.equal(prepared.plan.class_year_id, "CY-2027-001");

  const second = fixture.context.applyGatewayDraft_(applyEnvelope("class-year.create", {
    academicYearId: "YR-2027-2028", cohortMode: "new", grade: 1, code: "В",
  }, { requestId: uuidFrom(49), draftId: uuidFrom(149) }));
  assert.equal(second.success, true, JSON.stringify(second));
  assert.equal(second.result.entity_ids.cohortId, "COH-003");
  assert.equal(second.result.entity_ids.classYearId, "CY-2027-002");

  const first = fixture.context.applyGatewayDraft_(firstEnvelope);
  assert.equal(first.success, true, JSON.stringify(first));
  assert.equal(first.result.entity_ids.cohortId, "COH-002");
  assert.equal(first.result.entity_ids.classYearId, "CY-2027-001");
  assert.equal(fixture.sheets.get("Класні групи")._state.rows.filter((row) => /^COH-00[23]$/.test(row[0])).length, 2);
  assert.equal(fixture.sheets.get("Класи за роками")._state.rows.filter((row) => /^CY-2027-00[12]$/.test(row[0])).length, 2);
});

test("class create performs full live preflight before writing a reserved cohort", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(fixture);
  const firstEnvelope = applyEnvelope("class-year.create", {
    academicYearId: "YR-2027-2028", cohortMode: "new", grade: 1, code: "Б",
  }, { requestId: uuidFrom(52), draftId: uuidFrom(152) });
  const prepared = prepareOnly(fixture, firstEnvelope);
  assert.equal(prepared.plan.cohort_id, "COH-002");

  const competing = fixture.context.applyGatewayDraft_(applyEnvelope("class-year.create", {
    academicYearId: "YR-2027-2028", cohortMode: "new", grade: 1, code: "Б",
  }, { requestId: uuidFrom(53), draftId: uuidFrom(153) }));
  assert.equal(competing.success, true, JSON.stringify(competing));
  assert.equal(competing.result.entity_ids.cohortId, "COH-003");

  const blocked = fixture.context.applyGatewayDraft_(firstEnvelope);
  assert.equal(blocked.code, "duplicate_class_year");
  assert.equal(blocked.outcome_known, true);
  const groups = fixture.sheets.get("Класні групи")._state.rows;
  assert.equal(groups.some((row) => row[0] === "COH-002"), false);
  assert.equal(groups.filter((row) => row[0] === "COH-003").length, 1);
});

test("a prepared rollover reserves its generated target class ID across request kinds", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(fixture);
  const rolloverEnvelope = applyEnvelope("academic-year.rollover", {
    sourceYearId: "YR-2026-2027", targetYearId: "YR-2027-2028", effectiveDate: "2027-09-01",
    classes: [{
      sourceClassYearId: "CY-2026-001", cohortId: "COH-001", sourceGrade: 1,
      expectedVersion: classYearVersion(fixture, "CY-2026-001"),
      action: "promote", targetGrade: 2, targetCode: "А",
    }],
  }, { requestId: uuidFrom(50), draftId: uuidFrom(150) });
  const prepared = prepareOnly(fixture, rolloverEnvelope);
  assert.equal(prepared.plan.items[0].target_id, "CY-2027-001");

  const classCreate = fixture.context.applyGatewayDraft_(applyEnvelope("class-year.create", {
    academicYearId: "YR-2027-2028", cohortMode: "new", grade: 1, code: "Б",
  }, { requestId: uuidFrom(51), draftId: uuidFrom(151) }));
  assert.equal(classCreate.success, true, JSON.stringify(classCreate));
  assert.equal(classCreate.result.entity_ids.classYearId, "CY-2027-002");

  const rollover = fixture.context.applyGatewayDraft_(rolloverEnvelope);
  assert.equal(rollover.success, true, JSON.stringify(rollover));
  const targetIds = fixture.sheets.get("Класи за роками")._state.rows
    .filter((row) => row[1] === "YR-2027-2028")
    .map((row) => row[0]);
  assert.deepEqual(new Set(targetIds), new Set(["CY-2027-001", "CY-2027-002"]));
});

test("rollover preflights the complete source set and resumes without duplicate target classes", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  fixture.properties.set("GATEWAY_TEST_FAIL_AFTER_MUTATIONS", "once");
  await loadAppsScripts(fixture);
  const envelope = applyEnvelope("academic-year.rollover", {
    sourceYearId: "YR-2026-2027",
    targetYearId: "YR-2027-2028",
    effectiveDate: "2027-09-01",
    classes: [{
      sourceClassYearId: "CY-2026-001", cohortId: "COH-001", sourceGrade: 1,
      expectedVersion: classYearVersion(fixture, "CY-2026-001"),
      action: "promote", targetGrade: 2, targetCode: "А",
      teacherUserId: "USR-002", teacherName: "Учитель Тестовий",
      locationId: "LOC-002", locationName: "Кабінет 12",
    }],
  }, { requestId: uuidFrom(9), draftId: uuidFrom(109) });
  assert.throws(() => fixture.context.applyGatewayDraft_(envelope), /Injected copy-test crash/);
  const replay = fixture.context.applyGatewayDraft_(envelope);
  assert.equal(replay.success, true);
  const classes = fixture.sheets.get("Класи за роками")._state.rows;
  assert.equal(classes.filter((row) => row[0] === "CY-2027-001").length, 1);
  assert.equal(classes[1][13], "Завершений");
  assert.equal(classes.find((row) => row[0] === "CY-2027-001")[13], "Активний");
  const years = fixture.sheets.get("Навчальні роки")._state.rows;
  assert.equal(years.find((row) => row[0] === "YR-2026-2027")[4], "Завершений");
  assert.equal(years.find((row) => row[0] === "YR-2027-2028")[4], "Активний");

  const incompleteFixture = appsScriptFixture();
  incompleteFixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(incompleteFixture);
  const incomplete = incompleteFixture.context.applyGatewayDraft_(applyEnvelope("academic-year.rollover", {
    sourceYearId: "YR-2026-2027", targetYearId: "YR-2027-2028", effectiveDate: "2027-09-01", classes: [],
  }, { requestId: uuidFrom(10), draftId: uuidFrom(110) }));
  assert.equal(incomplete.code, "invalid_rollover_classes");
});

test("rollover resumes a later item after an earlier class and target were durably checkpointed", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  fixture.sheets.get("Класні групи")._state.rows.push(["COH-002", "1-T2", "T2", "Активна", ""]);
  fixture.sheets.get("Класи за роками")._state.rows.push([
    "CY-2026-002", "YR-2026-2027", "2026/2027", "COH-002", "1-T2", 1, "T2",
    "Учитель Тестовий", "USR-002", "Кабінет 12", "LOC-002",
    "2026-09-01", "2027-08-31", "Активний", "", "",
  ]);
  await loadAppsScripts(fixture);
  const envelope = applyEnvelope("academic-year.rollover", {
    sourceYearId: "YR-2026-2027",
    targetYearId: "YR-2027-2028",
    effectiveDate: "2027-09-01",
    classes: [
      {
        sourceClassYearId: "CY-2026-001", cohortId: "COH-001", sourceGrade: 1,
        expectedVersion: classYearVersion(fixture, "CY-2026-001"),
        action: "promote", targetGrade: 2, targetCode: "А",
      },
      {
        sourceClassYearId: "CY-2026-002", cohortId: "COH-002", sourceGrade: 1,
        expectedVersion: classYearVersion(fixture, "CY-2026-002"),
        action: "promote", targetGrade: 2, targetCode: "T2",
      },
    ],
  }, { requestId: uuidFrom(27), draftId: uuidFrom(127) });
  const originalTransition = fixture.context.writeTransitionCells_;
  let inject = true;
  fixture.context.writeTransitionCells_ = function (sheet, row, ...args) {
    if (inject && sheet.getName() === "Класи за роками" && row === 3) {
      inject = false;
      throw fixture.context.gatewayApplyError_("rollover_source_conflict", "Injected later rollover conflict");
    }
    return originalTransition(sheet, row, ...args);
  };

  const interrupted = fixture.context.applyGatewayDraft_(envelope);
  assert.equal(interrupted.success, false);
  assert.equal(interrupted.outcome_known, false);
  assert.equal(fixture.sheets.get("Журнал застосувань")._state.rows[1][6], "applying");
  fixture.context.writeTransitionCells_ = originalTransition;

  const replay = fixture.context.applyGatewayDraft_(envelope);
  assert.equal(replay.success, true, JSON.stringify(replay));
  const classes = fixture.sheets.get("Класи за роками")._state.rows;
  assert.equal(classes.filter((row) => row[0] === "CY-2027-001").length, 1);
  assert.equal(classes.filter((row) => row[0] === "CY-2027-002").length, 1);
});

test("rollover preflights every pending source before its first domain write", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  fixture.sheets.get("Класні групи")._state.rows.push(["COH-002", "1-T2", "T2", "Активна", ""]);
  fixture.sheets.get("Класи за роками")._state.rows.push([
    "CY-2026-002", "YR-2026-2027", "2026/2027", "COH-002", "1-T2", 1, "T2",
    "Учитель Тестовий", "USR-002", "Кабінет 12", "LOC-002",
    "2026-09-01", "2027-08-31", "Активний", "", "",
  ]);
  await loadAppsScripts(fixture);
  const envelope = applyEnvelope("academic-year.rollover", {
    sourceYearId: "YR-2026-2027", targetYearId: "YR-2027-2028", effectiveDate: "2027-09-01",
    classes: [
      {
        sourceClassYearId: "CY-2026-001", cohortId: "COH-001", sourceGrade: 1,
        expectedVersion: classYearVersion(fixture, "CY-2026-001"),
        action: "promote", targetGrade: 2, targetCode: "А",
      },
      {
        sourceClassYearId: "CY-2026-002", cohortId: "COH-002", sourceGrade: 1,
        expectedVersion: classYearVersion(fixture, "CY-2026-002"),
        action: "promote", targetGrade: 2, targetCode: "T2",
      },
    ],
  }, { requestId: uuidFrom(54), draftId: uuidFrom(154) });
  prepareOnly(fixture, envelope);
  fixture.sheets.get("Класи за роками")._state.rows.find((row) => row[0] === "CY-2026-002")[15] = "Зовнішня зміна";

  const stale = fixture.context.applyGatewayDraft_(envelope);
  assert.equal(stale.code, "stale_class_year");
  assert.equal(stale.outcome_known, true);
  const classes = fixture.sheets.get("Класи за роками")._state.rows;
  assert.equal(classes.find((row) => row[0] === "CY-2026-001")[13], "Активний");
  assert.equal(classes.filter((row) => row[1] === "YR-2027-2028").length, 0);
});

test("rollover re-resolves academic-year IDs after a sort between status writes", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(fixture);
  const envelope = applyEnvelope("academic-year.rollover", {
    sourceYearId: "YR-2026-2027",
    targetYearId: "YR-2027-2028",
    effectiveDate: "2027-09-01",
    classes: [{
      sourceClassYearId: "CY-2026-001", cohortId: "COH-001", sourceGrade: 1,
      expectedVersion: classYearVersion(fixture, "CY-2026-001"),
      action: "promote", targetGrade: 2, targetCode: "А",
    }],
  }, { requestId: uuidFrom(43), draftId: uuidFrom(143) });
  const originalTransition = fixture.context.writeTransitionCells_;
  let yearWrites = 0;
  fixture.context.writeTransitionCells_ = function (sheet, row, ...args) {
    if (sheet.getName() === "Навчальні роки") {
      yearWrites += 1;
      if (yearWrites === 2) {
        throw fixture.context.gatewayApplyError_("rollover_year_probe", "Injected between year writes");
      }
    }
    return originalTransition(sheet, row, ...args);
  };

  const interrupted = fixture.context.applyGatewayDraft_(envelope);
  assert.equal(interrupted.code, "rollover_year_probe");
  assert.equal(interrupted.outcome_known, false);
  swapSheetDataRows(fixture.sheets.get("Навчальні роки"), 2, 3);
  fixture.context.writeTransitionCells_ = originalTransition;

  const replay = fixture.context.applyGatewayDraft_(envelope);
  assert.equal(replay.success, true, JSON.stringify(replay));
  const years = fixture.sheets.get("Навчальні роки")._state.rows;
  assert.equal(years.find((row) => row[0] === "YR-2026-2027")[4], "Завершений");
  assert.equal(years.find((row) => row[0] === "YR-2027-2028")[4], "Активний");
});

test("rollover refuses to close a cohort when a new active class appears during recovery", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(fixture);
  const envelope = applyEnvelope("academic-year.rollover", {
    sourceYearId: "YR-2026-2027",
    targetYearId: "YR-2027-2028",
    effectiveDate: "2027-09-01",
    classes: [{
      sourceClassYearId: "CY-2026-001", cohortId: "COH-001", sourceGrade: 1,
      expectedVersion: classYearVersion(fixture, "CY-2026-001"), action: "close",
    }],
  }, { requestId: uuidFrom(44), draftId: uuidFrom(144) });
  const originalCheckpoint = fixture.context.checkpointApplyJournal_;
  let inject = true;
  fixture.context.checkpointApplyJournal_ = function (journal, step) {
    originalCheckpoint(journal, step);
    if (inject && step === "rollover:CY-2026-001:source_written") {
      inject = false;
      fixture.sheets.get("Класи за роками")._state.rows.push([
        "CY-2026-099", "YR-2026-2027", "2026/2027", "COH-001", "1-А2", 1, "А2",
        "Учитель Тестовий", "USR-002", "Кабінет 12", "LOC-002",
        "2026-09-01", "2027-08-31", "Активний", "", "",
      ]);
      throw new Error("Injected after rollover source");
    }
  };
  assert.throws(() => fixture.context.applyGatewayDraft_(envelope), /Injected after rollover source/);
  fixture.context.checkpointApplyJournal_ = originalCheckpoint;

  const blocked = fixture.context.applyGatewayDraft_(envelope);
  assert.equal(blocked.code, "cohort_still_open");
  assert.equal(blocked.outcome_known, false);
  assert.equal(fixture.sheets.get("Класні групи")._state.rows.find((row) => row[0] === "COH-001")[3], "Активна");
});

test("rollover rechecks target uniqueness after a target-row checkpoint", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(fixture);
  const envelope = applyEnvelope("academic-year.rollover", {
    sourceYearId: "YR-2026-2027",
    targetYearId: "YR-2027-2028",
    effectiveDate: "2027-09-01",
    classes: [{
      sourceClassYearId: "CY-2026-001", cohortId: "COH-001", sourceGrade: 1,
      expectedVersion: classYearVersion(fixture, "CY-2026-001"),
      action: "promote", targetGrade: 2, targetCode: "А",
    }],
  }, { requestId: uuidFrom(45), draftId: uuidFrom(145) });
  const originalCheckpoint = fixture.context.checkpointApplyJournal_;
  let inject = true;
  fixture.context.checkpointApplyJournal_ = function (journal, step) {
    originalCheckpoint(journal, step);
    if (inject && step === "rollover:CY-2026-001:target_written") {
      inject = false;
      fixture.sheets.get("Класи за роками")._state.rows.push([
        "CY-2027-099", "YR-2027-2028", "2027/2028", "COH-099", "2-А", 2, "А",
        "Учитель Тестовий", "USR-002", "Кабінет 12", "LOC-002",
        "2027-09-01", "2028-08-31", "Активний", "", "",
      ]);
      throw new Error("Injected after rollover target");
    }
  };
  assert.throws(() => fixture.context.applyGatewayDraft_(envelope), /Injected after rollover target/);
  fixture.context.checkpointApplyJournal_ = originalCheckpoint;

  const blocked = fixture.context.applyGatewayDraft_(envelope);
  assert.equal(blocked.code, "duplicate_class_year");
  assert.equal(blocked.outcome_known, false);
  const targets = fixture.sheets.get("Класи за роками")._state.rows.filter((row) => row[1] === "YR-2027-2028");
  assert.equal(targets.filter((row) => row[0] === "CY-2027-001").length, 1);
});

test("rollover rejects skip and refuses to close a cohort with another active class-year", async () => {
  const skipFixture = appsScriptFixture();
  skipFixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  await loadAppsScripts(skipFixture);
  const skip = skipFixture.context.applyGatewayDraft_(applyEnvelope("academic-year.rollover", {
    sourceYearId: "YR-2026-2027", targetYearId: "YR-2027-2028", effectiveDate: "2027-09-01",
    classes: [{
      sourceClassYearId: "CY-2026-001", cohortId: "COH-001", sourceGrade: 1,
      expectedVersion: classYearVersion(skipFixture, "CY-2026-001"), action: "skip",
    }],
  }, { requestId: uuidFrom(32), draftId: uuidFrom(132) }));
  assert.equal(skip.code, "invalid_rollover_action");
  assert.equal(skipFixture.sheets.get("Класи за роками")._state.rows[1][13], "Активний");
  assert.equal(skipFixture.sheets.get("Журнал застосувань").getLastRow(), 1);

  const cohortFixture = appsScriptFixture();
  cohortFixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  cohortFixture.sheets.get("Класи за роками")._state.rows.push([
    "CY-2025-001", "YR-2025-2026", "2025/2026", "COH-001", "1-А", 1, "А",
    "Учитель Тестовий", "USR-002", "Кабінет 12", "LOC-002",
    "2025-09-01", "2026-08-31", "Активний", "", "",
  ]);
  await loadAppsScripts(cohortFixture);
  const close = cohortFixture.context.applyGatewayDraft_(applyEnvelope("academic-year.rollover", {
    sourceYearId: "YR-2026-2027", targetYearId: "YR-2027-2028", effectiveDate: "2027-09-01",
    classes: [{
      sourceClassYearId: "CY-2026-001", cohortId: "COH-001", sourceGrade: 1,
      expectedVersion: classYearVersion(cohortFixture, "CY-2026-001"), action: "close",
    }],
  }, { requestId: uuidFrom(33), draftId: uuidFrom(133) }));
  assert.equal(close.code, "cohort_still_open");
  assert.equal(cohortFixture.sheets.get("Класи за роками")._state.rows[1][13], "Активний");
  assert.equal(cohortFixture.sheets.get("Класні групи")._state.rows[1][3], "Активна");
});

test("one hundred-class rollover skips oversized hot cache and replays from the durable journal", { timeout: 120_000 }, async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  seedRolloverSourceClasses(fixture, 100);
  await loadAppsScripts(fixture);
  const versions = new Map(
    fixture.context.buildLibrarianClassYearVersions_(fixture.spreadsheet)
      .map((item) => [item.id, item.version]),
  );
  const classes = fixture.sheets.get("Класи за роками")._state.rows.slice(1, 101).map((row) => ({
    sourceClassYearId: row[0],
    cohortId: row[3],
    sourceGrade: 1,
    expectedVersion: versions.get(row[0]),
    action: "promote",
    targetGrade: 2,
    targetCode: row[6],
  }));
  const requestId = uuidFrom(34);
  const envelope = applyEnvelope("academic-year.rollover", {
    sourceYearId: "YR-2026-2027",
    targetYearId: "YR-2027-2028",
    effectiveDate: "2027-09-01",
    classes,
  }, { requestId, draftId: uuidFrom(134) });

  const first = fixture.context.applyGatewayDraft_(envelope);
  assert.equal(first.success, true, JSON.stringify(first));
  assert.equal(first.result.mutations.length, 202);
  assert.ok(Buffer.byteLength(JSON.stringify(first), "utf8") > 9000);
  const cacheKey = `GATEWAY_APPLY_${fixture.context.digestWebSafe_(requestId).slice(0, 40)}`;
  assert.equal(fixture.properties.has(cacheKey), false);
  assert.equal(fixture.sheets.get("Журнал застосувань")._state.rows[1][6], "applied");

  const replay = fixture.context.applyGatewayDraft_(envelope);
  assert.deepEqual(JSON.parse(JSON.stringify(replay)), JSON.parse(JSON.stringify(first)));
  assert.equal(fixture.properties.has(cacheKey), false);
  const targetRows = fixture.sheets.get("Класи за роками")._state.rows
    .filter((row) => row[1] === "YR-2027-2028");
  assert.equal(targetRows.length, 100);
  assert.equal(new Set(targetRows.map((row) => row[0])).size, 100);
});

test("repair migration is preflighted, reproducible, and idempotent", async () => {
  const fixture = appsScriptFixture();
  const { materials, operations } = seedRepairTemplate(fixture);
  operations.getRange(1, 16).setValue("");
  await loadAppsScripts(fixture);
  const first = fixture.context.repairLibrarianGatewayData_(fixture.spreadsheet);
  assert.equal(first.materials, 100);
  assert.equal(first.operationRows, 0);
  assert.equal(operations.getMaxRows(), 1400);
  assert.match(materials.getRange(327, 1).getFormula(), /\$A\$427:\$A\$1600/);
  assert.equal(operations.getRange(1313, 1).getFormula(), "=LEGACY_REVISION_BRIDGE()");
  assert.equal(operations.getRange(1313, 2).getDisplayValue(), "LEGACY-SENTINEL");
  assert.equal(operations.getRange(1, 16).getDisplayValue(), "Request ID застосування (службове)");
  assert.equal(operations._state.hiddenColumns.has(16), true);
  assert.equal(
    operations._state.validations.get("2:8:999:1").formula,
    '=OR(H2="";AND(ISNUMBER(H2);H2=INT(H2);H2>0))',
  );
  const second = fixture.context.repairLibrarianGatewayData_(fixture.spreadsheet);
  assert.equal(second.materials, 0);
  assert.equal(second.operationRows, 0);
});

test("repair fails closed on wrong generic formulas without touching the legacy bridge", async () => {
  const intermediateFixture = appsScriptFixture();
  const intermediate = seedRepairTemplate(intermediateFixture);
  intermediate.operations.getRange(20, 12).setFormula("=C999");
  await loadAppsScripts(intermediateFixture);
  assert.throws(
    () => intermediateFixture.context.repairLibrarianGatewayData_(intermediateFixture.spreadsheet),
    (error) => error?.gatewayCode === "repair_formula_mismatch",
  );
  assert.match(intermediate.materials.getRange(327, 1).getFormula(), /\$A\$1212/);
  assert.equal(intermediate.operations.getRange(1313, 2).getDisplayValue(), "LEGACY-SENTINEL");

  const sourceFixture = appsScriptFixture();
  const source = seedRepairTemplate(sourceFixture);
  source.operations.getRange(2, 1).setFormula(`="BROKEN-"&ROW()`);
  await loadAppsScripts(sourceFixture);
  assert.throws(
    () => sourceFixture.context.repairLibrarianGatewayData_(sourceFixture.spreadsheet),
    (error) => error?.gatewayCode === "operation_formula_template_invalid",
  );
});

test("source guards include HMAC, durable journals, explicit dispatch and exact manifest scopes", async () => {
  const [route, gatewayClient, gateway, journal, operations, manifest] = await Promise.all([
    readFile(new URL("../app/api/librarian/drafts/apply/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/sheets-gateway.ts", import.meta.url), "utf8"),
    readFile(new URL("../apps-script/LibrarianGateway.gs", import.meta.url), "utf8"),
    readFile(new URL("../apps-script/LibrarianApplyJournal.gs", import.meta.url), "utf8"),
    readFile(new URL("../apps-script/LibrarianApplyOperations.gs", import.meta.url), "utf8"),
    readFile(new URL("../apps-script/appsscript.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  assert.match(route, /authorizeLibrarianApi\(\)/);
  assert.match(route, /isSameOriginRequest\(request\)/);
  assert.match(gatewayClient, /crypto\.subtle\.sign\("HMAC"/);
  assert.match(gateway, /actor: input\.actor/);
  assert.match(gateway, /dispatchSafeApply_\(input, spreadsheet, journal\)/);
  assert.match(journal, /Журнал застосувань/);
  assert.match(journal, /"prepared"/);
  assert.match(journal, /"applying"/);
  assert.match(operations, /input\.kind === "academic-year\.rollover"/);
  assert.doesNotMatch(gateway, /SpreadsheetApp\.getActive\(\)/);
  assert.deepEqual(manifest.oauthScopes, [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/script.scriptapp",
  ]);
});
