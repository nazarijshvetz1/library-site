import { env } from "cloudflare:workers";

import {
  authorizeLibrarianApi,
  isSameOriginRequest,
  librarianError,
  librarianJson,
  readDraftJsonBody,
} from "@/lib/librarian-api";
import {
  decideTeacherCuratorRequest,
  listTeacherCuratorRequests,
  TeacherCuratorRequestError,
  type TeacherCuratorRequestDatabase,
  type TeacherCuratorRequestStatus,
} from "@/lib/teacher-curator-request-store";
import { safeResourceId } from "@/lib/visit-schedule-api";

export const dynamic = "force-dynamic";
const STATUSES = new Set<TeacherCuratorRequestStatus | "all">([
  "all", "submitted", "approved", "rejected", "cancelled",
]);

export async function GET(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  const url = new URL(request.url);
  const status = (url.searchParams.get("status") ?? "submitted") as TeacherCuratorRequestStatus | "all";
  const rawLimit = url.searchParams.get("limit") ?? "100";
  const limit = /^\d{1,3}$/u.test(rawLimit) ? Number(rawLimit) : 0;
  if (!STATUSES.has(status) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return librarianError(400, "validation_failed", "Некоректний статус або ліміт.", authorization.value.access.writesEnabled);
  }
  try {
    const requests = await listTeacherCuratorRequests(
      env.DB as unknown as TeacherCuratorRequestDatabase,
      { status, limit },
    );
    return librarianJson({
      schemaVersion: 1,
      success: true,
      requests,
      writesEnabled: authorization.value.access.writesEnabled,
    });
  } catch {
    return librarianError(503, "curator_requests_unavailable", "Заявки тимчасово недоступні.", authorization.value.access.writesEnabled);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  const { user, access } = authorization.value;
  if (!access.writesEnabled) {
    return librarianError(503, "writes_disabled", "Опрацювання заявок тимчасово вимкнено.", false);
  }
  if (!isSameOriginRequest(request)) {
    return librarianError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.", true);
  }
  const body = await readDraftJsonBody(request, true);
  if (!body.ok) return body.response;
  const keys = Object.keys(body.value);
  const requestId = typeof body.value.requestId === "string" ? body.value.requestId.trim() : "";
  const expectedVersion = body.value.expectedVersion;
  const decision = body.value.decision;
  if (keys.length !== 3 || !keys.includes("requestId") || !keys.includes("expectedVersion") || !keys.includes("decision")
    || !safeResourceId(requestId) || typeof expectedVersion !== "number"
    || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1
    || (decision !== "approve" && decision !== "reject")) {
    return librarianError(400, "validation_failed", "Оновіть заявку та повторіть рішення.", true);
  }
  try {
    const curatorRequest = await decideTeacherCuratorRequest(
      env.DB as unknown as TeacherCuratorRequestDatabase,
      user,
      { requestId, expectedVersion, decision },
    );
    return librarianJson({ schemaVersion: 1, success: true, request: curatorRequest, writesEnabled: true });
  } catch (error) {
    if (error instanceof TeacherCuratorRequestError) {
      return librarianError(error.status, error.code, error.message, true);
    }
    return librarianError(503, "curator_request_decision_unavailable", "Не вдалося опрацювати заявку.", true);
  }
}
