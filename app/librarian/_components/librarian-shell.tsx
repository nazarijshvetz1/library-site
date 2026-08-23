"use client";

/* eslint-disable @next/next/no-img-element -- the official shared emblem is intentionally loaded from the public catalog. */

import {
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
import styles from "./librarian-shell.module.css";

export type LibrarianShellProps = {
  activeSection: LibrarianSection;
  displayName: string;
  roleLabel: string;
  signOutHref: string;
  telegramMiniApp?: boolean;
  writesEnabled?: boolean;
  children: ReactNode;
};

type NavigationItem = {
  id: LibrarianSection;
  label: string;
  hint: string;
  icon: string;
};

const PRIMARY_ITEMS: NavigationItem[] = [
  { id: "home", label: "Головна", hint: "Огляд кабінету", icon: "⌂" },
  { id: "fund", label: "Фонд", hint: "Каталог і примірники", icon: "▤" },
  { id: "circulation", label: "Видача", hint: "Видача та повернення", icon: "⇄" },
  { id: "orders", label: "Заявки", hint: "Замовлення вчителів", icon: "▣" },
];

const SECONDARY_ITEMS: NavigationItem[] = [
  { id: "visits", label: "Відвідування", hint: "Графік бібліотеки", icon: "◷" },
  { id: "teachers", label: "Вчителі", hint: "Картки та доступ", icon: "●" },
  { id: "acquisitions", label: "Комплектування", hint: "Дозамовлення фонду", icon: "＋" },
  { id: "management", label: "Керування", hint: "Кабінети й навчальний рік", icon: "⚙" },
];

const ALL_ITEMS = [...PRIMARY_ITEMS, ...SECONDARY_ITEMS];

export default function LibrarianShell({
  activeSection,
  displayName,
  roleLabel,
  signOutHref,
  telegramMiniApp = false,
  writesEnabled,
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
            <small>Кабінет бібліотекаря</small>
          </span>
        </a>

        <nav className={styles.utilityNav} aria-label="Службові посилання">
          <a href={publicCatalogHref ?? undefined} target="_blank" rel="noopener noreferrer">
            Публічний каталог <span aria-hidden="true">↗</span>
          </a>
          {excelExportHref ? <a href={excelExportHref}>Експорт <span aria-hidden="true">⇩</span></a> : null}
          {excelImportHref ? <a href={excelImportHref}>Імпорт <span aria-hidden="true">⇧</span></a> : null}
          <a href={telegramHref ?? undefined} className={styles.telegramLink}>
            Telegram <span aria-hidden="true">➤</span>
          </a>
        </nav>

        <div className={styles.account}>
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
            {ALL_ITEMS.map((item) => (
              <SectionLink
                key={item.id}
                item={item}
                active={item.id === activeSection}
                telegramMiniApp={telegramMiniApp}
              />
            ))}
          </nav>
          <nav className={styles.sidebarUtilities} aria-label="Службові посилання кабінету">
            <a href={publicCatalogHref ?? undefined} target="_blank" rel="noopener noreferrer">Публічний каталог ↗</a>
            {excelExportHref ? <a href={excelExportHref}>Експорт в Excel</a> : null}
            {excelImportHref ? <a href={excelImportHref}>Імпорт з Excel</a> : null}
            <a href={telegramHref ?? undefined}>Telegram</a>
          </nav>
          {writesEnabled !== undefined ? (
            <div className={writesEnabled ? styles.writeEnabled : styles.readOnly} role="status">
              <span aria-hidden="true">{writesEnabled ? "●" : "○"}</span>
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
            <span aria-hidden="true">{item.icon}</span>
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
          <span aria-hidden="true">•••</span>
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
                ×
              </button>
            </header>
            <nav className={styles.drawerNav} aria-label="Додаткові розділи кабінету бібліотекаря">
              {SECONDARY_ITEMS.map((item) => (
                <SectionLink
                  key={item.id}
                  item={item}
                  active={item.id === activeSection}
                  telegramMiniApp={telegramMiniApp}
                  compact
                />
              ))}
            </nav>
            <div className={styles.drawerUtilities}>
              <a href={publicCatalogHref ?? undefined} target="_blank" rel="noopener noreferrer">Публічний каталог ↗</a>
              {excelExportHref ? <a href={excelExportHref}>Експорт в Excel</a> : null}
              {excelImportHref ? <a href={excelImportHref}>Імпорт з Excel</a> : null}
              <a href={telegramHref ?? undefined}>Telegram</a>
              <a href={signOutHref}>{telegramMiniApp ? "Повернутися до бота" : "Вийти з кабінету"}</a>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
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
      <span className={styles.sectionIcon} aria-hidden="true">{item.icon}</span>
      <span>
        <strong>{item.label}</strong>
        <small>{item.hint}</small>
      </span>
    </a>
  );
}
