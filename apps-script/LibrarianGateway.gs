/**
 * Захищений шлюз для приватного кабінету бібліотекаря.
 *
 * Script Property SHEETS_GATEWAY_SECRET встановлюється вручну й ніколи не
 * зберігається у клітинках або коді. Публічний doGet з PublicCatalogApi.gs
 * залишається без змін. Запис доступний лише через HMAC, явний серверний прапорець
 * LIBRARIAN_WRITES_ENABLED і перевірений список безпечних операцій.
 */

var LIBRARIAN_GATEWAY_MAX_AGE_SECONDS = 300;
var LIBRARIAN_GATEWAY_NONCE_TTL_SECONDS = 600;
var LIBRARIAN_GATEWAY_PRODUCTION_SPREADSHEET_ID = "18SEyo-tAJ8uHoAFMrYbiaGMtmXjhiscQGcYTpJrNtEI";
var LIBRARIAN_GATEWAY_APPLY_LEDGER_LIMIT = 75;
var LIBRARIAN_GATEWAY_APPLY_LEDGER_TTL_MS = 90 * 24 * 60 * 60 * 1000;
var LIBRARIAN_GATEWAY_APPLY_INDEX_KEY = "GATEWAY_APPLY_INDEX_V1";

function doPost(e) {
  try {
    var request = parseGatewayRequest_(e);
    verifyGatewayRequest_(request);

    if (request.action === "referenceData") {
      return gatewayJson_({
        success: true,
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        referenceData: buildLibrarianReferenceData_(),
      });
    }
    if (request.action === "applyDraft") {
      return gatewayJson_(applyGatewayDraft_(request.payload));
    }

    return gatewayJson_({ success: false, error: "Непідтримувана дія." });
  } catch (error) {
    return gatewayJson_({
      success: false,
      error: error && error.message ? error.message : "Помилка захищеного шлюзу.",
    });
  }
}

function parseGatewayRequest_(e) {
  var raw = e && e.postData && e.postData.contents;
  if (!raw || raw.length > 200000) throw new Error("Некоректний запит.");
  var request = JSON.parse(raw);
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Некоректний запит.");
  }
  return request;
}

function verifyGatewayRequest_(request) {
  var secret = PropertiesService.getScriptProperties().getProperty("SHEETS_GATEWAY_SECRET");
  if (!secret || secret.length < 32) throw new Error("Шлюз ще не налаштовано.");

  var action = String(request.action || "");
  var timestamp = Number(request.timestamp);
  var nonce = String(request.nonce || "");
  var signature = String(request.signature || "");
  var payload = request.payload && typeof request.payload === "object"
    ? request.payload
    : {};

  if (!/^[a-z][A-Za-z0-9]{1,63}$/.test(action)) throw new Error("Некоректна дія.");
  if (!/^[-A-Za-z0-9_]{20,120}$/.test(nonce)) throw new Error("Некоректний nonce.");
  if (!/^[-A-Za-z0-9_]{40,120}$/.test(signature)) throw new Error("Некоректний підпис.");
  if (!isFinite(timestamp)) throw new Error("Некоректний час запиту.");

  var now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > LIBRARIAN_GATEWAY_MAX_AGE_SECONDS) {
    throw new Error("Термін дії запиту минув.");
  }

  var payloadHash = digestWebSafe_(JSON.stringify(payload));
  var canonical = [action, String(timestamp), nonce, payloadHash].join("\n");
  var expected = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(canonical, secret, Utilities.Charset.UTF_8),
  ).replace(/=+$/, "");
  if (!constantTimeEqual_(signature, expected)) throw new Error("Невірний підпис.");

  var nonceKey = "gateway-nonce-" + digestWebSafe_(nonce).slice(0, 36);
  var cache = CacheService.getScriptCache();
  var nonceLock = LockService.getScriptLock();
  if (!nonceLock.tryLock(10000)) throw new Error("Шлюз зайнятий. Повторіть запит.");
  try {
    if (cache.get(nonceKey)) throw new Error("Повторний запит відхилено.");
    cache.put(nonceKey, "1", LIBRARIAN_GATEWAY_NONCE_TTL_SECONDS);
  } finally {
    nonceLock.releaseLock();
  }
}

