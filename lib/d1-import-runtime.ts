/**
 * Worker-safe runtime for the one-time staging import.
 *
 * The browser uploads data, never SQL. This module validates the complete
 * loader plan and derives the same bounded INSERT statements that the local
 * loader uses. Keep it free of Node-only modules: it runs inside a Worker.
 */

export const HOSTED_IMPORT_PLAN_FORMAT = "library-d1-load-plan";
export const HOSTED_IMPORT_PLAN_VERSION = 2;
export const HOSTED_IMPORT_TARGET_SCHEMA = "0003";
export const HOSTED_IMPORT_MAX_BYTES = 6 * 1024 * 1024;
export const HOSTED_IMPORT_MAX_INSERT_SQL_BYTES = 72_000;
export const HOSTED_IMPORT_MAX_BATCH_STATEMENTS = 45;
export const HOSTED_IMPORT_MAX_ROWS = 20_000;

/**
 * Static, FK-safe deletion order for the disposable staging database.
 *
 * This deliberately excludes schema/migration tables and the legacy draft
 * tables. `migration_import_runs` is included so the same pinned plan can be
 * uploaded again after a reset.
 */
export const STAGING_IMPORT_RESET_TABLES = Object.freeze([
  "telegram_librarian_sessions",
  "telegram_mini_app_auth_receipts",
  "telegram_delivery_outbox",
  "telegram_teacher_activation_invites",
  "telegram_link_tokens",
  "telegram_connections",
  "telegram_webhook_updates",
  "portal_notifications",
  "material_request_events",
  "material_request_reservations",
  "material_request_items",
  "material_requests",
  "teacher_profiles",
  "visit_slot_claims",
  "visit_bookings",
  "visit_guest_sessions",
  "visit_guest_rate_limits",
  "visit_teacher_sessions",
  "visit_teacher_login_limits",
  "visit_teacher_access_commands",
  "visit_teacher_credentials",
  "visit_mutation_commands",
  "visit_schedule_closures",
  "visit_schedule_hours",
  "class_loan_transaction_lines",
  "class_loan_transactions",
  "class_loan_items",
  "class_loans",
  "inventory_transaction_lines",
  "inventory_transactions",
  "loan_items",
  "loans",
  "holdings",
  "material_stock_totals",
  "material_links",
  "material_cover_assets",
  "textbook_assignments",
  "material_metadata_enrichments",
  "class_years",
  "audit_events",
  "mutation_commands",
  "materials",
  "academic_years",
  "cohorts",
  "locations",
  "users",
  "migration_import_runs",
] as const);

