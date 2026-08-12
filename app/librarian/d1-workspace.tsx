"use client";

/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  buildCatalogSearchUrl,
  editDraftToChanges,
  gradeLabel,
  holdingKey,
  type CatalogSearchFilters,
  type MaterialEditDraft,
  materialToEditDraft,
  resolveLoanDueAtForSubmission,
  todayInKyiv,
} from "@/lib/librarian-d1-client";
import { normalizeCoverPhotoForUpload } from "@/lib/cover-client";
import {
  clearPendingInventoryIntent as clearStoredInventoryIntent,
  type PendingInventoryIntent,
  readPendingInventoryIntent as readStoredInventoryIntent,
  writePendingInventoryIntent as writeStoredInventoryIntent,
} from "@/lib/librarian-pending-intent";
import AcademicWorkspace, {
  type AcademicTool,
  isAcademicTool,
} from "./academic-workspace";

import styles from "./d1-workspace.module.css";

type Tool =
  | "catalog"
  | "create"
  | "receipt"
  | "transfer"
  | "writeoff"
  | "count"
  | "issue"
  | "return"
  | AcademicTool;
type LoadState = "idle" | "loading" | "ready" | "error";

type CatalogMaterial = {
  id: string;
  title: string;
  author: string;
  year: number | null;
  isbn: string;
  rubric: string;
  subject: string;
  publicationType: string;
  classFrom: number | null;
  classTo: number | null;
  publisher: string;
  thumbnailUrl: string;
  totalQuantity: number;
  availableQuantity: number;
  libraryQuantity: number;
  otherLocationQuantity: number;
  loanedQuantity: number;
};

type MaterialLink = {
  id?: string;
  kind: string;
  label: string;
  url: string;
  isPublic?: boolean;
  sortOrder?: number;
};

type EditableLinkDraft = {
  key: string;
  id: string | null;
  kind: "ebook" | "details" | "publisher" | "store" | "preview" | "other";
  label: string;
  url: string;
  isPublic: boolean;
};

type MaterialHolding = {
  locationId: string;
  locationName: string;
  locationType: string;
  locationStatus: string;
  condition: string | null;
  quantity: number;
  updatedAt: string;
};

type MaterialDetail = CatalogMaterial & {
  version?: number;
  notes?: string;
  links: MaterialLink[];
  holdings: MaterialHolding[];
  cover: {
    url: string;
    mimeType: string;
    width: number | null;
    height: number | null;
    version?: number;
  } | null;
};

type SearchEnvelope = {
  success: boolean;
  items: CatalogMaterial[];
  page: { hasMore: boolean; nextCursor: string | null };
};

type DetailEnvelope = {
  success: boolean;
  material: MaterialDetail;
};

type MutationEnvelope<T> = {
  success: boolean;
  result: T;
};

type ApiFailure = {
  success?: false;
  code?: string;
  error?: string;
  message?: string;
  fieldErrors?: Record<string, string>;
};

type LibraryTeacher = {
  id: string;
  fullName: string;
};

type LibraryLocation = {
  id: string;
  name: string;
  type: string;
  isPublic: boolean;
};

type ReferenceEnvelope = {
  success: boolean;
  teachers: LibraryTeacher[];
  locations: LibraryLocation[];
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

type BookLookupEnvelope = {
  success: boolean;
  found: boolean;
  candidates: BookLookupCandidate[];
};

type OpenLoanItem = {
  loanItemId: string;
  materialId: string;
  materialTitle: string;
  materialYear: number | null;
  sourceLocationId: string;
  sourceLocationName: string;
  condition: string;
  quantityIssued: number;
  quantityReturned: number;
  quantityOutstanding: number;
};

type OpenLoan = {
  loanId: string;
  teacherUserId: string;
  teacherName: string;
  issuedAt: string;
  dueAt: string | null;
  notes: string;
  version: number;
  items: OpenLoanItem[];
};

type LoansEnvelope = {
  success: boolean;
  loans: OpenLoan[];
};

type LibrarianWorkspaceProps = {
  displayName: string;
  role: string;
  writesEnabled: boolean;
  signOutHref: string;
};

const PUBLIC_CATALOG_URL = "https://nazarijshvetz1.github.io/library-site/";
const LOGO_URL = `${PUBLIC_CATALOG_URL}library-logo.png`;

const EMPTY_FILTERS: CatalogSearchFilters = {
  q: "",
  rubric: "",
  grade: "",
  subject: "",
  publicationType: "",
  available: false,
};

const TOOLS: Array<{ id: Tool; icon: string; label: string; hint: string }> = [
  { id: "catalog", icon: "⌕", label: "Каталог", hint: "Пошук і картка" },
  { id: "create", icon: "+", label: "Новий матеріал", hint: "Додати без чернетки" },
  { id: "receipt", icon: "↓", label: "Надходження", hint: "Додати примірники" },
  { id: "transfer", icon: "⇄", label: "Переміщення", hint: "Змінити розміщення" },
  { id: "writeoff", icon: "−", label: "Списання", hint: "Зменшити залишок" },
  {
    id: "count",
    icon: "✓",
    label: "Фактична кількість",
    hint: "Звірити залишок",
  },
  { id: "issue", icon: "→", label: "Видача", hint: "Видати вчителю" },
  { id: "return", icon: "↩", label: "Повернення", hint: "Прийняти книги" },
  { id: "academic-year", icon: "▣", label: "Новий навчальний рік", hint: "Створити період" },
  { id: "class-create", icon: "+", label: "Відкрити клас", hint: "Додати до року" },
  { id: "class-update", icon: "↻", label: "Змінити клас", hint: "Керівник і кабінет" },
  { id: "class-close", icon: "×", label: "Закрити клас", hint: "Зберегти історію" },
  { id: "rollover", icon: "⇢", label: "Перехід на новий рік", hint: "Перевести всі класи" },
];

export default function D1LibrarianWorkspace({
  displayName,
  role,
  writesEnabled,
  signOutHref,
}: LibrarianWorkspaceProps) {
  const [tool, setTool] = useState<Tool>("catalog");
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [items, setItems] = useState<CatalogMaterial[]>([]);
  const [searchState, setSearchState] = useState<LoadState>("loading");
  const [searchError, setSearchError] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const detailRequestRef = useRef(0);
  const [detail, setDetail] = useState<MaterialDetail | null>(null);
  const [detailState, setDetailState] = useState<LoadState>("idle");
  const [detailError, setDetailError] = useState("");
  const [editing, setEditing] = useState(false);
  const [workspaceNotice, setWorkspaceNotice] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const [teachers, setTeachers] = useState<LibraryTeacher[]>([]);
  const [locations, setLocations] = useState<LibraryLocation[]>([]);
  const [referenceState, setReferenceState] = useState<LoadState>("loading");
  const [referenceError, setReferenceError] = useState("");

  const loadDetail = useCallback(async (materialId: string) => {
    const request = detailRequestRef.current + 1;
    detailRequestRef.current = request;
    setDetailState("loading");
    setDetailError("");
    try {
      const response = await apiJson<DetailEnvelope>(
        `/api/librarian/materials/${encodeURIComponent(materialId)}`,
      );
      if (request !== detailRequestRef.current || selectedIdRef.current !== materialId) return;
      setDetail(response.material);
      setDetailState("ready");
    } catch (error) {
      if (request !== detailRequestRef.current || selectedIdRef.current !== materialId) return;
      setDetail(null);
      setDetailState("error");
      setDetailError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearchState("loading");
      setSearchError("");
      try {
        const response = await apiJson<SearchEnvelope>(
          buildCatalogSearchUrl(filters),
          { signal: controller.signal },
        );
        setItems(response.items);
        setNextCursor(response.page.nextCursor);
        setSearchState("ready");
      } catch (error) {
        if (controller.signal.aborted) return;
        setItems([]);
        setNextCursor(null);
        setSearchState("error");
        setSearchError(errorMessage(error));
      }
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [filters, refreshToken]);

  useEffect(() => {
    const controller = new AbortController();
    void apiJson<ReferenceEnvelope>("/api/librarian/library-reference", {
      signal: controller.signal,
    }).then((response) => {
      setTeachers(response.teachers);
      setLocations(response.locations);
      setReferenceState("ready");
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setReferenceState("error");
      setReferenceError(errorMessage(error));
    });
    return () => controller.abort();
  }, []);

  const selectMaterial = useCallback(
    (materialId: string) => {
      selectedIdRef.current = materialId;
      detailRequestRef.current += 1;
      setSelectedId(materialId);
      setEditing(false);
      setWorkspaceNotice("");
      void loadDetail(materialId);
    },
    [loadDetail],
  );

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const response = await apiJson<SearchEnvelope>(
        buildCatalogSearchUrl(filters, nextCursor),
      );
      setItems((current) => {
        const known = new Set(current.map((item) => item.id));
        return [
          ...current,
          ...response.items.filter((item) => !known.has(item.id)),
        ];
      });
      setNextCursor(response.page.nextCursor);
    } catch (error) {
      setSearchError(errorMessage(error));
    } finally {
      setLoadingMore(false);
    }
  }

  const refreshSelected = useCallback(async () => {
    setRefreshToken((value) => value + 1);
    const currentId = selectedIdRef.current;
    if (currentId) await loadDetail(currentId);
  }, [loadDetail]);

  function chooseTool(nextTool: Tool) {
    setTool(nextTool);
    setEditing(false);
    setWorkspaceNotice("");
  }

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/">
          <img src={LOGO_URL} alt="" width="48" height="48" />
          <span>
            <strong>Єдина бібліотека</strong>
            <small>Швидкий кабінет бібліотекаря</small>
          </span>
        </Link>
        <div className={styles.account}>
          <a
            href={PUBLIC_CATALOG_URL}
            className={styles.catalogLink}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Відкрити публічний каталог у новій вкладці"
          >
            <span className={styles.catalogLinkLabel}>Публічний каталог</span>{" "}
            <span aria-hidden="true">↗</span>
          </a>
          <span>
            <strong>{displayName}</strong>
            <small>{role === "admin" ? "Адміністратор" : "Бібліотекар"}</small>
          </span>
          <a className={styles.signOut} href={signOutHref} title="Вийти">
            ↗
          </a>
        </div>
      </header>

      <div className={styles.body}>
        <aside className={styles.sidebar} aria-label="Робочі дії">
          <p className={styles.sidebarLabel}>Робоче місце</p>
          <nav className={styles.toolNav}>
            {TOOLS.map((item) => (
              <button
                key={item.id}
                className={tool === item.id ? styles.toolActive : styles.tool}
                type="button"
                onClick={() => chooseTool(item.id)}
              >
                <span aria-hidden="true">{item.icon}</span>
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.hint}</small>
                </span>
              </button>
            ))}
          </nav>
          <div className={writesEnabled ? styles.writeOn : styles.writeOff}>
            <span aria-hidden="true">{writesEnabled ? "●" : "○"}</span>
            <span>
              <strong>{writesEnabled ? "Запис увімкнено" : "Лише перегляд"}</strong>
              <small>
                {writesEnabled
                  ? "Зміни одразу потрапляють у нову базу."
                  : "Адміністратор тимчасово вимкнув зміни."}
              </small>
            </span>
          </div>
        </aside>

        <section className={styles.workspace}>
          <div className={styles.mobileTools} aria-label="Робочі дії">
            {TOOLS.map((item) => (
              <button
                key={item.id}
                className={tool === item.id ? styles.mobileToolActive : ""}
                type="button"
                onClick={() => chooseTool(item.id)}
              >
                <span aria-hidden="true">{item.icon}</span>
                {item.label}
              </button>
            ))}
          </div>

          <div className={styles.titleRow}>
            <div>
              <p className={styles.eyebrow}>D1 · швидкий режим</p>
              <h1>{toolTitle(tool)}</h1>
              <p>{toolDescription(tool)}</p>
            </div>
            <button
              className={styles.refresh}
              type="button"
              onClick={() => void refreshSelected()}
              disabled={searchState === "loading" || detailState === "loading"}
            >
              ↻ Оновити
            </button>
          </div>

          {workspaceNotice ? (
            <div className={styles.workspaceNotice} role="status" aria-live="polite">
              <InlineMessage tone="error">{workspaceNotice}</InlineMessage>
              <button
                type="button"
                aria-label="Закрити повідомлення"
                onClick={() => setWorkspaceNotice("")}
              >
                ×
              </button>
            </div>
          ) : null}

          <div className={isAcademicTool(tool) ? styles.workGridWide : styles.workGrid}>
            {!isAcademicTool(tool) ? (
              <CatalogSearch
                filters={filters}
                onFilters={setFilters}
                items={items}
                state={searchState}
                error={searchError}
                selectedId={selectedId}
                onSelect={selectMaterial}
                nextCursor={nextCursor}
                loadingMore={loadingMore}
                onLoadMore={() => void loadMore()}
              />
            ) : null}

            <section className={styles.actionPane}>
              {tool === "catalog" ? (
                <MaterialCard
                  detail={detail}
                  state={detailState}
                  error={detailError}
                  editing={editing}
                  onEditing={(value) => {
                    setEditing(value);
                    if (value) setWorkspaceNotice("");
                  }}
                  writesEnabled={writesEnabled}
                  onSaved={refreshSelected}
                  onNotice={setWorkspaceNotice}
                  onChooseTool={chooseTool}
                />
              ) : null}
              {tool === "count" ? (
                <StockCountPanel
                  detail={detail}
                  state={detailState}
                  error={detailError}
                  writesEnabled={writesEnabled}
                  locations={locations}
                  onSaved={refreshSelected}
                />
              ) : null}
              {tool === "create" ? (
                <MaterialCreatePanel
                  writesEnabled={writesEnabled}
                  locations={locations}
                  referenceState={referenceState}
                  referenceError={referenceError}
                  onCreated={async (materialId) => {
                    setRefreshToken((value) => value + 1);
                    selectMaterial(materialId);
                  }}
                  onOpenMaterial={() => chooseTool("catalog")}
                />
              ) : null}
              {tool === "receipt" ? (
                <ReceiptPanel
                  detail={detail}
                  state={detailState}
                  error={detailError}
                  writesEnabled={writesEnabled}
                  locations={locations}
                  referenceState={referenceState}
                  referenceError={referenceError}
                  onSaved={refreshSelected}
                />
              ) : null}
              {tool === "transfer" ? (
                <TransferPanel
                  detail={detail}
                  state={detailState}
                  error={detailError}
                  writesEnabled={writesEnabled}
                  locations={locations}
                  referenceState={referenceState}
                  referenceError={referenceError}
                  onSaved={refreshSelected}
                />
              ) : null}
              {tool === "writeoff" ? (
                <WriteoffPanel
                  detail={detail}
                  state={detailState}
                  error={detailError}
                  writesEnabled={writesEnabled}
                  locations={locations}
                  referenceState={referenceState}
                  referenceError={referenceError}
                  onSaved={refreshSelected}
                />
              ) : null}
              {tool === "issue" ? (
                <LoanIssuePanel
                  detail={detail}
                  state={detailState}
                  error={detailError}
                  writesEnabled={writesEnabled}
                  teachers={teachers}
                  referenceState={referenceState}
                  referenceError={referenceError}
                  onSaved={refreshSelected}
                  onChooseReturn={() => chooseTool("return")}
                />
              ) : null}
              {tool === "return" ? (
                <LoanReturnPanel
                  writesEnabled={writesEnabled}
                  teachers={teachers}
                  locations={locations}
                  referenceState={referenceState}
                  referenceError={referenceError}
                  onSaved={refreshSelected}
                />
              ) : null}
              {isAcademicTool(tool) ? (
                <AcademicWorkspace
                  tool={tool}
                  writesEnabled={writesEnabled}
                  teachers={teachers}
                  locations={locations}
                />
              ) : null}
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}

