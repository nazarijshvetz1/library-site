"use client";

/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  formatVisitDateTime,
  isUncertainVisitFailure,
  type LibrarianVisitsEnvelope,
  type VisitBooking,
  type VisitCancelPayload,
  type VisitPendingIntent,
  visitApi,
  VisitApiError,
  visitPendingKey,
  readVisitPendingIntent,
  writeVisitPendingIntent,
  clearVisitPendingIntent,
} from "@/app/visits/visit-client";
import styles from "@/app/visits/visits.module.css";
import TeacherAccessAdmin from "./teacher-access-admin";
import MaterialRequestInbox from "./material-request-inbox";

const LOGO_URL = "https://nazarijshvetz1.github.io/library-site/library-logo.png";

type Props = { pendingScope: string; displayName: string; writesEnabled: boolean; signOutHref: string };

export default function LibrarianVisitWorkspace({ pendingScope, displayName, writesEnabled, signOutHref }: Props) {
  const [data, setData] = useState<LibrarianVisitsEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [noticeTone, setNoticeTone] = useState<"success" | "error">("success");
  const [submitting, setSubmitting] = useState(false);
  const [date, setDate] = useState(() => todayInKyiv());
  const [status, setStatus] = useState("active");
  const [pending, setPending] = useState<Extract<VisitPendingIntent, { kind: "cancel" }> | null>(null);
  const storageKey = visitPendingKey("librarian", pendingScope);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const selectedDate = date || todayInKyiv();
      const range = { from: selectedDate, to: selectedDate };
      const params = new URLSearchParams({ ...range, status: status || "all", limit: "100" });
      setData(await visitApi<LibrarianVisitsEnvelope>(`/api/librarian/visits?${params.toString()}`));
    } catch (error) {
      setNotice(errorMessage(error));
      setNoticeTone("error");
    } finally {
      setLoading(false);
    }
  }, [date, status]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const stored = readVisitPendingIntent(window.localStorage, storageKey);
      setPending(stored?.kind === "cancel" ? stored : null);
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load, storageKey]);

  const bookings = useMemo(() => data?.bookings ?? [], [data]);

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
      await visitApi(`/api/librarian/visits/${encodeURIComponent(bookingId)}`, {
        method: "DELETE",
        body: JSON.stringify(payload),
      });
      clearVisitPendingIntent(window.localStorage, storageKey);
      setPending(null);
      setNotice("Запис скасовано бібліотекарем.");
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

  function cancel(booking: VisitBooking) {
    if (!window.confirm(`Скасувати запис ${booking.surname}?`)) return;
    const payload = { requestId: crypto.randomUUID(), expectedVersion: booking.version, reason: null };
    void sendCancel(booking.id, payload, {
      kind: "cancel",
      requestId: payload.requestId,
      bookingId: booking.id,
      payload,
    });
  }

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/librarian">
          <img src={LOGO_URL} alt="" width="48" height="48" />
          <span><strong>Єдина бібліотека</strong><small>Розклад відвідувань</small></span>
        </Link>
        <div className={styles.account}>
          <Link href="/librarian">Кабінет</Link>
          <span><strong>{displayName}</strong><small>Бібліотекар</small></span>
          <a href={signOutHref}>Вийти</a>
        </div>
      </header>

      <section className={styles.page}>
        <div className={styles.intro}>
          <p className={styles.eyebrow}>Захищений перегляд</p>
          <h1>Відвідування бібліотеки</h1>
          <p>Повний розклад із прізвищами та класами доступний лише працівникам бібліотеки.</p>
        </div>

        {pending ? <div className={styles.pending} role="status"><span>Відповідь на скасування не надійшла.</span><button type="button" onClick={() => void sendCancel(pending.bookingId, pending.payload, pending)} disabled={submitting}>Перевірити результат</button></div> : null}
        {data && data.bookingEnabled !== true ? <div className={styles.info} role="status">Скасування записів тимчасово вимкнено адміністратором.</div> : null}
        {notice ? <div className={styles[noticeTone]} role={noticeTone === "error" ? "alert" : "status"}>{notice}</div> : null}

        <section className={styles.card}>
          <div className={styles.cardHeading}>
            <div><span>{bookings.length} записів</span><h2>Розклад</h2></div>
            <button className={styles.quiet} type="button" onClick={() => void load()} disabled={loading}>↻ Оновити</button>
          </div>
          <div className={styles.adminFilters}>
            <label>Дата<input type="date" value={date} onInput={(event) => setDate(event.currentTarget.value)} /></label>
            <label>Стан<select value={status} onChange={(event) => setStatus(event.currentTarget.value)}><option value="active">Активні</option><option value="cancelled">Скасовані</option><option value="">Усі</option></select></label>
          </div>
          {loading ? <p className={styles.empty}>Оновлюємо розклад…</p> : bookings.length ? (
            <div role="region" aria-label="Таблиця відвідувань">
              <table className={styles.adminTable}>
                <thead><tr><th>Час</th><th>Учитель</th><th>Клас</th><th>Мета</th><th>Стан</th><th><span className="sr-only">Дії</span></th></tr></thead>
                <tbody>{bookings.map((booking) => (
                  <tr key={booking.id}>
                    <td><strong>{formatVisitDateTime(`${booking.date}T${booking.startTime}`)}</strong><br />до {booking.endTime}</td>
                    <td><strong>{booking.surname}</strong><span className={styles.identityKind} data-verified={bookingIdentityVerified(booking)}>{bookingIdentityLabel(booking)}</span></td>
                    <td>{booking.classLabel || "—"}</td>
                    <td>{booking.purpose || "—"}</td>
                    <td>{booking.status === "cancelled" ? "Скасовано" : "Активний"}</td>
                    <td>{booking.status !== "cancelled" ? <button className={styles.danger} type="button" onClick={() => cancel(booking)} disabled={!writesEnabled || data?.bookingEnabled !== true || submitting || Boolean(pending)}>Скасувати</button> : null}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : <p className={styles.empty}>За цими фільтрами записів немає.</p>}
        </section>
        <MaterialRequestInbox pendingScope={pendingScope} writesEnabled={writesEnabled} />
        <TeacherAccessAdmin writesEnabled={writesEnabled} />
      </section>
    </main>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof VisitApiError) return error.message;
  return "Не вдалося виконати запит. Спробуйте ще раз.";
}

function bookingIdentityVerified(booking: VisitBooking): boolean {
  return booking.ownerKind === "teacher" && booking.identityVerified === true;
}

function bookingIdentityLabel(booking: VisitBooking): string {
  if (booking.ownerKind === "guest" || booking.identityVerified === false) {
    return "Непідтверджений гостьовий запис";
  }
  return bookingIdentityVerified(booking)
    ? "Підтверджений учитель"
    : "Спосіб підтвердження не вказано";
}

function todayInKyiv(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
