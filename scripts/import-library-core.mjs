#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FORMAT_VERSION = 1;

const SHEET_SPECS = Object.freeze({
  materials: ["materials", "Матеріали"],
  covers: ["covers", "Обкладинки"],
  locations: ["locations", "Місця"],
  users: ["users", "Користувачі"],
  openingStock: ["openingStock", "Початкові залишки"],
  operations: ["operations", "Операції"],
  revisionJournal: ["revisionJournal", "Журнал ревізій"],
});

const OPTIONAL_SHEET_SPECS = Object.freeze({
  academicYears: ["academicYears", "Навчальні роки"],
  cohorts: ["cohorts", "Класні групи"],
  classYears: ["classYears", "Класи за роками"],
});

const REQUIRED_SHEETS = Object.freeze(Object.keys(SHEET_SPECS));

const COMMERCIAL_HOSTS = new Set([
  "amazon.co.uk",
  "amazon.com",
  "balka-book.com",
  "book-ye.com.ua",
  "ebay.com",
  "goodbooks.com.ua",
  "inpleno.com.ua",
  "knigoland.com.ua",
  "knigoray.com.ua",
  "knigovo.com",
  "knigovo.org.ua",
  "knygy.com.ua",
  "megakniga.com.ua",
  "mybook.biz.ua",
  "rozetka.com.ua",
  "shop.dinternal-education.ua",
  "yakaboo.ua",
]);

const DIRECT_DOCUMENT_EXTENSIONS = new Set([
  "djvu",
  "doc",
  "docx",
  "epub",
  "fb2",
  "mobi",
  "odt",
  "pdf",
  "ppt",
  "pptx",
]);

const OPERATION_TYPE_MAP = Object.freeze({
  "Надходження": "receipt",
  "Видача": "loan_issue",
  "Повернення": "loan_return",
  "Переміщення": "transfer",
  "Коригування": "adjustment",
  "Списання": "writeoff",
  "Втрата": "loss",
  "Передано у використання": "issued_for_use",
});

const OPERATION_STATUS_MAP = Object.freeze({
  "Підтверджено": "confirmed",
  "Відхилено": "rejected",
  "Чернетка": "draft",
  "Очікує перевірки": "pending",
});

class Diagnostics {
  constructor() {
    this.errors = [];
    this.warnings = [];
  }

  error(code, location, message, details = undefined) {
    this.errors.push(diagnostic(code, location, message, details));
  }

  warning(code, location, message, details = undefined) {
    this.warnings.push(diagnostic(code, location, message, details));
  }

  finish() {
    const compare = (left, right) => stableStringify(left).localeCompare(stableStringify(right), "uk");
    this.errors.sort(compare);
    this.warnings.sort(compare);
    return { errors: this.errors, warnings: this.warnings };
  }
}

function diagnostic(code, location, message, details) {
  const value = { code, location, message };
  if (details !== undefined) value.details = details;
  return value;
}

export function importCanonicalExport(input, options = {}) {
  const diagnostics = new Diagnostics();
  const source = normalizeSource(input?.source, diagnostics);
  const { sheets, ignoredSheets } = selectSheets(input?.sheets, diagnostics);

  const locations = normalizeLocations(sheets.locations, diagnostics);
  const users = normalizeUsers(sheets.users, diagnostics);
  const academicYears = normalizeAcademicYears(sheets.academicYears, diagnostics);
  const cohorts = normalizeCohorts(sheets.cohorts, diagnostics);
  const classYears = normalizeClassYears(
    sheets.classYears,
    {
      academicYearIds: new Set(academicYears.map((row) => row.academic_year_id)),
      cohortIds: new Set(cohorts.map((row) => row.cohort_id)),
      userIds: new Set(users.map((row) => row.user_id)),
      locationIds: new Set(locations.map((row) => row.location_id)),
    },
    diagnostics,
  );
  validateAcademicLifecycle(academicYears, cohorts, classYears, diagnostics);
  const { materials, materialLinks, isbnDiagnostics } = normalizeMaterials(
    sheets.materials,
    diagnostics,
  );
  const coverAssets = normalizeCovers(sheets.covers, materials, diagnostics);

  const materialIds = new Set(materials.map((row) => row.material_id));
  const locationIds = new Set(locations.map((row) => row.location_id));
  const userIds = new Set(users.map((row) => row.user_id));

  const openingStock = normalizeOpeningStock(
    sheets.openingStock,
    { materialIds, locationIds },
    diagnostics,
  );
  const operations = normalizeOperations(
    sheets.operations,
    { materialIds, locationIds, userIds },
    diagnostics,
  );
  const revisionChecks = normalizeRevisionJournal(
    sheets.revisionJournal,
    { materialIds, locationIds, operationIds: new Set(operations.map((row) => row.operation_id)) },
    diagnostics,
  );

  validateRevisionOperations(revisionChecks, operations, diagnostics);
  const { balances, stockReport } = deriveBalances(
    openingStock,
    operations,
    locations,
    diagnostics,
  );

  const tables = {
    materials: sortRows(materials, "material_id"),
    material_links: sortRows(materialLinks, "link_id"),
    cover_assets: sortRows(coverAssets, "material_id"),
    locations: sortRows(locations, "location_id"),
    users: sortRows(users, "user_id"),
    academic_years: sortRows(academicYears, "academic_year_id"),
    cohorts: sortRows(cohorts, "cohort_id"),
    class_years: sortRows(classYears, "class_year_id"),
    opening_stock: sortRows(openingStock, "opening_stock_id"),
    operations: sortRows(operations, "operation_id"),
    revision_checks: sortRows(revisionChecks, "request_id"),
    stock_balances: sortRows(balances, "balance_id"),
  };

  const finished = diagnostics.finish();
  const report = buildReport({
    source,
    tables,
    ignoredSheets,
    isbnDiagnostics,
    stockReport,
    errors: finished.errors,
    warnings: finished.warnings,
  });

  const bundle = {
    format: "library-d1-staging",
    format_version: FORMAT_VERSION,
    source,
    tables,
    reconciliation: report,
  };

  if (options.throwOnError && !report.ok) {
    const error = new Error(`Імпорт не пройшов перевірку: ${report.diagnostics.error_count} помилок.`);
    error.code = "IMPORT_VALIDATION_FAILED";
    error.report = report;
    throw error;
  }

  return { bundle, report };
}

function normalizeSource(value, diagnostics) {
  const source = isObject(value) ? value : {};
  const spreadsheetId = cleanText(source.spreadsheetId ?? source.spreadsheet_id);
  const exportedAt = cleanText(source.exportedAt ?? source.exported_at);
  if (!spreadsheetId) diagnostics.warning("source_id_missing", "source.spreadsheetId", "Відсутній ID джерела.");
  if (exportedAt && !isIsoDateTime(exportedAt)) {
    diagnostics.warning("exported_at_invalid", "source.exportedAt", "Дата експорту не є ISO-8601.", exportedAt);
  }
  return {
    spreadsheet_id: spreadsheetId || null,
    title: cleanText(source.title) || null,
    exported_at: exportedAt || null,
    value_render_option: cleanText(source.valueRenderOption ?? source.value_render_option) || null,
  };
}

