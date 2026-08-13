import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const coverMutation = await import(
  pathToFileURL(path.join(root, "lib/library-cover-mutation.ts")).href
);
const catalog = await import(
  pathToFileURL(path.join(root, "lib/catalog-d1.ts")).href
);
const coverCleanup = await import(
  pathToFileURL(path.join(root, "lib/cover-cleanup.ts")).href
);

class PreparedStatement {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...values) {
    return new PreparedStatement(this.database, this.sql, values);
  }

  async first() {
    return this.database.sqlite.prepare(this.sql).get(...this.bindings) ?? null;
  }

  async all() {
    return { results: this.database.sqlite.prepare(this.sql).all(...this.bindings) };
  }

  execute() {
    return { results: this.database.sqlite.prepare(this.sql).all(...this.bindings) };
  }
}

class TestD1 {
  constructor(sqlite) {
    this.sqlite = sqlite;
    this.batchNumber = 0;
    this.beforeBatch = null;
    this.throwAfterBatch = 0;
  }

  prepare(sql) {
    return new PreparedStatement(this, sql);
  }

  async batch(statements) {
    this.batchNumber += 1;
    if (this.beforeBatch) this.beforeBatch(this.batchNumber, this.sqlite);
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.execute());
      this.sqlite.exec("COMMIT");
      if (this.throwAfterBatch === this.batchNumber) {
        throw new Error("simulated response loss after commit");
      }
      return results;
    } catch (error) {
      if (this.sqlite.isTransaction) this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

class TestBucket {
  constructor() {
    this.objects = new Map();
    this.putCount = 0;
    this.deleted = [];
  }

  async head(key) {
    const object = this.objects.get(key);
    return object ? {
      customMetadata: object.customMetadata,
      httpMetadata: object.httpMetadata,
    } : null;
  }

  async put(key, value, options) {
    this.putCount += 1;
    this.objects.set(key, {
      bytes: new Uint8Array(value),
      ...options,
    });
  }

  async delete(key) {
    this.deleted.push(key);
    this.objects.delete(key);
  }
}

function openDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of [
    "0000_librarian_drafts.sql",
    "0001_draft_workflow.sql",
    "0002_remove_legacy_audit_triggers.sql",
    "0003_odd_the_order.sql",
  ]) {
    const sql = fs.readFileSync(path.join(root, "drizzle", file), "utf8");
    for (const statement of sql.split(/-->\s*statement-breakpoint/gu)) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }
  sqlite.exec(`ALTER TABLE material_stock_totals
    ADD COLUMN reserved_quantity integer NOT NULL DEFAULT 0`);
  sqlite.exec(`CREATE TABLE material_request_reservations (
    material_id text NOT NULL,
    source_location_id text NOT NULL,
    condition text NOT NULL,
    reserved_quantity integer NOT NULL,
    issued_quantity integer NOT NULL DEFAULT 0,
    released_quantity integer NOT NULL DEFAULT 0
  )`);
  seed(sqlite);
  return { sqlite, d1: new TestD1(sqlite), bucket: new TestBucket() };
}

function seed(sqlite) {
  const now = "2026-08-12T08:00:00.000Z";
  sqlite.prepare(`
    INSERT INTO users (
      id, full_name, sort_name, email, auth_user_id, role, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'librarian', 'active', ?, ?)
  `).run(
    "USR-LIB",
    "Назарій Швець",
    "швець назарій",
    "librarian@example.com",
    "auth-librarian",
    now,
    now,
  );
  sqlite.prepare(`
    INSERT INTO materials (
      id, catalog_number, title, sort_title, search_text, rubric,
      publication_type, subject, class_from, class_to, author,
      publication_year, isbn, isbn_normalized, publisher, notes,
      status, version, created_at, updated_at, archived_at
    ) VALUES (
      'CAT-0001', 1, 'Тестова книга', 'тестова книга', 'тестова книга',
      'Підручники', 'Підручник', 'Математика', 5, 5, 'Автор',
      2025, '', '', 'Видавництво', '', 'active', 1, ?, ?, NULL
    )
  `).run(now, now);
  sqlite.prepare(`
    INSERT INTO material_stock_totals (
      material_id, total_quantity, library_quantity,
      other_location_quantity, loaned_quantity, updated_at
    ) VALUES ('CAT-0001', 0, 0, 0, 0, ?)
  `).run(now);
  sqlite.exec("INSERT INTO materials_fts(materials_fts) VALUES('rebuild')");
}

