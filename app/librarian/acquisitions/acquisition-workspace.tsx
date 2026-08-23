"use client";

/* eslint-disable @next/next/no-html-link-for-pages -- full-page navigation is intentional in Vinext production. */

import { useCallback, useEffect, useRef, useState } from "react";
import { parseAcquisitionWorkbook, type ParsedAcquisitionWorkbook } from "./acquisition-excel-parser";
import styles from "./acquisition-workspace.module.css";

type RequestRecord = {
  id: string; publicNumber: string; requesterKind: "teacher" | "student"; requesterName: string; requesterClassName: string;
  category: "educational" | "literature"; sourceKind: "catalog" | "manual"; literatureKind: string; materialId: string | null;
  title: string; author: string; publicationYear: number; requestedQuantity: number; approvedQuantity: number | null;
  orderedQuantity: number; receivedQuantity: number; sourceUrl: string; subject: string; targetClass: string; requesterNote: string;
  librarianNote: string; clarificationMessage: string; rejectionReason: string; status: string; duplicateCount: number;
  academicYearLabel: string; version: number; updatedAt: string;
};
type Summary = { total: number; active: number; submitted: number; ordered: number; received: number; requestedCopies: number; orderedCopies: number; receivedCopies: number; duplicateGroups: number };
type Group = { duplicateKey: string; title: string; author: string; publicationYear: number; requestCount: number; requestedQuantity: number; orderedQuantity: number; receivedQuantity: number };
type Envelope = { success: true; requests: RequestRecord[]; summary: Summary; procurementGroups: Group[]; writesEnabled: boolean };
type Preview = { valid: boolean; rows: Array<{ sourceSheet: string; sourceRow: number; valid: boolean; errors: string[]; duplicateCount: number }>; totals: { rows: number; valid: number; errors: number; duplicates: number; existing?: number } };

const STATUS: Record<string, string> = { submitted: "Нова", in_review: "На розгляді", clarification: "Потрібне уточнення", approved: "Погоджено", planned: "Заплановано", ordered: "Замовлено", partially_received: "Частково отримано", received: "Отримано", rejected: "Відхилено", cancelled: "Скасовано" };

