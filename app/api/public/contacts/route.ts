import { env } from "cloudflare:workers";

import { getPublicLibraryContactProfile, PublicLibraryProfileError } from "@/lib/public-library-profile";
import type { VisitD1Database } from "@/lib/visit-schedule-store";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const profile = await getPublicLibraryContactProfile(env.DB as unknown as VisitD1Database);
    return publicJson({ schemaVersion: 1, success: true, profile });
  } catch (error) {
    const status = error instanceof PublicLibraryProfileError ? error.status : 503;
    return publicJson({
      schemaVersion: 1,
      success: false,
      code: error instanceof PublicLibraryProfileError ? error.code : "contacts_unavailable",
      error: "Контакти тимчасово недоступні.",
    }, status, "no-store");
  }
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: publicHeaders("public, max-age=60") });
}

function publicJson(body: unknown, status = 200, cacheControl = "public, max-age=60, s-maxage=300"): Response {
  return Response.json(body, { status, headers: publicHeaders(cacheControl) });
}

function publicHeaders(cacheControl: string): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": cacheControl,
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
}