function buildLibrarianReferenceData_() {
  var spreadsheet = openGatewaySpreadsheet_();
  return {
    teachers: readReferenceRows_(spreadsheet, "Користувачі", 6, function (row) {
      if (!/^USR-\d{3,}$/.test(row[0]) || !row[1]) return null;
      if (!/(Учитель|Адміністрац|Бібліотекар)/i.test(row[2])) return null;
      return { id: row[0], name: row[1], role: row[2], status: row[5] };
    }),
    locations: readReferenceRows_(spreadsheet, "Місця", 4, function (row) {
      if (!/^LOC-\d{3,}$/.test(row[0]) || !row[1] || /^(LOC-007|LOC-008)$/.test(row[0])) return null;
      return { id: row[0], name: row[1], type: row[2], status: row[3] };
    }),
    academicYears: readReferenceRows_(spreadsheet, "Навчальні роки", 6, function (row) {
      if (!/^YR-20\d{2}-20\d{2}$/.test(row[0]) || !/^20\d{2}\/20\d{2}$/.test(row[1])) return null;
      return {
        id: row[0], label: row[1], startDate: row[2], endDate: row[3],
        status: row[4], notes: row[5],
      };
    }),
    classYears: readReferenceRows_(spreadsheet, "Класи за роками", 16, function (row) {
      if (!/^CY-20\d{2}-\d{3,}$/.test(row[0]) || !/^YR-20\d{2}-20\d{2}$/.test(row[1])) return null;
      return {
        id: row[0], academicYearId: row[1], academicYearLabel: row[2], cohortId: row[3],
        className: row[4], grade: Number(row[5]) || null, code: row[6],
        teacherName: row[7], teacherUserId: row[8], locationName: row[9], locationId: row[10],
        startDate: row[11], endDate: row[12], status: row[13], actualClosedDate: row[14], notes: row[15],
      };
    }),
  };
}

function openGatewaySpreadsheet_(verifiedSpreadsheetId) {
  var configured = verifiedSpreadsheetId ||
    PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  var spreadsheetId = String(configured || "").trim();
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(spreadsheetId)) {
    throw new Error("Некоректний SPREADSHEET_ID у властивостях скрипту.");
  }
  var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  if (!spreadsheet) throw new Error("Не вдалося відкрити службову Google-таблицю.");
  return spreadsheet;
}

function applyGatewayDraft_(rawPayload) {
  var input = validateApplyEnvelope_(rawPayload);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error("Шлюз зайнятий. Повторіть запит із тим самим request_id.");
  }
  try {
    var properties = PropertiesService.getScriptProperties();
    var writeTarget;
    try {
      writeTarget = assertGatewayWriteTarget_(properties);
    } catch (error) {
      if (!error || !error.gatewayCode) throw error;
      return applyFailure_(input, error.gatewayCode, error.message);
    }
    var ledgerKey = "GATEWAY_APPLY_" + digestWebSafe_(input.requestId).slice(0, 40);
    var fingerprint = digestWebSafe_(JSON.stringify({
      draft_id: input.draftId,
      revision: input.revision,
      kind: input.kind,
      payload: input.payload,
      write_mode: writeTarget.mode,
      spreadsheet_id: writeTarget.spreadsheetId,
    }));
    var remembered = readApplyResult_(properties.getProperty(ledgerKey));
    if (remembered) {
      if (remembered.fingerprint !== fingerprint) {
        return applyFailure_(
          input,
          "request_id_conflict",
          "Цей request_id уже використано для іншого вмісту.",
        );
      }
      return remembered.response;
    }
    var writesEnabled = String(
      properties.getProperty("LIBRARIAN_WRITES_ENABLED") || "",
    ).toLowerCase() === "true";
    if (!writesEnabled) {
      return applyFailure_(
        input,
        "writes_disabled",
        "Запис до Google Sheets вимкнено. Дані не змінено.",
      );
    }

    var response;
    try {
      var result = dispatchSafeApply_(input, writeTarget.spreadsheetId);
      SpreadsheetApp.flush();
      response = {
        success: true,
        schemaVersion: 1,
        request_id: input.requestId,
        draft_id: input.draftId,
        kind: input.kind,
        applied_at: new Date().toISOString(),
        result: result,
      };
    } catch (error) {
      if (!error || !error.gatewayCode) throw error;
      response = applyFailure_(input, error.gatewayCode, error.message);
    }

    rememberApplyResult_(properties, ledgerKey, fingerprint, response);
    return response;
  } finally {
    lock.releaseLock();
  }
}

