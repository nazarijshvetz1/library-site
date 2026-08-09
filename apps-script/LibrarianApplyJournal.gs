/**
 * Durable, spreadsheet-local idempotency journal for librarian writes.
 *
 * Script Properties remain a small response cache only.  The hidden sheet is
 * the source of truth when an HTTP response is lost or an Apps Script
 * invocation stops after one of several domain writes.
 */

var LIBRARIAN_APPLY_JOURNAL_SHEET = "Журнал застосувань";
var LIBRARIAN_APPLY_JOURNAL_MAX_ROWS = 10000;
var LIBRARIAN_APPLY_JOURNAL_HEADERS = [
  "request_id",
  "fingerprint",
  "draft_id",
  "revision",
  "kind",
  "target",
  "state",
  "plan_json",
  "result_json",
  "created_at",
  "updated_at",
  "error",
];

function ensureApplyJournalSheet_(spreadsheet) {
  var sheet = spreadsheet.getSheetByName(LIBRARIAN_APPLY_JOURNAL_SHEET);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(LIBRARIAN_APPLY_JOURNAL_SHEET);
    sheet.getRange(1, 1, 1, LIBRARIAN_APPLY_JOURNAL_HEADERS.length)
      .setValues([LIBRARIAN_APPLY_JOURNAL_HEADERS]);
    if (typeof sheet.hideSheet === "function") sheet.hideSheet();
    return sheet;
  }

  var headers = sheet.getRange(1, 1, 1, LIBRARIAN_APPLY_JOURNAL_HEADERS.length)
    .getDisplayValues()[0];
  LIBRARIAN_APPLY_JOURNAL_HEADERS.forEach(function (expected, index) {
    if (String(headers[index] || "").trim() !== expected) {
      throw gatewayApplyError_(
        "journal_schema_mismatch",
        "Структура аркуша «Журнал застосувань» не відповідає захищеній схемі.",
      );
    }
  });
  if (typeof sheet.hideSheet === "function") sheet.hideSheet();
  return sheet;
}

function findApplyJournalEntry_(sheet, requestId) {
  var lastRow = Number(sheet.getLastRow()) || 1;
  if (lastRow < 2) return null;
  if (lastRow > LIBRARIAN_APPLY_JOURNAL_MAX_ROWS) {
    throw gatewayApplyError_("journal_full", "Журнал застосувань перевищив безпечний ліміт.");
  }
  var values = sheet.getRange(
    2,
    1,
    lastRow - 1,
    LIBRARIAN_APPLY_JOURNAL_HEADERS.length,
  ).getDisplayValues();
  var matches = [];
  values.forEach(function (row, index) {
    if (String(row[0] || "").trim() === requestId) matches.push(index + 2);
  });
  if (matches.length > 1) {
    throw gatewayApplyError_("duplicate_journal_request", "request_id повторюється у журналі застосувань.");
  }
  return matches.length ? readApplyJournalEntry_(sheet, matches[0]) : null;
}

function readApplyJournalEntry_(sheet, row) {
  var values = sheet.getRange(
    row,
    1,
    1,
    LIBRARIAN_APPLY_JOURNAL_HEADERS.length,
  ).getDisplayValues()[0];
  return {
    sheet: sheet,
    row: row,
    requestId: String(values[0] || "").trim(),
    fingerprint: String(values[1] || "").trim(),
    draftId: String(values[2] || "").trim(),
    revision: Number(values[3]) || 0,
    kind: String(values[4] || "").trim(),
    target: parseApplyJournalJson_(values[5], null),
    state: String(values[6] || "").trim(),
    plan: parseApplyJournalJson_(values[7], {}),
    result: parseApplyJournalJson_(values[8], null),
    createdAt: String(values[9] || "").trim(),
    updatedAt: String(values[10] || "").trim(),
    error: String(values[11] || ""),
  };
}

