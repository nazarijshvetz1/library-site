"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

type DraftKind =
  | "material.create"
  | "material.update"
  | "receipt.create"
  | "transfer.create"
  | "writeoff.create"
  | "revision.count"
  | "academic-year.create"
  | "class-year.create"
  | "class-year.update"
  | "class-year.close"
  | "academic-year.rollover";

type CatalogMaterial = Record<string, unknown> & {
  id?: unknown;
  isbn?: unknown;
  rubric?: unknown;
  type?: unknown;
  subject?: unknown;
  classFrom?: unknown;
  classTo?: unknown;
  title?: unknown;
  author?: unknown;
  stock?: unknown;
};

type SavedDraft = {
  id: string;
  kind: DraftKind;
  payload: Record<string, unknown>;
  revision: number;
  status: string;
  createdAt: string;
  updatedAt: string;
};

type LoadState = "loading" | "ready" | "error";

type SubmitState = {
  phase: "idle" | "saving" | "success" | "error";
  message: string;
};

type SaveDraftResult = {
  draft: SavedDraft | null;
  fieldErrors: Record<string, string>;
  stale?: boolean;
};

type DraftAction = "submit" | "cancel";

type ReferenceTeacher = {
  id: string;
  name: string;
  role: string;
  status: string;
};

type ReferenceLocation = {
  id: string;
  name: string;
  type: string;
  status: string;
};

type ReferenceAcademicYear = {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  status: string;
  notes: string;
};

type ReferenceClassYear = {
  id: string;
  academicYearId: string;
  academicYearLabel: string;
  cohortId: string;
  className: string;
  grade: number | null;
  code: string;
  teacherName: string;
  teacherUserId: string;
  locationName: string;
  locationId: string;
  startDate: string;
  endDate: string;
  status: string;
  actualClosedDate: string;
  notes: string;
};

type ReferenceData = {
  teachers: ReferenceTeacher[];
  locations: ReferenceLocation[];
  academicYears: ReferenceAcademicYear[];
  classYears: ReferenceClassYear[];
};

type ReferenceState = {
  phase: "loading" | "ready" | "error";
  message: string;
  generatedAt: string | null;
};

type BookLookupCandidate = {
  isbn: string;
  title: string;
  authors: string[];
  publisher: string;
  publishedYear: number | null;
  coverUrl: string;
  sourceUrl: string;
  provider: "google_books" | "open_library";
};

type WorkspaceProps = {
  displayName: string;
  role: "librarian" | "admin";
  writesEnabled: boolean;
  signOutHref: string;
};

type BarcodeResult = { rawValue: string };
type BarcodeDetectorInstance = {
  detect(source: HTMLVideoElement): Promise<BarcodeResult[]>;
};
type BarcodeDetectorConstructor = new (options?: {
  formats?: string[];
}) => BarcodeDetectorInstance;

declare global {
  interface Window {
    BarcodeDetector?: BarcodeDetectorConstructor;
  }
}

const LOGO_URL =
  "https://nazarijshvetz1.github.io/library-site/library-logo.png";
const PUBLIC_CATALOG_URL = "https://nazarijshvetz1.github.io/library-site/";

const SCENARIOS: Array<{
  kind: DraftKind;
  group: "catalog" | "movement" | "classes";
  label: string;
  shortLabel: string;
  description: string;
  icon: string;
}> = [
  {
    kind: "material.create",
    group: "catalog",
    label: "Новий матеріал",
    shortLabel: "Додати",
    description: "Підготуйте бібліографічну картку",
    icon: "＋",
  },
  {
    kind: "material.update",
    group: "catalog",
    label: "Редагування матеріалу",
    shortLabel: "Редагувати",
    description: "Підготуйте виправлення картки",
    icon: "✎",
  },
  {
    kind: "receipt.create",
    group: "movement",
    label: "Надходження",
    shortLabel: "Надходження",
    description: "Зафіксуйте нові примірники",
    icon: "↓",
  },
  {
    kind: "transfer.create",
    group: "movement",
    label: "Переміщення",
    shortLabel: "Перемістити",
    description: "Підготуйте зміну розміщення",
    icon: "⇄",
  },
  {
    kind: "writeoff.create",
    group: "movement",
    label: "Списання",
    shortLabel: "Списати",
    description: "Підготуйте акт списання або втрати",
    icon: "−",
  },
  {
    kind: "revision.count",
    group: "movement",
    label: "Ревізія",
    shortLabel: "Ревізія",
    description: "Запишіть фактичну кількість",
    icon: "✓",
  },
  {
    kind: "academic-year.create",
    group: "classes",
    label: "Новий навчальний рік",
    shortLabel: "Новий рік",
    description: "Підготуйте наступний навчальний період",
    icon: "▣",
  },
  {
    kind: "class-year.create",
    group: "classes",
    label: "Відкрити клас",
    shortLabel: "Відкрити клас",
    description: "Додайте клас до навчального року",
    icon: "+",
  },
  {
    kind: "class-year.update",
    group: "classes",
    label: "Змінити клас",
    shortLabel: "Змінити клас",
    description: "Змініть керівника, кабінет або назву",
    icon: "↻",
  },
  {
    kind: "class-year.close",
    group: "classes",
    label: "Закрити клас",
    shortLabel: "Закрити клас",
    description: "Збережіть історію закритого класу",
    icon: "×",
  },
  {
    kind: "academic-year.rollover",
    group: "classes",
    label: "Перехід на новий рік",
    shortLabel: "Перехід класів",
    description: "Переведіть класи зі збереженням історії",
    icon: "⇢",
  },
];

const KIND_LABELS: Record<DraftKind, string> = {
  "material.create": "Новий матеріал",
  "material.update": "Редагування матеріалу",
  "receipt.create": "Надходження",
  "transfer.create": "Переміщення",
  "writeoff.create": "Списання",
  "revision.count": "Ревізія",
  "academic-year.create": "Новий навчальний рік",
  "class-year.create": "Відкрити клас",
  "class-year.update": "Змінити клас",
  "class-year.close": "Закрити клас",
  "academic-year.rollover": "Перехід на новий рік",
};

const SCENARIO_GROUPS = [
  { id: "catalog" as const, label: "Каталог" },
  { id: "movement" as const, label: "Облік примірників" },
  { id: "classes" as const, label: "Навчальні роки й класи" },
];

const EMPTY_REFERENCE_DATA: ReferenceData = {
  teachers: [],
  locations: [],
  academicYears: [],
  classYears: [],
};

