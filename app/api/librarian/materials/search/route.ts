import { env } from "cloudflare:workers";

import {
  type CatalogD1Database,
  CatalogQueryValidationError,
  DEFAULT_LIBRARIAN_SEARCH_LIMIT,
  listCatalogMaterials,
  MAX_LIBRARIAN_SEARCH_LIMIT,
  parseCatalogListQuery,
} from "@/lib/catalog-d1";
import {
  authorizeLibrarianApi,
  librarianError,
  librarianJson,
} from "@/lib/librarian-api";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  const { access } = authorization.value;

  try {
    const query = parseCatalogListQuery(new URL(request.url), {
      defaultLimit: DEFAULT_LIBRARIAN_SEARCH_LIMIT,
      maxLimit: MAX_LIBRARIAN_SEARCH_LIMIT,
    });
    const result = await listCatalogMaterials(
      env.DB as unknown as CatalogD1Database,
      query,
    );
    return librarianJson({
      schemaVersion: 2,
      success: true,
      items: result.items,
      page: {
        limit: query.limit,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
      },
      writesEnabled: access.writesEnabled,
    });
  } catch (error) {
    if (error instanceof CatalogQueryValidationError) {
      return librarianError(
        400,
        "invalid_catalog_query",
        error.message,
        access.writesEnabled,
        { [error.field]: error.message },
      );
    }
    return librarianError(
      503,
      "catalog_unavailable",
      "Не вдалося виконати пошук матеріалів.",
      access.writesEnabled,
    );
  }
}
