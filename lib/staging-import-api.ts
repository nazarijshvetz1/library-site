import { env } from "cloudflare:workers";

import type { ChatGPTUser } from "@/app/chatgpt-auth";
import {
  authorizeLibrarianApi,
  librarianError,
  librarianJson,
} from "@/lib/librarian-api";
import {
  type D1DatabaseLike,
  type D1StatementLike,
  type HostedImportPlan,
  HostedImportError,
  HOSTED_IMPORT_MAX_BYTES,
  parseAndValidateHostedImportPlan,
  readBoundedRequestBytes,
  sha256Hex,
} from "@/lib/d1-import-runtime";
import { getRuntimeBoolean, getRuntimeString } from "@/lib/runtime-env";
import {
  evaluateStagingImportGate,
  isImportRunExpiryAccepted,
  isStagingImportGateActive,
} from "@/lib/staging-import-gate";
const ACTION_BODY_LIMIT = 2048;
const PLAN_OBJECT_PREFIX = "_migration/library-d1/";

export type ImportRunStatus =
  | "uploaded"
  | "preflighted"
  | "committed"
  | "verified"
  | "cleaned";

export type ImportRun = {
  id: string;
  plan_sha256: string;
  source_bundle_sha256: string;
  object_key: string;
  status: ImportRunStatus;
  plan_bytes: number;
  expected_rows: number | null;
  insert_statements: number | null;
  preflight_json: string | null;
  verification_json: string | null;
  created_by_user_id: string;
  created_by_email: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
  committed_at: string | null;
  verified_at: string | null;
  cleaned_at: string | null;
  last_error_code: string | null;
};

export type ImportStoredObject = {
  body: ReadableStream<Uint8Array>;
  size?: number;
  customMetadata?: Record<string, string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
};

export type ImportBucket = {
  put(
    key: string,
    value: ArrayBuffer,
    options: {
      httpMetadata: { contentType: string };
      customMetadata: Record<string, string>;
    },
  ): Promise<unknown>;
  get(key: string): Promise<ImportStoredObject | null>;
  head(key: string): Promise<{ size?: number; customMetadata?: Record<string, string> } | null>;
  delete(key: string): Promise<void>;
};

export type StagingImportContext = {
  user: ChatGPTUser;
  db: D1DatabaseLike;
  bucket: ImportBucket;
  allowedOrigin: string;
  pinnedPlanSha256: string;
  gateExpiresAt: string;
};

type ImportAuthorization =
  | { ok: true; value: StagingImportContext }
  | { ok: false; response: Response };

export async function authorizeStagingImport(
  request: Request,
  options: { allowExpiredGate?: boolean } = {},
): Promise<ImportAuthorization> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization;

  const gate = evaluateStagingImportGate({
    appEnv: getRuntimeString("APP_ENV"),
    enabled: getRuntimeBoolean("LIBRARY_IMPORT_ENABLED"),
    allowedOrigin: getRuntimeString("LIBRARY_IMPORT_ALLOWED_ORIGIN"),
    pinnedPlanSha256: getRuntimeString("LIBRARY_IMPORT_PLAN_SHA256"),
    expiresAt: getRuntimeString("LIBRARY_IMPORT_EXPIRES_AT"),
    requestUrl: request.url,
    submittedOrigin: request.headers.get("Origin"),
    allowExpiredGate: options.allowExpiredGate,
  });
  if (!gate.ok) {
    return {
      ok: false,
      response: librarianError(
        gate.status,
        gate.code,
        gate.code === "staging_import_disabled"
          ? "Одноразовий імпорт у цьому середовищі вимкнено."
          : gate.code === "staging_import_origin_denied"
            ? "Запит staging-import надійшов не з дозволеного staging-сайту."
            : "Захисний контур staging-import налаштовано не повністю або його строк минув.",
        false,
      ),
    };
  }

  const runtime = env as unknown as Record<string, unknown>;
  const db = runtime.DB;
  const bucket = runtime.COVER_UPLOADS;
  if (!db || typeof db !== "object" || !bucket || typeof bucket !== "object") {
    return {
      ok: false,
      response: librarianError(
        503,
        "staging_import_bindings_unavailable",
        "Staging D1 або приватне R2-сховище недоступні.",
        false,
      ),
    };
  }

  return {
    ok: true,
    value: {
      user: authorization.value.user,
      db: db as D1DatabaseLike,
      bucket: bucket as ImportBucket,
      allowedOrigin: gate.allowedOrigin,
      pinnedPlanSha256: gate.pinnedPlanSha256,
      gateExpiresAt: gate.expiresAt,
    },
  };
}

