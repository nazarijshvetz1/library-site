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
  librarianToolHref,
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
  { id: "reports", label: "Звіти", hint: "Аналітика й документи", icon: "reports" },
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
  const [expandedState, setExpandedState] = useState<{
    activeSection: LibrarianSection;
    expandedSection: LibrarianSection | null;
  }>({ activeSection, expandedSection: activeSection });
  const drawerTriggerRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

  const excelExportHref = librarianUtilityHref("excelExport", telegramMiniApp);
  const excelImportHref = librarianUtilityHref("excelImport", telegramMiniApp);
  const telegramHref = librarianUtilityHref("telegram", telegramMiniApp);
  const publicCatalogHref = librarianUtilityHref("publicCatalog", telegramMiniApp);
  const secondaryActive = SECONDARY_ITEMS.some((item) => item.id === activeSection);
  const navigationHistory = useLibrarianNavigationHistory(telegramMiniApp);
  const navigationSubsections = mergeSubsections(
    standardLibrarianSubsections(telegramMiniApp),
    subsections,
  );
  const expandedSection = expandedState.activeSection === activeSection
    ? expandedState.expandedSection
    : activeSection;

  useEffect(() => {
    if (!drawerOpen) return;
    closeButtonRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setDrawerOpen(false);
        window.requestAnimationFrame(() => drawerTriggerRef.current?.focus());
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
      window.requestAnimationFrame(() => drawerTriggerRef.current?.focus());
    }
  }

  function toggleSection(section: LibrarianSection) {
    setExpandedState((current) => {
      const currentExpanded = current.activeSection === activeSection
        ? current.expandedSection
        : activeSection;
      return {
        activeSection,
        expandedSection: currentExpanded === section ? null : section,
      };
    });
  }

  function openDrawerForSection(trigger: HTMLButtonElement, section?: LibrarianSection) {
    drawerTriggerRef.current = trigger;
    if (section) {
      setExpandedState({ activeSection, expandedSection: section });
    }
    setDrawerOpen(true);
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
          {excelExportHref ? <a href={excelExportHref}>Звіти <SiteIcon name="reports" size={16} /></a> : null}
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
              const nested = navigationSubsections.filter((subsection) => subsection.section === item.id);
              const active = item.id === activeSection;
              const expanded = expandedSection === item.id;
              return (
                <div className={styles.navigationGroup} key={item.id}>
                  <SectionControl
                    item={item}
                    active={active}
                    telegramMiniApp={telegramMiniApp}
                    expanded={expanded}
                    controlsId={nested.length ? `librarian-subsections-${item.id}` : undefined}
                    onToggle={nested.length ? () => toggleSection(item.id) : undefined}
                  />
                  {expanded && nested.length ? (
                    <nav id={`librarian-subsections-${item.id}`} className={styles.subsectionNav} aria-label={`Підрозділи: ${item.label}`}>
                      {nested.map((subsection) => (
                        <SubsectionLink
                          key={subsection.id}
                          subsection={subsection}
                          active={subsection.id === activeSubsection}
                          onNavigate={subsection.section === activeSection ? onSubsectionNavigate : undefined}
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
            {excelExportHref ? <a href={excelExportHref}><SiteIcon name="reports" size={15} /> Звіти й документи</a> : null}
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
        {PRIMARY_ITEMS.map((item) => {
          const nested = navigationSubsections.filter((subsection) => subsection.section === item.id);
          const active = item.id === activeSection;
          return nested.length ? (
            <button
              key={item.id}
              type="button"
              className={active ? styles.mobileCurrent : ""}
              aria-expanded={drawerOpen && expandedSection === item.id}
              aria-controls="librarian-more-menu"
              onClick={(event) => openDrawerForSection(event.currentTarget, item.id)}
            >
              <span aria-hidden="true"><SiteIcon name={item.icon} size={20} /></span>
              <strong>{item.label}</strong>
            </button>
          ) : (
            <a
              key={item.id}
              href={librarianSectionHref(item.id, telegramMiniApp)}
              aria-current={active ? "page" : undefined}
            >
              <span aria-hidden="true"><SiteIcon name={item.icon} size={20} /></span>
              <strong>{item.label}</strong>
            </a>
          );
        })}
        <button
          type="button"
          className={secondaryActive ? styles.mobileCurrent : ""}
          aria-expanded={drawerOpen}
          aria-controls="librarian-more-menu"
          onClick={(event) => openDrawerForSection(event.currentTarget)}
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
              {ALL_ITEMS.map((item) => {
                const nested = navigationSubsections.filter((subsection) => subsection.section === item.id);
                const expanded = expandedSection === item.id;
                return (
                  <div className={styles.drawerNavigationGroup} key={item.id}>
                    <SectionControl
                      item={item}
                      active={item.id === activeSection}
                      telegramMiniApp={telegramMiniApp}
                      compact
                      expanded={expanded}
                      controlsId={nested.length ? `librarian-drawer-subsections-${item.id}` : undefined}
                      onToggle={nested.length ? () => toggleSection(item.id) : undefined}
                    />
                    {expanded && nested.length ? (
                      <nav
                        id={`librarian-drawer-subsections-${item.id}`}
                        className={styles.drawerSubsectionNav}
                        aria-label={`Підрозділи: ${item.label}`}
                      >
                        {nested.map((subsection) => (
                          <SubsectionLink
                            key={subsection.id}
                            subsection={subsection}
                            active={subsection.id === activeSubsection}
                            onNavigate={subsection.section === activeSection ? onSubsectionNavigate : undefined}
                            onActivate={() => closeDrawer()}
                            compact
                          />
                        ))}
                      </nav>
                    ) : null}
                  </div>
                );
              })}
            </nav>
            <div className={styles.drawerUtilities}>
              <a href={publicCatalogHref ?? undefined} target="_blank" rel="noopener noreferrer">Публічний каталог <SiteIcon name="external" size={16} /></a>
              {excelExportHref ? <a href={excelExportHref}><SiteIcon name="reports" size={16} /> Звіти й документи</a> : null}
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
  onActivate,
  compact = false,
}: {
  subsection: LibrarianSubsection;
  active: boolean;
  onNavigate?: (id: string) => void;
  onActivate?: () => void;
  compact?: boolean;
}) {
  return (
    <a
      className={`${styles.subsectionLink} ${active ? styles.subsectionCurrent : ""} ${compact ? styles.subsectionCompact : ""}`}
      href={subsection.href}
      aria-current={active ? "page" : undefined}
      onClick={(event) => {
        const plainPrimaryClick = event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
        if (plainPrimaryClick) onActivate?.();
        if (!onNavigate || !plainPrimaryClick) return;
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

function SectionControl({
  item,
  active,
  telegramMiniApp,
  compact = false,
  expanded = false,
  controlsId,
  onToggle,
}: {
  item: NavigationItem;
  active: boolean;
  telegramMiniApp: boolean;
  compact?: boolean;
  expanded?: boolean;
  controlsId?: string;
  onToggle?: () => void;
}) {
  const content = (
    <>
      <span className={styles.sectionIcon} aria-hidden="true"><SiteIcon name={item.icon} size={20} /></span>
      <span className={styles.sectionCopy}>
        <strong>{item.label}</strong>
        <small>{item.hint}</small>
      </span>
      {onToggle ? (
        <span className={styles.sectionChevron} aria-hidden="true"><SiteIcon name="expand" size={16} /></span>
      ) : null}
    </>
  );

  if (onToggle) {
    return (
      <button
        className={`${styles.sectionLink} ${styles.sectionToggle} ${active ? styles.sectionCurrent : ""} ${compact ? styles.compactLink : ""}`}
        type="button"
        aria-expanded={expanded}
        aria-controls={controlsId}
        onClick={onToggle}
      >
        {content}
      </button>
    );
  }

  return (
    <a
      className={`${styles.sectionLink} ${active ? styles.sectionCurrent : ""} ${compact ? styles.compactLink : ""}`}
      href={librarianSectionHref(item.id, telegramMiniApp)}
      aria-current={active ? "page" : undefined}
    >
      {content}
    </a>
  );
}

function standardLibrarianSubsections(telegramMiniApp: boolean): LibrarianSubsection[] {
  const reportsBase = librarianSectionHref("reports", telegramMiniApp);
  const acquisitionsBase = librarianSectionHref("acquisitions", telegramMiniApp);
  return [
    { id: "catalog", section: "fund", label: "Каталог", hint: "Пошук і картка", icon: "catalog", href: librarianToolHref("catalog", telegramMiniApp) },
    { id: "create", section: "fund", label: "Новий матеріал", hint: "Додати до фонду", icon: "new-material", href: librarianToolHref("create", telegramMiniApp) },
    ...(telegramMiniApp ? [] : [
      { id: "textbooks", section: "fund" as const, label: "Е-підручники", hint: "Список для учнів", icon: "fund" as const, href: "/librarian/textbooks" },
    ]),
    { id: "issue", section: "circulation", label: "Видача вчителю", hint: "Оформити видачу", icon: "issue-teacher", href: librarianToolHref("issue", telegramMiniApp) },
    { id: "return", section: "circulation", label: "Повернення", hint: "Прийняти книги", icon: "return", href: librarianToolHref("return", telegramMiniApp) },
    { id: "class-issue", section: "circulation", label: "Видача класу", hint: "Кілька матеріалів", icon: "issue-class", href: librarianToolHref("class-issue", telegramMiniApp) },
    { id: "class-return", section: "circulation", label: "Повернення класу", hint: "Частково або повністю", icon: "return-class", href: librarianToolHref("class-return", telegramMiniApp) },
    { id: "requests", section: "acquisitions", label: "Заявки", hint: "Поточне комплектування", icon: "acquisitions", href: acquisitionsBase },
    { id: "planning", section: "acquisitions", label: "Планування фонду", hint: "Потреба на новий рік", icon: "reports", href: telegramMiniApp ? `${acquisitionsBase}&view=planning` : "/librarian/acquisitions/planning" },
    { id: "overview", section: "reports", label: "Огляд", hint: "Готові звіти", icon: "reports", href: `${reportsBase}#overview` },
    { id: "classes", section: "reports", label: "Класи", hint: "Відомості й залишки", icon: "issue-class", href: `${reportsBase}#classes` },
    { id: "fund", section: "reports", label: "Фонд", hint: "Рух та інвентаризація", icon: "fund", href: `${reportsBase}#fund` },
    { id: "activity", section: "reports", label: "Робота бібліотеки", hint: "Заявки й відвідування", icon: "visits", href: `${reportsBase}#activity` },
    { id: "academic-year", section: "management", label: "Новий навчальний рік", hint: "Створити період", icon: "academic-year", href: librarianToolHref("academic-year", telegramMiniApp) },
    { id: "class-create", section: "management", label: "Відкрити клас", hint: "Додати до року", icon: "class-create", href: librarianToolHref("class-create", telegramMiniApp) },
    { id: "class-update", section: "management", label: "Змінити клас", hint: "Керівник і кабінет", icon: "class-update", href: librarianToolHref("class-update", telegramMiniApp) },
    { id: "class-close", section: "management", label: "Закрити клас", hint: "Зберегти історію", icon: "class-close", href: librarianToolHref("class-close", telegramMiniApp) },
    { id: "class-reopen", section: "management", label: "Поновити клас", hint: "Виправити закриття", icon: "class-reopen", href: librarianToolHref("class-reopen", telegramMiniApp) },
    { id: "rollover", section: "management", label: "Перехід на новий рік", hint: "Перевести всі класи", icon: "rollover", href: librarianToolHref("rollover", telegramMiniApp) },
    { id: "locations", section: "management", label: "Кабінети", hint: "Розміщення фонду", icon: "locations", href: librarianToolHref("locations", telegramMiniApp) },
    { id: "contacts", section: "management", label: "Контакти", hint: "Дані для відкритого сайту", icon: "contacts", href: librarianToolHref("contacts", telegramMiniApp) },
  ];
}

function mergeSubsections(
  defaults: LibrarianSubsection[],
  overrides: LibrarianSubsection[],
): LibrarianSubsection[] {
  const merged = new Map(defaults.map((subsection) => [`${subsection.section}:${subsection.id}`, subsection]));
  overrides.forEach((subsection) => merged.set(`${subsection.section}:${subsection.id}`, subsection));
  return [...merged.values()];
}
