import { env } from "cloudflare:workers";

import { authorizeLibrarianApi, librarianError } from "@/lib/librarian-api";
import { createProcurementPlanExcel } from "@/lib/procurement-planning-excel";
import {
  readLatestProcurementPlanSnapshot,
  readProcurementPlan,
  type ProcurementPlanningDatabase,
  ProcurementPlanningError,
} from "@/lib/procurement-planning-store";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ planId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  const planId = decodeURIComponent((await context.params).planId).trim();
  if (!/^PPLAN-[A-Za-z0-9-]{10,100}$/u.test(planId)) return librarianError(400, "invalid_plan_id", "Некоректний ідентифікатор плану.", authorization.value.access.writesEnabled);
  try {
    const snapshot = new URL(request.url).searchParams.get("snapshot");
    if (snapshot && snapshot !== "latest") return librarianError(400, "invalid_snapshot", "Некоректна версія плану.", authorization.value.access.writesEnabled);
    const db = env.DB as unknown as ProcurementPlanningDatabase;
    const plan = snapshot === "latest"
      ? await readLatestProcurementPlanSnapshot(db, planId)
      : await readProcurementPlan(db, planId);
    const workbook = createProcurementPlanExcel(plan);
    return new Response(workbook.bytes, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(workbook.fileName)}`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof ProcurementPlanningError) return librarianError(error.status, error.code, error.message, authorization.value.access.writesEnabled);
    return librarianError(503, "procurement_excel_unavailable", "Не вдалося сформувати Excel-файл.", authorization.value.access.writesEnabled);
  }
}