export default function AcquisitionWorkspace({ displayName, writesEnabled, signOutHref, telegramMiniApp = false }: { displayName: string; writesEnabled: boolean; signOutHref: string; telegramMiniApp?: boolean }) {
  const [data, setData] = useState<Envelope | null>(null); const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [status, setStatus] = useState("active"); const [requester, setRequester] = useState("all"); const [query, setQuery] = useState("");
  const [workbook, setWorkbook] = useState<ParsedAcquisitionWorkbook | null>(null); const [preview, setPreview] = useState<Preview | null>(null);
  const [importId, setImportId] = useState("");
  const handoffHandled = useRef(false);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ status, requester, q: query.trim() });
      const response = await fetch(`/api/librarian/acquisition-requests?${params}`, { cache: "no-store" });
      const body = await response.json() as Envelope & { error?: string };
      if (!response.ok) throw new Error(body.error || "Не вдалося завантажити комплектування.");
      setData(body);
    } catch (loadError) { setError(message(loadError)); } finally { setLoading(false); }
  }, [query, requester, status]);
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
    if (action === "approve") approvedQuantity = promptNumber("Погоджена кількість", record.requestedQuantity); else if (action === "order") orderedQuantity = promptNumber("Замовлена кількість", record.approvedQuantity ?? record.requestedQuantity);
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
  async function copyStudentLink() {
    try { await navigator.clipboard.writeText(`${window.location.origin}/suggest-book`); setNotice("Покликання для учнів скопійовано."); }
    catch { setError("Не вдалося скопіювати покликання. Відкрийте форму й скопіюйте адресу браузера."); }
  }

  const summary = data?.summary;
  return <main className={`${styles.shell} ${telegramMiniApp ? styles.telegram : ""}`}>
    <header className={styles.header}><a className={styles.brand} href="/librarian"><strong>Єдина бібліотека</strong><span>Комплектування фонду</span></a><nav><a href="/librarian">Каталог</a><a href="/librarian/visits">Відвідування</a><a href="/librarian/teachers">Вчителі</a></nav><div className={styles.account}><span>{displayName}</span><a href={signOutHref}>{telegramMiniApp ? "До бота" : "Вийти"}</a></div></header>
    <section className={styles.page}>
      <div className={styles.hero}><div><span>Керування придбаннями</span><h1>Комплектування фонду</h1><p>Дозамовлення, нові видання та пропозиції учнів — без впливу на фактичний залишок до оформлення надходження.</p></div><button type="button" onClick={() => void load()} disabled={loading}>↻ Оновити</button></div>
      {!writesEnabled ? <div className={styles.warning}>Запис тимчасово вимкнено. Дані доступні лише для перегляду.</div> : null}
      {error ? <div className={styles.error} role="alert">{error}</div> : null}{notice ? <div className={styles.success} role="status">{notice}</div> : null}
      <section className={styles.metrics} aria-label="Підсумок комплектування"><article><strong>{summary?.active ?? 0}</strong><span>активних заявок</span></article><article><strong>{summary?.requestedCopies ?? 0}</strong><span>запитано примірників</span></article><article><strong>{summary?.orderedCopies ?? 0}</strong><span>замовлено</span></article><article><strong>{summary?.receivedCopies ?? 0}</strong><span>фактично отримано</span></article><article><strong>{summary?.duplicateGroups ?? 0}</strong><span>груп повторів</span></article></section>
      <section className={styles.tools}>
        <div><h2>Excel</h2><p>Спочатку завантажте шаблон. Перед записом файл проходить перевірку, а повторний імпорт не створить копій.</p><div className={styles.actions}><a href="/api/librarian/acquisition-requests/import-template">Завантажити шаблон</a><a href="/api/librarian/acquisition-requests/export">Експорт у Excel</a><label><input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy || !writesEnabled} onChange={(event) => { const file = event.currentTarget.files?.[0] ?? null; event.currentTarget.value = ""; void chooseWorkbook(file); }} />Імпортувати Excel</label></div></div>
        <div><h2>Форма для учнів</h2><p>Публічна мобільна форма без входу. Видимий список пропозицій не публікується.</p><div className={styles.actions}><a href="/suggest-book" target="_blank" rel="noreferrer">Відкрити форму</a><button type="button" onClick={() => void copyStudentLink()}>Копіювати покликання</button></div></div>
      </section>
      {preview ? <section className={styles.preview}><h2>Перевірка файла</h2><p>{preview.totals.rows} рядків · {preview.totals.valid} готові · {preview.totals.errors} з помилками · {preview.totals.duplicates} збігаються з наявними пропозиціями{preview.totals.existing ? ` · ${preview.totals.existing} уже існують і будуть пропущені` : ""}</p>{preview.rows.filter((row) => !row.valid).slice(0, 20).map((row) => <p key={`${row.sourceSheet}-${row.sourceRow}`} className={styles.errorLine}>{row.sourceSheet}, рядок {row.sourceRow}: {row.errors.join(" ")}</p>)}<button type="button" disabled={!preview.valid || busy || !writesEnabled} onClick={() => void commitImport()}>Підтвердити імпорт</button></section> : null}
      {data?.procurementGroups.length ? <details className={styles.groups}><summary>Повторні запити: {data.procurementGroups.length} груп</summary><div>{data.procurementGroups.map((group) => <article key={group.duplicateKey}><strong>{group.title}</strong><span>{group.author} · {group.publicationYear}</span><small>{group.requestCount} заявок · запитано {group.requestedQuantity} · замовлено {group.orderedQuantity} · отримано {group.receivedQuantity}</small></article>)}</div></details> : null}
      <section className={styles.queue}>
        <div className={styles.filters}><select value={status} onChange={(event) => setStatus(event.currentTarget.value)}><option value="active">Активні</option><option value="all">Усі</option>{Object.entries(STATUS).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select><select value={requester} onChange={(event) => setRequester(event.currentTarget.value)}><option value="all">Усі заявники</option><option value="teacher">Учителі</option><option value="student">Учні</option></select><input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Назва, автор, ім’я або номер" /></div>
        {loading ? <p className={styles.empty}>Оновлюємо чергу…</p> : data?.requests.length ? <div className={styles.list}>{data.requests.map((record) => <RequestCard key={record.id} record={record} busy={busy || !writesEnabled} telegramMiniApp={telegramMiniApp} onAction={act} onSend={sendAction} />)}</div> : <p className={styles.empty}>За цими фільтрами заявок немає.</p>}
      </section>
    </section>
  </main>;
}

