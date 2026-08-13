import { env } from "cloudflare:workers";

import {
  authorizeLibrarianApi,
  isSameOriginRequest,
  librarianError,
  librarianJson,
  readDraftJsonBody,
} from "@/lib/librarian-api";
import {
  TeacherRegistryError,
  type TeacherRegistryDatabase,
  type TeacherStatus,
} from "@/lib/teacher-registry-store";

export async function authorizeTeacherRegistryRead() {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization;
  return {
    ok: true as const,
    value: {
      ...authorization.value,
      db: env.DB as unknown as TeacherRegistryDatabase,
    },
  };
}

export async function authorizeTeacherRegistryWrite(request: Request) {
  const authorization = await authorizeTeacherRegistryRead();
  if (!authorization.ok) return authorization;
  if (!authorization.value.access.writesEnabled) {
    return {
      ok: false as const,
      response: librarianError(503, "writes_disabled", "Зміни карток учителів тимчасово вимкнено.", false),
    };
  }
  if (!isSameOriginRequest(request)) {
    return {
      ok: false as const,
      response: librarianError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.", true),
    };
  }
  return authorization;
}

export function parseTeacherListQuery(request: Request):
  | { ok: true; value: { status: TeacherStatus | "all"; attention: "all" | "orders" | "overdue" | "visits" | "access"; query: string; limit: number; cursor: string | null } }
  | { ok: false; response: Response } {
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "active";
  const attention = url.searchParams.get("attention") ?? "all";
  const query = (url.searchParams.get("q") ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
  const cursor = url.searchParams.get("cursor");
  const rawLimit = url.searchParams.get("limit") ?? "30";
  const limit = Number(rawLimit);
  const allowedKeys = new Set(["status", "attention", "q", "cursor", "limit"]);
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key)) return invalidList("Невідомий параметр списку.");
  }
  if (!(["active", "inactive", "all"] as const).includes(status as TeacherStatus | "all")) {
    return invalidList("Некоректний стан картки.");
  }
  if (!(["all", "orders", "overdue", "visits", "access"] as const).includes(
    attention as "all" | "orders" | "overdue" | "visits" | "access",
  )) return invalidList("Некоректний фільтр уваги.");
  if (query.length > 120 || (cursor !== null && (cursor.length < 1 || cursor.length > 512))
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return invalidList("Перевірте пошук, сторінку та кількість рядків.");
  }
  return {
    ok: true,
    value: {
      status: status as TeacherStatus | "all",
      attention: attention as "all" | "orders" | "overdue" | "visits" | "access",
      query,
      limit,
      cursor,
    },
  };
}

export function safeTeacherId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

export async function readTeacherRegistryBody(request: Request) {
  return readDraftJsonBody(request, true);
}

export function teacherRegistryJson(body: unknown, init: ResponseInit = {}) {
  return librarianJson(body, init);
}

export function teacherRegistryStoreError(error: unknown, fallbackCode: string): Response {
  if (error instanceof TeacherRegistryError) {
    return librarianJson({
      schemaVersion: 1,
      success: false,
      code: error.code,
      error: error.message,
      ...(error.details ? { details: error.details, ...error.details } : {}),
      writesEnabled: true,
    }, { status: error.status });
  }
  return librarianJson({
    schemaVersion: 1,
    success: false,
    code: fallbackCode,
    error: "Реєстр учителів тимчасово недоступний. Спробуйте ще раз.",
    writesEnabled: true,
  }, { status: 503 });
}

function invalidList(message: string) {
  return {
    ok: false as const,
    response: librarianJson({
      schemaVersion: 1,
      success: false,
      code: "validation_failed",
      error: message,
      writesEnabled: false,
    }, { status: 400 }),
  };
}
