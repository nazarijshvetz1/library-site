import { env } from "cloudflare:workers";

import { teacherPortalGate, visitJson, visitStoreError } from "@/lib/visit-schedule-api";
import type { VisitD1Database } from "@/lib/visit-schedule-store";
import { listVisitTeacherDirectory } from "@/lib/visit-teacher-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const gate = teacherPortalGate(); if (gate) return gate;
  try {
    const teachers = await listVisitTeacherDirectory(
      env.DB as unknown as VisitD1Database,
      new URL(request.url).searchParams.get("q") ?? "",
      request,
    );
    return visitJson({ schemaVersion: 1, success: true, teachers });
  } catch (error) {
    return visitStoreError(error, "teacher_directory_unavailable");
  }
}
