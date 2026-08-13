import { env } from "cloudflare:workers";

import { isSameOriginRequest } from "@/lib/librarian-api";
import {
  clearGuestSessionCookie,
  createVisitGuestSession,
  guestSessionCookie,
  requireVisitGuestSession,
  revokeVisitGuestSession,
} from "@/lib/visit-guest-auth";
import { guestFeatureGate, readVisitJson, visitError, visitJson, visitStoreError } from "@/lib/visit-schedule-api";
import type { VisitD1Database } from "@/lib/visit-schedule-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const gate = guestFeatureGate(); if (gate) return gate;
  try {
    const identity = await requireVisitGuestSession(env.DB as unknown as VisitD1Database, request);
    return visitJson({ schemaVersion: 1, success: true, guest: {
      pendingScope: identity.pendingScope, expiresAt: identity.expiresAt,
    } });
  } catch (error) { return visitStoreError(error, "guest_session_unavailable"); }
}

export async function POST(request: Request): Promise<Response> {
  const gate = guestFeatureGate(); if (gate) return gate;
  if (!isSameOriginRequest(request)) return visitError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.");
  const body = await readVisitJson(request); if (!body.ok) return body.response;
  if (Object.keys(body.value).length !== 0) return visitError(400, "validation_failed", "Тіло має бути порожнім JSON-об’єктом.");
  try {
    const result = await createVisitGuestSession(env.DB as unknown as VisitD1Database, request);
    return visitJson({ schemaVersion: 1, success: true, guest: {
      pendingScope: result.identity.pendingScope, expiresAt: result.identity.expiresAt,
    } }, { status: 201, headers: { "Set-Cookie": guestSessionCookie(result.token) } });
  } catch (error) { return visitStoreError(error, "guest_session_unavailable"); }
}

export async function DELETE(request: Request): Promise<Response> {
  const gate = guestFeatureGate(); if (gate) return gate;
  if (!isSameOriginRequest(request)) return visitError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.");
  try {
    await revokeVisitGuestSession(env.DB as unknown as VisitD1Database, request);
    return visitJson({ schemaVersion: 1, success: true }, {
      headers: { "Set-Cookie": clearGuestSessionCookie() },
    });
  } catch (error) { return visitStoreError(error, "guest_session_unavailable"); }
}
