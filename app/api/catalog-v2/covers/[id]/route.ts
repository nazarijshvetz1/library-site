import { env } from "cloudflare:workers";

import {
  catalogCoverCacheDecision,
  type CatalogD1Database,
  getCatalogCoverAsset,
  normalizeCatalogId,
} from "@/lib/catalog-d1";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { id: rawId } = await context.params;
  const id = normalizeCatalogId(rawId);
  if (!id) return imageError(400);

  try {
    const asset = await getCatalogCoverAsset(
      env.DB as unknown as CatalogD1Database,
      id,
    );
    if (!asset) return imageError(404);
    if (asset.externalUrl) {
      return new Response(null, {
        status: 302,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=300, s-maxage=3600",
          Location: asset.externalUrl,
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    if (asset.storageProvider !== "r2" || !asset.storageKey) {
      return imageError(404);
    }

    const cache = catalogCoverCacheDecision(asset.sha256, request.url);
    if (cache.redirect) {
      return canonicalCoverRedirect(id, cache.canonicalVersion);
    }

    const object = await env.COVER_UPLOADS.get(asset.storageKey);
    if (!object) return imageError(404);
    const etag = object.httpEtag || (asset.sha256 ? `"${asset.sha256}"` : "");
    if (etag && request.headers.get("If-None-Match") === etag) {
      return new Response(null, {
        status: 304,
        headers: imageHeaders(asset.mimeType, etag, object.size, cache.immutable),
      });
    }
    return new Response(object.body, {
      headers: imageHeaders(asset.mimeType, etag, object.size, cache.immutable),
    });
  } catch {
    return imageError(503);
  }
}

function imageHeaders(
  mimeType: string,
  etag: string,
  size: number,
  immutable: boolean,
): Headers {
  const headers = new Headers({
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": immutable
      ? "public, max-age=31536000, immutable"
      : "no-store",
    "Content-Disposition": "inline",
    "Content-Type": mimeType,
    "X-Content-Type-Options": "nosniff",
  });
  if (etag) headers.set("ETag", etag);
  if (Number.isInteger(size) && size >= 0) headers.set("Content-Length", String(size));
  return headers;
}

function canonicalCoverRedirect(id: string, version: string): Response {
  return new Response(null, {
    status: 307,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      Location: `/api/catalog-v2/covers/${encodeURIComponent(id)}?v=${version}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function imageError(status: number): Response {
  return new Response(null, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": status === 404 ? "public, max-age=30" : "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
