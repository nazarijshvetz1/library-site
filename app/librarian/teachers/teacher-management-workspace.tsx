"use client";

/* eslint-disable @next/next/no-img-element */

import { type FormEvent, useCallback, useEffect, useState } from "react";

import { visitApi, VisitApiError } from "@/app/visits/visit-client";
import MaterialRequestInbox from "@/app/librarian/visits/material-request-inbox";
import TeacherAccessAdmin from "@/app/librarian/visits/teacher-access-admin";
import {
  changeTeacherStatus,
  createTeacherProfile,
  deleteEmptyTeacherProfile,
  emptyTeacherCounters,
  loadTeacherDetail,
  loadTeacherDirectory,
  teacherProfileDraft,
  type TeacherDetail,
  type TeacherDirectoryEnvelope,
  type TeacherDirectoryRow,
  type TeacherLocation,
  type TeacherProfileDraft,
  TeacherDuplicateWarning,
  updateTeacherProfile,
} from "./teacher-management-client";
import styles from "./teacher-management.module.css";

const LOGO_URL = "https://nazarijshvetz1.github.io/library-site/library-logo.png";

type MainTab = "overview" | "teachers" | "orders" | "visits";
type DetailTab = "profile" | "orders" | "issued" | "visits";
type DirectoryStatus = "active" | "inactive" | "all";

type TelegramStatus = {
  configured: boolean;
  linkingEnabled: boolean;
  notificationsEnabled: boolean;
  botUsername: string | null;
  connected: boolean;
  status: "active" | "disabled" | "blocked" | null;
  notifyOrders: boolean;
  notifyVisits: boolean;
  version: number | null;
  linkedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastErrorCode: string | null;
};
type LibrarianTelegramEnvelope = { success: true; telegram: TelegramStatus; writesEnabled: boolean };
type TelegramLinkEnvelope = { success: true; linkUrl: string; expiresAt: string; writesEnabled: boolean };

type Props = {
  pendingScope: string;
  displayName: string;
  role: "admin" | "librarian";
  writesEnabled: boolean;
  signOutHref: string;
};

export default function TeacherManagementWorkspace({
  pendingScope,
  displayName,
  role,
  writesEnabled,
  signOutHref,
}: Props) {
  const [tab, setTab] = useState<MainTab>("overview");
  const [directory, setDirectory] = useState<TeacherDirectoryEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [noticeTone, setNoticeTone] = useState<"success" | "error" | "info">("info");

  const loadSummary = useCallback(async () => {
    setLoading(true);
    try {
      setDirectory(await loadTeacherDirectory({ status: "all", limit: 30 }));
    } catch (error) {
      setNotice(errorMessage(error));
      setNoticeTone("error");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleDirectoryNotice = useCallback((message: string, tone: "success" | "error" | "info" = "success") => {
    setNotice(message);
    setNoticeTone(tone);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadSummary(), 0);
    return () => window.clearTimeout(timer);
  }, [loadSummary]);

  const effectiveWrites = writesEnabled && directory?.writesEnabled !== false;

  function openAttention(nextTab: MainTab) {
    setTab(nextTab);
    window.requestAnimationFrame(() => document.getElementById("teacher-management-panel")?.focus());
  }

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <a className={styles.brand} href="/librarian">
          <img src={LOGO_URL} alt="" width="48" height="48" />
          <span><strong>Єдина бібліотека</strong><small>Керування вчителями</small></span>
        </a>
        <nav className={styles.headerNav} aria-label="Розділи кабінету бібліотекаря">
          <a href="/librarian">Каталог</a>
          <a href="/librarian/visits">Розклад</a>
          <a href="/librarian/export">Експорт в Excel</a>
          <a href="/librarian/import">Імпорт з Excel</a>
        </nav>
        <div className={styles.account}>
          <span><strong>{displayName}</strong><small>{role === "admin" ? "Адміністратор" : "Бібліотекар"}</small></span>
          <a href={signOutHref}>Вийти</a>
        </div>
      </header>

      <section className={styles.page}>
        <div className={styles.intro}>
          <div>
            <p className={styles.eyebrow}>Захищений робочий розділ</p>
            <h1>Вчителі та їхні звернення</h1>
            <p>Картки, доступ, замовлення, фактичні видачі й відвідування — в одному місці.</p>
          </div>
          <button className={styles.refreshButton} type="button" onClick={() => void loadSummary()} disabled={loading}>
            {loading ? "Оновлюємо…" : "↻ Оновити"}
          </button>
        </div>

        {!effectiveWrites ? (
          <div className={styles.info} role="status">Зміни тимчасово вимкнені. Перегляд даних залишається доступним.</div>
        ) : null}
        {notice ? <div className={styles[noticeTone]} role={noticeTone === "error" ? "alert" : "status"}>{notice}</div> : null}

        <nav className={styles.tabs} aria-label="Керування вчителями">
          <TabButton active={tab === "overview"} onClick={() => setTab("overview")}>Огляд</TabButton>
          <TabButton active={tab === "teachers"} onClick={() => setTab("teachers")} count={directory?.counters.active}>Вчителі</TabButton>
          <TabButton active={tab === "orders"} onClick={() => setTab("orders")} count={directory?.counters.withOpenRequests}>Замовлення і видачі</TabButton>
          <TabButton active={tab === "visits"} onClick={() => setTab("visits")}>Відвідування</TabButton>
        </nav>

        <div id="teacher-management-panel" className={styles.panel} tabIndex={-1}>
          {tab === "overview" ? (
            <OverviewPanel data={directory} loading={loading} onOpen={openAttention} writesEnabled={effectiveWrites} />
          ) : tab === "teachers" ? (
            <TeacherDirectoryPanel
              initialData={directory}
              writesEnabled={effectiveWrites}
              onDirectoryChange={setDirectory}
              onNotice={handleDirectoryNotice}
            />
          ) : tab === "orders" ? (
            <OrdersPanel pendingScope={pendingScope} writesEnabled={effectiveWrites} />
          ) : (
            <VisitManagementPanel />
          )}
        </div>
      </section>
    </main>
  );
}

function TabButton({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick}>
      {children}{typeof count === "number" && count > 0 ? <span>{count}</span> : null}
    </button>
  );
}

