"use client";

import { useEffect, useState } from "react";
import SiteIcon from "@/app/_components/site-icon";
import LibrarianShell from "../_components/librarian-shell";
import styles from "./excel-export.module.css";

type ExportState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; fileName: string; sheets: number; rows: number }
  | { kind: "error"; message: string };

type ClassOption = {
  id: string;
  academicYear: string;
  className: string;
  teacherName: string;
  locationName: string;
  remainingQuantity: number;
};

type ClassExportState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; fileName: string; documents: number; rows: number }
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
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [classesLoading, setClassesLoading] = useState(true);
  const [classesError, setClassesError] = useState("");
  const [selectedClassId, setSelectedClassId] = useState("");
  const [classState, setClassState] = useState<ClassExportState>({ kind: "idle" });
  const loading = state.kind === "loading";
  const classLoading = classState.kind === "loading";

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/librarian/class-excel-export", {
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        const body = await response.json().catch(() => null) as { classes?: ClassOption[]; error?: string } | null;
        if (!response.ok || !Array.isArray(body?.classes)) {
          throw new Error(body?.error || "Не вдалося завантажити список класів.");
        }
        setClasses(body.classes);
        setSelectedClassId((current) => current || body.classes?.[0]?.id || "");
        setClassesError("");
      } catch (error) {
        if (controller.signal.aborted) return;
        setClassesError(error instanceof Error ? error.message : "Не вдалося завантажити список класів.");
      } finally {
        if (!controller.signal.aborted) setClassesLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

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

  async function downloadClassExport(allClasses: boolean) {
    if (classLoading || (!allClasses && !selectedClassId)) return;
    setClassState({ kind: "loading" });
    try {
      const query = allClasses ? "all=true" : `classYearId=${encodeURIComponent(selectedClassId)}`;
      const response = await fetch(`/api/librarian/class-excel-export?${query}`, {
        method: "GET",
        cache: "no-store",
        headers: { Accept: allClasses ? "application/zip" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || "Не вдалося сформувати документи класів.");
      }
      const fallbackName = allClasses ? "Видачі класам.zip" : "Документ класу.xlsx";
      const fileName = safeFileName(response.headers.get("X-Export-Filename") ?? "") || fallbackName;
      triggerDownload(await response.blob(), fileName);
      setClassState({
        kind: "success",
        fileName,
        documents: positiveHeader(response.headers.get("X-Export-Documents")),
        rows: positiveHeader(response.headers.get("X-Export-Rows")),
      });
    } catch (error) {
      setClassState({
        kind: "error",
        message: error instanceof Error ? error.message : "Не вдалося сформувати документи класів.",
      });
    }
  }

  return (
    <LibrarianShell
      activeSection="management"
      displayName={displayName}
      roleLabel={role === "admin" ? "Адміністратор" : "Бібліотекар"}
      signOutHref={signOutHref}
    >
      <main className={styles.shell}>
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
              <a href="/librarian/import">Відкрити імпорт з Excel <SiteIcon name="next" size={17} /></a>
            </div>
          </aside>
        </div>

        <section className={styles.classExportCard} aria-labelledby="class-export-title" aria-busy={classLoading}>
          <div className={styles.cardHeading}>
            <div><p>Окремі документи</p><h2 id="class-export-title">Видані матеріали по класах</h2></div>
            <span aria-hidden="true">2 аркуші</span>
          </div>
          <p className={styles.description}>
            Для кожного активного класу формується окремий Excel-документ. У ньому є два аркуші: «Підручники» та «Методична література, зошити».
          </p>
          <div className={styles.classExportGrid}>
            <label className={styles.classSelect}>
              <span>Клас</span>
              <select
                value={selectedClassId}
                onChange={(event) => setSelectedClassId(event.target.value)}
                disabled={classesLoading || classLoading || classes.length === 0}
              >
                {classes.length === 0 ? <option value="">Активних класів немає</option> : null}
                {classes.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.className} · {item.academicYear} · залишилося {item.remainingQuantity}
                  </option>
                ))}
              </select>
            </label>
            <div className={styles.classDetails} aria-live="polite">
              {classesLoading ? <span>Завантажую класи…</span> : null}
              {!classesLoading && classesError ? <span className={styles.inlineError}>{classesError}</span> : null}
              {!classesLoading && !classesError && selectedClassId ? (() => {
                const selected = classes.find((item) => item.id === selectedClassId);
                return selected ? (
                  <><span><strong>Кабінет:</strong> {selected.locationName}</span><span><strong>Куратор класу:</strong> {selected.teacherName}</span></>
                ) : null;
              })() : null}
            </div>
          </div>
          <ul className={styles.checkList}>
            <li>Колонки: №, предмет, назва/автор/рік</li>
            <li>Залишилося у класу, рубрика, дата видачі</li>
            <li>Тільки фактично неповернуті примірники</li>
            <li>Times New Roman, 14 кегль, готово до друку</li>
          </ul>
          <div className={styles.classActions}>
            <button
              className={styles.secondaryButton}
              type="button"
              disabled={classLoading || !selectedClassId}
              onClick={() => void downloadClassExport(false)}
            >
              {classLoading ? "Формую…" : "Завантажити обраний клас"}
            </button>
            <button
              className={styles.downloadButton}
              type="button"
              disabled={classLoading || classes.length === 0}
              onClick={() => void downloadClassExport(true)}
            >
              {classLoading ? "Формую архів…" : "Завантажити всі класи (.zip)"}
            </button>
          </div>
          {classState.kind === "error" ? <p className={styles.error} role="alert">{classState.message} Дані на сайті не змінено.</p> : null}
          {classState.kind === "success" ? (
            <div className={styles.success} role="status">
              <strong>Документ завантажено</strong>
              <span>{classState.fileName}</span>
              <small>{classState.documents.toLocaleString("uk-UA")} документів · {classState.rows.toLocaleString("uk-UA")} рядків даних</small>
            </div>
          ) : null}
        </section>
        </section>
      </main>
    </LibrarianShell>
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

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
