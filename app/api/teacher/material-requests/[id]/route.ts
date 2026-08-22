import { env } from "cloudflare:workers";

import {
  materialRequestError,
  materialRequestJson,
  materialRequestStoreError,
  readMaterialRequestJson,
  safePortalResourceId,
} from "@/lib/teacher-material-request-api";
import {
  cancelTeacherMaterialRequest,
  type TeacherMaterialRequestDatabase,
} from "@/lib/teacher-material-request-store";
import { validateMaterialRequestCancelInput } from "@/lib/teacher-material-request-validation";
import { requireVisitTeacherSession } from "@/lib/visit-teacher-auth";
import type { VisitD1Database } from "@/lib/visit-schedule-store";
import { teacherPortalGate } from "@/lib/visit-schedule-api";
import { scheduleTelegramOutboxDrain } from "@/lib/telegram-delivery-runtime";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = teacherPortalGate(); if (gate) return gate;
  const db = env.DB as unknown as TeacherMaterialRequestDatabase & VisitD1Database;
  try {
    const teacher = await requireVisitTeacherSession(db, request);
    const { id } = await context.params;
    if (!safePortalResourceId(id)) {
      return materialRequestError(400, "validation_failed", "Некоректний номер заявки.");
    }
    const body = await readMaterialRequestJson(request);
    if (!body.ok) return body.response;
    const validated = validateMaterialRequestCancelInput(body.value);
    if (!validated.ok) {
      return materialRequestError(400, "validation_failed", "Перевірте підтвердження скасування.", {
        fieldErrors: validated.fieldErrors,
      });
    }
    const requestRecord = await cancelTeacherMaterialRequest(db, teacher, id, validated.value);
    scheduleTelegramOutboxDrain(db, request.url);
    return materialRequestJson({ schemaVersion: 1, success: true, request: requestRecord });
  } catch (error) {
    return materialRequestStoreError(error, "material_request_cancel_unavailable");
  }
}
