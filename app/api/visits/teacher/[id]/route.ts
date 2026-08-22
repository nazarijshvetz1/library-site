import { env } from "cloudflare:workers";
import { isSameOriginRequest } from "@/lib/librarian-api";
import { featureGate, readVisitJson, safeResourceId, teacherPortalGate, visitError, visitJson, visitStoreError } from "@/lib/visit-schedule-api";
import { cancelOwnVisitBooking, updateOwnVisitBooking, type VisitD1Database } from "@/lib/visit-schedule-store";
import { requireVisitTeacherSession } from "@/lib/visit-teacher-auth";
import { validateVisitCancelInput } from "@/lib/visit-schedule-validation";
import { validateVisitBookingUpdateInput } from "@/lib/visit-portal-validation";
import { scheduleTelegramOutboxDrain } from "@/lib/telegram-delivery-runtime";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = featureGate(true); if (gate) return gate;
  const portalGate = teacherPortalGate(); if (portalGate) return portalGate;
  if (!isSameOriginRequest(request)) {
    return visitError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.");
  }
  const db = env.DB as unknown as VisitD1Database;
  const { id } = await context.params;
  if (!safeResourceId(id)) return visitError(400, "validation_failed", "Некоректний ідентифікатор бронювання.");
  const body = await readVisitJson(request); if (!body.ok) return body.response;
  const validated = validateVisitBookingUpdateInput(body.value);
  if (!validated.ok) return visitError(400, "validation_failed", "Перевірте дані зміни.", { fieldErrors: validated.fieldErrors });
  try {
    const teacher = await requireVisitTeacherSession(db, request);
    const result = await updateOwnVisitBooking(db, teacher, id, validated.value);
    scheduleTelegramOutboxDrain(db, request.url);
    return visitJson({ schemaVersion: 1, success: true, result });
  } catch (error) {
    return visitStoreError(error, "visit_booking_unavailable");
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = featureGate(true); if (gate) return gate;
  if (!isSameOriginRequest(request)) {
    return visitError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.");
  }
  const db = env.DB as unknown as VisitD1Database;
  const { id } = await context.params;
  if (!safeResourceId(id)) return visitError(400, "validation_failed", "Некоректний ідентифікатор бронювання.");
  const body = await readVisitJson(request); if (!body.ok) return body.response;
  const validated = validateVisitCancelInput(body.value);
  if (!validated.ok) return visitError(400, "validation_failed", "Перевірте підтвердження скасування.", { fieldErrors: validated.fieldErrors });
  try {
    const teacher = await requireVisitTeacherSession(db, request);
    const result = await cancelOwnVisitBooking(db, teacher, id, validated.value);
    scheduleTelegramOutboxDrain(db, request.url);
    return visitJson({ schemaVersion: 1, success: true, result, bookingEnabled: true });
  } catch (error) {
    return visitStoreError(error, "visit_booking_unavailable");
  }
}
