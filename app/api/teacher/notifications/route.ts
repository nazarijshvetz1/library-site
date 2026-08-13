import { env } from "cloudflare:workers";

import {
  materialRequestError,
  materialRequestJson,
  materialRequestStoreError,
  parseBoundedLimit,
} from "@/lib/teacher-material-request-api";
import {
  listTeacherNotifications,
  type TeacherMaterialRequestDatabase,
} from "@/lib/teacher-material-request-store";
import { requireVisitTeacherSession } from "@/lib/visit-teacher-auth";
import type { VisitD1Database } from "@/lib/visit-schedule-store";
import { teacherPortalGate } from "@/lib/visit-schedule-api";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const gate = teacherPortalGate(); if (gate) return gate;
  const db = env.DB as unknown as TeacherMaterialRequestDatabase & VisitD1Database;
  try {
    const teacher = await requireVisitTeacherSession(db, request);
    const url = new URL(request.url);
    const limit = parseBoundedLimit(url.searchParams.get("limit"), 50, 100);
    if (limit === null) {
      return materialRequestError(400, "validation_failed", "Некоректний ліміт.");
    }
    const result = await listTeacherNotifications(db, teacher.teacherUserId, {
      limit,
      cursor: url.searchParams.get("cursor"),
    });
    return materialRequestJson({
      schemaVersion: 1,
      success: true,
      ...result,
      page: result.page,
    });
  } catch (error) {
    return materialRequestStoreError(error, "notifications_unavailable");
  }
}
