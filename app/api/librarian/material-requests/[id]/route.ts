import { env } from "cloudflare:workers";

import { authorizeLibrarianApi } from "@/lib/librarian-api";
import {
  materialRequestError,
  materialRequestJson,
  materialRequestStoreError,
  readMaterialRequestJson,
  safePortalResourceId,
} from "@/lib/teacher-material-request-api";
import {
  applyLibrarianMaterialRequestAction,
  getMaterialRequest,
  type TeacherMaterialRequestDatabase,
} from "@/lib/teacher-material-request-store";
import { validateMaterialRequestActionInput } from "@/lib/teacher-material-request-validation";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  const { user, access } = authorization.value;
  if (!access.writesEnabled) {
    return materialRequestError(503, "writes_disabled", "Зміни заявок тимчасово вимкнено.", {
      writesEnabled: false,
    });
  }
  const { id } = await context.params;
  if (!safePortalResourceId(id)) {
    return materialRequestError(400, "validation_failed", "Некоректний номер заявки.", {
      writesEnabled: true,
    });
  }
  const body = await readMaterialRequestJson(request, true);
  if (!body.ok) return body.response;
  const validated = validateMaterialRequestActionInput(body.value);
  if (!validated.ok) {
    return materialRequestError(400, "validation_failed", "Перевірте дію та дані видачі.", {
      fieldErrors: validated.fieldErrors,
      writesEnabled: true,
    });
  }
  try {
    const db = env.DB as unknown as TeacherMaterialRequestDatabase;
    const result = await applyLibrarianMaterialRequestAction(
      db,
      user,
      id,
      validated.value,
    );
    const requestRecord = await getMaterialRequest(db, id);
    if (!requestRecord) {
      return materialRequestError(503, "mutation_result_unavailable", "Заявку змінено, але її не вдалося перечитати.", {
        writesEnabled: true,
      });
    }
    return materialRequestJson({
      schemaVersion: 1,
      success: true,
      request: requestRecord,
      ...(validated.value.action === "ready" && "loan" in result
        ? { loan: result.loan }
        : {}),
      writesEnabled: true,
    });
  } catch (error) {
    return materialRequestStoreError(error, "material_request_update_unavailable", true);
  }
}
