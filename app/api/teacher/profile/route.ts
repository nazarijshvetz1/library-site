import { env } from "cloudflare:workers";

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
import { getTeacherOwnProfile, updateTeacherOwnProfile } from "@/lib/teacher-profile-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const gate = teacherPortalGate();
  if (gate) return gate;
  const db = env.DB as unknown as VisitD1Database;
  try {
    const teacher = await requireVisitTeacherSession(db, request);
    const profile = await getTeacherOwnProfile(db, teacher.teacherUserId);
    return visitJson({ schemaVersion: 1, success: true, profile });
  } catch (error) {
    return visitStoreError(error, "teacher_profile_unavailable");
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const gate = teacherPortalGate();
  if (gate) return gate;
  const body = await readVisitJson(request);
  if (!body.ok) return body.response;
  const keys = Object.keys(body.value);
  const expectedKeys = ["requestId", "expectedVersion", "subjectPosition", "primaryLocationId"];
  const acceptedKeys = new Set([...expectedKeys, "fullName"]);
  if (expectedKeys.some((key) => !keys.includes(key)) || keys.some((key) => !acceptedKeys.has(key))) {
    return visitError(400, "validation_failed", "Форма профілю містить непідтримувані або пропущені поля.");
  }
  const requestId = typeof body.value.requestId === "string"
    ? body.value.requestId.trim().toLowerCase()
    : "";
  const expectedVersion = Number(body.value.expectedVersion);
  const subjectPosition = typeof body.value.subjectPosition === "string"
    ? body.value.subjectPosition.normalize("NFKC").trim().replace(/\s+/gu, " ")
    : "";
  const fullName = body.value.fullName === undefined
    ? undefined
    : typeof body.value.fullName === "string"
      ? body.value.fullName.normalize("NFKC").trim().replace(/\s+/gu, " ")
      : "";
  const primaryLocationId = body.value.primaryLocationId === null || body.value.primaryLocationId === ""
    ? null
    : typeof body.value.primaryLocationId === "string"
      ? body.value.primaryLocationId.trim()
      : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(requestId)
    || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1
    || (fullName !== undefined && (fullName.length < 3 || fullName.length > 120 || fullName.split(/\s+/u).length < 2))
    || subjectPosition.length > 160
    || (primaryLocationId !== null && !safeResourceId(primaryLocationId))) {
    return visitError(400, "validation_failed", "Перевірте предмет, посаду та обраний кабінет.");
  }
  const db = env.DB as unknown as VisitD1Database;
  try {
    const teacher = await requireVisitTeacherSession(db, request);
    await updateTeacherOwnProfile(db, teacher, {
      requestId,
      expectedVersion,
      ...(fullName === undefined ? {} : { fullName }),
      subjectPosition,
      primaryLocationId,
    });
    const profile = await getTeacherOwnProfile(db, teacher.teacherUserId);
    return visitJson({ schemaVersion: 1, success: true, profile });
  } catch (error) {
    return visitStoreError(error, "teacher_profile_update_unavailable");
  }
}