function CatalogSearch({
  filters,
  onFilters,
  items,
  state,
  error,
  selectedId,
  onSelect,
  nextCursor,
  loadingMore,
  onLoadMore,
}: {
  filters: CatalogSearchFilters;
  onFilters: (value: CatalogSearchFilters) => void;
  items: CatalogMaterial[];
  state: LoadState;
  error: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  function update<K extends keyof CatalogSearchFilters>(
    key: K,
    value: CatalogSearchFilters[K],
  ) {
    onFilters({ ...filters, [key]: value });
  }

  const hasFilters = Object.entries(filters).some(([, value]) => Boolean(value));

  return (
    <section className={styles.searchPane} aria-labelledby="catalog-search-title">
      <div className={styles.paneHeading}>
        <div>
          <p>Крок 1</p>
          <h2 id="catalog-search-title">Знайдіть матеріал</h2>
        </div>
        {hasFilters ? (
          <button type="button" onClick={() => onFilters(EMPTY_FILTERS)}>
            Очистити
          </button>
        ) : null}
      </div>

      <label className={styles.searchField}>
        <span className={styles.srOnly}>Пошук за назвою, ISBN або CAT-ID</span>
        <span aria-hidden="true">⌕</span>
        <input
          type="search"
          value={filters.q}
          onChange={(event) => update("q", event.target.value)}
          placeholder="Назва, автор, ISBN або CAT-ID"
          autoComplete="off"
        />
      </label>

      <details className={styles.filters}>
        <summary>Фільтри рубрики, класу, предмета й типу</summary>
        <div className={styles.filterGrid}>
          <label>
            <span>Рубрика</span>
            <input
              value={filters.rubric}
              onChange={(event) => update("rubric", event.target.value)}
              placeholder="Наприклад, Підручники"
            />
          </label>
          <label>
            <span>Клас</span>
            <select
              value={filters.grade}
              onChange={(event) => update("grade", event.target.value)}
            >
              <option value="">Усі класи</option>
              {Array.from({ length: 11 }, (_, index) => index + 1).map((grade) => (
                <option key={grade} value={grade}>
                  {grade} клас
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Предмет</span>
            <input
              value={filters.subject}
              onChange={(event) => update("subject", event.target.value)}
              placeholder="Наприклад, математика"
            />
          </label>
          <label>
            <span>Тип видання</span>
            <input
              value={filters.publicationType}
              onChange={(event) => update("publicationType", event.target.value)}
              placeholder="Підручник, атлас…"
            />
          </label>
          <label className={styles.checkField}>
            <input
              type="checkbox"
              checked={filters.available}
              onChange={(event) => update("available", event.target.checked)}
            />
            <span>Лише доступні зараз</span>
          </label>
        </div>
      </details>

      <div className={styles.resultMeta} aria-live="polite">
        {state === "loading" ? "Шукаємо…" : `Знайдено на сторінці: ${items.length}`}
      </div>

      {state === "error" ? <InlineMessage tone="error">{error}</InlineMessage> : null}
      {state === "ready" && items.length === 0 ? (
        <div className={styles.empty}>
          <span aria-hidden="true">⌕</span>
          <strong>Нічого не знайдено</strong>
          <p>Спробуйте коротшу назву або очистіть один із фільтрів.</p>
        </div>
      ) : null}

      <div className={styles.results} aria-busy={state === "loading"}>
        {items.map((item) => (
          <button
            type="button"
            key={item.id}
            className={item.id === selectedId ? styles.resultActive : styles.result}
            onClick={() => onSelect(item.id)}
          >
            <Cover material={item} />
            <span className={styles.resultCopy}>
              <strong>{item.title}</strong>
              <small>
                {[item.author, item.year ? String(item.year) : "Рік не вказано"]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
              <small>{[item.subject, gradeLabel(item.classFrom, item.classTo)].filter(Boolean).join(" · ")}</small>
            </span>
            <span className={styles.resultAside}>
              <code>{item.id}</code>
              <small>{item.availableQuantity} доступно</small>
            </span>
          </button>
        ))}
      </div>

      {nextCursor ? (
        <button
          className={styles.moreButton}
          type="button"
          disabled={loadingMore}
          onClick={onLoadMore}
        >
          {loadingMore ? "Завантажуємо…" : "Показати ще"}
        </button>
      ) : null}
    </section>
  );
}

function MaterialCard({
  detail,
  state,
  error,
  editing,
  onEditing,
  writesEnabled,
  onSaved,
  onNotice,
  onChooseTool,
}: {
  detail: MaterialDetail | null;
  state: LoadState;
  error: string;
  editing: boolean;
  onEditing: (value: boolean) => void;
  writesEnabled: boolean;
  onSaved: () => Promise<void>;
  onNotice: (message: string) => void;
  onChooseTool: (tool: Tool) => void;
}) {
  if (state === "idle") return <ChooseMaterial />;
  if (state === "loading") return <PanelLoading />;
  if (state === "error" || !detail) {
    return <InlineMessage tone="error">{error || "Матеріал не завантажено."}</InlineMessage>;
  }

  if (editing) {
    return (
      <MaterialEditForm
        detail={detail}
        writesEnabled={writesEnabled}
        onCancel={() => onEditing(false)}
        onCompleted={async () => {
          onEditing(false);
          await onSaved();
        }}
        onPartialUnknown={(message) => {
          onNotice(message);
          onEditing(false);
          void onSaved();
        }}
      />
    );
  }

  return (
    <div className={styles.detailCard}>
      <div className={styles.detailHero}>
        <div className={styles.detailCover}>
          {detail.cover?.url || detail.thumbnailUrl ? (
            <img src={detail.cover?.url || detail.thumbnailUrl} alt={`Обкладинка: ${detail.title}`} />
          ) : (
            <span aria-hidden="true">Б</span>
          )}
        </div>
        <div>
          <p className={styles.materialId}>{detail.id}</p>
          <h2>{detail.title}</h2>
          <p>{[detail.author, detail.year].filter(Boolean).join(" · ") || "Автор і рік не вказані"}</p>
          <div className={styles.detailActions}>
            <button
              className={styles.primaryButton}
              type="button"
              disabled={!writesEnabled || typeof detail.version !== "number"}
              onClick={() => onEditing(true)}
            >
              Редагувати матеріал
            </button>
            <button className={styles.secondaryButton} type="button" onClick={() => onChooseTool("count")}>
              Встановити кількість
            </button>
            <button className={styles.secondaryButton} type="button" onClick={() => onChooseTool("issue")}>
              Видати вчителю
            </button>
          </div>
          {writesEnabled && typeof detail.version !== "number" ? (
            <p className={styles.contractWarning}>
              Редагування стане доступним після оновлення версії картки сервером.
            </p>
          ) : null}
        </div>
      </div>

      <div className={styles.stockStrip}>
        <StockStat label="Усього" value={detail.totalQuantity} />
        <StockStat label="Доступно" value={detail.availableQuantity} emphasis />
        <StockStat label="Видано" value={detail.loanedQuantity} />
      </div>

      <section className={styles.detailSection}>
        <h3>Відомості про видання</h3>
        <dl className={styles.factGrid}>
          <Fact label="Рубрика" value={detail.rubric} />
          <Fact label="Тип" value={detail.publicationType} />
          <Fact label="Предмет" value={detail.subject} />
          <Fact label="Клас" value={gradeLabel(detail.classFrom, detail.classTo)} />
          <Fact label="ISBN" value={detail.isbn} />
          <Fact label="Видавництво" value={detail.publisher} />
        </dl>
        {detail.notes ? <p className={styles.notes}>{detail.notes}</p> : null}
      </section>

      <section className={styles.detailSection}>
        <div className={styles.sectionTitle}>
          <h3>Примірники й розміщення</h3>
          <span>{detail.holdings.length}</span>
        </div>
        {detail.holdings.length ? (
          <div className={styles.holdingList}>
            {detail.holdings.map((holding) => (
              <article key={holdingKey(holding)}>
                <span aria-hidden="true">⌂</span>
                <div>
                  <strong>{holding.locationName}</strong>
                  <small>{conditionLabel(holding.condition)}</small>
                </div>
                <b>{holding.quantity}</b>
              </article>
            ))}
          </div>
        ) : (
          <p className={styles.mutedText}>Місця з ненульовим залишком відсутні.</p>
        )}
      </section>

      <section className={styles.detailSection}>
        <div className={styles.sectionTitle}>
          <h3>Посилання та електронні версії</h3>
          <span>{detail.links.length}</span>
        </div>
        {detail.links.length ? (
          <div className={styles.linkList}>
            {detail.links.map((link, index) => (
              <a
                key={link.id || `${link.url}-${index}`}
                href={link.url}
                target="_blank"
                rel="noreferrer"
              >
                <span aria-hidden="true">↗</span>
                <span>
                  <strong>{link.label || linkKindLabel(link.kind)}</strong>
                  <small>{linkKindLabel(link.kind)}</small>
                </span>
              </a>
            ))}
          </div>
        ) : (
          <p className={styles.mutedText}>Для цього матеріалу посилань ще немає.</p>
        )}
      </section>
    </div>
  );
}

type CoverSelection = {
  file: File;
  previewUrl: string;
  requestId: string;
  photoKey: string;
  retainForRetry: boolean;
};

type CoverUploadController = {
  file: File | null;
  previewUrl: string;
  normalizing: boolean;
  error: string;
  choose: (file: File | null) => Promise<void>;
  clear: () => void;
  promote: (materialId: string, expectedVersion: number) => Promise<void>;
};

function useDirectCoverUpload(): CoverUploadController {
  const [selection, setSelection] = useState<CoverSelection | null>(null);
  const [normalizing, setNormalizing] = useState(false);
  const [error, setError] = useState("");

  const previewUrl = selection?.previewUrl ?? "";
  const temporaryKey = selection?.photoKey ?? "";
  const retainForRetry = selection?.retainForRetry ?? false;
  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);
  useEffect(() => () => {
    if (temporaryKey && !retainForRetry) {
      void deleteTemporaryCover(temporaryKey);
    }
  }, [temporaryKey, retainForRetry]);

  function clear() {
    if (selection?.photoKey) void deleteTemporaryCover(selection.photoKey);
    setSelection(null);
    setError("");
  }

  async function choose(file: File | null) {
    if (!file) {
      clear();
      return;
    }
    setNormalizing(true);
    setError("");
    try {
      const normalized = await normalizeCoverPhotoForUpload(file);
      if (selection?.photoKey) void deleteTemporaryCover(selection.photoKey);
      setSelection({
        file: normalized,
        previewUrl: URL.createObjectURL(normalized),
        requestId: crypto.randomUUID(),
        photoKey: "",
        retainForRetry: false,
      });
    } catch (selectionError) {
      setError(errorMessage(selectionError));
    } finally {
      setNormalizing(false);
    }
  }

  async function promote(materialId: string, expectedVersion: number) {
    if (!selection) return;
    setError("");
    let active = selection;
    try {
      if (!active.photoKey) {
        const form = new FormData();
        form.set("photo", active.file, active.file.name);
        const uploaded = await apiJson<{
          success: true;
          photo: { key: string };
        }>("/api/librarian/cover-photo", {
          method: "POST",
          body: form,
        });
        active = {
          ...active,
          photoKey: uploaded.photo.key,
          retainForRetry: true,
        };
        setSelection(active);
      }
      const finalized = await apiJson<MutationEnvelope<{
        materialId: string;
        coverVersion: number;
        url: string;
      }> & { sourceCleanedUp?: boolean }>(`/api/librarian/materials/${encodeURIComponent(materialId)}/cover`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: active.requestId,
          coverPhotoKey: active.photoKey,
          expectedVersion,
        }),
      });
      if (!finalized.sourceCleanedUp) void deleteTemporaryCover(active.photoKey);
      setSelection(null);
    } catch (uploadError) {
      const message = errorMessage(uploadError);
      if (
        active.photoKey
        && uploadError instanceof ApiError
        && uploadError.status >= 400
        && uploadError.status < 500
      ) {
        void deleteTemporaryCover(active.photoKey);
        setSelection({
          ...active,
          photoKey: "",
          requestId: crypto.randomUUID(),
          retainForRetry: false,
        });
      } else if (active.photoKey) {
        setSelection({ ...active, retainForRetry: true });
      }
      setError(message);
      throw uploadError;
    }
  }

  return {
    file: selection?.file ?? null,
    previewUrl: selection?.previewUrl ?? "",
    normalizing,
    error,
    choose,
    clear,
    promote,
  };
}

function CoverPhotoField({
  upload,
  currentUrl,
  disabled,
}: {
  upload: CoverUploadController;
  currentUrl: string;
  disabled: boolean;
}) {
  const previewUrl = upload.previewUrl || currentUrl;
  return (
    <section className={styles.directCoverField} aria-busy={upload.normalizing}>
      <div className={styles.directCoverPreview}>
        {previewUrl ? <img src={previewUrl} alt="Попередній перегляд обкладинки" /> : <span aria-hidden="true">Б</span>}
      </div>
      <div className={styles.directCoverCopy}>
        <strong>{upload.file ? "Нова обкладинка готова" : currentUrl ? "Поточна обкладинка" : "Додати обкладинку"}</strong>
        <p>
          {upload.normalizing
            ? "Готуємо компактний JPEG…"
            : upload.file
              ? `${upload.file.name} · ${Math.ceil(upload.file.size / 1024)} КБ`
              : "JPG, PNG або WEBP. Браузер підготує JPEG до 600 × 900 пікселів."}
        </p>
        <div className={styles.directCoverActions}>
          <label className={styles.secondaryButton}>
            {upload.file || currentUrl ? "Обрати інше фото" : "Обрати фото"}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              capture="environment"
              disabled={disabled || upload.normalizing}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0] ?? null;
                event.currentTarget.value = "";
                void upload.choose(file);
              }}
            />
          </label>
          {upload.file ? <button type="button" className={styles.secondaryButton} disabled={disabled} onClick={upload.clear}>Прибрати нове фото</button> : null}
        </div>
      </div>
    </section>
  );
}

