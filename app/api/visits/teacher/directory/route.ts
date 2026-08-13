import { env } from "cloudflare:workers";

import { featureGate, visitStoreError, visitJson } from "@/lib/visit-schedule-api";
import { type VisitD1Database } from "@/lib/visit-schedule-store";
import { listVisitTeacherDirectory } from "@/lib/visit-teacher-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const gate = featureGate();
  if (gate) return gate;
  try {
    const query = new URL(request.url).searchParams.get("q") ?? "";
    const teachers = await listVisitTeacherDirectory(
      env.DB as unknown as VisitD1Database,
      query,
      request,
    );
    return visitJson({ schemaVersion: 2, success: true, teachers });
  } catch (error) {
    return visitStoreError(error, "teacher_directory_unavailable");
  }
}
