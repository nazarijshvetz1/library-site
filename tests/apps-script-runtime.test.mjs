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
  const material = Array(21).fill("");
  Object.assign(material, {
    0: "CAT-0112", 1: "Стара рубрика", 2: "Підручник", 3: "Математика",
    4: 2, 5: 2, 6: "Математика — 2 клас", 7: "Автор", 8: 2024, 20: "Підручники і хрестоматії",
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
  assert.deepEqual(JSON.parse(JSON.stringify(payload.materials[0].stock.locations)), [{ name: "Бібліотека", quantity: 3 }]);

  const jsonp = context.jsonResponse_(payload, "safe.callback");
  assert.equal(jsonp.mime, "javascript");
  assert.match(jsonp.text, /^safe\.callback\(/);
  const rejectedCallback = context.jsonResponse_(payload, "alert(1)");
  assert.equal(rejectedCallback.mime, "json");
});
