"use client";

/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
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
  clearVisitPendingIntent,
  formatVisitDateTime,
  isUncertainVisitFailure,
  readVisitPendingIntent,
  teacherSearchUrl,
  teacherSessionUrl,
  teacherVisitsUrl,
  type TeacherVisitsEnvelope,
  type VisitBooking,
  type VisitCancelPayload,
  type VisitCreatePayload,
  type VisitPendingIntent,
  type VisitTeacher,
  type VisitTeacherIdentity,
  type VisitTeacherSearchEnvelope,
  type VisitTeacherSessionEnvelope,
  validVisitDuration,
  visitApi,
  VisitApiError,
  visitHorizonEnd,
  visitPendingKey,
  weekdayKey,
  writeVisitPendingIntent,
} from "./visit-client";
import styles from "./visits.module.css";

const LOGO_URL = "https://nazarijshvetz1.github.io/library-site/library-logo.png";
const PUBLIC_CATALOG_URL = "https://nazarijshvetz1.github.io/library-site/";

type Props = {
  initialDate: string;
  initialStartTime: string;
  initialEndTime: string;
};

export default function VisitBookingWorkspace({
  initialDate,
  initialStartTime,
  initialEndTime,
}: Props) {
  const [session, setSession] = useState<VisitTeacherSessionEnvelope | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [authNotice, setAuthNotice] = useState("");
  const [authBusy, setAuthBusy] = useState(false);

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
        clearVisitPendingIntent(
          window.sessionStorage,
          visitPendingKey("teacher", session.pendingScope),
        );
      }
      setSession(null);
    } catch {
      setAuthNotice("Не вдалося вийти. Спробуйте ще раз.");
    } finally {
      setAuthBusy(false);
    }
  }

  if (checkingSession) {
    return <VisitShell><div className={styles.authLoading} role="status">Перевіряємо доступ…</div></VisitShell>;
  }

  if (!session) {
    return (
      <VisitShell>
        <TeacherSignIn onSignIn={signIn} busy={authBusy} notice={authNotice} />
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
      initialDate={initialDate}
      initialStartTime={initialStartTime}
      initialEndTime={initialEndTime}
    />
  );
}

