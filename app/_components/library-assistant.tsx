"use client";

/* eslint-disable @next/next/no-img-element -- Reuses existing catalog cover URLs. */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Mic, MicOff, Send, Volume2, VolumeX, X, Sparkles, CalendarDays, Square } from "lucide-react";
import { ASSISTANT_NAMES, type AssistantUsage, type AssistantRole, type AssistantCard, type AssistantToolResult, type AssistantVisitPreview } from "@/lib/assistant-contract";
import styles from "./library-assistant.module.css";

type Message = { role: "user" | "assistant"; content: string };
type Reply = { success: boolean; error?: string; message?: string; code?: string; usage?: AssistantUsage; sessionId?: string; expiresAt?: string; sdp?: string; text?: string; results?: AssistantToolResult[]; enabled?: boolean; result?: { id: string; date: string; startTime: string; endTime: string } };

class AssistantApiError extends Error {
  code: string;
  constructor(message: string, code = "") { super(message); this.code = code; }
}

type AssistantProps = { assistantRole: AssistantRole; identityKey: string; fallbackHref: string };

export default function LibraryAssistant(props: AssistantProps) {
  // A different signed-in person must never inherit a conversation or live microphone.
  return <AssistantPanel key={`${props.assistantRole}:${props.identityKey}`} {...props} />;
}

