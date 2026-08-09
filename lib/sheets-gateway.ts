import { getRuntimeString } from "@/lib/runtime-env";
import { validCoverPhotoKey } from "@/lib/cover-upload";
import { DRAFT_KINDS } from "@/lib/draft-validation";

export type LibrarianReferenceData = {
  materialVersions: Array<{ id: string; version: string }>;
  classYearVersions: Array<{ id: string; version: string }>;
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
const GATEWAY_TIMEOUT_MS = 45_000;
const MAX_GATEWAY_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class GatewayNotConfiguredError extends Error {}

export class GatewayRejectedError extends Error {
  readonly code: string;
  readonly requestId: string;
  readonly draftId: string;
  readonly retryable: boolean;
  readonly outcomeKnown: boolean;

  constructor(
    code: string,
    message: string,
    requestId: string,
    draftId: string,
    retryable: boolean,
    outcomeKnown: boolean,
  ) {
    super(message);
    this.name = "GatewayRejectedError";
    this.code = code;
    this.requestId = requestId;
    this.draftId = draftId;
    this.retryable = retryable;
    this.outcomeKnown = outcomeKnown;
  }
}

export type DraftGatewayActor = {
  id: string;
  email: string;
};

export type DraftGatewayAttachment = {
  key: string;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  originalName: string;
  byteLength: number;
  sha256: string;
  base64: string;
};

export type DraftGatewayApplyInput = {
  requestId: string;
  draftId: string;
  revision: number;
  kind: string;
  payload: Record<string, unknown>;
  actor: DraftGatewayActor;
  attachment?: DraftGatewayAttachment;
};

export type DraftGatewayMutation = {
  sheet: string;
  row: number;
  key: string;
  action: string;
  entityId: string;
};

export type DraftGatewayApplyResult = {
  requestId: string;
  draftId: string;
  kind: string;
  status: "applied" | "already_applied";
  message: string;
  alreadyApplied: boolean;
  appliedAt: string;
  mutations: DraftGatewayMutation[];
  entityIds: Record<string, string | string[]>;
  summary: Record<string, unknown>;
  cover: Record<string, unknown>;
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
  assertDraftGatewayInput(input);
  const payload = {
    request_id: input.requestId,
    draft_id: input.draftId,
    revision: input.revision,
    kind: input.kind,
    payload: input.payload,
    actor: {
      id: input.actor.id,
      email: input.actor.email,
    },
    ...(input.attachment ? {
      attachment: {
        key: input.attachment.key,
        contentType: input.attachment.contentType,
        originalName: input.attachment.originalName,
        byteLength: input.attachment.byteLength,
        sha256: input.attachment.sha256,
        base64: input.attachment.base64,
      },
    } : {}),
  };
  const body = await callSignedGateway("applyDraft", payload);
  const responseRequestId = readText(body, "request_id", 64);
  const responseDraftId = readText(body, "draft_id", 64);
  const responseKind = readText(body, "kind", 80);

  if (
    body.schemaVersion !== 1 ||
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
      body.retryable === true,
      body.outcome_known === true,
    );
  }

  const result = isRecord(body.result) ? body.result : {};
  const normalizedResult = normalizeApplyResult(result, input, body);
  if (!normalizedResult) {
    throw new Error("Gateway did not return a complete write confirmation");
  }
  return normalizedResult;
}

function normalizeApplyResult(
  result: Record<string, unknown>,
  input: DraftGatewayApplyInput,
  body: Record<string, unknown>,
): DraftGatewayApplyResult | null {
  const status = readText(result, "status", 80);
  const kind = readText(result, "kind", 80);
  const message = readText(result, "message", 500);
  const appliedAt = readText(body, "applied_at", 40);
  if (
    kind !== input.kind
    || (status !== "applied" && status !== "already_applied")
    || typeof result.already_applied !== "boolean"
    || result.already_applied !== (status === "already_applied")
    || !message
    || !/^\d{4}-\d{2}-\d{2}T/.test(appliedAt)
    || Number.isNaN(Date.parse(appliedAt))
    || !Array.isArray(result.mutations)
    || result.mutations.length > 250
    || !isRecord(result.entity_ids)
    || !isRecord(result.summary)
    || !isRecord(result.cover)
  ) return null;

  const mutations: DraftGatewayMutation[] = [];
  for (const raw of result.mutations) {
    if (!isRecord(raw)) return null;
    const sheet = readText(raw, "sheet", 100);
    const row = safePositiveInteger(raw.row);
    const key = readText(raw, "key", 160);
    const action = readText(raw, "action", 80);
    const entityId = readText(raw, "entity_id", 100);
    if (!sheet || row === null || !action) return null;
    mutations.push({ sheet, row, key, action, entityId });
  }

  const entityIds = normalizeEntityIds(result.entity_ids);
  const summary = normalizeJsonRecord(result.summary, 100, 4_000);
  const cover = normalizeJsonRecord(result.cover, 40, 4_000);
  if (!entityIds || !summary || !cover || !readText(cover, "status", 80)) return null;

  const normalized: DraftGatewayApplyResult = {
    requestId: input.requestId,
    draftId: input.draftId,
    kind,
    status,
    message,
    alreadyApplied: result.already_applied === true,
    appliedAt,
    mutations,
    entityIds,
    summary,
    cover,
  };
  return normalized;
}

