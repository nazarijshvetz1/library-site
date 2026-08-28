import { env } from "cloudflare:workers";

import {
  authorizeLibrarianApi,
  isSameOriginRequest,
  librarianError,
  librarianJson,
  readDraftJsonBody,
} from "@/lib/librarian-api";
import {
  mutateTextbookAssignment,
  TextbookCatalogError,
  type TextbookDatabase,
} from "@/lib/textbook-catalog-store";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };
type UpdateValue = {
  requestId: string;
  expectedVersion: number;
  action: "publish" | "archive" | "restore" | "reorder";
  sortOrder?: number;
};

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  if (!authorization.value.access.writesEnabled) {
    return librarianError(503, "writes_disabled", "Зміни тимчасово вимкнено.", false);
  }
  if (!isSameOriginRequest(request)) {
    return librarianError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.", true);
  }
  const id = (await context.params).id;
  if (!TEXTBOOK_ID_PATTERN.test(id)) {
    return librarianError(400, "validation_failed", "Некоректний номер запису.", true);
  }
  const body = await readDraftJsonBody(request, true);
  if (!body.ok) return body.response;
  const validated = updateInput(body.value);
  if (!validated.ok) {
    return librarianError(400, "validation_failed", "Перевірте зміни е-підручника.", true, validated.errors);
  }
  try {
    const textbook = await mutateTextbookAssignment(
      env.DB as unknown as TextbookDatabase,
      authorization.value.user,
      id,
      validated.value,
    );
    return librarianJson({ schemaVersion: 1, success: true, textbook, writesEnabled: true });
  } catch (error) {
    if (error instanceof TextbookCatalogError) {
      return librarianError(error.status, error.code, error.message, true, error.fieldErrors);
    }
    return librarianError(503, "textbook_catalog_unavailable", "Не вдалося оновити е-підручник.", true);
  }
}

function updateInput(input: Record<string, unknown>): { ok: true; value: UpdateValue } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  exactKeys(input, ["requestId", "expectedVersion", "action", "sortOrder"], errors);
  const requestId = String(input.requestId ?? "").trim();
  const expectedVersion = typeof input.expectedVersion === "number" ? input.expectedVersion : Number.NaN;
  const action = input.action;
  const sortOrder = typeof input.sortOrder === "number" ? input.sortOrder : undefined;
  if (!UUID_PATTERN.test(requestId)) errors.requestId = "Некоректний номер запиту.";
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) errors.expectedVersion = "Оновіть список і повторіть дію.";
  if (action !== "publish" && action !== "archive" && action !== "restore" && action !== "reorder") {
    errors.action = "Некоректна дія.";
  }
  if (action === "reorder") {
    if (!Number.isInteger(sortOrder) || (sortOrder ?? -1) < 0 || (sortOrder ?? 0) > 999999) {
      errors.sortOrder = "Порядок має бути від 0 до 999999.";
    }
  } else if (input.sortOrder !== undefined) {
    errors.sortOrder = "Порядок можна змінити лише окремою дією.";
  }
  const value: UpdateValue = {
    requestId,
    expectedVersion,
    action: action as UpdateValue["action"],
    ...(action === "reorder" ? { sortOrder } : {}),
  };
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

function exactKeys(input: Record<string, unknown>, allowed: string[], errors: Record<string, string>): void {
  for (const key of Object.keys(input)) if (!allowed.includes(key)) errors[key] = "Невідоме поле.";
}

const TEXTBOOK_ID_PATTERN = /^TXT-[A-Za-z0-9][A-Za-z0-9._:-]{0,155}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