function OverviewPanel({
  data,
  loading,
  onOpen,
  writesEnabled,
}: {
  data: TeacherDirectoryEnvelope | null;
  loading: boolean;
  onOpen: (tab: MainTab) => void;
  writesEnabled: boolean;
}) {
  const summary = data?.counters ?? emptyTeacherCounters();
  const cards = [
    { label: "Активні вчителі", value: summary.active, tab: "teachers" as const, tone: "green" },
    { label: "Закриті картки", value: summary.inactive, tab: "teachers" as const, tone: "neutral" },
    { label: "Є активні замовлення", value: summary.withOpenRequests, tab: "orders" as const, tone: "gold" },
    { label: "Є відкриті видачі", value: summary.withOpenLoans, tab: "orders" as const, tone: "blue" },
  ];
  const attention = [
    { label: "Учителі без коду", value: summary.withoutCode, tab: "teachers" as const },
    { label: "Заблокований доступ", value: summary.locked, tab: "teachers" as const },
    { label: "Прострочені видачі", value: summary.withOverdueLoans, tab: "orders" as const },
    { label: "Активні замовлення", value: summary.withOpenRequests, tab: "orders" as const },
  ];

  return (
    <div className={styles.overviewStack}>
      <div className={styles.overviewGrid}>
        <section className={styles.card} aria-labelledby="overview-title">
        <div className={styles.cardHeading}><div><span>Стан роботи</span><h2 id="overview-title">Огляд</h2></div></div>
        {loading ? <p className={styles.empty}>Збираємо актуальні показники…</p> : (
          <div className={styles.metricGrid}>
            {cards.map((card) => (
              <button type="button" key={card.label} data-tone={card.tone} onClick={() => onOpen(card.tab)}>
                <strong>{card.value}</strong><span>{card.label}</span><small>Переглянути →</small>
              </button>
            ))}
          </div>
        )}
        </section>
        <section className={styles.card} aria-labelledby="attention-title">
        <div className={styles.cardHeading}><div><span>Черга</span><h2 id="attention-title">Потребує уваги</h2></div></div>
        <ul className={styles.attentionList}>
          {attention.map((item) => (
            <li key={item.label} data-empty={item.value === 0}>
              <span><strong>{item.label}</strong><small>{attentionHint(item.label)}</small></span>
              <button type="button" onClick={() => onOpen(item.tab)} aria-label={`${item.label}: ${item.value}. Переглянути`}>
                {item.value}<span aria-hidden="true">→</span>
              </button>
            </li>
          ))}
        </ul>
        </section>
      </div>
      <LibrarianTelegramPanel writesEnabled={writesEnabled} />
    </div>
  );
}

