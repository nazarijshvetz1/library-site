import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  isSupportedDraftApplyKind,
  validateDraftApplyInput,
} from "../lib/draft-apply-validation.ts";

const draftId = "8092f8cf-6e7b-4f4b-9e29-56dd684268f2";
const requestId = "437e85df-1491-43b8-8831-06dc88fb12b7";

function appsScriptFixture() {
  const rows = [
    [
      "ID навчального року",
      "Навчальний рік",
      "Дата початку",
      "Дата завершення",
      "Статус",
      "Примітка",
    ],
    [
      "YR-2026-2027",
      "2026/2027",
      new Date("2026-09-01T12:00:00.000Z"),
      new Date("2027-08-31T12:00:00.000Z"),
      "Активний",
      "",
    ],
  ];
  const formulas = [];
  const properties = new Map();
  const cache = new Map();
  const lockStats = { acquired: 0, released: 0 };
  let flushes = 0;

  const ensureCell = (row, column) => {
    while (rows.length < row) rows.push([]);
    while (rows[row - 1].length < column) rows[row - 1].push("");
    while (formulas.length < row) formulas.push([]);
    while (formulas[row - 1].length < column) formulas[row - 1].push("");
  };
  const display = (value) => value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value ?? "");
  const range = (startRow, startColumn, rowCount = 1, columnCount = 1) => ({
    getDisplayValues() {
      return Array.from({ length: rowCount }, (_, rowOffset) =>
        Array.from({ length: columnCount }, (_, columnOffset) => {
          ensureCell(startRow + rowOffset, startColumn + columnOffset);
          return display(rows[startRow + rowOffset - 1][startColumn + columnOffset - 1]);
        }));
    },
    getValues() {
      return Array.from({ length: rowCount }, (_, rowOffset) =>
        Array.from({ length: columnCount }, (_, columnOffset) => {
          ensureCell(startRow + rowOffset, startColumn + columnOffset);
          return rows[startRow + rowOffset - 1][startColumn + columnOffset - 1];
        }));
    },
    getFormulas() {
      return Array.from({ length: rowCount }, (_, rowOffset) =>
        Array.from({ length: columnCount }, (_, columnOffset) => {
          ensureCell(startRow + rowOffset, startColumn + columnOffset);
          return formulas[startRow + rowOffset - 1][startColumn + columnOffset - 1];
        }));
    },
    getValue() {
      ensureCell(startRow, startColumn);
      return rows[startRow - 1][startColumn - 1];
    },
    getFormula() {
      ensureCell(startRow, startColumn);
      return formulas[startRow - 1][startColumn - 1];
    },
    setValue(value) {
      ensureCell(startRow, startColumn);
      rows[startRow - 1][startColumn - 1] = value;
      return this;
    },
    setValues(values) {
      assert.equal(values.length, rowCount);
      values.forEach((sourceRow, rowOffset) => {
        assert.equal(sourceRow.length, columnCount);
        sourceRow.forEach((value, columnOffset) => {
          ensureCell(startRow + rowOffset, startColumn + columnOffset);
          rows[startRow + rowOffset - 1][startColumn + columnOffset - 1] = value;
        });
      });
      return this;
    },
  });
  const sheet = {
    getLastColumn: () => 6,
    getLastRow: () => {
      let last = 1;
      rows.forEach((row, index) => {
        if (row.some((value) => display(value).trim())) last = index + 1;
      });
      return last;
    },
    getMaxRows: () => 100,
    insertRowsAfter() {},
    getRange: range,
  };
  const spreadsheet = {
    getSheetByName: (name) => name === "Навчальні роки" ? sheet : null,
    getSpreadsheetTimeZone: () => "Europe/Kyiv",
  };
  const scriptProperties = {
    getProperty: (key) => properties.get(key) ?? null,
    setProperty(key, value) { properties.set(key, String(value)); return this; },
    deleteProperty(key) { properties.delete(key); return this; },
  };
  const lock = {
    tryLock() { lockStats.acquired += 1; return true; },
    releaseLock() { lockStats.released += 1; },
  };
  const context = vm.createContext({
    CacheService: {
      getScriptCache: () => ({
        get: (key) => cache.get(key) ?? null,
        put: (key, value) => cache.set(key, value),
      }),
    },
    ContentService: {
      MimeType: { JSON: "json" },
      createTextOutput: (text) => ({
        text,
        setMimeType(mime) { this.mime = mime; return this; },
      }),
    },
    LockService: { getScriptLock: () => lock },
    PropertiesService: { getScriptProperties: () => scriptProperties },
    SpreadsheetApp: {
      openById(id) {
        assert.equal(id, "18SEyo-tAJ8uHoAFMrYbiaGMtmXjhiscQGcYTpJrNtEI");
        return spreadsheet;
      },
      flush() { flushes += 1; },
    },
    Utilities: {
      Charset: { UTF_8: "utf8" },
      DigestAlgorithm: { SHA_256: "sha256" },
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString("base64url"),
      computeDigest: (_algorithm, value) => [...createHash("sha256").update(value).digest()],
      computeHmacSha256Signature: (value, secret) => [...createHmac("sha256", secret).update(value).digest()],
      formatDate: (value) => value.toISOString().slice(0, 10),
    },
  });
  return {
    context,
    rows,
    formulas,
    properties,
    lockStats,
    get flushes() { return flushes; },
  };
}

