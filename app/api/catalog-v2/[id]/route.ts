import { env } from "cloudflare:workers";

import {
  type CatalogD1Database,
  getCatalogMaterialDetail,
  normalizeCatalogId,
} from "@/lib/catalog-d1";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  const { id: rawId } = await context.params;
  const id = normalizeCatalogId(rawId);
  if (!id) return publicError(400, "invalid_material_id", "Некоректний CAT-ID.");

  try {
    const material = await getCatalogMaterialDetail(
      env.DB as unknown as CatalogD1Database,
      id,
      "public",
    );
    if (!material) {
      return publicError(404, "material_not_found", "Матеріал не знайдено.");
    }
    return publicJson({ schemaVersion: 2, success: true, material });
  } catch {
    return publicError(
      503,
      "catalog_unavailable",
      "Картка матеріалу тимчасово недоступна.",
    );
  }
}

function publicJson(body: unknown): Response {
  return Response.json(body, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function publicError(status: number, code: string, error: string): Response {
  return Response.json(
    { schemaVersion: 2, success: false, code, error },
    {
      status,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": status === 404 ? "public, max-age=30" : "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
