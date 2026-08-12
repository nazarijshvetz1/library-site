import { env } from "cloudflare:workers";

import type { CatalogD1Database } from "@/lib/catalog-d1";
import {
  authorizeLibrarianApi,
  isSameOriginRequest,
  librarianError,
  librarianJson,
  readDraftJsonBody,
} from "@/lib/librarian-api";
import {
  issueLoanToTeacher,
  type LibraryD1Database,
  LibraryMutationError,
} from "@/lib/library-mutation-store";
import { listOpenLoans } from "@/lib/library-directory-store";
import { validateLoanCreateInput } from "@/lib/library-write-validation";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  const { access } = authorization.value;
  const url = new URL(request.url);
  const teacherUserId = String(url.searchParams.get("teacherUserId") ?? "").trim();
  if (teacherUserId.length > 64) {
    return librarianError(
      400,
      "invalid_teacher_filter",
      "Некоректний фільтр учителя.",
      access.writesEnabled,
    );
  }
  const limitText = url.searchParams.get("limit");
  const limit = limitText === null ? 100 : Number(limitText);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    return librarianError(
      400,
      "invalid_limit",
      "Кількість записів має бути від 1 до 200.",
      access.writesEnabled,
    );
  }
  try {
    const loans = await listOpenLoans(
      env.DB as unknown as CatalogD1Database,
      { teacherUserId, limit },
    );
    return librarianJson({
      schemaVersion: 1,
      success: true,
      loans,
      writesEnabled: access.writesEnabled,
    });
  } catch {
    return librarianError(
      503,
      "loans_unavailable",
      "Не вдалося завантажити відкриті видачі.",
      access.writesEnabled,
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  const { user, access } = authorization.value;
  if (!access.writesEnabled) {
    return librarianError(
      503,
      "writes_disabled",
      "Видачу матеріалів тимчасово вимкнено адміністратором.",
      false,
    );
  }
  if (!isSameOriginRequest(request)) {
    return librarianError(
      403,
      "cross_origin_request",
      "Запит має надійти з цього самого сайту.",
      true,
    );
  }
  const body = await readDraftJsonBody(request, true);
  if (!body.ok) return body.response;
  const validated = validateLoanCreateInput(body.value);
  if (!validated.ok) {
    return librarianError(
      400,
      "validation_failed",
      "Перевірте вчителя, матеріали, кількість і дати.",
      true,
      validated.fieldErrors,
    );
  }
  try {
    const result = await issueLoanToTeacher(
      user,
      validated.value,
      env.DB as unknown as LibraryD1Database,
    );
    return librarianJson(
      { success: true, result, writesEnabled: true },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof LibraryMutationError) {
      return librarianJson(
        {
          success: false,
          code: error.code,
          error: error.message,
          ...(error.details ?? {}),
          writesEnabled: true,
        },
        { status: error.status },
      );
    }
    return librarianError(
      503,
      "loan_issue_unavailable",
      "Не вдалося оформити видачу. Спробуйте ще раз.",
      true,
    );
  }
}