const ACADEMIC_YEAR_ID_RE = /^YR-(20\d{2})-(20\d{2})$/u;
const ACADEMIC_YEAR_LABEL_RE = /^(20\d{2})\/(20\d{2})$/u;
const COHORT_ID_RE = /^COH-\d{3,}$/u;
const CLASS_YEAR_ID_RE = /^CY-(20\d{2})-\d{3,}$/u;
const CLASS_CODE_RE = /^[\p{L}\p{N}().'_-]{1,16}$/u;

const DUAL_ROLE_TEACHER_IDENTITIES = new Map<string, string>([
  ["USR-006", "Орел Галина Миколаївна"],
  ["USR-007", "Галака Наталія Григорівна"],
  ["USR-008", "Єгорова Альона Ігорівна"],
  ["USR-009", "Плахотнюк Володимир Віталійович"],
]);

type ScalarKind = "string" | "integer" | "nullable-string" | "nullable-integer";

type TableSpec = {
  name: string;
  columns: Readonly<Record<string, ScalarKind>>;
  primaryKey: readonly string[];
  uniqueKeys: readonly (readonly string[])[];
};

export const HOSTED_IMPORT_TABLE_SPECS: readonly TableSpec[] = Object.freeze([
  tableSpec("locations", {
    id: "string", name: "string", type: "string", status: "string",
    is_public: "integer", sort_order: "integer", created_at: "string", updated_at: "string",
  }, ["id"], [["name"]]),
  tableSpec("users", {
    id: "string", full_name: "string", sort_name: "string", email: "nullable-string",
    auth_user_id: "nullable-string", role: "string", status: "string",
    created_at: "string", updated_at: "string",
  }, ["id"], [["email"], ["auth_user_id"]]),
  tableSpec("academic_years", {
    id: "string", label: "string", start_date: "string", end_date: "string",
    status: "string", notes: "string", version: "integer",
    created_at: "string", updated_at: "string",
  }, ["id"], [["label"]]),
  tableSpec("cohorts", {
    id: "string", status: "string", notes: "string",
    created_at: "string", updated_at: "string",
  }, ["id"]),
  tableSpec("class_years", {
    id: "string", academic_year_id: "string", cohort_id: "string", class_name: "string",
    grade: "integer", code: "string", teacher_user_id: "nullable-string",
    location_id: "nullable-string", start_date: "string", end_date: "string",
    status: "string", actual_closed_date: "nullable-string", notes: "string",
    version: "integer", created_at: "string", updated_at: "string",
  }, ["id"], [["academic_year_id", "cohort_id"], ["academic_year_id", "class_name"]]),
  tableSpec("materials", {
    id: "string", catalog_number: "integer", title: "string", sort_title: "string",
    search_text: "string", rubric: "string", publication_type: "string", subject: "string",
    class_from: "nullable-integer", class_to: "nullable-integer", author: "string",
    publication_year: "nullable-integer", isbn: "string", isbn_normalized: "string",
    publisher: "string", notes: "string", status: "string", version: "integer",
    created_at: "string", updated_at: "string", archived_at: "nullable-string",
  }, ["id"], [["catalog_number"]]),
  tableSpec("material_links", {
    id: "string", material_id: "string", kind: "string", label: "string", url: "string",
    is_public: "integer", sort_order: "integer", status: "string",
    created_at: "string", updated_at: "string",
  }, ["id"], [["material_id", "url"]]),
  tableSpec("material_cover_assets", {
    id: "string", material_id: "string", storage_provider: "string",
    storage_key: "nullable-string", external_url: "nullable-string", mime_type: "nullable-string",
    byte_length: "nullable-integer", width: "nullable-integer", height: "nullable-integer",
    sha256: "nullable-string", status: "string", version: "integer",
    created_at: "string", updated_at: "string",
  }, ["id"], [["material_id"], ["storage_key"]]),
  tableSpec("inventory_transactions", {
    id: "string", request_id: "string", kind: "string", occurred_at: "string",
    document_number: "nullable-string", reason: "string", notes: "string",
    loan_id: "nullable-string", actor_user_id: "string", reversal_of_id: "nullable-string",
    status: "string", created_at: "string",
  }, ["id"], [["request_id"], ["reversal_of_id"]]),
  tableSpec("inventory_transaction_lines", {
    id: "string", transaction_id: "string", material_id: "string", location_id: "string",
    condition: "string", quantity_delta: "integer", quantity_before: "integer",
    quantity_after: "integer", counted_quantity: "nullable-integer",
    loan_item_id: "nullable-string", created_at: "string",
  }, ["id"]),
  tableSpec("holdings", {
    material_id: "string", location_id: "string", condition: "string", quantity: "integer",
    version: "integer", updated_at: "string",
  }, ["material_id", "location_id", "condition"]),
  tableSpec("material_stock_totals", {
    material_id: "string", total_quantity: "integer", library_quantity: "integer",
    other_location_quantity: "integer", loaned_quantity: "integer", updated_at: "string",
  }, ["material_id"]),
  tableSpec("audit_events", {
    id: "string", actor_user_id: "nullable-string", actor_email: "string", action: "string",
    entity_type: "string", entity_id: "string", request_id: "nullable-string",
    before_json: "nullable-string", after_json: "nullable-string", metadata_json: "nullable-string",
    created_at: "string",
  }, ["id"]),
]);

export type HostedImportPlan = {
  format: typeof HOSTED_IMPORT_PLAN_FORMAT;
  format_version: typeof HOSTED_IMPORT_PLAN_VERSION;
  target_schema: typeof HOSTED_IMPORT_TARGET_SCHEMA;
  source_bundle_sha256: string;
  imported_at: string;
  tables: Record<string, Array<Record<string, string | number | null>>>;
  reconciliation: Record<string, unknown> & { ok: true };
};

export type D1StatementLike = {
  bind?: (...values: unknown[]) => D1StatementLike;
  all?: () => Promise<{ results?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>;
  run?: () => Promise<{ meta?: { changes?: number } }>;
  first?: <T = Record<string, unknown>>() => Promise<T | null>;
};

export type D1DatabaseLike = {
  prepare(sql: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<Array<{ meta?: { changes?: number } }>>;
};

export type HostedImportInspection = {
  ok: boolean;
  targetSchema: string;
  sourceBundleSha256: string;
  tables: Record<string, {
    target: number;
    existing: number;
    new: number;
    unchanged: number;
    conflicts: number;
    extraExisting: number;
  }>;
  totalNew: number;
  totalUnchanged: number;
  totalConflicts: number;
  totalExtraExisting: number;
  ftsContentRows: number;
  conflicts: Array<Record<string, unknown>>;
};

export class HostedImportError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = "HostedImportError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type StagingImportResetResult = {
  batchStatements: number;
  clearedReversalLinks: number;
  deletedRows: number;
  deletedByTable: Record<(typeof STAGING_IMPORT_RESET_TABLES)[number], number>;
};

export type HostedImportCommitProof = {
  runId: string;
  planSha256: string;
  expectedRows: number;
  insertStatements: number;
  expiresAt: string;
  committedAt: string;
};

/** Abort the entire import batch if its exact committed run proof vanished. */
export function bindHostedImportCommitGuard(
  db: D1DatabaseLike,
  proof: HostedImportCommitProof,
): D1StatementLike {
  const statement = db.prepare(`
    INSERT INTO migration_import_runs (id)
    SELECT '__invalid_missing_commit_proof__'
    WHERE NOT EXISTS (
      SELECT 1
      FROM migration_import_runs
      WHERE id = ?
        AND plan_sha256 = ?
        AND status = 'committed'
        AND expected_rows = ?
        AND insert_statements = ?
        AND expires_at = ?
        AND committed_at = ?
    )
  `);
  if (!statement.bind) {
    throw new HostedImportError("d1_adapter_invalid", "D1 adapter не підтримує bind().", 500);
  }
  return statement.bind(
    proof.runId,
    proof.planSha256,
    proof.expectedRows,
    proof.insertStatements,
    proof.expiresAt,
    proof.committedAt,
  );
}

/**
 * Clears only disposable D1 domain rows in one D1 batch. The FTS command and
 * every DELETE participate in the same transaction, so a failed statement
 * restores both the content rows and the search index.
 */
export async function resetStagingImportTarget(
  db: D1DatabaseLike,
): Promise<StagingImportResetResult> {
  const statements = [
    db.prepare("INSERT INTO materials_fts(materials_fts) VALUES('delete-all')"),
    // The schema requires `kind='reversal'` and `reversal_of_id` together, so
    // both disposable fields must be neutralized in the same UPDATE.
    db.prepare("UPDATE inventory_transactions SET kind = 'import', reversal_of_id = NULL WHERE reversal_of_id IS NOT NULL"),
    ...STAGING_IMPORT_RESET_TABLES.map((table) => db.prepare(`DELETE FROM "${table}"`)),
  ];
  let results: Array<{ meta?: { changes?: number } }>;
  try {
    results = await db.batch(statements);
  } catch {
    throw new HostedImportError(
      "staging_reset_atomic_batch_failed",
      "Тестову D1 не очищено: атомарний batch скасовано без часткових змін.",
      409,
    );
  }

  const deletedByTable = Object.fromEntries(
    STAGING_IMPORT_RESET_TABLES.map((table, index) => [
      table,
      Number(results[index + 2]?.meta?.changes ?? 0),
    ]),
  ) as StagingImportResetResult["deletedByTable"];

  return {
    batchStatements: statements.length,
    clearedReversalLinks: Number(results[1]?.meta?.changes ?? 0),
    deletedRows: Object.values(deletedByTable).reduce((total, count) => total + count, 0),
    deletedByTable,
  };
}

export type BoundedRequestBodyOptions = {
  limit: number;
  tooLargeCode: string;
  tooLargeMessage: string;
  emptyCode: string;
  emptyMessage: string;
};

export type HostedImportReplayRun = {
  id: string;
  plan_sha256: string;
  source_bundle_sha256: string;
  object_key: string;
  status: string;
  plan_bytes: number;
  created_by_user_id: string;
  expires_at: string;
};

type HostedImportReplayObject = {
  size?: number;
  customMetadata?: Record<string, string>;
};

export type HostedImportReplayInput<Run extends HostedImportReplayRun> = {
  run: Run;
  bytes: Uint8Array;
  expectedObjectKey: string;
  ownerUserId: string;
  head: (key: string) => Promise<HostedImportReplayObject | null>;
  put: (
    key: string,
    value: ArrayBuffer,
    options: {
      httpMetadata: { contentType: string };
      customMetadata: Record<string, string>;
    },
  ) => Promise<unknown>;
  delete: (key: string) => Promise<void>;
  reload: () => Promise<Run | null>;
  assertWritable?: () => void;
};

function tableSpec(
  name: string,
  columns: Record<string, ScalarKind>,
  primaryKey: readonly string[],
  uniqueKeys: readonly (readonly string[])[] = [],
): TableSpec {
  return Object.freeze({
    name,
    columns: Object.freeze(columns),
    primaryKey: Object.freeze(primaryKey),
    uniqueKeys: Object.freeze(uniqueKeys),
  });
}

export async function readBoundedJsonBytes(request: Request): Promise<Uint8Array> {
  const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new HostedImportError("unsupported_media_type", "Потрібен JSON-файл плану імпорту.", 415);
  }
  return readBoundedRequestBytes(request, {
    limit: HOSTED_IMPORT_MAX_BYTES,
    tooLargeCode: "plan_too_large",
    tooLargeMessage: "Файл плану перевищує 6 МіБ.",
    emptyCode: "empty_body",
    emptyMessage: "Файл плану порожній.",
  });
}

/**
 * Read a request body without ever buffering more than the caller's limit.
 * Content-Encoding is rejected so the limit always applies to the exact bytes
 * that are validated and hashed.
 */
export async function readBoundedRequestBytes(
  request: Request,
  options: BoundedRequestBodyOptions,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
    throw new HostedImportError("request_body_limit_invalid", "Некоректний службовий ліміт тіла запиту.", 500);
  }
  if (request.headers.has("Content-Encoding")) {
    throw new HostedImportError("content_encoding_forbidden", "Стиснене тіло запиту не приймається.", 415);
  }
  const declared = request.headers.get("Content-Length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > options.limit)) {
    throw new HostedImportError(options.tooLargeCode, options.tooLargeMessage, 413);
  }
  if (!request.body) {
    throw new HostedImportError(options.emptyCode, options.emptyMessage, 400);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > options.limit) {
        try { await reader.cancel("request body too large"); } catch { /* size error is authoritative */ }
        throw new HostedImportError(options.tooLargeCode, options.tooLargeMessage, 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) {
    throw new HostedImportError(options.emptyCode, options.emptyMessage, 400);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Repair a missing private replay object without racing an expired cleanup.
 * The D1 run is re-read after any R2 observation/write. If cleanup won, this
 * call removes a late recreation instead of returning a stale resumable state.
 */
export async function settleHostedImportUploadReplay<Run extends HostedImportReplayRun>(
  input: HostedImportReplayInput<Run>,
): Promise<Run> {
  assertReplayRunCompatible(input.run, input.run, input);
  if (input.run.status === "cleaned") return input.run;

  const object = await input.head(input.run.object_key);
  if (object) {
    assertReplayObjectCompatible(object, input.run);
  } else {
    input.assertWritable?.();
    await input.put(
      input.run.object_key,
      input.bytes.slice().buffer,
      {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
        customMetadata: {
          runId: input.run.id,
          planSha256: input.run.plan_sha256,
          ownerUserId: input.run.created_by_user_id,
          expiresAt: input.run.expires_at,
        },
      },
    );
    try {
      input.assertWritable?.();
    } catch (error) {
      // A PUT that crossed the gate deadline must not leave a newly-created
      // object behind. The per-run key is unique, so this delete cannot target
      // another import session.
      await input.delete(input.run.object_key);
      throw error;
    }
  }

  // This read is mandatory even when HEAD found the object: cleanup may have
  // claimed the run and deleted the object between the two operations.
  const latest = await input.reload();
  if (!latest) {
    throw new HostedImportError(
      "import_upload_replay_lost",
      "Службовий запис сесії зник під час відновлення upload.",
      409,
    );
  }
  assertReplayRunCompatible(latest, input.run, input);
  if (latest.status === "cleaned") {
    await input.delete(latest.object_key);
  }
  return latest;
}

function assertReplayRunCompatible<Run extends HostedImportReplayRun>(
  candidate: Run,
  original: Run,
  input: HostedImportReplayInput<Run>,
): void {
  if (candidate.id !== original.id
    || candidate.plan_sha256 !== original.plan_sha256
    || candidate.source_bundle_sha256 !== original.source_bundle_sha256
    || candidate.object_key !== input.expectedObjectKey
    || candidate.object_key !== original.object_key
    || candidate.plan_bytes !== input.bytes.byteLength
    || candidate.plan_bytes !== original.plan_bytes
    || candidate.created_by_user_id !== input.ownerUserId
    || candidate.created_by_user_id !== original.created_by_user_id
    || candidate.expires_at !== original.expires_at) {
    throw new HostedImportError(
      "import_upload_replay_mismatch",
      "Службовий запис сесії змінився під час відновлення upload.",
      409,
    );
  }
}

function assertReplayObjectCompatible(
  object: HostedImportReplayObject,
  run: HostedImportReplayRun,
): void {
  const metadata = object.customMetadata ?? {};
  if ((typeof object.size === "number" && object.size !== run.plan_bytes)
    || metadata.runId !== run.id
    || metadata.planSha256 !== run.plan_sha256
    || metadata.ownerUserId !== run.created_by_user_id
    || metadata.expiresAt !== run.expires_at) {
    throw new HostedImportError(
      "plan_object_metadata_invalid",
      "Метадані приватного плану не пройшли перевірку replay.",
      409,
    );
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    digestInput.buffer,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function parseAndValidateHostedImportPlan(bytes: Uint8Array): HostedImportPlan {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HostedImportError("plan_json_invalid", "Файл не є коректним UTF-8 JSON.");
  }
  return validateHostedImportPlan(value);
}

export function validateHostedImportPlan(value: unknown): HostedImportPlan {
  const plan = requireRecord(value, "plan");
  requireExactKeys(plan, [
    "format", "format_version", "target_schema", "source_bundle_sha256",
    "imported_at", "tables", "reconciliation",
  ], "plan");
  if (plan.format !== HOSTED_IMPORT_PLAN_FORMAT
    || plan.format_version !== HOSTED_IMPORT_PLAN_VERSION
    || plan.target_schema !== HOSTED_IMPORT_TARGET_SCHEMA) {
    throw new HostedImportError(
      "plan_contract_invalid",
      `Очікується ${HOSTED_IMPORT_PLAN_FORMAT} v${HOSTED_IMPORT_PLAN_VERSION} для schema ${HOSTED_IMPORT_TARGET_SCHEMA}.`,
    );
  }
  requireSha256(plan.source_bundle_sha256, "plan.source_bundle_sha256");
  requireIsoTimestamp(plan.imported_at, "plan.imported_at");

  const tables = requireRecord(plan.tables, "plan.tables");
  requireExactKeys(tables, HOSTED_IMPORT_TABLE_SPECS.map((spec) => spec.name), "plan.tables");
  let totalRows = 0;
  const ids = new Map<string, Set<string>>();
  for (const spec of HOSTED_IMPORT_TABLE_SPECS) {
    const rows = tables[spec.name];
    if (!Array.isArray(rows)) fail("plan_table_invalid", `plan.tables.${spec.name} має бути масивом.`);
    totalRows += rows.length;
    if (totalRows > HOSTED_IMPORT_MAX_ROWS) {
      fail("plan_row_limit", `План перевищує ліміт ${HOSTED_IMPORT_MAX_ROWS} рядків.`);
    }
    const primary = new Set<string>();
    const uniqueSets = spec.uniqueKeys.map(() => new Set<string>());
    for (const [index, rawRow] of rows.entries()) {
      const path = `plan.tables.${spec.name}[${index}]`;
      const row = requireRecord(rawRow, path);
      requireExactKeys(row, Object.keys(spec.columns), path);
      for (const [column, kind] of Object.entries(spec.columns)) {
        validateScalar(row[column], kind, `${path}.${column}`);
      }
      const primaryValue = compoundKey(row, spec.primaryKey);
      if (primary.has(primaryValue)) fail("plan_primary_key_duplicate", `${path}: повторний первинний ключ.`);
      primary.add(primaryValue);
      spec.uniqueKeys.forEach((columns, uniqueIndex) => {
        if (columns.some((column) => row[column] === null)) return;
        const key = compoundKey(row, columns);
        if (uniqueSets[uniqueIndex].has(key)) fail("plan_unique_key_duplicate", `${path}: повторне унікальне значення.`);
        uniqueSets[uniqueIndex].add(key);
      });
    }
    ids.set(
      spec.name,
      new Set(rows.map((row) => String((row as Record<string, unknown>)[spec.primaryKey[0]]))),
    );
  }
  if (totalRows === 0) fail("plan_empty", "Порожній план імпорту не дозволено.");

  validateReferences(tables as HostedImportPlan["tables"], ids);
  validateAcademicTables(tables as HostedImportPlan["tables"]);
  validateStockTotals(tables as HostedImportPlan["tables"]);

  const reconciliation = requireRecord(plan.reconciliation, "plan.reconciliation");
  if (reconciliation.ok !== true) fail("plan_reconciliation_failed", "Локальна reconciliation плану неуспішна.");
  if (reconciliation.target_schema !== HOSTED_IMPORT_TARGET_SCHEMA) {
    fail("plan_reconciliation_schema_mismatch", "Schema у reconciliation не збігається з планом.");
  }
  if (reconciliation.source_bundle_sha256 !== plan.source_bundle_sha256) {
    fail("plan_reconciliation_hash_mismatch", "Hash джерела у reconciliation не збігається з планом.");
  }
  const targetCounts = requireRecord(reconciliation.target_counts, "plan.reconciliation.target_counts");
  requireExactKeys(targetCounts, HOSTED_IMPORT_TABLE_SPECS.map((spec) => spec.name), "plan.reconciliation.target_counts");
  for (const spec of HOSTED_IMPORT_TABLE_SPECS) {
    if (targetCounts[spec.name] !== (tables[spec.name] as unknown[]).length) {
      fail("plan_target_count_mismatch", `Кількість ${spec.name} не збігається з reconciliation.`);
    }
  }

  return plan as HostedImportPlan;
}

function validateScalar(value: unknown, kind: ScalarKind, path: string): void {
  const nullable = kind.startsWith("nullable-");
  if (value === null && nullable) return;
  const base = nullable ? kind.slice("nullable-".length) : kind;
  if (base === "integer") {
    if (!Number.isSafeInteger(value)) fail("plan_scalar_invalid", `${path} має бути цілим безпечним числом${nullable ? " або null" : ""}.`);
    return;
  }
  if (typeof value !== "string") fail("plan_scalar_invalid", `${path} має бути рядком${nullable ? " або null" : ""}.`);
  if (value.includes("\0")) fail("plan_nul_forbidden", `${path} містить заборонений NUL-символ.`);
  if (new TextEncoder().encode(value).byteLength > 256 * 1024) {
    fail("plan_string_too_large", `${path} перевищує 256 КіБ.`);
  }
}

function validateReferences(
  tables: HostedImportPlan["tables"],
  ids: Map<string, Set<string>>,
): void {
  const materialIds = ids.get("materials") ?? new Set();
  const userIds = ids.get("users") ?? new Set();
  const locationIds = ids.get("locations") ?? new Set();
  const academicYearIds = ids.get("academic_years") ?? new Set();
  const cohortIds = ids.get("cohorts") ?? new Set();
  const transactionIds = ids.get("inventory_transactions") ?? new Set();
  for (const [index, row] of tables.class_years.entries()) {
    requireReference(academicYearIds, row.academic_year_id, `plan.tables.class_years[${index}].academic_year_id`);
    requireReference(cohortIds, row.cohort_id, `plan.tables.class_years[${index}].cohort_id`);
    if (row.teacher_user_id !== null) {
      requireReference(userIds, row.teacher_user_id, `plan.tables.class_years[${index}].teacher_user_id`);
    }
    if (row.location_id !== null) {
      requireReference(locationIds, row.location_id, `plan.tables.class_years[${index}].location_id`);
    }
  }
  for (const table of ["material_links", "material_cover_assets", "inventory_transaction_lines", "holdings", "material_stock_totals"]) {
    for (const [index, row] of tables[table].entries()) {
      requireReference(materialIds, row.material_id, `plan.tables.${table}[${index}].material_id`);
    }
  }
  for (const [index, row] of tables.inventory_transactions.entries()) {
    requireReference(userIds, row.actor_user_id, `plan.tables.inventory_transactions[${index}].actor_user_id`);
  }
  for (const [index, row] of tables.inventory_transaction_lines.entries()) {
    requireReference(transactionIds, row.transaction_id, `plan.tables.inventory_transaction_lines[${index}].transaction_id`);
    requireReference(locationIds, row.location_id, `plan.tables.inventory_transaction_lines[${index}].location_id`);
  }
  for (const [index, row] of tables.holdings.entries()) {
    requireReference(locationIds, row.location_id, `plan.tables.holdings[${index}].location_id`);
  }
  for (const [index, row] of tables.audit_events.entries()) {
    if (row.actor_user_id !== null) requireReference(userIds, row.actor_user_id, `plan.tables.audit_events[${index}].actor_user_id`);
  }
}

function validateAcademicTables(tables: HostedImportPlan["tables"]): void {
  const academicYears = new Map<string, Record<string, string | number | null>>();
  let activeYearCount = 0;
  for (const [index, row] of tables.academic_years.entries()) {
    const path = `plan.tables.academic_years[${index}]`;
    const id = String(row.id);
    const label = String(row.label);
    const idMatch = id.match(ACADEMIC_YEAR_ID_RE);
    const labelMatch = label.match(ACADEMIC_YEAR_LABEL_RE);
    if (!idMatch || Number(idMatch[2]) !== Number(idMatch[1]) + 1) {
      fail("plan_academic_year_invalid", `${path}.id має бути послідовним ID YR-2026-2027.`);
    }
    if (!labelMatch
      || Number(labelMatch[2]) !== Number(labelMatch[1]) + 1
      || labelMatch[1] !== idMatch[1]
      || labelMatch[2] !== idMatch[2]) {
      fail("plan_academic_year_invalid", `${path}.label не відповідає ID навчального року.`);
    }
    if (!isCalendarDate(row.start_date) || !isCalendarDate(row.end_date) || String(row.start_date) >= String(row.end_date)) {
      fail("plan_academic_year_invalid", `${path} містить некоректний діапазон календарних дат.`);
    }
    if (String(row.start_date).slice(0, 4) !== idMatch[1] || String(row.end_date).slice(0, 4) !== idMatch[2]) {
      fail("plan_academic_year_invalid", `${path} містить дати, що не відповідають ID навчального року.`);
    }
    if (String(row.end_date) !== `${idMatch[2]}-05-31`) {
      fail("plan_academic_year_invalid", `${path}.end_date має бути 31 травня.`);
    }
    if (!(["draft", "active", "closed"] as unknown[]).includes(row.status)) {
      fail("plan_academic_year_invalid", `${path}.status має бути draft, active або closed.`);
    }
    if (!Number.isSafeInteger(row.version) || Number(row.version) < 1) {
      fail("plan_academic_year_invalid", `${path}.version має бути додатним цілим числом.`);
    }
    if (row.status === "active") activeYearCount += 1;
    academicYears.set(id, row);
  }
  if (activeYearCount > 1) {
    fail("plan_academic_state_invalid", "План містить більше одного активного навчального року.");
  }

  const cohorts = new Map<string, Record<string, string | number | null>>();
  for (const [index, row] of tables.cohorts.entries()) {
    const path = `plan.tables.cohorts[${index}]`;
    const id = String(row.id);
    if (!COHORT_ID_RE.test(id)) {
      fail("plan_cohort_invalid", `${path}.id має формат COH-001.`);
    }
    if (!(["active", "graduated", "closed"] as unknown[]).includes(row.status)) {
      fail("plan_cohort_invalid", `${path}.status має бути active, graduated або closed.`);
    }
    cohorts.set(id, row);
  }

  const users = new Map(tables.users.map((row) => [String(row.id), row]));
  const locations = new Map(tables.locations.map((row) => [String(row.id), row]));
  const openCohorts = new Set<string>();
  for (const [index, row] of tables.class_years.entries()) {
    const path = `plan.tables.class_years[${index}]`;
    const id = String(row.id);
    const academicYearId = String(row.academic_year_id);
    const cohortId = String(row.cohort_id);
    const idMatch = id.match(CLASS_YEAR_ID_RE);
    const year = academicYears.get(academicYearId);
    const cohort = cohorts.get(cohortId);
    if (!idMatch || !year || idMatch[1] !== academicYearId.slice(3, 7)) {
      fail("plan_class_year_invalid", `${path}.id не відповідає навчальному року.`);
    }
    if (!cohort) fail("plan_class_year_invalid", `${path}.cohort_id не знайдено.`);
    if (!Number.isSafeInteger(row.grade) || Number(row.grade) < 1 || Number(row.grade) > 11) {
      fail("plan_class_year_invalid", `${path}.grade має бути цілим числом від 1 до 11.`);
    }
    if (typeof row.code !== "string" || !CLASS_CODE_RE.test(row.code)) {
      fail("plan_class_year_invalid", `${path}.code містить недозволені символи.`);
    }
    if (row.class_name !== `${row.grade}-${row.code}`) {
      fail("plan_class_year_invalid", `${path}.class_name не відповідає grade і code.`);
    }
    if (!isCalendarDate(row.start_date) || !isCalendarDate(row.end_date) || String(row.start_date) >= String(row.end_date)) {
      fail("plan_class_year_invalid", `${path} містить некоректний діапазон календарних дат.`);
    }
    if (String(row.start_date) < String(year.start_date) || String(row.end_date) > String(year.end_date)) {
      fail("plan_class_year_invalid", `${path} містить дати поза межами навчального року.`);
    }
    if (!(["planned", "active", "closed"] as unknown[]).includes(row.status)) {
      fail("plan_class_year_invalid", `${path}.status має бути planned, active або closed.`);
    }
    if (!Number.isSafeInteger(row.version) || Number(row.version) < 1) {
      fail("plan_class_year_invalid", `${path}.version має бути додатним цілим числом.`);
    }
    const isClosed = row.status === "closed";
    if (isClosed !== (row.actual_closed_date !== null)
      || (row.actual_closed_date !== null && !isCalendarDate(row.actual_closed_date))) {
      fail("plan_class_year_invalid", `${path} має неузгоджені status та actual_closed_date.`);
    }
    if (row.actual_closed_date !== null && String(row.actual_closed_date) < String(row.start_date)) {
      fail("plan_class_year_invalid", `${path}.actual_closed_date передує даті початку.`);
    }
    if (row.teacher_user_id !== null) {
      const teacher = users.get(String(row.teacher_user_id));
      if (!teacher || !isTeacherProfileSourceUser(teacher) || teacher.status !== "active") {
        fail("plan_class_teacher_invalid", `${path}.teacher_user_id має посилатися на активного вчителя.`);
      }
    }
    if (row.location_id !== null) {
      const location = locations.get(String(row.location_id));
      if (!location || location.status !== "active" || location.type === "service") {
        fail("plan_class_location_invalid", `${path}.location_id має посилатися на активне неслужбове місце.`);
      }
    }
    if (row.status !== "closed" && cohort.status !== "active") {
      fail("plan_academic_state_invalid", `${path}: відкритий клас належить неактивній групі.`);
    }
    if (row.status !== "closed") {
      if (openCohorts.has(cohortId)) {
        fail("plan_academic_state_invalid", `${path}: класна група використовується більш ніж одним відкритим класом.`);
      }
      openCohorts.add(cohortId);
    }
    if ((row.status === "active" && year.status !== "active")
      || (row.status === "planned" && year.status !== "draft")
      || (year.status === "closed" && row.status !== "closed")) {
      fail("plan_academic_state_invalid", `${path}: статус класу не узгоджений зі статусом навчального року.`);
    }
  }
}

function isTeacherProfileSourceUser(row: Record<string, string | number | null>): boolean {
  if (row.role === "teacher") return true;
  return row.role === "admin"
    && row.status === "active"
    && DUAL_ROLE_TEACHER_IDENTITIES.get(String(row.id)) === row.full_name;
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function validateStockTotals(tables: HostedImportPlan["tables"]): void {
  for (const [index, row] of tables.material_stock_totals.entries()) {
    const total = row.total_quantity;
    const library = row.library_quantity;
    const other = row.other_location_quantity;
    const loaned = row.loaned_quantity;
    if (typeof total !== "number"
      || typeof library !== "number"
      || typeof other !== "number"
      || typeof loaned !== "number"
      || [total, library, other, loaned].some((value) => value < 0)) {
      fail("plan_stock_negative", `plan.tables.material_stock_totals[${index}] містить від’ємний залишок.`);
    }
    if (total !== library + other + loaned) {
      fail("plan_stock_equation_invalid", `plan.tables.material_stock_totals[${index}] не проходить рівність залишків.`);
    }
  }
  for (const [index, row] of tables.holdings.entries()) {
    if (typeof row.quantity !== "number" || row.quantity <= 0) {
      fail("plan_holding_invalid", `plan.tables.holdings[${index}] має містити додатний залишок.`);
    }
  }
}

function requireReference(values: Set<string>, value: unknown, path: string): void {
  if (typeof value !== "string" || !values.has(value)) fail("plan_reference_missing", `${path} не посилається на рядок цього плану.`);
}

export async function inspectHostedImportPlan(
  db: D1DatabaseLike,
  plan: HostedImportPlan,
): Promise<HostedImportInspection> {
  validateHostedImportPlan(plan);
  const required = [
    ...HOSTED_IMPORT_TABLE_SPECS.map((spec) => spec.name),
    "teacher_profiles",
    "materials_fts",
  ];
  const schemaRows = await queryRows(
    db,
    `SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (${required.map(sqlLiteral).join(", ")})`,
  );
  const present = new Set(schemaRows.map((row) => String(row.name)));
  const missing = required.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new HostedImportError(
      "import_schema_missing",
      `У D1 відсутні таблиці schema ${HOSTED_IMPORT_TARGET_SCHEMA}: ${missing.join(", ")}.`,
      409,
      { missingTables: missing },
    );
  }

  const tableReports: HostedImportInspection["tables"] = {};
  const conflicts: Array<Record<string, unknown>> = [];
  for (const spec of HOSTED_IMPORT_TABLE_SPECS) {
    const columns = Object.keys(spec.columns);
    const targetRows = plan.tables[spec.name];
    const boundedRows = await queryRows(
      db,
      `SELECT ${columns.map(quoteIdentifier).join(", ")}, count(*) OVER() AS "__hosted_total"
       FROM ${quoteIdentifier(spec.name)}
       ORDER BY ${spec.primaryKey.map(quoteIdentifier).join(", ")}
       LIMIT ${targetRows.length + 1}`,
    );
    const existingTotal = boundedRows.length > 0
      ? Number(boundedRows[0].__hosted_total)
      : 0;
    if (!Number.isSafeInteger(existingTotal) || existingTotal < 0) {
      throw new HostedImportError("d1_inspection_count_invalid", `D1 повернула некоректну кількість ${spec.name}.`, 500);
    }
    const existingRows = boundedRows.map((row) => {
      const clean = { ...row };
      delete clean.__hosted_total;
      return clean;
    });
    const existingByPrimary = new Map(existingRows.map((row) => [compoundKey(row, spec.primaryKey), row]));
    const uniqueMaps = spec.uniqueKeys.map((uniqueColumns) => new Map(existingRows
      .filter((row) => uniqueColumns.every((column) => row[column] !== null && row[column] !== undefined))
      .map((row) => [compoundKey(row, uniqueColumns), row])));
    let newCount = 0;
    let unchanged = 0;
    let tableConflicts = 0;
    for (const row of targetRows) {
      const primary = compoundKey(row, spec.primaryKey);
      const existing = existingByPrimary.get(primary);
      if (existing) {
        if (rowsEqual(row, existing, columns)) unchanged += 1;
        else {
          tableConflicts += 1;
          conflicts.push({
            table: spec.name,
            kind: "primary_key_drift",
            key: primary,
            columns: columns.filter((column) => normalizeSqlValue(row[column]) !== normalizeSqlValue(existing[column])),
          });
        }
        continue;
      }
      let uniqueCollision: Record<string, unknown> | null = null;
      spec.uniqueKeys.forEach((uniqueColumns, uniqueIndex) => {
        if (uniqueCollision || uniqueColumns.some((column) => row[column] === null)) return;
        const key = compoundKey(row, uniqueColumns);
        const collision = uniqueMaps[uniqueIndex].get(key);
        if (collision) uniqueCollision = {
          table: spec.name,
          kind: "unique_key_collision",
          key: primary,
          columns: uniqueColumns,
          existingPrimaryKey: compoundKey(collision, spec.primaryKey),
        };
      });
      if (uniqueCollision) {
        tableConflicts += 1;
        conflicts.push(uniqueCollision);
      } else newCount += 1;
    }
    const targetKeys = new Set(targetRows.map((row) => compoundKey(row, spec.primaryKey)));
    const selectedExtra = existingRows.filter((row) => !targetKeys.has(compoundKey(row, spec.primaryKey))).length;
    const extraExisting = existingTotal <= targetRows.length + 1
      ? selectedExtra
      : Math.max(1, existingTotal - targetRows.length);
    tableReports[spec.name] = {
      target: targetRows.length,
      existing: existingTotal,
      new: newCount,
      unchanged,
      conflicts: tableConflicts,
      extraExisting,
    };
  }

  const materialTargetRows = plan.tables.materials.length;
  const ftsRows = await queryRows(
    db,
    `SELECT rowid, count(*) OVER() AS "__hosted_total"
     FROM materials_fts
     ORDER BY rowid
     LIMIT ${materialTargetRows + 1}`,
  );
  const ftsContentRows = ftsRows.length > 0 ? Number(ftsRows[0].__hosted_total) : 0;
  if (!Number.isSafeInteger(ftsContentRows) || ftsContentRows < 0) {
    throw new HostedImportError("d1_fts_count_invalid", "D1 повернула некоректну кількість FTS content rows.", 500);
  }

  return {
    ok: conflicts.length === 0,
    targetSchema: HOSTED_IMPORT_TARGET_SCHEMA,
    sourceBundleSha256: plan.source_bundle_sha256,
    tables: tableReports,
    totalNew: sum(Object.values(tableReports), (value) => value.new),
    totalUnchanged: sum(Object.values(tableReports), (value) => value.unchanged),
    totalConflicts: conflicts.length,
    totalExtraExisting: sum(Object.values(tableReports), (value) => value.extraExisting),
    ftsContentRows,
    conflicts,
  };
}

export function assertFreshImportInspection(
  inspection: HostedImportInspection,
  plan: HostedImportPlan,
): void {
  const expectedRows = totalHostedImportRows(plan);
  if (!inspection.ok || inspection.totalConflicts > 0) {
    throw new HostedImportError("import_target_conflict", "Staging D1 має конфлікти з планом.", 409, {
      conflictCount: inspection.totalConflicts,
      conflicts: inspection.conflicts.slice(0, 20),
    });
  }
  if (inspection.totalExtraExisting > 0 || inspection.totalUnchanged > 0 || inspection.totalNew !== expectedRows) {
    throw new HostedImportError(
      "import_target_not_empty",
      "Одноразовий hosted-import дозволено лише у порожню цільову staging D1.",
      409,
      {
        expectedRows,
        newRows: inspection.totalNew,
        unchangedRows: inspection.totalUnchanged,
        extraExistingRows: inspection.totalExtraExisting,
      },
    );
  }
  if (inspection.ftsContentRows !== 0) {
    throw new HostedImportError("import_fts_not_empty", "Пошуковий індекс staging не порожній до імпорту.", 409);
  }
}

export function assertVerifiedImportInspection(
  inspection: HostedImportInspection,
  plan: HostedImportPlan,
): void {
  const expectedRows = totalHostedImportRows(plan);
  if (!inspection.ok
    || inspection.totalNew !== 0
    || inspection.totalConflicts !== 0
    || inspection.totalExtraExisting !== 0
    || inspection.totalUnchanged !== expectedRows
    || inspection.ftsContentRows !== plan.tables.materials.length) {
    throw new HostedImportError("import_verification_failed", "D1 не пройшла післяімпортну reconciliation.", 409, {
      expectedRows,
      newRows: inspection.totalNew,
      unchangedRows: inspection.totalUnchanged,
      conflictCount: inspection.totalConflicts,
      extraExistingRows: inspection.totalExtraExisting,
    });
  }
}

/**
 * FTS5 external-content verification. `rank=1` compares the actual index with
 * `content='materials'`; COUNT(*) alone would only read the content table.
 */
export async function verifyHostedImportFts(
  db: D1DatabaseLike,
  plan: HostedImportPlan,
): Promise<{ integrity: true; sampledMaterialIds: string[] }> {
  const integrity = db.prepare(
    "INSERT INTO materials_fts(materials_fts, rank) VALUES('integrity-check', 1)",
  );
  if (!integrity.run) {
    throw new HostedImportError("d1_adapter_invalid", "D1 adapter не підтримує run().", 500);
  }
  try {
    await integrity.run();
  } catch {
    throw new HostedImportError(
      "import_fts_integrity_failed",
      "FTS5 integrity-check не підтвердив відповідність індексу таблиці materials.",
      409,
    );
  }

  const materials = plan.tables.materials;
  const sampleIndexes = [...new Set([0, Math.floor(materials.length / 2), materials.length - 1])]
    .filter((index) => index >= 0 && index < materials.length);
  const sampledMaterialIds: string[] = [];
  for (const index of sampleIndexes) {
    const materialId = String(materials[index].id);
    const token = materialId.match(/^CAT-(\d+)$/u)?.[1];
    if (!token) throw new HostedImportError("plan_material_id_invalid", "CAT-ID не придатний для FTS smoke test.", 400);
    const statement = db.prepare(`
      SELECT materials.id AS id
      FROM materials
      JOIN materials_fts ON materials_fts.rowid = materials.rowid
      WHERE materials.id = ? AND materials_fts MATCH ?
      LIMIT 1
    `);
    if (!statement.bind) {
      throw new HostedImportError("d1_adapter_invalid", "D1 adapter не підтримує bind()/first().", 500);
    }
    const bound = statement.bind(materialId, token);
    if (!bound.first) {
      throw new HostedImportError("d1_adapter_invalid", "D1 adapter не підтримує bind()/first().", 500);
    }
    const row = await bound.first<{ id: string }>();
    if (row?.id !== materialId) {
      throw new HostedImportError(
        "import_fts_match_failed",
        "Детермінований FTS MATCH smoke test не знайшов матеріал.",
        409,
        { materialId },
      );
    }
    sampledMaterialIds.push(materialId);
  }
  return { integrity: true, sampledMaterialIds };
}

export function buildHostedImportInsertSql(plan: HostedImportPlan): string[] {
  validateHostedImportPlan(plan);
  const statements: string[] = [];
  for (const spec of HOSTED_IMPORT_TABLE_SPECS) {
    statements.push(...buildInsertStatements(spec, plan.tables[spec.name]));
  }
  const teacherProfileUserIds = plan.tables.users
    .filter(isTeacherProfileSourceUser)
    .map((row) => String(row.id));
  if (teacherProfileUserIds.length > 0) {
    statements.push(`INSERT INTO teacher_profiles (
      teacher_user_id, subject_position, primary_location_id, service_contact,
      librarian_note, version, last_mutation_request_id, closed_at,
      closed_by_user_id, created_by_user_id, updated_by_user_id, created_at, updated_at
    ) SELECT id, '', NULL, '', '', 1, NULL, NULL, NULL, NULL, NULL, created_at, updated_at
      FROM users WHERE id IN (${teacherProfileUserIds.map(sqlLiteral).join(", ")})`);
  }
  if (statements.length + 3 > HOSTED_IMPORT_MAX_BATCH_STATEMENTS) {
    throw new HostedImportError(
      "import_statement_limit",
      "План потребує забагато D1 batch statements.",
      400,
      { insertStatements: statements.length, batchLimit: HOSTED_IMPORT_MAX_BATCH_STATEMENTS },
    );
  }
  return statements;
}

function buildInsertStatements(
  spec: TableSpec,
  rows: Array<Record<string, string | number | null>>,
): string[] {
  if (rows.length === 0) return [];
  const columns = Object.keys(spec.columns);
  const prefix = `INSERT INTO ${quoteIdentifier(spec.name)} (${columns.map(quoteIdentifier).join(", ")}) VALUES\n`;
  const statements: string[] = [];
  let tuples: string[] = [];
  for (const [index, row] of rows.entries()) {
    const tuple = `(${columns.map((column) => sqlLiteral(row[column])).join(", ")})`;
    if (utf8Length(`${prefix}${tuple}`) > HOSTED_IMPORT_MAX_INSERT_SQL_BYTES) {
      throw new HostedImportError(
        "import_tuple_too_large",
        `Один рядок ${spec.name}[${index}] перевищує SQL-ліміт ${HOSTED_IMPORT_MAX_INSERT_SQL_BYTES} байтів.`,
        400,
      );
    }
    const candidate = `${prefix}${[...tuples, tuple].join(",\n")}`;
    if (tuples.length > 0 && utf8Length(candidate) > HOSTED_IMPORT_MAX_INSERT_SQL_BYTES) {
      statements.push(`${prefix}${tuples.join(",\n")}`);
      tuples = [tuple];
    } else {
      tuples.push(tuple);
    }
  }
  if (tuples.length > 0) statements.push(`${prefix}${tuples.join(",\n")}`);
  return statements;
}

export function totalHostedImportRows(plan: HostedImportPlan): number {
  return HOSTED_IMPORT_TABLE_SPECS.reduce((total, spec) => total + plan.tables[spec.name].length, 0);
}

async function queryRows(db: D1DatabaseLike, sql: string): Promise<Array<Record<string, unknown>>> {
  const statement = db.prepare(sql);
  if (!statement.all) throw new HostedImportError("d1_adapter_invalid", "D1 adapter не підтримує all().", 500);
  const result = await statement.all();
  if (Array.isArray(result)) return result;
  return Array.isArray(result.results) ? result.results : [];
}

function rowsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  columns: readonly string[],
): boolean {
  return columns.every((column) => normalizeSqlValue(left[column]) === normalizeSqlValue(right[column]));
}

function normalizeSqlValue(value: unknown): string {
  if (value === null || value === undefined) return "null:";
  if (typeof value === "number") return `number:${value}`;
  return `string:${String(value)}`;
}

function compoundKey(row: Record<string, unknown>, columns: readonly string[]): string {
  return columns.map((column) => normalizeSqlValue(row[column])).join("\0");
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("plan_sql_value_invalid", "Небезпечне числове значення у плані.");
    return String(value);
  }
  if (typeof value !== "string" || value.includes("\0")) {
    fail("plan_sql_value_invalid", "Небезпечне текстове значення у плані.");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("plan_object_invalid", `${path} має бути JSON-об’єктом.`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const allowed = new Set(expected);
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length > 0 || extra.length > 0) {
    fail("plan_keys_invalid", `${path} має неочікувані або відсутні поля.`, { missing, extra });
  }
}

function requireSha256(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("plan_hash_invalid", `${path} має бути SHA-256 у нижньому регістрі.`);
  }
}

function requireIsoTimestamp(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail("plan_timestamp_invalid", `${path} має бути канонічним ISO-8601 timestamp.`);
  }
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function sum<T>(values: T[], selector: (value: T) => number): number {
  return values.reduce((total, value) => total + selector(value), 0);
}

function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new HostedImportError(code, message, 400, details);
}
