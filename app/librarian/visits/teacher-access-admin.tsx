"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { visitApi, VisitApiError } from "@/app/visits/visit-client";
import { teacherCodesCsv } from "./teacher-code-csv";
import styles from "./visit-access-admin.module.css";

type CredentialStatus = "active" | "disabled" | "locked";
type TeacherAccessAction = "enable" | "disable" | "unlock" | "revoke_sessions";

type TeacherCredential = {
  status: CredentialStatus;
  version: number;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  activeSessions: number;
  mustChangePin: boolean;
};

type TeacherAccessRow = {
  id: string;
  fullName: string;
  status: "active" | "inactive";
  credential: TeacherCredential | null;
};

type TeacherAccessEnvelope = {
  success: true;
  writesEnabled: boolean;
  teachers: TeacherAccessRow[];
};

type OneTimeCode = {
  teacherId: string;
  fullName: string;
  code: string;
};

type CodeIssueEnvelope = {
  success: true;
  teacher: { id: string; fullName: string };
  credential: TeacherCredential;
  code: string;
};

type BulkIssueEnvelope = {
  success: true;
  issued: Array<{ teacherUserId: string; fullName: string; code: string; version: number }>;
  skippedExisting?: number;
};

type ActionEnvelope = {
  success: true;
  teacher: { id: string; fullName: string };
  credential: TeacherCredential;
};

type NoticeTone = "success" | "error" | "info";

const DIRECTORY_URL = "/api/librarian/visits/teacher-access";
const BULK_CONFIRMATION = "ISSUE_MISSING_ONLY";

