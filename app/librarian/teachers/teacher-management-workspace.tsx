"use client";

/* eslint-disable @next/next/no-img-element */

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import LibrarianShell from "../_components/librarian-shell";
import { visitApi } from "@/app/visits/visit-client";
import MaterialRequestInbox from "@/app/librarian/visits/material-request-inbox";
import TeacherAccessAdmin from "@/app/librarian/visits/teacher-access-admin";
import SiteIcon from "@/app/_components/site-icon";
import CollapsibleListSection from "@/app/_components/collapsible-list-section";
import TeacherCodeImport from "./teacher-code-import";
import {
  changeTeacherStatus,
  createTeacherProfile,
  deleteTeacherProfile,
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

type MainTab = "overview" | "teachers" | "orders" | "visits" | "telegram";
type DetailTab = "profile" | "access" | "orders" | "issued" | "visits";
type DirectoryStatus = "active" | "inactive" | "all";
type DirectoryTelegram = "all" | "connected" | "disconnected" | "muted" | "blocked";

const TAB_COPY: Record<MainTab, { eyebrow: string; title: string; description: string }> = {
  overview: {
    eyebrow: "Захищений робочий розділ",
    title: "Вчителі та їхні звернення",
    description: "Картки, доступ, замовлення, фактичні видачі й відвідування — в одному місці.",
  },
  teachers: {
    eyebrow: "Довідник і доступ",
    title: "Картки вчителів",
    description: "Профілі, службові відомості, фото, коди доступу та історія роботи кожного вчителя.",
  },
  orders: {
    eyebrow: "Заявки та видача",
    title: "Замовлення вчителів",
    description: "Перевіряйте заявки, готуйте резерв і фіксуйте фактичну видачу матеріалів.",
  },
  visits: {
    eyebrow: "Розклад бібліотеки",
    title: "Відвідування вчителів",
    description: "Переглядайте майбутні записи й керуйте зайнятими проміжками бібліотеки.",
  },
  telegram: {
    eyebrow: "Оперативні сповіщення",
    title: "Telegram бібліотекаря",
    description: "Окремо підключіть особистий чат із ботом і налаштуйте сповіщення.",
  },
};

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
type TelegramTeacherMenuRollout = {
  currentVersion: number;
  connectedTeachers: number;
  currentTeachers: number;
  mutedPendingTeachers: number;
  recipients: number;
  queued: number;
  retrying: number;
  sent: number;
  failed: number;
  lastUpdatedAt: string | null;
};
type TelegramTeacherMenuEnvelope = {
  success: true;
  rollout: TelegramTeacherMenuRollout;
  queuedNow?: number;
  writesEnabled: boolean;
};
type TeacherCuratorRequest = {
  id: string;
  teacher: { id: string; fullName: string };
  currentClass: { id: string; className: string; academicYearLabel: string } | null;
  requestedClass: { id: string; className: string; academicYearLabel: string };
  status: "submitted" | "approved" | "rejected" | "cancelled";
  teacherNote: string;
  version: number;
  createdAt: string;
};
type TeacherCuratorRequestsEnvelope = {
  schemaVersion: 1;
  success: true;
  requests: TeacherCuratorRequest[];
  writesEnabled: boolean;
};

type Props = {
  pendingScope: string;
  displayName: string;
  role: "admin" | "librarian";
  writesEnabled: boolean;
  signOutHref: string;
  telegramMiniApp?: boolean;
  initialTab?: MainTab;
};

export default function TeacherManagementWorkspace({
  pendingScope,
  displayName,
  role,
  writesEnabled,
  signOutHref,
  telegramMiniApp = false,
  initialTab = "overview",
}: Props) {
  const [tab, setTab] = useState<MainTab>(initialTab);
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
  const pageCopy = TAB_COPY[tab];

  function openAttention(nextTab: MainTab) {
    setTab(nextTab);
    window.requestAnimationFrame(() => document.getElementById("teacher-management-panel")?.focus());
  }

  return (
    <LibrarianShell
      activeSection={tab === "orders" ? "orders" : "teachers"}
      displayName={displayName}
      roleLabel={role === "admin" ? "Адміністратор" : "Бібліотекар"}
      signOutHref={signOutHref}
      telegramMiniApp={telegramMiniApp}
      writesEnabled={effectiveWrites}
    >
      <main className={styles.shell}>
        <section className={styles.page}>
        <div className={styles.intro}>
          <div>
            <p className={styles.eyebrow}>{pageCopy.eyebrow}</p>
            <h1>{pageCopy.title}</h1>
            <p>{pageCopy.description}</p>
          </div>
          <button className={styles.refreshButton} type="button" onClick={() => void loadSummary()} disabled={loading}>
            <SiteIcon name={loading ? "loading" : "refresh"} size={18} /> {loading ? "Оновлюємо…" : "Оновити"}
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
          <TabButton active={tab === "telegram"} onClick={() => setTab("telegram")} telegram>Telegram</TabButton>
        </nav>

        <div id="teacher-management-panel" className={styles.panel} tabIndex={-1}>
          {tab === "overview" ? (
            <OverviewPanel data={directory} loading={loading} onOpen={openAttention} />
          ) : tab === "teachers" ? (
            <TeacherDirectoryPanel
              initialData={directory}
              writesEnabled={effectiveWrites}
              onDirectoryChange={setDirectory}
              onNotice={handleDirectoryNotice}
            />
          ) : tab === "orders" ? (
            <OrdersPanel pendingScope={pendingScope} writesEnabled={effectiveWrites} />
          ) : tab === "visits" ? (
            <VisitManagementPanel telegramMiniApp={telegramMiniApp} />
          ) : (
            <LibrarianTelegramPanel writesEnabled={effectiveWrites} />
          )}
        </div>
        </section>
      </main>
    </LibrarianShell>
  );
}

function TabButton({
  active,
  onClick,
  count,
  telegram = false,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count?: number;
  telegram?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button type="button" aria-pressed={active} data-telegram={telegram || undefined} onClick={onClick}>
      {children}{typeof count === "number" && count > 0 ? <span>{count}</span> : null}
    </button>
  );
}

function OverviewPanel({
  data,
  loading,
  onOpen,
}: {
  data: TeacherDirectoryEnvelope | null;
  loading: boolean;
  onOpen: (tab: MainTab) => void;
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
    { label: "Telegram не підключено", value: summary.telegramNotConnected, tab: "teachers" as const },
    { label: "Сповіщення Telegram вимкнено", value: summary.telegramNotificationsOff, tab: "teachers" as const },
    { label: "Бот Telegram заблоковано", value: summary.telegramBlocked, tab: "teachers" as const },
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
                <strong>{card.value}</strong><span>{card.label}</span><small>Переглянути <SiteIcon name="next" size={15} /></small>
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
                {item.value}<span aria-hidden="true"><SiteIcon name="next" size={17} /></span>
              </button>
            </li>
          ))}
        </ul>
        </section>
      </div>
    </div>
  );
}

