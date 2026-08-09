import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const rawCover = "https://raw.githubusercontent.com/nazarijshvetz1/library-covers/main/covers/CAT-0112.jpg";

function sheet(rows) {
  return {
    getLastRow: () => rows.length + 1,
    getRange: () => ({ getValues: () => rows }),
  };
}

test("Apps Script creates a sanitized catalog and excludes service balances", async () => {
  const source = await readFile(new URL("../apps-script/PublicCatalogApi.gs", import.meta.url), "utf8");
  const material = Array(25).fill("");
  Object.assign(material, {
    0: "CAT-0112", 1: "Стара рубрика", 2: "Підручник", 3: "Математика",
    4: 2, 5: 2, 6: "Математика — 2 клас", 7: "Автор", 8: 2024,
    9: 9780306406157, 20: "Підручники і хрестоматії", 24: "978-0-306-40615-7",
  });
  const sheets = {
    "Матеріали": sheet([material]),
    "Обкладинки": sheet([["CAT-0112", "", rawCover]]),
    "Баланс": sheet([
      ["", "CAT-0112", "", "LOC-001", "Бібліотека", 3],
      ["", "CAT-0112", "", "LOC-007", "Списано", 9],
    ]),
    "Місця": sheet([
      ["LOC-001", "Бібліотека", "Бібліотека", "Активне"],
      ["LOC-007", "Списано", "Службове місце", "Активне"],
    ]),
  };
  const cache = new Map();
  const context = vm.createContext({
    console: { error() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    SpreadsheetApp: { openById: () => ({ getSheetByName: (name) => sheets[name] || null }) },
    CacheService: { getScriptCache: () => ({
      get: (key) => cache.get(key) || null,
      getAll: (keys) => Object.fromEntries(keys.filter((key) => cache.has(key)).map((key) => [key, cache.get(key)])),
      put: (key, value) => cache.set(key, value),
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: "json", JAVASCRIPT: "javascript" },
      createTextOutput: (text) => ({ text, setMimeType(mime) { this.mime = mime; return this; } }),
    },
  });
  vm.runInContext(source, context);

  const payload = context.buildPublicCatalogPayload_();
  assert.equal(payload.materials.length, 1);
  assert.equal(payload.stats.copies, 3);
  assert.equal(payload.stats.locations, 1);
  assert.equal(payload.materials[0].quantity, 3);
  assert.equal(payload.materials[0].stock.library, 3);
  assert.equal(payload.materials[0].cover, rawCover);
  assert.equal(payload.materials[0].isbn, "9780306406157");
  assert.deepEqual(JSON.parse(JSON.stringify(payload.materials[0].stock.locations)), [{ name: "Бібліотека", quantity: 3 }]);

  const jsonp = context.jsonResponse_(payload, "safe.callback");
  assert.equal(jsonp.mime, "javascript");
  assert.match(jsonp.text, /^safe\.callback\(/);
  const rejectedCallback = context.jsonResponse_(payload, "alert(1)");
  assert.equal(rejectedCallback.mime, "json");
});

test("public catalog read target is configurable independently from the write gateway", async () => {
  const source = await readFile(new URL("../apps-script/PublicCatalogApi.gs", import.meta.url), "utf8");
  const productionId = "18SEyo-tAJ8uHoAFMrYbiaGMtmXjhiscQGcYTpJrNtEI";
  const copyId = "1SyntheticCatalogSpreadsheetId_00000000000000000";
  const properties = new Map([["SPREADSHEET_ID", "write-gateway-target-must-not-be-used"]]);
  const opened = [];
  const emptySheet = sheet([]);
  const context = vm.createContext({
    console: { error() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (key) => properties.has(key) ? properties.get(key) : null,
    }) },
    SpreadsheetApp: { openById: (id) => {
      opened.push(id);
      return { getSheetByName: () => emptySheet };
    } },
    CacheService: { getScriptCache: () => ({ get: () => null, getAll: () => ({}), put() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: "json", JAVASCRIPT: "javascript" },
      createTextOutput: (text) => ({ text, setMimeType(mime) { this.mime = mime; return this; } }),
    },
  });
  vm.runInContext(source, context);

  context.buildPublicCatalogPayload_();
  assert.equal(opened.at(-1), productionId);

  properties.set("PUBLIC_CATALOG_SPREADSHEET_ID", copyId);
  context.buildPublicCatalogPayload_();
  assert.equal(opened.at(-1), copyId);
  assert.notEqual(opened.at(-1), properties.get("SPREADSHEET_ID"));

  properties.set("PUBLIC_CATALOG_SPREADSHEET_ID", "   ");
  assert.throws(
    () => context.buildPublicCatalogPayload_(),
    /Некоректний PUBLIC_CATALOG_SPREADSHEET_ID/,
  );
});

test("gateway invalidates only the configured public catalog target cache", async () => {
  const [publicSource, gatewaySource] = await Promise.all([
    readFile(new URL("../apps-script/PublicCatalogApi.gs", import.meta.url), "utf8"),
    readFile(new URL("../apps-script/LibrarianGateway.gs", import.meta.url), "utf8"),
  ]);
  const publicId = "1SyntheticPublicCatalogTarget_000000000000000";
  const otherId = "1SyntheticUnrelatedTarget_000000000000000000";
  const properties = new Map([
    ["PUBLIC_CATALOG_SPREADSHEET_ID", publicId],
    ["SPREADSHEET_ID", "1IndependentWriteTarget_00000000000000000000"],
  ]);
  const prefix = `public-catalog-v2:${publicId}`;
  const otherPrefix = `public-catalog-v2:${otherId}`;
  const cache = new Map([
    [`${prefix}:meta`, JSON.stringify({ chunks: 2, length: 12 })],
    [`${prefix}:0`, "target-part-0"],
    [`${prefix}:1`, "target-part-1"],
    [`${otherPrefix}:meta`, JSON.stringify({ chunks: 1, length: 5 })],
    [`${otherPrefix}:0`, "other"],
  ]);
  const removed = [];
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (key) => properties.has(key) ? properties.get(key) : null,
    }) },
    CacheService: { getScriptCache: () => ({
      get: (key) => cache.get(key) ?? null,
      removeAll: (keys) => {
        removed.push(...keys);
        keys.forEach((key) => cache.delete(key));
      },
    }) },
  });
  vm.runInContext(publicSource, context);
  vm.runInContext(gatewaySource, context);

  context.invalidateGatewayPublicCatalogCache_();

  assert.deepEqual(removed, [`${prefix}:meta`, `${prefix}:0`, `${prefix}:1`]);
  assert.equal(cache.has(`${prefix}:meta`), false);
  assert.equal(cache.has(`${prefix}:0`), false);
  assert.equal(cache.has(`${prefix}:1`), false);
  assert.equal(cache.get(`${otherPrefix}:meta`), JSON.stringify({ chunks: 1, length: 5 }));
  assert.equal(cache.get(`${otherPrefix}:0`), "other");
});
