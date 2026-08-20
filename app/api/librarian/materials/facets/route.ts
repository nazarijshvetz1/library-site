import { env } from "cloudflare:workers";

import {
  type CatalogD1Database,
  listCatalogMaterialFacets,
} from "@/lib/catalog-d1";
import {
  authorizeLibrarianApi,
  librarianError,
  librarianJson,
} from "@/lib/librarian-api";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  const { access } = authorization.value;

  try {
    const facets = await listCatalogMaterialFacets(
      env.DB as unknown as CatalogD1Database,
    );
    return librarianJson({
      schemaVersion: 2,
      success: true,
      ...facets,
      writesEnabled: access.writesEnabled,
    });
  } catch {
    return librarianError(
      503,
      "catalog_facets_unavailable",
      "Не вдалося завантажити параметри каталогу.",
      access.writesEnabled,
    );
  }
}