function assertGatewayWriteTarget_(properties) {
  var mode = String(properties.getProperty("LIBRARIAN_WRITE_MODE") || "").trim();
  var spreadsheetId = String(properties.getProperty("SPREADSHEET_ID") || "").trim();
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(spreadsheetId)) {
    throw gatewayApplyError_(
      "invalid_spreadsheet_id",
      "Некоректний SPREADSHEET_ID у властивостях скрипту.",
    );
  }
  if (mode === "copy_test") {
    if (spreadsheetId === LIBRARIAN_GATEWAY_PRODUCTION_SPREADSHEET_ID) {
      throw gatewayApplyError_(
        "unsafe_write_target",
        "Тестовий режим не може записувати до продуктивної таблиці.",
      );
    }
    return { mode: mode, spreadsheetId: spreadsheetId };
  }
  if (mode === "production") {
    if (spreadsheetId !== LIBRARIAN_GATEWAY_PRODUCTION_SPREADSHEET_ID) {
      throw gatewayApplyError_(
        "unsafe_write_target",
        "Продуктивний режим дозволяє лише основну службову таблицю.",
      );
    }
    return { mode: mode, spreadsheetId: spreadsheetId };
  }
  throw gatewayApplyError_(
    "write_mode_disabled",
    "Режим запису не налаштовано. Дані не змінено.",
  );
}

function validateApplyEnvelope_(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw gatewayApplyError_("invalid_apply_request", "Некоректний запит на застосування.");
  }
  var requestId = String(raw.request_id || "").trim();
  var draftId = String(raw.draft_id || "").trim();
  var revision = Number(raw.revision);
  var kind = String(raw.kind || "").trim();
  var payload = raw.payload;
  var uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(requestId)) {
    throw gatewayApplyError_("invalid_request_id", "Некоректний request_id.");
  }
  if (!uuidPattern.test(draftId)) {
    throw gatewayApplyError_("invalid_draft_id", "Некоректний draft_id.");
  }
  if (!isFinite(revision) || Math.floor(revision) !== revision || revision < 1) {
    throw gatewayApplyError_("invalid_revision", "Некоректна ревізія чернетки.");
  }
  if (!/^[a-z]+(?:[.-][a-z]+){1,4}$/.test(kind)) {
    throw gatewayApplyError_("invalid_kind", "Некоректний тип чернетки.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw gatewayApplyError_("invalid_payload", "Некоректні дані чернетки.");
  }
  if (JSON.stringify(payload).length > 50000) {
    throw gatewayApplyError_("payload_too_large", "Дані чернетки завеликі.");
  }
  return {
    requestId: requestId,
    draftId: draftId,
    revision: revision,
    kind: kind,
    payload: payload,
  };
}

function dispatchSafeApply_(input, verifiedSpreadsheetId) {
  if (input.kind === "academic-year.create") {
    return applyAcademicYearCreate_(
      openGatewaySpreadsheet_(verifiedSpreadsheetId),
      input.payload,
    );
  }
  throw gatewayApplyError_(
    "unsupported_kind",
    "Цей тип чернетки ще не має перевіреного безпечного запису.",
  );
}

