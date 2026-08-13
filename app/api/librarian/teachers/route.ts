import {
  authorizeTeacherRegistryRead,
  authorizeTeacherRegistryWrite,
  parseTeacherListQuery,
  readTeacherRegistryBody,
  teacherRegistryJson,
  teacherRegistryStoreError,
} from "@/lib/teacher-registry-api";
import {
  createTeacherRegistryCard,
  getTeacherRegistryDetail,
  listTeacherRegistry,
} from "@/lib/teacher-registry-store";
import { validateTeacherCreateInput } from "@/lib/teacher-registry-validation";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const authorization = await authorizeTeacherRegistryRead();
  if (!authorization.ok) return authorization.response;
  const parsed = parseTeacherListQuery(request);
  if (!parsed.ok) return parsed.response;
  try {
    const result = await listTeacherRegistry(authorization.value.db, parsed.value);
    return teacherRegistryJson({
      schemaVersion: 1,
      success: true,
      ...result,
      summary: result.counters,
      writesEnabled: authorization.value.access.writesEnabled,
    });
  } catch (error) {
    return teacherRegistryStoreError(error, "teacher_registry_unavailable");
  }
}

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeTeacherRegistryWrite(request);
  if (!authorization.ok) return authorization.response;
  const body = await readTeacherRegistryBody(request);
  if (!body.ok) return body.response;
  const validated = validateTeacherCreateInput(body.value);
  if (!validated.ok) {
    return teacherRegistryJson({
      schemaVersion: 1,
      success: false,
      code: "validation_failed",
      error: "Перевірте дані нової картки.",
      fieldErrors: validated.fieldErrors,
      writesEnabled: true,
    }, { status: 400 });
  }
  try {
    const result = await createTeacherRegistryCard(
      authorization.value.db,
      authorization.value.user,
      validated.value,
    );
    const detail = await getTeacherRegistryDetail(authorization.value.db, String(result.teacherId));
    return teacherRegistryJson({
      schemaVersion: 1,
      success: true,
      teacher: detail.teacher,
      writesEnabled: true,
    }, { status: 201 });
  } catch (error) {
    return teacherRegistryStoreError(error, "teacher_create_unavailable");
  }
}
