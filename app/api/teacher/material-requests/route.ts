import { env } from "cloudflare:workers";

import {
  materialRequestError,
  materialRequestJson,
  materialRequestStoreError,
  parseBoundedLimit,
  readMaterialRequestJson,
} from "@/lib/teacher-material-request-api";
import {
  createTeacherMaterialRequest,
  listTeacherMaterialRequestPage,
  type MaterialRequestStatus,
  type TeacherMaterialRequestDatabase,
} from "@/lib/teacher-material-request-store";
import { validateMaterialRequestCreateInput } from "@/lib/teacher-material-request-validation";
import { requireVisitTeacherSession } from "@/lib/visit-teacher-auth";
import type { VisitD1Database } from "@/lib/visit-schedule-store";
import { teacherPortalGate } from "@/lib/visit-schedule-api";

export const dynamic = "force-dynamic";

const STATUSES = new Set<MaterialRequestStatus | "all">([
  "all",
  "submitted",
  "in_review",
  "ready",
  "partially_ready",
  "completed",
  "rejected",
  "cancelled",
]);

export async function GET(request: Request): Promise<Response> {
  const gate = teacherPortalGate(); if (gate) return gate;
  const db = env.DB as unknown as TeacherMaterialRequestDatabase & VisitD1Database;
  try {
    const teacher = await requireVisitTeacherSession(db, request);
    const url = new URL(request.url);
    const status = (url.searchParams.get("status") ?? "all") as MaterialRequestStatus | "all";
    const limit = parseBoundedLimit(url.searchParams.get("limit"), 50, 100);
    const cursor = url.searchParams.get("cursor");
    if (!STATUSES.has(status) || limit === null) {
      return materialRequestError(400, "validation_failed", "Некоректний статус або ліміт.");
    }
    const result = await listTeacherMaterialRequestPage(db, teacher.teacherUserId, {
      status,
      limit,
      cursor,
    });
    return materialRequestJson({
      schemaVersion: 1,
      success: true,
      requests: result.requests,
      page: result.page,
    });
  } catch (error) {
    return materialRequestStoreError(error, "material_requests_unavailable");
  }
}

export async function POST(request: Request): Promise<Response> {
  const gate = teacherPortalGate(); if (gate) return gate;
  const db = env.DB as unknown as TeacherMaterialRequestDatabase & VisitD1Database;
  try {
    const teacher = await requireVisitTeacherSession(db, request);
    const body = await readMaterialRequestJson(request);
    if (!body.ok) return body.response;
    const validated = validateMaterialRequestCreateInput(body.value);
    if (!validated.ok) {
      return materialRequestError(
        400,
        "validation_failed",
        "Перевірте матеріали, кількість і примітку.",
        { fieldErrors: validated.fieldErrors },
      );
    }
    const requestRecord = await createTeacherMaterialRequest(db, teacher, validated.value);
    return materialRequestJson(
      { schemaVersion: 1, success: true, request: requestRecord },
      { status: 201 },
    );
  } catch (error) {
    return materialRequestStoreError(error, "material_request_create_unavailable");
  }
}