const actor = {
  userId: "auth-librarian",
  displayName: "Назарій Швець",
  email: "librarian@example.com",
  fullName: "Назарій Швець",
};

const shaA = "a".repeat(64);
const shaB = "b".repeat(64);

function input(overrides = {}) {
  const sha256 = overrides.sha256 ?? shaA;
  return {
    requestId: overrides.requestId ?? "20000000-0000-4000-8000-000000000001",
    materialId: "CAT-0001",
    expectedVersion: overrides.expectedVersion ?? 0,
    attachment: {
      key: overrides.sourceKey ?? "cover-drafts/0123456789abcdef01234567/20000000-0000-4000-8000-000000000010.jpg",
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      byteLength: 4,
      sha256,
      width: 400,
      height: 600,
      originalName: "Обкладинка.jpg",
    },
  };
}

test("direct cover replace writes immutable R2 bytes, one D1 version, audit and replay", async () => {
  const { sqlite, d1, bucket } = openDatabase();
  const request = input();
  const first = await coverMutation.replaceMaterialCoverDirect(actor, request, d1, bucket);
  const replay = await coverMutation.replaceMaterialCoverDirect(actor, request, d1, bucket);
  const replayWithoutSource = await coverMutation.replayCompletedMaterialCover(
    actor,
    {
      requestId: request.requestId,
      materialId: request.materialId,
      expectedVersion: request.expectedVersion,
      sourceKey: request.attachment.key,
    },
    d1,
  );

  assert.deepEqual(replay, first);
  assert.deepEqual(replayWithoutSource, first);
  assert.equal(first.coverVersion, 1);
  assert.equal(first.storageKey, `covers/CAT-0001/${shaA}.jpg`);
  assert.equal(first.url, `/api/catalog-v2/covers/CAT-0001?v=${shaA.slice(0, 12)}`);
  assert.equal(bucket.putCount, 1);
  assert.equal(bucket.objects.get(first.storageKey).customMetadata.requestId, request.requestId);
  const stored = sqlite.prepare(`
    SELECT storage_provider, storage_key, sha256, status, version, width, height
    FROM material_cover_assets WHERE material_id = 'CAT-0001'
  `).get();
  assert.deepEqual({ ...stored }, {
    storage_provider: "r2",
    storage_key: first.storageKey,
    sha256: shaA,
    status: "ready",
    version: 1,
    width: 400,
    height: 600,
  });
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'material.cover.replaced'").get().count, 1);
  assert.equal(sqlite.prepare("SELECT status FROM mutation_commands WHERE id = ?").get(request.requestId).status, "completed");
});

test("response loss after the committed D1 batch replays the completed result", async () => {
  const { sqlite, d1, bucket } = openDatabase();
  d1.throwAfterBatch = 2;
  const request = input({ requestId: "20000000-0000-4000-8000-000000000002" });
  const result = await coverMutation.replaceMaterialCoverDirect(actor, request, d1, bucket);

  assert.equal(result.coverVersion, 1);
  assert.equal(bucket.putCount, 1);
  assert.equal(sqlite.prepare("SELECT status FROM mutation_commands WHERE id = ?").get(request.requestId).status, "completed");
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM audit_events").get().count, 1);
});

