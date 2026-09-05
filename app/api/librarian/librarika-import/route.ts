import { env } from "cloudflare:workers";
import { authorizeLibrarianApi, isSameOriginRequest, librarianError, librarianJson } from "@/lib/librarian-api";
import { readBoundedJson } from "@/lib/bounded-json";
import { appendLibrarikaImportPart, LibrarikaImportError, readLibrarikaImportStatus, startLibrarikaImport, verifyLibrarikaImport, type ImportStart, type LibrarikaImportDatabase } from "@/lib/librarika-import-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  if (authorization.value.access.role !== "admin") return librarianError(403, "admin_required", "Перенесення доступне лише адміністратору.", false);
  try {
    const result = await readLibrarikaImportStatus(env.DB as unknown as LibrarikaImportDatabase, new URL(request.url).searchParams.get("runId") || "");
    return librarianJson({ success: true, result });
  } catch (error) { return importFailure(error); }
}

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  const { user, access } = authorization.value;
  if (access.role !== "admin" || !user.d1UserId) return librarianError(403, "admin_required", "Перенесення доступне лише адміністратору.", false);
  if (!access.writesEnabled) return librarianError(503, "writes_disabled", "Запис у бібліотеку тимчасово вимкнено.", false);
  if (!isSameOriginRequest(request)) return librarianError(403, "cross_origin_request", "Запит має надійти з цього сайту.", true);
  let body: Record<string, unknown>;
  try { body = await readBoundedJson(request, 180000); }
  catch { return librarianError(400, "invalid_body", "Некоректна або завелика частина плану.", true); }
  try {
    const db = env.DB as unknown as LibrarikaImportDatabase;
    const actor = { id: user.d1UserId, email: user.email || "" };
    let result: unknown;
    if (body.action === "start") result = await startLibrarikaImport(db, actor, body.input as ImportStart);
    else if (body.action === "part") result = await appendLibrarikaImportPart(db, actor, body.input as Parameters<typeof appendLibrarikaImportPart>[2]);
    else if (body.action === "verify") result = await verifyLibrarikaImport(db, actor, String(body.runId || ""));
    else return librarianError(400, "action_invalid", "Невідома дія перенесення.", true);
    return librarianJson({ success: true, result });
  } catch (error) { return importFailure(error); }
}

function importFailure(error: unknown): Response {
  if (error instanceof LibrarikaImportError) return librarianError(error.status, error.code, error.message, true);
  // Raw errors may contain source rows or SQL. Never return or log them.
  console.warn("librarika_import_failed");
  return librarianError(503, "import_unavailable", "Частину не підтверджено. Повторіть з тим самим файлом: уже підтверджені частини не дублюються.", true);
}
