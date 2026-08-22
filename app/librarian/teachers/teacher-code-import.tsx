"use client";

import { useState } from "react";

import { visitApi, VisitApiError } from "@/app/visits/visit-client";
import {
  parseTeacherCodeImport,
  type TeacherCodeImportPreview,
} from "./teacher-code-import-parser";
import styles from "./teacher-code-import.module.css";

type ImportEnvelope = {
  success: true;
  count: number;
  teacherUserIds: string[];
};

export default function TeacherCodeImport({
  writesEnabled,
  onImported,
}: {
  writesEnabled: boolean;
  onImported: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<TeacherCodeImportPreview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [inputKey, setInputKey] = useState(0);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());

  async function chooseFile(file: File | null) {
    setPreview(null);
    setAcknowledged(false);
    setNotice("");
    setError("");
    if (!file) return;
    setRequestId(crypto.randomUUID());
    setBusy(true);
    try {
      setPreview(await parseTeacherCodeImport(file));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не вдалося прочитати Excel-файл.");
      setInputKey((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }

  async function importCodes() {
    if (!preview || !acknowledged || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await visitApi<ImportEnvelope>("/api/librarian/visits/teacher-access/import", {
        method: "POST",
        body: JSON.stringify({
          requestId,
          confirmation: "IMPORT_MISSING_TEACHER_CODES",
          rows: preview.rows.map(({ teacherUserId, fullName, code }) => ({ teacherUserId, fullName, code })),
        }),
      });
      setPreview(null);
      setAcknowledged(false);
      setInputKey((value) => value + 1);
      setRequestId(crypto.randomUUID());
      setNotice(`Імпортовано ${result.count} ${pluralCode(result.count)}. Учителі мають змінити тимчасовий код на власний PIN після першого входу.`);
      await onImported();
    } catch (caught) {
      setError(importError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="teacher-code-import-title">
      <div className={styles.heading}>
        <div>
          <span>Excel · до 100 кодів</span>
          <h3 id="teacher-code-import-title">Імпорт тимчасових кодів</h3>
          <p>Завантажте готовий шаблон, заповніть коди для потрібних учителів і поверніть файл сюди. Рядки без коду буде пропущено, а чинні PIN-коди не змінюються.</p>
        </div>
        <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          {open ? "Закрити" : "Імпортувати коди з Excel"}
        </button>
      </div>

      {open ? (
        <div className={styles.body}>
          <div className={styles.steps}>
            {/* This is a protected file response, not an application page. */}
            <a className={styles.templateLink} href="/api/librarian/visits/teacher-access/import-template" download>
              1. Завантажити актуальний шаблон Excel
            </a>
            <label className={styles.fileLabel}>
              <span>2. Обрати заповнений файл .xlsx</span>
              <input
                key={inputKey}
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(event) => void chooseFile(event.currentTarget.files?.[0] ?? null)}
                disabled={!writesEnabled || busy}
              />
            </label>
          </div>
          {!writesEnabled ? <div className={styles.info}>Запис зараз вимкнено адміністратором. Шаблон можна завантажити, але імпорт недоступний.</div> : null}
          {error ? <div className={styles.error} role="alert">{error}</div> : null}
          {notice ? <div className={styles.success} role="status">{notice}</div> : null}
          {preview ? (
            <div className={styles.preview}>
              <div><strong>{preview.rows.length}</strong><span>кодів готові до імпорту</span><small>{preview.fileName}</small></div>
              <ul aria-label="Учителі у файлі">
                {preview.rows.slice(0, 8).map((row) => <li key={row.teacherUserId}>{row.fullName}<span>код перевірено</span></li>)}
                {preview.rows.length > 8 ? <li>Ще {preview.rows.length - 8}…</li> : null}
              </ul>
              <label className={styles.confirmation}>
                <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.currentTarget.checked)} disabled={busy} />
                <span>Підтверджую: це тимчасові коди для першого входу, а файл після передачі кодів буде безпечно видалено.</span>
              </label>
              <button className={styles.importButton} type="button" onClick={() => void importCodes()} disabled={!writesEnabled || !acknowledged || busy}>
                {busy ? "Імпортуємо…" : `3. Імпортувати ${preview.rows.length} ${pluralCode(preview.rows.length)}`}
              </button>
            </div>
          ) : busy ? <p className={styles.loading}>Перевіряємо файл…</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function importError(error: unknown): string {
  if (error instanceof VisitApiError) {
    if (["teacher_code_import_mismatch", "teacher_code_import_conflict"].includes(error.code)) {
      return "Список учителів або кодів змінився. Жоден код не імпортовано — завантажте новий шаблон і повторіть.";
    }
    return error.message;
  }
  return "Не вдалося імпортувати коди. Дані не змінено.";
}

function pluralCode(value: number): string {
  const last = value % 10;
  const lastTwo = value % 100;
  return last === 1 && lastTwo !== 11 ? "код" : last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14) ? "коди" : "кодів";
}
