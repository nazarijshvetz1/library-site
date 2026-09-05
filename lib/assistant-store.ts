import type { VisitD1Database, VisitHours, VisitBooking } from "./visit-schedule-store.ts";
import { VisitScheduleError, createVisitBooking } from "./visit-schedule-store.ts";
import type { VisitTeacherIdentity } from "./visit-teacher-auth.ts";
import { isoWeekday, addDays, kyivLocalNow, validateVisitBookingCreateInput, type VisitBookingCreateInput } from "./visit-schedule-validation.ts";
import type { AssistantVisitPreview } from "./assistant-contract.ts";

export const ASSISTANT_SESSION_MINUTES = 10;
export type AssistantSession = { id: string; actor_key: string; expires_at: string; provider_call_id: string | null; closed_at: string | null };
type Draft = { id: string; actor_key: string; session_id: string; payload_json: string; class_label: string; expires_at: string; confirmed_at: string | null; result_json: string | null };

export async function createAssistantSession(db: VisitD1Database, actorKey: string, dailyLimit: number, now = new Date()): Promise<AssistantSession> {
  const id = crypto.randomUUID();
  const createdAt = now.toISOString();
  const day = kyivLocalNow(now).date;
  const expiresAt = new Date(now.getTime() + ASSISTANT_SESSION_MINUTES * 60_000).toISOString();
  const row = await db.prepare(`INSERT INTO assistant_sessions(id,actor_key,created_day,created_at,expires_at)
    SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM assistant_sessions WHERE actor_key=? AND created_day=?) < ?
    AND (SELECT COUNT(*) FROM assistant_sessions WHERE actor_key=? AND closed_at IS NULL AND expires_at>?) < 2
    RETURNING id,actor_key,expires_at,provider_call_id,closed_at`)
    .bind(id, actorKey, day, createdAt, expiresAt, actorKey, day, dailyLimit, actorKey, createdAt).first<AssistantSession>();
  if (!row) throw new VisitScheduleError("assistant_session_limit", 429, "Досягнуто ліміт розмов: завершіть інші сеанси або спробуйте пізніше. Звичайні розділи бібліотеки працюють.");
  return row;
}

export async function requireAssistantSession(db: VisitD1Database, id: string, actorKey: string, counter?: "tool_calls" | "text_turns", now = new Date()): Promise<AssistantSession> {
  const limit = counter === "text_turns" ? 24 : 100;
  const predicate = "id=? AND actor_key=? AND closed_at IS NULL AND expires_at>?";
  const row = counter
    ? await db.prepare(`UPDATE assistant_sessions SET ${counter}=${counter}+1 WHERE ${predicate} AND ${counter}<? RETURNING id,actor_key,expires_at,provider_call_id,closed_at`)
      .bind(id, actorKey, now.toISOString(), limit).first<AssistantSession>()
    : await db.prepare(`SELECT id,actor_key,expires_at,provider_call_id,closed_at FROM assistant_sessions WHERE ${predicate}`)
      .bind(id, actorKey, now.toISOString()).first<AssistantSession>();
  if (!row) throw new VisitScheduleError("assistant_session_ended", 403, "Сеанс завершено або його ліміт вичерпано. Почніть нову розмову.");
  return row;
}

