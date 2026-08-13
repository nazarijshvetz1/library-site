import { env } from "cloudflare:workers";

import { isSameOriginRequest } from "@/lib/librarian-api";
import { enforceGuestMutationRate, requireVisitGuestSession } from "@/lib/visit-guest-auth";
import { cancelGuestVisitBooking, safeVisitResourceId, updateGuestVisitBooking } from "@/lib/visit-guest-store";
import { validateGuestVisitCancelInput, validateVisitBookingUpdateInput } from "@/lib/visit-portal-validation";
import { guestFeatureGate, readVisitJson, visitError, visitJson, visitStoreError } from "@/lib/visit-schedule-api";
import type { VisitD1Database } from "@/lib/visit-schedule-store";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context): Promise<Response> {
  return mutate(request, context, "update");
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  return mutate(request, context, "cancel");
}

async function mutate(request: Request, context: Context, kind: "update" | "cancel"): Promise<Response> {
  const gate = guestFeatureGate(true); if (gate) return gate;
  if (!isSameOriginRequest(request)) return visitError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.");
  const { id } = await context.params;
  if (!safeVisitResourceId(id)) return visitError(400, "validation_failed", "Некоректний ідентифікатор бронювання.");
  const body = await readVisitJson(request); if (!body.ok) return body.response;
  const validated = kind === "update"
    ? validateVisitBookingUpdateInput(body.value)
    : validateGuestVisitCancelInput(body.value);
  if (!validated.ok) return visitError(400, "validation_failed", "Перевірте дані зміни.", { fieldErrors: validated.fieldErrors });
  const db = env.DB as unknown as VisitD1Database;
  try {
    const guest = await requireVisitGuestSession(db, request);
    await enforceGuestMutationRate(db, request, guest);
    const result = kind === "update"
      ? await updateGuestVisitBooking(db, guest, id, validated.value as ReturnType<typeof validateVisitBookingUpdateInput> extends { value: infer T } ? T : never)
      : await cancelGuestVisitBooking(db, guest, id, validated.value as ReturnType<typeof validateGuestVisitCancelInput> extends { value: infer T } ? T : never);
    return visitJson({ schemaVersion: 1, success: true, result });
  } catch (error) { return visitStoreError(error, "visit_booking_unavailable"); }
}