function selectSheets(value, diagnostics) {
  if (!isObject(value)) {
    diagnostics.error("sheets_missing", "sheets", "У JSON відсутній об'єкт sheets.");
    return { sheets: emptySheetMap(), ignoredSheets: [] };
  }

  const selected = {};
  const usedKeys = new Set();
  for (const [canonicalKey, aliases] of Object.entries(SHEET_SPECS)) {
    let matchKey = aliases.find((alias) => Object.hasOwn(value, alias));
    if (!matchKey) {
      matchKey = Object.keys(value).find((key) => aliases.includes(cleanText(value[key]?.sheetName)));
    }
    if (!matchKey) {
      diagnostics.error("required_sheet_missing", `sheets.${canonicalKey}`, "Відсутній обов'язковий центральний аркуш.");
      selected[canonicalKey] = [];
      continue;
    }
    usedKeys.add(matchKey);
    selected[canonicalKey] = sheetRows(value[matchKey], `sheets.${matchKey}`, diagnostics);
  }

  for (const [canonicalKey, aliases] of Object.entries(OPTIONAL_SHEET_SPECS)) {
    let matchKey = aliases.find((alias) => Object.hasOwn(value, alias));
    if (!matchKey) {
      matchKey = Object.keys(value).find((key) => aliases.includes(cleanText(value[key]?.sheetName)));
    }
    if (!matchKey) {
      selected[canonicalKey] = [];
      continue;
    }
    usedKeys.add(matchKey);
    selected[canonicalKey] = sheetRows(value[matchKey], `sheets.${matchKey}`, diagnostics);
  }

  const ignoredSheets = Object.keys(value).filter((key) => !usedKeys.has(key)).sort((a, b) => a.localeCompare(b, "uk"));
  ignoredSheets.forEach((key) => {
    diagnostics.warning(
      "sheet_ignored",
      `sheets.${key}`,
      "Аркуш не входить до дозволеного набору та не використовувався для імпорту.",
      { sheet_name: cleanText(value[key]?.sheetName) || key },
    );
  });
  return { sheets: selected, ignoredSheets };
}

function emptySheetMap() {
  return Object.fromEntries([
    ...REQUIRED_SHEETS,
    ...Object.keys(OPTIONAL_SHEET_SPECS),
  ].map((key) => [key, []]));
}

function sheetRows(sheet, location, diagnostics) {
  let values;
  if (Array.isArray(sheet)) values = sheet;
  else if (isObject(sheet) && Array.isArray(sheet.values)) values = sheet.values;
  else if (isObject(sheet) && Array.isArray(sheet.rows)) {
    if (Array.isArray(sheet.headers) && sheet.rows.every(Array.isArray)) {
      values = [sheet.headers, ...sheet.rows];
    } else {
      values = sheet.rows;
    }
  }
  if (!Array.isArray(values)) {
    diagnostics.error("sheet_values_missing", location, "Аркуш не містить масиву values/rows.");
    return [];
  }
  if (!values.length) return [];
  if (values.every(isObject)) {
    return values.map((data, index) => ({ index: index + 1, cells: null, data }));
  }
  if (!Array.isArray(values[0])) {
    diagnostics.error("sheet_shape_invalid", location, "Очікувався двовимірний масив або масив об'єктів.");
    return [];
  }
  const headers = values[0].map((cell) => cleanText(unwrapCell(cell)));
  return values.slice(1).map((cells, index) => {
    const normalizedCells = Array.isArray(cells) ? cells.map(unwrapCell) : [];
    const data = {};
    headers.forEach((header, column) => {
      if (header && !Object.hasOwn(data, header)) data[header] = normalizedCells[column];
    });
    return { index: index + 2, cells: normalizedCells, data };
  });
}

function unwrapCell(value) {
  if (!isObject(value)) return value;
  if (Object.hasOwn(value, "formattedValue")) return value.formattedValue;
  if (Object.hasOwn(value, "value")) return value.value;
  if (isObject(value.effectiveValue)) return Object.values(value.effectiveValue)[0];
  return "";
}

function field(row, aliases, columnIndex) {
  for (const alias of aliases) {
    if (Object.hasOwn(row.data, alias)) return row.data[alias];
  }
  return row.cells ? row.cells[columnIndex] : undefined;
}

function normalizeMaterials(rows, diagnostics) {
  const materials = [];
  const materialLinks = [];
  const seenIds = new Map();
  const seenIsbns = new Map();
  const isbnDiagnostics = {
    present: 0,
    valid: 0,
    invalid: 0,
    missing: 0,
    formula_errors: 0,
    duplicates: 0,
  };

  for (const row of rows) {
    const location = `sheets.materials.rows[${row.index}]`;
    const materialId = cleanText(field(row, ["ID матеріалу", "material_id", "id"], 0)).toUpperCase();
    if (!materialId && rowIsEmpty(row)) continue;
    if (!/^CAT-\d{4,}$/.test(materialId)) {
      diagnostics.error("material_id_invalid", `${location}.material_id`, "Некоректний CAT-ID.", materialId);
      continue;
    }
    if (seenIds.has(materialId)) {
      diagnostics.error("material_id_duplicate", `${location}.material_id`, "CAT-ID повторюється.", {
        material_id: materialId,
        first_row: seenIds.get(materialId),
      });
      continue;
    }
    seenIds.set(materialId, row.index);

    const title = cleanText(field(row, ["Назва (з класом)", "title", "name"], 6));
    if (!title) diagnostics.error("material_title_missing", `${location}.title`, "Матеріал не має назви.", materialId);

    const rawIsbn = cleanText(field(row, ["ISBN", "isbn"], 9));
    const sourceNormalizedIsbn = cleanText(field(row, ["ISBN нормалізований", "normalized_isbn"], 24));
    const isbn = analyzeIsbn(rawIsbn, sourceNormalizedIsbn, location, diagnostics, isbnDiagnostics);
    if (isbn.normalized) {
      const matches = seenIsbns.get(isbn.normalized) || [];
      matches.push(materialId);
      seenIsbns.set(isbn.normalized, matches);
    }

    const classFrom = optionalInteger(field(row, ["Клас від", "class_from"], 4), 1, 11);
    const rawClassTo = optionalInteger(field(row, ["Клас до", "class_to"], 5), 1, 11);
    const classTo = rawClassTo ?? classFrom;
    if (classFrom !== null && classTo !== null && classFrom > classTo) {
      diagnostics.error("class_range_invalid", location, "Початковий клас більший за кінцевий.", { material_id: materialId, class_from: classFrom, class_to: classTo });
    }

    const rawYear = field(row, ["Рік", "published_year", "year"], 8);
    const publishedYear = optionalInteger(rawYear, 1500, 3000);
    if (cleanText(rawYear) && publishedYear === null) {
      diagnostics.warning("published_year_invalid", `${location}.published_year`, "Рік не перенесено через некоректне значення.", cleanText(rawYear));
    }

    const rubric = cleanText(field(row, ["Рубрика балансу", "rubric"], 20))
      || cleanText(field(row, ["Розділ", "section"], 1));
    const publisher = cleanText(field(row, ["Видавництво", "publisher"], 23));
    const author = cleanText(field(row, ["Автор", "author"], 7));
    const subject = cleanText(field(row, ["Предмет / напрям", "subject"], 3));

    materials.push(compactNulls({
      material_id: materialId,
      section: cleanText(field(row, ["Розділ", "section"], 1)) || null,
      rubric: rubric || null,
      publication_type: cleanText(field(row, ["Тип видання", "publication_type"], 2)) || null,
      subject: subject || null,
      class_from: classFrom,
      class_to: classTo,
      title,
      author: author || null,
      publisher: publisher || null,
      published_year: publishedYear,
      isbn_raw: rawIsbn || null,
      isbn_normalized: isbn.normalized,
      isbn_valid: isbn.valid === null ? null : Number(isbn.valid),
      processing_status: cleanText(field(row, ["Статус опрацювання", "processing_status"], 14)) || null,
      notes: cleanText(field(row, ["Примітка", "notes"], 17)) || null,
      legacy_source: cleanText(field(row, ["Джерело", "legacy_source"], 16)) || null,
      search_text: normalizeSearchText([
        materialId,
        title,
        author,
        publisher,
        subject,
        rubric,
        isbn.normalized,
      ].filter(Boolean).join(" ")),
    }));

    const rawUrl = cleanText(field(row, ["Електронна версія", "electronic_url", "resource_url"], 11));
    if (rawUrl) {
      const normalizedUrl = normalizeHttpUrl(rawUrl, `${location}.electronic_url`, diagnostics);
      if (normalizedUrl) {
        const classification = classifyResourceUrl(normalizedUrl);
        materialLinks.push({
          link_id: `${materialId}:resource:1`,
          material_id: materialId,
          url: normalizedUrl,
          label: "Електронна версія / інформація",
          classification: classification.classification,
          host: classification.host,
          file_format: classification.file_format,
          is_direct_file: Number(classification.is_direct_file),
          is_primary: 1,
        });
      }
    }
  }

  for (const [isbn, ids] of seenIsbns) {
    if (ids.length < 2) continue;
    isbnDiagnostics.duplicates += 1;
    diagnostics.warning("isbn_duplicate", "sheets.materials", "Нормалізований ISBN використано для кількох CAT-ID.", { isbn, material_ids: ids.sort() });
  }

  return { materials, materialLinks, isbnDiagnostics };
}