export function validateAssistantVisit(input: Record<string, unknown>, requestId: string): VisitBookingCreateInput {
  const allowed = new Set(["date", "startTime", "endTime", "classYearId", "purpose"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new VisitScheduleError("invalid_tool_arguments", 400, "Некоректні поля запису.");
  try {
    // This validates a proposal only. Public consent is obtained exclusively by the confirmation UI.
    const result = validateVisitBookingCreateInput({ ...input, requestId, publicDisplayConsent: true });
    if (!result.ok) throw new Error(Object.values(result.fieldErrors).join(" "));
    return result.value;
  } catch {
    throw new VisitScheduleError("invalid_visit_proposal", 400, "Уточніть дату, початок, завершення, клас або особистий візит. Тривалість 20–240 хв, час кратний 5 хв.");
  }
}

export function freeVisitIntervals(schedule: { hours: VisitHours; busy: Array<{ date: string; startTime: string; endTime: string }>; closures: Array<{ date: string; startTime: string; endTime: string }> }, from: string, days: number, duration: number, now = kyivLocalNow()): Array<{ date: string; startTime: string; endTime: string }> {
  if (!Number.isInteger(duration) || duration < 20 || duration > 240 || duration % 5) throw new VisitScheduleError("invalid_duration", 400, "Укажіть тривалість 20–240 хв, кратну 5 хв.");
  const result: Array<{ date: string; startTime: string; endTime: string }> = [];
  const mins = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const clock = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    for (const hours of schedule.hours[String(isoWeekday(date))] ?? []) {
      let start: number | null = null;
      const finish = mins(hours.endTime);
      for (let minute = mins(hours.startTime); minute <= finish; minute += 5) {
        const time = clock(minute);
        const occupied = minute === finish || date < now.date || (date === now.date && time <= now.time)
          || [...schedule.busy, ...schedule.closures].some((b) => b.date === date && time >= b.startTime && time < b.endTime);
        if (!occupied && start === null) start = minute;
        if (occupied && start !== null) {
          if (minute - start >= duration) result.push({ date, startTime: clock(start), endTime: time });
          start = null;
        }
      }
    }
  }
  return result;
}

export async function prepareAssistantVisit(db: VisitD1Database, actorKey: string, sessionId: string, input: VisitBookingCreateInput, classLabel: string, now = new Date()): Promise<AssistantVisitPreview> {
  await requireAssistantSession(db, sessionId, actorKey, undefined, now);
  const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  await db.prepare(`INSERT INTO assistant_visit_drafts(id,actor_key,session_id,payload_json,class_label,created_at,expires_at) VALUES(?,?,?,?,?,?,?)`)
    .bind(input.requestId, actorKey, sessionId, JSON.stringify(input), classLabel, now.toISOString(), expiresAt).all();
  return { id: input.requestId, date: input.date, startTime: input.startTime, endTime: input.endTime, classLabel, purpose: input.purpose ?? "", expiresAt };
}

export async function readAssistantVisitReceipt(db: VisitD1Database, actorKey: string, draftId: string): Promise<VisitBooking | null> {
  // Recover even when the core transaction committed but the HTTP reply/draft cache was lost.
  const receipt = await db.prepare(`SELECT c.result_json FROM assistant_visit_drafts d
    JOIN visit_mutation_commands c ON c.id=d.id AND c.owner_auth_user_id=d.actor_key
    WHERE d.id=? AND d.actor_key=? AND c.kind='visit_booking_create' AND c.status='completed'`)
    .bind(draftId, actorKey).first<{ result_json: string | null }>();
  return receipt?.result_json ? JSON.parse(receipt.result_json) as VisitBooking : null;
}

export async function confirmAssistantVisit(db: VisitD1Database, actorKey: string, teacher: VisitTeacherIdentity, draftId: string, consent: unknown, now = new Date()): Promise<VisitBooking> {
  if (actorKey !== `teacher:${teacher.teacherUserId}`) throw new VisitScheduleError("assistant_tool_denied", 403, "Потрібен вхід власника запису.");
  const draft = await db.prepare("SELECT * FROM assistant_visit_drafts WHERE id=? AND actor_key=?").bind(draftId, actorKey).first<Draft>();
  if (!draft) throw new VisitScheduleError("assistant_draft_not_found", 404, "Підготовлений запис не знайдено.");
  const receipt = await readAssistantVisitReceipt(db, actorKey, draftId);
  if (receipt) return receipt;
  if (consent !== true) throw new VisitScheduleError("consent_required", 400, "Підтвердьте запис і відображення вашого ПІБ та часу у відкритому графіку.");
  if (draft.expires_at <= now.toISOString()) throw new VisitScheduleError("assistant_draft_expired", 409, "Пропозиція застаріла. Перевірте вільний час ще раз.");
  await requireAssistantSession(db, draft.session_id, actorKey, undefined, now);
  await db.prepare("UPDATE assistant_visit_drafts SET confirmed_at=COALESCE(confirmed_at,?) WHERE id=? AND actor_key=?")
    .bind(now.toISOString(), draftId, actorKey).all();
  let result: VisitBooking;
  try {
    result = await createVisitBooking(db, teacher, JSON.parse(draft.payload_json) as VisitBookingCreateInput);
  } catch (error) {
    // Definitive conflicts invalidate the proposal; transport failures remain retryable with the same ID.
    if (error instanceof VisitScheduleError && ["slot_unavailable", "class_year_not_active", "visit_time_elapsed", "outside_booking_horizon"].includes(error.code)) {
      await db.prepare("UPDATE assistant_visit_drafts SET expires_at=? WHERE id=? AND actor_key=?").bind(now.toISOString(), draftId, actorKey).all();
    }
    throw error;
  }
  await db.prepare("UPDATE assistant_visit_drafts SET result_json=? WHERE id=? AND actor_key=?")
    .bind(JSON.stringify(result), draftId, actorKey).all();
  return result;
}

export async function registerAssistantCall(db: VisitD1Database, id: string, actorKey: string, response: Response, key: string, fetcher: typeof fetch = fetch): Promise<string> {
  const callId = response.headers.get("Location")?.split("/").pop();
  if (!callId || !/^rtc_[A-Za-z0-9_-]+$/u.test(callId)) {
    await response.body?.cancel();
    throw new VisitScheduleError("invalid_provider_call", 503, "Не вдалося безпечно підключити голос. Спробуйте текстову розмову.");
  }
  try {
    const row = await db.prepare("UPDATE assistant_sessions SET provider_call_id=? WHERE id=? AND actor_key=? AND closed_at IS NULL RETURNING id")
      .bind(callId, id, actorKey).first<{ id: string }>();
    if (!row) throw new Error("assistant_call_not_registered");
    const sdp = await response.text();
    if (!sdp.startsWith("v=0")) throw new Error("invalid_provider_sdp");
    return sdp;
  } catch (error) {
    // A remote call exists already: compensate even if D1 registration failed.
    try { await hangupAssistantCall(db, id, callId, key, fetcher); }
    catch { /* A persisted call remains eligible for the minute cleanup retry. */ }
    throw error;
  }
}

export async function hangupAssistantCall(db: VisitD1Database, id: string, callId: string, key: string, fetcher: typeof fetch = fetch): Promise<void> {
  if (!/^rtc_[A-Za-z0-9_-]+$/u.test(callId)) return;
  const response = await fetcher(`https://api.openai.com/v1/realtime/calls/${callId}/hangup`, {
    method: "POST", headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000),
  });
  await response.body?.cancel();
  if (!response.ok && response.status !== 404) throw new Error("assistant_hangup_unavailable");
  await db.prepare("UPDATE assistant_sessions SET provider_call_id=NULL,closed_at=COALESCE(closed_at,?) WHERE id=? AND provider_call_id=?")
    .bind(new Date().toISOString(), id, callId).all();
}

// Invoked by the existing minute cron. Failed hangups stay queued for the next run.
export async function expireAssistantCalls(db: VisitD1Database, key: string | undefined, now = new Date(), fetcher: typeof fetch = fetch): Promise<void> {
  if (!key) return;
  const rows = await db.prepare(`SELECT id,provider_call_id FROM assistant_sessions
    WHERE provider_call_id IS NOT NULL AND (expires_at<=? OR closed_at IS NOT NULL) ORDER BY expires_at LIMIT 10`)
    .bind(now.toISOString()).all<{ id: string; provider_call_id: string }>();
  await Promise.allSettled((rows.results ?? []).map((row) => hangupAssistantCall(db, row.id, row.provider_call_id, key, fetcher)));
}