function assertDraftGatewayInput(input: DraftGatewayApplyInput): void {
  if (!UUID_PATTERN.test(input.requestId) || !UUID_PATTERN.test(input.draftId)) {
    throw new Error("Invalid draft gateway identifiers");
  }
  if (!Number.isInteger(input.revision) || input.revision < 1 || input.revision > 2_147_483_647) {
    throw new Error("Invalid draft gateway revision");
  }
  if (!(DRAFT_KINDS as readonly string[]).includes(input.kind) || !isRecord(input.payload)) {
    throw new Error("Invalid draft gateway operation");
  }
  if (
    !safeIdentityValue(input.actor.id, 256)
    || !safeIdentityValue(input.actor.email, 320)
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.actor.email)
  ) {
    throw new Error("Invalid authenticated gateway actor");
  }

  const coverPayload = input.kind === "material.update" && isRecord(input.payload.changes)
    ? input.payload.changes
    : input.payload;
  const coverPhotoKey = typeof coverPayload.coverPhotoKey === "string"
    ? coverPayload.coverPhotoKey
    : "";
  const coverPhotoName = typeof coverPayload.coverPhotoName === "string"
    ? coverPayload.coverPhotoName
    : "";
  if (coverPhotoKey && !input.attachment) {
    throw new Error("The reviewed cover photo attachment is missing");
  }
  if (!input.attachment) return;
  if (
    (input.kind !== "material.create" && input.kind !== "material.update")
    || input.attachment.key !== coverPhotoKey
    || !validCoverPhotoKey(input.attachment.key)
    || (coverPhotoName && input.attachment.originalName !== coverPhotoName)
    || !safeIdentityValue(input.attachment.originalName, 180)
    || !["image/jpeg", "image/png", "image/webp"].includes(input.attachment.contentType)
    || !Number.isInteger(input.attachment.byteLength)
    || input.attachment.byteLength < 1
    || input.attachment.byteLength > MAX_GATEWAY_ATTACHMENT_BYTES
    || !/^[0-9a-f]{64}$/.test(input.attachment.sha256)
    || !isCanonicalBase64OfSize(input.attachment.base64, input.attachment.byteLength)
  ) {
    throw new Error("Invalid reviewed cover photo attachment");
  }
}

function safeIdentityValue(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && value.trim() === value
    && ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    });
}

function isCanonicalBase64OfSize(value: unknown, expectedBytes: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return false;
  if (value.length > Math.ceil(MAX_GATEWAY_ATTACHMENT_BYTES / 3) * 4 + 4) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding === expectedBytes;
}

function normalizeEntityIds(
  value: Record<string, unknown>,
): Record<string, string | string[]> | null {
  const normalized: Record<string, string | string[]> = {};
  const entries = Object.entries(value);
  if (entries.length > 100) return null;
  for (const [key, raw] of entries) {
    if (!/^[a-z][a-z0-9_]{0,63}$/i.test(key)) return null;
    if (typeof raw === "string" && safeIdentityValue(raw, 100)) {
      normalized[key] = raw;
      continue;
    }
    if (
      Array.isArray(raw)
      && raw.length <= 100
      && raw.every((item) => safeIdentityValue(item, 100))
    ) {
      normalized[key] = raw.slice() as string[];
      continue;
    }
    return null;
  }
  return normalized;
}

function normalizeJsonRecord(
  value: Record<string, unknown>,
  maximumKeys: number,
  maximumBytes: number,
): Record<string, unknown> | null {
  if (Object.keys(value).length > maximumKeys) return null;
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximumBytes) return null;
    return value;
  } catch {
    return null;
  }
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
    materialVersions: sanitizeRows(value.materialVersions, 5000, (row) => ({
      id: readText(row, "id", 64),
      version: readText(row, "version", 64),
    })).filter((row) => /^CAT-\d{4,}$/.test(row.id) && /^[A-Za-z0-9_-]{43}$/.test(row.version)),
    classYearVersions: sanitizeRows(value.classYearVersions, 5000, (row) => ({
      id: readText(row, "id", 64),
      version: readText(row, "version", 64),
    })).filter((row) => /^CY-20\d{2}-\d{3,}$/.test(row.id) && /^[A-Za-z0-9_-]{43}$/.test(row.version)),
    teachers: sanitizeRows(value.teachers, 1000, (row) => ({
      id: readText(row, "id", 64),
      name: readText(row, "name", 200),
      role: readText(row, "role", 100),
      status: readText(row, "status", 100),
    })).filter((row) => /^USR-\d{3,}$/.test(row.id) && row.name && /^(?:active|актив)/iu.test(row.status)),
    locations: sanitizeRows(value.locations, 1000, (row) => ({
      id: readText(row, "id", 64),
      name: readText(row, "name", 160),
      type: readText(row, "type", 100),
      status: readText(row, "status", 100),
    })).filter((row) => /^LOC-\d{3,}$/.test(row.id) && row.name && /^(?:active|актив)/iu.test(row.status) && !/^(LOC-007|LOC-008)$/.test(row.id)),
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
