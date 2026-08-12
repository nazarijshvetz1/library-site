"use client";

/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import {
  busyPeriodParts,
  clearVisitPendingIntent,
  formatVisitDateTime,
  isUncertainVisitFailure,
  readVisitPendingIntent,
  type TeacherVisitsEnvelope,
  type VisitBooking,
  type VisitCancelPayload,
  type VisitCreatePayload,
  type VisitPendingIntent,
  teacherVisitsUrl,
  validVisitDuration,
  visitApi,
  VisitApiError,
  visitPendingKey,
  visitHorizonEnd,
  weekdayKey,
  writeVisitPendingIntent,
} from "./visit-client";
import styles from "./visits.module.css";

const LOGO_URL = "https://nazarijshvetz1.github.io/library-site/library-logo.png";

type Props = {
  pendingScope: string;
  displayName: string;
  signOutHref: string;
  initialDate: string;
  initialStartTime: string;
  initialEndTime: string;
};

export default function VisitBookingWorkspace({
  pendingScope,
  displayName,
  signOutHref,
  initialDate,
  initialStartTime,
  initialEndTime,
}: Props) {
  const storageKey = visitPendingKey("teacher", pendingScope);
  const [data, setData] = useState<TeacherVisitsEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [noticeTone, setNoticeTone] = useState<"success" | "error" | "info">("info");
  const [pending, setPending] = useState<VisitPendingIntent | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [surname, setSurname] = useState("");
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
      const next = await visitApi<TeacherVisitsEnvelope>(teacherVisitsUrl(todayInKyiv()));
      setData(next);
    } catch (error) {
      setNotice(errorMessage(error));
      setNoticeTone("error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPending(readVisitPendingIntent(window.localStorage, storageKey));
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load, storageKey]);

  const selectedBusy = useMemo(
    () => (data?.busy ?? [])
      .map(busyPeriodParts)
      .filter((period) => period.date === date),
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
    if (!writeVisitPendingIntent(window.localStorage, storageKey, intent)) {
      setNotice("Браузер не дозволив безпечно зберегти запит для повторної перевірки. Звільніть місце у сховищі або відкрийте звичайне вікно браузера.");
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
      clearVisitPendingIntent(window.localStorage, storageKey);
      setPending(null);
      setNotice("Візит заброньовано. Він з’явився у ваших записах.");
      setNoticeTone("success");
      setPurpose("");
      await load();
    } catch (error) {
      if (!isUncertainVisitFailure(error)) {
        clearVisitPendingIntent(window.localStorage, storageKey);
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
      surname: surname.trim(),
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
    if (!writeVisitPendingIntent(window.localStorage, storageKey, intent)) {
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
      clearVisitPendingIntent(window.localStorage, storageKey);
      setPending(null);
      setNotice("Запис скасовано.");
      setNoticeTone("success");
      await load();
    } catch (error) {
      if (!isUncertainVisitFailure(error)) {
        clearVisitPendingIntent(window.localStorage, storageKey);
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
    <main className={styles.shell}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/">
          <img src={LOGO_URL} alt="" width="48" height="48" />
          <span><strong>Єдина бібліотека</strong><small>Запис учителя</small></span>
        </Link>
        <div className={styles.account}>
          <span><strong>{displayName}</strong><small>Захищена сторінка</small></span>
          <a href={signOutHref}>Вийти</a>
        </div>
      </header>

      <section className={styles.page}>
        <div className={styles.intro}>
          <p className={styles.eyebrow}>Відвідування бібліотеки</p>
          <h1>Оберіть зручний час</h1>
          <p>Зайняті проміжки видно без персональних даних. Ваше прізвище та клас доступні лише вам і бібліотекарю.</p>
          <p className={styles.accessHint}>Якщо доступ не надано, зверніться до бібліотекаря, щоб додати вашу робочу email-адресу.</p>
        </div>

        {pending ? (
          <div className={styles.pending} role="status">
            <span>Попередній запит міг бути прийнятий, але відповідь не надійшла.</span>
            <button type="button" onClick={retryPending} disabled={submitting}>Перевірити результат</button>
          </div>
        ) : null}
        {notice ? <div className={styles[noticeTone]} role={noticeTone === "error" ? "alert" : "status"}>{notice}</div> : null}

        <div className={styles.teacherGrid}>
          <form className={styles.card} onSubmit={submit} aria-busy={submitting}>
            <div className={styles.cardHeading}>
              <div><span>Новий запис</span><h2>Дані візиту</h2></div>
              <span className={bookingEnabled ? styles.enabled : styles.disabled}>{bookingEnabled ? "Запис відкрито" : "Запис призупинено"}</span>
            </div>
            <div className={styles.fields}>
              <label className={styles.wide}>Прізвище *
                <input required maxLength={80} autoComplete="family-name" value={surname} aria-invalid={Boolean(fieldErrors.surname)} onInput={(event) => setSurname(event.currentTarget.value)} placeholder="Наприклад, Шевченко" />
                {fieldErrors.surname ? <small className={styles.fieldError}>{fieldErrors.surname}</small> : null}
              </label>
              <label>Дата *
                <input required type="date" min={today} max={visitHorizonEnd(today)} value={date} aria-invalid={Boolean(fieldErrors.date)} onInput={(event) => setDate(event.currentTarget.value)} />
                {fieldErrors.date ? <small className={styles.fieldError}>{fieldErrors.date}</small> : null}
              </label>
              <label>Початок *
                <input required type="time" step={300} value={startTime} aria-invalid={Boolean(fieldErrors.startTime)} onInput={(event) => setStartTime(event.currentTarget.value)} />
                {fieldErrors.startTime ? <small className={styles.fieldError}>{fieldErrors.startTime}</small> : null}
              </label>
              <label>Завершення *
                <input required type="time" step={300} value={endTime} aria-invalid={Boolean(fieldErrors.endTime)} onInput={(event) => setEndTime(event.currentTarget.value)} />
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
                <textarea maxLength={160} value={purpose} aria-invalid={Boolean(fieldErrors.purpose)} onInput={(event) => setPurpose(event.currentTarget.value)} placeholder="Необов’язково: урок, добір літератури…" />
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
    </main>
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
    return error.message;
  }
  return "Не вдалося виконати запит. Спробуйте ще раз.";
}
