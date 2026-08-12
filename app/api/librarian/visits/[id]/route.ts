import { env } from "cloudflare:workers";
import { authorizeLibrarianApi, librarianError } from "@/lib/librarian-api";
import { featureGate, readVisitJson, safeResourceId, visitError, visitJson, visitStoreError } from "@/lib/visit-schedule-api";
import { cancelAdminVisitBooking, type VisitD1Database } from "@/lib/visit-schedule-store";
import { validateVisitCancelInput } from "@/lib/visit-schedule-validation";

export const dynamic = "force-dynamic";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const authorization = await authorizeLibrarianApi(); if (!authorization.ok) return authorization.response;
  if (!authorization.value.access.writesEnabled) return librarianError(503, "writes_disabled", "Запис тимчасово вимкнено.", false);
  const gate = featureGate(true); if (gate) return gate;
  const { id } = await context.params;
  if (!safeResourceId(id)) return visitError(400, "validation_failed", "Некоректний ідентифікатор бронювання.");
  const body = await readVisitJson(request); if (!body.ok) return body.response;
  const validated = validateVisitCancelInput(body.value, true);
  if (!validated.ok) return visitError(400, "validation_failed", "Перевірте підтвердження скасування.", { fieldErrors: validated.fieldErrors });
  try {
    const result = await cancelAdminVisitBooking(env.DB as unknown as VisitD1Database, authorization.value.user, id, validated.value);
    return visitJson({ schemaVersion: 1, success: true, result, writesEnabled: true });
  } catch (error) {
    return visitStoreError(error, "visit_booking_unavailable");
  }
}