async function deleteTemporaryCover(key: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(
        `/api/librarian/cover-photo?key=${encodeURIComponent(key)}`,
        {
          method: "DELETE",
          credentials: "same-origin",
          headers: { accept: "application/json" },
          keepalive: true,
        },
      );
      if (response.ok || response.status === 404 || response.status === 409) return;
    } catch {
      // Retry a transient connection failure while the page is still alive.
    }
  }
}

function MaterialEditForm({
  detail,
  writesEnabled,
  onCancel,
  onCompleted,
  onPartialUnknown,
}: {
  detail: MaterialDetail;
  writesEnabled: boolean;
  onCancel: () => void;
  onCompleted: () => Promise<void>;
  onPartialUnknown: (message: string) => void;
}) {
  const [draft, setDraft] = useState<MaterialEditDraft>(() => materialToEditDraft(detail));
  const [links, setLinks] = useState<EditableLinkDraft[]>(() =>
    detail.links.map((link) => ({
      key: link.id || crypto.randomUUID(),
      id: link.id || null,
      kind: isLinkKind(link.kind) ? link.kind : "other",
      label: link.label,
      url: link.url,
      isPublic: link.isPublic ?? true,
    })),
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const coverUpload = useDirectCoverUpload();

  function update<K extends keyof MaterialEditDraft>(key: K, value: MaterialEditDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function applyBookCandidate(candidate: BookLookupCandidate) {
    setDraft((current) => mergeBookLookupDraft(current, candidate));
    setLinks((current) => mergeBookLookupLink(current, candidate));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!writesEnabled || typeof detail.version !== "number") return;
    setSaving(true);
    setMessage("");
    setFieldErrors({});
    let coverSaved = false;
    try {
      if (coverUpload.file) {
        await coverUpload.promote(detail.id, detail.cover?.version ?? 0);
        coverSaved = true;
      }
      await apiJson<MutationEnvelope<{ materialId: string; version: number }>>(
        `/api/librarian/materials/${encodeURIComponent(detail.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            expectedVersion: detail.version,
            changes: {
              ...editDraftToChanges(draft),
              links: linkPayload(links),
            },
          }),
        },
      );
      setMessage("Матеріал оновлено.");
      await onCompleted();
    } catch (error) {
      if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
      if (coverSaved) {
        onPartialUnknown(
          `Обкладинку збережено, але результат інших змін не вдалося підтвердити. Картку завантажуємо повторно; перевірте поля перед наступною дією: ${errorMessage(error)}`,
        );
      } else {
        setMessage(errorMessage(error));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className={styles.editForm} onSubmit={submit}>
      <div className={styles.formHeading}>
        <div>
          <p>{detail.id}</p>
          <h2>Редагування матеріалу</h2>
          <small>Зміни зберігаються одразу, без проміжної чернетки.</small>
        </div>
        <button type="button" onClick={onCancel}>×</button>
      </div>

      <div className={styles.formGrid}>
        <EditField label="Назва" required error={fieldError(fieldErrors, "title")} wide>
          <input value={draft.title} onChange={(event) => update("title", event.target.value)} required />
        </EditField>
        <EditField label="Автор" error={fieldError(fieldErrors, "author")} wide>
          <input value={draft.author} onChange={(event) => update("author", event.target.value)} />
        </EditField>
        <EditField label="Рубрика" required error={fieldError(fieldErrors, "rubric")}>
          <input value={draft.rubric} onChange={(event) => update("rubric", event.target.value)} required />
        </EditField>
        <EditField label="Тип видання" error={fieldError(fieldErrors, "publicationType")}>
          <input value={draft.publicationType} onChange={(event) => update("publicationType", event.target.value)} />
        </EditField>
        <EditField label="Предмет" error={fieldError(fieldErrors, "subject")}>
          <input value={draft.subject} onChange={(event) => update("subject", event.target.value)} />
        </EditField>
        <EditField label="Рік видання" error={fieldError(fieldErrors, "publicationYear")}>
          <input type="number" min="1000" max="2100" value={draft.publicationYear} onChange={(event) => update("publicationYear", event.target.value)} />
        </EditField>
        <EditField label="Клас від" error={fieldError(fieldErrors, "classFrom")}>
          <input type="number" min="1" max="12" value={draft.classFrom} onChange={(event) => update("classFrom", event.target.value)} />
        </EditField>
        <EditField label="Клас до" error={fieldError(fieldErrors, "classTo")}>
          <input type="number" min="1" max="12" value={draft.classTo} onChange={(event) => update("classTo", event.target.value)} />
        </EditField>
        <EditField label="ISBN" error={fieldError(fieldErrors, "isbn")}>
          <input value={draft.isbn} onChange={(event) => update("isbn", event.target.value)} />
        </EditField>
        <EditField label="Видавництво" error={fieldError(fieldErrors, "publisher")}>
          <input value={draft.publisher} onChange={(event) => update("publisher", event.target.value)} />
        </EditField>
        <div className={styles.fieldWide}>
          <IsbnLookupAssist isbn={draft.isbn} onApply={applyBookCandidate} disabled={saving} />
        </div>
        <EditField label="Примітка" error={fieldError(fieldErrors, "notes")} wide>
          <textarea rows={4} value={draft.notes} onChange={(event) => update("notes", event.target.value)} />
        </EditField>
        <div className={styles.fieldWide}>
          <CoverPhotoField
            upload={coverUpload}
            currentUrl={detail.cover?.url || detail.thumbnailUrl}
            disabled={!writesEnabled || saving}
          />
        </div>
        <div className={styles.fieldWide}>
          <LinkEditor
            links={links}
            onLinks={setLinks}
            error={fieldError(fieldErrors, "links")}
          />
        </div>
      </div>

      {message ? (
        <InlineMessage tone={message === "Матеріал оновлено." ? "success" : "error"}>
          {message}
        </InlineMessage>
      ) : null}
      {coverUpload.error ? <InlineMessage tone="error">{coverUpload.error}</InlineMessage> : null}

      <div className={styles.formActions}>
        <button className={styles.secondaryButton} type="button" onClick={onCancel}>Скасувати</button>
        <button
          className={styles.primaryButton}
          type="submit"
          disabled={saving || coverUpload.normalizing || !writesEnabled || typeof detail.version !== "number"}
        >
          {saving ? "Зберігаємо…" : "Зберегти зміни"}
        </button>
      </div>
    </form>
  );
}

function MaterialCreatePanel({
  writesEnabled,
  locations,
  referenceState,
  referenceError,
  onCreated,
  onOpenMaterial,
}: {
  writesEnabled: boolean;
  locations: LibraryLocation[];
  referenceState: LoadState;
  referenceError: string;
  onCreated: (materialId: string) => Promise<void>;
  onOpenMaterial: () => void;
}) {
  const [draft, setDraft] = useState<MaterialEditDraft>(emptyMaterialDraft);
  const [links, setLinks] = useState<EditableLinkDraft[]>([]);
  const [withReceipt, setWithReceipt] = useState(false);
  const countableLocations = locations.filter((location) => location.type !== "service");
  const [locationId, setLocationId] = useState("");
  const effectiveLocationId = locationId || countableLocations[0]?.id || "";
  const [condition, setCondition] = useState("good");
  const [quantity, setQuantity] = useState("1");
  const [occurredAt, setOccurredAt] = useState(() => todayInKyiv());
  const [documentNumber, setDocumentNumber] = useState("");
  const [receiptNotes, setReceiptNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [createdId, setCreatedId] = useState("");
  const coverUpload = useDirectCoverUpload();

  function update<K extends keyof MaterialEditDraft>(key: K, value: MaterialEditDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function applyBookCandidate(candidate: BookLookupCandidate) {
    setDraft((current) => mergeBookLookupDraft(current, candidate));
    setLinks((current) => mergeBookLookupLink(current, candidate));
  }

  function reset() {
    setDraft(emptyMaterialDraft());
    setLinks([]);
    setWithReceipt(false);
    setQuantity("1");
    setDocumentNumber("");
    setReceiptNotes("");
    setMessage("");
    setFieldErrors({});
    setCreatedId("");
    coverUpload.clear();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!writesEnabled || createdId) return;
    setSaving(true);
    setMessage("");
    setFieldErrors({});
    try {
      const values = editDraftToChanges(draft);
      const response = await apiJson<MutationEnvelope<{
        materialId: string;
        catalogNumber: number;
        version: number;
      }>>("/api/librarian/materials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          ...values,
          links: linkPayload(links),
          initialReceipt: withReceipt ? {
            locationId: effectiveLocationId,
            condition,
            quantity: Number(quantity),
            expectedQuantity: 0,
            occurredAt,
            documentNumber: documentNumber.trim() || null,
            notes: receiptNotes.trim() || null,
          } : null,
        }),
      });
      const materialId = response.result.materialId;
      setCreatedId(materialId);
      await onCreated(materialId);
      const hadCover = Boolean(coverUpload.file);
      if (hadCover) {
        try {
          await coverUpload.promote(materialId, 0);
        } catch (coverError) {
          setMessage(
            coverCleanupPending(coverError)
              ? `Матеріал ${materialId} створено, але стан обкладинки ще не вдалося підтвердити. Повторіть дію з тим самим фото: ${errorMessage(coverError)}`
              : `Матеріал ${materialId} створено, але обкладинку ще не додано: ${errorMessage(coverError)}`,
          );
          return;
        }
        await onCreated(materialId);
      }
      setMessage(`Матеріал ${materialId} створено${hadCover ? " з обкладинкою" : ""}.`);
    } catch (requestError) {
      if (requestError instanceof ApiError) setFieldErrors(requestError.fieldErrors);
      setMessage(errorMessage(requestError));
    } finally {
      setSaving(false);
    }
  }

  async function retryCreatedCover() {
    if (!createdId || !coverUpload.file || !writesEnabled) return;
    setSaving(true);
    setMessage("");
    try {
      await coverUpload.promote(createdId, 0);
      setMessage(`Обкладинку матеріалу ${createdId} додано.`);
      await onCreated(createdId);
    } catch (error) {
      setMessage(
        coverCleanupPending(error)
          ? `Матеріал ${createdId} уже створено, але стан обкладинки ще не вдалося підтвердити. Повторіть дію з тим самим фото: ${errorMessage(error)}`
          : `Матеріал ${createdId} уже створено, але обкладинку не додано: ${errorMessage(error)}`,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className={styles.createCard} onSubmit={submit}>
      <div className={styles.formHeading}>
        <div>
          <p>Автоматичний CAT-ID</p>
          <h2>Додати новий матеріал</h2>
          <small>CAT-ID створить база. Поля із зірочкою обов’язкові.</small>
        </div>
      </div>

      <div className={styles.formGrid}>
        <EditField label="Назва" required error={fieldError(fieldErrors, "title")} wide>
          <input value={draft.title} onChange={(event) => update("title", event.target.value)} required />
        </EditField>
        <EditField label="Автор" error={fieldError(fieldErrors, "author")} wide>
          <input value={draft.author} onChange={(event) => update("author", event.target.value)} />
        </EditField>
        <EditField label="Рубрика" required error={fieldError(fieldErrors, "rubric")}>
          <input value={draft.rubric} onChange={(event) => update("rubric", event.target.value)} required />
        </EditField>
        <EditField label="Тип видання" error={fieldError(fieldErrors, "publicationType")}>
          <input value={draft.publicationType} onChange={(event) => update("publicationType", event.target.value)} />
        </EditField>
        <EditField label="Предмет" error={fieldError(fieldErrors, "subject")}>
          <input value={draft.subject} onChange={(event) => update("subject", event.target.value)} />
        </EditField>
        <EditField label="Рік видання" error={fieldError(fieldErrors, "publicationYear")}>
          <input type="number" min="1000" max="2100" value={draft.publicationYear} onChange={(event) => update("publicationYear", event.target.value)} />
        </EditField>
        <EditField label="Клас від" error={fieldError(fieldErrors, "classFrom")}>
          <input type="number" min="1" max="12" value={draft.classFrom} onChange={(event) => update("classFrom", event.target.value)} />
        </EditField>
        <EditField label="Клас до" error={fieldError(fieldErrors, "classTo")}>
          <input type="number" min="1" max="12" value={draft.classTo} onChange={(event) => update("classTo", event.target.value)} />
        </EditField>
        <EditField label="ISBN" error={fieldError(fieldErrors, "isbn")}>
          <input value={draft.isbn} onChange={(event) => update("isbn", event.target.value)} inputMode="numeric" />
        </EditField>
        <EditField label="Видавництво" error={fieldError(fieldErrors, "publisher")}>
          <input value={draft.publisher} onChange={(event) => update("publisher", event.target.value)} />
        </EditField>
        <div className={styles.fieldWide}>
          <IsbnLookupAssist isbn={draft.isbn} onApply={applyBookCandidate} disabled={saving || Boolean(createdId)} />
        </div>
        <EditField label="Примітка" error={fieldError(fieldErrors, "notes")} wide>
          <textarea rows={3} value={draft.notes} onChange={(event) => update("notes", event.target.value)} />
        </EditField>
        <div className={styles.fieldWide}>
          <LinkEditor links={links} onLinks={setLinks} error={fieldError(fieldErrors, "links")} />
        </div>
      </div>

      <CoverPhotoField
        upload={coverUpload}
        currentUrl=""
        disabled={!writesEnabled || saving || Boolean(createdId)}
      />
      {coverUpload.error ? <InlineMessage tone="error">{coverUpload.error}</InlineMessage> : null}

      <label className={styles.receiptToggle}>
        <input
          type="checkbox"
          aria-label="Одразу зареєструвати початкове надходження"
          checked={withReceipt}
          disabled={referenceState !== "ready" || !countableLocations.length}
          onChange={(event) => setWithReceipt(event.target.checked)}
        />
        <span>
          <strong>Одразу зареєструвати початкове надходження</strong>
          <small>Новий матеріал і перші примірники збережуться однією операцією.</small>
        </span>
      </label>

      {referenceState === "error" ? <InlineMessage tone="info">{referenceError} Матеріал можна створити без початкового надходження.</InlineMessage> : null}

      {withReceipt ? (
        <div className={styles.embeddedReceipt}>
          <div className={styles.formGrid}>
            <EditField label="Місце" required wide>
              <select value={effectiveLocationId} onChange={(event) => setLocationId(event.target.value)} required>
                {countableLocations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
              </select>
            </EditField>
            <EditField label="Стан" required>
              <ConditionSelect value={condition} onValue={setCondition} />
            </EditField>
            <EditField label="Кількість" required error={fieldErrors["initialReceipt.quantity"]}>
              <input type="number" min="1" max="1000000" value={quantity} onChange={(event) => setQuantity(event.target.value)} required />
            </EditField>
            <EditField label="Дата" required>
              <input type="date" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} required />
            </EditField>
            <EditField label="Документ">
              <input value={documentNumber} onChange={(event) => setDocumentNumber(event.target.value)} placeholder="Накладна, акт…" />
            </EditField>
            <EditField label="Примітка до надходження" wide>
              <textarea rows={2} value={receiptNotes} onChange={(event) => setReceiptNotes(event.target.value)} />
            </EditField>
          </div>
        </div>
      ) : null}

      {message ? <InlineMessage tone={createdId && !coverUpload.file ? "success" : "error"}>{message}</InlineMessage> : null}

      <div className={styles.formActions}>
        {createdId ? (
          <>
            <button className={styles.secondaryButton} type="button" onClick={reset}>Додати ще один</button>
            {coverUpload.file ? (
              <button className={styles.secondaryButton} type="button" disabled={saving} onClick={() => void retryCreatedCover()}>
                Повторити обкладинку
              </button>
            ) : null}
            <button className={styles.secondaryButton} type="button" onClick={onOpenMaterial}>Відкрити картку</button>
          </>
        ) : <span>Збереження відбувається напряму в D1, без чернетки.</span>}
        <button className={styles.primaryButton} type="submit" disabled={!writesEnabled || saving || coverUpload.normalizing || Boolean(createdId)}>
          {saving ? "Створюємо…" : "Створити матеріал"}
        </button>
      </div>
    </form>
  );
}

function ReceiptPanel({
  detail,
  state,
  error,
  writesEnabled,
  locations,
  referenceState,
  referenceError,
  onSaved,
}: {
  detail: MaterialDetail | null;
  state: LoadState;
  error: string;
  writesEnabled: boolean;
  locations: LibraryLocation[];
  referenceState: LoadState;
  referenceError: string;
  onSaved: () => Promise<void>;
}) {
  if (state === "idle") return <ChooseMaterial />;
  if (state === "loading" || referenceState === "loading") return <PanelLoading />;
  if (state === "error" || !detail) return <InlineMessage tone="error">{error}</InlineMessage>;
  if (referenceState === "error") return <InlineMessage tone="error">{referenceError}</InlineMessage>;
  return (
    <ReceiptForm
      key={detail.id}
      detail={detail}
      writesEnabled={writesEnabled}
      locations={locations.filter((location) => location.type !== "service")}
      onSaved={onSaved}
    />
  );
}

function ReceiptForm({
  detail,
  writesEnabled,
  locations,
  onSaved,
}: {
  detail: MaterialDetail;
  writesEnabled: boolean;
  locations: LibraryLocation[];
  onSaved: () => Promise<void>;
}) {
  const [locationId, setLocationId] = useState(locations[0]?.id || "");
  const effectiveLocationId = locationId || locations[0]?.id || "";
  const [condition, setCondition] = useState("good");
  const holding = detail.holdings.find(
    (item) => item.locationId === effectiveLocationId && (item.condition || "unspecified") === condition,
  );
  const expectedQuantity = holding?.quantity ?? 0;
  const [quantity, setQuantity] = useState("1");
  const [occurredAt, setOccurredAt] = useState(() => todayInKyiv());
  const [documentNumber, setDocumentNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!writesEnabled || !effectiveLocationId) return;
    setSaving(true);
    setSuccess(false);
    setMessage("");
    try {
      const response = await apiJson<MutationEnvelope<{ quantityAfter: number }>>(
        "/api/librarian/receipts",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            materialId: detail.id,
            locationId: effectiveLocationId,
            condition,
            quantity: Number(quantity),
            expectedQuantity,
            occurredAt,
            documentNumber: documentNumber.trim() || null,
            notes: notes.trim() || null,
          }),
        },
      );
      setSuccess(true);
      setMessage(`Надходження збережено. Новий залишок: ${response.result.quantityAfter}.`);
      await onSaved();
    } catch (requestError) {
      setMessage(errorMessage(requestError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className={styles.receiptCard} onSubmit={submit}>
      <div className={styles.formHeading}>
        <div>
          <p>{detail.id}</p>
          <h2>Зареєструвати надходження</h2>
          <small>{detail.title}</small>
        </div>
      </div>
      <div className={styles.selectedSummary}>
        <Cover material={detail} />
        <div>
          <strong>{detail.title}</strong>
          <small>У фонді зараз {detail.totalQuantity}, доступно {detail.availableQuantity}.</small>
        </div>
      </div>

      {locations.length ? (
        <div className={styles.formGrid}>
          <EditField label="Місце надходження" required wide>
            <select value={effectiveLocationId} onChange={(event) => setLocationId(event.target.value)} required>
              {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
            </select>
          </EditField>
          <EditField label="Стан" required>
            <ConditionSelect value={condition} onValue={setCondition} />
          </EditField>
          <EditField label="Поточний залишок">
            <input value={expectedQuantity} readOnly />
          </EditField>
          <EditField label="Надійшло примірників" required>
            <input type="number" min="1" max="1000000" value={quantity} onChange={(event) => setQuantity(event.target.value)} required />
          </EditField>
          <EditField label="Дата" required>
            <input type="date" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} required />
          </EditField>
          <EditField label="Документ">
            <input value={documentNumber} onChange={(event) => setDocumentNumber(event.target.value)} placeholder="Номер накладної або акта" />
          </EditField>
          <EditField label="Примітка" wide>
            <textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />
          </EditField>
        </div>
      ) : <InlineMessage tone="info">У новій базі немає активного місця для надходження.</InlineMessage>}

      {message ? <InlineMessage tone={success ? "success" : "error"}>{message}</InlineMessage> : null}
      <div className={styles.formActions}>
        <span>Залишок і журнал надходжень оновляться однією операцією.</span>
        <button className={styles.primaryButton} type="submit" disabled={!writesEnabled || !effectiveLocationId || saving || !quantity}>
          {saving ? "Зберігаємо…" : "Зареєструвати надходження"}
        </button>
      </div>
    </form>
  );
}

function TransferPanel({
  detail,
  state,
  error,
  writesEnabled,
  locations,
  referenceState,
  referenceError,
  onSaved,
}: {
  detail: MaterialDetail | null;
  state: LoadState;
  error: string;
  writesEnabled: boolean;
  locations: LibraryLocation[];
  referenceState: LoadState;
  referenceError: string;
  onSaved: () => Promise<void>;
}) {
  if (state === "idle") return <ChooseMaterial />;
  if (state === "loading" || referenceState === "loading") return <PanelLoading />;
  if (state === "error" || !detail) return <InlineMessage tone="error">{error}</InlineMessage>;
  if (referenceState === "error") return <InlineMessage tone="error">{referenceError}</InlineMessage>;
  return (
    <TransferForm
      key={detail.id}
      detail={detail}
      writesEnabled={writesEnabled}
      locations={locations.filter((location) => location.type !== "service")}
      onSaved={onSaved}
    />
  );
}

function TransferForm({
  detail,
  writesEnabled,
  locations,
  onSaved,
}: {
  detail: MaterialDetail;
  writesEnabled: boolean;
  locations: LibraryLocation[];
  onSaved: () => Promise<void>;
}) {
  const initialIntent = useMemo(
    () => readPendingInventoryIntent("transfer", detail.id),
    [detail.id],
  );
  const initialPayload = initialIntent?.payload ?? {};
  const availableHoldings = detail.holdings.filter(
    (holding) =>
      holding.locationStatus === "active"
      && holding.locationType !== "service"
      && holding.quantity > 0,
  );
  const [sourceKey, setSourceKey] = useState(
    () => {
      const restored = availableHoldings.find(
        (holding) =>
          holding.locationId === initialPayload.sourceLocationId
          && (holding.condition || "unspecified") === initialPayload.condition,
      );
      return restored ? holdingKey(restored) : availableHoldings[0] ? holdingKey(availableHoldings[0]) : "";
    },
  );
  const source = availableHoldings.find((holding) => holdingKey(holding) === sourceKey) ?? null;
  const destinationLocations = locations.filter((location) => location.id !== source?.locationId);
  const [destinationLocationId, setDestinationLocationId] = useState(
    typeof initialPayload.destinationLocationId === "string" ? initialPayload.destinationLocationId : "",
  );
  const effectiveDestinationId = destinationLocations.some(
    (location) => location.id === destinationLocationId,
  ) ? destinationLocationId : destinationLocations[0]?.id || "";
  const destinationHolding = source
    ? detail.holdings.find(
      (holding) =>
        holding.locationId === effectiveDestinationId
        && (holding.condition || "unspecified") === (source.condition || "unspecified"),
    )
    : null;
  const [quantity, setQuantity] = useState(() => String(initialPayload.quantity ?? 1));
  const [occurredAt, setOccurredAt] = useState(
    typeof initialPayload.occurredAt === "string" ? initialPayload.occurredAt : todayInKyiv(),
  );
  const [documentNumber, setDocumentNumber] = useState(
    typeof initialPayload.documentNumber === "string" ? initialPayload.documentNumber : "",
  );
  const [notes, setNotes] = useState(
    typeof initialPayload.notes === "string" ? initialPayload.notes : "",
  );
  const [requestId, setRequestId] = useState(() => initialIntent?.requestId || crypto.randomUUID());
  const [pendingIntent, setPendingIntent] = useState(initialIntent);
  const [retryPending, setRetryPending] = useState(Boolean(initialIntent));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(
    initialIntent ? "Результат попереднього переміщення не підтверджено. Повторіть перевірку з тим самим номером операції." : "",
  );
  const [success, setSuccess] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function renewRequest() {
    if (retryPending) return;
    setRequestId(crypto.randomUUID());
    setMessage("");
    setSuccess(false);
  }

  function chooseSource(value: string) {
    setSourceKey(value);
    const nextSource = availableHoldings.find((holding) => holdingKey(holding) === value);
    if (nextSource?.locationId === destinationLocationId) setDestinationLocationId("");
    setQuantity("1");
    renewRequest();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!writesEnabled || (!retryPending && (!source || !effectiveDestinationId))) return;
    setSaving(true);
    setSuccess(false);
    setMessage("");
    setFieldErrors({});
    const payload = retryPending && pendingIntent
      ? pendingIntent.payload
      : {
        requestId,
        materialId: detail.id,
        sourceLocationId: source?.locationId,
        destinationLocationId: effectiveDestinationId,
        condition: source?.condition || "unspecified",
        quantity: Number(quantity),
        expectedSourceQuantity: source?.quantity,
        expectedDestinationQuantity: destinationHolding?.quantity ?? 0,
        occurredAt,
        documentNumber: documentNumber.trim() || null,
        notes: notes.trim() || null,
      };
    const intent = { kind: "transfer" as const, materialId: detail.id, requestId, payload };
    if (!writePendingInventoryIntent(intent)) {
      setMessage("Браузер не дозволив безпечно зберегти номер операції. Запис не виконувався; звільніть місце у сховищі вкладки й повторіть.");
      setSaving(false);
      return;
    }
    setPendingIntent(intent);
    try {
      const response = await apiJson<MutationEnvelope<{
        quantityMoved: number;
        sourceQuantityAfter: number;
        destinationQuantityAfter: number;
      }>>("/api/librarian/transfers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      clearPendingInventoryIntent("transfer", detail.id);
      setPendingIntent(null);
      setRetryPending(false);
      setSuccess(true);
      setMessage(
        `Переміщено ${response.result.quantityMoved}. Залишок: ${response.result.sourceQuantityAfter} → ${response.result.destinationQuantityAfter}.`,
      );
      setRequestId(crypto.randomUUID());
      await onSaved();
    } catch (requestError) {
      if (requestError instanceof ApiError) setFieldErrors(requestError.fieldErrors);
      if (isDefinitiveInventoryFailure(requestError)) {
        clearPendingInventoryIntent("transfer", detail.id);
        setPendingIntent(null);
        setRetryPending(false);
        setRequestId(crypto.randomUUID());
        if (requestError instanceof ApiError && requestError.code === "stock_quantity_conflict") {
          setMessage("Залишок уже змінився. Картку оновлено — перевірте кількість і повторіть дію.");
          await onSaved();
        } else {
          setMessage(errorMessage(requestError));
        }
      } else {
        setRetryPending(true);
        setMessage(`Результат переміщення не підтверджено. Не створюйте нову операцію — повторіть цю перевірку: ${errorMessage(requestError)}`);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className={styles.receiptCard} onSubmit={submit} aria-busy={saving}>
      <div className={styles.formHeading}>
        <div>
          <p>{detail.id}</p>
          <h2>Перемістити примірники</h2>
          <small>{detail.title}</small>
        </div>
      </div>
      <div className={styles.selectedSummary}>
        <Cover material={detail} />
        <div>
          <strong>{detail.title}</strong>
          <small>Одна операція одночасно зменшить залишок у джерелі та збільшить у новому місці.</small>
        </div>
      </div>

      {availableHoldings.length && destinationLocations.length ? (
        <div className={styles.formGrid}>
          <EditField label="Звідки" required wide error={fieldErrors.sourceLocationId}>
            <select value={sourceKey} onChange={(event) => chooseSource(event.target.value)} disabled={retryPending} required aria-invalid={Boolean(fieldErrors.sourceLocationId)}>
              {availableHoldings.map((holding) => (
                <option key={holdingKey(holding)} value={holdingKey(holding)}>
                  {holding.locationName} · {conditionLabel(holding.condition)} · {holding.quantity}
                </option>
              ))}
            </select>
          </EditField>
          <EditField label="Куди" required wide error={fieldErrors.destinationLocationId}>
            <select
              value={effectiveDestinationId}
              onChange={(event) => {
                setDestinationLocationId(event.target.value);
                renewRequest();
              }}
              disabled={retryPending}
              required
              aria-invalid={Boolean(fieldErrors.destinationLocationId)}
            >
              {destinationLocations.map((location) => (
                <option key={location.id} value={location.id}>{location.name}</option>
              ))}
            </select>
          </EditField>
          <EditField label="Стан примірників" error={fieldErrors.condition}>
            <input value={conditionLabel(source?.condition ?? null)} readOnly />
          </EditField>
          <EditField label="У джерелі зараз">
            <input value={source?.quantity ?? 0} readOnly />
          </EditField>
          <EditField label="У місці призначення зараз">
            <input value={destinationHolding?.quantity ?? 0} readOnly />
          </EditField>
          <EditField label="Перемістити" required error={fieldErrors.quantity}>
            <input
              type="number"
              min="1"
              max={source?.quantity ?? 1}
              value={quantity}
              onChange={(event) => {
                setQuantity(event.target.value);
                renewRequest();
              }}
              disabled={retryPending}
              required
              aria-invalid={Boolean(fieldErrors.quantity)}
            />
          </EditField>
          <EditField label="Дата" required error={fieldErrors.occurredAt}>
            <input
              type="date"
              value={occurredAt}
              onChange={(event) => {
                setOccurredAt(event.target.value);
                renewRequest();
              }}
              disabled={retryPending}
              required
              aria-invalid={Boolean(fieldErrors.occurredAt)}
            />
          </EditField>
          <EditField label="Документ" error={fieldErrors.documentNumber}>
            <input
              value={documentNumber}
              onChange={(event) => {
                setDocumentNumber(event.target.value);
                renewRequest();
              }}
              placeholder="Номер акта або накладної"
              maxLength={160}
              disabled={retryPending}
              aria-invalid={Boolean(fieldErrors.documentNumber)}
            />
          </EditField>
          <EditField label="Примітка" wide error={fieldErrors.notes}>
            <textarea
              rows={3}
              maxLength={2000}
              value={notes}
              disabled={retryPending}
              aria-invalid={Boolean(fieldErrors.notes)}
              onChange={(event) => {
                setNotes(event.target.value);
                renewRequest();
              }}
            />
          </EditField>
        </div>
      ) : (
        <InlineMessage tone="info">
          Потрібні ненульовий залишок і щонайменше два активні місця зберігання.
        </InlineMessage>
      )}

      {message ? <InlineMessage tone={success ? "success" : "error"}>{message}</InlineMessage> : null}
      <div className={styles.formActions}>
        <span>Повтор після втрати зв’язку не створить другу операцію.</span>
        <button
          className={styles.primaryButton}
          type="submit"
          disabled={!writesEnabled || (!retryPending && (!source || !effectiveDestinationId || !quantity)) || saving}
        >
          {saving ? "Перевіряємо…" : retryPending ? "Перевірити результат" : "Перемістити примірники"}
        </button>
      </div>
    </form>
  );
}

function WriteoffPanel({
  detail,
  state,
  error,
  writesEnabled,
  locations,
  referenceState,
  referenceError,
  onSaved,
}: {
  detail: MaterialDetail | null;
  state: LoadState;
  error: string;
  writesEnabled: boolean;
  locations: LibraryLocation[];
  referenceState: LoadState;
  referenceError: string;
  onSaved: () => Promise<void>;
}) {
  if (state === "idle") return <ChooseMaterial />;
  if (state === "loading" || referenceState === "loading") return <PanelLoading />;
  if (state === "error" || !detail) return <InlineMessage tone="error">{error}</InlineMessage>;
  if (referenceState === "error") return <InlineMessage tone="error">{referenceError}</InlineMessage>;
  return (
    <WriteoffForm
      key={detail.id}
      detail={detail}
      writesEnabled={writesEnabled}
      locations={locations.filter((location) => location.type !== "service")}
      onSaved={onSaved}
    />
  );
}

function WriteoffForm({
  detail,
  writesEnabled,
  locations,
  onSaved,
}: {
  detail: MaterialDetail;
  writesEnabled: boolean;
  locations: LibraryLocation[];
  onSaved: () => Promise<void>;
}) {
  const initialIntent = useMemo(
    () => readPendingInventoryIntent("writeoff", detail.id),
    [detail.id],
  );
  const initialPayload = initialIntent?.payload ?? {};
  const locationIds = new Set(locations.map((location) => location.id));
  const availableHoldings = detail.holdings.filter(
    (holding) =>
      holding.locationStatus === "active"
      && holding.locationType !== "service"
      && locationIds.has(holding.locationId)
      && holding.quantity > 0,
  );
  const [sourceKey, setSourceKey] = useState(
    () => {
      const restored = availableHoldings.find(
        (holding) =>
          holding.locationId === initialPayload.locationId
          && (holding.condition || "unspecified") === initialPayload.condition,
      );
      return restored ? holdingKey(restored) : availableHoldings[0] ? holdingKey(availableHoldings[0]) : "";
    },
  );
  const source = availableHoldings.find((holding) => holdingKey(holding) === sourceKey) ?? null;
  const [quantity, setQuantity] = useState(() => String(initialPayload.quantity ?? 1));
  const [reason, setReason] = useState(
    typeof initialPayload.reason === "string" ? initialPayload.reason : "damaged",
  );
  const [occurredAt, setOccurredAt] = useState(
    typeof initialPayload.occurredAt === "string" ? initialPayload.occurredAt : todayInKyiv(),
  );
  const [documentNumber, setDocumentNumber] = useState(
    typeof initialPayload.documentNumber === "string" ? initialPayload.documentNumber : "",
  );
  const [notes, setNotes] = useState(
    typeof initialPayload.notes === "string" ? initialPayload.notes : "",
  );
  const [requestId, setRequestId] = useState(() => initialIntent?.requestId || crypto.randomUUID());
  const [pendingIntent, setPendingIntent] = useState(initialIntent);
  const [retryPending, setRetryPending] = useState(Boolean(initialIntent));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(
    initialIntent ? "Результат попереднього списання не підтверджено. Повторіть перевірку з тим самим номером операції." : "",
  );
  const [success, setSuccess] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function renewRequest() {
    if (retryPending) return;
    setRequestId(crypto.randomUUID());
    setMessage("");
    setSuccess(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!writesEnabled || (!retryPending && !source)) return;
    const amount = Number(quantity);
    const confirmed = retryPending || window.confirm(
      `Списати ${amount} прим. «${detail.title}» з місця «${source.locationName}»? Залишок зменшиться одразу.`,
    );
    if (!confirmed) return;
    setSaving(true);
    setSuccess(false);
    setMessage("");
    setFieldErrors({});
    const payload = retryPending && pendingIntent
      ? pendingIntent.payload
      : {
        requestId,
        materialId: detail.id,
        locationId: source?.locationId,
        condition: source?.condition || "unspecified",
        quantity: amount,
        expectedQuantity: source?.quantity,
        reason,
        occurredAt,
        documentNumber: documentNumber.trim() || null,
        notes: notes.trim() || null,
      };
    const intent = { kind: "writeoff" as const, materialId: detail.id, requestId, payload };
    if (!writePendingInventoryIntent(intent)) {
      setMessage("Браузер не дозволив безпечно зберегти номер операції. Списання не виконувалося; звільніть місце у сховищі вкладки й повторіть.");
      setSaving(false);
      return;
    }
    setPendingIntent(intent);
    try {
      const response = await apiJson<MutationEnvelope<{
        quantityWrittenOff: number;
        quantityAfter: number;
      }>>("/api/librarian/writeoffs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      clearPendingInventoryIntent("writeoff", detail.id);
      setPendingIntent(null);
      setRetryPending(false);
      setSuccess(true);
      setMessage(
        `Списано ${response.result.quantityWrittenOff}. Новий залишок у вибраному місці: ${response.result.quantityAfter}.`,
      );
      setRequestId(crypto.randomUUID());
      await onSaved();
    } catch (requestError) {
      if (requestError instanceof ApiError) setFieldErrors(requestError.fieldErrors);
      if (isDefinitiveInventoryFailure(requestError)) {
        clearPendingInventoryIntent("writeoff", detail.id);
        setPendingIntent(null);
        setRetryPending(false);
        setRequestId(crypto.randomUUID());
        if (requestError instanceof ApiError && requestError.code === "stock_quantity_conflict") {
          setMessage("Залишок уже змінився. Картку оновлено — перевірте кількість і повторіть дію.");
          await onSaved();
        } else {
          setMessage(errorMessage(requestError));
        }
      } else {
        setRetryPending(true);
        setMessage(`Результат списання не підтверджено. Не створюйте нову операцію — повторіть цю перевірку: ${errorMessage(requestError)}`);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className={styles.receiptCard} onSubmit={submit} aria-busy={saving}>
      <div className={styles.formHeading}>
        <div>
          <p>{detail.id}</p>
          <h2>Списати примірники</h2>
          <small>{detail.title}</small>
        </div>
      </div>
      <div className={styles.selectedSummary}>
        <Cover material={detail} />
        <div>
          <strong>{detail.title}</strong>
          <small>Списання зменшує фактичний фонд і залишається в незмінному журналі операцій.</small>
        </div>
      </div>

      {availableHoldings.length ? (
        <div className={styles.formGrid}>
          <EditField label="Звідки списати" required wide error={fieldErrors.locationId}>
            <select
              value={sourceKey}
              disabled={retryPending}
              aria-invalid={Boolean(fieldErrors.locationId)}
              onChange={(event) => {
                setSourceKey(event.target.value);
                setQuantity("1");
                renewRequest();
              }}
              required
            >
              {availableHoldings.map((holding) => (
                <option key={holdingKey(holding)} value={holdingKey(holding)}>
                  {holding.locationName} · {conditionLabel(holding.condition)} · {holding.quantity}
                </option>
              ))}
            </select>
          </EditField>
          <EditField label="Поточний залишок">
            <input value={source?.quantity ?? 0} readOnly />
          </EditField>
          <EditField label="Списати" required error={fieldErrors.quantity}>
            <input
              type="number"
              min="1"
              max={source?.quantity ?? 1}
              value={quantity}
              disabled={retryPending}
              aria-invalid={Boolean(fieldErrors.quantity)}
              onChange={(event) => {
                setQuantity(event.target.value);
                renewRequest();
              }}
              required
            />
          </EditField>
          <EditField label="Причина" required error={fieldErrors.reason}>
            <select
              value={reason}
              disabled={retryPending}
              aria-invalid={Boolean(fieldErrors.reason)}
              onChange={(event) => {
                setReason(event.target.value);
                renewRequest();
              }}
            >
              <option value="worn">Зношено</option>
              <option value="damaged">Пошкоджено</option>
              <option value="lost">Втрачено</option>
              <option value="obsolete">Застаріло</option>
              <option value="inventory_shortage">Нестача за підрахунком</option>
              <option value="other">Інша причина</option>
            </select>
          </EditField>
          <EditField label="Дата" required error={fieldErrors.occurredAt}>
            <input
              type="date"
              value={occurredAt}
              disabled={retryPending}
              aria-invalid={Boolean(fieldErrors.occurredAt)}
              onChange={(event) => {
                setOccurredAt(event.target.value);
                renewRequest();
              }}
              required
            />
          </EditField>
          <EditField label="Документ" error={fieldErrors.documentNumber}>
            <input
              value={documentNumber}
              onChange={(event) => {
                setDocumentNumber(event.target.value);
                renewRequest();
              }}
              placeholder="Номер акта"
              maxLength={160}
              disabled={retryPending}
              aria-invalid={Boolean(fieldErrors.documentNumber)}
            />
          </EditField>
          <EditField label="Примітка" wide error={fieldErrors.notes}>
            <textarea
              rows={3}
              maxLength={2000}
              value={notes}
              disabled={retryPending}
              aria-invalid={Boolean(fieldErrors.notes)}
              onChange={(event) => {
                setNotes(event.target.value);
                renewRequest();
              }}
              required={reason === "other"}
              placeholder={reason === "other" ? "Опишіть іншу причину" : "За потреби"}
            />
          </EditField>
        </div>
      ) : (
        <InlineMessage tone="info">Для матеріалу немає ненульового залишку, який можна списати.</InlineMessage>
      )}

      {message ? <InlineMessage tone={success ? "success" : "error"}>{message}</InlineMessage> : null}
      <div className={styles.formActions}>
        <span>Перед записом система ще раз перевірить актуальний залишок.</span>
        <button
          className={styles.primaryButton}
          type="submit"
          disabled={!writesEnabled || (!retryPending && (!source || !quantity)) || saving}
        >
          {saving ? "Перевіряємо…" : retryPending ? "Перевірити результат" : "Списати примірники"}
        </button>
      </div>
    </form>
  );
}

function StockCountPanel({
  detail,
  state,
  error,
  writesEnabled,
  locations,
  onSaved,
}: {
  detail: MaterialDetail | null;
  state: LoadState;
  error: string;
  writesEnabled: boolean;
  locations: LibraryLocation[];
  onSaved: () => Promise<void>;
}) {
  if (state === "idle") return <ChooseMaterial />;
  if (state === "loading") return <PanelLoading />;
  if (state === "error" || !detail) return <InlineMessage tone="error">{error}</InlineMessage>;
  return (
    <StockCountForm
      key={detail.id}
      detail={detail}
      writesEnabled={writesEnabled}
      locations={locations}
      onSaved={onSaved}
    />
  );
}

function StockCountForm({
  detail,
  writesEnabled,
  locations,
  onSaved,
}: {
  detail: MaterialDetail;
  writesEnabled: boolean;
  locations: LibraryLocation[];
  onSaved: () => Promise<void>;
}) {
  const holdings = useMemo(
    () => detail.holdings.filter((holding) => holding.locationStatus === "active" && holding.locationType !== "service"),
    [detail.holdings],
  );
  const countableLocations = useMemo(() => {
    const byId = new Map<string, LibraryLocation>();
    locations.filter((location) => location.type !== "service").forEach((location) => byId.set(location.id, location));
    holdings.forEach((holding) => {
      if (!byId.has(holding.locationId)) {
        byId.set(holding.locationId, {
          id: holding.locationId,
          name: holding.locationName,
          type: holding.locationType,
          isPublic: true,
        });
      }
    });
    return [...byId.values()];
  }, [holdings, locations]);
  const initialHolding = holdings[0] ?? null;
  const [locationId, setLocationId] = useState(() => initialHolding?.locationId || countableLocations[0]?.id || "");
  const effectiveLocationId = locationId || countableLocations[0]?.id || "";
  const [condition, setCondition] = useState(() => initialHolding?.condition || "unspecified");
  const selected = holdings.find((holding) => holding.locationId === effectiveLocationId && (holding.condition || "unspecified") === condition) ?? null;
  const expectedQuantity = selected?.quantity ?? 0;
  const [countedQuantity, setCountedQuantity] = useState(() => String(expectedQuantity));
  const [reason, setReason] = useState("inventory_count");
  const [occurredAt, setOccurredAt] = useState(() => todayInKyiv());
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);

  function chooseLocation(value: string) {
    setLocationId(value);
    const next = holdings.find((holding) => holding.locationId === value);
    const nextCondition = next?.condition || "unspecified";
    setCondition(nextCondition);
    setCountedQuantity(String(next?.quantity ?? 0));
    setMessage("");
  }

  function chooseCondition(value: string) {
    setCondition(value);
    const next = holdings.find((holding) => holding.locationId === effectiveLocationId && (holding.condition || "unspecified") === value);
    setCountedQuantity(String(next?.quantity ?? 0));
    setMessage("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!effectiveLocationId || !writesEnabled) return;
    setSaving(true);
    setMessage("");
    setSuccess(false);
    try {
      const response = await apiJson<MutationEnvelope<{ quantityDelta: number; countedQuantity: number }>>(
        "/api/librarian/stock-adjustments",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            materialId: detail.id,
            locationId: effectiveLocationId,
            condition,
            expectedQuantity,
            countedQuantity: Number(countedQuantity),
            reason,
            occurredAt,
            notes: notes.trim() || null,
          }),
        },
      );
      const delta = response.result.quantityDelta;
      setSuccess(true);
      setMessage(
        delta === 0
          ? "Кількість підтверджено без змін."
          : `Фактичну кількість збережено (${delta > 0 ? "+" : ""}${delta}).`,
      );
      await onSaved();
    } catch (requestError) {
      setMessage(errorMessage(requestError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className={styles.countCard} onSubmit={submit}>
      <div className={styles.formHeading}>
        <div>
          <p>{detail.id}</p>
          <h2>Встановити фактичну кількість</h2>
          <small>{detail.title}</small>
        </div>
      </div>

      <div className={styles.selectedSummary}>
        <Cover material={detail} />
        <div>
          <strong>{detail.title}</strong>
          <small>Система перевірить, чи залишок не змінився під час підрахунку.</small>
        </div>
      </div>

      {countableLocations.length ? (
        <div className={styles.formGrid}>
          <EditField label="Розміщення" required wide>
            <select value={effectiveLocationId} onChange={(event) => chooseLocation(event.target.value)}>
              {countableLocations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </EditField>
          <EditField label="Стан примірників" required>
            <select value={condition} onChange={(event) => chooseCondition(event.target.value)}>
              <option value="unspecified">Стан не уточнено</option>
              <option value="good">Добрий стан</option>
              <option value="worn">Зношені</option>
              <option value="damaged">Пошкоджені</option>
            </select>
          </EditField>
          <EditField label="Кількість у базі">
            <input value={expectedQuantity} readOnly />
          </EditField>
          <EditField label="Пораховано фактично" required>
            <input
              type="number"
              min="0"
              max="1000000"
              value={countedQuantity}
              onChange={(event) => setCountedQuantity(event.target.value)}
              required
            />
          </EditField>
          <EditField label="Причина" required>
            <select value={reason} onChange={(event) => setReason(event.target.value)}>
              <option value="inventory_count">Фактичний підрахунок</option>
              <option value="error_correction">Виправлення помилки</option>
              <option value="other">Інша причина</option>
            </select>
          </EditField>
          <EditField label="Дата" required>
            <input type="date" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} required />
          </EditField>
          <EditField label="Примітка" wide>
            <textarea
              rows={3}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              required={reason === "other"}
              placeholder={reason === "other" ? "Опишіть причину" : "За потреби"}
            />
          </EditField>
        </div>
      ) : (
        <InlineMessage tone="info">
          Для матеріалу немає активного місця зберігання. Нове місце можна буде обрати після підключення довідника D1.
        </InlineMessage>
      )}

      {message ? <InlineMessage tone={success ? "success" : "error"}>{message}</InlineMessage> : null}

      <div className={styles.formActions}>
        <span>Ця дія одразу оновить залишок та журнал операцій.</span>
        <button
          className={styles.primaryButton}
          type="submit"
          disabled={!effectiveLocationId || !writesEnabled || saving || !countedQuantity}
        >
          {saving ? "Зберігаємо…" : "Зберегти фактичну кількість"}
        </button>
      </div>
    </form>
  );
}

function LoanIssuePanel({
  detail,
  state,
  error,
  writesEnabled,
  teachers,
  referenceState,
  referenceError,
  onSaved,
  onChooseReturn,
}: {
  detail: MaterialDetail | null;
  state: LoadState;
  error: string;
  writesEnabled: boolean;
  teachers: LibraryTeacher[];
  referenceState: LoadState;
  referenceError: string;
  onSaved: () => Promise<void>;
  onChooseReturn: () => void;
}) {
  if (state === "idle") return <ChooseMaterial />;
  if (state === "loading" || referenceState === "loading") return <PanelLoading />;
  if (state === "error" || !detail) return <InlineMessage tone="error">{error}</InlineMessage>;
  if (referenceState === "error") return <InlineMessage tone="error">{referenceError}</InlineMessage>;
  if (!teachers.length) {
    return <InlineMessage tone="info">У новій базі ще немає активних учителів.</InlineMessage>;
  }
  return (
    <LoanIssueForm
      key={detail.id}
      detail={detail}
      teachers={teachers}
      writesEnabled={writesEnabled}
      onSaved={onSaved}
      onChooseReturn={onChooseReturn}
    />
  );
}

function LoanIssueForm({
  detail,
  teachers,
  writesEnabled,
  onSaved,
  onChooseReturn,
}: {
  detail: MaterialDetail;
  teachers: LibraryTeacher[];
  writesEnabled: boolean;
  onSaved: () => Promise<void>;
  onChooseReturn: () => void;
}) {
  const availableHoldings = detail.holdings.filter(
    (holding) =>
      holding.locationStatus === "active"
      && holding.locationType !== "service"
      && holding.quantity > 0,
  );
  const [teacherUserId, setTeacherUserId] = useState(teachers[0]?.id || "");
  const [sourceKey, setSourceKey] = useState(() => availableHoldings[0] ? holdingKey(availableHoldings[0]) : "");
  const source = availableHoldings.find((holding) => holdingKey(holding) === sourceKey) ?? null;
  const [quantity, setQuantity] = useState("1");
  const [issuedAt, setIssuedAt] = useState(() => todayInKyiv());
  const [dueAt, setDueAt] = useState("");
  const dueAtInputRef = useRef<HTMLInputElement>(null);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!writesEnabled || !source || !teacherUserId) return;
    const submittedDueAt = resolveLoanDueAtForSubmission(
      dueAtInputRef.current?.value,
      new FormData(event.currentTarget).get("dueAt"),
      dueAt,
    );
    setSaving(true);
    setSuccess(false);
    setMessage("");
    try {
      const response = await apiJson<MutationEnvelope<{ loanId: string; status: string }>>(
        "/api/librarian/loans",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            teacherUserId,
            issuedAt,
            dueAt: submittedDueAt,
            notes: notes.trim() || null,
            items: [{
              materialId: detail.id,
              sourceLocationId: source.locationId,
              condition: source.condition || "unspecified",
              quantity: Number(quantity),
              expectedAvailableQuantity: source.quantity,
            }],
          }),
        },
      );
      setSuccess(true);
      setMessage(response.result.status === "open" ? "Видачу оформлено." : "Операцію збережено.");
      await onSaved();
    } catch (requestError) {
      setMessage(errorMessage(requestError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className={styles.loanCard} onSubmit={submit}>
      <div className={styles.formHeading}>
        <div>
          <p>{detail.id}</p>
          <h2>Видати матеріал учителю</h2>
          <small>{detail.title}</small>
        </div>
      </div>

      <div className={styles.selectedSummary}>
        <Cover material={detail} />
        <div>
          <strong>{detail.title}</strong>
          <small>{[detail.author, detail.year].filter(Boolean).join(" · ")}</small>
        </div>
      </div>

      {availableHoldings.length ? (
        <div className={styles.formGrid}>
          <EditField label="Учитель" required wide>
            <select value={teacherUserId} onChange={(event) => setTeacherUserId(event.target.value)} required>
              {teachers.map((teacher) => (
                <option key={teacher.id} value={teacher.id}>{teacher.fullName}</option>
              ))}
            </select>
          </EditField>
          <EditField label="Звідки видати" required wide>
            <select value={sourceKey} onChange={(event) => setSourceKey(event.target.value)} required>
              {availableHoldings.map((holding) => (
                <option key={holdingKey(holding)} value={holdingKey(holding)}>
                  {holding.locationName} · {conditionLabel(holding.condition)} · доступно {holding.quantity}
                </option>
              ))}
            </select>
          </EditField>
          <EditField label="Кількість" required>
            <input
              type="number"
              min="1"
              max={source?.quantity ?? 1}
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              required
            />
          </EditField>
          <EditField label="Дата видачі" required>
            <input type="date" value={issuedAt} onChange={(event) => setIssuedAt(event.target.value)} required />
          </EditField>
          <EditField label="Повернути до">
            <input
              ref={dueAtInputRef}
              name="dueAt"
              type="date"
              min={issuedAt}
              value={dueAt}
              onInput={(event) => setDueAt(event.currentTarget.value)}
            />
          </EditField>
          <EditField label="Примітка" wide>
            <textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Наприклад, для роботи з 7-А класом" />
          </EditField>
        </div>
      ) : (
        <InlineMessage tone="info">Цей матеріал зараз відсутній у доступних місцях зберігання.</InlineMessage>
      )}

      {message ? <InlineMessage tone={success ? "success" : "error"}>{message}</InlineMessage> : null}

      <div className={styles.formActions}>
        {success ? (
          <button className={styles.secondaryButton} type="button" onClick={onChooseReturn}>
            Перейти до повернень
          </button>
        ) : <span>Залишок зменшиться одразу після збереження.</span>}
        <button
          className={styles.primaryButton}
          type="submit"
          disabled={!writesEnabled || !source || !teacherUserId || saving || !quantity}
        >
          {saving ? "Оформлюємо…" : "Оформити видачу"}
        </button>
      </div>
    </form>
  );
}

function LoanReturnPanel({
  writesEnabled,
  teachers,
  locations,
  referenceState,
  referenceError,
  onSaved,
}: {
  writesEnabled: boolean;
  teachers: LibraryTeacher[];
  locations: LibraryLocation[];
  referenceState: LoadState;
  referenceError: string;
  onSaved: () => Promise<void>;
}) {
  if (referenceState === "loading") return <PanelLoading />;
  if (referenceState === "error") return <InlineMessage tone="error">{referenceError}</InlineMessage>;
  return (
    <LoanReturnWorkspace
      writesEnabled={writesEnabled}
      teachers={teachers}
      locations={locations.filter((location) => location.type !== "service")}
      onSaved={onSaved}
    />
  );
}

function LoanReturnWorkspace({
  writesEnabled,
  teachers,
  locations,
  onSaved,
}: {
  writesEnabled: boolean;
  teachers: LibraryTeacher[];
  locations: LibraryLocation[];
  onSaved: () => Promise<void>;
}) {
  const [teacherFilter, setTeacherFilter] = useState("");
  const [loans, setLoans] = useState<OpenLoan[]>([]);
  const [selectedLoanId, setSelectedLoanId] = useState("");
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [completionMessage, setCompletionMessage] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ limit: "100" });
    if (teacherFilter) params.set("teacherUserId", teacherFilter);
    void apiJson<LoansEnvelope>(`/api/librarian/loans?${params}`, {
      signal: controller.signal,
    }).then((response) => {
      setLoans(response.loans);
      setSelectedLoanId((current) =>
        response.loans.some((loan) => loan.loanId === current)
          ? current
          : response.loans[0]?.loanId || "",
      );
      setState("ready");
    }).catch((requestError) => {
      if (controller.signal.aborted) return;
      setState("error");
      setError(errorMessage(requestError));
    });
    return () => controller.abort();
  }, [reloadToken, teacherFilter]);

  const selectedLoan = loans.find((loan) => loan.loanId === selectedLoanId) ?? null;

  return (
    <div className={styles.returnCard}>
      <div className={styles.formHeading}>
        <div>
          <p>Відкриті видачі</p>
          <h2>Прийняти повернення</h2>
          <small>Знайдіть учителя й оберіть потрібну видачу.</small>
        </div>
        <button type="button" onClick={() => {
          setState("loading");
          setError("");
          setReloadToken((value) => value + 1);
        }} title="Оновити">↻</button>
      </div>

      <label className={styles.returnFilter}>
        <span>Учитель</span>
        <select value={teacherFilter} onChange={(event) => {
          setState("loading");
          setError("");
          setCompletionMessage("");
          setTeacherFilter(event.target.value);
        }}>
          <option value="">Усі вчителі з відкритими видачами</option>
          {teachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.fullName}</option>)}
        </select>
      </label>

      {state === "loading" ? <PanelLoading /> : null}
      {state === "error" ? <InlineMessage tone="error">{error}</InlineMessage> : null}
      {completionMessage ? <InlineMessage tone="success">{completionMessage}</InlineMessage> : null}
      {state === "ready" && !loans.length ? (
        <div className={styles.noLoans}>
          <span aria-hidden="true">✓</span>
          <strong>Відкритих видач немає</strong>
          <p>Для вибраного вчителя все повернено.</p>
        </div>
      ) : null}

      {loans.length ? (
        <label className={styles.returnFilter}>
          <span>Видача</span>
          <select value={selectedLoanId} onChange={(event) => setSelectedLoanId(event.target.value)}>
            {loans.map((loan) => (
              <option key={loan.loanId} value={loan.loanId}>
                {loan.teacherName} · видано {formatDate(loan.issuedAt)} · {loan.items.length} поз.
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {selectedLoan ? (
        <LoanReturnForm
          key={`${selectedLoan.loanId}-${selectedLoan.version}`}
          loan={selectedLoan}
          locations={locations}
          writesEnabled={writesEnabled}
          onSaved={async (message) => {
            setCompletionMessage(message);
            await onSaved();
            setState("loading");
            setReloadToken((value) => value + 1);
          }}
        />
      ) : null}
    </div>
  );
}

type ReturnRow = {
  selected: boolean;
  quantity: string;
  condition: string;
};

function LoanReturnForm({
  loan,
  locations,
  writesEnabled,
  onSaved,
}: {
  loan: OpenLoan;
  locations: LibraryLocation[];
  writesEnabled: boolean;
  onSaved: (message: string) => Promise<void>;
}) {
  const defaultLocationId = locations.find((location) => location.type === "library")?.id || locations[0]?.id || "";
  const [returnLocationId, setReturnLocationId] = useState(defaultLocationId);
  const [returnedAt, setReturnedAt] = useState(() => todayInKyiv());
  const [notes, setNotes] = useState("");
  const [rows, setRows] = useState<Record<string, ReturnRow>>(() => Object.fromEntries(
    loan.items.map((item) => [item.loanItemId, {
      selected: true,
      quantity: String(item.quantityOutstanding),
      condition: item.condition || "unspecified",
    }]),
  ));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);

  function updateRow(loanItemId: string, changes: Partial<ReturnRow>) {
    setRows((current) => ({
      ...current,
      [loanItemId]: { ...current[loanItemId], ...changes },
    }));
  }

  const selectedItems = loan.items.filter((item) => {
    const row = rows[item.loanItemId];
    return row?.selected && Number(row.quantity) > 0;
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!writesEnabled || !returnLocationId || !selectedItems.length) return;
    setSaving(true);
    setSuccess(false);
    setMessage("");
    try {
      const response = await apiJson<MutationEnvelope<{ status: "open" | "closed" }>>(
        "/api/librarian/loans/returns",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            loanId: loan.loanId,
            returnedAt,
            notes: notes.trim() || null,
            items: selectedItems.map((item) => ({
              loanItemId: item.loanItemId,
              quantity: Number(rows[item.loanItemId].quantity),
              returnLocationId,
              condition: rows[item.loanItemId].condition,
            })),
          }),
        },
      );
      const resultMessage = response.result.status === "closed"
        ? "Усю видачу повернено."
        : "Часткове повернення збережено.";
      setSuccess(true);
      setMessage(resultMessage);
      await onSaved(resultMessage);
    } catch (requestError) {
      setMessage(errorMessage(requestError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className={styles.returnForm} onSubmit={submit}>
      <div className={styles.loanSummary}>
        <div>
          <span>Учитель</span>
          <strong>{loan.teacherName}</strong>
        </div>
        <div>
          <span>Видано</span>
          <strong>{formatDate(loan.issuedAt)}</strong>
        </div>
        <div>
          <span>Повернути до</span>
          <strong>{loan.dueAt ? formatDate(loan.dueAt) : "Без строку"}</strong>
        </div>
      </div>

      <div className={styles.returnItems}>
        {loan.items.map((item) => {
          const row = rows[item.loanItemId];
          return (
            <article key={item.loanItemId} className={row?.selected ? styles.returnItemSelected : ""}>
              <input
                aria-label={`Повернути ${item.materialTitle}`}
                type="checkbox"
                checked={row?.selected ?? false}
                onChange={(event) => updateRow(item.loanItemId, { selected: event.target.checked })}
              />
              <div>
                <strong>{item.materialTitle}</strong>
                <small>{[item.materialId, item.materialYear, item.sourceLocationName].filter(Boolean).join(" · ")}</small>
              </div>
              <label>
                <span>Кількість</span>
                <input
                  type="number"
                  min="1"
                  max={item.quantityOutstanding}
                  value={row?.quantity ?? ""}
                  disabled={!row?.selected}
                  onChange={(event) => updateRow(item.loanItemId, { quantity: event.target.value })}
                />
              </label>
              <label>
                <span>Стан</span>
                <select
                  value={row?.condition ?? "unspecified"}
                  disabled={!row?.selected}
                  onChange={(event) => updateRow(item.loanItemId, { condition: event.target.value })}
                >
                  <option value="unspecified">Не уточнено</option>
                  <option value="good">Добрий</option>
                  <option value="worn">Зношений</option>
                  <option value="damaged">Пошкоджений</option>
                </select>
              </label>
            </article>
          );
        })}
      </div>

      <div className={styles.formGrid}>
        <EditField label="Куди повернуто" required>
          <select value={returnLocationId} onChange={(event) => setReturnLocationId(event.target.value)} required>
            {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
          </select>
        </EditField>
        <EditField label="Дата повернення" required>
          <input type="date" min={loan.issuedAt} value={returnedAt} onChange={(event) => setReturnedAt(event.target.value)} required />
        </EditField>
        <EditField label="Примітка" wide>
          <textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Стан, комплектність або інша примітка" />
        </EditField>
      </div>

      {!locations.length ? <InlineMessage tone="info">Немає активного місця для повернення.</InlineMessage> : null}
      {message ? <InlineMessage tone={success ? "success" : "error"}>{message}</InlineMessage> : null}

      <div className={styles.formActions}>
        <span>Обрано позицій: {selectedItems.length}</span>
        <button
          className={styles.primaryButton}
          type="submit"
          disabled={!writesEnabled || !returnLocationId || !selectedItems.length || saving}
        >
          {saving ? "Зберігаємо…" : "Зберегти повернення"}
        </button>
      </div>
    </form>
  );
}

function Cover({ material }: { material: CatalogMaterial }) {
  return (
    <span className={styles.cover}>
      {material.thumbnailUrl ? (
        <img src={material.thumbnailUrl} alt="" loading="lazy" />
      ) : (
        <span aria-hidden="true">Б</span>
      )}
    </span>
  );
}

function StockStat({ label, value, emphasis = false }: { label: string; value: number; emphasis?: boolean }) {
  return (
    <article className={emphasis ? styles.stockEmphasis : ""}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value || "Не вказано"}</dd>
    </div>
  );
}

function EditField({
  label,
  required = false,
  error = "",
  wide = false,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={wide ? styles.fieldWide : styles.field}>
      <span>{label}{required ? <b> *</b> : null}</span>
      {children}
      {error ? <small className={styles.fieldError}>{error}</small> : null}
    </label>
  );
}

function LinkEditor({
  links,
  onLinks,
  error = "",
}: {
  links: EditableLinkDraft[];
  onLinks: (links: EditableLinkDraft[]) => void;
  error?: string;
}) {
  function update(key: string, changes: Partial<EditableLinkDraft>) {
    onLinks(links.map((link) => link.key === key ? { ...link, ...changes } : link));
  }

  function add() {
    if (links.length >= 20) return;
    onLinks([...links, {
      key: crypto.randomUUID(),
      id: null,
      kind: "ebook",
      label: "Читати онлайн",
      url: "",
      isPublic: true,
    }]);
  }

  return (
    <section className={styles.linkEditor}>
      <div className={styles.linkEditorHeading}>
        <span>
          <strong>Посилання та електронні книги</strong>
          <small>Вони відображатимуться у картці матеріалу.</small>
        </span>
        <button type="button" onClick={add} disabled={links.length >= 20}>+ Додати посилання</button>
      </div>
      {links.map((link, index) => (
        <article key={link.key}>
          <span className={styles.linkNumber}>{index + 1}</span>
          <label>
            <span>Тип</span>
            <select value={link.kind} onChange={(event) => update(link.key, { kind: event.target.value as EditableLinkDraft["kind"] })}>
              <option value="ebook">Електронна книга</option>
              <option value="details">Інформація</option>
              <option value="publisher">Видавництво</option>
              <option value="store">Магазин</option>
              <option value="preview">Перегляд</option>
              <option value="other">Інше</option>
            </select>
          </label>
          <label>
            <span>Підпис</span>
            <input value={link.label} onChange={(event) => update(link.key, { label: event.target.value })} placeholder="Наприклад, Читати онлайн" />
          </label>
          <label className={styles.linkUrlField}>
            <span>URL</span>
            <input type="url" value={link.url} onChange={(event) => update(link.key, { url: event.target.value })} placeholder="https://…" />
          </label>
          <label className={styles.publicLinkToggle}>
            <input type="checkbox" checked={link.isPublic} onChange={(event) => update(link.key, { isPublic: event.target.checked })} />
            <span>Показувати вчителям</span>
          </label>
          <button className={styles.removeLink} type="button" onClick={() => onLinks(links.filter((item) => item.key !== link.key))}>Видалити</button>
        </article>
      ))}
      {!links.length ? <p className={styles.mutedText}>Посилань ще немає.</p> : null}
      {error ? <small className={styles.fieldError}>{error}</small> : null}
    </section>
  );
}

function IsbnLookupAssist({
  isbn,
  onApply,
  disabled,
}: {
  isbn: string;
  onApply: (candidate: BookLookupCandidate) => void;
  disabled: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [candidates, setCandidates] = useState<BookLookupCandidate[]>([]);

  async function lookup() {
    const query = isbn.trim();
    if (!query || loading) return;
    setLoading(true);
    setMessage("");
    setCandidates([]);
    try {
      const response = await apiJson<BookLookupEnvelope>(
        `/api/librarian/isbn-lookup?isbn=${encodeURIComponent(query)}`,
      );
      setCandidates(response.candidates);
      setMessage(
        response.found
          ? "Оберіть знайдений опис. Заповнені вами поля не буде перезаписано."
          : "За цим ISBN опису не знайдено — заповніть поля вручну.",
      );
    } catch (lookupError) {
      setMessage(errorMessage(lookupError));
    } finally {
      setLoading(false);
    }
  }

  function apply(candidate: BookLookupCandidate) {
    onApply(candidate);
    setCandidates([]);
    setMessage("Дані видання додано до порожніх полів; перевірте їх перед збереженням.");
  }

  return (
    <section className={styles.isbnLookup} aria-live="polite">
      <div>
        <strong>Автозаповнення за ISBN</strong>
        <small>Назва, автор, рік, видавництво та інформаційне посилання.</small>
      </div>
      <button
        className={styles.secondaryButton}
        type="button"
        disabled={disabled || loading || !isbn.trim()}
        onClick={() => void lookup()}
      >
        {loading ? "Шукаємо…" : "Знайти опис"}
      </button>
      {message ? <p>{message}</p> : null}
      {candidates.length ? (
        <div className={styles.isbnCandidates}>
          {candidates.map((candidate, index) => (
            <button
              key={`${candidate.provider}-${candidate.title}-${index}`}
              type="button"
              onClick={() => apply(candidate)}
            >
              <strong>{candidate.title}</strong>
              <small>
                {[candidate.authors.join(", "), candidate.publishedYear, candidate.publisher]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
              <span>{candidate.provider === "google_books" ? "Google Books" : "Open Library"}</span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ConditionSelect({ value, onValue }: { value: string; onValue: (value: string) => void }) {
  return (
    <select value={value} onChange={(event) => onValue(event.target.value)}>
      <option value="unspecified">Стан не уточнено</option>
      <option value="good">Добрий стан</option>
      <option value="worn">Зношені</option>
      <option value="damaged">Пошкоджені</option>
    </select>
  );
}

function ChooseMaterial() {
  return (
    <div className={styles.chooseMaterial}>
      <span aria-hidden="true">☷</span>
      <h2>Оберіть матеріал у результатах</h2>
      <p>Картка, посилання, примірники та робочі дії з’являться тут.</p>
    </div>
  );
}

function PanelLoading() {
  return (
    <div className={styles.loading} aria-live="polite">
      <i /><i /><i /> Завантажуємо картку…
    </div>
  );
}

function InlineMessage({ children, tone }: { children: React.ReactNode; tone: "error" | "success" | "info" }) {
  return (
    <div
      className={`${styles.message} ${styles[`message${capitalize(tone)}`]}`}
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "error" ? "assertive" : "polite"}
    >
      {children}
    </div>
  );
}

class ApiError extends Error {
  fieldErrors: Record<string, string>;
  status: number;
  code: string;

  constructor(
    message: string,
    fieldErrors: Record<string, string> = {},
    status = 0,
    code = "",
  ) {
    super(message);
    this.name = "ApiError";
    this.fieldErrors = fieldErrors;
    this.status = status;
    this.code = code;
  }
}

function readPendingInventoryIntent(
  kind: PendingInventoryIntent["kind"],
  materialId: string,
): PendingInventoryIntent | null {
  if (typeof window === "undefined") return null;
  return readStoredInventoryIntent(window.sessionStorage, kind, materialId);
}

function writePendingInventoryIntent(intent: PendingInventoryIntent): boolean {
  if (typeof window === "undefined") return false;
  try {
    writeStoredInventoryIntent(window.sessionStorage, intent);
    return true;
  } catch {
    return false;
  }
}

function clearPendingInventoryIntent(
  kind: PendingInventoryIntent["kind"],
  materialId: string,
): void {
  if (typeof window === "undefined") return;
  try {
    clearStoredInventoryIntent(window.sessionStorage, kind, materialId);
  } catch {
    // The completed/terminal response remains authoritative even if browser cleanup is blocked.
  }
}

const DEFINITIVE_INVENTORY_FAILURES = new Set([
  "validation_failed",
  "authentication_required",
  "access_denied",
  "allowlist_not_configured",
  "cross_origin_request",
  "actor_not_mapped",
  "material_not_found",
  "source_location_not_found",
  "destination_location_not_found",
  "location_not_found",
  "stock_quantity_conflict",
  "insufficient_stock",
  "request_id_conflict",
  "unsupported_media_type",
  "invalid_json",
]);

function isDefinitiveInventoryFailure(error: unknown): boolean {
  return error instanceof ApiError
    && error.status !== 408
    && error.status !== 425
    && error.status !== 429
    && DEFINITIVE_INVENTORY_FAILURES.has(error.code);
}

function coverCleanupPending(error: unknown): boolean {
  return error instanceof ApiError && error.code === "cover_cleanup_pending";
}

async function apiJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { accept: "application/json", ...(init.headers || {}) },
  });
  const body = (await response.json().catch(() => null)) as (T & ApiFailure) | null;
  if (!response.ok || !body || body.success === false) {
    throw new ApiError(
      body?.error || body?.message || `Запит не виконано (${response.status}).`,
      body?.fieldErrors || {},
      response.status,
      body?.code || "",
    );
  }
  return body;
}

function toolTitle(tool: Tool): string {
  if (tool === "create") return "Новий матеріал";
  if (tool === "receipt") return "Надходження";
  if (tool === "transfer") return "Переміщення";
  if (tool === "writeoff") return "Списання";
  if (tool === "count") return "Фактична кількість";
  if (tool === "issue") return "Видача вчителю";
  if (tool === "return") return "Повернення";
  if (tool === "academic-year") return "Новий навчальний рік";
  if (tool === "class-create") return "Відкрити клас";
  if (tool === "class-update") return "Змінити клас";
  if (tool === "class-close") return "Закрити клас";
  if (tool === "rollover") return "Перехід на новий рік";
  return "Каталог матеріалів";
}

function toolDescription(tool: Tool): string {
  if (tool === "create") return "Додайте видання напряму в нову базу; CAT-ID створиться автоматично.";
  if (tool === "receipt") return "Оберіть матеріал і додайте нові примірники на баланс.";
  if (tool === "transfer") return "Перемістіть примірники між двома місцями однією атомарною операцією.";
  if (tool === "writeoff") return "Зафіксуйте пошкодження, втрату, застарілість або нестачу.";
  if (tool === "count") return "Оберіть матеріал і запишіть те, що порахували на місці.";
  if (tool === "issue") return "Оформіть видачу з конкретного місця зберігання.";
  if (tool === "return") return "Знайдіть відкриту видачу та прийміть повернення.";
  if (tool === "academic-year") return "Підготуйте наступний навчальний період напряму в D1.";
  if (tool === "class-create") return "Створіть клас у навчальному році та призначте керівника й кабінет.";
  if (tool === "class-update") return "Оновіть назву, керівника, кабінет або примітку без чернетки.";
  if (tool === "class-close") return "Завершіть клас без видалення його історії.";
  if (tool === "rollover") return "Завершіть поточний рік і перенесіть усі класи контрольованою операцією.";
  return "Швидкий пошук, усі посилання, примірники та пряме редагування.";
}

function conditionLabel(value: string | null): string {
  if (value === "good") return "добрий стан";
  if (value === "worn") return "зношений";
  if (value === "damaged") return "пошкоджений";
  return "стан не уточнено";
}

function linkKindLabel(value: string): string {
  if (value === "ebook") return "Електронна книга";
  if (value === "details") return "Інформація про видання";
  if (value === "publisher") return "Сайт видавництва";
  if (value === "store") return "Сторінка магазину";
  if (value === "preview") return "Попередній перегляд";
  return "Корисне посилання";
}

function formatDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

function fieldError(errors: Record<string, string>, field: string): string {
  return errors[`changes.${field}`] || errors[field] || "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Сталася невідома помилка.";
}

function emptyMaterialDraft(): MaterialEditDraft {
  return {
    title: "",
    rubric: "",
    publicationType: "",
    subject: "",
    classFrom: "",
    classTo: "",
    author: "",
    publicationYear: "",
    isbn: "",
    publisher: "",
    notes: "",
  };
}

function linkPayload(links: EditableLinkDraft[]) {
  return links.map((link, index) => ({
    id: link.id,
    kind: link.kind,
    label: link.label.trim(),
    url: link.url.trim(),
    isPublic: link.isPublic,
    sortOrder: index,
  }));
}

function mergeBookLookupDraft(
  current: MaterialEditDraft,
  candidate: BookLookupCandidate,
): MaterialEditDraft {
  return {
    ...current,
    title: current.title.trim() || candidate.title,
    author: current.author.trim() || candidate.authors.join(", "),
    publicationYear: current.publicationYear || (candidate.publishedYear ? String(candidate.publishedYear) : ""),
    isbn: current.isbn.trim() || candidate.isbn,
    publisher: current.publisher.trim() || candidate.publisher,
  };
}

function mergeBookLookupLink(
  current: EditableLinkDraft[],
  candidate: BookLookupCandidate,
): EditableLinkDraft[] {
  if (!candidate.sourceUrl || current.some((link) => link.url === candidate.sourceUrl)) return current;
  return [
    ...current,
    {
      key: crypto.randomUUID(),
      id: null,
      kind: "details",
      label: `Інформація про видання · ${candidate.provider === "google_books" ? "Google Books" : "Open Library"}`,
      url: candidate.sourceUrl,
      isPublic: true,
    },
  ];
}

function isLinkKind(value: string): value is EditableLinkDraft["kind"] {
  return new Set<string>(["ebook", "details", "publisher", "store", "preview", "other"]).has(value);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