test("two concurrent finishers for one request still write exactly one audit event", async () => {
  const { sqlite, d1, bucket } = openDatabase();
  const request = input({ requestId: "20000000-0000-4000-8000-000000000006" });
  const originalHead = bucket.head.bind(bucket);
  let arrivals = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  bucket.head = async (key) => {
    arrivals += 1;
    if (arrivals === 2) release();
    await gate;
    return originalHead(key);
  };

  const [first, second] = await Promise.all([
    coverMutation.replaceMaterialCoverDirect(actor, request, d1, bucket),
    coverMutation.replaceMaterialCoverDirect(actor, request, d1, bucket),
  ]);
  assert.deepEqual(second, first);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM audit_events WHERE request_id = ?").get(request.requestId).count, 1);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM material_cover_assets WHERE material_id = 'CAT-0001'").get().count, 1);
});

test("a deterministic permanent-key conflict marks the durable command failed", async () => {
  const { sqlite, d1, bucket } = openDatabase();
  const request = input({ requestId: "20000000-0000-4000-8000-000000000007" });
  const key = `covers/CAT-0001/${shaA}.jpg`;
  bucket.objects.set(key, {
    bytes: new Uint8Array([1, 2, 3]),
    httpMetadata: { contentType: "image/jpeg" },
    customMetadata: { sha256: shaB, requestId: "another-request" },
  });

  await assert.rejects(
    coverMutation.replaceMaterialCoverDirect(actor, request, d1, bucket),
    (error) => error.code === "cover_storage_conflict",
  );
  const command = sqlite.prepare("SELECT status, error_code FROM mutation_commands WHERE id = ?").get(request.requestId);
  assert.deepEqual({ ...command }, { status: "failed", error_code: "cover_storage_conflict" });
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM material_cover_assets").get().count, 0);
});

test("a concurrent different cover fails the optimistic plan and cleans only its owned key", async () => {
  const { sqlite, d1, bucket } = openDatabase();
  const request = input({ requestId: "20000000-0000-4000-8000-000000000003" });
  d1.beforeBatch = (batchNumber, database) => {
    if (batchNumber !== 2) return;
    const now = "2026-08-12T09:00:00.000Z";
    database.prepare(`
      INSERT INTO material_cover_assets (
        id, material_id, storage_provider, storage_key, external_url, mime_type,
        byte_length, width, height, sha256, status, version, created_at, updated_at
      ) VALUES (?, 'CAT-0001', 'r2', ?, NULL, 'image/jpeg', 4, 400, 600, ?, 'ready', 1, ?, ?)
    `).run("COVER-CAT-0001", `covers/CAT-0001/${shaB}.jpg`, shaB, now, now);
  };

  await assert.rejects(
    coverMutation.replaceMaterialCoverDirect(actor, request, d1, bucket),
    (error) => error.code === "cover_version_conflict" && error.details.currentVersion === 1,
  );
  assert.equal(sqlite.prepare("SELECT status FROM mutation_commands WHERE id = ?").get(request.requestId).status, "failed");
  assert.equal(bucket.objects.has(`covers/CAT-0001/${shaA}.jpg`), false);
  assert.deepEqual(bucket.deleted, [`covers/CAT-0001/${shaA}.jpg`]);
  assert.equal(sqlite.prepare("SELECT sha256 FROM material_cover_assets WHERE material_id = 'CAT-0001'").get().sha256, shaB);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM audit_events").get().count, 0);
});