function LibrarianTelegramPanel({ writesEnabled }: { writesEnabled: boolean }) {
  const [telegram, setTelegram] = useState<TelegramStatus | null>(null);
  const [apiWritesEnabled, setApiWritesEnabled] = useState(true);
  const [notifyOrders, setNotifyOrders] = useState(true);
  const [notifyVisits, setNotifyVisits] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"link" | "save" | "test" | "disconnect" | null>(null);
  const [notice, setNotice] = useState("");
  const [noticeTone, setNoticeTone] = useState<"success" | "error" | "info">("info");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await visitApi<LibrarianTelegramEnvelope>("/api/librarian/telegram");
      setTelegram(response.telegram);
      setApiWritesEnabled(response.writesEnabled);
      setNotifyOrders(response.telegram.notifyOrders);
      setNotifyVisits(response.telegram.notifyVisits);
    } catch (error) {
      setNotice(errorMessage(error)); setNoticeTone("error");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function connect() {
    setBusy("link"); setNotice("");
    try {
      const response = await visitApi<TelegramLinkEnvelope>("/api/librarian/telegram/link", { method: "POST" });
      window.location.assign(response.linkUrl);
    } catch (error) {
      setNotice(errorMessage(error)); setNoticeTone("error"); setBusy(null);
    }
  }

  async function savePreferences() {
    if (!telegram?.connected || telegram.version === null) return;
    setBusy("save"); setNotice("");
    try {
      const response = await visitApi<LibrarianTelegramEnvelope>("/api/librarian/telegram", {
        method: "PATCH",
        body: JSON.stringify({ notifyOrders, notifyVisits, expectedVersion: telegram.version }),
      });
      setTelegram(response.telegram); setApiWritesEnabled(response.writesEnabled);
      setNotifyOrders(response.telegram.notifyOrders); setNotifyVisits(response.telegram.notifyVisits);
      setNotice("Налаштування Telegram збережено."); setNoticeTone("success");
    } catch (error) {
      setNotice(errorMessage(error)); setNoticeTone("error");
    } finally { setBusy(null); }
  }

  async function sendTest() {
    setBusy("test"); setNotice("");
    try {
      await visitApi("/api/librarian/telegram/test", { method: "POST" });
      setNotice("Тестове повідомлення надіслано в Telegram."); setNoticeTone("success");
      await load();
    } catch (error) {
      setNotice(errorMessage(error)); setNoticeTone("error");
    } finally { setBusy(null); }
  }

  async function disconnect() {
    if (telegram?.version === null || telegram?.version === undefined) return;
    setBusy("disconnect"); setNotice("");
    try {
      const response = await visitApi<LibrarianTelegramEnvelope>("/api/librarian/telegram/disconnect", {
        method: "POST",
        body: JSON.stringify({ expectedVersion: telegram.version }),
      });
      setTelegram(response.telegram); setApiWritesEnabled(response.writesEnabled);
      setNotice("Telegram від’єднано від кабінету бібліотекаря."); setNoticeTone("success");
    } catch (error) {
      setNotice(errorMessage(error)); setNoticeTone("error");
    } finally { setBusy(null); }
  }

  const canWrite = writesEnabled && apiWritesEnabled;
  const changed = Boolean(telegram?.connected)
    && (notifyOrders !== telegram?.notifyOrders || notifyVisits !== telegram?.notifyVisits);
  const statusLabel = telegram?.connected
    ? "Підключено"
    : telegram?.status === "blocked"
      ? "Бот заблоковано"
      : "Не підключено";

  return (
    <section className={`${styles.card} ${styles.telegramPanel}`} aria-labelledby="librarian-telegram-title">
      <div className={styles.telegramHeading}>
        <div className={styles.telegramMark} aria-hidden="true">➤</div>
        <div><span>Оперативні сповіщення</span><h2 id="librarian-telegram-title">Telegram бібліотекаря</h2><p>Бот дублюватиме нові замовлення та записи до бібліотеки. Дані залишаються і в цьому кабінеті.</p></div>
        <strong data-connected={telegram?.connected || undefined}>{loading ? "Перевіряємо…" : statusLabel}</strong>
      </div>
      {notice ? <div className={styles[noticeTone]} role={noticeTone === "error" ? "alert" : "status"}>{notice}</div> : null}
      {!loading && telegram && (!telegram.configured || !telegram.linkingEnabled) ? <div className={styles.info}>Для запуску треба додати захищений токен бота й увімкнути Telegram у налаштуваннях сайту.</div> : null}
      {!loading && telegram?.connected ? (
        <>
          <div className={styles.telegramPreferenceGrid}>
            <label htmlFor="librarian-telegram-orders"><input id="librarian-telegram-orders" aria-label="Сповіщення про замовлення вчителів" type="checkbox" checked={notifyOrders} onChange={(event) => setNotifyOrders(event.currentTarget.checked)} disabled={!canWrite || Boolean(busy)} /><span><strong>Замовлення вчителів</strong><small>Нова заявка або її скасування вчителем</small></span></label>
            <label htmlFor="librarian-telegram-visits"><input id="librarian-telegram-visits" aria-label="Сповіщення про відвідування" type="checkbox" checked={notifyVisits} onChange={(event) => setNotifyVisits(event.currentTarget.checked)} disabled={!canWrite || Boolean(busy)} /><span><strong>Відвідування</strong><small>Новий, змінений або скасований запис</small></span></label>
          </div>
          {!telegram.notificationsEnabled ? <div className={styles.info}>Бот підключено, але доставку повідомлень ще не ввімкнено в налаштуваннях сайту.</div> : null}
          <div className={styles.telegramActions}>
            <button className={styles.primaryButton} type="button" onClick={() => void savePreferences()} disabled={!canWrite || !changed || Boolean(busy)}>{busy === "save" ? "Зберігаємо…" : "Зберегти"}</button>
            <button type="button" onClick={() => void sendTest()} disabled={!canWrite || Boolean(busy) || !telegram.notificationsEnabled}>{busy === "test" ? "Надсилаємо…" : "Надіслати тест"}</button>
            <button className={styles.telegramDanger} type="button" onClick={() => void disconnect()} disabled={!canWrite || Boolean(busy)}>{busy === "disconnect" ? "Від’єднуємо…" : "Від’єднати"}</button>
          </div>
        </>
      ) : !loading && telegram?.configured && telegram.linkingEnabled ? (
        <button className={styles.primaryButton} type="button" onClick={() => void connect()} disabled={!canWrite || Boolean(busy)}>{busy === "link" ? "Створюємо посилання…" : telegram.status === "blocked" ? "Підключити повторно" : "Підключити Telegram"}</button>
      ) : null}
    </section>
  );
}

