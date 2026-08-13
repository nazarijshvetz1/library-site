import {
  authorizeTeacherRegistryRead,
  authorizeTeacherRegistryWrite,
  readTeacherRegistryBody,
  safeTeacherId,
  teacherRegistryJson,
  teacherRegistryStoreError,
} from "@/lib/teacher-registry-api";
import {
  deleteEmptyTeacherRegistryCard,
  getTeacherRegistryDetail,
  updateTeacherRegistryCard,
} from "@/lib/teacher-registry-store";
import {
  validateTeacherDeleteInput,
  validateTeacherUpdateInput,
} from "@/lib/teacher-registry-validation";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const authorization = await authorizeTeacherRegistryRead();
  if (!authorization.ok) return authorization.response;
  const { id } = await context.params;
  if (!safeTeacherId(id)) return invalidTeacherId(authorization.value.access.writesEnabled);
  try {
    const detail = await getTeacherRegistryDetail(authorization.value.db, id);
    return teacherRegistryJson({
      schemaVersion: 1,
      success: true,
      ...detail,
      writesEnabled: authorization.value.access.writesEnabled,
    });
  } catch (error) {
    return teacherRegistryStoreError(error, "teacher_detail_unavailable");
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const authorization = await authorizeTeacherRegistryWrite(request);
  if (!authorization.ok) return authorization.response;
  const { id } = await context.params;
  if (!safeTeacherId(id)) return invalidTeacherId(true);
  const body = await readTeacherRegistryBody(request);
  if (!body.ok) return body.response;
  const validated = validateTeacherUpdateInput(body.value);
  if (!validated.ok) return validationError("Перевірте зміни картки.", validated.fieldErrors);
  try {
    await updateTeacherRegistryCard(
      authorization.value.db,
      authorization.value.user,
      id,
      validated.value,
    );
    const detail = await getTeacherRegistryDetail(authorization.value.db, id);
    return teacherRegistryJson({
      schemaVersion: 1,
      success: true,
      teacher: detail.teacher,
      writesEnabled: true,
    });
  } catch (error) {
    return teacherRegistryStoreError(error, "teacher_update_unavailable");
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const authorization = await authorizeTeacherRegistryWrite(request);
  if (!authorization.ok) return authorization.response;
  const { id } = await context.params;
  if (!safeTeacherId(id)) return invalidTeacherId(true);
  const body = await readTeacherRegistryBody(request);
  if (!body.ok) return body.response;
  const validated = validateTeacherDeleteInput(body.value);
  if (!validated.ok) return validationError("Підтвердьте видалення порожньої картки.", validated.fieldErrors);
  try {
    const result = await deleteEmptyTeacherRegistryCard(
      authorization.value.db,
      authorization.value.user,
      id,
      validated.value,
    );
    return teacherRegistryJson({
      schemaVersion: 1,
      success: true,
      ...result,
      writesEnabled: true,
    });
  } catch (error) {
    return teacherRegistryStoreError(error, "teacher_delete_unavailable");
  }
}

function invalidTeacherId(writesEnabled: boolean): Response {
  return teacherRegistryJson({
    schemaVersion: 1,
    success: false,
    code: "validation_failed",
    error: "Некоректний номер картки вчителя.",
    writesEnabled,
  }, { status: 400 });
}

function validationError(error: string, fieldErrors: Record<string, string>): Response {
  return teacherRegistryJson({
    schemaVersion: 1,
    success: false,
    code: "validation_failed",
    error,
    fieldErrors,
    writesEnabled: true,
  }, { status: 400 });
}
