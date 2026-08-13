import { env } from "cloudflare:workers";

import { isSameOriginRequest } from "@/lib/librarian-api";
import { enforceGuestMutationRate, requireVisitGuestSession } from "@/lib/visit-guest-auth";
import { createGuestVisitBooking, listOwnGuestVisits } from "@/lib/visit-guest-store";
import { validateGuestVisitCreateInput } from "@/lib/visit-portal-validation";
import { guestFeatureGate, readVisitJson, visitError, visitJson, visitStoreError } from "@/lib/visit-schedule-api";
import { readVisitSchedule, type VisitD1Database } from "@/lib/visit-schedule-store";
import { kyivToday, parseVisitRange, VisitValidationError } from "@/lib/visit-schedule-validation";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const gate = guestFeatureGate(); if (gate) return gate;
  const db = env.DB as unknown as VisitD1Database;
  try {
    const guest = await requireVisitGuestSession(db, request);
    const range = parseVisitRange(new URL(request.url), kyivToday(), 90);
    const [schedule, bookings] = await Promise.all([
      readVisitSchedule(db, range, { includeClasses: true }),
      listOwnGuestVisits(db, guest, range),
    ]);
    const { classYears = [], ...publicSchedule } = schedule;
    return visitJson({ schemaVersion: 1, success: true, ...publicSchedule, classYears, bookings });
  } catch (error) {
    if (error instanceof VisitValidationError) return visitError(400, error.code, error.message);
    return visitStoreError(error, "visit_schedule_unavailable");
  }
}

export async function POST(request: Request): Promise<Response> {
  const gate = guestFeatureGate(true); if (gate) return gate;
  if (!isSameOriginRequest(request)) return visitError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.");
  const body = await readVisitJson(request); if (!body.ok) return body.response;
  const validated = validateGuestVisitCreateInput(body.value);
  if (!validated.ok) return visitError(400, "validation_failed", "Перевірте дані бронювання.", { fieldErrors: validated.fieldErrors });
  const db = env.DB as unknown as VisitD1Database;
  try {
    const guest = await requireVisitGuestSession(db, request);
    await enforceGuestMutationRate(db, request, guest);
    const result = await createGuestVisitBooking(db, guest, validated.value);
    return visitJson({ schemaVersion: 1, success: true, result }, { status: 201 });
  } catch (error) { return visitStoreError(error, "visit_booking_unavailable"); }
}
