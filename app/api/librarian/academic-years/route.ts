import { env } from "cloudflare:workers";

import {
  type AcademicD1Database,
  AcademicAdminError,
  createAcademicYearDirect,
} from "@/lib/academic-admin-store";
import { validateAcademicYearCreateInput } from "@/lib/academic-admin-validation";
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
    return librarianError(503, "writes_disabled", "Створення навчальних років тимчасово вимкнено.", false);
  }
  if (!isSameOriginRequest(request)) {
    return librarianError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.", true);
  }
  const body = await readDraftJsonBody(request, true);
  if (!body.ok) return body.response;
  const validated = validateAcademicYearCreateInput(body.value);
  if (!validated.ok) {
    return librarianError(400, "validation_failed", "Перевірте дані навчального року.", true, validated.fieldErrors);
  }
  try {
    const result = await createAcademicYearDirect(
      user,
      validated.value,
      env.DB as unknown as AcademicD1Database,
    );
    return librarianJson({ schemaVersion: 1, success: true, result, writesEnabled: true }, { status: 201 });
  } catch (error) {
    return academicMutationError(error, "academic_year_create_unavailable", "Не вдалося створити навчальний рік.");
  }
}

function academicMutationError(error: unknown, code: string, message: string): Response {
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
  return librarianError(503, code, message, true);
}