function applyAcademicYearCreate_(spreadsheet, payload) {
  validateExactKeys_(payload, ["label", "startDate", "endDate", "notes"]);
  var label = requiredText_(payload.label, 9, "Назва навчального року відсутня.");
  var labelMatch = label.match(/^(20\d{2})\/(20\d{2})$/);
  if (!labelMatch || Number(labelMatch[2]) !== Number(labelMatch[1]) + 1) {
    throw gatewayApplyError_("invalid_academic_year", "Навчальний рік має формат 2026/2027.");
  }
  var startDate = requiredIsoDate_(payload.startDate, "Некоректна дата початку.");
  var endDate = requiredIsoDate_(payload.endDate, "Некоректна дата завершення.");
  if (startDate >= endDate || startDate.slice(0, 4) !== labelMatch[1] ||
      endDate.slice(0, 4) !== labelMatch[2]) {
    throw gatewayApplyError_("invalid_academic_year_dates", "Дати не відповідають навчальному року.");
  }
  var notes = optionalSafeText_(payload.notes, 2000);
  var academicYearId = "YR-" + label.replace("/", "-");
  var sheet = spreadsheet.getSheetByName("Навчальні роки");
  if (!sheet) throw gatewayApplyError_("sheet_not_found", "Не знайдено аркуш «Навчальні роки».");

  var columns = resolveAcademicYearColumns_(sheet);
  var expected = {
    id: academicYearId,
    label: label,
    startDate: startDate,
    endDate: endDate,
    status: "Чернетка",
    notes: notes,
  };
  var existingRow = findAcademicYearRow_(sheet, columns, academicYearId, label);
  if (existingRow) {
    reconcileAcademicYearRow_(spreadsheet, sheet, existingRow, columns, expected);
    SpreadsheetApp.flush();
    verifyAcademicYearRow_(spreadsheet, sheet, existingRow, columns, expected);
    return {
      status: "already_applied",
      message: "Навчальний рік уже був доданий цим запитом.",
      sheet: "Навчальні роки",
      row: existingRow,
      academic_year_id: academicYearId,
      already_applied: true,
    };
  }

  var targetRow = nextAcademicYearRow_(sheet, columns);
  ensureSheetRowExists_(sheet, targetRow);
  writeAcademicYearRow_(sheet, targetRow, columns, expected);
  SpreadsheetApp.flush();
  verifyAcademicYearRow_(spreadsheet, sheet, targetRow, columns, expected);
  return {
    status: "applied",
    message: "Навчальний рік додано.",
    sheet: "Навчальні роки",
    row: targetRow,
    academic_year_id: academicYearId,
    already_applied: false,
  };
}

function resolveAcademicYearColumns_(sheet) {
  var lastColumn = Math.max(6, Number(sheet.getLastColumn()) || 0);
  if (lastColumn > 100) throw gatewayApplyError_("schema_mismatch", "Забагато колонок у службовому аркуші.");
  var headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  var definitions = {
    id: ["ID навчального року", "ID року"],
    label: ["Навчальний рік"],
    startDate: ["Дата початку"],
    endDate: ["Дата завершення", "Дата закінчення"],
    status: ["Статус"],
    notes: ["Примітка", "Примітки"],
  };
  var result = {};
  Object.keys(definitions).forEach(function (key) {
    var accepted = definitions[key].map(normalizeHeader_);
    headers.forEach(function (header, index) {
      if (accepted.indexOf(normalizeHeader_(header)) !== -1) {
        if (result[key]) {
          throw gatewayApplyError_("schema_mismatch", "Заголовок службового аркуша повторюється.");
        }
        result[key] = index + 1;
      }
    });
    if (!result[key]) {
      throw gatewayApplyError_("schema_mismatch", "Не знайдено обов’язковий заголовок: " + definitions[key][0]);
    }
  });
  var orderedColumns = academicYearFieldKeys_()
    .map(function (key) { return result[key]; })
    .sort(function (left, right) { return left - right; });
  if (orderedColumns.join(",") !== "1,2,3,4,5,6") {
    throw gatewayApplyError_(
      "schema_mismatch",
      "Колонки аркуша «Навчальні роки» мають бути єдиним блоком A:F.",
    );
  }
  return result;
}