function VisitShell({ children }: { children: React.ReactNode }) {
  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/">
          <img src={LOGO_URL} alt="" width="48" height="48" />
          <span><strong>Єдина бібліотека</strong><small>Запис учителя</small></span>
        </Link>
        <a className={styles.catalogLink} href={PUBLIC_CATALOG_URL}>Публічний каталог</a>
      </header>
      {children}
    </main>
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
    if (!selected || code.length !== 11) return;
    void onSignIn(selected.loginId, code);
  }

  function changeCode(value: string) {
    const normalized = value.toUpperCase().replace(/[^23456789ABCDEFGHJKMNPQRSTUVWXYZ]/gu, "").slice(0, 10);
    setCode(normalized.length > 5 ? `${normalized.slice(0, 5)}-${normalized.slice(5)}` : normalized);
  }

  return (
    <section className={`${styles.page} ${styles.authPage}`}>
      <div className={styles.intro}>
        <p className={styles.eyebrow}>Графік відвідування бібліотеки</p>
        <h1>Увійдіть за своїм ім’ям</h1>
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

          <label className={styles.wide}>Особистий код *
            <input
              required
              type="password"
              inputMode="text"
              autoComplete="one-time-code"
              autoCapitalize="characters"
              minLength={11}
              maxLength={11}
              pattern="[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}"
              value={code}
              onChange={(event) => changeCode(event.currentTarget.value)}
              disabled={!selected || busy}
              placeholder="XXXXX-XXXXX"
            />
            <small>Код знаєте лише ви. Не повідомляйте його іншим.</small>
          </label>
        </div>
        <button className={styles.primary} type="submit" disabled={!selected || code.length !== 11 || busy}>
          {busy ? "Перевіряємо…" : "Увійти до графіка"}
        </button>
        <p className={styles.authHelp}>Немає коду або вас немає у списку? Зверніться до бібліотекаря.</p>
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
  initialDate,
  initialStartTime,
  initialEndTime,
}: {
  teacher: VisitTeacherIdentity;
  pendingScope: string;
  signingOut: boolean;
  signOutNotice: string;
  onSignOut: () => Promise<void>;
  initialDate: string;
  initialStartTime: string;
  initialEndTime: string;
}) {
  const storageKey = visitPendingKey("teacher", pendingScope);
  const [data, setData] = useState<TeacherVisitsEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [noticeTone, setNoticeTone] = useState<"success" | "error" | "info">("info");
  const [pending, setPending] = useState<VisitPendingIntent | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const today = useMemo(() => todayInKyiv(), []);
  const [date, setDate] = useState(() => validDate(initialDate) ? initialDate : today);
  const [startTime, setStartTime] = useState(() => validTime(initialStartTime) ? initialStartTime : "09:00");
  const [endTime, setEndTime] = useState(() => validTime(initialEndTime) ? initialEndTime : "09:30");
  const [classYearId, setClassYearId] = useState("");
  const [purpose, setPurpose] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await visitApi<TeacherVisitsEnvelope>(teacherVisitsUrl(todayInKyiv())));
    } catch (error) {
      setNotice(errorMessage(error));
      setNoticeTone("error");
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
      await load();
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
    if (!validVisitDuration(startTime, endTime)) {
      setNotice("Візит має тривати від 20 хвилин до 4 годин, із кроком 5 хвилин.");
      setNoticeTone("error");
      return;
    }
    const payload: VisitCreatePayload = {
      requestId: crypto.randomUUID(),
      date,
      startTime,
      endTime,
      purpose: purpose.trim() || null,
      classYearId: classYearId || null,
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
      await load();
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
    else void sendCancel(pending.bookingId, pending.payload, pending);
  }

  const bookingEnabled = data?.bookingEnabled === true;

  return (
    <VisitShell>
      <section className={styles.page}>
        <div className={styles.bookingTopbar}>
          <div className={styles.intro}>
            <p className={styles.eyebrow}>Відвідування бібліотеки</p>
            <h1>Оберіть зручний час</h1>
            <p>Зайняті проміжки видно без персональних даних. Ваші дані доступні лише вам і бібліотекарю.</p>
          </div>
          <div className={styles.account}>
            <span><small>Ви увійшли як</small><strong>{teacher.fullName}</strong></span>
            <button type="button" onClick={() => void onSignOut()} disabled={signingOut || submitting || Boolean(pending)}>Вийти</button>
          </div>
        </div>

        {pending ? (
          <div className={styles.pending} role="status">
            <span>Попередній запит міг бути прийнятий, але відповідь не надійшла.</span>
            <button type="button" onClick={retryPending} disabled={submitting}>Перевірити результат</button>
          </div>
        ) : null}
        {signOutNotice ? <div className={styles.error} role="alert">{signOutNotice}</div> : null}
        {notice ? <div className={styles[noticeTone]} role={noticeTone === "error" ? "alert" : "status"}>{notice}</div> : null}

        <div className={styles.teacherGrid}>
          <form className={styles.card} onSubmit={submit} aria-busy={submitting}>
            <div className={styles.cardHeading}>
              <div><span>Новий запис</span><h2>Дані візиту</h2></div>
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
            </div>
            <button className={styles.primary} type="submit" disabled={submitting || !bookingEnabled || Boolean(pending)}>
              {submitting ? "Зберігаємо…" : "Забронювати час"}
            </button>
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
              <button type="button" className={styles.danger} onClick={() => cancelBooking(booking)} disabled={!bookingEnabled || submitting || Boolean(pending)}>Скасувати</button>
            </article>
          ))}</div> : <p className={styles.empty}>Майбутніх записів немає.</p>}
        </section>
      </section>
    </VisitShell>
  );
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
