/**
 * Публічний API каталогу бібліотеки.
 *
 * Скрипт лише читає чотири службові аркуші й повертає обмежений набір
 * полів, потрібних сайту. Користувачі, електронні адреси, примітки та
 * службові операції ніколи не потрапляють у відповідь.
 */

var PUBLIC_CATALOG_CONFIG = Object.freeze({
  spreadsheetId: "18SEyo-tAJ8uHoAFMrYbiaGMtmXjhiscQGcYTpJrNtEI",
  cachePrefix: "public-catalog-v2",
  cacheSeconds: 300,
  cacheChunkCharacters: 40000,
  excludedLocationIds: ["LOC-007", "LOC-008"],
});

function doGet(e) {
  try {
    var payload = getPublicCatalogPayload_();
    return jsonResponse_(payload, e && e.parameter ? e.parameter.callback : "");
  } catch (error) {
    console.error("Public catalog error: " + safeErrorMessage_(error));
    return jsonResponse_({
      schemaVersion: 1,
      success: false,
      status: "temporarily_unavailable",
      message: "Каталог тимчасово недоступний",
    }, e && e.parameter ? e.parameter.callback : "");
  }
}

function getPublicCatalogPayload_() {
  var cached = readCachedPayload_();
  if (cached) return cached;

  var lock = LockService.getScriptLock();
  var hasLock = lock.tryLock(5000);
  try {
    if (hasLock) {
      cached = readCachedPayload_();
      if (cached) return cached;
    }
    var payload = buildPublicCatalogPayload_();
    if (hasLock) writeCachedPayload_(payload);
    return payload;
  } finally {
    if (hasLock) lock.releaseLock();
  }
}

function buildPublicCatalogPayload_() {
  var spreadsheet = SpreadsheetApp.openById(PUBLIC_CATALOG_CONFIG.spreadsheetId);
  var materialsSheet = requiredSheet_(spreadsheet, "Матеріали");
  var coversSheet = requiredSheet_(spreadsheet, "Обкладинки");
  var balancesSheet = requiredSheet_(spreadsheet, "Баланс");
  var locationsSheet = requiredSheet_(spreadsheet, "Місця");

  var covers = readCovers_(coversSheet);
  var locationDirectory = readLocations_(locationsSheet);
  var stock = readStock_(balancesSheet, locationDirectory);
  var rows = readRows_(materialsSheet, 25);
  var materials = [];
  var rubrics = {};
  var copies = 0;

  rows.forEach(function (row) {
    var id = text_(row[0]).toUpperCase();
    var title = text_(row[6]);
    if (!/^CAT-\d{4,}$/.test(id) || !title) return;

    var itemStock = stock[id] || emptyStock_();
    var rubric = text_(row[20]) || text_(row[1]) || "Без рубрики";
    rubrics[rubric] = true;
    copies += itemStock.total;

    materials.push({
      id: id,
      rubric: rubric,
      type: text_(row[2]) || "Не зазначено",
      subject: text_(row[3]) || "Не зазначено",
      classFrom: grade_(row[4]),
      classTo: grade_(row[5]) || grade_(row[4]),
      title: title,
      author: text_(row[7]),
      year: year_(row[8]),
      isbn: isbn_(row[24] || row[9]),
      cover: covers[id] || "",
      quantity: itemStock.total,
      stock: itemStock,
    });
  });

  materials.sort(function (a, b) {
    return a.id.localeCompare(b.id, "uk", { numeric: true });
  });

  return {
    schemaVersion: 1,
    success: true,
    generatedAt: new Date().toISOString(),
    stats: {
      materials: materials.length,
      copies: copies,
      locations: publicLocationCount_(locationDirectory),
      rubrics: Object.keys(rubrics).length,
    },
    materials: materials,
  };
}

function readCovers_(sheet) {
  var result = {};
  readRows_(sheet, 3).forEach(function (row) {
    var id = text_(row[0]).toUpperCase();
    var url = safeCoverUrl_(row[2]);
    if (/^CAT-\d{4,}$/.test(id) && url) result[id] = url;
  });
  return result;
}

function readLocations_(sheet) {
  var result = {};
  readRows_(sheet, 4).forEach(function (row) {
    var id = text_(row[0]).toUpperCase();
    if (!id) return;
    result[id] = {
      name: text_(row[1]),
      type: text_(row[2]),
      status: text_(row[3]),
    };
  });
  return result;
}