function TeacherDirectoryPanel({
  initialData,
  writesEnabled,
  onDirectoryChange,
  onNotice,
}: {
  initialData: TeacherDirectoryEnvelope | null;
  writesEnabled: boolean;
  onDirectoryChange: (data: TeacherDirectoryEnvelope) => void;
  onNotice: (message: string, tone?: "success" | "error" | "info") => void;
}) {
  const [data, setData] = useState<TeacherDirectoryEnvelope | null>(initialData);
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<DirectoryStatus>("active");
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TeacherDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async (cursor: string | null = null) => {
    if (cursor) setLoadingMore(true);
    else setLoading(true);
    try {
      const next = await loadTeacherDirectory({ query, status, cursor, limit: 30 });
      if (cursor) {
        setData((current) => current ? {
          ...next,
          teachers: mergeRows(current.teachers, next.teachers),
        } : next);
      } else {
        setData(next);
        onDirectoryChange(next);
      }
    } catch (error) {
      onNotice(errorMessage(error), "error");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [onDirectoryChange, onNotice, query, status]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function selectTeacher(teacherId: string) {
    setSelectedId(teacherId);
    setDetailLoading(true);
    try {
      const response = await loadTeacherDetail(teacherId);
      setDetail(response);
    } catch (error) {
      onNotice(errorMessage(error), "error");
    } finally {
      setDetailLoading(false);
    }
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuery(queryInput.trim());
  }

  async function mutationSaved(next: TeacherDetail, message: string) {
    setDetail(next);
    onNotice(message);
    await load();
  }

  return (
    <div className={styles.directoryStack}>
      <section className={styles.card} aria-labelledby="directory-title">
        <div className={styles.cardHeading}>
          <div><span>{data?.counters.active ?? 0} активних</span><h2 id="directory-title">Картки вчителів</h2></div>
          <button className={styles.primaryButton} type="button" onClick={() => setCreating((value) => !value)} disabled={!writesEnabled}>
            {creating ? "Закрити форму" : "+ Додати вчителя"}
          </button>
        </div>

        {creating ? (
          <TeacherProfileForm
            mode="create"
            locations={data?.locations ?? []}
            disabled={!writesEnabled}
            onCancel={() => setCreating(false)}
            onSaved={async (next) => {
              setCreating(false);
              setSelectedId(next.teacher.id);
              await mutationSaved(next, `Картку ${next.teacher.fullName} створено.`);
            }}
          />
        ) : null}

        <form className={styles.filters} role="search" onSubmit={search}>
          <label className={styles.searchField}>Пошук
            <span><input type="search" autoComplete="off" maxLength={100} value={queryInput} onChange={(event) => setQueryInput(event.currentTarget.value)} placeholder="Прізвище або ім’я" /><button type="submit">Знайти</button></span>
          </label>
          <label>Стан
            <select value={status} onChange={(event) => setStatus(event.currentTarget.value as DirectoryStatus)}>
              <option value="active">Активні</option><option value="inactive">Закриті</option><option value="all">Усі</option>
            </select>
          </label>
        </form>

        {loading ? <p className={styles.empty}>Оновлюємо картки…</p> : data?.teachers.length ? (
          <div className={styles.directoryLayout}>
            <div className={styles.teacherList} role="list" aria-label="Список учителів">
              {data.teachers.map((teacher) => (
                <button type="button" key={teacher.id} data-selected={selectedId === teacher.id} onClick={() => void selectTeacher(teacher.id)}>
                  <span className={styles.avatar} aria-hidden="true">{teacherInitials(teacher.fullName)}</span>
                  <span className={styles.teacherIdentity}><strong>{teacher.fullName}</strong><small>{[teacher.subjectPosition, teacher.primaryLocation?.name].filter(Boolean).join(" · ") || "Дані ще не заповнено"}</small></span>
                  <span className={styles.badges}><StatusBadge teacher={teacher} />{teacher.attention.overdueLoans ? <em>{teacher.attention.overdueLoans} простроч.</em> : null}{teacher.attention.openRequests ? <em>{teacher.attention.openRequests} заяв.</em> : null}</span>
                </button>
              ))}
              {data.page.hasMore && data.page.nextCursor ? <button className={styles.loadMore} type="button" onClick={() => void load(data.page.nextCursor)} disabled={loadingMore}>{loadingMore ? "Завантажуємо…" : "Показати ще"}</button> : null}
            </div>
            <aside className={styles.detailRegion} aria-label="Картка вибраного вчителя">
              {detailLoading ? <p className={styles.empty}>Відкриваємо картку…</p> : detail ? (
                <TeacherDetailCard detail={detail} locations={data.locations} writesEnabled={writesEnabled} onSaved={mutationSaved} onDeleted={async () => { setDetail(null); setSelectedId(null); onNotice("Порожню помилкову картку видалено."); await load(); }} />
              ) : <div className={styles.detailPlaceholder}><span aria-hidden="true">👤</span><h3>Виберіть учителя</h3><p>Тут з’являться профіль, замовлення, фактичні видачі та відвідування.</p></div>}
            </aside>
          </div>
        ) : <p className={styles.empty}>За цими фільтрами карток не знайдено.</p>}
      </section>

      <TeacherAccessAdmin writesEnabled={writesEnabled} />
    </div>
  );
}

function TeacherDetailCard({
  detail,
  locations,
  writesEnabled,
  onSaved,
  onDeleted,
}: {
  detail: TeacherDetail;
  locations: TeacherLocation[];
  writesEnabled: boolean;
  onSaved: (detail: TeacherDetail, message: string) => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const [tab, setTab] = useState<DetailTab>("profile");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const teacher = detail.teacher;
  const closeBlockers = teacher.status === "active" ? teacherCloseBlockers(detail) : [];
  const deletionAllowed = detail.dependencySummary.totalDependencies === 0;
  const deletionBlockers = teacherDeletionBlockers(detail);

  async function changeStatus() {
    const action = teacher.status === "active" ? "close" : "restore";
    if (action === "close") {
      if (closeBlockers.length) return;
      const warning = `Закрити картку ${teacher.fullName}? Доступ буде вимкнено, а відкриті сеанси завершено. Історія та ${teacher.attention.openLoans} відкритих видач залишаться в обліку.`;
      if (!window.confirm(warning)) return;
    }
    const reason = window.prompt(action === "close" ? "Причина закриття картки (необов’язково):" : "Примітка до поновлення картки (необов’язково):", "");
    if (reason === null) return;
    setBusy(true);
    setActionError("");
    try {
      await changeTeacherStatus(teacher.id, teacher.version, action, reason);
      const refreshed = await loadTeacherDetail(teacher.id);
      await onSaved(refreshed, action === "close" ? "Картку закрито без втрати історії." : "Картку поновлено. Доступ за кодом потрібно увімкнути окремо.");
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!deletionAllowed) return;
    const confirmation = window.prompt(`Безповоротно видаляється лише порожня помилкова картка. Для підтвердження введіть повне ПІБ:\n${teacher.fullName}`)?.trim();
    if (confirmation !== teacher.fullName) return;
    setBusy(true);
    setActionError("");
    try {
      await deleteEmptyTeacherProfile(teacher.id, teacher.version);
      await onDeleted();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={styles.detailCard}>
      <header>
        <span className={styles.largeAvatar} aria-hidden="true">{teacherInitials(teacher.fullName)}</span>
        <div><p>{teacher.status === "active" ? "Активна картка" : "Картка закрита"}</p><h3>{teacher.fullName}</h3><small>{teacher.subjectPosition || "Посаду або предмет не вказано"}</small></div>
      </header>
      <nav className={styles.detailTabs} aria-label="Дані вчителя">
        {(["profile", "orders", "issued", "visits"] as const).map((item) => <button key={item} type="button" aria-pressed={tab === item} onClick={() => setTab(item)}>{detailTabLabel(item)}<span>{detailTabCount(item, detail)}</span></button>)}
      </nav>
      {actionError ? <div className={styles.error} role="alert">{actionError}</div> : null}
      {tab === "profile" ? editing ? (
        <TeacherProfileForm mode="edit" teacher={teacher} locations={locations} disabled={!writesEnabled || busy} onCancel={() => setEditing(false)} onSaved={async (next) => { setEditing(false); await onSaved(next, "Інформацію про вчителя оновлено."); }} />
      ) : (
        <div className={styles.profilePane}>
          <dl><div><dt>Предмет / посада</dt><dd>{teacher.subjectPosition || "—"}</dd></div><div><dt>Основний кабінет</dt><dd>{teacher.primaryLocation?.name || "—"}</dd></div><div><dt>Службовий контакт</dt><dd>{teacher.serviceContact || "—"}</dd></div><div><dt>Внутрішня примітка</dt><dd>{teacher.librarianNote || "—"}</dd></div></dl>
          <div className={styles.profileActions}><button type="button" onClick={() => setEditing(true)} disabled={!writesEnabled || busy}>Редагувати</button><a href="#teacher-access-title" title={`У блоці кодів нижче знайдіть ${teacher.fullName}`}>Код і доступ</a><button type="button" onClick={() => void changeStatus()} disabled={!writesEnabled || busy || (teacher.status === "active" && closeBlockers.length > 0)}>{teacher.status === "active" ? "Закрити картку" : "Поновити картку"}</button><button className={styles.dangerButton} type="button" onClick={() => void remove()} disabled={!writesEnabled || busy || !deletionAllowed} title={deletionAllowed ? "Безповоротно видалити порожню помилкову картку" : "Картка має пов’язані дані, тому її можна лише закрити"}>Видалити картку</button></div>
          <p className={styles.accessHint}>Для керування кодом перейдіть до блоку нижче та знайдіть ПІБ: <strong>{teacher.fullName}</strong>.</p>
          {closeBlockers.length ? <p className={styles.closeGuard}>Щоб закрити картку, спочатку: {closeBlockers.join("; ")}.</p> : null}
          {!deletionAllowed && deletionBlockers.length ? <p className={styles.deleteGuard}>Картку не можна видалити: {deletionBlockers.join(", ")}. Її можна лише закрити.</p> : null}
        </div>
      ) : tab === "orders" ? <CompactRecords kind="orders" detail={detail} /> : tab === "issued" ? <CompactRecords kind="issued" detail={detail} /> : <CompactRecords kind="visits" detail={detail} />}
    </article>
  );
}

function TeacherProfileForm({
  mode,
  teacher,
  locations,
  disabled,
  onCancel,
  onSaved,
}: {
  mode: "create" | "edit";
  teacher?: TeacherDirectoryRow;
  locations: TeacherLocation[];
  disabled: boolean;
  onCancel: () => void;
  onSaved: (detail: TeacherDetail) => Promise<void>;
}) {
  const [draft, setDraft] = useState<TeacherProfileDraft>(() => teacherProfileDraft(teacher));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  function change<K extends keyof TeacherProfileDraft>(key: K, value: TeacherProfileDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft.fullName.trim().length < 3) { setError("Вкажіть повне прізвище та ім’я."); return; }
    setSubmitting(true);
    setError("");
    try {
      let response;
      try {
        response = mode === "create"
          ? await createTeacherProfile(draft)
          : await updateTeacherProfile(teacher!.id, teacher!.version, draft);
      } catch (reason) {
        if (!(reason instanceof TeacherDuplicateWarning)) throw reason;
        const candidates = reason.candidates.map((candidate) => `${candidate.fullName} (${candidate.status === "active" ? "активна" : "закрита"})`).join("\n");
        const confirmed = window.confirm(`Знайдено схожу картку:\n${candidates || "ПІБ повністю збігається з наявною карткою."}\n\nУсе одно створити або зберегти окрему картку?`);
        if (!confirmed) return;
        response = mode === "create"
          ? await createTeacherProfile(draft, true)
          : await updateTeacherProfile(teacher!.id, teacher!.version, draft, true);
      }
      const refreshed = await loadTeacherDetail(response.teacher.id);
      await onSaved(refreshed);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className={styles.profileForm} onSubmit={submit}>
      <div className={styles.formHeading}><div><span>{mode === "create" ? "Нова картка" : "Профіль"}</span><h3>{mode === "create" ? "Додати вчителя" : "Редагувати інформацію"}</h3></div><button type="button" onClick={onCancel}>×</button></div>
      <p className={styles.formHint}>Показуються лише службові дані, які бібліотекар вводить свідомо. Особиста пошта автоматично не підтягується.</p>
      {error ? <div className={styles.error} role="alert">{error}</div> : null}
      <div className={styles.formGrid}>
        <label className={styles.fullField}>Прізвище та ім’я *<input required minLength={3} maxLength={120} autoComplete="off" value={draft.fullName} onChange={(event) => change("fullName", event.currentTarget.value)} /></label>
        <label>Предмет / посада<input maxLength={160} value={draft.subjectPosition} onChange={(event) => change("subjectPosition", event.currentTarget.value)} placeholder="Наприклад, учитель історії" /></label>
        <label>Основний кабінет<select value={draft.primaryLocationId} onChange={(event) => change("primaryLocationId", event.currentTarget.value)}><option value="">Не вказано</option>{locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label>
        <label className={styles.fullField}>Службовий контакт<input maxLength={200} value={draft.serviceContact} onChange={(event) => change("serviceContact", event.currentTarget.value)} placeholder="Службовий телефон, email або внутрішній номер" /></label>
        <label className={styles.fullField}>Внутрішня примітка<textarea maxLength={4000} value={draft.librarianNote} onChange={(event) => change("librarianNote", event.currentTarget.value)} /></label>
      </div>
      <div className={styles.formActions}><button type="button" onClick={onCancel}>Скасувати</button><button className={styles.primaryButton} type="submit" disabled={disabled || submitting}>{submitting ? "Зберігаємо…" : mode === "create" ? "Створити картку" : "Зберегти зміни"}</button></div>
    </form>
  );
}

function CompactRecords({ kind, detail }: { kind: "orders" | "issued" | "visits"; detail: TeacherDetail }) {
  const records = kind === "orders" ? detail.requests : kind === "issued" ? detail.loans : detail.futureVisits;
  if (!records.length) return <p className={styles.empty}>У цьому розділі записів немає.</p>;
  return <div className={styles.recordList}>{records.map((record) => {
    if (kind === "orders") {
      const order = record as TeacherDetail["requests"][number];
      return <article key={order.id}><span><strong>Замовлення від {formatDate(order.submitted_at)}</strong><small>{order.items.length ? order.items.map((item) => `${item.title_snapshot}${item.author_snapshot ? ` — ${item.author_snapshot}` : ""}: ${item.requested_quantity} замовлено, ${item.reserved_quantity} у резерві, ${item.fulfilled_quantity} видано`).join("; ") : `${Number(order.requested_quantity)} примірників`}</small></span><StatusPill value={order.status} /></article>;
    }
    if (kind === "issued") {
      const issued = record as TeacherDetail["loans"][number];
      return <article key={issued.id}><span><strong>Видано {formatDate(issued.issued_at)}</strong><small>{issued.items.length ? `${issued.items.map((item) => `${item.title}${item.author ? ` — ${item.author}` : ""}: ${item.outstanding_quantity} не повернуто`).join("; ")}${issued.due_at ? ` · повернути до ${formatDate(issued.due_at)}` : ""}` : `${Number(issued.outstanding_quantity)} не повернуто${issued.due_at ? ` · повернути до ${formatDate(issued.due_at)}` : ""}`}</small></span><StatusPill value={issued.status} /></article>;
    }
    const visit = record as TeacherDetail["futureVisits"][number];
    return <article key={visit.id}><span><strong>{formatDate(visit.visit_date)} · {visit.start_time}–{visit.end_time}</strong><small>{[visit.class_label, visit.purpose].filter(Boolean).join(" · ") || "Без додаткових відомостей"}</small></span><StatusPill value={visit.status} /></article>;
  })}</div>;
}

function OrdersPanel({ pendingScope, writesEnabled }: { pendingScope: string; writesEnabled: boolean }) {
  return (
    <div className={styles.ordersStack}>
      <section className={styles.flowNote} aria-labelledby="order-flow-title"><div><span aria-hidden="true">1</span><strong>Прийняти заявку</strong><small>Перевірити кількість і наявність</small></div><div><span aria-hidden="true">2</span><strong>Підготувати резерв</strong><small>Примірники чекають на вчителя</small></div><div><span aria-hidden="true">3</span><strong>Фактично видати</strong><small>Лише тоді створюється позика</small></div></section>
      <MaterialRequestInbox pendingScope={pendingScope} writesEnabled={writesEnabled} />
      <p className={styles.sectionFootnote}>Якщо підготовлене замовлення не забрали, його можна буде звільнити без створення позики та повернути примірники до доступного фонду.</p>
    </div>
  );
}

function VisitManagementPanel() {
  const [date, setDate] = useState(() => todayInKyiv());
  const [status, setStatus] = useState("active");
  const [data, setData] = useState<VisitListEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ from: date, to: date, status: status || "all", limit: "100" });
      setData(await visitApi<VisitListEnvelope>(`/api/librarian/visits?${params.toString()}`));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [date, status]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <section className={styles.card} aria-labelledby="visits-title">
      <div className={styles.cardHeading}><div><span>{data?.bookings.length ?? 0} записів</span><h2 id="visits-title">Відвідування бібліотеки</h2></div><a className={styles.secondaryLink} href="/librarian/visits">Повне керування розкладом →</a></div>
      <div className={styles.filters}><label>Дата<input type="date" value={date} onChange={(event) => setDate(event.currentTarget.value)} /></label><label>Стан<select value={status} onChange={(event) => setStatus(event.currentTarget.value)}><option value="active">Активні</option><option value="cancelled">Скасовані</option><option value="">Усі</option></select></label></div>
      {error ? <div className={styles.error} role="alert">{error}</div> : loading ? <p className={styles.empty}>Оновлюємо розклад…</p> : data?.bookings.length ? <div className={styles.visitList}>{data.bookings.map((booking) => <article key={booking.id}><time>{booking.startTime}–{booking.endTime}</time><span><strong>{booking.surname}</strong><small>{[booking.classLabel, booking.purpose].filter(Boolean).join(" · ") || "Без додаткових відомостей"}</small></span><StatusPill value={booking.status} /></article>)}</div> : <p className={styles.empty}>На цю дату записів немає.</p>}
    </section>
  );
}

type VisitListEnvelope = {
  success: true;
  bookings: Array<{ id: string; surname: string; classLabel: string; purpose: string; startTime: string; endTime: string; status: string }>;
};

function StatusBadge({ teacher }: { teacher: TeacherDirectoryRow }) {
  if (teacher.status === "inactive") return <span className={styles.closedBadge}>Закрита</span>;
  if (!teacher.access.hasCode) return <span className={styles.missingBadge}>Без коду</span>;
  if (teacher.access.status === "locked") return <span className={styles.warningBadge}>Заблоковано</span>;
  if (teacher.access.status === "disabled") return <span className={styles.closedBadge}>Доступ вимкнено</span>;
  return <span className={styles.activeBadge}>Активна</span>;
}

function StatusPill({ value }: { value: string }) {
  return <span className={styles.statusPill} data-status={value}>{statusLabel(value)}</span>;
}

function mergeRows(current: TeacherDirectoryRow[], next: TeacherDirectoryRow[]) {
  const rows = new Map(current.map((teacher) => [teacher.id, teacher]));
  for (const teacher of next) rows.set(teacher.id, teacher);
  return Array.from(rows.values());
}

function teacherInitials(fullName: string) {
  return fullName.trim().split(/\s+/u).slice(0, 2).map((part) => part[0]?.toLocaleUpperCase("uk-UA") ?? "").join("") || "В";
}

function detailTabLabel(tab: DetailTab) {
  return ({ profile: "Профіль", orders: "Замовлення", issued: "Видано", visits: "Відвідування" } as const)[tab];
}

function detailTabCount(tab: DetailTab, detail: TeacherDetail) {
  if (tab === "orders") return detail.requests.length;
  if (tab === "issued") return detail.loans.length;
  if (tab === "visits") return detail.futureVisits.length;
  return null;
}

function teacherCloseBlockers(detail: TeacherDetail): string[] {
  const dependencies = detail.dependencySummary;
  return [
    dependencies.activeRequests ? `опрацювати ${dependencies.activeRequests} активних замовлень` : "",
    dependencies.futureActiveVisits ? `скасувати або передати ${dependencies.futureActiveVisits} майбутніх відвідувань` : "",
    dependencies.activeClassAssignments ? `закрити або передати ${dependencies.activeClassAssignments} активних призначень класів` : "",
  ].filter(Boolean);
}

function teacherDeletionBlockers(detail: TeacherDetail): string[] {
  const labels: Record<string, string> = {
    credentials: "виданий код",
    sessions: "сеанси входу",
    visits: "відвідування",
    requests: "замовлення",
    loans: "видачі",
    classAssignments: "призначення класів",
    classResponsibilities: "класні видачі",
    notifications: "сповіщення",
  };
  return Object.entries(detail.dependencySummary)
    .filter(([key, value]) => key !== "totalDependencies" && !key.startsWith("active") && !key.startsWith("future") && !key.startsWith("open") && Number(value) > 0)
    .map(([key, value]) => `${labels[key] ?? key}: ${value}`);
}

function statusLabel(value: string) {
  return ({ submitted: "Нове", in_review: "Опрацьовується", reserved: "Підготовлено", ready: "Готове", partially_ready: "Частково", completed: "Виконано", rejected: "Відхилено", cancelled: "Скасовано", active: "Активне", open: "Відкрита", closed: "Закрита" } as Record<string, string>)[value] ?? value;
}

function attentionHint(label: string) {
  if (label === "Учителі без коду") return "Доступ до кабінету ще не видано";
  if (label === "Заблокований доступ") return "Перевірити невдалі спроби входу";
  if (label === "Прострочені видачі") return "Потрібно нагадати про повернення";
  return "Потрібно опрацювати або підготувати";
}

function formatDate(value: string) {
  const date = new Date(value.length === 10 ? `${value}T12:00:00+03:00` : value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("uk-UA", { dateStyle: "medium", timeZone: "Europe/Kyiv" }).format(date);
}

function todayInKyiv() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function errorMessage(error: unknown) {
  return error instanceof VisitApiError ? error.message : "Не вдалося виконати запит. Спробуйте ще раз.";
}
