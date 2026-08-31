import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  confirmedPermanentPrivateCover,
  persistedCoverFromApplyResult,
} from "../lib/cover-cleanup-proof.ts";

const [source, coverClient, coverStorage, applyRoute] = await Promise.all([
  readFile(new URL("../apps-script/LibrarianCoverBridge.gs", import.meta.url), "utf8"),
  readFile(new URL("../lib/cover-client.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/cover-storage.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/librarian/drafts/apply/route.ts", import.meta.url), "utf8"),
]);

function appsScriptContext(fetchImpl = () => response(404, "")) {
  const properties = new Map([
    ["GITHUB_OWNER", "nazarijshvetz1"],
    ["GITHUB_REPO", "library-covers"],
    ["GITHUB_TOKEN", "test_token_value_long_enough"],
    ["SPREADSHEET_ID", "1SyntheticCopySpreadsheetId_000000000000000000"],
  ]);
  const context = vm.createContext({
    console,
    Date,
    Error,
    JSON,
    Math,
    Number,
    Object,
    RegExp,
    String,
    encodeURIComponent,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => properties.get(key) ?? null,
      }),
    },
    SpreadsheetApp: { flush: () => {}, openById: () => null },
    UrlFetchApp: { fetch: fetchImpl },
    Utilities: {
      DigestAlgorithm: { SHA_1: "SHA_1", SHA_256: "SHA_256" },
      base64Decode: (value) => [...Buffer.from(value, "base64")],
      base64Encode: (value) => Buffer.from(value).toString("base64"),
      computeDigest: (algorithm, value) => [
        ...createHash(algorithm === "SHA_1" ? "sha1" : "sha256")
          .update(Buffer.from(value))
          .digest(),
      ],
      newBlob: (value) => {
        const bytes = typeof value === "string"
          ? Buffer.from(value, "utf8")
          : Buffer.from(value);
        return {
          getBytes: () => [...bytes],
          getDataAsString: () => bytes.toString("utf8"),
        };
      },
    },
  });
  vm.runInContext(source, context, { filename: "LibrarianCoverBridge.gs" });
  return context;
}

function response(status, body) {
  return {
    getResponseCode: () => status,
    getContentText: () => body,
  };
}

