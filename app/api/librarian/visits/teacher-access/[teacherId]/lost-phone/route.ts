import {
  authorizeVisitTeacherAccessApi,
  exactBodyKeys,
  resolveVisitLibrarianActor,
  safeResourceId,
  validRequestId,
  visitError,
  visitJson,
  visitStoreError,
  visitTeacherAccessBody,
} from "@/lib/visit-teacher-access-api";
import { protectLostVisitTeacherPhone } from "@/lib/visit-teacher-auth";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ teacherId: string }> },
): Promise<Response> {
  const authorization = await authorizeVisitTeacherAccessApi(request);
  if (!authorization.ok) return authorization.response;
  const { teacherId } = await context.params;
  if (!safeResourceId(teacherId)) {
    return visitError(400, "validation_failed", "Некоректний ідентифікатор учителя.");
  }
  const body = await visitTeacherAccessBody(request);
  if (!body.ok) return body.response;
  if (!exactBodyKeys(body.value, ["requestId", "expectedCredentialVersion", "expectedTelegramVersion"])
    || !validRequestId(body.value.requestId)
    || !Number.isSafeInteger(body.value.expectedCredentialVersion)
    || Number(body.value.expectedCredentialVersion) < 1
    || !Number.isSafeInteger(body.value.expectedTelegramVersion)
    || Number(body.value.expectedTelegramVersion) < 1) {
    return visitError(400, "validation_failed", "Перевірте версії доступу й Telegram.");
  }
  try {
    const actor = await resolveVisitLibrarianActor(authorization.value.db, authorization.value.user);
    const result = await protectLostVisitTeacherPhone(
      authorization.value.db,
      actor,
      teacherId,
      {
        requestId: body.value.requestId,
        expectedCredentialVersion: Number(body.value.expectedCredentialVersion),
        expectedTelegramVersion: Number(body.value.expectedTelegramVersion),
      },
    );
    return visitJson({ schemaVersion: 1, success: true, ...result });
  } catch (error) {
    return visitStoreError(error, "teacher_lost_phone_protection_failed");
  }
}
