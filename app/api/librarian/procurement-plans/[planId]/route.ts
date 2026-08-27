import { env } from "cloudflare:workers";

import {
  authorizeLibrarianApi,
  isSameOriginRequest,
  librarianError,
  librarianJson,
  readDraftJsonBody,
} from "@/lib/librarian-api";
import {
  mutateProcurementPlan,
  readProcurementPlan,
  type ProcurementPlanningDatabase,
  ProcurementPlanningError,
} from "@/lib/procurement-planning-store";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ planId: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  const planId = validPlanId((await context.params).planId);
  if (!planId) return librarianError(400, "invalid_plan_id", "Некоректний ідентифікатор плану.", authorization.value.access.writesEnabled);
  try {
    const plan = await readProcurementPlan(env.DB as unknown as ProcurementPlanningDatabase, planId);
    return librarianJson({ schemaVersion: 1, success: true, plan, writesEnabled: authorization.value.access.writesEnabled });
  } catch (error) {
    return planningError(error, authorization.value.access.writesEnabled);
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  const { user, access } = authorization.value;
  if (!access.writesEnabled) return librarianError(503, "writes_disabled", "Збереження плану тимчасово вимкнено.", false);
  if (!isSameOriginRequest(request)) return librarianError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.", true);
  const planId = validPlanId((await context.params).planId);
  if (!planId) return librarianError(400, "invalid_plan_id", "Некоректний ідентифікатор плану.", true);
  const body = await readDraftJsonBody(request, true);
  if (!body.ok) return body.response;
  try {
    const plan = await mutateProcurementPlan(env.DB as unknown as ProcurementPlanningDatabase, user, planId, body.value);
    return librarianJson({ schemaVersion: 1, success: true, plan, writesEnabled: true });
  } catch (error) {
    return planningError(error, true);
  }
}

function validPlanId(value: string): string | null {
  const normalized = decodeURIComponent(value).trim();
  return /^PPLAN-[A-Za-z0-9-]{10,100}$/u.test(normalized) ? normalized : null;
}

function planningError(error: unknown, writesEnabled: boolean): Response {
  if (error instanceof ProcurementPlanningError) return librarianError(error.status, error.code, error.message, writesEnabled);
  return librarianError(503, "procurement_planning_unavailable", "Не вдалося змінити план комплектування.", writesEnabled);
}
