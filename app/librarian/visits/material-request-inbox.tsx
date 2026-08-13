"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import {
  clearPortalPendingIntent,
  isUncertainVisitFailure,
  mergePortalPageById,
  readPortalPendingIntent,
  visitApi,
  VisitApiError,
  writePortalPendingIntent,
} from "@/app/visits/visit-client";
import styles from "@/app/visits/visits.module.css";

type RequestStatus = "submitted" | "in_review" | "ready" | "partially_ready" | "completed" | "rejected" | "cancelled";

type RequestItem = {
  id: string;
  material: { id: string; title: string; author: string; year: number | null; thumbnailUrl: string };
  requestedQuantity: number;
  approvedQuantity: number;
  fulfilledQuantity: number;
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
  version: number;
  createdAt: string;
  updatedAt: string;
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
};

type MaterialDetailEnvelope = {
  success: true;
  material: { id: string; holdings: Holding[] };
};

type ReadyRow = {
  approvedQuantity: number;
  sourceKey: string;
};

type RequestAction = "start_review" | "ready" | "complete" | "reject";
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
    reason?: string;
    items?: Array<{
      itemId: string;
      approvedQuantity: number;
      sourceLocationId: string;
      condition: string;
      expectedAvailableQuantity: number;
    }>;
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
  const storageKey = `library.librarian.requests.pending.v1:${pendingScope}`;

  const load = useCallback(async (afterMutation = false, cursor: string | null = null) => {
    const append = Boolean(cursor);
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (status) params.set("status", status);
      if (cursor) params.set("cursor", cursor);
      if (append) {
        const requestResponse = await visitApi<RequestsEnvelope>(`/api/librarian/material-requests?${params.toString()}`);
        setData((current) => current
          ? { ...requestResponse, requests: mergePortalPageById(current.requests, requestResponse.requests) }
          : requestResponse);
      } else {
        const [requestResponse, locationResponse] = await Promise.all([
          visitApi<RequestsEnvelope>(`/api/librarian/material-requests?${params.toString()}`),
          visitApi<LocationsEnvelope>("/api/librarian/material-requests/locations"),
        ]);
        setData(requestResponse);
        setLocations(locationResponse.locations);
      }
    } catch (error) {
      setNotice(afterMutation
        ? "Дію збережено, але чергу не вдалося оновити. Натисніть «Оновити»."
        : append
          ? "Не вдалося завантажити наступні замовлення. Спробуйте ще раз."
          : errorMessage(error));
      setNoticeTone(afterMutation ? "info" : "error");
    } finally {
      if (append) setLoadingMore(false);
      else setLoading(false);
    }
  }, [status]);

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

  function simpleAction(request: LibrarianRequest, action: "start_review" | "complete") {
    if (action === "complete" && !window.confirm("Позначити це замовлення повністю виконаним?")) return;
    const requestId = crypto.randomUUID();
    void sendAction({ kind: "librarian-request-action", requestId, resourceId: request.id, payload: { requestId, expectedVersion: request.version, action } });
  }

  function reject(request: LibrarianRequest) {
    const reason = window.prompt("Причина відхилення (буде показана вчителю):")?.trim();
    if (!reason) return;
    const requestId = crypto.randomUUID();
    void sendAction({ kind: "librarian-request-action", requestId, resourceId: request.id, payload: { requestId, expectedVersion: request.version, action: "reject", reason } });
  }

  function changeStatus(nextStatus: string) {
    setStatus(nextStatus);
    setData(null);
    setNotice("");
  }

  const requests = useMemo(() => data?.requests ?? [], [data]);

  return (
    <section className={`${styles.card} ${styles.requestInbox}`} aria-labelledby="request-inbox-title">
      <div className={styles.cardHeading}><div><span>{data?.newCount ?? 0} нових</span><h2 id="request-inbox-title">Замовлення вчителів</h2></div><button className={styles.quiet} type="button" onClick={() => void load()} disabled={loading || loadingMore || submitting}>↻ Оновити</button></div>
      <div className={styles.adminFilters}><label>Стан<select value={status} onChange={(event) => changeStatus(event.currentTarget.value)} disabled={loading || loadingMore || submitting}><option value="">Усі</option><option value="submitted">Нові</option><option value="in_review">Опрацьовуються</option><option value="ready">Готові</option><option value="partially_ready">Частково готові</option><option value="completed">Виконані</option><option value="rejected">Відхилені</option></select></label></div>
      {pending ? <div className={styles.pending} role="status"><span>Результат дії із замовленням не підтверджено.</span><button type="button" onClick={() => void sendAction(pending)} disabled={submitting}>Перевірити результат</button></div> : null}
      {notice ? <div className={styles[noticeTone]} role={noticeTone === "error" ? "alert" : "status"}>{notice}</div> : null}
      {loading ? <p className={styles.empty}>Оновлюємо замовлення…</p> : requests.length ? <div className={styles.inboxList}>{requests.map((request) => (
        <article key={request.id}>
          <header><div><span className={styles.requestStatus} data-status={request.status}>{statusLabel(request.status)}</span><h3>{request.teacher.fullName}</h3><time dateTime={request.createdAt}>{formatDate(request.createdAt)}</time></div><strong>{request.items.length} поз.</strong></header>
          {request.teacherNotes ? <p>{request.teacherNotes}</p> : null}
          <ul>{request.items.map((item) => <li key={item.id}><span><strong>{item.material.title}</strong><small>{[item.material.author, item.material.year, item.material.id].filter(Boolean).join(" · ")}</small></span><span>{item.requestedQuantity} запитано{item.approvedQuantity ? ` · ${item.approvedQuantity} схвалено` : ""}</span></li>)}</ul>
          {request.pickupLocation ? <p>Місце отримання: <strong>{request.pickupLocation.name}</strong></p> : null}
          <div className={styles.inboxActions}>
            {request.status === "submitted" ? <button className={styles.quiet} type="button" onClick={() => simpleAction(request, "start_review")} disabled={!writesEnabled || !data?.writesEnabled || submitting || Boolean(pending)}>Взяти в роботу</button> : null}
            {request.status === "submitted" || request.status === "in_review" ? <ReadyRequestForm request={request} locations={locations} disabled={!writesEnabled || !data?.writesEnabled || submitting || Boolean(pending)} onSubmit={sendAction} /> : null}
            {request.status === "submitted" || request.status === "in_review" ? <button className={styles.danger} type="button" onClick={() => reject(request)} disabled={!writesEnabled || !data?.writesEnabled || submitting || Boolean(pending)}>Відхилити</button> : null}
            {request.status === "ready" || request.status === "partially_ready" ? <button className={styles.primary} type="button" onClick={() => simpleAction(request, "complete")} disabled={!writesEnabled || !data?.writesEnabled || submitting || Boolean(pending)}>Видано вчителю</button> : null}
          </div>
        </article>
      ))}</div> : <p className={styles.empty}>За цим фільтром замовлень немає.</p>}
      {data?.page.hasMore && data.page.nextCursor ? <button className={styles.loadMore} type="button" onClick={() => void load(false, data.page.nextCursor)} disabled={loading || loadingMore || submitting}>{loadingMore ? "Завантажуємо…" : "Завантажити ще"}</button> : null}
    </section>
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
        const available = details[index].material.holdings.filter((holding) => holding.locationStatus === "active" && holding.locationType !== "service" && holding.quantity > 0);
        nextHoldings[item.id] = available;
        const first = available[0];
        nextRows[item.id] = { approvedQuantity: first ? Math.min(item.requestedQuantity, first.quantity) : 0, sourceKey: first ? holdingKey(first) : "" };
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
        expectedAvailableQuantity: holding.quantity,
      } : null;
    }).filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (!pickupLocationId || !items.length) {
      setNotice("Оберіть місце отримання та схваліть щонайменше одну позицію.");
      return;
    }
    const requestId = crypto.randomUUID();
    void onSubmit({ kind: "librarian-request-action", requestId, resourceId: request.id, payload: { requestId, expectedVersion: request.version, action: "ready", pickupLocationId, dueAt: dueAt || null, items } });
  }

  if (!open) return <button className={styles.quiet} type="button" onClick={() => void prepare()} disabled={disabled}>Підготувати видачу</button>;
  return (
    <form className={styles.readyForm} onSubmit={submit}>
      <div className={styles.cardHeading}><div><span>Фактична видача</span><h4>Підготувати замовлення</h4></div><button className={styles.quiet} type="button" onClick={() => setOpen(false)} disabled={disabled}>×</button></div>
      {notice ? <div className={styles.error} role="alert">{notice}</div> : null}
      {loading ? <p className={styles.empty}>Перевіряємо фактичні залишки…</p> : <>
        <div className={styles.fields}><label>Місце отримання *<select required value={pickupLocationId} onChange={(event) => setPickupLocationId(event.currentTarget.value)}><option value="">Оберіть активне публічне місце</option>{locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label><label>Повернути до<input type="date" min={todayInKyiv()} value={dueAt} onChange={(event) => setDueAt(event.currentTarget.value)} /></label></div>
        <div className={styles.readyRows}>{request.items.map((item) => {
          const options = holdings[item.id] ?? [];
          const row = rows[item.id] ?? { approvedQuantity: 0, sourceKey: "" };
          const holding = options.find((candidate) => holdingKey(candidate) === row.sourceKey);
          return <fieldset key={item.id} disabled={disabled || !options.length}><legend>{item.material.title}</legend><label>Джерело<select value={row.sourceKey} onChange={(event) => { const next = options.find((candidate) => holdingKey(candidate) === event.currentTarget.value); changeRow(item.id, { sourceKey: event.currentTarget.value, approvedQuantity: next ? Math.min(item.requestedQuantity, next.quantity) : 0 }); }}><option value="">Немає доступного залишку</option>{options.map((option) => <option key={holdingKey(option)} value={holdingKey(option)}>{option.locationName} · {conditionLabel(option.condition)} · {option.quantity} доступно</option>)}</select></label><label>Схвалити<input type="number" min="0" max={Math.min(item.requestedQuantity, holding?.quantity ?? 0)} value={row.approvedQuantity} onChange={(event) => changeRow(item.id, { approvedQuantity: Number(event.currentTarget.value) })} /></label></fieldset>;
        })}</div>
        <button className={styles.primary} type="submit" disabled={disabled}>Позначити готовим і створити видачу</button>
      </>}
    </form>
  );
}

function holdingKey(holding: Holding): string {
  return `${holding.locationId}\u001e${holding.condition || "unspecified"}`;
}

function conditionLabel(condition: string | null): string {
  return ({ new: "новий", good: "добрий", worn: "зношений", damaged: "пошкоджений", unspecified: "не вказано" } as Record<string, string>)[condition || "unspecified"] || condition || "не вказано";
}

function statusLabel(status: RequestStatus): string {
  return ({ submitted: "Нове", in_review: "Опрацьовується", ready: "Готове", partially_ready: "Частково готове", completed: "Виконано", rejected: "Відхилено", cancelled: "Скасовано" } as Record<RequestStatus, string>)[status];
}

function actionSuccess(action: RequestAction): string {
  if (action === "start_review") return "Замовлення взято в роботу.";
  if (action === "ready") return "Готовність і фактичну видачу збережено. Учитель отримає повідомлення.";
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