function applyEnvelope(overrides = {}) {
  return {
    request_id: requestId,
    draft_id: draftId,
    revision: 2,
    kind: "academic-year.create",
    payload: {
      label: "2027/2028",
      startDate: "2027-09-01",
      endDate: "2028-08-31",
      notes: "Новий навчальний рік",
    },
    ...overrides,
  };
}

test("apply request validation supports a server-generated idempotency key", () => {
  const withoutRequestId = validateDraftApplyInput({ id: draftId, revision: 2 });
  assert.equal(withoutRequestId.ok, true);
  if (withoutRequestId.ok) assert.equal(withoutRequestId.value.requestId, undefined);

  assert.equal(validateDraftApplyInput({ id: draftId, revision: 2, requestId }).ok, true);
  assert.equal(validateDraftApplyInput({ id: draftId, revision: 0 }).ok, false);
  assert.equal(validateDraftApplyInput({ id: draftId, revision: 2, requestId: "../x" }).ok, false);
  assert.equal(isSupportedDraftApplyKind("academic-year.create"), true);
  assert.equal(isSupportedDraftApplyKind("material.create"), false);
});

test("Apps Script keeps writes disabled until both sides are explicitly enabled", async () => {
  const fixture = appsScriptFixture();
  const source = await readFile(new URL("../apps-script/LibrarianGateway.gs", import.meta.url), "utf8");
  vm.runInContext(source, fixture.context);

  const result = fixture.context.applyGatewayDraft_(applyEnvelope());
  assert.equal(result.success, false);
  assert.equal(result.code, "writes_disabled");
  assert.equal(fixture.rows.length, 2);
  assert.equal(fixture.lockStats.acquired, 1);
  assert.equal(fixture.lockStats.released, 1);
});

test("Apps Script rejects a replay while nonce cache access is locked", async () => {
  const fixture = appsScriptFixture();
  const secret = "gateway-test-secret-with-at-least-32-characters";
  fixture.properties.set("SHEETS_GATEWAY_SECRET", secret);
  const source = await readFile(new URL("../apps-script/LibrarianGateway.gs", import.meta.url), "utf8");
  vm.runInContext(source, fixture.context);

  const action = "referenceData";
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = "0123456789abcdef0123456789abcdef";
  const payload = {};
  const payloadHash = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("base64url");
  const signature = createHmac("sha256", secret)
    .update([action, String(timestamp), nonce, payloadHash].join("\n"))
    .digest("base64url");
  const request = { action, timestamp, nonce, payload, signature };

  assert.doesNotThrow(() => fixture.context.verifyGatewayRequest_(request));
  assert.throws(
    () => fixture.context.verifyGatewayRequest_(request),
    /Повторний запит відхилено/,
  );
  assert.equal(fixture.lockStats.acquired, 2);
  assert.equal(fixture.lockStats.released, 2);
});