export default function TeacherAccessAdmin({
  writesEnabled,
  refreshKey = 0,
}: {
  writesEnabled: boolean;
  refreshKey?: number;
}) {
  const [data, setData] = useState<TeacherAccessEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "missing" | CredentialStatus>("all");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [noticeTone, setNoticeTone] = useState<NoticeTone>("info");
  const [oneTimeCodes, setOneTimeCodes] = useState<OneTimeCode[]>([]);
  const [clipboardNotice, setClipboardNotice] = useState("");

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const next = await visitApi<TeacherAccessEnvelope>(DIRECTORY_URL);
      setData(next);
    } catch (error) {
      setNotice(accessErrorMessage(error));
      setNoticeTone("error");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load, refreshKey]);

  const teachers = useMemo(
    () => (data?.teachers ?? []).filter((teacher) => teacher.status === "active"),
    [data],
  );
  const missingCount = useMemo(
    () => teachers.filter((teacher) => teacher.credential === null).length,
    [teachers],
  );
  const filteredTeachers = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("uk-UA");
    return teachers.filter((teacher) => {
      if (normalizedQuery && !teacher.fullName.toLocaleLowerCase("uk-UA").includes(normalizedQuery)) {
        return false;
      }
      if (filter === "missing") return teacher.credential === null;
      if (filter !== "all") return teacher.credential?.status === filter;
      return true;
    });
  }, [filter, query, teachers]);

  const canWrite = writesEnabled && data?.writesEnabled === true && !busyAction;

  async function issueCode(teacher: TeacherAccessRow) {
    const existing = teacher.credential !== null;
    if (existing && !window.confirm(
      `Скинути PIN для ${teacher.fullName} і видати новий тимчасовий код? Попередній PIN одразу перестане працювати, а всі відкриті сеанси буде завершено.`,
    )) return;

    setBusyAction(`code:${teacher.id}`);
    setNotice("");
    setClipboardNotice("");
    try {
      const result = await visitApi<CodeIssueEnvelope>(
        `${DIRECTORY_URL}/${encodeURIComponent(teacher.id)}/code`,
        {
          method: "POST",
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            expectedVersion: teacher.credential?.version ?? 0,
          }),
        },
      );
      setOneTimeCodes([{ teacherId: result.teacher.id, fullName: result.teacher.fullName, code: result.code }]);
      setNotice(existing ? "PIN скинуто. Передайте вчителю новий тимчасовий код." : "Тимчасовий код створено. Після першого входу вчитель встановить власний PIN.");
      setNoticeTone("success");
      await load(true);
    } catch (error) {
      setNotice(codeIssueErrorMessage(error));
      setNoticeTone("error");
    } finally {
      setBusyAction(null);
    }
  }

  async function updateCredential(teacher: TeacherAccessRow, action: TeacherAccessAction) {
    if (!teacher.credential) return;
    const confirmation = actionConfirmation(teacher, action);
    if (confirmation && !window.confirm(confirmation)) return;

    setBusyAction(`${action}:${teacher.id}`);
    setNotice("");
    try {
      await visitApi<ActionEnvelope>(`${DIRECTORY_URL}/${encodeURIComponent(teacher.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          expectedVersion: teacher.credential.version,
          action,
        }),
      });
      setNotice(actionSuccessMessage(action, teacher.fullName));
      setNoticeTone("success");
      await load(true);
    } catch (error) {
      setNotice(accessErrorMessage(error));
      setNoticeTone("error");
    } finally {
      setBusyAction(null);
    }
  }

  async function bulkIssue() {
    if (missingCount === 0) return;
    if (!window.confirm(
      `Створити одноразові коди для ${missingCount} активних учителів, які ще не мають коду? Існуючі коди не зміняться.`,
    )) return;

    setBusyAction("bulk-issue");
    setNotice("");
    setClipboardNotice("");
    try {
      const result = await visitApi<BulkIssueEnvelope>(`${DIRECTORY_URL}/bulk-issue`, {
        method: "POST",
        body: JSON.stringify({ requestId: crypto.randomUUID(), confirmation: BULK_CONFIRMATION }),
      });
      setOneTimeCodes(result.issued.map((item) => ({
        teacherId: item.teacherUserId,
        fullName: item.fullName,
        code: item.code,
      })));
      setNotice(result.issued.length
        ? `Створено ${result.issued.length} ${pluralCode(result.issued.length)}. Збережіть або роздрукуйте список зараз.`
        : "Нових кодів не створено: усі активні вчителі вже мають доступ.");
      setNoticeTone(result.issued.length ? "success" : "info");
      await load(true);
    } catch (error) {
      setNotice(codeIssueErrorMessage(error));
      setNoticeTone("error");
    } finally {
      setBusyAction(null);
    }
  }

  async function copyCodes(codes = oneTimeCodes) {
    const copied = await copyTextWithFallback(codeListText(codes));
    if (copied) {
      setClipboardNotice(codes.length === 1 ? "Код скопійовано." : "Список кодів скопійовано.");
    } else {
      setClipboardNotice("Браузер не дозволив автоматичне копіювання. Виділіть код вручну або завантажте список.");
    }
  }

  function downloadCodes() {
    const csv = teacherCodesCsv(oneTimeCodes);
    const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `коди-вчителів-${todayInKyiv()}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function printCodes() {
    const className = "visit-access-code-print";
    const cleanup = () => document.body.classList.remove(className);
    document.body.classList.add(className);
    window.addEventListener("afterprint", cleanup, { once: true });
    window.print();
  }

  function forgetCodes() {
    setOneTimeCodes([]);
    setClipboardNotice("");
  }

  return (
    <section className={styles.accessCard} aria-labelledby="teacher-access-title">
      <div className={styles.heading}>
        <div>
          <span>Вхід без email</span>
          <h2 id="teacher-access-title">PIN-коди та відновлення доступу</h2>
          <p>Бібліотекар видає тимчасовий код. Після першого входу вчитель створює власний 4-значний PIN. Забутий PIN тут можна лише скинути, але не переглянути.</p>
        </div>
        <button className={styles.secondaryButton} type="button" onClick={() => void load()} disabled={loading || Boolean(busyAction)}>
          ↻ Оновити
        </button>
      </div>

      {!writesEnabled || data?.writesEnabled === false ? (
        <div className={styles.info} role="status">Зміни доступу тимчасово вимкнені адміністратором. Перегляд списку залишається доступним.</div>
      ) : null}
      {notice ? <div className={styles[noticeTone]} role={noticeTone === "error" ? "alert" : "status"}>{notice}</div> : null}

      {oneTimeCodes.length ? (
        <section className={styles.codeReveal} aria-labelledby="one-time-code-title">
          <div className={styles.codeRevealHeading}>
            <div>
              <span>Показується лише зараз</span>
              <h3 id="one-time-code-title">Тимчасові коди для першого входу</h3>
            </div>
            <button className={styles.forgetButton} type="button" onClick={forgetCodes}>Закрити й забути</button>
          </div>
          <p className={styles.codeWarning} id="one-time-code-warning">
            Сайт не зберігає ці коди у відкритому вигляді. Передайте код відповідному вчителю: після входу він створить власний PIN із 4 цифр.
          </p>
          <div className={styles.codeList} aria-describedby="one-time-code-warning">
            {oneTimeCodes.map((item) => (
              <article key={item.teacherId}>
                <strong>{item.fullName}</strong>
                <code>{item.code}</code>
                <button type="button" onClick={() => void copyCodes([item])} aria-label={`Скопіювати код для ${item.fullName}`}>Копіювати</button>
              </article>
            ))}
          </div>
          <div className={styles.revealActions}>
            <button type="button" onClick={() => void copyCodes()}>Копіювати всі</button>
            <button type="button" onClick={downloadCodes}>Завантажити CSV</button>
            <button type="button" onClick={printCodes}>Друкувати</button>
          </div>
          <p className={styles.clipboardNotice} role="status" aria-live="polite">{clipboardNotice}</p>
        </section>
      ) : null}

      <div className={styles.summary} aria-label="Стан доступу вчителів">
        <div><strong>{teachers.length}</strong><span>активних учителів</span></div>
        <div><strong>{missingCount}</strong><span>ще без коду</span></div>
        <div><strong>{teachers.filter((teacher) => teacher.credential?.status === "locked").length}</strong><span>тимчасово заблоковано</span></div>
      </div>

      <div className={styles.toolbar}>
        <label className={styles.searchLabel} htmlFor="teacher-access-search">
          Пошук учителя
          <input
            id="teacher-access-search"
            type="search"
            autoComplete="off"
            maxLength={80}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Прізвище або ім’я"
          />
        </label>
        <label htmlFor="teacher-access-filter">
          Стан
          <select id="teacher-access-filter" value={filter} onChange={(event) => setFilter(event.currentTarget.value as typeof filter)}>
            <option value="all">Усі</option>
            <option value="missing">Без коду</option>
            <option value="active">Активні</option>
            <option value="locked">Заблоковані</option>
            <option value="disabled">Вимкнені</option>
          </select>
        </label>
        <button
          className={styles.bulkButton}
          type="button"
          onClick={() => void bulkIssue()}
          disabled={!canWrite || missingCount === 0}
        >
          {busyAction === "bulk-issue" ? "Створюємо…" : `Видати тимчасові коди (${missingCount})`}
        </button>
      </div>
      <p className={styles.bulkHint}>Масова видача створює тимчасові коди лише для вчителів без доступу. Чинні PIN-коди не змінюються.</p>

      {loading ? <p className={styles.empty}>Оновлюємо список учителів…</p> : filteredTeachers.length ? (
        <div className={styles.tableRegion} role="region" aria-label="Коди доступу вчителів">
          <table className={styles.accessTable}>
            <thead>
              <tr><th scope="col">Учитель</th><th scope="col">Стан</th><th scope="col">Останній вхід</th><th scope="col">Сеанси</th><th scope="col"><span className="sr-only">Дії</span></th></tr>
            </thead>
            <tbody>
              {filteredTeachers.map((teacher) => (
                <tr key={teacher.id}>
                  <th scope="row">{teacher.fullName}</th>
                  <td data-label="Стан"><CredentialBadge credential={teacher.credential} /></td>
                  <td data-label="Останній вхід">{teacher.credential?.lastLoginAt ? formatDateTime(teacher.credential.lastLoginAt) : "—"}</td>
                  <td data-label="Сеанси">{teacher.credential?.activeSessions ?? 0}</td>
                  <td className={styles.rowActions}>
                    <button
                      type="button"
                      onClick={() => void issueCode(teacher)}
                      disabled={!canWrite}
                    >
                      {busyAction === `code:${teacher.id}` ? "Створюємо…" : teacher.credential ? "Забув PIN — скинути" : "Створити тимчасовий код"}
                    </button>
                    {teacher.credential?.status === "disabled" ? (
                      <button type="button" onClick={() => void updateCredential(teacher, "enable")} disabled={!canWrite}>Увімкнути</button>
                    ) : teacher.credential ? (
                      <button className={styles.dangerButton} type="button" onClick={() => void updateCredential(teacher, "disable")} disabled={!canWrite}>Вимкнути</button>
                    ) : null}
                    {teacher.credential?.status === "locked" ? (
                      <button type="button" onClick={() => void updateCredential(teacher, "unlock")} disabled={!canWrite}>Розблокувати</button>
                    ) : null}
                    {(teacher.credential?.activeSessions ?? 0) > 0 ? (
                      <button type="button" onClick={() => void updateCredential(teacher, "revoke_sessions")} disabled={!canWrite}>Завершити сеанси</button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className={styles.empty}>За цими фільтрами активних учителів не знайдено.</p>}
    </section>
  );
}

function CredentialBadge({ credential }: { credential: TeacherCredential | null }) {
  if (!credential) return <span className={`${styles.badge} ${styles.missingBadge}`}>Без коду</span>;
  const label = credential.mustChangePin && credential.status === "active"
    ? "Очікує створення PIN"
    : credential.status === "active"
    ? "Активний"
    : credential.status === "disabled"
      ? "Вимкнений"
      : "Заблокований";
  return (
    <span className={`${styles.badge} ${styles[`${credential.status}Badge`]}`}>
      {label}
      {credential.status === "locked" && credential.lockedUntil ? <small>до {formatDateTime(credential.lockedUntil)}</small> : null}
    </span>
  );
}

function actionConfirmation(teacher: TeacherAccessRow, action: TeacherAccessAction): string | null {
  if (action === "disable") return `Вимкнути доступ для ${teacher.fullName}? Усі відкриті сеанси буде завершено, але записи збережуться.`;
  if (action === "revoke_sessions") return `Завершити всі відкриті сеанси ${teacher.fullName}? Код залишиться чинним.`;
  return null;
}

function actionSuccessMessage(action: TeacherAccessAction, name: string): string {
  if (action === "enable") return `Доступ для ${name} увімкнено.`;
  if (action === "disable") return `Доступ для ${name} вимкнено.`;
  if (action === "unlock") return `${name} розблоковано.`;
  return `Відкриті сеанси ${name} завершено.`;
}

function codeIssueErrorMessage(error: unknown): string {
  if (error instanceof VisitApiError && error.code === "code_result_unrecoverable") {
    return "Код було змінено, але одноразову відповідь уже неможливо відновити. Оновіть список і створіть новий код.";
  }
  if (error instanceof VisitApiError && (!error.status || error.status >= 500)) {
    return "Не вдалося отримати одноразовий код. Якщо зміна могла зберегтися, оновіть список і створіть новий код — попередній відкритий код відновити неможливо.";
  }
  return accessErrorMessage(error);
}

function accessErrorMessage(error: unknown): string {
  if (error instanceof VisitApiError) return error.message;
  return "Не вдалося виконати запит. Спробуйте ще раз.";
}

function codeListText(codes: OneTimeCode[]): string {
  return [
    "Коди доступу до графіка відвідування бібліотеки",
    "Передайте кожен код лише відповідному вчителю.",
    "",
    ...codes.map((item) => `${item.fullName}\t${item.code}`),
  ].join("\n");
}

async function copyTextWithFallback(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Some browsers expose the modern API but deny it inside embedded pages.
      // Continue with the selection-based fallback while the click is active.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto -9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);

  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("uk-UA", {
    timeZone: "Europe/Kyiv",
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function pluralCode(count: number): string {
  const tens = count % 100;
  const units = count % 10;
  if (tens >= 11 && tens <= 14) return "кодів";
  if (units === 1) return "код";
  if (units >= 2 && units <= 4) return "коди";
  return "кодів";
}

function todayInKyiv(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
