import { env } from "cloudflare:workers";
import { authorizeLibrarianApi, isSameOriginRequest } from "@/lib/librarian-api";
import { getRuntimeBoolean, getRuntimeString } from "@/lib/runtime-env";
import { requireVisitTeacherSession, type VisitTeacherIdentity } from "@/lib/visit-teacher-auth";
import { readVisitJson, teacherPortalGate, featureGate, visitJson, visitError, visitBookingEnabled, visitScheduleEnabled } from "@/lib/visit-schedule-api";
import { VisitScheduleError, type VisitD1Database } from "@/lib/visit-schedule-store";
import { kyivLocalNow } from "@/lib/visit-schedule-validation";
import { assistantDailyLimit, assistantInstructions, assistantTools, ASSISTANT_NAMES, ASSISTANT_VOICES, type AssistantRole, type AssistantToolResult } from "@/lib/assistant-contract";
import { AssistantLimitError, readAssistantUsage, closeAssistantSessions, failAssistantStartup, createAssistantSession, requireAssistantSession, confirmAssistantVisit, readAssistantVisitReceipt, registerAssistantCall } from "@/lib/assistant-store";
import type { CatalogD1Database } from "@/lib/catalog-d1";
import { runAssistantLibraryTool } from "@/lib/assistant-library";
import { scheduleTelegramOutboxDrain } from "@/lib/telegram-delivery-runtime";
import { acceptAssistantConsent, readAssistantConsent, requireAssistantConsent, revokeAssistantConsent } from "@/lib/assistant-consent";
import { confirmAssistantAction, cancelAssistantAction, readAssistantActionReceipt, readAssistantActionPreview } from "@/lib/assistant-actions";
import { LibraryMutationError } from "@/lib/library-mutation-store";
import { CatalogQueryValidationError } from "@/lib/catalog-d1";
import type { ChatGPTUser } from "@/app/chatgpt-auth";
import { assistantAudioInput } from "@/lib/assistant-audio";
import { assistantModel } from "@/lib/assistant-models";
import { confirmTeacherAssistantAction, teacherActionRow } from "@/lib/assistant-teacher-actions";
import { parseAssistantCart } from "@/lib/teacher-cart";
import { AcquisitionStoreError } from "@/lib/acquisition-store";
import { TeacherMaterialRequestError } from "@/lib/teacher-material-request-store";
import { TelegramIntegrationError } from "@/lib/telegram-notifications";

export const dynamic = "force-dynamic";
type Principal = { actorKey: string; teacher?: VisitTeacherIdentity; librarian?: ChatGPTUser; writesEnabled?: boolean };

async function authenticate(db: VisitD1Database, request: Request, role: AssistantRole): Promise<Principal | Response> {
  if (role === "teacher") {
    const gate = teacherPortalGate(); if (gate) return gate;
    const teacher = await requireVisitTeacherSession(db, request);
    return { actorKey: `teacher:${teacher.teacherUserId}`, teacher };
  }
  const auth = await authorizeLibrarianApi();
  return auth.ok ? { actorKey: `librarian:${auth.value.user.userId}`, librarian: auth.value.user, writesEnabled: auth.value.access.writesEnabled } : auth.response;
}

function boundedId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/iu.test(value)) throw new VisitScheduleError("invalid_session", 400, "Некоректний сеанс помічника.");
  return value;
}

