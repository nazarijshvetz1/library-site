import { env } from "cloudflare:workers";

import { normalizeCatalogId } from "@/lib/catalog-d1";
import {
  authorizeLibrarianApi,
  isSameOriginRequest,
  librarianError,
  librarianJson,
  readDraftJsonBody,
} from "@/lib/librarian-api";
import {
  appendMaterialEbookLinkDirect,
  type LibraryD1Database,
  LibraryMutationError,
} from "@/lib/library-mutation-store";
import { validateMaterialEbookLinkCreateInput } from "@/lib/library-write-validation";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(
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
      "Збереження тимчасово вимкнено адміністратором.",
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
  const { id: rawId } = await context.params;
  const id = normalizeCatalogId(rawId);
  if (!id) {
    return librarianError(400, "invalid_material_id", "Некоректний CAT-ID.", true);
  }
  const body = await readDraftJsonBody(request, true);
  if (!body.ok) return body.response;
  const validated = validateMaterialEbookLinkCreateInput(body.value);
  if (!validated.ok) {
    return librarianError(
      400,
      "validation_failed",
      "Перевірте адресу електронного підручника.",
      true,
      validated.fieldErrors,
    );
  }
  try {
    const result = await appendMaterialEbookLinkDirect(
      user,
      id,
      validated.value,
      env.DB as unknown as LibraryD1Database,
    );
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
      "ebook_link_unavailable",
      "Не вдалося зберегти посилання. Спробуйте ще раз.",
      true,
    );
  }
}