function jpegAttachment() {
  const bytes = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
    0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0xff, 0xd9,
  ]);
  return {
    bytes,
    attachment: {
      base64: bytes.toString("base64"),
      byteLength: bytes.length,
      contentType: "image/jpeg",
      originalName: "photo.jpg",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

function normalizedPhotoRequest(context, overrides = {}) {
  const { attachment } = jpegAttachment();
  return context.normalizeLibrarianCoverRequest_({
    catId: "cat-1279",
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    materialRow: 1380,
    writeMode: "production",
    overwrite: false,
    attachment,
    ...overrides,
  });
}

function gitBlobSha(bytes) {
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest("hex");
}

test("browser normalization produces only a compact final JPEG", () => {
  assert.match(coverClient, /MAX_NORMALIZED_WIDTH = 600/);
  assert.match(coverClient, /MAX_NORMALIZED_HEIGHT = 900/);
  assert.match(coverClient, /const attempts = \[0\.82,/);
  assert.match(coverClient, /context\.fillStyle = "#ffffff"/);
  assert.match(coverClient, /canvasToBlob\(canvas, "image\/jpeg", quality\)/);
  assert.match(coverClient, /export async function editCoverPhotoForUpload/u);
  assert.match(coverClient, /context\.rotate\(rotation \* Math\.PI \/ 180\)/u);
  assert.match(coverClient, /const zoom = Math\.min\(2\.5/u);
  assert.doesNotMatch(coverClient, /safeOriginalFallback/);
});

test("photo requests have row-stable fingerprints and no public import path", () => {
  const context = appsScriptContext();
  const first = normalizedPhotoRequest(context);
  const afterSort = normalizedPhotoRequest(context, { materialRow: 44 });

  assert.equal(first.catId, "CAT-1279");
  assert.equal(first.sourceKind, "site_photo");
  assert.equal(first.fingerprint, afterSort.fingerprint);
  assert.equal(Object.hasOwn(first, "importPath"), false);
  assert.doesNotMatch(source, /imports\/site/);
});

test("private photo writes only final covers/CAT-ID.jpg with one base64 layer", () => {
  const calls = [];
  const { bytes } = jpegAttachment();
  const blobSha = gitBlobSha(bytes);
  const path = "covers/CAT-1279.jpg";
  const context = appsScriptContext((url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return response(404, "");
    if (calls.length === 2) {
      return response(201, JSON.stringify({ content: { path, sha: blobSha } }));
    }
    return response(200, JSON.stringify({ path, type: "file", sha: blobSha }));
  });

  const result = context.putLibrarianSitePhotoCover_(normalizedPhotoRequest(context));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    finalUrl: "https://raw.githubusercontent.com/nazarijshvetz1/library-covers/main/covers/CAT-1279.jpg",
    alreadyApplied: false,
  });
  assert.equal(calls.length, 3);
  assert.match(calls[1].url, /\/contents\/covers\/CAT-1279\.jpg$/);
  const body = JSON.parse(calls[1].options.payload);
  assert.deepEqual(Buffer.from(body.content, "base64"), bytes);
  assert.equal(body.branch, "main");
  assert.equal(Object.hasOwn(body, "sha"), false);
  assert.doesNotMatch(calls[1].options.payload, /test_token_value/);
});

test("existing photo is idempotent by Git blob SHA and overwrite is guarded", () => {
  const context = appsScriptContext();
  const { bytes } = jpegAttachment();
  const sameSha = gitBlobSha(bytes);
  const same = appsScriptContext(() => response(200, JSON.stringify({
    path: "covers/CAT-1279.jpg",
    type: "file",
    sha: sameSha,
  })));
  assert.equal(same.putLibrarianSitePhotoCover_(normalizedPhotoRequest(same)).alreadyApplied, true);

  context.UrlFetchApp.fetch = () => response(200, JSON.stringify({
    path: "covers/CAT-1279.jpg",
    type: "file",
    sha: "1".repeat(40),
  }));
  assert.throws(
    () => context.putLibrarianSitePhotoCover_(normalizedPhotoRequest(context)),
    (error) => error.code === "cover_already_exists",
  );
});

test("overwrite includes the current SHA and verifies the final SHA", () => {
  const calls = [];
  const { bytes } = jpegAttachment();
  const blobSha = gitBlobSha(bytes);
  const oldSha = "1".repeat(40);
  const path = "covers/CAT-1279.jpg";
  const context = appsScriptContext((url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return response(200, JSON.stringify({ path, type: "file", sha: oldSha }));
    if (calls.length === 2) return response(200, JSON.stringify({ content: { path, sha: blobSha } }));
    return response(200, JSON.stringify({ path, type: "file", sha: blobSha }));
  });
  context.putLibrarianSitePhotoCover_(normalizedPhotoRequest(context, { overwrite: true }));
  assert.equal(JSON.parse(calls[1].options.payload).sha, oldSha);
});

test("attachment hash, JPEG type, length and strict base64 are enforced", () => {
  const context = appsScriptContext();
  const { attachment } = jpegAttachment();
  const request = (changed) => ({
    catId: "CAT-1279",
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    materialRow: 1380,
    writeMode: "production",
    attachment: changed,
  });
  assert.throws(
    () => context.normalizeLibrarianCoverRequest_(request({ ...attachment, sha256: "0".repeat(64) })),
    (error) => error.code === "cover_hash_mismatch",
  );
  assert.throws(
    () => context.normalizeLibrarianCoverRequest_(request({ ...attachment, contentType: "image/png" })),
    (error) => error.code === "cover_content_type_mismatch",
  );
  assert.throws(
    () => context.normalizeLibrarianCoverRequest_(request({ ...attachment, byteLength: attachment.byteLength + 1 })),
    (error) => error.code === "cover_length_mismatch",
  );
  assert.throws(
    () => context.normalizeLibrarianCoverRequest_(request({ ...attachment, base64: `${attachment.base64.slice(0, -1)}!` })),
    (error) => error.code === "invalid_cover_base64",
  );
});

test("source URLs never accept a simultaneous private attachment", () => {
  const context = appsScriptContext();
  const { attachment } = jpegAttachment();
  assert.throws(
    () => context.normalizeLibrarianCoverRequest_({
      catId: "CAT-1279",
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      materialRow: 1380,
      writeMode: "production",
      sourceUrl: "https://example.com/book",
      attachment,
    }),
    (error) => error.code === "cover_source_conflict",
  );
});

test("CAT-ID remains authoritative when rows are sorted during URL processing", () => {
  const context = appsScriptContext();
  let coverFlag = "";
  let coverUrl = "";
  let coverFormula = "";
  const materialMatch = { getRow: () => 44 };
  const coverMatch = { getRow: () => 8 };
  const expectedFormula = '=IF(A8="";"";IFERROR(IMAGE("https://raw.githubusercontent.com/nazarijshvetz1/library-covers/main/covers/CAT-1279.jpg");"Фото відсутнє"))';
  const materials = {
    getMaxRows: () => 100,
    getLastColumn: () => 2,
    getRange: (row, column) => {
      if (row === 2 && column === 1) {
        return { createTextFinder: () => ({
          matchEntireCell: () => ({
            matchCase: () => ({ findAll: () => [materialMatch] }),
          }),
        }) };
      }
      if (row === 1 && column === 1) return { getDisplayValues: () => [["CAT-ID", "Обкладинка"]] };
      if (row === 44 && column === 2) return {
        getFormula: () => "",
        setValue: (value) => { coverFlag = value; },
        getDisplayValue: () => coverFlag,
      };
      throw new Error(`unexpected material range ${row}:${column}`);
    },
  };
  const covers = {
    getMaxRows: () => 100,
    getRange: (row, column, rowCount, columnCount) => {
      if (row === 2 && column === 1) {
        return { createTextFinder: () => ({
          matchEntireCell: () => ({ matchCase: () => ({ findAll: () => [coverMatch] }) }),
        }) };
      }
      if (row === 8 && column === 1 && rowCount === 1 && columnCount === 3) {
        return {
          getDisplayValues: () => [["CAT-1279", "", coverUrl]],
          getFormulas: () => [["", coverFormula, ""]],
        };
      }
      if (row === 8 && column === 2) return { setFormula: (value) => { coverFormula = value; } };
      if (row === 8 && column === 3) return {
        setValue: (value) => { coverUrl = value; },
      };
      throw new Error(`unexpected cover range ${row}:${column}`);
    },
  };
  const spreadsheet = {
    getSheetByName: (name) => name === "Матеріали" ? materials : name === "Обкладинки" ? covers : null,
  };
  const finalUrl = context.librarianCoverFinalUrl_("CAT-1279");
  const result = context.applyLibrarianCoverToSheets_(spreadsheet, "CAT-1279", 1380, finalUrl);
  assert.equal(result.materialRow, 44);
  assert.equal(coverFlag, "Так");
  assert.equal(coverUrl, finalUrl);
  assert.equal(coverFormula, expectedFormula);
});

test("cover write rejects duplicate CAT-IDs before mutating either sheet", () => {
  const context = appsScriptContext();
  let writes = 0;
  const match = (row) => ({ getRow: () => row });
  const materials = {
    getMaxRows: () => 100,
    getLastColumn: () => 2,
    getRange: (row, column) => {
      if (row === 2 && column === 1) return { createTextFinder: () => ({
        matchEntireCell: () => ({ matchCase: () => ({ findAll: () => [match(4), match(9)] }) }),
      }) };
      throw new Error(`unexpected material range ${row}:${column}`);
    },
  };
  const spreadsheet = {
    getSheetByName: (name) => name === "Матеріали" ? materials : name === "Обкладинки" ? {} : null,
  };
  assert.throws(
    () => context.applyLibrarianCoverToSheets_(
      spreadsheet,
      "CAT-1279",
      4,
      context.librarianCoverFinalUrl_("CAT-1279"),
    ),
    (error) => error.code === "material_id_ambiguous",
  );
  assert.equal(writes, 0);
});

test("an empty displayed cover row with formulas is never reused", () => {
  const context = appsScriptContext();
  let inserted = 0;
  let coverFlag = "";
  let insertedId = "";
  let insertedFormula = "";
  let insertedUrl = "";
  const materialMatch = { getRow: () => 44 };
  const materials = {
    getMaxRows: () => 100,
    getLastColumn: () => 2,
    getRange: (row, column) => {
      if (row === 2 && column === 1) return { createTextFinder: () => ({
        matchEntireCell: () => ({ matchCase: () => ({ findAll: () => [materialMatch] }) }),
      }) };
      if (row === 1 && column === 1) return { getDisplayValues: () => [["CAT-ID", "Обкладинка"]] };
      if (row === 44 && column === 2) return {
        getFormula: () => "",
        setValue: (value) => { coverFlag = value; },
        getDisplayValue: () => coverFlag,
      };
      throw new Error(`unexpected material range ${row}:${column}`);
    },
  };
  const covers = {
    getMaxRows: () => 2,
    insertRowAfter: (row) => { assert.equal(row, 2); inserted += 1; },
    getRange: (row, column, rowCount, columnCount) => {
      if (row === 2 && column === 1 && columnCount === 1) return { createTextFinder: () => ({
        matchEntireCell: () => ({ matchCase: () => ({ findAll: () => [] }) }),
      }) };
      if (row === 2 && column === 1 && rowCount === 1 && columnCount === 3) return {
        getDisplayValues: () => [["", "", ""]],
        getFormulas: () => [["=IF('Матеріали'!A2=\"\";\"\";'Матеріали'!A2)", "=IF(C2=\"\";\"\";IMAGE(C2))", ""]],
      };
      if (row === 3 && column === 1 && rowCount === 1 && columnCount === 3) return {
        getDisplayValues: () => [[insertedId, "", insertedUrl]],
        getFormulas: () => [["", insertedFormula, ""]],
      };
      if (row === 3 && column === 1) return { setValue: (value) => { insertedId = value; } };
      if (row === 3 && column === 2) return { setFormula: (value) => { insertedFormula = value; } };
      if (row === 3 && column === 3) return { setValue: (value) => { insertedUrl = value; } };
      throw new Error(`unexpected cover range ${row}:${column}:${rowCount}:${columnCount}`);
    },
  };
  const spreadsheet = {
    getSheetByName: (name) => name === "Матеріали" ? materials : name === "Обкладинки" ? covers : null,
  };
  const result = context.applyLibrarianCoverToSheets_(
    spreadsheet,
    "CAT-1279",
    44,
    context.librarianCoverFinalUrl_("CAT-1279"),
  );
  assert.equal(result.coverRow, 3);
  assert.equal(inserted, 1);
  assert.equal(insertedId, "CAT-1279");
  assert.equal(coverFlag, "Так");
});

test("polling counts attempts before fetch and caps every run at twenty rows", () => {
  const context = appsScriptContext();
  let fetches = 0;
  const rows = Array.from({ length: 25 }, (_, index) => [
    `123e4567-e89b-42d3-a456-${String(index).padStart(12, "0")}`,
    "fingerprint",
    `CAT-${String(index + 1000).padStart(4, "0")}`,
    "100",
    "url",
    "queued",
    "https://example.com/book",
    "",
    "",
    new Date().toISOString(),
    new Date().toISOString(),
    "0",
    "",
    new Date(Date.now() + 60_000).toISOString(),
  ]);
  const journal = {
    getLastRow: () => rows.length + 1,
    getRange: () => ({ getDisplayValues: () => rows }),
  };
  context.SpreadsheetApp.openById = () => ({
    getSheetByName: () => journal,
  });
  context.updateLibrarianCoverPolling_ = () => {};
  context.updateLibrarianCoverJournal_ = () => {};
  context.fetchLibrarianCoverRequestResult_ = () => {
    fetches += 1;
    if (fetches === 1) throw new Error("temporary");
    return null;
  };
  context.checkLibrarianSiteCoverJobs();
  assert.equal(fetches, 20);
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      vm.runInContext("LIBRARIAN_SITE_COVERS.headers.slice(-3)", context),
    )),
    ["attempt_count", "last_checked_at", "deadline_at"],
  );
});