function prepareApplyJournalEntry_(spreadsheet, input, fingerprint, target, plan) {
  var sheet = ensureApplyJournalSheet_(spreadsheet);
  var existing = findApplyJournalEntry_(sheet, input.requestId);
  if (existing) {
    if (existing.fingerprint !== fingerprint ||
        !existing.target || existing.target.spreadsheet_id !== target.spreadsheetId ||
        existing.target.write_mode !== target.mode) {
      throw gatewayApplyError_(
        "request_id_conflict",
        "Цей request_id уже використано для іншого вмісту або цільової таблиці.",
      );
    }
    return existing;
  }

  var targetRow = nextApplyJournalRow_(sheet);
  ensureSheetRowExists_(sheet, targetRow);
  var now = new Date().toISOString();
  var values = [
    input.requestId,
    fingerprint,
    input.draftId,
    input.revision,
    input.kind,
    JSON.stringify({ write_mode: target.mode, spreadsheet_id: target.spreadsheetId }),
    "prepared",
    stringifyApplyJournalJson_(plan || {}),
    "",
    now,
    now,
    "",
  ];
  var range = sheet.getRange(targetRow, 1, 1, values.length);
  var formulas = range.getFormulas()[0];
  var current = range.getDisplayValues()[0];
  if (formulas.some(function (formula) { return Boolean(formula); }) ||
      current.some(function (value) { return String(value || "").trim() !== ""; })) {
    throw gatewayApplyError_("journal_target_not_empty", "Цільовий рядок журналу вже зайнятий.");
  }
  range.setValues([values]);
  SpreadsheetApp.flush();
  var prepared = readApplyJournalEntry_(sheet, targetRow);
  if (prepared.requestId !== input.requestId || prepared.state !== "prepared") {
    throw new Error("Google Sheets не підтвердив підготовку журналу застосувань.");
  }
  return prepared;
}

function nextApplyJournalRow_(sheet) {
  var lastRow = Number(sheet.getLastRow()) || 1;
  if (lastRow >= LIBRARIAN_APPLY_JOURNAL_MAX_ROWS) {
    throw gatewayApplyError_("journal_full", "Журнал застосувань заповнений.");
  }
  if (lastRow < 2) return 2;
  var requestIds = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
  var lastDataRow = 1;
  requestIds.forEach(function (row, index) {
    if (String(row[0] || "").trim()) lastDataRow = index + 2;
  });
  return lastDataRow + 1;
}

function updateApplyJournalEntry_(entry, state, plan, result, errorMessage) {
  var allowed = ["prepared", "applying", "applied", "failed"];
  if (allowed.indexOf(state) === -1) throw new Error("Некоректний стан журналу застосувань.");
  var range = entry.sheet.getRange(
    entry.row,
    1,
    1,
    LIBRARIAN_APPLY_JOURNAL_HEADERS.length,
  );
  var values = range.getValues()[0];
  if (String(values[0] || "").trim() !== entry.requestId ||
      String(values[1] || "").trim() !== entry.fingerprint) {
    throw new Error("Журнал застосувань змінився під час операції.");
  }
  values[6] = state;
  values[7] = stringifyApplyJournalJson_(plan || entry.plan || {});
  values[8] = result ? stringifyApplyJournalJson_(result) : "";
  values[10] = new Date().toISOString();
  values[11] = String(errorMessage || "").slice(0, 2000);
  range.setValues([values]);
  SpreadsheetApp.flush();
  entry.state = state;
  entry.plan = plan || entry.plan || {};
  entry.result = result || null;
  entry.error = String(errorMessage || "");
  return entry;
}

function checkpointApplyJournal_(entry, stepName) {
  var plan = entry.plan || {};
  var completed = Array.isArray(plan.completed_steps) ? plan.completed_steps.slice() : [];
  if (completed.indexOf(stepName) === -1) completed.push(stepName);
  plan.completed_steps = completed;
  updateApplyJournalEntry_(entry, "applying", plan, null, "");
}

/**
 * Persist a domain-write intent immediately before the first cell/row mutation
 * in a resumable step.  A gateway error before this marker is known to have
 * changed no domain data; after it, retries must reconcile the same request.
 */
