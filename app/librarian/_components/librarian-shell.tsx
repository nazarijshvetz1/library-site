"use client";

/* eslint-disable @next/next/no-img-element -- the official shared emblem is intentionally loaded from the public catalog. */

import {
  useCallback,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  LIBRARY_EMBLEM_URL,
  librarianSectionHref,
  librarianUtilityHref,
  type LibrarianSection,
} from "./librarian-routes";
import SiteIcon, { type SiteIconName } from "../../_components/site-icon";
import styles from "./librarian-shell.module.css";

export type LibrarianShellProps = {
  activeSection: LibrarianSection;
  displayName: string;
  roleLabel: string;
  signOutHref: string;
  telegramMiniApp?: boolean;
  writesEnabled?: boolean;
  subsections?: LibrarianSubsection[];
  activeSubsection?: string;
  onSubsectionNavigate?: (id: string) => void;
  children: ReactNode;
};

export type LibrarianSubsection = {
  id: string;
  section: LibrarianSection;
  label: string;
  hint: string;
  icon: SiteIconName;
  href: string;
};

type NavigationItem = {
  id: LibrarianSection;
  label: string;
  hint: string;
  icon: SiteIconName;
};

const PRIMARY_ITEMS: NavigationItem[] = [
  { id: "home", label: "Головна", hint: "Огляд кабінету", icon: "home" },
  { id: "fund", label: "Фонд", hint: "Каталог і примірники", icon: "fund" },
  { id: "circulation", label: "Видача", hint: "Видача та повернення", icon: "circulation" },
  { id: "orders", label: "Заявки", hint: "Замовлення вчителів", icon: "requests" },
];

const SECONDARY_ITEMS: NavigationItem[] = [
  { id: "visits", label: "Відвідування", hint: "Графік бібліотеки", icon: "visits" },
  { id: "teachers", label: "Вчителі", hint: "Картки та доступ", icon: "teachers" },
  { id: "acquisitions", label: "Комплектування", hint: "Дозамовлення фонду", icon: "acquisitions" },
  { id: "management", label: "Керування", hint: "Кабінети й навчальний рік", icon: "management" },
];

const ALL_ITEMS = [...PRIMARY_ITEMS, ...SECONDARY_ITEMS];

