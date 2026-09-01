import { env } from "cloudflare:workers";

import type { CatalogD1Database } from "@/lib/catalog-d1";
import {
  ClassLoanManagementError,
  readClassLoanManagement,
} from "@/lib/class-loan-management-store";
import {
  authorizeLibrarianApi,
  isSameOriginRequest,
  librarianError,
  librarianJson,
  readDraftJsonBody,
} from "@/lib/librarian-api";
import { readLibraryReferenceData } from "@/lib/library-directory-store";
import {
  adjustClassLoanItem,
  type LibraryD1Database,
  linkLegacyClassLoanItem,
  LibraryMutationError,
  updateClassLoanMetadata,
} from "@/lib/library-mutation-store";
import { validateClassLoanManagementInput } from "@/lib/library-write-validation";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ classLoanId: string }> };

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  const { access } = authorization.value;
  const { classLoanId } = await context.params;
  const historyLimitValue = new URL(request.url).searchParams.get("historyLimit");
  const historyLimit = historyLimitValue === null ? 120 : Number(historyLimitValue);
  if (!Number.isSafeInteger(historyLimit) || historyLimit < 1 || historyLimit > 200) {
    return librarianError(
      400,
      "validation_failed",
      "Кількість записів історії має бути від 1 до 200.",
      access.writesEnabled,
    );
  }
  try {
    const db = env.DB as unknown as CatalogD1Database;
    const [classLoan, referenceData] = await Promise.all([
      readClassLoanManagement(db, classLoanId, { historyLimit }),
      readLibraryReferenceData(db),
    ]);
    return librarianJson({
      schemaVersion: 1,
      success: true,
      classLoan,
      referenceData,
      writesEnabled: access.writesEnabled,
    });
  } catch (error) {
    if (error instanceof ClassLoanManagementError) {
      return librarianError(
        error.status,
        error.code,
        error.message,
        access.writesEnabled,
      );
    }
    return librarianError(
      503,
      "class_loan_management_unavailable",
      "Не вдалося завантажити керування відомістю.",
      access.writesEnabled,
    );
  }
}

export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  const { user, access } = authorization.value;
  if (!access.writesEnabled) {
    return librarianError(
      503,
      "writes_disabled",
      "Збереження змін тимчасово вимкнено адміністратором.",
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
  const validated = validateClassLoanManagementInput(body.value);
  if (!validated.ok) {
    return librarianError(
      400,
      "validation_failed",
      "Перевірте дані зміни та обов’язково вкажіть причину.",
      true,
      validated.fieldErrors,
    );
  }
  const { classLoanId } = await context.params;
  try {
    const db = env.DB as unknown as LibraryD1Database;
    const result = validated.value.action === "update_metadata"
      ? await updateClassLoanMetadata(user, classLoanId, validated.value, db)
      : validated.value.action === "link_legacy_item"
        ? await linkLegacyClassLoanItem(user, classLoanId, validated.value, db)
        : await adjustClassLoanItem(user, classLoanId, validated.value, db);
    return librarianJson({ success: true, result, writesEnabled: true });
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
      "class_loan_update_unavailable",
      "Не вдалося зберегти зміну відомості. Спробуйте ще раз.",
      true,
    );
  }
}
