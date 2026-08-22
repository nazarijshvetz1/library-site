"use client";

import {
  type FormEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  formatTeacherAccessCode,
  normalizedTeacherAccessCode,
  normalizedTeacherPin,
  teacherAccessCodeComplete,
  teacherPinStrength,
  teacherSearchUrl,
  visitApi,
  VisitApiError,
  type VisitTeacher,
  type VisitTeacherSearchEnvelope,
} from "@/app/visits/visit-client";
import styles from "./telegram.module.css";

type TeacherTab = "overview" | "visits" | "orders" | "loans" | "notifications";
type TelegramWebApp = {
  initData: string;
  ready(): void;
  expand(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
};

type ActivationState = {
  mode: "generic" | "personal" | "connected";
  teacher: { fullName: string } | null;
  requiresCode: boolean;
  requiresNewPin: boolean;
  grantExpiresAt: string | null;
};

type BootstrapEnvelope =
  | { success: true; onboardingRequired: false; teacher: { fullName: string } }
  | { success: true; onboardingRequired: true; activation: ActivationState };

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export default function TelegramTeacherLaunch({
  targetTab,
  enabled,
  botUsername,
}: {
  targetTab: TeacherTab;
  enabled: boolean;
  botUsername: string | null;
}) {
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<"checking" | "activation" | "submitting" | "success" | "error" | "disabled">(
    enabled ? "checking" : "disabled",
  );
  const [message, setMessage] = useState(
    enabled ? "Перевіряємо безпечний вхід…" : "Кабінет у Telegram ще не ввімкнено.",
  );
  const [activation, setActivation] = useState<ActivationState | null>(null);
  const [initData, setInitData] = useState("");
  const targetUrl = useMemo(
    () => `/teacher/telegram/cabinet?tab=${encodeURIComponent(targetTab)}`,
    [targetTab],
  );

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const controller = new AbortController();
    async function start() {
      setPhase("checking");
      setActivation(null);
      setInitData("");
      setMessage("Перевіряємо безпечний вхід…");
      try {
        const webApp = await loadTelegramWebApp();
        if (cancelled) return;
        webApp.ready();
        webApp.expand();
        webApp.setHeaderColor?.("#174d38");
        webApp.setBackgroundColor?.("#f4f5ef");
        if (!webApp.initData) {
          throw new Error("Відкрийте «Кабінет учителя» кнопкою в приватному чаті з ботом.");
        }
        setMessage("Підтверджуємо ваш Telegram…");
        const response = await fetch("/api/teacher/session/telegram", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ initData: webApp.initData }),
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => null) as (BootstrapEnvelope & { error?: string }) | null;
        if (!response.ok || !payload) {
          throw new Error(payload?.error || "Не вдалося відкрити кабінет учителя.");
        }
        if (payload.onboardingRequired) {
          setInitData(webApp.initData);
          setActivation(payload.activation);
          setPhase("activation");
          setMessage(activationIntro(payload.activation));
          return;
        }
        window.location.replace(targetUrl);
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        setPhase("error");
        setMessage(error instanceof Error ? error.message : "Не вдалося відкрити кабінет учителя.");
      }
    }
    void start();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [attempt, enabled, targetUrl]);

  async function activate(input: { loginId: string; code: string; newPin: string }) {
    if (!activation || !initData) return;
    setPhase("submitting");
    setMessage("Захищено активуємо кабінет…");
    try {
      await visitApi("/api/teacher/session/telegram/activate", {
        method: "POST",
        cache: "no-store",
        body: JSON.stringify({
          initData,
          requestId: crypto.randomUUID(),
          loginId: input.loginId,
          code: input.code,
          newPin: input.newPin,
        }),
      });
      setPhase("success");
      setMessage("Готово! Кабінет активовано, а Telegram підключено.");
      window.location.replace(targetUrl);
    } catch (error) {
      setPhase("activation");
      setMessage(error instanceof VisitApiError
        ? error.message
        : "Не вдалося активувати кабінет. Спробуйте ще раз.");
    }
  }

  const botUrl = botUsername ? `https://t.me/${botUsername}` : null;
  return (
    <main className={styles.page}>
      <section className={styles.panel} aria-labelledby="telegram-teacher-title">
        <div className={styles.mark} aria-hidden="true">ЄБ</div>
        <p className={styles.eyebrow}>Єдина бібліотека</p>
        <h1 id="telegram-teacher-title">
          {activation ? "Активувати кабінет учителя" : "Кабінет учителя"}
        </h1>
        <p className={styles.message} role={phase === "error" ? "alert" : "status"} aria-live="polite">
          {message}
        </p>
        {phase === "checking" || phase === "submitting" || phase === "success" ? (
          <span className={styles.spinner} aria-hidden="true" />
        ) : null}
        {activation && (phase === "activation" || phase === "submitting") ? (
          <TelegramTeacherActivationForm
            activation={activation}
            busy={phase === "submitting"}
            onActivate={activate}
          />
        ) : null}
        {phase === "error" ? (
          <button className={styles.primary} type="button" onClick={() => setAttempt((value) => value + 1)}>
            Спробувати ще раз
          </button>
        ) : null}
        {phase !== "checking" && phase !== "submitting" && botUrl ? (
          <a className={styles.secondary} href={botUrl}>Повернутися до бота</a>
        ) : null}
        <small>Код і PIN вводьте лише в цьому захищеному вікні — не надсилайте їх повідомленням у чат.</small>
      </section>
    </main>
  );
}

