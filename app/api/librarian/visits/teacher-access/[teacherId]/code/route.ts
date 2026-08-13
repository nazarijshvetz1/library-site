import {
  authorizeVisitTeacherAccessApi, exactBodyKeys, resolveVisitLibrarianActor, safeResourceId, validRequestId, visitError, visitJson,
  visitStoreError, visitTeacherAccessBody,
} from "@/lib/visit-teacher-access-api";
import { issueVisitTeacherCode } from "@/lib/visit-teacher-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ teacherId: string }> }): Promise<Response> {
  const authorization = await authorizeVisitTeacherAccessApi(request);
  if (!authorization.ok) return authorization.response;
  const { teacherId } = await context.params;
  if (!safeResourceId(teacherId)) return visitError(400, "validation_failed", "Некоректний ідентифікатор учителя.");
  const body = await visitTeacherAccessBody(request);
  if (!body.ok) return body.response;
  if (!exactBodyKeys(body.value, ["requestId", "expectedVersion"]) || !validRequestId(body.value.requestId)
    || !Number.isSafeInteger(body.value.expectedVersion) || Number(body.value.expectedVersion) < 0) {
    return visitError(400, "validation_failed", "Перевірте версію доступу.");
  }
  try {
    const actor = await resolveVisitLibrarianActor(authorization.value.db, authorization.value.user);
    const result = await issueVisitTeacherCode(authorization.value.db, actor, teacherId, {
      requestId: body.value.requestId,
      expectedVersion: Number(body.value.expectedVersion),
    });
    return visitJson({ schemaVersion: 2, success: true, ...result });
  } catch (error) {
    return visitStoreError(error, "teacher_access_update_failed");
  }
}
