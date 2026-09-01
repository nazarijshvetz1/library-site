"use client";

import { useRouter } from "next/navigation";
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import styles from "./statement.module.css";

type LoanStatus = "open" | "closed" | "cancelled";
type ManagerTab = "items" | "metadata" | "history";
type ItemLifecycleStatus = "active" | "removed";

type ManagedClassLoanItem = {
  classLoanItemId: string;
  materialId: string;
  title: string;
  author: string;
  publicationYear: number | null;
  subject: string;
  sourceLocationId: string;
  sourceLocationName: string;
  condition: string;
  quantityIssued: number;
  quantityReturned: number;
  quantityOutstanding: number;
  version: number;
  lifecycleStatus: ItemLifecycleStatus;
  editable: boolean;
  currentAvailableAtSource: number;
  editBlockedReason: "loan_not_open" | "statement_item_link_missing" | null;
  removedAt?: string | null;
};

type LoanHistoryItem = {
  id: string;
  action: string;
  label?: string;
  actorName: string;
  occurredAt: string;
  details?: unknown;
};

type LegacyStatementCandidate = {
  statementLineId: string;
  title: string;
  author: string;
  publicationYear: number | null;
  subject: string;
  rubric: string;
  quantityIssued: number;
};

type ManagedClassLoan = {
  classLoanId: string;
  classYearId: string;
  className: string;
  classYearStatus: "planned" | "active" | "closed";
  academicYearLabel: string;
  status: LoanStatus;
  version: number;
  responsibleTeacherUserId: string;
  responsibleTeacherName: string;
  issuedAt: string;
  dueAt: string | null;
  notes: string;
  items: ManagedClassLoanItem[];
  legacyStatementCandidates: LegacyStatementCandidate[];
  history: LoanHistoryItem[];
  historyLimit: number;
  historyTruncated: boolean;
};

type ManagementEnvelope = {
  success: boolean;
  writesEnabled: boolean;
  classLoan: unknown;
  referenceData: {
    teachers: Array<{ id: string; fullName: string }>;
    locations: Array<{ id: string; name: string; type: string }>;
  };
  error?: string;
};

type MutationResultEnvelope = {
  success: boolean;
  result?: {
    classLoanId: string;
    version: number;
    classLoanItemId?: string;
    itemVersion?: number;
    transactionId?: string;
  };
  error?: string;
  code?: string;
};

type PatchPayload = {
  requestId: string;
  expectedVersion: number;
  action: "update_metadata" | "set_item_quantity" | "remove_item" | "restore_item" | "link_legacy_item";
  reason: string;
  responsibleTeacherUserId?: string;
  dueAt?: string | null;
  notes?: string;
  classLoanItemId?: string;
  expectedItemVersion?: number;
  quantity?: number;
  statementLineId?: string;
};

type Props = {
  classLoanId: string;
  writesEnabled: boolean;
  onClose: () => void;
};

const DEFAULT_REASON = "Виправлення даних бібліотекарем";

