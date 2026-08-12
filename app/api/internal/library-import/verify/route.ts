import {
  assertVerifiedImportInspection,
  HostedImportError,
  inspectHostedImportPlan,
  totalHostedImportRows,
  verifyHostedImportFts,
} from "@/lib/d1-import-runtime";
import {
  authorizeStagingImport,
  bindStatement,
  executeRun,
  importFailure,
  importJson,
  loadStoredImportPlan,
  nowIso,
  readPlanShaAction,
  requireImportRun,
  safeInspectionJson,
} from "@/lib/staging-import-api";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeStagingImport(request, { allowExpiredGate: true });
  if (!authorization.ok) return authorization.response;
  const context = authorization.value;

  try {
    const planSha256 = await readPlanShaAction(request);
    const run = await requireImportRun(
      context,
      planSha256,
      ["committed", "verified"],
      { allowExpired: true },
    );
    if (run.status === "verified") {
      return importJson({
        success: true,
        resumed: true,
        runId: run.id,
        planSha256,
        status: run.status,
        verifiedAt: run.verified_at,
        report: run.verification_json ? JSON.parse(run.verification_json) : null,
      });
    }
    const { plan } = await loadStoredImportPlan(context, run);
    const inspection = await inspectHostedImportPlan(context.db, plan);
    assertVerifiedImportInspection(inspection, plan);

    const ftsVerification = await verifyHostedImportFts(context.db, plan);
    const materialRows = plan.tables.materials.length;

    const verifiedAt = nowIso();
    const safeReport = {
      ok: true,
      expectedRows: totalHostedImportRows(plan),
      totalNew: inspection.totalNew,
      totalUnchanged: inspection.totalUnchanged,
      totalConflicts: inspection.totalConflicts,
      totalExtraExisting: inspection.totalExtraExisting,
      materialRows,
      ftsContentRows: inspection.ftsContentRows,
      ftsIntegrity: ftsVerification.integrity,
      ftsSampledMaterialIds: ftsVerification.sampledMaterialIds,
      tables: inspection.tables,
    };
    const changes = await executeRun(bindStatement(
      context.db.prepare(`
        UPDATE migration_import_runs
        SET status = 'verified', verification_json = ?, verified_at = ?,
            updated_at = ?, last_error_code = NULL
        WHERE id = ? AND plan_sha256 = ? AND status = 'committed'
      `),
      safeInspectionJson(safeReport),
      verifiedAt,
      verifiedAt,
      run.id,
      planSha256,
    ));
    if (changes !== 1) {
      throw new HostedImportError("import_verify_race", "Стан сесії змінився під час verify.", 409);
    }

    return importJson({
      success: true,
      runId: run.id,
      planSha256,
      status: "verified",
      verifiedAt,
      report: safeReport,
    });
  } catch (error) {
    return importFailure(error);
  }
}