function AssistantPanel({ assistantRole: role, identityKey, fallbackHref }: AssistantProps) {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [checking, setChecking] = useState(false);
  const [consent, setConsent] = useState(false);
  const [notice, setNotice] = useState("");
  const [usage, setUsage] = useState<AssistantUsage | null>(null);
  const [busy, setBusy] = useState(false);
  const [voice, setVoice] = useState(false);
  const [muted, setMuted] = useState(false);
  const [quiet, setQuiet] = useState(false);
  const [phase, setPhase] = useState("Готовий допомогти");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [partial, setPartial] = useState("");
  const [cards, setCards] = useState<AssistantCard[]>([]);
  const [preview, setPreview] = useState<AssistantVisitPreview | null>(null);
  const [pending, setPending] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pc = useRef<RTCPeerConnection | null>(null);
  const channel = useRef<RTCDataChannel | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const session = useRef<{ id: string; mode: "voice" | "text" } | null>(null);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const usageRequest = useRef(0);
  const closing = useRef<Promise<void>>(Promise.resolve());
  const operationLock = useRef(false);
  const pendingRef = useRef(false);
  const messagesRef = useRef<Message[]>([]);
  const liveTranscript = useRef("");
  const responseActive = useRef(false);
  const responseQueued = useRef(false);
  const storageKey = `library.assistant.visit.pending.v1:${identityKey}`;

  const api = useCallback(async (operation: string, data: Record<string, unknown> = {}, keepalive = false): Promise<Reply> => {
    const token = generation.current;
    const usageToken = ["status", "start", "close", "close_all"].includes(operation) ? ++usageRequest.current : 0;
    const response = await fetch("/api/assistant", { method: "POST", credentials: "same-origin", cache: "no-store", keepalive,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role, operation, ...data }) });
    const reply = await response.json() as Reply;
    if (reply.usage && token === generation.current && usageToken === usageRequest.current) setUsage(reply.usage);
    if (!response.ok || !reply.success) throw new AssistantApiError(reply.error || reply.message || "Не вдалося виконати запит.", reply.code);
    return reply;
  }, [role]);

  const append = useCallback((message: Message) => {
    messagesRef.current = [...messagesRef.current.slice(-19), message];
    setMessages(messagesRef.current);
  }, []);

  const stop = useCallback(() => {
    generation.current++;
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    channel.current?.close(); channel.current = null;
    pc.current?.close(); pc.current = null;
    responseActive.current = false; responseQueued.current = false;
    if (audio.current) { audio.current.pause(); audio.current.srcObject = null; }
    const previous = session.current; session.current = null;
    if (previous) closing.current = api("close", { sessionId: previous.id }, true).then(() => {}, () => {});
    operationLock.current = false;
    setBusy(false); setVoice(false); setMuted(false); setPartial("");
    setPhase("Мікрофон вимкнено");
  }, [api]);

  useEffect(() => () => { stop(); }, [stop]);
  useEffect(() => {
    const onHidden = () => { if (document.hidden) stop(); };
    const onExit = () => stop();
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onExit);
    return () => { document.removeEventListener("visibilitychange", onHidden); window.removeEventListener("pagehide", onExit); };
  }, [stop]);

  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    const current = dialog.current;
    const updateViewport = () => {
      const viewport = window.visualViewport;
      if (!current || !viewport) return;
      current.style.setProperty("--assistant-height", `${viewport.height}px`);
      current.style.setProperty("--assistant-top", `${viewport.offsetTop}px`);
    };
    updateViewport();
    window.visualViewport?.addEventListener("resize", updateViewport);
    window.visualViewport?.addEventListener("scroll", updateViewport);
    return () => { current?.close(); window.visualViewport?.removeEventListener("resize", updateViewport); window.visualViewport?.removeEventListener("scroll", updateViewport); };
  }, [open]);

  function openAssistant() {
    setOpen(true); setChecking(true); setEnabled(false); setUsage(null);
    const token = generation.current;
    void api("status").then((reply) => { if (generation.current === token) { setEnabled(Boolean(reply.enabled)); setNotice(reply.enabled ? "" : reply.message ?? ""); } })
      .catch((error: unknown) => { if (generation.current === token) setNotice(error instanceof Error ? error.message : "Не вдалося перевірити доступ."); })
      .finally(() => { if (generation.current === token) setChecking(false); });
    try {
      const stored = JSON.parse(window.sessionStorage.getItem(storageKey) || "null") as AssistantVisitPreview | null;
      if (stored && /^[0-9a-f-]{36}$/iu.test(stored.id)) { setPreview(stored); setPending(true); pendingRef.current = true; }
    } catch { /* No persisted pending confirmation. */ }
  }

  function close() { stop(); setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); }

  async function finishOwnSessions() {
    if (operationLock.current) return;
    stop(); operationLock.current = true; setBusy(true);
    const token = generation.current;
    try {
      await closing.current;
      if (token !== generation.current) return;
      const closeAll = api("close_all");
      closing.current = closeAll.then(() => {}, () => {});
      const reply = await closeAll;
      if (token === generation.current) {
        // A pending confirmation may already have committed: keep its recovery receipt.
        if (!pendingRef.current) setPreview(null);
        setNotice(reply.usage?.remainingToday === 0
          ? "Ваші активні розмови завершено. Денний ліміт уже використано; він поновиться опівночі за Києвом."
          : "Ваші активні розмови завершено. Можна почати нову розмову.");
      }
    } catch (error) {
      if (token === generation.current) setNotice(error instanceof Error ? error.message : "Не вдалося завершити розмови. Спробуйте ще раз.");
    } finally { if (token === generation.current) { operationLock.current = false; setBusy(false); } }
  }

  async function refreshUsage() {
    if (operationLock.current) return;
    operationLock.current = true; setBusy(true);
    const token = generation.current;
    try {
      const reply = await api("status");
      if (token === generation.current) {
        setEnabled(Boolean(reply.enabled));
        setNotice(!reply.enabled ? reply.message ?? "" : reply.usage?.remainingToday === 0
          ? "Денний ліміт використано. Нові розмови будуть доступні опівночі за Києвом; поточну можна продовжити."
          : reply.usage && reply.usage.activeSessions >= reply.usage.maxActiveSessions
            ? "У вас дві активні розмови. Для нової завершіть їх кнопкою нижче."
            : "Доступ перевірено. Можна повторити запит.");
      }
    } catch (error) {
      if (token === generation.current) setNotice(error instanceof Error ? error.message : "Не вдалося перевірити доступ.");
    } finally { if (token === generation.current) { operationLock.current = false; setBusy(false); } }
  }
  function requestVoiceResponse() {
    responseQueued.current = true;
    if (responseActive.current || channel.current?.readyState !== "open") return;
    responseQueued.current = false; responseActive.current = true;
    channel.current.send(JSON.stringify({ type: "response.create" }));
  }
  function applyResults(results: AssistantToolResult[]) {
    const nextCards = results.flatMap((result) => result.cards ?? []);
    if (results.some((result) => result.cards)) setCards(nextCards.slice(0, 60));
    for (const result of results) {
      if (result.preview && !pendingRef.current) setPreview(result.preview);
      if (!result.success && result.message) setNotice(result.message);
    }
  }
  function armExpiry(expiresAt: string | undefined) {
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = setTimeout(() => { stop(); setNotice("Сеанс завершено. За потреби почніть нову розмову."); }, Math.max(0, Math.min(600_000, Date.parse(expiresAt || "") - Date.now()) || 600_000));
  }

  async function startVoice() {
    if (!consent || !enabled || operationLock.current) return;
    stop();
    operationLock.current = true; setBusy(true); setNotice("");
    const token = generation.current;
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) throw new Error("Тут голос недоступний. Напишіть запит або відкрийте сайт у звичайному браузері.");
      const media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (token !== generation.current) { media.getTracks().forEach((track) => track.stop()); return; }
      stream.current = media;
      const peer = new RTCPeerConnection(); pc.current = peer;
      const playback = new Audio(); playback.autoplay = true; playback.muted = quiet; audio.current = playback;
      peer.ontrack = (event) => { playback.srcObject = event.streams[0]; void playback.play().catch(() => { setQuiet(true); playback.muted = true; setNotice("Натисніть кнопку звуку, щоб дозволити озвучення."); }); };
      peer.onconnectionstatechange = () => {
        if (token === generation.current && ["failed", "disconnected"].includes(peer.connectionState)) { stop(); setNotice("Голосове з’єднання перервалося. Спробуйте текст або нову розмову."); }
      };
      media.getTracks().forEach((track) => peer.addTrack(track, media));
      const dc = peer.createDataChannel("oai-events"); channel.current = dc;
      const seen = new Set<string>();
      dc.onopen = () => { setPhase("Слухаю"); setVoice(true); };
      dc.onmessage = (event) => {
        if (token !== generation.current) return;
        let data: { type?: string; delta?: string; transcript?: string; error?: { code?: string }; response?: { output?: Array<{ type: string; name?: string; call_id?: string; arguments?: string }> } };
        try { data = JSON.parse(event.data as string); } catch { return; }
        if (data.type === "response.created") responseActive.current = true;
        if (data.type === "input_audio_buffer.speech_started") { setPhase("Слухаю"); liveTranscript.current = ""; setPartial(""); }
        if (data.type === "input_audio_buffer.speech_stopped") setPhase("Перевіряю запит");
        if (data.type === "conversation.item.input_audio_transcription.completed" && data.transcript) append({ role: "user", content: data.transcript });
        if (data.type === "response.output_audio_transcript.delta") { liveTranscript.current += data.delta || ""; setPartial(liveTranscript.current); }
        if (data.type === "response.output_audio_transcript.done" && data.transcript) { append({ role: "assistant", content: data.transcript }); liveTranscript.current = ""; setPartial(""); }
        if (data.type === "output_audio_buffer.started") setPhase("Відповідаю");
        if (data.type === "output_audio_buffer.stopped") setPhase("Слухаю");
        if (data.type === "error") {
          if (data.error?.code === "conversation_already_has_active_response") { responseActive.current = true; responseQueued.current = true; }
          else { responseActive.current = false; setNotice("Не вдалося обробити репліку. Спробуйте повторити або написати запит."); }
        }
        if (data.type === "response.done") {
          responseActive.current = false;
          const calls = (data.response?.output ?? []).filter((item) => item.type === "function_call" && item.call_id && !seen.has(item.call_id));
          if (!calls.length) { if (responseQueued.current) requestVoiceResponse(); return; }
          calls.forEach((call) => seen.add(call.call_id!));
          if (calls.length > 4) { stop(); setNotice("Забагато дій одночасно. Уточніть один запит."); return; }
          setPhase("Перевіряю базу");
          void (async () => {
            for (const call of calls) {
              let result: AssistantToolResult;
              try {
                const reply = await api("tool", { sessionId: session.current?.id, name: call.name, arguments: JSON.parse(call.arguments || "{}") });
                result = reply as AssistantToolResult;
              } catch (error) { result = { success: false, message: error instanceof Error ? error.message : "Дані недоступні." }; }
              if (token !== generation.current || dc.readyState !== "open") return;
              applyResults([result]);
              dc.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) } }));
            }
            if (token === generation.current && dc.readyState === "open") requestVoiceResponse();
          })();
        }
      };
      const offer = await peer.createOffer(); await peer.setLocalDescription(offer);
      await closing.current;
      if (token !== generation.current) return;
      const reply = await api("start", { mode: "voice", aiConsent: true, sdp: offer.sdp });
      if (token !== generation.current) { if (reply.sessionId) void api("close", { sessionId: reply.sessionId }).catch(() => {}); return; }
      if (!reply.sessionId || !reply.sdp) throw new Error("Не вдалося підключити голос.");
      session.current = { id: reply.sessionId, mode: "voice" }; armExpiry(reply.expiresAt);
      await peer.setRemoteDescription({ type: "answer", sdp: reply.sdp });
    } catch (error) {
      if (token === generation.current) { stop(); setNotice(error instanceof Error ? error.message : "Надайте доступ до мікрофона або скористайтеся текстом."); }
    } finally { if (token === generation.current) { operationLock.current = false; setBusy(false); } }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const message = input.trim();
    if (!message || !consent || !enabled || operationLock.current) return;
    if (session.current?.mode === "voice" && channel.current?.readyState === "open") {
      channel.current.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: message }] } }));
      requestVoiceResponse();
      append({ role: "user", content: message }); setInput(""); return;
    }
    operationLock.current = true; setBusy(true); setNotice(""); setPhase("Перевіряю запит");
    const token = generation.current;
    const history = messagesRef.current.slice(-6).map((m) => ({ ...m, content: m.content.slice(0, 1000) }));
    append({ role: "user", content: message }); setInput("");
    try {
      if (!session.current) {
        await closing.current;
        if (token !== generation.current) return;
        const started = await api("start", { mode: "text", aiConsent: true });
        if (token !== generation.current) { if (started.sessionId) void api("close", { sessionId: started.sessionId }).catch(() => {}); return; }
        if (!started.sessionId) throw new Error("Не вдалося почати розмову.");
        session.current = { id: started.sessionId, mode: "text" }; armExpiry(started.expiresAt);
      }
      const reply = await api("message", { sessionId: session.current.id, message, history });
      if (token !== generation.current) return;
      applyResults(reply.results ?? []); append({ role: "assistant", content: reply.text ?? "Перегляньте результати нижче." }); setPhase("Готовий допомогти");
    } catch (error) { if (token === generation.current) {
      if (error instanceof AssistantApiError && error.code === "assistant_session_ended") stop();
      setNotice(error instanceof Error ? error.message : "Не вдалося перевірити дані."); setInput(message);
    } }
    finally { if (token === generation.current) { operationLock.current = false; setBusy(false); } }
  }

  async function confirmVisit() {
    if (!preview || operationLock.current) return;
    try { window.sessionStorage.setItem(storageKey, JSON.stringify(preview)); }
    catch { setNotice("Браузер не дозволяє зберегти запит для безпечного повтору. Запишіться через розділ «Графік»."); return; }
    pendingRef.current = true; setPending(true); operationLock.current = true; setBusy(true); setNotice("");
    const draft = preview;
    try {
      const reply = await api("confirm_visit", { draftId: draft.id, publicDisplayConsent: true });
      window.sessionStorage.removeItem(storageKey); pendingRef.current = false; setPending(false); setPreview(null);
      append({ role: "assistant", content: `${reply.message} ${draft.date}, ${draft.startTime}–${draft.endTime}.` });
      setNotice("Запис підтверджено. Він уже є у вашому графіку.");
      window.dispatchEvent(new CustomEvent("library:assistant-visit-created"));
      if (channel.current?.readyState === "open") channel.current.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: `Кнопка підтвердження отримала успішний серверний результат: візит ${draft.date} ${draft.startTime}–${draft.endTime} збережено.` }] } }));
    } catch (error) {
      const terminal = error instanceof AssistantApiError && ["assistant_draft_expired", "assistant_draft_not_found", "assistant_session_ended", "slot_unavailable", "class_year_not_active", "visit_time_elapsed", "outside_booking_horizon"].includes(error.code);
      if (terminal) {
        window.sessionStorage.removeItem(storageKey); pendingRef.current = false; setPending(false); setPreview(null);
        setNotice(`${error.message} Почніть нову розмову або уточніть інший час.`);
      } else setNotice(`${error instanceof Error ? error.message : "Результат ще не підтверджено."} Натисніть «Перевірити запис» — повтор не створить другого бронювання.`);
    }
    finally { operationLock.current = false; setBusy(false); }
  }

  return <>
    <button ref={trigger} type="button" className={styles.launcher} aria-haspopup="dialog" onClick={openAssistant}><Sparkles size={20} /><span>{role === "teacher" ? "ШІ-помічник" : "Джарвіс"}</span></button>
    {open ? <dialog ref={dialog} className={styles.dialog} aria-labelledby={`assistant-title-${role}`} onCancel={(e) => { e.preventDefault(); close(); }}>
      <div className={styles.panel}>
        <header className={styles.header}><div><small>ЄДИНА БІБЛІОТЕКА · ШІ</small><h2 id={`assistant-title-${role}`}>{ASSISTANT_NAMES[role]}</h2></div><button type="button" onClick={close} aria-label="Закрити помічника"><X size={22} /></button></header>
        <div className={styles.body}>
          {!messages.length ? <p>Запитайте звичайними словами про книгу, наявність{role === "teacher" ? " або вільний час для відвідування" : " чи місце зберігання"}.</p> : null}
          {!consent ? <label className={styles.consent}><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /><span>Погоджуюся на передачу мого голосу, тексту та потрібних даних бібліотеки до OpenAI для відповіді ШІ. Сайт не зберігає аудіозаписи. Не диктуйте PIN або паролі.</span></label> : null}
          {checking ? <p role="status">Перевіряю доступ…</p> : null}
          {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
          {usage ? <section className={styles.usage} aria-label="Доступ до розмов">
            <span>{usage.dailyLimit === null ? "Без денного ліміту розмов" : `Сьогодні: ${usage.usedToday} із ${usage.dailyLimit} · залишилося ${usage.remainingToday}`}</span>
            {usage.dailyLimit !== null ? <small>Ліміт поновлюється {usage.resetsOn} о 00:00 за Києвом. Закриття розмови не обнуляє лічильник.</small> : null}
            {usage.activeSessions > 0 ? <><small>Активних розмов: {usage.activeSessions} із {usage.maxActiveSessions}.</small><button type="button" className={styles.secondary} disabled={busy} onClick={() => void finishOwnSessions()}>Завершити мої активні розмови</button></> : null}
            <button type="button" className={styles.secondary} disabled={busy} onClick={() => void refreshUsage()}>Перевірити доступ</button>
          </section> : null}
          {!enabled && !checking ? <a className={styles.fallback} href={fallbackHref}>{role === "teacher" ? <><CalendarDays size={18} /> Відкрити графік і записатися</> : "Відкрити пошук у фонді"}</a> : null}
          <div className={styles.messages} aria-label="Розмова">{messages.map((m, i) => <p key={i} className={m.role === "user" ? styles.user : styles.answer}><small>{m.role === "user" ? "Ви" : ASSISTANT_NAMES[role]}</small>{m.content}</p>)}{partial ? <p className={styles.answer}>{partial}</p> : null}</div>
          {preview ? <section className={styles.preview} aria-labelledby="assistant-visit-preview"><h3 id="assistant-visit-preview">{pending ? "Перевірка запису" : "Підтвердьте відвідування"}</h3><strong>{preview.date} · {preview.startTime}–{preview.endTime}</strong><p>{preview.classLabel}{preview.purpose ? ` · ${preview.purpose}` : ""}</p><p>Після підтвердження ваші ПІБ, дата й точний час будуть видимі у відкритому графіку. Клас і мета візиту залишаться приватними.</p><button type="button" disabled={busy} onClick={() => void confirmVisit()}>{busy ? "Перевіряю…" : pending ? "Перевірити запис" : "Погоджуюся й записатися"}</button>{!pending ? <button type="button" className={styles.secondary} onClick={() => setPreview(null)}>Не записувати</button> : <small>Повторна перевірка не створить другого запису.</small>}</section> : null}
          {cards.length ? <div className={styles.cards} aria-label="Перевірені результати">{cards.map((card) => <article key={`${card.kind}-${card.id}`} className={styles.card}>{card.image ? <img src={card.image} alt="" width={52} height={76} loading="lazy" /> : null}<div><h3>{card.title}</h3><p>{card.description}</p>{card.details.map((detail, i) => <small key={i}>{detail}</small>)}{card.kind === "material" ? <button type="button" className={styles.secondary} disabled={busy || !enabled || !consent} onClick={() => setInput(`Покажи деталі матеріалу ${card.id}`)}>Детальніше</button> : null}</div></article>)}</div> : null}
        </div>
        <footer className={styles.footer}>
          <div className={styles.voiceBar}><span role="status" aria-live="polite"><i data-active={voice && !muted} />{muted ? "Мікрофон вимкнено" : phase}</span><div>{voice ? <><button type="button" aria-label={muted ? "Увімкнути мікрофон" : "Вимкнути мікрофон"} onClick={() => { stream.current?.getAudioTracks().forEach((track) => { track.enabled = muted; }); setMuted(!muted); }}>{muted ? <MicOff size={20} /> : <Mic size={20} />}</button><button type="button" aria-label="Завершити голосову розмову" onClick={stop}><Square size={18} /></button></> : <button type="button" disabled={!enabled || !consent || busy} onClick={() => void startVoice()}><Mic size={18} /> Поговорити</button>}<button type="button" aria-label={quiet ? "Увімкнути звук" : "Вимкнути звук"} onClick={() => { if (audio.current) { audio.current.muted = !quiet; if (quiet) void audio.current.play().catch(() => {}); } setQuiet(!quiet); }}>{quiet ? <VolumeX size={20} /> : <Volume2 size={20} />}</button></div></div>
          <form className={styles.form} onSubmit={(e) => void sendMessage(e)}><input aria-label="Запит до ШІ-помічника" value={input} onChange={(e) => setInput(e.target.value)} maxLength={1800} placeholder="Напишіть або запитайте голосом…" autoComplete="off" /><button type="submit" aria-label="Надіслати запит" disabled={!enabled || !consent || busy || !input.trim()}><Send size={20} /></button></form>
        </footer>
      </div>
    </dialog> : null}
  </>;
}