function RequestCard({ record, busy, telegramMiniApp, onAction, onSend }: { record: RequestRecord; busy: boolean; telegramMiniApp: boolean; onAction: (record: RequestRecord, action: string) => Promise<void>; onSend: (record: RequestRecord, fields: Record<string, unknown>) => Promise<void> }) {
  const [receiptOpen, setReceiptOpen] = useState(false);
  const librarianToolBase = telegramMiniApp ? "/librarian/telegram/cabinet?target=home&" : "/librarian?";
  const createHref = `${librarianToolBase}tool=create&title=${encodeURIComponent(record.title)}&author=${encodeURIComponent(record.author)}&year=${record.publicationYear}&link=${encodeURIComponent(record.sourceUrl)}&subject=${encodeURIComponent(record.subject)}&acquisition=${encodeURIComponent(record.id)}`;
  const receiptHref = `${librarianToolBase}tool=receipt&material=${encodeURIComponent(record.materialId ?? "")}&acquisition=${encodeURIComponent(record.id)}`;
  return <article className={styles.request}>
    <header><div><span className={`${styles.badge} ${record.status === "clarification" ? styles.alertBadge : ""}`}>{STATUS[record.status] ?? record.status}</span>{record.duplicateCount > 1 ? <span className={styles.duplicate}>Ще {record.duplicateCount - 1} схожих</span> : null}</div><small>{record.publicNumber} · {record.academicYearLabel}</small></header>
    <div className={styles.requestBody}><div><h2>{record.title}</h2><p>{record.author} · {record.publicationYear}{record.materialId ? ` · ${record.materialId}` : " · нового запису в каталозі ще немає"}</p><a href={record.sourceUrl} target="_blank" rel="noreferrer">Відкрити покликання ↗</a></div><dl><div><dt>Заявник</dt><dd>{record.requesterName}{record.requesterClassName ? ` · ${record.requesterClassName}` : ""}</dd></div><div><dt>Потрібно</dt><dd>{record.requestedQuantity} прим.</dd></div><div><dt>Погоджено</dt><dd>{record.approvedQuantity ?? "—"}</dd></div><div><dt>Замовлено / отримано</dt><dd>{record.orderedQuantity} / {record.receivedQuantity}</dd></div>{record.subject ? <div><dt>Предмет і клас</dt><dd>{record.subject} · {record.targetClass}</dd></div> : null}</dl></div>
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
    </div>
    {receiptOpen ? <ReceiptAllocator record={record} disabled={busy} onSend={onSend} /> : null}
  </article>;
}

function ReceiptAllocator({ record, disabled, onSend }: { record: RequestRecord; disabled: boolean; onSend: (record: RequestRecord, fields: Record<string, unknown>) => Promise<void> }) {
  const [lines, setLines] = useState<Array<{ lineId: string; occurredAt: string; locationName: string; receivedQuantity: number; unallocatedQuantity: number }>>([]); const [lineId,setLineId]=useState(""); const [quantity,setQuantity]=useState("1"); const [loading,setLoading]=useState(true);
  useEffect(() => { const controller=new AbortController(); void fetch(`/api/librarian/acquisition-requests/${encodeURIComponent(record.id)}/receipt-lines`,{cache:"no-store",signal:controller.signal}).then(async(response)=>{const body=await response.json() as {lines?:typeof lines}; if(response.ok){setLines(body.lines??[]);setLineId(body.lines?.[0]?.lineId??"");}}).finally(()=>setLoading(false)); return()=>controller.abort(); },[record.id]);
  return <div className={styles.receipts}><strong>Фактичні надходження цього матеріалу</strong>{loading?<span>Оновлюємо…</span>:lines.length?<><select value={lineId} onChange={(event)=>setLineId(event.currentTarget.value)}>{lines.map((line)=><option key={line.lineId} value={line.lineId}>{new Date(line.occurredAt).toLocaleDateString("uk-UA")} · {line.locationName} · доступно для зарахування {line.unallocatedQuantity}</option>)}</select><input type="number" min="1" max={Math.max(...lines.map((line)=>line.unallocatedQuantity))} value={quantity} onChange={(event)=>setQuantity(event.currentTarget.value)}/><button disabled={disabled||!lineId} onClick={()=>void onSend(record,{action:"link_receipt",approvedQuantity:null,orderedQuantity:null,targetMaterialId:null,receiptLineId:lineId,allocatedQuantity:Number(quantity),message:""})}>Зарахувати до заявки</button></>:<span>Нових незарахованих надходжень не знайдено.</span>}</div>;
}

function promptNumber(label: string, fallback: number): number | null { const raw=window.prompt(label,String(fallback)); if(raw===null)return null; const value=Number(raw); return Number.isSafeInteger(value)&&value>=0?value:null; }
function message(error: unknown): string { return error instanceof Error ? error.message : "Сталася помилка."; }
