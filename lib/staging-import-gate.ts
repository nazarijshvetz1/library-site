const MAX_GATE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const EXPIRED_CLEANUP_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

export function isStagingImportGateActive(expiresAt: string, nowMs = Date.now()): boolean {
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
}

export function isImportRunExpiryAccepted(
  runExpiresAt: string,
  gateExpiresAt: string,
  allowExpired: boolean,
  nowMs = Date.now(),
): boolean {
  if (runExpiresAt !== gateExpiresAt) return false;
  const expiresAtMs = Date.parse(runExpiresAt);
  return Number.isFinite(expiresAtMs) && (allowExpired || expiresAtMs > nowMs);
}

export type StagingImportGateInput = {
  appEnv: string | null;
  enabled: boolean;
  allowedOrigin: string | null;
  pinnedPlanSha256: string | null;
  expiresAt: string | null;
  requestUrl: string;
  submittedOrigin: string | null;
  nowMs?: number;
  allowExpiredGate?: boolean;
};

export type StagingImportGateResult =
  | {
    ok: true;
    allowedOrigin: string;
    pinnedPlanSha256: string;
    expiresAt: string;
  }
  | {
    ok: false;
    status: 403 | 503;
    code:
      | "staging_import_disabled"
      | "staging_import_gate_invalid"
      | "staging_import_origin_denied";
  };

/** Pure, Worker-safe fail-closed gate used before any D1 or R2 access. */
export function evaluateStagingImportGate(
  input: StagingImportGateInput,
): StagingImportGateResult {
  if (input.appEnv !== "staging" || !input.enabled) {
    return { ok: false, status: 503, code: "staging_import_disabled" };
  }

  const allowedOrigin = parseOrigin(input.allowedOrigin);
  const pinnedPlanSha256 = input.pinnedPlanSha256;
  const expiresAtMs = input.expiresAt ? Date.parse(input.expiresAt) : Number.NaN;
  const now = input.nowMs ?? Date.now();
  const expiryInvalid = input.allowExpiredGate
    ? (expiresAtMs - now > MAX_GATE_LIFETIME_MS || now - expiresAtMs > EXPIRED_CLEANUP_GRACE_MS)
    : (expiresAtMs <= now || expiresAtMs - now > MAX_GATE_LIFETIME_MS);
  if (!allowedOrigin
    || !allowedOrigin.startsWith("https://")
    || !pinnedPlanSha256
    || !/^[a-f0-9]{64}$/u.test(pinnedPlanSha256)
    || !input.expiresAt
    || !Number.isFinite(expiresAtMs)
    || expiryInvalid) {
    return { ok: false, status: 503, code: "staging_import_gate_invalid" };
  }

  const requestOrigin = safeRequestOrigin(input.requestUrl);
  const submittedOrigin = parseOrigin(input.submittedOrigin);
  if (requestOrigin !== allowedOrigin || submittedOrigin !== allowedOrigin) {
    return { ok: false, status: 403, code: "staging_import_origin_denied" };
  }

  return {
    ok: true,
    allowedOrigin,
    pinnedPlanSha256,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

function parseOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function safeRequestOrigin(value: string): string | null {
  try { return new URL(value).origin; } catch { return null; }
}
