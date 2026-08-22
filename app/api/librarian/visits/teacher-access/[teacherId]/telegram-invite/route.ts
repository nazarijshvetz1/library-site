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
import {
  createTelegramTeacherActivationInvite,
  revokeTelegramTeacherActivationInvite,
} from "@/lib/telegram-notifications";

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
  if (!exactBodyKeys(body.value, ["requestId", "expectedCredentialVersion"])
    || !validRequestId(body.value.requestId)
    || !Number.isSafeInteger(body.value.expectedCredentialVersion)
    || Number(body.value.expectedCredentialVersion) < 1) {
    return visitError(400, "validation_failed", "Перевірте версію доступу.");
  }
  try {
    const actor = await resolveVisitLibrarianActor(authorization.value.db, authorization.value.user);
    const invite = await createTelegramTeacherActivationInvite(
      authorization.value.db,
      actor,
      teacherId,
      {
        requestId: body.value.requestId,
        expectedCredentialVersion: Number(body.value.expectedCredentialVersion),
      },
    );
    return visitJson({ schemaVersion: 1, success: true, ...invite });
  } catch (error) {
    return visitStoreError(error, "telegram_teacher_invite_failed");
  }
}

export async function DELETE(
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
  if (!exactBodyKeys(body.value, ["requestId", "inviteId"])
    || !validRequestId(body.value.requestId)
    || typeof body.value.inviteId !== "string"
    || !/^TGA-[0-9a-f-]{36}$/iu.test(body.value.inviteId)) {
    return visitError(400, "validation_failed", "Перевірте запрошення.");
  }
  try {
    const actor = await resolveVisitLibrarianActor(authorization.value.db, authorization.value.user);
    const result = await revokeTelegramTeacherActivationInvite(
      authorization.value.db,
      actor,
      teacherId,
      { requestId: body.value.requestId, inviteId: body.value.inviteId },
    );
    return visitJson({ schemaVersion: 1, success: true, ...result });
  } catch (error) {
    return visitStoreError(error, "telegram_teacher_invite_revoke_failed");
  }
}
