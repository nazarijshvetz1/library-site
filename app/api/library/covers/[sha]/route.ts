import { LIBRARIKA_CATALOG_URL } from "@/lib/librarika";

export const dynamic = "force-dynamic";

function retiredImportedCover(): Response {
  return Response.json(
    {
      success: false,
      error: "librarika_authoritative",
      message: "Імпортовані обкладинки художньої та наукової літератури більше не публікуються локально.",
      catalogUrl: LIBRARIKA_CATALOG_URL,
    },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}

export const GET = retiredImportedCover;
export const HEAD = retiredImportedCover;
export const POST = retiredImportedCover;
export const PUT = retiredImportedCover;
export const PATCH = retiredImportedCover;
export const DELETE = retiredImportedCover;
