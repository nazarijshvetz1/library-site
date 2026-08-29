"use client";

/* eslint-disable @next/next/no-img-element -- catalog covers are served by the existing cover bridge */
/* eslint-disable react-hooks/set-state-in-effect -- the effect owns the remote list loading lifecycle */

import { useEffect, useMemo, useState } from "react";

import SiteIcon from "@/app/_components/site-icon";
import LibrarianShell from "../_components/librarian-shell";
import styles from "./textbook-management.module.css";

type ManagedTextbook = {
  id: string;
  materialId: string;
  materialVersion: number;
  grade: number;
  status: "draft" | "published" | "archived";
  sortOrder: number;
  version: number;
  title: string;
  author: string;
  publicationYear: number | null;
  subject: string;
  publisher: string;
  coverUrl: string;
  activeResourceCount: number;
  brokenResourceCount: number;
  primaryResourceUrl: string;
  createdAt: string;
  updatedAt: string;
};

type Candidate = {
  materialId: string;
  materialVersion: number;
  title: string;
  author: string;
  publicationYear: number | null;
  subject: string;
  publisher: string;
  classFrom: number | null;
  classTo: number | null;
  coverUrl: string;
  resourceUrl: string;
  activeResourceCount: number;
};

type StatusFilter = "visible" | "hidden" | "all";
type SortMode = "manual" | "title" | "subject" | "newest";

