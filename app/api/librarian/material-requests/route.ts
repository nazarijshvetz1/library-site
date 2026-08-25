import { env } from "cloudflare:workers";

import { authorizeLibrarianApi } from "@/lib/librarian-api";
import {
  materialRequestError,
  materialRequestJson,
  materialRequestStoreError,
  parseBoundedLimit,
  readMaterialRequestJson,
} from "@/lib/teacher-material-request-api";
import {
  hideCompletedLibrarianMaterialRequests,
  listLibrarianMaterialRequests,
  type LibrarianMaterialRequestSort,
  type MaterialRequestVisibility,
  type MaterialRequestStatus,
  type TeacherMaterialRequestDatabase,
} from "@/lib/teacher-material-request-store";

export const dynamic = "force-dynamic";

const STATUSES = new Set<MaterialRequestStatus | "active" | "all">([
  "active",
  "all",
  "submitted",
  "in_review",
  "ready",
  "partially_ready",
  "completed",
  "rejected",
  "cancelled",
]);
const SORTS = new Set<LibrarianMaterialRequestSort>(["date_desc", "date_asc", "teacher_asc", "teacher_desc", "status_asc", "status_desc"]);
const VISIBILITY = new Set<MaterialRequestVisibility>(["visible", "hidden", "all"]);

export async function GET(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  const { access } = authorization.value;
  const url = new URL(request.url);
  const status = (url.searchParams.get("status") ?? "all") as
    | MaterialRequestStatus
    | "active"
    | "all";
  const limit = parseBoundedLimit(url.searchParams.get("limit"), 100, 100);
  const sort = (url.searchParams.get("sort") ?? "date_desc") as LibrarianMaterialRequestSort;
  const visibility = (url.searchParams.get("visibility") ?? "visible") as MaterialRequestVisibility;
  const query = (url.searchParams.get("q") ?? "").trim();
  if (!STATUSES.has(status) || limit === null || !SORTS.has(sort) || !VISIBILITY.has(visibility) || query.length > 100) {
    return materialRequestError(400, "validation_failed", "Некоректний статус або ліміт.", {
      writesEnabled: access.writesEnabled,
    });
  }
  try {
    const result = await listLibrarianMaterialRequests(
      env.DB as unknown as TeacherMaterialRequestDatabase,
      { status, limit, cursor: url.searchParams.get("cursor"), sort, visibility, query },
    );
    return materialRequestJson({
      schemaVersion: 1,
      success: true,
      ...result,
      page: result.page,
      writesEnabled: access.writesEnabled,
    });
  } catch (error) {
    return materialRequestStoreError(
      error,
      "material_requests_unavailable",
      access.writesEnabled,
    );
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  const { user, access } = authorization.value;
  if (!access.writesEnabled) return materialRequestError(503, "writes_disabled", "Зміни заявок тимчасово вимкнено.", { writesEnabled: false });
  const body = await readMaterialRequestJson(request, true);
  if (!body.ok) return body.response;
  const value = body.value as Record<string, unknown>;
  const mutationId = typeof value.mutationId === "string" ? value.mutationId : "";
  if (value.action !== "hide_completed" || !/^[0-9a-f-]{36}$/iu.test(mutationId)) return materialRequestError(400, "validation_failed", "Не вдалося підтвердити масове приховування.", { writesEnabled: true });
  try {
    const result = await hideCompletedLibrarianMaterialRequests(env.DB as unknown as TeacherMaterialRequestDatabase, user, mutationId);
    return materialRequestJson({ schemaVersion: 1, success: true, result, writesEnabled: true });
  } catch (error) { return materialRequestStoreError(error, "material_requests_hide_unavailable", true); }
}
