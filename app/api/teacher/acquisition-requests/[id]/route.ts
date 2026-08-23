import { env } from "cloudflare:workers";
import { acquisitionError, acquisitionJson, acquisitionStoreError, readAcquisitionJson, safeAcquisitionId } from "@/lib/acquisition-api";
import { cancelTeacherAcquisitionRequest, type AcquisitionDatabase } from "@/lib/acquisition-store";
import { validateAcquisitionCancelInput } from "@/lib/acquisition-validation";
import { requireVisitTeacherSession } from "@/lib/visit-teacher-auth";
import type { VisitD1Database } from "@/lib/visit-schedule-store";
import { teacherPortalGate } from "@/lib/visit-schedule-api";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, context: Context): Promise<Response> {
  const gate = teacherPortalGate(); if (gate) return gate;
  const { id } = await context.params;
  if (!safeAcquisitionId(id)) return acquisitionError(400, "validation_failed", "Некоректний номер заявки.");
  const db = env.DB as unknown as AcquisitionDatabase & VisitD1Database;
  try {
    const teacher = await requireVisitTeacherSession(db, request);
    const body = await readAcquisitionJson(request); if (!body.ok) return body.response;
    const validated = validateAcquisitionCancelInput(body.value);
    if (!validated.ok) return acquisitionError(400, "validation_failed", "Перевірте підтвердження скасування.", { fieldErrors: validated.fieldErrors });
    return acquisitionJson({ schemaVersion: 1, success: true, request: await cancelTeacherAcquisitionRequest(db, teacher, id, validated.value) });
  } catch (error) { return acquisitionStoreError(error, "acquisition_request_cancel_unavailable"); }
}
