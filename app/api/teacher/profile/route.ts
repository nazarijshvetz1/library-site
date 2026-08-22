import { env } from "cloudflare:workers";

import { teacherPortalGate, visitJson, visitStoreError } from "@/lib/visit-schedule-api";
import type { VisitD1Database } from "@/lib/visit-schedule-store";
import { requireVisitTeacherSession } from "@/lib/visit-teacher-auth";
import { getTeacherOwnProfile } from "@/lib/teacher-profile-store";

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
