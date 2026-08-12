import { env } from "cloudflare:workers";
import { authorizeLibrarianApi, librarianError } from "@/lib/librarian-api";
import { featureGate, visitBookingEnabled, visitJson, visitStoreError } from "@/lib/visit-schedule-api";
import { readVisitSchedule, type VisitD1Database } from "@/lib/visit-schedule-store";
import { kyivToday, parseAdminVisitRange, VisitValidationError } from "@/lib/visit-schedule-validation";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi(); if (!authorization.ok) return authorization.response;
  const gate = featureGate(); if (gate) return gate;
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "all";
  const limit = Number(url.searchParams.get("limit") ?? 100);
  if (!(["active", "cancelled", "all"] as string[]).includes(status) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return librarianError(400, "validation_failed", "Некоректний статус або ліміт.", authorization.value.access.writesEnabled);
  }
  try {
    const range = parseAdminVisitRange(url, kyivToday(), 30);
    const schedule = await readVisitSchedule(env.DB as unknown as VisitD1Database, range, {
      includePrivateBookings: true, includeClasses: true,
      status: status as "active" | "cancelled" | "all", limit,
    });
    return visitJson({ schemaVersion: 1, success: true, ...schedule,
      writesEnabled: authorization.value.access.writesEnabled,
      scheduleEnabled: true, bookingEnabled: visitBookingEnabled() });
  } catch (error) {
    if (error instanceof VisitValidationError) return librarianError(400, error.code, error.message, authorization.value.access.writesEnabled);
    return visitStoreError(error, "visit_schedule_unavailable");
  }
}
