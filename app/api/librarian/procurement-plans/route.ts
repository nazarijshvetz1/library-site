import { env } from "cloudflare:workers";

import {
  authorizeLibrarianApi,
  isSameOriginRequest,
  librarianError,
  librarianJson,
  readDraftJsonBody,
} from "@/lib/librarian-api";
import {
  createProcurementPlan,
  listProcurementPlans,
  type ProcurementPlanningDatabase,
  ProcurementPlanningError,
} from "@/lib/procurement-planning-store";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  try {
    const plans = await listProcurementPlans(env.DB as unknown as ProcurementPlanningDatabase);
    return librarianJson({ schemaVersion: 1, success: true, plans, writesEnabled: authorization.value.access.writesEnabled });
  } catch (error) {
    return planningError(error, authorization.value.access.writesEnabled);
  }
}

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  const { user, access } = authorization.value;
  if (!access.writesEnabled) return librarianError(503, "writes_disabled", "Створення плану тимчасово вимкнено.", false);
  if (!isSameOriginRequest(request)) return librarianError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.", true);
  const body = await readDraftJsonBody(request, true);
  if (!body.ok) return body.response;
  try {
    const plan = await createProcurementPlan(env.DB as unknown as ProcurementPlanningDatabase, user, {
      academicYearLabel: String(body.value.academicYearLabel ?? ""),
      title: String(body.value.title ?? ""),
      defaultReserve: Number(body.value.defaultReserve ?? 0),
      notes: String(body.value.notes ?? ""),
    });
    return librarianJson({ schemaVersion: 1, success: true, plan, writesEnabled: true }, { status: 201 });
  } catch (error) {
    return planningError(error, true);
  }
}

function planningError(error: unknown, writesEnabled: boolean): Response {
  if (error instanceof ProcurementPlanningError) return librarianError(error.status, error.code, error.message, writesEnabled);
  return librarianError(503, "procurement_planning_unavailable", "Не вдалося завантажити план комплектування.", writesEnabled);
}
