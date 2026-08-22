import { env } from "cloudflare:workers";

import {
  createManagedLocation,
  listManagedLocations,
  LocationRegistryError,
  type LocationRegistryDatabase,
} from "@/lib/location-registry-store";
import {
  authorizeLibrarianApi,
  isSameOriginRequest,
  librarianError,
  librarianJson,
  readDraftJsonBody,
} from "@/lib/librarian-api";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  try {
    return librarianJson({
      schemaVersion: 1,
      success: true,
      locations: await listManagedLocations(env.DB as unknown as LocationRegistryDatabase),
      writesEnabled: authorization.value.access.writesEnabled,
    });
  } catch (error) {
    return locationError(error, authorization.value.access.writesEnabled, "Не вдалося завантажити кабінети.");
  }
}

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  if (!authorization.value.access.writesEnabled) return librarianError(503, "writes_disabled", "Зміни тимчасово вимкнено.", false);
  if (!isSameOriginRequest(request)) return librarianError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.", true);
  const body = await readDraftJsonBody(request, true);
  if (!body.ok) return body.response;
  const validated = createInput(body.value);
  if (!validated.ok) return librarianError(400, "validation_failed", "Перевірте дані кабінету.", true, validated.errors);
  try {
    const location = await createManagedLocation(
      env.DB as unknown as LocationRegistryDatabase,
      authorization.value.user,
      validated.value,
    );
    return librarianJson({ schemaVersion: 1, success: true, location, writesEnabled: true }, { status: 201 });
  } catch (error) {
    return locationError(error, true, "Не вдалося створити кабінет.");
  }
}

function createInput(input: Record<string, unknown>): { ok: true; value: { requestId: string; name: string; isPublic: boolean; sortOrder: number } } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  exactKeys(input, ["requestId", "name", "isPublic", "sortOrder"], errors);
  const requestId = String(input.requestId ?? "").trim();
  const name = String(input.name ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
  const sortOrder = typeof input.sortOrder === "number" ? input.sortOrder : Number.NaN;
  if (!UUID_PATTERN.test(requestId)) errors.requestId = "Некоректний номер запиту.";
  if (!name || name.length > 160) errors.name = "Введіть назву до 160 символів.";
  if (typeof input.isPublic !== "boolean") errors.isPublic = "Вкажіть видимість кабінету.";
  if (!Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 9999) errors.sortOrder = "Порядок має бути від 0 до 9999.";
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { requestId, name, isPublic: input.isPublic as boolean, sortOrder } };
}

function exactKeys(input: Record<string, unknown>, allowed: string[], errors: Record<string, string>): void {
  for (const key of Object.keys(input)) if (!allowed.includes(key)) errors[key] = "Невідоме поле.";
}

function locationError(error: unknown, writesEnabled: boolean, fallback: string): Response {
  if (error instanceof LocationRegistryError) return librarianError(error.status, error.code, error.message, writesEnabled, error.fieldErrors);
  return librarianError(503, "location_registry_unavailable", fallback, writesEnabled);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
