import { env } from "cloudflare:workers";

import {
  type CatalogD1Database,
  getCatalogMaterialDetail,
  normalizeCatalogId,
} from "@/lib/catalog-d1";
import {
  authorizeLibrarianApi,
  isSameOriginRequest,
  librarianError,
  librarianJson,
  readDraftJsonBody,
} from "@/lib/librarian-api";
import {
  type LibraryD1Database,
  LibraryMutationError,
  updateMaterialDirect,
} from "@/lib/library-mutation-store";
import { validateMaterialUpdateInput } from "@/lib/library-write-validation";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  const { access } = authorization.value;
  const { id: rawId } = await context.params;
  const id = normalizeCatalogId(rawId);
  if (!id) {
    return librarianError(
      400,
      "invalid_material_id",
      "Некоректний CAT-ID.",
      access.writesEnabled,
    );
  }

  try {
    const material = await getCatalogMaterialDetail(
      env.DB as unknown as CatalogD1Database,
      id,
      "librarian",
    );
    if (!material) {
      return librarianError(
        404,
        "material_not_found",
        "Матеріал не знайдено.",
        access.writesEnabled,
      );
    }
    return librarianJson({
      schemaVersion: 2,
      success: true,
      material,
      writesEnabled: access.writesEnabled,
    });
  } catch {
    return librarianError(
      503,
      "catalog_unavailable",
      "Не вдалося завантажити картку матеріалу.",
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
    return librarianError(
      400,
      "invalid_material_id",
      "Некоректний CAT-ID.",
      true,
    );
  }
  const body = await readDraftJsonBody(request, true);
  if (!body.ok) return body.response;
  const validated = validateMaterialUpdateInput(body.value);
  if (!validated.ok) {
    return librarianError(
      400,
      "validation_failed",
      "Перевірте поля матеріалу.",
      true,
      validated.fieldErrors,
    );
  }

  try {
    const result = await updateMaterialDirect(
      user,
      id,
      validated.value,
      env.DB as unknown as LibraryD1Database,
    );
    return librarianJson({
      success: true,
      result,
      writesEnabled: true,
    });
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
      "material_update_unavailable",
      "Не вдалося зберегти матеріал. Спробуйте ще раз.",
      true,
    );
  }
}
