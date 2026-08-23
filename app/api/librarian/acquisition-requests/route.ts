import { env } from "cloudflare:workers";
import { authorizeLibrarianApi } from "@/lib/librarian-api";
import { acquisitionError, acquisitionJson, acquisitionStoreError } from "@/lib/acquisition-api";
import { listLibrarianAcquisitionRequests, type AcquisitionDatabase } from "@/lib/acquisition-store";
import type { AcquisitionStatus } from "@/lib/acquisition-validation";

export const dynamic = "force-dynamic";
const STATUSES = new Set<AcquisitionStatus | "active" | "all">(["active","all","submitted","in_review","clarification","approved","planned","ordered","partially_received","received","rejected","cancelled"]);

export async function GET(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi(); if (!authorization.ok) return authorization.response;
  const { access } = authorization.value;
  const url = new URL(request.url);
  const status = (url.searchParams.get("status") ?? "all") as AcquisitionStatus | "active" | "all";
  const requesterKind = (url.searchParams.get("requester") ?? "all") as "teacher" | "student" | "all";
  if (!STATUSES.has(status) || !["teacher","student","all"].includes(requesterKind)) return acquisitionError(400, "validation_failed", "Некоректні фільтри.", { writesEnabled: access.writesEnabled });
  try {
    const result = await listLibrarianAcquisitionRequests(env.DB as unknown as AcquisitionDatabase, { status, requesterKind, query: url.searchParams.get("q") ?? "" });
    return acquisitionJson({ schemaVersion: 1, success: true, ...result, writesEnabled: access.writesEnabled });
  } catch (error) { return acquisitionStoreError(error, "acquisition_requests_unavailable", access.writesEnabled); }
}
