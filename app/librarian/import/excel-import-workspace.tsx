"use client";

import { useMemo, useRef, useState } from "react";

import LibrarianShell from "../_components/librarian-shell";
import { analyzeExcelWorkbook, MAX_EXCEL_BYTES, type WorkbookPreview } from "./excel-workbook-parser";
import styles from "./staging-import.module.css";

export default function ExcelImportWorkspace({
  displayName,
  roleLabel,
  signOutHref,
  writesEnabled,
}: {
  displayName: string;
  roleLabel: string;
  signOutHref: string;
  writesEnabled: boolean;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<WorkbookPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const errorCount = useMemo(() => preview?.issues.filter((item) => item.severity === "error").length ?? 0, [preview]);
  const warningCount = useMemo(() => preview?.issues.filter((item) => item.severity === "warning").length ?? 0, [preview]);

  async function analyze() {
    if (!file || busy) return;
    setBusy(true);
    setError("");
    setConfirmed(false);
    try {
      setPreview(await analyzeExcelWorkbook(file));
    } catch (reason) {
      setPreview(null);
      setError(reason instanceof Error ? reason.message : "Не вдалося прочитати Excel-файл.");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setFile(null);
    setPreview(null);
    setError("");
    setConfirmed(false);
    if (fileInput.current) fileInput.current.value = "";
  }

  return (
    <LibrarianShell
      activeSection="management"
      displayName={displayName}
      roleLabel={roleLabel}
      signOutHref={signOutHref}
      writesEnabled={writesEnabled}
    >
      <main className={styles.shell}>
        <section className={styles.card} aria-labelledby="import-title">
          <div className={styles.heading}>
            <div>
              <p>Захищений інструмент імпорту</p>
              <h1 id="import-title">Імпорт з Excel</h1>
            </div>
          </div>

        <div className={styles.warning}>
          <strong>Спочатку — лише перевірка.</strong>
          <span>Після вибору файла база даних не змінюється. Система читає структуру, пропускає колонку «Вигляд», службові рядки й підсумки та готує звіт.</span>
        </div>

        <div className={styles.templateBox}>
          <div>
            <strong>Рекомендований шаблон «Єдина бібліотека»</strong>
            <small>Times New Roman, 14 кегль; матеріали, залишки, вчителі, класи та обидва види видач.</small>
          </div>
          <a href="/templates/library-import-template.xlsx" download>Завантажити шаблон Excel</a>
        </div>

        <section className={styles.uploadBox} aria-labelledby="choose-file-title">
          <label>
            <span id="choose-file-title">Файл Excel (.xlsx, до {Math.round(MAX_EXCEL_BYTES / 1024 / 1024)} МіБ)</span>
            <input
              ref={fileInput}
              type="file"
              accept="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xlsx"
              disabled={busy}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setPreview(null);
                setError("");
                setConfirmed(false);
              }}
            />
          </label>
          <button type="button" disabled={!file || busy} onClick={() => void analyze()}>
            {busy ? "Перевіряю…" : "Перевірити файл"}
          </button>
          {file || preview ? <button className={styles.secondaryAction} type="button" disabled={busy} onClick={reset}>Очистити</button> : null}
        </section>

        {error ? <p className={styles.message} role="alert">{error}</p> : null}

        {preview ? (
          <>
            <section className={styles.preview} aria-labelledby="preview-title">
              <div className={styles.previewHeading}>
                <div>
                  <p>Попередній звіт</p>
                  <h2 id="preview-title">{preview.fileName}</h2>
                </div>
                <span className={errorCount ? styles.badgeError : styles.badgeOk}>{errorCount ? `${errorCount} помилок` : "Структура придатна"}</span>
              </div>
              <dl className={styles.metrics}>
                <Metric label="Аркушів" value={preview.sheetCount} />
                <Metric label="Матеріалів" value={preview.materialRows} />
                <Metric label="Залишків" value={preview.stockRows} />
                <Metric label="Вчителів" value={preview.teacherRows} />
                <Metric label="Класів" value={preview.classRows} />
                <Metric label="Видач класам" value={preview.classLoanRows} />
                <Metric label="Видач учителям" value={preview.teacherLoanRows} />
              </dl>

              <div className={styles.sheetTableWrap}>
                <table className={styles.sheetTable}>
                  <caption>Розпізнані аркуші та колонки</caption>
                  <thead><tr><th>Аркуш</th><th>Рядків</th><th>Колонки</th><th>Пропущено</th></tr></thead>
                  <tbody>{preview.sheets.map((sheet) => (
                    <tr key={sheet.name}>
                      <th scope="row">{sheet.name}</th>
                      <td>{sheet.dataRows}</td>
                      <td>{sheet.columns.join(", ") || "—"}</td>
                      <td>{sheet.ignoredColumns.join(", ") || "—"}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </section>

            <section className={styles.issues} aria-labelledby="issues-title">
              <div><h2 id="issues-title">Перевірки</h2><span>{errorCount} помилок · {warningCount} попереджень</span></div>
              {preview.issues.length ? <ul>{preview.issues.map((issue, index) => (
                <li className={issue.severity === "error" ? styles.issueError : styles.issueWarning} key={`${issue.message}-${index}`}>
                  <strong>{issue.severity === "error" ? "Помилка" : "Увага"}{issue.sheet ? ` · ${issue.sheet}` : ""}</strong>
                  <span>{issue.message}</span>
                </li>
              ))}</ul> : <p className={styles.success}>Помилок і попереджень не знайдено.</p>}
            </section>

            <section className={styles.confirmBox} aria-labelledby="confirm-title">
              <div>
                <strong id="confirm-title">Фінальне перенесення виконується окремо</strong>
                <small>
                  Цей звіт можна завантажити й перевірити. Запис у D1 дозволяється лише у спеціально відкритому вікні імпорту після резервної копії; аркуші видач не перетворюються на від’ємні залишки.
                </small>
              </div>
              <label>
                <input type="checkbox" checked={confirmed} disabled={errorCount > 0} onChange={(event) => setConfirmed(event.target.checked)} />
                <span>Я переглянув(ла) звіт і підтверджую підготовку пакета перенесення.</span>
              </label>
              <div className={styles.reportActions}>
                <button type="button" onClick={() => downloadReport(preview)}>Завантажити звіт JSON</button>
                <button type="button" disabled={!confirmed || errorCount > 0 || !writesEnabled} onClick={() => downloadReport(preview, true)}>
                  Підготувати пакет перенесення
                </button>
              </div>
              {!writesEnabled ? <p className={styles.inlineNote}>Запис у кабінеті зараз вимкнено адміністратором; перевірка й звіт доступні.</p> : null}
            </section>
          </>
        ) : null}
        </section>
      </main>
    </LibrarianShell>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div><dt>{label}</dt><dd>{value.toLocaleString("uk-UA")}</dd></div>;
}

function downloadReport(preview: WorkbookPreview, prepared = false) {
  const body = JSON.stringify({
    format: prepared ? "library-excel-transfer-preview" : "library-excel-validation-report",
    formatVersion: 1,
    preview,
    important: "Це звіт перевірки, а не SQL і не команда автоматичного запису в D1.",
  }, null, 2);
  const url = URL.createObjectURL(new Blob([body], { type: "application/json;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${prepared ? "пакет-перенесення" : "звіт-перевірки"}-${preview.fileName.replace(/\.xlsx$/iu, "")}.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
