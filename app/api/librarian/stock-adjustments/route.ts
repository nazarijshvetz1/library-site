import { env } from "cloudflare:workers";

import {
  authorizeLibrarianApi,
  isSameOriginRequest,
  librarianError,
  librarianJson,
  readDraftJsonBody,
} from "@/lib/librarian-api";
import {
  adjustHoldingToActualCount,
  type LibraryD1Database,
  LibraryMutationError,
} from "@/lib/library-mutation-store";
import { validateStockAdjustmentInput } from "@/lib/library-write-validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  const { user, access } = authorization.value;

  if (!access.writesEnabled) {
    return librarianError(
      503,
      "writes_disabled",
      "Коригування залишків тимчасово вимкнено адміністратором.",
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
  const validated = validateStockAdjustmentInput(body.value);
  if (!validated.ok) {
    return librarianError(
      400,
      "validation_failed",
      "Перевірте фактичну кількість і причину коригування.",
      true,
      validated.fieldErrors,
    );
  }

  try {
    const result = await adjustHoldingToActualCount(
      user,
      validated.value,
      env.DB as unknown as LibraryD1Database,
    );
    return librarianJson(
      {
        success: true,
        result,
        writesEnabled: true,
      },
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
      "stock_adjustment_unavailable",
      "Не вдалося зберегти фактичну кількість. Спробуйте ще раз.",
      true,
    );
  }
}