test("failed permanent cleanup is retried from the durable failed command", async () => {
  const { sqlite, d1, bucket } = openDatabase();
  const request = input({ requestId: "20000000-0000-4000-8000-000000000008" });
  d1.beforeBatch = (batchNumber, database) => {
    if (batchNumber !== 2) return;
    const now = "2026-08-12T09:00:00.000Z";
    database.prepare(`
      INSERT INTO material_cover_assets (
        id, material_id, storage_provider, storage_key, external_url, mime_type,
        byte_length, width, height, sha256, status, version, created_at, updated_at
      ) VALUES (?, 'CAT-0001', 'r2', ?, NULL, 'image/jpeg', 4, 400, 600, ?, 'ready', 1, ?, ?)
    `).run("COVER-CAT-0001", `covers/CAT-0001/${shaB}.jpg`, shaB, now, now);
  };
  const originalDelete = bucket.delete.bind(bucket);
  let deleteAttempts = 0;
  bucket.delete = async (key) => {
    deleteAttempts += 1;
    if (deleteAttempts === 1) throw new Error("simulated R2 delete failure");
    return originalDelete(key);
  };

  await assert.rejects(
    coverMutation.replaceMaterialCoverDirect(actor, request, d1, bucket),
    (error) => error.code === "cover_cleanup_pending" && error.status === 503,
  );
  const permanentKey = `covers/CAT-0001/${shaA}.jpg`;
  assert.equal(bucket.objects.has(permanentKey), true);
  assert.equal(sqlite.prepare("SELECT status FROM mutation_commands WHERE id = ?").get(request.requestId).status, "failed");

  await assert.rejects(
    coverMutation.replayCompletedMaterialCover(
      actor,
      {
        requestId: request.requestId,
        materialId: request.materialId,
        expectedVersion: request.expectedVersion,
        sourceKey: request.attachment.key,
      },
      d1,
      bucket,
    ),
    (error) => error.code === "cover_version_conflict",
  );
  assert.equal(deleteAttempts, 2);
  assert.equal(bucket.objects.has(permanentKey), false);
});

test("a material archived after planning fails durably instead of leaving processing", async () => {
  const { sqlite, d1, bucket } = openDatabase();
  const request = input({ requestId: "20000000-0000-4000-8000-000000000004" });
  d1.beforeBatch = (batchNumber, database) => {
    if (batchNumber === 2) {
      database.exec("UPDATE materials SET status = 'archived', archived_at = '2026-08-12T09:00:00.000Z' WHERE id = 'CAT-0001'");
    }
  };

  await assert.rejects(
    coverMutation.replaceMaterialCoverDirect(actor, request, d1, bucket),
    (error) => error.code === "material_not_found" && error.status === 404,
  );
  const command = sqlite.prepare("SELECT status, error_code FROM mutation_commands WHERE id = ?").get(request.requestId);
  assert.deepEqual({ ...command }, { status: "failed", error_code: "material_not_found" });
  assert.equal(bucket.objects.has(`covers/CAT-0001/${shaA}.jpg`), false);
});

test("librarian detail gets cover version while public detail only gets cache-busted image", async () => {
  const { d1, bucket } = openDatabase();
  await coverMutation.replaceMaterialCoverDirect(
    actor,
    input({ requestId: "20000000-0000-4000-8000-000000000005" }),
    d1,
    bucket,
  );
  const publicDetail = await catalog.getCatalogMaterialDetail(d1, "CAT-0001", "public");
  const librarianDetail = await catalog.getCatalogMaterialDetail(d1, "CAT-0001", "librarian");

  assert.equal(publicDetail.cover.url, `/api/catalog-v2/covers/CAT-0001?v=${shaA.slice(0, 12)}`);
  assert.equal(Object.hasOwn(publicDetail.cover, "version"), false);
  assert.equal(librarianDetail.cover.version, 1);
});

test("immutable cover caching requires the exact current SHA prefix", () => {
  const canonical = shaA.slice(0, 12);
  assert.deepEqual(
    catalog.catalogCoverCacheDecision(shaA, "https://library.test/api/catalog-v2/covers/CAT-0001"),
    { canonicalVersion: canonical, redirect: true, immutable: false },
  );
  assert.deepEqual(
    catalog.catalogCoverCacheDecision(shaA, "https://library.test/api/catalog-v2/covers/CAT-0001?v=wrong"),
    { canonicalVersion: canonical, redirect: true, immutable: false },
  );
  assert.deepEqual(
    catalog.catalogCoverCacheDecision(shaA, `https://library.test/api/catalog-v2/covers/CAT-0001?v=${canonical}`),
    { canonicalVersion: canonical, redirect: false, immutable: true },
  );
  assert.deepEqual(
    catalog.catalogCoverCacheDecision(shaA, `https://library.test/api/catalog-v2/covers/CAT-0001?v=${canonical}&v=${canonical}`),
    { canonicalVersion: canonical, redirect: true, immutable: false },
  );
  assert.deepEqual(
    catalog.catalogCoverCacheDecision("", "https://library.test/api/catalog-v2/covers/CAT-0001"),
    { canonicalVersion: "", redirect: false, immutable: false },
  );
});

