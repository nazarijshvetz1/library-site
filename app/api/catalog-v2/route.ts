import { env } from "cloudflare:workers";

import {
  CatalogDataIntegrityError,
  type CatalogD1Database,
  CatalogQueryValidationError,
  listCatalogMaterials,
  parseCatalogListQuery,
} from "@/lib/catalog-d1";

export const dynamic = "force-dynamic";

const PUBLIC_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=30, s-maxage=60, stale-while-revalidate=300",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
} as const;

export async function GET(request: Request): Promise<Response> {
  try {
    const query = parseCatalogListQuery(new URL(request.url));
    const result = await listCatalogMaterials(
      env.DB as unknown as CatalogD1Database,
      query,
    );
    return publicJson({
      schemaVersion: 2,
      success: true,
      items: result.items,
      page: {
        limit: query.limit,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
      },
    });
  } catch (error) {
    if (error instanceof CatalogQueryValidationError) {
      return publicJson(
        {
          schemaVersion: 2,
          success: false,
          code: "invalid_catalog_query",
          error: error.message,
          field: error.field,
        },
        400,
        "no-store",
      );
    }
    const code = error instanceof CatalogDataIntegrityError
      ? "catalog_data_invalid"
      : "catalog_unavailable";
    return publicJson(
      {
        schemaVersion: 2,
        success: false,
        code,
        error: "Каталог тимчасово недоступний. Спробуйте ще раз пізніше.",
      },
      503,
      "no-store",
    );
  }
}

function publicJson(body: unknown, status = 200, cacheControl?: string): Response {
  const headers = new Headers(PUBLIC_HEADERS);
  if (cacheControl) headers.set("Cache-Control", cacheControl);
  return Response.json(body, { status, headers });
}
