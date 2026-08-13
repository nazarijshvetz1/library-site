import { authorizeVisitTeacherAccessApi, visitJson, visitStoreError } from "@/lib/visit-teacher-access-api";
import { listVisitTeacherAccess } from "@/lib/visit-teacher-auth";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const authorization = await authorizeVisitTeacherAccessApi();
  if (!authorization.ok) return authorization.response;
  try {
    const teachers = await listVisitTeacherAccess(authorization.value.db);
    return visitJson({
      schemaVersion: 2,
      success: true,
      writesEnabled: authorization.value.access.writesEnabled,
      teachers,
    });
  } catch (error) {
    return visitStoreError(error, "teacher_access_unavailable");
  }
}
