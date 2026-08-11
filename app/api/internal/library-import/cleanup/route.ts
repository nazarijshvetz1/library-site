import { HostedImportError } from "@/lib/d1-import-runtime";
import {
  authorizeStagingImport,
  bindStatement,
  executeRun,
  importFailure,
  importJson,
  nowIso,
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
      ["uploaded", "preflighted", "verified", "cleaned"],
      { allowExpired: true },
    );
    const alreadyClaimed = run.status === "cleaned";
    const abandoned = alreadyClaimed
      ? run.last_error_code === "expired_abandoned"
      : run.status === "uploaded" || run.status === "preflighted";
    if (abandoned && Date.parse(run.expires_at) > Date.now()) {
      throw new HostedImportError(
        "import_cleanup_requires_verify",
        "Активну сесію можна очистити лише після verify; до завершення строку abort заборонено.",
        409,
      );
    }
    const cleanedAt = run.cleaned_at ?? nowIso();
    if (!alreadyClaimed) {
      try {
        const changes = await executeRun(bindStatement(
          context.db.prepare(`
            UPDATE migration_import_runs
            SET status = CASE WHEN status = ? THEN 'cleaned' ELSE '__guard_failed__' END,
                cleaned_at = ?, updated_at = ?, last_error_code = ?
            WHERE id = ? AND plan_sha256 = ?
          `),
          run.status,
          cleanedAt,
          cleanedAt,
          abandoned ? "expired_abandoned" : null,
          run.id,
          planSha256,
        ));
        if (changes !== 1) throw new Error("cleanup claim changed no row");
      } catch {
        throw new HostedImportError(
          "import_cleanup_race",
          "Стан сесії змінився до cleanup; R2-файл не видалено.",
          409,
        );
      }
    }

    const object = await context.bucket.head(run.object_key);
    if (object) {
      const metadata = object.customMetadata ?? {};
      if (metadata.runId !== run.id
        || metadata.planSha256 !== run.plan_sha256
        || metadata.ownerUserId !== run.created_by_user_id
        || metadata.expiresAt !== run.expires_at) {
        throw new HostedImportError(
          "plan_object_metadata_invalid",
          "Приватний файл не видалено: його метадані не належать цій сесії.",
          409,
        );
      }
      await context.bucket.delete(run.object_key);
    }

    return importJson({
      success: true,
      resumed: alreadyClaimed,
      runId: run.id,
      planSha256,
      status: "cleaned",
      abandoned,
      objectDeleted: Boolean(object),
      cleanedAt,
    });
  } catch (error) {
    return importFailure(error);
  }
}
