import type { ChatGPTUser } from "@/app/chatgpt-auth";

type D1Value = string | number | null;

type D1Result<T = Record<string, unknown>> = {
  results?: T[];
};

type D1Statement = {
  bind(...values: D1Value[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
};

export type CoverMutationDatabase = {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<D1Result[]>;
};

export type CoverMutationBucket = {
  head(key: string): Promise<{
    customMetadata?: Record<string, string>;
    httpMetadata?: { contentType?: string };
  } | null>;
  put(
    key: string,
    value: ArrayBuffer,
    options: {
      httpMetadata: { contentType: string };
      customMetadata: Record<string, string>;
    },
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
};

export type NormalizedCoverAttachment = {
  key: string;
  bytes: Uint8Array;
  byteLength: number;
  sha256: string;
  width: number;
  height: number;
  originalName: string;
};

export type CoverReplaceInput = {
  requestId: string;
  materialId: string;
  expectedVersion: number;
  attachment: NormalizedCoverAttachment;
};

export type CoverReplaceResult = {
  materialId: string;
  coverVersion: number;
  storageKey: string;
  url: string;
  sha256: string;
  byteLength: number;
  width: number;
  height: number;
  updatedAt: string;
};

type CoverBefore = {
  storageProvider: string;
  storageKey: string | null;
  externalUrl: string | null;
  mimeType: string | null;
  byteLength: number | null;
  width: number | null;
  height: number | null;
  sha256: string | null;
  status: string;
  version: number;
} | null;

type CoverPlan = {
  phase: "cover_planned";
  expectedVersion: number;
  before: CoverBefore;
  result: CoverReplaceResult;
};

type StoredCommand = {
  actor_user_id: string;
  target_type: string | null;
  target_id: string | null;
  status: string;
  request_hash: string;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
};

type CoverRow = {
  material_id: string;
  storage_provider: string | null;
  storage_key: string | null;
  external_url: string | null;
  mime_type: string | null;
  byte_length: number | null;
  width: number | null;
  height: number | null;
  sha256: string | null;
  status: string | null;
  version: number | null;
};

type MutationActor = { id: string; email: string };

export class LibraryCoverMutationError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    status: number,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "LibraryCoverMutationError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** Returns a completed replay even after the owner-scoped source was cleaned. */
export async function replayCompletedMaterialCover(
  user: ChatGPTUser,
  input: {
    requestId: string;
    materialId: string;
    expectedVersion: number;
    sourceKey: string;
  },
  db: CoverMutationDatabase,
  bucket?: CoverMutationBucket,
): Promise<CoverReplaceResult | null> {
  const actor = await resolveMutationActor(db, user);
  const command = await readCommand(db, input.requestId);
  if (!command) return null;
  if (
    command.actor_user_id !== actor.id
    || command.target_type !== "material_cover"
    || command.target_id !== input.materialId
  ) {
    throw new LibraryCoverMutationError(
      "request_id_conflict",
      409,
      "Цей request ID вже використано для іншої зміни.",
    );
  }
  if (command.status === "failed") {
    if (bucket) {
      await retryFailedCleanup(db, bucket, input, command);
    }
    throw new LibraryCoverMutationError(
      command.error_code || "cover_replace_failed",
      409,
      command.error_message || "Обкладинку не замінено.",
    );
  }
  if (command.status !== "completed") return null;

  const result = parseCompletedResult(command.result_json);
  const audit = await db.prepare(`
    SELECT metadata_json
    FROM audit_events
    WHERE request_id = ? AND actor_user_id = ?
      AND action = 'material.cover.replaced'
      AND entity_type = 'material' AND entity_id = ?
    LIMIT 1
  `).bind(input.requestId, actor.id, input.materialId).first<{
    metadata_json: string | null;
  }>();
  let sourceKey = "";
  try {
    sourceKey = String(JSON.parse(audit?.metadata_json ?? "{}").sourceKey ?? "");
  } catch {
    throw invalidCommand();
  }
  if (
    result.coverVersion !== input.expectedVersion + 1
    || sourceKey !== input.sourceKey
  ) {
    throw new LibraryCoverMutationError(
      "request_id_conflict",
      409,
      "Цей request ID вже використано для іншої зміни.",
    );
  }
  return result;
}

/**
 * Promotes an owner-scoped, server-validated JPEG to immutable R2 storage and
 * switches the single current D1 cover row to it. A durable processing command
 * is written before R2, so retries resume the same content-addressed object
 * instead of creating unknown keys after an ambiguous network failure.
 */
export async function replaceMaterialCoverDirect(
  user: ChatGPTUser,
  input: CoverReplaceInput,
  db: CoverMutationDatabase,
  bucket: CoverMutationBucket,
): Promise<CoverReplaceResult> {
  const actor = await resolveMutationActor(db, user);
  const requestHash = await mutationHash({
    kind: "material.cover.replace",
    actorUserId: actor.id,
    materialId: input.materialId,
    expectedVersion: input.expectedVersion,
    sourceKey: input.attachment.key,
    sha256: input.attachment.sha256,
    byteLength: input.attachment.byteLength,
    width: input.attachment.width,
    height: input.attachment.height,
  });

  const existing = await readCommand(db, input.requestId);
  if (existing) {
    return resumeOrReplay(existing, requestHash, input, db, bucket, actor);
  }

  const current = await readCurrentCover(db, input.materialId);
  if (!current) {
    throw new LibraryCoverMutationError(
      "material_not_found",
      404,
      "Матеріал не знайдено.",
    );
  }
  const currentVersion = positiveInteger(current.version);
  if (currentVersion !== input.expectedVersion) {
    throw coverVersionConflict(currentVersion);
  }

  const updatedAt = new Date().toISOString();
  const storageKey = permanentCoverKey(input.materialId, input.attachment.sha256);
  const result: CoverReplaceResult = {
    materialId: input.materialId,
    coverVersion: currentVersion + 1,
    storageKey,
    url: `/api/catalog-v2/covers/${encodeURIComponent(input.materialId)}?v=${input.attachment.sha256.slice(0, 12)}`,
    sha256: input.attachment.sha256,
    byteLength: input.attachment.byteLength,
    width: input.attachment.width,
    height: input.attachment.height,
    updatedAt,
  };
  const plan: CoverPlan = {
    phase: "cover_planned",
    expectedVersion: currentVersion,
    before: beforeFromRow(current),
    result,
  };

  try {
    await db.batch([
      db.prepare(`
        INSERT INTO mutation_commands (
          id, draft_id, kind, actor_user_id, status, target_type, target_id,
          request_hash, result_json, error_code, error_message,
          created_at, updated_at, completed_at
        ) VALUES (
          ?, NULL, 'material.cover.replace', ?, 'processing', 'material_cover', ?,
          ?, ?, NULL, NULL, ?, ?, NULL
        )
      `).bind(
        input.requestId,
        actor.id,
        input.materialId,
        requestHash,
        JSON.stringify(plan),
        updatedAt,
        updatedAt,
      ),
    ]);
  } catch (error) {
    const raced = await readCommand(db, input.requestId);
    if (!raced) throw error;
    return resumeOrReplay(raced, requestHash, input, db, bucket, actor);
  }

  return finishCoverPlan(db, bucket, actor, input, requestHash, plan);
}

async function resumeOrReplay(
  command: StoredCommand,
  requestHash: string,
  input: CoverReplaceInput,
  db: CoverMutationDatabase,
  bucket: CoverMutationBucket,
  actor: MutationActor,
): Promise<CoverReplaceResult> {
  if (command.request_hash !== requestHash) {
    throw new LibraryCoverMutationError(
      "request_id_conflict",
      409,
      "Цей request ID вже використано для іншої зміни.",
    );
  }
  if (command.status === "completed") {
    return parseCompletedResult(command.result_json);
  }
  if (command.status === "failed") {
    await retryFailedCleanup(db, bucket, input, command);
    throw new LibraryCoverMutationError(
      command.error_code || "cover_replace_failed",
      409,
      command.error_message || "Обкладинку не замінено.",
    );
  }
  if (command.status !== "processing") {
    throw invalidCommand();
  }
  const plan = parseCoverPlan(command.result_json);
  if (
    plan.result.materialId !== input.materialId
    || plan.result.sha256 !== input.attachment.sha256
    || plan.expectedVersion !== input.expectedVersion
  ) {
    throw invalidCommand();
  }
  return finishCoverPlan(db, bucket, actor, input, requestHash, plan);
}

async function finishCoverPlan(
  db: CoverMutationDatabase,
  bucket: CoverMutationBucket,
  actor: MutationActor,
  input: CoverReplaceInput,
  requestHash: string,
  plan: CoverPlan,
): Promise<CoverReplaceResult> {
  try {
    await ensurePermanentObject(bucket, actor, input, plan.result.storageKey);
  } catch (error) {
    if (
      error instanceof LibraryCoverMutationError
      && error.code === "cover_storage_conflict"
    ) {
      await markCommandFailed(db, input.requestId, error.code, error.message);
    }
    throw error;
  }

  const after = {
    storageProvider: "r2",
    storageKey: plan.result.storageKey,
    externalUrl: null,
    mimeType: "image/jpeg",
    byteLength: plan.result.byteLength,
    width: plan.result.width,
    height: plan.result.height,
    sha256: plan.result.sha256,
    status: "ready",
    version: plan.result.coverVersion,
  };
  const completedJson = JSON.stringify(plan.result);
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO material_cover_assets (
          id, material_id, storage_provider, storage_key, external_url,
          mime_type, byte_length, width, height, sha256, status, version,
          created_at, updated_at
        )
        SELECT
          ?, m.id, 'r2', ?, NULL, 'image/jpeg', ?, ?, ?, ?, 'ready', 1, ?, ?
        FROM materials m
        WHERE m.id = ? AND m.status = 'active' AND m.archived_at IS NULL
        ON CONFLICT(material_id) DO UPDATE SET
          storage_provider = 'r2',
          storage_key = excluded.storage_key,
          external_url = NULL,
          mime_type = excluded.mime_type,
          byte_length = excluded.byte_length,
          width = excluded.width,
          height = excluded.height,
          sha256 = excluded.sha256,
          status = 'ready',
          version = material_cover_assets.version + 1,
          updated_at = excluded.updated_at
        WHERE material_cover_assets.version = ?
      `).bind(
        `COVER-${input.materialId}`,
        plan.result.storageKey,
        plan.result.byteLength,
        plan.result.width,
        plan.result.height,
        plan.result.sha256,
        plan.result.updatedAt,
        plan.result.updatedAt,
        input.materialId,
        plan.expectedVersion,
      ),
      db.prepare(`
        UPDATE mutation_commands
        SET status = 'completed', result_json = ?, updated_at = ?, completed_at = ?
        WHERE id = ? AND status = 'processing' AND request_hash = ?
          AND changes() = 1
      `).bind(
        completedJson,
        plan.result.updatedAt,
        plan.result.updatedAt,
        input.requestId,
        requestHash,
      ),
      db.prepare(`
        INSERT INTO audit_events (
          id, actor_user_id, actor_email, action, entity_type, entity_id,
          request_id, before_json, after_json, metadata_json, created_at
        ) VALUES (
          ?, ?, ?, 'material.cover.replaced', 'material',
          (SELECT target_id FROM mutation_commands
            WHERE id = ? AND status = 'completed' AND result_json = ?
              AND changes() = 1),
          ?, ?, ?, ?, ?
        )
      `).bind(
        crypto.randomUUID(),
        actor.id,
        actor.email,
        input.requestId,
        completedJson,
        input.requestId,
        plan.before ? JSON.stringify(plan.before) : null,
        JSON.stringify(after),
        JSON.stringify({ sourceKey: input.attachment.key, immutableHistoryRetained: true }),
        plan.result.updatedAt,
      ),
    ]);
  } catch (error) {
    const command = await readCommand(db, input.requestId);
    if (command?.status === "completed" && command.request_hash === requestHash) {
      return parseCompletedResult(command.result_json);
    }
    const current = await readCurrentCover(db, input.materialId);
    if (!current) {
      await markCommandFailed(
        db,
        input.requestId,
        "material_not_found",
        "Матеріал більше не доступний для зміни обкладинки.",
      );
      const cleanupSettled = await cleanupProvenUnusedObject(
        bucket,
        null,
        input.requestId,
        plan,
      );
      if (!cleanupSettled) throw cleanupPending();
      throw new LibraryCoverMutationError(
        "material_not_found",
        404,
        "Матеріал більше не доступний для зміни обкладинки.",
      );
    }
    const currentVersion = positiveInteger(current.version);
    if (currentVersion !== plan.expectedVersion) {
      await markCommandFailed(
        db,
        input.requestId,
        "cover_version_conflict",
        "Обкладинку вже змінив інший запит. Оновіть картку і повторіть дію.",
      );
      const cleanupSettled = await cleanupProvenUnusedObject(
        bucket,
        current,
        input.requestId,
        plan,
      );
      if (!cleanupSettled) throw cleanupPending();
      throw coverVersionConflict(currentVersion);
    }
    throw error;
  }
  return plan.result;
}

async function cleanupProvenUnusedObject(
  bucket: CoverMutationBucket,
  current: CoverRow | null,
  requestId: string,
  plan: CoverPlan,
): Promise<boolean> {
  if (current?.storage_key === plan.result.storageKey) return true;
  try {
    const object = await bucket.head(plan.result.storageKey);
    if (!object) return true;
    if (
      object?.customMetadata?.requestId !== requestId
      || object.customMetadata.sha256 !== plan.result.sha256
    ) return true;
    await bucket.delete(plan.result.storageKey);
    return true;
  } catch {
    // A failed command retains the exact key in result_json for later cleanup.
    return false;
  }
}

async function retryFailedCleanup(
  db: CoverMutationDatabase,
  bucket: CoverMutationBucket,
  input: {
    requestId: string;
    materialId: string;
    expectedVersion: number;
    sourceKey?: string;
    attachment?: NormalizedCoverAttachment;
  },
  command: StoredCommand,
): Promise<void> {
  if (
    command.error_code !== "cover_version_conflict"
    && command.error_code !== "material_not_found"
  ) return;
  let plan: CoverPlan;
  try {
    plan = parseCoverPlan(command.result_json);
  } catch {
    return;
  }
  const current = await readCurrentCover(db, input.materialId);
  const settled = await cleanupProvenUnusedObject(
    bucket,
    current,
    input.requestId,
    plan,
  );
  if (!settled) throw cleanupPending();
}

function cleanupPending(): LibraryCoverMutationError {
  return new LibraryCoverMutationError(
    "cover_cleanup_pending",
    503,
    "Зміну завершено з помилкою, але очищення R2 ще не підтверджено. Повторіть запит із тим самим request ID.",
  );
}

async function ensurePermanentObject(
  bucket: CoverMutationBucket,
  actor: MutationActor,
  input: CoverReplaceInput,
  storageKey: string,
): Promise<void> {
  const existing = await bucket.head(storageKey);
  if (existing) {
    if (
      existing.customMetadata?.sha256 !== input.attachment.sha256
      || existing.httpMetadata?.contentType !== "image/jpeg"
    ) {
      throw new LibraryCoverMutationError(
        "cover_storage_conflict",
        409,
        "Постійний ключ обкладинки вже містить інший файл.",
      );
    }
    return;
  }

  await bucket.put(
    storageKey,
    exactArrayBuffer(input.attachment.bytes),
    {
      httpMetadata: { contentType: "image/jpeg" },
      customMetadata: {
        sha256: input.attachment.sha256,
        materialId: input.materialId,
        sourceKey: input.attachment.key,
        requestId: input.requestId,
        uploadedBy: actor.id,
        width: String(input.attachment.width),
        height: String(input.attachment.height),
        originalName: input.attachment.originalName.slice(0, 180),
      },
    },
  );
}

async function resolveMutationActor(
  db: CoverMutationDatabase,
  user: ChatGPTUser,
): Promise<MutationActor> {
  const response = await db.prepare(`
    SELECT id, email
    FROM users
    WHERE status = 'active' AND role IN ('admin', 'librarian')
      AND (auth_user_id = ? OR lower(email) = lower(?))
    ORDER BY CASE WHEN auth_user_id = ? THEN 0 ELSE 1 END, id
    LIMIT 2
  `).bind(user.userId, user.email, user.userId).all<{
    id: string;
    email: string | null;
  }>();
  const rows = response.results ?? [];
  if (rows.length !== 1) {
    throw new LibraryCoverMutationError(
      "actor_not_mapped",
      403,
      rows.length > 1
        ? "Обліковий запис бібліотекаря налаштовано неоднозначно."
        : "Обліковий запис не прив’язано до активного бібліотекаря.",
    );
  }
  return { id: rows[0].id, email: user.email.toLowerCase() };
}

async function readCurrentCover(
  db: CoverMutationDatabase,
  materialId: string,
): Promise<CoverRow | null> {
  return db.prepare(`
    SELECT
      m.id AS material_id,
      c.storage_provider, c.storage_key, c.external_url, c.mime_type,
      c.byte_length, c.width, c.height, c.sha256, c.status, c.version
    FROM materials m
    LEFT JOIN material_cover_assets c ON c.material_id = m.id
    WHERE m.id = ? AND m.status = 'active' AND m.archived_at IS NULL
    LIMIT 1
  `).bind(materialId).first<CoverRow>();
}

async function readCommand(
  db: CoverMutationDatabase,
  requestId: string,
): Promise<StoredCommand | null> {
  return db.prepare(`
    SELECT
      actor_user_id, target_type, target_id, status, request_hash,
      result_json, error_code, error_message
    FROM mutation_commands
    WHERE id = ?
    LIMIT 1
  `).bind(requestId).first<StoredCommand>();
}

async function markCommandFailed(
  db: CoverMutationDatabase,
  requestId: string,
  code: string,
  message: string,
): Promise<void> {
  const completedAt = new Date().toISOString();
  try {
    await db.batch([
      db.prepare(`
        UPDATE mutation_commands
        SET status = 'failed', error_code = ?, error_message = ?,
          updated_at = ?, completed_at = ?
        WHERE id = ? AND status = 'processing'
      `).bind(code, message, completedAt, completedAt, requestId),
    ]);
  } catch {
    // The original conflict remains authoritative; the durable plan is retained.
  }
}

function beforeFromRow(row: CoverRow): CoverBefore {
  if (!row.storage_provider || !row.version) return null;
  return {
    storageProvider: row.storage_provider,
    storageKey: row.storage_key,
    externalUrl: row.external_url,
    mimeType: row.mime_type,
    byteLength: nullableInteger(row.byte_length),
    width: nullableInteger(row.width),
    height: nullableInteger(row.height),
    sha256: row.sha256,
    status: row.status || "",
    version: positiveInteger(row.version),
  };
}

function permanentCoverKey(materialId: string, sha256: string): string {
  return `covers/${materialId}/${sha256}.jpg`;
}

function parseCoverPlan(value: string | null): CoverPlan {
  try {
    const plan = JSON.parse(value ?? "") as CoverPlan;
    if (
      plan?.phase !== "cover_planned"
      || !plan.result
      || !/^CAT-\d{4,}$/u.test(plan.result.materialId)
      || !/^[0-9a-f]{64}$/u.test(plan.result.sha256)
      || plan.result.storageKey !== permanentCoverKey(plan.result.materialId, plan.result.sha256)
      || !Number.isInteger(plan.expectedVersion)
      || plan.expectedVersion < 0
      || plan.result.coverVersion !== plan.expectedVersion + 1
    ) throw new Error("invalid plan");
    return plan;
  } catch {
    throw invalidCommand();
  }
}

function parseCompletedResult(value: string | null): CoverReplaceResult {
  try {
    const result = JSON.parse(value ?? "") as CoverReplaceResult;
    if (
      !result
      || !/^CAT-\d{4,}$/u.test(result.materialId)
      || !/^[0-9a-f]{64}$/u.test(result.sha256)
      || result.storageKey !== permanentCoverKey(result.materialId, result.sha256)
      || !Number.isInteger(result.coverVersion)
      || result.coverVersion <= 0
    ) throw new Error("invalid result");
    return result;
  } catch {
    throw invalidCommand();
  }
}

function invalidCommand(): LibraryCoverMutationError {
  return new LibraryCoverMutationError(
    "mutation_result_invalid",
    503,
    "Збережений стан зміни обкладинки пошкоджено.",
  );
}

function coverVersionConflict(currentVersion: number): LibraryCoverMutationError {
  return new LibraryCoverMutationError(
    "cover_version_conflict",
    409,
    "Обкладинку вже змінив інший запит. Оновіть картку і повторіть дію.",
    { currentVersion },
  );
}

async function mutationHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stableStringify(value)),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(object[key])}`
  ).join(",")}}`;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function positiveInteger(value: unknown): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function nullableInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}
