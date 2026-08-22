import {
  authorizeVisitTeacherAccessApi,
  resolveVisitLibrarianActor,
  visitJson,
  visitStoreError,
  visitTeacherCodeImportBody,
} from "@/lib/visit-teacher-access-api";
import {
  importVisitTeacherCodes,
  validateVisitTeacherCodeImportInput,
} from "@/lib/visit-teacher-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeVisitTeacherAccessApi(request);
  if (!authorization.ok) return authorization.response;
  const body = await visitTeacherCodeImportBody(request);
  if (!body.ok) return body.response;
  try {
    const input = validateVisitTeacherCodeImportInput(body.value);
    const result = await importVisitTeacherCodes(
      authorization.value.db,
      await resolveVisitLibrarianActor(authorization.value.db, authorization.value.user),
      input,
    );
    return visitJson({
      schemaVersion: 2,
      success: true,
      count: result.count,
      teacherUserIds: result.teacherUserIds,
    });
  } catch (error) {
    return visitStoreError(error, "teacher_code_import_failed");
  }
}