export function importJson(body: unknown, init: ResponseInit = {}): Response {
  return librarianJson(body, init);
}

export function importFailure(error: unknown): Response {
  if (error instanceof HostedImportError) {
    return librarianJson({
      success: false,
      code: error.code,
      error: error.message,
      ...(error.details ? { details: error.details } : {}),
    }, { status: error.status });
  }
  return librarianError(
    503,
    "staging_import_unavailable",
    "Операцію staging-import не виконано. Дані production не змінено.",
    false,
  );
}

export function importRunId(planSha256: string): string {
  return `MIG-${planSha256.slice(0, 12)}-${crypto.randomUUID()}`;
}

export function importObjectKey(planSha256: string, runId: string): string {
  return `${PLAN_OBJECT_PREFIX}${planSha256}/${runId}.json`;
}

export async function findImportRun(
  db: D1DatabaseLike,
  planSha256: string,
): Promise<ImportRun | null> {
  const statement = bindStatement(
    db.prepare(`
      SELECT id, plan_sha256, source_bundle_sha256, object_key, status,
             plan_bytes, expected_rows, insert_statements, preflight_json,
             verification_json, created_by_user_id, created_by_email,
             expires_at, created_at, updated_at, committed_at, verified_at,
             cleaned_at, last_error_code
      FROM migration_import_runs
      WHERE plan_sha256 = ?
      LIMIT 1
    `),
    planSha256,
  );
  if (!statement.first) throw new HostedImportError("d1_adapter_invalid", "D1 adapter не підтримує first().", 500);
  return await statement.first<ImportRun>();
}

export async function requireImportRun(
  context: StagingImportContext,
  planSha256: string,
  allowedStatuses: readonly ImportRunStatus[],
  options: { allowExpired?: boolean } = {},
): Promise<ImportRun> {
  assertPinnedPlan(context, planSha256);
  const run = await findImportRun(context.db, planSha256);
  if (!run) throw new HostedImportError("import_run_not_found", "Сесію імпорту не знайдено.", 404);
  if (run.created_by_user_id !== context.user.userId) {
    throw new HostedImportError("import_run_owner_mismatch", "Ця сесія належить іншому користувачеві.", 403);
  }
  if (!isImportRunExpiryAccepted(
    run.expires_at,
    context.gateExpiresAt,
    options.allowExpired === true,
  )) {
    throw new HostedImportError("import_run_expired", "Строк сесії імпорту минув.", 410);
  }
  if (run.object_key !== importObjectKey(run.plan_sha256, run.id)) {
    throw new HostedImportError("import_object_key_invalid", "Службовий R2-ключ сесії не пройшов перевірку.", 409);
  }
  if (!allowedStatuses.includes(run.status)) {
    throw new HostedImportError(
      "import_phase_replay",
      `Операція не дозволена зі статусу ${run.status}.`,
      409,
      { status: run.status },
    );
  }
  return run;
}

export function assertPinnedPlan(context: StagingImportContext, planSha256: string): void {
  if (!/^[a-f0-9]{64}$/u.test(planSha256) || planSha256 !== context.pinnedPlanSha256) {
    throw new HostedImportError("plan_hash_not_pinned", "SHA-256 плану не збігається з дозволеним staging-планом.", 403);
  }
}