test("Apps Script applies one exact academic-year row and resumes idempotently", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  const source = await readFile(new URL("../apps-script/LibrarianGateway.gs", import.meta.url), "utf8");
  vm.runInContext(source, fixture.context);

  const first = fixture.context.applyGatewayDraft_(applyEnvelope());
  assert.equal(first.success, true);
  assert.equal(first.result.status, "applied");
  assert.equal(first.result.row, 3);
  assert.equal(fixture.rows[2][0], "YR-2027-2028");
  assert.equal(fixture.rows[2][1], "2027/2028");
  assert.equal(fixture.rows[2][2].toISOString().slice(0, 10), "2027-09-01");
  assert.equal(fixture.rows[2][4], "Запланований");
  assert.equal(fixture.rows.length, 3);

  const replay = fixture.context.applyGatewayDraft_(applyEnvelope());
  assert.equal(replay.success, true);
  assert.equal(replay.result.row, 3);
  assert.equal(fixture.rows.length, 3);
  assert.equal(fixture.lockStats.acquired, fixture.lockStats.released);
  assert.ok(fixture.flushes >= 1);

  const newRequestSameOperation = fixture.context.applyGatewayDraft_(applyEnvelope({
    request_id: "8e67575c-a04c-45e8-88c3-b8062716e21a",
  }));
  assert.equal(newRequestSameOperation.success, true);
  assert.equal(newRequestSameOperation.result.status, "already_applied");
  assert.equal(fixture.rows.length, 3);

  const conflictingReuse = fixture.context.applyGatewayDraft_(applyEnvelope({
    payload: {
      label: "2028/2029",
      startDate: "2028-09-01",
      endDate: "2029-08-31",
    },
  }));
  assert.equal(conflictingReuse.success, false);
  assert.equal(conflictingReuse.code, "request_id_conflict");
  assert.equal(fixture.rows.length, 3);

  for (let index = 0; index < 80; index += 1) {
    fixture.context.rememberApplyResult_(
      fixture.context.PropertiesService.getScriptProperties(),
      `GATEWAY_APPLY_TEST_${index}`,
      `fingerprint-${index}`,
      { success: false, code: "test" },
    );
  }
  const ledger = fixture.properties.get("GATEWAY_APPLY_INDEX_V1");
  assert.ok(Buffer.byteLength(ledger, "utf8") < 9_000);
  assert.ok(JSON.parse(ledger).length <= 75);
});

test("Apps Script rejects schema drift and formulas before any cell write", async () => {
  const fixture = appsScriptFixture();
  fixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  fixture.rows[0][5] = "Невідомий заголовок";
  const before = structuredClone(fixture.rows);
  const source = await readFile(new URL("../apps-script/LibrarianGateway.gs", import.meta.url), "utf8");
  vm.runInContext(source, fixture.context);

  const schemaFailure = fixture.context.applyGatewayDraft_(applyEnvelope());
  assert.equal(schemaFailure.success, false);
  assert.equal(schemaFailure.code, "schema_mismatch");
  assert.deepEqual(fixture.rows, before);

  const formulaFixture = appsScriptFixture();
  formulaFixture.properties.set("LIBRARIAN_WRITES_ENABLED", "true");
  formulaFixture.formulas.splice(
    0,
    3,
    Array(6).fill(""),
    Array(6).fill(""),
    ["", "", "", "", "=IF(A3=\"\",\"\",\"Запланований\")", ""],
  );
  const formulaSource = await readFile(new URL("../apps-script/LibrarianGateway.gs", import.meta.url), "utf8");
  vm.runInContext(formulaSource, formulaFixture.context);
  const formulaFailure = formulaFixture.context.applyGatewayDraft_(applyEnvelope());
  assert.equal(formulaFailure.success, false);
  assert.equal(formulaFailure.code, "formula_protected");
  assert.equal(formulaFixture.rows.length, 3);
  assert.ok(formulaFixture.rows[2].every((value) => value === ""));
});

test("apply sources enforce owner, revision, HMAC, durable ledger, and exact scope", async () => {
  const [route, store, gateway, appsScript, manifest] = await Promise.all([
    readFile(new URL("../app/api/librarian/drafts/apply/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/draft-apply-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/sheets-gateway.ts", import.meta.url), "utf8"),
    readFile(new URL("../apps-script/LibrarianGateway.gs", import.meta.url), "utf8"),
    readFile(new URL("../apps-script/appsscript.json", import.meta.url), "utf8").then(JSON.parse),
  ]);

  assert.match(route, /authorizeLibrarianApi\(\)/);
  assert.match(route, /isSameOriginRequest\(request\)/);
  assert.match(route, /access\.writesEnabled/);
  assert.match(route, /isSupportedDraftApplyKind/);
  assert.match(store, /eq\(librarianDrafts\.ownerUserId, user\.userId\)/);
  assert.match(store, /eq\(librarianDrafts\.status, "ready_for_review"\)/);
  assert.match(store, /eq\(librarianDrafts\.revision, expectedRevision\)/);
  assert.match(store, /reviewNote: encodeApplyMetadata/);
  assert.match(store, /status: outcome/);
  assert.match(gateway, /callSignedGateway\("applyDraft", payload\)/);
  assert.match(gateway, /crypto\.subtle\.sign\("HMAC"/);
  assert.match(appsScript, /LockService\.getScriptLock\(\)/);
  assert.match(appsScript, /GATEWAY_APPLY_INDEX_V1/);
  assert.match(appsScript, /SpreadsheetApp\.openById\(spreadsheetId\)/);
  assert.doesNotMatch(appsScript, /SpreadsheetApp\.getActive\(\)/);
  assert.deepEqual(manifest.oauthScopes, ["https://www.googleapis.com/auth/spreadsheets"]);
});
