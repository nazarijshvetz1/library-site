"use client";

/* eslint-disable @next/next/no-img-element -- Reuses existing catalog cover URLs. */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Mic, MicOff, Send, Volume2, VolumeX, X, Sparkles, CalendarDays, Square } from "lucide-react";
import { ASSISTANT_NAMES, type AssistantActionPreview, type AssistantConsent, type AssistantUsage, type AssistantRole, type AssistantCard, type AssistantToolResult, type AssistantVisitPreview } from "@/lib/assistant-contract";
import styles from "./library-assistant.module.css";
import { assistantAudioInput, assistantMicEnabled, type AssistantAudioMode, type AssistantMicrophone } from "@/lib/assistant-audio";
import type { AssistantCartBridge } from "@/lib/teacher-cart";

type Message = { role: "user" | "assistant"; content: string };
type Reply = { success: boolean; error?: string; message?: string; code?: string; actionPreview?: AssistantActionPreview; actionResult?: unknown; consent?: AssistantConsent; usage?: AssistantUsage; sessionId?: string; expiresAt?: string; sdp?: string; text?: string; results?: AssistantToolResult[]; enabled?: boolean; result?: { id: string; date: string; startTime: string; endTime: string } };

class AssistantApiError extends Error {
  code: string;
  constructor(message: string, code = "") { super(message); this.code = code; }
}

type AssistantProps = { assistantRole: AssistantRole; identityKey: string; fallbackHref: string; embedded?: boolean; visible?: boolean; cartBridge?: AssistantCartBridge };

export default function LibraryAssistant(props: AssistantProps) {
  // A different signed-in person must never inherit a conversation or live microphone.
  return <AssistantPanel key={`${props.assistantRole}:${props.identityKey}`} {...props} />;
}