async function providerFetch(path: string, body: BodyInit, key: string, json = true): Promise<Response> {
  const response = await fetch(`https://api.openai.com/v1/${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, ...(json ? { "Content-Type": "application/json" } : {}) },
    body, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new VisitScheduleError("voice_provider_unavailable", 503, response.status === 429
      ? "Ліміт голосового сервісу вичерпано. Спробуйте пізніше; звичайні розділи працюють."
      : "ШІ-сервіс поки недоступний. Скористайтеся звичайним пошуком або графіком.");
  }
  return response;
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) return visitError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.");
  const body = await readVisitJson(request); if (!body.ok) return body.response;
  const { role, operation } = body.value;
  if ((role !== "teacher" && role !== "librarian") || typeof operation !== "string") return visitError(400, "invalid_assistant_request", "Некоректний запит помічника.");
  const db = env.DB as unknown as VisitD1Database & CatalogD1Database;
  try {
    const principal = await authenticate(db, request, role); if (principal instanceof Response) return principal;
    let cart: ReturnType<typeof parseAssistantCart>;
    try { cart = parseAssistantCart(role === "teacher" ? body.value.cart : undefined); }
    catch { return visitError(400, "invalid_cart", "Кошик має некоректний формат. Оновіть сторінку."); }
    const key = getRuntimeString("OPENAI_API_KEY");
    const enabled = getRuntimeBoolean("ASSISTANT_ENABLED") && Boolean(key);
    const dailyLimit = assistantDailyLimit(role, getRuntimeString(role === "librarian" ? "ASSISTANT_LIBRARIAN_DAILY_SESSIONS" : "ASSISTANT_TEACHER_DAILY_SESSIONS"));
    const bookingEnabled = getRuntimeBoolean("ASSISTANT_WRITES_ENABLED") && visitBookingEnabled() && visitScheduleEnabled();
    if (operation === "status") return visitJson({ success: true, name: ASSISTANT_NAMES[role], enabled, bookingEnabled: role === "teacher" && bookingEnabled,
      consent: await readAssistantConsent(db, principal.actorKey),
      usage: await readAssistantUsage(db, principal.actorKey, dailyLimit),
      message: enabled ? "Готовий до розмови" : "Помічник готується до запуску. Голосовий сервіс ще не підключено. Пошук і графік сайту працюють як раніше." });
    if (operation === "accept_consent") return visitJson({ success: true,
      consent: await acceptAssistantConsent(db, principal.actorKey, body.value.version, body.value.revision) });
    if (operation === "revoke_consent") return visitJson({ success: true,
      consent: await revokeAssistantConsent(db, principal.actorKey, key ?? undefined) });
    if (operation === "action_status" || operation === "confirm_action" || operation === "cancel_action") {
      if (principal.teacher) {
        const id = boundedId(body.value.draftId);
        const row = await teacherActionRow(db, principal.actorKey, id);
        if (row.result_json) return visitJson({ success: true, actionResult: JSON.parse(row.result_json), message: "Дію вже виконано. Повторних змін не створено." });
        if (operation === "cancel_action") {
          // The receipt and cancellation compete on the same row inside D1 transactions.
          await db.prepare("UPDATE assistant_action_drafts SET cancelled_at=COALESCE(cancelled_at,?) WHERE id=? AND actor_key=? AND result_json IS NULL").bind(new Date().toISOString(), id, principal.actorKey).all();
          const latest = await teacherActionRow(db, principal.actorKey, id);
          return visitJson({ success: true, ...(latest.result_json ? { actionResult: JSON.parse(latest.result_json) } : {}), message: latest.result_json ? "Дію вже виконано." : "Підготовлену дію скасовано. Дані не змінено." });
        }
        if (row.cancelled_at || row.expires_at <= new Date().toISOString()) throw new VisitScheduleError("assistant_action_expired", 409, "Пропозиція застаріла. Підготуйте нову.");
        if (operation === "action_status") return visitJson({ success: true, actionPreview: JSON.parse(row.preview_json) });
        if (!enabled || !getRuntimeBoolean("ASSISTANT_WRITES_ENABLED") || (row.kind.startsWith("teacher.visit.") && !bookingEnabled)) return visitError(403, "assistant_writes_disabled", "Зміни через помічника зараз вимкнено.");
        const actionResult = await confirmTeacherAssistantAction(db, principal.actorKey, principal.teacher, id, body.value.confirmed, cart, body.value.publicDisplayConsent);
        scheduleTelegramOutboxDrain(db, request.url);
        return visitJson({ success: true, actionResult, message: row.kind === "teacher.order.submit" ? "Замовлення надіслано бібліотекарю одним списком." : "Дію виконано й збережено в бібліотеці." });
      }
      if (!principal.librarian) return visitError(403, "assistant_tool_denied", "Дії Джарвіса доступні лише бібліотекарю.");
      const draftId = boundedId(body.value.draftId);
      const receipt = await readAssistantActionReceipt(db, principal.actorKey, draftId);
      if (receipt) return visitJson({ success: true, actionResult: receipt, message: "Дію вже виконано. Повторних змін не створено." });
      if (operation === "action_status") return visitJson({ success: true, actionPreview: await readAssistantActionPreview(db, principal.actorKey, draftId) });
      if (operation === "cancel_action") {
        const completed = await cancelAssistantAction(db, principal.actorKey, draftId);
        if (completed) return visitJson({ success: true, actionResult: completed, message: "Дію вже виконано. Повторних змін не створено." });
        return visitJson({ success: true, message: "Підготовлену дію скасовано. Облік не змінено." });
      }
      if (!enabled || !principal.writesEnabled || !getRuntimeBoolean("ASSISTANT_WRITES_ENABLED")) return visitError(403, "assistant_writes_disabled", "Зміни через Джарвіса зараз вимкнено.");
      const result = await confirmAssistantAction(db, principal.actorKey, principal.librarian, draftId, body.value.confirmed);
      return visitJson({ success: true, actionResult: result, message: "Дію виконано й збережено в базі бібліотеки." });
    }
    if (operation === "confirm_visit") {
      if (!principal.teacher) return visitError(403, "assistant_tool_denied", "Потрібен вхід учителя.");
      const draftId = boundedId(body.value.draftId);
      const receipt = await readAssistantVisitReceipt(db, principal.actorKey, draftId);
      if (receipt) return visitJson({ success: true, result: receipt, message: "Цей візит уже було заброньовано. Повторного запису не створено." });
      if (!enabled || !bookingEnabled) return visitError(403, "assistant_writes_disabled", "Запис через помічника тимчасово недоступний.");
      const gate = featureGate(true); if (gate) return gate;
      const result = await confirmAssistantVisit(db, principal.actorKey, principal.teacher, draftId, body.value.publicDisplayConsent);
      scheduleTelegramOutboxDrain(db, request.url);
      return visitJson({ success: true, result, message: "Візит заброньовано й додано до вашого графіка." });
    }
    if (operation === "close" || operation === "close_all") {
      await closeAssistantSessions(db, principal.actorKey, key ?? undefined, operation === "close" ? boundedId(body.value.sessionId) : undefined);
      return visitJson({ success: true, usage: await readAssistantUsage(db, principal.actorKey, dailyLimit) });
    }
    if (!enabled || !key) return visitError(503, "assistant_not_configured", "Голосовий сервіс ще не підключено. Скористайтеся пошуком і графіком сайту.");
    await requireAssistantConsent(db, principal.actorKey);
    if (operation === "start") {
      const mode = body.value.mode;
      const audioMode = body.value.audioMode ?? "natural";
      const microphone = body.value.microphone ?? "speaker";
      if (!["natural", "noisy", "manual"].includes(String(audioMode)) || !["speaker", "headset"].includes(String(microphone))) return visitError(400, "invalid_audio_mode", "Оберіть режим мікрофона.");
      if (mode !== "voice" && mode !== "text") return visitError(400, "invalid_mode", "Оберіть голос або текст.");
      if (mode === "voice" && (typeof body.value.sdp !== "string" || body.value.sdp.length > 12_000 || !body.value.sdp.startsWith("v=0"))) return visitError(400, "invalid_sdp", "Не вдалося підготувати мікрофон.");
      const session = await createAssistantSession(db, principal.actorKey, dailyLimit);
      // Informational counters must not orphan an already-created session if the read fails.
      const usage = await readAssistantUsage(db, principal.actorKey, dailyLimit).catch(() => undefined);
      if (mode === "text") return visitJson({ success: true, sessionId: session.id, expiresAt: session.expires_at, usage });
      const now = kyivLocalNow();
      const form = new FormData();
      form.set("sdp", body.value.sdp as string);
      form.set("session", JSON.stringify({ type: "realtime", model: assistantModel(role, "realtime", getRuntimeString),
        instructions: assistantInstructions(role, `${now.date} ${now.time}`), tools: assistantTools(role), max_output_tokens: 1000,
        audio: { input: assistantAudioInput(audioMode as "natural" | "noisy" | "manual", microphone as "speaker" | "headset"), output: { voice: ASSISTANT_VOICES[role] } },
      }));
      try {
        await requireAssistantSession(db, session.id, principal.actorKey);
        await requireAssistantConsent(db, principal.actorKey);
        const response = await providerFetch("realtime/calls", form, key, false);
        const sdp = await registerAssistantCall(db, session.id, principal.actorKey, response, key);
        return visitJson({ success: true, sessionId: session.id, expiresAt: session.expires_at, sdp, usage });
      } catch (error) {
        await closeAssistantSessions(db, principal.actorKey, key, session.id);
        await failAssistantStartup(db, session.id, principal.actorKey);
        throw error;
      }
    }
    const sessionId = boundedId(body.value.sessionId);
    await requireAssistantSession(db, sessionId, principal.actorKey, operation === "message" ? "text_turns" : undefined);
    const execute = async (name: string, args: unknown): Promise<AssistantToolResult> => {
      const current = await authenticate(db, request, role);
      if (current instanceof Response) throw new VisitScheduleError("authentication_required", 401, "Вхід завершився. Увійдіть ще раз.");
      await requireAssistantConsent(db, current.actorKey);
      await requireAssistantSession(db, sessionId, current.actorKey, "tool_calls");
      const result = await runAssistantLibraryTool(db, { role, actorKey: current.actorKey, teacherUserId: current.teacher?.teacherUserId, sessionId, bookingEnabled, scheduleEnabled: visitScheduleEnabled(), librarianWritesEnabled: Boolean(current.librarian && current.writesEnabled && getRuntimeBoolean("ASSISTANT_WRITES_ENABLED")), teacherWritesEnabled: Boolean(current.teacher && getRuntimeBoolean("ASSISTANT_WRITES_ENABLED")), cart }, name, args);
      if (result.cartUpdate) cart = result.cartUpdate.snapshot;
      return result;
    };
    if (operation === "tool") {
      if (typeof body.value.name !== "string") return visitError(400, "invalid_tool", "Невідома дія.");
      return visitJson(await execute(body.value.name, body.value.arguments));
    }
    if (operation === "message") {
      const message = body.value.message;
      if (typeof message !== "string" || !message.trim() || message.length > 1800) return visitError(400, "invalid_message", "Повідомлення має містити до 1800 символів.");
      const history = Array.isArray(body.value.history) ? body.value.history.slice(-10).filter((m): m is { role: "user" | "assistant"; content: string } => Boolean(m && typeof m === "object" && ["user", "assistant"].includes(m.role) && typeof m.content === "string" && m.content.length <= 2000)) : [];
      const input: unknown[] = [...history, { role: "user", content: message }];
      const results: AssistantToolResult[] = [];
      const now = kyivLocalNow();
      for (let step = 0; step < 4; step++) {
        // Do not start further paid rounds after the user closes/expires the session.
        await requireAssistantSession(db, sessionId, principal.actorKey);
        const current = await authenticate(db, request, role); if (current instanceof Response) return current;
        await requireAssistantConsent(db, current.actorKey);
        const response = await providerFetch("responses", JSON.stringify({ model: assistantModel(role, "text", getRuntimeString), store: false,
          instructions: assistantInstructions(role, `${now.date} ${now.time}`), input, tools: assistantTools(role).map((t) => ({ ...t, strict: false })),
          max_output_tokens: 1600, reasoning: { effort: "low" }, include: ["reasoning.encrypted_content"],
        }), key);
        const data = await response.json() as { output?: Array<{ type: string; name?: string; arguments?: string; call_id?: string; content?: Array<{ type: string; text?: string }> }> };
        const output = data.output ?? [];
        const calls = output.filter((item) => item.type === "function_call");
        if (calls.length > 4) throw new VisitScheduleError("assistant_tool_limit", 429, "Уточніть один запит за раз.");
        input.push(...output);
        if (!calls.length) {
          const text = output.flatMap((item) => item.content ?? []).filter((item) => item.type === "output_text").map((item) => item.text ?? "").join("\n");
          return visitJson({ success: true, text: text || "Уточніть, будь ласка, ваш запит.", results });
        }
        for (const call of calls) {
          let result: AssistantToolResult;
          try { result = await execute(call.name ?? "", JSON.parse(call.arguments ?? "{}")); }
          catch (error) { result = { success: false, message: error instanceof VisitScheduleError || error instanceof TeacherMaterialRequestError || error instanceof AcquisitionStoreError || error instanceof TelegramIntegrationError ? error.message : "Не вдалося перевірити дані. Спробуйте уточнити запит." }; }
          results.push(result);
          input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) });
        }
      }
      return visitJson({ success: true, text: "Показую перевірені результати. Уточніть наступний крок, будь ласка.", results });
    }
    return visitError(400, "unknown_assistant_operation", "Невідома дія помічника.");
  } catch (error) {
    if (error instanceof AcquisitionStoreError || error instanceof TeacherMaterialRequestError || error instanceof TelegramIntegrationError) return visitError(error.status, error.code, error.message);
    if (error instanceof LibraryMutationError) return visitError(error.status, error.code, error.message);
    if (error instanceof CatalogQueryValidationError) return visitError(400, "invalid_catalog_query", error.message);
    if (error instanceof AssistantLimitError) return visitError(error.status, error.code, error.message, { usage: error.usage });
    return error instanceof VisitScheduleError ? visitError(error.status, error.code, error.message)
      : visitError(503, "assistant_unavailable", "Помічник тимчасово недоступний. Звичайні розділи бібліотеки працюють.");
  }
}
