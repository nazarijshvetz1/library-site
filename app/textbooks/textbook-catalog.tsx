"use client";

/* eslint-disable @next/next/no-img-element -- catalog covers are stored in D1/R2 or at vetted HTTPS URLs */
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext production navigation intentionally uses full-page anchors */
/* eslint-disable react-hooks/set-state-in-effect -- effects synchronize URL state and remote API loading state */

import { useEffect, useMemo, useState } from "react";

import SiteIcon from "@/app/_components/site-icon";
import styles from "./textbooks.module.css";

const PUBLIC_CATALOG_URL = "https://nazarijshvetz1.github.io/library-site/";
const LOGO_URL = `${PUBLIC_CATALOG_URL}library-logo.png`;
const GRADES = Array.from({ length: 11 }, (_, index) => index + 1);

type Resource = {
  id: string;
  label: string;
  url: string;
  directPdf: boolean;
  sourceHost: string;
};

type Textbook = {
  id: string;
  grade: number;
  title: string;
  author: string;
  publicationYear: number | null;
  subject: string;
  publisher: string;
  coverUrl: string;
  sortOrder: number;
  createdAt: string;
  resources: Resource[];
};

type SortMode = "recommended" | "title" | "author" | "newest" | "recent";

export default function TextbookCatalog() {
  const [grade, setGrade] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [subject, setSubject] = useState("");
  const [sort, setSort] = useState<SortMode>("recommended");
  const [items, setItems] = useState<Textbook[]>([]);
  const [academicYear, setAcademicYear] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    function restoreUrlState() {
      const url = new URL(window.location.href);
      const nextGrade = Number(url.searchParams.get("grade"));
      setGrade(Number.isInteger(nextGrade) && nextGrade >= 1 && nextGrade <= 11 ? nextGrade : null);
      setQuery(bounded(url.searchParams.get("q"), 120));
      setSubject(bounded(url.searchParams.get("subject"), 120));
      setSort(parseSort(url.searchParams.get("sort")));
    }
    restoreUrlState();
    window.addEventListener("popstate", restoreUrlState);
    return () => window.removeEventListener("popstate", restoreUrlState);
  }, []);

  useEffect(() => {
    if (grade === null) {
      setItems([]);
      setAcademicYear("");
      setError("");
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    fetch(`/api/textbooks?grade=${grade}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as {
          success?: boolean;
          error?: string;
          academicYear?: { label?: string };
          items?: Textbook[];
        };
        if (!response.ok || body.success !== true) throw new Error(body.error || "Не вдалося завантажити е-підручники.");
        setItems(Array.isArray(body.items) ? body.items : []);
        setAcademicYear(body.academicYear?.label || "");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "Не вдалося завантажити е-підручники.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [grade, refreshKey]);

  const subjects = useMemo(
    () => [...new Set(items.map((item) => item.subject).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "uk-UA")),
    [items],
  );
  const visibleItems = useMemo(() => {
    const normalized = normalizeSearch(query);
    const filtered = items.filter((item) => {
      if (subject && item.subject !== subject) return false;
      if (!normalized) return true;
      return normalizeSearch([item.title, item.author, item.subject, item.publisher].join(" ")).includes(normalized);
    });
    return [...filtered].sort((a, b) => compareTextbooks(a, b, sort));
  }, [items, query, subject, sort]);

  function chooseGrade(nextGrade: number) {
    setGrade(nextGrade);
    setSubject("");
    updateUrl({ grade: String(nextGrade), subject: null }, "push");
  }

  function updateQuery(value: string) {
    const next = value.slice(0, 120);
    setQuery(next);
    updateUrl({ q: next || null }, "replace");
  }

  function updateSubject(value: string) {
    setSubject(value);
    updateUrl({ subject: value || null }, "push");
  }

  function updateSort(value: SortMode) {
    setSort(value);
    updateUrl({ sort: value === "recommended" ? null : value }, "push");
  }

  function resetFilters() {
    setQuery("");
    setSubject("");
    setSort("recommended");
    updateUrl({ q: null, subject: null, sort: null }, "push");
  }

  return (
    <main className={styles.page}>
      <a className={styles.skipLink} href="#textbook-results">До списку підручників</a>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <a className={styles.brand} href="/" aria-label="Єдина бібліотека — головна">
            <img src={LOGO_URL} alt="" width="46" height="46" />
            <span><strong>Єдина бібліотека</strong><small>Міжнародний ліцей МАУП</small></span>
          </a>
          <nav className={styles.nav} aria-label="Головна навігація">
            <a href={PUBLIC_CATALOG_URL}>Каталог <SiteIcon name="external" size={15} /></a>
            <a className={styles.navCurrent} href="/textbooks">Е-підручники</a>
            <a href="/visits">Графік</a>
            <a href="/teacher">Кабінет учителя</a>
          </nav>
        </div>
      </header>

      <section className={styles.hero} aria-labelledby="textbooks-title">
        <div>
          <p className={styles.eyebrow}>Для учнів і батьків · 1–11 класи</p>
          <h1 id="textbooks-title">Єдина бібліотека · Е-підручники</h1>
          <p>Цифрова полиця з електронними версіями саме тих підручників, якими користується ліцей.</p>
        </div>
        <aside className={styles.heroNote}>
          <SiteIcon name="security" size={22} />
          <span><strong>Перевірені зовнішні джерела</strong><small>Електронні версії відкриваються на сайтах ІМЗО, МОН, видавців або освітніх бібліотек.</small></span>
        </aside>
      </section>

      <section className={styles.gradePanel} aria-labelledby="grade-title">
        <div className={styles.sectionHeading}>
          <div><span>Крок 1</span><h2 id="grade-title">Оберіть клас</h2></div>
          {academicYear ? <p>Навчальний рік <strong>{academicYear}</strong></p> : null}
        </div>
        <fieldset className={styles.gradeFieldset}>
          <legend className={styles.srOnly}>Клас навчання</legend>
          {GRADES.map((value) => (
            <label key={value} className={grade === value ? styles.gradeActive : ""}>
              <input type="radio" name="grade" value={value} checked={grade === value} onChange={() => chooseGrade(value)} />
              <span>{value}<small>клас</small></span>
            </label>
          ))}
        </fieldset>
      </section>

      <section className={styles.catalog} aria-labelledby="catalog-title">
        <div className={styles.sectionHeading}>
          <div><span>Крок 2</span><h2 id="catalog-title">Знайдіть підручник</h2></div>
          {grade !== null ? <p aria-live="polite"><strong>{visibleItems.length}</strong> у списку</p> : null}
        </div>

        {grade === null ? (
          <div className={styles.initialState}>
            <SiteIcon name="fund" size={34} />
            <h3>Спочатку оберіть свій клас</h3>
            <p>Покажемо предмети й електронні підручники лише для потрібного класу.</p>
          </div>
        ) : (
          <div className={styles.catalogGrid}>
            <aside className={styles.filters} aria-label="Фільтри е-підручників">
              <label>
                <span>Пошук</span>
                <span className={styles.searchControl}>
                  <SiteIcon name="search" size={18} />
                  <input
                    type="search"
                    value={query}
                    maxLength={120}
                    placeholder="Назва, автор або предмет"
                    onChange={(event) => updateQuery(event.target.value)}
                  />
                </span>
              </label>
              <label><span>Предмет</span><select value={subject} onChange={(event) => updateSubject(event.target.value)}><option value="">Усі предмети</option>{subjects.map((value) => <option key={value}>{value}</option>)}</select></label>
              <label><span>Сортування</span><select value={sort} onChange={(event) => updateSort(event.target.value as SortMode)}><option value="recommended">Рекомендоване</option><option value="title">Назва А–Я</option><option value="author">За автором</option><option value="newest">Спочатку новіші</option><option value="recent">Нещодавно додані</option></select></label>
              {(query || subject || sort !== "recommended") ? <button type="button" className={styles.resetButton} onClick={resetFilters}>Очистити фільтри</button> : null}
            </aside>

            <div id="textbook-results" className={styles.results} aria-busy={loading}>
              {error ? <div className={styles.errorState} role="alert"><SiteIcon name="error" size={24} /><div><strong>Не вдалося оновити список</strong><p>{error}</p></div><button type="button" onClick={() => setRefreshKey((value) => value + 1)}>Спробувати ще раз</button></div> : null}
              {loading ? <div className={styles.skeletonGrid} aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <span key={index} />)}</div> : null}
              {!loading && !error && visibleItems.length === 0 ? (
                <div className={styles.emptyState}>
                  <SiteIcon name="search" size={30} />
                  <h3>{items.length === 0 ? `Для ${grade} класу е-підручників ще немає` : "За цими фільтрами нічого не знайдено"}</h3>
                  <p>{items.length === 0 ? "Бібліотекар ще не опублікував електронні версії для цього класу." : "Спробуйте іншу назву або очистьте фільтри."}</p>
                  {items.length > 0 ? <button type="button" onClick={resetFilters}>Очистити фільтри</button> : null}
                </div>
              ) : null}
              {!loading && visibleItems.length > 0 ? (
                <div className={styles.cardGrid}>
                  {visibleItems.map((item) => <TextbookCard key={item.id} item={item} />)}
                </div>
              ) : null}
            </div>
          </div>
        )}
      </section>

      <footer className={styles.footer}><span>© {new Date().getFullYear()} Бібліотека Міжнародного ліцею МАУП</span><a href={PUBLIC_CATALOG_URL}>Публічний каталог <SiteIcon name="external" size={14} /></a></footer>
    </main>
  );
}

function TextbookCard({ item }: { item: Textbook }) {
  return (
    <article className={styles.card}>
      <div className={styles.cover}>
        {item.coverUrl ? <img src={item.coverUrl} alt="" loading="lazy" /> : <span>{item.title}</span>}
      </div>
      <div className={styles.cardBody}>
        <div className={styles.chips}><span>{item.grade} клас</span>{item.subject ? <span>{item.subject}</span> : null}</div>
        <h3>{item.title}</h3>
        <p>{[item.author, item.publicationYear, item.publisher].filter(Boolean).join(" · ") || "Відомості про видання уточнюються"}</p>
        <div className={styles.resources}>
          {item.resources.map((resource) => (
            <a key={resource.id || resource.url} href={resource.url} target="_blank" rel="noopener noreferrer">
              <span><strong>Відкрити електронну версію</strong><small>{resource.directPdf ? "PDF" : "Онлайн"} · {resource.sourceHost}</small></span>
              <SiteIcon name={resource.directPdf ? "export" : "external"} size={18} />
            </a>
          ))}
        </div>
      </div>
    </article>
  );
}

function compareTextbooks(a: Textbook, b: Textbook, mode: SortMode): number {
  if (mode === "title") return compareText(a.title, b.title) || compareText(a.id, b.id);
  if (mode === "author") return compareText(a.author || a.title, b.author || b.title) || compareText(a.title, b.title);
  if (mode === "newest") return (b.publicationYear ?? 0) - (a.publicationYear ?? 0) || compareText(a.title, b.title);
  if (mode === "recent") return Date.parse(b.createdAt || "") - Date.parse(a.createdAt || "") || compareText(a.title, b.title);
  return a.sortOrder - b.sortOrder || compareText(a.title, b.title) || compareText(a.id, b.id);
}

function compareText(a: string, b: string): number { return a.localeCompare(b, "uk-UA", { sensitivity: "base" }); }
function normalizeSearch(value: string): string { return value.normalize("NFKC").toLocaleLowerCase("uk-UA").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/gu, " ").trim(); }
function bounded(value: string | null, max: number): string { return String(value ?? "").slice(0, max); }
function parseSort(value: string | null): SortMode { return value === "title" || value === "author" || value === "newest" || value === "recent" ? value : "recommended"; }

function updateUrl(changes: Record<string, string | null>, mode: "push" | "replace") {
  const url = new URL(window.location.href);
  Object.entries(changes).forEach(([key, value]) => value ? url.searchParams.set(key, value) : url.searchParams.delete(key));
  window.history[mode === "push" ? "pushState" : "replaceState"]({}, "", `${url.pathname}${url.search}`);
}
