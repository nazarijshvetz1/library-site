import { resetStagingImportTarget } from "@/lib/d1-import-runtime";
import {
  assertPinnedPlan,
  assertStagingImportStillActive,
  authorizeStagingImport,
  importFailure,
  importJson,
  readStagingResetAction,
} from "@/lib/staging-import-api";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeStagingImport(request);
  if (!authorization.ok) return authorization.response;
  const context = authorization.value;

  // This destructive maintenance endpoint is intentionally absent from the
  // production workflow, even while the one-time production import gate is on.
  if (context.target !== "staging" || context.librarianWritesEnabled) {
    return importJson({
      success: false,
      code: "staging_reset_unavailable",
      error: "Очищення доступне лише в тестовому середовищі з вимкненим робочим записом.",
    }, { status: 404 });
  }

  try {
    const action = await readStagingResetAction(request);
    assertPinnedPlan(context, action.planSha256);
    assertStagingImportStillActive(context);
    const report = await resetStagingImportTarget(context.db);
    return importJson({
      success: true,
      status: "idle",
      planSha256: action.planSha256,
      report,
    });
  } catch (error) {
    return importFailure(error);
  }
}
