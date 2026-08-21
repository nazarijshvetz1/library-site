import { env } from "cloudflare:workers";

import {
  deleteManagedLocation,
  LocationRegistryError,
  type LocationRegistryDatabase,
  updateManagedLocation,
} from "@/lib/location-registry-store";
import {
  authorizeLibrarianApi,
  isSameOriginRequest,
  librarianError,
  librarianJson,
  readDraftJsonBody,
} from "@/lib/librarian-api";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  if (!authorization.value.access.writesEnabled) return librarianError(503, "writes_disabled", "Зміни тимчасово вимкнено.", false);
  if (!isSameOriginRequest(request)) return librarianError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.", true);
  const id = (await context.params).id;
  if (!LOCATION_ID_PATTERN.test(id)) return librarianError(400, "validation_failed", "Некоректний номер кабінету.", true);
  const body = await readDraftJsonBody(request, true);
  if (!body.ok) return body.response;
  const validated = updateInput(body.value);
  if (!validated.ok) return librarianError(400, "validation_failed", "Перевірте зміни кабінету.", true, validated.errors);
  try {
    const location = await updateManagedLocation(env.DB as unknown as LocationRegistryDatabase, authorization.value.user, id, validated.value);
    return librarianJson({ schemaVersion: 1, success: true, location, writesEnabled: true });
  } catch (error) {
    return locationError(error, "Не вдалося оновити кабінет.");
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  if (!authorization.value.access.writesEnabled) return librarianError(503, "writes_disabled", "Зміни тимчасово вимкнено.", false);
  if (!isSameOriginRequest(request)) return librarianError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.", true);
  const id = (await context.params).id;
  if (!LOCATION_ID_PATTERN.test(id)) return librarianError(400, "validation_failed", "Некоректний номер кабінету.", true);
  const body = await readDraftJsonBody(request, true);
  if (!body.ok) return body.response;
  const validated = deleteInput(body.value);
  if (!validated.ok) return librarianError(400, "validation_failed", "Підтвердьте видалення кабінету.", true, validated.errors);
  try {
    const result = await deleteManagedLocation(env.DB as unknown as LocationRegistryDatabase, authorization.value.user, id, validated.value);
    return librarianJson({ schemaVersion: 1, success: true, result, writesEnabled: true });
  } catch (error) {
    return locationError(error, "Не вдалося видалити кабінет.");
  }
}

type UpdateValue = { requestId: string; expectedUpdatedAt: string; changes: { name?: string; isPublic?: boolean; sortOrder?: number; status?: "active" | "inactive" } };

function updateInput(input: Record<string, unknown>): { ok: true; value: UpdateValue } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  exactKeys(input, ["requestId", "expectedUpdatedAt", "changes"], errors);
  const requestId = String(input.requestId ?? "").trim();
  const expectedUpdatedAt = String(input.expectedUpdatedAt ?? "").trim();
  const raw = input.changes && typeof input.changes === "object" && !Array.isArray(input.changes) ? input.changes as Record<string, unknown> : null;
  const changes: UpdateValue["changes"] = {};
  if (raw) exactKeys(raw, ["name", "isPublic", "sortOrder", "status"], errors);
  if (!UUID_PATTERN.test(requestId)) errors.requestId = "Некоректний номер запиту.";
  if (!validTimestamp(expectedUpdatedAt)) errors.expectedUpdatedAt = "Оновіть список і повторіть дію.";
  if (!raw) errors.changes = "Не вказано змін.";
  if (raw && "name" in raw) {
    const name = String(raw.name ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
    if (!name || name.length > 160) errors.name = "Введіть назву до 160 символів."; else changes.name = name;
  }
  if (raw && "isPublic" in raw) {
    if (typeof raw.isPublic !== "boolean") errors.isPublic = "Некоректна видимість."; else changes.isPublic = raw.isPublic;
  }
  if (raw && "sortOrder" in raw) {
    const value = typeof raw.sortOrder === "number" ? raw.sortOrder : Number.NaN;
    if (!Number.isSafeInteger(value) || value < 0 || value > 9999) errors.sortOrder = "Порядок має бути від 0 до 9999."; else changes.sortOrder = value;
  }
  if (raw && "status" in raw) {
    if (raw.status !== "active" && raw.status !== "inactive") errors.status = "Некоректний стан."; else changes.status = raw.status;
  }
  if (raw && !Object.keys(changes).length && !Object.keys(errors).length) errors.changes = "Не вказано змін.";
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { requestId, expectedUpdatedAt, changes } };
}

function deleteInput(input: Record<string, unknown>): { ok: true; value: { requestId: string; expectedUpdatedAt: string; confirmation: string } } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  exactKeys(input, ["requestId", "expectedUpdatedAt", "confirmation"], errors);
  const requestId = String(input.requestId ?? "").trim();
  const expectedUpdatedAt = String(input.expectedUpdatedAt ?? "").trim();
  const confirmation = String(input.confirmation ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
  if (!UUID_PATTERN.test(requestId)) errors.requestId = "Некоректний номер запиту.";
  if (!validTimestamp(expectedUpdatedAt)) errors.expectedUpdatedAt = "Оновіть список і повторіть дію.";
  if (!confirmation || confirmation.length > 160) errors.confirmation = "Введіть точну назву кабінету.";
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { requestId, expectedUpdatedAt, confirmation } };
}

function exactKeys(input: Record<string, unknown>, allowed: string[], errors: Record<string, string>): void {
  for (const key of Object.keys(input)) if (!allowed.includes(key)) errors[key] = "Невідоме поле.";
}

function locationError(error: unknown, fallback: string): Response {
  if (error instanceof LocationRegistryError) return librarianError(error.status, error.code, error.message, true, error.fieldErrors);
  return librarianError(503, "location_registry_unavailable", fallback, true);
}

function validTimestamp(value: string): boolean { return value.length <= 40 && !Number.isNaN(Date.parse(value)); }
const LOCATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
