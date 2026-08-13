import { env } from "cloudflare:workers";
import { isSameOriginRequest } from "@/lib/librarian-api";
import { featureGate, readVisitJson, visitBookingEnabled, visitError, visitJson, visitStoreError } from "@/lib/visit-schedule-api";
import { createVisitBooking, readVisitSchedule, type VisitD1Database } from "@/lib/visit-schedule-store";
import { requireVisitTeacherSession } from "@/lib/visit-teacher-auth";
import { kyivLocalNow, parseVisitRange, validateVisitBookingCreateInput, VisitValidationError } from "@/lib/visit-schedule-validation";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const gate = featureGate(); if (gate) return gate;
  const db = env.DB as unknown as VisitD1Database;
  try {
    const teacher = await requireVisitTeacherSession(db, request);
    const now = kyivLocalNow();
    const range = parseVisitRange(new URL(request.url), now.date, 90);
    const schedule = await readVisitSchedule(db, range, {
      ownerUserId: teacher.teacherUserId, includeClasses: true, status: "active", futureOnly: now,
    });
    return visitJson({ schemaVersion: 1, success: true, ...schedule, bookingEnabled: visitBookingEnabled() });
  } catch (error) {
    if (error instanceof VisitValidationError) return visitError(400, error.code, error.message);
    return visitStoreError(error, "visit_schedule_unavailable");
  }
}

export async function POST(request: Request): Promise<Response> {
  const gate = featureGate(true); if (gate) return gate;
  if (!isSameOriginRequest(request)) {
    return visitError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.");
  }
  const db = env.DB as unknown as VisitD1Database;
  const body = await readVisitJson(request); if (!body.ok) return body.response;
  const validated = validateVisitBookingCreateInput(body.value);
  if (!validated.ok) return visitError(400, "validation_failed", "Перевірте дані бронювання.", { fieldErrors: validated.fieldErrors });
  try {
    const teacher = await requireVisitTeacherSession(db, request);
    const result = await createVisitBooking(db, teacher, validated.value);
    return visitJson({ schemaVersion: 1, success: true, result, bookingEnabled: true }, { status: 201 });
  } catch (error) {
    return visitStoreError(error, "visit_booking_unavailable");
  }
}
