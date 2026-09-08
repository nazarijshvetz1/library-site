import { publicCatalogCoverResponse } from "@/lib/public-catalog-cover";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { id } = await context.params;
  return publicCatalogCoverResponse(
    request,
    id,
    "literature",
    "/api/library/material-covers",
  );
}
