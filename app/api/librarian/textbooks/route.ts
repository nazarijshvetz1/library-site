import { env } from "cloudflare:workers";

import {
  authorizeLibrarianApi,
  isSameOriginRequest,
  librarianError,
  librarianJson,
  readDraftJsonBody,
} from "@/lib/librarian-api";
import {
  createTextbookAssignment,
  listManagedTextbooks,
  TextbookCatalogError,
  type TextbookDatabase,
} from "@/lib/textbook-catalog-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  const url = new URL(request.url);
  for (const key of url.searchParams.keys()) {
    if (key !== "grade" && key !== "q") {
      return librarianError(400, "invalid_textbook_query", "Невідомий параметр запиту.", authorization.value.access.writesEnabled);
    }
  }
  const grade = Number(url.searchParams.get("grade") ?? "1");
  const q = String(url.searchParams.get("q") ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!Number.isInteger(grade) || grade < 1 || grade > 11) {
    return librarianError(400, "invalid_grade", "Оберіть клас від 1 до 11.", authorization.value.access.writesEnabled, { grade: "Некоректний клас." });
  }
  if (q.length > 120) {
    return librarianError(400, "invalid_search", "Скоротіть пошуковий запит.", authorization.value.access.writesEnabled, { q: "Не більше 120 символів." });
  }
  try {
    const result = await listManagedTextbooks(
      env.DB as unknown as TextbookDatabase,
      { grade, q },
    );
    return librarianJson({
      schemaVersion: 1,
      success: true,
      ...result,
      writesEnabled: authorization.value.access.writesEnabled,
    });
  } catch (error) {
    return textbookError(error, authorization.value.access.writesEnabled, "Не вдалося завантажити список е-підручників.");
  }
}

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  if (!authorization.value.access.writesEnabled) {
    return librarianError(503, "writes_disabled", "Зміни тимчасово вимкнено.", false);
  }
  if (!isSameOriginRequest(request)) {
    return librarianError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.", true);
  }
  const body = await readDraftJsonBody(request, true);
  if (!body.ok) return body.response;
  const validated = createInput(body.value);
  if (!validated.ok) {
    return librarianError(400, "validation_failed", "Перевірте дані е-підручника.", true, validated.errors);
  }
  try {
    const textbook = await createTextbookAssignment(
      env.DB as unknown as TextbookDatabase,
      authorization.value.user,
      validated.value,
    );
    return librarianJson({ schemaVersion: 1, success: true, textbook, writesEnabled: true }, { status: 201 });
  } catch (error) {
    return textbookError(error, true, "Не вдалося додати е-підручник.");
  }
}

type CreateValue = { requestId: string; materialId: string; grade: number; publish: boolean };

function createInput(input: Record<string, unknown>): { ok: true; value: CreateValue } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  exactKeys(input, ["requestId", "materialId", "grade", "publish"], errors);
  const requestId = String(input.requestId ?? "").trim();
  const materialId = String(input.materialId ?? "").trim().toUpperCase();
  const grade = typeof input.grade === "number" ? input.grade : Number.NaN;
  if (!UUID_PATTERN.test(requestId)) errors.requestId = "Некоректний номер запиту.";
  if (!CAT_ID_PATTERN.test(materialId)) errors.materialId = "Некоректний номер матеріалу.";
  if (!Number.isInteger(grade) || grade < 1 || grade > 11) errors.grade = "Оберіть клас від 1 до 11.";
  if (typeof input.publish !== "boolean") errors.publish = "Вкажіть, чи публікувати підручник.";
  return Object.keys(errors).length
    ? { ok: false, errors }
    : { ok: true, value: { requestId, materialId, grade, publish: input.publish as boolean } };
}

function exactKeys(input: Record<string, unknown>, allowed: string[], errors: Record<string, string>): void {
  for (const key of Object.keys(input)) if (!allowed.includes(key)) errors[key] = "Невідоме поле.";
}

function textbookError(error: unknown, writesEnabled: boolean, fallback: string): Response {
  if (error instanceof TextbookCatalogError) {
    return librarianError(error.status, error.code, error.message, writesEnabled, error.fieldErrors);
  }
  return librarianError(503, "textbook_catalog_unavailable", fallback, writesEnabled);
}

const CAT_ID_PATTERN = /^CAT-\d{4,}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
