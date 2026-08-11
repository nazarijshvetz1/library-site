import {
  authorizeStagingImport,
  importFailure,
  importJson,
  readPlanShaAction,
  requireImportRun,
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
      ["uploaded", "preflighted", "committed", "verified", "cleaned"],
      { allowExpired: true },
    );
    return importJson({
      success: true,
      resumed: true,
      runId: run.id,
      planSha256,
      status: run.status,
      planBytes: run.plan_bytes,
      expectedRows: run.expected_rows,
      insertStatements: run.insert_statements,
      expiresAt: run.expires_at,
      preflight: parseReport(run.preflight_json),
      verification: parseReport(run.verification_json),
    });
  } catch (error) {
    return importFailure(error);
  }
}

function parseReport(value: string | null): unknown {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}
