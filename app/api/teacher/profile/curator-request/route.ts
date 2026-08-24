import { env } from "cloudflare:workers";

import {
  cancelTeacherCuratorRequest,
  submitTeacherCuratorRequest,
  TeacherCuratorRequestError,
  type TeacherCuratorRequestDatabase,
} from "@/lib/teacher-curator-request-store";
import {
  readVisitJson,
  safeResourceId,
  teacherPortalGate,
  visitError,
  visitJson,
  visitStoreError,
} from "@/lib/visit-schedule-api";
import type { VisitD1Database } from "@/lib/visit-schedule-store";
import { requireVisitTeacherSession } from "@/lib/visit-teacher-auth";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function POST(request: Request): Promise<Response> {
  const gate = teacherPortalGate();
  if (gate) return gate;
  const body = await readVisitJson(request);
  if (!body.ok) return body.response;
  const keys = Object.keys(body.value);
  const expected = ["requestId", "expectedVersion", "requestedClassYearId", "teacherNote"];
  const requestId = typeof body.value.requestId === "string" ? body.value.requestId.trim().toLowerCase() : "";
  const requestedClassYearId = typeof body.value.requestedClassYearId === "string"
    ? body.value.requestedClassYearId.trim()
    : "";
  const teacherNote = typeof body.value.teacherNote === "string"
    ? body.value.teacherNote.normalize("NFKC").trim().replace(/\s+/gu, " ")
    : "";
  const rawExpectedVersion = body.value.expectedVersion;
  const expectedVersion = rawExpectedVersion === null ? null : rawExpectedVersion;
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))
    || !UUID.test(requestId) || !safeResourceId(requestedClassYearId)
    || teacherNote.length > 1000
    || (expectedVersion !== null && (typeof expectedVersion !== "number"
      || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1))) {
    return visitError(400, "validation_failed", "Перевірте клас, примітку та версію заявки.");
  }
  const db = env.DB as unknown as TeacherCuratorRequestDatabase & VisitD1Database;
  try {
    const teacher = await requireVisitTeacherSession(db, request);
    const curatorRequest = await submitTeacherCuratorRequest(db, teacher, {
      mutationRequestId: requestId,
      expectedVersion,
      requestedClassYearId,
      teacherNote,
    });
    return visitJson({ schemaVersion: 1, success: true, request: curatorRequest }, { status: 201 });
  } catch (error) {
    return curatorError(error, "curator_request_submit_unavailable");
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const gate = teacherPortalGate();
  if (gate) return gate;
  const body = await readVisitJson(request);
  if (!body.ok) return body.response;
  const keys = Object.keys(body.value);
  const requestId = typeof body.value.requestId === "string" ? body.value.requestId.trim().toLowerCase() : "";
  const expectedVersion = body.value.expectedVersion;
  if (keys.length !== 2 || !keys.includes("requestId") || !keys.includes("expectedVersion")
    || !UUID.test(requestId) || typeof expectedVersion !== "number"
    || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    return visitError(400, "validation_failed", "Оновіть заявку та повторіть скасування.");
  }
  const db = env.DB as unknown as TeacherCuratorRequestDatabase & VisitD1Database;
  try {
    const teacher = await requireVisitTeacherSession(db, request);
    const curatorRequest = await cancelTeacherCuratorRequest(db, teacher, {
      mutationRequestId: requestId,
      expectedVersion,
    });
    return visitJson({ schemaVersion: 1, success: true, request: curatorRequest });
  } catch (error) {
    return curatorError(error, "curator_request_cancel_unavailable");
  }
}

function curatorError(error: unknown, fallback: string): Response {
  if (error instanceof TeacherCuratorRequestError) {
    return visitError(error.status, error.code, error.message);
  }
  return visitStoreError(error, fallback);
}
