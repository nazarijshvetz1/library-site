"use client";

/* eslint-disable @next/next/no-html-link-for-pages -- full-page navigation is intentional in Vinext production. */

import { BarcodeFormat, QRCodeWriter } from "@zxing/library";
import { useCallback, useEffect, useRef, useState } from "react";
import SiteIcon from "@/app/_components/site-icon";
import CollapsibleListSection from "@/app/_components/collapsible-list-section";
import LibrarianShell from "../_components/librarian-shell";
import { parseAcquisitionWorkbook, type ParsedAcquisitionWorkbook } from "./acquisition-excel-parser";
import { acquisitionSubsections } from "./acquisition-navigation";
import styles from "./acquisition-workspace.module.css";

type RequestRecord = {
  id: string; publicNumber: string; requesterKind: "teacher" | "student"; requesterName: string; requesterClassName: string;
  category: "educational" | "literature"; sourceKind: "catalog" | "manual"; literatureKind: string; materialId: string | null;
  title: string; author: string; publicationYear: number | null; requestedQuantity: number; approvedQuantity: number | null;
  orderedQuantity: number; receivedQuantity: number; sourceUrl: string; subject: string; targetClass: string; requesterNote: string;
  librarianNote: string; clarificationMessage: string; rejectionReason: string; status: string; duplicateCount: number;
  academicYearLabel: string; version: number; updatedAt: string;
  librarianHiddenAt: string | null;
};
type Summary = { total: number; active: number; submitted: number; ordered: number; received: number; requestedCopies: number; orderedCopies: number; receivedCopies: number; duplicateGroups: number };
type Group = { duplicateKey: string; title: string; author: string; publicationYear: number | null; requestCount: number; requestedQuantity: number; orderedQuantity: number; receivedQuantity: number };
type Envelope = { success: true; requests: RequestRecord[]; summary: Summary; procurementGroups: Group[]; writesEnabled: boolean };
type Preview = { valid: boolean; rows: Array<{ sourceSheet: string; sourceRow: number; valid: boolean; errors: string[]; duplicateCount: number }>; totals: { rows: number; valid: number; errors: number; duplicates: number; existing?: number } };

const STATUS: Record<string, string> = { submitted: "Нова", in_review: "На розгляді", clarification: "Потрібне уточнення", approved: "Погоджено", planned: "Заплановано", ordered: "Замовлено", partially_received: "Частково отримано", received: "Отримано", rejected: "Відхилено", cancelled: "Скасовано" };