function analyzeIsbn(raw, sourceNormalized, location, diagnostics, stats) {
  if (sourceNormalized.startsWith("#")) {
    stats.formula_errors += 1;
    diagnostics.warning("isbn_formula_error", `${location}.normalized_isbn`, "У вихідній колонці ISBN була помилка формули; значення перераховано локально.", sourceNormalized);
  }
  const candidate = normalizeIsbn(raw || (sourceNormalized.startsWith("#") ? "" : sourceNormalized));
  if (!candidate) {
    stats.missing += 1;
    return { normalized: null, valid: null };
  }
  stats.present += 1;
  const valid = isValidIsbn(candidate);
  if (valid) stats.valid += 1;
  else {
    stats.invalid += 1;
    diagnostics.warning("isbn_invalid", `${location}.isbn`, "ISBN не пройшов перевірку контрольної цифри.", { raw, normalized: candidate });
  }
  // Keep the original text for review, but only a checksum-valid ISBN may
  // populate the indexed exact-match column in D1.
  return { normalized: valid ? candidate : null, valid };
}

function normalizeCovers(rows, materials, diagnostics) {
  const materialIds = new Set(materials.map((row) => row.material_id));
  const seen = new Map();
  const covers = [];
  for (const row of rows) {
    const location = `sheets.covers.rows[${row.index}]`;
    const materialId = cleanText(field(row, ["ID матеріалу", "material_id"], 0)).toUpperCase();
    if (!materialId && rowIsEmpty(row)) continue;
    if (!materialIds.has(materialId)) {
      diagnostics.warning("cover_material_missing", `${location}.material_id`, "Обкладинка посилається на відсутній матеріал.", materialId);
      continue;
    }
    const rawUrl = cleanText(field(row, ["URL обкладинки", "cover_url", "url"], 2));
    if (!rawUrl) continue;
    const url = normalizeHttpUrl(rawUrl, `${location}.cover_url`, diagnostics);
    if (!url) continue;
    if (seen.has(materialId)) {
      diagnostics.error("cover_duplicate", location, "Для CAT-ID знайдено кілька обкладинок.", { material_id: materialId, first_row: seen.get(materialId) });
      continue;
    }
    seen.set(materialId, row.index);
    covers.push({ material_id: materialId, cover_url: url, storage_kind: classifyCoverStorage(url) });
  }
  return covers;
}

function normalizeLocations(rows, diagnostics) {
  const result = [];
  const seenIds = new Map();
  const seenNames = new Map();
  for (const row of rows) {
    const location = `sheets.locations.rows[${row.index}]`;
    const id = cleanText(field(row, ["ID місця", "location_id", "id"], 0)).toUpperCase();
    if (!id && rowIsEmpty(row)) continue;
    if (!/^LOC-\d{3,}$/.test(id)) {
      diagnostics.error("location_id_invalid", `${location}.location_id`, "Некоректний ID місця.", id);
      continue;
    }
    if (seenIds.has(id)) {
      diagnostics.error("location_id_duplicate", `${location}.location_id`, "ID місця повторюється.", { location_id: id, first_row: seenIds.get(id) });
      continue;
    }
    seenIds.set(id, row.index);
    const name = cleanText(field(row, ["Назва", "name"], 1));
    if (!name) diagnostics.error("location_name_missing", `${location}.name`, "Місце не має назви.", id);
    const normalizedName = normalizeSearchText(name);
    if (normalizedName && seenNames.has(normalizedName)) {
      diagnostics.warning("location_name_duplicate", `${location}.name`, "Назва місця повторюється.", { name, first_location_id: seenNames.get(normalizedName) });
    } else if (normalizedName) seenNames.set(normalizedName, id);
    const type = cleanText(field(row, ["Тип", "type"], 2));
    const status = cleanText(field(row, ["Статус", "status"], 3));
    result.push({
      location_id: id,
      name,
      location_type: type || null,
      status: status || null,
      is_active: Number(/^актив/i.test(status)),
      is_service: Number(id === "LOC-007" || id === "LOC-008" || /служб/i.test(type)),
    });
  }
  return result;
}

const CURRENT_STAFF_ROLES = new Set([
  "адміністратор",
  "адміністрація",
  "бібліотекар",
  "бібліотекар адміністратор",
  "учитель",
]);

const ACTIVE_USER_STATUSES = new Set([
  "активна",
  "активне",
  "активний",
]);

function isDomainActiveUser(role, status) {
  const normalizedStatus = normalizeSearchText(status);
  if (ACTIVE_USER_STATUSES.has(normalizedStatus)) return true;
  if (normalizedStatus !== "доступ не активовано") return false;
  return CURRENT_STAFF_ROLES.has(normalizeSearchText(role));
}

