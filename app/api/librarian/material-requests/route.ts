import { env } from "cloudflare:workers";

import { authorizeLibrarianApi } from "@/lib/librarian-api";
import {
  materialRequestError,
  materialRequestJson,
  materialRequestStoreError,
  parseBoundedLimit,
} from "@/lib/teacher-material-request-api";
import {
  listLibrarianMaterialRequests,
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
  if (!STATUSES.has(status) || limit === null) {
    return materialRequestError(400, "validation_failed", "Некоректний статус або ліміт.", {
      writesEnabled: access.writesEnabled,
    });
  }
  try {
    const result = await listLibrarianMaterialRequests(
      env.DB as unknown as TeacherMaterialRequestDatabase,
      { status, limit, cursor: url.searchParams.get("cursor") },
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
