import { env } from "cloudflare:workers";
import { authorizeLibrarianApi } from "@/lib/librarian-api";
import { acquisitionError, acquisitionJson, acquisitionStoreError, readAcquisitionJson, safeAcquisitionId } from "@/lib/acquisition-api";
import { applyLibrarianAcquisitionAction, type AcquisitionDatabase } from "@/lib/acquisition-store";
import { validateAcquisitionActionInput } from "@/lib/acquisition-validation";
import { scheduleTelegramOutboxDrain } from "@/lib/telegram-delivery-runtime";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context): Promise<Response> {
  const authorization = await authorizeLibrarianApi(); if (!authorization.ok) return authorization.response;
  const { user, access } = authorization.value;
  if (!access.writesEnabled) return acquisitionError(503, "writes_disabled", "Запис тимчасово вимкнено.", { writesEnabled: false });
  const { id } = await context.params;
  if (!safeAcquisitionId(id)) return acquisitionError(400, "validation_failed", "Некоректний номер заявки.", { writesEnabled: true });
  try {
    const body = await readAcquisitionJson(request, { writesEnabled: true }); if (!body.ok) return body.response;
    const validated = validateAcquisitionActionInput(body.value);
    if (!validated.ok) return acquisitionError(400, "validation_failed", "Перевірте дію та кількість.", { fieldErrors: validated.fieldErrors, writesEnabled: true });
    const record = await applyLibrarianAcquisitionAction(env.DB as unknown as AcquisitionDatabase, user, id, validated.value);
    scheduleTelegramOutboxDrain(env.DB as unknown as AcquisitionDatabase, request.url);
    return acquisitionJson({ schemaVersion: 1, success: true, request: record, writesEnabled: true });
  } catch (error) { return acquisitionStoreError(error, "acquisition_request_update_unavailable", true); }
}