test("URL dispatch persists an in-flight journal state before the external request", () => {
  const queueStart = source.indexOf("function queueLibrarianCover_");
  const queueEnd = source.indexOf("function checkLibrarianSiteCoverJobs");
  const queueSource = source.slice(queueStart, queueEnd);
  const persisted = queueSource.indexOf(
    "updateLibrarianCoverJournal_(journal, row, 'queued', '', 'Запит підготовлено; очікуємо результат обробки.')",
  );
  const flushed = queueSource.indexOf("SpreadsheetApp.flush();", persisted);
  const dispatched = queueSource.indexOf("dispatchLibrarianCoverUrl_(normalized)", persisted);
  assert.ok(persisted >= 0 && flushed > persisted && dispatched > flushed);
  assert.match(queueSource, /existingValues\[5\] === 'queued'[\s\S]*installLibrarianCoverBridgeTrigger_\(\)[\s\S]*return librarianCoverJournalResult_/);
  assert.match(queueSource, /!dispatchError\.code[\s\S]*Повторне надсилання заблоковано/);
});

test("external journal text is neutralized against spreadsheet formulas", () => {
  const context = appsScriptContext();
  assert.equal(context.safeLibrarianSheetLiteral_("=IMPORTXML(\"https://x\")", 500), "'=IMPORTXML(\"https://x\")");
  assert.equal(context.safeLibrarianSheetLiteral_("+1+1", 500), "'+1+1");
  assert.equal(context.safeLibrarianSheetLiteral_("Звичайний статус", 500), "Звичайний статус");
});