function AssistantPanel({ assistantRole: role, identityKey, fallbackHref, embedded = false, visible = true, cartBridge }: AssistantProps) {
  const cartRef = useRef(cartBridge);
  useEffect(() => { cartRef.current = cartBridge; }, [cartBridge]);
  const visibleRef = useRef(!embedded || visible);
  const turnEpoch = useRef(0);
  const commitPending = useRef(false);
  const audioConfig = useRef<{ mode: AssistantAudioMode; microphone: AssistantMicrophone } | null>(null);
  const audioConfigTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [configuringAudio, setConfiguringAudio] = useState(false);
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [checking, setChecking] = useState(false);
  const [consent, setConsent] = useState(false);
  const [consentInfo, setConsentInfo] = useState<AssistantConsent | null>(null);
  const [savingConsent, setSavingConsent] = useState(false);
  const [revokeFailed, setRevokeFailed] = useState(false);
  const [notice, setNotice] = useState("");
  const [usage, setUsage] = useState<AssistantUsage | null>(null);
  const [busy, setBusy] = useState(false);
  const [voice, setVoice] = useState(false);
  const [muted, setMuted] = useState(false);
  const [quiet, setQuiet] = useState(false);
  const [audioMode, setAudioMode] = useState<AssistantAudioMode>("noisy");
  const [microphone, setMicrophone] = useState<AssistantMicrophone>("speaker");
  const [recording, setRecording] = useState(false);
  const [outputSpeaking, setOutputSpeaking] = useState(false);
  const audioControl = useRef({ mode: "noisy" as AssistantAudioMode, paused: false, speaking: false, recording: false, started: 0 });
  const echoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialized = useRef(false);
  const [phase, setPhase] = useState("Готовий допомогти");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [partial, setPartial] = useState("");
  const [cards, setCards] = useState<AssistantCard[]>([]);
  const [preview, setPreview] = useState<AssistantVisitPreview | null>(null);
  const [pending, setPending] = useState(false);
  const [actionPreview, setActionPreview] = useState<AssistantActionPreview | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const actionPendingRef = useRef(false);
  const actionRequest = useRef<string | null>(null);
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
  const consentRequest = useRef(0);
  const consentChange = useRef<Promise<Reply> | null>(null);
  const revokeIntent = useRef(false);
  const closing = useRef<Promise<void>>(Promise.resolve());
  const operationLock = useRef(false);
  const pendingRef = useRef(false);
  const messagesRef = useRef<Message[]>([]);
  const liveTranscript = useRef("");
  const responseActive = useRef(false);
  const responseQueued = useRef(false);
  const storageKey = `library.assistant.visit.pending.v1:${identityKey}`;
  const actionStorageKey = `library.assistant.action.pending.v1:${role}:${identityKey}`;

  function syncMicrophone() {
    const c = audioControl.current;
    stream.current?.getAudioTracks().forEach((track) => { track.enabled = !audioConfig.current && visibleRef.current && !document.hidden && assistantMicEnabled(c.mode, c.paused, c.speaking, c.recording); });
  }
  function discardVoiceInput() {
    turnEpoch.current++; commitPending.current = false;
    const dc = channel.current;
    responseQueued.current = false;
    if (dc?.readyState !== "open") return;
    if (responseActive.current) dc.send(JSON.stringify({ type: "response.cancel" }));
    dc.send(JSON.stringify({ type: "output_audio_buffer.clear" }));
    dc.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
  }
  function pauseMicrophone(paused: boolean) {
    audioControl.current.paused = paused; audioControl.current.recording = false;
    setMuted(paused); setRecording(false); syncMicrophone();
    if (paused) discardVoiceInput();
    else if (audio.current) void audio.current.play().catch(() => {});
  }
  function chooseAudio(mode: AssistantAudioMode, mic: AssistantMicrophone) {
    discardVoiceInput();
    if (channel.current?.readyState === "open") {
      audioConfig.current = { mode, microphone: mic }; setConfiguringAudio(true);
      if (audioConfigTimer.current) clearTimeout(audioConfigTimer.current);
      audioConfigTimer.current = setTimeout(() => { if (audioConfig.current) { stop(); setNotice("Налаштування звуку не підтверджено. Мікрофон вимкнено — почніть розмову ще раз."); } }, 8000);
    }
    audioControl.current.mode = mode; audioControl.current.recording = false;
    setAudioMode(mode); setMicrophone(mic); setRecording(false); syncMicrophone();
    try { window.localStorage.setItem("library.assistant.audio.v1", JSON.stringify({ mode, microphone: mic })); } catch { /* device preference only */ }
    if (channel.current?.readyState === "open") channel.current.send(JSON.stringify({ type: "session.update", session: { type: "realtime", audio: { input: assistantAudioInput(mode, mic) } } }));
  }
  function toggleRecording() {
    if (channel.current?.readyState !== "open" || audioControl.current.mode !== "manual" || audioConfig.current || !visibleRef.current) return;
    const c = audioControl.current;
    if (!c.recording) {
      discardVoiceInput(); c.paused = false; c.recording = true; c.started = performance.now();
      if (audio.current) void audio.current.play().catch(() => {});
      setMuted(false); setRecording(true); setPhase("Говоріть; натисніть ще раз, щоб надіслати"); syncMicrophone();
    } else {
      c.recording = false; setRecording(false); syncMicrophone();
      if (performance.now() - c.started < 250) { discardVoiceInput(); setPhase("Натисніть, щоб говорити"); return; }
      channel.current.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      commitPending.current = true; setPhase("Перевіряю запит");
    }
  }

  function clearStoredAction(id: string) {
    try {
      const stored = JSON.parse(window.sessionStorage.getItem(actionStorageKey) || "null") as { id?: string } | null;
      if (stored?.id === id) window.sessionStorage.removeItem(actionStorageKey);
    } catch { /* A storage failure cannot undo a committed library operation. */ }
  }

  const api = useCallback(async (operation: string, data: Record<string, unknown> = {}, keepalive = false): Promise<Reply> => {
    const token = generation.current;
    const usageToken = ["status", "start", "close", "close_all"].includes(operation) ? ++usageRequest.current : 0;
    const consentToken = ["status", "accept_consent", "revoke_consent"].includes(operation) ? ++consentRequest.current : 0;
    const response = await fetch("/api/assistant", { method: "POST", credentials: "same-origin", cache: "no-store", keepalive,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role, operation, ...(role === "teacher" ? { cart: cartRef.current?.read() } : {}), ...data }) });
    const reply = await response.json() as Reply;
    if (reply.usage && token === generation.current && usageToken === usageRequest.current) setUsage(reply.usage);
    if (reply.consent && token === generation.current && consentToken === consentRequest.current) {
      if (!reply.consent.accepted) { revokeIntent.current = false; setRevokeFailed(false); }
      setConsentInfo(reply.consent); setConsent(reply.consent.accepted && !revokeIntent.current);
      if (revokeIntent.current) setRevokeFailed(true);
    }
    if (reply.code === "ai_consent_required" && token === generation.current) { setConsent(false); setConsentInfo(null); }
    if (!response.ok || !reply.success) throw new AssistantApiError(reply.error || reply.message || "Не вдалося виконати запит.", reply.code);
    return reply;
  }, [role]);

  const append = useCallback((message: Message) => {
    messagesRef.current = [...messagesRef.current.slice(-19), message];
    setMessages(messagesRef.current);
  }, []);

  const stop = useCallback(() => {
    generation.current++;
    turnEpoch.current++; commitPending.current = false;
    audioConfig.current = null; setConfiguringAudio(false);
    if (audioConfigTimer.current) clearTimeout(audioConfigTimer.current);
    setChecking(false);
    if (echoTimer.current) clearTimeout(echoTimer.current);
    audioControl.current.speaking = false; audioControl.current.recording = false; audioControl.current.paused = false;
    setRecording(false); setOutputSpeaking(false);
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
    actionRequest.current = null;
    setBusy(false); setVoice(false); setMuted(false); setPartial("");
    setPhase("Мікрофон вимкнено");
  }, [api]);

  useEffect(() => () => { initialized.current = false; stop(); }, [stop]);
  useEffect(() => { if (!consent && session.current) stop(); }, [consent, stop]);
  useEffect(() => {
    const onHidden = () => {
      if (document.hidden) { stop(); initialized.current = false; }
      else if (embedded && visibleRef.current && !initialized.current) { initialized.current = true; openAssistant(); }
    };
    const onExit = () => stop();
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onExit);
    return () => { document.removeEventListener("visibilitychange", onHidden); window.removeEventListener("pagehide", onExit); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stop, embedded]);

  useEffect(() => {
    if (!open || embedded) return;
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
  }, [open, embedded]);

  useEffect(() => {
    try {
      const pref = JSON.parse(window.localStorage.getItem("library.assistant.audio.v1") || "null") as { mode?: AssistantAudioMode; microphone?: AssistantMicrophone } | null;
      if (pref?.mode && ["natural", "noisy", "manual"].includes(pref.mode)) { audioControl.current.mode = pref.mode; setAudioMode(pref.mode); }
      if (pref?.microphone && ["speaker", "headset"].includes(pref.microphone)) setMicrophone(pref.microphone);
    } catch { /* defaults work without browser storage */ }
  }, []);
  useEffect(() => {
    visibleRef.current = !embedded || visible;
    if (!embedded) return;
    if (visible && !initialized.current) { initialized.current = true; openAssistant(); }
    if (!visible) { pauseMicrophone(true); audio.current?.pause(); }
    // Visibility pauses capture without losing the conversation, preview or session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedded, visible]);

  function openAssistant() {
    setOpen(true); setChecking(true); setEnabled(false); setUsage(null); setConsent(false); setConsentInfo(null);
    const token = generation.current;
    void Promise.resolve(consentChange.current).catch(() => {}).then(() => api("status")).then((reply) => { if (generation.current === token) { setEnabled(Boolean(reply.enabled)); setNotice(reply.enabled ? "" : reply.message ?? ""); } })
      .catch((error: unknown) => { if (generation.current === token) setNotice(error instanceof Error ? error.message : "Не вдалося перевірити доступ."); })
      .finally(() => { if (generation.current === token) setChecking(false); });
    try {
      const stored = JSON.parse(window.sessionStorage.getItem(storageKey) || "null") as AssistantVisitPreview | null;
      if (stored && /^[0-9a-f-]{36}$/iu.test(stored.id)) { setPreview(stored); setPending(true); pendingRef.current = true; }
    } catch { /* No persisted pending confirmation. */ }
    try {
      const stored = JSON.parse(window.sessionStorage.getItem(actionStorageKey) || "null") as { id?: string } | null;
      if (stored?.id && /^[0-9a-f-]{36}$/iu.test(stored.id)) {
        const id = stored.id;
        setActionPreview(null); setActionPending(true); actionPendingRef.current = true;
        // Storage holds only a recovery ID; the review text always comes from D1.
        void api("action_status", { draftId: id }).then((reply) => {
          if (reply.actionResult) { clearStoredAction(id); applyActionReceipt(reply.actionResult); }
          if (token !== generation.current) return;
          if (reply.actionResult) { setActionPending(false); actionPendingRef.current = false; setNotice(reply.message ?? "Дію вже виконано."); }
          else if (reply.actionPreview) setActionPreview(reply.actionPreview);
        }).catch((error: unknown) => {
          if (token !== generation.current) return;
          if (error instanceof AssistantApiError && ["assistant_action_not_found", "assistant_action_expired"].includes(error.code)) { clearStoredAction(id); cartRef.current?.lock(false); setActionPending(false); actionPendingRef.current = false; }
          setNotice("Не вдалося відновити картку дії. Закрийте й відкрийте помічника, щоб перевірити результат.");
        });
      }
    } catch { /* Pending action receipt is optional. */ }
  }

  function close() { stop(); setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); }

  async function changeConsent(accept: boolean) {
    if (consentChange.current || (accept && (!consentInfo || checking || revokeIntent.current))) return;
    if (!accept) { revokeIntent.current = true; stop(); setConsent(false); }
    setSavingConsent(true); setNotice("");
    const token = generation.current;
    // Dispatch immediately: closing the panel must not cancel an explicit revocation.
    const change = api(accept ? "accept_consent" : "revoke_consent", accept ? { version: consentInfo!.version, revision: consentInfo!.revision } : {}, true);
    consentChange.current = change;
    try {
      await change;
      if (!accept) { revokeIntent.current = false; setRevokeFailed(false); }
      if (token === generation.current) {
        setRevokeFailed(false);
        if (!accept && !pendingRef.current) setPreview(null);
        if (!accept && !actionPendingRef.current) setActionPreview(null);
        setNotice(accept ? "Згоду збережено у вашому обліковому записі. Можна починати розмову." : "Згоду відкликано. Нові запити заблоковано, мікрофон тут вимкнено. Завершення інших голосових з’єднань може зайняти час; вже надіслані дані це не відкликає.");
      }
    } catch (error) {
      if (!accept) { revokeIntent.current = true; setRevokeFailed(true); setConsent(false); }
      if (token === generation.current) {
        setConsent(false); setConsentInfo(null); setRevokeFailed(!accept);
        setNotice(`${error instanceof Error ? error.message : "Не вдалося зберегти згоду."} ${accept ? "Натисніть «Перевірити доступ» і повторіть." : "Мікрофон вимкнено. Повторіть відкликання, щоб зберегти його для всіх пристроїв."}`);
      }
    } finally { consentChange.current = null; setSavingConsent(false); }
  }

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
    if (operationLock.current || consentChange.current) return;
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
    if (!visibleRef.current || document.hidden || audioControl.current.paused) return;
    responseQueued.current = true;
    if (responseActive.current || channel.current?.readyState !== "open") return;
    responseQueued.current = false; responseActive.current = true;
    channel.current.send(JSON.stringify({ type: "response.create" }));
  }
  function applyResults(results: AssistantToolResult[]) {
    const nextCards = results.flatMap((result) => result.cards ?? []);
    if (results.some((result) => result.cards)) setCards(nextCards.slice(0, 60));
    for (const result of results) {
      if (result.cartUpdate && !cartRef.current?.apply(result.cartUpdate)) {
        result.success = false; result.message = "Кошик змінився під час відповіді. Зміни помічника не застосовані; перевірте актуальний кошик.";
        setNotice(result.message); setActionPreview(null); return false;
      }
      if (result.preview && !pendingRef.current) setPreview(result.preview);
      if (result.actionPreview && !actionPendingRef.current && !actionRequest.current) setActionPreview(result.actionPreview);
      if (!result.success && result.message) setNotice(result.message);
    }
    return true;
  }
  function applyActionReceipt(value: unknown) {
    if (value && typeof value === "object" && "cartSignature" in value && typeof value.cartSignature === "string") cartRef.current?.clear(value.cartSignature);
    cartRef.current?.lock(false);
    window.dispatchEvent(new CustomEvent("library:assistant-action-completed"));
  }
  function armExpiry(expiresAt: string | undefined) {
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = setTimeout(() => { stop(); setNotice("Сеанс завершено. За потреби почніть нову розмову."); }, Math.max(0, Math.min(600_000, Date.parse(expiresAt || "") - Date.now()) || 600_000));
  }

  async function startVoice() {
    if (!consent || !enabled || operationLock.current || consentChange.current || revokeFailed) return;
    stop();
    operationLock.current = true; setBusy(true); setNotice("");
    const token = generation.current;
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) throw new Error("Тут голос недоступний. Напишіть запит або відкрийте сайт у звичайному браузері.");
      const media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      if (token !== generation.current) { media.getTracks().forEach((track) => track.stop()); return; }
      stream.current = media;
      syncMicrophone();
      const peer = new RTCPeerConnection(); pc.current = peer;
      const playback = new Audio(); playback.autoplay = true; playback.muted = quiet; audio.current = playback;
      peer.ontrack = (event) => { if (token !== generation.current) return; playback.srcObject = event.streams[0]; if (visibleRef.current && !audioControl.current.paused && !document.hidden) void playback.play().catch(() => { setQuiet(true); playback.muted = true; setNotice("Натисніть кнопку звуку, щоб дозволити озвучення."); }); };
      peer.onconnectionstatechange = () => {
        if (token === generation.current && ["failed", "disconnected"].includes(peer.connectionState)) { stop(); setNotice("Голосове з’єднання перервалося. Спробуйте текст або нову розмову."); }
      };
      media.getTracks().forEach((track) => peer.addTrack(track, media));
      const dc = peer.createDataChannel("oai-events"); channel.current = dc;
      const seen = new Set<string>();
      dc.onopen = () => { if (token !== generation.current) return; syncMicrophone(); setPhase(audioControl.current.mode === "manual" ? "Натисніть, щоб говорити" : "Слухаю"); setVoice(true); };
      dc.onmessage = (event) => {
        if (token !== generation.current) return;
        let data: { type?: string; delta?: string; transcript?: string; session?: { audio?: { input?: { turn_detection?: { type?: string; threshold?: number } | null; noise_reduction?: { type?: string } } } }; error?: { code?: string }; response?: { output?: Array<{ type: string; name?: string; call_id?: string; arguments?: string }> } };
        try { data = JSON.parse(event.data as string); } catch { return; }
        if (data.type === "response.created") responseActive.current = true;
        if (data.type === "session.updated" && audioConfig.current) {
          const expected = assistantAudioInput(audioConfig.current.mode, audioConfig.current.microphone);
          const actual = data.session?.audio?.input;
          if ((actual?.turn_detection?.type ?? null) === (expected.turn_detection?.type ?? null) && actual?.noise_reduction?.type === expected.noise_reduction.type) { audioConfig.current = null; if (audioConfigTimer.current) clearTimeout(audioConfigTimer.current); setConfiguringAudio(false); syncMicrophone(); }
        }
        if (data.type === "input_audio_buffer.committed" && commitPending.current) { commitPending.current = false; requestVoiceResponse(); }
        if (data.type === "input_audio_buffer.speech_started") { setPhase("Слухаю"); liveTranscript.current = ""; setPartial(""); }
        if (data.type === "input_audio_buffer.speech_stopped") setPhase("Перевіряю запит");
        if (data.type === "conversation.item.input_audio_transcription.completed" && data.transcript) append({ role: "user", content: data.transcript });
        if (data.type === "conversation.item.input_audio_transcription.failed") setNotice("Не вдалося розібрати слова. Повторіть ближче до мікрофона або напишіть запит.");
        if (data.type === "response.output_audio_transcript.delta") { liveTranscript.current += data.delta || ""; setPartial(liveTranscript.current); }
        if (data.type === "response.output_audio_transcript.done" && data.transcript) { append({ role: "assistant", content: data.transcript }); liveTranscript.current = ""; setPartial(""); }
        if (data.type === "output_audio_buffer.started") {
          if (echoTimer.current) clearTimeout(echoTimer.current);
          audioControl.current.speaking = true; setOutputSpeaking(true); syncMicrophone(); setPhase("Відповідаю");
        }
        if (data.type === "output_audio_buffer.stopped" || data.type === "output_audio_buffer.cleared") {
          if (echoTimer.current) clearTimeout(echoTimer.current);
          echoTimer.current = setTimeout(() => {
            if (token !== generation.current) return;
            audioControl.current.speaking = false; setOutputSpeaking(false); syncMicrophone();
            setPhase(audioControl.current.mode === "manual" ? "Натисніть, щоб говорити" : "Слухаю");
          }, audioControl.current.mode === "noisy" ? 350 : 0);
        }
        if (data.type === "error") {
          commitPending.current = false;
          if (audioConfig.current) { stop(); setNotice("Не вдалося змінити режим звуку. Мікрофон вимкнено; почніть розмову в обраному режимі ще раз."); return; }
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
          const epoch = turnEpoch.current;
          void (async () => {
            for (const call of calls) {
              if (epoch !== turnEpoch.current || !visibleRef.current || audioControl.current.paused) return;
              let result: AssistantToolResult;
              try {
                const reply = await api("tool", { sessionId: session.current?.id, name: call.name, arguments: JSON.parse(call.arguments || "{}") });
                result = reply as AssistantToolResult;
              } catch (error) { result = { success: false, message: error instanceof Error ? error.message : "Дані недоступні." }; }
              if (token !== generation.current || dc.readyState !== "open") return;
              if (epoch !== turnEpoch.current) return;
              applyResults([result]);
              dc.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) } }));
            }
            if (token === generation.current && epoch === turnEpoch.current && dc.readyState === "open") requestVoiceResponse();
          })();
        }
      };
      const offer = await peer.createOffer(); await peer.setLocalDescription(offer);
      await closing.current;
      if (token !== generation.current) return;
      const reply = await api("start", { mode: "voice", sdp: offer.sdp, audioMode, microphone });
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
    if (!message || !consent || !enabled || operationLock.current || consentChange.current || revokeFailed) return;
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
        const started = await api("start", { mode: "text" });
        if (token !== generation.current) { if (started.sessionId) void api("close", { sessionId: started.sessionId }).catch(() => {}); return; }
        if (!started.sessionId) throw new Error("Не вдалося почати розмову.");
        session.current = { id: started.sessionId, mode: "text" }; armExpiry(started.expiresAt);
      }
      const reply = await api("message", { sessionId: session.current.id, message, history });
      if (token !== generation.current) return;
      const applied = applyResults(reply.results ?? []); append({ role: "assistant", content: applied ? reply.text ?? "Перегляньте результати нижче." : "Кошик змінився під час відповіді. Перегляньте його ще раз — непідтверджені зміни не застосовано." }); setPhase("Готовий допомогти");
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

  async function finishAction(confirm: boolean) {
    if (!actionPreview || operationLock.current || consentChange.current) return;
    const draft = actionPreview;
    if (confirm && draft.cartSignature && !actionPendingRef.current && cartRef.current?.isLocked()) { setNotice("Попереднє замовлення ще перевіряється. Відкрийте «Замовити» й перевірте його результат."); return; }
    const token = generation.current;
    if (confirm) {
      try { window.sessionStorage.setItem(actionStorageKey, JSON.stringify({ id: draft.id })); }
      catch { setNotice("Не вдалося зберегти запит для безпечного повтору. Скористайтеся карткою матеріалу."); return; }
      setActionPending(true); actionPendingRef.current = true;
      if (draft.cartSignature) cartRef.current?.lock(true);
    }
    actionRequest.current = draft.id; operationLock.current = true; setBusy(true);
    try {
      const reply = await api(confirm ? "confirm_action" : "cancel_action", { draftId: draft.id, ...(confirm ? { confirmed: true, ...(draft.publicDisplayConsent ? { publicDisplayConsent: true } : {}) } : {}) });
      clearStoredAction(draft.id);
      if (reply.actionResult) applyActionReceipt(reply.actionResult);
      else cartRef.current?.lock(false);
      if (token !== generation.current) return;
      setActionPreview(null); setActionPending(false); actionPendingRef.current = false;
      append({ role: "assistant", content: `${draft.title}: ${reply.message}` }); setNotice(reply.message ?? "");
      if (channel.current?.readyState === "open") channel.current.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: `Серверний результат кнопки для «${draft.title}»: ${reply.message}. Для нової наявності перевір базу знову.` }] } }));
    } catch (error) {
      const terminal = error instanceof AssistantApiError && ["assistant_cart_changed", "cart_stock_changed", "assistant_action_conflict", "version_conflict", "invalid_status_transition", "assistant_action_not_found", "assistant_action_expired", "assistant_session_ended", "ai_consent_required", "material_version_conflict", "stock_quantity_conflict", "stock_changed", "class_loan_version_conflict", "reserved_stock_conflict", "material_reserved_conflict"].includes(error.code);
      if (terminal) { clearStoredAction(draft.id); cartRef.current?.lock(false); }
      if (token !== generation.current) return;
      if (terminal) { setActionPreview(null); setActionPending(false); actionPendingRef.current = false; }
      setNotice(`${error instanceof Error ? error.message : "Не вдалося підтвердити результат."} ${terminal ? "Підготуйте нову картку дії." : "Повторіть перевірку — запит не створить дубль."}`);
    } finally { if (token === generation.current) { actionRequest.current = null; operationLock.current = false; setBusy(false); } }
  }

  async function addCardToCart(materialId: string) {
    if (role !== "teacher" || !session.current || operationLock.current || !cartRef.current || !consent || cartRef.current.isLocked()) return;
    operationLock.current = true; setBusy(true);
    const token = generation.current;
    try {
      const quantity = (cartRef.current.read().items.find((i) => i.materialId === materialId)?.quantity ?? 0) + 1;
      const result = await api("tool", { sessionId: session.current.id, name: "update_order_cart", arguments: { materialId, quantity } }) as AssistantToolResult;
      if (token !== generation.current) return;
      if (applyResults([result])) { setNotice("Додано до кошика. Замовлення ще не надіслано."); append({ role: "assistant", content: "Матеріал додано до спільного кошика. Можете продовжити вибір або попросити надіслати весь список бібліотекарю." }); }
    } catch (error) { if (token === generation.current) setNotice(error instanceof Error ? error.message : "Не вдалося оновити кошик."); }
    finally { if (token === generation.current) { operationLock.current = false; setBusy(false); } }
  }

  const Surface = embedded ? "section" : "dialog";
  return <>
    {!embedded ? <button ref={trigger} type="button" className={styles.launcher} aria-haspopup="dialog" onClick={openAssistant}><Sparkles size={20} /><span>{role === "teacher" ? "Містер Букінгем" : "Джарвіс"}</span></button> : null}
    {open ? <Surface ref={embedded ? undefined : dialog} hidden={embedded && !visible} className={`${styles.dialog} ${embedded ? styles.embedded : ""}`} aria-labelledby={`assistant-title-${role}`} onCancel={(e) => { e.preventDefault(); close(); }}>
      <div className={styles.panel}>
        <header className={styles.header}><div><small>ЄДИНА БІБЛІОТЕКА · ШІ</small><h2 id={`assistant-title-${role}`}>{ASSISTANT_NAMES[role]}</h2></div>{!embedded ? <button type="button" onClick={close} aria-label="Закрити помічника"><X size={22} /></button> : null}</header>
        <div className={styles.body}>
          {!messages.length ? <p>Запитайте звичайними словами про книгу, наявність{role === "teacher" ? " або вільний час для відвідування" : " чи місце зберігання"}.</p> : null}
          {!checking && !consent ? <div><label className={styles.consent}><input type="checkbox" checked={false} disabled={savingConsent || !consentInfo || revokeFailed} onChange={(e) => { if (e.target.checked) void changeConsent(true); }} /><span>Погоджуюся на передачу мого голосу, тексту та потрібних даних бібліотеки до OpenAI для відповіді ШІ. Сайт не зберігає аудіозаписи. Не диктуйте PIN або паролі. Згода зберігається у моєму обліковому записі до відкликання або зміни умов.</span></label>{revokeFailed ? <button type="button" disabled={savingConsent} onClick={() => void changeConsent(false)}>Повторити відкликання згоди</button> : null}</div> : null}
          {savingConsent ? <p role="status">Зберігаю згоду…</p> : null}
          {consent && !checking ? <details className={styles.consentSettings}><summary>Згоду збережено · налаштування</summary><p>Діє для вашого облікового запису на інших пристроях. Мікрофон вмикається лише після «Поговорити»; дозвіл браузера на нього надається окремо.</p><button type="button" className={styles.secondary} disabled={savingConsent} onClick={() => void changeConsent(false)}>Відкликати згоду й зупинити розмови</button></details> : null}
          {checking ? <p role="status">Перевіряю доступ…</p> : null}
          {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
          {!enabled && !checking ? <button type="button" disabled={busy} onClick={() => void refreshUsage()}>Перевірити підключення</button> : null}
          {role === "teacher" ? <div className={styles.quickActions} aria-label="Можливості помічника">{["Знайти підручник", "Показати мій кошик", "Записатися до бібліотеки", "Коли повертати мої матеріали?", "Мої повідомлення"].map((prompt) => <button type="button" className={styles.secondary} key={prompt} onClick={() => setInput(prompt)}>{prompt}</button>)}<small>Кошик: {cartBridge?.read().items.length ?? 0} поз. · {cartBridge?.read().items.reduce((sum, i) => sum + i.quantity, 0) ?? 0} прим. Він спільний із розділом «Замовити».</small></div> : null}
          {usage ? <section className={styles.usage} aria-label="Доступ до розмов">
            <span>{usage.dailyLimit === null ? "Без денного ліміту розмов" : `Сьогодні: ${usage.usedToday} із ${usage.dailyLimit} · залишилося ${usage.remainingToday}`}</span>
            {usage.dailyLimit !== null ? <small>Ліміт поновлюється {usage.resetsOn} о 00:00 за Києвом. Закриття розмови не обнуляє лічильник.</small> : null}
            {usage.activeSessions > 0 ? <><small>Активних розмов: {usage.activeSessions} із {usage.maxActiveSessions}.</small><button type="button" className={styles.secondary} disabled={busy} onClick={() => void finishOwnSessions()}>Завершити мої активні розмови</button></> : null}
            <button type="button" className={styles.secondary} disabled={busy} onClick={() => void refreshUsage()}>Перевірити доступ</button>
          </section> : null}
          {!enabled && !checking ? <a className={styles.fallback} href={fallbackHref}>{role === "teacher" ? <><CalendarDays size={18} /> Відкрити графік і записатися</> : "Відкрити пошук у фонді"}</a> : null}
          <div className={styles.messages} aria-label="Розмова">{messages.map((m, i) => <p key={i} className={m.role === "user" ? styles.user : styles.answer}><small>{m.role === "user" ? "Ви" : ASSISTANT_NAMES[role]}</small>{m.content}</p>)}{partial ? <p className={styles.answer}>{partial}</p> : null}</div>
          {actionPreview ? <section className={styles.preview} aria-label="Підтвердження дії"><h3>{actionPreview.title}</h3><p>{actionPending ? "Перевіряємо результат попереднього підтвердження." : "Дані ще не змінено. Перевірте всі поля."}</p><ul>{actionPreview.lines.map((line, i) => <li key={i}>{line}</li>)}</ul><button type="button" disabled={busy || savingConsent || (!actionPending && !consent)} onClick={() => void finishAction(true)}>{busy ? "Перевіряю…" : actionPending ? "Перевірити результат" : actionPreview.publicDisplayConsent ? "Погоджуюся й підтверджую перенесення" : actionPreview.cartSignature ? "Надіслати замовлення бібліотекарю" : "Підтвердити дію"}</button>{!actionPending ? <button type="button" className={styles.secondary} disabled={busy} onClick={() => void finishAction(false)}>Скасувати</button> : <small>Повторна перевірка не створить другої операції.</small>}</section> : null}
          {preview ? <section className={styles.preview} aria-labelledby="assistant-visit-preview"><h3 id="assistant-visit-preview">{pending ? "Перевірка запису" : "Підтвердьте відвідування"}</h3><strong>{preview.date} · {preview.startTime}–{preview.endTime}</strong><p>{preview.classLabel}{preview.purpose ? ` · ${preview.purpose}` : ""}</p><p>Після підтвердження ваші ПІБ, дата й точний час будуть видимі у відкритому графіку. Клас і мета візиту залишаться приватними.</p><button type="button" disabled={busy} onClick={() => void confirmVisit()}>{busy ? "Перевіряю…" : pending ? "Перевірити запис" : "Погоджуюся й записатися"}</button>{!pending ? <button type="button" className={styles.secondary} onClick={() => setPreview(null)}>Не записувати</button> : <small>Повторна перевірка не створить другого запису.</small>}</section> : null}
          {cards.length ? <div className={styles.cards} aria-label="Перевірені результати">{cards.map((card) => <article key={`${card.kind}-${card.id}`} className={styles.card}>{card.image ? <img src={card.image} alt="" width={52} height={76} loading="lazy" /> : null}<div><h3>{card.title}</h3><p>{card.description}</p>{card.details.map((detail, i) => <small key={i}>{detail}</small>)}{role === "librarian" && card.href?.startsWith("/api/librarian/reports/") ? <a className={styles.reportLink} href={card.href}>Завантажити повний звіт</a> : null}{card.kind === "material" ? <button type="button" className={styles.secondary} disabled={busy || !enabled || !consent} onClick={() => setInput(`Покажи деталі матеріалу ${card.id}`)}>Детальніше</button> : null}{role === "teacher" && card.kind === "material" ? <button type="button" disabled={busy || !consent || actionPending} onClick={() => void addCardToCart(card.id)}>Додати 1 прим. до кошика</button> : null}</div></article>)}</div> : null}
        </div>
        <footer className={styles.footer}>
          <details className={styles.audioSettings}><summary>Звук: {audioMode === "noisy" ? "шумне приміщення" : audioMode === "manual" ? "за натисканням" : "природна розмова"}</summary><label>Режим<select value={audioMode} disabled={busy} onChange={(e) => chooseAudio(e.target.value as AssistantAudioMode, microphone)}><option value="natural">Природна розмова</option><option value="noisy">Шумне приміщення</option><option value="manual">Натисніть, щоб говорити</option></select></label><label>Мікрофон<select value={microphone} disabled={busy} onChange={(e) => chooseAudio(audioMode, e.target.value as AssistantMicrophone)}><option value="speaker">Телефон / ноутбук, динамік</option><option value="headset">Навушники з мікрофоном</option></select></label><small>У шумному режимі мікрофон не передає звук, поки помічник говорить. За натисканням — лише між початком і надсиланням вашої репліки.</small></details>
          {configuringAudio ? <small role="status">Налаштовую звук; мікрофон тимчасово вимкнено.</small> : null}
          {voice && audioMode === "manual" ? <button type="button" className={styles.talkButton} disabled={configuringAudio} aria-pressed={recording} onClick={toggleRecording}>{recording ? "Завершити й надіслати" : "Натисніть, щоб говорити"}</button> : null}
          {voice && audioMode === "noisy" && outputSpeaking ? <button type="button" onClick={() => { discardVoiceInput(); audioControl.current.speaking = false; setOutputSpeaking(false); pauseMicrophone(false); }}>Перебити й говорити</button> : null}
          <div className={styles.voiceBar}><span role="status" aria-live="polite"><i data-active={voice && assistantMicEnabled(audioMode, muted, outputSpeaking, recording)} />{muted ? "Мікрофон вимкнено" : phase}</span><div>{voice ? <><button type="button" aria-label={muted ? "Увімкнути мікрофон" : "Вимкнути мікрофон"} onClick={() => pauseMicrophone(!muted)}>{muted ? <MicOff size={20} /> : <Mic size={20} />}</button><button type="button" aria-label="Завершити голосову розмову" onClick={stop}><Square size={18} /></button></> : <button type="button" disabled={!enabled || !consent || busy} onClick={() => void startVoice()}><Mic size={18} /> Поговорити</button>}<button type="button" aria-label={quiet ? "Увімкнути звук" : "Вимкнути звук"} onClick={() => { if (audio.current) { audio.current.muted = !quiet; if (quiet) void audio.current.play().catch(() => {}); } setQuiet(!quiet); }}>{quiet ? <VolumeX size={20} /> : <Volume2 size={20} />}</button></div></div>
          <form className={styles.form} onSubmit={(e) => void sendMessage(e)}><input aria-label="Запит до ШІ-помічника" value={input} onChange={(e) => setInput(e.target.value)} maxLength={1800} placeholder="Напишіть або запитайте голосом…" autoComplete="off" /><button type="submit" aria-label="Надіслати запит" disabled={!enabled || !consent || busy || !input.trim()}><Send size={20} /></button></form>
        </footer>
      </div>
    </Surface> : null}
  </>;
}