export function assertStagingImportStillActive(context: StagingImportContext): void {
  if (!isStagingImportGateActive(context.gateExpiresAt)) {
    throw new HostedImportError(
      "staging_import_gate_expired",
      "Строк staging-import минув до завершення upload; приватний файл не збережено.",
      410,
    );
  }
}

export async function loadStoredImportPlan(
  context: StagingImportContext,
  run: ImportRun,
): Promise<{ plan: HostedImportPlan; bytes: Uint8Array }> {
  const object = await context.bucket.get(run.object_key);
  if (!object) throw new HostedImportError("plan_object_missing", "Приватний файл плану не знайдено.", 404);
  const metadata = object.customMetadata ?? {};
  if (metadata.runId !== run.id
    || metadata.planSha256 !== run.plan_sha256
    || metadata.ownerUserId !== run.created_by_user_id
    || metadata.expiresAt !== run.expires_at) {
    throw new HostedImportError("plan_object_metadata_invalid", "Метадані приватного плану не пройшли перевірку.", 409);
  }
  if (typeof object.size === "number" && object.size > HOSTED_IMPORT_MAX_BYTES) {
    throw new HostedImportError("plan_too_large", "Приватний план перевищує 6 МіБ.", 413);
  }
  const bytes = await readStoredBytes(object, HOSTED_IMPORT_MAX_BYTES);
  if (bytes.byteLength !== run.plan_bytes) {
    throw new HostedImportError("plan_object_size_mismatch", "Розмір приватного плану змінився.", 409);
  }
  const digest = await sha256Hex(bytes);
  if (digest !== run.plan_sha256 || digest !== context.pinnedPlanSha256) {
    throw new HostedImportError("plan_object_hash_mismatch", "SHA-256 приватного плану змінився.", 409);
  }
  return { plan: parseAndValidateHostedImportPlan(bytes), bytes };
}

export async function readPlanShaAction(request: Request): Promise<string> {
  const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new HostedImportError("unsupported_media_type", "Потрібне JSON-тіло запиту.", 415);
  }
  const bytes = await readBoundedRequestBytes(request, {
    limit: ACTION_BODY_LIMIT,
    tooLargeCode: "action_body_too_large",
    tooLargeMessage: "Тіло службового запиту завелике.",
    emptyCode: "action_body_invalid",
    emptyMessage: "Тіло службового запиту порожнє.",
  });
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HostedImportError("action_json_invalid", "Некоректне JSON-тіло службового запиту.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HostedImportError("action_json_invalid", "JSON має бути об’єктом.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.planSha256 !== "string") {
    throw new HostedImportError("action_contract_invalid", "Очікується лише поле planSha256.");
  }
  if (!/^[a-f0-9]{64}$/u.test(record.planSha256)) {
    throw new HostedImportError("action_hash_invalid", "planSha256 має бути SHA-256 у нижньому регістрі.");
  }
  return record.planSha256;
}

export async function executeRun(
  statement: D1StatementLike,
): Promise<number> {
  if (!statement.run) throw new HostedImportError("d1_adapter_invalid", "D1 adapter не підтримує run().", 500);
  const result = await statement.run();
  return Number(result.meta?.changes ?? 0);
}

export function bindStatement(statement: D1StatementLike, ...values: unknown[]): D1StatementLike {
  if (!statement.bind) throw new HostedImportError("d1_adapter_invalid", "D1 adapter не підтримує bind().", 500);
  return statement.bind(...values);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function safeInspectionJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).byteLength > 64 * 1024) {
    throw new HostedImportError("inspection_report_too_large", "Звіт reconciliation завеликий.", 409);
  }
  return text;
}

async function readStoredBytes(object: ImportStoredObject, limit: number): Promise<Uint8Array> {
  const reader = object.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        try { await reader.cancel("stored plan too large"); } catch { /* preserve size failure */ }
        throw new HostedImportError("plan_too_large", "Приватний план перевищує 6 МіБ.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
