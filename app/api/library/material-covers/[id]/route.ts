import { LIBRARIKA_CATALOG_URL } from "@/lib/librarika";

export const dynamic = "force-dynamic";

function retiredLiteratureCover(): Response {
  return Response.json(
    {
      success: false,
      error: "librarika_authoritative",
      message: "Обкладинки художньої та наукової літератури доступні в Librarika.",
      catalogUrl: LIBRARIKA_CATALOG_URL,
    },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}

export const GET = retiredLiteratureCover;
export const HEAD = retiredLiteratureCover;
export const POST = retiredLiteratureCover;
export const PUT = retiredLiteratureCover;
export const PATCH = retiredLiteratureCover;
export const DELETE = retiredLiteratureCover;
