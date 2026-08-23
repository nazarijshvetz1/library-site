"use client";

/* eslint-disable @next/next/no-img-element -- Images are remote catalog assets handled outside Next's loader. */

import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  busyPeriodParts,
  clearPortalPendingIntent,
  clearVisitPendingIntent,
  formatTeacherAccessCode,
  formatVisitDateTime,
  isUncertainVisitFailure,
  mergePortalPageById,
  normalizedTeacherAccessCode,
  normalizedTeacherPin,
  readPortalPendingIntent,
  readVisitPendingIntent,
  publicVisitsUrl,
  teacherSearchUrl,
  teacherSessionUrl,
  teacherAccessCodeComplete,
  teacherPinStrength,
  teacherVisitsUrl,
  type PublicVisitsEnvelope,
  type GuestVisitsEnvelope,
  type TeacherVisitsEnvelope,
  type VisitBooking,
  type VisitCancelPayload,
  type VisitCreatePayload,
  type VisitGuestBooking,
  type VisitGuestCreatePayload,
  type VisitGuestSessionEnvelope,
  type VisitGuestTeacher,
  type VisitPatchPayload,
  type VisitPendingIntent,
  type VisitTeacher,
  type VisitTeacherIdentity,
  type VisitTeacherSearchEnvelope,
  type VisitTeacherSessionEnvelope,
  validVisitDuration,
  visitApi,
  VisitApiError,
  visitDateRange,
  visitHorizonEnd,
  visitPendingKey,
  weekdayKey,
  writePortalPendingIntent,
  writeVisitPendingIntent,
} from "./visit-client";
import { normalizeCoverPhotoForUpload } from "@/lib/cover-client";
import TeacherAcquisitionPanel from "@/app/teacher/acquisition/teacher-acquisition-panel";
import styles from "./visits.module.css";

const LOGO_URL = "https://nazarijshvetz1.github.io/library-site/library-logo.png";
const PUBLIC_CATALOG_URL = "https://nazarijshvetz1.github.io/library-site/";

type Props = {
  initialDate: string;
  initialStartTime: string;
  initialEndTime: string;
  initialTab?: "overview" | "visits" | "orders" | "acquisition" | "loans" | "notifications";
  initialOrderMaterialId?: string;
  telegramMiniApp?: boolean;
};

type TeacherTab = NonNullable<Props["initialTab"]>;

const TEACHER_TABS: Array<{ id: TeacherTab; label: string; icon: string }> = [
  { id: "overview", label: "Огляд", icon: "⌂" },
  { id: "visits", label: "Відвідування", icon: "◷" },
  { id: "orders", label: "Замовлення", icon: "▤" },
  { id: "acquisition", label: "Запропонувати придбання", icon: "+" },
  { id: "loans", label: "Мої посібники", icon: "▥" },
  { id: "notifications", label: "Повідомлення", icon: "●" },
];

function clearTeacherPortalPendingStorage(storage: Storage, pendingScope: string): void {
  clearVisitPendingIntent(storage, visitPendingKey("teacher", pendingScope));
  clearPortalPendingIntent(storage, `library.teacher.orders.pending.v1:${pendingScope}`);
  clearPortalPendingIntent(storage, `library.teacher.notifications.pending.v1:${pendingScope}`);
}

