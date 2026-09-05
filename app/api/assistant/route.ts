import { env } from "cloudflare:workers";
import { authorizeLibrarianApi, isSameOriginRequest } from "@/lib/librarian-api";
import { getRuntimeBoolean, getRuntimeString } from "@/lib/runtime-env";
import { requireVisitTeacherSession, type VisitTeacherIdentity } from "@/lib/visit-teacher-auth";
import { readVisitJson, teacherPortalGate, featureGate, visitJson, visitError, visitBookingEnabled, visitScheduleEnabled } from "@/lib/visit-schedule-api";
import { VisitScheduleError, type VisitD1Database } from "@/lib/visit-schedule-store";
import { kyivLocalNow } from "@/lib/visit-schedule-validation";
import { assistantInstructions, assistantTools, ASSISTANT_NAMES, ASSISTANT_VOICES, type AssistantRole, type AssistantToolResult } from "@/lib/assistant-contract";
import { createAssistantSession, requireAssistantSession, confirmAssistantVisit, readAssistantVisitReceipt, hangupAssistantCall, registerAssistantCall } from "@/lib/assistant-store";
import type { CatalogD1Database } from "@/lib/catalog-d1";
import { runAssistantLibraryTool } from "@/lib/assistant-library";
import { scheduleTelegramOutboxDrain } from "@/lib/telegram-delivery-runtime";

export const dynamic = "force-dynamic";
type Principal = { actorKey: string; teacher?: VisitTeacherIdentity };

async function authenticate(db: VisitD1Database, request: Request, role: AssistantRole): Promise<Principal | Response> {
  if (role === "teacher") {
    const gate = teacherPortalGate(); if (gate) return gate;
    const teacher = await requireVisitTeacherSession(db, request);
    return { actorKey: `teacher:${teacher.teacherUserId}`, teacher };
  }
  const auth = await authorizeLibrarianApi();
  return auth.ok ? { actorKey: `librarian:${auth.value.user.userId}` } : auth.response;
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
    const key = getRuntimeString("OPENAI_API_KEY");
    const enabled = getRuntimeBoolean("ASSISTANT_ENABLED") && Boolean(key);
    const bookingEnabled = getRuntimeBoolean("ASSISTANT_WRITES_ENABLED") && visitBookingEnabled() && visitScheduleEnabled();
    if (operation === "status") return visitJson({ success: true, name: ASSISTANT_NAMES[role], enabled, bookingEnabled: role === "teacher" && bookingEnabled,
      message: enabled ? "Готовий до розмови" : "Помічник готується до запуску. Голосовий сервіс ще не підключено. Пошук і графік сайту працюють як раніше." });
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
    if (operation === "close") {
      const id = boundedId(body.value.sessionId);
      const row = await db.prepare("UPDATE assistant_sessions SET closed_at=? WHERE id=? AND actor_key=? RETURNING provider_call_id")
        .bind(new Date().toISOString(), id, principal.actorKey).first<{ provider_call_id: string | null }>();
      if (key && row?.provider_call_id && /^rtc_[A-Za-z0-9_-]+$/u.test(row.provider_call_id)) {
        try { await hangupAssistantCall(db, id, row.provider_call_id, key); } catch { /* Minute cron retries provider cleanup. */ }
      }
      return visitJson({ success: true });
    }
    if (!enabled || !key) return visitError(503, "assistant_not_configured", "Голосовий сервіс ще не підключено. Скористайтеся пошуком і графіком сайту.");
    if (operation === "start") {
      if (body.value.aiConsent !== true) return visitError(400, "ai_consent_required", "Потрібна згода на обробку запитів ШІ-сервісом.");
      const mode = body.value.mode;
      if (mode !== "voice" && mode !== "text") return visitError(400, "invalid_mode", "Оберіть голос або текст.");
      if (mode === "voice" && (typeof body.value.sdp !== "string" || body.value.sdp.length > 12_000 || !body.value.sdp.startsWith("v=0"))) return visitError(400, "invalid_sdp", "Не вдалося підготувати мікрофон.");
      const dailyLimit = Math.max(1, Math.min(30, Number(getRuntimeString("ASSISTANT_DAILY_SESSIONS") || "12") || 12));
      const session = await createAssistantSession(db, principal.actorKey, dailyLimit);
      if (mode === "text") return visitJson({ success: true, sessionId: session.id, expiresAt: session.expires_at });
      const now = kyivLocalNow();
      const form = new FormData();
      form.set("sdp", body.value.sdp as string);
      form.set("session", JSON.stringify({ type: "realtime", model: getRuntimeString("ASSISTANT_REALTIME_MODEL") || "gpt-realtime-mini",
        instructions: assistantInstructions(role, `${now.date} ${now.time}`), tools: assistantTools(role), max_output_tokens: 1000,
        audio: { input: { transcription: { model: "gpt-4o-mini-transcribe", language: "uk" }, turn_detection: { type: "semantic_vad", eagerness: "low", interrupt_response: true, create_response: true } }, output: { voice: ASSISTANT_VOICES[role] } },
      }));
      try {
        const response = await providerFetch("realtime/calls", form, key, false);
        const sdp = await registerAssistantCall(db, session.id, principal.actorKey, response, key);
        return visitJson({ success: true, sessionId: session.id, expiresAt: session.expires_at, sdp });
      } catch (error) {
        await db.prepare("UPDATE assistant_sessions SET closed_at=? WHERE id=?").bind(new Date().toISOString(), session.id).all();
        throw error;
      }
    }
    const sessionId = boundedId(body.value.sessionId);
    await requireAssistantSession(db, sessionId, principal.actorKey, operation === "message" ? "text_turns" : undefined);
    const execute = async (name: string, args: unknown): Promise<AssistantToolResult> => {
      const current = await authenticate(db, request, role);
      if (current instanceof Response) throw new VisitScheduleError("authentication_required", 401, "Вхід завершився. Увійдіть ще раз.");
      await requireAssistantSession(db, sessionId, current.actorKey, "tool_calls");
      return runAssistantLibraryTool(db, { role, actorKey: current.actorKey, teacherUserId: current.teacher?.teacherUserId, sessionId, bookingEnabled, scheduleEnabled: visitScheduleEnabled() }, name, args);
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
        const response = await providerFetch("responses", JSON.stringify({ model: getRuntimeString("ASSISTANT_TEXT_MODEL") || "gpt-5.4-mini", store: false,
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
          catch (error) { result = { success: false, message: error instanceof VisitScheduleError ? error.message : "Не вдалося перевірити дані. Спробуйте уточнити запит." }; }
          results.push(result);
          input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) });
        }
      }
      return visitJson({ success: true, text: "Показую перевірені результати. Уточніть наступний крок, будь ласка.", results });
    }
    return visitError(400, "unknown_assistant_operation", "Невідома дія помічника.");
  } catch (error) {
    return error instanceof VisitScheduleError ? visitError(error.status, error.code, error.message)
      : visitError(503, "assistant_unavailable", "Помічник тимчасово недоступний. Звичайні розділи бібліотеки працюють.");
  }
}