test("promoted source cleanup distinguishes settled absence from retryable storage failure", async () => {
  const calls = [];
  const absent = await coverCleanup.settlePromotedCoverSource("owner", "source", {
    hasActiveReference: async () => false,
    deleteOwnedSource: async (...args) => {
      calls.push(args);
      return false;
    },
  });
  assert.deepEqual(absent, { settled: true, sourceCleanedUp: true });
  assert.deepEqual(calls, [["owner", "source"]]);

  const pending = await coverCleanup.settlePromotedCoverSource("owner", "source", {
    hasActiveReference: async () => false,
    deleteOwnedSource: async () => {
      throw new Error("simulated R2 delete failure");
    },
  });
  assert.deepEqual(pending, { settled: false, sourceCleanedUp: false });

  const retained = await coverCleanup.settlePromotedCoverSource("owner", "source", {
    hasActiveReference: async () => true,
    deleteOwnedSource: async () => {
      throw new Error("must not delete an active draft source");
    },
  });
  assert.deepEqual(retained, { settled: true, sourceCleanedUp: false });
});

test("finalize route is authenticated, same-origin, write-gated and revalidates owner JPEG", () => {
  const route = fs.readFileSync(
    path.join(root, "app/api/librarian/materials/[id]/cover/route.ts"),
    "utf8",
  );
  const workspace = fs.readFileSync(
    path.join(root, "app/librarian/d1-workspace.tsx"),
    "utf8",
  );
  assert.match(route, /authorizeLibrarianApi\(\)/u);
  assert.match(route, /if \(!access\.writesEnabled\)/u);
  assert.match(route, /isSameOriginRequest\(request\)/u);
  assert.match(route, /readOwnedCoverAttachment\(/u);
  assert.match(route, /replaceMaterialCoverDirect\(/u);
  assert.match(route, /code: "cover_cleanup_pending"/u);
  assert.match(route, /\{ status: 503 \}/u);
  assert.match(route, /if \(!cleanup\.settled\)/u);
  assert.match(workspace, /normalizeCoverPhotoForUpload\(/u);
  assert.match(workspace, /retainForRetry/u);
  assert.match(workspace, /uploadError\.status >= 400[\s\S]*uploadError\.status < 500/u);
  assert.match(workspace, /coverCleanupPending\(coverError\)/u);
  assert.match(workspace, /стан обкладинки ще не вдалося підтвердити/u);
  assert.match(workspace, /результат інших змін не вдалося підтвердити/u);
  assert.match(route, /Стан зміни обкладинки ще не вдалося остаточно підтвердити/u);
});

test("partial edit outcome is raised before the cover form unmounts", () => {
  const workspace = fs.readFileSync(
    path.join(root, "app/librarian/d1-workspace.tsx"),
    "utf8",
  );
  assert.match(workspace, /const \[workspaceNotice, setWorkspaceNotice\] = useState\(""\)/u);
  assert.match(
    workspace,
    /onPartialUnknown=\{\(message\) => \{\s*onNotice\(message\);\s*onEditing\(false\);\s*void onSaved\(\);/u,
  );
  assert.match(
    workspace,
    /if \(coverSaved\) \{\s*onPartialUnknown\([\s\S]*?\);\s*\} else \{\s*setMessage\(errorMessage\(error\)\);/u,
  );
  assert.match(
    workspace,
    /<InlineMessage tone=\{workspaceNoticeTone\}>\{workspaceNotice\}<\/InlineMessage>/u,
  );
  assert.doesNotMatch(workspace, /if \(coverSaved\) await onRefresh\(\)/u);
  assert.doesNotMatch(
    workspace,
    /coverCleanupPending\([^)]*\)[\s\S]{0,220}обкладинку збережено/u,
  );
});
