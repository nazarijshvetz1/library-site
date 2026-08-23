"use client";

/* eslint-disable @next/next/no-img-element -- first-party catalog thumbnails are already resized by the catalog service. */

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import styles from "./teacher-acquisition.module.css";

type CatalogItem = {
  id: string; title: string; author: string; year: number | null; subject: string;
  classFrom: number | null; classTo: number | null; thumbnailUrl: string; availableQuantity: number;
};
type CatalogDetail = CatalogItem & { links: Array<{ url: string }> };
type Acquisition = {
  id: string; publicNumber: string; title: string; author: string; publicationYear: number; requestedQuantity: number;
  approvedQuantity: number | null; orderedQuantity: number; receivedQuantity: number; status: string; version: number;
  requesterNote: string; librarianNote: string; clarificationMessage: string; rejectionReason: string; sourceUrl: string; updatedAt: string;
};
type JsonError = { error?: string; fieldErrors?: Record<string, string> };

const STATUS_LABELS: Record<string, string> = {
  submitted: "Нова", in_review: "На розгляді", clarification: "Потрібне уточнення", approved: "Погоджено",
  planned: "Заплановано", ordered: "Замовлено", partially_received: "Частково отримано", received: "Отримано",
  rejected: "Відхилено", cancelled: "Скасовано",
};
const PUBLIC_CATALOG_URL = "https://nazarijshvetz1.github.io/library-site/";