function normalizeUsers(rows, diagnostics) {
  const result = [];
  const seenIds = new Map();
  const seenEmails = new Map();
  for (const row of rows) {
    const location = `sheets.users.rows[${row.index}]`;
    const id = cleanText(field(row, ["ID користувача", "user_id", "id"], 0)).toUpperCase();
    if (!id && rowIsEmpty(row)) continue;
    if (!/^USR-\d{3,}$/.test(id)) {
      diagnostics.error("user_id_invalid", `${location}.user_id`, "Некоректний ID користувача.", id);
      continue;
    }
    if (seenIds.has(id)) {
      diagnostics.error("user_id_duplicate", `${location}.user_id`, "ID користувача повторюється.", { user_id: id, first_row: seenIds.get(id) });
      continue;
    }
    seenIds.set(id, row.index);
    const name = cleanText(field(row, ["ПІБ", "name"], 1));
    if (!name) diagnostics.error("user_name_missing", `${location}.name`, "Користувач не має ПІБ.", id);
    const email = cleanText(field(row, ["Email", "email"], 4)).toLocaleLowerCase("uk-UA");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
      diagnostics.warning("user_email_invalid", `${location}.email`, "Email не перенесено як дійсний логін.", email);
    }
    if (email && seenEmails.has(email)) {
      diagnostics.error("user_email_duplicate", `${location}.email`, "Email належить кільком користувачам.", { email, first_user_id: seenEmails.get(email) });
    } else if (email) seenEmails.set(email, id);
    const role = cleanText(field(row, ["Роль", "role"], 2));
    const status = cleanText(field(row, ["Статус", "status"], 5));
    result.push({
      user_id: id,
      name,
      role: role || null,
      current_class: cleanText(field(row, ["Поточний клас", "current_class"], 3)) || null,
      email: email || null,
      status: status || null,
      is_active: Number(isDomainActiveUser(role, status)),
    });
  }
  return result;
}

function normalizeAcademicYears(rows, diagnostics) {
  const result = [];
  const seenIds = new Map();
  const seenLabels = new Map();
  for (const row of rows) {
    const location = `sheets.academicYears.rows[${row.index}]`;
    const id = cleanText(field(row, ["ID навчального року", "academic_year_id", "id"], 0)).toUpperCase();
    if (!id && rowIsEmpty(row)) continue;
    const match = id.match(/^YR-(20\d{2})-(20\d{2})$/u);
    if (!match || Number(match[2]) !== Number(match[1]) + 1) {
      diagnostics.error("academic_year_id_invalid", `${location}.academic_year_id`, "Некоректний ID навчального року.", id);
      continue;
    }
    if (seenIds.has(id)) {
      diagnostics.error("academic_year_id_duplicate", `${location}.academic_year_id`, "ID навчального року повторюється.", { academic_year_id: id, first_row: seenIds.get(id) });
      continue;
    }
    seenIds.set(id, row.index);
    const label = cleanText(field(row, ["Навчальний рік", "label"], 1));
    const labelMatch = label.match(/^(20\d{2})\/(20\d{2})$/u);
    if (!labelMatch || Number(labelMatch[2]) !== Number(labelMatch[1]) + 1) {
      diagnostics.error("academic_year_label_invalid", `${location}.label`, "Назва навчального року має формат 2026/2027.", label);
    } else if (`YR-${labelMatch[1]}-${labelMatch[2]}` !== id) {
      diagnostics.error("academic_year_label_mismatch", `${location}.label`, "Назва навчального року не відповідає його ID.", { id, label });
    }
    if (seenLabels.has(label)) {
      diagnostics.error("academic_year_label_duplicate", `${location}.label`, "Назва навчального року повторюється.", { label, first_row: seenLabels.get(label) });
    } else if (label) seenLabels.set(label, row.index);
    const startDate = normalizeDate(field(row, ["Дата початку", "start_date"], 2), `${location}.start_date`, diagnostics);
    const endDate = normalizeDate(field(row, ["Дата завершення", "end_date"], 3), `${location}.end_date`, diagnostics);
    if (startDate && endDate && startDate >= endDate) {
      diagnostics.error("academic_year_date_order", location, "Дата завершення навчального року має бути пізнішою за дату початку.");
    }
    if (startDate && match && startDate.slice(0, 4) !== match[1]) {
      diagnostics.error("academic_year_start_mismatch", `${location}.start_date`, "Рік дати початку не відповідає навчальному року.");
    }
    if (endDate && match && endDate.slice(0, 4) !== match[2]) {
      diagnostics.error("academic_year_end_mismatch", `${location}.end_date`, "Рік дати завершення не відповідає навчальному року.");
    }
    const status = mapAcademicYearStatus(field(row, ["Статус", "status"], 4), `${location}.status`, diagnostics);
    result.push({
      academic_year_id: id,
      label,
      start_date: startDate,
      end_date: endDate,
      status,
      notes: cleanText(field(row, ["Примітка", "Примітки", "notes"], 5)) || null,
    });
  }
  return result;
}

function normalizeCohorts(rows, diagnostics) {
  const result = [];
  const seenIds = new Map();
  for (const row of rows) {
    const location = `sheets.cohorts.rows[${row.index}]`;
    const id = cleanText(field(row, ["ID групи", "cohort_id", "id"], 0)).toUpperCase();
    if (!id && rowIsEmpty(row)) continue;
    if (!/^COH-\d{3,}$/u.test(id)) {
      diagnostics.error("cohort_id_invalid", `${location}.cohort_id`, "Некоректний ID класної групи.", id);
      continue;
    }
    if (seenIds.has(id)) {
      diagnostics.error("cohort_id_duplicate", `${location}.cohort_id`, "ID класної групи повторюється.", { cohort_id: id, first_row: seenIds.get(id) });
      continue;
    }
    seenIds.set(id, row.index);
    result.push({
      cohort_id: id,
      status: mapCohortStatus(field(row, ["Статус", "status"], 3), `${location}.status`, diagnostics),
      notes: cleanText(field(row, ["Примітка", "Примітки", "notes"], 4)) || null,
    });
  }
  return result;
}