function findAcademicYearRow_(sheet, columns, id, label) {
  var lastRow = Number(sheet.getLastRow()) || 0;
  if (lastRow < 2) return 0;
  if (lastRow > 20000) throw gatewayApplyError_("sheet_too_large", "Службовий аркуш перевищує безпечний ліміт.");
  var width = 6;
  var rows = sheet.getRange(2, 1, lastRow - 1, width).getDisplayValues();
  var matches = [];
  rows.forEach(function (row, index) {
    var rowId = String(row[columns.id - 1] || "").trim();
    var rowLabel = String(row[columns.label - 1] || "").trim();
    if (rowId === id || rowLabel === label) matches.push(index + 2);
  });
  if (matches.length > 1) {
    throw gatewayApplyError_("duplicate_academic_year", "У таблиці знайдено дублікати цього навчального року.");
  }
  return matches[0] || 0;
}

function nextAcademicYearRow_(sheet, columns) {
  var lastRow = Number(sheet.getLastRow()) || 1;
  if (lastRow < 2) return 2;
  if (lastRow > 20000) throw gatewayApplyError_("sheet_too_large", "Службовий аркуш перевищує безпечний ліміт.");
  var width = 6;
  var rows = sheet.getRange(2, 1, lastRow - 1, width).getDisplayValues();
  var lastDataRow = 1;
  rows.forEach(function (row, index) {
    var hasData = academicYearFieldKeys_().some(function (key) {
      return String(row[columns[key] - 1] || "").trim() !== "";
    });
    if (hasData) lastDataRow = index + 2;
  });
  return lastDataRow + 1;
}

function ensureSheetRowExists_(sheet, row) {
  var maximum = Number(sheet.getMaxRows()) || 0;
  if (row > maximum) sheet.insertRowsAfter(maximum, row - maximum);
}

function writeAcademicYearRow_(sheet, row, columns, expected) {
  var range = sheet.getRange(row, 1, 1, 6);
  var current = range.getValues()[0];
  var formulas = range.getFormulas()[0];
  academicYearFieldKeys_().forEach(function (key) {
    var index = columns[key] - 1;
    if (formulas[index]) {
      throw gatewayApplyError_("formula_protected", "Цільова клітинка містить формулу; запис зупинено.");
    }
    if (String(current[index] === null || current[index] === undefined ? "" : current[index]).trim()) {
      throw gatewayApplyError_("target_row_not_empty", "Цільовий рядок уже містить дані; запис зупинено.");
    }
  });
  var output = current.slice();
  academicYearFieldKeys_().forEach(function (key) {
    output[columns[key] - 1] = key === "startDate" || key === "endDate"
      ? isoDateValue_(expected[key])
      : expected[key];
  });
  range.setValues([output]);
}

function reconcileAcademicYearRow_(spreadsheet, sheet, row, columns, expected) {
  var range = sheet.getRange(row, 1, 1, 6);
  var current = range.getValues()[0];
  var formulas = range.getFormulas()[0];
  var output = current.slice();
  var needsWrite = false;
  academicYearFieldKeys_().forEach(function (key) {
    var index = columns[key] - 1;
    var actual = normalizedAcademicYearCell_(spreadsheet, current[index], key);
    var wanted = String(expected[key]);
    if (actual === wanted) return;
    if (actual !== "") {
      throw gatewayApplyError_("academic_year_conflict", "Навчальний рік уже існує з іншими даними.");
    }
    if (formulas[index]) {
      throw gatewayApplyError_("formula_protected", "Клітинка з формулою не може бути змінена.");
    }
    output[index] = key === "startDate" || key === "endDate"
      ? isoDateValue_(wanted)
      : wanted;
    needsWrite = true;
  });
  if (needsWrite) {
    academicYearFieldKeys_().forEach(function (key) {
      if (formulas[columns[key] - 1]) {
        throw gatewayApplyError_(
          "formula_protected",
          "Рядок містить формулу; часткове доповнення зупинено.",
        );
      }
    });
    range.setValues([output]);
  }
}

function verifyAcademicYearRow_(spreadsheet, sheet, row, columns, expected) {
  academicYearFieldKeys_().forEach(function (key) {
    var actual = normalizedAcademicYearCell_(
      spreadsheet,
      sheet.getRange(row, columns[key]).getValue(),
      key,
    );
    if (actual !== String(expected[key])) {
      throw new Error("Google Sheets не підтвердив запис навчального року.");
    }
  });
}

function academicYearFieldKeys_() {
  return ["id", "label", "startDate", "endDate", "status", "notes"];
}

