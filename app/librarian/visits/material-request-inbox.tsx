"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  clearPortalPendingIntent,
  isUncertainVisitFailure,
  mergePortalPageById,
  readPortalPendingIntent,
  visitApi,
  VisitApiError,
  writePortalPendingIntent,
} from "@/app/visits/visit-client";
import SiteIcon from "@/app/_components/site-icon";
import CollapsibleListSection from "@/app/_components/collapsible-list-section";
import styles from "@/app/visits/visits.module.css";

type RequestStatus = "submitted" | "in_review" | "ready" | "partially_ready" | "completed" | "rejected" | "cancelled";

type RequestItem = {
  id: string;
  material: { id: string; title: string; author: string; year: number | null; thumbnailUrl: string };
  requestedQuantity: number;
  approvedQuantity: number;
  fulfilledQuantity: number;
  reservedQuantity: number;
  reservations: RequestReservation[];
};

type RequestReservation = {
  id: string;
  sourceLocationId: string;
  sourceLocationName: string;
  condition: string;
  reservedQuantity: number;
  issuedQuantity: number;
  releasedQuantity: number;
  remainingQuantity: number;
};

type LibrarianRequest = {
  id: string;
  status: RequestStatus;
  teacher: { id: string; fullName: string };
  teacherNotes: string;
  librarianNote: string | null;
  rejectionReason: string | null;
  pickupLocation: { id: string; name: string } | null;
  resultingLoanId: string | null;
  dueAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  librarianHiddenAt: string | null;
  items: RequestItem[];
};

type RequestsEnvelope = {
  success: true;
  requests: LibrarianRequest[];
  page: { limit: number; hasMore: boolean; nextCursor: string | null };
  newCount: number;
  writesEnabled: boolean;
};

type PickupLocation = { id: string; name: string; type: string; isPublic: true; status: "active" };
type LocationsEnvelope = { success: true; locations: PickupLocation[]; writesEnabled: boolean };

type Holding = {
  locationId: string;
  locationName: string;
  locationType: string;
  locationStatus: string;
  condition: string | null;
  quantity: number;
  physicalQuantity?: number;
  reservedQuantity?: number;
  availableQuantity?: number;
};

type MaterialDetailEnvelope = {
  success: true;
  material: { id: string; holdings: Holding[] };
};

type ReadyRow = {
  approvedQuantity: number;
  sourceKey: string;
};

type RequestAction = "start_review" | "ready" | "complete" | "reject" | "issue" | "release";
type RequestActionIntent = {
  kind: "librarian-request-action";
  requestId: string;
  resourceId: string;
  payload: {
    requestId: string;
    expectedVersion: number;
    action: RequestAction;
    pickupLocationId?: string;
    dueAt?: string | null;
    issuedAt?: string;
    reason?: string;
    items?: Array<{
      itemId: string;
      approvedQuantity: number;
      sourceLocationId: string;
      condition: string;
      expectedAvailableQuantity: number;
    } | { reservationId: string; quantity: number }>;
  };
};

