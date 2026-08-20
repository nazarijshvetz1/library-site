"use client";

/* eslint-disable @next/next/no-img-element -- shared external library logo is intentionally reused. */

import { useState } from "react";
import styles from "./excel-export.module.css";

type ExportState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; fileName: string; sheets: number; rows: number }
  | { kind: "error"; message: string };

export default function ExcelExportWorkspace({
  displayName,
  role,
  signOutHref,
}: {
  displayName: string;
  role: "librarian" | "admin";
  signOutHref: string;
}) {
  const [state, setState] = useState<ExportState>({ kind: "idle" });
  const loading = state.kind === "loading";

  async function downloadExport() {
    if (loading) return;
    setState({ kind: "loading" });
    try {
      const response = await fetch("/api/librarian/excel-export", {
        method: "GET",
        cache: "no-store",
        headers: { Accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || "Не вдалося сформувати Excel-файл.");
      }
      const blob = await response.blob();
      const encodedName = response.headers.get("X-Export-Filename") ?? "";
      const fileName = safeFileName(encodedName) || "Єдина бібліотека — повний експорт.xlsx";
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setState({
        kind: "success",
        fileName,
        sheets: positiveHeader(response.headers.get("X-Export-Sheets")),
        rows: positiveHeader(response.headers.get("X-Export-Rows")),
      });
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "Не вдалося сформувати Excel-файл.",
      });
    }
  }

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <a className={styles.brand} href="/librarian">
          <img src="https://nazarijshvetz1.github.io/library-site/library-logo.png" alt="" width="52" height="52" />
          <span><strong>Єдина бібліотека</strong><small>Експорт службової бази</small></span>
        </a>
        <nav className={styles.headerNav} aria-label="Розділи кабінету бібліотекаря">
          <a href="/librarian">Каталог</a>
          <a href="/librarian/visits">Розклад</a>
          <a href="/librarian/teachers">Вчителі</a>
        </nav>
        <div className={styles.account}>
          <span><strong>{displayName}</strong><small>{role === "admin" ? "Адміністратор" : "Бібліотекар"}</small></span>
          <a href={signOutHref}>Вийти</a>
        </div>
      </header>

      <section className={styles.page} aria-labelledby="export-title">
        <div className={styles.intro}>
          <p>Захищений інструмент · лише читання</p>
          <h1 id="export-title">Експорт в Excel</h1>
          <span>Сформуйте повний знімок бібліотечної бази одним файлом. Експорт нічого не змінює і не видаляє на сайті.</span>
        </div>

        <div className={styles.layout}>
          <section className={styles.primaryCard} aria-labelledby="full-export-title" aria-busy={loading}>
            <div className={styles.cardHeading}>
              <div><p>Рекомендовано</p><h2 id="full-export-title">Повний експорт бібліотеки</h2></div>
              <span aria-hidden="true">XLSX</span>
            </div>
            <p className={styles.description}>
              Один файл із каталогом, фактичними залишками, класами, вчителями, усією історією видач та заявками вчителів.
            </p>
            <ul className={styles.checkList}>
              <li>Зведення і контроль залишків</li>
              <li>Каталог без колонки «Вигляд» та без обкладинок</li>
              <li>Окремі аркуші за предметами і перегляд за класами</li>
              <li>Видачі класам і вчителям, включно з поверненнями</li>
              <li>Заявки, резерви, місця отримання і статуси</li>
              <li>Times New Roman, 14 кегль, фільтри та закріплені заголовки</li>
            </ul>
            <div className={styles.safetyNote}>
              <strong>Коди доступу не експортуються.</strong>
              <span>У файл не потрапляють PIN-коди, тимчасові коди, хеші, сесії або службові ключі.</span>
            </div>
            <button className={styles.downloadButton} type="button" disabled={loading} onClick={() => void downloadExport()}>
              {loading ? "Формую Excel…" : "Сформувати й завантажити Excel"}
            </button>
            {state.kind === "error" ? <p className={styles.error} role="alert">{state.message} Дані на сайті не змінено.</p> : null}
            {state.kind === "success" ? (
              <div className={styles.success} role="status">
                <strong>Файл завантажено</strong>
                <span>{state.fileName}</span>
                <small>{state.sheets.toLocaleString("uk-UA")} аркушів · {state.rows.toLocaleString("uk-UA")} рядків даних</small>
              </div>
            ) : null}
          </section>

          <aside className={styles.sideCard} aria-labelledby="contents-title">
            <h2 id="contents-title">Що буде у файлі</h2>
            <ol>
              <li><strong>Зведення</strong><span>фонд, доступно, резерви й видано</span></li>
              <li><strong>Каталог і залишки</strong><span>усі матеріали, місця та стани</span></li>
              <li><strong>За класами і предметами</strong><span>готові аркуші для перегляду</span></li>
              <li><strong>Видачі</strong><span>окремо класи та вчителі</span></li>
              <li><strong>Заявки вчителів</strong><span>усі позиції та результати</span></li>
              <li><strong>Контроль</strong><span>автоматична перевірка розбіжностей</span></li>
            </ol>
            <div className={styles.importLink}>
              <strong>Потрібно завантажити дані на сайт?</strong>
              <span>Імпорт залишається окремим службовим інструментом.</span>
              <a href="/librarian/import">Відкрити імпорт з Excel →</a>
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}

function safeFileName(value: string): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value).replace(/[\\/:*?"<>|]/gu, "-").slice(0, 180);
  } catch {
    return "";
  }
}

function positiveHeader(value: string | null): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}