function normalizeClassYears(rows, refs, diagnostics) {
  const result = [];
  const seenIds = new Map();
  const seenYearCohorts = new Map();
  const seenYearNames = new Map();
  for (const row of rows) {
    const location = `sheets.classYears.rows[${row.index}]`;
    const id = cleanText(field(row, ["ID запису", "class_year_id", "id"], 0)).toUpperCase();
    if (!id && rowIsEmpty(row)) continue;
    if (!/^CY-20\d{2}-\d{3,}$/u.test(id)) {
      diagnostics.error("class_year_id_invalid", `${location}.class_year_id`, "Некоректний ID класу за роком.", id);
      continue;
    }
    if (seenIds.has(id)) {
      diagnostics.error("class_year_id_duplicate", `${location}.class_year_id`, "ID класу за роком повторюється.", { class_year_id: id, first_row: seenIds.get(id) });
      continue;
    }
    seenIds.set(id, row.index);
    const academicYearId = cleanText(field(row, ["ID навчального року", "academic_year_id"], 1)).toUpperCase();
    const cohortId = cleanText(field(row, ["ID групи", "cohort_id"], 3)).toUpperCase();
    validateReference(academicYearId, refs.academicYearIds, "class_year_academic_year_missing", `${location}.academic_year_id`, diagnostics);
    validateReference(cohortId, refs.cohortIds, "class_year_cohort_missing", `${location}.cohort_id`, diagnostics);
    const grade = optionalInteger(field(row, ["Клас", "grade"], 5), 1, 11);
    if (grade === null) diagnostics.error("class_year_grade_invalid", `${location}.grade`, "Паралель класу має бути цілим числом від 1 до 11.");
    const code = cleanText(field(row, ["Код", "code"], 6)).toLocaleUpperCase("uk-UA");
    if (!/^[\p{L}\p{N}().'_-]{1,16}$/u.test(code)) {
      diagnostics.error("class_year_code_invalid", `${location}.code`, "Некоректний код класу.", code);
    }
    const className = `${grade ?? 1}-${code}`;
    const sourceName = cleanText(field(row, ["Назва класу", "class_name"], 4));
    if (sourceName && normalizeSearchText(sourceName) !== normalizeSearchText(className)) {
      diagnostics.warning("class_year_name_normalized", `${location}.class_name`, "Назву класу нормалізовано з паралелі та коду.", { source: sourceName, normalized: className });
    }
    const yearCohortKey = `${academicYearId}\0${cohortId}`;
    if (seenYearCohorts.has(yearCohortKey)) {
      diagnostics.error("class_year_cohort_duplicate", location, "Класна група повторюється в одному навчальному році.", { first_row: seenYearCohorts.get(yearCohortKey), academic_year_id: academicYearId, cohort_id: cohortId });
    } else seenYearCohorts.set(yearCohortKey, row.index);
    const yearNameKey = `${academicYearId}\0${className}`;
    if (seenYearNames.has(yearNameKey)) {
      diagnostics.error("class_year_name_duplicate", location, "Назва класу повторюється в одному навчальному році.", { first_row: seenYearNames.get(yearNameKey), academic_year_id: academicYearId, class_name: className });
    } else seenYearNames.set(yearNameKey, row.index);

    const teacherUserId = cleanText(field(row, ["ID керівника", "teacher_user_id"], 8)).toUpperCase() || null;
    const locationId = cleanText(field(row, ["ID кабінету", "location_id"], 10)).toUpperCase() || null;
    if (teacherUserId) validateReference(teacherUserId, refs.userIds, "class_year_teacher_missing", `${location}.teacher_user_id`, diagnostics);
    if (locationId) validateReference(locationId, refs.locationIds, "class_year_location_missing", `${location}.location_id`, diagnostics);
    const startDate = normalizeDate(field(row, ["Дата початку", "start_date"], 11), `${location}.start_date`, diagnostics);
    const endDate = normalizeDate(field(row, ["Дата завершення", "end_date"], 12), `${location}.end_date`, diagnostics);
    if (startDate && endDate && startDate >= endDate) {
      diagnostics.error("class_year_date_order", location, "Дата завершення класу має бути пізнішою за дату початку.");
    }
    let status = mapClassYearStatus(field(row, ["Статус", "status"], 13), `${location}.status`, diagnostics);
    let actualClosedDate = normalizeOptionalDate(field(row, ["Фактична дата закриття", "actual_closed_date"], 14), `${location}.actual_closed_date`, diagnostics);
    if (status === "closed" && !actualClosedDate) {
      actualClosedDate = endDate;
      diagnostics.warning("class_year_close_date_defaulted", `${location}.actual_closed_date`, "Для закритого класу фактичну дату відновлено з планової дати завершення.", id);
    } else if (status !== "closed" && actualClosedDate) {
      status = "closed";
      diagnostics.warning("class_year_status_closed_from_date", `${location}.status`, "Статус змінено на closed, бо вказано фактичну дату закриття.", id);
    }
    result.push({
      class_year_id: id,
      academic_year_id: academicYearId,
      cohort_id: cohortId,
      class_name: className,
      grade: grade ?? 1,
      code,
      teacher_user_id: teacherUserId,
      location_id: locationId,
      start_date: startDate,
      end_date: endDate,
      status,
      actual_closed_date: actualClosedDate,
      notes: cleanText(field(row, ["Примітка", "Примітки", "notes"], 15)) || null,
    });
  }
  return result;
}

function mapAcademicYearStatus(value, location, diagnostics) {
  const normalized = normalizeSearchText(value);
  if (normalized === "draft" || normalized.includes("чернет")) return "draft";
  if (normalized === "active" || normalized.includes("актив")) return "active";
  if (normalized === "closed" || normalized.includes("закрит") || normalized.includes("заверш")) return "closed";
  diagnostics.error("academic_year_status_invalid", location, "Невідомий статус навчального року.", cleanText(value));
  return "draft";
}

function mapCohortStatus(value, location, diagnostics) {
  const normalized = normalizeSearchText(value);
  if (normalized === "active" || normalized.includes("актив")) return "active";
  if (normalized === "graduated" || normalized.includes("випущ") || normalized.includes("випуск")) return "graduated";
  if (normalized === "closed" || normalized.includes("закрит") || normalized.includes("заверш")) return "closed";
  diagnostics.error("cohort_status_invalid", location, "Невідомий статус класної групи.", cleanText(value));
  return "active";
}

function mapClassYearStatus(value, location, diagnostics) {
  const normalized = normalizeSearchText(value);
  if (normalized === "planned" || normalized.includes("план") || normalized.includes("чернет")) return "planned";
  if (normalized === "active" || normalized.includes("актив")) return "active";
  if (normalized === "closed" || normalized.includes("закрит") || normalized.includes("заверш")) return "closed";
  diagnostics.error("class_year_status_invalid", location, "Невідомий статус класу.", cleanText(value));
  return "planned";
}

function validateAcademicLifecycle(academicYears, cohorts, classYears, diagnostics) {
  const activeYears = academicYears.filter((row) => row.status === "active");
  if (activeYears.length > 1) {
    diagnostics.error(
      "academic_year_active_duplicate",
      "sheets.academicYears",
      "Активним може бути лише один навчальний рік.",
      activeYears.map((row) => row.academic_year_id),
    );
  }
  const yearsById = new Map(academicYears.map((row) => [row.academic_year_id, row]));
  const cohortsById = new Map(cohorts.map((row) => [row.cohort_id, row]));
  const openCohorts = new Map();
  for (const row of classYears) {
    const year = yearsById.get(row.academic_year_id);
    const cohort = cohortsById.get(row.cohort_id);
    const location = `sheets.classYears.${row.class_year_id || "unknown"}`;
    const idYear = row.class_year_id.match(/^CY-(20\d{2})-/u)?.[1];
    if (idYear && idYear !== row.academic_year_id.slice(3, 7)) {
      diagnostics.error("class_year_id_year_mismatch", `${location}.class_year_id`, "ID класу не відповідає навчальному року.");
    }
    if (row.status !== "closed") {
      if (cohort && cohort.status !== "active") {
        diagnostics.error("class_year_cohort_status_invalid", `${location}.cohort_id`, "Відкритий клас має належати активній класній групі.");
      }
      if (openCohorts.has(row.cohort_id)) {
        diagnostics.error(
          "class_year_cohort_open_duplicate",
          `${location}.cohort_id`,
          "Класна група використовується більш ніж одним відкритим класом.",
          { first_class_year_id: openCohorts.get(row.cohort_id) },
        );
      } else openCohorts.set(row.cohort_id, row.class_year_id);
    }
    if (year && (
      (row.status === "active" && year.status !== "active")
      || (row.status === "planned" && year.status !== "draft")
      || (year.status === "closed" && row.status !== "closed")
    )) {
      diagnostics.error("class_year_academic_status_invalid", `${location}.status`, "Статус класу не узгоджений зі статусом навчального року.");
    }
    if (year && (row.start_date < year.start_date || row.end_date > year.end_date)) {
      diagnostics.error("class_year_date_outside_academic_year", location, "Дати класу мають бути в межах навчального року.");
    }
  }
}

function normalizeOpeningStock(rows, refs, diagnostics) {
  const result = [];
  const idCounts = new Map();
  const prepared = [];
  for (const row of rows) {
    const location = `sheets.openingStock.rows[${row.index}]`;
    if (rowIsEmpty(row)) continue;
    const materialId = cleanText(field(row, ["ID матеріалу", "material_id"], 1)).toUpperCase();
    const locationId = cleanText(field(row, ["ID місця", "location_id"], 2)).toUpperCase();
    const quantity = positiveInteger(field(row, ["Кількість", "quantity"], 4));
    validateReference(materialId, refs.materialIds, "opening_material_missing", `${location}.material_id`, diagnostics);
    validateReference(locationId, refs.locationIds, "opening_location_missing", `${location}.location_id`, diagnostics);
    if (quantity === null) diagnostics.error("opening_quantity_invalid", `${location}.quantity`, "Початкова кількість має бути додатним цілим числом.", field(row, ["Кількість", "quantity"], 4));
    const normalized = {
      occurred_on: normalizeDate(field(row, ["Дата", "date"], 0), `${location}.date`, diagnostics),
      material_id: materialId,
      location_id: locationId,
      condition: cleanText(field(row, ["Стан", "condition"], 3)) || null,
      quantity: quantity ?? 0,
      source: cleanText(field(row, ["Джерело", "source"], 5)) || null,
      notes: cleanText(field(row, ["Примітка", "notes"], 6)) || null,
    };
    prepared.push(normalized);
  }
  prepared.sort(compareRows);
  for (const row of prepared) {
    const base = digest(row).slice(0, 20);
    const occurrence = (idCounts.get(base) || 0) + 1;
    idCounts.set(base, occurrence);
    result.push({ opening_stock_id: `OPEN-${base}${occurrence > 1 ? `-${occurrence}` : ""}`, ...row });
  }
  return result;
}

function normalizeOperations(rows, refs, diagnostics) {
  const result = [];
  const seenIds = new Map();
  const seenRequests = new Map();
  for (const row of rows) {
    const location = `sheets.operations.rows[${row.index}]`;
    const operationId = cleanText(field(row, ["ID операції", "operation_id"], 0)).toUpperCase();
    if (!operationId && rowIsEmpty(row)) continue;
    if (!/^OP-\d{6,}$/.test(operationId)) {
      diagnostics.error("operation_id_invalid", `${location}.operation_id`, "Некоректний ID операції.", operationId);
      continue;
    }
    if (seenIds.has(operationId)) {
      diagnostics.error("operation_id_duplicate", `${location}.operation_id`, "ID операції повторюється.", { operation_id: operationId, first_row: seenIds.get(operationId) });
      continue;
    }
    seenIds.set(operationId, row.index);
    const materialId = cleanText(field(row, ["ID матеріалу (службове)", "material_id"], 11)).toUpperCase();
    const fromLocationId = cleanText(field(row, ["ID місця звідки (службове)", "source_location_id"], 12)).toUpperCase();
    const toLocationId = cleanText(field(row, ["ID місця куди (службове)", "destination_location_id"], 13)).toUpperCase();
    const actorUserId = cleanText(field(row, ["ID відповідального (службове)", "actor_user_id"], 14)).toUpperCase();
    validateReference(materialId, refs.materialIds, "operation_material_missing", `${location}.material_id`, diagnostics);
    if (fromLocationId) validateReference(fromLocationId, refs.locationIds, "operation_source_location_missing", `${location}.source_location_id`, diagnostics);
    if (toLocationId) validateReference(toLocationId, refs.locationIds, "operation_destination_location_missing", `${location}.destination_location_id`, diagnostics);
    if (actorUserId) validateReference(actorUserId, refs.userIds, "operation_actor_missing", `${location}.actor_user_id`, diagnostics);
    const quantity = positiveInteger(field(row, ["Кількість", "quantity"], 7));
    if (quantity === null) diagnostics.error("operation_quantity_invalid", `${location}.quantity`, "Кількість операції має бути додатним цілим числом.");
    const rawType = cleanText(field(row, ["Тип операції", "operation_type"], 3));
    const operationType = OPERATION_TYPE_MAP[rawType] || "other";
    if (operationType === "other") diagnostics.warning("operation_type_unknown", `${location}.operation_type`, "Невідомий тип операції збережено як other.", rawType);
    const rawStatus = cleanText(field(row, ["Статус", "status"], 8));
    const status = OPERATION_STATUS_MAP[rawStatus] || "other";
    if (status === "other") diagnostics.warning("operation_status_unknown", `${location}.status`, "Невідомий статус операції збережено як other.", rawStatus);
    if (status === "confirmed" && !fromLocationId && !toLocationId) {
      diagnostics.error("operation_locations_missing", location, "Підтверджена операція не має джерела або призначення.", operationId);
    }
    if (fromLocationId && fromLocationId === toLocationId) {
      diagnostics.error("operation_same_location", location, "Джерело і призначення операції збігаються.", operationId);
    }
    const requestId = cleanText(field(row, ["Request ID застосування (службове)", "request_id"], 15));
    if (requestId && seenRequests.has(requestId)) {
      diagnostics.error("operation_request_duplicate", `${location}.request_id`, "Request ID операції повторюється.", { request_id: requestId, first_operation_id: seenRequests.get(requestId) });
    } else if (requestId) seenRequests.set(requestId, operationId);
    result.push({
      operation_id: operationId,
      occurred_on: normalizeDate(field(row, ["Дата", "date"], 1), `${location}.date`, diagnostics),
      material_id: materialId,
      operation_type: operationType,
      operation_type_source: rawType || null,
      source_location_id: fromLocationId || null,
      destination_location_id: toLocationId || null,
      condition: cleanText(field(row, ["Стан", "condition"], 6)) || null,
      quantity: quantity ?? 0,
      status,
      status_source: rawStatus || null,
      actor_user_id: actorUserId || null,
      actor_name_snapshot: cleanText(field(row, ["Відповідальний (ПІБ)", "actor_name"], 9)) || null,
      notes: cleanText(field(row, ["Примітка", "notes"], 10)) || null,
      request_id: requestId || null,
    });
  }
  return result.sort(operationOrder);
}

function normalizeRevisionJournal(rows, refs, diagnostics) {
  const result = [];
  const seenRequests = new Map();
  for (const row of rows) {
    const location = `sheets.revisionJournal.rows[${row.index}]`;
    const requestId = cleanText(field(row, ["request_id"], 0));
    if (!requestId && rowIsEmpty(row)) continue;
    if (!requestId) {
      diagnostics.error("revision_request_missing", `${location}.request_id`, "Ревізія не має request_id.");
      continue;
    }
    if (seenRequests.has(requestId)) {
      diagnostics.error("revision_request_duplicate", `${location}.request_id`, "Request ID ревізії повторюється.", { request_id: requestId, first_row: seenRequests.get(requestId) });
      continue;
    }
    seenRequests.set(requestId, row.index);
    const materialId = cleanText(field(row, ["material_id"], 2)).toUpperCase();
    const locationId = cleanText(field(row, ["location_id"], 3)).toUpperCase();
    validateReference(materialId, refs.materialIds, "revision_material_missing", `${location}.material_id`, diagnostics);
    validateReference(locationId, refs.locationIds, "revision_location_missing", `${location}.location_id`, diagnostics);
    const expected = nonNegativeInteger(field(row, ["expected"], 5));
    const counted = nonNegativeInteger(field(row, ["counted"], 6));
    const difference = signedInteger(field(row, ["difference"], 7));
    if (expected === null || counted === null || difference === null) {
      diagnostics.error("revision_quantity_invalid", location, "expected, counted і difference мають бути цілими числами.");
    } else if (difference !== counted - expected) {
      diagnostics.error("revision_difference_mismatch", `${location}.difference`, "Різниця ревізії не дорівнює counted - expected.", { expected, counted, difference });
    }
    const operationId = cleanText(field(row, ["operation_id"], 11)).toUpperCase();
    if (operationId && !refs.operationIds.has(operationId)) {
      diagnostics.error("revision_operation_missing", `${location}.operation_id`, "Пов'язану операцію не знайдено.", operationId);
    }
    if (difference === 0 && operationId) {
      diagnostics.warning("revision_zero_has_operation", location, "Нульова ревізія не повинна змінювати баланс.", operationId);
    }
    if (difference !== null && difference !== 0 && !operationId) {
      diagnostics.warning("revision_adjustment_unlinked", location, "Ненульова ревізія не має пов'язаної операції.", requestId);
    }
    result.push({
      request_id: requestId,
      session_id: cleanText(field(row, ["session_id"], 1)) || null,
      material_id: materialId,
      location_id: locationId,
      location_name_snapshot: cleanText(field(row, ["location_name"], 4)) || null,
      expected_quantity: expected ?? 0,
      counted_quantity: counted ?? 0,
      difference: difference ?? 0,
      occurred_on: normalizeDate(field(row, ["date"], 8), `${location}.date`, diagnostics),
      actor_name_snapshot: cleanText(field(row, ["actor"], 9)) || null,
      notes: cleanText(field(row, ["notes"], 10)) || null,
      operation_id: operationId || null,
    });
  }
  return result;
}

function validateRevisionOperations(revisions, operations, diagnostics) {
  const byId = new Map(operations.map((row) => [row.operation_id, row]));
  for (const revision of revisions) {
    if (!revision.operation_id) continue;
    const operation = byId.get(revision.operation_id);
    if (!operation) continue;
    if (operation.material_id !== revision.material_id) {
      diagnostics.error("revision_operation_material_mismatch", `revision.${revision.request_id}`, "Ревізія та операція посилаються на різні матеріали.", {
        revision_material_id: revision.material_id,
        operation_material_id: operation.material_id,
      });
    }
    if (operation.operation_type !== "adjustment") {
      diagnostics.warning("revision_operation_type_unexpected", `revision.${revision.request_id}`, "Пов'язана операція не є коригуванням.", operation.operation_type_source);
    }
    if (operation.quantity !== Math.abs(revision.difference)) {
      diagnostics.error("revision_operation_quantity_mismatch", `revision.${revision.request_id}`, "Кількість операції не відповідає різниці ревізії.", {
        operation_quantity: operation.quantity,
        revision_difference: revision.difference,
      });
    }
  }
}

function deriveBalances(openingStock, operations, locations, diagnostics) {
  const quantities = new Map();
  const openingTotal = openingStock.reduce((sum, row) => sum + row.quantity, 0);
  const locationDirectory = new Map(locations.map((row) => [row.location_id, row]));

  for (const row of openingStock) addQuantity(quantities, row.material_id, row.location_id, row.quantity);

  const confirmed = operations.filter((row) => row.status === "confirmed").sort(operationOrder);
  for (const row of confirmed) {
    if (row.source_location_id) {
      const before = quantityAt(quantities, row.material_id, row.source_location_id);
      const after = before - row.quantity;
      if (after < 0) {
        diagnostics.error("stock_negative", `operation.${row.operation_id}`, "Операція створює від'ємний залишок.", {
          material_id: row.material_id,
          location_id: row.source_location_id,
          before,
          quantity: row.quantity,
          after,
        });
      }
      setQuantity(quantities, row.material_id, row.source_location_id, after);
    }
    if (row.destination_location_id) {
      addQuantity(quantities, row.material_id, row.destination_location_id, row.quantity);
    }
  }

  const balances = [];
  let finalTotal = 0;
  let activeTotal = 0;
  let serviceTotal = 0;
  let negativeRows = 0;
  for (const [key, quantity] of [...quantities.entries()].sort()) {
    const [materialId, locationId] = key.split("\u0000");
    if (quantity < 0) negativeRows += 1;
    if (quantity === 0) continue;
    const location = locationDirectory.get(locationId);
    finalTotal += quantity;
    if (location?.is_service) serviceTotal += quantity;
    else if (location?.is_active) activeTotal += quantity;
    balances.push({
      balance_id: `${materialId}:${locationId}`,
      material_id: materialId,
      location_id: locationId,
      quantity,
    });
  }
  return {
    balances,
    stockReport: {
      opening_total: openingTotal,
      confirmed_operations: confirmed.length,
      final_total: finalTotal,
      active_total: activeTotal,
      service_total: serviceTotal,
      nonzero_balance_rows: balances.length,
      negative_balance_rows: negativeRows,
    },
  };
}

function buildReport({ source, tables, ignoredSheets, isbnDiagnostics, stockReport, errors, warnings }) {
  const linkClassifications = countBy(tables.material_links, "classification");
  const operationTypes = countBy(tables.operations, "operation_type");
  const operationStatuses = countBy(tables.operations, "status");
  const materialWithLinks = new Set(tables.material_links.map((row) => row.material_id)).size;
  return {
    ok: errors.length === 0,
    source,
    ignored_sheets: ignoredSheets,
    counts: Object.fromEntries(Object.entries(tables).map(([key, rows]) => [key, rows.length])),
    links: {
      materials_with_links: materialWithLinks,
      materials_without_links: Math.max(0, tables.materials.length - materialWithLinks),
      coverage_percent: tables.materials.length
        ? Math.round((materialWithLinks / tables.materials.length) * 1000) / 10
        : 0,
      by_classification: linkClassifications,
    },
    isbn: isbnDiagnostics,
    stock: stockReport,
    operations: {
      by_type: operationTypes,
      by_status: operationStatuses,
    },
    revisions: {
      count: tables.revision_checks.length,
      zero_difference: tables.revision_checks.filter((row) => row.difference === 0).length,
      with_operation: tables.revision_checks.filter((row) => row.operation_id).length,
    },
    diagnostics: {
      error_count: errors.length,
      warning_count: warnings.length,
      errors,
      warnings,
    },
  };
}

export function normalizeSearchText(value) {
  return cleanText(value)
    .normalize("NFKC")
    .toLocaleLowerCase("uk-UA")
    .replace(/[’ʼ`´]/gu, "'")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

export function classifyResourceUrl(value) {
  const url = new URL(value);
  const host = url.hostname.toLocaleLowerCase("en-US").replace(/^www\./u, "");
  const extension = url.pathname.toLocaleLowerCase("en-US").match(/\.([a-z0-9]{2,5})$/u)?.[1] || null;
  if (extension && DIRECT_DOCUMENT_EXTENSIONS.has(extension)) {
    return { classification: "direct_document", host, file_format: extension, is_direct_file: true };
  }
  if (host === "drive.google.com" || host === "docs.google.com") {
    return { classification: "cloud_document", host, file_format: null, is_direct_file: false };
  }
  if (COMMERCIAL_HOSTS.has(host)) {
    return { classification: "commercial_page", host, file_format: null, is_direct_file: false };
  }
  return { classification: "information_page", host, file_format: null, is_direct_file: false };
}

function normalizeHttpUrl(value, location, diagnostics) {
  try {
    const url = new URL(cleanText(value));
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported_protocol");
    if (url.username || url.password) throw new Error("credentials_forbidden");
    if (!url.hostname) throw new Error("hostname_missing");
    if (url.protocol === "http:") diagnostics.warning("url_not_https", location, "Посилання використовує HTTP, а не HTTPS.", value);
    return url.toString();
  } catch {
    diagnostics.error("url_invalid", location, "Некоректне HTTP(S)-посилання.", value);
    return null;
  }
}

function classifyCoverStorage(value) {
  const url = new URL(value);
  if (url.hostname.toLocaleLowerCase("en-US") === "raw.githubusercontent.com") return "github_raw";
  return "external_url";
}

function normalizeIsbn(value) {
  const normalized = cleanText(value).toLocaleUpperCase("en-US").replace(/[^0-9X]/gu, "");
  return /^(?:\d{13}|\d{9}[0-9X])$/u.test(normalized) ? normalized : normalized || null;
}

function isValidIsbn(value) {
  if (/^\d{13}$/u.test(value)) {
    const sum = [...value].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0);
    return sum % 10 === 0;
  }
  if (/^\d{9}[0-9X]$/u.test(value)) {
    const sum = [...value].reduce((total, digit, index) => {
      const number = digit === "X" ? 10 : Number(digit);
      return total + number * (10 - index);
    }, 0);
    return sum % 11 === 0;
  }
  return false;
}

function normalizeDate(value, location, diagnostics) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = Date.UTC(1899, 11, 30) + Math.floor(value) * 86_400_000;
    return new Date(millis).toISOString().slice(0, 10);
  }
  const text = cleanText(value);
  if (!text) {
    diagnostics.error("date_missing", location, "Відсутня дата.");
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text) && isCalendarDate(text)) return text;
  const match = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/u);
  if (match) {
    const iso = `${match[3]}-${match[2]}-${match[1]}`;
    if (isCalendarDate(iso)) return iso;
  }
  if (isIsoDateTime(text)) return text.slice(0, 10);
  diagnostics.error("date_invalid", location, "Некоректна дата.", text);
  return null;
}

function normalizeOptionalDate(value, location, diagnostics) {
  if (!cleanText(value)) return null;
  return normalizeDate(value, location, diagnostics);
}

function isCalendarDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isIsoDateTime(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) && Number.isFinite(Date.parse(value));
}

function validateReference(value, directory, code, location, diagnostics) {
  if (!value || !directory.has(value)) diagnostics.error(code, location, "Посилання на довідник не знайдено.", value || null);
}

function rowIsEmpty(row) {
  if (row.cells) return row.cells.every((value) => !cleanText(value));
  return Object.values(row.data).every((value) => !cleanText(value));
}

function cleanText(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

function optionalInteger(value, minimum, maximum) {
  if (!cleanText(value)) return null;
  const number = Number(cleanText(value).replace(/\s/gu, "").replace(",", "."));
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : null;
}

function positiveInteger(value) {
  return optionalInteger(value, 1, Number.MAX_SAFE_INTEGER);
}

function nonNegativeInteger(value) {
  return optionalInteger(value, 0, Number.MAX_SAFE_INTEGER);
}

function signedInteger(value) {
  if (!cleanText(value)) return null;
  const number = Number(cleanText(value).replace(/\s/gu, "").replace(",", "."));
  return Number.isSafeInteger(number) ? number : null;
}

function addQuantity(map, materialId, locationId, amount) {
  setQuantity(map, materialId, locationId, quantityAt(map, materialId, locationId) + amount);
}

function setQuantity(map, materialId, locationId, quantity) {
  map.set(`${materialId}\u0000${locationId}`, quantity);
}

function quantityAt(map, materialId, locationId) {
  return map.get(`${materialId}\u0000${locationId}`) || 0;
}

function sortRows(rows, key) {
  return [...rows].sort((left, right) => String(left[key] || "").localeCompare(String(right[key] || ""), "uk", { numeric: true }));
}

function operationOrder(left, right) {
  return left.operation_id.localeCompare(right.operation_id, "en", { numeric: true });
}

function compareRows(left, right) {
  return stableStringify(left).localeCompare(stableStringify(right), "en");
}

function digest(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function countBy(rows, key) {
  const counts = {};
  for (const row of rows) counts[row[key] || "unknown"] = (counts[row[key] || "unknown"] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right, "en")));
}

function compactNulls(value) {
  return Object.fromEntries(Object.entries(value));
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function stableStringify(value, space = 2) {
  return JSON.stringify(stableValue(value), null, space);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.input) throw new Error("Вкажіть --input <canonical-export.json>.");
  if (/^https?:\/\//iu.test(args.input)) throw new Error("Імпортер приймає лише локальний JSON, не URL.");

  const inputPath = path.resolve(args.input);
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const { bundle, report } = importCanonicalExport(input);
  const bundleText = `${stableStringify(bundle)}\n`;
  const reportText = `${stableStringify(report)}\n`;

  if (args.output) {
    const outputPath = path.resolve(args.output);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, bundleText, "utf8");
  } else {
    process.stdout.write(bundleText);
  }
  if (args.report) {
    const reportPath = path.resolve(args.report);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, reportText, "utf8");
  }
  if (!report.ok) process.exitCode = 2;
  return { bundle, report };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--input", "--output", "--report"].includes(key)) throw new Error(`Невідомий аргумент: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Відсутнє значення для ${key}.`);
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  runCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