function TelegramTeacherActivationForm({
  activation,
  busy,
  onActivate,
}: {
  activation: ActivationState;
  busy: boolean;
  onActivate(input: { loginId: string; code: string; newPin: string }): Promise<void>;
}) {
  const listId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<VisitTeacher[]>([]);
  const [selected, setSelected] = useState<VisitTeacher | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchNotice, setSearchNotice] = useState("");
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [pinConfirmation, setPinConfirmation] = useState("");
  const [validationNotice, setValidationNotice] = useState("");
  const generic = activation.mode === "generic";
  const normalizedCode = normalizedTeacherAccessCode(code);
  const codeIsTemporary = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$/u.test(normalizedCode);
  const needsNewPin = generic ? codeIsTemporary : activation.requiresNewPin;
  const pinStatus = teacherPinStrength(pin);
  const normalizedQuery = query.trim();

  useEffect(() => {
    if (!generic || selected || normalizedQuery.length < 3) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      setSearchNotice("");
      try {
        const response = await visitApi<VisitTeacherSearchEnvelope>(teacherSearchUrl(normalizedQuery), {
          signal: controller.signal,
          cache: "no-store",
        });
        setResults(response.teachers);
        if (!response.teachers.length) setSearchNotice("Збігів не знайдено. Перевірте написання імені.");
      } catch (error) {
        if (!controller.signal.aborted) {
          setResults([]);
          setSearchNotice(error instanceof VisitApiError && error.status === 429
            ? "Забагато спроб. Зачекайте трохи й повторіть пошук."
            : "Не вдалося виконати пошук. Спробуйте ще раз.");
        }
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [generic, normalizedQuery, selected]);

  function chooseTeacher(teacher: VisitTeacher) {
    setSelected(teacher);
    setQuery(teacher.fullName);
    setResults([]);
    setSearchNotice("");
  }

  function changeQuery(value: string) {
    setQuery(value);
    if (selected && value !== selected.fullName) setSelected(null);
    if (value.trim().length < 3) {
      setResults([]);
      setSearchNotice("");
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidationNotice("");
    const chosen = selected ?? (generic && results.length === 1 ? results[0] : null);
    if (generic && !chosen) {
      setSearchNotice("Оберіть своє точне ім’я у списку.");
      searchRef.current?.focus();
      return;
    }
    if (activation.requiresCode && !teacherAccessCodeComplete(code)) {
      setValidationNotice("Введіть 4-значний PIN або повний тимчасовий код бібліотекаря.");
      return;
    }
    if (needsNewPin && (!pinStatus.strong || normalizedTeacherPin(pinConfirmation) !== normalizedTeacherPin(pin))) {
      setValidationNotice(!pinStatus.strong
        ? "Оберіть неочевидний PIN із 4 цифр без повторів і простих послідовностей."
        : "Повторіть новий PIN однаково в обох полях.");
      return;
    }
    void onActivate({
      loginId: chosen?.loginId ?? "",
      code: activation.requiresCode ? normalizedCode : "",
      newPin: needsNewPin ? normalizedTeacherPin(pin) : "",
    });
  }

  const submitDisabled = busy
    || (generic && !selected)
    || (activation.requiresCode && !teacherAccessCodeComplete(code))
    || (needsNewPin && (!pinStatus.strong || normalizedTeacherPin(pinConfirmation) !== normalizedTeacherPin(pin)));

  return (
    <form className={styles.activationForm} onSubmit={submit} aria-busy={busy}>
      {generic ? (
        <div className={styles.fieldGroup}>
          <label htmlFor={`${listId}-search`}>Прізвище та ім’я *</label>
          <input
            ref={searchRef}
            id={`${listId}-search`}
            type="search"
            autoComplete="off"
            spellCheck="false"
            maxLength={100}
            value={query}
            aria-controls={listId}
            onChange={(event) => changeQuery(event.currentTarget.value)}
            placeholder="Введіть щонайменше 3 літери"
            disabled={busy}
          />
          <small>{searching ? "Шукаємо…" : searchNotice || "Оберіть точне ім’я зі списку бази даних."}</small>
          {results.length ? (
            <ul id={listId} className={styles.teacherResults} aria-label="Знайдені вчителі">
              {results.map((teacher) => (
                <li key={teacher.loginId}>
                  <button type="button" onClick={() => chooseTeacher(teacher)}>{teacher.fullName}</button>
                </li>
              ))}
            </ul>
          ) : null}
          {selected ? <div className={styles.selectedTeacher}><span>Обрано з бази</span><strong>{selected.fullName}</strong></div> : null}
        </div>
      ) : (
        <div className={styles.selectedTeacher}>
          <span>{activation.mode === "connected" ? "Telegram підтверджено" : "Особисте запрошення"}</span>
          <strong>{activation.teacher?.fullName}</strong>
        </div>
      )}

      {activation.requiresCode ? (
        <div className={styles.fieldGroup}>
          <label htmlFor={`${listId}-code`}>Тимчасовий код або PIN *</label>
          <input
            id={`${listId}-code`}
            required
            type="password"
            inputMode="text"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            maxLength={11}
            value={code}
            onChange={(event) => {
              setCode(formatTeacherAccessCode(event.currentTarget.value));
              setValidationNotice("");
            }}
            placeholder="4 цифри або XXXXX-XXXXX"
            disabled={busy}
          />
        </div>
      ) : null}

      {needsNewPin ? (
        <>
          <div className={styles.fieldGroup}>
            <label htmlFor={`${listId}-pin`}>Створіть власний 4-значний PIN *</label>
            <input
              id={`${listId}-pin`}
              required
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              pattern="[0-9]{4}"
              maxLength={4}
              value={pin}
              onChange={(event) => setPin(normalizedTeacherPin(event.currentTarget.value))}
              placeholder="••••"
              disabled={busy}
            />
            <small>Не використовуйте 1111, 1234, дату народження чи іншу очевидну комбінацію.</small>
          </div>
          <div className={styles.fieldGroup}>
            <label htmlFor={`${listId}-pin-confirmation`}>Повторіть новий PIN *</label>
            <input
              id={`${listId}-pin-confirmation`}
              required
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              pattern="[0-9]{4}"
              maxLength={4}
              value={pinConfirmation}
              onChange={(event) => setPinConfirmation(normalizedTeacherPin(event.currentTarget.value))}
              placeholder="••••"
              disabled={busy}
            />
          </div>
        </>
      ) : null}
      {validationNotice ? <p className={styles.formError} role="alert">{validationNotice}</p> : null}
      <button className={styles.primary} type="submit" disabled={submitDisabled}>
        {busy ? "Активуємо…" : "Продовжити"}
      </button>
    </form>
  );
}

function activationIntro(activation: ActivationState): string {
  if (activation.mode === "personal") {
    return `Запрошення підготовлено для ${activation.teacher?.fullName ?? "вчителя"}. Створіть PIN або підтвердьте чинний.`;
  }
  if (activation.mode === "connected") {
    return "Telegram уже підтверджено. Введіть тимчасовий код бібліотекаря та створіть новий особистий PIN.";
  }
  return "Оберіть себе з бази та введіть тимчасовий код бібліотекаря або свій PIN.";
}

async function loadTelegramWebApp(): Promise<TelegramWebApp> {
  if (window.Telegram?.WebApp) return window.Telegram.WebApp;
  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-telegram-web-app="true"]');
    if (existing) {
      if (existing.dataset.loaded === "true") {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Не вдалося завантажити Telegram Mini App.")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-web-app.js";
    script.async = true;
    script.dataset.telegramWebApp = "true";
    script.addEventListener("load", () => { script.dataset.loaded = "true"; resolve(); }, { once: true });
    script.addEventListener("error", () => reject(new Error("Не вдалося завантажити Telegram Mini App.")), { once: true });
    document.head.append(script);
  });
  if (!window.Telegram?.WebApp) throw new Error("Відкрийте цей кабінет безпосередньо з Telegram.");
  return window.Telegram.WebApp;
}
