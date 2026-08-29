import { env } from "cloudflare:workers";

import {
  type CatalogD1Database,
  listCatalogMaterialFacets,
} from "@/lib/catalog-d1";

export const dynamic = "force-dynamic";

const PUBLIC_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=300, s-maxage=600, stale-while-revalidate=3600",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
} as const;

export async function GET(): Promise<Response> {
  try {
    const facets = await listCatalogMaterialFacets(
      env.DB as unknown as CatalogD1Database,
    );
    return Response.json({
      schemaVersion: 2,
      success: true,
      ...facets,
    }, { headers: PUBLIC_HEADERS });
  } catch {
    return Response.json({
      schemaVersion: 2,
      success: false,
      code: "catalog_facets_unavailable",
      error: "Параметри каталогу тимчасово недоступні.",
    }, {
      status: 503,
      headers: { ...PUBLIC_HEADERS, "Cache-Control": "no-store" },
    });
  }
}
