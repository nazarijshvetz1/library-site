import {
  bindHostedImportCommitGuard,
  buildHostedImportInsertSql,
  HostedImportError,
  totalHostedImportRows,
} from "@/lib/d1-import-runtime";
import {
  authorizeStagingImport,
  bindStatement,
  importFailure,
  importJson,
  loadStoredImportPlan,
  nowIso,
  readPlanShaAction,
  requireImportRun,
} from "@/lib/staging-import-api";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeStagingImport(request);
  if (!authorization.ok) return authorization.response;
  const context = authorization.value;

  try {
    const planSha256 = await readPlanShaAction(request);
    const run = await requireImportRun(context, planSha256, ["preflighted", "committed"]);
    if (run.status === "committed") {
      return importJson({
        success: true,
        resumed: true,
        runId: run.id,
        planSha256,
        status: run.status,
        appliedRows: run.expected_rows,
        insertStatements: run.insert_statements,
        committedAt: run.committed_at,
      });
    }
    const { plan } = await loadStoredImportPlan(context, run);
    const insertSql = buildHostedImportInsertSql(plan);
    const expectedRows = totalHostedImportRows(plan);
    if (run.source_bundle_sha256 !== plan.source_bundle_sha256
      || run.expected_rows !== expectedRows
      || run.insert_statements !== insertSql.length) {
      throw new HostedImportError(
        "import_preflight_proof_mismatch",
        "План більше не збігається з результатом preflight.",
        409,
      );
    }

    const committedAt = nowIso();
    const stateStatement = bindStatement(
      context.db.prepare(`
        UPDATE migration_import_runs
        SET status = CASE
              WHEN status = 'preflighted'
                AND plan_sha256 = ?
                AND expected_rows = ?
                AND insert_statements = ?
                AND expires_at = ?
              THEN 'committed'
              ELSE '__guard_failed__'
            END,
            committed_at = ?, updated_at = ?, last_error_code = NULL
        WHERE id = ?
      `),
      planSha256,
      expectedRows,
      insertSql.length,
      context.gateExpiresAt,
      committedAt,
      committedAt,
      run.id,
    );
    const statements = [
      stateStatement,
      bindHostedImportCommitGuard(context.db, {
        runId: run.id,
        planSha256,
        expectedRows,
        insertStatements: insertSql.length,
        expiresAt: context.gateExpiresAt,
        committedAt,
      }),
      ...insertSql.map((sql) => context.db.prepare(sql)),
      context.db.prepare("INSERT INTO materials_fts(materials_fts) VALUES('rebuild')"),
    ];
    let results: Array<{ meta?: { changes?: number } }>;
    try {
      results = await context.db.batch(statements);
    } catch {
      throw new HostedImportError(
        "import_atomic_batch_failed",
        "Атомарний D1 batch не виконано; частковий імпорт не збережено.",
        409,
      );
    }
    const stateChanges = Number(results[0]?.meta?.changes ?? 0);
    if (stateChanges !== 1) {
      throw new HostedImportError(
        "import_commit_race",
        "Стан сесії змінився під час commit.",
        409,
      );
    }

    return importJson({
      success: true,
      runId: run.id,
      planSha256,
      status: "committed",
      appliedRows: expectedRows,
      insertStatements: insertSql.length,
      batchStatements: statements.length,
      committedAt,
    });
  } catch (error) {
    return importFailure(error);
  }
}