export default function StatementManager({
  classLoanId,
  writesEnabled: initialWritesEnabled,
  onClose,
}: Props) {
  const router = useRouter();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const mutationInFlightRef = useRef(false);
  const [tab, setTab] = useState<ManagerTab>("items");
  const [loan, setLoan] = useState<ManagedClassLoan | null>(null);
  const [teachers, setTeachers] = useState<ManagementEnvelope["referenceData"]["teachers"]>([]);
  const [writesEnabled, setWritesEnabled] = useState(initialWritesEnabled);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [reason, setReason] = useState(DEFAULT_REASON);
  const [quantityDrafts, setQuantityDrafts] = useState<Record<string, string>>({});
  const [legacyLineDrafts, setLegacyLineDrafts] = useState<Record<string, string>>({});
  const [teacherUserId, setTeacherUserId] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [notes, setNotes] = useState("");
  const [pendingPatch, setPendingPatch] = useState<PatchPayload | null>(() => (
    readStoredPendingPatch(classLoanId)
  ));
  const [historyLimit, setHistoryLimit] = useState(120);

  const endpoint = `/api/librarian/class-loans/${encodeURIComponent(classLoanId)}`;
  const readEndpoint = `${endpoint}?historyLimit=${historyLimit}`;

  const applyEnvelope = useCallback((body: ManagementEnvelope) => {
    const nextLoan = normalizeManagementLoan(body.classLoan);
    setLoan(nextLoan);
    setTeachers(body.referenceData?.teachers ?? []);
    setWritesEnabled(Boolean(body.writesEnabled));
    setTeacherUserId(nextLoan.responsibleTeacherUserId);
    setDueAt(nextLoan.dueAt ?? "");
    setNotes(nextLoan.notes ?? "");
    setQuantityDrafts(Object.fromEntries(nextLoan.items.map((item) => [
      item.classLoanItemId,
      String(item.quantityIssued),
    ])));
    setLegacyLineDrafts(Object.fromEntries(nextLoan.items.map((item) => [
      item.classLoanItemId,
      suggestedLegacyStatementLineId(item, nextLoan.legacyStatementCandidates),
    ])));
  }, []);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError("");
    try {
      const response = await fetch(readEndpoint, { cache: "no-store", credentials: "same-origin" });
      const body = await readJson<ManagementEnvelope>(response);
      if (!response.ok || !body.success || !body.classLoan) {
        throw new Error(body.error || "Не вдалося завантажити керування відомістю.");
      }
      applyEnvelope(body);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setLoading(false);
    }
  }, [applyEnvelope, readEndpoint]);

  useEffect(() => {
    let cancelled = false;
    window.queueMicrotask(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    persistPendingPatch(classLoanId, pendingPatch);
  }, [classLoanId, pendingPatch]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && panelRef.current?.getAttribute("aria-busy") !== "true") onClose();
      if (event.key !== "Tab") return;
      const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ) ?? [])].filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const activeItems = useMemo(
    () => loan?.items.filter((item) => item.lifecycleStatus === "active") ?? [],
    [loan],
  );
  const removedItems = useMemo(
    () => loan?.items.filter((item) => item.lifecycleStatus === "removed") ?? [],
    [loan],
  );
  const activeCopies = activeItems.reduce((sum, item) => sum + item.quantityIssued, 0);
  const canWrite = Boolean(
    writesEnabled
    && loan?.status === "open"
    && loan.classYearStatus === "active",
  );
  const canMutate = canWrite && pendingPatch === null;
  const metadataChanged = Boolean(loan && (
    teacherUserId !== loan.responsibleTeacherUserId
    || (dueAt || null) !== loan.dueAt
    || notes.trim() !== loan.notes.trim()
  ));

  async function sendPatch(payload: PatchPayload, retry = false) {
    if (mutationInFlightRef.current || saving || pendingPatch && !retry) return;
    mutationInFlightRef.current = true;
    if (!retry) setPendingPatch(payload);
    setSaving(true);
    setError("");
    setMessage(retry ? "Перевіряємо результат попередньої зміни…" : "Зберігаємо зміну…");
    try {
      const response = await fetch(endpoint, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await readJson<MutationResultEnvelope>(response);
      if (!response.ok || !body.success) {
        const sameRequestRetryRequired = response.status === 408
          || response.status === 425
          || response.status === 409 && body.code === "mutation_in_progress";
        const definitive = response.status >= 400
          && response.status < 500
          && !sameRequestRetryRequired;
        if (definitive) setPendingPatch(null);
        if (response.status === 409) await load(true);
        const messageText = body.error || "Не вдалося зберегти зміну.";
        throw response.ok ? new Error(messageText) : new HttpResponseError(messageText);
      }
      setPendingPatch(null);
      setMessage("Зміну збережено. Відомість і залишки оновлено.");
      await load(true);
      router.refresh();
    } catch (requestError) {
      setError(errorMessage(requestError));
      if (!(requestError instanceof HttpResponseError)) {
        setMessage("Відповідь сервера не підтверджена. Повторіть той самий запит кнопкою нижче.");
      } else {
        setMessage("");
      }
    } finally {
      setSaving(false);
      mutationInFlightRef.current = false;
    }
  }

  function normalizedReason(): string {
    return reason.trim() || DEFAULT_REASON;
  }

  async function changeQuantity(item: ManagedClassLoanItem) {
    if (!loan || !canMutate || !item.editable) return;
    const quantity = Number(quantityDrafts[item.classLoanItemId]);
    const minimum = Math.max(1, item.quantityReturned);
    const maximum = item.quantityIssued + item.currentAvailableAtSource;
    if (!Number.isInteger(quantity) || quantity < minimum || quantity > maximum) {
      setError(`Для «${item.title}» вкажіть від ${minimum} до ${maximum} примірників.`);
      return;
    }
    if (quantity === item.quantityIssued) return;
    await sendPatch({
      requestId: crypto.randomUUID(),
      expectedVersion: loan.version,
      action: "set_item_quantity",
      reason: normalizedReason(),
      classLoanItemId: item.classLoanItemId,
      expectedItemVersion: item.version,
      quantity,
    });
  }

  async function removeItem(item: ManagedClassLoanItem) {
    if (!loan || !canMutate || !item.editable) return;
    if (!window.confirm(`Прибрати «${item.title}» з актуальної відомості та повернути ${item.quantityOutstanding} прим. у фонд? Уже зафіксовані повернення та вся історія операцій збережуться.`)) return;
    await sendPatch({
      requestId: crypto.randomUUID(),
      expectedVersion: loan.version,
      action: "remove_item",
      reason: normalizedReason(),
      classLoanItemId: item.classLoanItemId,
      expectedItemVersion: item.version,
    });
  }

  async function restoreItem(item: ManagedClassLoanItem) {
    if (!loan || !canMutate || !item.editable) return;
    const quantity = Number(quantityDrafts[item.classLoanItemId]);
    const minimum = Math.max(1, item.quantityReturned);
    const maximum = item.quantityReturned + item.currentAvailableAtSource;
    if (!Number.isInteger(quantity) || quantity < minimum || quantity > maximum) {
      setError(`Для відновлення «${item.title}» вкажіть від ${minimum} до ${maximum} примірників.`);
      return;
    }
    await sendPatch({
      requestId: crypto.randomUUID(),
      expectedVersion: loan.version,
      action: "restore_item",
      reason: normalizedReason(),
      classLoanItemId: item.classLoanItemId,
      expectedItemVersion: item.version,
      quantity,
    });
  }

  async function linkLegacyItem(item: ManagedClassLoanItem) {
    if (!loan || !canMutate || item.editBlockedReason !== "statement_item_link_missing") return;
    const statementLineId = legacyLineDrafts[item.classLoanItemId] ?? "";
    if (!statementLineId) {
      setError(`Оберіть відповідний рядок старої відомості для «${item.title}».`);
      return;
    }
    await sendPatch({
      requestId: crypto.randomUUID(),
      expectedVersion: loan.version,
      action: "link_legacy_item",
      reason: normalizedReason(),
      classLoanItemId: item.classLoanItemId,
      expectedItemVersion: item.version,
      statementLineId,
    });
  }

  async function updateMetadata(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!loan || !canMutate || !metadataChanged) return;
    await sendPatch({
      requestId: crypto.randomUUID(),
      expectedVersion: loan.version,
      action: "update_metadata",
      reason: normalizedReason(),
      responsibleTeacherUserId: teacherUserId,
      dueAt: dueAt || null,
      notes: notes.trim(),
    });
  }

  return (
    <div className={styles.managerBackdrop}>
      <section
        ref={panelRef}
        className={styles.managerPanel}
        role="dialog"
        aria-modal="true"
        aria-busy={saving}
        aria-labelledby="statement-manager-title"
        tabIndex={-1}
      >
        <header className={styles.managerHeader}>
          <div>
            <small>Керування видачею класу</small>
            <h2 id="statement-manager-title">{loan?.className || "Відомість"}</h2>
            <span>{loan?.academicYearLabel || "Завантаження…"}</span>
          </div>
          <button ref={closeButtonRef} type="button" disabled={saving} onClick={onClose} aria-label="Закрити керування">×</button>
        </header>

        <div className={styles.managerTabs} aria-label="Розділи керування" role="tablist">
          <TabButton active={tab === "items"} id="items" onSelect={setTab}>Підручники <span>{activeItems.length}</span></TabButton>
          <TabButton active={tab === "metadata"} id="metadata" onSelect={setTab}>Дані видачі</TabButton>
          <TabButton active={tab === "history"} id="history" onSelect={setTab}>Історія <span>{loan ? `${loan.history.length}${loan.historyTruncated ? "+" : ""}` : "0"}</span></TabButton>
        </div>

        <div className={styles.managerBody}>
          {loading ? <ManagerState title="Завантажуємо відомість…" /> : null}
          {!loading && error && !loan ? (
            <ManagerState title={error} actionLabel="Спробувати ще" onAction={() => void load()} />
          ) : null}
          {loan ? (
            <>
              <div className={styles.managerSummary}>
                <span className={loan.status === "open" ? styles.statusOpen : styles.statusClosed}>
                  {statusLabel(loan.status)}
                </span>
                <strong>{activeItems.length} поз. · {activeCopies} прим.</strong>
              </div>

              {loan.classYearStatus !== "active" ? (
                <p className={styles.managerNotice}>Клас уже закрито. Відомість та її історія доступні лише для перегляду.</p>
              ) : loan.status !== "open" ? (
                <p className={styles.managerNotice}>Закрита або скасована видача доступна лише для перегляду.</p>
              ) : !writesEnabled ? (
                <p className={styles.managerNotice}>Запис змін зараз вимкнено адміністратором.</p>
              ) : null}

              {pendingPatch ? (
                <p className={styles.managerNotice}>Попередня зміна ще не підтверджена. Нові дії заблоковано, доки ви не перевірите той самий запит або не оновите дані.</p>
              ) : null}

              {tab !== "history" && canWrite ? (
                <label className={styles.reasonField}>
                  <span>Причина змін</span>
                  <input disabled={!canMutate || saving} maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} />
                </label>
              ) : null}

              {tab === "items" ? (
                <ItemsTab
                  loan={loan}
                  activeItems={activeItems}
                  removedItems={removedItems}
                  canWrite={canMutate}
                  saving={saving}
                  quantityDrafts={quantityDrafts}
                  setQuantityDrafts={setQuantityDrafts}
                  legacyLineDrafts={legacyLineDrafts}
                  setLegacyLineDrafts={setLegacyLineDrafts}
                  onChangeQuantity={(item) => void changeQuantity(item)}
                  onRemove={(item) => void removeItem(item)}
                  onRestore={(item) => void restoreItem(item)}
                  onLinkLegacy={(item) => void linkLegacyItem(item)}
                />
              ) : null}

              {tab === "metadata" ? (
                <form className={styles.metadataForm} role="tabpanel" id="statement-manager-metadata" aria-labelledby="statement-manager-tab-metadata" onSubmit={updateMetadata}>
                  <div className={styles.readOnlyMeta}>
                    <div><span>Клас</span><strong>{loan.className}</strong></div>
                    <div><span>Навчальний рік</span><strong>{loan.academicYearLabel}</strong></div>
                    <div><span>Початкова дата видачі</span><strong>{formatDate(loan.issuedAt)}</strong></div>
                  </div>
                  <label>
                    <span>Відповідальний учитель</span>
                    <select disabled={!canMutate || saving} value={teacherUserId} onChange={(event) => setTeacherUserId(event.target.value)}>
                      {teachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.fullName}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>Повернути до</span>
                    <input disabled={!canMutate || saving} type="date" min={loan.issuedAt.slice(0, 10)} value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
                  </label>
                  <label>
                    <span>Примітка</span>
                    <textarea disabled={!canMutate || saving} rows={4} maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Внутрішня примітка до видачі" />
                  </label>
                  {canWrite ? <button className={styles.managerPrimaryButton} type="submit" disabled={!canMutate || saving || !teacherUserId || !metadataChanged}>{saving ? "Зберігаємо…" : "Зберегти дані"}</button> : null}
                </form>
              ) : null}

              {tab === "history" ? (
                <HistoryTab
                  items={loan.history}
                  truncated={loan.historyTruncated}
                  historyLimit={loan.historyLimit}
                  canLoadMore={loan.historyTruncated && historyLimit < 200}
                  loading={loading}
                  onLoadMore={() => setHistoryLimit((current) => Math.min(200, current + 80))}
                />
              ) : null}
            </>
          ) : null}
        </div>

        <footer className={styles.managerFooter} aria-live="polite">
          <div>
            {error && loan ? <strong className={styles.managerError}>{error}</strong> : null}
            {message ? <span>{message}</span> : null}
          </div>
          {pendingPatch ? (
            <button type="button" disabled={saving} onClick={() => void sendPatch(pendingPatch, true)}>
              {saving ? "Перевіряємо…" : "Перевірити той самий запит"}
            </button>
          ) : null}
        </footer>
      </section>
    </div>
  );
}