export default function VisitBookingWorkspace({
  initialDate,
  initialStartTime,
  initialEndTime,
  initialTab = "overview",
  initialOrderMaterialId = "",
  telegramMiniApp = false,
}: Props) {
  const [session, setSession] = useState<VisitTeacherSessionEnvelope | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [authNotice, setAuthNotice] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [firstLoginCode, setFirstLoginCode] = useState("");

  const checkSession = useCallback(async () => {
    setCheckingSession(true);
    try {
      setSession(await visitApi<VisitTeacherSessionEnvelope>(teacherSessionUrl));
    } catch (error) {
      if (error instanceof VisitApiError && error.status === 401) {
        setSession(null);
      } else {
        setAuthNotice("Не вдалося перевірити доступ. Спробуйте оновити сторінку.");
      }
    } finally {
      setCheckingSession(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void checkSession(), 0);
    return () => window.clearTimeout(timer);
  }, [checkSession]);

  async function signIn(loginId: string, code: string) {
    setAuthBusy(true);
    setAuthNotice("");
    try {
      const authenticated = await visitApi<VisitTeacherSessionEnvelope>(teacherSessionUrl, {
        method: "POST",
        body: JSON.stringify({ loginId, code }),
      });
      setFirstLoginCode(authenticated.mustChangePin ? normalizedTeacherAccessCode(code) : "");
      setSession(authenticated);
    } catch (error) {
      // This deliberately does not reveal whether the name or personal code was wrong.
      if (error instanceof VisitApiError && error.status === 429) {
        setAuthNotice("Забагато спроб входу. Зачекайте трохи й повторіть.");
      } else if (error instanceof VisitApiError && error.status >= 500) {
        setAuthNotice("Сервіс входу тимчасово недоступний. Спробуйте трохи пізніше.");
      } else {
        setAuthNotice("Не вдалося увійти. Перевірте обране ім’я та особистий код.");
      }
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut() {
    setAuthBusy(true);
    setAuthNotice("");
    try {
      await visitApi<{ success: true }>(teacherSessionUrl, { method: "DELETE" });
      if (session?.pendingScope) {
        clearTeacherPortalPendingStorage(window.sessionStorage, session.pendingScope);
      }
      setSession(null);
      setFirstLoginCode("");
    } catch {
      setAuthNotice("Не вдалося вийти. Спробуйте ще раз.");
    } finally {
      setAuthBusy(false);
    }
  }

  if (!session) {
    return (
      <VisitShell telegramMiniApp={telegramMiniApp}>
        <section className={styles.page}>
          <div className={styles.intro}>
            <p className={styles.eyebrow}>Кабінет учителя</p>
            <h1>Бібліотека у вашому розкладі</h1>
            <p>Перегляньте вільний час без входу. Для підтвердженого запису, замовлень і власної історії увійдіть за персональним кодом.</p>
          </div>
          <PublicVisitSchedule
            initialDate={initialDate}
            initialStartTime={initialStartTime}
            initialEndTime={initialEndTime}
            teacherEntryPath={telegramMiniApp ? "/teacher/telegram/cabinet" : "/teacher"}
          />
          <div className={styles.accessModes} id="teacher-access">
            {checkingSession
              ? <div className={`${styles.card} ${styles.authLoading}`} role="status">Перевіряємо, чи ви вже увійшли…</div>
              : <>
                <GuestBookingPanel
                  initialDate={initialDate}
                  initialStartTime={initialStartTime}
                  initialEndTime={initialEndTime}
                />
                <TeacherSignIn onSignIn={signIn} busy={authBusy} notice={authNotice} />
              </>}
          </div>
        </section>
      </VisitShell>
    );
  }

  if (session.mustChangePin) {
    return (
      <VisitShell telegramMiniApp={telegramMiniApp}>
        <section className={styles.page}>
          <div className={styles.intro}>
            <p className={styles.eyebrow}>Перший вхід</p>
            <h1>Створіть власний PIN</h1>
            <p>Тимчасовий код бібліотекаря прийнято. Тепер оберіть 4 цифри, які надалі використовуватимете для входу.</p>
          </div>
          <TeacherSecurityPanel
            pendingScope={session.pendingScope}
            required
            initialCurrentCode={firstLoginCode}
            onClose={() => undefined}
            onSessionRotated={(rotated) => {
              setFirstLoginCode("");
              setSession((current) => current ? { ...current, ...rotated } : current);
            }}
          />
        </section>
      </VisitShell>
    );
  }

  return (
    <VisitBookingPanel
      teacher={session.teacher}
      pendingScope={session.pendingScope}
      signingOut={authBusy}
      signOutNotice={authNotice}
      onSignOut={signOut}
      onSessionRotated={(rotated) => setSession((current) => current ? { ...current, ...rotated } : current)}
      initialDate={initialDate}
      initialStartTime={initialStartTime}
      initialEndTime={initialEndTime}
      initialTab={initialTab}
      initialOrderMaterialId={initialOrderMaterialId}
      telegramMiniApp={telegramMiniApp}
    />
  );
}

function VisitShell({ children, telegramMiniApp = false }: { children: React.ReactNode; telegramMiniApp?: boolean }) {
  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <a className={styles.brand} href={telegramMiniApp ? "/teacher/telegram/cabinet?tab=overview" : "/"}>
          <img src={LOGO_URL} alt="" width="48" height="48" />
          <span><strong>Єдина бібліотека</strong><small>Кабінет учителя</small></span>
        </a>
        <a className={styles.catalogLink} href={PUBLIC_CATALOG_URL}>Публічний каталог</a>
      </header>
      {children}
    </main>
  );
}

type PublicScheduleSlot = {
  startTime: string;
  endTime: string;
  status: "free" | "busy" | "closed";
  displayName?: string;
  identityVerified?: boolean;
  sourceKey?: string;
};

function PublicVisitSchedule({
  initialDate,
  initialStartTime,
  initialEndTime,
  teacherEntryPath,
}: Pick<Props, "initialDate" | "initialStartTime" | "initialEndTime"> & { teacherEntryPath: string }) {
  const today = useMemo(() => todayInKyiv(), []);
  const [weekStart, setWeekStart] = useState(() => publicWeekStart(initialDate, today));
  const [data, setData] = useState<PublicVisitsEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const dates = useMemo(() => visitDates(weekStart, 7), [weekStart]);
  const currentTime = currentTimeInKyiv();
  const selectedWeekContainsInitial = dates.includes(initialDate);

  const load = useCallback(async () => {
    const range = visitDates(weekStart, 7);
    setLoading(true);
    setNotice("");
    try {
      setData(await visitApi<PublicVisitsEnvelope>(publicVisitsUrl(range[0], range.at(-1) ?? range[0])));
    } catch {
      setNotice("Не вдалося оновити публічний графік. Спробуйте ще раз.");
    } finally {
      setLoading(false);
    }
  }, [weekStart]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <section className={`${styles.card} ${styles.publicSchedule}`} aria-labelledby="public-schedule-title">
      <div className={styles.cardHeading}>
        <div>
          <span>Доступно без входу</span>
          <h2 id="public-schedule-title">Публічний графік</h2>
        </div>
        <div className={styles.weekControls} aria-label="Перемикання тижня">
          <button
            type="button"
            aria-label="Попередній тиждень"
            disabled={weekStart <= today || loading}
            onClick={() => setWeekStart(shiftVisitDate(weekStart, -7, today))}
          >←</button>
          <strong>{formatWeek(dates)}</strong>
          <button
            type="button"
            aria-label="Наступний тиждень"
            disabled={weekStart >= lastPublicWeekStart(today) || loading}
            onClick={() => setWeekStart(shiftVisitDate(weekStart, 7, today))}
          >→</button>
        </div>
      </div>

      <p className={styles.publicPrivacy}>Графік відкритий для всіх без входу. Для підтверджених записів видно ім’я вчителя й точний час. Клас, мета візиту та контактні дані не публікуються.</p>
      {notice ? <div className={styles.error} role="alert">{notice} <button type="button" onClick={() => void load()}>Повторити</button></div> : null}
      {loading ? <p className={styles.empty} role="status">Оновлюємо графік…</p> : null}
      {!loading && data ? (
        <div className={styles.publicDays} aria-live="polite">
          {dates.map((date) => {
            const slots = publicSlots(data, date);
            return (
              <article key={date} className={date === today ? styles.today : undefined}>
                <h3><time dateTime={date}>{formatVisitDay(date)}</time>{date === today ? <span>Сьогодні</span> : null}</h3>
                {slots.length ? (
                  <ul>
                    {slots.map((slot) => {
                      const selected = selectedWeekContainsInitial
                        && date === initialDate
                        && slot.startTime <= initialStartTime
                        && slot.endTime >= initialEndTime;
                      if (slot.status !== "free") {
                        return <li key={`${slot.startTime}-${slot.endTime}-${slot.sourceKey ?? slot.status}`} data-status={slot.status}><strong>{slot.startTime}–{slot.endTime}</strong><span>{slot.status === "closed" ? "Зачинено" : slot.displayName || "Заброньовано"}</span></li>;
                      }
                      const start = bookableSlotStart(date, slot, today, currentTime);
                      if (!start) {
                        return <li key={`${slot.startTime}-${slot.endTime}`} data-status="closed"><strong>{slot.startTime}–{slot.endTime}</strong><span>Час минув</span></li>;
                      }
                      const end = boundedSlotEnd(start, slot.endTime, 40);
                      const href = `${teacherEntryPath}?${new URLSearchParams({ date, start, end, tab: "visits" }).toString()}#teacher-access`;
                      return (
                        <li key={`${slot.startTime}-${slot.endTime}`} data-status="free" data-selected={selected || undefined}>
                          <a href={href}><strong>{start}–{slot.endTime}</strong><span>{selected ? "Обрано" : "Обрати"}</span></a>
                        </li>
                      );
                    })}
                  </ul>
                ) : <p>Бібліотека зачинена</p>}
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

type GuestPendingIntent =
  | { kind: "guest-create"; requestId: string; payload: VisitGuestCreatePayload }
  | { kind: "guest-patch"; requestId: string; resourceId: string; payload: VisitPatchPayload }
  | { kind: "guest-cancel"; requestId: string; resourceId: string; payload: VisitCancelPayload };

const GUEST_PENDING_KINDS = ["guest-create", "guest-patch", "guest-cancel"] as const;
const VISIT_PURPOSES = [
  "Урок у бібліотеці",
  "Добір літератури",
  "Класна година",
  "Робота над навчальним проєктом",
] as const;

function GuestBookingPanel({
  initialDate,
  initialStartTime,
  initialEndTime,
}: Pick<Props, "initialDate" | "initialStartTime" | "initialEndTime">) {
  const teacherListId = useId();
  const teacherSearchRef = useRef<HTMLInputElement>(null);
  const today = useMemo(() => todayInKyiv(), []);
  const [activated, setActivated] = useState(false);
  const [session, setSession] = useState<VisitGuestSessionEnvelope | null>(null);
  const [data, setData] = useState<GuestVisitsEnvelope | null>(null);
  const [initializing, setInitializing] = useState(false);
  const [endingSession, setEndingSession] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");
  const [noticeTone, setNoticeTone] = useState<"success" | "error" | "info">("info");
  const [pending, setPending] = useState<GuestPendingIntent | null>(null);
  const [editing, setEditing] = useState<VisitGuestBooking | null>(null);
  const [teacherQuery, setTeacherQuery] = useState("");
  const [teacherResults, setTeacherResults] = useState<VisitGuestTeacher[]>([]);
  const [selectedTeacher, setSelectedTeacher] = useState<VisitGuestTeacher | null>(null);
  const [teacherSearchNotice, setTeacherSearchNotice] = useState("");
  const [activeTeacherIndex, setActiveTeacherIndex] = useState(-1);
  const [date, setDate] = useState(() => validDate(initialDate) ? initialDate : today);
  const [startTime, setStartTime] = useState(() => validTime(initialStartTime) ? initialStartTime : "09:00");
  const [endTime, setEndTime] = useState(() => validTime(initialEndTime) ? initialEndTime : "09:40");
  const [classYearId, setClassYearId] = useState("");
  const [purpose, setPurpose] = useState("");
  const [publicDisplayConsent, setPublicDisplayConsent] = useState(false);
  const storageKey = session ? `library.guest.pending.v1:${session.guest.pendingScope}` : "";

  const load = useCallback(async () => {
    const range = visitDateRange(todayInKyiv(), 90);
    setData(await visitApi<GuestVisitsEnvelope>(`/api/visits/guest?${new URLSearchParams(range).toString()}`));
  }, []);

  async function activateGuestBooking() {
    if (initializing || session) return;
    setActivated(true);
    setInitializing(true);
    setNotice("");
    try {
      let active: VisitGuestSessionEnvelope;
      try {
        active = await visitApi<VisitGuestSessionEnvelope>("/api/visits/guest/session");
      } catch (error) {
        if (!(error instanceof VisitApiError) || error.status !== 401) throw error;
        active = await visitApi<VisitGuestSessionEnvelope>("/api/visits/guest/session", {
          method: "POST",
          body: JSON.stringify({}),
        });
      }
      const range = visitDateRange(todayInKyiv(), 90);
      const guestData = await visitApi<GuestVisitsEnvelope>(`/api/visits/guest?${new URLSearchParams(range).toString()}`);
      setSession(active);
      setData(guestData);
      const key = `library.guest.pending.v1:${active.guest.pendingScope}`;
      setPending(readPortalPendingIntent<GuestPendingIntent>(window.sessionStorage, key, GUEST_PENDING_KINDS));
      window.setTimeout(() => teacherSearchRef.current?.focus(), 0);
    } catch (error) {
      setNotice(errorMessage(error));
      setNoticeTone("error");
    } finally {
      setInitializing(false);
    }
  }

  const normalizedTeacherQuery = teacherQuery.trim();
  useEffect(() => {
    if (!activated || !session || selectedTeacher || normalizedTeacherQuery.length < 3) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setTeacherSearchNotice("Шукаємо…");
      try {
        const params = new URLSearchParams({ q: normalizedTeacherQuery });
        const response = await visitApi<{ success: true; teachers: VisitGuestTeacher[] }>(`/api/visits/guest/directory?${params.toString()}`, { signal: controller.signal });
        setTeacherResults(response.teachers);
        setActiveTeacherIndex(response.teachers.length ? 0 : -1);
        setTeacherSearchNotice(response.teachers.length ? "" : "Збігів не знайдено.");
      } catch {
        if (!controller.signal.aborted) {
          setTeacherResults([]);
          setActiveTeacherIndex(-1);
          setTeacherSearchNotice("Не вдалося виконати пошук.");
        }
      }
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [activated, normalizedTeacherQuery, selectedTeacher, session]);

  function changeTeacherQuery(value: string) {
    setTeacherQuery(value);
    if (selectedTeacher && value !== selectedTeacher.fullName) setSelectedTeacher(null);
    if (value.trim().length < 3) {
      setTeacherResults([]);
      setActiveTeacherIndex(-1);
      setTeacherSearchNotice("");
    }
  }

  function chooseGuestTeacher(teacher: VisitGuestTeacher) {
    setSelectedTeacher(teacher);
    setTeacherQuery(teacher.fullName);
    setTeacherResults([]);
    setActiveTeacherIndex(-1);
    setTeacherSearchNotice("");
  }

  function guestTeacherKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!teacherResults.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveTeacherIndex((index) => Math.min(teacherResults.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveTeacherIndex((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter" && activeTeacherIndex >= 0) {
      event.preventDefault();
      chooseGuestTeacher(teacherResults[activeTeacherIndex]);
    } else if (event.key === "Escape") {
      setTeacherResults([]);
      setActiveTeacherIndex(-1);
    }
  }

  async function sendGuestIntent(intent: GuestPendingIntent) {
    if (!storageKey) return;
    if (!writePortalPendingIntent(window.sessionStorage, storageKey, intent)) {
      setNotice("Браузер не дозволив безпечно зберегти запит для повторної перевірки.");
      setNoticeTone("error");
      return;
    }
    setPending(intent);
    setSubmitting(true);
    setNotice("");
    const resourcePath = intent.kind === "guest-create" ? "" : `/${encodeURIComponent(intent.resourceId)}`;
    const method = intent.kind === "guest-create" ? "POST" : intent.kind === "guest-patch" ? "PATCH" : "DELETE";
    try {
      await visitApi(`/api/visits/guest${resourcePath}`, { method, body: JSON.stringify(intent.payload) });
      clearPortalPendingIntent(window.sessionStorage, storageKey);
      setPending(null);
      const successMessage = intent.kind === "guest-create" ? "Гостьовий запис створено." : intent.kind === "guest-patch" ? "Гостьовий запис оновлено." : "Гостьовий запис скасовано.";
      setNotice(successMessage);
      setNoticeTone("success");
      setEditing(null);
      setPublicDisplayConsent(false);
      if (intent.kind === "guest-create") {
        setPurpose("");
        setSelectedTeacher(null);
        setTeacherQuery("");
      }
      try {
        await load();
      } catch {
        setNotice(`${successMessage} Не вдалося оновити список; натисніть «Оновити» або перезавантажте сторінку.`);
        setNoticeTone("info");
      }
    } catch (error) {
      if (!isUncertainVisitFailure(error)) {
        clearPortalPendingIntent(window.sessionStorage, storageKey);
        setPending(null);
      }
      setNotice(errorMessage(error));
      setNoticeTone("error");
    } finally {
      setSubmitting(false);
    }
  }

  function submitGuest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTeacher || !publicDisplayConsent || !validVisitDuration(startTime, endTime) || pending) return;
    const requestId = crypto.randomUUID();
    if (editing) {
      const payload: VisitPatchPayload = { requestId, expectedVersion: editing.version, date, startTime, endTime, classYearId: classYearId || null, purpose: purpose || null, publicDisplayConsent: true };
      void sendGuestIntent({ kind: "guest-patch", requestId, resourceId: editing.id, payload });
    } else {
      const payload: VisitGuestCreatePayload = { requestId, teacherRef: selectedTeacher.teacherRef, date, startTime, endTime, classYearId: classYearId || null, purpose: purpose || null, publicDisplayConsent: true };
      void sendGuestIntent({ kind: "guest-create", requestId, payload });
    }
  }

  function editGuestBooking(booking: VisitGuestBooking) {
    setEditing(booking);
    setSelectedTeacher(booking.teacher);
    setTeacherQuery(booking.teacher.fullName);
    setDate(booking.date);
    setStartTime(booking.startTime);
    setEndTime(booking.endTime);
    setClassYearId(booking.classYearId || "");
    setPurpose(booking.purpose || "");
    setPublicDisplayConsent(booking.publicDisplayConsent === true);
  }

  function cancelGuestBooking(booking: VisitGuestBooking) {
    if (!window.confirm("Скасувати цей непідтверджений гостьовий запис?")) return;
    const requestId = crypto.randomUUID();
    const payload = { requestId, expectedVersion: booking.version, reason: null };
    void sendGuestIntent({ kind: "guest-cancel", requestId, resourceId: booking.id, payload });
  }

  async function endGuestSession() {
    if (!session || endingSession || submitting) return;
    const previousData = data;
    setEndingSession(true);
    setData(null);
    setNotice("");
    try {
      await visitApi("/api/visits/guest/session", { method: "DELETE" });
      if (storageKey) clearPortalPendingIntent(window.sessionStorage, storageKey);
      setSession(null);
      setPending(null);
      setActivated(false);
      resetGuestForm();
      setNotice("Гостьовий сеанс завершено. Дані ваших гостьових записів більше не показуються в цьому кабінеті.");
      setNoticeTone("success");
    } catch (error) {
      setData(previousData);
      setNotice(errorMessage(error));
      setNoticeTone("error");
    } finally {
      setEndingSession(false);
    }
  }

  function resetGuestForm() {
    setEditing(null);
    setSelectedTeacher(null);
    setTeacherQuery("");
    setTeacherResults([]);
    setActiveTeacherIndex(-1);
    setDate(validDate(initialDate) ? initialDate : today);
    setStartTime(validTime(initialStartTime) ? initialStartTime : "09:00");
    setEndTime(validTime(initialEndTime) ? initialEndTime : "09:40");
    setClassYearId("");
    setPurpose("");
    setPublicDisplayConsent(false);
  }

  const activeBookings = (data?.bookings ?? []).filter((booking) => booking.status === "active");

  return (
    <section className={`${styles.card} ${styles.guestCard}`} aria-labelledby="guest-title">
      <div className={styles.cardHeading}><div><span>Швидкий запис без коду</span><h2 id="guest-title">Гостьовий режим</h2></div></div>
      <div className={styles.unverifiedNote} role="note"><strong>Особу не підтверджено.</strong> Ви лише заявляєте, від імені якого вчителя створюєте запис. Для підтвердженої особи та замовлень увійдіть персональним кодом.</div>
      {!activated ? <button className={styles.primary} type="button" aria-expanded="false" aria-controls="guest-booking-form" onClick={() => void activateGuestBooking()}>Записатися без коду</button> : null}
      {initializing ? <p className={styles.empty} role="status">Готуємо гостьовий запис…</p> : null}
      {activated && !initializing && !session ? <button className={styles.quiet} type="button" onClick={() => void activateGuestBooking()}>Спробувати відкрити гостьовий запис ще раз</button> : null}
      {pending ? <div className={styles.pending} role="status"><span>Результат попереднього гостьового запиту не підтверджено.</span><button type="button" onClick={() => void sendGuestIntent(pending)} disabled={submitting}>Перевірити результат</button></div> : null}
      {notice ? <div className={styles[noticeTone]} role={noticeTone === "error" ? "alert" : "status"}>{notice}</div> : null}
      {session ? <div className={styles.sharedDeviceNote} role="note"><span><strong>Працюєте на спільному пристрої?</strong> Завершіть гостьовий сеанс після запису, щоб наступна людина не побачила ваші дані.</span><button className={styles.quiet} type="button" onClick={() => void endGuestSession()} disabled={endingSession || submitting}>{endingSession ? "Завершуємо…" : "Завершити гостьовий сеанс"}</button></div> : null}
      {!initializing && !endingSession && session ? (
        <form id="guest-booking-form" onSubmit={submitGuest} aria-busy={submitting || endingSession}>
          <div className={styles.fields}>
            <div className={`${styles.wide} ${styles.comboboxField}`}>
              <label htmlFor={`${teacherListId}-search`}>Учитель *</label>
              <input ref={teacherSearchRef} id={`${teacherListId}-search`} type="search" role="combobox" aria-autocomplete="list" aria-expanded={teacherResults.length > 0} aria-controls={teacherListId} aria-activedescendant={activeTeacherIndex >= 0 ? `${teacherListId}-${activeTeacherIndex}` : undefined} aria-describedby={`${teacherListId}-help ${teacherListId}-status`} value={teacherQuery} onChange={(event) => changeTeacherQuery(event.currentTarget.value)} onKeyDown={guestTeacherKeyDown} placeholder="Введіть щонайменше 3 літери" disabled={Boolean(editing)} autoComplete="off" />
              <small id={`${teacherListId}-help`}>Оберіть точне ім’я зі списку бази даних.</small>
              <div id={`${teacherListId}-status`} className={styles.searchStatus} role="status" aria-live="polite">{teacherSearchNotice}</div>
              {teacherResults.length ? <ul id={teacherListId} className={styles.teacherResults} role="listbox" aria-label="Знайдені вчителі">{teacherResults.map((teacher, index) => <li id={`${teacherListId}-${index}`} key={teacher.teacherRef} role="option" aria-selected={index === activeTeacherIndex}><button type="button" onMouseEnter={() => setActiveTeacherIndex(index)} onClick={() => chooseGuestTeacher(teacher)}>{teacher.fullName}</button></li>)}</ul> : null}
            </div>
            <label>Дата *<input required type="date" min={today} max={visitHorizonEnd(today)} value={date} onChange={(event) => setDate(event.currentTarget.value)} /></label>
            <label>Початок *<input required type="time" step={300} value={startTime} onChange={(event) => setStartTime(event.currentTarget.value)} /></label>
            <label>Завершення *<input required type="time" step={300} value={endTime} onChange={(event) => setEndTime(event.currentTarget.value)} /></label>
            <label>Клас<select value={classYearId} onChange={(event) => setClassYearId(event.currentTarget.value)}><option value="">Без класу</option>{(data?.classYears ?? []).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
            <label className={styles.wide}>Мета візиту<select value={purpose} onChange={(event) => setPurpose(event.currentTarget.value)}><option value="">Не вказувати</option>{VISIT_PURPOSES.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
            <label className={`${styles.wide} ${styles.publicConsent}`}><input required type="checkbox" checked={publicDisplayConsent} onChange={(event) => setPublicDisplayConsent(event.currentTarget.checked)} /><span>Я розумію, що у відкритому графіку всі бачитимуть час і позначку «Непідтверджений гостьовий запис». Ім’я обраного вчителя, клас і мета візиту не публікуватимуться.</span></label>
          </div>
          <div className={styles.guestActions}>
            {editing ? <button className={styles.quiet} type="button" onClick={resetGuestForm} disabled={submitting}>Не редагувати</button> : null}
            <button className={styles.primary} type="submit" disabled={!selectedTeacher || !publicDisplayConsent || !validVisitDuration(startTime, endTime) || submitting || Boolean(pending)}>{submitting ? "Зберігаємо…" : editing ? "Зберегти зміни" : "Створити гостьовий запис"}</button>
          </div>
        </form>
      ) : null}
      {!endingSession && activeBookings.length ? <div className={styles.guestBookings}><h3>Гостьові записи в цьому браузері</h3>{activeBookings.map((booking) => <article key={booking.id}><div><strong>{formatVisitDateTime(`${booking.date}T${booking.startTime}`)}–{booking.endTime}</strong><span>{booking.teacher.fullName} · {booking.classLabel || "Без класу"}</span></div><div><button className={styles.quiet} type="button" onClick={() => editGuestBooking(booking)} disabled={submitting || Boolean(pending)}>Редагувати</button><button className={styles.danger} type="button" onClick={() => cancelGuestBooking(booking)} disabled={submitting || Boolean(pending)}>Скасувати</button></div></article>)}</div> : null}
    </section>
  );
}

function TeacherSignIn({
  onSignIn,
  busy,
  notice,
}: {
  onSignIn: (loginId: string, code: string) => Promise<void>;
  busy: boolean;
  notice: string;
}) {
  const listId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<VisitTeacher[]>([]);
  const [selected, setSelected] = useState<VisitTeacher | null>(null);
  const [code, setCode] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchNotice, setSearchNotice] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const normalizedQuery = query.trim();

  useEffect(() => {
    if (selected || normalizedQuery.length < 3) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      setSearchNotice("");
      try {
        const response = await visitApi<VisitTeacherSearchEnvelope>(teacherSearchUrl(normalizedQuery), {
          signal: controller.signal,
        });
        setResults(response.teachers);
        setActiveIndex(response.teachers.length ? 0 : -1);
        if (!response.teachers.length) setSearchNotice("Збігів не знайдено. Перевірте написання імені.");
      } catch (error) {
        if (!controller.signal.aborted) {
          setResults([]);
          setActiveIndex(-1);
          setSearchNotice(error instanceof VisitApiError && error.status === 429
            ? "Забагато спроб. Зачекайте трохи й повторіть пошук."
            : "Не вдалося виконати пошук. Спробуйте ще раз.");
        }
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [normalizedQuery, selected]);

  function chooseTeacher(teacher: VisitTeacher) {
    setSelected(teacher);
    setQuery(teacher.fullName);
    setResults([]);
    setActiveIndex(-1);
    setSearchNotice("");
  }

  function changeQuery(value: string) {
    setQuery(value);
    if (selected && value !== selected.fullName) setSelected(null);
    if (value.trim().length < 3) {
      setResults([]);
      setSearching(false);
      setSearchNotice("");
      setActiveIndex(-1);
    }
  }

  function searchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!results.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(results.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault();
      chooseTeacher(results[activeIndex]);
    } else if (event.key === "Escape") {
      setResults([]);
      setActiveIndex(-1);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const chosen = selected ?? (results.length === 1 ? results[0] : null);
    if (!chosen) {
      setSearchNotice("Оберіть своє ім’я у списку під полем.");
      searchRef.current?.focus();
      return;
    }
    if (!teacherAccessCodeComplete(code)) return;
    void onSignIn(chosen.loginId, normalizedTeacherAccessCode(code));
  }

  function changeCode(value: string) {
    setCode(formatTeacherAccessCode(value));
  }

  return (
    <section className={`${styles.authPage}`} aria-labelledby={`${listId}-title`}>
      <div className={styles.intro}>
        <p className={styles.eyebrow}>Графік відвідування бібліотеки</p>
        <h2 id={`${listId}-title`}>Увійдіть за своїм ім’ям</h2>
        <p>Знайдіть себе у списку вчителів і введіть особистий код, який видав бібліотекар. Email-адреса не потрібна.</p>
      </div>

      <form className={`${styles.card} ${styles.authCard}`} onSubmit={submit} aria-busy={busy}>
        <div className={styles.cardHeading}>
          <div><span>Доступ учителя</span><h2>Ім’я та особистий код</h2></div>
        </div>
        {notice ? <div className={styles.error} role="alert">{notice}</div> : null}
        <div className={styles.fields}>
          <div className={`${styles.wide} ${styles.comboboxField}`}>
            <label htmlFor={`${listId}-search`}>Прізвище та ім’я *</label>
            <input
              ref={searchRef}
              id={`${listId}-search`}
              type="search"
              role="combobox"
              autoComplete="off"
              spellCheck="false"
              maxLength={100}
              value={query}
              aria-autocomplete="list"
              aria-controls={listId}
              aria-expanded={results.length > 0}
              aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
              aria-describedby={`${listId}-help ${listId}-status`}
              onChange={(event) => changeQuery(event.currentTarget.value)}
              onKeyDown={searchKeyDown}
              placeholder="Почніть вводити щонайменше 3 літери"
            />
            <small id={`${listId}-help`}>Оберіть точне ім’я зі списку бази даних.</small>
            <div id={`${listId}-status`} className={styles.searchStatus} role="status" aria-live="polite">
              {searching ? "Шукаємо…" : searchNotice}
            </div>
            {results.length ? (
              <ul id={listId} className={styles.teacherResults} role="listbox" aria-label="Знайдені вчителі">
                {results.map((teacher, index) => (
                  <li
                    id={`${listId}-${index}`}
                    key={teacher.loginId}
                    role="option"
                    aria-selected={index === activeIndex}
                  >
                    <button
                      type="button"
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => chooseTeacher(teacher)}
                    >
                      <strong>{teacher.fullName}</strong>
                      {teacher.publicHint ? <small>{teacher.publicHint}</small> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          {selected ? (
            <div className={`${styles.wide} ${styles.selectedTeacher}`}>
              <span>Обрано з бази даних</span>
              <strong>{selected.fullName}</strong>
              <button type="button" onClick={() => {
                setSelected(null);
                setQuery("");
                setCode("");
                window.setTimeout(() => searchRef.current?.focus(), 0);
              }}>Змінити</button>
            </div>
          ) : null}

          <label className={styles.wide}>Тимчасовий код або PIN *
            <input
              required
              type="password"
              inputMode="text"
              autoComplete="one-time-code"
              autoCapitalize="characters"
              maxLength={11}
              pattern="(?:[0-9]{4}|[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5})"
              value={code}
              onChange={(event) => changeCode(event.currentTarget.value)}
              disabled={busy}
              placeholder="4 цифри"
            />
            <small>Під час першого входу введіть код бібліотекаря. Після цього сайт запропонує створити власний 4-значний PIN.</small>
          </label>
        </div>
        <button className={styles.primary} type="submit" disabled={!teacherAccessCodeComplete(code) || busy}>
          {busy ? "Перевіряємо…" : "Увійти до кабінету"}
        </button>
        <p className={styles.authHelp}>Забули PIN або вас немає у списку? Бібліотекар може видати новий тимчасовий код.</p>
      </form>
    </section>
  );
}

function VisitBookingPanel({
  teacher,
  pendingScope,
  signingOut,
  signOutNotice,
  onSignOut,
  onSessionRotated,
  initialDate,
  initialStartTime,
  initialEndTime,
  initialTab,
  initialOrderMaterialId,
  telegramMiniApp,
}: {
  teacher: VisitTeacherIdentity;
  pendingScope: string;
  signingOut: boolean;
  signOutNotice: string;
  onSignOut: () => Promise<void>;
  onSessionRotated: (session: Pick<VisitTeacherSessionEnvelope, "pendingScope" | "expiresAt" | "mustChangePin">) => void;
  initialDate: string;
  initialStartTime: string;
  initialEndTime: string;
  initialTab: "overview" | "visits" | "orders" | "acquisition" | "loans" | "notifications";
  initialOrderMaterialId: string;
  telegramMiniApp: boolean;
}) {
  const storageKey = visitPendingKey("teacher", pendingScope);
  const [activeTab, setActiveTab] = useState(initialTab);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [data, setData] = useState<TeacherVisitsEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [noticeTone, setNoticeTone] = useState<"success" | "error" | "info">("info");
  const [pending, setPending] = useState<VisitPendingIntent | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [editingBooking, setEditingBooking] = useState<VisitBooking | null>(null);
  const today = useMemo(() => todayInKyiv(), []);
  const [date, setDate] = useState(() => validDate(initialDate) ? initialDate : today);
  const [startTime, setStartTime] = useState(() => validTime(initialStartTime) ? initialStartTime : "09:00");
  const [endTime, setEndTime] = useState(() => validTime(initialEndTime) ? initialEndTime : "09:30");
  const [classYearId, setClassYearId] = useState("");
  const [purpose, setPurpose] = useState("");
  const [publicDisplayConsent, setPublicDisplayConsent] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const load = useCallback(async (afterMutation = false) => {
    setLoading(true);
    try {
      setData(await visitApi<TeacherVisitsEnvelope>(teacherVisitsUrl(todayInKyiv())));
    } catch (error) {
      setNotice(afterMutation
        ? "Дію збережено, але список не вдалося оновити. Натисніть «Оновити»."
        : errorMessage(error));
      setNoticeTone(afterMutation ? "info" : "error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPending(readVisitPendingIntent(window.sessionStorage, storageKey));
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load, storageKey]);

  const selectedBusy = useMemo(
    () => (data?.busy ?? []).map(busyPeriodParts).filter((period) => period.date === date),
    [data?.busy, date],
  );
  const selectedClosures = useMemo(
    () => (data?.closures ?? []).filter((closure) => closure.date === date),
    [data?.closures, date],
  );
  const activeBookings = useMemo(
    () => (data?.bookings ?? []).filter((booking) => booking.status === "active"),
    [data?.bookings],
  );

  async function sendCreate(intent: Extract<VisitPendingIntent, { kind: "create" }>) {
    setSubmitting(true);
    setNotice("");
    setFieldErrors({});
    if (!writeVisitPendingIntent(window.sessionStorage, storageKey, intent)) {
      setNotice("Браузер не дозволив безпечно зберегти запит для повторної перевірки.");
      setNoticeTone("error");
      setSubmitting(false);
      return;
    }
    setPending(intent);
    try {
      await visitApi("/api/visits/teacher", {
        method: "POST",
        body: JSON.stringify(intent.payload),
      });
      clearVisitPendingIntent(window.sessionStorage, storageKey);
      setPending(null);
      setNotice("Візит заброньовано. Він з’явився у ваших записах.");
      setNoticeTone("success");
      setPurpose("");
      setPublicDisplayConsent(false);
      await load(true);
    } catch (error) {
      if (!isUncertainVisitFailure(error)) {
        clearVisitPendingIntent(window.sessionStorage, storageKey);
        setPending(null);
      }
      setNotice(errorMessage(error));
      setNoticeTone("error");
      if (error instanceof VisitApiError) setFieldErrors(error.fieldErrors);
    } finally {
      setSubmitting(false);
    }
  }

  async function sendPatch(intent: Extract<VisitPendingIntent, { kind: "patch" }>) {
    setSubmitting(true);
    setNotice("");
    setFieldErrors({});
    if (!writeVisitPendingIntent(window.sessionStorage, storageKey, intent)) {
      setNotice("Браузер не дозволив безпечно зберегти запит для повторної перевірки.");
      setNoticeTone("error");
      setSubmitting(false);
      return;
    }
    setPending(intent);
    try {
      await visitApi(`/api/visits/teacher/${encodeURIComponent(intent.bookingId)}`, {
        method: "PATCH",
        body: JSON.stringify(intent.payload),
      });
      clearVisitPendingIntent(window.sessionStorage, storageKey);
      setPending(null);
      setEditingBooking(null);
      setPublicDisplayConsent(false);
      setNotice("Запис перенесено. Попередній час звільнено лише після успішного збереження нового.");
      setNoticeTone("success");
      await load(true);
    } catch (error) {
      if (!isUncertainVisitFailure(error)) {
        clearVisitPendingIntent(window.sessionStorage, storageKey);
        setPending(null);
      }
      setNotice(errorMessage(error));
      setNoticeTone("error");
      if (error instanceof VisitApiError) setFieldErrors(error.fieldErrors);
    } finally {
      setSubmitting(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!publicDisplayConsent) {
      setFieldErrors({ publicDisplayConsent: "Підтвердьте публічний показ вашого імені та часу." });
      setNotice("Потрібно підтвердити, що ім’я та час будуть видимі у відкритому графіку.");
      setNoticeTone("error");
      return;
    }
    if (!validVisitDuration(startTime, endTime)) {
      setNotice("Візит має тривати від 20 хвилин до 4 годин, із кроком 5 хвилин.");
      setNoticeTone("error");
      return;
    }
    const values = {
      date,
      startTime,
      endTime,
      purpose: purpose.trim() || null,
      classYearId: classYearId || null,
      publicDisplayConsent: true as const,
    };
    if (editingBooking) {
      const payload: VisitPatchPayload = {
        requestId: crypto.randomUUID(),
        expectedVersion: editingBooking.version,
        ...values,
      };
      void sendPatch({ kind: "patch", requestId: payload.requestId, bookingId: editingBooking.id, payload });
      return;
    }
    const payload: VisitCreatePayload = {
      requestId: crypto.randomUUID(),
      ...values,
    };
    void sendCreate({ kind: "create", requestId: payload.requestId, payload });
  }

  async function sendCancel(
    bookingId: string,
    payload: VisitCancelPayload,
    intent: Extract<VisitPendingIntent, { kind: "cancel" }>,
  ) {
    setSubmitting(true);
    if (!writeVisitPendingIntent(window.sessionStorage, storageKey, intent)) {
      setNotice("Браузер не дозволив безпечно зберегти запит для повторної перевірки.");
      setNoticeTone("error");
      setSubmitting(false);
      return;
    }
    setPending(intent);
    try {
      await visitApi(`/api/visits/teacher/${encodeURIComponent(bookingId)}`, {
        method: "DELETE",
        body: JSON.stringify(payload),
      });
      clearVisitPendingIntent(window.sessionStorage, storageKey);
      setPending(null);
      setNotice("Запис скасовано.");
      setNoticeTone("success");
      await load(true);
    } catch (error) {
      if (!isUncertainVisitFailure(error)) {
        clearVisitPendingIntent(window.sessionStorage, storageKey);
        setPending(null);
      }
      setNotice(errorMessage(error));
      setNoticeTone("error");
    } finally {
      setSubmitting(false);
    }
  }

  function cancelBooking(booking: VisitBooking) {
    if (!window.confirm("Скасувати цей запис до бібліотеки?")) return;
    const payload = { requestId: crypto.randomUUID(), expectedVersion: booking.version };
    void sendCancel(booking.id, payload, {
      kind: "cancel",
      requestId: payload.requestId,
      bookingId: booking.id,
      payload,
    });
  }

  function retryPending() {
    if (!pending) return;
    if (pending.kind === "create") void sendCreate(pending);
    else if (pending.kind === "patch") void sendPatch(pending);
    else void sendCancel(pending.bookingId, pending.payload, pending);
  }

  function editBooking(booking: VisitBooking) {
    setEditingBooking(booking);
    setDate(booking.date);
    setStartTime(booking.startTime);
    setEndTime(booking.endTime);
    setClassYearId(booking.classYearId || "");
    setPurpose(booking.purpose || "");
    setPublicDisplayConsent(booking.publicDisplayConsent === true);
    window.setTimeout(() => document.querySelector<HTMLElement>("#teacher-visit-form")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  function stopEditing() {
    setEditingBooking(null);
    setPurpose("");
    setClassYearId("");
    setPublicDisplayConsent(false);
  }

  const bookingEnabled = data?.bookingEnabled === true;

  return (
    <VisitShell telegramMiniApp={telegramMiniApp}>
      <section className={styles.page}>
        <div className={styles.bookingTopbar}>
          <div className={styles.intro}>
            <p className={styles.eyebrow}>Кабінет учителя</p>
            <h1>{teacherTabTitle(activeTab)}</h1>
            <p>У відкритому графіку видно лише погоджені ім’я та час. Клас, мета, замовлення й повідомлення доступні лише вам і бібліотекарю.</p>
          </div>
          <div className={styles.account}>
            <span><small>Ви увійшли як</small><strong>{teacher.fullName}</strong></span>
            <button type="button" onClick={() => setSecurityOpen(true)} disabled={signingOut || submitting || Boolean(pending)}>Безпека</button>
            <button type="button" onClick={() => void onSignOut()} disabled={signingOut || submitting || Boolean(pending)}>Вийти</button>
          </div>
        </div>

        <nav className={styles.teacherTabs} aria-label="Розділи кабінету">
          {TEACHER_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-current={activeTab === tab.id ? "page" : undefined}
              onClick={() => setActiveTab(tab.id)}
            >
              <span aria-hidden="true">{tab.icon}</span>{tab.label}
            </button>
          ))}
        </nav>

        {pending ? (
          <div className={styles.pending} role="status">
            <span>Попередній запит міг бути прийнятий, але відповідь не надійшла.</span>
            <button type="button" onClick={retryPending} disabled={submitting}>Перевірити результат</button>
          </div>
        ) : null}
        {signOutNotice ? <div className={styles.error} role="alert">{signOutNotice}</div> : null}
        {notice ? <div className={styles[noticeTone]} role={noticeTone === "error" ? "alert" : "status"}>{notice}</div> : null}

        {activeTab === "overview" ? (
          <TeacherOverview
            teacherName={teacher.fullName}
            bookings={activeBookings}
            loading={loading}
            onOpenVisits={() => setActiveTab("visits")}
            onOpenOrders={() => setActiveTab("orders")}
            onOpenAcquisition={() => setActiveTab("acquisition")}
            onOpenLoans={() => setActiveTab("loans")}
          />
        ) : null}

        {activeTab === "visits" ? <>
        <div className={styles.teacherGrid}>
          <form className={styles.card} id="teacher-visit-form" onSubmit={submit} aria-busy={submitting}>
            <div className={styles.cardHeading}>
              <div><span>{editingBooking ? "Редагування запису" : "Новий запис"}</span><h2>{editingBooking ? "Новий час і деталі" : "Дані візиту"}</h2></div>
              <span className={bookingEnabled ? styles.enabled : styles.disabled}>{bookingEnabled ? "Запис відкрито" : "Запис призупинено"}</span>
            </div>
            <div className={styles.identityBanner}>
              <span>Учитель</span><strong>{teacher.fullName}</strong><small>Ім’я підставляється з бази даних автоматично.</small>
            </div>
            <div className={styles.fields}>
              <label>Дата *
                <input required type="date" min={today} max={visitHorizonEnd(today)} value={date} aria-invalid={Boolean(fieldErrors.date)} onChange={(event) => setDate(event.currentTarget.value)} />
                {fieldErrors.date ? <small className={styles.fieldError}>{fieldErrors.date}</small> : null}
              </label>
              <label>Початок *
                <input required type="time" step={300} value={startTime} aria-invalid={Boolean(fieldErrors.startTime)} onChange={(event) => setStartTime(event.currentTarget.value)} />
                {fieldErrors.startTime ? <small className={styles.fieldError}>{fieldErrors.startTime}</small> : null}
              </label>
              <label>Завершення *
                <input required type="time" step={300} value={endTime} aria-invalid={Boolean(fieldErrors.endTime)} onChange={(event) => setEndTime(event.currentTarget.value)} />
                {fieldErrors.endTime ? <small className={styles.fieldError}>{fieldErrors.endTime}</small> : null}
              </label>
              <label>Клас
                <select value={classYearId} aria-invalid={Boolean(fieldErrors.classYearId)} onChange={(event) => setClassYearId(event.currentTarget.value)}>
                  <option value="">Без класу</option>
                  {(data?.classYears ?? []).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
                {fieldErrors.classYearId ? <small className={styles.fieldError}>{fieldErrors.classYearId}</small> : null}
              </label>
              <label className={styles.wide}>Мета візиту
                <textarea maxLength={160} value={purpose} aria-invalid={Boolean(fieldErrors.purpose)} onChange={(event) => setPurpose(event.currentTarget.value)} placeholder="Необов’язково: урок, добір літератури…" />
                {fieldErrors.purpose ? <small className={styles.fieldError}>{fieldErrors.purpose}</small> : null}
              </label>
              <label className={`${styles.wide} ${styles.publicConsent}`}>
                <input required type="checkbox" checked={publicDisplayConsent} aria-invalid={Boolean(fieldErrors.publicDisplayConsent)} onChange={(event) => { setPublicDisplayConsent(event.currentTarget.checked); setFieldErrors((current) => ({ ...current, publicDisplayConsent: "" })); }} />
                <span>Я погоджуюся, що моє ім’я та точний час цього запису будуть видимі всім у відкритому графіку. Клас і мета візиту залишаться приватними.</span>
                {fieldErrors.publicDisplayConsent ? <small className={styles.fieldError}>{fieldErrors.publicDisplayConsent}</small> : null}
              </label>
            </div>
            <div className={styles.formActions}>
              {editingBooking ? <button className={styles.quiet} type="button" onClick={stopEditing} disabled={submitting || Boolean(pending)}>Не редагувати</button> : null}
              <button className={styles.primary} type="submit" disabled={submitting || !bookingEnabled || !publicDisplayConsent || Boolean(pending)}>
                {submitting ? "Зберігаємо…" : editingBooking ? "Перенести запис" : "Забронювати час"}
              </button>
            </div>
          </form>

          <aside className={styles.card} aria-labelledby="availability-title">
            <div className={styles.cardHeading}><div><span>{date || "Оберіть дату"}</span><h2 id="availability-title">Зайняті проміжки</h2></div></div>
            {loading ? <p className={styles.empty}>Оновлюємо розклад…</p> : selectedBusy.length || selectedClosures.length ? (
              <ul className={styles.busyList}>{selectedClosures.map((period, index) => (
                <li key={`closed-${period.startTime}-${period.endTime}-${index}`}><span aria-hidden="true" /> <strong>{period.startTime}–{period.endTime}</strong><small>зачинено</small></li>
              ))}{selectedBusy.map((period, index) => (
                <li key={`${period.startTime}-${period.endTime}-${index}`}><span aria-hidden="true" /> <strong>{period.startTime}–{period.endTime}</strong><small>зайнято</small></li>
              ))}</ul>
            ) : <p className={styles.empty}>На цю дату зайнятих проміжків немає.</p>}
            {data?.hours ? <p className={styles.hours}>Години запису: {(data.hours[weekdayKey(date)] ?? []).map((range) => `${range.startTime}–${range.endTime}`).join(", ") || "зачинено"}</p> : null}
          </aside>
        </div>

        <section className={`${styles.card} ${styles.bookings}`} aria-labelledby="my-bookings-title">
          <div className={styles.cardHeading}><div><span>Лише для вас</span><h2 id="my-bookings-title">Мої майбутні записи</h2></div><button type="button" className={styles.quiet} onClick={() => void load()} disabled={loading}>↻ Оновити</button></div>
          {activeBookings.length ? <div className={styles.bookingList}>{activeBookings.map((booking) => (
            <article key={booking.id}>
              <div><strong>{formatVisitDateTime(`${booking.date}T${booking.startTime}`)}–{booking.endTime}</strong><span>{booking.classLabel || "Без класу"}{booking.purpose ? ` · ${booking.purpose}` : ""}</span></div>
              <div className={styles.bookingActions}><button type="button" className={styles.quiet} onClick={() => editBooking(booking)} disabled={!bookingEnabled || submitting || Boolean(pending)}>Редагувати</button><button type="button" className={styles.danger} onClick={() => cancelBooking(booking)} disabled={!bookingEnabled || submitting || Boolean(pending)}>Скасувати</button></div>
            </article>
          ))}</div> : <p className={styles.empty}>Майбутніх записів немає.</p>}
        </section>
        </> : null}

        {activeTab === "orders" ? <TeacherOrdersPanel pendingScope={pendingScope} initialMaterialId={initialOrderMaterialId} /> : null}
        {activeTab === "acquisition" ? <TeacherAcquisitionPanel /> : null}
        {activeTab === "loans" ? <TeacherLoansPanel /> : null}
        {activeTab === "notifications" ? <TeacherNotificationsPanel pendingScope={pendingScope} /> : null}
        {securityOpen ? <TeacherSecurityPanel pendingScope={pendingScope} onClose={() => setSecurityOpen(false)} onSessionRotated={onSessionRotated} /> : null}
      </section>
    </VisitShell>
  );
}

type TeacherCatalogItem = {
  id: string;
  title: string;
  author: string;
  year: number | null;
  thumbnailUrl: string;
  availableQuantity: number;
};

type TeacherCatalogEnvelope = {
  success: true;
  items: TeacherCatalogItem[];
};

type MaterialRequestStatus = "submitted" | "in_review" | "ready" | "partially_ready" | "completed" | "rejected" | "cancelled";

type MaterialRequest = {
  id: string;
  status: MaterialRequestStatus;
  teacherNotes: string;
  librarianNote: string | null;
  rejectionReason: string | null;
  pickupLocation: { id: string; name: string } | null;
  resultingLoanId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  items: Array<{
    id: string;
    material: { id: string; title: string; author: string; year: number | null; thumbnailUrl: string };
    requestedQuantity: number;
    approvedQuantity: number;
    fulfilledQuantity: number;
  }>;
};

type MaterialRequestsEnvelope = {
  success: true;
  requests: MaterialRequest[];
  page: { limit: number; hasMore: boolean; nextCursor: string | null };
};

type OrderMutationPayload =
  | { requestId: string; notes: string | null; items: Array<{ materialId: string; quantity: number }> }
  | { requestId: string; expectedVersion: number; reason: string | null };

type OrderPendingIntent = {
  kind: "order-create" | "order-cancel";
  requestId: string;
  resourceId?: string;
  payload: OrderMutationPayload;
};

type TeacherNotification = {
  id: string;
  type: string;
  title: string;
  message: string;
  entityType: string;
  entityId: string;
  read: boolean;
  version: number;
  createdAt: string;
  readAt: string | null;
};

type NotificationsEnvelope = {
  success: true;
  notifications: TeacherNotification[];
  page: { limit: number; hasMore: boolean; nextCursor: string | null };
  unreadCount: number;
};

type TelegramStatus = {
  configured: boolean;
  linkingEnabled: boolean;
  notificationsEnabled: boolean;
  miniAppEnabled: boolean;
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

type TelegramStatusEnvelope = { success: true; telegram: TelegramStatus };
type TelegramLinkEnvelope = { success: true; linkUrl: string; expiresAt: string };

type TeacherOwnProfile = {
  id: string;
  fullName: string;
  subjectPosition: string;
  serviceContact: string;
  primaryLocation: { id: string; name: string } | null;
  curatedClasses: Array<{
    id: string;
    className: string;
    academicYearLabel: string;
    status: string;
    location: { id: string; name: string } | null;
  }>;
  photoUrl: string | null;
  photoVersion: number;
  profileVersion: number;
  updatedAt: string;
};

type TeacherProfileEnvelope = { schemaVersion: 1; success: true; profile: TeacherOwnProfile };

function teacherTabTitle(tab: TeacherTab): string {
  if (tab === "visits") return "Мої відвідування";
  if (tab === "orders") return "Замовлення матеріалів";
  if (tab === "acquisition") return "Запропонувати придбання";
  if (tab === "loans") return "Мої посібники";
  if (tab === "notifications") return "Мої повідомлення";
  return "Вітаємо у вашому кабінеті";
}

function TeacherOverview({
  teacherName,
  bookings,
  loading,
  onOpenVisits,
  onOpenOrders,
  onOpenAcquisition,
  onOpenLoans,
}: {
  teacherName: string;
  bookings: VisitBooking[];
  loading: boolean;
  onOpenVisits: () => void;
  onOpenOrders: () => void;
  onOpenAcquisition: () => void;
  onOpenLoans: () => void;
}) {
  const nextBooking = bookings[0] ?? null;
  const [profile, setProfile] = useState<TeacherOwnProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [profileNotice, setProfileNotice] = useState("");
  const [profileNoticeTone, setProfileNoticeTone] = useState<"success" | "error">("success");

  const loadProfile = useCallback(async () => {
    setProfileLoading(true);
    try {
      const response = await visitApi<TeacherProfileEnvelope>("/api/teacher/profile");
      setProfile(response.profile);
    } catch (error) {
      setProfileNotice(errorMessage(error));
      setProfileNoticeTone("error");
    } finally {
      setProfileLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadProfile(), 0);
    return () => window.clearTimeout(timer);
  }, [loadProfile]);

  async function uploadPhoto(file: File | null) {
    if (!file || !profile || photoBusy) return;
    setPhotoBusy(true);
    setProfileNotice("");
    try {
      const prepared = await normalizeCoverPhotoForUpload(file);
      const form = new FormData();
      form.set("photo", prepared, prepared.name);
      form.set("requestId", crypto.randomUUID());
      form.set("expectedVersion", String(profile.profileVersion));
      await visitApi("/api/teacher/profile/photo", { method: "POST", body: form });
      await loadProfile();
      setProfileNotice("Фото профілю збережено.");
      setProfileNoticeTone("success");
    } catch (error) {
      setProfileNotice(errorMessage(error));
      setProfileNoticeTone("error");
    } finally {
      setPhotoBusy(false);
    }
  }

  async function deletePhoto() {
    if (!profile?.photoUrl || photoBusy || !window.confirm("Видалити фото профілю?")) return;
    setPhotoBusy(true);
    setProfileNotice("");
    try {
      await visitApi("/api/teacher/profile/photo", {
        method: "DELETE",
        body: JSON.stringify({ requestId: crypto.randomUUID(), expectedVersion: profile.profileVersion }),
      });
      await loadProfile();
      setProfileNotice("Фото профілю видалено.");
      setProfileNoticeTone("success");
    } catch (error) {
      setProfileNotice(errorMessage(error));
      setProfileNoticeTone("error");
    } finally {
      setPhotoBusy(false);
    }
  }

  return (
    <section className={styles.overviewGrid} aria-label="Огляд кабінету">
      <article className={`${styles.card} ${styles.welcomeCard}`}>
        <div className={styles.profileSummary}>
          <div className={styles.profilePortrait}>
            {profile?.photoUrl
              ? <img src={profile.photoUrl} alt={`Фото ${teacherName}`} />
              : <span aria-hidden="true">{teacherInitials(teacherName)}</span>}
          </div>
          <div className={styles.profileDetails}>
            <span>Підтверджений профіль</span>
            <h2>{teacherName}</h2>
            {profileLoading ? <p>Оновлюємо відомості…</p> : profile ? (
              <dl>
                <div><dt>Предмет / посада</dt><dd>{profile.subjectPosition || "Не вказано"}</dd></div>
                <div><dt>Основний кабінет</dt><dd>{profile.primaryLocation?.name || "Не вказано"}</dd></div>
                <div><dt>Куратор класу</dt><dd>{profile.curatedClasses.length
                  ? profile.curatedClasses.map((item) => `${item.className}${item.location?.name ? ` · ${item.location.name}` : ""}`).join(", ")
                  : "Не призначено"}</dd></div>
                {profile.serviceContact ? <div><dt>Службовий контакт</dt><dd>{profile.serviceContact}</dd></div> : null}
              </dl>
            ) : <p>Відомості профілю зараз недоступні.</p>}
          </div>
        </div>
        <div className={styles.photoActions} aria-label="Фото профілю">
          <label className={styles.quiet} aria-disabled={photoBusy || !profile}>
            <input type="file" accept="image/jpeg,image/png,image/webp" capture="user" disabled={photoBusy || !profile} onChange={(event) => { const file = event.currentTarget.files?.[0] ?? null; event.currentTarget.value = ""; void uploadPhoto(file); }} />
            Зробити фото
          </label>
          <label className={styles.quiet} aria-disabled={photoBusy || !profile}>
            <input type="file" accept="image/jpeg,image/png,image/webp" disabled={photoBusy || !profile} onChange={(event) => { const file = event.currentTarget.files?.[0] ?? null; event.currentTarget.value = ""; void uploadPhoto(file); }} />
            Обрати з галереї
          </label>
          {profile?.photoUrl ? <button className={styles.danger} type="button" disabled={photoBusy} onClick={() => void deletePhoto()}>Видалити фото</button> : null}
        </div>
        {profileNotice ? <div className={styles[profileNoticeTone]} role={profileNoticeTone === "error" ? "alert" : "status"}>{profileNotice}</div> : null}
        <p className={styles.profilePrivacy}>Фото бачите ви та бібліотекар. Воно не публікується у відкритому каталозі чи графіку.</p>
      </article>
      <article className={styles.card}>
        <div className={styles.cardHeading}><div><span>Найближче</span><h2>Відвідування</h2></div></div>
        {loading ? <p className={styles.empty}>Оновлюємо…</p> : nextBooking ? (
          <p className={styles.nextVisit}><strong>{formatVisitDateTime(`${nextBooking.date}T${nextBooking.startTime}`)}–{nextBooking.endTime}</strong><span>{nextBooking.classLabel || "Без класу"}</span></p>
        ) : <p className={styles.empty}>Майбутніх записів немає.</p>}
        <button className={styles.quiet} type="button" onClick={onOpenVisits}>Відкрити графік</button>
      </article>
      <article className={styles.card}>
        <div className={styles.cardHeading}><div><span>Каталог</span><h2>Потрібні матеріали</h2></div></div>
        <p className={styles.empty}>Знайдіть підручники або інші матеріали й надішліть одне замовлення бібліотекарю.</p>
        <button className={styles.quiet} type="button" onClick={onOpenOrders}>Створити замовлення</button>
      </article>
      <article className={styles.card}>
        <div className={styles.cardHeading}><div><span>Комплектування</span><h2>Запропонувати придбання</h2></div></div>
        <p className={styles.empty}>Дозамовте примірники, яких бракує, або запропонуйте нове видання для фонду.</p>
        <button className={styles.quiet} type="button" onClick={onOpenAcquisition}>Створити пропозицію</button>
      </article>
      <article className={styles.card}>
        <div className={styles.cardHeading}><div><span>Облік</span><h2>Видані посібники</h2></div></div>
        <p className={styles.empty}>Перегляньте все, що записано особисто на вас і на класи, за які ви відповідаєте.</p>
        <button className={styles.quiet} type="button" onClick={onOpenLoans}>Переглянути посібники</button>
      </article>
    </section>
  );
}

type TeacherLoanItem = {
  materialId: string;
  materialTitle: string;
  materialAuthor: string;
  materialYear: number | null;
  sourceLocationName: string;
  quantityOutstanding: number;
};

type TeacherPersonalLoan = {
  loanId: string;
  issuedAt: string;
  dueAt: string | null;
  notes: string;
  items: TeacherLoanItem[];
};

type TeacherClassLoan = {
  classLoanId: string;
  className: string;
  academicYearLabel: string;
  responsibleTeacherName: string;
  issuedAt: string;
  dueAt: string | null;
  notes: string;
  relationship: { curator: boolean; responsible: boolean };
  items: TeacherLoanItem[];
};

type TeacherLoansEnvelope = {
  success: true;
  summary: {
    personalCopies: number;
    classCopies: number;
    totalCopies: number;
    classCount: number;
  };
  personalLoans: TeacherPersonalLoan[];
  classLoans: TeacherClassLoan[];
};

function TeacherLoansPanel() {
  const [data, setData] = useState<TeacherLoansEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await visitApi<TeacherLoansEnvelope>("/api/teacher/loans"));
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <section className={styles.teacherLoans} aria-labelledby="teacher-loans-title">
      <div className={styles.cardHeading}>
        <div><span>Лише для вас</span><h2 id="teacher-loans-title">Що записано на вас</h2></div>
        <button className={styles.quiet} type="button" onClick={() => void load()} disabled={loading}>↻ Оновити</button>
      </div>
      {error ? <div className={styles.error} role="alert">{error}</div> : null}
      <div className={styles.loanCounters} aria-label="Підсумок виданих посібників">
        <article><span>Усього</span><strong>{data?.summary.totalCopies ?? 0}</strong><small>примірників</small></article>
        <article><span>Особисто на вас</span><strong>{data?.summary.personalCopies ?? 0}</strong><small>примірників</small></article>
        <article><span>На класах</span><strong>{data?.summary.classCopies ?? 0}</strong><small>{data?.summary.classCount ?? 0} класів</small></article>
      </div>
      {loading ? <p className={styles.empty}>Оновлюємо список посібників…</p> : null}
      {!loading && data ? (
        <div className={styles.loanSections}>
          <section className={styles.card} aria-labelledby="personal-loans-title">
            <div className={styles.cardHeading}><div><span>{data.summary.personalCopies} прим.</span><h2 id="personal-loans-title">Особисто на вас</h2></div></div>
            {data.personalLoans.length ? (
              <div className={styles.teacherLoanList}>{data.personalLoans.map((loan) => (
                <article key={loan.loanId}>
                  <header><span>Видано {formatPortalDay(loan.issuedAt)}</span><small>{loan.dueAt ? `Повернути до ${formatPortalDay(loan.dueAt)}` : "Без строку"}</small></header>
                  {loan.items.map((item) => <TeacherLoanItemRow key={`${loan.loanId}-${item.materialId}`} item={item} />)}
                  {loan.notes ? <p>{loan.notes}</p> : null}
                </article>
              ))}</div>
            ) : <p className={styles.empty}>Особистих неповернених видач немає.</p>}
          </section>
          <section className={styles.card} aria-labelledby="class-loans-title">
            <div className={styles.cardHeading}><div><span>{data.summary.classCopies} прим.</span><h2 id="class-loans-title">На класах</h2></div></div>
            {data.classLoans.length ? (
              <div className={styles.teacherLoanList}>{data.classLoans.map((loan) => (
                <article key={loan.classLoanId}>
                  <header>
                    <span>{loan.className} · {loan.academicYearLabel}</span>
                    <small>{classLoanRoleLabel(loan.relationship)}</small>
                  </header>
                  <div className={styles.loanMeta}>Видано {formatPortalDay(loan.issuedAt)}{loan.dueAt ? ` · повернути до ${formatPortalDay(loan.dueAt)}` : " · без строку"} · відповідальний: {loan.responsibleTeacherName}</div>
                  {loan.items.map((item) => <TeacherLoanItemRow key={`${loan.classLoanId}-${item.materialId}`} item={item} />)}
                  {loan.notes ? <p>{loan.notes}</p> : null}
                </article>
              ))}</div>
            ) : <p className={styles.empty}>Неповернених комплектів відповідальних класів немає.</p>}
          </section>
        </div>
      ) : null}
    </section>
  );
}

function TeacherLoanItemRow({ item }: { item: TeacherLoanItem }) {
  return (
    <div className={styles.teacherLoanItem}>
      <div><strong>{item.materialTitle}</strong><small>{[item.materialAuthor, item.materialYear, item.materialId].filter(Boolean).join(" · ")}</small><small>{item.sourceLocationName}</small></div>
      <span><strong>{item.quantityOutstanding}</strong><small>залишилось</small></span>
    </div>
  );
}

function classLoanRoleLabel(relationship: TeacherClassLoan["relationship"]): string {
  if (relationship.curator && relationship.responsible) return "Ви куратор і відповідальний за видачу";
  if (relationship.curator) return "Ви куратор класу";
  return "Ви відповідальний за видачу";
}

function teacherInitials(fullName: string): string {
  return fullName.trim().split(/\s+/u).slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("uk-UA") ?? "").join("") || "В";
}

function TeacherOrdersPanel({ pendingScope, initialMaterialId }: { pendingScope: string; initialMaterialId: string }) {
  const [query, setQuery] = useState(initialMaterialId);
  const [items, setItems] = useState<TeacherCatalogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [noticeTone, setNoticeTone] = useState<"success" | "error" | "info">("info");
  const [cart, setCart] = useState<Record<string, { item: TeacherCatalogItem; quantity: number }>>({});
  const [notes, setNotes] = useState("");
  const [requests, setRequests] = useState<MaterialRequest[]>([]);
  const [requestPage, setRequestPage] = useState<MaterialRequestsEnvelope["page"] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pending, setPending] = useState<OrderPendingIntent | null>(null);
  const initialMaterialApplied = useRef(false);
  const normalizedQuery = query.trim();
  const storageKey = `library.teacher.orders.pending.v1:${pendingScope}`;

  const loadRequests = useCallback(async (afterMutation = false, cursor: string | null = null) => {
    const append = Boolean(cursor);
    if (append) setHistoryLoadingMore(true);
    else setHistoryLoading(true);
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (cursor) params.set("cursor", cursor);
      const response = await visitApi<MaterialRequestsEnvelope>(`/api/teacher/material-requests?${params.toString()}`);
      setRequests((current) => append ? mergePortalPageById(current, response.requests) : response.requests);
      setRequestPage(response.page);
    } catch (error) {
      setNotice(afterMutation
        ? "Дію збережено, але історію замовлень не вдалося оновити. Натисніть «Оновити»."
        : append
          ? "Не вдалося завантажити наступні замовлення. Спробуйте ще раз."
          : errorMessage(error));
      setNoticeTone(afterMutation ? "info" : "error");
    } finally {
      if (append) setHistoryLoadingMore(false);
      else setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPending(readPortalPendingIntent<OrderPendingIntent>(window.sessionStorage, storageKey, ["order-create", "order-cancel"]));
      void loadRequests();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadRequests, storageKey]);

  useEffect(() => {
    if (normalizedQuery.length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setNotice("");
      try {
        const params = new URLSearchParams({ q: normalizedQuery, available: "true", limit: "12" });
        const response = await visitApi<TeacherCatalogEnvelope>(`/api/catalog-v2?${params.toString()}`, { signal: controller.signal });
        setItems(response.items);
        if (initialMaterialId && !initialMaterialApplied.current) {
          initialMaterialApplied.current = true;
          const selected = response.items.find((item) => item.id === initialMaterialId);
          if (selected) {
            setCart((current) => current[selected.id]
              ? current
              : { ...current, [selected.id]: { item: selected, quantity: 1 } });
            setNotice(`«${selected.title}» додано до кошика. Перевірте кількість і надішліть замовлення.`);
            setNoticeTone("success");
          } else {
            setNotice("Цей матеріал зараз недоступний для замовлення. Можна знайти інший у каталозі нижче.");
            setNoticeTone("info");
          }
        }
        if (!response.items.length) {
          if (!initialMaterialId) setNotice("За цим запитом доступних матеріалів не знайдено.");
          setNoticeTone("info");
        }
      } catch {
        if (!controller.signal.aborted) {
          setNotice("Не вдалося виконати пошук у каталозі.");
          setNoticeTone("error");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [initialMaterialId, normalizedQuery]);

  function changeQuery(value: string) {
    setQuery(value);
    if (value.trim().length < 2) {
      setItems([]);
      setLoading(false);
      setNotice("");
    }
  }

  async function sendOrderIntent(intent: OrderPendingIntent) {
    if (!writePortalPendingIntent(window.sessionStorage, storageKey, intent)) {
      setNotice("Браузер не дозволив безпечно зберегти замовлення для повторної перевірки.");
      setNoticeTone("error");
      return;
    }
    setPending(intent);
    setSubmitting(true);
    setNotice("");
    try {
      const suffix = intent.kind === "order-cancel" && intent.resourceId ? `/${encodeURIComponent(intent.resourceId)}` : "";
      await visitApi<{ success: true; request: MaterialRequest }>(`/api/teacher/material-requests${suffix}`, {
        method: intent.kind === "order-create" ? "POST" : "DELETE",
        body: JSON.stringify(intent.payload),
      });
      clearPortalPendingIntent(window.sessionStorage, storageKey);
      setPending(null);
      setNotice(intent.kind === "order-create" ? "Замовлення надіслано бібліотекарю." : "Замовлення скасовано.");
      setNoticeTone("success");
      if (intent.kind === "order-create") {
        setCart({});
        setNotes("");
      }
      await loadRequests(true);
    } catch (error) {
      if (!isUncertainVisitFailure(error)) {
        clearPortalPendingIntent(window.sessionStorage, storageKey);
        setPending(null);
      }
      setNotice(errorMessage(error));
      setNoticeTone("error");
    } finally {
      setSubmitting(false);
    }
  }

  function submitOrder() {
    if (!cartRows.length || pending) return;
    const requestId = crypto.randomUUID();
    const payload = {
      requestId,
      notes: notes.trim() || null,
      items: cartRows.map(({ item, quantity }) => ({ materialId: item.id, quantity })),
    };
    void sendOrderIntent({ kind: "order-create", requestId, payload });
  }

  function cancelOrder(request: MaterialRequest) {
    if (!window.confirm("Скасувати це замовлення?")) return;
    const requestId = crypto.randomUUID();
    const payload = { requestId, expectedVersion: request.version, reason: null };
    void sendOrderIntent({ kind: "order-cancel", requestId, resourceId: request.id, payload });
  }

  function add(item: TeacherCatalogItem) {
    const currentQuantity = cart[item.id]?.quantity ?? 0;
    if (currentQuantity >= item.availableQuantity) {
      setNotice(`У кошику вже вся доступна кількість «${item.title}».`);
      setNoticeTone("info");
      return;
    }
    setCart((current) => {
      const existing = current[item.id];
      const quantity = Math.min(item.availableQuantity, (existing?.quantity ?? 0) + 1);
      return { ...current, [item.id]: { item, quantity } };
    });
    const nextQuantity = currentQuantity + 1;
    setNotice(currentQuantity
      ? `Кількість «${item.title}» у кошику збільшено до ${nextQuantity}.`
      : `«${item.title}» додано до кошика.`);
    setNoticeTone("success");
  }

  function updateQuantity(id: string, quantity: number) {
    setCart((current) => {
      const existing = current[id];
      if (!existing) return current;
      if (quantity <= 0) {
        const next = { ...current };
        delete next[id];
        return next;
      }
      return { ...current, [id]: { ...existing, quantity: Math.min(existing.item.availableQuantity, quantity) } };
    });
  }

  const cartRows = Object.values(cart);
  return (
    <section aria-labelledby="orders-title">
      {pending ? <div className={styles.pending} role="status"><span>Результат попередньої дії із замовленням не підтверджено.</span><button type="button" onClick={() => void sendOrderIntent(pending)} disabled={submitting}>Перевірити результат</button></div> : null}
      {notice ? <div className={styles[noticeTone]} role={noticeTone === "error" ? "alert" : "status"}>{notice}</div> : null}
      <div className={styles.orderLayout}>
      <div className={styles.card}>
        <div className={styles.cardHeading}><div><span>Крок 1</span><h2 id="orders-title">Знайдіть матеріали</h2></div></div>
        <label className={styles.portalSearch}>Назва, автор або CAT-ID
          <input type="search" value={query} onChange={(event) => changeQuery(event.currentTarget.value)} placeholder="Введіть щонайменше 2 символи" autoComplete="off" />
        </label>
        <div className={styles.searchStatus} role="status" aria-live="polite">{loading ? "Шукаємо…" : ""}</div>
        {items.length ? <div className={styles.catalogCards}>{items.map((item) => {
          const cartQuantity = cart[item.id]?.quantity ?? 0;
          const maximumInCart = cartQuantity >= item.availableQuantity;
          return <article key={item.id}>
            <TeacherCover item={item} />
            <div><strong>{item.title}</strong><span>{[item.author || "Автор не вказаний", item.year || "Рік не вказано"].join(" · ")}</span><small>{item.availableQuantity} доступно</small></div>
            <button type="button" onClick={() => add(item)} disabled={item.availableQuantity < 1 || maximumInCart || cartRows.length >= 10 && !cart[item.id]}>
              {maximumInCart ? "У кошику" : cartQuantity > 0 ? "Додати ще" : "Додати"}
            </button>
          </article>
        })}</div> : null}
      </div>
      <aside className={styles.card} aria-labelledby="cart-title">
        <div className={styles.cardHeading}><div><span>Крок 2 · до 10 позицій</span><h2 id="cart-title">Кошик</h2></div><strong>{cartRows.length}/10</strong></div>
        {cartRows.length ? <ul className={styles.cartList}>{cartRows.map(({ item, quantity }) => (
          <li key={item.id}>
            <span><strong>{item.title}</strong><small>{item.id}</small></span>
            <label>Кількість<input type="number" min="0" max={item.availableQuantity} value={quantity} onChange={(event) => updateQuantity(item.id, Number(event.currentTarget.value))} /></label>
            <button type="button" onClick={() => updateQuantity(item.id, 0)} aria-label={`Прибрати ${item.title} з кошика`}>×</button>
          </li>
        ))}</ul> : <p className={styles.empty}>Додайте матеріали з результатів пошуку.</p>}
        <label className={styles.portalSearch}>Примітка бібліотекарю
          <textarea maxLength={300} value={notes} onChange={(event) => setNotes(event.currentTarget.value)} placeholder="Необов’язково: для якого уроку або класу" />
        </label>
        <button className={styles.primary} type="button" onClick={submitOrder} disabled={!cartRows.length || submitting || Boolean(pending)}>{submitting ? "Надсилаємо…" : "Надіслати замовлення"}</button>
        <p className={styles.authHelp}>Фактичний залишок бібліотекар перевірить під час підготовки замовлення.</p>
      </aside>
      </div>
      <section className={`${styles.card} ${styles.requestHistory}`} aria-labelledby="request-history-title">
        <div className={styles.cardHeading}><div><span>Лише для вас</span><h2 id="request-history-title">Історія замовлень</h2></div><button className={styles.quiet} type="button" onClick={() => void loadRequests()} disabled={historyLoading || historyLoadingMore || submitting}>↻ Оновити</button></div>
        {historyLoading ? <p className={styles.empty}>Оновлюємо замовлення…</p> : requests.length ? <div className={styles.requestList}>{requests.map((request) => (
          <article key={request.id}>
            <header><span className={styles.requestStatus} data-status={request.status}>{materialRequestStatusLabel(request.status)}</span><time dateTime={request.createdAt}>{formatPortalDate(request.createdAt)}</time></header>
            <ul>{request.items.map((item) => <li key={item.id}><span><strong>{item.material.title}</strong><small>{[item.material.author, item.material.year].filter(Boolean).join(" · ")}</small></span><span>{item.approvedQuantity ? `${item.approvedQuantity} із ${item.requestedQuantity}` : `${item.requestedQuantity} запитано`}</span></li>)}</ul>
            {request.pickupLocation ? <p>Отримання: <strong>{request.pickupLocation.name}</strong></p> : null}
            {request.rejectionReason ? <p className={styles.requestReason}>{request.rejectionReason}</p> : null}
            {request.status === "submitted" ? <button className={styles.danger} type="button" onClick={() => cancelOrder(request)} disabled={submitting || Boolean(pending)}>Скасувати замовлення</button> : null}
          </article>
        ))}</div> : <p className={styles.empty}>Замовлень ще немає.</p>}
        {requestPage?.hasMore && requestPage.nextCursor ? <button className={styles.loadMore} type="button" onClick={() => void loadRequests(false, requestPage.nextCursor)} disabled={historyLoading || historyLoadingMore || submitting}>{historyLoadingMore ? "Завантажуємо…" : "Завантажити ще"}</button> : null}
      </section>
    </section>
  );
}

function TeacherCover({ item }: { item: TeacherCatalogItem }) {
  return item.thumbnailUrl
    ? <img className={styles.orderCover} src={item.thumbnailUrl} alt="" width="54" height="78" loading="lazy" />
    : <span className={styles.orderCoverFallback} aria-hidden="true">{item.title.slice(0, 1)}</span>;
}

type NotificationPendingIntent = {
  kind: "notification-read";
  requestId: string;
  resourceId: string;
  payload: { requestId: string; expectedVersion: number; read: true };
};

function TeacherNotificationsPanel({ pendingScope }: { pendingScope: string }) {
  const [data, setData] = useState<NotificationsEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<NotificationPendingIntent | null>(null);
  const storageKey = `library.teacher.notifications.pending.v1:${pendingScope}`;

  const load = useCallback(async (afterMutation = false, cursor: string | null = null) => {
    const append = Boolean(cursor);
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (cursor) params.set("cursor", cursor);
      const response = await visitApi<NotificationsEnvelope>(`/api/teacher/notifications?${params.toString()}`);
      setData((current) => append && current
        ? { ...response, notifications: mergePortalPageById(current.notifications, response.notifications) }
        : response);
    } catch (error) {
      setNotice(afterMutation
        ? "Позначку збережено, але список повідомлень не вдалося оновити. Натисніть «Оновити»."
        : append
          ? "Не вдалося завантажити наступні повідомлення. Спробуйте ще раз."
          : errorMessage(error));
    } finally {
      if (append) setLoadingMore(false);
      else setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPending(readPortalPendingIntent<NotificationPendingIntent>(window.sessionStorage, storageKey, ["notification-read"]));
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load, storageKey]);

  async function sendRead(intent: NotificationPendingIntent) {
    if (!writePortalPendingIntent(window.sessionStorage, storageKey, intent)) {
      setNotice("Браузер не дозволив зберегти дію для повторної перевірки.");
      return;
    }
    setPending(intent);
    setSubmitting(true);
    setNotice("");
    try {
      await visitApi(`/api/teacher/notifications/${encodeURIComponent(intent.resourceId)}`, {
        method: "PATCH",
        body: JSON.stringify(intent.payload),
      });
      clearPortalPendingIntent(window.sessionStorage, storageKey);
      setPending(null);
      await load(true);
    } catch (error) {
      if (!isUncertainVisitFailure(error)) {
        clearPortalPendingIntent(window.sessionStorage, storageKey);
        setPending(null);
      }
      setNotice(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  function markRead(notification: TeacherNotification) {
    const requestId = crypto.randomUUID();
    void sendRead({
      kind: "notification-read",
      requestId,
      resourceId: notification.id,
      payload: { requestId, expectedVersion: notification.version, read: true },
    });
  }

  return (
    <div className={styles.notificationStack}>
      <TeacherTelegramSettings />
      <section className={styles.card} aria-labelledby="notifications-title">
      <div className={styles.cardHeading}><div><span>{data?.unreadCount ?? 0} непрочитаних</span><h2 id="notifications-title">Повідомлення</h2></div><button className={styles.quiet} type="button" onClick={() => void load()} disabled={loading || loadingMore || submitting}>↻ Оновити</button></div>
      {pending ? <div className={styles.pending} role="status"><span>Не вдалося підтвердити позначку «прочитано».</span><button type="button" onClick={() => void sendRead(pending)} disabled={submitting}>Перевірити результат</button></div> : null}
      {notice ? <div className={styles.error} role="alert">{notice}</div> : null}
      {loading ? <p className={styles.empty}>Оновлюємо повідомлення…</p> : data?.notifications.length ? <div className={styles.notificationList}>{data.notifications.map((notification) => (
        <article key={notification.id} data-unread={!notification.read || undefined}>
          <span aria-hidden="true" />
          <div><header><strong>{notification.title}</strong><time dateTime={notification.createdAt}>{formatPortalDate(notification.createdAt)}</time></header><p>{notification.message}</p></div>
          {!notification.read ? <button className={styles.quiet} type="button" onClick={() => markRead(notification)} disabled={submitting || Boolean(pending)}>Позначити прочитаним</button> : <small>Прочитано</small>}
        </article>
      ))}</div> : <p className={styles.empty}>Повідомлень ще немає.</p>}
      {data?.page.hasMore && data.page.nextCursor ? <button className={styles.loadMore} type="button" onClick={() => void load(false, data.page.nextCursor)} disabled={loading || loadingMore || submitting}>{loadingMore ? "Завантажуємо…" : "Завантажити ще"}</button> : null}
      </section>
    </div>
  );
}

function TeacherTelegramSettings() {
  const [telegram, setTelegram] = useState<TelegramStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"link" | "toggle" | "test" | "disconnect" | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [notice, setNotice] = useState("");
  const [noticeTone, setNoticeTone] = useState<"success" | "error" | "info">("info");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await visitApi<TelegramStatusEnvelope>("/api/teacher/telegram");
      setTelegram(response.telegram);
      setConfirmDisconnect(false);
    } catch (error) {
      setNotice(errorMessage(error));
      setNoticeTone("error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    function refreshAfterTelegram() {
      if (document.visibilityState !== "visible") return;
      setBusy(null);
      void load();
    }
    window.addEventListener("pageshow", refreshAfterTelegram);
    document.addEventListener("visibilitychange", refreshAfterTelegram);
    return () => {
      window.removeEventListener("pageshow", refreshAfterTelegram);
      document.removeEventListener("visibilitychange", refreshAfterTelegram);
    };
  }, [load]);

  async function connect() {
    setBusy("link"); setNotice("");
    try {
      const response = await visitApi<TelegramLinkEnvelope>("/api/teacher/telegram/link", { method: "POST" });
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
      const response = await visitApi<TelegramStatusEnvelope>("/api/teacher/telegram", {
        method: "PATCH",
        body: JSON.stringify({
          notifyOrders: nextEnabled,
          notifyVisits: nextEnabled,
          expectedVersion: telegram.version,
        }),
      });
      setTelegram(response.telegram);
      setNotice(nextEnabled ? "Telegram-сповіщення увімкнено." : "Telegram-сповіщення вимкнено.");
      setNoticeTone("success");
    } catch (error) {
      setNotice(errorMessage(error)); setNoticeTone("error");
    } finally { setBusy(null); }
  }

  async function sendTest() {
    setBusy("test"); setNotice("");
    try {
      await visitApi("/api/teacher/telegram/test", { method: "POST" });
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
      const response = await visitApi<TelegramStatusEnvelope>("/api/teacher/telegram/disconnect", {
        method: "POST",
        body: JSON.stringify({
          expectedVersion: telegram.version,
          confirmation: "disconnect_telegram",
        }),
      });
      setTelegram(response.telegram);
      setConfirmDisconnect(false);
      setNotice("Telegram від’єднано від кабінету."); setNoticeTone("success");
    } catch (error) {
      setNotice(errorMessage(error)); setNoticeTone("error");
    } finally { setBusy(null); }
  }

  const notificationsOn = Boolean(telegram?.notifyOrders || telegram?.notifyVisits);
  const statusLabel = telegram?.connected
    ? "Підключено"
    : telegram?.status === "blocked"
      ? "Бот заблоковано в Telegram"
      : "Не підключено";

  return (
    <section className={`${styles.card} ${styles.telegramPanel}`} aria-labelledby="teacher-telegram-title">
      <div className={styles.cardHeading}>
        <div><span>Дублювання повідомлень</span><h2 id="teacher-telegram-title">Telegram</h2></div>
        <strong className={telegram?.connected ? styles.telegramConnected : styles.telegramDisconnected}>{loading ? "Перевіряємо…" : statusLabel}</strong>
      </div>
      <p className={styles.telegramIntro}>Підключіть особистий приватний чат із ботом. Повідомлення в кабінеті залишаться основними й не зникнуть.</p>
      {notice ? <div className={styles[noticeTone]} role={noticeTone === "error" ? "alert" : "status"}>{notice}</div> : null}
      {!loading && telegram && (!telegram.configured || !telegram.linkingEnabled) ? (
        <div className={styles.info}>Telegram ще налаштовується бібліотекарем. Тут не потрібно вводити номер телефону чи email.</div>
      ) : null}
      {!loading && telegram?.connected ? (
        <>
          {telegram.miniAppEnabled ? <div className={styles.info}>У боті доступна кнопка «Кабінет учителя»: каталог, замовлення, записи, посібники та повідомлення відкриваються прямо в Telegram.</div> : null}
          <div className={styles.info}>Сповіщення про замовлення та відвідування: <strong>{notificationsOn ? "увімкнено 🔔" : "вимкнено 🔕"}</strong>. Бот і швидкий вхід залишаються підключеними в обох режимах.</div>
          {!telegram.notificationsEnabled ? <div className={styles.info}>Підключення готове, але надсилання повідомлень ще не ввімкнено бібліотекарем.</div> : null}
          <div className={styles.telegramActions}>
            <button className={styles.primary} type="button" onClick={() => void toggleNotifications()} disabled={Boolean(busy)}>{busy === "toggle" ? "Змінюємо…" : notificationsOn ? "🔕 Вимкнути сповіщення" : "🔔 Увімкнути сповіщення"}</button>
            <button className={styles.quiet} type="button" onClick={() => void sendTest()} disabled={Boolean(busy) || !telegram.notificationsEnabled || !notificationsOn}>{busy === "test" ? "Надсилаємо…" : "Надіслати тест"}</button>
            <button className={styles.danger} type="button" onClick={() => setConfirmDisconnect(true)} disabled={Boolean(busy)}>Від’єднати Telegram</button>
          </div>
          {confirmDisconnect ? <div className={styles.info} role="alert"><p>Повне від’єднання вимкне автовхід через цього бота. Сповіщення можна лише вимкнути кнопкою вище.</p><div className={styles.telegramActions}><button className={styles.danger} type="button" onClick={() => void disconnect()} disabled={Boolean(busy)}>{busy === "disconnect" ? "Від’єднуємо…" : "Так, від’єднати"}</button><button className={styles.quiet} type="button" onClick={() => setConfirmDisconnect(false)} disabled={Boolean(busy)}>Скасувати</button></div></div> : null}
        </>
      ) : !loading && telegram?.linkingEnabled && telegram.configured ? (
        <div className={styles.telegramActions}>
          <button className={styles.primary} type="button" onClick={() => void connect()} disabled={Boolean(busy)}>{busy === "link" ? "Створюємо посилання…" : telegram.status === "blocked" ? "Підключити повторно" : "Підключити Telegram"}</button>
          <button className={styles.quiet} type="button" onClick={() => void load()} disabled={Boolean(busy)}>Я вже підключив(ла) — перевірити</button>
        </div>
      ) : null}
    </section>
  );
}

type CodeRotationEnvelope = {
  success: true;
  credentialVersion: number;
  expiresAt: string;
  pendingScope: string;
  mustChangePin: false;
};

type CodeRotationIntent = {
  requestId: string;
  payload: { requestId: string; currentCode: string; newPin: string };
};

function TeacherSecurityPanel({
  pendingScope,
  onClose,
  onSessionRotated,
  required = false,
  initialCurrentCode = "",
}: {
  pendingScope: string;
  onClose: () => void;
  onSessionRotated: (session: Pick<VisitTeacherSessionEnvelope, "pendingScope" | "expiresAt" | "mustChangePin">) => void;
  required?: boolean;
  initialCurrentCode?: string;
}) {
  const [currentCode, setCurrentCode] = useState(initialCurrentCode);
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [showPin, setShowPin] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");
  const [noticeTone, setNoticeTone] = useState<"success" | "error" | "info">("info");
  const [pendingRotation, setPendingRotation] = useState<CodeRotationIntent | null>(null);
  const [rotated, setRotated] = useState(false);
  const strength = teacherPinStrength(newPin);
  const confirmationComplete = normalizedTeacherPin(confirmPin).length === 4;
  const pinsMatch = confirmationComplete
    && normalizedTeacherPin(confirmPin) === normalizedTeacherPin(newPin);

  useEffect(() => {
    function escape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape" && !submitting && !required) onClose();
    }
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose, required, submitting]);

  async function sendRotation(intent: CodeRotationIntent) {
    setPendingRotation(intent);
    setSubmitting(true);
    setNotice("");
    try {
      const response = await visitApi<CodeRotationEnvelope>("/api/teacher/security/code", {
        method: "POST",
        body: JSON.stringify(intent.payload),
      });
      setPendingRotation(null);
      setRotated(true);
      setCurrentCode("");
      setNotice("Новий PIN активний. Надалі входьте за своїм ім’ям і цими 4 цифрами.");
      setNoticeTone("success");
      clearTeacherPortalPendingStorage(window.sessionStorage, pendingScope);
      onSessionRotated({ pendingScope: response.pendingScope, expiresAt: response.expiresAt, mustChangePin: false });
    } catch (error) {
      setNotice(isUncertainVisitFailure(error)
        ? "Результат зміни PIN не підтверджено. Не закривайте вікно: повторіть той самий запит. PIN не зберігається у браузерному сховищі."
        : errorMessage(error));
      setNoticeTone("error");
      if (!isUncertainVisitFailure(error)) setPendingRotation(null);
    } finally {
      setSubmitting(false);
    }
  }

  function submitRotation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!teacherAccessCodeComplete(currentCode) || !strength.strong || !pinsMatch) return;
    const requestId = crypto.randomUUID();
    void sendRotation({
      requestId,
      payload: {
        requestId,
        currentCode: normalizedTeacherAccessCode(currentCode),
        newPin: normalizedTeacherPin(newPin),
      },
    });
  }

  return (
    <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => {
      if (!required && event.target === event.currentTarget) onClose();
    }}>
      <section className={`${styles.card} ${styles.securityDialog}`} role="dialog" aria-modal="true" aria-labelledby="security-title">
        <div className={styles.cardHeading}><div><span>{required ? "Перший вхід" : "Безпека"}</span><h2 id="security-title">{required ? "Створіть власний PIN" : "Змінити PIN"}</h2></div>{!required ? <button className={styles.quiet} type="button" onClick={onClose} aria-label="Закрити" disabled={submitting}>×</button> : null}</div>
        <p className={styles.empty}>PIN складається з 4 цифр. Після зміни попередній код і старі сеанси перестануть працювати.</p>
        {notice ? <div className={styles[noticeTone]} role={noticeTone === "error" ? "alert" : "status"}>{notice}</div> : null}
        <form onSubmit={submitRotation}>
          <div className={styles.fields}>
            {initialCurrentCode && required ? <div className={`${styles.wide} ${styles.success}`} role="status">Тимчасовий код бібліотекаря підтверджено.</div> : <label className={styles.wide}>Поточний код або PIN *<input required type="password" inputMode="text" autoComplete="current-password" maxLength={11} value={currentCode} onChange={(event) => setCurrentCode(formatTeacherAccessCode(event.currentTarget.value))} placeholder="4 цифри" pattern="(?:[0-9]{4}|[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5})" disabled={submitting || rotated || Boolean(pendingRotation)} /></label>}
            <label className={styles.wide}>Новий PIN *
              <span className={styles.generatedCode}><input required type={showPin ? "text" : "password"} inputMode="numeric" autoComplete="new-password" maxLength={4} value={newPin} onChange={(event) => { setNewPin(normalizedTeacherPin(event.currentTarget.value)); setRotated(false); }} placeholder="••••" pattern="[0-9]{4}" aria-invalid={newPin.length > 0 && !strength.strong} aria-describedby="new-pin-help new-pin-rules" disabled={submitting || rotated || Boolean(pendingRotation)} /><button className={styles.quiet} type="button" onClick={() => setShowPin((value) => !value)} disabled={!newPin || submitting}>{showPin ? "Сховати" : "Показати"}</button></span>
              <small id="new-pin-help">Оберіть 4 цифри, які легко запам’ятати вам, але важко вгадати іншим.</small>
              <ul id="new-pin-rules" className={styles.codeRules} aria-live="polite">
                <li data-ok={strength.complete}>Рівно 4 цифри</li>
                <li data-ok={strength.notRepeated}>Не чотири однакові цифри й не повтор однієї пари</li>
                <li data-ok={strength.notObvious}>Не проста послідовність на зразок 1234</li>
              </ul>
            </label>
            <label className={styles.wide}>Повторіть PIN *<input required type="password" inputMode="numeric" autoComplete="new-password" maxLength={4} value={confirmPin} onChange={(event) => setConfirmPin(normalizedTeacherPin(event.currentTarget.value))} placeholder="••••" pattern="[0-9]{4}" aria-invalid={confirmationComplete && !pinsMatch} aria-describedby="confirm-pin-help" disabled={submitting || rotated || Boolean(pendingRotation)} /><small id="confirm-pin-help" className={confirmationComplete && !pinsMatch ? styles.fieldError : undefined}>{confirmationComplete && !pinsMatch ? "PIN-коди не збігаються." : "Введіть ті самі 4 цифри ще раз."}</small></label>
          </div>
          {pendingRotation ? <button className={styles.primary} type="button" onClick={() => void sendRotation(pendingRotation)} disabled={submitting}>{submitting ? "Перевіряємо…" : "Повторити той самий запит"}</button> : <button className={styles.primary} type="submit" disabled={!teacherAccessCodeComplete(currentCode) || !strength.strong || !pinsMatch || submitting || rotated}>{submitting ? "Змінюємо…" : rotated ? "PIN змінено" : "Активувати PIN"}</button>}
        </form>
      </section>
    </div>
  );
}

function visitDates(from: string, count: number): string[] {
  const [year, month, day] = from.split("-").map(Number);
  if (!year || !month || !day) return [];
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 1, day + index));
    return date.toISOString().slice(0, 10);
  });
}

function shiftVisitDate(date: string, days: number, minimum: string): string {
  const shifted = visitDatesFromOffset(date, days);
  return shifted < minimum ? minimum : shifted;
}

function lastPublicWeekStart(today: string): string {
  return visitDatesFromOffset(visitHorizonEnd(today), -6);
}

function publicWeekStart(requested: string, today: string): string {
  if (!validDate(requested) || requested < today) return today;
  const lastStart = lastPublicWeekStart(today);
  return requested > lastStart ? lastStart : requested;
}

function visitDatesFromOffset(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function formatWeek(dates: string[]): string {
  if (!dates.length) return "";
  const formatter = new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "short", timeZone: "UTC" });
  return `${formatter.format(new Date(`${dates[0]}T12:00:00Z`))} – ${formatter.format(new Date(`${dates.at(-1)}T12:00:00Z`))}`;
}

function formatVisitDay(date: string): string {
  const value = new Intl.DateTimeFormat("uk-UA", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
  return value.charAt(0).toLocaleUpperCase("uk-UA") + value.slice(1);
}

function publicSlots(data: PublicVisitsEnvelope, date: string): PublicScheduleSlot[] {
  const ranges = data.hours[weekdayKey(date)] ?? [];
  const namedBookings = (data.publicBookings ?? [])
    .filter((item) => item.date === date)
    .map((item, index) => ({
      ...item,
      status: "busy" as const,
      displayName: item.identityVerified === false ? "Непідтверджений гостьовий запис" : item.displayName,
      sourceKey: `booking-${index}-${item.startTime}-${item.endTime}`,
    }));
  const blockers = [
    ...data.closures.filter((item) => item.date === date).map((item) => ({ ...item, status: "closed" as const })),
    ...data.busy.map(busyPeriodParts).filter((item) => item.date === date).map((item) => ({ ...item, status: "busy" as const })),
    ...namedBookings,
  ];
  const slots: PublicScheduleSlot[] = [];
  for (const range of ranges) {
    const boundaries = new Set([timeMinutes(range.startTime), timeMinutes(range.endTime)]);
    for (const blocker of blockers) {
      const start = Math.max(timeMinutes(range.startTime), timeMinutes(blocker.startTime));
      const end = Math.min(timeMinutes(range.endTime), timeMinutes(blocker.endTime));
      if (start < end) {
        boundaries.add(start);
        boundaries.add(end);
      }
    }
    const ordered = [...boundaries].sort((left, right) => left - right);
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const start = ordered[index];
      const end = ordered[index + 1];
      if (end <= start) continue;
      const namedBooking = namedBookings.find((item) => covers(item, start, end));
      const status = blockers.some((item) => item.status === "closed" && covers(item, start, end))
        ? "closed"
        : namedBooking || blockers.some((item) => item.status === "busy" && covers(item, start, end))
          ? "busy"
          : "free";
      const displayName = status === "busy" ? namedBooking?.displayName : undefined;
      const identityVerified = status === "busy" ? namedBooking?.identityVerified : undefined;
      const sourceKey = status === "busy" ? namedBooking?.sourceKey : undefined;
      const previous = slots.at(-1);
      if (
        previous?.status === status
        && previous.displayName === displayName
        && previous.sourceKey === sourceKey
        && previous.endTime === minutesTime(start)
      ) {
        previous.endTime = minutesTime(end);
      } else {
        slots.push({ startTime: minutesTime(start), endTime: minutesTime(end), status, displayName, identityVerified, sourceKey });
      }
    }
  }
  return slots.filter((slot) => slot.status !== "free" || timeMinutes(slot.endTime) - timeMinutes(slot.startTime) >= 20);
}

function covers(
  blocker: { startTime: string; endTime: string },
  start: number,
  end: number,
): boolean {
  return timeMinutes(blocker.startTime) < end && timeMinutes(blocker.endTime) > start;
}

function timeMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function minutesTime(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function materialRequestStatusLabel(status: MaterialRequestStatus): string {
  const labels: Record<MaterialRequestStatus, string> = {
    submitted: "Надіслано",
    in_review: "Опрацьовується",
    ready: "Готове",
    partially_ready: "Частково готове",
    completed: "Виконано",
    rejected: "Відхилено",
    cancelled: "Скасовано",
  };
  return labels[status];
}

function formatPortalDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("uk-UA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Kyiv",
  }).format(date);
}

function formatPortalDay(value: string): string {
  const date = new Date(value.length === 10 ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("uk-UA", {
    dateStyle: "medium",
    timeZone: "Europe/Kyiv",
  }).format(date);
}

function boundedSlotEnd(start: string, end: string, duration: number): string {
  return minutesTime(Math.min(timeMinutes(end), timeMinutes(start) + duration));
}

function bookableSlotStart(date: string, slot: PublicScheduleSlot, today: string, currentTime: string): string | null {
  if (date > today) return slot.startTime;
  if (date < today) return null;
  const nextFiveMinutes = Math.floor(timeMinutes(currentTime) / 5) * 5 + 5;
  const start = Math.max(timeMinutes(slot.startTime), nextFiveMinutes);
  return timeMinutes(slot.endTime) - start >= 20 ? minutesTime(start) : null;
}

function currentTimeInKyiv(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.hour}:${values.minute}`;
}

function todayInKyiv(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function validDate(value: string): boolean {
  return /^20\d{2}-\d{2}-\d{2}$/u.test(value);
}

function validTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof VisitApiError) {
    if (error.code === "slot_unavailable") return "Цей час щойно зайняли. Оберіть інший проміжок.";
    if (error.status === 401) return "Сеанс завершився. Оновіть сторінку та увійдіть знову.";
    return error.message;
  }
  return "Не вдалося виконати запит. Спробуйте ще раз.";
}
