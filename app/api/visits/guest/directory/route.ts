import { env } from "cloudflare:workers";

import { listGuestTeacherDirectory } from "@/lib/visit-guest-auth";
import { guestFeatureGate, visitJson, visitStoreError } from "@/lib/visit-schedule-api";
import type { VisitD1Database } from "@/lib/visit-schedule-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const gate = guestFeatureGate(); if (gate) return gate;
  try {
    const teachers = await listGuestTeacherDirectory(
      env.DB as unknown as VisitD1Database,
      request,
      new URL(request.url).searchParams.get("q") ?? "",
    );
    return visitJson({ schemaVersion: 1, success: true, teachers });
  } catch (error) { return visitStoreError(error, "teacher_directory_unavailable"); }
}