function markApplyJournalWriteIntent_(entry, stepName) {
  var intent = "write_started:" + String(stepName || "domain");
  if (!hasApplyJournalCheckpoint_(entry, intent)) {
    checkpointApplyJournal_(entry, intent);
  }
  return intent;
}

function hasApplyJournalCheckpoint_(entry, stepName) {
  var completed = entry && entry.plan && Array.isArray(entry.plan.completed_steps)
    ? entry.plan.completed_steps
    : [];
  return completed.indexOf(stepName) !== -1;
}

function hasAnyApplyJournalCheckpoint_(entry) {
  return Boolean(
    entry && entry.plan && Array.isArray(entry.plan.completed_steps) &&
    entry.plan.completed_steps.length,
  );
}

/**
 * IDs selected by a prepared/applying request are reservations even before a
 * domain row exists.  A later request must not allocate the same CAT/cohort/CY
 * after the first invocation is stopped between journal preparation and its
 * first write intent.
 */
function collectApplyJournalReservations_(spreadsheet) {
  var reserved = {
    material_ids: {},
    cohort_ids: {},
    class_year_ids: {},
  };
  var sheet = spreadsheet.getSheetByName(LIBRARIAN_APPLY_JOURNAL_SHEET);
  if (!sheet) return reserved;
  sheet = ensureApplyJournalSheet_(spreadsheet);
  var lastRow = Number(sheet.getLastRow()) || 1;
  if (lastRow < 2) return reserved;
  if (lastRow > LIBRARIAN_APPLY_JOURNAL_MAX_ROWS) {
    throw gatewayApplyError_("journal_full", "Журнал застосувань перевищив безпечний ліміт.");
  }
  var rows = sheet.getRange(2, 1, lastRow - 1, 8).getDisplayValues();
  rows.forEach(function (row) {
    var state = String(row[6] || "").trim();
    if (state !== "prepared" && state !== "applying") return;
    var plan = parseApplyJournalJson_(row[7], {});
    reserveApplyPlanId_(reserved.material_ids, plan.material_id, /^CAT-\d{4,}$/);
    if (plan.cohort_create) {
      reserveApplyPlanId_(reserved.cohort_ids, plan.cohort_id, /^COH-\d{3,}$/);
    }
    reserveApplyPlanId_(reserved.class_year_ids, plan.class_year_id, /^CY-20\d{2}-\d{3,}$/);
    (Array.isArray(plan.items) ? plan.items : []).forEach(function (item) {
      reserveApplyPlanId_(reserved.class_year_ids, item && item.target_id, /^CY-20\d{2}-\d{3,}$/);
    });
  });
  return reserved;
}

function reserveApplyPlanId_(target, rawId, pattern) {
  var id = String(rawId || "").trim().toUpperCase();
  if (pattern.test(id)) target[id] = true;
}

function parseApplyJournalJson_(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    var parsed = JSON.parse(String(value));
    if (parsed && parsed._journal_encoding === "gzip-base64" && typeof parsed.data === "string") {
      if (typeof Utilities.ungzip !== "function") {
        throw new Error("gzip is unavailable");
      }
      var uncompressed = Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(parsed.data)))
        .getDataAsString("UTF-8");
      parsed = JSON.parse(uncompressed);
    }
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (error) {
    throw gatewayApplyError_("journal_corrupt", "Пошкоджено JSON у журналі застосувань.");
  }
}

function stringifyApplyJournalJson_(value) {
  var text = JSON.stringify(value);
  if (text.length <= 45000) return text;
  if (typeof Utilities.gzip !== "function") {
    throw gatewayApplyError_("journal_payload_too_large", "План операції завеликий для журналу.");
  }
  var compressed = Utilities.gzip(Utilities.newBlob(text, "application/json")).getBytes();
  var wrapped = JSON.stringify({
    _journal_encoding: "gzip-base64",
    data: Utilities.base64Encode(compressed),
  });
  if (wrapped.length > 49000) {
    throw gatewayApplyError_("journal_payload_too_large", "План операції завеликий для журналу.");
  }
  return wrapped;
}