export default function LibrarianWorkspace({
  displayName,
  role,
  writesEnabled,
  signOutHref,
}: WorkspaceProps) {
  const [activeKind, setActiveKind] = useState<DraftKind>("material.create");
  const [catalog, setCatalog] = useState<CatalogMaterial[]>([]);
  const [drafts, setDrafts] = useState<SavedDraft[]>([]);
  const [editingDraft, setEditingDraft] = useState<SavedDraft | null>(null);
  const [formOpenVersion, setFormOpenVersion] = useState(0);
  const [formHasUnsavedChanges, setFormHasUnsavedChanges] = useState(false);
  const editingDraftRef = useRef<SavedDraft | null>(null);
  const formStateRef = useRef({ dirty: false, stale: false });
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadMessage, setLoadMessage] = useState("Завантажуємо службові дані…");
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [apiStats, setApiStats] = useState<Record<string, unknown>>({});
  const [referenceData, setReferenceData] = useState<ReferenceData>(EMPTY_REFERENCE_DATA);
  const [referenceState, setReferenceState] = useState<ReferenceState>({
    phase: "loading",
    message: "Завантажуємо захищені довідники…",
    generatedAt: null,
  });
  const [submitState, setSubmitState] = useState<SubmitState>({
    phase: "idle",
    message: "",
  });

  const loadWorkspace = useCallback(async (signal?: AbortSignal) => {
    setLoadState("loading");
    setLoadMessage("Завантажуємо службові дані…");
    setReferenceState((current) => ({
      ...current,
      phase: "loading",
      message: "Завантажуємо захищені довідники…",
    }));

    try {
      const [catalogResponse, draftsResponse, referenceResponse] = await Promise.all([
        fetch("/api/librarian/catalog", { cache: "no-store", signal }),
        fetch("/api/librarian/drafts", { cache: "no-store", signal }),
        fetch("/api/librarian/reference-data", { cache: "no-store", signal })
          .catch(() => null),
      ]);

      const catalogBody = await catalogResponse.json();
      const draftsBody = await draftsResponse.json();
      const referenceBody: unknown = referenceResponse
        ? await referenceResponse.json().catch(() => null)
        : null;

      if (!catalogResponse.ok || catalogBody.success !== true) {
        throw new Error(readApiError(catalogBody, "Не вдалося завантажити каталог"));
      }
      if (!draftsResponse.ok || draftsBody.success !== true) {
        throw new Error(readApiError(draftsBody, "Не вдалося завантажити чернетки"));
      }

      setCatalog(Array.isArray(catalogBody.materials) ? catalogBody.materials : []);
      const loadedDrafts: SavedDraft[] = Array.isArray(draftsBody.drafts)
        ? draftsBody.drafts
        : [];
      setDrafts(loadedDrafts);
      const currentEditingDraft = editingDraftRef.current;
      const refreshedDraft = currentEditingDraft
        ? loadedDrafts.find((draft) => draft.id === currentEditingDraft.id)
        : null;
      if (
        refreshedDraft
        && !formStateRef.current.dirty
        && !formStateRef.current.stale
      ) {
        editingDraftRef.current = refreshedDraft;
        setEditingDraft(refreshedDraft);
        setFormOpenVersion((current) => current + 1);
      }
      setApiStats(isRecord(catalogBody.stats) ? catalogBody.stats : {});
      setGeneratedAt(typeof catalogBody.generatedAt === "string" ? catalogBody.generatedAt : null);
      if (
        referenceResponse?.ok
        && isRecord(referenceBody)
        && referenceBody.success === true
        && isRecord(referenceBody.referenceData)
      ) {
        setReferenceData(normalizeReferenceData(referenceBody.referenceData));
        setReferenceState({
          phase: "ready",
          message: "Захищені довідники завантажено",
          generatedAt: typeof referenceBody.generatedAt === "string"
            ? referenceBody.generatedAt
            : null,
        });
      } else {
        setReferenceData(EMPTY_REFERENCE_DATA);
        setReferenceState({
          phase: "error",
          message: readApiError(referenceBody, "Захищені довідники тимчасово недоступні"),
          generatedAt: null,
        });
      }
      setLoadState("ready");
      setLoadMessage("Дані готові до роботи");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setLoadState("error");
      setLoadMessage(error instanceof Error ? error.message : "Сталася помилка завантаження");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadWorkspace(controller.signal);
    return () => controller.abort();
  }, [loadWorkspace]);

  useEffect(() => {
    editingDraftRef.current = editingDraft;
  }, [editingDraft]);

  useEffect(() => {
    if (!formHasUnsavedChanges) return;
    const preventAccidentalExit = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventAccidentalExit);
    return () => window.removeEventListener("beforeunload", preventAccidentalExit);
  }, [formHasUnsavedChanges]);

  const handleFormDirtyChange = useCallback((dirty: boolean) => {
    formStateRef.current.dirty = dirty;
    setFormHasUnsavedChanges(dirty);
  }, []);

  const handleFormStaleChange = useCallback((stale: boolean) => {
    formStateRef.current.stale = stale;
  }, []);

  const saveDraft = useCallback(
    async (
      kind: DraftKind,
      payload: Record<string, unknown>,
      id?: string,
      revision?: number,
    ): Promise<SaveDraftResult> => {
      setSubmitState({ phase: "saving", message: "Зберігаємо чернетку…" });

      try {
        const response = await fetch("/api/librarian/drafts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(id ? { id } : {}),
            ...(typeof revision === "number" ? { revision } : {}),
            kind,
            payload,
          }),
        });
        const body = await response.json();

        if (!response.ok || body.success !== true || !body.draft) {
          const fieldErrors = readFieldErrors(body.fieldErrors);
          const fieldMessage = formatFieldErrors(fieldErrors);
          const stale = response.status === 409 || response.status === 428;
          const message = stale
            ? "Чернетка змінилася в іншій вкладці або вже надіслана. Дані не перезаписано — оновіть список і відкрийте чернетку знову."
            : fieldMessage || readApiError(body, "Не вдалося зберегти чернетку");
          setSubmitState({ phase: "error", message });
          return { draft: null, fieldErrors, stale };
        }

        setDrafts((current) => [body.draft, ...current.filter((item) => item.id !== body.draft.id)]);
        setEditingDraft((current) => current?.id === body.draft.id ? body.draft : current);
        setSubmitState({
          phase: "success",
          message: `Чернетку ${shortDraftId(body.draft.id)} збережено. Google Sheets не змінено.`,
        });
        return { draft: body.draft as SavedDraft, fieldErrors: {} };
      } catch (error) {
        setSubmitState({
          phase: "error",
          message: error instanceof Error ? error.message : "Не вдалося зберегти чернетку",
        });
        return { draft: null, fieldErrors: {} };
      }
    },
    [],
  );

  const transitionDraft = useCallback(
    async (
      id: string,
      revision: number,
      action: DraftAction,
    ): Promise<SaveDraftResult> => {
      setSubmitState({
        phase: "saving",
        message: action === "submit"
          ? "Надсилаємо чернетку на перевірку…"
          : "Скасовуємо чернетку…",
      });

      try {
        const response = await fetch("/api/librarian/drafts", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, revision, action }),
        });
        const body = await response.json();
        if (!response.ok || body.success !== true || !body.draft) {
          const stale = response.status === 409 || response.status === 428;
          setSubmitState({
            phase: "error",
            message: stale
              ? "Стан чернетки вже змінився. Дію не повторено — оновіть список перед наступною спробою."
              : readApiError(body, "Не вдалося змінити стан чернетки"),
          });
          return {
            draft: null,
            fieldErrors: readFieldErrors(body.fieldErrors),
            stale,
          };
        }

        const updated = body.draft as SavedDraft;
        setDrafts((current) => [updated, ...current.filter((item) => item.id !== updated.id)]);
        setEditingDraft((current) => current?.id === updated.id ? updated : current);
        setSubmitState({
          phase: "success",
          message: action === "submit"
            ? "Чернетку надіслано на перевірку. Google Sheets не змінено."
            : "Чернетку скасовано. Google Sheets не змінено.",
        });
        return { draft: updated, fieldErrors: {} };
      } catch (error) {
        setSubmitState({
          phase: "error",
          message: error instanceof Error ? error.message : "Не вдалося змінити стан чернетки",
        });
        return { draft: null, fieldErrors: {} };
      }
    },
    [],
  );

  const materialCount = readNumber(apiStats, ["materials", "materialCount", "totalMaterials"])
    ?? catalog.length;
  const draftCount = drafts.length;
  const todayCount = drafts.filter((draft) => isToday(draft.createdAt)).length;
  const activeScenario = SCENARIOS.find((item) => item.kind === activeKind) ?? SCENARIOS[0];

  const confirmDiscardChanges = () => (
    !formHasUnsavedChanges
    || window.confirm("Є незбережені зміни. Відкинути їх і перейти далі?")
  );

  const switchScenario = (kind: DraftKind): boolean => {
    if (kind === activeKind && !editingDraft) return true;
    if (!confirmDiscardChanges()) return false;
    handleFormDirtyChange(false);
    handleFormStaleChange(false);
    setActiveKind(kind);
    editingDraftRef.current = null;
    setEditingDraft(null);
    setFormOpenVersion((current) => current + 1);
    setSubmitState({ phase: "idle", message: "" });
    return true;
  };

  const openDraft = (draft: SavedDraft) => {
    if (!confirmDiscardChanges()) return;
    handleFormDirtyChange(false);
    handleFormStaleChange(false);
    setActiveKind(draft.kind);
    editingDraftRef.current = draft;
    setEditingDraft(draft);
    setFormOpenVersion((current) => current + 1);
    setSubmitState({ phase: "idle", message: "" });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <main className="workspace-shell">
      <header className="workspace-header">
        <a className="brand-lockup compact" href="/" aria-label="Єдина бібліотека — головна">
          <img className="brand-logo" src={LOGO_URL} alt="" width="48" height="48" />
          <span><strong>Єдина бібліотека</strong><small>Кабінет бібліотекаря</small></span>
        </a>

        <div className="account-cluster">
          <a className="catalog-link" href={PUBLIC_CATALOG_URL}>Каталог <span aria-hidden="true">↗</span></a>
          <div className="account-copy">
            <strong>{displayName}</strong>
            <small>{role === "admin" ? "Адміністратор" : "Бібліотекар"}</small>
          </div>
          <a className="icon-button" href={signOutHref} aria-label="Вийти з облікового запису" title="Вийти">
            ↗
          </a>
        </div>
      </header>

      <div className="workspace-grid">
        <aside className="workspace-sidebar" aria-label="Робочі операції">
          <p className="sidebar-label">Операції</p>
          <nav className="scenario-nav">
            {SCENARIO_GROUPS.map((group) => (
              <div className="scenario-group" key={group.id}>
                <p>{group.label}</p>
                {SCENARIOS.filter((scenario) => scenario.group === group.id).map((scenario) => (
                  <button
                    key={scenario.kind}
                    type="button"
                    className={scenario.kind === activeKind ? "scenario-button active" : "scenario-button"}
                    onClick={() => switchScenario(scenario.kind)}
                    aria-current={scenario.kind === activeKind ? "page" : undefined}
                  >
                    <span className="scenario-icon" aria-hidden="true">{scenario.icon}</span>
                    <span><strong>{scenario.label}</strong><small>{scenario.description}</small></span>
                  </button>
                ))}
              </div>
            ))}
          </nav>

          <div className="sidebar-safety">
            <span aria-hidden="true">◉</span>
            <div><strong>Безпечний режим</strong><p>Усі дії зберігаються як чернетки.</p></div>
          </div>
        </aside>

        <section className="workspace-main" aria-labelledby="workspace-title">
          <div className="workspace-title-row">
            <div>
              <p className="eyebrow"><span aria-hidden="true" /> Робоча область</p>
              <h1 id="workspace-title">{activeScenario.label}</h1>
              <p>{activeScenario.description}. Перевірте дані перед збереженням.</p>
            </div>
            <button className="refresh-button" type="button" onClick={() => void loadWorkspace()} disabled={loadState === "loading"}>
              <span aria-hidden="true">↻</span> {loadState === "loading" ? "Оновлення…" : "Оновити дані"}
            </button>
          </div>

          <div className="draft-safety-banner" role="status">
            <span className="safety-icon" aria-hidden="true">✎</span>
            <div>
              <strong>Режим чернетки · Google Sheets не змінено</strong>
              <p>
                Збережені записи очікують окремої перевірки та підтвердження бібліотекарем.
                {writesEnabled ? " Автоматичний запис у таблицю для цієї форми все одно не виконується." : ""}
              </p>
            </div>
          </div>

          <section className="summary-row" aria-label="Стан робочих даних">
            <article><span>Матеріалів у каталозі</span><strong>{formatNumber(materialCount)}</strong><small>{loadState === "ready" ? "дані завантажено" : loadMessage}</small></article>
            <article><span>Чернеток</span><strong>{formatNumber(draftCount)}</strong><small>ще не внесено до Sheets</small></article>
            <article><span>Створено сьогодні</span><strong>{formatNumber(todayCount)}</strong><small>{generatedAt ? `Каталог: ${formatDateTime(generatedAt)}` : "поточна сесія"}</small></article>
          </section>

          {loadState === "error" ? (
            <div className="inline-alert error" role="alert">
              <span aria-hidden="true">!</span><div><strong>Дані тимчасово недоступні</strong><p>{loadMessage}</p></div>
              <button type="button" onClick={() => void loadWorkspace()}>Спробувати знову</button>
            </div>
          ) : null}

          {referenceState.phase === "error" && activeScenario.group === "classes" ? (
            <div className="inline-alert warning" role="status">
              <span aria-hidden="true">i</span>
              <div>
                <strong>Довідники класів поки недоступні</strong>
                <p>{referenceState.message}. Спробуйте «Оновити дані»; незбережені дані не надсилаються до Sheets.</p>
              </div>
            </div>
          ) : null}

          <div className="work-columns">
            <section className="form-card" aria-label={`Форма: ${activeScenario.label}`}>
              <OperationForm
                key={`${activeKind}:${editingDraft?.id ?? "new"}:${formOpenVersion}`}
                kind={activeKind}
                catalog={catalog}
                catalogLoading={loadState === "loading"}
                sourceGeneratedAt={generatedAt}
                referenceData={referenceData}
                referenceState={referenceState}
                submitState={submitState}
                onSave={saveDraft}
                onTransition={transitionDraft}
                initialDraft={editingDraft}
                onDirtyChange={handleFormDirtyChange}
                onStaleChange={handleFormStaleChange}
                onReset={() => {
                  handleFormDirtyChange(false);
                  handleFormStaleChange(false);
                  editingDraftRef.current = null;
                  setEditingDraft(null);
                  setSubmitState({ phase: "idle", message: "" });
                }}
              />
            </section>

            <aside className="drafts-card" aria-labelledby="drafts-heading">
              <div className="card-heading">
                <div><p className="mini-label">Черга перевірки</p><h2 id="drafts-heading">Останні чернетки</h2></div>
                <span className="count-badge">{draftCount}</span>
              </div>

              {loadState === "loading" ? (
                <div className="draft-loading" aria-live="polite"><i /><i /><i /><span>Завантаження…</span></div>
              ) : drafts.length === 0 ? (
                <div className="empty-drafts"><span aria-hidden="true">□</span><strong>Чернеток ще немає</strong><p>Перший збережений запис з’явиться тут.</p></div>
              ) : (
                <ol className="draft-list">
                  {drafts.slice(0, 8).map((draft) => (
                    <li key={draft.id}>
                      <span className="draft-kind-icon" aria-hidden="true">{SCENARIOS.find((item) => item.kind === draft.kind)?.icon ?? "·"}</span>
                      <div><strong>{draftPrimaryText(draft)}</strong><small>{KIND_LABELS[draft.kind] ?? draft.kind} · {formatDateTime(draft.updatedAt || draft.createdAt)}</small></div>
                      <span className="draft-actions">
                        <span className={`draft-state status-${draft.status}`}>{draftStatusLabel(draft.status)}</span>
                        {draft.status === "draft" ? (
                          <button
                            className="draft-open"
                            type="button"
                            onClick={() => openDraft(draft)}
                          >
                            Відкрити
                          </button>
                        ) : draft.status === "ready_for_review" ? (
                          <button
                            className="draft-open draft-cancel"
                            type="button"
                            disabled={!isPositiveRevision(draft.revision) || submitState.phase === "saving"}
                            onClick={() => {
                              if (!window.confirm("Скасувати чернетку, надіслану на перевірку?")) return;
                              void transitionDraft(draft.id, draft.revision, "cancel");
                            }}
                          >
                            Скасувати
                          </button>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </aside>
          </div>
        </section>
      </div>

      <nav className="mobile-operation-nav" aria-label="Робочі операції">
        {SCENARIOS.map((scenario) => (
          <button
            key={scenario.kind}
            type="button"
            className={scenario.kind === activeKind ? "active" : ""}
            onClick={() => {
              if (switchScenario(scenario.kind)) {
                window.scrollTo({ top: 0, behavior: "smooth" });
              }
            }}
            aria-current={scenario.kind === activeKind ? "page" : undefined}
          >
            <span aria-hidden="true">{scenario.icon}</span>{scenario.shortLabel}
          </button>
        ))}
      </nav>
    </main>
  );
}

function OperationForm({
  kind,
  catalog,
  catalogLoading,
  sourceGeneratedAt,
  referenceData,
  referenceState,
  submitState,
  onSave,
  onTransition,
  initialDraft,
  onDirtyChange,
  onStaleChange,
  onReset,
}: {
  kind: DraftKind;
  catalog: CatalogMaterial[];
  catalogLoading: boolean;
  sourceGeneratedAt: string | null;
  referenceData: ReferenceData;
  referenceState: ReferenceState;
  submitState: SubmitState;
  initialDraft: SavedDraft | null;
  onSave: (
    kind: DraftKind,
    payload: Record<string, unknown>,
    id?: string,
    revision?: number,
  ) => Promise<SaveDraftResult>;
  onTransition: (
    id: string,
    revision: number,
    action: DraftAction,
  ) => Promise<SaveDraftResult>;
  onDirtyChange: (dirty: boolean) => void;
  onStaleChange: (stale: boolean) => void;
  onReset: () => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [draftId, setDraftId] = useState<string | null>(initialDraft?.id ?? null);
  const [draftRevision, setDraftRevision] = useState<number | null>(
    isPositiveRevision(initialDraft?.revision) ? initialDraft!.revision : null,
  );
  const [draftStatus, setDraftStatus] = useState(initialDraft?.status ?? "draft");
  const [stale, setStale] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [lastSavedPayload, setLastSavedPayload] = useState<Record<string, unknown> | null>(
    initialDraft?.payload ?? null,
  );
  const [coverCleanupMessage, setCoverCleanupMessage] = useState("");
  const requestIdRef = useRef(initialDraft?.id ?? crypto.randomUUID());
  const [formVersion, setFormVersion] = useState(0);
  const initialPayload = initialDraft?.payload ?? {};
  const markDirty = useCallback(() => setHasUnsavedChanges(true), []);

  useEffect(() => {
    onDirtyChange(hasUnsavedChanges);
  }, [hasUnsavedChanges, onDirtyChange]);

  useEffect(() => {
    onStaleChange(stale);
  }, [onStaleChange, stale]);

  useEffect(() => () => {
    onDirtyChange(false);
    onStaleChange(false);
  }, [onDirtyChange, onStaleChange]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;

    if (form.querySelector('[data-cover-upload-pending="true"]')) {
      setCoverCleanupMessage("Дочекайтеся завершення завантаження фотографії перед збереженням чернетки.");
      return;
    }

    if (kindNeedsMaterial(kind)) {
      const materialId = new FormData(form).get("materialId");
      if (typeof materialId !== "string" || !materialId.trim()) {
        const picker = form.querySelector<HTMLInputElement>("[data-material-picker-input]");
        picker?.setCustomValidity("Оберіть матеріал зі списку результатів.");
        picker?.reportValidity();
        picker?.focus();
        return;
      }
    }
    if (!form.reportValidity()) return;

    if (stale || draftStatus !== "draft") return;

    const payload = formPayload(
      new FormData(form),
      kind,
      referenceData,
      sourceGeneratedAt,
    );
    const previousCoverPhotoKey = draftCoverPhotoKey(kind, lastSavedPayload);
    const result = await onSave(
      kind,
      payload,
      draftId ?? requestIdRef.current,
      draftRevision ?? undefined,
    );
    if (result.draft) {
      setDraftId(result.draft.id);
      setDraftRevision(result.draft.revision);
      setDraftStatus(result.draft.status);
      setHasUnsavedChanges(false);
      setStale(false);
      setLastSavedPayload(result.draft.payload);
      const savedCoverPhotoKey = draftCoverPhotoKey(kind, result.draft.payload);
      if (previousCoverPhotoKey && previousCoverPhotoKey !== savedCoverPhotoKey) {
        setCoverCleanupMessage("Видаляємо попередню приватну фотографію…");
        void deleteOwnedCoverPhoto(previousCoverPhotoKey).then((deleted) => {
          setCoverCleanupMessage(deleted
            ? "Попередню приватну фотографію безпечно видалено після збереження чернетки."
            : "Чернетку збережено, але попередню фотографію не видалено: вона може використовуватися іншою чернеткою.");
        });
      } else {
        setCoverCleanupMessage("");
      }
      return;
    }
    if (result.stale) setStale(true);

    const firstError = Object.entries(result.fieldErrors)[0];
    if (firstError) {
      const fieldName = firstError[0].replace(/^payload\./, "");
      const field = form.elements.namedItem(fieldName);
      if (
        field instanceof HTMLInputElement
        || field instanceof HTMLSelectElement
        || field instanceof HTMLTextAreaElement
      ) {
        field.setCustomValidity(firstError[1]);
        field.focus();
        field.reportValidity();
      }
    }
  };

  const handleTransition = async (action: DraftAction) => {
    if (!draftId || !isPositiveRevision(draftRevision) || stale) return;
    if (action === "submit" && hasUnsavedChanges) return;
    if (
      action === "cancel"
      && !window.confirm("Скасувати цю чернетку? Дані в Google Sheets не зміняться.")
    ) return;

    const result = await onTransition(draftId, draftRevision, action);
    if (result.draft) {
      setDraftRevision(result.draft.revision);
      setDraftStatus(result.draft.status);
      setHasUnsavedChanges(false);
      setStale(false);
    } else if (result.stale) {
      setStale(true);
    }
  };

  const startNewDraft = () => {
    if (
      hasUnsavedChanges
      && !window.confirm("Є незбережені зміни. Відкинути їх і створити нову чернетку?")
    ) return;
    formRef.current?.reset();
    setDraftId(null);
    setDraftRevision(null);
    setDraftStatus("draft");
    setStale(false);
    setHasUnsavedChanges(false);
    setLastSavedPayload(null);
    setCoverCleanupMessage("");
    requestIdRef.current = crypto.randomUUID();
    setFormVersion((current) => current + 1);
    onReset();
  };

  return (
    <form
      ref={formRef}
      className="operation-form"
      onSubmit={handleSubmit}
      onInput={(event) => {
        const target = event.target;
        if (
          target instanceof HTMLInputElement
          || target instanceof HTMLSelectElement
          || target instanceof HTMLTextAreaElement
        ) {
          target.setCustomValidity("");
          markDirty();
        }
      }}
    >
      <div className="card-heading form-heading">
        <div><p className="mini-label">Крок 1</p><h2>{KIND_LABELS[kind]}</h2></div>
        <span className={`draft-chip status-${draftStatus}`}><i /> {draftStatusLabel(draftStatus)}</span>
      </div>

      <fieldset className="operation-fields" key={formVersion} disabled={draftStatus !== "draft" || stale}>
        {kind === "material.create" ? <NewMaterialFields catalog={catalog} initialPayload={initialPayload} savedCoverPhotoKey={draftCoverPhotoKey(kind, lastSavedPayload)} onDirty={markDirty} /> : null}
        {kind === "material.update" ? <MaterialUpdateFields catalog={catalog} loading={catalogLoading} initialPayload={initialPayload} onDirty={markDirty} /> : null}
        {kind === "receipt.create" ? <ReceiptFields catalog={catalog} loading={catalogLoading} initialPayload={initialPayload} referenceData={referenceData} onDirty={markDirty} /> : null}
        {kind === "transfer.create" ? <TransferFields catalog={catalog} loading={catalogLoading} initialPayload={initialPayload} referenceData={referenceData} onDirty={markDirty} /> : null}
        {kind === "writeoff.create" ? <WriteoffFields catalog={catalog} loading={catalogLoading} initialPayload={initialPayload} referenceData={referenceData} onDirty={markDirty} /> : null}
        {kind === "revision.count" ? <RevisionFields catalog={catalog} loading={catalogLoading} initialPayload={initialPayload} referenceData={referenceData} onDirty={markDirty} /> : null}
        {kind === "academic-year.create" ? <AcademicYearFields initialPayload={initialPayload} /> : null}
        {kind === "class-year.create" ? <ClassYearCreateFields initialPayload={initialPayload} referenceData={referenceData} referenceState={referenceState} /> : null}
        {kind === "class-year.update" ? <ClassYearUpdateFields initialPayload={initialPayload} referenceData={referenceData} referenceState={referenceState} /> : null}
        {kind === "class-year.close" ? <ClassYearCloseFields initialPayload={initialPayload} referenceData={referenceData} referenceState={referenceState} /> : null}
        {kind === "academic-year.rollover" ? <AcademicYearRolloverFields initialPayload={initialPayload} referenceData={referenceData} referenceState={referenceState} /> : null}
      </fieldset>

      {submitState.phase !== "idle" ? (
        <div
          className={`submit-message ${submitState.phase}`}
          role={submitState.phase === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          <span aria-hidden="true">{submitState.phase === "success" ? "✓" : submitState.phase === "error" ? "!" : "◷"}</span>
          {submitState.message}
        </div>
      ) : null}

      {coverCleanupMessage ? (
        <div className="submit-message saving" role="status" aria-live="polite">
          <span aria-hidden="true">i</span>{coverCleanupMessage}
        </div>
      ) : null}

      {stale ? (
        <div className="stale-draft-warning" role="alert">
          <strong>Редагування зупинено, щоб не перезаписати новіші дані.</strong>
          <span>Натисніть «Оновити дані» вгорі та відкрийте актуальну чернетку.</span>
        </div>
      ) : null}

      <div className="form-footer">
        <div>
          <strong>Google Sheets не змінено</strong>
          <small>{draftId ? `${draftStatusLabel(draftStatus)} ${shortDraftId(draftId)} · ревізія ${draftRevision ?? "—"}` : "Зберігається тільки службова чернетка"}</small>
        </div>
        <div className="form-footer-actions">
          {draftId ? (
            <button className="button button-quiet" type="button" onClick={startNewDraft}>
              Нова чернетка
            </button>
          ) : null}
          {draftId && draftStatus === "draft" ? (
            <button
              className="button button-danger"
              type="button"
              onClick={() => void handleTransition("cancel")}
              disabled={submitState.phase === "saving" || stale}
            >
              Скасувати
            </button>
          ) : null}
          {draftId && draftStatus === "draft" ? (
            <button
              className="button button-secondary"
              type="button"
              onClick={() => void handleTransition("submit")}
              disabled={submitState.phase === "saving" || stale || hasUnsavedChanges}
              title={hasUnsavedChanges ? "Спочатку збережіть останні зміни" : undefined}
            >
              Надіслати на перевірку
            </button>
          ) : null}
          {draftStatus === "draft" ? (
            <button className="button button-primary save-button" type="submit" disabled={submitState.phase === "saving" || stale}>
              {submitState.phase === "saving" ? "Збереження…" : draftId ? "Оновити чернетку" : "Зберегти чернетку"}
              <span aria-hidden="true">→</span>
            </button>
          ) : null}
        </div>
      </div>
    </form>
  );
}

function NewMaterialFields({
  catalog,
  initialPayload,
  savedCoverPhotoKey,
  onDirty,
}: {
  catalog: CatalogMaterial[];
  initialPayload: Record<string, unknown>;
  savedCoverPhotoKey: string;
  onDirty: () => void;
}) {
  const rubrics = catalogRubrics(catalog);
  const maximumYear = new Date().getUTCFullYear() + 1;
  const [isbn, setIsbn] = useState(initialField(initialPayload, "isbn"));
  const [title, setTitle] = useState(initialField(initialPayload, "title"));
  const [author, setAuthor] = useState(initialField(initialPayload, "author"));
  const [publisher, setPublisher] = useState(initialField(initialPayload, "publisher"));
  const [year, setYear] = useState(initialField(initialPayload, "year"));
  const [coverSourceUrl, setCoverSourceUrl] = useState(initialField(initialPayload, "coverSourceUrl"));
  const [coverPhotoKey, setCoverPhotoKey] = useState(initialField(initialPayload, "coverPhotoKey"));
  const [coverPhotoName, setCoverPhotoName] = useState(initialField(initialPayload, "coverPhotoName"));
  const [coverConfirmed, setCoverConfirmed] = useState(
    initialPayload.coverConfirmed === true || initialPayload.coverConfirmed === "true",
  );
  const [lookupState, setLookupState] = useState<SubmitState>({ phase: "idle", message: "" });
  const [lookupCandidates, setLookupCandidates] = useState<BookLookupCandidate[]>([]);
  const [uploadState, setUploadState] = useState<SubmitState>({ phase: "idle", message: "" });
  const [previewFailed, setPreviewFailed] = useState(false);
  const lookupSequenceRef = useRef(0);
  const lookupAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const uploadRequestGenerationRef = useRef(0);
  const coverPhotoKeyRef = useRef(coverPhotoKey);
  const savedCoverPhotoKeyRef = useRef(savedCoverPhotoKey);
  const manualFieldsRef = useRef({
    title: Boolean(initialField(initialPayload, "title")),
    author: Boolean(initialField(initialPayload, "author")),
    publisher: Boolean(initialField(initialPayload, "publisher")),
    year: Boolean(initialField(initialPayload, "year")),
    coverSourceUrl: Boolean(initialField(initialPayload, "coverSourceUrl")),
  });

  useEffect(() => {
    coverPhotoKeyRef.current = coverPhotoKey;
  }, [coverPhotoKey]);

  useEffect(() => {
    savedCoverPhotoKeyRef.current = savedCoverPhotoKey;
  }, [savedCoverPhotoKey]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      uploadRequestGenerationRef.current += 1;
      lookupAbortRef.current?.abort();
      const unsavedPhotoKey = coverPhotoKeyRef.current;
      if (unsavedPhotoKey && unsavedPhotoKey !== savedCoverPhotoKeyRef.current) {
        void deleteOwnedCoverPhoto(unsavedPhotoKey);
      }
    };
  }, []);

  const applyLookupCandidate = (candidate: BookLookupCandidate) => {
    onDirty();
    setIsbn((current) => current.trim() ? current : candidate.isbn);
    if (candidate.title && !manualFieldsRef.current.title) setTitle(candidate.title);
    if (candidate.authors.length && !manualFieldsRef.current.author) {
      setAuthor(candidate.authors.join(", "));
    }
    if (candidate.publisher && !manualFieldsRef.current.publisher) {
      setPublisher(candidate.publisher);
    }
    if (candidate.publishedYear && !manualFieldsRef.current.year) {
      setYear(String(candidate.publishedYear));
    }
    if (
      candidate.coverUrl
      && !coverPhotoKeyRef.current
      && !manualFieldsRef.current.coverSourceUrl
    ) {
      setCoverSourceUrl(candidate.coverUrl);
      setPreviewFailed(false);
      setCoverConfirmed(false);
    }
    setLookupState({
      phase: "success",
      message: "Дані попередньо заповнено. Обов’язково звірте їх із примірником.",
    });
  };

  const lookupIsbn = async (value = isbn) => {
    const query = value.trim();
    if (!query) {
      setLookupState({ phase: "error", message: "Спочатку введіть або відскануйте ISBN." });
      return;
    }
    lookupAbortRef.current?.abort();
    const controller = new AbortController();
    const sequence = lookupSequenceRef.current + 1;
    lookupSequenceRef.current = sequence;
    lookupAbortRef.current = controller;
    setLookupState({ phase: "saving", message: "Шукаємо назву й обкладинку…" });
    setLookupCandidates([]);
    try {
      const response = await fetch(`/api/librarian/isbn-lookup?isbn=${encodeURIComponent(query)}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const body: unknown = await response.json();
      if (sequence !== lookupSequenceRef.current) return;
      if (!response.ok || !isRecord(body) || body.success !== true) {
        throw new Error(readApiError(body, "Не вдалося виконати пошук"));
      }
      const candidates = Array.isArray(body.candidates)
        ? body.candidates.filter(isBookLookupCandidate)
        : [];
      setLookupCandidates(candidates);
      if (!candidates.length) {
        setLookupState({
          phase: "error",
          message: "За ISBN нічого не знайдено. Введіть дані вручну або додайте посилання чи фотографію.",
        });
        return;
      }
      applyLookupCandidate(candidates[0]);
    } catch (error) {
      if (controller.signal.aborted || sequence !== lookupSequenceRef.current) return;
      setLookupState({
        phase: "error",
        message: error instanceof Error
          ? error.message
          : "Пошук тимчасово недоступний. Дані можна ввести вручну.",
      });
    } finally {
      if (lookupAbortRef.current === controller) lookupAbortRef.current = null;
    }
  };

  const changeIsbn = (value: string) => {
    lookupSequenceRef.current += 1;
    lookupAbortRef.current?.abort();
    lookupAbortRef.current = null;
    setLookupCandidates([]);
    setLookupState({ phase: "idle", message: "" });
    setIsbn(value);
    onDirty();
  };

  const uploadPhoto = async (file: File) => {
    if (file.size > 8 * 1024 * 1024) {
      setUploadState({ phase: "error", message: "Фото має бути не більше 8 МБ." });
      return;
    }
    onDirty();
    const uploadGeneration = uploadRequestGenerationRef.current + 1;
    uploadRequestGenerationRef.current = uploadGeneration;
    const previousPhotoKey = coverPhotoKeyRef.current;
    setUploadState({ phase: "saving", message: "Завантажуємо приватну копію фотографії…" });
    const data = new FormData();
    data.set("photo", file);
    try {
      const response = await fetch("/api/librarian/cover-photo", { method: "POST", body: data });
      const body: unknown = await response.json();
      if (!response.ok || !isRecord(body) || body.success !== true || !isRecord(body.photo)) {
        throw new Error(readApiError(body, "Не вдалося завантажити фотографію"));
      }
      const key = readText(body.photo, ["key"]);
      const name = readText(body.photo, ["name"]);
      if (!key) throw new Error("Сховище не повернуло ключ фотографії");
      if (!mountedRef.current || uploadGeneration !== uploadRequestGenerationRef.current) {
        await deleteOwnedCoverPhoto(key);
        return;
      }
      coverPhotoKeyRef.current = key;
      setCoverPhotoKey(key);
      onDirty();
      setCoverPhotoName(name || file.name);
      setCoverSourceUrl("");
      setCoverConfirmed(false);
      setPreviewFailed(false);
      manualFieldsRef.current.coverSourceUrl = false;
      const shouldDeletePrevious = previousPhotoKey
        && previousPhotoKey !== key
        && previousPhotoKey !== savedCoverPhotoKeyRef.current;
      const previousDeleted = shouldDeletePrevious
        ? await deleteOwnedCoverPhoto(previousPhotoKey)
        : true;
      if (!mountedRef.current || uploadGeneration !== uploadRequestGenerationRef.current) return;
      setUploadState({
        phase: "success",
        message: previousDeleted
          ? "Фото збережено у приватній чернетці. Перевірте його й підтвердьте."
          : "Нове фото збережено, але попередню незбережену копію не вдалося видалити.",
      });
    } catch (error) {
      if (!mountedRef.current || uploadGeneration !== uploadRequestGenerationRef.current) return;
      setUploadState({
        phase: "error",
        message: error instanceof Error ? error.message : "Не вдалося завантажити фотографію",
      });
    }
  };

  const removePhoto = async () => {
    if (!coverPhotoKey) return;
    if (coverPhotoKey === savedCoverPhotoKeyRef.current) {
      coverPhotoKeyRef.current = "";
      setCoverPhotoKey("");
      setCoverPhotoName("");
      setCoverConfirmed(false);
      onDirty();
      setUploadState({
        phase: "success",
        message: "Фото від’єднано у формі. Збережіть чернетку — лише після цього попередній приватний файл буде видалено.",
      });
      return;
    }
    setUploadState({ phase: "saving", message: "Видаляємо фотографію з чернетки…" });
    try {
      if (!await deleteOwnedCoverPhoto(coverPhotoKey)) {
        throw new Error("Не вдалося видалити фотографію");
      }
      coverPhotoKeyRef.current = "";
      setCoverPhotoKey("");
      onDirty();
      setCoverPhotoName("");
      setCoverConfirmed(false);
      setUploadState({ phase: "idle", message: "" });
    } catch (error) {
      setUploadState({
        phase: "error",
        message: error instanceof Error ? error.message : "Не вдалося видалити фотографію",
      });
    }
  };

  const uploadedPreviewUrl = coverPhotoKey
    ? `/api/librarian/cover-photo?key=${encodeURIComponent(coverPhotoKey)}`
    : "";
  const hasCoverSource = Boolean(coverPhotoKey || coverSourceUrl.trim());

  return (
    <>
      <section className="form-section" aria-labelledby="new-main-heading">
        <div className="section-heading"><span>01</span><div><h3 id="new-main-heading">Основні відомості</h3><p>Поля зі зірочкою обов’язкові</p></div></div>
        <div className="field-grid">
          <BarcodeInput
            name="isbn"
            label="ISBN (штрихкод EAN-13)"
            hint="Введіть ISBN або відскануйте штрихкод — пошук заповнить картку, але не збереже її без вашої перевірки"
            value={isbn}
            onValueChange={changeIsbn}
            onLookup={(value) => void lookupIsbn(value)}
            lookupPending={lookupState.phase === "saving"}
          />
          {lookupState.phase !== "idle" ? (
            <div className={`lookup-status field-wide ${lookupState.phase}`} role={lookupState.phase === "error" ? "alert" : "status"}>
              <span aria-hidden="true">{lookupState.phase === "success" ? "✓" : lookupState.phase === "error" ? "!" : "◷"}</span>
              <p>{lookupState.message}</p>
            </div>
          ) : null}
          {lookupCandidates.length > 1 ? (
            <div className="lookup-candidates field-wide" aria-label="Знайдені видання">
              <strong>Знайдено кілька варіантів</strong>
              {lookupCandidates.map((candidate, index) => (
                <button type="button" key={`${candidate.provider}:${index}`} onClick={() => applyLookupCandidate(candidate)}>
                  <span>{candidate.title}</span>
                  <small>{candidate.authors.join(", ") || candidate.publisher || "Без додаткових даних"}</small>
                </button>
              ))}
            </div>
          ) : null}
          <label className="field field-wide"><span>Назва матеріалу <b aria-hidden="true">*</b></span><input name="title" type="text" required autoComplete="off" value={title} onChange={(event) => { manualFieldsRef.current.title = true; setTitle(event.target.value); }} placeholder="Наприклад, Математика. 5 клас" /></label>
          <label className="field"><span>Автор / укладач</span><input name="author" type="text" autoComplete="off" value={author} onChange={(event) => { manualFieldsRef.current.author = true; setAuthor(event.target.value); }} placeholder="Прізвище та ініціали" /></label>
          <label className="field"><span>Видавництво</span><input name="publisher" type="text" autoComplete="off" value={publisher} onChange={(event) => { manualFieldsRef.current.publisher = true; setPublisher(event.target.value); }} placeholder="Назва видавництва" /></label>
          <label className="field"><span>Рік видання</span><input name="year" type="number" inputMode="numeric" min="1500" max={maximumYear} value={year} onChange={(event) => { manualFieldsRef.current.year = true; setYear(event.target.value); }} placeholder={String(new Date().getUTCFullYear())} /></label>
        </div>
      </section>

      <section className="form-section" aria-labelledby="new-class-heading">
        <div className="section-heading"><span>02</span><div><h3 id="new-class-heading">Класифікація</h3><p>Допомагає знайти матеріал у каталозі</p></div></div>
        <div className="field-grid">
          <label className="field"><span>Рубрика <b aria-hidden="true">*</b></span><input name="rubric" type="text" list="rubrics-list" required autoComplete="off" defaultValue={initialField(initialPayload, "rubric")} placeholder="Оберіть або введіть нову" /><datalist id="rubrics-list">{rubrics.map((rubric) => <option key={rubric} value={rubric} />)}</datalist></label>
          <label className="field"><span>З класу</span><select name="classFrom" defaultValue={initialField(initialPayload, "classFrom") || gradeFromLegacy(initialPayload)}><option value="">Не зазначено</option>{gradeOptions()}</select></label>
          <label className="field"><span>До класу</span><select name="classTo" defaultValue={initialField(initialPayload, "classTo") || gradeFromLegacy(initialPayload)}><option value="">Як «З класу»</option>{gradeOptions()}</select></label>
          <label className="field"><span>Предмет</span><input name="subject" type="text" autoComplete="off" defaultValue={initialField(initialPayload, "subject")} placeholder="Наприклад, математика" /></label>
          <label className="field"><span>Тип видання</span><select name="publicationType" defaultValue={initialField(initialPayload, "publicationType")}><option value="">Не вибрано</option><option>Підручник</option><option>Посібник</option><option>Зошит</option><option>Збірник</option><option>Атлас</option><option>Словник</option><option>Інше</option></select></label>
        </div>
      </section>

      <section className="form-section" aria-labelledby="new-extra-heading">
        <div className="section-heading"><span>03</span><div><h3 id="new-extra-heading">Обкладинка та примітка</h3><p>Додайте посилання або фотографію, перегляньте й підтвердьте</p></div></div>
        <div className="field-grid">
          <label className="field field-wide"><span>Джерело обкладинки</span><input name="coverSourceUrl" type="url" inputMode="url" value={coverSourceUrl} disabled={Boolean(coverPhotoKey)} onChange={(event) => { manualFieldsRef.current.coverSourceUrl = true; setCoverSourceUrl(event.target.value); setCoverConfirmed(false); }} placeholder={coverPhotoKey ? "Спочатку приберіть завантажене фото" : "https://… сторінка видання або зображення"} /><small>{coverPhotoKey ? "Для заміни фото посиланням спочатку натисніть «Прибрати фото»." : "Посилання не відкривається браузером автоматично: його безпечно перевірить обробник після збереження."}</small></label>
          <div className="cover-photo-field field-wide">
            <label className="button button-secondary cover-upload-button">
              <span aria-hidden="true">▧</span>{uploadState.phase === "saving" ? "Завантаження…" : "Додати фото примірника"}
              <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={uploadState.phase === "saving"} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadPhoto(file); event.currentTarget.value = ""; }} />
            </label>
            <small>JPG, PNG або WEBP до 8 МБ. Фото зберігається приватно до опрацювання.</small>
          </div>
          {coverPhotoKey ? <input type="hidden" name="coverPhotoKey" value={coverPhotoKey} /> : null}
          {coverPhotoName ? <input type="hidden" name="coverPhotoName" value={coverPhotoName} /> : null}
          <input type="hidden" data-cover-upload-pending={uploadState.phase === "saving" ? "true" : "false"} />
          {uploadState.phase !== "idle" ? (
            <div className={`lookup-status field-wide ${uploadState.phase}`} role={uploadState.phase === "error" ? "alert" : "status"}>
              <span aria-hidden="true">{uploadState.phase === "success" ? "✓" : uploadState.phase === "error" ? "!" : "◷"}</span>
              <p>{uploadState.message}</p>
            </div>
          ) : null}
          {uploadedPreviewUrl ? (
            <div className="cover-preview field-wide">
              <div className="cover-preview-image">
                {!previewFailed ? <img src={uploadedPreviewUrl} alt="Попередній перегляд завантаженої обкладинки" onError={() => setPreviewFailed(true)} /> : <span aria-hidden="true">?</span>}
              </div>
              <div>
                <strong>{previewFailed ? "Зображення не вдалося показати" : "Перевірте обкладинку"}</strong>
                <p>{previewFailed ? "Приватну фотографію не вдалося завантажити для перегляду. Спробуйте додати її повторно." : coverPhotoName || "Завантажена приватна фотографія"}</p>
                {coverPhotoKey ? <button type="button" className="change-material" onClick={() => void removePhoto()}>Прибрати фото</button> : null}
              </div>
            </div>
          ) : coverSourceUrl.trim() ? (
            <div className="cover-preview cover-link-preview field-wide" role="status">
              <div className="cover-preview-image" aria-hidden="true">↗</div>
              <div>
                <strong>Посилання додано без автоматичного відкриття</strong>
                <p>Це захищає локальну мережу. Обкладинку буде знайдено й перевірено безпечним обробником після збереження чернетки.</p>
              </div>
            </div>
          ) : null}
          {hasCoverSource ? (
            <label className="cover-confirm field-wide">
              <input name="coverConfirmed" type="checkbox" value="true" required checked={coverConfirmed} onChange={(event) => setCoverConfirmed(event.target.checked)} />
              <span><strong>Підтверджую цю обкладинку</strong><small>Файл буде оброблено лише після підтвердження бібліотекарем.</small></span>
            </label>
          ) : null}
          <label className="field field-wide"><span>Примітка</span><textarea name="notes" rows={3} defaultValue={initialField(initialPayload, "notes")} placeholder="Додаткова інформація для перевірки" /></label>
        </div>
      </section>
    </>
  );
}

function MaterialUpdateFields({
  catalog,
  loading,
  initialPayload,
  onDirty,
}: {
  catalog: CatalogMaterial[];
  loading: boolean;
  initialPayload: Record<string, unknown>;
  onDirty: () => void;
}) {
  const changes = nestedRecord(initialPayload, "changes");
  const rubrics = catalogRubrics(catalog);
  const maximumYear = new Date().getUTCFullYear() + 1;
  const [coverSourceUrl, setCoverSourceUrl] = useState(initialField(changes, "coverSourceUrl"));
  const [coverConfirmed, setCoverConfirmed] = useState(
    changes.coverConfirmed === true || changes.coverConfirmed === "true",
  );

  return (
    <>
      <MaterialSection catalog={catalog} loading={loading} heading="Який матеріал змінюється" initialPayload={initialPayload} onDirty={onDirty} />
      <section className="form-section" aria-labelledby="material-update-heading">
        <div className="section-heading"><span>02</span><div><h3 id="material-update-heading">Нові значення</h3><p>Заповніть лише поля, які треба змінити</p></div></div>
        <div className="field-grid">
          <label className="field field-wide"><span>Нова назва</span><input name="changes.title" type="text" maxLength={300} defaultValue={initialField(changes, "title")} placeholder="Залиште порожнім без зміни" /></label>
          <label className="field"><span>Рубрика</span><input name="changes.rubric" type="text" list="update-rubrics-list" defaultValue={initialField(changes, "rubric")} placeholder="Без зміни" /><datalist id="update-rubrics-list">{rubrics.map((rubric) => <option key={rubric} value={rubric} />)}</datalist></label>
          <label className="field"><span>Тип видання</span><select name="changes.publicationType" defaultValue={initialField(changes, "publicationType")}><option value="">Без зміни</option><option>Підручник</option><option>Посібник</option><option>Зошит</option><option>Збірник</option><option>Атлас</option><option>Словник</option><option>Інше</option></select></label>
          <label className="field"><span>Предмет</span><input name="changes.subject" type="text" defaultValue={initialField(changes, "subject")} placeholder="Без зміни" /></label>
          <label className="field"><span>Автор / укладач</span><input name="changes.author" type="text" defaultValue={initialField(changes, "author")} placeholder="Без зміни" /></label>
          <label className="field"><span>Видавництво</span><input name="changes.publisher" type="text" defaultValue={initialField(changes, "publisher")} placeholder="Без зміни" /></label>
          <label className="field"><span>Рік видання</span><input name="changes.year" type="number" inputMode="numeric" min="1500" max={maximumYear} defaultValue={initialField(changes, "year")} placeholder="Без зміни" /></label>
          <label className="field"><span>З класу</span><select name="changes.classFrom" defaultValue={initialField(changes, "classFrom")}><option value="">Без зміни</option>{gradeOptions()}</select></label>
          <label className="field"><span>До класу</span><select name="changes.classTo" defaultValue={initialField(changes, "classTo")}><option value="">Без зміни</option>{gradeOptions()}</select></label>
          <label className="field"><span>ISBN</span><input name="changes.isbn" type="text" inputMode="numeric" defaultValue={initialField(changes, "isbn")} placeholder="Без зміни" /></label>
          <label className="field"><span>Електронна версія</span><input name="changes.electronicUrl" type="url" inputMode="url" defaultValue={initialField(changes, "electronicUrl")} placeholder="https://…" /></label>
          <label className="field field-wide"><span>Нове джерело обкладинки</span><input name="changes.coverSourceUrl" type="url" inputMode="url" value={coverSourceUrl} onChange={(event) => { setCoverSourceUrl(event.target.value); setCoverConfirmed(false); }} placeholder="https://…" /><small>Додавайте лише коли потрібно замінити обкладинку.</small></label>
          {coverSourceUrl.trim() ? (
            <label className="cover-confirm field-wide">
              <input name="changes.coverConfirmed" type="checkbox" value="true" required checked={coverConfirmed} onChange={(event) => setCoverConfirmed(event.target.checked)} />
              <span><strong>Підтверджую нову обкладинку</strong><small>Зміна буде лише у чернетці до окремої перевірки.</small></span>
            </label>
          ) : null}
          <label className="field field-wide"><span>Причина виправлення</span><textarea name="reason" rows={2} defaultValue={initialField(initialPayload, "reason")} placeholder="Що саме треба виправити" /></label>
          <label className="field field-wide"><span>Нова примітка в картці</span><textarea name="changes.notes" rows={3} defaultValue={initialField(changes, "notes")} placeholder="Без зміни" /></label>
        </div>
      </section>
    </>
  );
}

function WriteoffFields({
  catalog,
  loading,
  initialPayload,
  referenceData,
  onDirty,
}: {
  catalog: CatalogMaterial[];
  loading: boolean;
  initialPayload: Record<string, unknown>;
  referenceData: ReferenceData;
  onDirty: () => void;
}) {
  return (
    <>
      <MaterialSection catalog={catalog} loading={loading} heading="Що списується" initialPayload={initialPayload} onDirty={onDirty} />
      <section className="form-section" aria-labelledby="writeoff-heading">
        <div className="section-heading"><span>02</span><div><h3 id="writeoff-heading">Акт списання</h3><p>Вкажіть звідки, скільки та з якої причини</p></div></div>
        <div className="field-grid">
          <ProtectedLocationSelect name="fromLocationId" label="Звідки" required initialId={initialField(initialPayload, "fromLocationId")} referenceData={referenceData} />
          <label className="field"><span>Кількість <b aria-hidden="true">*</b></span><input name="quantity" type="number" inputMode="numeric" min="1" step="1" required defaultValue={initialField(initialPayload, "quantity") || "1"} /></label>
          <label className="field"><span>Службове призначення <b aria-hidden="true">*</b></span><select name="destination" required defaultValue={initialField(initialPayload, "destination") || "written_off"}><option value="written_off">Списано</option><option value="lost">Втрачено</option></select></label>
          <label className="field"><span>Причина <b aria-hidden="true">*</b></span><select name="reason" required defaultValue={initialField(initialPayload, "reason") || "worn"}><option value="worn">Зношено</option><option value="obsolete">Застаріло</option><option value="damaged">Пошкоджено</option><option value="lost">Втрачено</option><option value="other">Інша причина</option></select></label>
          <label className="field"><span>Стан примірників</span><input name="condition" type="text" defaultValue={initialField(initialPayload, "condition")} placeholder="Наприклад, непридатні" /></label>
          <label className="field"><span>Номер акта</span><input name="actNumber" type="text" defaultValue={initialField(initialPayload, "actNumber")} placeholder="За наявності" /></label>
          <label className="field"><span>Дата <b aria-hidden="true">*</b></span><input name="date" type="date" required defaultValue={initialField(initialPayload, "date") || todayValue()} /></label>
          <label className="field field-wide"><span>Примітка</span><textarea name="notes" rows={3} defaultValue={initialField(initialPayload, "notes")} placeholder="Для іншої причини опишіть її тут" /></label>
        </div>
      </section>
    </>
  );
}

function AcademicYearFields({ initialPayload }: { initialPayload: Record<string, unknown> }) {
  return (
    <section className="form-section first-section" aria-labelledby="academic-year-heading">
      <div className="section-heading"><span>01</span><div><h3 id="academic-year-heading">Навчальний період</h3><p>Новий рік створиться як чернетка</p></div></div>
      <div className="field-grid">
        <label className="field"><span>Назва <b aria-hidden="true">*</b></span><input name="label" type="text" required pattern="20[0-9]{2}/20[0-9]{2}" defaultValue={initialField(initialPayload, "label")} placeholder="2027/2028" /></label>
        <span className="field field-note"><span>Формат</span><small>Другий рік має йти одразу після першого.</small></span>
        <label className="field"><span>Початок <b aria-hidden="true">*</b></span><input name="startDate" type="date" required defaultValue={initialField(initialPayload, "startDate")} /></label>
        <label className="field"><span>Завершення <b aria-hidden="true">*</b></span><input name="endDate" type="date" required defaultValue={initialField(initialPayload, "endDate")} /></label>
        <label className="field field-wide"><span>Примітка</span><textarea name="notes" rows={3} defaultValue={initialField(initialPayload, "notes")} placeholder="Додаткова службова інформація" /></label>
      </div>
    </section>
  );
}

function ClassYearCreateFields({
  initialPayload,
  referenceData,
  referenceState,
}: {
  initialPayload: Record<string, unknown>;
  referenceData: ReferenceData;
  referenceState: ReferenceState;
}) {
  const [cohortMode, setCohortMode] = useState(initialField(initialPayload, "cohortMode") || "new");
  const cohorts = uniqueCohorts(referenceData.classYears);
  return (
    <section className="form-section first-section" aria-labelledby="class-create-heading">
      <div className="section-heading"><span>01</span><div><h3 id="class-create-heading">Клас у навчальному році</h3><p>Керівник обирається за ім’ям, кабінет — за номером</p></div></div>
      <ReferenceAvailability state={referenceState} />
      <div className="field-grid">
        <AcademicYearSelect name="academicYearId" label="Навчальний рік" required initialId={initialField(initialPayload, "academicYearId")} referenceData={referenceData} />
        <label className="field"><span>Класна група <b aria-hidden="true">*</b></span><select name="cohortMode" required value={cohortMode} onChange={(event) => setCohortMode(event.target.value)}><option value="new">Нова група</option><option value="existing">Продовжити наявну</option></select></label>
        {cohortMode === "existing" ? (
          <label className="field field-wide"><span>Наявна група <b aria-hidden="true">*</b></span><select name="cohortId" required defaultValue={initialField(initialPayload, "cohortId")}><option value="">Оберіть класну групу</option>{cohorts.map((cohort) => <option key={cohort.id} value={cohort.id}>{cohort.label}</option>)}</select></label>
        ) : null}
        <label className="field"><span>Паралель <b aria-hidden="true">*</b></span><select name="grade" required defaultValue={initialField(initialPayload, "grade")}><option value="">Оберіть клас</option>{gradeOptions()}</select></label>
        <label className="field"><span>Код після дефіса <b aria-hidden="true">*</b></span><input name="code" type="text" required maxLength={16} defaultValue={initialField(initialPayload, "code")} placeholder="А, IT(1), ESA" /></label>
        <TeacherSelect name="teacherUserId" label="Класний керівник" initialId={initialField(initialPayload, "teacherUserId")} referenceData={referenceData} />
        <ProtectedLocationSelect name="locationId" label="Кабінет" initialId={initialField(initialPayload, "locationId")} referenceData={referenceData} />
        <label className="field field-wide"><span>Примітка</span><textarea name="notes" rows={3} defaultValue={initialField(initialPayload, "notes")} /></label>
      </div>
    </section>
  );
}

function ClassYearUpdateFields({
  initialPayload,
  referenceData,
  referenceState,
}: {
  initialPayload: Record<string, unknown>;
  referenceData: ReferenceData;
  referenceState: ReferenceState;
}) {
  const changes = nestedRecord(initialPayload, "changes");
  const [classYearId, setClassYearId] = useState(initialField(initialPayload, "classYearId"));
  const selected = referenceData.classYears.find((item) => item.id === classYearId);
  const academicYearId = initialField(initialPayload, "academicYearId") || selected?.academicYearId || "";
  return (
    <section className="form-section first-section" aria-labelledby="class-update-heading">
      <div className="section-heading"><span>01</span><div><h3 id="class-update-heading">Зміни класу</h3><p>Порожнє поле означає «без зміни»</p></div></div>
      <ReferenceAvailability state={referenceState} />
      <div className="field-grid">
        <ClassYearSelect name="classYearId" label="Клас" required initialId={classYearId} referenceData={referenceData} onChange={setClassYearId} />
        <input name="academicYearId" type="hidden" value={academicYearId} />
        <label className="field"><span>Нова паралель</span><select name="changes.grade" defaultValue={initialField(changes, "grade")}><option value="">Без зміни</option>{gradeOptions()}</select></label>
        <label className="field"><span>Новий код</span><input name="changes.code" type="text" maxLength={16} defaultValue={initialField(changes, "code")} placeholder="Без зміни" /></label>
        <TeacherSelect name="changes.teacherUserId" label="Новий класний керівник" initialId={nullableDirectoryInitial(changes, "teacherUserId")} referenceData={referenceData} allowClear />
        <ProtectedLocationSelect name="changes.locationId" label="Новий кабінет" initialId={nullableDirectoryInitial(changes, "locationId")} referenceData={referenceData} allowClear />
        <label className="field field-wide"><span>Причина зміни</span><textarea name="reason" rows={2} defaultValue={initialField(initialPayload, "reason")} placeholder="Наприклад, зміна кабінету" /></label>
        <label className="field field-wide"><span>Нова примітка</span><textarea name="changes.notes" rows={3} defaultValue={initialField(changes, "notes")} placeholder="Без зміни" /></label>
      </div>
    </section>
  );
}

function ClassYearCloseFields({
  initialPayload,
  referenceData,
  referenceState,
}: {
  initialPayload: Record<string, unknown>;
  referenceData: ReferenceData;
  referenceState: ReferenceState;
}) {
  return (
    <section className="form-section first-section" aria-labelledby="class-close-heading">
      <div className="section-heading"><span>01</span><div><h3 id="class-close-heading">Закриття класу</h3><p>Запис залишиться в історії</p></div></div>
      <ReferenceAvailability state={referenceState} />
      <div className="field-grid">
        <ClassYearSelect name="classYearId" label="Клас" required initialId={initialField(initialPayload, "classYearId")} referenceData={referenceData} />
        <label className="field"><span>Фактична дата закриття <b aria-hidden="true">*</b></span><input name="actualClosedDate" type="date" required defaultValue={initialField(initialPayload, "actualClosedDate") || todayValue()} /></label>
        <label className="field"><span>Причина <b aria-hidden="true">*</b></span><select name="reason" required defaultValue={initialField(initialPayload, "reason") || "closed"}><option value="closed">Закрито</option><option value="merged">Об’єднано</option><option value="graduated">Випуск</option><option value="reorganized">Реорганізація</option><option value="other">Інша</option></select></label>
        <label className="field"><span>Що робити з групою <b aria-hidden="true">*</b></span><select name="closeCohort" required defaultValue={initialBooleanField(initialPayload, "closeCohort", true)}><option value="true">Закрити класну групу</option><option value="false">Залишити групу для іншого класу</option></select></label>
        <label className="field field-wide"><span>Примітка</span><textarea name="notes" rows={3} defaultValue={initialField(initialPayload, "notes")} placeholder="Для іншої причини додайте пояснення" /></label>
      </div>
    </section>
  );
}

type RolloverRow = {
  sourceClassYearId: string;
  cohortId: string;
  sourceGrade: number;
  className: string;
  action: "promote" | "graduate" | "close" | "skip";
  targetGrade?: number;
  targetCode?: string;
  teacherUserId?: string;
  teacherName?: string;
  locationId?: string;
  locationName?: string;
  overrideReason?: string;
  notes?: string;
};

function AcademicYearRolloverFields({
  initialPayload,
  referenceData,
  referenceState,
}: {
  initialPayload: Record<string, unknown>;
  referenceData: ReferenceData;
  referenceState: ReferenceState;
}) {
  const defaultSource = initialField(initialPayload, "sourceYearId")
    || referenceData.academicYears.find((year) => /active|актив/i.test(year.status))?.id
    || referenceData.academicYears[0]?.id
    || "";
  const [sourceYearId, setSourceYearId] = useState(defaultSource);
  const defaultTarget = initialField(initialPayload, "targetYearId")
    || nextAcademicYearId(defaultSource, referenceData.academicYears);
  const [targetYearId, setTargetYearId] = useState(defaultTarget);
  const initialRows = rolloverRowsFromPayload(initialPayload, referenceData);
  const [rows, setRows] = useState<RolloverRow[]>(
    initialRows.length ? initialRows : buildRolloverRows(defaultSource, referenceData),
  );

  useEffect(() => {
    if (sourceYearId || !referenceData.academicYears.length) return;
    const source = referenceData.academicYears.find((year) => /active|актив/i.test(year.status))?.id
      || referenceData.academicYears[0]?.id
      || "";
    setSourceYearId(source);
    setTargetYearId(nextAcademicYearId(source, referenceData.academicYears));
    setRows(buildRolloverRows(source, referenceData));
  }, [referenceData, sourceYearId]);

  const changeSource = (value: string) => {
    setSourceYearId(value);
    setTargetYearId(nextAcademicYearId(value, referenceData.academicYears));
    setRows(buildRolloverRows(value, referenceData));
  };
  const updateRow = (index: number, change: Partial<RolloverRow>) => {
    setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...change } : row));
  };
  const safeLocations = protectedLocations(referenceData);

  return (
    <section className="form-section first-section" aria-labelledby="rollover-heading">
      <div className="section-heading"><span>01</span><div><h3 id="rollover-heading">Перехід класів</h3><p>Для кожного класу перевірте нову назву, керівника й кабінет</p></div></div>
      <ReferenceAvailability state={referenceState} />
      <div className="field-grid">
        <AcademicYearSelect name="sourceYearId" label="З навчального року" required initialId={sourceYearId} value={sourceYearId} onChange={changeSource} referenceData={referenceData} />
        <AcademicYearSelect name="targetYearId" label="У навчальний рік" required initialId={targetYearId} value={targetYearId} onChange={setTargetYearId} referenceData={referenceData} />
        <label className="field"><span>Дата переходу <b aria-hidden="true">*</b></span><input name="effectiveDate" type="date" required defaultValue={initialField(initialPayload, "effectiveDate") || todayValue()} /></label>
        <label className="field field-wide"><span>Загальна примітка</span><textarea name="notes" rows={2} defaultValue={initialField(initialPayload, "notes")} /></label>
      </div>

      <input name="rolloverClassesJson" type="hidden" value={JSON.stringify(rows.map(stripRolloverDisplayFields))} />
      <div className="rollover-list" aria-label="Класи для переходу">
        {rows.length ? rows.map((row, index) => (
          <article className="rollover-row" key={row.sourceClassYearId}>
            <div className="rollover-class"><strong>{row.className}</strong><small>{row.cohortId}</small></div>
            <label className="field"><span>Дія</span><select value={row.action} onChange={(event) => {
              const action = event.target.value as RolloverRow["action"];
              updateRow(index, {
                action,
                targetGrade: action === "promote" ? Math.min(row.sourceGrade + 1, 11) : undefined,
                targetCode: action === "promote" ? row.targetCode || classCodeFromName(row.className) : undefined,
              });
            }}><option value="promote" disabled={row.sourceGrade === 11}>Перевести</option><option value="graduate" disabled={row.sourceGrade !== 11}>Випуск</option><option value="close">Закрити</option><option value="skip">Пропустити</option></select></label>
            {row.action === "promote" ? (
              <>
                <label className="field"><span>Нова паралель</span><select value={row.targetGrade ?? ""} onChange={(event) => updateRow(index, { targetGrade: Number(event.target.value) })}>{gradeOptions()}</select></label>
                <label className="field"><span>Новий код <b aria-hidden="true">*</b></span><input type="text" maxLength={16} required value={row.targetCode ?? ""} onChange={(event) => updateRow(index, { targetCode: event.target.value })} /></label>
                <label className="field"><span>Класний керівник</span><select value={row.teacherUserId ?? ""} onChange={(event) => {
                  const teacher = referenceData.teachers.find((item) => item.id === event.target.value);
                  updateRow(index, { teacherUserId: teacher?.id, teacherName: teacher?.name });
                }}><option value="">Не призначено</option>{referenceData.teachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.name}</option>)}</select></label>
                <label className="field"><span>Кабінет</span><select value={row.locationId ?? ""} onChange={(event) => {
                  const location = safeLocations.find((item) => item.id === event.target.value);
                  updateRow(index, { locationId: location?.id, locationName: location?.name });
                }}><option value="">Не призначено</option>{safeLocations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label>
                {row.targetGrade !== row.sourceGrade + 1 ? (
                  <label className="field field-wide"><span>Пояснення нестандартного переходу</span><input type="text" required value={row.overrideReason ?? ""} onChange={(event) => updateRow(index, { overrideReason: event.target.value })} /></label>
                ) : null}
              </>
            ) : null}
          </article>
        )) : (
          <div className="reference-empty" role="status">Для вибраного року не знайдено відкритих класів із чинними службовими ID.</div>
        )}
      </div>
    </section>
  );
}

function ReceiptFields({
  catalog,
  loading,
  initialPayload,
  referenceData,
  onDirty,
}: {
  catalog: CatalogMaterial[];
  loading: boolean;
  initialPayload: Record<string, unknown>;
  referenceData: ReferenceData;
  onDirty: () => void;
}) {
  const locations = catalogLocations(catalog);
  return (
    <>
      <MaterialSection catalog={catalog} loading={loading} heading="Що надійшло" initialPayload={initialPayload} onDirty={onDirty} />
      <section className="form-section" aria-labelledby="receipt-details-heading">
        <div className="section-heading"><span>02</span><div><h3 id="receipt-details-heading">Дані надходження</h3><p>Кількість і нове місце зберігання</p></div></div>
        <div className="field-grid">
          <label className="field"><span>Кількість <b aria-hidden="true">*</b></span><input name="quantity" type="number" inputMode="numeric" min="1" step="1" required defaultValue={initialField(initialPayload, "quantity") || "1"} /></label>
          <DirectoryLocationField
            name="locationId"
            legacyName="location"
            label="Розміщення"
            required
            initialId={initialField(initialPayload, "locationId")}
            initialLegacy={initialField(initialPayload, "location")}
            referenceData={referenceData}
            fallbackLocations={locations}
          />
          <label className="field"><span>Дата <b aria-hidden="true">*</b></span><input name="date" type="date" required defaultValue={initialField(initialPayload, "date") || todayValue()} /></label>
          <label className="field"><span>Номер документа</span><input name="documentNumber" type="text" autoComplete="off" defaultValue={initialField(initialPayload, "documentNumber")} placeholder="За наявності" /></label>
          <label className="field field-wide"><span>Примітка</span><textarea name="notes" rows={3} defaultValue={initialField(initialPayload, "notes")} placeholder="Джерело надходження або інша інформація" /></label>
        </div>
        <datalist id="known-locations">{locations.map((location) => <option key={location} value={location} />)}</datalist>
      </section>
    </>
  );
}

function TransferFields({
  catalog,
  loading,
  initialPayload,
  referenceData,
  onDirty,
}: {
  catalog: CatalogMaterial[];
  loading: boolean;
  initialPayload: Record<string, unknown>;
  referenceData: ReferenceData;
  onDirty: () => void;
}) {
  const locations = catalogLocations(catalog);
  return (
    <>
      <MaterialSection catalog={catalog} loading={loading} heading="Що переміщується" initialPayload={initialPayload} onDirty={onDirty} />
      <section className="form-section" aria-labelledby="transfer-details-heading">
        <div className="section-heading"><span>02</span><div><h3 id="transfer-details-heading">Маршрут переміщення</h3><p>Звідки, куди та скільки примірників</p></div></div>
        <div className="field-grid">
          <DirectoryLocationField
            name="fromLocationId"
            legacyName="fromLocation"
            label="Звідки"
            required
            initialId={initialField(initialPayload, "fromLocationId")}
            initialLegacy={initialField(initialPayload, "fromLocation")}
            referenceData={referenceData}
            fallbackLocations={locations}
          />
          <DirectoryLocationField
            name="toLocationId"
            legacyName="toLocation"
            label="Куди"
            required
            initialId={initialField(initialPayload, "toLocationId")}
            initialLegacy={initialField(initialPayload, "toLocation")}
            referenceData={referenceData}
            fallbackLocations={locations}
          />
          <label className="field"><span>Кількість <b aria-hidden="true">*</b></span><input name="quantity" type="number" inputMode="numeric" min="1" step="1" required defaultValue={initialField(initialPayload, "quantity") || "1"} /></label>
          <label className="field"><span>Дата <b aria-hidden="true">*</b></span><input name="date" type="date" required defaultValue={initialField(initialPayload, "date") || todayValue()} /></label>
          <label className="field field-wide"><span>Примітка</span><textarea name="notes" rows={3} defaultValue={initialField(initialPayload, "notes")} placeholder="Причина або відповідальна особа" /></label>
        </div>
        <datalist id="known-locations">{locations.map((location) => <option key={location} value={location} />)}</datalist>
      </section>
    </>
  );
}

function RevisionFields({
  catalog,
  loading,
  initialPayload,
  referenceData,
  onDirty,
}: {
  catalog: CatalogMaterial[];
  loading: boolean;
  initialPayload: Record<string, unknown>;
  referenceData: ReferenceData;
  onDirty: () => void;
}) {
  const locations = catalogLocations(catalog);
  return (
    <>
      <MaterialSection catalog={catalog} loading={loading} heading="Що перевіряється" initialPayload={initialPayload} onDirty={onDirty} />
      <section className="form-section" aria-labelledby="revision-details-heading">
        <div className="section-heading"><span>02</span><div><h3 id="revision-details-heading">Фактичний залишок</h3><p>Запишіть те, що пораховано на місці</p></div></div>
        <div className="field-grid">
          <DirectoryLocationField
            name="locationId"
            legacyName="location"
            label="Розміщення"
            required
            initialId={initialField(initialPayload, "locationId")}
            initialLegacy={initialField(initialPayload, "location")}
            referenceData={referenceData}
            fallbackLocations={locations}
          />
          <label className="field"><span>Пораховано примірників <b aria-hidden="true">*</b></span><input name="countedQuantity" type="number" inputMode="numeric" min="0" step="1" required defaultValue={initialField(initialPayload, "countedQuantity")} /></label>
          <label className="field"><span>Дата <b aria-hidden="true">*</b></span><input name="date" type="date" required defaultValue={initialField(initialPayload, "date") || todayValue()} /></label>
          <label className="field field-wide"><span>Примітка</span><textarea name="notes" rows={3} defaultValue={initialField(initialPayload, "notes")} placeholder="Стан примірників, розбіжності або пояснення" /></label>
        </div>
        <datalist id="known-locations">{locations.map((location) => <option key={location} value={location} />)}</datalist>
      </section>
    </>
  );
}

function DirectoryLocationField({
  name,
  legacyName,
  label,
  required = false,
  initialId,
  initialLegacy,
  referenceData,
  fallbackLocations,
}: {
  name: string;
  legacyName: string;
  label: string;
  required?: boolean;
  initialId: string;
  initialLegacy: string;
  referenceData: ReferenceData;
  fallbackLocations: string[];
}) {
  const locations = protectedLocations(referenceData);
  const listId = useId();
  if (locations.length) {
    return (
      <ProtectedLocationSelect
        name={name}
        label={label}
        required={required}
        initialId={initialId}
        referenceData={referenceData}
      />
    );
  }
  return (
    <label className="field">
      <span>{label} {required ? <b aria-hidden="true">*</b> : null}</span>
      <input name={legacyName} type="text" list={listId} required={required} autoComplete="off" defaultValue={initialLegacy} placeholder="Бібліотека або кабінет №" />
      <datalist id={listId}>{fallbackLocations.map((location) => <option key={location} value={location} />)}</datalist>
      <small>Тимчасово використовується каталог; захищений довідник не завантажено.</small>
    </label>
  );
}

function ProtectedLocationSelect({
  name,
  label,
  initialId,
  referenceData,
  required = false,
  allowClear = false,
}: {
  name: string;
  label: string;
  initialId: string;
  referenceData: ReferenceData;
  required?: boolean;
  allowClear?: boolean;
}) {
  const locations = protectedLocations(referenceData);
  return (
    <label className="field">
      <span>{label} {required ? <b aria-hidden="true">*</b> : null}</span>
      <select name={name} required={required} defaultValue={initialId} disabled={!locations.length}>
        <option value="">{locations.length ? (allowClear ? "Без зміни" : "Не призначено") : "Довідник недоступний"}</option>
        {allowClear ? <option value="__clear__">Очистити значення</option> : null}
        {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
      </select>
      <small>У чернетці збережеться службовий ID і ця назва кабінету.</small>
    </label>
  );
}

function TeacherSelect({
  name,
  label,
  initialId,
  referenceData,
  required = false,
  allowClear = false,
}: {
  name: string;
  label: string;
  initialId: string;
  referenceData: ReferenceData;
  required?: boolean;
  allowClear?: boolean;
}) {
  const teachers = referenceData.teachers
    .filter((teacher) => /^USR-\d{3,}$/u.test(teacher.id) && teacher.name.trim())
    .sort((left, right) => left.name.localeCompare(right.name, "uk"));
  return (
    <label className="field">
      <span>{label} {required ? <b aria-hidden="true">*</b> : null}</span>
      <select name={name} required={required} defaultValue={initialId} disabled={!teachers.length}>
        <option value="">{teachers.length ? (allowClear ? "Без зміни" : "Не призначено") : "Довідник недоступний"}</option>
        {allowClear ? <option value="__clear__">Очистити значення</option> : null}
        {teachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.name}</option>)}
      </select>
      <small>Пошук і вибір відбуваються за ім’ям; ID додається автоматично.</small>
    </label>
  );
}

function AcademicYearSelect({
  name,
  label,
  initialId,
  referenceData,
  required = false,
  value,
  onChange,
}: {
  name: string;
  label: string;
  initialId: string;
  referenceData: ReferenceData;
  required?: boolean;
  value?: string;
  onChange?: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{label} {required ? <b aria-hidden="true">*</b> : null}</span>
      <select
        name={name}
        required={required}
        value={value}
        defaultValue={value === undefined ? initialId : undefined}
        disabled={!referenceData.academicYears.length}
        onChange={onChange ? (event) => onChange(event.target.value) : undefined}
      >
        <option value="">{referenceData.academicYears.length ? "Оберіть навчальний рік" : "Довідник недоступний"}</option>
        {referenceData.academicYears.map((year) => <option key={year.id} value={year.id}>{year.label}{year.status ? ` · ${year.status}` : ""}</option>)}
      </select>
    </label>
  );
}

function ClassYearSelect({
  name,
  label,
  initialId,
  referenceData,
  required = false,
  onChange,
}: {
  name: string;
  label: string;
  initialId: string;
  referenceData: ReferenceData;
  required?: boolean;
  onChange?: (value: string) => void;
}) {
  const classYears = referenceData.classYears
    .filter((item) => !item.actualClosedDate && !/closed|закрит/i.test(item.status))
    .sort((left, right) => `${left.academicYearLabel} ${left.className}`.localeCompare(`${right.academicYearLabel} ${right.className}`, "uk", { numeric: true }));
  return (
    <label className="field field-wide">
      <span>{label} {required ? <b aria-hidden="true">*</b> : null}</span>
      <select name={name} required={required} defaultValue={initialId} disabled={!classYears.length} onChange={onChange ? (event) => onChange(event.target.value) : undefined}>
        <option value="">{classYears.length ? "Оберіть клас" : "Відкритих класів не знайдено"}</option>
        {classYears.map((item) => <option key={item.id} value={item.id}>{item.academicYearLabel} · {item.className}{item.teacherName ? ` · ${item.teacherName}` : ""}{item.locationName ? ` · ${item.locationName}` : ""}</option>)}
      </select>
    </label>
  );
}

function ReferenceAvailability({ state }: { state: ReferenceState }) {
  return state.phase === "ready" ? (
    <div className="reference-ready" role="status"><span aria-hidden="true">✓</span> Захищені довідники актуальні{state.generatedAt ? ` станом на ${formatDateTime(state.generatedAt)}` : ""}.</div>
  ) : (
    <div className={`reference-ready ${state.phase}`} role={state.phase === "error" ? "alert" : "status"}><span aria-hidden="true">{state.phase === "loading" ? "◷" : "!"}</span> {state.message}</div>
  );
}

function MaterialSection({
  catalog,
  loading,
  heading,
  initialPayload,
  onDirty,
}: {
  catalog: CatalogMaterial[];
  loading: boolean;
  heading: string;
  initialPayload: Record<string, unknown>;
  onDirty: () => void;
}) {
  return (
    <section className="form-section" aria-labelledby="material-lookup-heading">
      <div className="section-heading"><span>01</span><div><h3 id="material-lookup-heading">{heading}</h3><p>Знайдіть за CAT-ID, ISBN або назвою</p></div></div>
      <MaterialPicker
        catalog={catalog}
        loading={loading}
        initialId={initialField(initialPayload, "materialId")}
        onDirty={onDirty}
      />
    </section>
  );
}

function MaterialPicker({
  catalog,
  loading,
  initialId,
  onDirty,
}: {
  catalog: CatalogMaterial[];
  loading: boolean;
  initialId: string;
  onDirty: () => void;
}) {
  const initialMaterial = catalog.find((material) => materialIdentifier(material) === initialId);
  const [query, setQuery] = useState(initialMaterial ? materialDisplayTitle(initialMaterial) : initialId);
  const [selectedId, setSelectedId] = useState(initialId);
  const [showResults, setShowResults] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const results = useMemo(() => {
    const normalized = normalizeSearch(query);
    if (!normalized || selectedId) return [];
    return catalog
      .filter((item) => materialSearchText(item).includes(normalized))
      .slice(0, 8);
  }, [catalog, query, selectedId]);

  const selectMaterial = (material: CatalogMaterial) => {
    setSelectedId(materialIdentifier(material));
    setQuery(materialDisplayTitle(material));
    setShowResults(false);
    inputRef.current?.setCustomValidity("");
    onDirty();
  };

  const handleScan = (value: string) => {
    const match = catalog.find((item) => materialSearchText(item).includes(normalizeSearch(value)));
    if (match) selectMaterial(match);
    else {
      setSelectedId("");
      setQuery(value);
      setShowResults(true);
      onDirty();
    }
  };

  return (
    <div className="material-picker">
      <input type="hidden" name="materialId" value={selectedId} required />
      <label className="field field-wide" htmlFor={`${listId}-input`}>
        <span>Матеріал <b aria-hidden="true">*</b></span>
        <span className="search-control">
          <span className="search-glyph" aria-hidden="true">⌕</span>
          <input
            ref={inputRef}
            id={`${listId}-input`}
            type="search"
            role="combobox"
            required
            data-material-picker-input
            aria-expanded={showResults && results.length > 0}
            aria-controls={`${listId}-results`}
            aria-autocomplete="list"
            autoComplete="off"
            value={query}
            onChange={(event) => {
              event.currentTarget.setCustomValidity("");
              setQuery(event.target.value);
              setSelectedId("");
              setShowResults(true);
              onDirty();
            }}
            onFocus={() => setShowResults(true)}
            onBlur={(event) => {
              if (!selectedId) {
                event.currentTarget.setCustomValidity("Оберіть матеріал зі списку результатів.");
              }
            }}
            placeholder={loading ? "Каталог завантажується…" : "CAT-0001, ISBN або назва"}
          />
          {selectedId ? <span className="selected-mark" aria-label="Матеріал вибрано">✓</span> : null}
        </span>
      </label>

      <CameraScanner
        compact
        onDetected={handleScan}
        onFallback={() => inputRef.current?.focus()}
      />

      {!selectedId && query.trim() && showResults ? (
        <div className="material-results" id={`${listId}-results`} role="listbox">
          {results.length > 0 ? results.map((material) => (
            <button
              key={materialIdentifier(material)}
              type="button"
              role="option"
              aria-selected="false"
              onClick={() => selectMaterial(material)}
            >
              <span className="result-cover" aria-hidden="true">▥</span>
              <span><strong>{materialDisplayTitle(material)}</strong><small>{materialMeta(material)}</small></span>
              <span className="result-id">{materialIdentifier(material)}</span>
            </button>
          )) : (
            <p className="no-results">Нічого не знайдено. Перевірте ISBN або введіть частину назви.</p>
          )}
        </div>
      ) : null}

      {selectedId ? (
        <button className="change-material" type="button" onClick={() => { setSelectedId(""); setQuery(""); inputRef.current?.setCustomValidity(""); inputRef.current?.focus(); onDirty(); }}>
          Змінити матеріал
        </button>
      ) : null}
    </div>
  );
}

function BarcodeInput({
  name,
  label,
  hint,
  value,
  onValueChange,
  onLookup,
  lookupPending,
}: {
  name: string;
  label: string;
  hint: string;
  value: string;
  onValueChange: (value: string) => void;
  onLookup: (value: string) => void;
  lookupPending: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();

  const updateAndLookup = (detected: string) => {
    onValueChange(detected);
    onLookup(detected);
  };

  return (
    <div className="barcode-field field-wide">
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <div className="barcode-control">
          <input
            ref={inputRef}
            id={id}
            name={name}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            placeholder="978…"
            aria-describedby={`${id}-hint`}
          />
          <CameraScanner onDetected={updateAndLookup} onFallback={() => inputRef.current?.focus()} />
          <button
            className="isbn-lookup-button"
            type="button"
            disabled={lookupPending || !value.trim()}
            onClick={() => onLookup(value)}
          >
            {lookupPending ? "Шукаємо…" : "Знайти за ISBN"}
          </button>
        </div>
        <small id={`${id}-hint`}>{hint}</small>
      </div>
    </div>
  );
}

function CameraScanner({
  onDetected,
  onFallback,
  compact = false,
}: {
  onDetected: (value: string) => void;
  onFallback: () => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [message, setMessage] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number | null>(null);
  const scanningRef = useRef(false);
  const startingRef = useRef(false);
  const mountedRef = useRef(true);
  const focusScopeActiveRef = useRef(false);
  const fallbackRequestedRef = useRef(false);
  const onFallbackRef = useRef(onFallback);
  onFallbackRef.current = onFallback;

  const stop = useCallback(() => {
    scanningRef.current = false;
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setOpen(false);
  }, []);

  const requestFallbackFocus = useCallback(() => {
    if (focusScopeActiveRef.current) {
      fallbackRequestedRef.current = true;
      stop();
      return;
    }
    stop();
    queueMicrotask(() => {
      if (mountedRef.current) onFallbackRef.current();
    });
  }, [stop]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stop();
    };
  }, [stop]);

  useEffect(() => {
    if (!open) return;
    focusScopeActiveRef.current = true;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusFrame = requestAnimationFrame(() => closeRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        stop();
        return;
      }
      if (event.key === "Tab") {
        const dialog = closeRef.current?.closest(".scanner-dialog");
        if (!(dialog instanceof HTMLElement)) return;
        const focusable = [...dialog.querySelectorAll<HTMLElement>(
          "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
        )].filter((element) => !element.hasAttribute("hidden"));
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      focusScopeActiveRef.current = false;
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      if (fallbackRequestedRef.current) {
        fallbackRequestedRef.current = false;
        queueMicrotask(() => {
          if (mountedRef.current) onFallbackRef.current();
        });
      } else if (mountedRef.current) {
        previouslyFocused?.focus();
      }
    };
  }, [open, stop]);

  const start = async () => {
    setMessage("");

    const BarcodeDetector = window.BarcodeDetector;
    if (!BarcodeDetector || !navigator.mediaDevices?.getUserMedia) {
      setMessage("Сканування не підтримується цим браузером. Введіть ISBN вручну.");
      requestFallbackFocus();
      return;
    }
    if (startingRef.current || scanningRef.current) return;

    startingRef.current = true;
    setStarting(true);
    setOpen(true);
    scanningRef.current = true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      if (!scanningRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;

      const video = videoRef.current;
      if (!video) throw new Error("Камеру не вдалося підготувати");
      video.srcObject = stream;
      await video.play();

      const detector = new BarcodeDetector({
        formats: ["ean_13"],
      });

      const inspectFrame = async () => {
        if (!scanningRef.current || !videoRef.current) return;
        try {
          const results = await detector.detect(videoRef.current);
          if (!scanningRef.current) return;
          const value = results.find((result) => result.rawValue.trim())?.rawValue.trim();
          if (value) {
            onDetected(value);
            setMessage(`Код ${value} розпізнано.`);
            stop();
            return;
          }
        } catch {
          // A frame can fail while the camera is focusing; keep scanning.
        }
        frameRef.current = requestAnimationFrame(inspectFrame);
      };
      frameRef.current = requestAnimationFrame(inspectFrame);
    } catch {
      setMessage("Камера недоступна. Дозвольте доступ або введіть ISBN вручну.");
      requestFallbackFocus();
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        className={compact ? "scan-button compact" : "scan-button"}
        type="button"
        onClick={() => void start()}
        disabled={starting || open}
        aria-busy={starting}
        aria-label={compact ? "Сканувати ISBN камерою" : undefined}
      >
        <span aria-hidden="true">▣</span>{compact ? "" : starting ? "Відкриваємо камеру…" : "Сканувати камерою"}
      </button>
      {message ? <small className="scanner-message" role="status">{message}</small> : null}
      {open ? (
        <div className="scanner-overlay" role="dialog" aria-modal="true" aria-labelledby="scanner-title">
          <div className="scanner-dialog">
            <div className="scanner-heading"><div><p>Сканування ISBN</p><h2 id="scanner-title">Наведіть камеру на книжковий штрихкод EAN-13</h2></div><button ref={closeRef} type="button" onClick={stop} aria-label="Закрити сканер">×</button></div>
            <div className="video-frame"><video ref={videoRef} muted playsInline /><span aria-hidden="true" /></div>
            <p>Тримайте штрихкод усередині рамки. Розпізнавання відбудеться автоматично.</p>
            <button className="button button-secondary" type="button" onClick={requestFallbackFocus}>Ввести ISBN вручну</button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function isBookLookupCandidate(value: unknown): value is BookLookupCandidate {
  if (!isRecord(value)) return false;
  return (
    typeof value.isbn === "string"
    && typeof value.title === "string"
    && Array.isArray(value.authors)
    && value.authors.every((author) => typeof author === "string")
    && typeof value.publisher === "string"
    && (value.publishedYear === null || typeof value.publishedYear === "number")
    && typeof value.coverUrl === "string"
    && typeof value.sourceUrl === "string"
    && (value.provider === "google_books" || value.provider === "open_library")
  );
}

function gradeOptions() {
  return Array.from({ length: 11 }, (_, index) => {
    const grade = index + 1;
    return <option key={grade} value={grade}>{grade} клас</option>;
  });
}

function gradeFromLegacy(payload: Record<string, unknown>): string {
  const legacy = initialField(payload, "grade");
  const match = legacy.match(/\b(?:10|11|[1-9])\b/);
  return match?.[0] ?? "";
}

function formPayload(
  formData: FormData,
  kind: DraftKind,
  referenceData: ReferenceData,
  sourceGeneratedAt: string | null,
): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  const changes: Record<string, unknown> = {};
  for (const [key, rawValue] of formData.entries()) {
    if (typeof rawValue !== "string") continue;
    const value = rawValue.trim();
    if (!value) continue;
    if (key.startsWith("changes.")) changes[key.slice("changes.".length)] = value;
    else flat[key] = value;
  }

  if (typeof flat.coverConfirmed === "string") flat.coverConfirmed = flat.coverConfirmed === "true";
  if (typeof changes.coverConfirmed === "string") changes.coverConfirmed = changes.coverConfirmed === "true";

  const numericFields = kind === "material.create"
    ? ["year", "classFrom", "classTo"]
    : kind === "revision.count"
      ? ["countedQuantity"]
      : kind === "receipt.create" || kind === "transfer.create" || kind === "writeoff.create"
        ? ["quantity"]
        : kind === "class-year.create"
          ? ["grade"]
          : [];
  numericFields.forEach((field) => convertNumericField(flat, field));
  if (kind === "material.update") {
    ["year", "classFrom", "classTo"].forEach((field) => convertNumericField(changes, field));
  }
  if (kind === "class-year.update") convertNumericField(changes, "grade");
  if (kind === "class-year.close" && typeof flat.closeCohort === "string") {
    flat.closeCohort = flat.closeCohort === "true";
  }

  appendDirectorySnapshot(flat, "locationId", "locationName", referenceData.locations);
  appendDirectorySnapshot(flat, "fromLocationId", "fromLocationName", referenceData.locations);
  appendDirectorySnapshot(flat, "toLocationId", "toLocationName", referenceData.locations);
  appendDirectorySnapshot(flat, "teacherUserId", "teacherName", referenceData.teachers);
  appendDirectorySnapshot(changes, "locationId", "locationName", referenceData.locations);
  appendDirectorySnapshot(changes, "teacherUserId", "teacherName", referenceData.teachers);

  if ([
    "material.update",
    "receipt.create",
    "transfer.create",
    "writeoff.create",
    "revision.count",
  ].includes(kind) && sourceGeneratedAt) {
    flat.sourceGeneratedAt = sourceGeneratedAt;
  }

  if (kind === "material.update" || kind === "class-year.update") {
    flat.changes = changes;
  }

  if (kind === "academic-year.rollover") {
    const rawClasses = flat.rolloverClassesJson;
    delete flat.rolloverClassesJson;
    if (typeof rawClasses === "string") {
      try {
        const parsed: unknown = JSON.parse(rawClasses);
        flat.classes = Array.isArray(parsed) ? parsed : [];
      } catch {
        flat.classes = [];
      }
    }
  }
  return flat;
}

function draftCoverPhotoKey(
  kind: DraftKind,
  payload: Record<string, unknown> | null,
): string {
  if (!payload) return "";
  const coverPayload = kind === "material.update"
    ? nestedRecord(payload, "changes")
    : payload;
  return initialField(coverPayload, "coverPhotoKey");
}

async function deleteOwnedCoverPhoto(key: string): Promise<boolean> {
  if (!key) return true;
  try {
    const response = await fetch(
      `/api/librarian/cover-photo?key=${encodeURIComponent(key)}`,
      { method: "DELETE" },
    );
    return response.ok;
  } catch {
    return false;
  }
}

function convertNumericField(record: Record<string, unknown>, field: string) {
  if (typeof record[field] === "string") record[field] = Number(record[field]);
}

function appendDirectorySnapshot(
  payload: Record<string, unknown>,
  idField: string,
  nameField: string,
  directory: Array<{ id: string; name: string }>,
) {
  const id = payload[idField];
  if (id === "__clear__") {
    payload[idField] = null;
    payload[nameField] = null;
    return;
  }
  if (typeof id !== "string") return;
  const match = directory.find((item) => item.id === id);
  if (match) payload[nameField] = match.name;
}

function readApiError(body: unknown, fallback: string): string {
  if (!isRecord(body)) return fallback;
  return typeof body.error === "string" ? body.error : fallback;
}

function formatFieldErrors(value: unknown): string {
  if (!isRecord(value)) return "";
  const messages = Object.values(value).filter((item): item is string => typeof item === "string");
  return messages.join(" ");
}

function readFieldErrors(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeReferenceData(value: Record<string, unknown>): ReferenceData {
  const teachers = Array.isArray(value.teachers)
    ? value.teachers.flatMap((item): ReferenceTeacher[] => {
        if (!isRecord(item)) return [];
        const id = readText(item, ["id"]);
        const name = readText(item, ["name"]);
        if (!/^USR-\d{3,}$/u.test(id) || !name) return [];
        return [{ id, name, role: readText(item, ["role"]), status: readText(item, ["status"]) }];
      })
    : [];
  const locations = Array.isArray(value.locations)
    ? value.locations.flatMap((item): ReferenceLocation[] => {
        if (!isRecord(item)) return [];
        const id = readText(item, ["id"]);
        const name = readText(item, ["name"]);
        if (!/^LOC-\d{3,}$/u.test(id) || !name || id === "LOC-007" || id === "LOC-008") return [];
        return [{ id, name, type: readText(item, ["type"]), status: readText(item, ["status"]) }];
      })
    : [];
  const academicYears = Array.isArray(value.academicYears)
    ? value.academicYears.flatMap((item): ReferenceAcademicYear[] => {
        if (!isRecord(item)) return [];
        const id = readText(item, ["id"]);
        const label = readText(item, ["label"]);
        if (!/^YR-20\d{2}-20\d{2}$/u.test(id) || !/^20\d{2}\/20\d{2}$/u.test(label)) return [];
        return [{
          id,
          label,
          startDate: readText(item, ["startDate"]),
          endDate: readText(item, ["endDate"]),
          status: readText(item, ["status"]),
          notes: readText(item, ["notes"]),
        }];
      })
    : [];
  const classYears = Array.isArray(value.classYears)
    ? value.classYears.flatMap((item): ReferenceClassYear[] => {
        if (!isRecord(item)) return [];
        const id = readText(item, ["id"]);
        const academicYearId = readText(item, ["academicYearId"]);
        if (!/^CY-20\d{2}-\d{3,}$/u.test(id) || !/^YR-20\d{2}-20\d{2}$/u.test(academicYearId)) return [];
        const grade = readNumber(item, ["grade"]);
        return [{
          id,
          academicYearId,
          academicYearLabel: readText(item, ["academicYearLabel"]),
          cohortId: readText(item, ["cohortId"]),
          className: readText(item, ["className"]),
          grade,
          code: readText(item, ["code"]),
          teacherName: readText(item, ["teacherName"]),
          teacherUserId: readText(item, ["teacherUserId"]),
          locationName: readText(item, ["locationName"]),
          locationId: readText(item, ["locationId"]),
          startDate: readText(item, ["startDate"]),
          endDate: readText(item, ["endDate"]),
          status: readText(item, ["status"]),
          actualClosedDate: readText(item, ["actualClosedDate"]),
          notes: readText(item, ["notes"]),
        }];
      })
    : [];
  return { teachers, locations, academicYears, classYears };
}

function readText(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return "";
}

function initialField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function nestedRecord(payload: Record<string, unknown>, key: string): Record<string, unknown> {
  return isRecord(payload[key]) ? payload[key] as Record<string, unknown> : {};
}

function initialBooleanField(
  payload: Record<string, unknown>,
  key: string,
  fallback: boolean,
): string {
  const value = payload[key];
  return value === true || value === "true"
    ? "true"
    : value === false || value === "false"
      ? "false"
      : fallback ? "true" : "false";
}

function nullableDirectoryInitial(payload: Record<string, unknown>, key: string): string {
  return Object.hasOwn(payload, key) && payload[key] === null
    ? "__clear__"
    : initialField(payload, key);
}

function protectedLocations(referenceData: ReferenceData): ReferenceLocation[] {
  return referenceData.locations
    .filter((location) => (
      /^LOC-\d{3,}$/u.test(location.id)
      && location.id !== "LOC-007"
      && location.id !== "LOC-008"
      && location.name.trim()
    ))
    .sort((left, right) => left.name.localeCompare(right.name, "uk", { numeric: true }));
}

function uniqueCohorts(classYears: ReferenceClassYear[]): Array<{ id: string; label: string }> {
  const cohorts = new Map<string, string>();
  classYears.forEach((item) => {
    if (!/^COH-\d{3,}$/u.test(item.cohortId)) return;
    const label = [item.className, item.academicYearLabel].filter(Boolean).join(" · ") || item.cohortId;
    cohorts.set(item.cohortId, label);
  });
  return [...cohorts].map(([id, label]) => ({ id, label }))
    .sort((left, right) => left.label.localeCompare(right.label, "uk", { numeric: true }));
}

function nextAcademicYearId(
  sourceYearId: string,
  years: ReferenceAcademicYear[],
): string {
  const match = sourceYearId.match(/^YR-(20\d{2})-(20\d{2})$/u);
  if (!match) return "";
  const expected = `YR-${Number(match[1]) + 1}-${Number(match[2]) + 1}`;
  return years.some((year) => year.id === expected) ? expected : "";
}

function buildRolloverRows(
  sourceYearId: string,
  referenceData: ReferenceData,
): RolloverRow[] {
  const safeLocations = protectedLocations(referenceData);
  return referenceData.classYears
    .filter((item) => (
      item.academicYearId === sourceYearId
      && /^CY-20\d{2}-\d{3,}$/u.test(item.id)
      && /^COH-\d{3,}$/u.test(item.cohortId)
      && typeof item.grade === "number"
      && item.grade >= 1
      && item.grade <= 11
      && !item.actualClosedDate
      && !/closed|закрит/i.test(item.status)
    ))
    .sort((left, right) => left.className.localeCompare(right.className, "uk", { numeric: true }))
    .map((item) => {
      const location = safeLocations.find((candidate) => candidate.id === item.locationId);
      const teacher = referenceData.teachers.find((candidate) => candidate.id === item.teacherUserId);
      const graduate = item.grade === 11;
      return {
        sourceClassYearId: item.id,
        cohortId: item.cohortId,
        sourceGrade: item.grade!,
        className: item.className || `${item.grade}-${item.code}`,
        action: graduate ? "graduate" : "promote",
        ...(graduate ? {} : {
          targetGrade: item.grade! + 1,
          targetCode: item.code || classCodeFromName(item.className),
        }),
        ...(teacher ? { teacherUserId: teacher.id, teacherName: teacher.name } : {}),
        ...(location ? { locationId: location.id, locationName: location.name } : {}),
      } satisfies RolloverRow;
    });
}

function rolloverRowsFromPayload(
  payload: Record<string, unknown>,
  referenceData: ReferenceData,
): RolloverRow[] {
  if (!Array.isArray(payload.classes)) return [];
  return payload.classes.flatMap((item): RolloverRow[] => {
    if (!isRecord(item)) return [];
    const sourceClassYearId = readText(item, ["sourceClassYearId"]);
    const cohortId = readText(item, ["cohortId"]);
    const sourceGrade = readNumber(item, ["sourceGrade"]);
    const action = readText(item, ["action"]);
    const sourceClass = referenceData.classYears.find((candidate) => (
      candidate.id === sourceClassYearId
    ));
    if (
      !/^CY-20\d{2}-\d{3,}$/u.test(sourceClassYearId)
      || !/^COH-\d{3,}$/u.test(cohortId)
      || sourceGrade === null
      || !["promote", "graduate", "close", "skip"].includes(action)
    ) return [];
    return [{
      sourceClassYearId,
      cohortId,
      sourceGrade,
      className: sourceClass?.className
        || readText(item, ["className"])
        || `${sourceGrade}-${sourceClass?.code || readText(item, ["targetCode"]) || "?"}`,
      action: action as RolloverRow["action"],
      ...(readNumber(item, ["targetGrade"]) !== null ? { targetGrade: readNumber(item, ["targetGrade"])! } : {}),
      ...(readText(item, ["targetCode"]) ? { targetCode: readText(item, ["targetCode"]) } : {}),
      ...(readText(item, ["teacherUserId"]) ? { teacherUserId: readText(item, ["teacherUserId"]), teacherName: readText(item, ["teacherName"]) } : {}),
      ...(readText(item, ["locationId"]) ? { locationId: readText(item, ["locationId"]), locationName: readText(item, ["locationName"]) } : {}),
      ...(readText(item, ["overrideReason"]) ? { overrideReason: readText(item, ["overrideReason"]) } : {}),
      ...(readText(item, ["notes"]) ? { notes: readText(item, ["notes"]) } : {}),
    }];
  });
}

function stripRolloverDisplayFields(row: RolloverRow): Record<string, unknown> {
  return {
    sourceClassYearId: row.sourceClassYearId,
    cohortId: row.cohortId,
    sourceGrade: row.sourceGrade,
    action: row.action,
    ...(row.action === "promote" ? {
      targetGrade: row.targetGrade,
      targetCode: row.targetCode,
      ...(row.teacherUserId && row.teacherName ? { teacherUserId: row.teacherUserId, teacherName: row.teacherName } : {}),
      ...(row.locationId && row.locationName ? { locationId: row.locationId, locationName: row.locationName } : {}),
    } : {}),
    ...(row.overrideReason ? { overrideReason: row.overrideReason } : {}),
    ...(row.notes ? { notes: row.notes } : {}),
  };
}

function classCodeFromName(value: string): string {
  return value.match(/^\d{1,2}-(.+)$/u)?.[1] ?? "";
}

function kindNeedsMaterial(kind: DraftKind): boolean {
  return [
    "material.update",
    "receipt.create",
    "transfer.create",
    "writeoff.create",
    "revision.count",
  ].includes(kind);
}

function isPositiveRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function draftStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    draft: "Чернетка",
    ready_for_review: "Очікує перевірки",
    cancelled: "Скасовано",
    approved_pending_apply: "Погоджено до внесення",
    applied: "Внесено",
    failed: "Помилка внесення",
  };
  return labels[status] ?? status;
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const raw = record[key];
    if (raw === null || raw === undefined || raw === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function catalogRubrics(catalog: CatalogMaterial[]): string[] {
  const values = new Set([
    "Підручники і хрестоматії",
    "Робочі та контрольні зошити, збірники",
    "Дидактичні й довідкові матеріали",
    "Методична література",
    "ЗНО і НМТ",
  ]);
  catalog.forEach((material) => {
    const rubric = readText(material, ["rubric"]);
    if (rubric) values.add(rubric);
  });
  return [...values].sort((left, right) => left.localeCompare(right, "uk"));
}

function catalogLocations(catalog: CatalogMaterial[]): string[] {
  const values = new Set(["Бібліотека"]);
  catalog.forEach((material) => {
    const stock = material.stock;
    if (!isRecord(stock) || !Array.isArray(stock.locations)) return;
    stock.locations.forEach((entry) => {
      if (!isRecord(entry)) return;
      const name = readText(entry, ["name"]);
      if (name) values.add(name);
    });
  });
  return [...values].sort((left, right) => left.localeCompare(right, "uk", { numeric: true }));
}

function materialIdentifier(material: CatalogMaterial): string {
  return readText(material, ["catId", "cat_id", "materialId", "material_id", "id", "isbn"]);
}

function materialDisplayTitle(material: CatalogMaterial): string {
  return readText(material, ["title", "name"]) || "Матеріал без назви";
}

function materialMeta(material: CatalogMaterial): string {
  return [
    readText(material, ["author", "authors"]),
    materialClassLabel(material),
    readText(material, ["isbn"]),
  ].filter(Boolean).join(" · ") || "Додаткові дані відсутні";
}

function materialClassLabel(material: CatalogMaterial): string {
  const explicit = readText(material, ["grade", "className", "class"]);
  if (explicit) return explicit;
  const classFrom = readNumber(material, ["classFrom"]);
  const classTo = readNumber(material, ["classTo"]);
  if (!classFrom) return "";
  if (!classTo || classTo === classFrom) return `${classFrom} клас`;
  return `${classFrom}–${classTo} класи`;
}

function materialSearchText(material: CatalogMaterial): string {
  return normalizeSearch([
    materialIdentifier(material),
    materialDisplayTitle(material),
    materialMeta(material),
    readText(material, ["subject", "rubric"]),
  ].join(" "));
}

function normalizeSearch(value: string): string {
  return value.toLocaleLowerCase("uk-UA").replace(/[\s\-–—]+/gu, "").trim();
}

function draftPrimaryText(draft: SavedDraft): string {
  const payload = isRecord(draft.payload) ? draft.payload : {};
  return readText(payload, [
    "title",
    "materialTitle",
    "materialId",
    "label",
    "classYearId",
    "targetYearId",
    "academicYearId",
  ]) || KIND_LABELS[draft.kind] || "Чернетка";
}

function shortDraftId(value: unknown): string {
  if (typeof value !== "string") return "створено";
  return `№ ${value.slice(0, 8)}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("uk-UA").format(value);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "щойно";
  return new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function isToday(value: string): boolean {
  const date = new Date(value);
  const now = new Date();
  return date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
}

function todayValue(): string {
  const now = new Date();
  const localDate = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 10);
}
