import {
  assertFreshImportInspection,
  buildHostedImportInsertSql,
  inspectHostedImportPlan,
  totalHostedImportRows,
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
  const authorization = await authorizeStagingImport(request);
  if (!authorization.ok) return authorization.response;
  const context = authorization.value;

  try {
    const planSha256 = await readPlanShaAction(request);
    const run = await requireImportRun(context, planSha256, ["uploaded", "preflighted"]);
    if (run.status === "preflighted") {
      return importJson({
        success: true,
        resumed: true,
        runId: run.id,
        planSha256,
        status: run.status,
        report: run.preflight_json ? JSON.parse(run.preflight_json) : null,
      });
    }
    const { plan } = await loadStoredImportPlan(context, run);
    const inspection = await inspectHostedImportPlan(context.db, plan);
    assertFreshImportInspection(inspection, plan);
    const insertStatements = buildHostedImportInsertSql(plan);
    const expectedRows = totalHostedImportRows(plan);
    const safeReport = {
      ok: true,
      expectedRows,
      insertStatements: insertStatements.length,
      tables: inspection.tables,
      totalNew: inspection.totalNew,
      totalUnchanged: inspection.totalUnchanged,
      totalConflicts: inspection.totalConflicts,
      totalExtraExisting: inspection.totalExtraExisting,
      ftsContentRows: inspection.ftsContentRows,
    };
    const updatedAt = nowIso();
    const changes = await executeRun(bindStatement(
      context.db.prepare(`
        UPDATE migration_import_runs
        SET status = 'preflighted', expected_rows = ?, insert_statements = ?,
            preflight_json = ?, updated_at = ?, last_error_code = NULL
        WHERE id = ? AND plan_sha256 = ? AND status = 'uploaded'
      `),
      expectedRows,
      insertStatements.length,
      safeInspectionJson(safeReport),
      updatedAt,
      run.id,
      planSha256,
    ));
    if (changes !== 1) {
      return importJson({
        success: false,
        code: "import_preflight_race",
        error: "Стан сесії змінився під час preflight. Повторний commit не запускався.",
      }, { status: 409 });
    }

    return importJson({
      success: true,
      runId: run.id,
      planSha256,
      status: "preflighted",
      report: safeReport,
    });
  } catch (error) {
    return importFailure(error);
  }
}