function readStock_(sheet, locationDirectory) {
  var result = {};
  readRows_(sheet, 6).forEach(function (row) {
    var id = text_(row[1]).toUpperCase();
    var locationId = text_(row[3]).toUpperCase();
    var quantity = positiveInteger_(row[5]);
    if (!/^CAT-\d{4,}$/.test(id) || !quantity || isExcludedLocation_(locationId, locationDirectory)) return;

    var directoryEntry = locationDirectory[locationId] || {};
    var locationName = text_(row[4]) || directoryEntry.name || "Інше місце";
    if (!result[id]) result[id] = emptyStock_();
    var item = result[id];
    var existing = item.locations.filter(function (location) { return location.name === locationName; })[0];
    if (existing) existing.quantity += quantity;
    else item.locations.push({ name: locationName, quantity: quantity });
    item.total += quantity;
    if (isLibraryLocation_(locationName, directoryEntry.type)) item.library += quantity;
    else item.other += quantity;
  });

  Object.keys(result).forEach(function (id) {
    result[id].locations.sort(function (a, b) { return a.name.localeCompare(b.name, "uk"); });
  });
  return result;
}

function isExcludedLocation_(locationId, directory) {
  if (PUBLIC_CATALOG_CONFIG.excludedLocationIds.indexOf(locationId) !== -1) return true;
  var entry = directory[locationId] || {};
  return /службов/i.test(text_(entry.type)) || /неактив|закрит/i.test(text_(entry.status));
}

function isLibraryLocation_(name, type) {
  return /бібліотек/i.test(text_(name)) || /бібліотек/i.test(text_(type));
}

function publicLocationCount_(directory) {
  return Object.keys(directory).filter(function (locationId) {
    return !isExcludedLocation_(locationId, directory);
  }).length;
}

function emptyStock_() {
  return { total: 0, library: 0, other: 0, locations: [] };
}

function readRows_(sheet, width) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, width).getValues();
}

function requiredSheet_(spreadsheet, name) {
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) throw new Error("Не знайдено аркуш: " + name);
  return sheet;
}

function safeCoverUrl_(value) {
  var url = text_(value);
  return /^https:\/\/raw\.githubusercontent\.com\/nazarijshvetz1\/library-covers\/main\/covers\/CAT-\d{4,}\.jpg(?:\?.*)?$/i.test(url) ? url : "";
}

function text_(value) {
  return String(value === null || typeof value === "undefined" ? "" : value).trim();
}

function grade_(value) {
  var match = text_(value).match(/(?:^|\D)(1[01]|[1-9])(?:\D|$)/);
  return match ? Number(match[1]) : 0;
}

function year_(value) {
  var match = text_(value).match(/(?:19|20)\d{2}/);
  return match ? Number(match[0]) : "";
}

function isbn_(value) {
  var normalized = text_(value).toUpperCase().replace(/[\s-]+/g, "");
  return /^(?:\d{13}|\d{9}[\dX])$/.test(normalized) ? normalized : "";
}

function positiveInteger_(value) {
  var number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function readCachedPayload_() {
  var cache = CacheService.getScriptCache();
  var metaText = cache.get(PUBLIC_CATALOG_CONFIG.cachePrefix + ":meta");
  if (!metaText) return null;
  try {
    var meta = JSON.parse(metaText);
    if (!meta || !Number.isInteger(meta.chunks) || meta.chunks < 1 || meta.chunks > 100) return null;
    var keys = [];
    for (var index = 0; index < meta.chunks; index += 1) keys.push(PUBLIC_CATALOG_CONFIG.cachePrefix + ":" + index);
    var values = cache.getAll(keys);
    var json = keys.map(function (key) { return values[key] || ""; }).join("");
    if (json.length !== meta.length) return null;
    return JSON.parse(json);
  } catch (error) {
    return null;
  }
}

function writeCachedPayload_(payload) {
  var cache = CacheService.getScriptCache();
  var json = JSON.stringify(payload);
  var chunkSize = PUBLIC_CATALOG_CONFIG.cacheChunkCharacters;
  var chunks = [];
  for (var start = 0; start < json.length; start += chunkSize) chunks.push(json.slice(start, start + chunkSize));
  chunks.forEach(function (chunk, index) {
    cache.put(PUBLIC_CATALOG_CONFIG.cachePrefix + ":" + index, chunk, PUBLIC_CATALOG_CONFIG.cacheSeconds);
  });
  cache.put(PUBLIC_CATALOG_CONFIG.cachePrefix + ":meta", JSON.stringify({ chunks: chunks.length, length: json.length }), PUBLIC_CATALOG_CONFIG.cacheSeconds);
}

function jsonResponse_(payload, callback) {
  var json = JSON.stringify(payload);
  if (callback && validCallback_(callback)) {
    return ContentService.createTextOutput(callback + "(" + json + ");")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function validCallback_(value) {
  return /^[A-Za-z_$][0-9A-Za-z_$]*(?:\.[A-Za-z_$][0-9A-Za-z_$]*)*$/.test(String(value || ""));
}

function safeErrorMessage_(error) {
  return error && error.message ? String(error.message).slice(0, 300) : "Unknown error";
}
