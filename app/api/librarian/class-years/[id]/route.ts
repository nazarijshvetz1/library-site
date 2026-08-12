import { env } from "cloudflare:workers";

import {
  type AcademicD1Database,
  AcademicAdminError,
  updateClassYearDirect,
} from "@/lib/academic-admin-store";
import {
  normalizeClassYearId,
  validateClassYearUpdateInput,
} from "@/lib/academic-admin-validation";
import {
  authorizeLibrarianApi,
  isSameOriginRequest,
  librarianError,
  librarianJson,
  readDraftJsonBody,
} from "@/lib/librarian-api";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  const { user, access } = authorization.value;
  if (!access.writesEnabled) {
    return librarianError(503, "writes_disabled", "Редагування класів тимчасово вимкнено.", false);
  }
  if (!isSameOriginRequest(request)) {
    return librarianError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.", true);
  }
  const { id: rawId } = await context.params;
  const classYearId = normalizeClassYearId(rawId);
  if (!classYearId) return librarianError(400, "invalid_class_year_id", "Некоректний ID класу.", true);
  const body = await readDraftJsonBody(request, true);
  if (!body.ok) return body.response;
  const validated = validateClassYearUpdateInput(body.value);
  if (!validated.ok) {
    return librarianError(400, "validation_failed", "Перевірте зміни класу.", true, validated.fieldErrors);
  }
  try {
    const result = await updateClassYearDirect(
      user,
      classYearId,
      validated.value,
      env.DB as unknown as AcademicD1Database,
    );
    return librarianJson({ schemaVersion: 1, success: true, result, writesEnabled: true });
  } catch (error) {
    if (error instanceof AcademicAdminError) {
      return librarianJson({
        schemaVersion: 1,
        success: false,
        code: error.code,
        error: error.message,
        ...(error.details ?? {}),
        writesEnabled: true,
      }, { status: error.status });
    }
    return librarianError(503, "class_year_update_unavailable", "Не вдалося оновити клас.", true);
  }
}
