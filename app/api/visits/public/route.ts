import { env } from "cloudflare:workers";
import { featureGate, visitError, visitJson, visitStoreError } from "@/lib/visit-schedule-api";
import { readVisitSchedule, type VisitD1Database } from "@/lib/visit-schedule-store";
import { kyivToday, parseVisitRange, VisitValidationError } from "@/lib/visit-schedule-validation";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const gate = featureGate();
  if (gate) return cors(gate);
  try {
    const range = parseVisitRange(new URL(request.url), kyivToday(), 30);
    const schedule = await readVisitSchedule(env.DB as unknown as VisitD1Database, range);
    return cors(visitJson({ schemaVersion: 1, success: true, generatedAt: new Date().toISOString(), ...schedule }, {
      headers: { "Cache-Control": "public, max-age=30, s-maxage=30" },
    }));
  } catch (error) {
    if (error instanceof VisitValidationError) return cors(visitError(400, error.code, error.message));
    return cors(visitStoreError(error, "visit_schedule_unavailable"));
  }
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders()).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, { status: response.status, headers });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
