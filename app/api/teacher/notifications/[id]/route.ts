import { env } from "cloudflare:workers";

import {
  materialRequestError,
  materialRequestJson,
  materialRequestStoreError,
  readMaterialRequestJson,
  safePortalResourceId,
} from "@/lib/teacher-material-request-api";
import {
  deleteTeacherNotification,
  markTeacherNotificationRead,
  type TeacherMaterialRequestDatabase,
} from "@/lib/teacher-material-request-store";
import {
  validateNotificationDeleteInput,
  validateNotificationReadInput,
} from "@/lib/teacher-material-request-validation";
import { requireVisitTeacherSession } from "@/lib/visit-teacher-auth";
import type { VisitD1Database } from "@/lib/visit-schedule-store";
import { teacherPortalGate } from "@/lib/visit-schedule-api";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = teacherPortalGate(); if (gate) return gate;
  const db = env.DB as unknown as TeacherMaterialRequestDatabase & VisitD1Database;
  try {
    const teacher = await requireVisitTeacherSession(db, request);
    const { id } = await context.params;
    if (!safePortalResourceId(id)) {
      return materialRequestError(400, "validation_failed", "Некоректний номер сповіщення.");
    }
    const body = await readMaterialRequestJson(request);
    if (!body.ok) return body.response;
    const validated = validateNotificationReadInput(body.value);
    if (!validated.ok) {
      return materialRequestError(400, "validation_failed", "Перевірте підтвердження прочитання.", {
        fieldErrors: validated.fieldErrors,
      });
    }
    const notification = await markTeacherNotificationRead(db, teacher, id, validated.value);
    return materialRequestJson({ schemaVersion: 1, success: true, notification });
  } catch (error) {
    return materialRequestStoreError(error, "notification_update_unavailable");
  }
}

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
      return materialRequestError(400, "validation_failed", "Некоректний номер сповіщення.");
    }
    const body = await readMaterialRequestJson(request);
    if (!body.ok) return body.response;
    const validated = validateNotificationDeleteInput(body.value);
    if (!validated.ok) {
      return materialRequestError(400, "validation_failed", "Перевірте підтвердження видалення.", {
        fieldErrors: validated.fieldErrors,
      });
    }
    const notification = await deleteTeacherNotification(db, teacher, id, validated.value);
    return materialRequestJson({ schemaVersion: 1, success: true, notification });
  } catch (error) {
    return materialRequestStoreError(error, "notification_delete_unavailable");
  }
}
