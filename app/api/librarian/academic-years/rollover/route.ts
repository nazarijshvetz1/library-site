import { env } from "cloudflare:workers";

import {
  type AcademicD1Database,
  AcademicAdminError,
  rolloverAcademicYearDirect,
} from "@/lib/academic-admin-store";
import { validateAcademicYearRolloverInput } from "@/lib/academic-admin-validation";
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
    return librarianError(503, "writes_disabled", "Перехід на новий навчальний рік тимчасово вимкнено.", false);
  }
  if (!isSameOriginRequest(request)) {
    return librarianError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.", true);
  }
  const body = await readDraftJsonBody(request, true);
  if (!body.ok) return body.response;
  const validated = validateAcademicYearRolloverInput(body.value);
  if (!validated.ok) {
    return librarianError(400, "validation_failed", "Перевірте повний план переходу.", true, validated.fieldErrors);
  }
  try {
    const result = await rolloverAcademicYearDirect(
      user,
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
    return librarianError(503, "academic_rollover_unavailable", "Не вдалося виконати перехід на новий навчальний рік.", true);
  }
}