function normalizedAcademicYearCell_(spreadsheet, value, key) {
  if (key === "startDate" || key === "endDate") {
    if (Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value.getTime())) {
      return Utilities.formatDate(value, spreadsheet.getSpreadsheetTimeZone(), "yyyy-MM-dd");
    }
  }
  return String(value === null || value === undefined ? "" : value).trim();
}

function isoDateValue_(value) {
  var parts = String(value).split("-").map(Number);
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12, 0, 0));
}

function requiredIsoDate_(value, message) {
  var text = requiredText_(value, 10, message);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw gatewayApplyError_("invalid_date", message);
  var date = isoDateValue_(text);
  if (isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw gatewayApplyError_("invalid_date", message);
  }
  return text;
}

function requiredText_(value, maximum, message) {
  if (typeof value !== "string") throw gatewayApplyError_("invalid_payload", message);
  var text = value.trim();
  if (!text || text.length > maximum || /^[=+\-@]/.test(text)) {
    throw gatewayApplyError_("invalid_payload", message);
  }
  return text;
}

function optionalSafeText_(value, maximum) {
  if (value === undefined || value === null || value === "") return "";
  return requiredText_(value, maximum, "Некоректна примітка.");
}

function validateExactKeys_(value, allowed) {
  Object.keys(value).forEach(function (key) {
    if (allowed.indexOf(key) === -1) {
      throw gatewayApplyError_("unsupported_payload_field", "Чернетка містить непідтримуване поле.");
    }
  });
}

function normalizeHeader_(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("uk-UA");
}

function gatewayApplyError_(code, message) {
  var error = new Error(message);
  error.gatewayCode = code;
  return error;
}

function applyFailure_(input, code, message) {
  return {
    success: false,
    schemaVersion: 1,
    request_id: input.requestId,
    draft_id: input.draftId,
    kind: input.kind,
    code: code,
    error: message,
  };
}

function readApplyResult_(value) {
  if (!value) return null;
  try {
    var parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || typeof parsed.fingerprint !== "string" ||
        !parsed.response || typeof parsed.response !== "object") return null;
    return parsed;
  } catch (error) {
    return null;
  }
}

function rememberApplyResult_(properties, key, fingerprint, response) {
  var now = Date.now();
  properties.setProperty(key, JSON.stringify({
    fingerprint: fingerprint,
    response: response,
    storedAt: now,
  }));

  var index;
  try {
    index = JSON.parse(properties.getProperty(LIBRARIAN_GATEWAY_APPLY_INDEX_KEY) || "[]");
  } catch (error) {
    index = [];
  }
  if (!Array.isArray(index)) index = [];
  var cutoff = now - LIBRARIAN_GATEWAY_APPLY_LEDGER_TTL_MS;
  var kept = [];
  index.forEach(function (item) {
    if (!item || typeof item.key !== "string" || !isFinite(Number(item.at))) return;
    if (item.key === key) return;
    if (Number(item.at) < cutoff) {
      properties.deleteProperty(item.key);
      return;
    }
    kept.push({ key: item.key, at: Number(item.at) });
  });
  kept.push({ key: key, at: now });
  kept.sort(function (left, right) { return left.at - right.at; });
  while (kept.length > LIBRARIAN_GATEWAY_APPLY_LEDGER_LIMIT) {
    properties.deleteProperty(kept.shift().key);
  }
  properties.setProperty(LIBRARIAN_GATEWAY_APPLY_INDEX_KEY, JSON.stringify(kept));
}

function readReferenceRows_(spreadsheet, sheetName, columnCount, mapper) {
  var sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) throw new Error("Не знайдено службовий аркуш: " + sheetName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, Math.min(lastRow - 1, 5000), columnCount)
    .getDisplayValues()
    .map(function (row) { return mapper(row.map(function (value) { return String(value || "").trim(); })); })
    .filter(function (value) { return Boolean(value); });
}

function digestWebSafe_(value) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8),
  ).replace(/=+$/, "");
}

function constantTimeEqual_(left, right) {
  if (left.length !== right.length) return false;
  var difference = 0;
  for (var index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function gatewayJson_(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
