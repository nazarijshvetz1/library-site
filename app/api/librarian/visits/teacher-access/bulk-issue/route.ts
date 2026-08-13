import {
  authorizeVisitTeacherAccessApi,
  exactBodyKeys,
  resolveVisitLibrarianActor,
  validRequestId,
  visitError,
  visitJson,
  visitStoreError,
  visitTeacherAccessBody,
} from "@/lib/visit-teacher-access-api";
import { bulkIssueVisitTeacherCodes } from "@/lib/visit-teacher-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeVisitTeacherAccessApi(request);
  if (!authorization.ok) return authorization.response;
  const body = await visitTeacherAccessBody(request);
  if (!body.ok) return body.response;
  if (!exactBodyKeys(body.value, ["requestId", "confirmation"]) || !validRequestId(body.value.requestId)
    || body.value.confirmation !== "ISSUE_MISSING_ONLY") {
    return visitError(400, "validation_failed", "Потрібне точне підтвердження створення відсутніх кодів.");
  }
  try {
    const result = await bulkIssueVisitTeacherCodes(
      authorization.value.db,
      await resolveVisitLibrarianActor(authorization.value.db, authorization.value.user),
      { requestId: body.value.requestId, confirmation: "ISSUE_MISSING_ONLY" },
    );
    const { statementCount: ignored, ...publicResult } = result;
    void ignored;
    return visitJson({ schemaVersion: 2, success: true, ...publicResult });
  } catch (error) {
    return visitStoreError(error, "teacher_access_update_failed");
  }
}