export default function MaterialRequestInbox({
  pendingScope,
  writesEnabled,
}: {
  pendingScope: string;
  writesEnabled: boolean;
}) {
  const [data, setData] = useState<RequestsEnvelope | null>(null);
  const [locations, setLocations] = useState<PickupLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState("");
  const [noticeTone, setNoticeTone] = useState<"success" | "error" | "info">("info");
  const [submitting, setSubmitting] = useState(false);
  const [pending, setPending] = useState<RequestActionIntent | null>(null);
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("date_desc");
  const [query, setQuery] = useState("");
  const [committedQuery, setCommittedQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const loadRequestRef = useRef(0);
  const filterScope = `${status}\u001e${sort}\u001e${committedQuery}\u001e${showHidden}`;
  const statusRef = useRef(filterScope);
  useEffect(() => {
    statusRef.current = filterScope;
  }, [filterScope]);
  const storageKey = `library.librarian.requests.pending.v1:${pendingScope}`;

  const load = useCallback(async (afterMutation = false, cursor: string | null = null) => {
    const requestSequence = ++loadRequestRef.current;
    const requestStatus = filterScope;
    const append = Boolean(cursor);
    if (append) setLoadingMore(true);
    else { setLoading(true); setLoadingMore(false); }
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (status) params.set("status", status);
      params.set("sort", sort);
      params.set("visibility", showHidden ? "all" : "visible");
      if (committedQuery) params.set("q", committedQuery);
      if (cursor) params.set("cursor", cursor);
      if (append) {
        const requestResponse = await visitApi<RequestsEnvelope>(`/api/librarian/material-requests?${params.toString()}`);
        if (requestSequence !== loadRequestRef.current || requestStatus !== statusRef.current) return;
        setData((current) => current
          ? { ...requestResponse, requests: mergePortalPageById(current.requests, requestResponse.requests) }
          : requestResponse);
      } else {
        const [requestResponse, locationResponse] = await Promise.all([
          visitApi<RequestsEnvelope>(`/api/librarian/material-requests?${params.toString()}`),
          visitApi<LocationsEnvelope>("/api/librarian/material-requests/locations"),
        ]);
        if (requestSequence !== loadRequestRef.current || requestStatus !== statusRef.current) return;
        setData(requestResponse);
        setLocations(locationResponse.locations);
      }
    } catch (error) {
      if (requestSequence !== loadRequestRef.current || requestStatus !== statusRef.current) return;
      setNotice(afterMutation
        ? "Дію збережено, але чергу не вдалося оновити. Натисніть «Оновити»."
        : append
          ? "Не вдалося завантажити наступні замовлення. Спробуйте ще раз."
          : errorMessage(error));
      setNoticeTone(afterMutation ? "info" : "error");
    } finally {
      if (requestSequence === loadRequestRef.current && requestStatus === statusRef.current) {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
    }
  }, [committedQuery, filterScope, showHidden, sort, status]);

  useEffect(() => {
    const timer = window.setTimeout(() => setCommittedQuery(query.trim()), 280);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPending(readPortalPendingIntent<RequestActionIntent>(window.sessionStorage, storageKey, ["librarian-request-action"]));
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load, storageKey]);

  async function sendAction(intent: RequestActionIntent) {
    if (!writePortalPendingIntent(window.sessionStorage, storageKey, intent)) {
      setNotice("Браузер не дозволив безпечно зберегти дію для повторної перевірки.");
      setNoticeTone("error");
      return;
    }
    setPending(intent);
    setSubmitting(true);
    setNotice("");
    try {
      await visitApi(`/api/librarian/material-requests/${encodeURIComponent(intent.resourceId)}`, {
        method: "PATCH",
        body: JSON.stringify(intent.payload),
      });
      clearPortalPendingIntent(window.sessionStorage, storageKey);
      setPending(null);
      setNotice(actionSuccess(intent.payload.action));
      setNoticeTone("success");
      await load(true);
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

  function startReview(request: LibrarianRequest) {
    const requestId = crypto.randomUUID();
    void sendAction({ kind: "librarian-request-action", requestId, resourceId: request.id, payload: { requestId, expectedVersion: request.version, action: "start_review" } });
  }

  function reject(request: LibrarianRequest) {
    const reason = window.prompt("Причина відхилення (буде показана вчителю):")?.trim();
    if (!reason) return;
    const requestId = crypto.randomUUID();
    void sendAction({ kind: "librarian-request-action", requestId, resourceId: request.id, payload: { requestId, expectedVersion: request.version, action: "reject", reason } });
  }

  function completeLegacyRequest(request: LibrarianRequest) {
    if (!window.confirm(
      `Підтвердити отримання раніше оформленої видачі для ${request.teacher.fullName}? Позика та рух залишків уже були записані до оновлення системи; повторної видачі не буде.`,
    )) return;
    const requestId = crypto.randomUUID();
    void sendAction({
      kind: "librarian-request-action",
      requestId,
      resourceId: request.id,
      payload: { requestId, expectedVersion: request.version, action: "complete" },
    });
  }

  function changeStatus(nextStatus: string) {
    setStatus(nextStatus);
    setData(null);
    setNotice("");
  }

  async function changeVisibility(request: LibrarianRequest, hidden: boolean) {
    setSubmitting(true); setNotice("");
    try {
      await visitApi(`/api/librarian/material-requests/${encodeURIComponent(request.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ action: hidden ? "hide" : "restore", mutationId: crypto.randomUUID() }),
      });
      setNotice(hidden ? "Виконане замовлення приховано з робочого списку." : "Замовлення повернуто до робочого списку.");
      setNoticeTone("success");
      await load(true);
    } catch (error) {
      setNotice(errorMessage(error)); setNoticeTone("error");
    } finally { setSubmitting(false); }
  }

  async function hideCompleted() {
    if (!window.confirm("Приховати всі виконані, відхилені та скасовані замовлення? Історія та видачі не видаляються.")) return;
    setSubmitting(true); setNotice("");
    try {
      const result = await visitApi<{ result: { hiddenCount: number } }>("/api/librarian/material-requests", {
        method: "PATCH",
        body: JSON.stringify({ action: "hide_completed", mutationId: crypto.randomUUID() }),
      });
      setNotice(result.result.hiddenCount ? `Приховано завершених замовлень: ${result.result.hiddenCount}.` : "Нових завершених замовлень для приховування немає.");
      setNoticeTone("success");
      await load(true);
    } catch (error) {
      setNotice(errorMessage(error)); setNoticeTone("error");
    } finally { setSubmitting(false); }
  }

  const requests = useMemo(() => data?.requests ?? [], [data]);

  return (
    <CollapsibleListSection className={`${styles.card} ${styles.requestInbox}`} flatOnMobile titleId="request-inbox-title" eyebrow={`${data?.newCount ?? 0} нових`} title="Замовлення вчителів" actions={<button className={styles.quiet} type="button" onClick={() => void load()} disabled={loading || loadingMore || submitting} aria-busy={loading}><SiteIcon name={loading ? "loading" : "refresh"} size={18} /> {loading ? "Оновлюємо…" : "Оновити"}</button>}>
      <div className={styles.adminFilters}>
        <label>Пошук<input type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Учитель, назва або автор" /></label>
        <label>Стан<select value={status} onChange={(event) => changeStatus(event.currentTarget.value)} disabled={loading || loadingMore || submitting}><option value="">Усі</option><option value="submitted">Нові</option><option value="in_review">Опрацьовуються</option><option value="ready">Готові</option><option value="partially_ready">Частково готові</option><option value="completed">Виконані</option><option value="rejected">Відхилені</option><option value="cancelled">Скасовані</option></select></label>
        <label>Сортування<select value={sort} onChange={(event) => setSort(event.currentTarget.value)} disabled={loading || loadingMore || submitting}><option value="date_desc">Дата: спочатку нові</option><option value="date_asc">Дата: спочатку давні</option><option value="teacher_asc">Прізвище А–Я</option><option value="teacher_desc">Прізвище Я–А</option><option value="status_asc">Статус: робочі першими</option><option value="status_desc">Статус: завершені першими</option></select></label>
        <label className={styles.visibilityToggle}><input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.currentTarget.checked)} /> Показати приховані</label>
        <button className={styles.quiet} type="button" onClick={() => void hideCompleted()} disabled={!writesEnabled || submitting}><SiteIcon name="hidden" size={16} /> Приховати всі завершені</button>
      </div>
      {pending ? <div className={styles.pending} role="status"><span>Результат дії із замовленням не підтверджено.</span><button type="button" onClick={() => void sendAction(pending)} disabled={submitting}>Перевірити результат</button></div> : null}
      {notice ? <div className={styles[noticeTone]} role={noticeTone === "error" ? "alert" : "status"}>{notice}</div> : null}
      {loading ? <p className={styles.empty}>Оновлюємо замовлення…</p> : requests.length ? <div className={styles.inboxList}>{requests.map((request) => (
        <article key={request.id}>
          <header><div><span className={styles.requestStatus} data-status={request.status}>{statusLabel(request.status)}</span>{request.librarianHiddenAt ? <span className={styles.hiddenRecordBadge}>Приховано</span> : null}<h3>{request.teacher.fullName}</h3><time dateTime={request.createdAt}>{formatDate(request.createdAt)}</time></div><strong>{request.items.length} поз.</strong></header>
          {request.teacherNotes ? <p>{request.teacherNotes}</p> : null}
          <ul>{request.items.map((item) => <li key={item.id}><span><strong>{item.material.title}</strong><small>{[item.material.author, item.material.year, item.material.id].filter(Boolean).join(" · ")}</small></span><span>{item.requestedQuantity} запитано{item.reservedQuantity ? ` · ${item.reservedQuantity} у резерві` : ""}{item.fulfilledQuantity ? ` · ${item.fulfilledQuantity} видано` : ""}</span></li>)}</ul>
          {request.pickupLocation ? <p>Місце отримання: <strong>{request.pickupLocation.name}</strong></p> : null}
          <div className={styles.inboxActions}>
            {request.status === "submitted" ? <button className={styles.quiet} type="button" onClick={() => startReview(request)} disabled={!writesEnabled || !data?.writesEnabled || submitting || Boolean(pending)}>Взяти в роботу</button> : null}
            {request.status === "submitted" || request.status === "in_review" || request.status === "partially_ready" ? <ReadyRequestForm key={`${request.id}:${request.version}`} request={request} locations={locations} disabled={!writesEnabled || !data?.writesEnabled || submitting || Boolean(pending)} onSubmit={sendAction} /> : null}
            {request.status === "submitted" || request.status === "in_review" ? <button className={styles.danger} type="button" onClick={() => reject(request)} disabled={!writesEnabled || !data?.writesEnabled || submitting || Boolean(pending)}>Відхилити</button> : null}
            {(request.status === "ready" || request.status === "partially_ready") && request.items.some((item) => item.reservations.some((reservation) => reservation.remainingQuantity > 0)) ? <ReservationActionForm request={request} disabled={!writesEnabled || !data?.writesEnabled || submitting || Boolean(pending)} onSubmit={sendAction} /> : null}
            {(request.status === "ready" || request.status === "partially_ready") && request.resultingLoanId && !request.items.some((item) => item.reservations.length > 0) ? <button className={styles.primary} type="button" onClick={() => completeLegacyRequest(request)} disabled={!writesEnabled || !data?.writesEnabled || submitting || Boolean(pending)}>Підтвердити отримання старої видачі</button> : null}
            {["completed", "rejected", "cancelled"].includes(request.status) ? <button className={styles.quiet} type="button" onClick={() => void changeVisibility(request, !request.librarianHiddenAt)} disabled={!writesEnabled || !data?.writesEnabled || submitting}><SiteIcon name={request.librarianHiddenAt ? "visible" : "hidden"} size={16} /> {request.librarianHiddenAt ? "Повернути" : "Приховати"}</button> : null}
          </div>
        </article>
      ))}</div> : <p className={styles.empty}>За цим фільтром замовлень немає.</p>}
      {data?.page.hasMore && data.page.nextCursor ? <button className={styles.loadMore} type="button" onClick={() => void load(false, data.page.nextCursor)} disabled={loading || loadingMore || submitting}>{loadingMore ? "Завантажуємо…" : "Завантажити ще"}</button> : null}
    </CollapsibleListSection>
  );
}

function ReservationActionForm({
  request,
  disabled,
  onSubmit,
}: {
  request: LibrarianRequest;
  disabled: boolean;
  onSubmit: (intent: RequestActionIntent) => Promise<void>;
}) {
  const reservations = request.items.flatMap((item) => item.reservations
    .filter((reservation) => reservation.remainingQuantity > 0)
    .map((reservation) => ({ ...reservation, title: item.material.title })));
  const [action, setAction] = useState<"issue" | "release" | null>(null);
  const [issuedAt, setIssuedAt] = useState(() => todayInKyiv());
  const [dueAt, setDueAt] = useState(request.dueAt ?? "");
  const [reason, setReason] = useState("");
  const [quantities, setQuantities] = useState<Record<string, number>>(() => Object.fromEntries(
    reservations.map((reservation) => [reservation.id, reservation.remainingQuantity]),
  ));
  const [notice, setNotice] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action) return;
    const items = reservations.map((reservation) => ({
      reservationId: reservation.id,
      quantity: Math.min(reservation.remainingQuantity, Math.max(0, Number(quantities[reservation.id]) || 0)),
    })).filter((item) => item.quantity > 0);
    if (!items.length) {
      setNotice("Вкажіть кількість щонайменше для одного резерву.");
      return;
    }
    if (action === "release" && !reason.trim()) {
      setNotice("Вкажіть причину звільнення резерву — її буде збережено в історії.");
      return;
    }
    const totalQuantity = items.reduce((total, item) => total + item.quantity, 0);
    if (action === "issue" && !window.confirm(`Підтвердити фактичну видачу для ${request.teacher.fullName}: ${totalQuantity} прим.? Залишок зменшиться, буде створено позику.`)) return;
    if (action === "release" && !window.confirm("Звільнити вибрані примірники як не забрані? Вони знову стануть доступними для інших замовлень.")) return;
    const requestId = crypto.randomUUID();
    void onSubmit({
      kind: "librarian-request-action",
      requestId,
      resourceId: request.id,
      payload: action === "issue"
        ? { requestId, expectedVersion: request.version, action, issuedAt, dueAt: dueAt || null, items }
        : { requestId, expectedVersion: request.version, action, reason: reason.trim(), items },
    });
  }

  if (!action) return <div className={styles.inboxActions}><button className={styles.primary} type="button" onClick={() => setAction("issue")} disabled={disabled}>Фактично видати</button><button className={styles.quiet} type="button" onClick={() => setAction("release")} disabled={disabled}>Не забрано</button></div>;
  return (
    <form className={styles.readyForm} onSubmit={submit}>
      <div className={styles.cardHeading}><div><span>{action === "issue" ? "Фактична видача" : "Звільнення резерву"}</span><h4>{action === "issue" ? "Передати примірники вчителю" : "Позначити як не забране"}</h4></div><button className={styles.quiet} type="button" onClick={() => { setAction(null); setNotice(""); }} disabled={disabled} aria-label="Закрити"><SiteIcon name="close" size={18} /></button></div>
      <p>{action === "issue" ? "Позика та рух залишків будуть створені лише після цієї дії." : "Фізичного руху примірників не буде: вони просто повернуться до доступного фонду."}</p>
      {notice ? <div className={styles.error} role="alert">{notice}</div> : null}
      {action === "issue" ? <div className={styles.fields}><label>Дата видачі *<input required type="date" max={todayInKyiv()} value={issuedAt} onChange={(event) => setIssuedAt(event.currentTarget.value)} /></label><label>Повернути до<input type="date" min={issuedAt} value={dueAt} onChange={(event) => setDueAt(event.currentTarget.value)} /></label></div> : <div className={styles.fields}><label>Причина *<textarea required maxLength={500} value={reason} onChange={(event) => setReason(event.currentTarget.value)} placeholder="Наприклад, учитель не забрав замовлення" /></label></div>}
      <div className={styles.readyRows}>{reservations.map((reservation) => <fieldset key={reservation.id} disabled={disabled}><legend>{reservation.title}</legend><p>{reservation.sourceLocationName} · {conditionLabel(reservation.condition)} · у резерві {reservation.remainingQuantity}</p><label>{action === "issue" ? "Видати" : "Звільнити"}<input type="number" min="0" max={reservation.remainingQuantity} value={quantities[reservation.id] ?? 0} onChange={(event) => setQuantities((current) => ({ ...current, [reservation.id]: Number(event.currentTarget.value) }))} /></label></fieldset>)}</div>
      <button className={action === "issue" ? styles.primary : styles.danger} type="submit" disabled={disabled}>{action === "issue" ? "Підтвердити фактичну видачу" : "Звільнити резерв"}</button>
    </form>
  );
}

function ReadyRequestForm({
  request,
  locations,
  disabled,
  onSubmit,
}: {
  request: LibrarianRequest;
  locations: PickupLocation[];
  disabled: boolean;
  onSubmit: (intent: RequestActionIntent) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pickupLocationId, setPickupLocationId] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [holdings, setHoldings] = useState<Record<string, Holding[]>>({});
  const [rows, setRows] = useState<Record<string, ReadyRow>>({});
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");

  async function prepare() {
    setOpen(true);
    if (Object.keys(holdings).length) return;
    setLoading(true);
    try {
      const details = await Promise.all(request.items.map((item) => visitApi<MaterialDetailEnvelope>(`/api/librarian/materials/${encodeURIComponent(item.material.id)}`)));
      const nextHoldings: Record<string, Holding[]> = {};
      const nextRows: Record<string, ReadyRow> = {};
      request.items.forEach((item, index) => {
        const available = details[index].material.holdings.filter((holding) => holding.locationStatus === "active" && holding.locationType !== "service" && holdingAvailable(holding) > 0);
        nextHoldings[item.id] = available;
        const first = available[0];
        nextRows[item.id] = { approvedQuantity: first ? item.approvedQuantity + Math.min(item.requestedQuantity - item.approvedQuantity, holdingAvailable(first)) : item.approvedQuantity, sourceKey: first ? holdingKey(first) : "" };
      });
      setHoldings(nextHoldings);
      setRows(nextRows);
      setPickupLocationId(locations[0]?.id || "");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  function changeRow(itemId: string, change: Partial<ReadyRow>) {
    setRows((current) => ({ ...current, [itemId]: { ...current[itemId], ...change } }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const items = request.items.map((item) => {
      const row = rows[item.id];
      const holding = (holdings[item.id] ?? []).find((candidate) => holdingKey(candidate) === row?.sourceKey);
      return holding && row.approvedQuantity > 0 ? {
        itemId: item.id,
        approvedQuantity: row.approvedQuantity,
        sourceLocationId: holding.locationId,
        condition: holding.condition || "unspecified",
        expectedAvailableQuantity: holdingAvailable(holding),
      } : null;
    }).filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (!pickupLocationId || !items.length) {
      setNotice("Оберіть місце отримання та схваліть щонайменше одну позицію.");
      return;
    }
    const requestId = crypto.randomUUID();
    void onSubmit({ kind: "librarian-request-action", requestId, resourceId: request.id, payload: { requestId, expectedVersion: request.version, action: "ready", pickupLocationId, dueAt: dueAt || null, items } });
  }

  if (!open) return <button className={styles.quiet} type="button" onClick={() => void prepare()} disabled={disabled}>{request.status === "partially_ready" ? "Додати до резерву" : "Підготувати резерв"}</button>;
  return (
    <form className={styles.readyForm} onSubmit={submit}>
      <div className={styles.cardHeading}><div><span>Резерв без видачі</span><h4>Підготувати замовлення</h4></div><button className={styles.quiet} type="button" onClick={() => setOpen(false)} disabled={disabled} aria-label="Закрити"><SiteIcon name="close" size={18} /></button></div>
      {notice ? <div className={styles.error} role="alert">{notice}</div> : null}
      {loading ? <p className={styles.empty}>Перевіряємо фактичні залишки…</p> : <>
        <div className={styles.fields}><label>Місце отримання *<select required value={pickupLocationId} onChange={(event) => setPickupLocationId(event.currentTarget.value)}><option value="">Оберіть активне публічне місце</option>{locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label><label>Повернути до<input type="date" min={todayInKyiv()} value={dueAt} onChange={(event) => setDueAt(event.currentTarget.value)} /></label></div>
        <div className={styles.readyRows}>{request.items.map((item) => {
          const options = holdings[item.id] ?? [];
          const row = rows[item.id] ?? { approvedQuantity: 0, sourceKey: "" };
          const holding = options.find((candidate) => holdingKey(candidate) === row.sourceKey);
          return <fieldset key={item.id} disabled={disabled || !options.length}><legend>{item.material.title}</legend><p>{item.approvedQuantity} уже підготовлено із {item.requestedQuantity}</p><label>Джерело<select value={row.sourceKey} onChange={(event) => { const next = options.find((candidate) => holdingKey(candidate) === event.currentTarget.value); changeRow(item.id, { sourceKey: event.currentTarget.value, approvedQuantity: next ? item.approvedQuantity + Math.min(item.requestedQuantity - item.approvedQuantity, holdingAvailable(next)) : item.approvedQuantity }); }}><option value="">Немає доступного залишку</option>{options.map((option) => <option key={holdingKey(option)} value={holdingKey(option)}>{option.locationName} · {conditionLabel(option.condition)} · {holdingAvailable(option)} доступно</option>)}</select></label><label>Підготувати загалом<input type="number" min={item.approvedQuantity} max={Math.min(item.requestedQuantity, item.approvedQuantity + (holding ? holdingAvailable(holding) : 0))} value={row.approvedQuantity} onChange={(event) => changeRow(item.id, { approvedQuantity: Number(event.currentTarget.value) })} /></label></fieldset>;
        })}</div>
        <button className={styles.primary} type="submit" disabled={disabled}>Зберегти резерв і повідомити вчителя</button>
      </>}
    </form>
  );
}

function holdingKey(holding: Holding): string {
  return `${holding.locationId}\u001e${holding.condition || "unspecified"}`;
}

function holdingAvailable(holding: Holding): number {
  return Math.max(0, Number(holding.availableQuantity ?? holding.quantity) || 0);
}

function conditionLabel(condition: string | null): string {
  return ({ new: "новий", good: "добрий", worn: "зношений", damaged: "пошкоджений", unspecified: "не вказано" } as Record<string, string>)[condition || "unspecified"] || condition || "не вказано";
}

function statusLabel(status: RequestStatus): string {
  return ({ submitted: "Нове", in_review: "Опрацьовується", ready: "Готове", partially_ready: "Частково готове", completed: "Виконано", rejected: "Відхилено", cancelled: "Скасовано" } as Record<RequestStatus, string>)[status];
}

function actionSuccess(action: RequestAction): string {
  if (action === "start_review") return "Замовлення взято в роботу.";
  if (action === "ready") return "Резерв підготовлено без створення позики. Учитель отримає повідомлення.";
  if (action === "issue") return "Фактичну видачу збережено, позику й рух примірників створено.";
  if (action === "release") return "Незабраний резерв звільнено. Примірники знову доступні.";
  if (action === "complete") return "Замовлення позначено виконаним.";
  return "Замовлення відхилено. Учитель отримає причину.";
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("uk-UA", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Kyiv" }).format(date);
}

function todayInKyiv(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function errorMessage(error: unknown): string {
  return error instanceof VisitApiError ? error.message : "Не вдалося виконати запит. Спробуйте ще раз.";
}