function LibrarianTelegramPanel({ writesEnabled }: { writesEnabled: boolean }) {
  const [telegram, setTelegram] = useState<TelegramStatus | null>(null);
  const [teacherMenus, setTeacherMenus] = useState<TelegramTeacherMenuRollout | null>(null);
  const [apiWritesEnabled, setApiWritesEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"link" | "toggle" | "test" | "disconnect" | "menus" | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [showMenuConfirmation, setShowMenuConfirmation] = useState(false);
  const [confirmMenus, setConfirmMenus] = useState(false);
  const [notice, setNotice] = useState("");
  const [noticeTone, setNoticeTone] = useState<"success" | "error" | "info">("info");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [response, menus] = await Promise.all([
        visitApi<LibrarianTelegramEnvelope>("/api/librarian/telegram"),
        visitApi<TelegramTeacherMenuEnvelope>("/api/librarian/telegram/teacher-menus"),
      ]);
      setTelegram(response.telegram);
      setTeacherMenus(menus.rollout);
      setApiWritesEnabled(response.writesEnabled && menus.writesEnabled);
      setConfirmDisconnect(false);
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

  async function toggleNotifications() {
    if (!telegram?.connected || telegram.version === null) return;
    const nextEnabled = !(telegram.notifyOrders || telegram.notifyVisits);
    setBusy("toggle"); setNotice("");
    try {
      const response = await visitApi<LibrarianTelegramEnvelope>("/api/librarian/telegram", {
        method: "PATCH",
        body: JSON.stringify({
          notifyOrders: nextEnabled,
          notifyVisits: nextEnabled,
          expectedVersion: telegram.version,
        }),
      });
      setTelegram(response.telegram); setApiWritesEnabled(response.writesEnabled);
      setNotice(nextEnabled ? "Telegram-сповіщення увімкнено." : "Telegram-сповіщення вимкнено.");
      setNoticeTone("success");
    } catch (error) {
      setNotice(errorMessage(error)); setNoticeTone("error");
    } finally { setBusy(null); }
  }

  async function sendTest() {
    setBusy("test"); setNotice("");
    try {
      await visitApi("/api/librarian/telegram/test", { method: "POST" });
      setNotice("Тестове повідомлення надіслано. Вебхук і меню Telegram оновлено."); setNoticeTone("success");
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
        body: JSON.stringify({
          expectedVersion: telegram.version,
          confirmation: "disconnect_telegram",
        }),
      });
      setTelegram(response.telegram); setApiWritesEnabled(response.writesEnabled);
      setConfirmDisconnect(false);
      setNotice("Telegram від’єднано від кабінету бібліотекаря."); setNoticeTone("success");
    } catch (error) {
      setNotice(errorMessage(error)); setNoticeTone("error");
    } finally { setBusy(null); }
  }

  async function refreshTeacherMenus() {
    if (!teacherMenus) return;
    setBusy("menus"); setNotice("");
    try {
      const response = await visitApi<TelegramTeacherMenuEnvelope>(
        "/api/librarian/telegram/teacher-menus",
        {
          method: "POST",
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            confirmation: "refresh_teacher_menus",
            expectedMenuVersion: teacherMenus.currentVersion,
            expectedRecipientCount: teacherMenus.recipients,
          }),
        },
      );
      setTeacherMenus(response.rollout);
      setApiWritesEnabled(response.writesEnabled);
      setShowMenuConfirmation(false);
      setConfirmMenus(false);
      setNotice(response.queuedNow
        ? `Актуальне меню передано в чергу для ${response.queuedNow} вчителів.`
        : "Усі доступні меню вже актуальні або перебувають у черзі.");
      setNoticeTone("success");
      window.setTimeout(() => void load(), 1200);
    } catch (error) {
      setNotice(errorMessage(error)); setNoticeTone("error");
    } finally { setBusy(null); }
  }

  const canWrite = writesEnabled && apiWritesEnabled;
  const notificationsOn = Boolean(telegram?.notifyOrders || telegram?.notifyVisits);
  const statusLabel = telegram?.connected
    ? "Підключено"
    : telegram?.status === "blocked"
      ? "Бот заблоковано"
      : "Не підключено";

  return (
    <div className={styles.telegramSettingsStack}>
      {notice ? <div className={`${styles[noticeTone]} ${styles.telegramGlobalNotice}`} role={noticeTone === "error" ? "alert" : "status"}>{notice}</div> : null}
      <section className={`${styles.card} ${styles.telegramPanel} ${styles.telegramConnectionCard}`} aria-labelledby="librarian-telegram-connection-title">
        <div className={styles.telegramHeading}>
          <div className={styles.telegramMark} aria-hidden="true"><SiteIcon name="telegram" size={24} /></div>
          <div><span>Особистий чат із ботом</span><h2 id="librarian-telegram-connection-title">{telegram?.connected ? "Telegram підключено" : "Підключити Telegram"}</h2><p>Підключення відкриває режим бібліотекаря в боті та створює приватний канал для оперативної роботи.</p></div>
          <strong role="status" aria-live="polite" data-connected={telegram?.connected || undefined}>{loading ? "Перевіряємо…" : statusLabel}</strong>
        </div>
        {!loading && telegram && (!telegram.configured || !telegram.linkingEnabled) ? <div className={styles.info}>Для запуску треба додати захищений токен бота й увімкнути Telegram у налаштуваннях сайту.</div> : null}
        {!loading && telegram?.connected ? (
          <>
            <div className={styles.telegramActions}>
              <button className={styles.telegramDanger} type="button" onClick={() => setConfirmDisconnect(true)} disabled={!canWrite || Boolean(busy)}>Від’єднати Telegram</button>
            </div>
            {confirmDisconnect ? <div className={styles.info} role="alert"><p>Повне від’єднання вимкне автовхід і режим бібліотекаря в боті. Для тиші достатньо вимкнути сповіщення в окремому блоці нижче.</p><div className={styles.telegramActions}><button className={styles.telegramDanger} type="button" onClick={() => void disconnect()} disabled={!canWrite || Boolean(busy)}>{busy === "disconnect" ? "Від’єднуємо…" : "Так, від’єднати"}</button><button type="button" onClick={() => setConfirmDisconnect(false)} disabled={Boolean(busy)}>Скасувати</button></div></div> : null}
          </>
        ) : !loading && telegram?.configured && telegram.linkingEnabled ? (
          <div className={styles.telegramActions}>
            <button className={styles.primaryButton} type="button" onClick={() => void connect()} disabled={!canWrite || Boolean(busy)}>{busy === "link" ? "Створюємо посилання…" : telegram.status === "blocked" ? "Підключити повторно" : "Підключити Telegram"}</button>
          </div>
        ) : null}
      </section>

      <section className={`${styles.card} ${styles.telegramPanel}`} aria-labelledby="librarian-telegram-notifications-title">
        <div className={styles.telegramHeading}>
          <div className={styles.telegramMark} aria-hidden="true"><SiteIcon name="notifications" size={24} /></div>
          <div><span>Після підключення</span><h2 id="librarian-telegram-notifications-title">Сповіщення Telegram</h2><p>Окремо керуйте дублюванням нових замовлень і записів. Дані завжди залишаються в кабінеті бібліотекаря.</p></div>
          <strong data-connected={telegram?.connected && notificationsOn || undefined}>{loading ? "Перевіряємо…" : telegram?.connected ? notificationsOn ? "Увімкнено" : "Вимкнено" : "Спочатку підключіть"}</strong>
        </div>
        {!loading && !telegram?.connected ? <div className={styles.info}>Спочатку скористайтеся кнопкою «Підключити Telegram» у блоці вище.</div> : null}
        {!loading && telegram?.connected ? (
          <>
            <div className={styles.info}>Сповіщення про замовлення та відвідування: <strong><SiteIcon name={notificationsOn ? "notifications" : "bell-off"} size={16} /> {notificationsOn ? "увімкнено" : "вимкнено"}</strong>. Бот і режим бібліотекаря залишаються підключеними.</div>
            {!telegram.notificationsEnabled ? <div className={styles.info}>Бот підключено, але доставку повідомлень ще не ввімкнено в налаштуваннях сайту.</div> : null}
            <div className={styles.telegramActions}>
              <button className={styles.primaryButton} type="button" onClick={() => void toggleNotifications()} disabled={!canWrite || Boolean(busy)}><SiteIcon name={notificationsOn ? "bell-off" : "notifications"} size={18} /> {busy === "toggle" ? "Змінюємо…" : notificationsOn ? "Вимкнути сповіщення" : "Увімкнути сповіщення"}</button>
              <button type="button" onClick={() => void sendTest()} disabled={!canWrite || Boolean(busy) || !telegram.notificationsEnabled || !notificationsOn}>{busy === "test" ? "Надсилаємо…" : "Надіслати тест"}</button>
            </div>
          </>
        ) : null}
      </section>

      <section className={`${styles.card} ${styles.telegramPanel} ${styles.telegramTeacherMenuCard}`} aria-labelledby="librarian-telegram-teacher-menu-title">
        <div className={styles.telegramHeading}>
          <div className={styles.telegramMark} aria-hidden="true"><SiteIcon name="refresh" size={24} /></div>
          <div><span>Меню вчителів</span><h2 id="librarian-telegram-teacher-menu-title">Оновити меню в Telegram</h2><p>Нові кнопки з’являються автоматично під час наступної взаємодії вчителя з ботом. Для важливого оновлення можна заздалегідь надіслати актуальне меню всім доступним одержувачам.</p></div>
          <strong data-connected={teacherMenus?.recipients === 0 || undefined}>{loading ? "Перевіряємо…" : teacherMenus?.recipients ? `${teacherMenus.recipients} очікує` : "Актуально"}</strong>
        </div>
        {teacherMenus ? (
          <>
            <div className={styles.telegramMenuStats} aria-live="polite">
              <div><strong>{teacherMenus.connectedTeachers}</strong><span>підключено</span></div>
              <div><strong>{teacherMenus.currentTeachers}</strong><span>мають актуальне меню</span></div>
              <div><strong>{teacherMenus.recipients}</strong><span>можна оновити зараз</span></div>
              <div><strong>{teacherMenus.queued + teacherMenus.retrying}</strong><span>у доставці</span></div>
            </div>
            {teacherMenus.mutedPendingTeachers ? <div className={styles.info}>{teacherMenus.mutedPendingTeachers} вчителів вимкнули сповіщення. Масове повідомлення їм не надсилається; меню оновиться автоматично, коли вони самі скористаються ботом.</div> : null}
            {teacherMenus.failed ? <div className={styles.info}>Не доставлено: {teacherMenus.failed}. Заблоковані або недоступні чати не впливають на інших учителів.</div> : null}
            {showMenuConfirmation && teacherMenus.recipients > 0 ? (
              <div className={styles.telegramMenuConfirmation} role="group" aria-label="Підтвердження оновлення меню">
                <p>Бот без звуку надішле актуальні кнопки {teacherMenus.recipients} вчителям. PIN-коди, замовлення та налаштування сповіщень не зміняться.</p>
                <label><input type="checkbox" checked={confirmMenus} onChange={(event) => setConfirmMenus(event.target.checked)} /> Підтверджую надсилання актуального меню</label>
                <div className={styles.telegramActions}>
                  <button className={styles.primaryButton} type="button" onClick={() => void refreshTeacherMenus()} disabled={!canWrite || Boolean(busy) || !confirmMenus}>{busy === "menus" ? "Передаємо в чергу…" : `Надіслати меню ${teacherMenus.recipients} вчителям`}</button>
                  <button type="button" onClick={() => { setShowMenuConfirmation(false); setConfirmMenus(false); }} disabled={Boolean(busy)}>Скасувати</button>
                </div>
              </div>
            ) : (
              <div className={styles.telegramActions}>
                <button className={styles.primaryButton} type="button" onClick={() => { setShowMenuConfirmation(true); setConfirmMenus(false); }} disabled={!canWrite || Boolean(busy) || teacherMenus.recipients === 0}>Оновити меню всім</button>
                <button type="button" onClick={() => void load()} disabled={Boolean(busy) || loading}><SiteIcon name={loading ? "loading" : "refresh"} size={17} /> {loading ? "Оновлюємо…" : "Оновити стан"}</button>
              </div>
            )}
          </>
        ) : !loading ? <div className={styles.info}>Не вдалося завантажити стан меню. Спробуйте оновити сторінку.</div> : null}
      </section>
    </div>
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
  const [telegram, setTelegram] = useState<DirectoryTelegram>("all");
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TeacherDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const listRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  const directoryScope = `${query}\u001e${status}\u001e${telegram}`;
  const directoryScopeRef = useRef(directoryScope);
  useEffect(() => {
    directoryScopeRef.current = directoryScope;
  }, [directoryScope]);

  const load = useCallback(async (cursor: string | null = null) => {
    const requestSequence = ++listRequestRef.current;
    const requestScope = `${query}\u001e${status}\u001e${telegram}`;
    if (cursor) setLoadingMore(true);
    else setLoading(true);
    try {
      const next = await loadTeacherDirectory({ query, status, telegram, cursor, limit: 30 });
      if (requestSequence !== listRequestRef.current || requestScope !== directoryScopeRef.current) return;
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
      if (requestSequence !== listRequestRef.current || requestScope !== directoryScopeRef.current) return;
      onNotice(errorMessage(error), "error");
    } finally {
      if (requestSequence === listRequestRef.current && requestScope === directoryScopeRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [onDirectoryChange, onNotice, query, status, telegram]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function selectTeacher(teacherId: string) {
    const requestSequence = ++detailRequestRef.current;
    selectedIdRef.current = teacherId;
    setSelectedId(teacherId);
    setDetail(null);
    setDetailLoading(true);
    try {
      const response = await loadTeacherDetail(teacherId);
      if (requestSequence !== detailRequestRef.current || selectedIdRef.current !== teacherId) return;
      setDetail(response);
    } catch (error) {
      if (requestSequence !== detailRequestRef.current || selectedIdRef.current !== teacherId) return;
      onNotice(errorMessage(error), "error");
    } finally {
      if (requestSequence === detailRequestRef.current && selectedIdRef.current === teacherId) setDetailLoading(false);
    }
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuery(queryInput.trim());
  }

  async function mutationSaved(next: TeacherDetail, message: string) {
    if (selectedIdRef.current === next.teacher.id) {
      setDetail(next);
      setDetailLoading(false);
    }
    onNotice(message);
    await load();
  }

  return (
    <div className={styles.directoryStack}>
      <TeacherCuratorRequestQueue writesEnabled={writesEnabled} onNotice={onNotice} />
      <CollapsibleListSection className={styles.card} flatOnMobile titleId="directory-title" eyebrow={`${data?.counters.active ?? 0} активних`} title="Картки вчителів" actions={<button className={styles.primaryButton} type="button" onClick={() => setCreating((value) => !value)} disabled={!writesEnabled}>
            <SiteIcon name={creating ? "close" : "add"} size={18} /> {creating ? "Закрити форму" : "Додати вчителя"}
          </button>}>

        {creating ? (
          <TeacherProfileForm
            mode="create"
            locations={data?.locations ?? []}
            disabled={!writesEnabled}
            onCancel={() => setCreating(false)}
            onSaved={async (next) => {
              setCreating(false);
              detailRequestRef.current += 1;
              selectedIdRef.current = next.teacher.id;
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
          <label>Telegram
            <select value={telegram} onChange={(event) => setTelegram(event.currentTarget.value as DirectoryTelegram)}>
              <option value="all">Усі</option>
              <option value="connected">Підключені</option>
              <option value="disconnected">Не підключені</option>
              <option value="muted">Сповіщення вимкнено</option>
              <option value="blocked">Бот заблоковано</option>
            </select>
          </label>
        </form>

        {loading ? <p className={styles.empty}>Оновлюємо картки…</p> : data?.teachers.length ? (
          <div className={styles.directoryLayout}>
            <div className={styles.teacherList} role="list" aria-label="Список учителів">
              {data.teachers.map((teacher) => (
                <button type="button" key={teacher.id} data-selected={selectedId === teacher.id} onClick={() => void selectTeacher(teacher.id)}>
                  <TeacherAvatar teacher={teacher} size="small" />
                  <span className={styles.teacherIdentity}><strong>{teacher.fullName}</strong><small>{[teacher.subjectPosition, teacher.primaryLocation?.name, accountRoleLabel(teacher.accountRole)].filter(Boolean).join(" · ") || "Дані ще не заповнено"}</small></span>
                  <span className={styles.badges}><StatusBadge teacher={teacher} /><TelegramStatusBadge teacher={teacher} />{teacher.attention.overdueLoans ? <em>{teacher.attention.overdueLoans} простроч.</em> : null}{teacher.attention.openRequests ? <em>{teacher.attention.openRequests} заяв.</em> : null}</span>
                </button>
              ))}
              {data.page.hasMore && data.page.nextCursor ? <button className={styles.loadMore} type="button" onClick={() => void load(data.page.nextCursor)} disabled={loadingMore}>{loadingMore ? "Завантажуємо…" : "Показати ще"}</button> : null}
            </div>
            <aside className={styles.detailRegion} aria-label="Картка вибраного вчителя">
              {detailLoading ? <p className={styles.empty}>Відкриваємо картку…</p> : detail ? (
                <TeacherDetailCard detail={detail} locations={data.locations} writesEnabled={writesEnabled} onClose={() => { detailRequestRef.current += 1; selectedIdRef.current = null; setDetail(null); setSelectedId(null); }} onSaved={mutationSaved} onDeleted={async () => { selectedIdRef.current = null; setDetail(null); setSelectedId(null); onNotice("Картку й доступ учителя видалено. Історію обліку збережено."); await load(); }} />
              ) : <div className={styles.detailPlaceholder}><span aria-hidden="true"><SiteIcon name="profile" size={28} /></span><h3>Виберіть учителя</h3><p>Тут з’являться профіль, замовлення, фактичні видачі та відвідування.</p></div>}
            </aside>
          </div>
        ) : <p className={styles.empty}>За цими фільтрами карток не знайдено.</p>}
      </CollapsibleListSection>

      <section className={styles.bulkOperations} aria-labelledby="teacher-bulk-operations-title">
        <div><span>Масові операції</span><h2 id="teacher-bulk-operations-title">Імпорт тимчасових кодів</h2><p>Службовий інструмент розміщено внизу, щоб він не заважав щоденній роботі з картками.</p></div>
        <TeacherCodeImport
          writesEnabled={writesEnabled}
          onImported={async () => {
            await load();
          }}
        />
      </section>
    </div>
  );
}

function TeacherCuratorRequestQueue({
  writesEnabled,
  onNotice,
}: {
  writesEnabled: boolean;
  onNotice: (message: string, tone?: "success" | "error" | "info") => void;
}) {
  const [requests, setRequests] = useState<TeacherCuratorRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await visitApi<TeacherCuratorRequestsEnvelope>("/api/librarian/teacher-curator-requests?status=submitted&limit=100");
      setRequests(response.requests);
    } catch (error) {
      onNotice(errorMessage(error), "error");
    } finally {
      setLoading(false);
    }
  }, [onNotice]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function decide(item: TeacherCuratorRequest, decision: "approve" | "reject") {
    const verb = decision === "approve" ? "підтвердити" : "відхилити";
    if (!window.confirm(`${verb[0].toUpperCase()}${verb.slice(1)} зміну кураторства для ${item.teacher.fullName}?`)) return;
    setBusyId(item.id);
    try {
      await visitApi("/api/librarian/teacher-curator-requests", {
        method: "PATCH",
        body: JSON.stringify({ requestId: item.id, expectedVersion: item.version, decision }),
      });
      onNotice(decision === "approve"
        ? `Клас ${item.requestedClass.className} закріплено за ${item.teacher.fullName}.`
        : `Заявку ${item.teacher.fullName} відхилено.`);
      await load();
    } catch (error) {
      onNotice(errorMessage(error), "error");
      await load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <CollapsibleListSection className={`${styles.card} ${styles.curatorQueue}`} flatOnMobile titleId="curator-request-title" eyebrow={`${requests.length} очікує`} title="Зміни кураторства" actions={<button type="button" onClick={() => void load()} disabled={loading}><SiteIcon name={loading ? "loading" : "refresh"} size={18} /> {loading ? "Оновлюємо…" : "Оновити"}</button>}>
      <p className={styles.curatorQueueHint}>Учитель може змінити предмет і кабінет самостійно. Клас куратора змінюється тут, щоб зберегти правильний облік виданих матеріалів.</p>
      {loading ? <p className={styles.empty}>Перевіряємо заявки…</p> : requests.length ? (
        <div className={styles.curatorRequestList}>
          {requests.map((item) => (
            <article key={item.id}>
              <div>
                <strong>{item.teacher.fullName}</strong>
                <span>{item.currentClass ? `${item.currentClass.className} → ` : "Новий куратор: "}<b>{item.requestedClass.className}</b> · {item.requestedClass.academicYearLabel}</span>
                {item.teacherNote ? <small>{item.teacherNote}</small> : null}
              </div>
              <div>
                <button type="button" disabled={!writesEnabled || Boolean(busyId)} onClick={() => void decide(item, "reject")}>Відхилити</button>
                <button className={styles.primaryButton} type="button" disabled={!writesEnabled || Boolean(busyId)} onClick={() => void decide(item, "approve")}>{busyId === item.id ? "Зберігаємо…" : "Підтвердити"}</button>
              </div>
            </article>
          ))}
        </div>
      ) : <p className={styles.empty}>Нових заявок на зміну кураторства немає.</p>}
    </CollapsibleListSection>
  );
}

function TeacherDetailCard({
  detail,
  locations,
  writesEnabled,
  onClose,
  onSaved,
  onDeleted,
}: {
  detail: TeacherDetail;
  locations: TeacherLocation[];
  writesEnabled: boolean;
  onClose: () => void;
  onSaved: (detail: TeacherDetail, message: string) => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const [tab, setTab] = useState<DetailTab>("profile");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const teacher = detail.teacher;
  const closeBlockers = teacher.status === "active" ? teacherCloseBlockers(detail) : [];

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
    const confirmation = window.prompt(`Картку буде прибрано зі списку, доступ, PIN і сеанси буде вимкнено. Видачі, замовлення та журнал дій залишаться в обліку.\n\nДля підтвердження введіть повне ПІБ:\n${teacher.fullName}`)?.trim();
    if (confirmation !== teacher.fullName) return;
    setBusy(true);
    setActionError("");
    try {
      await deleteTeacherProfile(teacher.id, teacher.version, confirmation);
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
        <TeacherAvatar teacher={teacher} size="large" />
        <div><p>{teacher.status === "active" ? "Активна картка" : "Картка закрита"}</p><h3>{teacher.fullName}</h3><small>{[teacher.subjectPosition || "Посаду або предмет не вказано", accountRoleLabel(teacher.accountRole)].join(" · ")}</small><div className={styles.teacherHeaderBadges}><TelegramStatusBadge teacher={teacher} /></div></div>
        <button className={styles.detailClose} type="button" onClick={onClose} aria-label="Закрити картку"><SiteIcon name="close" size={18} /></button>
      </header>
      <nav className={styles.detailTabs} aria-label="Дані вчителя">
        {(["profile", "access", "orders", "issued", "visits"] as const).map((item) => <button key={item} type="button" aria-pressed={tab === item} onClick={() => setTab(item)}>{detailTabLabel(item)}{detailTabCount(item, detail) !== null ? <span>{detailTabCount(item, detail)}</span> : null}</button>)}
      </nav>
      {actionError ? <div className={styles.error} role="alert">{actionError}</div> : null}
      {tab === "profile" ? editing ? (
        <TeacherProfileForm mode="edit" teacher={teacher} locations={locations} disabled={!writesEnabled || busy} onCancel={() => setEditing(false)} onSaved={async (next) => { setEditing(false); await onSaved(next, "Інформацію про вчителя оновлено."); }} />
      ) : (
        <div className={styles.profilePane}>
          <dl><div><dt>Предмет / посада</dt><dd>{teacher.subjectPosition || "—"}</dd></div><div><dt>Обліковий рівень</dt><dd>{accountRoleLabel(teacher.accountRole)}</dd></div><div><dt>Основний кабінет</dt><dd>{teacher.primaryLocation?.name || "—"}</dd></div><div><dt>Мобільний номер</dt><dd>{teacher.serviceContact || "—"}</dd></div><div><dt>Внутрішня примітка</dt><dd>{teacher.librarianNote || "—"}</dd></div></dl>
          <div className={styles.profileActions}><button type="button" onClick={() => setEditing(true)} disabled={!writesEnabled || busy}>Редагувати</button><button type="button" onClick={() => setTab("access")}>Код і доступ</button><button type="button" onClick={() => void changeStatus()} disabled={!writesEnabled || busy || (teacher.status === "active" && closeBlockers.length > 0)}>{teacher.status === "active" ? "Закрити картку" : "Поновити картку"}</button><button className={styles.dangerButton} type="button" onClick={() => void remove()} disabled={!writesEnabled || busy} title="Видалити картку й доступ, зберігши історію обліку">Видалити картку</button></div>
          {closeBlockers.length ? <p className={styles.closeGuard}>Щоб закрити картку, спочатку: {closeBlockers.join("; ")}.</p> : null}
          <p className={styles.deleteGuard}>Видалення прибере картку й доступ, але не видалить видачі, замовлення, відвідування та журнал операцій.</p>
        </div>
      ) : tab === "access" ? <TeacherAccessAdmin key={teacher.id} writesEnabled={writesEnabled} teacherId={teacher.id} embedded /> : tab === "orders" ? <CompactRecords kind="orders" detail={detail} /> : tab === "issued" ? <CompactRecords kind="issued" detail={detail} /> : <CompactRecords kind="visits" detail={detail} />}
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
      <div className={styles.formHeading}><div><span>{mode === "create" ? "Нова картка" : "Профіль"}</span><h3>{mode === "create" ? "Додати вчителя" : "Редагувати інформацію"}</h3></div><button type="button" onClick={onCancel} aria-label="Закрити форму"><SiteIcon name="close" size={18} /></button></div>
      <p className={styles.formHint}>Показуються лише службові дані, які бібліотекар вводить свідомо. Особиста пошта автоматично не підтягується.</p>
      {error ? <div className={styles.error} role="alert">{error}</div> : null}
      <div className={styles.formGrid}>
        <label className={styles.fullField}>Прізвище та ім’я *<input required minLength={3} maxLength={120} autoComplete="off" value={draft.fullName} onChange={(event) => change("fullName", event.currentTarget.value)} /></label>
        <label>Предмет / посада<input maxLength={160} value={draft.subjectPosition} onChange={(event) => change("subjectPosition", event.currentTarget.value)} placeholder="Наприклад, учитель історії" /></label>
        <label>Основний кабінет<select value={draft.primaryLocationId} onChange={(event) => change("primaryLocationId", event.currentTarget.value)}><option value="">Не вказано</option>{locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label>
        <label className={styles.fullField}>Мобільний номер<input type="tel" autoComplete="tel" inputMode="tel" maxLength={40} value={draft.serviceContact} onChange={(event) => change("serviceContact", event.currentTarget.value)} placeholder="Наприклад, +380 67 123 45 67" /></label>
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

function VisitManagementPanel({ telegramMiniApp }: { telegramMiniApp: boolean }) {
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
    <CollapsibleListSection className={styles.card} flatOnMobile titleId="visits-title" eyebrow={`${data?.bookings.length ?? 0} записів`} title="Відвідування бібліотеки" actions={<a className={styles.secondaryLink} href={telegramMiniApp ? "/librarian/telegram/cabinet?target=visits" : "/librarian/visits"}>Повне керування розкладом <SiteIcon name="next" size={17} /></a>}>
      <div className={styles.filters}><label>Дата<input type="date" value={date} onChange={(event) => setDate(event.currentTarget.value)} /></label><label>Стан<select value={status} onChange={(event) => setStatus(event.currentTarget.value)}><option value="active">Активні</option><option value="cancelled">Скасовані</option><option value="">Усі</option></select></label></div>
      {error ? <div className={styles.error} role="alert">{error}</div> : loading ? <p className={styles.empty}>Оновлюємо розклад…</p> : data?.bookings.length ? <div className={styles.visitList}>{data.bookings.map((booking) => <article key={booking.id}><time>{booking.startTime}–{booking.endTime}</time><span><strong>{booking.surname}</strong><small>{[booking.classLabel, booking.purpose].filter(Boolean).join(" · ") || "Без додаткових відомостей"}</small></span><StatusPill value={booking.status} /></article>)}</div> : <p className={styles.empty}>На цю дату записів немає.</p>}
    </CollapsibleListSection>
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

function TeacherAvatar({ teacher, size }: { teacher: TeacherDirectoryRow; size: "small" | "large" }) {
  const className = size === "large" ? styles.largeAvatar : styles.avatar;
  return (
    <span className={`${className} ${styles.avatarFrame}`}>
      {teacher.photoUrl
        ? <img className={styles.teacherPhoto} src={teacher.photoUrl} alt={`Фото ${teacher.fullName}`} />
        : <span aria-hidden="true">{teacherInitials(teacher.fullName)}</span>}
      {teacher.telegram.connected ? (
        <span className={styles.telegramAvatarIndicator} role="img" aria-label={teacher.telegram.notificationsMuted ? "Telegram підключено, сповіщення вимкнено" : "Telegram підключено"} title={teacher.telegram.notificationsMuted ? "Telegram: сповіщення вимкнено" : "Telegram підключено"}>
          <SiteIcon name={teacher.telegram.notificationsMuted ? "bell-off" : "telegram"} size={11} />
        </span>
      ) : null}
    </span>
  );
}

function TelegramStatusBadge({ teacher }: { teacher: TeacherDirectoryRow }) {
  if (teacher.telegram.status === "blocked") return <span className={styles.telegramBlockedBadge}><SiteIcon name="telegram" size={12} /> Бот заблоковано</span>;
  if (teacher.telegram.connected && teacher.telegram.notificationsMuted) return <span className={styles.telegramMutedBadge}><SiteIcon name="bell-off" size={12} /> Сповіщення вимкнено</span>;
  if (teacher.telegram.connected) return <span className={styles.telegramConnectedBadge}><SiteIcon name="telegram" size={12} /> Telegram</span>;
  return <span className={styles.telegramDisconnectedBadge}><SiteIcon name="unlink" size={12} /> Не підключено</span>;
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
  return ({ profile: "Профіль", access: "Доступ", orders: "Замовлення", issued: "Видано", visits: "Відвідування" } as const)[tab];
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

function statusLabel(value: string) {
  return ({ submitted: "Нове", in_review: "Опрацьовується", reserved: "Підготовлено", ready: "Готове", partially_ready: "Частково", completed: "Виконано", rejected: "Відхилено", cancelled: "Скасовано", active: "Активне", open: "Відкрита", closed: "Закрита" } as Record<string, string>)[value] ?? value;
}

function accountRoleLabel(role: TeacherDirectoryRow["accountRole"]) {
  return ({ teacher: "Учитель", admin: "Адміністратор", librarian: "Бібліотекар" } as const)[role];
}

function attentionHint(label: string) {
  if (label === "Учителі без коду") return "Доступ до кабінету ще не видано";
  if (label === "Заблокований доступ") return "Перевірити невдалі спроби входу";
  if (label === "Telegram не підключено") return "Учитель ще не активував бота";
  if (label === "Сповіщення Telegram вимкнено") return "Telegram підключено, але повідомлення вимкнені";
  if (label === "Бот Telegram заблоковано") return "Telegram відхиляє повідомлення бота";
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
  return error instanceof Error ? error.message : "Не вдалося виконати запит. Спробуйте ще раз.";
}
