import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  assertFreshImportInspection,
  assertVerifiedImportInspection,
  buildHostedImportInsertSql,
  HOSTED_IMPORT_MAX_BATCH_STATEMENTS,
  HOSTED_IMPORT_MAX_INSERT_SQL_BYTES,
  inspectHostedImportPlan,
  parseAndValidateHostedImportPlan,
  readBoundedRequestBytes,
  settleHostedImportUploadReplay,
  totalHostedImportRows,
  validateHostedImportPlan,
  verifyHostedImportFts,
} from "../lib/d1-import-runtime.ts";
import { importCanonicalExport } from "../scripts/import-library-core.mjs";
import { buildD1LoadPlan } from "../scripts/load-library-d1.mjs";
import {
  evaluateStagingImportGate,
  isImportRunExpiryAccepted,
  isStagingImportGateActive,
} from "../lib/staging-import-gate.ts";

const fixtureUrl = new URL("./fixtures/library-core-canonical.json", import.meta.url);
const migrationUrls = [0, 1, 2, 3, 4].map((index) => new URL(
  `../drizzle/${[
    "0000_librarian_drafts.sql",
    "0001_draft_workflow.sql",
    "0002_remove_legacy_audit_triggers.sql",
    "0003_odd_the_order.sql",
    "0004_staging_import_runs.sql",
  ][index]}`,
  import.meta.url,
));

async function fixturePlan() {
  const canonical = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const { bundle, report } = importCanonicalExport(canonical);
  assert.equal(report.ok, true);
  return buildD1LoadPlan(bundle, { throwOnError: true }).plan;
}

async function migratedDatabase(t) {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec("PRAGMA foreign_keys = ON");
  for (const url of migrationUrls) database.exec(await readFile(url, "utf8"));
  return database;
}

