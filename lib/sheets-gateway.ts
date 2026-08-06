import { getRuntimeString } from "@/lib/runtime-env";

export type LibrarianReferenceData = {
  teachers: Array<{ id: string; name: string; role: string; status: string }>;
  locations: Array<{ id: string; name: string; type: string; status: string }>;
  academicYears: Array<{
    id: string;
    label: string;
    startDate: string;
    endDate: string;
    status: string;
    notes: string;
  }>;
  classYears: Array<{
    id: string;
    academicYearId: string;
    academicYearLabel: string;
    cohortId: string;
    className: string;
    grade: number | null;
    code: string;
    teacherName: string;
    teacherUserId: string;
    locationName: string;
    locationId: string;
    startDate: string;
    endDate: string;
    status: string;
    actualClosedDate: string;
    notes: string;
  }>;
};

const MAX_GATEWAY_RESPONSE_BYTES = 2 * 1024 * 1024;
const GATEWAY_TIMEOUT_MS = 12_000;

export class GatewayNotConfiguredError extends Error {}

export class GatewayRejectedError extends Error {
  readonly code: string;
  readonly requestId: string;
  readonly draftId: string;

  constructor(code: string, message: string, requestId: string, draftId: string) {
    super(message);
    this.name = "GatewayRejectedError";
    this.code = code;
    this.requestId = requestId;
    this.draftId = draftId;
  }
}

export type DraftGatewayApplyInput = {
  requestId: string;
  draftId: string;
  revision: number;
  kind: string;
  payload: Record<string, unknown>;
};

export type DraftGatewayApplyResult = {
  requestId: string;
  draftId: string;
  kind: string;
  status: string;
  message: string;
  sheet: string;
  row: number | null;
  academicYearId: string;
  alreadyApplied: boolean;
  appliedAt: string;
};

type GatewayConfiguration = {
  url: string;
  secret: string;
};

function gatewayConfiguration(): GatewayConfiguration | null {
  const url = getRuntimeString("SHEETS_GATEWAY_URL");
  const secret = getRuntimeString("SHEETS_GATEWAY_SECRET");
  if (!url || !secret || secret.length < 32 || !validGatewayUrl(url)) return null;
  return { url, secret };
}

export function isSheetsGatewayConfigured(): boolean {
  return gatewayConfiguration() !== null;
}

export async function fetchLibrarianReferenceData(): Promise<{
  generatedAt: string;
  referenceData: LibrarianReferenceData;
}> {
  const payload = {};
  const body = await callSignedGateway("referenceData", payload);
  if (body.success !== true || !isRecord(body.referenceData)) {
    throw new Error(readText(body, "error") || "Gateway returned an invalid response");
  }
  return {
    generatedAt: readText(body, "generatedAt"),
    referenceData: normalizeReferenceData(body.referenceData),
  };
}

export async function applyLibrarianDraftGateway(
  input: DraftGatewayApplyInput,
): Promise<DraftGatewayApplyResult> {
  const payload = {
    request_id: input.requestId,
    draft_id: input.draftId,
    revision: input.revision,
    kind: input.kind,
    payload: input.payload,
  };
  const body = await callSignedGateway("applyDraft", payload);
  const responseRequestId = readText(body, "request_id", 64);
  const responseDraftId = readText(body, "draft_id", 64);
  const responseKind = readText(body, "kind", 80);

  if (
    responseRequestId !== input.requestId ||
    responseDraftId !== input.draftId ||
    responseKind !== input.kind
  ) {
    throw new Error("Gateway returned a response for another request");
  }
  if (body.success !== true) {
    throw new GatewayRejectedError(
      readText(body, "code", 80) || "apply_rejected",
      readText(body, "error", 500) || "Шлюз відхилив застосування чернетки.",
      responseRequestId,
      responseDraftId,
    );
  }

  const result = isRecord(body.result) ? body.result : {};
  const normalized: DraftGatewayApplyResult = {
    requestId: responseRequestId,
    draftId: responseDraftId,
    kind: responseKind,
    status: readText(result, "status", 80) || "applied",
    message: readText(result, "message", 500),
    sheet: readText(result, "sheet", 100),
    row: safePositiveInteger(result.row),
    academicYearId: readText(result, "academic_year_id", 64),
    alreadyApplied: result.already_applied === true,
    appliedAt: readText(body, "applied_at", 40),
  };
  if (
    input.kind === "academic-year.create" &&
    !validAcademicYearApplyResult(normalized, input.payload)
  ) {
    throw new Error("Gateway did not confirm the academic-year write");
  }
  return normalized;
}

