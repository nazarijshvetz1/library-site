import { env } from "cloudflare:workers";

import { authorizeLibrarianApi, librarianError, librarianJson } from "@/lib/librarian-api";
import {
  searchProcurementCatalog,
  type ProcurementPlanningDatabase,
  ProcurementPlanningError,
} from "@/lib/procurement-planning-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  try {
    const query = new URL(request.url).searchParams.get("q") ?? "";
    const materials = await searchProcurementCatalog(env.DB as unknown as ProcurementPlanningDatabase, query);
    return librarianJson({ schemaVersion: 1, success: true, materials, writesEnabled: authorization.value.access.writesEnabled });
  } catch (error) {
    if (error instanceof ProcurementPlanningError) return librarianError(error.status, error.code, error.message, authorization.value.access.writesEnabled);
    return librarianError(503, "procurement_catalog_unavailable", "Не вдалося виконати пошук у фонді.", authorization.value.access.writesEnabled);
  }
}
