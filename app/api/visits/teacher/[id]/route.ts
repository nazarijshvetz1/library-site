import { env } from "cloudflare:workers";
import { authorizeTeacher, featureGate, readVisitJson, safeResourceId, visitError, visitJson, visitStoreError } from "@/lib/visit-schedule-api";
import { cancelOwnVisitBooking, type VisitD1Database } from "@/lib/visit-schedule-store";
import { validateVisitCancelInput } from "@/lib/visit-schedule-validation";

export const dynamic = "force-dynamic";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = featureGate(true); if (gate) return gate;
  const db = env.DB as unknown as VisitD1Database;
  const authorization = await authorizeTeacher(db); if (!authorization.ok) return authorization.response;
  const { id } = await context.params;
  if (!safeResourceId(id)) return visitError(400, "validation_failed", "Некоректний ідентифікатор бронювання.");
  const body = await readVisitJson(request); if (!body.ok) return body.response;
  const validated = validateVisitCancelInput(body.value);
  if (!validated.ok) return visitError(400, "validation_failed", "Перевірте підтвердження скасування.", { fieldErrors: validated.fieldErrors });
  try {
    const result = await cancelOwnVisitBooking(db, authorization.user, id, validated.value, authorization.accessMode);
    return visitJson({ schemaVersion: 1, success: true, result, bookingEnabled: true });
  } catch (error) {
    return visitStoreError(error, "visit_booking_unavailable");
  }
}