export default function TeacherAcquisitionPanel() {
  const [category, setCategory] = useState<"educational" | "literature">("educational");
  const [sourceKind, setSourceKind] = useState<"catalog" | "manual">("catalog");
  const [literatureKind, setLiteratureKind] = useState("fiction");
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [selected, setSelected] = useState<CatalogItem | null>(null);
  const [title, setTitle] = useState(""); const [author, setAuthor] = useState("");
  const [year, setYear] = useState(""); const [quantity, setQuantity] = useState("1");
  const [sourceUrl, setSourceUrl] = useState(""); const [subject, setSubject] = useState("");
  const [targetClass, setTargetClass] = useState(""); const [note, setNote] = useState("");
  const [requests, setRequests] = useState<Acquisition[]>([]);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [notice, setNotice] = useState(""); const [error, setError] = useState("");
  const detailRequest = useRef(0);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/teacher/acquisition-requests", { cache: "no-store" });
      const body = await response.json() as { success?: boolean; requests?: Acquisition[]; error?: string };
      if (!response.ok) throw new Error(body.error || "Не вдалося завантажити пропозиції.");
      setRequests(body.requests ?? []);
    } catch (loadError) { setError(message(loadError)); } finally { setLoading(false); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  useEffect(() => {
    if (sourceKind !== "catalog" || selected || query.trim().length < 2) {
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: query.trim(), limit: "10" });
        const response = await fetch(`/api/catalog-v2?${params}`, { signal: controller.signal });
        const body = await response.json() as { items?: CatalogItem[] };
        if (response.ok) setCatalog(body.items ?? []);
      } catch { if (!controller.signal.aborted) setCatalog([]); }
    }, 280);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, selected, sourceKind]);

  async function choose(item: CatalogItem) {
    const requestNumber = detailRequest.current + 1;
    detailRequest.current = requestNumber;
    setSelected(item); setTitle(item.title); setAuthor(item.author || "");
    setYear(item.year ? String(item.year) : ""); setSubject(item.subject || "");
    setTargetClass(formatCatalogClass(item.classFrom, item.classTo));
    setSourceUrl(`${PUBLIC_CATALOG_URL}?material=${encodeURIComponent(item.id)}`);
    setCatalog([]); setQuery(item.id); setDetailLoading(true);
    try {
      const response = await fetch(`/api/catalog-v2/${encodeURIComponent(item.id)}`, { cache: "no-store" });
      const body = await response.json() as { material?: CatalogDetail };
      if (!response.ok || !body.material || detailRequest.current !== requestNumber) return;
      const detail = body.material;
      setAuthor(detail.author || ""); setYear(detail.year ? String(detail.year) : "");
      setSubject(detail.subject || ""); setTargetClass(formatCatalogClass(detail.classFrom, detail.classTo));
      setSourceUrl(detail.links.find((link) => /^https?:\/\//iu.test(link.url))?.url
        ?? `${PUBLIC_CATALOG_URL}?material=${encodeURIComponent(detail.id)}`);
    } catch {
      // The catalog summary is enough to continue; an edition link is optional in this mode.
    } finally {
      if (detailRequest.current === requestNumber) setDetailLoading(false);
    }
  }
  function changeSource(value: "catalog" | "manual") {
    detailRequest.current += 1;
    setSourceKind(value); setSelected(null); setQuery(""); setCatalog([]); setDetailLoading(false);
    setTitle(""); setAuthor(""); setYear(""); setSubject(""); setTargetClass(""); setSourceUrl("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/teacher/acquisition-requests", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(), category, sourceKind,
          literatureKind: category === "literature" ? literatureKind : "none",
          materialId: sourceKind === "catalog" ? selected?.id ?? null : null,
          title, author, publicationYear: Number(year), requestedQuantity: Number(quantity), sourceUrl,
          subject: category === "educational" ? subject : "", targetClass: category === "educational" ? targetClass : "", note,
        }),
      });
      const body = await response.json() as JsonError;
      if (!response.ok) throw new Error(body.error || firstFieldError(body.fieldErrors) || "Не вдалося надіслати пропозицію.");
      setNotice("Пропозицію надіслано бібліотекарю.");
      detailRequest.current += 1;
      setSelected(null); setQuery(""); setTitle(""); setAuthor(""); setYear(""); setQuantity("1");
      setSourceUrl(""); setSubject(""); setTargetClass(""); setNote(""); setDetailLoading(false);
      await load();
    } catch (submitError) { setError(message(submitError)); } finally { setBusy(false); }
  }

  const existingCatalogMaterial = category === "educational" && sourceKind === "catalog";

  async function cancel(record: Acquisition) {
    if (!window.confirm(`Скасувати пропозицію ${record.publicNumber}?`)) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/teacher/acquisition-requests/${encodeURIComponent(record.id)}`, {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mutationId: crypto.randomUUID(), expectedVersion: record.version, reason: "" }),
      });
      const body = await response.json() as JsonError;
      if (!response.ok) throw new Error(body.error || "Не вдалося скасувати пропозицію.");
      setNotice("Пропозицію скасовано."); await load();
    } catch (cancelError) { setError(message(cancelError)); } finally { setBusy(false); }
  }

  return (
    <section className={styles.workspace} aria-labelledby="acquisition-teacher-title">
      <div className={styles.intro}>
        <div><span>Комплектування фонду</span><h2 id="acquisition-teacher-title">Запропонувати придбання</h2></div>
        <p>Дозамовте потрібні примірники або запропонуйте нову художню чи наукову літературу. Це не є бронюванням наявного фонду.</p>
      </div>
      {error ? <div className={styles.error} role="alert">{error}</div> : null}
      {notice ? <div className={styles.success} role="status">{notice}</div> : null}
      <div className={styles.grid}>
        <form className={styles.card} onSubmit={submit} aria-busy={busy}>
          <fieldset className={styles.segmented}><legend>Що потрібно?</legend>
            <label><input type="radio" name="category" checked={category === "educational"} onChange={() => setCategory("educational")} /> Дозамовити навчальні матеріали</label>
            <label><input type="radio" name="category" checked={category === "literature"} onChange={() => { setCategory("literature"); changeSource("manual"); }} /> Запропонувати літературу</label>
          </fieldset>
          {category === "educational" ? <fieldset className={styles.segmented}><legend>Чи є матеріал у каталозі?</legend>
            <label><input type="radio" name="source" checked={sourceKind === "catalog"} onChange={() => changeSource("catalog")} /> Є у каталозі</label>
            <label><input type="radio" name="source" checked={sourceKind === "manual"} onChange={() => changeSource("manual")} /> Ще немає</label>
          </fieldset> : null}
          {sourceKind === "catalog" ? <label className={styles.wide}>Знайти матеріал у каталозі *
            <input value={query} onChange={(event) => { detailRequest.current += 1; setQuery(event.currentTarget.value); setSelected(null); setCatalog([]); setDetailLoading(false); }} placeholder="Назва, автор або CAT-ID" />
            {catalog.length ? <div className={styles.results}>{catalog.map((item) => <button type="button" key={item.id} onClick={() => void choose(item)}>
              <CatalogCover item={item} />
              <span className={styles.resultCopy}><strong>{item.title}</strong><span>{item.author || "Автор не вказаний"}{item.year ? ` · ${item.year}` : ""}</span><small>{item.id} · доступно {item.availableQuantity}</small></span>
            </button>)}</div> : null}
            {selected ? <span className={styles.selectedMaterial}><CatalogCover item={selected} /><span><strong>{selected.title}</strong><small>{selected.author || "Автор потрібно вказати"}{selected.year ? ` · ${selected.year}` : ""} · {selected.id}</small>{detailLoading ? <small>Доповнюємо дані з каталогу…</small> : null}</span></span> : null}
          </label> : null}
          <div className={styles.fields}>
            {category === "literature" ? <label>Вид літератури *<select value={literatureKind} onChange={(event) => setLiteratureKind(event.currentTarget.value)}><option value="fiction">Художня</option><option value="science">Наукова</option><option value="popular_science">Науково-популярна</option><option value="other">Інша</option></select></label> : null}
            <label>Назва *<input required minLength={2} maxLength={320} value={title} readOnly={Boolean(selected)} onChange={(event) => setTitle(event.currentTarget.value)} /></label>
            <label>Автор *<input required minLength={2} maxLength={240} value={author} readOnly={Boolean(selected && selected.author)} onChange={(event) => setAuthor(event.currentTarget.value)} /></label>
            <label>Рік *<input required type="number" min="1000" max="2100" value={year} onChange={(event) => setYear(event.currentTarget.value)} /></label>
            <label>Кількість *<input required type="number" min="1" max="1000" value={quantity} onChange={(event) => setQuantity(event.currentTarget.value)} /></label>
            {category === "educational" ? <><label>Предмет{existingCatalogMaterial ? "" : " *"}<input required={!existingCatalogMaterial} maxLength={120} value={subject} onChange={(event) => setSubject(event.currentTarget.value)} /></label><label>Клас{existingCatalogMaterial ? "" : " *"}<input required={!existingCatalogMaterial} maxLength={80} value={targetClass} onChange={(event) => setTargetClass(event.currentTarget.value)} placeholder="Наприклад, 7-А" /></label></> : null}
            <label className={styles.wide}>Покликання на видання{existingCatalogMaterial ? "" : " *"}<input required={!existingCatalogMaterial} type="url" maxLength={1000} value={sourceUrl} onChange={(event) => setSourceUrl(event.currentTarget.value)} placeholder="https://…" />{existingCatalogMaterial ? <small>Якщо в каталозі покликання немає, це поле можна залишити порожнім.</small> : null}</label>
            <label className={styles.wide}>Примітка<textarea maxLength={1000} value={note} onChange={(event) => setNote(event.currentTarget.value)} placeholder="Для якого уроку або з якою метою" /></label>
          </div>
          <button className={styles.primary} type="submit" disabled={busy || (sourceKind === "catalog" && !selected)}>{busy ? "Надсилаємо…" : "Надіслати пропозицію"}</button>
        </form>
        <section className={styles.card} aria-labelledby="my-acquisition-title">
          <div className={styles.heading}><div><span>Лише для вас</span><h3 id="my-acquisition-title">Мої пропозиції</h3></div><button type="button" onClick={() => void load()} disabled={loading}>↻ Оновити</button></div>
          {loading ? <p className={styles.empty}>Оновлюємо історію…</p> : requests.length ? <div className={styles.history}>{requests.map((record) => <article key={record.id}>
            <header><span className={styles.status}>{STATUS_LABELS[record.status] ?? record.status}</span><small>{record.publicNumber}</small></header>
            <h4>{record.title}</h4><p>{record.author} · {record.publicationYear} · {record.requestedQuantity} прим.</p>
            {record.clarificationMessage ? <p className={styles.attention}><strong>Уточнення:</strong> {record.clarificationMessage}</p> : null}
            {record.librarianNote && !record.clarificationMessage ? <p>{record.librarianNote}</p> : null}
            {record.rejectionReason ? <p className={styles.attention}>{record.rejectionReason}</p> : null}
            <div className={styles.progress}><span>погоджено {record.approvedQuantity ?? 0}</span><span>замовлено {record.orderedQuantity}</span><span>отримано {record.receivedQuantity}</span></div>
            {["submitted","in_review","clarification","approved","planned"].includes(record.status) ? <button type="button" className={styles.danger} disabled={busy} onClick={() => void cancel(record)}>Скасувати</button> : null}
          </article>)}</div> : <p className={styles.empty}>Ви ще не надсилали пропозицій до комплектування.</p>}
        </section>
      </div>
    </section>
  );
}

function firstFieldError(errors?: Record<string, string>): string { return Object.values(errors ?? {})[0] ?? ""; }
function message(error: unknown): string { return error instanceof Error ? error.message : "Сталася помилка."; }

function formatCatalogClass(classFrom: number | null, classTo: number | null): string {
  if (!classFrom && !classTo) return "";
  const from = classFrom ?? classTo;
  const to = classTo ?? classFrom;
  return from === to ? `${from} клас` : `${from}–${to} класи`;
}

function CatalogCover({ item }: { item: CatalogItem }) {
  return item.thumbnailUrl
    ? <img className={styles.resultCover} src={item.thumbnailUrl} alt="" loading="lazy" />
    : <span className={styles.resultCoverFallback} aria-hidden="true">К</span>;
}