export default function TextbookManagementWorkspace({
  displayName,
  role,
  writesEnabled,
  signOutHref,
}: {
  displayName: string;
  role: string;
  writesEnabled: boolean;
  signOutHref: string;
}) {
  const [grade, setGrade] = useState(1);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("visible");
  const [sort, setSort] = useState<SortMode>("manual");
  const [items, setItems] = useState<ManagedTextbook[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [academicYear, setAcademicYear] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [orderDrafts, setOrderDrafts] = useState<Record<string, string>>({});
  const [linkDrafts, setLinkDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timeout);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch(`/api/librarian/textbooks?grade=${grade}&q=${encodeURIComponent(debouncedQuery)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json() as {
          success?: boolean;
          error?: string;
          academicYear?: { label?: string };
          items?: ManagedTextbook[];
          candidates?: Candidate[];
        };
        if (!response.ok || body.success !== true) throw new Error(body.error || "Не вдалося завантажити список.");
        const nextItems = Array.isArray(body.items) ? body.items : [];
        setItems(nextItems);
        setCandidates(Array.isArray(body.candidates) ? body.candidates : []);
        setAcademicYear(body.academicYear?.label || "");
        setOrderDrafts(Object.fromEntries(nextItems.map((item) => [item.id, String(item.sortOrder)])));
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setMessage({ tone: "error", text: errorMessage(reason) });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [grade, debouncedQuery, refreshKey]);

  const visibleItems = useMemo(() => {
    const filtered = items.filter((item) => {
      if (status === "visible") return item.status === "published";
      if (status === "hidden") return item.status !== "published";
      return true;
    });
    return [...filtered].sort((a, b) => {
      if (sort === "title") return compare(a.title, b.title);
      if (sort === "subject") return compare(a.subject, b.subject) || compare(a.title, b.title);
      if (sort === "newest") return (b.publicationYear ?? 0) - (a.publicationYear ?? 0) || compare(a.title, b.title);
      return a.sortOrder - b.sortOrder || compare(a.title, b.title);
    });
  }, [items, sort, status]);

  async function addCandidate(candidate: Candidate) {
    await perform(candidate.materialId, async () => {
      const response = await apiJson<{ textbook: ManagedTextbook }>("/api/librarian/textbooks", {
        method: "POST",
        body: JSON.stringify({ requestId: crypto.randomUUID(), materialId: candidate.materialId, grade, publish: true }),
      });
      setMessage({ tone: "success", text: `«${response.textbook.title}» додано до ${grade} класу й опубліковано.` });
    });
  }

  async function saveLinkAndAddCandidate(candidate: Candidate) {
    const url = validHttpsUrl(linkDrafts[candidate.materialId] ?? "");
    if (!url) {
      setMessage({ tone: "error", text: "Укажіть коректне HTTPS-посилання без логіна й пароля." });
      return;
    }
    let linkSaved = false;
    await perform(candidate.materialId, async () => {
      await apiJson(`/api/librarian/materials/${encodeURIComponent(candidate.materialId)}/ebook-links`, {
        method: "POST",
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          expectedVersion: candidate.materialVersion,
          url,
        }),
      });
      linkSaved = true;
      try {
        const response = await apiJson<{ textbook: ManagedTextbook }>("/api/librarian/textbooks", {
          method: "POST",
          body: JSON.stringify({ requestId: crypto.randomUUID(), materialId: candidate.materialId, grade, publish: true }),
        });
        setLinkDrafts((current) => ({ ...current, [candidate.materialId]: "" }));
        setMessage({ tone: "success", text: `Посилання збережено, а «${response.textbook.title}» додано до ${grade} класу.` });
      } catch (reason) {
        throw new Error(`Посилання збережено, але підручник не опубліковано: ${errorMessage(reason)}`);
      }
    }, false);
    if (linkSaved) setRefreshKey((value) => value + 1);
  }

  async function addLinkToManaged(item: ManagedTextbook) {
    const url = validHttpsUrl(linkDrafts[item.materialId] ?? "");
    if (!url) {
      setMessage({ tone: "error", text: "Укажіть коректне HTTPS-посилання без логіна й пароля." });
      return;
    }
    await perform(`link-${item.materialId}`, async () => {
      await apiJson(`/api/librarian/materials/${encodeURIComponent(item.materialId)}/ebook-links`, {
        method: "POST",
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          expectedVersion: item.materialVersion,
          url,
        }),
      });
      setLinkDrafts((current) => ({ ...current, [item.materialId]: "" }));
      setMessage({ tone: "success", text: `Нове покликання для «${item.title}» збережено.` });
    });
  }

  async function changeItem(item: ManagedTextbook, action: "archive" | "restore" | "publish" | "reorder") {
    const parsedOrder = Number(orderDrafts[item.id]);
    if (action === "reorder" && (!Number.isInteger(parsedOrder) || parsedOrder < 0 || parsedOrder > 999999)) {
      setMessage({ tone: "error", text: "Порядок має бути цілим числом від 0 до 999999." });
      return;
    }
    await perform(item.id, async () => {
      const response = await apiJson<{ textbook: ManagedTextbook }>(`/api/librarian/textbooks/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          expectedVersion: item.version,
          action,
          ...(action === "reorder" ? { sortOrder: parsedOrder } : {}),
        }),
      });
      setMessage({
        tone: "success",
        text: action === "archive"
          ? `«${item.title}» приховано з учнівського списку.`
          : action === "reorder"
            ? `Порядок «${item.title}» збережено.`
            : `«${item.title}» знову опубліковано.`,
      });
      setItems((current) => current.map((entry) => entry.id === item.id ? response.textbook : entry));
      setOrderDrafts((current) => ({ ...current, [item.id]: String(response.textbook.sortOrder) }));
    }, false);
  }

  async function perform(id: string, work: () => Promise<void>, refresh = true) {
    if (!writesEnabled || busyId) return;
    setBusyId(id);
    setMessage(null);
    try {
      await work();
      if (refresh) setRefreshKey((value) => value + 1);
    } catch (reason) {
      setMessage({ tone: "error", text: errorMessage(reason) });
    } finally {
      setBusyId("");
    }
  }

  return (
    <LibrarianShell
      activeSection="fund"
      activeSubsection="textbooks"
      displayName={displayName}
      roleLabel={role === "admin" ? "Адміністратор" : "Бібліотекар"}
      writesEnabled={writesEnabled}
      signOutHref={signOutHref}
    >
      <main className={styles.workspace}>
        <header className={styles.titleRow}>
          <div><p>Фонд · цифрова полиця</p><h1>Каталог е-підручників</h1><span>Керуйте лише публічним списком. Картки фонду, примірники та історія не видаляються.</span></div>
          <a href="/textbooks" target="_blank" rel="noopener noreferrer">Відкрити для учнів <SiteIcon name="external" size={17} /></a>
        </header>

        <section className={styles.toolbar} aria-label="Параметри списку">
          <label><span>Навчальний рік</span><strong>{academicYear || "Завантаження…"}</strong></label>
          <label><span>Клас</span><select value={grade} onChange={(event) => { setGrade(Number(event.target.value)); setQuery(""); }} aria-label="Клас">{Array.from({ length: 11 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1} клас</option>)}</select></label>
          <label><span>Стан</span><select value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)} aria-label="Стан"><option value="visible">Опубліковані</option><option value="hidden">Приховані</option><option value="all">Усі</option></select></label>
          <label><span>Сортування</span><select value={sort} onChange={(event) => setSort(event.target.value as SortMode)} aria-label="Сортування"><option value="manual">Ручний порядок</option><option value="title">За назвою</option><option value="subject">За предметом</option><option value="newest">За роком</option></select></label>
          <button type="button" onClick={() => setRefreshKey((value) => value + 1)} disabled={loading}><SiteIcon name={loading ? "loading" : "refresh"} size={17} /> Оновити</button>
        </section>

        {message ? <div className={`${styles.notice} ${message.tone === "error" ? styles.noticeError : ""}`} role={message.tone === "error" ? "alert" : "status"}><SiteIcon name={message.tone === "error" ? "error" : "success"} size={19} /><span>{message.text}</span></div> : null}

        <div className={styles.layout}>
          <section className={styles.listPanel} aria-labelledby="current-textbooks-title">
            <header><div><span>{visibleItems.length} у списку</span><h2 id="current-textbooks-title">Е-підручники {grade} класу</h2></div><small>Менше число = вище у «Рекомендованому».</small></header>
            {loading ? <p className={styles.loading}><SiteIcon name="loading" size={20} /> Завантаження…</p> : null}
            {!loading && visibleItems.length === 0 ? <div className={styles.empty}><SiteIcon name="fund" size={28} /><strong>У цьому списку записів немає</strong><span>Знайдіть підручник праворуч або змініть фільтр стану.</span></div> : null}
            <div className={styles.items}>
              {visibleItems.map((item) => (
                <article key={item.id} className={styles.item}>
                  <Cover url={item.coverUrl} title={item.title} />
                  <div className={styles.itemBody}>
                    <div className={styles.itemTop}><span className={item.status === "published" ? styles.live : styles.hidden}>{item.status === "published" ? "Опубліковано" : item.status === "archived" ? "Приховано" : "Чернетка"}</span><a href={`/librarian?tool=catalog&material=${encodeURIComponent(item.materialId)}`}>{item.materialId} <SiteIcon name="external" size={13} /></a></div>
                    <h3>{item.title}</h3>
                    <p>{[item.subject, item.author, item.publicationYear, item.publisher].filter(Boolean).join(" · ")}</p>
                    <div className={styles.linkState}>{item.activeResourceCount > 0 ? <><SiteIcon name="success" size={15} /> {item.activeResourceCount} активне посилання</> : <><SiteIcon name="error" size={15} /> Немає активного посилання</>}{item.primaryResourceUrl ? <a href={item.primaryResourceUrl} target="_blank" rel="noopener noreferrer">Перевірити</a> : null}</div>
                    <details className={styles.linkAdder}>
                      <summary><SiteIcon name="add" size={14} /> Додати покликання</summary>
                      <div><input type="url" inputMode="url" placeholder="https://…" value={linkDrafts[item.materialId] ?? ""} onChange={(event) => setLinkDrafts((current) => ({ ...current, [item.materialId]: event.target.value }))} aria-label={`Покликання для ${item.title}`} /><button type="button" onClick={() => void addLinkToManaged(item)} disabled={!writesEnabled || Boolean(busyId)}>Зберегти</button></div>
                    </details>
                    <div className={styles.itemActions}>
                      <label><span>Порядок</span><input type="number" min="0" max="999999" value={orderDrafts[item.id] ?? item.sortOrder} onChange={(event) => setOrderDrafts((current) => ({ ...current, [item.id]: event.target.value }))} /></label>
                      <button type="button" onClick={() => void changeItem(item, "reorder")} disabled={!writesEnabled || busyId === item.id || Number(orderDrafts[item.id]) === item.sortOrder}>Зберегти</button>
                      {item.status === "published" ? <button type="button" className={styles.quietButton} onClick={() => void changeItem(item, "archive")} disabled={!writesEnabled || Boolean(busyId)}><SiteIcon name="hidden" size={15} /> Приховати</button> : <button type="button" className={styles.primaryButton} onClick={() => void changeItem(item, item.status === "archived" ? "restore" : "publish")} disabled={!writesEnabled || Boolean(busyId)}><SiteIcon name="visible" size={15} /> Опублікувати</button>}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <aside className={styles.addPanel} aria-labelledby="add-textbook-title">
            <header><span>Додати з чинного каталогу</span><h2 id="add-textbook-title">Знайти підручник</h2><p>Знайдіть підручник у фонді. Якщо електронного покликання ще немає, його можна додати прямо тут.</p></header>
            <label className={styles.search}><span>Назва, автор або CAT-ID</span><div><SiteIcon name="search" size={18} /><input type="search" value={query} maxLength={120} placeholder="Введіть щонайменше 2 символи" onChange={(event) => setQuery(event.target.value)} /></div></label>
            {debouncedQuery.length < 2 ? <p className={styles.searchHint}>Пошук почнеться після двох символів.</p> : null}
            {debouncedQuery.length >= 2 && !loading && candidates.length === 0 ? <p className={styles.searchHint}>Вільних підручників із таким запитом не знайдено.</p> : null}
            <div className={styles.candidates}>
              {candidates.map((candidate) => (
                <article key={candidate.materialId} className={!candidate.resourceUrl ? styles.candidateNeedsLink : ""}>
                  <Cover url={candidate.coverUrl} title={candidate.title} compact />
                  <div><strong>{candidate.title}</strong><small>{[candidate.subject, candidate.author, candidate.publicationYear].filter(Boolean).join(" · ")}</small><span>{candidate.materialId}{candidate.resourceUrl ? " · покликання готове" : " · потрібне покликання"}</span></div>
                  {candidate.resourceUrl ? <button type="button" onClick={() => void addCandidate(candidate)} disabled={!writesEnabled || Boolean(busyId)} aria-label={`Додати ${candidate.title}`}><SiteIcon name={busyId === candidate.materialId ? "loading" : "add"} size={17} /></button> : null}
                  {!candidate.resourceUrl ? <div className={styles.candidateLinkForm}><input type="url" inputMode="url" placeholder="Офіційне HTTPS-покликання" value={linkDrafts[candidate.materialId] ?? ""} onChange={(event) => setLinkDrafts((current) => ({ ...current, [candidate.materialId]: event.target.value }))} aria-label={`Покликання для ${candidate.title}`} /><button type="button" onClick={() => void saveLinkAndAddCandidate(candidate)} disabled={!writesEnabled || Boolean(busyId)}>{busyId === candidate.materialId ? <SiteIcon name="loading" size={15} /> : <SiteIcon name="add" size={15} />} Зберегти й додати</button></div> : null}
                </article>
              ))}
            </div>
          </aside>
        </div>
      </main>
    </LibrarianShell>
  );
}

function Cover({ url, title, compact = false }: { url: string; title: string; compact?: boolean }) {
  return <span className={`${styles.cover} ${compact ? styles.coverCompact : ""}`}>{url ? <img src={url} alt="" /> : <span>{title}</span>}</span>;
}

async function apiJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const body = await response.json() as T & { success?: boolean; error?: string };
  if (!response.ok || body.success === false) throw new Error(body.error || "Не вдалося зберегти зміну.");
  return body;
}

function compare(a: string, b: string): number { return a.localeCompare(b, "uk-UA", { sensitivity: "base" }); }
function errorMessage(reason: unknown): string { return reason instanceof Error ? reason.message : "Сталася помилка. Спробуйте ще раз."; }
function validHttpsUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : "";
  } catch {
    return "";
  }
}
