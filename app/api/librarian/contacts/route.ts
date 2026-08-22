import { env } from "cloudflare:workers";

import {
  authorizeLibrarianApi,
  isSameOriginRequest,
  librarianError,
  librarianJson,
  readDraftJsonBody,
} from "@/lib/librarian-api";
import {
  getLibrarianContactProfile,
  PublicLibraryProfileError,
  updatePublicLibraryContactProfile,
  type ContactProfileChanges,
} from "@/lib/public-library-profile";
import { resolveVisitLibrarianActor, validRequestId } from "@/lib/visit-teacher-access-api";
import type { VisitD1Database } from "@/lib/visit-schedule-store";

export const dynamic = "force-dynamic";

const CHANGE_KEYS = [
  "librarianName", "librarianDescription", "librarianPhone", "librarianEmail",
  "assistantName", "assistantDescription", "assistantPhone", "assistantEmail",
] as const;

export async function GET(): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  try {
    const profile = await getLibrarianContactProfile(env.DB as unknown as VisitD1Database);
    return librarianJson({ schemaVersion: 1, success: true, profile,
      writesEnabled: authorization.value.access.writesEnabled });
  } catch (error) {
    return profileError(error, authorization.value.access.writesEnabled);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  if (!authorization.value.access.writesEnabled) {
    return librarianError(503, "writes_disabled", "Редагування контактів тимчасово вимкнено.", false);
  }
  if (!isSameOriginRequest(request)) {
    return librarianError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.", true);
  }
  const body = await readDraftJsonBody(request, true);
  if (!body.ok) return body.response;
  if (Object.keys(body.value).length !== 3 || !body.value.changes
    || typeof body.value.changes !== "object" || Array.isArray(body.value.changes)
    || typeof body.value.requestId !== "string" || !validRequestId(body.value.requestId)
    || !Number.isSafeInteger(body.value.expectedVersion) || Number(body.value.expectedVersion) < 1) {
    return librarianError(400, "validation_failed", "Оновіть форму контактів і повторіть дію.", true);
  }
  const changes = body.value.changes as Record<string, unknown>;
  if (Object.keys(changes).length !== CHANGE_KEYS.length
    || CHANGE_KEYS.some((key) => typeof changes[key] !== "string")) {
    return librarianError(400, "validation_failed", "Заповніть лише дозволені поля контактів.", true);
  }
  try {
    const db = env.DB as unknown as VisitD1Database;
    const actor = await resolveVisitLibrarianActor(db, authorization.value.user);
    const profile = await updatePublicLibraryContactProfile(db, actor, {
      requestId: body.value.requestId,
      expectedVersion: Number(body.value.expectedVersion),
      changes: Object.fromEntries(CHANGE_KEYS.map((key) => [key, changes[key]])) as ContactProfileChanges,
    });
    return librarianJson({ schemaVersion: 1, success: true, profile, writesEnabled: true });
  } catch (error) {
    return profileError(error, true);
  }
}

function profileError(error: unknown, writesEnabled: boolean): Response {
  if (error instanceof PublicLibraryProfileError) {
    return librarianError(error.status, error.code, error.message, writesEnabled);
  }
  return librarianError(503, "contacts_unavailable", "Контакти тимчасово недоступні.", writesEnabled);
}
