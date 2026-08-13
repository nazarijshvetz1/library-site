import {
  authorizeVisitTeacherAccessApi, exactBodyKeys, resolveVisitLibrarianActor, safeResourceId, validRequestId, visitError, visitJson,
  visitStoreError, visitTeacherAccessBody,
} from "@/lib/visit-teacher-access-api";
import { updateVisitTeacherAccess } from "@/lib/visit-teacher-auth";

export const dynamic = "force-dynamic";
const ACTIONS = new Set(["enable", "disable", "unlock", "revoke_sessions"]);

export async function PATCH(request: Request, context: { params: Promise<{ teacherId: string }> }): Promise<Response> {
  const authorization = await authorizeVisitTeacherAccessApi(request);
  if (!authorization.ok) return authorization.response;
  const { teacherId } = await context.params;
  if (!safeResourceId(teacherId)) return visitError(400, "validation_failed", "Некоректний ідентифікатор учителя.");
  const body = await visitTeacherAccessBody(request);
  if (!body.ok) return body.response;
  if (!exactBodyKeys(body.value, ["requestId", "expectedVersion", "action"]) || !validRequestId(body.value.requestId)
    || !Number.isSafeInteger(body.value.expectedVersion) || Number(body.value.expectedVersion) < 1
    || typeof body.value.action !== "string" || !ACTIONS.has(body.value.action)) {
    return visitError(400, "validation_failed", "Перевірте дію та версію доступу.");
  }
  try {
    const result = await updateVisitTeacherAccess(
      authorization.value.db,
      await resolveVisitLibrarianActor(authorization.value.db, authorization.value.user),
      teacherId,
      {
        requestId: body.value.requestId,
        expectedVersion: Number(body.value.expectedVersion),
        action: body.value.action as "enable" | "disable" | "unlock" | "revoke_sessions",
      },
    );
    return visitJson({ schemaVersion: 2, success: true, ...result });
  } catch (error) {
    return visitStoreError(error, "teacher_access_update_failed");
  }
}
