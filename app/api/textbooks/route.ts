import { env } from "cloudflare:workers";

import {
  listPublicTextbooks,
  TextbookCatalogError,
  type TextbookDatabase,
} from "@/lib/textbook-catalog-store";

export const dynamic = "force-dynamic";

const PUBLIC_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=30, s-maxage=60, stale-while-revalidate=180",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
} as const;

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  for (const key of url.searchParams.keys()) {
    if (key !== "grade") {
      return publicError(400, "invalid_textbook_query", "Невідомий параметр запиту.");
    }
  }
  const grade = Number(url.searchParams.get("grade"));
  if (!Number.isInteger(grade) || grade < 1 || grade > 11) {
    return publicError(400, "invalid_grade", "Оберіть клас від 1 до 11.");
  }
  try {
    const result = await listPublicTextbooks(
      env.DB as unknown as TextbookDatabase,
      grade,
    );
    return publicJson({
      schemaVersion: 1,
      success: true,
      academicYear: result.academicYear,
      grade,
      items: result.items,
      count: result.items.length,
    });
  } catch (error) {
    if (error instanceof TextbookCatalogError) {
      return publicError(error.status, error.code, error.message);
    }
    return publicError(503, "textbook_catalog_unavailable", "Е-підручники тимчасово недоступні. Спробуйте ще раз пізніше.");
  }
}

function publicError(status: number, code: string, message: string): Response {
  return publicJson(
    { schemaVersion: 1, success: false, code, error: message },
    status,
    "no-store",
  );
}

function publicJson(body: unknown, status = 200, cacheControl?: string): Response {
  const headers = new Headers(PUBLIC_HEADERS);
  if (cacheControl) headers.set("Cache-Control", cacheControl);
  return Response.json(body, { status, headers });
}
