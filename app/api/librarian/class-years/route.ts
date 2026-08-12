import { env } from "cloudflare:workers";

import {
  type AcademicD1Database,
  AcademicAdminError,
  createClassYearDirect,
} from "@/lib/academic-admin-store";
import { validateClassYearCreateInput } from "@/lib/academic-admin-validation";
import {
  authorizeLibrarianApi,
  isSameOriginRequest,
  librarianError,
  librarianJson,
  readDraftJsonBody,
} from "@/lib/librarian-api";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  const { user, access } = authorization.value;
  if (!access.writesEnabled) {
    return librarianError(503, "writes_disabled", "Створення класів тимчасово вимкнено.", false);
  }
  if (!isSameOriginRequest(request)) {
    return librarianError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.", true);
  }
  const body = await readDraftJsonBody(request, true);
  if (!body.ok) return body.response;
  const validated = validateClassYearCreateInput(body.value);
  if (!validated.ok) {
    return librarianError(400, "validation_failed", "Перевірте дані нового класу.", true, validated.fieldErrors);
  }
  try {
    const result = await createClassYearDirect(
      user,
      validated.value,
      env.DB as unknown as AcademicD1Database,
    );
    return librarianJson({ schemaVersion: 1, success: true, result, writesEnabled: true }, { status: 201 });
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
    return librarianError(503, "class_year_create_unavailable", "Не вдалося створити клас.", true);
  }
}