function ItemsTab({
  loan,
  activeItems,
  removedItems,
  canWrite,
  saving,
  quantityDrafts,
  setQuantityDrafts,
  legacyLineDrafts,
  setLegacyLineDrafts,
  onChangeQuantity,
  onRemove,
  onRestore,
  onLinkLegacy,
}: {
  loan: ManagedClassLoan;
  activeItems: ManagedClassLoanItem[];
  removedItems: ManagedClassLoanItem[];
  canWrite: boolean;
  saving: boolean;
  quantityDrafts: Record<string, string>;
  setQuantityDrafts: (value: React.SetStateAction<Record<string, string>>) => void;
  legacyLineDrafts: Record<string, string>;
  setLegacyLineDrafts: (value: React.SetStateAction<Record<string, string>>) => void;
  onChangeQuantity: (item: ManagedClassLoanItem) => void;
  onRemove: (item: ManagedClassLoanItem) => void;
  onRestore: (item: ManagedClassLoanItem) => void;
  onLinkLegacy: (item: ManagedClassLoanItem) => void;
}) {
  return (
    <div className={styles.itemsTab} role="tabpanel" id="statement-manager-items" aria-labelledby="statement-manager-tab-items">
      <div className={styles.itemsToolbar}>
        <div><strong>Підручники класу</strong><small>Кількість змінюється разом із залишками фонду.</small></div>
        {canWrite ? <a href={classIssueHref(loan)}>+ Додати підручники</a> : null}
      </div>
      {!activeItems.length ? <p className={styles.emptyState}>В актуальній відомості немає підручників.</p> : null}
      <div className={styles.managedItems}>
        {activeItems.map((item) => {
          const draft = quantityDrafts[item.classLoanItemId] ?? String(item.quantityIssued);
          const draftNumber = Number(draft);
          const minimum = Math.max(1, item.quantityReturned);
          const maximum = item.quantityIssued + item.currentAvailableAtSource;
          const changed = Number.isInteger(draftNumber) && draftNumber !== item.quantityIssued;
          const editable = canWrite && item.editable && !saving;
          return (
            <article key={item.classLoanItemId} className={styles.managedItem}>
              <div className={styles.managedItemIdentity}>
                <div>
                  <span>{item.subject || "Без предмета"}</span>
                  <strong>{item.title}</strong>
                  <small>{[item.author, item.publicationYear].filter(Boolean).join(" · ") || "Автор і рік не вказані"}</small>
                  <small>{item.sourceLocationName} · {conditionLabel(item.condition)}</small>
                </div>
                <dl>
                  <div><dt>Видано</dt><dd>{item.quantityIssued}</dd></div>
                  <div><dt>Повернено</dt><dd>{item.quantityReturned}</dd></div>
                  <div><dt>На класі</dt><dd>{item.quantityOutstanding}</dd></div>
                </dl>
              </div>
              <div className={styles.quantityEditor}>
                <button type="button" aria-label={`Зменшити кількість: ${item.title}`} disabled={!editable || draftNumber <= minimum} onClick={() => setQuantityDrafts((current) => ({ ...current, [item.classLoanItemId]: String(Math.max(minimum, (Number(current[item.classLoanItemId]) || item.quantityIssued) - 1)) }))}>−</button>
                <label><span>Кількість</span><input aria-label={`Кількість: ${item.title}`} type="number" min={minimum} max={maximum} inputMode="numeric" disabled={!editable} value={draft} onChange={(event) => setQuantityDrafts((current) => ({ ...current, [item.classLoanItemId]: event.target.value }))} /></label>
                <button type="button" aria-label={`Збільшити кількість: ${item.title}`} disabled={!editable || draftNumber >= maximum} onClick={() => setQuantityDrafts((current) => ({ ...current, [item.classLoanItemId]: String(Math.min(maximum, (Number(current[item.classLoanItemId]) || item.quantityIssued) + 1)) }))}>+</button>
                <button className={styles.saveItemButton} type="button" disabled={!editable || !changed} onClick={() => onChangeQuantity(item)}>Зберегти</button>
              </div>
              {!item.editable && item.editBlockedReason ? (
                <p className={styles.itemBlockedReason}>{editBlockedReasonLabel(item.editBlockedReason)}</p>
              ) : null}
              {canWrite && item.editBlockedReason === "statement_item_link_missing" ? (
                <div className={styles.legacyLinkEditor}>
                  <label>
                    <span>Рядок у старій відомості</span>
                    <select
                      disabled={saving}
                      value={legacyLineDrafts[item.classLoanItemId] ?? ""}
                      onChange={(event) => setLegacyLineDrafts((current) => ({
                        ...current,
                        [item.classLoanItemId]: event.target.value,
                      }))}
                    >
                      <option value="">Оберіть відповідний рядок</option>
                      {loan.legacyStatementCandidates.map((candidate) => (
                        <option key={candidate.statementLineId} value={candidate.statementLineId}>
                          {legacyStatementCandidateLabel(candidate)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    disabled={saving || !(legacyLineDrafts[item.classLoanItemId] ?? "")}
                    onClick={() => onLinkLegacy(item)}
                  >
                    Підтвердити зв’язок
                  </button>
                </div>
              ) : null}
              {canWrite ? (
                <div className={styles.itemDangerRow}>
                  <span>{item.currentAvailableAtSource > 0 ? `Ще доступно у джерелі: ${item.currentAvailableAtSource}` : "Додаткових примірників у джерелі немає"}</span>
                  <button type="button" disabled={!editable} onClick={() => onRemove(item)}>Прибрати</button>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>

      {removedItems.length ? (
        <details className={styles.removedItems}>
          <summary>Прибрані позиції <span>{removedItems.length}</span></summary>
          <div>
            {removedItems.map((item) => {
              const draft = quantityDrafts[item.classLoanItemId] ?? String(Math.max(1, item.quantityIssued));
              const minimum = Math.max(1, item.quantityReturned);
              const maximum = item.quantityReturned + item.currentAvailableAtSource;
              return (
                <article key={item.classLoanItemId}>
                  <div>
                    <strong>{item.title}</strong>
                    <small>{item.removedAt ? `Прибрано ${formatDateTime(item.removedAt)}` : "Позицію прибрано"}</small>
                    {!item.editable && item.editBlockedReason ? (
                      <p className={styles.itemBlockedReason}>{editBlockedReasonLabel(item.editBlockedReason)}</p>
                    ) : null}
                  </div>
                  {canWrite ? (
                    <div>
                      <input aria-label={`Кількість для відновлення: ${item.title}`} type="number" min={minimum} max={maximum} inputMode="numeric" disabled={saving || !item.editable} value={draft} onChange={(event) => setQuantityDrafts((current) => ({ ...current, [item.classLoanItemId]: event.target.value }))} />
                      <button type="button" disabled={saving || !item.editable || maximum < minimum} onClick={() => onRestore(item)}>Відновити</button>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function HistoryTab({
  items,
  truncated,
  historyLimit,
  canLoadMore,
  loading,
  onLoadMore,
}: {
  items: LoanHistoryItem[];
  truncated: boolean;
  historyLimit: number;
  canLoadMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}) {
  if (!items.length) return <p className={styles.emptyState} role="tabpanel" id="statement-manager-history" aria-labelledby="statement-manager-tab-history">Історія змін поки порожня.</p>;
  return (
    <div className={styles.historyPanel} role="tabpanel" id="statement-manager-history" aria-labelledby="statement-manager-tab-history">
      {truncated ? <p>Показано останні {items.length} із понад {historyLimit} записів.</p> : null}
      <ol className={styles.historyList}>
        {items.map((item) => (
          <li key={item.id}>
            <span aria-hidden="true" />
            <div>
              <strong>{item.label || historyLabel(item.action)}</strong>
              <small>{formatDateTime(item.occurredAt)} · {item.actorName || "Система"}</small>
              {historyDetails(item.details) ? <p>{historyDetails(item.details)}</p> : null}
            </div>
          </li>
        ))}
      </ol>
      {canLoadMore ? <button type="button" disabled={loading} onClick={onLoadMore}>{loading ? "Завантажуємо…" : "Завантажити ще"}</button> : null}
    </div>
  );
}

function TabButton({ active, id, onSelect, children }: {
  active: boolean;
  id: ManagerTab;
  onSelect: (tab: ManagerTab) => void;
  children: React.ReactNode;
}) {
  function onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs: ManagerTab[] = ["items", "metadata", "history"];
    const currentIndex = tabs.indexOf(id);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    onSelect(next);
    window.queueMicrotask(() => document.getElementById(`statement-manager-tab-${next}`)?.focus());
  }
  return (
    <button
      id={`statement-manager-tab-${id}`}
      type="button"
      role="tab"
      aria-selected={active}
      aria-controls={`statement-manager-${id}`}
      tabIndex={active ? 0 : -1}
      className={active ? styles.managerTabActive : undefined}
      onClick={() => onSelect(id)}
      onKeyDown={onKeyDown}
    >
      {children}
    </button>
  );
}

function ManagerState({ title, actionLabel, onAction }: {
  title: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return <div className={styles.managerState}><strong>{title}</strong>{actionLabel && onAction ? <button type="button" onClick={onAction}>{actionLabel}</button> : null}</div>;
}

class HttpResponseError extends Error {}

async function readJson<T>(response: Response): Promise<T> {
  return response.json().catch(() => ({})) as Promise<T>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Сталася невідома помилка.";
}

function statusLabel(status: LoanStatus): string {
  if (status === "closed") return "Повернено";
  if (status === "cancelled") return "Скасовано";
  return "Відкрита видача";
}

function conditionLabel(condition: string): string {
  if (condition === "good") return "Добрий стан";
  if (condition === "worn") return "Зношений";
  if (condition === "damaged") return "Пошкоджений";
  return "Стан не уточнено";
}

function editBlockedReasonLabel(reason: ManagedClassLoanItem["editBlockedReason"]): string {
  return reason === "statement_item_link_missing"
    ? "Це давня позиція без однозначного зв’язку. Звірте її з паперовою або старою відомістю та підтвердьте відповідний рядок нижче."
    : "Ця видача доступна лише для перегляду.";
}

function historyLabel(action: string): string {
  const labels: Record<string, string> = {
    "class_loan.issued": "Оформлено видачу",
    "class_loan.appended": "Додано підручники",
    "class_loan.metadata_updated": "Оновлено дані видачі",
    "class_loan_item.quantity_updated": "Змінено кількість",
    "class_loan_item.removed": "Прибрано позицію",
    "class_loan_item.restored": "Відновлено позицію",
    "class_loan.legacy_item_linked": "Підтверджено старий рядок відомості",
    "class_loan.returned": "Прийнято повернення",
    quantity_changed: "Змінено кількість",
    removed: "Прибрано позицію",
    restored: "Відновлено позицію",
    issue: "Оформлено видачу",
    return: "Прийнято повернення",
  };
  return labels[action] || action.replaceAll("_", " ").replaceAll(".", " · ");
}

function historyDetails(details: unknown): string {
  if (typeof details === "string") return details.trim();
  if (!details || typeof details !== "object") return "";
  const source = details as Record<string, unknown>;
  if (typeof source.summary === "string") return source.summary.trim();
  if (typeof source.reason === "string") return source.reason.trim();
  const before = source.quantityBefore;
  const after = source.quantityAfter;
  if (typeof before === "number" && typeof after === "number") return `Кількість: ${before} → ${after}`;
  return "";
}

function formatDate(value: string): string {
  const source = value.length === 10 ? `${value}T12:00:00+03:00` : value;
  const date = new Date(source);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("uk-UA", {
    timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric",
  }).format(date);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("uk-UA", {
    timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function normalizeManagementLoan(value: unknown): ManagedClassLoan {
  if (!isRecord(value)) throw new Error("Сервер повернув некоректні дані відомості.");
  const header = isRecord(value.header) ? value.header : value;
  const rawItems = Array.isArray(value.items) ? value.items : [];
  const rawHistory = Array.isArray(value.history) ? value.history : [];
  const rawLegacyCandidates = Array.isArray(value.legacyStatementCandidates)
    ? value.legacyStatementCandidates
    : [];
  const classLoanId = textValue(header.classLoanId);
  if (!classLoanId) throw new Error("Сервер не повернув номер відомості.");
  const items = rawItems.filter(isRecord).map((item) => {
    const quantityIssued = integerValue(item.quantityIssued);
    const quantityReturned = Math.min(quantityIssued, integerValue(item.quantityReturned));
    const lifecycleStatus: ItemLifecycleStatus = item.lifecycleStatus === "removed" ? "removed" : "active";
    return {
      classLoanItemId: textValue(item.classLoanItemId),
      materialId: textValue(item.materialId),
      title: textValue(item.title) || "Матеріал",
      author: textValue(item.author),
      publicationYear: nullableIntegerValue(item.publicationYear),
      subject: textValue(item.subject),
      sourceLocationId: textValue(item.sourceLocationId),
      sourceLocationName: textValue(item.sourceLocationName),
      condition: textValue(item.condition) || "unspecified",
      quantityIssued,
      quantityReturned,
      quantityOutstanding: lifecycleStatus === "active"
        ? Math.max(0, integerValue(item.quantityOutstanding) || quantityIssued - quantityReturned)
        : 0,
      version: Math.max(1, integerValue(item.version)),
      lifecycleStatus,
      editable: item.editable === true,
      currentAvailableAtSource: integerValue(
        item.currentAvailableAtSource ?? item.availableQuantity,
      ),
      editBlockedReason: item.editBlockedReason === "loan_not_open"
        || item.editBlockedReason === "statement_item_link_missing"
        ? item.editBlockedReason
        : null,
      removedAt: nullableTextValue(item.removedAt),
    } satisfies ManagedClassLoanItem;
  }).filter((item) => item.classLoanItemId);
  return {
    classLoanId,
    classYearId: textValue(header.classYearId),
    className: textValue(header.className),
    classYearStatus: classYearStatusValue(header.classYearStatus),
    academicYearLabel: textValue(header.academicYearLabel),
    status: loanStatusValue(header.status),
    version: Math.max(1, integerValue(header.version)),
    responsibleTeacherUserId: textValue(header.responsibleTeacherUserId),
    responsibleTeacherName: textValue(header.responsibleTeacherName),
    issuedAt: textValue(header.issuedAt),
    dueAt: nullableTextValue(header.dueAt),
    notes: textValue(header.notes),
    items,
    legacyStatementCandidates: rawLegacyCandidates.filter(isRecord).map((candidate) => ({
      statementLineId: textValue(candidate.statementLineId),
      title: textValue(candidate.title) || "Матеріал",
      author: textValue(candidate.author),
      publicationYear: nullableIntegerValue(candidate.publicationYear),
      subject: textValue(candidate.subject),
      rubric: textValue(candidate.rubric),
      quantityIssued: integerValue(candidate.quantityIssued),
    })).filter((candidate) => candidate.statementLineId),
    history: rawHistory.filter(isRecord).map(normalizeHistoryItem),
    historyLimit: Math.max(1, integerValue(value.historyLimit) || 120),
    historyTruncated: value.historyTruncated === true,
  };
}

function normalizeHistoryItem(item: Record<string, unknown>): LoanHistoryItem {
  const kind = textValue(item.kind);
  const rawAction = textValue(item.action);
  const action = rawAction || (
    kind === "return" ? "return" : kind === "issue" ? "issue" : kind || "change"
  );
  let details: unknown = item.details;
  if (kind === "adjustment") {
    details = {
      quantityBefore: integerValue(item.quantityBefore),
      quantityAfter: integerValue(item.quantityAfter),
      summary: textValue(item.reason),
    };
  } else if (kind === "issue" || kind === "return") {
    const lines = Array.isArray(item.lines) ? item.lines : [];
    const notes = textValue(item.notes);
    details = notes || (lines.length ? `${lines.length} поз. у цій операції` : "");
  } else if (kind === "metadata" && isRecord(item.metadata)) {
    details = item.metadata;
  }
  return {
    id: textValue(item.id) || `${kind}:${textValue(item.occurredAt)}:${crypto.randomUUID()}`,
    action,
    label: textValue(item.label) || undefined,
    actorName: textValue(item.actorName),
    occurredAt: textValue(item.occurredAt) || textValue(item.createdAt),
    details,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function nullableTextValue(value: unknown): string | null {
  return textValue(value) || null;
}

function integerValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function nullableIntegerValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function loanStatusValue(value: unknown): LoanStatus {
  return value === "closed" || value === "cancelled" ? value : "open";
}

function classYearStatusValue(value: unknown): "planned" | "active" | "closed" {
  return value === "planned" || value === "closed" ? value : "active";
}

function classIssueHref(loan: ManagedClassLoan): string {
  const returnTo = `/librarian/class-loans/${encodeURIComponent(loan.classLoanId)}/statement`;
  const query = new URLSearchParams({
    tool: "class-issue",
    classLoanId: loan.classLoanId,
    classYearId: loan.classYearId,
    teacherUserId: loan.responsibleTeacherUserId,
    issuedAt: loan.issuedAt.slice(0, 10),
    returnTo,
  });
  query.set("dueAt", loan.dueAt ?? "");
  return `/librarian?${query.toString()}`;
}

function suggestedLegacyStatementLineId(
  item: ManagedClassLoanItem,
  candidates: LegacyStatementCandidate[],
): string {
  if (item.editBlockedReason !== "statement_item_link_missing") return "";
  const exact = candidates.filter((candidate) => (
    candidate.title === item.title
    && candidate.author === item.author
    && candidate.publicationYear === item.publicationYear
    && candidate.subject === item.subject
    && candidate.quantityIssued === item.quantityIssued
  ));
  return exact.length === 1 ? exact[0].statementLineId : "";
}

function legacyStatementCandidateLabel(candidate: LegacyStatementCandidate): string {
  const description = [
    candidate.title,
    candidate.author,
    candidate.publicationYear,
    candidate.subject,
  ].filter(Boolean).join(" · ");
  return `${description || "Матеріал"} · ${candidate.quantityIssued} прим.`;
}

function pendingPatchStorageKey(classLoanId: string): string {
  return `library.class-loan.pending-patch.v1:${classLoanId}`;
}

function readStoredPendingPatch(classLoanId: string): PatchPayload | null {
  if (typeof window === "undefined") return null;
  try {
    const value: unknown = JSON.parse(
      window.sessionStorage.getItem(pendingPatchStorageKey(classLoanId)) ?? "null",
    );
    if (!isRecord(value)) return null;
    const action = value.action;
    const requestId = textValue(value.requestId);
    const expectedVersion = Number(value.expectedVersion);
    const reason = textValue(value.reason);
    if (
      !requestId
      || !Number.isSafeInteger(expectedVersion)
      || expectedVersion < 1
      || reason.length < 2
      || ![
        "update_metadata",
        "set_item_quantity",
        "remove_item",
        "restore_item",
        "link_legacy_item",
      ].includes(String(action))
    ) return null;
    return value as PatchPayload;
  } catch {
    return null;
  }
}

function persistPendingPatch(classLoanId: string, payload: PatchPayload | null): void {
  if (typeof window === "undefined") return;
  const key = pendingPatchStorageKey(classLoanId);
  try {
    if (payload) window.sessionStorage.setItem(key, JSON.stringify(payload));
    else window.sessionStorage.removeItem(key);
  } catch {
    // Idempotent retry remains available while this manager instance is open.
  }
}