test("temporary photo cleanup runs only after a confirmed permanent private cover", () => {
  assert.match(coverStorage, /export async function deleteOwnedCoverAttachment/);
  assert.match(applyRoute, /const applied = await completeDraftApply[\s\S]*confirmedPermanentPrivateCover\(gatewayResult\.cover, claim\.requestId\)/);
  assert.match(applyRoute, /claim\.alreadyApplied[\s\S]*persistedCoverFromApplyResult\(claim\.persistedResult\)/);
  assert.match(applyRoute, /confirmedPermanentPrivateCover\(replayCover, claim\.requestId\)[\s\S]*readOwnedCoverAttachment[\s\S]*cleanupConfirmedCoverAttachment/);
  assert.match(applyRoute, /if \(await activeDraftReferencesCoverPhoto\(userId, key\)\) return false/);
  assert.match(applyRoute, /catch \{[\s\S]*return false;[\s\S]*\}/);
});

test("replay cleanup proof is bound to request, material and permanent URL", () => {
  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  const cover = {
    mode: "private_photo",
    status: "completed",
    permanent_url_written: true,
    request_id: requestId,
    material_id: "CAT-1279",
    final_url:
      "https://raw.githubusercontent.com/nazarijshvetz1/library-covers/main/covers/CAT-1279.jpg",
  };
  assert.equal(confirmedPermanentPrivateCover(cover, requestId), true);
  assert.equal(persistedCoverFromApplyResult({ cover }), cover);
  assert.equal(persistedCoverFromApplyResult({ cover: [] }), null);
  assert.equal(
    confirmedPermanentPrivateCover(cover, "00000000-0000-4000-8000-000000000000"),
    false,
  );
  assert.equal(
    confirmedPermanentPrivateCover({ ...cover, material_id: "CAT-1280" }, requestId),
    false,
  );
  assert.equal(
    confirmedPermanentPrivateCover({ ...cover, permanent_url_written: false }, requestId),
    false,
  );
});