async function callSignedGateway(
  action: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const configuration = gatewayConfiguration();
  if (!configuration) throw new GatewayNotConfiguredError("Gateway is not configured");

  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const payloadHash = await sha256WebSafe(JSON.stringify(payload));
  const signature = await hmacWebSafe(
    configuration.secret,
    [action, String(timestamp), nonce, payloadHash].join("\n"),
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
  try {
    const response = await fetch(configuration.url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action, timestamp, nonce, payload, signature }),
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Gateway HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_GATEWAY_RESPONSE_BYTES) {
      throw new Error("Gateway response is too large");
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_GATEWAY_RESPONSE_BYTES) {
      throw new Error("Gateway response is too large");
    }
    const body: unknown = JSON.parse(text);
    if (!isRecord(body)) throw new Error("Gateway returned an invalid response");
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeReferenceData(value: Record<string, unknown>): LibrarianReferenceData {
  return {
    teachers: sanitizeRows(value.teachers, 1000, (row) => ({
      id: readText(row, "id", 64),
      name: readText(row, "name", 200),
      role: readText(row, "role", 100),
      status: readText(row, "status", 100),
    })).filter((row) => /^USR-\d{3,}$/.test(row.id) && row.name),
    locations: sanitizeRows(value.locations, 1000, (row) => ({
      id: readText(row, "id", 64),
      name: readText(row, "name", 160),
      type: readText(row, "type", 100),
      status: readText(row, "status", 100),
    })).filter((row) => /^LOC-\d{3,}$/.test(row.id) && row.name && !/^(LOC-007|LOC-008)$/.test(row.id)),
    academicYears: sanitizeRows(value.academicYears, 100, (row) => ({
      id: readText(row, "id", 64),
      label: readText(row, "label", 20),
      startDate: readText(row, "startDate", 20),
      endDate: readText(row, "endDate", 20),
      status: readText(row, "status", 100),
      notes: readText(row, "notes", 500),
    })).filter((row) => /^YR-20\d{2}-20\d{2}$/.test(row.id)),
    classYears: sanitizeRows(value.classYears, 5000, (row) => ({
      id: readText(row, "id", 64),
      academicYearId: readText(row, "academicYearId", 64),
      academicYearLabel: readText(row, "academicYearLabel", 20),
      cohortId: readText(row, "cohortId", 64),
      className: readText(row, "className", 50),
      grade: safeGrade(row.grade),
      code: readText(row, "code", 20),
      teacherName: readText(row, "teacherName", 200),
      teacherUserId: readText(row, "teacherUserId", 64),
      locationName: readText(row, "locationName", 160),
      locationId: readText(row, "locationId", 64),
      startDate: readText(row, "startDate", 20),
      endDate: readText(row, "endDate", 20),
      status: readText(row, "status", 100),
      actualClosedDate: readText(row, "actualClosedDate", 20),
      notes: readText(row, "notes", 500),
    })).filter((row) => /^CY-20\d{2}-\d{3,}$/.test(row.id) && /^YR-20\d{2}-20\d{2}$/.test(row.academicYearId)),
  };
}

function sanitizeRows<T>(
  value: unknown,
  limit: number,
  mapper: (row: Record<string, unknown>) => T,
): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).slice(0, limit).map(mapper);
}

function readText(
  value: unknown,
  key?: string,
  maximum = 1000,
): string {
  const raw = key && isRecord(value) ? value[key] : value;
  return typeof raw === "string" ? raw.trim().slice(0, maximum) : "";
}

function safeGrade(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 11 ? number : null;
}

function safePositiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 1_000_000
    ? number
    : null;
}

function validAcademicYearApplyResult(
  result: DraftGatewayApplyResult,
  payload: Record<string, unknown>,
): boolean {
  const label = typeof payload.label === "string" ? payload.label : "";
  const expectedId = /^20\d{2}\/20\d{2}$/.test(label)
    ? `YR-${label.replace("/", "-")}`
    : "";
  return (
    ["applied", "already_applied"].includes(result.status) &&
    result.sheet === "Навчальні роки" &&
    result.row !== null &&
    result.academicYearId === expectedId &&
    /^\d{4}-\d{2}-\d{2}T/.test(result.appliedAt) &&
    (result.status === "already_applied" ? result.alreadyApplied : true)
  );
}

function validGatewayUrl(value: string): boolean {
  return /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(value);
}

async function sha256WebSafe(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToWebSafe(new Uint8Array(digest));
}

async function hmacWebSafe(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bytesToWebSafe(new Uint8Array(signature));
}

function bytesToWebSafe(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
