import { env } from "cloudflare:workers";
import { authorizeLibrarianApi } from "@/lib/librarian-api";
import { acquisitionError, acquisitionJson, acquisitionStoreError, readAcquisitionJson } from "@/lib/acquisition-api";
import { hideCompletedLibrarianAcquisitionRequests, listLibrarianAcquisitionRequests, type AcquisitionDatabase, type AcquisitionVisibility, type LibrarianAcquisitionSort } from "@/lib/acquisition-store";
import type { AcquisitionStatus } from "@/lib/acquisition-validation";

export const dynamic = "force-dynamic";
const STATUSES = new Set<AcquisitionStatus | "active" | "all">(["active","all","submitted","in_review","clarification","approved","planned","ordered","partially_received","received","rejected","cancelled"]);
const SORTS = new Set<LibrarianAcquisitionSort>(["date_desc", "date_asc", "requester_asc", "requester_desc", "status_asc", "status_desc"]);
const VISIBILITY = new Set<AcquisitionVisibility>(["visible", "hidden", "all"]);

export async function GET(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi(); if (!authorization.ok) return authorization.response;
  const { access } = authorization.value;
  const url = new URL(request.url);
  const status = (url.searchParams.get("status") ?? "all") as AcquisitionStatus | "active" | "all";
  const requesterKind = (url.searchParams.get("requester") ?? "all") as "teacher" | "student" | "all";
  const visibility = (url.searchParams.get("visibility") ?? "visible") as AcquisitionVisibility;
  const sort = (url.searchParams.get("sort") ?? "date_desc") as LibrarianAcquisitionSort;
  if (!STATUSES.has(status) || !["teacher","student","all"].includes(requesterKind) || !VISIBILITY.has(visibility) || !SORTS.has(sort)) return acquisitionError(400, "validation_failed", "Некоректні фільтри.", { writesEnabled: access.writesEnabled });
  try {
    const result = await listLibrarianAcquisitionRequests(env.DB as unknown as AcquisitionDatabase, { status, requesterKind, query: url.searchParams.get("q") ?? "", visibility, sort });
    return acquisitionJson({ schemaVersion: 1, success: true, ...result, writesEnabled: access.writesEnabled });
  } catch (error) { return acquisitionStoreError(error, "acquisition_requests_unavailable", access.writesEnabled); }
}

export async function PATCH(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi(); if (!authorization.ok) return authorization.response;
  const { user, access } = authorization.value;
  if (!access.writesEnabled) return acquisitionError(503, "writes_disabled", "Запис тимчасово вимкнено.", { writesEnabled: false });
  try {
    const body = await readAcquisitionJson(request, { writesEnabled: true }); if (!body.ok) return body.response;
    const value = body.value as Record<string, unknown>;
    const mutationId = typeof value.mutationId === "string" ? value.mutationId : "";
    if (value.action !== "hide_completed" || !/^[0-9a-f-]{36}$/iu.test(mutationId)) return acquisitionError(400, "validation_failed", "Не вдалося підтвердити масове приховування.", { writesEnabled: true });
    const result = await hideCompletedLibrarianAcquisitionRequests(env.DB as unknown as AcquisitionDatabase, user, mutationId);
    return acquisitionJson({ schemaVersion: 1, success: true, result, writesEnabled: true });
  } catch (error) { return acquisitionStoreError(error, "acquisition_requests_hide_unavailable", true); }
}
