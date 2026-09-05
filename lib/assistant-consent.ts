import type { VisitD1Database } from "./visit-schedule-store.ts";
import { VisitScheduleError } from "./visit-schedule-store.ts";
import { ASSISTANT_CONSENT_VERSION, type AssistantConsent } from "./assistant-contract.ts";
import { hangupAssistantCall } from "./assistant-store.ts";

export async function readAssistantConsent(db: VisitD1Database, actorKey: string): Promise<AssistantConsent> {
  const row = await db.prepare("SELECT version,accepted_at,revoked_at,revision FROM assistant_consents WHERE actor_key=?")
    .bind(actorKey).first<{ version: string; accepted_at: string | null; revoked_at: string | null; revision: number }>();
  return { accepted: Boolean(row?.accepted_at && !row.revoked_at && row.version === ASSISTANT_CONSENT_VERSION),
    version: ASSISTANT_CONSENT_VERSION, revision: row?.revision ?? 0 };
}

export async function requireAssistantConsent(db: VisitD1Database, actorKey: string): Promise<AssistantConsent> {
  const consent = await readAssistantConsent(db, actorKey);
  if (!consent.accepted) throw new VisitScheduleError("ai_consent_required", 403, "Підтвердьте згоду на обробку голосу й тексту. Вона збережеться у вашому обліковому записі.");
  return consent;
}

// Only an explicit consent control can call this; never accept a flag on a session start.
export async function acceptAssistantConsent(db: VisitD1Database, actorKey: string, version: unknown, revision: unknown, now = new Date()): Promise<AssistantConsent> {
  if (version !== ASSISTANT_CONSENT_VERSION || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)
    throw new VisitScheduleError("ai_consent_changed", 409, "Умови згоди оновлено. Перевірте доступ і підтвердьте їх знову.");
  const row = await db.prepare(`INSERT INTO assistant_consents(actor_key,version,accepted_at,revoked_at,revision)
    SELECT ?,?,?,NULL,1 WHERE ?=0 OR EXISTS(SELECT 1 FROM assistant_consents WHERE actor_key=? AND revision=?)
    ON CONFLICT(actor_key) DO UPDATE SET version=excluded.version,accepted_at=excluded.accepted_at,revoked_at=NULL,revision=assistant_consents.revision+1
    WHERE assistant_consents.revision=? RETURNING revision`)
    .bind(actorKey, ASSISTANT_CONSENT_VERSION, now.toISOString(), revision, actorKey, revision, revision).first<{ revision: number }>();
  if (!row) throw new VisitScheduleError("ai_consent_changed", 409, "Згоду вже змінено в іншій вкладці. Перевірте доступ і повторіть дію.");
  return { accepted: true, version: ASSISTANT_CONSENT_VERSION, revision: row.revision };
}

export async function revokeAssistantConsent(db: VisitD1Database, actorKey: string, key?: string, now = new Date(), fetcher: typeof fetch = fetch): Promise<AssistantConsent> {
  const stamp = now.toISOString();
  // Blocking new starts and closing existing sessions must commit together.
  const results = await db.batch([
    db.prepare(`INSERT INTO assistant_consents(actor_key,version,accepted_at,revoked_at,revision) VALUES(?,?,NULL,?,1)
      ON CONFLICT(actor_key) DO UPDATE SET revoked_at=excluded.revoked_at,revision=assistant_consents.revision+1 RETURNING revision`)
      .bind(actorKey, ASSISTANT_CONSENT_VERSION, stamp),
    db.prepare(`UPDATE assistant_sessions SET closed_at=COALESCE(closed_at,?)
      WHERE actor_key=? AND (closed_at IS NULL OR provider_call_id IS NOT NULL) RETURNING id,provider_call_id`).bind(stamp, actorKey),
  ]);
  const calls = results[1].results as Array<{ id: string; provider_call_id: string | null }> | undefined;
  if (key) await Promise.allSettled((calls ?? []).filter((row) => row.provider_call_id)
    .map((row) => hangupAssistantCall(db, row.id, row.provider_call_id!, key, fetcher)));
  const revision = (results[0].results?.[0] as { revision: number } | undefined)?.revision ?? 0;
  return { accepted: false, version: ASSISTANT_CONSENT_VERSION, revision };
}
