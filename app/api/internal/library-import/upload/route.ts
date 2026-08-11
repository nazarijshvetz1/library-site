import {
  parseAndValidateHostedImportPlan,
  readBoundedJsonBytes,
  settleHostedImportUploadReplay,
  sha256Hex,
} from "@/lib/d1-import-runtime";
import {
  assertPinnedPlan,
  assertStagingImportStillActive,
  authorizeStagingImport,
  bindStatement,
  executeRun,
  findImportRun,
  importFailure,
  importJson,
  importObjectKey,
  importRunId,
  nowIso,
} from "@/lib/staging-import-api";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeStagingImport(request);
  if (!authorization.ok) return authorization.response;
  const context = authorization.value;

  let objectKey: string | null = null;
  let objectStored = false;
  let acceptedPlanSha256 = "";
  try {
    const requestedHash = request.headers.get("X-Library-Plan-SHA256")?.trim().toLowerCase() ?? "";
    assertPinnedPlan(context, requestedHash);
    const bytes = await readBoundedJsonBytes(request);
    const planSha256 = await sha256Hex(bytes);
    acceptedPlanSha256 = planSha256;
    assertPinnedPlan(context, planSha256);
    if (planSha256 !== requestedHash) {
      return importJson({
        success: false,
        code: "plan_request_hash_mismatch",
        error: "SHA-256 отриманого файла не збігається із заголовком запиту.",
      }, { status: 409 });
    }
    const plan = parseAndValidateHostedImportPlan(bytes);
    assertStagingImportStillActive(context);
    const existing = await findImportRun(context.db, planSha256);
    if (existing) {
      if (existing.created_by_user_id !== context.user.userId) {
        return importJson({
          success: false,
          code: "import_run_owner_mismatch",
          error: "Ця сесія належить іншому користувачеві.",
        }, { status: 403 });
      }
      if (existing.source_bundle_sha256 !== plan.source_bundle_sha256
        || existing.plan_bytes !== bytes.byteLength
        || existing.object_key !== importObjectKey(existing.plan_sha256, existing.id)
        || existing.expires_at !== context.gateExpiresAt) {
        return importJson({
          success: false,
          code: "import_upload_replay_mismatch",
          error: "Наявна сесія не збігається з повторно надісланим планом.",
        }, { status: 409 });
      }
      const latest = await settleHostedImportUploadReplay({
        run: existing,
        bytes,
        expectedObjectKey: importObjectKey(existing.plan_sha256, existing.id),
        ownerUserId: context.user.userId,
        head: (key) => context.bucket.head(key),
        put: (key, value, options) => context.bucket.put(key, value, options),
        delete: (key) => context.bucket.delete(key),
        reload: () => findImportRun(context.db, planSha256),
        assertWritable: () => assertStagingImportStillActive(context),
      });
      return importJson({
        success: true,
        resumed: true,
        runId: latest.id,
        planSha256,
        status: latest.status,
        planBytes: latest.plan_bytes,
        expiresAt: latest.expires_at,
      });
    }

    const runId = importRunId(planSha256);
    objectKey = importObjectKey(planSha256, runId);
    const createdAt = nowIso();
    assertStagingImportStillActive(context);
    await context.bucket.put(
      objectKey,
      bytes.slice().buffer,
      {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
        customMetadata: {
          runId,
          planSha256,
          ownerUserId: context.user.userId,
          expiresAt: context.gateExpiresAt,
        },
      },
    );
    objectStored = true;
    assertStagingImportStillActive(context);

    const changes = await executeRun(bindStatement(
      context.db.prepare(`
        INSERT INTO migration_import_runs (
          id, plan_sha256, source_bundle_sha256, object_key, status,
          plan_bytes, expected_rows, insert_statements, preflight_json,
          verification_json, created_by_user_id, created_by_email,
          expires_at, created_at, updated_at, committed_at, verified_at,
          cleaned_at, last_error_code
        ) VALUES (?, ?, ?, ?, 'uploaded', ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
      `),
      runId,
      planSha256,
      plan.source_bundle_sha256,
      objectKey,
      bytes.byteLength,
      context.user.userId,
      context.user.email,
      context.gateExpiresAt,
      createdAt,
      createdAt,
    ));
    if (changes !== 1) throw new Error("import run was not inserted");

    return importJson({
      success: true,
      runId,
      planSha256,
      status: "uploaded",
      planBytes: bytes.byteLength,
      expiresAt: context.gateExpiresAt,
    }, { status: 201 });
  } catch (error) {
    if (objectStored && objectKey) {
      let checked = false;
      try {
        const persisted = acceptedPlanSha256
          ? await findImportRun(context.db, acceptedPlanSha256)
          : null;
        checked = true;
        if (persisted?.object_key === objectKey && persisted.created_by_user_id === context.user.userId) {
          return importJson({
            success: true,
            resumed: true,
            runId: persisted.id,
            planSha256: persisted.plan_sha256,
            status: persisted.status,
            planBytes: persisted.plan_bytes,
            expiresAt: persisted.expires_at,
          });
        }
      } catch {
        // Ambiguous D1 result: keep the uniquely named private object. Deleting
        // it could destroy the plan referenced by a committed run.
      }
      if (checked) {
        try { await context.bucket.delete(objectKey); } catch { /* never mask the authoritative error */ }
      }
    }
    return importFailure(error);
  }
}