export default function AcquisitionWorkspace({ displayName, role = "librarian", writesEnabled, signOutHref, telegramMiniApp = false }: { displayName: string; role?: string; writesEnabled: boolean; signOutHref: string; telegramMiniApp?: boolean }) {
  const [data, setData] = useState<Envelope | null>(null); const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [status, setStatus] = useState("active"); const [requester, setRequester] = useState("all"); const [query, setQuery] = useState("");
  const [sort, setSort] = useState("date_desc"); const [showHidden, setShowHidden] = useState(false);
  const [workbook, setWorkbook] = useState<ParsedAcquisitionWorkbook | null>(null); const [preview, setPreview] = useState<Preview | null>(null);
  const [importId, setImportId] = useState("");
  const handoffHandled = useRef(false);
  const loadRequestRef = useRef(0);
  const loadScope = `${status}\u001e${requester}\u001e${query.trim()}\u001e${sort}\u001e${showHidden}`;
  const loadScopeRef = useRef(loadScope);
  useEffect(() => {
    loadScopeRef.current = loadScope;
  }, [loadScope]);

  const load = useCallback(async () => {
    const requestSequence = ++loadRequestRef.current;
    const requestScope = `${status}\u001e${requester}\u001e${query.trim()}\u001e${sort}\u001e${showHidden}`;
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ status, requester, q: query.trim(), sort, visibility: showHidden ? "all" : "visible" });
      const response = await fetch(`/api/librarian/acquisition-requests?${params}`, { cache: "no-store" });
      const body = await response.json() as Envelope & { error?: string };
      if (!response.ok) throw new Error(body.error || "Не вдалося завантажити комплектування.");
      if (requestSequence !== loadRequestRef.current || requestScope !== loadScopeRef.current) return;
      setData(body);
    } catch (loadError) {
      if (requestSequence === loadRequestRef.current && requestScope === loadScopeRef.current) setError(message(loadError));
    } finally {
      if (requestSequence === loadRequestRef.current && requestScope === loadScopeRef.current) setLoading(false);
    }
  }, [query, requester, showHidden, sort, status]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => {
    if (!data || handoffHandled.current) return;
    const timer = window.setTimeout(() => {
      const cleanUrl = telegramMiniApp ? "/librarian/telegram/cabinet?target=acquisitions" : "/librarian/acquisitions";
      const params = new URLSearchParams(window.location.search);
      const receiptRequest = (params.get("receiptRequest") ?? "").trim();
      if (receiptRequest) {
        handoffHandled.current = true;
        window.history.replaceState({}, "", cleanUrl);
        setNotice("Надходження оформлено. Відкрийте заявку й зарахуйте потрібну кількість із нового надходження.");
        return;
      }
      const requestId = (params.get("linkRequest") ?? "").trim();
      const materialId = (params.get("material") ?? "").trim().toUpperCase();
      if (!requestId && !materialId) return;
      handoffHandled.current = true;
      const record = data.requests.find((item) => item.id === requestId);
      if (!record || !/^CAT-\d{4,}$/u.test(materialId)) {
        setError("Матеріал створено, але заявку не знайдено для автоматичного прив’язування. CAT-ID можна прив’язати вручну.");
        return;
      }
      if (!writesEnabled) { setError("Матеріал створено, але запис зараз вимкнено. Прив’яжіть CAT-ID після відновлення запису."); return; }
      setBusy(true); setError(""); setNotice("");
      void fetch(`/api/librarian/acquisition-requests/${encodeURIComponent(record.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mutationId: crypto.randomUUID(), expectedVersion: record.version, action: "link_material", approvedQuantity: null, orderedQuantity: null, targetMaterialId: materialId, receiptLineId: "", allocatedQuantity: null, message: "" }),
      }).then(async (response) => {
        const body = await response.json() as { error?: string };
        if (!response.ok) throw new Error(body.error || "Не вдалося прив’язати створений матеріал.");
        window.history.replaceState({}, "", cleanUrl);
        setNotice(`Матеріал ${materialId} створено й прив’язано до заявки.`);
        await load();
      }).catch((handoffError) => setError(message(handoffError))).finally(() => setBusy(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [data, load, telegramMiniApp, writesEnabled]);

  async function act(record: RequestRecord, action: string) {
    let approvedQuantity: number | null = null, orderedQuantity: number | null = null, targetMaterialId: string | null = null, text = "";
    if (action === "approve") approvedQuantity = promptNumber("Погоджена кількість", record.requestedQuantity, 1); else if (action === "order") orderedQuantity = promptNumber("Замовлена кількість", record.approvedQuantity ?? record.requestedQuantity, 1);
    else if (action === "request_clarification") text = window.prompt("Що потрібно уточнити у вчителя?")?.trim() ?? "";
    else if (action === "reject") text = window.prompt("Причина відхилення")?.trim() ?? "";
    else if (action === "link_material") targetMaterialId = window.prompt("CAT-ID створеного матеріалу")?.trim().toUpperCase() ?? null;
    else if (action === "cancel" && !window.confirm("Скасувати цю заявку?")) return;
    if ((action === "approve" && approvedQuantity === null) || (action === "order" && orderedQuantity === null) || (["request_clarification","reject"].includes(action) && !text) || (action === "link_material" && !targetMaterialId)) return;
    await sendAction(record, { action, approvedQuantity, orderedQuantity, targetMaterialId, receiptLineId: "", allocatedQuantity: null, message: text });
  }
  async function sendAction(record: RequestRecord, fields: Record<string, unknown>) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/librarian/acquisition-requests/${encodeURIComponent(record.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mutationId: crypto.randomUUID(), expectedVersion: record.version, ...fields }) });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "Не вдалося змінити заявку.");
      setNotice("Зміни збережено. Учителя буде повідомлено."); await load();
    } catch (actionError) { setError(message(actionError)); } finally { setBusy(false); }
  }

  async function changeVisibility(record: RequestRecord, hidden: boolean) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/librarian/acquisition-requests/${encodeURIComponent(record.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: hidden ? "hide" : "restore", mutationId: crypto.randomUUID() }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "Не вдалося змінити видимість заявки.");
      setNotice(hidden ? "Завершену заявку приховано з робочого списку." : "Заявку повернуто до робочого списку.");
      await load();
    } catch (visibilityError) { setError(message(visibilityError)); } finally { setBusy(false); }
  }

  async function hideCompleted() {
    if (!window.confirm("Приховати всі отримані, відхилені та скасовані заявки? Історія не видаляється.")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/librarian/acquisition-requests", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "hide_completed", mutationId: crypto.randomUUID() }) });
      const body = await response.json() as { result?: { hiddenCount?: number }; error?: string };
      if (!response.ok) throw new Error(body.error || "Не вдалося приховати завершені заявки.");
      setNotice(body.result?.hiddenCount ? `Приховано завершених заявок: ${body.result.hiddenCount}.` : "Нових завершених заявок для приховування немає.");
      await load();
    } catch (hideError) { setError(message(hideError)); } finally { setBusy(false); }
  }

  async function chooseWorkbook(file: File | null) {
    setWorkbook(null); setPreview(null); setError(""); setNotice("");
    if (!file) return;
    setBusy(true);
    try {
      const parsed = await parseAcquisitionWorkbook(file); const nextImportId = crypto.randomUUID();
      setWorkbook(parsed); setImportId(nextImportId);
      const response = await fetch("/api/librarian/acquisition-requests/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "preview", importId: nextImportId, fileName: parsed.fileName, fileHash: parsed.fileHash, confirmation: null, rows: parsed.rows }) });
      const body = await response.json() as { preview?: Preview; error?: string };
      if (!response.ok || !body.preview) throw new Error(body.error || "Не вдалося перевірити файл.");
      setPreview(body.preview);
    } catch (parseError) { setError(message(parseError)); } finally { setBusy(false); }
  }
  async function commitImport() {
    if (!workbook || !preview?.valid || !window.confirm(`Імпортувати ${preview.totals.valid} перевірених рядків?`)) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/librarian/acquisition-requests/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "commit", importId, fileName: workbook.fileName, fileHash: workbook.fileHash, confirmation: "IMPORT_ACQUISITION_REQUESTS", rows: workbook.rows }) });
      const body = await response.json() as { result?: { imported: number; replayed: boolean }; error?: string };
      if (!response.ok || !body.result) throw new Error(body.error || "Імпорт не виконано.");
      setNotice(body.result.replayed ? "Цей файл уже імпортовано раніше; дублікати не створено." : `Імпортовано ${body.result.imported} рядків.`);
      setWorkbook(null); setPreview(null); await load();
    } catch (importError) { setError(message(importError)); } finally { setBusy(false); }
  }
  const summary = data?.summary;
  return <LibrarianShell
    activeSection="acquisitions"
    displayName={displayName}
    roleLabel={role === "admin" ? "Адміністратор" : "Бібліотекар"}
    signOutHref={signOutHref}
    telegramMiniApp={telegramMiniApp}
    writesEnabled={writesEnabled}
    subsections={acquisitionSubsections(telegramMiniApp)}
    activeSubsection="requests"
  >
    <main className={`${styles.shell} ${telegramMiniApp ? styles.telegram : ""}`}>
      <section className={styles.page}>
      <div className={styles.hero}><div><span>Керування придбаннями</span><h1>Комплектування фонду</h1><p>Дозамовлення, нові видання та пропозиції учнів — без впливу на фактичний залишок до оформлення надходження.</p></div><button type="button" onClick={() => void load()} disabled={loading} aria-busy={loading}><SiteIcon name={loading ? "loading" : "refresh"} size={18} /> {loading ? "Оновлюємо…" : "Оновити"}</button></div>
      {!writesEnabled ? <div className={styles.warning}>Запис тимчасово вимкнено. Дані доступні лише для перегляду.</div> : null}
      {error ? <div className={styles.error} role="alert">{error}</div> : null}{notice ? <div className={styles.success} role="status">{notice}</div> : null}
      <section className={styles.metrics} aria-label="Підсумок комплектування"><article><strong>{summary?.active ?? 0}</strong><span>активних заявок</span></article><article><strong>{summary?.requestedCopies ?? 0}</strong><span>запитано примірників</span></article><article><strong>{summary?.orderedCopies ?? 0}</strong><span>замовлено</span></article><article><strong>{summary?.receivedCopies ?? 0}</strong><span>фактично отримано</span></article><article><strong>{summary?.duplicateGroups ?? 0}</strong><span>груп повторів</span></article></section>
      <CollapsibleListSection className={styles.queue} flatOnMobile titleId="acquisition-queue-title" eyebrow={`${data?.requests.length ?? 0} у списку`} title="Заявки на комплектування">
        <div className={styles.filters}><select aria-label="Статус" value={status} onChange={(event) => setStatus(event.currentTarget.value)}><option value="active">Активні</option><option value="all">Усі</option>{Object.entries(STATUS).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select><select aria-label="Заявник" value={requester} onChange={(event) => setRequester(event.currentTarget.value)}><option value="all">Усі заявники</option><option value="teacher">Учителі</option><option value="student">Учні</option></select><select aria-label="Сортування" value={sort} onChange={(event) => setSort(event.currentTarget.value)}><option value="date_desc">Дата: спочатку нові</option><option value="date_asc">Дата: спочатку давні</option><option value="requester_asc">Прізвище А–Я</option><option value="requester_desc">Прізвище Я–А</option><option value="status_asc">Статус: робочі першими</option><option value="status_desc">Статус: завершені першими</option></select><input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Назва, автор, ім’я або номер" /><label className={styles.visibilityToggle}><input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.currentTarget.checked)} /> Показати приховані</label><button type="button" disabled={busy || !writesEnabled} onClick={() => void hideCompleted()}><SiteIcon name="hidden" size={16} /> Приховати всі завершені</button></div>
        {loading ? <p className={styles.empty}>Оновлюємо чергу…</p> : data?.requests.length ? <div className={styles.list}>{data.requests.map((record) => <RequestCard key={record.id} record={record} busy={busy || !writesEnabled} telegramMiniApp={telegramMiniApp} onAction={act} onSend={sendAction} onVisibility={changeVisibility} />)}</div> : <p className={styles.empty}>За цими фільтрами заявок немає.</p>}
      </CollapsibleListSection>
      <section className={styles.tools}>
        <div><h2>Excel</h2><p>Спочатку завантажте шаблон. Перед записом файл проходить перевірку, а повторний імпорт не створить копій.</p><div className={styles.actions}><a href="/api/librarian/acquisition-requests/import-template">Завантажити шаблон</a><a href="/api/librarian/acquisition-requests/export">Експорт у Excel</a><label><input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy || !writesEnabled} onChange={(event) => { const file = event.currentTarget.files?.[0] ?? null; event.currentTarget.value = ""; void chooseWorkbook(file); }} />Імпортувати Excel</label></div></div>
        <StudentSuggestionQr onNotice={setNotice} onError={setError} />
      </section>
      {preview ? <section className={styles.preview}><h2>Перевірка файла</h2><p>{preview.totals.rows} рядків · {preview.totals.valid} готові · {preview.totals.errors} з помилками · {preview.totals.duplicates} збігаються з наявними пропозиціями{preview.totals.existing ? ` · ${preview.totals.existing} уже існують і будуть пропущені` : ""}</p>{preview.rows.filter((row) => !row.valid).slice(0, 20).map((row) => <p key={`${row.sourceSheet}-${row.sourceRow}`} className={styles.errorLine}>{row.sourceSheet}, рядок {row.sourceRow}: {row.errors.join(" ")}</p>)}<button type="button" disabled={!preview.valid || busy || !writesEnabled} onClick={() => void commitImport()}>Підтвердити імпорт</button></section> : null}
      {data?.procurementGroups.length ? <details className={styles.groups}><summary>Повторні запити: {data.procurementGroups.length} груп</summary><div>{data.procurementGroups.map((group) => <article key={group.duplicateKey}><strong>{group.title}</strong><span>{metadataLine(group.author, group.publicationYear)}</span><small>{group.requestCount} заявок · запитано {group.requestedQuantity} · замовлено {group.orderedQuantity} · отримано {group.receivedQuantity}</small></article>)}</div></details> : null}
      </section>
    </main>
  </LibrarianShell>;
}

function StudentSuggestionQr({ onNotice, onError }: { onNotice: (value: string) => void; onError: (value: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [formUrl, setFormUrl] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const url = new URL("/suggest-book", window.location.origin).toString();
      setFormUrl(url);
      if (canvasRef.current) drawQrCode(canvasRef.current, url);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function copyLink() {
    if (!formUrl) return;
    const copied = await copyTextWithFallback(formUrl);
    if (copied) onNotice("Покликання для учнів скопійовано.");
    else onError("Браузер не дозволив скопіювати покликання. Скопіюйте адресу під QR-кодом вручну.");
  }

  async function copyQr() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const blob = await canvasBlob(canvas);
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("image_clipboard_unavailable");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      onNotice("QR-код скопійовано як зображення.");
    } catch {
      await downloadCanvas(canvas, "QR — запропонувати книгу бібліотеці.png");
      onNotice("Браузер не дозволив копіювання зображення, тому QR-код завантажено у PNG.");
    }
  }

  async function downloadQr() {
    if (!canvasRef.current) return;
    await downloadCanvas(canvasRef.current, "QR — запропонувати книгу бібліотеці.png");
    onNotice("QR-код завантажено у PNG.");
  }

  function printQr() {
    const className = "acquisition-student-qr-print";
    const cleanup = () => document.body.classList.remove(className);
    document.body.classList.add(className);
    window.addEventListener("afterprint", cleanup, { once: true });
    window.print();
    window.setTimeout(cleanup, 30_000);
  }

  return <div className={styles.studentQrCard} data-student-qr-print>
    <div className={styles.qrCopy}><h2>Форма для учнів</h2><p>Публічна мобільна форма без входу. Відскануйте код, щоб запропонувати книгу бібліотеці.</p></div>
    <canvas ref={canvasRef} className={styles.qrCanvas} width="840" height="840" aria-label="QR-код публічної форми пропозиції книги" />
    <code className={styles.qrUrl}>{formUrl || "Готуємо покликання…"}</code>
    <div className={styles.actions} data-qr-controls>
      <a href="/suggest-book" target="_blank" rel="noreferrer">Відкрити форму</a>
      <button type="button" onClick={() => void copyLink()}>Копіювати покликання</button>
      <button type="button" onClick={() => void copyQr()}>Копіювати QR-код</button>
      <button type="button" onClick={() => void downloadQr()}>Завантажити QR</button>
      <button type="button" onClick={printQr}>Друкувати QR</button>
    </div>
  </div>;
}

function RequestCard({ record, busy, telegramMiniApp, onAction, onSend, onVisibility }: { record: RequestRecord; busy: boolean; telegramMiniApp: boolean; onAction: (record: RequestRecord, action: string) => Promise<void>; onSend: (record: RequestRecord, fields: Record<string, unknown>) => Promise<void>; onVisibility: (record: RequestRecord, hidden: boolean) => Promise<void> }) {
  const [receiptOpen, setReceiptOpen] = useState(false);
  const librarianToolBase = telegramMiniApp ? "/librarian/telegram/cabinet?target=home&" : "/librarian?";
  const createParams = new URLSearchParams({ tool: "create", title: record.title, subject: record.subject, acquisition: record.id });
  if (record.author) createParams.set("author", record.author);
  if (record.publicationYear !== null) createParams.set("year", String(record.publicationYear));
  if (record.sourceUrl) createParams.set("link", record.sourceUrl);
  const createHref = `${librarianToolBase}${createParams.toString()}`;
  const receiptHref = `${librarianToolBase}tool=receipt&material=${encodeURIComponent(record.materialId ?? "")}&acquisition=${encodeURIComponent(record.id)}`;
  return <article className={styles.request}>
    <header><div><span className={`${styles.badge} ${record.status === "clarification" ? styles.alertBadge : ""}`}>{STATUS[record.status] ?? record.status}</span>{record.librarianHiddenAt ? <span className={styles.hiddenBadge}>Приховано</span> : null}{record.duplicateCount > 1 ? <span className={styles.duplicate}>Ще {record.duplicateCount - 1} схожих</span> : null}</div><small>{record.publicNumber} · {record.academicYearLabel}</small></header>
    <div className={styles.requestBody}><div><h2>{record.title}</h2><p>{metadataLine(record.author, record.publicationYear)}{record.materialId ? ` · ${record.materialId}` : " · нового запису в каталозі ще немає"}</p>{record.sourceUrl ? <a href={record.sourceUrl} target="_blank" rel="noreferrer">Відкрити покликання <SiteIcon name="external" size={15} /></a> : <span className={styles.missingMetadata}>Покликання не вказано</span>}</div><dl><div><dt>Заявник</dt><dd>{record.requesterName}{record.requesterClassName ? ` · ${record.requesterClassName}` : ""}</dd></div><div><dt>Потрібно</dt><dd>{record.requestedQuantity} прим.</dd></div><div><dt>Погоджено</dt><dd>{record.approvedQuantity ?? "—"}</dd></div><div><dt>Замовлено / отримано</dt><dd>{record.orderedQuantity} / {record.receivedQuantity}</dd></div>{record.subject || record.targetClass ? <div><dt>Предмет і клас</dt><dd>{[record.subject, record.targetClass].filter(Boolean).join(" · ")}</dd></div> : null}</dl></div>
    {record.requesterNote ? <p className={styles.note}><strong>Примітка заявника:</strong> {record.requesterNote}</p> : null}{record.clarificationMessage ? <p className={styles.note}><strong>Запитано уточнення:</strong> {record.clarificationMessage}</p> : null}{record.rejectionReason ? <p className={styles.note}><strong>Причина:</strong> {record.rejectionReason}</p> : null}
    <div className={styles.cardActions}>
      {record.status === "submitted" || record.status === "clarification" ? <button disabled={busy} onClick={() => void onAction(record,"start_review")}>Взяти в роботу</button> : null}
      {["submitted","in_review","clarification"].includes(record.status) ? <button disabled={busy} onClick={() => void onAction(record,"approve")}>Погодити</button> : null}
      {["submitted","in_review","approved","planned"].includes(record.status) ? <button disabled={busy} onClick={() => void onAction(record,"request_clarification")}>Уточнити</button> : null}
      {record.status === "approved" ? <button disabled={busy} onClick={() => void onAction(record,"plan")}>Запланувати</button> : null}
      {["approved","planned","ordered"].includes(record.status) ? <button disabled={busy} onClick={() => void onAction(record,"order")}>Відзначити замовлення</button> : null}
      {!record.materialId && ["approved","planned","ordered"].includes(record.status) ? <><a href={createHref}>Створити матеріал</a><button disabled={busy} onClick={() => void onAction(record,"link_material")}>Прив’язати CAT-ID</button></> : null}
      {record.materialId && ["ordered","partially_received"].includes(record.status) ? <><a href={receiptHref}>Оформити надходження</a><button disabled={busy} onClick={() => setReceiptOpen((value) => !value)}>Зарахувати надходження</button></> : null}
      {["submitted","in_review","clarification","approved","planned","ordered"].includes(record.status) ? <button className={styles.danger} disabled={busy} onClick={() => void onAction(record,"reject")}>Відхилити</button> : null}
      {["received", "rejected", "cancelled"].includes(record.status) ? <button disabled={busy} onClick={() => void onVisibility(record, !record.librarianHiddenAt)}><SiteIcon name={record.librarianHiddenAt ? "visible" : "hidden"} size={15} /> {record.librarianHiddenAt ? "Повернути" : "Приховати"}</button> : null}
    </div>
    {receiptOpen ? <ReceiptAllocator key={`${record.id}:${record.version}`} record={record} disabled={busy} onSend={onSend} /> : null}
  </article>;
}

function ReceiptAllocator({ record, disabled, onSend }: { record: RequestRecord; disabled: boolean; onSend: (record: RequestRecord, fields: Record<string, unknown>) => Promise<void> }) {
  type ReceiptLine = { lineId: string; occurredAt: string; locationName: string; receivedQuantity: number; unallocatedQuantity: number };
  const [lines, setLines] = useState<ReceiptLine[]>([]);
  const [lineId, setLineId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const remainingNeeded = Math.max(0, record.orderedQuantity - record.receivedQuantity);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/librarian/acquisition-requests/${encodeURIComponent(record.id)}/receipt-lines`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as { lines?: ReceiptLine[]; error?: string };
        if (!response.ok) throw new Error(body.error || "Не вдалося завантажити надходження.");
        const nextLines = body.lines ?? [];
        const first = nextLines[0];
        setLines(nextLines);
        setLineId(first?.lineId ?? "");
        setQuantity(String(first ? Math.min(first.unallocatedQuantity, remainingNeeded) : 1));
      })
      .catch((error) => {
        if (!controller.signal.aborted) setLoadError(message(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [record.id, record.version, remainingNeeded]);

  const selectedLine = lines.find((line) => line.lineId === lineId);
  const selectedMaximum = Math.min(selectedLine?.unallocatedQuantity ?? 0, remainingNeeded);
  const allocatedQuantity = Number(quantity);
  const quantityValid = Number.isSafeInteger(allocatedQuantity) && allocatedQuantity >= 1 && allocatedQuantity <= selectedMaximum;
  return <div className={styles.receipts}>
    <strong>Фактичні надходження цього матеріалу</strong>
    {loading ? <span>Оновлюємо…</span> : loadError ? <span role="alert">{loadError}</span> : lines.length ? <>
      <select value={lineId} onChange={(event) => { const nextId = event.currentTarget.value; const next = lines.find((line) => line.lineId === nextId); setLineId(nextId); setQuantity(String(next ? Math.min(next.unallocatedQuantity, remainingNeeded) : 1)); }}>
        {lines.map((line) => <option key={line.lineId} value={line.lineId}>{new Date(line.occurredAt).toLocaleDateString("uk-UA")} · {line.locationName} · доступно для зарахування {line.unallocatedQuantity}</option>)}
      </select>
      <input type="number" min="1" max={selectedMaximum} value={quantity} aria-invalid={!quantityValid} onChange={(event) => setQuantity(event.currentTarget.value)} />
      <button type="button" disabled={disabled || !lineId || !quantityValid} onClick={() => void onSend(record, { action: "link_receipt", approvedQuantity: null, orderedQuantity: null, targetMaterialId: null, receiptLineId: lineId, allocatedQuantity, message: "" })}>Зарахувати до заявки</button>
    </> : <span>Нових незарахованих надходжень не знайдено.</span>}
  </div>;
}

function promptNumber(label: string, fallback: number, minimum = 0): number | null { const raw=window.prompt(label,String(fallback)); if(raw===null)return null; const value=Number(raw); return Number.isSafeInteger(value)&&value>=minimum?value:null; }
function message(error: unknown): string { return error instanceof Error ? error.message : "Сталася помилка."; }

function metadataLine(author: string, publicationYear: number | null): string {
  return [author || "Автор не вказаний", publicationYear ? String(publicationYear) : "рік не вказаний"].join(" · ");
}

function drawQrCode(canvas: HTMLCanvasElement, value: string): void {
  const size = canvas.width;
  const matrix = new QRCodeWriter().encode(value, BarcodeFormat.QR_CODE, size, size, new Map());
  const context = canvas.getContext("2d");
  if (!context) return;
  context.imageSmoothingEnabled = false;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, size, size);
  context.fillStyle = "#143f2c";
  for (let y = 0; y < matrix.getHeight(); y += 1) {
    for (let x = 0; x < matrix.getWidth(); x += 1) {
      if (matrix.get(x, y)) context.fillRect(x, y, 1, 1);
    }
  }
}

async function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("qr_png_unavailable");
  return blob;
}

async function downloadCanvas(canvas: HTMLCanvasElement, fileName: string): Promise<void> {
  const url = URL.createObjectURL(await canvasBlob(canvas));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function copyTextWithFallback(value: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return true; } catch { /* use selection fallback */ }
  }
  const textarea = document.createElement("textarea");
  textarea.value = value; textarea.readOnly = true; textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed"; textarea.style.left = "-9999px"; textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try { textarea.select(); return document.execCommand("copy"); }
  catch { return false; }
  finally { textarea.remove(); }
}
