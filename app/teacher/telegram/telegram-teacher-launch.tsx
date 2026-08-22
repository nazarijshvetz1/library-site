"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./telegram.module.css";

type TeacherTab = "overview" | "visits" | "orders" | "loans" | "notifications";
type TelegramWebApp = {
  initData: string;
  ready(): void;
  expand(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
};

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
  const [state, setState] = useState<"checking" | "error" | "disabled">(enabled ? "checking" : "disabled");
  const [message, setMessage] = useState(enabled ? "Перевіряємо безпечний вхід…" : "Кабінет у Telegram ще не ввімкнено.");
  const targetUrl = useMemo(
    () => `/teacher/telegram/cabinet?tab=${encodeURIComponent(targetTab)}`,
    [targetTab],
  );

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const controller = new AbortController();
    async function start() {
      setState("checking");
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
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        if (!response.ok) throw new Error(payload?.error || "Не вдалося відкрити кабінет учителя.");
        window.location.replace(targetUrl);
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        setState("error");
        setMessage(error instanceof Error ? error.message : "Не вдалося відкрити кабінет учителя.");
      }
    }
    void start();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [attempt, enabled, targetUrl]);

  const botUrl = botUsername ? `https://t.me/${botUsername}` : null;
  return (
    <main className={styles.page}>
      <section className={styles.panel} aria-labelledby="telegram-teacher-title">
        <div className={styles.mark} aria-hidden="true">ЄБ</div>
        <p className={styles.eyebrow}>Єдина бібліотека</p>
        <h1 id="telegram-teacher-title">Кабінет учителя</h1>
        <p className={styles.message} role={state === "error" ? "alert" : "status"}>{message}</p>
        {state === "checking" ? <span className={styles.spinner} aria-hidden="true" /> : null}
        {state === "error" ? (
          <button className={styles.primary} type="button" onClick={() => setAttempt((value) => value + 1)}>
            Спробувати ще раз
          </button>
        ) : null}
        {state !== "checking" && botUrl ? (
          <a className={styles.secondary} href={botUrl}>Відкрити бота</a>
        ) : null}
        <small>Вхід дозволено лише для Telegram, який учитель раніше підключив у своєму кабінеті.</small>
      </section>
    </main>
  );
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