export default function LibrarianShell({
  activeSection,
  displayName,
  roleLabel,
  signOutHref,
  telegramMiniApp = false,
  writesEnabled,
  subsections = [],
  activeSubsection,
  onSubsectionNavigate,
  children,
}: LibrarianShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

  const excelExportHref = librarianUtilityHref("excelExport", telegramMiniApp);
  const excelImportHref = librarianUtilityHref("excelImport", telegramMiniApp);
  const telegramHref = librarianUtilityHref("telegram", telegramMiniApp);
  const publicCatalogHref = librarianUtilityHref("publicCatalog", telegramMiniApp);
  const secondaryActive = SECONDARY_ITEMS.some((item) => item.id === activeSection);
  const navigationHistory = useLibrarianNavigationHistory(telegramMiniApp);

  useEffect(() => {
    if (!drawerOpen) return;
    closeButtonRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setDrawerOpen(false);
        window.requestAnimationFrame(() => moreButtonRef.current?.focus());
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        drawerRef.current?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])") ?? [],
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  function closeDrawer(restoreFocus = false) {
    setDrawerOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => moreButtonRef.current?.focus());
    }
  }

  return (
    <div className={`${styles.shell} ${telegramMiniApp ? styles.telegramMiniApp : ""}`}>
      <header className={styles.header}>
        <a
          className={styles.brand}
          href={librarianSectionHref("home", telegramMiniApp)}
          aria-label="Єдина бібліотека — головна сторінка кабінету бібліотекаря"
        >
          <img src={LIBRARY_EMBLEM_URL} alt="" width="48" height="48" />
          <span>
            <strong>Єдина бібліотека</strong>
            <small>Міжнародний ліцей МАУП</small>
          </span>
        </a>

        <nav className={styles.utilityNav} aria-label="Службові посилання">
          <a href={publicCatalogHref ?? undefined} target="_blank" rel="noopener noreferrer">
            Публічний каталог <SiteIcon name="external" size={16} />
          </a>
          {excelExportHref ? <a href={excelExportHref}>Експорт <SiteIcon name="export" size={16} /></a> : null}
          {excelImportHref ? <a href={excelImportHref}>Імпорт <SiteIcon name="import" size={16} /></a> : null}
          <a href={telegramHref ?? undefined} className={styles.telegramLink}>
            Telegram <SiteIcon name="telegram" size={16} />
          </a>
        </nav>

        <div className={styles.account}>
          <nav className={styles.historyNav} aria-label="Історія переходів">
            <button
              type="button"
              aria-label="Назад до попередньої сторінки"
              title="Назад"
              disabled={!navigationHistory.canGoBack}
              onClick={navigationHistory.goBack}
            >
              <SiteIcon name="previous" size={18} />
            </button>
            <button
              type="button"
              aria-label="Вперед до наступної сторінки"
              title="Вперед"
              disabled={!navigationHistory.canGoForward}
              onClick={navigationHistory.goForward}
            >
              <SiteIcon name="forward" size={18} />
            </button>
          </nav>
          <span>
            <strong title={displayName}>{displayName}</strong>
            <small>{roleLabel}</small>
          </span>
          <a href={signOutHref}>{telegramMiniApp ? "До бота" : "Вийти"}</a>
        </div>
      </header>

      <div className={styles.layout}>
        <aside className={styles.sidebar} aria-label="Головне меню кабінету бібліотекаря">
          <p className={styles.menuLabel}>Робоче місце</p>
          <nav className={styles.desktopNav} aria-label="Розділи кабінету бібліотекаря">
            {ALL_ITEMS.map((item) => {
              const nested = subsections.filter((subsection) => subsection.section === item.id);
              const active = item.id === activeSection;
              return (
                <div className={styles.navigationGroup} key={item.id}>
                  <SectionLink
                    item={item}
                    active={active}
                    telegramMiniApp={telegramMiniApp}
                  />
                  {active && nested.length ? (
                    <nav className={styles.subsectionNav} aria-label={`Підрозділи: ${item.label}`}>
                      {nested.map((subsection) => (
                        <SubsectionLink
                          key={subsection.id}
                          subsection={subsection}
                          active={subsection.id === activeSubsection}
                          onNavigate={onSubsectionNavigate}
                        />
                      ))}
                    </nav>
                  ) : null}
                </div>
              );
            })}
          </nav>
          <nav className={styles.sidebarUtilities} aria-label="Службові посилання кабінету">
            <a href={publicCatalogHref ?? undefined} target="_blank" rel="noopener noreferrer">Публічний каталог <SiteIcon name="external" size={15} /></a>
            {excelExportHref ? <a href={excelExportHref}><SiteIcon name="export" size={15} /> Експорт в Excel</a> : null}
            {excelImportHref ? <a href={excelImportHref}><SiteIcon name="import" size={15} /> Імпорт з Excel</a> : null}
            <a href={telegramHref ?? undefined}><SiteIcon name="telegram" size={15} /> Telegram</a>
          </nav>
          {writesEnabled !== undefined ? (
            <div className={writesEnabled ? styles.writeEnabled : styles.readOnly} role="status">
              <span aria-hidden="true"><SiteIcon name={writesEnabled ? "success" : "read-only"} size={16} /></span>
              <span>
                <strong>{writesEnabled ? "Зміни дозволені" : "Лише перегляд"}</strong>
                <small>{writesEnabled ? "Дані зберігаються одразу." : "Редагування тимчасово вимкнене."}</small>
              </span>
            </div>
          ) : null}
        </aside>

        <div className={styles.content}>{children}</div>
      </div>

      <nav className={styles.mobileNav} aria-label="Основні розділи кабінету бібліотекаря">
        {PRIMARY_ITEMS.map((item) => (
          <a
            key={item.id}
            href={librarianSectionHref(item.id, telegramMiniApp)}
            aria-current={item.id === activeSection ? "page" : undefined}
          >
            <span aria-hidden="true"><SiteIcon name={item.icon} size={20} /></span>
            <strong>{item.label}</strong>
          </a>
        ))}
        <button
          ref={moreButtonRef}
          type="button"
          className={secondaryActive ? styles.mobileCurrent : ""}
          aria-expanded={drawerOpen}
          aria-controls="librarian-more-menu"
          onClick={() => setDrawerOpen(true)}
        >
          <span aria-hidden="true"><SiteIcon name="more" size={20} /></span>
          <strong>Ще</strong>
        </button>
      </nav>

      {drawerOpen ? (
        <div className={styles.drawerLayer}>
          <button
            type="button"
            className={styles.backdrop}
            aria-label="Закрити додаткове меню"
            onClick={() => closeDrawer(true)}
          />
          <section
            ref={drawerRef}
            id="librarian-more-menu"
            className={styles.drawer}
            role="dialog"
            aria-modal="true"
            aria-labelledby="librarian-more-title"
          >
            <header>
              <div>
                <span>Кабінет бібліотекаря</span>
                <h2 id="librarian-more-title">Інші розділи</h2>
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                aria-label="Закрити меню"
                onClick={() => closeDrawer(true)}
              >
                <SiteIcon name="close" size={20} />
              </button>
            </header>
            <nav className={styles.drawerNav} aria-label="Усі розділи кабінету бібліотекаря">
              {ALL_ITEMS.map((item) => (
                <div className={styles.drawerNavigationGroup} key={item.id}>
                  <SectionLink
                    item={item}
                    active={item.id === activeSection}
                    telegramMiniApp={telegramMiniApp}
                    compact
                  />
                  {item.id === activeSection ? subsections.filter((subsection) => subsection.section === item.id).map((subsection) => (
                    <SubsectionLink
                      key={subsection.id}
                      subsection={subsection}
                      active={subsection.id === activeSubsection}
                      onNavigate={(id) => {
                        closeDrawer();
                        onSubsectionNavigate?.(id);
                      }}
                      compact
                    />
                  )) : null}
                </div>
              ))}
            </nav>
            <div className={styles.drawerUtilities}>
              <a href={publicCatalogHref ?? undefined} target="_blank" rel="noopener noreferrer">Публічний каталог <SiteIcon name="external" size={16} /></a>
              {excelExportHref ? <a href={excelExportHref}><SiteIcon name="export" size={16} /> Експорт в Excel</a> : null}
              {excelImportHref ? <a href={excelImportHref}><SiteIcon name="import" size={16} /> Імпорт з Excel</a> : null}
              <a href={telegramHref ?? undefined}><SiteIcon name="telegram" size={16} /> Telegram</a>
              <a href={signOutHref}><SiteIcon name={telegramMiniApp ? "external" : "logout"} size={16} /> {telegramMiniApp ? "Повернутися до бота" : "Вийти з кабінету"}</a>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function SubsectionLink({
  subsection,
  active,
  onNavigate,
  compact = false,
}: {
  subsection: LibrarianSubsection;
  active: boolean;
  onNavigate?: (id: string) => void;
  compact?: boolean;
}) {
  return (
    <a
      className={`${styles.subsectionLink} ${active ? styles.subsectionCurrent : ""} ${compact ? styles.subsectionCompact : ""}`}
      href={subsection.href}
      aria-current={active ? "page" : undefined}
      onClick={(event) => {
        if (!onNavigate || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onNavigate(subsection.id);
      }}
    >
      <span aria-hidden="true"><SiteIcon name={subsection.icon} size={17} /></span>
      <span><strong>{subsection.label}</strong><small>{subsection.hint}</small></span>
    </a>
  );
}

type StoredNavigationHistory = { entries: string[]; index: number };

function useLibrarianNavigationHistory(telegramMiniApp: boolean) {
  const [state, setState] = useState<StoredNavigationHistory>({ entries: [], index: -1 });
  const storageKey = `library:librarian-history:${telegramMiniApp ? "telegram" : "web"}`;

  const recordCurrent = useCallback(() => {
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    let stored = readNavigationHistory(storageKey);
    if (stored.entries[stored.index] !== current) {
      const previousIndex = stored.entries.lastIndexOf(current, Math.max(0, stored.index - 1));
      const nextIndex = stored.entries.indexOf(current, stored.index + 1);
      if (previousIndex >= 0 && previousIndex === stored.index - 1) {
        stored = { ...stored, index: previousIndex };
      } else if (nextIndex >= 0 && nextIndex === stored.index + 1) {
        stored = { ...stored, index: nextIndex };
      } else {
        const entries = [...stored.entries.slice(0, stored.index + 1), current].slice(-40);
        stored = { entries, index: entries.length - 1 };
      }
      writeNavigationHistory(storageKey, stored);
    }
    setState(stored);
  }, [storageKey]);

  useEffect(() => {
    const initialRecord = window.setTimeout(recordCurrent, 0);
    window.addEventListener("popstate", recordCurrent);
    window.addEventListener("pageshow", recordCurrent);
    window.addEventListener("librarian:navigation-change", recordCurrent);
    return () => {
      window.clearTimeout(initialRecord);
      window.removeEventListener("popstate", recordCurrent);
      window.removeEventListener("pageshow", recordCurrent);
      window.removeEventListener("librarian:navigation-change", recordCurrent);
    };
  }, [recordCurrent]);

  const go = useCallback((offset: -1 | 1) => {
    const stored = readNavigationHistory(storageKey);
    const index = stored.index + offset;
    const destination = stored.entries[index];
    if (!destination) return;
    const next = { ...stored, index };
    writeNavigationHistory(storageKey, next);
    setState(next);
    window.location.assign(destination);
  }, [storageKey]);

  return {
    canGoBack: state.index > 0,
    canGoForward: state.index >= 0 && state.index < state.entries.length - 1,
    goBack: () => go(-1),
    goForward: () => go(1),
  };
}

function readNavigationHistory(key: string): StoredNavigationHistory {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(key) || "null") as StoredNavigationHistory | null;
    if (parsed && Array.isArray(parsed.entries) && Number.isInteger(parsed.index)) {
      const entries = parsed.entries.filter((entry): entry is string => typeof entry === "string" && entry.startsWith("/")).slice(-40);
      return { entries, index: Math.min(Math.max(-1, parsed.index), entries.length - 1) };
    }
  } catch { /* Session storage may be unavailable in privacy-focused WebViews. */ }
  return { entries: [], index: -1 };
}

function writeNavigationHistory(key: string, value: StoredNavigationHistory) {
  try { window.sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Navigation still works through direct links. */ }
}

function SectionLink({
  item,
  active,
  telegramMiniApp,
  compact = false,
}: {
  item: NavigationItem;
  active: boolean;
  telegramMiniApp: boolean;
  compact?: boolean;
}) {
  return (
    <a
      className={`${styles.sectionLink} ${active ? styles.sectionCurrent : ""} ${compact ? styles.compactLink : ""}`}
      href={librarianSectionHref(item.id, telegramMiniApp)}
      aria-current={active ? "page" : undefined}
    >
      <span className={styles.sectionIcon} aria-hidden="true"><SiteIcon name={item.icon} size={20} /></span>
      <span>
        <strong>{item.label}</strong>
        <small>{item.hint}</small>
      </span>
    </a>
  );
}