function d1Adapter(database) {
  function statement(sql, values = []) {
    return {
      _sql: sql,
      _values: values,
      bind(...nextValues) { return statement(sql, nextValues); },
      async all() { return { results: database.prepare(sql).all(...values) }; },
      async first() { return database.prepare(sql).get(...values) ?? null; },
      async run() {
        const result = database.prepare(sql).run(...values);
        return { meta: { changes: Number(result.changes) } };
      },
    };
  }
  return {
    prepare: statement,
    async batch(statements) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((item) => {
          const prepared = database.prepare(item._sql);
          if (/^\s*(?:SELECT|PRAGMA|WITH)\b/iu.test(item._sql)) {
            return { results: prepared.all(...item._values), meta: { changes: 0 } };
          }
          const result = prepared.run(...item._values);
          return { meta: { changes: Number(result.changes) } };
        });
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

test("strict hosted contract accepts the deterministic local load plan and rejects SQL-shaped extras", async () => {
  const plan = await fixturePlan();
  assert.equal(validateHostedImportPlan(plan), plan);
  const bytes = new TextEncoder().encode(JSON.stringify(plan));
  assert.deepEqual(parseAndValidateHostedImportPlan(bytes), plan);

  const withSql = structuredClone(plan);
  withSql.sql = "DROP TABLE materials";
  assert.throws(() => validateHostedImportPlan(withSql), (error) => error?.code === "plan_keys_invalid");

  const extraColumn = structuredClone(plan);
  extraColumn.tables.materials[0].raw_sql = "SELECT 1";
  assert.throws(() => validateHostedImportPlan(extraColumn), (error) => error?.code === "plan_keys_invalid");

  const missingReference = structuredClone(plan);
  missingReference.tables.material_links[0].material_id = "CAT-9999";
  assert.throws(() => validateHostedImportPlan(missingReference), (error) => error?.code === "plan_reference_missing");

  const brokenTotal = structuredClone(plan);
  brokenTotal.tables.material_stock_totals[0].total_quantity += 1;
  assert.throws(() => validateHostedImportPlan(brokenTotal), (error) => error?.code === "plan_stock_equation_invalid");
});

test("fresh preflight, one atomic batch, FTS rebuild and post-verify agree", async (t) => {
  const plan = await fixturePlan();
  const database = await migratedDatabase(t);
  const db = d1Adapter(database);
  const before = await inspectHostedImportPlan(db, plan);
  assertFreshImportInspection(before, plan);

  const insertSql = buildHostedImportInsertSql(plan);
  assert.ok(insertSql.length > 0);
  assert.ok(insertSql.length + 2 <= HOSTED_IMPORT_MAX_BATCH_STATEMENTS);
  const digest = "a".repeat(64);
  database.prepare(`
    INSERT INTO migration_import_runs (
      id, plan_sha256, source_bundle_sha256, object_key, status, plan_bytes,
      expected_rows, insert_statements, created_by_user_id, created_by_email,
      expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'preflighted', 100, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "MIG-test",
    digest,
    plan.source_bundle_sha256,
    `_migration/library-d1/${digest}/MIG-test.json`,
    totalHostedImportRows(plan),
    insertSql.length,
    "owner-1",
    "owner@example.test",
    "2026-08-12T00:00:00.000Z",
    "2026-08-11T00:00:00.000Z",
    "2026-08-11T00:00:00.000Z",
  );

  const committedAt = "2026-08-11T00:01:00.000Z";
  await db.batch([
    ...insertSql.map((sql) => db.prepare(sql)),
    db.prepare("INSERT INTO materials_fts(materials_fts) VALUES('rebuild')"),
    db.prepare(`
      UPDATE migration_import_runs
      SET status = 'committed', committed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'preflighted'
    `).bind(committedAt, committedAt, "MIG-test"),
  ]);

  const after = await inspectHostedImportPlan(db, plan);
  assertVerifiedImportInspection(after, plan);
  assert.equal(after.totalUnchanged, totalHostedImportRows(plan));
  assert.equal(database.prepare("SELECT status FROM migration_import_runs WHERE id = 'MIG-test'").get().status, "committed");
  assert.equal(database.prepare("SELECT count(*) AS count FROM materials_fts").get().count, plan.tables.materials.length);
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM materials_fts WHERE materials_fts MATCH '9780306406157'").get().count,
    1,
  );
  const fts = await verifyHostedImportFts(db, plan);
  assert.equal(fts.integrity, true);
  assert.ok(fts.sampledMaterialIds.length >= 1);

  database.exec("INSERT INTO materials_fts(materials_fts) VALUES('delete-all')");
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM materials_fts").get().count,
    plan.tables.materials.length,
    "external-content COUNT still follows materials and does not prove the index",
  );
  await assert.rejects(
    verifyHostedImportFts(db, plan),
    (error) => error?.code === "import_fts_integrity_failed",
  );
});

test("single oversized tuples are rejected before a D1 statement is prepared", async () => {
  const plan = structuredClone(await fixturePlan());
  plan.tables.materials[0].notes = "x".repeat(HOSTED_IMPORT_MAX_INSERT_SQL_BYTES + 1);
  assert.throws(
    () => buildHostedImportInsertSql(plan),
    (error) => error?.code === "import_tuple_too_large",
  );
});

test("bounded action bodies stop chunked reads above the cap and reject content encoding", async () => {
  let cancelled = false;
  const oversizedStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(2048));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() {
      cancelled = true;
    },
  });
  const oversizedRequest = new Request("https://staging.example.test/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: oversizedStream,
    duplex: "half",
  });
  await assert.rejects(
    readBoundedRequestBytes(oversizedRequest, {
      limit: 2048,
      tooLargeCode: "action_body_too_large",
      tooLargeMessage: "too large",
      emptyCode: "action_body_invalid",
      emptyMessage: "empty",
    }),
    (error) => error?.code === "action_body_too_large" && error?.status === 413,
  );
  assert.equal(cancelled, true);

  const encodedRequest = new Request("https://staging.example.test/action", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
    },
    body: "{}",
  });
  await assert.rejects(
    readBoundedRequestBytes(encodedRequest, {
      limit: 2048,
      tooLargeCode: "action_body_too_large",
      tooLargeMessage: "too large",
      emptyCode: "action_body_invalid",
      emptyMessage: "empty",
    }),
    (error) => error?.code === "content_encoding_forbidden" && error?.status === 415,
  );
});

test("upload replay removes a late R2 recreation after cleanup wins", async () => {
  const digest = "d".repeat(64);
  const bytes = new TextEncoder().encode('{"safe":true}');
  const objectKey = `_migration/library-d1/${digest}/MIG-replay.json`;
  const original = {
    id: "MIG-replay",
    plan_sha256: digest,
    source_bundle_sha256: "e".repeat(64),
    object_key: objectKey,
    status: "preflighted",
    plan_bytes: bytes.byteLength,
    created_by_user_id: "owner-1",
    expires_at: "2026-08-11T12:00:00.000Z",
  };
  let latest = original;
  let objectPresent = false;
  let puts = 0;
  let deletes = 0;

  const settled = await settleHostedImportUploadReplay({
    run: original,
    bytes,
    expectedObjectKey: objectKey,
    ownerUserId: "owner-1",
    head: async () => null,
    put: async () => {
      // Cleanup claims the run and deletes the old/missing object immediately
      // before this replay PUT becomes visible.
      latest = { ...original, status: "cleaned" };
      objectPresent = false;
      objectPresent = true;
      puts += 1;
    },
    delete: async (key) => {
      assert.equal(key, objectKey);
      objectPresent = false;
      deletes += 1;
    },
    reload: async () => latest,
  });

  assert.equal(settled.status, "cleaned");
  assert.equal(puts, 1);
  assert.equal(deletes, 1);
  assert.equal(objectPresent, false);
});

test("upload replay deletes a repair PUT that crosses the gate deadline", async () => {
  const digest = "f".repeat(64);
  const bytes = new TextEncoder().encode('{"safe":true}');
  const objectKey = `_migration/library-d1/${digest}/MIG-expiry.json`;
  const run = {
    id: "MIG-expiry",
    plan_sha256: digest,
    source_bundle_sha256: "1".repeat(64),
    object_key: objectKey,
    status: "uploaded",
    plan_bytes: bytes.byteLength,
    created_by_user_id: "owner-1",
    expires_at: "2026-08-11T12:00:00.000Z",
  };
  let active = true;
  let objectPresent = false;
  let reloads = 0;

  await assert.rejects(
    settleHostedImportUploadReplay({
      run,
      bytes,
      expectedObjectKey: objectKey,
      ownerUserId: "owner-1",
      head: async () => null,
      put: async () => {
        objectPresent = true;
        active = false;
      },
      delete: async () => {
        objectPresent = false;
      },
      reload: async () => {
        reloads += 1;
        return run;
      },
      assertWritable: () => {
        if (!active) throw new Error("expired while PUT was in flight");
      },
    }),
    /expired while PUT was in flight/u,
  );
  assert.equal(objectPresent, false);
  assert.equal(reloads, 0);
});

test("SQL-looking text in an allowed field is escaped as data", async (t) => {
  const plan = structuredClone(await fixturePlan());
  plan.tables.materials[0].title = "'); DROP TABLE users; --";
  const database = await migratedDatabase(t);
  const db = d1Adapter(database);
  const insertSql = buildHostedImportInsertSql(plan);
  await db.batch([
    ...insertSql.map((sql) => db.prepare(sql)),
    db.prepare("INSERT INTO materials_fts(materials_fts) VALUES('rebuild')"),
  ]);
  assert.equal(database.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name='users'").get().count, 1);
  assert.equal(database.prepare("SELECT title FROM materials WHERE id = ?").get(plan.tables.materials[0].id).title, "'); DROP TABLE users; --");
});

test("a failed hosted batch rolls back every imported row and the durable status", async (t) => {
  const plan = await fixturePlan();
  const database = await migratedDatabase(t);
  const db = d1Adapter(database);
  const insertSql = buildHostedImportInsertSql(plan);
  const digest = "b".repeat(64);
  database.prepare(`
    INSERT INTO migration_import_runs (
      id, plan_sha256, source_bundle_sha256, object_key, status, plan_bytes,
      expected_rows, insert_statements, created_by_user_id, created_by_email,
      expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'preflighted', 100, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "MIG-rollback",
    digest,
    plan.source_bundle_sha256,
    `_migration/library-d1/${digest}/MIG-rollback.json`,
    totalHostedImportRows(plan),
    insertSql.length,
    "owner-1",
    "owner@example.test",
    "2026-08-12T00:00:00.000Z",
    "2026-08-11T00:00:00.000Z",
    "2026-08-11T00:00:00.000Z",
  );
  database.exec(`
    CREATE TRIGGER fixture_abort_hosted_import
    BEFORE INSERT ON materials
    WHEN NEW.id = 'CAT-0599'
    BEGIN
      SELECT RAISE(ABORT, 'fixture hosted failure');
    END
  `);

  await assert.rejects(db.batch([
    ...insertSql.map((sql) => db.prepare(sql)),
    db.prepare("INSERT INTO materials_fts(materials_fts) VALUES('rebuild')"),
    db.prepare("UPDATE migration_import_runs SET status = 'committed' WHERE id = 'MIG-rollback'"),
  ]), /fixture hosted failure/u);

  assert.equal(database.prepare("SELECT count(*) AS count FROM materials").get().count, 0);
  assert.equal(database.prepare("SELECT count(*) AS count FROM holdings").get().count, 0);
  assert.equal(database.prepare("SELECT status FROM migration_import_runs WHERE id = 'MIG-rollback'").get().status, "preflighted");
});

test("hosted runtime remains Worker-safe and routes keep all five gates", async () => {
  const [runtime, api, upload, commit, consoleSource, migration, docs] = await Promise.all([
    readFile(new URL("../lib/d1-import-runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/staging-import-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/internal/library-import/upload/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/internal/library-import/commit/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/librarian/import/staging-import-console.tsx", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0004_staging_import_runs.sql", import.meta.url), "utf8"),
    readFile(new URL("../docs/D1_IMPORTER_UK.md", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(runtime, /from\s+["']node:/u);
  assert.doesNotMatch(runtime, /\bBuffer\b|\bprocess\b|\bfetch\s*\(/u);
  for (const marker of [
    "APP_ENV",
    "LIBRARY_IMPORT_ENABLED",
    "LIBRARY_IMPORT_ALLOWED_ORIGIN",
    "LIBRARY_IMPORT_PLAN_SHA256",
    "LIBRARY_IMPORT_EXPIRES_AT",
  ]) assert.match(api, new RegExp(marker));
  assert.match(api, /authorizeLibrarianApi/u);
  assert.match(api, /created_by_user_id !== context\.user\.userId/u);
  assert.match(upload, /settleHostedImportUploadReplay/u);
  assert.match(upload, /assertStagingImportStillActive/u);
  assert.match(commit, /context\.db\.batch/u);
  assert.match(commit, /materials_fts/u);
  assert.match(consoleSource, /shouldRestoreExpiredRun/u);
  assert.match(consoleSource, /await resumeStatus\(sha256, error\.message\)/u);
  assert.doesNotMatch(migration, /CREATE\s+TRIGGER/iu);
  assert.match(docs, /_migration\/library-d1\//u);
  assert.match(docs, /45 діб/u);
});

test("pure staging gate fails closed for production, origin and expiry mistakes", () => {
  const nowMs = Date.parse("2026-08-11T12:00:00.000Z");
  const valid = {
    appEnv: "staging",
    enabled: true,
    allowedOrigin: "https://staging.example.test",
    pinnedPlanSha256: "a".repeat(64),
    expiresAt: "2026-08-12T12:00:00.000Z",
    requestUrl: "https://staging.example.test/api/internal/library-import/upload",
    submittedOrigin: "https://staging.example.test",
    nowMs,
  };
  assert.equal(evaluateStagingImportGate(valid).ok, true);
  assert.equal(evaluateStagingImportGate({ ...valid, appEnv: "production" }).code, "staging_import_disabled");
  assert.equal(evaluateStagingImportGate({ ...valid, enabled: false }).code, "staging_import_disabled");
  assert.equal(evaluateStagingImportGate({ ...valid, submittedOrigin: null }).code, "staging_import_origin_denied");
  assert.equal(evaluateStagingImportGate({ ...valid, submittedOrigin: "https://evil.example.test" }).code, "staging_import_origin_denied");
  assert.equal(evaluateStagingImportGate({ ...valid, requestUrl: "https://evil.example.test/api" }).code, "staging_import_origin_denied");
  assert.equal(evaluateStagingImportGate({ ...valid, allowedOrigin: "https://staging.example.test/path" }).code, "staging_import_gate_invalid");
  assert.equal(evaluateStagingImportGate({ ...valid, pinnedPlanSha256: "A".repeat(64) }).code, "staging_import_gate_invalid");
  const expired = { ...valid, expiresAt: "2026-08-11T11:59:59.000Z" };
  assert.equal(evaluateStagingImportGate(expired).code, "staging_import_gate_invalid");
  assert.equal(evaluateStagingImportGate({ ...expired, allowExpiredGate: true }).ok, true);
  assert.equal(isStagingImportGateActive(valid.expiresAt, nowMs), true);
  assert.equal(isStagingImportGateActive(valid.expiresAt, Date.parse(valid.expiresAt)), false);
  assert.equal(isImportRunExpiryAccepted(expired.expiresAt, expired.expiresAt, true, nowMs), true);
  assert.equal(isImportRunExpiryAccepted(expired.expiresAt, expired.expiresAt, false, nowMs), false);
  assert.equal(isImportRunExpiryAccepted(expired.expiresAt, valid.expiresAt, true, nowMs), false);
  assert.equal(evaluateStagingImportGate({
    ...expired,
    expiresAt: "2026-07-01T00:00:00.000Z",
    allowExpiredGate: true,
  }).code, "staging_import_gate_invalid");
});

test("migration run key rejects traversal and commit guard loses safely to cleanup", async (t) => {
  const plan = await fixturePlan();
  const database = await migratedDatabase(t);
  const db = d1Adapter(database);
  const digest = "c".repeat(64);
  assert.throws(() => database.prepare(`
    INSERT INTO migration_import_runs (
      id, plan_sha256, source_bundle_sha256, object_key, status, plan_bytes,
      expected_rows, insert_statements, created_by_user_id, created_by_email,
      expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'preflighted', 100, 1, 1, 'owner', 'owner@example.test', ?, ?, ?)
  `).run(
    "MIG-traversal",
    digest,
    plan.source_bundle_sha256,
    `_migration/library-d1/${digest}/../../escape.json`,
    "2026-08-12T00:00:00.000Z",
    "2026-08-11T00:00:00.000Z",
    "2026-08-11T00:00:00.000Z",
  ), /constraint/iu);

  const insertSql = buildHostedImportInsertSql(plan);
  database.prepare(`
    INSERT INTO migration_import_runs (
      id, plan_sha256, source_bundle_sha256, object_key, status, plan_bytes,
      expected_rows, insert_statements, created_by_user_id, created_by_email,
      expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'preflighted', 100, ?, ?, 'owner', 'owner@example.test', ?, ?, ?)
  `).run(
    "MIG-race",
    digest,
    plan.source_bundle_sha256,
    `_migration/library-d1/${digest}/MIG-race.json`,
    totalHostedImportRows(plan),
    insertSql.length,
    "2026-08-10T00:00:00.000Z",
    "2026-08-09T00:00:00.000Z",
    "2026-08-09T00:00:00.000Z",
  );
  database.prepare(`
    UPDATE migration_import_runs
    SET status = CASE WHEN status = 'preflighted' THEN 'cleaned' ELSE '__guard_failed__' END,
        cleaned_at = '2026-08-11T12:00:00.000Z'
    WHERE id = 'MIG-race'
  `).run();

  await assert.rejects(db.batch([
    db.prepare(`
      UPDATE migration_import_runs
      SET status = CASE WHEN status = 'preflighted' THEN 'committed' ELSE '__guard_failed__' END
      WHERE id = 'MIG-race'
    `),
    ...insertSql.map((sql) => db.prepare(sql)),
    db.prepare("INSERT INTO materials_fts(materials_fts) VALUES('rebuild')"),
  ]), /constraint/iu);
  assert.equal(database.prepare("SELECT status FROM migration_import_runs WHERE id='MIG-race'").get().status, "cleaned");
  assert.equal(database.prepare("SELECT count(*) AS count FROM materials").get().count, 0);
});
