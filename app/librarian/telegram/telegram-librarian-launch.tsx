"use client";

import { useEffect, useMemo, useState } from "react";

import styles from "@/app/teacher/telegram/telegram.module.css";

type TelegramWebApp = {
  initData: string;
  ready(): void;
  expand(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
};

declare global {
  interface Window { Telegram?: { WebApp?: TelegramWebApp } }
}

export default function TelegramLibrarianLaunch({
  target,
  enabled,
  botUsername,
}: {
  target: "home" | "visits" | "teachers";
  enabled: boolean;
  botUsername: string | null;
}) {
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<"checking" | "error" | "disabled">(enabled ? "checking" : "disabled");
  const [message, setMessage] = useState(enabled ? "Перевіряємо захищений вхід…" : "Кабінет у Telegram ще не ввімкнено.");
  const targetUrl = useMemo(() => `/librarian/telegram/cabinet?target=${target}`, [target]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const controller = new AbortController();
    async function start() {
      setPhase("checking");
      setMessage("Перевіряємо захищений вхід…");
      try {
        const webApp = await loadTelegramWebApp();
        if (cancelled) return;
        webApp.ready();
        webApp.expand();
        webApp.setHeaderColor?.("#174d38");
        webApp.setBackgroundColor?.("#f4f5ef");
        if (!webApp.initData) throw new Error("Відкрийте кабінет кнопкою в приватному чаті з ботом.");
        const response = await fetch("/api/librarian/session/telegram", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ initData: webApp.initData }),
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => null) as { success?: boolean; error?: string } | null;
        if (!response.ok || !payload?.success) throw new Error(payload?.error || "Не вдалося відкрити кабінет бібліотекаря.");
        window.location.replace(targetUrl);
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        setPhase("error");
        setMessage(error instanceof Error ? error.message : "Не вдалося відкрити кабінет бібліотекаря.");
      }
    }
    void start();
    return () => { cancelled = true; controller.abort(); };
  }, [attempt, enabled, targetUrl]);

  const botUrl = botUsername ? `https://t.me/${botUsername}` : null;
  return (
    <main className={styles.page}>
      <section className={styles.panel} aria-labelledby="telegram-librarian-title">
        <div className={styles.mark} aria-hidden="true">ЄБ</div>
        <p className={styles.eyebrow}>Єдина бібліотека</p>
        <h1 id="telegram-librarian-title">Кабінет бібліотекаря</h1>
        <p className={styles.message} role={phase === "error" ? "alert" : "status"} aria-live="polite">{message}</p>
        {phase === "checking" ? <span className={styles.spinner} aria-hidden="true" /> : null}
        {phase === "error" ? <button className={styles.primary} type="button" onClick={() => setAttempt((value) => value + 1)}>Спробувати ще раз</button> : null}
        {phase !== "checking" && botUrl ? <a className={styles.secondary} href={botUrl}>Повернутися до бота</a> : null}
        <small>Доступ надається лише підключеному Telegram чинного бібліотекаря або адміністратора.</small>
      </section>
    </main>
  );
}

async function loadTelegramWebApp(): Promise<TelegramWebApp> {
  if (!document.querySelector('script[src="https://telegram.org/js/telegram-web-app.js"]')) {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://telegram.org/js/telegram-web-app.js";
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Не вдалося завантажити Telegram Mini App."));
      document.head.append(script);
    });
  }
  const webApp = window.Telegram?.WebApp;
  if (!webApp) throw new Error("Відкрийте цю сторінку з Telegram-бота.");
  return webApp;
}
