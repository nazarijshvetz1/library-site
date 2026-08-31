"use client";

/* eslint-disable @next/next/no-img-element -- Material cover photos intentionally use direct image URLs. */

import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  buildCatalogSearchUrl,
  clearPendingClassCirculationIntent as clearStoredClassCirculationIntent,
  editDraftToChanges,
  gradeLabel,
  holdingKey,
  type CatalogSearchFilters,
  type ClassCirculationIntentKind,
  type MaterialEditDraft,
  type PendingClassCirculationIntent,
  materialToEditDraft,
  readPendingClassCirculationIntent as readStoredClassCirculationIntent,
  resolveLoanDueAtForSubmission,
  resolveLiveFormTextForSubmission,
  todayInKyiv,
  writePendingClassCirculationIntent as writeStoredClassCirculationIntent,
} from "@/lib/librarian-d1-client";
import {
  editCoverPhotoForUpload,
  normalizeCoverPhotoForUpload,
  type CoverPhotoEdit,
} from "@/lib/cover-client";
import { normalizeIsbn } from "@/lib/isbn";
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
import LibrarianShell, { type LibrarianSubsection } from "./_components/librarian-shell";
import {
  librarianSectionHref,
  librarianToolHref,
  type LibrarianSection,
} from "./_components/librarian-routes";
import SiteIcon, { type SiteIconName } from "../_components/site-icon";

import styles from "./d1-workspace.module.css";

type Tool =
  | "dashboard"
  | "catalog"
  | "create"
  | "receipt"
  | "transfer"
  | "writeoff"
  | "count"
  | "issue"
  | "return"
  | "class-issue"
  | "class-return"
  | "locations"
  | "contacts"
  | AcademicTool;
type LoadState = "idle" | "loading" | "ready" | "error";
type AcquisitionMaterialPrefill = { title: string; author: string; publicationYear: string; subject: string; sourceUrl: string; quantity: string };

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
  reservedQuantity?: number;
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
  physicalQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  /** Effective unreserved quantity retained for issue-form compatibility. */
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

type CatalogFacetsEnvelope = {
  success: boolean;
  rubrics: string[];
  subjects: string[];
  publicationTypes: string[];
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
  status?: string;
};

type ManagedLocation = {
  id: string;
  name: string;
  type: string;
  status: "active" | "inactive";
  isPublic: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  dependencies: {
    stockQuantity: number;
    activeReservations: number;
    activeClasses: number;
    activeTeachers: number;
    readyRequests: number;
    totalReferences: number;
  };
  canDelete: boolean;
  canDeactivate: boolean;
  blockers: string[];
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
  materialCatalogNumber: number;
  materialTitle: string;
  materialAuthor: string;
  materialYear: number | null;
  materialIsbn: string;
  coverUrl: string;
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

type CopyCondition = "unspecified" | "good" | "worn" | "damaged";

type AcademicReferenceYear = {
  id: string;
  status: string;
};

type AcademicReferenceCohort = {
  id: string;
  status: string;
};

type AcademicReferenceClassYear = {
  id: string;
  academicYearId: string;
  academicYearLabel: string;
  cohortId: string;
  className: string;
  grade: number;
  code: string;
  teacherUserId: string | null;
  teacherName: string;
  locationId: string | null;
  locationName: string;
  startDate: string;
  endDate: string;
  status: string;
  actualClosedDate: string | null;
  notes: string;
  version: number;
};

type AcademicReferenceEnvelope = {
  success: boolean;
  referenceData: {
    classYears: AcademicReferenceClassYear[];
    academicYears: AcademicReferenceYear[];
    cohorts: AcademicReferenceCohort[];
  };
  writesEnabled: boolean;
};

type ClassIssueItem = {
  materialId: string;
  sourceLocationId: string;
  condition: CopyCondition;
  quantity: number;
  expectedAvailableQuantity: number;
};

type ClassIssuePayload = {
  requestId: string;
  classYearId: string;
  expectedClassYearVersion: number;
  responsibleTeacherUserId: string;
  issuedAt: string;
  dueAt: string | null;
  notes: string | null;
  items: ClassIssueItem[];
};

type ClassIssueCartRow = ClassIssueItem & {
  key: string;
  materialTitle: string;
  materialAuthor: string;
  materialYear: number | null;
  thumbnailUrl: string;
  sourceLocationName: string;
};

type OpenClassLoanItem = {
  classLoanItemId: string;
  materialId: string;
  materialTitle: string;
  materialYear: number | null;
  sourceLocationId: string;
  sourceLocationName: string;
  condition: CopyCondition;
  quantityIssued: number;
  quantityReturned: number;
  quantityOutstanding: number;
};

type OpenClassLoan = {
  classLoanId: string;
  classYearId: string;
  className: string;
  academicYearId: string;
  academicYearLabel: string;
  cohortId: string;
  responsibleTeacherUserId: string;
  responsibleTeacherName: string;
  status: "open";
  issuedAt: string;
  dueAt: string | null;
  notes: string;
  version: number;
  items: OpenClassLoanItem[];
};

type ClassLoansEnvelope = {
  success: boolean;
  classLoans: OpenClassLoan[];
  writesEnabled: boolean;
};

type ClassReturnItem = {
  classLoanItemId: string;
  quantity: number;
  returnLocationId: string;
  condition: CopyCondition;
};

type ClassReturnPayload = {
  requestId: string;
  classLoanId: string;
  expectedVersion: number;
  returnedAt: string;
  notes: string | null;
  items: ClassReturnItem[];
};

type ClassLoanMutationResult = {
  classLoanId: string;
  status: "open" | "closed";
  version: number;
};

type LibrarianWorkspaceProps = {
  displayName: string;
  role: string;
  writesEnabled: boolean;
  signOutHref: string;
  telegramMiniApp?: boolean;
};

const EMPTY_FILTERS: CatalogSearchFilters = {
  q: "",
  rubric: "",
  grade: "",
  subject: "",
  publicationType: "",
  available: false,
};

function catalogFiltersKey(filters: CatalogSearchFilters): string {
  return JSON.stringify([
    filters.q.trim(),
    filters.rubric.trim(),
    filters.grade.trim(),
    filters.subject.trim(),
    filters.publicationType.trim(),
    filters.available,
  ]);
}

function buildMaterialTitleSuggestionUrl(title: string): string {
  const params = new URLSearchParams();
  params.set("title", title.trim());
  params.set("sort", "title");
  params.set("limit", "20");
  return `/api/librarian/materials/search?${params.toString()}`;
}

type ToolItem = { id: Tool; icon: SiteIconName; label: string; hint: string };
type ToolGroup = { id: string; label: string; items: ToolItem[] };
type MaterialActionTool = "receipt" | "transfer" | "writeoff" | "count" | "issue";

const DASHBOARD_TOOL: ToolItem = {
  id: "dashboard",
  icon: "home",
  label: "Головна",
  hint: "Огляд і швидкі дії",
};

const TOOL_GROUPS: ToolGroup[] = [
  {
    id: "fund",
    label: "Фонд",
    items: [
      { id: "catalog", icon: "catalog", label: "Каталог", hint: "Пошук і картка" },
      { id: "create", icon: "new-material", label: "Новий матеріал", hint: "Додати без чернетки" },
    ],
  },
  {
    id: "circulation",
    label: "Видача й повернення",
    items: [
      { id: "return", icon: "return", label: "Повернення", hint: "Прийняти книги" },
      { id: "class-issue", icon: "issue-class", label: "Видача класу", hint: "Кілька матеріалів" },
      { id: "class-return", icon: "return-class", label: "Повернення класу", hint: "Частково або повністю" },
    ],
  },
  {
    id: "academic",
    label: "Класи й навчальний рік",
    items: [
      { id: "academic-year", icon: "academic-year", label: "Новий навчальний рік", hint: "Створити період" },
      { id: "class-create", icon: "class-create", label: "Відкрити клас", hint: "Додати до року" },
      { id: "class-update", icon: "class-update", label: "Змінити клас", hint: "Керівник і кабінет" },
      { id: "class-close", icon: "class-close", label: "Закрити клас", hint: "Зберегти історію" },
      { id: "class-reopen", icon: "class-reopen", label: "Поновити клас", hint: "Виправити закриття" },
      { id: "rollover", icon: "rollover", label: "Перехід на новий рік", hint: "Перевести всі класи" },
    ],
  },
  {
    id: "settings",
    label: "Налаштування",
    items: [
      { id: "locations", icon: "locations", label: "Кабінети", hint: "Додати, змінити або закрити" },
      { id: "contacts", icon: "contacts", label: "Контакти", hint: "Дані для відкритого сайту" },
    ],
  },
];

const MATERIAL_ACTION_ITEMS: ToolItem[] = [
  { id: "issue", icon: "issue-teacher", label: "Видати вчителю", hint: "Оформити видачу" },
  { id: "receipt", icon: "receipt", label: "Додати примірники", hint: "Оформити надходження" },
  { id: "transfer", icon: "transfer", label: "Перемістити", hint: "Змінити розміщення" },
  { id: "count", icon: "count", label: "Звірити кількість", hint: "Зафіксувати залишок" },
  { id: "writeoff", icon: "writeoff", label: "Списати", hint: "Зменшити залишок" },
];
const MATERIAL_ACTION_IDS = new Set<MaterialActionTool>(MATERIAL_ACTION_ITEMS.map((item) => item.id as MaterialActionTool));
const TOOLS: ToolItem[] = [DASHBOARD_TOOL, ...TOOL_GROUPS.flatMap((group) => group.items), ...MATERIAL_ACTION_ITEMS];
const TOOL_IDS = new Set<Tool>(TOOLS.map((item) => item.id));

function parseTool(value: string | null): Tool | null {
  return value && TOOL_IDS.has(value as Tool) ? value as Tool : null;
}

function librarianSectionForTool(tool: Tool): LibrarianSection {
  if (tool === "dashboard") return "home";
  if (["issue", "return", "class-issue", "class-return"].includes(tool)) return "circulation";
  if (tool === "locations" || tool === "contacts" || isAcademicTool(tool)) return "management";
  return "fund";
}

function librarianSubsectionForTool(tool: Tool): string | undefined {
  if (MATERIAL_ACTION_IDS.has(tool as MaterialActionTool)) return tool === "issue" ? "issue" : "catalog";
  return tool === "dashboard" ? undefined : tool;
}

function librarianSubsections(telegramMiniApp: boolean): LibrarianSubsection[] {
  return TOOL_GROUPS.flatMap((group) => group.items.map((item) => ({
    id: item.id,
    section: librarianSectionForTool(item.id),
    label: item.label,
    hint: item.hint,
    icon: item.icon,
    href: librarianToolHref(item.id, telegramMiniApp),
  })));
}

export default function D1LibrarianWorkspace({
  displayName,
  role,
  writesEnabled,
  signOutHref,
  telegramMiniApp = false,
}: LibrarianWorkspaceProps) {
  const [tool, setTool] = useState<Tool>("dashboard");
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [items, setItems] = useState<CatalogMaterial[]>([]);
  const [searchState, setSearchState] = useState<LoadState>("loading");
  const [searchError, setSearchError] = useState("");
  const [resolvedSearchScope, setResolvedSearchScope] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMoreRequestRef = useRef(0);
  const [rubrics, setRubrics] = useState<string[]>([]);
  const [subjects, setSubjects] = useState<string[]>([]);
  const [publicationTypes, setPublicationTypes] = useState<string[]>([]);
  const [facetsState, setFacetsState] = useState<LoadState>("loading");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const detailRequestRef = useRef(0);
  const [detail, setDetail] = useState<MaterialDetail | null>(null);
  const [detailState, setDetailState] = useState<LoadState>("idle");
  const [detailError, setDetailError] = useState("");
  const [editing, setEditing] = useState(false);
  const [workspaceNotice, setWorkspaceNotice] = useState("");
  const [workspaceNoticeTone, setWorkspaceNoticeTone] = useState<"error" | "success">("error");
  const [refreshToken, setRefreshToken] = useState(0);
  const catalogRevision = `${catalogFiltersKey(filters)}\u001e${refreshToken}`;
  const catalogRevisionRef = useRef(catalogRevision);
  useEffect(() => {
    catalogRevisionRef.current = catalogRevision;
  }, [catalogRevision]);
  const [teachers, setTeachers] = useState<LibraryTeacher[]>([]);
  const [locations, setLocations] = useState<LibraryLocation[]>([]);
  const [referenceState, setReferenceState] = useState<LoadState>("loading");
  const [referenceError, setReferenceError] = useState("");
  const [referenceRefreshToken, setReferenceRefreshToken] = useState(0);
  const [acquisitionPrefill, setAcquisitionPrefill] = useState<AcquisitionMaterialPrefill | null>(null);
  const [acquisitionReturnId, setAcquisitionReturnId] = useState("");
  const workspaceTitleRef = useRef<HTMLHeadingElement>(null);
  const shellSubsections = useMemo(() => librarianSubsections(telegramMiniApp), [telegramMiniApp]);

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
    const requestScope = catalogFiltersKey(filters);
    const timer = window.setTimeout(async () => {
      setSearchState("loading");
      setLoadingMore(false);
      setSearchError("");
      try {
        const response = await apiJson<SearchEnvelope>(
          buildCatalogSearchUrl(filters),
          { signal: controller.signal },
        );
        setItems(response.items);
        setNextCursor(response.page.nextCursor);
        setResolvedSearchScope(requestScope);
        setSearchState("ready");
      } catch (error) {
        if (controller.signal.aborted) return;
        setItems([]);
        setNextCursor(null);
        setResolvedSearchScope("");
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
    void apiJson<CatalogFacetsEnvelope>("/api/librarian/materials/facets", {
      signal: controller.signal,
    }).then((response) => {
      setRubrics(response.rubrics);
      setSubjects(response.subjects ?? []);
      setPublicationTypes(response.publicationTypes ?? []);
      setFacetsState("ready");
    }).catch(() => {
      if (controller.signal.aborted) return;
      setFacetsState("error");
    });
    return () => controller.abort();
  }, [refreshToken]);

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
  }, [referenceRefreshToken]);

  const selectMaterial = useCallback(
    (materialId: string) => {
      selectedIdRef.current = materialId;
      detailRequestRef.current += 1;
      setSelectedId(materialId);
      setEditing(false);
      setWorkspaceNotice("");
      setWorkspaceNoticeTone("error");
      void loadDetail(materialId);
    },
    [loadDetail],
  );

  const applyToolFromLocation = useCallback(() => {
    const url = new URL(window.location.href);
    const requestedTool = parseTool(url.searchParams.get("tool")) ?? "dashboard";
    if (!parseTool(url.searchParams.get("tool")) && !telegramMiniApp) {
      url.searchParams.set("tool", requestedTool);
      const currentState = typeof window.history.state === "object" && window.history.state
        ? window.history.state as Record<string, unknown>
        : {};
      window.history.replaceState(
        { ...currentState, librarianTool: requestedTool },
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
    }

    setTool(requestedTool);
    setAcquisitionReturnId((url.searchParams.get("acquisition") ?? "").trim());

    if (requestedTool === "create") {
      const title = (url.searchParams.get("title") ?? "").trim();
      setAcquisitionPrefill(title ? {
        title,
        author: (url.searchParams.get("author") ?? "").trim(),
        publicationYear: (url.searchParams.get("year") ?? "").trim(),
        subject: (url.searchParams.get("subject") ?? "").trim(),
        sourceUrl: (url.searchParams.get("link") ?? "").trim(),
        quantity: (url.searchParams.get("quantity") ?? "").trim(),
      } : null);
    }

    const materialId = (url.searchParams.get("material") ?? "").trim().toUpperCase();
    if (requestedTool !== "dashboard" && /^CAT-\d{4,}$/u.test(materialId)) {
      setFilters((current) => ({ ...current, q: materialId, available: false }));
      selectMaterial(materialId);
      if (requestedTool === "catalog" && url.searchParams.get("edit") === "1" && writesEnabled) {
        setEditing(true);
      }
    }

    window.queueMicrotask(() => workspaceTitleRef.current?.focus());
  }, [selectMaterial, telegramMiniApp, writesEnabled]);

  useEffect(() => {
    const timer = window.setTimeout(applyToolFromLocation, 0);
    window.addEventListener("popstate", applyToolFromLocation);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("popstate", applyToolFromLocation);
    };
  }, [applyToolFromLocation]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    const requestSequence = ++loadMoreRequestRef.current;
    const requestRevision = `${catalogFiltersKey(filters)}\u001e${refreshToken}`;
    setLoadingMore(true);
    try {
      const response = await apiJson<SearchEnvelope>(
        buildCatalogSearchUrl(filters, nextCursor),
      );
      if (requestSequence !== loadMoreRequestRef.current || catalogRevisionRef.current !== requestRevision) return;
      setItems((current) => {
        const known = new Set(current.map((item) => item.id));
        return [
          ...current,
          ...response.items.filter((item) => !known.has(item.id)),
        ];
      });
      setNextCursor(response.page.nextCursor);
    } catch (error) {
      if (requestSequence === loadMoreRequestRef.current && catalogRevisionRef.current === requestRevision) {
        setSearchError(errorMessage(error));
      }
    } finally {
      if (requestSequence === loadMoreRequestRef.current && catalogRevisionRef.current === requestRevision) {
        setLoadingMore(false);
      }
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
    setWorkspaceNoticeTone("error");
    // Vinext patches the History API. Telegram's iOS WebView can treat those
    // patched same-document writes as a navigation and replace the Mini App
    // with its generic "page couldn't load" screen. The cabinet is already a
    // stateful client view, so Telegram only needs the React state transition.
    if (!telegramMiniApp) {
      const url = new URL(window.location.href);
      const currentTool = parseTool(url.searchParams.get("tool"));
      url.searchParams.set("tool", nextTool);
      const currentState = typeof window.history.state === "object" && window.history.state
        ? window.history.state as Record<string, unknown>
        : {};
      const method = currentTool === nextTool ? "replaceState" : "pushState";
      window.history[method](
        { ...currentState, librarianTool: nextTool },
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
      window.dispatchEvent(new Event("librarian:navigation-change"));
    }
    window.queueMicrotask(() => workspaceTitleRef.current?.focus());
  }

  function handleMaterialArchived(materialId: string) {
    selectedIdRef.current = null;
    detailRequestRef.current += 1;
    setSelectedId(null);
    setItems((current) => current.filter((item) => item.id !== materialId));
    setDetail(null);
    setDetailState("idle");
    setDetailError("");
    setEditing(false);
    setRefreshToken((value) => value + 1);
    setWorkspaceNotice(`Матеріал ${materialId} видалено з каталогу. Історію операцій збережено.`);
    setWorkspaceNoticeTone("success");
    window.queueMicrotask(() => workspaceTitleRef.current?.focus());
  }

  const clearMaterialSelection = useCallback(() => {
    selectedIdRef.current = null;
    detailRequestRef.current += 1;
    setSelectedId(null);
    setDetail(null);
    setDetailState("idle");
    setDetailError("");
    setEditing(false);
  }, []);

  const showCatalogSearch = tool !== "dashboard"
    && !isAcademicTool(tool)
    && tool !== "return"
    && tool !== "class-return"
    && tool !== "locations"
    && tool !== "contacts";
  const materialSelectionOpen = Boolean(selectedId)
    && (tool === "catalog" || tool === "class-issue" || MATERIAL_ACTION_IDS.has(tool as MaterialActionTool));
  const materialModalCloseRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!materialSelectionOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = "hidden";
    window.queueMicrotask(() => materialModalCloseRef.current?.focus());
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") clearMaterialSelection();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      window.queueMicrotask(() => previouslyFocused?.focus({ preventScroll: true }));
    };
  }, [clearMaterialSelection, materialSelectionOpen]);

  return (
    <LibrarianShell
      activeSection={librarianSectionForTool(tool)}
      displayName={displayName}
      roleLabel={role === "admin" ? "Адміністратор" : "Бібліотекар"}
      signOutHref={signOutHref}
      telegramMiniApp={telegramMiniApp}
      writesEnabled={writesEnabled}
      subsections={shellSubsections}
      activeSubsection={librarianSubsectionForTool(tool)}
      onSubsectionNavigate={(id) => chooseTool(id as Tool)}
    >
      <main className={styles.shell}>
        <div className={styles.body}>
        <section className={styles.workspace}>
          <div className={styles.titleRow}>
            <div>
              <p className={styles.eyebrow}>D1 · швидкий режим</p>
              <h1 ref={workspaceTitleRef} tabIndex={-1}>{toolTitle(tool)}</h1>
              <p>{toolDescription(tool)}</p>
            </div>
            <button
              className={styles.refresh}
              type="button"
              onClick={() => void refreshSelected()}
              disabled={searchState === "loading" || detailState === "loading"}
            >
              <SiteIcon name="refresh" size={18} /> Оновити
            </button>
          </div>

          {workspaceNotice ? (
            <div className={styles.workspaceNotice} role="status" aria-live="polite">
              <InlineMessage tone={workspaceNoticeTone}>{workspaceNotice}</InlineMessage>
              <button
                type="button"
                aria-label="Закрити повідомлення"
                onClick={() => setWorkspaceNotice("")}
              >
                <SiteIcon name="close" size={17} />
              </button>
            </div>
          ) : null}

          {tool === "dashboard" ? (
            <DashboardPanel
              filters={filters}
              onFilters={setFilters}
              items={items}
              searchState={searchState}
              writesEnabled={writesEnabled}
              teachers={teachers}
              locations={locations}
              referenceState={referenceState}
              telegramMiniApp={telegramMiniApp}
              onChooseTool={chooseTool}
            />
          ) : (
          <div className={`${tool === "create" ? styles.workGridCreate : showCatalogSearch ? styles.workGrid : styles.workGridWide} ${materialSelectionOpen ? styles.workGridSelected : ""}`}>
            {showCatalogSearch && tool !== "create" ? (
              <CatalogSearch
                filters={filters}
                onFilters={setFilters}
                items={items}
                state={searchState}
                error={searchError}
                rubrics={rubrics}
                subjects={subjects}
                publicationTypes={publicationTypes}
                facetsState={facetsState}
                suggestionsReady={resolvedSearchScope === catalogFiltersKey(filters)}
                selectedId={selectedId}
                onSelect={selectMaterial}
                nextCursor={nextCursor}
                loadingMore={loadingMore}
                onLoadMore={() => void loadMore()}
              />
            ) : null}

            <div
              className={materialSelectionOpen ? styles.materialModalBackdrop : styles.actionPaneHost}
              role={materialSelectionOpen ? "presentation" : undefined}
              onMouseDown={materialSelectionOpen ? (event) => {
                if (event.target === event.currentTarget) clearMaterialSelection();
              } : undefined}
            >
            <section
              className={`${styles.actionPane} ${materialSelectionOpen ? styles.materialModalPanel : ""}`}
              role={materialSelectionOpen ? "dialog" : undefined}
              aria-modal={materialSelectionOpen || undefined}
              aria-label={materialSelectionOpen ? "Картка матеріалу та доступні дії" : undefined}
            >
              {materialSelectionOpen ? (
                <button ref={materialModalCloseRef} className={styles.backToResults} type="button" onClick={clearMaterialSelection}>
                  <SiteIcon name="close" size={17} /> Закрити картку
                </button>
              ) : null}
              {MATERIAL_ACTION_IDS.has(tool as MaterialActionTool) && detail ? (
                <MaterialActionContext detail={detail} tool={tool as MaterialActionTool} onBack={clearMaterialSelection} />
              ) : null}
              {tool === "catalog" ? (
                <MaterialCard
                  key={detail?.id ?? "material-card"}
                  detail={detail}
                  state={detailState}
                  error={detailError}
                  editing={editing}
                  onEditing={(value) => {
                    setEditing(value);
                    if (value) {
                      setWorkspaceNotice("");
                      setWorkspaceNoticeTone("error");
                    }
                  }}
                  writesEnabled={writesEnabled}
                  onSaved={refreshSelected}
                  onNotice={(message) => {
                    setWorkspaceNotice(message);
                    setWorkspaceNoticeTone("error");
                  }}
                  onArchived={handleMaterialArchived}
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
                  rubrics={rubrics}
                  subjects={subjects}
                  publicationTypes={publicationTypes}
                  facetsState={facetsState}
                  initialPrefill={acquisitionPrefill}
                  onCreated={async (materialId) => {
                    setRefreshToken((value) => value + 1);
                    if (acquisitionReturnId) {
                      const returnBase = window.location.pathname.startsWith("/librarian/telegram/")
                        ? "/librarian/telegram/cabinet?target=acquisitions&"
                        : "/librarian/acquisitions?";
                      window.location.assign(`${returnBase}linkRequest=${encodeURIComponent(acquisitionReturnId)}&material=${encodeURIComponent(materialId)}`);
                      return;
                    }
                    selectMaterial(materialId);
                  }}
                  onOpenExisting={(materialId) => {
                    selectMaterial(materialId);
                    chooseTool("catalog");
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
                  onSaved={async () => {
                    await refreshSelected();
                    if (acquisitionReturnId) {
                      const returnBase = window.location.pathname.startsWith("/librarian/telegram/")
                        ? "/librarian/telegram/cabinet?target=acquisitions&"
                        : "/librarian/acquisitions?";
                      window.location.assign(`${returnBase}receiptRequest=${encodeURIComponent(acquisitionReturnId)}`);
                    }
                  }}
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
              {tool === "class-issue" ? (
                <ClassIssueWorkspace
                  detail={detail}
                  detailState={detailState}
                  detailError={detailError}
                  writesEnabled={writesEnabled}
                  teachers={teachers}
                  referenceState={referenceState}
                  referenceError={referenceError}
                  onSaved={refreshSelected}
                  onChooseReturn={() => chooseTool("class-return")}
                />
              ) : null}
              {tool === "class-return" ? (
                <ClassReturnWorkspace
                  writesEnabled={writesEnabled}
                  locations={locations}
                  referenceState={referenceState}
                  referenceError={referenceError}
                  onSaved={refreshSelected}
                />
              ) : null}
              {tool === "locations" ? (
                <LocationManagementPanel writesEnabled={writesEnabled} onChanged={() => { setReferenceState("loading"); setReferenceError(""); setReferenceRefreshToken((value) => value + 1); }} />
              ) : null}
              {tool === "contacts" ? (
                <ContactsManagementPanel writesEnabled={writesEnabled} />
              ) : null}
              {isAcademicTool(tool) ? (
                <AcademicWorkspace
                  tool={tool}
                  writesEnabled={writesEnabled}
                  locations={locations}
                />
              ) : null}
            </section>
            </div>
            {tool === "create" ? (
              <CatalogSearch
                filters={filters}
                onFilters={setFilters}
                items={items}
                state={searchState}
                error={searchError}
                rubrics={rubrics}
                subjects={subjects}
                publicationTypes={publicationTypes}
                facetsState={facetsState}
                suggestionsReady={resolvedSearchScope === catalogFiltersKey(filters)}
                selectedId={selectedId}
                onSelect={selectMaterial}
                nextCursor={nextCursor}
                loadingMore={loadingMore}
                onLoadMore={() => void loadMore()}
              />
            ) : null}
          </div>
          )}
        </section>
        </div>
      </main>
    </LibrarianShell>
  );
}

function DashboardPanel({
  filters,
  onFilters,
  items,
  searchState,
  writesEnabled,
  teachers,
  locations,
  referenceState,
  telegramMiniApp,
  onChooseTool,
}: {
  filters: CatalogSearchFilters;
  onFilters: (value: CatalogSearchFilters | ((current: CatalogSearchFilters) => CatalogSearchFilters)) => void;
  items: CatalogMaterial[];
  searchState: LoadState;
  writesEnabled: boolean;
  teachers: LibraryTeacher[];
  locations: LibraryLocation[];
  referenceState: LoadState;
  telegramMiniApp: boolean;
  onChooseTool: (tool: Tool) => void;
}) {
  const [attention, setAttention] = useState<{
    visitsToday: number;
    newTeacherOrders: number;
    activeAcquisitions: number;
  } | null>(null);
  const [attentionUnavailable, setAttentionUnavailable] = useState(false);
  const availableOnPage = items.reduce((sum, item) => sum + item.availableQuantity, 0);
  const quickActions = TOOLS.filter((item) => [
    "return",
    "issue",
    "class-issue",
    "receipt",
    "create",
    "count",
  ].includes(item.id));

  useEffect(() => {
    let cancelled = false;
    const date = todayInKyiv();
    const visitParams = new URLSearchParams({ from: date, to: date, status: "active", limit: "100" });
    const acquisitionParams = new URLSearchParams({ status: "active", requester: "all", q: "" });
    void Promise.all([
      apiJson<{ bookings: unknown[] }>(`/api/librarian/visits?${visitParams.toString()}`),
      apiJson<{ newCount: number }>("/api/librarian/material-requests?limit=100"),
      apiJson<{ summary: { active: number } }>(`/api/librarian/acquisition-requests?${acquisitionParams.toString()}`),
    ]).then(([visits, orders, acquisitions]) => {
      if (cancelled) return;
      setAttentionUnavailable(false);
      setAttention({
        visitsToday: visits.bookings.length,
        newTeacherOrders: orders.newCount,
        activeAcquisitions: acquisitions.summary.active,
      });
    }).catch(() => {
      if (!cancelled) setAttentionUnavailable(true);
    });
    return () => { cancelled = true; };
  }, []);

  function openCatalog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onChooseTool("catalog");
  }

  function searchScannedIsbn(value: string) {
    onFilters((current) => ({ ...current, q: value, available: false }));
    onChooseTool("catalog");
  }

  return (
    <div className={styles.dashboard}>
      <section className={styles.dashboardHero} aria-labelledby="dashboard-search-title">
        <div className={styles.dashboardHeroCopy}>
          <span className={writesEnabled ? styles.dashboardStatusOn : styles.dashboardStatusOff}>
            <span aria-hidden="true"><SiteIcon name={writesEnabled ? "success" : "read-only"} size={16} /></span>
            {writesEnabled ? "Запис увімкнено" : "Лише перегляд"}
          </span>
          <h2 id="dashboard-search-title">Знайдіть матеріал або відскануйте ISBN</h2>
          <p>Пошук відкриє картку матеріалу, залишки та доступні робочі дії.</p>
        </div>
        <form className={styles.dashboardSearch} onSubmit={openCatalog} role="search">
          <label>
            <span>Назва, автор, ISBN або CAT-ID</span>
            <input
              value={filters.q}
              onChange={(event) => {
                // React clears currentTarget after the handler returns. Snapshot
                // the value before passing a functional update to avoid a
                // deferred WebView render reading currentTarget as null.
                const nextQuery = event.currentTarget.value;
                onFilters((current) => ({ ...current, q: nextQuery }));
              }}
              placeholder="Наприклад, CAT-0195"
            />
          </label>
          <button type="submit">Знайти в каталозі</button>
          <IsbnCameraScanner disabled={false} onDetected={searchScannedIsbn} />
        </form>
      </section>

      <section className={styles.dashboardMetrics} aria-label="Стан робочого місця">
        <article>
          <strong>{searchState === "loading" ? "…" : items.length}</strong>
          <span>матеріалів на поточній сторінці</span>
        </article>
        <article>
          <strong>{searchState === "loading" ? "…" : availableOnPage}</strong>
          <span>доступних примірників у результатах</span>
        </article>
        <article>
          <strong>{referenceState === "loading" ? "…" : teachers.length}</strong>
          <span>вчителів у довіднику</span>
        </article>
        <article>
          <strong>{referenceState === "loading" ? "…" : locations.length}</strong>
          <span>активних місць зберігання</span>
        </article>
      </section>

      <section className={styles.dashboardSection} aria-labelledby="dashboard-quick-title">
        <div className={styles.dashboardSectionHeading}>
          <span>Щодня</span>
          <h2 id="dashboard-quick-title">Швидкі дії</h2>
        </div>
        <div className={styles.dashboardQuickGrid}>
          {quickActions.map((item) => (
            <button type="button" key={item.id} onClick={() => onChooseTool(item.id)}>
              <span aria-hidden="true"><SiteIcon name={item.icon} /></span>
              <span><strong>{item.label}</strong><small>{item.hint}</small></span>
              <span aria-hidden="true"><SiteIcon name="next" size={18} /></span>
            </button>
          ))}
        </div>
      </section>

      <div className={styles.dashboardLowerGrid}>
        <section className={styles.dashboardSection} aria-labelledby="dashboard-sections-title">
          <div className={styles.dashboardSectionHeading}>
            <span>Усі інструменти</span>
            <h2 id="dashboard-sections-title">Робочі розділи</h2>
          </div>
          <div className={styles.dashboardGroupGrid}>
            {TOOL_GROUPS.map((group) => (
              <article key={group.id}>
                <h3>{group.label}</h3>
                <div>
                  {group.items.map((item) => (
                    <button type="button" key={item.id} onClick={() => onChooseTool(item.id)}>
                      {item.label}<span aria-hidden="true"><SiteIcon name="next" size={16} /></span>
                    </button>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className={`${styles.dashboardSection} ${styles.dashboardQueues}`} aria-labelledby="dashboard-queues-title">
          <div className={styles.dashboardSectionHeading}>
            <span>Черги</span>
            <h2 id="dashboard-queues-title">Потребує уваги</h2>
          </div>
          <a href={librarianSectionHref("visits", telegramMiniApp)}><span><strong>Графік відвідувань</strong><small>Записи на сьогодні</small></span><span className={styles.dashboardQueueCount}>{attentionUnavailable ? "—" : attention?.visitsToday ?? "…"}</span><span aria-hidden="true"><SiteIcon name="next" size={18} /></span></a>
          <a href={librarianSectionHref("orders", telegramMiniApp)}><span><strong>Замовлення вчителів</strong><small>Нові заявки</small></span><span className={styles.dashboardQueueCount}>{attentionUnavailable ? "—" : attention?.newTeacherOrders ?? "…"}</span><span aria-hidden="true"><SiteIcon name="next" size={18} /></span></a>
          <a href={librarianSectionHref("acquisitions", telegramMiniApp)}><span><strong>Комплектування фонду</strong><small>Активні пропозиції й дозамовлення</small></span><span className={styles.dashboardQueueCount}>{attentionUnavailable ? "—" : attention?.activeAcquisitions ?? "…"}</span><span aria-hidden="true"><SiteIcon name="next" size={18} /></span></a>
        </section>
      </div>
    </div>
  );
}

function CatalogSearch({
  filters,
  onFilters,
  items,
  state,
  error,
  rubrics,
  subjects,
  publicationTypes,
  facetsState,
  suggestionsReady,
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
  rubrics: string[];
  subjects: string[];
  publicationTypes: string[];
  facetsState: LoadState;
  suggestionsReady: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const normalizedQuery = filters.q.trim();
  const titleQueryTokens = normalizedQuery.toLocaleLowerCase("uk-UA").split(/\s+/u).filter(Boolean);
  const suggestions = normalizedQuery.length >= 2 && suggestionsReady
    ? items.filter((item) => {
      const normalizedTitle = item.title.toLocaleLowerCase("uk-UA");
      return titleQueryTokens.every((token) => normalizedTitle.includes(token));
    }).slice(0, 6)
    : [];
  const suggestionsVisible = suggestionsOpen && suggestions.length > 0;
  const activeSuggestionItem = activeSuggestion >= 0
    ? suggestions[activeSuggestion] ?? null
    : null;

  function update<K extends keyof CatalogSearchFilters>(
    key: K,
    value: CatalogSearchFilters[K],
  ) {
    setActiveSuggestion(-1);
    onFilters({ ...filters, [key]: value });
  }

  function selectSuggestion(item: CatalogMaterial) {
    setSuggestionsOpen(false);
    setActiveSuggestion(-1);
    onSelect(item.id);
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      if (suggestionsOpen) event.preventDefault();
      setSuggestionsOpen(false);
      setActiveSuggestion(-1);
      return;
    }
    if (event.key === "Tab") {
      setSuggestionsOpen(false);
      setActiveSuggestion(-1);
      return;
    }
    if (!suggestions.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSuggestionsOpen(true);
      setActiveSuggestion((current) => (current + 1) % suggestions.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSuggestionsOpen(true);
      setActiveSuggestion((current) =>
        current <= 0 ? suggestions.length - 1 : current - 1
      );
      return;
    }
    if (
      event.key === "Enter"
      && suggestionsVisible
      && activeSuggestionItem
    ) {
      event.preventDefault();
      selectSuggestion(activeSuggestionItem);
    }
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

      <div
        className={styles.searchCombobox}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setSuggestionsOpen(false);
            setActiveSuggestion(-1);
          }
        }}
      >
        <label className={styles.searchField}>
          <span className={styles.srOnly}>Пошук за назвою, автором, ISBN або CAT-ID</span>
          <span aria-hidden="true"><SiteIcon name="search" /></span>
          <input
            type="search"
            role="combobox"
            value={filters.q}
            onChange={(event) => {
              update("q", event.target.value);
              setSuggestionsOpen(true);
              setActiveSuggestion(-1);
            }}
            onFocus={() => setSuggestionsOpen(true)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Назва, автор, ISBN або CAT-ID"
            autoComplete="off"
            aria-autocomplete="list"
            aria-expanded={suggestionsVisible}
            aria-controls="catalog-title-suggestions"
            aria-activedescendant={
              suggestionsVisible && activeSuggestionItem
                ? `catalog-suggestion-${activeSuggestionItem.id}`
                : undefined
            }
            aria-describedby="catalog-suggestion-help"
          />
        </label>
        <span id="catalog-suggestion-help" className={styles.srOnly}>
          Під час введення з’являться підказки. Переміщуйтеся стрілками та натисніть Enter, щоб відкрити матеріал.
        </span>
        {suggestionsVisible ? (
          <div
            id="catalog-title-suggestions"
            className={styles.suggestions}
            role="listbox"
            aria-label="Підказки матеріалів"
          >
            {suggestions.map((item, index) => (
              <button
                id={`catalog-suggestion-${item.id}`}
                key={item.id}
                className={index === activeSuggestion ? styles.suggestionActive : styles.suggestion}
                type="button"
                role="option"
                aria-selected={index === activeSuggestion}
                onMouseEnter={() => setActiveSuggestion(index)}
                onClick={() => selectSuggestion(item)}
              >
                <Cover material={item} />
                <span>
                  <strong>{item.title}</strong>
                  <small>
                    {[item.author || "Автор не вказаний", item.year ? String(item.year) : "Рік не вказано"]
                      .join(" · ")}
                  </small>
                  <code>{item.id}</code>
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <details className={styles.filters}>
        <summary>Фільтри рубрики, класу, предмета й типу</summary>
        <div className={styles.filterGrid}>
          <label>
            <span>Рубрика</span>
            <select
              value={filters.rubric}
              onChange={(event) => update("rubric", event.target.value)}
            >
              <option value="">Усі</option>
              {rubrics.map((rubric) => (
                <option key={rubric} value={rubric}>{rubric}</option>
              ))}
            </select>
            {facetsState === "loading" ? (
              <small className={styles.filterHint}>Оновлюємо список рубрик…</small>
            ) : null}
            {facetsState === "error" ? (
              <small className={styles.filterError}>Рубрики тимчасово недоступні.</small>
            ) : null}
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
          <label className={styles.autocompleteFilter}>
            <span>Предмет</span>
            <input
              type="search"
              list="catalog-subject-options"
              value={filters.subject}
              onChange={(event) => update("subject", event.target.value)}
              placeholder="Наприклад, математика"
              autoComplete="off"
              aria-autocomplete="list"
              aria-describedby="catalog-subject-filter-hint"
            />
            <datalist id="catalog-subject-options">
              {subjects.map((subject) => (
                <option key={subject} value={subject} />
              ))}
            </datalist>
            {facetsState === "loading" ? (
              <small id="catalog-subject-filter-hint" className={styles.filterHint}>
                Оновлюємо список предметів…
              </small>
            ) : null}
            {facetsState === "ready" ? (
              <small id="catalog-subject-filter-hint" className={styles.filterHint}>
                Почніть вводити — з’являться предмети з каталогу.
              </small>
            ) : null}
            {facetsState === "error" ? (
              <small id="catalog-subject-filter-hint" className={styles.filterError}>
                Підказки недоступні. Введіть повну назву предмета вручну.
              </small>
            ) : null}
          </label>
          <label className={styles.autocompleteFilter}>
            <span>Тип видання</span>
            <input
              type="search"
              list="catalog-publication-type-options"
              value={filters.publicationType}
              onChange={(event) => update("publicationType", event.target.value)}
              placeholder="Підручник, атлас…"
              autoComplete="off"
              aria-autocomplete="list"
              aria-describedby="catalog-publication-type-filter-hint"
            />
            <datalist id="catalog-publication-type-options">
              {publicationTypes.map((publicationType) => (
                <option key={publicationType} value={publicationType} />
              ))}
            </datalist>
            {facetsState === "loading" ? (
              <small id="catalog-publication-type-filter-hint" className={styles.filterHint}>
                Оновлюємо список типів видань…
              </small>
            ) : null}
            {facetsState === "ready" ? (
              <small id="catalog-publication-type-filter-hint" className={styles.filterHint}>
                Почніть вводити — з’являться типи видань із каталогу.
              </small>
            ) : null}
            {facetsState === "error" ? (
              <small id="catalog-publication-type-filter-hint" className={styles.filterError}>
                Підказки недоступні. Введіть повну назву типу видання вручну.
              </small>
            ) : null}
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
          <span aria-hidden="true"><SiteIcon name="search" size={22} /></span>
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

function MaterialActionContext({
  detail,
  tool,
  onBack,
}: {
  detail: MaterialDetail;
  tool: MaterialActionTool;
  onBack: () => void;
}) {
  const action = MATERIAL_ACTION_ITEMS.find((item) => item.id === tool);
  return (
    <header className={styles.materialActionContext}>
      <div className={styles.materialActionThumbnail}>
        {detail.cover?.url || detail.thumbnailUrl
          ? <img src={detail.cover?.url || detail.thumbnailUrl} alt="" />
          : <span aria-hidden="true">Б</span>}
      </div>
      <div>
        <span>{action?.label ?? "Дія з матеріалом"} · {detail.id}</span>
        <strong>{detail.title}</strong>
        <small>{detail.availableQuantity} доступно з {detail.totalQuantity}</small>
      </div>
      <button type="button" onClick={onBack}><SiteIcon name="previous" size={17} /> До картки</button>
    </header>
  );
}

type MaterialCardTab = "overview" | "holdings" | "links";

function MaterialCard({
  detail,
  state,
  error,
  editing,
  onEditing,
  writesEnabled,
  onSaved,
  onNotice,
  onArchived,
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
  onArchived: (materialId: string) => void;
  onChooseTool: (tool: Tool) => void;
}) {
  const [activeTab, setActiveTab] = useState<MaterialCardTab>("overview");

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
        onArchived={onArchived}
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
          <div className={styles.detailActionGrid} aria-label="Дії з матеріалом">
            <button
              className={styles.primaryButton}
              type="button"
              disabled={!writesEnabled}
              onClick={() => onChooseTool("issue")}
            >
              <SiteIcon name="issue-teacher" size={18} /> Видати
            </button>
            <button className={styles.primaryButton} type="button" disabled={!writesEnabled} onClick={() => onChooseTool("receipt")}>
              <SiteIcon name="receipt" size={18} /> Додати примірники
            </button>
            <button className={styles.secondaryButton} type="button" disabled={!writesEnabled} onClick={() => onChooseTool("transfer")}>
              <SiteIcon name="transfer" size={18} /> Перемістити
            </button>
            <button className={styles.secondaryButton} type="button" disabled={!writesEnabled} onClick={() => onChooseTool("count")}>
              <SiteIcon name="count" size={18} /> Звірити
            </button>
            <button className={styles.secondaryButton} type="button" disabled={!writesEnabled} onClick={() => onChooseTool("writeoff")}>
              <SiteIcon name="writeoff" size={18} /> Списати
            </button>
            <button
              className={styles.secondaryButton}
              type="button"
              disabled={!writesEnabled || typeof detail.version !== "number"}
              onClick={() => onEditing(true)}
            >
              <SiteIcon name="edit" size={18} /> Редагувати
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
        {detail.reservedQuantity ? <StockStat label="Зарезервовано" value={detail.reservedQuantity} /> : null}
      </div>

      <nav className={styles.materialTabs} aria-label="Картка матеріалу">
        <button type="button" aria-pressed={activeTab === "overview"} onClick={() => setActiveTab("overview")}>Огляд</button>
        <button type="button" aria-pressed={activeTab === "holdings"} onClick={() => setActiveTab("holdings")}>Примірники <span>{detail.holdings.length}</span></button>
        <button type="button" aria-pressed={activeTab === "links"} onClick={() => setActiveTab("links")}>Посилання <span>{detail.links.length}</span></button>
      </nav>

      {activeTab === "overview" ? <section className={styles.detailSection}>
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
      </section> : null}

      {activeTab === "holdings" ? <section className={styles.detailSection}>
        <div className={styles.sectionTitle}>
          <h3>Примірники й розміщення</h3>
          <span>{detail.holdings.length}</span>
        </div>
        {detail.holdings.length ? (
          <div className={styles.holdingList}>
            {detail.holdings.map((holding) => (
              <article key={holdingKey(holding)}>
                <span aria-hidden="true"><SiteIcon name="location" size={18} /></span>
                <div>
                  <strong>{holding.locationName}</strong>
                  <small>{conditionLabel(holding.condition)}</small>
                </div>
                <b>{holding.availableQuantity}</b>
                {holding.reservedQuantity > 0 ? (
                  <small>Фізично {holding.physicalQuantity} · у резерві {holding.reservedQuantity}</small>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <p className={styles.mutedText}>Місця з ненульовим залишком відсутні.</p>
        )}
      </section> : null}

      {activeTab === "links" ? <section className={styles.detailSection}>
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
                <span aria-hidden="true"><SiteIcon name="external" size={18} /></span>
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
      </section> : null}
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
  chooseFromUrl: (url: string) => Promise<void>;
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

  async function chooseFromUrl(url: string) {
    const value = url.trim();
    if (!value) return;
    setNormalizing(true);
    setError("");
    try {
      const response = await fetch(`/api/librarian/cover-photo/remote?url=${encodeURIComponent(value)}`, {
        headers: { accept: "image/jpeg,image/png,image/webp" },
        credentials: "same-origin",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || "Не вдалося завантажити обкладинку.");
      }
      const blob = await response.blob();
      const extension = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
      await choose(new File([blob], `isbn-cover.${extension}`, { type: blob.type }));
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
    chooseFromUrl,
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
  const [remoteUrl, setRemoteUrl] = useState("");
  const [editorFile, setEditorFile] = useState<File | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorError, setEditorError] = useState("");
  const [sourcePreviewUrl, setSourcePreviewUrl] = useState("");
  const previewUrl = upload.previewUrl || currentUrl;
  const pickerDisabled = disabled || upload.normalizing || editorBusy;

  useEffect(() => () => {
    if (sourcePreviewUrl) URL.revokeObjectURL(sourcePreviewUrl);
  }, [sourcePreviewUrl]);

  function choosePhoto(input: HTMLInputElement) {
    const file = input.files?.[0] ?? null;
    input.value = "";
    if (!file) return;
    setEditorFile(file);
    setSourcePreviewUrl(URL.createObjectURL(file));
    setEditorError("");
    setEditorOpen(true);
  }

  async function applyPhotoEdit(edit: CoverPhotoEdit) {
    if (!editorFile) return;
    setEditorBusy(true);
    setEditorError("");
    try {
      const edited = await editCoverPhotoForUpload(editorFile, edit);
      await upload.choose(edited);
      setEditorOpen(false);
    } catch (error) {
      setEditorError(errorMessage(error));
    } finally {
      setEditorBusy(false);
    }
  }

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
          <label className={styles.secondaryButton} aria-disabled={pickerDisabled}>
            Зробити фото
            <input
              type="file"
              accept="image/*"
              capture="environment"
              aria-label="Зробити фото обкладинки камерою"
              disabled={pickerDisabled}
              onChange={(event) => choosePhoto(event.currentTarget)}
            />
          </label>
          <label className={styles.secondaryButton} aria-disabled={pickerDisabled}>
            Обрати з галереї
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              aria-label="Обрати фото обкладинки з галереї"
              disabled={pickerDisabled}
              onChange={(event) => choosePhoto(event.currentTarget)}
            />
          </label>
          {upload.file && editorFile ? (
            <button type="button" className={styles.secondaryButton} disabled={pickerDisabled} onClick={() => {
              setEditorError("");
              setEditorOpen(true);
            }}>Редагувати фото</button>
          ) : null}
          {upload.file ? <button type="button" className={styles.secondaryButton} disabled={disabled} onClick={upload.clear}>Прибрати нове фото</button> : null}
        </div>
        <div className={styles.remoteCoverActions}>
          <input
            type="url"
            value={remoteUrl}
            disabled={disabled || upload.normalizing}
            onChange={(event) => setRemoteUrl(event.target.value)}
            placeholder="Посилання на фото з Google Books або Open Library"
            aria-label="Посилання на обкладинку"
          />
          <button type="button" className={styles.secondaryButton} disabled={disabled || upload.normalizing || !remoteUrl.trim()} onClick={() => void upload.chooseFromUrl(remoteUrl)}>
            Завантажити із сайту
          </button>
        </div>
        <small className={styles.remoteCoverHint}>Для інших сайтів збережіть дозволене фото на пристрій і скористайтеся «Обрати фото».</small>
        {editorError ? <InlineMessage tone="error">{editorError}</InlineMessage> : null}
      </div>
      {editorOpen && editorFile && sourcePreviewUrl ? (
        <CoverPhotoEditorModal
          previewUrl={sourcePreviewUrl}
          busy={editorBusy}
          onApply={(edit) => void applyPhotoEdit(edit)}
          onClose={() => {
            if (!editorBusy) setEditorOpen(false);
          }}
        />
      ) : null}
    </section>
  );
}

function CoverPhotoEditorModal({
  previewUrl,
  busy,
  onApply,
  onClose,
}: {
  previewUrl: string;
  busy: boolean;
  onApply: (edit: CoverPhotoEdit) => void;
  onClose: () => void;
}) {
  const [rotation, setRotation] = useState<CoverPhotoEdit["rotation"]>(0);
  const [zoom, setZoom] = useState(1);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [onClose]);

  function rotate(direction: -90 | 90) {
    setRotation((current) => {
      const next = (current + direction + 360) % 360;
      return next as CoverPhotoEdit["rotation"];
    });
  }

  return (
    <div className={styles.coverEditorBackdrop} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section className={styles.coverEditor} role="dialog" aria-modal="true" aria-labelledby="cover-editor-title">
        <header>
          <div>
            <small>Редактор фото</small>
            <h3 id="cover-editor-title">Підготуйте обкладинку</h3>
          </div>
          <button ref={closeRef} type="button" disabled={busy} onClick={onClose} aria-label="Закрити редактор">×</button>
        </header>
        <div className={styles.coverEditorWorkspace}>
          <div className={styles.coverEditorPreview}>
            <img
              src={previewUrl}
              alt="Попередній перегляд кадрування"
              style={{
                transform: `translate(${offsetX * 18}%, ${offsetY * 18}%) rotate(${rotation}deg) scale(${zoom})`,
              }}
            />
            <span aria-hidden="true" />
          </div>
          <div className={styles.coverEditorControls}>
            <div className={styles.coverEditorRotate}>
              <button type="button" disabled={busy} onClick={() => rotate(-90)}>↺ Повернути ліворуч</button>
              <button type="button" disabled={busy} onClick={() => rotate(90)}>↻ Повернути праворуч</button>
            </div>
            <label>
              <span>Масштаб</span>
              <input type="range" min="1" max="2.5" step="0.05" value={zoom} disabled={busy} onChange={(event) => setZoom(Number(event.target.value))} />
            </label>
            <label>
              <span>По горизонталі</span>
              <input type="range" min="-1" max="1" step="0.05" value={offsetX} disabled={busy} onChange={(event) => setOffsetX(Number(event.target.value))} />
            </label>
            <label>
              <span>По вертикалі</span>
              <input type="range" min="-1" max="1" step="0.05" value={offsetY} disabled={busy} onChange={(event) => setOffsetY(Number(event.target.value))} />
            </label>
            <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => {
              setRotation(0);
              setZoom(1);
              setOffsetX(0);
              setOffsetY(0);
            }}>Скинути</button>
          </div>
        </div>
        <footer>
          <button type="button" className={styles.secondaryButton} disabled={busy} onClick={onClose}>Скасувати</button>
          <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => onApply({ rotation, zoom, offsetX, offsetY })}>
            {busy ? "Готуємо фото…" : "Застосувати фото"}
          </button>
        </footer>
      </section>
    </div>
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
  onArchived,
}: {
  detail: MaterialDetail;
  writesEnabled: boolean;
  onCancel: () => void;
  onCompleted: () => Promise<void>;
  onPartialUnknown: (message: string) => void;
  onArchived: (materialId: string) => void;
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
  const [archiving, setArchiving] = useState(false);
  const [archiveUncertain, setArchiveUncertain] = useState(false);
  const [message, setMessage] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const coverUpload = useDirectCoverUpload();
  const archiveRequestId = useRef<string | null>(null);

  function update<K extends keyof MaterialEditDraft>(key: K, value: MaterialEditDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function applyBookCandidate(candidate: BookLookupCandidate) {
    setDraft((current) => mergeBookLookupDraft(current, candidate));
    setLinks((current) => mergeBookLookupLink(current, candidate));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (archiving || !writesEnabled || typeof detail.version !== "number") return;
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

  async function archiveMaterial() {
    if (saving || archiving || !writesEnabled || typeof detail.version !== "number") return;
    if (!archiveUncertain) {
      const confirmed = window.confirm(
        `Видалити ${detail.id} «${detail.title}» з каталогу?\n\nМатеріал зникне з пошуку та публічного каталогу після оновлення кешу (зазвичай до 10 хвилин). CAT-ID й історія операцій залишаться в базі. Незбережені зміни у формі буде втрачено.`,
      );
      if (!confirmed) return;
    }

    setArchiving(true);
    setMessage("");
    setFieldErrors({});
    const requestId = archiveRequestId.current ?? crypto.randomUUID();
    archiveRequestId.current = requestId;
    try {
      await apiJson<MutationEnvelope<{
        materialId: string;
        version: number;
        archivedAt: string;
      }>>(`/api/librarian/materials/${encodeURIComponent(detail.id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId,
          expectedVersion: detail.version,
        }),
      });
      archiveRequestId.current = null;
      setArchiveUncertain(false);
      coverUpload.clear();
      onArchived(detail.id);
    } catch (error) {
      if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
      const uncertain = !isDefinitiveArchiveFailure(error);
      setArchiveUncertain(uncertain);
      if (!uncertain) archiveRequestId.current = null;
      setMessage(errorMessage(error));
    } finally {
      setArchiving(false);
    }
  }

  return (
    <form className={styles.editForm} onSubmit={submit} aria-busy={saving || archiving}>
      <div className={styles.formHeading}>
        <div>
          <p>{detail.id}</p>
          <h2>Редагування матеріалу</h2>
          <small>Зміни зберігаються одразу, без проміжної чернетки.</small>
        </div>
        <button
          type="button"
          aria-label="Закрити редагування"
          disabled={saving || archiving}
          onClick={onCancel}
        >
          <SiteIcon name="close" size={20} />
        </button>
      </div>

      <fieldset className={styles.editFields} disabled={saving || archiving}>
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
          <IsbnLookupAssist
            isbn={draft.isbn}
            onIsbn={(value) => update("isbn", value)}
            onApply={applyBookCandidate}
            onCover={(candidate) => void coverUpload.chooseFromUrl(candidate.coverUrl)}
            disabled={saving || archiving}
          />
        </div>
        <EditField label="Примітка" error={fieldError(fieldErrors, "notes")} wide>
          <textarea rows={4} value={draft.notes} onChange={(event) => update("notes", event.target.value)} />
        </EditField>
        <div className={styles.fieldWide}>
          <CoverPhotoField
            upload={coverUpload}
            currentUrl={detail.cover?.url || detail.thumbnailUrl}
            disabled={!writesEnabled || saving || archiving}
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
      </fieldset>

      {message ? (
        <InlineMessage tone={message === "Матеріал оновлено." ? "success" : "error"}>
          {message}
        </InlineMessage>
      ) : null}
      {coverUpload.error ? <InlineMessage tone="error">{coverUpload.error}</InlineMessage> : null}

      <div className={styles.formActions}>
        <button className={styles.secondaryButton} type="button" disabled={saving || archiving} onClick={onCancel}>Скасувати</button>
        <button
          className={styles.primaryButton}
          type="submit"
          disabled={saving || archiving || coverUpload.normalizing || !writesEnabled || typeof detail.version !== "number"}
        >
          {saving ? "Зберігаємо…" : "Зберегти зміни"}
        </button>
      </div>

      <section
        className={styles.dangerZone}
        aria-labelledby={`archive-title-${detail.id}`}
        aria-describedby={`archive-help-${detail.id}`}
      >
        <div>
          <h3 id={`archive-title-${detail.id}`}>Видалення матеріалу</h3>
          <p id={`archive-help-${detail.id}`}>
            Матеріал зникне з пошуку та публічного каталогу після оновлення кешу (зазвичай до 10 хвилин). CAT-ID й історія операцій залишаться в базі.
          </p>
          {detail.totalQuantity > 0 || detail.loanedQuantity > 0 ? (
            <small>
              Зараз в обліку {detail.totalQuantity} примірн., видано {detail.loanedQuantity}.
              Спочатку поверніть видане та встановіть фактичний залишок 0 або виконайте списання.
            </small>
          ) : null}
        </div>
        <button
          className={styles.dangerButton}
          type="button"
          disabled={
            saving
            || archiving
            || coverUpload.normalizing
            || !writesEnabled
            || detail.totalQuantity > 0
            || detail.loanedQuantity > 0
          }
          onClick={() => void archiveMaterial()}
        >
          {archiving
            ? "Видаляємо…"
            : archiveUncertain
              ? "Перевірити видалення"
              : "Видалити матеріал"}
        </button>
      </section>
    </form>
  );
}

function MaterialCreatePanel({
  writesEnabled,
  locations,
  referenceState,
  referenceError,
  rubrics,
  subjects,
  publicationTypes,
  facetsState,
  initialPrefill,
  onCreated,
  onOpenExisting,
  onOpenMaterial,
}: {
  writesEnabled: boolean;
  locations: LibraryLocation[];
  referenceState: LoadState;
  referenceError: string;
  rubrics: string[];
  subjects: string[];
  publicationTypes: string[];
  facetsState: LoadState;
  initialPrefill: AcquisitionMaterialPrefill | null;
  onCreated: (materialId: string) => Promise<void>;
  onOpenExisting: (materialId: string) => void;
  onOpenMaterial: () => void;
}) {
  const [draft, setDraft] = useState<MaterialEditDraft>(() => initialPrefill ? {
    ...emptyMaterialDraft(), title: initialPrefill.title, author: initialPrefill.author,
    publicationYear: initialPrefill.publicationYear, subject: initialPrefill.subject,
  } : emptyMaterialDraft());
  const [links, setLinks] = useState<EditableLinkDraft[]>(() => initialPrefill && /^https?:\/\//iu.test(initialPrefill.sourceUrl)
    ? [{ key: crypto.randomUUID(), id: null, kind: "store", label: "Джерело пропозиції", url: initialPrefill.sourceUrl, isPublic: false }]
    : []);
  const parsedPrefillQuantity = Number(initialPrefill?.quantity ?? "");
  const validPrefillQuantity = Number.isSafeInteger(parsedPrefillQuantity) && parsedPrefillQuantity > 0 && parsedPrefillQuantity <= 1_000;
  const [withReceipt, setWithReceipt] = useState(validPrefillQuantity);
  const countableLocations = locations.filter((location) => location.type !== "service");
  const [locationId, setLocationId] = useState("");
  const effectiveLocationId = locationId || countableLocations[0]?.id || "";
  const [condition, setCondition] = useState("good");
  const [quantity, setQuantity] = useState(() => validPrefillQuantity ? String(parsedPrefillQuantity) : "1");
  const [occurredAt, setOccurredAt] = useState(() => todayInKyiv());
  const [documentNumber, setDocumentNumber] = useState("");
  const [receiptNotes, setReceiptNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [createdId, setCreatedId] = useState("");
  const [titleSuggestions, setTitleSuggestions] = useState<CatalogMaterial[]>([]);
  const [titleSuggestionsState, setTitleSuggestionsState] = useState<LoadState>("idle");
  const [titleSuggestionsOpen, setTitleSuggestionsOpen] = useState(false);
  const [activeTitleSuggestion, setActiveTitleSuggestion] = useState(-1);
  const [chosenExistingId, setChosenExistingId] = useState("");
  const coverUpload = useDirectCoverUpload();

  const titleQuery = draft.title.trim();
  const normalizedTitleQuery = titleQuery.toLocaleLowerCase("uk-UA");
  const titleQueryTokens = normalizedTitleQuery.split(/\s+/u).filter(Boolean);
  const visibleTitleSuggestions = titleQuery.length >= 2
    ? titleSuggestions.filter((item) => {
      const normalizedTitle = item.title.toLocaleLowerCase("uk-UA");
      return titleQueryTokens.every((token) => normalizedTitle.includes(token));
    }).slice(0, 6)
    : [];
  const titleSuggestionsVisible = titleSuggestionsOpen && visibleTitleSuggestions.length > 0;
  const activeTitleSuggestionItem = activeTitleSuggestion >= 0
    ? visibleTitleSuggestions[activeTitleSuggestion] ?? null
    : null;
  const duplicateCandidate = titleSuggestions.find((item) => item.id === chosenExistingId)
    ?? titleSuggestions.find((item) => item.title.trim().toLocaleLowerCase("uk-UA") === normalizedTitleQuery)
    ?? null;

  useEffect(() => {
    const controller = new AbortController();
    const query = draft.title.trim();
    const timer = window.setTimeout(async () => {
      if (query.length < 2) {
        setTitleSuggestions([]);
        setTitleSuggestionsState("idle");
        setTitleSuggestionsOpen(false);
        setActiveTitleSuggestion(-1);
        return;
      }
      setTitleSuggestionsState("loading");
      try {
        const response = await apiJson<SearchEnvelope>(
          buildMaterialTitleSuggestionUrl(query),
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        const tokens = query.toLocaleLowerCase("uk-UA").split(/\s+/u).filter(Boolean);
        setTitleSuggestions(response.items.filter((item) => {
          const normalizedTitle = item.title.toLocaleLowerCase("uk-UA");
          return tokens.every((token) => normalizedTitle.includes(token));
        }).slice(0, 6));
        setActiveTitleSuggestion(-1);
        setTitleSuggestionsState("ready");
      } catch {
        if (controller.signal.aborted) return;
        setTitleSuggestions([]);
        setActiveTitleSuggestion(-1);
        setTitleSuggestionsState("error");
      }
    }, query.length < 2 ? 0 : 220);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [draft.title]);

  function update<K extends keyof MaterialEditDraft>(key: K, value: MaterialEditDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function updateTitle(value: string) {
    setChosenExistingId("");
    setActiveTitleSuggestion(-1);
    setTitleSuggestionsOpen(true);
    setTitleSuggestionsState(value.trim().length >= 2 ? "loading" : "idle");
    if (value.trim().length < 2) setTitleSuggestions([]);
    update("title", value);
  }

  function selectTitleSuggestion(item: CatalogMaterial) {
    setDraft((current) => ({ ...current, title: item.title }));
    setChosenExistingId(item.id);
    setTitleSuggestionsOpen(false);
    setActiveTitleSuggestion(-1);
  }

  function handleTitleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      if (titleSuggestionsOpen) event.preventDefault();
      setTitleSuggestionsOpen(false);
      setActiveTitleSuggestion(-1);
      return;
    }
    if (event.key === "Tab") {
      setTitleSuggestionsOpen(false);
      setActiveTitleSuggestion(-1);
      return;
    }
    if (!visibleTitleSuggestions.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setTitleSuggestionsOpen(true);
      setActiveTitleSuggestion((current) => (current + 1) % visibleTitleSuggestions.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setTitleSuggestionsOpen(true);
      setActiveTitleSuggestion((current) => current <= 0
        ? visibleTitleSuggestions.length - 1
        : current - 1);
      return;
    }
    if (event.key === "Enter" && titleSuggestionsVisible) {
      event.preventDefault();
      selectTitleSuggestion(activeTitleSuggestionItem ?? visibleTitleSuggestions[0]);
    }
  }

  function applyBookCandidate(candidate: BookLookupCandidate) {
    setChosenExistingId("");
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
    setChosenExistingId("");
    setTitleSuggestionsOpen(false);
    setActiveTitleSuggestion(-1);
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
        <div
          className={`${styles.fieldWide} ${styles.createTitleField}`}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) {
              setTitleSuggestionsOpen(false);
              setActiveTitleSuggestion(-1);
            }
          }}
        >
          <label htmlFor="create-material-title">Назва <b aria-hidden="true">*</b></label>
          <div className={styles.createTitleInputWrap}>
            <input
              id="create-material-title"
              type="search"
              role="combobox"
              value={draft.title}
              onChange={(event) => updateTitle(event.target.value)}
              onFocus={() => setTitleSuggestionsOpen(true)}
              onKeyDown={handleTitleKeyDown}
              required
              autoComplete="off"
              aria-autocomplete="list"
              aria-expanded={titleSuggestionsVisible}
              aria-controls="create-material-title-suggestions"
              aria-activedescendant={
                titleSuggestionsVisible && activeTitleSuggestionItem
                  ? `create-title-suggestion-${activeTitleSuggestionItem.id}`
                  : undefined
              }
              aria-describedby="create-material-title-help"
              aria-invalid={Boolean(fieldError(fieldErrors, "title"))}
            />
            {titleSuggestionsVisible ? (
              <div
                id="create-material-title-suggestions"
                className={`${styles.suggestions} ${styles.createTitleSuggestions}`}
                role="listbox"
                aria-label="Схожі матеріали в каталозі"
              >
                {visibleTitleSuggestions.map((item, index) => (
                  <button
                    id={`create-title-suggestion-${item.id}`}
                    key={item.id}
                    className={index === activeTitleSuggestion ? styles.suggestionActive : styles.suggestion}
                    type="button"
                    role="option"
                    aria-selected={index === activeTitleSuggestion}
                    onMouseEnter={() => setActiveTitleSuggestion(index)}
                    onClick={() => selectTitleSuggestion(item)}
                  >
                    <Cover material={item} />
                    <span>
                      <strong>{item.title}</strong>
                      <small>{[item.author || "Автора не вказано", item.year ? String(item.year) : "Рік не вказано"].join(" · ")}</small>
                      <code>{item.id}</code>
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <small id="create-material-title-help" className={titleSuggestionsState === "error" ? styles.filterError : styles.filterHint}>
            {titleSuggestionsState === "loading"
              ? "Шукаємо схожі назви…"
              : titleSuggestionsState === "error"
                ? "Підказки тимчасово недоступні. Назву можна ввести вручну."
                : "Введіть щонайменше 2 літери — з’являться схожі матеріали з каталогу."}
          </small>
          {fieldError(fieldErrors, "title") ? <small className={styles.fieldError}>{fieldError(fieldErrors, "title")}</small> : null}
        </div>
        {titleQuery.length >= 2 && titleSuggestionsState === "ready" && visibleTitleSuggestions.length > 0 ? (
          <div className={`${styles.fieldWide} ${styles.duplicateWarning}`} role="status" aria-live="polite">
            <span aria-hidden="true"><SiteIcon name="error" size={18} /></span>
            <span>
              <strong>{duplicateCandidate ? "Такий матеріал уже є в каталозі" : "У каталозі є схожі назви"}</strong>
              <small>{duplicateCandidate
                ? `${duplicateCandidate.title} · ${duplicateCandidate.id}. Перевірте картку перед створенням дубліката.`
                : "Виберіть назву зі списку або продовжте вводити нову."}</small>
            </span>
            {duplicateCandidate ? (
              <button type="button" onClick={() => onOpenExisting(duplicateCandidate.id)}>Відкрити картку</button>
            ) : null}
          </div>
        ) : null}
        <EditField label="Автор" error={fieldError(fieldErrors, "author")} wide>
          <input value={draft.author} onChange={(event) => update("author", event.target.value)} />
        </EditField>
        <EditField label="Рубрика" required error={fieldError(fieldErrors, "rubric")}>
          <input
            type="search"
            list="create-material-rubric-options"
            value={draft.rubric}
            onChange={(event) => update("rubric", event.target.value)}
            required
            autoComplete="off"
            aria-autocomplete="list"
            aria-describedby="create-material-rubric-hint"
          />
          <datalist id="create-material-rubric-options">
            {rubrics.map((rubric) => <option key={rubric} value={rubric} />)}
          </datalist>
          <small id="create-material-rubric-hint" className={facetsState === "error" ? styles.filterError : styles.filterHint}>
            {facetInputHint(facetsState, "рубрик")}
          </small>
        </EditField>
        <EditField label="Тип видання" error={fieldError(fieldErrors, "publicationType")}>
          <input
            type="search"
            list="create-material-publication-type-options"
            value={draft.publicationType}
            onChange={(event) => update("publicationType", event.target.value)}
            autoComplete="off"
            aria-autocomplete="list"
            aria-describedby="create-material-publication-type-hint"
          />
          <datalist id="create-material-publication-type-options">
            {publicationTypes.map((publicationType) => <option key={publicationType} value={publicationType} />)}
          </datalist>
          <small id="create-material-publication-type-hint" className={facetsState === "error" ? styles.filterError : styles.filterHint}>
            {facetInputHint(facetsState, "типів видань")}
          </small>
        </EditField>
        <EditField label="Предмет" error={fieldError(fieldErrors, "subject")}>
          <input
            type="search"
            list="create-material-subject-options"
            value={draft.subject}
            onChange={(event) => update("subject", event.target.value)}
            autoComplete="off"
            aria-autocomplete="list"
            aria-describedby="create-material-subject-hint"
          />
          <datalist id="create-material-subject-options">
            {subjects.map((subject) => <option key={subject} value={subject} />)}
          </datalist>
          <small id="create-material-subject-hint" className={facetsState === "error" ? styles.filterError : styles.filterHint}>
            {facetInputHint(facetsState, "предметів")}
          </small>
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
          <IsbnLookupAssist
            isbn={draft.isbn}
            onIsbn={(value) => update("isbn", value)}
            onApply={applyBookCandidate}
            onCover={(candidate) => void coverUpload.chooseFromUrl(candidate.coverUrl)}
            disabled={saving || Boolean(createdId)}
          />
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
  // Receipts compare against physical stock; reservations only reduce what can
  // be issued, not the number of copies already present at the location.
  const expectedQuantity = holding?.physicalQuantity ?? 0;
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
        expectedSourceQuantity: source?.physicalQuantity,
        expectedDestinationQuantity: destinationHolding?.physicalQuantity ?? 0,
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
            <input value={source?.physicalQuantity ?? 0} readOnly />
          </EditField>
          <EditField label="У місці призначення зараз">
            <input value={destinationHolding?.physicalQuantity ?? 0} readOnly />
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
      `Списати ${amount} прим. «${detail.title}» з місця «${source?.locationName || ""}»? Залишок зменшиться одразу.`,
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
        expectedQuantity: source?.physicalQuantity,
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
            <input value={source?.physicalQuantity ?? 0} readOnly />
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
  // Inventory counting always starts from the physical quantity. Reserved
  // copies remain on the shelf and must still be counted.
  const expectedQuantity = selected?.physicalQuantity ?? 0;
  const [countedQuantity, setCountedQuantity] = useState(() => String(expectedQuantity));
  const [reason, setReason] = useState("inventory_count");
  const [occurredAt, setOccurredAt] = useState(() => todayInKyiv());
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);
  const visibleHoldings = useMemo(
    () => [...detail.holdings]
      .filter((holding) => (
        holding.physicalQuantity > 0
        || holding.reservedQuantity > 0
        || holding.availableQuantity > 0
      ))
      .sort((left, right) => (
        Number(right.locationStatus === "active" && right.locationType !== "service")
        - Number(left.locationStatus === "active" && left.locationType !== "service")
        || left.locationName.localeCompare(right.locationName, "uk")
        || conditionLabel(left.condition).localeCompare(conditionLabel(right.condition), "uk")
      )),
    [detail.holdings],
  );
  const physicalAtLocations = visibleHoldings.reduce((total, holding) => total + holding.physicalQuantity, 0);

  function chooseLocation(value: string) {
    setLocationId(value);
    const next = holdings.find((holding) => holding.locationId === value);
    const nextCondition = next?.condition || "unspecified";
    setCondition(nextCondition);
    setCountedQuantity(String(next?.physicalQuantity ?? 0));
    setMessage("");
  }

  function chooseCondition(value: string) {
    setCondition(value);
    const next = holdings.find((holding) => holding.locationId === effectiveLocationId && (holding.condition || "unspecified") === value);
    setCountedQuantity(String(next?.physicalQuantity ?? 0));
    setMessage("");
  }

  function chooseHolding(holding: MaterialHolding) {
    setLocationId(holding.locationId);
    setCondition(holding.condition || "unspecified");
    setCountedQuantity(String(holding.physicalQuantity));
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

      <section className={styles.stockDistribution} aria-labelledby="stock-distribution-title">
        <div className={styles.stockDistributionHeading}>
          <div>
            <h3 id="stock-distribution-title">Де знаходяться примірники</h3>
            <p>Натисніть активне місце, щоб одразу підставити його у форму підрахунку.</p>
          </div>
          <div className={styles.stockDistributionTotals} aria-label="Зведена кількість примірників">
            <span><strong>{physicalAtLocations}</strong> на місцях</span>
            <span><strong>{detail.loanedQuantity}</strong> видано</span>
            <span><strong>{detail.reservedQuantity ?? 0}</strong> у резерві</span>
            <span><strong>{detail.availableQuantity}</strong> доступно</span>
          </div>
        </div>
        {visibleHoldings.length ? (
          <div className={styles.stockLocationList}>
            {visibleHoldings.map((holding) => {
              const selectable = holding.locationStatus === "active" && holding.locationType !== "service";
              const active = selectable
                && holding.locationId === effectiveLocationId
                && (holding.condition || "unspecified") === condition;
              const content = (
                <>
                  <span className={styles.stockLocationIcon} aria-hidden="true"><SiteIcon name="locations" size={17} /></span>
                  <span className={styles.stockLocationCopy}>
                    <strong>{holding.locationName}</strong>
                    <small>
                      {conditionLabel(holding.condition)}
                      {holding.locationStatus !== "active" ? " · місце закрите" : ""}
                      {holding.locationType === "service" ? " · службове місце" : ""}
                    </small>
                  </span>
                  <span className={styles.stockLocationFigures}>
                    <strong>{holding.physicalQuantity}</strong>
                    <small>фізично · {holding.reservedQuantity} у резерві · {holding.availableQuantity} доступно</small>
                  </span>
                </>
              );
              return selectable ? (
                <button
                  key={`${holding.locationId}-${holding.condition || "unspecified"}`}
                  className={styles.stockLocationRow}
                  type="button"
                  aria-pressed={active}
                  onClick={() => chooseHolding(holding)}
                >
                  {content}
                </button>
              ) : (
                <article className={`${styles.stockLocationRow} ${styles.stockLocationReadOnly}`} key={`${holding.locationId}-${holding.condition || "unspecified"}`}>
                  {content}
                </article>
              );
            })}
          </div>
        ) : (
          <InlineMessage tone="info">Для цього матеріалу ще немає примірників у місцях зберігання.</InlineMessage>
        )}
      </section>

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
  const issueInFlightRef = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!writesEnabled || !source || !teacherUserId || success || issueInFlightRef.current) return;
    const submittedDueAt = resolveLoanDueAtForSubmission(
      dueAtInputRef.current?.value,
      new FormData(event.currentTarget).get("dueAt"),
      dueAt,
    );
    issueInFlightRef.current = true;
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
      issueInFlightRef.current = false;
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
          disabled={!writesEnabled || !source || !teacherUserId || saving || success || !quantity}
        >
          {saving ? "Оформлюємо…" : success ? "Видано" : "Оформити видачу"}
        </button>
      </div>
    </form>
  );
}

function ClassIssueWorkspace({
  detail,
  detailState,
  detailError,
  writesEnabled,
  teachers,
  referenceState,
  referenceError,
  onSaved,
  onChooseReturn,
}: {
  detail: MaterialDetail | null;
  detailState: LoadState;
  detailError: string;
  writesEnabled: boolean;
  teachers: LibraryTeacher[];
  referenceState: LoadState;
  referenceError: string;
  onSaved: () => Promise<void>;
  onChooseReturn: () => void;
}) {
  const [academicReference, setAcademicReference] = useState<AcademicReferenceEnvelope["referenceData"] | null>(null);
  const [academicState, setAcademicState] = useState<LoadState>("loading");
  const [academicError, setAcademicError] = useState("");
  const [academicReloadToken, setAcademicReloadToken] = useState(0);
  const [classYearId, setClassYearId] = useState("");
  const [responsibleTeacherUserId, setResponsibleTeacherUserId] = useState("");
  const [issuedAt, setIssuedAt] = useState(() => todayInKyiv());
  const [dueAt, setDueAt] = useState("");
  const issuedAtInputRef = useRef<HTMLInputElement>(null);
  const classDueAtInputRef = useRef<HTMLInputElement>(null);
  const [notes, setNotes] = useState("");
  const [sourceKey, setSourceKey] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [cart, setCart] = useState<ClassIssueCartRow[]>([]);
  const [pendingIntent, setPendingIntent] = useState<PendingClassCirculationIntent<ClassIssuePayload> | null>(
    () => readPendingClassCirculationIntent<ClassIssuePayload>("class-issue"),
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"error" | "success" | "info">("info");
  const [lastIssuedClassLoanId, setLastIssuedClassLoanId] = useState("");
  const issueInFlightRef = useRef(false);
  const materialPickerRef = useRef<HTMLElement>(null);
  const lastFocusedMaterialIdRef = useRef("");

  useEffect(() => {
    const controller = new AbortController();
    void apiJson<AcademicReferenceEnvelope>("/api/librarian/academic-reference", {
      signal: controller.signal,
    }).then((response) => {
      setAcademicReference(response.referenceData);
      setAcademicState("ready");
    }).catch((requestError) => {
      if (controller.signal.aborted) return;
      setAcademicState("error");
      setAcademicError(errorMessage(requestError));
    });
    return () => controller.abort();
  }, [academicReloadToken]);

  useEffect(() => {
    if (detailState === "idle" && !detail) {
      lastFocusedMaterialIdRef.current = "";
      return;
    }
    if (
      detailState !== "ready"
      || !detail
      || referenceState !== "ready"
      || academicState !== "ready"
      || lastFocusedMaterialIdRef.current === detail.id
    ) return;
    if (!window.matchMedia("(max-width: 1080px)").matches) return;
    const frame = window.requestAnimationFrame(() => {
      const picker = materialPickerRef.current;
      if (!picker) return;
      picker.focus({ preventScroll: true });
      lastFocusedMaterialIdRef.current = detail.id;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [academicState, detail, detailState, referenceState]);

  const activeClassYears = useMemo(() => {
    if (!academicReference) return [];
    const activeYears = new Set(
      academicReference.academicYears.filter((year) => year.status === "active").map((year) => year.id),
    );
    const activeCohorts = new Set(
      academicReference.cohorts.filter((cohort) => cohort.status === "active").map((cohort) => cohort.id),
    );
    return academicReference.classYears
      .filter((classYear) => (
        classYear.status === "active"
        && activeYears.has(classYear.academicYearId)
        && activeCohorts.has(classYear.cohortId)
      ))
      .sort((left, right) => left.className.localeCompare(right.className, "uk"));
  }, [academicReference]);

  const classYearSelectionIsCurrent = activeClassYears.some(
    (classYear) => classYear.id === classYearId,
  );
  const effectiveClassYearId = classYearSelectionIsCurrent
    ? classYearId
    : activeClassYears[0]?.id || "";
  const selectedClassYear = activeClassYears.find(
    (classYear) => classYear.id === effectiveClassYearId,
  ) ?? null;
  const assignedTeacherUserId = selectedClassYear?.teacherUserId
    && teachers.some((teacher) => teacher.id === selectedClassYear.teacherUserId)
    ? selectedClassYear.teacherUserId
    : "";
  const effectiveResponsibleTeacherUserId = classYearSelectionIsCurrent
    ? responsibleTeacherUserId
    : assignedTeacherUserId;
  const defaultIssuedAt = selectedClassYear
    ? todayInKyiv() < selectedClassYear.startDate
      ? selectedClassYear.startDate
      : todayInKyiv() > selectedClassYear.endDate
        ? selectedClassYear.endDate
        : todayInKyiv()
    : issuedAt;
  const effectiveIssuedAt = classYearSelectionIsCurrent ? issuedAt : defaultIssuedAt;
  const effectiveDueAt = classYearSelectionIsCurrent ? dueAt : selectedClassYear?.endDate || dueAt;

  function chooseClassYear(nextClassYearId: string) {
    const nextClassYear = activeClassYears.find((classYear) => classYear.id === nextClassYearId) ?? null;
    setClassYearId(nextClassYearId);
    setResponsibleTeacherUserId(
      nextClassYear?.teacherUserId
      && teachers.some((teacher) => teacher.id === nextClassYear.teacherUserId)
        ? nextClassYear.teacherUserId
        : "",
    );
    if (!nextClassYear) return;
    const today = todayInKyiv();
    setIssuedAt(
      today < nextClassYear.startDate
        ? nextClassYear.startDate
        : today > nextClassYear.endDate
          ? nextClassYear.endDate
          : today,
    );
    setDueAt(nextClassYear.endDate);
  }

  const availableHoldings = useMemo(() => detail?.holdings.filter(
    (holding) => (
      holding.locationStatus === "active"
      && holding.locationType !== "service"
      && holding.quantity > 0
    ),
  ) ?? [], [detail]);

  const effectiveSourceKey = availableHoldings.some((holding) => holdingKey(holding) === sourceKey)
    ? sourceKey
    : availableHoldings[0] ? holdingKey(availableHoldings[0]) : "";
  const source = availableHoldings.find((holding) => holdingKey(holding) === effectiveSourceKey) ?? null;
  const locked = saving || Boolean(pendingIntent);
  const cartCopies = cart.reduce((total, item) => total + item.quantity, 0);

  function addSelectedMaterial() {
    if (!detail || !source) return;
    const parsedQuantity = Number(quantity);
    if (!Number.isInteger(parsedQuantity) || parsedQuantity < 1 || parsedQuantity > source.quantity) {
      setMessageTone("error");
      setMessage(`Вкажіть від 1 до ${source.quantity} примірників.`);
      return;
    }
    const condition = normalizeCopyCondition(source.condition);
    const key = `${detail.id}\u001e${source.locationId}\u001e${condition}`;
    if (!cart.some((item) => item.key === key) && cart.length >= 100) {
      setMessageTone("error");
      setMessage("Одна видача може містити не більше 100 позицій.");
      return;
    }
    const row: ClassIssueCartRow = {
      key,
      materialId: detail.id,
      materialTitle: detail.title,
      materialAuthor: detail.author,
      materialYear: detail.year,
      thumbnailUrl: detail.thumbnailUrl,
      sourceLocationId: source.locationId,
      sourceLocationName: source.locationName,
      condition,
      quantity: parsedQuantity,
      expectedAvailableQuantity: source.quantity,
    };
    setLastIssuedClassLoanId("");
    setCart((current) => (
      current.some((item) => item.key === key)
        ? current.map((item) => item.key === key ? row : item)
        : [...current, row]
    ));
    setMessageTone("success");
    setMessage(`${detail.title} додано до видачі.`);
  }

  function updateCartQuantity(key: string, nextQuantity: number) {
    setCart((current) => current.map((item) => (
      item.key === key ? { ...item, quantity: nextQuantity } : item
    )));
  }

  async function sendIssueIntent(
    intent: PendingClassCirculationIntent<ClassIssuePayload>,
    alreadyStored: boolean,
  ) {
    if (issueInFlightRef.current) return;
    issueInFlightRef.current = true;
    if (!alreadyStored && !writePendingClassCirculationIntent(intent)) {
      setMessageTone("error");
      setMessage("Не вдалося зберегти безпечний повтор запиту в цьому браузері. Видачу не надіслано.");
      issueInFlightRef.current = false;
      return;
    }
    setPendingIntent(intent);
    setSaving(true);
    setMessageTone("info");
    setMessage(alreadyStored ? "Перевіряємо результат тим самим запитом…" : "Оформлюємо видачу на клас…");
    try {
      const response = await apiJson<MutationEnvelope<ClassLoanMutationResult>>(
        "/api/librarian/class-loans",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(intent.payload),
        },
      );
      clearPendingClassCirculationIntent("class-issue");
      setPendingIntent(null);
      setCart([]);
      setLastIssuedClassLoanId(response.result.classLoanId);
      setMessageTone("success");
      setMessage(response.result.status === "open" ? "Видачу на клас оформлено." : "Операцію збережено.");
      await onSaved();
    } catch (requestError) {
      if (isDefinitiveClassCirculationFailure(requestError)) {
        clearPendingClassCirculationIntent("class-issue");
        setPendingIntent(null);
        setAcademicState("loading");
        setAcademicError("");
        setAcademicReloadToken((value) => value + 1);
        await onSaved();
        setMessageTone("error");
        setMessage(
          requestError instanceof ApiError && requestError.code === "stock_quantity_conflict"
            ? `${errorMessage(requestError)} Приберіть змінену позицію з кошика, виберіть її у каталозі та додайте знову.`
            : `${errorMessage(requestError)} Дані оновлено; перевірте видачу й надішліть її знову.`,
        );
      } else {
        setMessageTone("info");
        setMessage("Відповідь сервера не підтверджена. Не створюйте нову видачу: натисніть «Перевірити результат».");
      }
    } finally {
      issueInFlightRef.current = false;
      setSaving(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!writesEnabled || !selectedClassYear || !effectiveResponsibleTeacherUserId || !cart.length || pendingIntent) return;
    const submittedForm = new FormData(event.currentTarget);
    const submittedIssuedAt = resolveLiveFormTextForSubmission(
      issuedAtInputRef.current?.value,
      submittedForm.get("issuedAt"),
      effectiveIssuedAt,
    ) || effectiveIssuedAt;
    const submittedDueAt = resolveLoanDueAtForSubmission(
      classDueAtInputRef.current?.value,
      submittedForm.get("dueAt"),
      effectiveDueAt,
    );
    if (cart.some((item) => (
      !Number.isInteger(item.quantity)
      || item.quantity < 1
      || item.quantity > item.expectedAvailableQuantity
    ))) {
      setMessageTone("error");
      setMessage("Перевірте кількість у кожній позиції видачі.");
      return;
    }
    if (submittedIssuedAt < selectedClassYear.startDate || submittedIssuedAt > selectedClassYear.endDate) {
      setMessageTone("error");
      setMessage("Дата видачі має бути в межах навчання вибраного класу.");
      return;
    }
    if (submittedDueAt && (submittedDueAt < submittedIssuedAt || submittedDueAt > selectedClassYear.endDate)) {
      setMessageTone("error");
      setMessage("Дата повернення має бути не раніше видачі й не пізніше завершення класу.");
      return;
    }
    const requestId = crypto.randomUUID();
    const payload: ClassIssuePayload = {
      requestId,
      classYearId: selectedClassYear.id,
      expectedClassYearVersion: selectedClassYear.version,
      responsibleTeacherUserId: effectiveResponsibleTeacherUserId,
      issuedAt: submittedIssuedAt,
      dueAt: submittedDueAt,
      notes: notes.trim() || null,
      items: cart.map((item) => ({
        materialId: item.materialId,
        sourceLocationId: item.sourceLocationId,
        condition: item.condition,
        quantity: item.quantity,
        expectedAvailableQuantity: item.expectedAvailableQuantity,
      })),
    };
    await sendIssueIntent({ kind: "class-issue", requestId, payload }, false);
  }

  if (!pendingIntent && (referenceState === "loading" || academicState === "loading")) return <PanelLoading />;
  if (!pendingIntent && referenceState === "error") return <InlineMessage tone="error">{referenceError}</InlineMessage>;
  if (!pendingIntent && academicState === "error") return <InlineMessage tone="error">{academicError}</InlineMessage>;

  return (
    <form className={styles.classCirculationCard} aria-busy={saving} onSubmit={submit}>
      <div className={styles.formHeading}>
        <div>
          <p>Групова операція</p>
          <h2>Видати підручники класу</h2>
          <small>Додавайте матеріали з каталогу до одного кошика, а потім підтвердьте видачу.</small>
        </div>
      </div>

      {pendingIntent ? (
        <div className={styles.pendingRecovery}>
          <InlineMessage tone="info">
            Є непідтверджена видача: {pendingIntent.payload.items.length} поз., клас {pendingIntent.payload.classYearId}.
          </InlineMessage>
          <button
            className={styles.secondaryButton}
            type="button"
            disabled={saving || !writesEnabled}
            onClick={() => void sendIssueIntent(pendingIntent, true)}
          >
            {saving ? "Перевіряємо…" : "Перевірити результат"}
          </button>
        </div>
      ) : null}

      <fieldset className={styles.editFields} disabled={locked}>
        {!activeClassYears.length ? (
          <InlineMessage tone="info">Немає активного класу в активному навчальному році.</InlineMessage>
        ) : (
          <div className={styles.formGrid}>
            <EditField label="Клас" required wide>
              <select value={effectiveClassYearId} onChange={(event) => chooseClassYear(event.target.value)} required>
                {activeClassYears.map((classYear) => (
                  <option key={classYear.id} value={classYear.id}>
                    {classYear.className} · {classYear.academicYearLabel}
                  </option>
                ))}
              </select>
            </EditField>
            <EditField label="Відповідальний учитель" required wide>
              <select
                value={effectiveResponsibleTeacherUserId}
                onChange={(event) => {
                  setClassYearId(effectiveClassYearId);
                  setResponsibleTeacherUserId(event.target.value);
                }}
                required
              >
                <option value="">Оберіть активного вчителя</option>
                {teachers.map((teacher) => (
                  <option key={teacher.id} value={teacher.id}>{teacher.fullName}</option>
                ))}
              </select>
            </EditField>
            <EditField label="Дата видачі" required>
              <input
                ref={issuedAtInputRef}
                name="issuedAt"
                type="date"
                min={selectedClassYear?.startDate}
                max={selectedClassYear?.endDate}
                value={effectiveIssuedAt}
                onInput={(event) => {
                  setClassYearId(effectiveClassYearId);
                  setIssuedAt(event.currentTarget.value);
                }}
                required
              />
            </EditField>
            <EditField label="Повернути до">
              <input
                ref={classDueAtInputRef}
                name="dueAt"
                type="date"
                min={effectiveIssuedAt}
                max={selectedClassYear?.endDate}
                value={effectiveDueAt}
                onInput={(event) => {
                  setClassYearId(effectiveClassYearId);
                  setDueAt(event.currentTarget.value);
                }}
              />
            </EditField>
          </div>
        )}

        <section
          ref={materialPickerRef}
          className={styles.classMaterialPicker}
          aria-labelledby="class-material-picker-title"
          tabIndex={-1}
        >
          <div>
            <h3 id="class-material-picker-title">Додати вибраний матеріал</h3>
            <p>Оберіть матеріал ліворуч, місце та кількість, тоді додайте його до кошика.</p>
          </div>
          {detailState === "idle" ? <ChooseMaterial /> : null}
          {detailState === "loading" ? <PanelLoading /> : null}
          {detailState === "error" ? <InlineMessage tone="error">{detailError}</InlineMessage> : null}
          {detailState === "ready" && detail ? (
            <div className={styles.classSelectedMaterial}>
              <div className={styles.selectedSummary}>
                <Cover material={detail} />
                <div>
                  <strong>{detail.title}</strong>
                  <small>{[detail.author, detail.year, detail.id].filter(Boolean).join(" · ")}</small>
                </div>
              </div>
              {availableHoldings.length ? (
                <div className={styles.classAddRow}>
                  <label>
                    <span>Звідки</span>
                    <select value={effectiveSourceKey} onChange={(event) => setSourceKey(event.target.value)}>
                      {availableHoldings.map((holding) => (
                        <option key={holdingKey(holding)} value={holdingKey(holding)}>
                          {holding.locationName} · {conditionLabel(holding.condition)} · {holding.quantity} доступно
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Кількість</span>
                    <input
                      type="number"
                      min="1"
                      max={source?.quantity ?? 1}
                      value={quantity}
                      onChange={(event) => setQuantity(event.target.value)}
                    />
                  </label>
                  <button className={styles.secondaryButton} type="button" onClick={addSelectedMaterial}>
                    Додати або оновити
                  </button>
                </div>
              ) : (
                <InlineMessage tone="info">У цього матеріалу немає доступних примірників.</InlineMessage>
              )}
            </div>
          ) : null}
        </section>

        <section className={styles.classCart} aria-labelledby="class-cart-title">
          <div className={styles.classCartHeading}>
            <div>
              <h3 id="class-cart-title">Кошик видачі</h3>
              <p>{cart.length} поз. · {cartCopies} прим.</p>
            </div>
          </div>
          {!cart.length ? (
            <InlineMessage tone="info">Додайте щонайменше один матеріал.</InlineMessage>
          ) : (
            <div className={styles.classCartRows}>
              {cart.map((item) => (
                <article key={item.key}>
                  <span className={styles.classCartCover}>
                    {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" /> : <span aria-hidden="true">Б</span>}
                  </span>
                  <div>
                    <strong>{item.materialTitle}</strong>
                    <small>{[item.materialAuthor, item.materialYear, item.materialId].filter(Boolean).join(" · ")}</small>
                    <small>{item.sourceLocationName} · {conditionLabel(item.condition)} · доступно {item.expectedAvailableQuantity}</small>
                  </div>
                  <label>
                    <span>Кількість</span>
                    <input
                      aria-label={`Кількість для ${item.materialTitle}`}
                      type="number"
                      min="1"
                      max={item.expectedAvailableQuantity}
                      value={item.quantity}
                      onChange={(event) => updateCartQuantity(item.key, Number(event.target.value))}
                    />
                  </label>
                  <button
                    className={styles.removeCartButton}
                    type="button"
                    aria-label={`Прибрати ${item.materialTitle} з кошика`}
                    onClick={() => setCart((current) => current.filter((row) => row.key !== item.key))}
                  >
                    <SiteIcon name="delete" size={18} />
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>

        <div className={styles.formGrid}>
          <EditField label="Примітка" wide>
            <textarea
              rows={3}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Наприклад, комплект підручників на навчальний рік"
            />
          </EditField>
        </div>
      </fieldset>

      {message ? <InlineMessage tone={messageTone}>{message}</InlineMessage> : null}

      <div className={styles.formActions}>
        {messageTone === "success" && lastIssuedClassLoanId ? (
          <div className={styles.statementActions}>
            <a
              className={styles.primaryButton}
              href={`/librarian/class-loans/${encodeURIComponent(lastIssuedClassLoanId)}/statement`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Відкрити й друкувати відомість
            </a>
            <a
              className={styles.secondaryButton}
              href={`/api/librarian/class-issue-statements/${encodeURIComponent(lastIssuedClassLoanId)}/excel`}
            >
              Excel
            </a>
            <button className={styles.secondaryButton} type="button" onClick={onChooseReturn}>
              До повернень
            </button>
          </div>
        ) : <span>Одна видача може містити до 100 позицій.</span>}
        {messageTone === "success" && lastIssuedClassLoanId ? null : (
          <button
            className={styles.primaryButton}
            type="submit"
            disabled={
              !writesEnabled
              || locked
              || !selectedClassYear
              || !effectiveResponsibleTeacherUserId
              || !cart.length
            }
          >
            {saving ? "Оформлюємо…" : `Підтвердити видачу (${cartCopies} прим.)`}
          </button>
        )}
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
  const [teacherQuery, setTeacherQuery] = useState("");
  const [selectedTeacherId, setSelectedTeacherId] = useState("");
  const [teacherPickerOpen, setTeacherPickerOpen] = useState(false);
  const [loans, setLoans] = useState<OpenLoan[]>([]);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [completionMessage, setCompletionMessage] = useState("");
  const [completionTone, setCompletionTone] = useState<"error" | "success" | "info">("success");

  const filteredTeachers = useMemo(() => {
    const query = normalizeTeacherSearch(teacherQuery);
    const tokens = query.split(" ").filter(Boolean);
    return teachers
      .filter((teacher) => {
        const normalizedName = normalizeTeacherSearch(teacher.fullName);
        return tokens.every((token) => normalizedName.includes(token));
      })
      .slice(0, 12);
  }, [teacherQuery, teachers]);
  const selectedTeacher = teachers.find((teacher) => teacher.id === selectedTeacherId) ?? null;

  useEffect(() => {
    if (!selectedTeacherId) {
      return undefined;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({ limit: "200", teacherUserId: selectedTeacherId });
    void apiJson<LoansEnvelope>(`/api/librarian/loans?${params}`, {
      signal: controller.signal,
    }).then((response) => {
      setLoans([...response.loans].sort((left, right) => (
        right.issuedAt.localeCompare(left.issuedAt)
        || right.loanId.localeCompare(left.loanId)
      )));
      setState("ready");
    }).catch((requestError) => {
      if (controller.signal.aborted) return;
      setState("error");
      setError(errorMessage(requestError));
    });
    return () => controller.abort();
  }, [reloadToken, selectedTeacherId]);

  function selectTeacher(teacher: LibraryTeacher) {
    setState("loading");
    setError("");
    setSelectedTeacherId(teacher.id);
    setTeacherQuery(teacher.fullName);
    setTeacherPickerOpen(false);
    setCompletionMessage("");
  }

  return (
    <div className={styles.returnCard}>
      <div className={styles.formHeading}>
        <div>
          <p>Відкриті видачі</p>
          <h2>Прийняти повернення</h2>
          <small>Почніть вводити прізвище або ім’я. Після вибору побачите всі видані примірники одним списком.</small>
        </div>
        <button type="button" onClick={() => {
          if (selectedTeacherId) {
            setState("loading");
            setError("");
            setReloadToken((value) => value + 1);
          }
        }} disabled={!selectedTeacherId || state === "loading"} title="Оновити" aria-label="Оновити відкриті видачі"><SiteIcon name="refresh" size={18} /></button>
      </div>

      <div className={styles.returnTeacherPicker}>
        <label htmlFor="return-teacher-search">Учитель</label>
        <div className={styles.returnTeacherSearch}>
          <SiteIcon name="search" size={18} />
          <input
            id="return-teacher-search"
            type="search"
            autoComplete="off"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={teacherPickerOpen}
            aria-controls="return-teacher-options"
            value={teacherQuery}
            placeholder="Прізвище або ім’я"
            onFocus={() => setTeacherPickerOpen(true)}
            onBlur={() => window.setTimeout(() => setTeacherPickerOpen(false), 100)}
            onChange={(event) => {
              setTeacherQuery(event.target.value);
              setTeacherPickerOpen(true);
              if (selectedTeacherId) {
                setSelectedTeacherId("");
                setLoans([]);
                setState("idle");
              }
              setCompletionMessage("");
            }}
          />
          {teacherQuery ? (
            <button type="button" onClick={() => {
              setTeacherQuery("");
              setSelectedTeacherId("");
              setLoans([]);
              setState("idle");
              setTeacherPickerOpen(true);
              setCompletionMessage("");
            }} aria-label="Очистити пошук учителя">×</button>
          ) : null}
        </div>
        {teacherPickerOpen ? (
          <div id="return-teacher-options" className={styles.returnTeacherOptions} role="listbox">
            {filteredTeachers.length ? filteredTeachers.map((teacher) => (
              <button
                key={teacher.id}
                type="button"
                role="option"
                aria-selected={teacher.id === selectedTeacherId}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectTeacher(teacher)}
              >
                <span aria-hidden="true">{teacherInitials(teacher.fullName)}</span>
                <strong>{teacher.fullName}</strong>
              </button>
            )) : <p>Збігів у довіднику немає.</p>}
          </div>
        ) : null}
      </div>

      {state === "idle" ? (
        <div className={styles.returnPrompt}>
          <SiteIcon name="teachers" size={24} />
          <strong>Оберіть учителя</strong>
          <span>Список відфільтровується під час введення.</span>
        </div>
      ) : null}
      {state === "loading" ? <PanelLoading /> : null}
      {state === "error" ? <InlineMessage tone="error">{error}</InlineMessage> : null}
      {completionMessage ? <InlineMessage tone={completionTone}>{completionMessage}</InlineMessage> : null}
      {state === "ready" && !loans.length ? (
        <div className={styles.noLoans}>
          <span aria-hidden="true"><SiteIcon name="success" size={20} /></span>
          <strong>Відкритих видач немає</strong>
          <p>{selectedTeacher?.fullName || "Для вибраного вчителя"}: усе повернено.</p>
        </div>
      ) : null}

      {state === "ready" && selectedTeacher && loans.length ? (
        <LoanReturnForm
          key={`${selectedTeacher.id}-${reloadToken}-${loans.map((loan) => `${loan.loanId}:${loan.version}`).join("|")}`}
          teacher={selectedTeacher}
          loans={loans}
          locations={locations}
          writesEnabled={writesEnabled}
          onSaved={async (message, tone = "success") => {
            setCompletionMessage(message);
            setCompletionTone(tone);
            await onSaved();
            setState("loading");
            setError("");
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

type ReturnableLoanItem = OpenLoanItem & {
  loanId: string;
  issuedAt: string;
  dueAt: string | null;
  loanVersion: number;
};

function LoanReturnForm({
  teacher,
  loans,
  locations,
  writesEnabled,
  onSaved,
}: {
  teacher: LibraryTeacher;
  loans: OpenLoan[];
  locations: LibraryLocation[];
  writesEnabled: boolean;
  onSaved: (message: string, tone?: "error" | "success" | "info") => Promise<void>;
}) {
  const items = useMemo<ReturnableLoanItem[]>(() => loans.flatMap((loan) => loan.items.map((item) => ({
    ...item,
    loanId: loan.loanId,
    issuedAt: loan.issuedAt,
    dueAt: loan.dueAt,
    loanVersion: loan.version,
  }))).sort((left, right) => (
    right.issuedAt.localeCompare(left.issuedAt)
    || left.materialTitle.localeCompare(right.materialTitle, "uk")
    || left.loanItemId.localeCompare(right.loanItemId)
  )), [loans]);
  const defaultLocationId = locations.find((location) => location.type === "library")?.id || locations[0]?.id || "";
  const [returnLocationId, setReturnLocationId] = useState(defaultLocationId);
  const [returnedAt, setReturnedAt] = useState(() => todayInKyiv());
  const [notes, setNotes] = useState("");
  const [rows, setRows] = useState<Record<string, ReturnRow>>(() => Object.fromEntries(
    items.map((item) => [item.loanItemId, {
      selected: true,
      quantity: String(item.quantityOutstanding),
      condition: item.condition || "unspecified",
    }]),
  ));
  const [previewItemId, setPreviewItemId] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);
  const returnInFlightRef = useRef(false);

  function updateRow(loanItemId: string, changes: Partial<ReturnRow>) {
    setRows((current) => ({
      ...current,
      [loanItemId]: { ...current[loanItemId], ...changes },
    }));
  }

  const selectedItems = items.filter((item) => {
    const row = rows[item.loanItemId];
    return row?.selected && Number(row.quantity) > 0;
  });
  const previewItem = items.find((item) => item.loanItemId === previewItemId) ?? null;
  const allSelected = items.length > 0 && selectedItems.length === items.length;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!writesEnabled || !returnLocationId || !selectedItems.length || returnInFlightRef.current) return;
    returnInFlightRef.current = true;
    setSaving(true);
    setSuccess(false);
    setMessage("");
    const byLoan = new Map<string, ReturnableLoanItem[]>();
    for (const item of selectedItems) {
      byLoan.set(item.loanId, [...(byLoan.get(item.loanId) ?? []), item]);
    }
    const groups = [...byLoan.entries()];
    try {
      const results = await Promise.allSettled(groups.map(([loanId, groupItems]) => (
        apiJson<MutationEnvelope<{ status: "open" | "closed" }>>(
          "/api/librarian/loans/returns",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              requestId: crypto.randomUUID(),
              loanId,
              returnedAt,
              notes: notes.trim() || null,
              items: groupItems.map((item) => ({
                loanItemId: item.loanItemId,
                quantity: Number(rows[item.loanItemId].quantity),
                returnLocationId,
                condition: rows[item.loanItemId].condition,
              })),
            }),
          },
        )
      )));
      const savedGroups = results.filter((result) => result.status === "fulfilled").length;
      const firstFailure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (firstFailure) {
        const failedMessage = errorMessage(firstFailure.reason);
        const partialMessage = savedGroups
          ? `Повернення збережено для ${savedGroups} із ${groups.length} видач. Не збережено: ${failedMessage}`
          : failedMessage;
        setMessage(partialMessage);
        await onSaved(partialMessage, savedGroups ? "info" : "error");
        return;
      }
      const resultMessage = selectedItems.length === items.length
        ? `Повернення всіх ${selectedItems.length} позицій збережено.`
        : `Повернення ${selectedItems.length} позицій збережено.`;
      setSuccess(true);
      setMessage(resultMessage);
      await onSaved(resultMessage);
    } catch (requestError) {
      setMessage(errorMessage(requestError));
    } finally {
      setSaving(false);
      returnInFlightRef.current = false;
    }
  }

  return (
    <form className={styles.returnForm} aria-busy={saving} onSubmit={submit}>
      <div className={styles.returnTeacherSummary}>
        <span aria-hidden="true">{teacherInitials(teacher.fullName)}</span>
        <div>
          <small>Повна картка видач</small>
          <strong>{teacher.fullName}</strong>
          <p>{items.length} {ukrainianCountLabel(items.length, "позиція", "позиції", "позицій")} · спочатку новіші видачі</p>
        </div>
        <label>
          <input
            type="checkbox"
            checked={allSelected}
            onChange={(event) => {
              const selected = event.target.checked;
              setRows((current) => Object.fromEntries(items.map((item) => [
                item.loanItemId,
                { ...current[item.loanItemId], selected },
              ])));
            }}
          />
          <span>{allSelected ? "Зняти всі" : "Обрати всі"}</span>
        </label>
      </div>

      <div className={styles.returnItems}>
        {items.map((item) => {
          const row = rows[item.loanItemId];
          return (
            <article key={item.loanItemId} className={row?.selected ? styles.returnItemSelected : ""}>
              <input
                aria-label={`Повернути ${item.materialTitle}`}
                type="checkbox"
                checked={row?.selected ?? false}
                onChange={(event) => updateRow(item.loanItemId, { selected: event.target.checked })}
              />
              <button className={styles.returnItemIdentity} type="button" onClick={() => setPreviewItemId(item.loanItemId)}>
                <span className={styles.returnItemCover}>
                  {item.coverUrl ? <img src={item.coverUrl} alt="" /> : <span aria-hidden="true">{item.materialTitle.slice(0, 1).toUpperCase()}</span>}
                </span>
                <span>
                  <strong>{item.materialTitle}</strong>
                  <small>{[item.materialAuthor, item.materialYear].filter(Boolean).join(" · ") || "Автор і рік не вказані"}</small>
                  <small>{item.materialCatalogNumber ? `Обліковий № ${item.materialCatalogNumber} · ` : ""}{item.materialId} · {item.sourceLocationName}</small>
                  <small>Видано {formatDate(item.issuedAt)} · {item.dueAt ? `до ${formatDate(item.dueAt)}` : "без строку"}</small>
                </span>
                <SiteIcon name="visible" size={17} />
              </button>
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
          <input type="date" value={returnedAt} onChange={(event) => setReturnedAt(event.target.value)} required />
        </EditField>
        <EditField label="Примітка" wide>
          <textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Стан, комплектність або інша примітка" />
        </EditField>
      </div>

      {!locations.length ? <InlineMessage tone="info">Немає активного місця для повернення.</InlineMessage> : null}
      {message ? <InlineMessage tone={success ? "success" : "error"}>{message}</InlineMessage> : null}

      <div className={styles.formActions}>
        <span>Обрано: {selectedItems.length} із {items.length}</span>
        <button
          className={styles.primaryButton}
          type="submit"
          disabled={!writesEnabled || !returnLocationId || !selectedItems.length || saving}
        >
          {saving ? "Зберігаємо…" : "Прийняти вибране"}
        </button>
      </div>

      {previewItem ? (
        <ReturnItemModal
          item={previewItem}
          row={rows[previewItem.loanItemId]}
          onChange={(changes) => updateRow(previewItem.loanItemId, changes)}
          onClose={() => setPreviewItemId("")}
        />
      ) : null}
    </form>
  );
}

function ReturnItemModal({
  item,
  row,
  onChange,
  onClose,
}: {
  item: ReturnableLoanItem;
  row: ReturnRow;
  onChange: (changes: Partial<ReturnRow>) => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div className={styles.materialQuickViewBackdrop} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className={styles.returnItemModal} role="dialog" aria-modal="true" aria-labelledby="return-item-title">
        <header>
          <div>
            <small>Картка виданого примірника</small>
            <h3 id="return-item-title">{item.materialTitle}</h3>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Закрити картку">×</button>
        </header>
        <div className={styles.returnItemModalBody}>
          <div className={styles.returnItemModalCover}>
            {item.coverUrl ? <img src={item.coverUrl} alt={`Обкладинка: ${item.materialTitle}`} /> : <span aria-hidden="true">{item.materialTitle.slice(0, 1).toUpperCase()}</span>}
          </div>
          <dl>
            <div><dt>Автор</dt><dd>{item.materialAuthor || "Не вказано"}</dd></div>
            <div><dt>Рік</dt><dd>{item.materialYear || "Не вказано"}</dd></div>
            <div><dt>Обліковий №</dt><dd>{item.materialCatalogNumber || "Не вказано"}</dd></div>
            <div><dt>CAT-ID</dt><dd>{item.materialId}</dd></div>
            <div><dt>ISBN</dt><dd>{item.materialIsbn || "Не вказано"}</dd></div>
            <div><dt>Видано</dt><dd>{formatDate(item.issuedAt)}</dd></div>
            <div><dt>Повернути до</dt><dd>{item.dueAt ? formatDate(item.dueAt) : "Без строку"}</dd></div>
            <div><dt>Звідки видано</dt><dd>{item.sourceLocationName}</dd></div>
            <div><dt>Залишилося</dt><dd>{item.quantityOutstanding}</dd></div>
          </dl>
        </div>
        <div className={styles.returnItemModalActions}>
          <label>
            <input type="checkbox" checked={row?.selected ?? false} onChange={(event) => onChange({ selected: event.target.checked })} />
            <span>Прийняти зараз</span>
          </label>
          <label>
            <span>Кількість</span>
            <input type="number" min="1" max={item.quantityOutstanding} disabled={!row?.selected} value={row?.quantity ?? ""} onChange={(event) => onChange({ quantity: event.target.value })} />
          </label>
          <label>
            <span>Стан</span>
            <select disabled={!row?.selected} value={row?.condition ?? "unspecified"} onChange={(event) => onChange({ condition: event.target.value })}>
              <option value="unspecified">Не уточнено</option>
              <option value="good">Добрий</option>
              <option value="worn">Зношений</option>
              <option value="damaged">Пошкоджений</option>
            </select>
          </label>
          <button className={styles.primaryButton} type="button" onClick={onClose}>Готово</button>
        </div>
      </section>
    </div>
  );
}

function normalizeTeacherSearch(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[’'`-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("uk");
}

function teacherInitials(fullName: string): string {
  return fullName.split(/\s+/u).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() || "").join("");
}

function ukrainianCountLabel(value: number, one: string, few: string, many: string): string {
  const mod100 = value % 100;
  const mod10 = value % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function ClassReturnWorkspace({
  writesEnabled,
  locations,
  referenceState,
  referenceError,
  onSaved,
}: {
  writesEnabled: boolean;
  locations: LibraryLocation[];
  referenceState: LoadState;
  referenceError: string;
  onSaved: () => Promise<void>;
}) {
  const usableLocations = useMemo(
    () => locations.filter((location) => (
      location.type !== "service"
      && (location.status === undefined || location.status === "active")
    )),
    [locations],
  );
  const [loans, setLoans] = useState<OpenClassLoan[]>([]);
  const [classDirectory, setClassDirectory] = useState<AcademicReferenceClassYear[]>([]);
  const [classFilter, setClassFilter] = useState("");
  const [selectedLoanId, setSelectedLoanId] = useState("");
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [pendingIntent, setPendingIntent] = useState<PendingClassCirculationIntent<ClassReturnPayload> | null>(
    () => readPendingClassCirculationIntent<ClassReturnPayload>("class-return"),
  );
  const [saving, setSaving] = useState(false);
  const [completionMessage, setCompletionMessage] = useState("");
  const [completionTone, setCompletionTone] = useState<"error" | "success" | "info">("success");

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      apiJson<ClassLoansEnvelope>("/api/librarian/class-loans?limit=200", {
        signal: controller.signal,
      }),
      apiJson<AcademicReferenceEnvelope>("/api/librarian/academic-reference", {
        signal: controller.signal,
      }),
    ]).then(([loanResponse, academicResponse]) => {
      setLoans(loanResponse.classLoans);
      setClassDirectory(academicResponse.referenceData.classYears);
      setState("ready");
    }).catch((requestError) => {
      if (controller.signal.aborted) return;
      setState("error");
      setError(errorMessage(requestError));
    });
    return () => controller.abort();
  }, [reloadToken]);

  const classOptions = useMemo(() => {
    const byId = new Map<string, { id: string; label: string }>();
    for (const loan of loans) {
      const classYear = classDirectory.find((candidate) => candidate.id === loan.classYearId);
      byId.set(loan.classYearId, {
        id: loan.classYearId,
        label: classYear
          ? `${classYear.className} · ${classYear.academicYearLabel}`
          : `${loan.className} · ${loan.academicYearLabel}`,
      });
    }
    return [...byId.values()].sort((left, right) => left.label.localeCompare(right.label, "uk"));
  }, [classDirectory, loans]);

  const filteredLoans = useMemo(
    () => loans.filter((loan) => !classFilter || loan.classYearId === classFilter),
    [classFilter, loans],
  );

  const effectiveSelectedLoanId = filteredLoans.some((loan) => loan.classLoanId === selectedLoanId)
    ? selectedLoanId
    : filteredLoans[0]?.classLoanId || "";
  const selectedLoan = filteredLoans.find(
    (loan) => loan.classLoanId === effectiveSelectedLoanId,
  ) ?? null;
  const locked = saving || Boolean(pendingIntent);

  async function sendReturnIntent(
    intent: PendingClassCirculationIntent<ClassReturnPayload>,
    alreadyStored: boolean,
  ) {
    if (!alreadyStored && !writePendingClassCirculationIntent(intent)) {
      setCompletionTone("error");
      setCompletionMessage("Не вдалося зберегти безпечний повтор у цьому браузері. Повернення не надіслано.");
      return;
    }
    setPendingIntent(intent);
    setSaving(true);
    setCompletionTone("info");
    setCompletionMessage(alreadyStored ? "Перевіряємо результат тим самим запитом…" : "Зберігаємо повернення класу…");
    try {
      const response = await apiJson<MutationEnvelope<ClassLoanMutationResult>>(
        "/api/librarian/class-loans/returns",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(intent.payload),
        },
      );
      clearPendingClassCirculationIntent("class-return");
      setPendingIntent(null);
      setCompletionTone("success");
      setCompletionMessage(
        response.result.status === "closed"
          ? "Усю видачу класу повернено."
          : "Часткове повернення класу збережено.",
      );
      await onSaved();
      setState("loading");
      setReloadToken((value) => value + 1);
    } catch (requestError) {
      if (isDefinitiveClassCirculationFailure(requestError)) {
        clearPendingClassCirculationIntent("class-return");
        setPendingIntent(null);
        setCompletionTone("error");
        setCompletionMessage(`${errorMessage(requestError)} Список відкритих видач оновлено.`);
        await onSaved();
        setState("loading");
        setReloadToken((value) => value + 1);
      } else {
        setCompletionTone("info");
        setCompletionMessage("Відповідь сервера не підтверджена. Не створюйте нове повернення: перевірте цей самий запит.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.classCirculationCard}>
      <div className={styles.formHeading}>
        <div>
          <p>Відкриті видачі класам</p>
          <h2>Повернути підручники класу</h2>
          <small>Оберіть клас, видачу та фактично повернені позиції.</small>
        </div>
        <button
          type="button"
          aria-label="Оновити відкриті видачі класам"
          disabled={locked}
          onClick={() => {
            setState("loading");
            setError("");
            setReloadToken((value) => value + 1);
          }}
        >
          <SiteIcon name="refresh" size={18} />
        </button>
      </div>

      {pendingIntent ? (
        <div className={styles.pendingRecovery}>
          <InlineMessage tone="info">
            Є непідтверджене повернення: {pendingIntent.payload.items.length} поз. у видачі {pendingIntent.payload.classLoanId}.
          </InlineMessage>
          <button
            className={styles.secondaryButton}
            type="button"
            disabled={saving || !writesEnabled}
            onClick={() => void sendReturnIntent(pendingIntent, true)}
          >
            {saving ? "Перевіряємо…" : "Перевірити результат"}
          </button>
        </div>
      ) : null}

      {referenceState === "error" ? <InlineMessage tone="error">{referenceError}</InlineMessage> : null}
      {state === "loading" ? <PanelLoading /> : null}
      {state === "error" ? <InlineMessage tone="error">{error}</InlineMessage> : null}
      {completionMessage ? <InlineMessage tone={completionTone}>{completionMessage}</InlineMessage> : null}

      {state === "ready" ? (
        <fieldset className={styles.editFields} disabled={locked || referenceState === "loading"}>
          <label className={styles.returnFilter}>
            <span>Клас</span>
            <select
              value={classFilter}
              onChange={(event) => {
                setClassFilter(event.target.value);
                setCompletionMessage("");
              }}
            >
              <option value="">Усі класи з відкритими видачами</option>
              {classOptions.map((classOption) => (
                <option key={classOption.id} value={classOption.id}>{classOption.label}</option>
              ))}
            </select>
          </label>

          {!filteredLoans.length ? (
            <div className={styles.noLoans}>
              <span aria-hidden="true"><SiteIcon name="success" size={20} /></span>
              <strong>Відкритих видач класу немає</strong>
              <p>Усі зафіксовані підручники вже повернено.</p>
            </div>
          ) : (
            <label className={styles.returnFilter}>
              <span>Видача</span>
              <select value={effectiveSelectedLoanId} onChange={(event) => setSelectedLoanId(event.target.value)}>
                {filteredLoans.map((loan) => (
                  <option key={loan.classLoanId} value={loan.classLoanId}>
                    {loan.className} · {loan.responsibleTeacherName} · {formatDate(loan.issuedAt)} · {loan.items.length} поз.
                  </option>
                ))}
              </select>
            </label>
          )}
        </fieldset>
      ) : null}

      {selectedLoan && !pendingIntent ? (
        <ClassReturnForm
          key={`${selectedLoan.classLoanId}-${selectedLoan.version}`}
          loan={selectedLoan}
          locations={usableLocations}
          writesEnabled={writesEnabled}
          locked={saving}
          onSubmitIntent={(intent) => sendReturnIntent(intent, false)}
        />
      ) : null}
    </div>
  );
}

type ClassReturnRow = {
  selected: boolean;
  quantity: string;
  condition: CopyCondition;
  returnLocationId: string;
};

function ClassReturnForm({
  loan,
  locations,
  writesEnabled,
  locked,
  onSubmitIntent,
}: {
  loan: OpenClassLoan;
  locations: LibraryLocation[];
  writesEnabled: boolean;
  locked: boolean;
  onSubmitIntent: (intent: PendingClassCirculationIntent<ClassReturnPayload>) => Promise<void>;
}) {
  const defaultLocationId = locations.find((location) => location.type === "library")?.id || locations[0]?.id || "";
  const [returnedAt, setReturnedAt] = useState(() => todayInKyiv());
  const classReturnedAtInputRef = useRef<HTMLInputElement>(null);
  const [notes, setNotes] = useState("");
  const [rows, setRows] = useState<Record<string, ClassReturnRow>>(() => Object.fromEntries(
    loan.items.map((item) => [item.classLoanItemId, {
      selected: true,
      quantity: String(item.quantityOutstanding),
      condition: normalizeCopyCondition(item.condition),
      returnLocationId: locations.some((location) => location.id === item.sourceLocationId)
        ? item.sourceLocationId
        : defaultLocationId,
    }]),
  ));
  const [message, setMessage] = useState("");

  function updateRow(classLoanItemId: string, changes: Partial<ClassReturnRow>) {
    setRows((current) => ({
      ...current,
      [classLoanItemId]: { ...current[classLoanItemId], ...changes },
    }));
  }

  const selectedItems = loan.items.filter((item) => rows[item.classLoanItemId]?.selected);
  const selectedCopies = selectedItems.reduce(
    (total, item) => total + (Number(rows[item.classLoanItemId]?.quantity) || 0),
    0,
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!writesEnabled || locked || !selectedItems.length) return;
    const submittedReturnedAt = resolveLiveFormTextForSubmission(
      classReturnedAtInputRef.current?.value,
      new FormData(event.currentTarget).get("returnedAt"),
      returnedAt,
    ) || returnedAt;
    const invalidItem = selectedItems.find((item) => {
      const row = rows[item.classLoanItemId];
      const itemQuantity = Number(row.quantity);
      return !row.returnLocationId
        || !Number.isInteger(itemQuantity)
        || itemQuantity < 1
        || itemQuantity > item.quantityOutstanding;
    });
    if (invalidItem) {
      setMessage("Перевірте кількість і місце повернення кожної обраної позиції.");
      return;
    }
    const returnsEverything = selectedItems.length === loan.items.length
      && selectedItems.every((item) => Number(rows[item.classLoanItemId].quantity) === item.quantityOutstanding);
    if (!window.confirm(
      `${returnsEverything ? "Повністю закрити" : "Зберегти часткове повернення для"} видачі класу «${loan.className}»: ${selectedCopies} прим. у ${selectedItems.length} поз.?`,
    )) return;

    const requestId = crypto.randomUUID();
    const payload: ClassReturnPayload = {
      requestId,
      classLoanId: loan.classLoanId,
      expectedVersion: loan.version,
      returnedAt: submittedReturnedAt,
      notes: notes.trim() || null,
      items: selectedItems.map((item) => ({
        classLoanItemId: item.classLoanItemId,
        quantity: Number(rows[item.classLoanItemId].quantity),
        returnLocationId: rows[item.classLoanItemId].returnLocationId,
        condition: rows[item.classLoanItemId].condition,
      })),
    };
    setMessage("");
    await onSubmitIntent({ kind: "class-return", requestId, payload });
  }

  return (
    <form className={styles.returnForm} aria-busy={locked} onSubmit={submit}>
      <fieldset className={styles.editFields} disabled={locked}>
        <div className={styles.loanSummary}>
          <div>
            <span>Клас</span>
            <strong>{loan.className} · {loan.academicYearLabel}</strong>
          </div>
          <div>
            <span>Відповідальний</span>
            <strong>{loan.responsibleTeacherName}</strong>
          </div>
          <div>
            <span>Видано / повернути до</span>
            <strong>{formatDate(loan.issuedAt)} / {loan.dueAt ? formatDate(loan.dueAt) : "без строку"}</strong>
          </div>
        </div>

        <div className={styles.returnSelectionActions}>
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={() => setRows((current) => Object.fromEntries(
              Object.entries(current).map(([key, value]) => [key, { ...value, selected: true }]),
            ))}
          >
            Позначити все
          </button>
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={() => setRows((current) => Object.fromEntries(
              Object.entries(current).map(([key, value]) => [key, { ...value, selected: false }]),
            ))}
          >
            Зняти позначки
          </button>
        </div>

        <div className={styles.classReturnItems}>
          {loan.items.map((item) => {
            const row = rows[item.classLoanItemId];
            return (
              <article key={item.classLoanItemId} className={row?.selected ? styles.returnItemSelected : ""}>
                <label className={styles.classReturnToggle}>
                  <input
                    aria-label={`Повернути ${item.materialTitle}`}
                    type="checkbox"
                    checked={row?.selected ?? false}
                    onChange={(event) => updateRow(item.classLoanItemId, { selected: event.target.checked })}
                  />
                </label>
                <div>
                  <strong>{item.materialTitle}</strong>
                  <small>{[item.materialId, item.materialYear, item.sourceLocationName].filter(Boolean).join(" · ")}</small>
                  <small>Видано {item.quantityIssued} · уже повернено {item.quantityReturned} · залишилося {item.quantityOutstanding}</small>
                </div>
                <label>
                  <span>Кількість</span>
                  <input
                    type="number"
                    min="1"
                    max={item.quantityOutstanding}
                    value={row?.quantity ?? ""}
                    disabled={!row?.selected}
                    onChange={(event) => updateRow(item.classLoanItemId, { quantity: event.target.value })}
                  />
                </label>
                <label>
                  <span>Куди повернуто</span>
                  <select
                    value={row?.returnLocationId ?? ""}
                    disabled={!row?.selected}
                    onChange={(event) => updateRow(item.classLoanItemId, { returnLocationId: event.target.value })}
                  >
                    <option value="">Оберіть місце</option>
                    {locations.map((location) => (
                      <option key={location.id} value={location.id}>{location.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Стан</span>
                  <select
                    value={row?.condition ?? "unspecified"}
                    disabled={!row?.selected}
                    onChange={(event) => updateRow(item.classLoanItemId, {
                      condition: normalizeCopyCondition(event.target.value),
                    })}
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
          <EditField label="Дата повернення" required>
            <input
              ref={classReturnedAtInputRef}
              name="returnedAt"
              type="date"
              min={loan.issuedAt}
              value={returnedAt}
              onInput={(event) => setReturnedAt(event.currentTarget.value)}
              required
            />
          </EditField>
          <EditField label="Примітка" wide>
            <textarea
              rows={3}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Стан комплектів або пояснення часткового повернення"
            />
          </EditField>
        </div>
      </fieldset>

      {!locations.length ? <InlineMessage tone="info">Немає активного місця для повернення.</InlineMessage> : null}
      {message ? <InlineMessage tone="error">{message}</InlineMessage> : null}

      <div className={styles.formActions}>
        <span>Обрано: {selectedItems.length} поз. · {selectedCopies} прим.</span>
        <button
          className={styles.primaryButton}
          type="submit"
          disabled={!writesEnabled || locked || !locations.length || !selectedItems.length}
        >
          Підтвердити повернення
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
        <button type="button" onClick={add} disabled={links.length >= 20}><SiteIcon name="add" size={16} /> Додати посилання</button>
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
  onIsbn,
  onApply,
  onCover,
  disabled,
}: {
  isbn: string;
  onIsbn: (value: string) => void;
  onApply: (candidate: BookLookupCandidate) => void;
  onCover: (candidate: BookLookupCandidate) => void;
  disabled: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [candidates, setCandidates] = useState<BookLookupCandidate[]>([]);

  async function lookup(scannedValue?: string) {
    const query = (scannedValue ?? isbn).trim();
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
    if (candidate.coverUrl) onCover(candidate);
    setCandidates([]);
    setMessage("Дані видання додано до порожніх полів; перевірте їх перед збереженням.");
  }

  return (
    <section className={styles.isbnLookup} aria-live="polite">
      <div>
        <strong>Автозаповнення за ISBN</strong>
        <small>Назва, автор, рік, видавництво, інформаційне посилання та обкладинка.</small>
      </div>
      <div className={styles.isbnLookupActions}>
        <IsbnCameraScanner
          disabled={disabled || loading}
          onDetected={(value) => {
            onIsbn(value);
            void lookup(value);
          }}
        />
        <button
          className={styles.secondaryButton}
          type="button"
          disabled={disabled || loading || !isbn.trim()}
          onClick={() => void lookup()}
        >
          {loading ? "Шукаємо…" : "Знайти опис"}
        </button>
      </div>
      {message ? <p>{message}</p> : null}
      {candidates.length ? (
        <div className={styles.isbnCandidates}>
          {candidates.map((candidate, index) => (
            <button
              key={`${candidate.provider}-${candidate.title}-${index}`}
              type="button"
              onClick={() => apply(candidate)}
            >
              {candidate.coverUrl ? <img src={candidate.coverUrl} alt="" /> : <span className={styles.isbnCoverFallback} aria-hidden="true">Б</span>}
              <strong>{candidate.title}</strong>
              <small>
                {[candidate.authors.join(", "), candidate.publishedYear, candidate.publisher]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
              <span className={styles.isbnProvider}>{candidate.provider === "google_books" ? "Google Books" : "Open Library"}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className={styles.externalBookSearch}>
        <a href={pidruchnykSearchUrl(isbn)} target="_blank" rel="noopener noreferrer">Шукати на Pidruchnyk.com.ua <SiteIcon name="external" size={14} /></a>
        <a href={yakabooSearchUrl(isbn)} target="_blank" rel="noopener noreferrer">Шукати на Yakaboo <SiteIcon name="external" size={14} /></a>
      </div>
    </section>
  );
}

type NativeBarcodeDetector = { detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>> };
type NativeBarcodeDetectorConstructor = {
  new (options?: { formats?: string[] }): NativeBarcodeDetector;
  getSupportedFormats?: () => Promise<string[]>;
};
type IsbnScannerControls = { stop: () => void };

function isbnCameraErrorMessage(error: unknown): string {
  const errorName = error && typeof error === "object" && "name" in error
    ? (error as { name?: unknown }).name
    : "";
  const name = typeof errorName === "string" ? errorName : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Доступ до камери заборонено. Дозвольте камеру для цього сайту в налаштуваннях браузера й спробуйте ще раз.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "Камеру не знайдено. Перевірте пристрій або введіть ISBN вручну.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "Не вдалося запустити камеру. Можливо, її використовує інша програма.";
  }
  return "Не вдалося запустити сканування. Спробуйте ще раз або введіть ISBN вручну.";
}

function IsbnCameraScanner({ disabled, onDetected }: { disabled: boolean; onDetected: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [message, setMessage] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number | null>(null);
  const controlsRef = useRef<IsbnScannerControls | null>(null);
  const scanningRef = useRef(false);
  const startingRef = useRef(false);

  const releaseCamera = useCallback(() => {
    scanningRef.current = false;
    controlsRef.current?.stop();
    controlsRef.current = null;
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const stop = useCallback(() => {
    releaseCamera();
    setOpen(false);
  }, [releaseCamera]);

  useEffect(() => {
    const handlePageHide = () => {
      releaseCamera();
      setOpen(false);
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      releaseCamera();
    };
  }, [releaseCamera]);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") stop();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, stop]);

  async function start() {
    if (startingRef.current || scanningRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setMessage("Цей браузер не надає доступу до камери. Відкрийте сайт через HTTPS або введіть ISBN вручну.");
      return;
    }
    startingRef.current = true;
    setStarting(true);
    setMessage("");
    setOpen(true);
    scanningRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      if (!scanningRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      let video = videoRef.current;
      for (let attempt = 0; !video && attempt < 30 && scanningRef.current; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 16));
        video = videoRef.current;
      }
      if (!video) throw new Error("camera_not_ready");
      video.srcObject = stream;
      await video.play();

      const detectorConstructor = (window as Window & { BarcodeDetector?: NativeBarcodeDetectorConstructor }).BarcodeDetector;
      let detector: NativeBarcodeDetector | null = null;
      if (detectorConstructor) {
        try {
          const supportedFormats = detectorConstructor.getSupportedFormats
            ? await detectorConstructor.getSupportedFormats()
            : ["ean_13"];
          if (supportedFormats.includes("ean_13")) {
            detector = new detectorConstructor({ formats: ["ean_13"] });
          }
        } catch {
          detector = null;
        }
      }

      if (detector) {
        const scan = async () => {
          if (!scanningRef.current || !videoRef.current || !detector) return;
          try {
            const results = await detector.detect(videoRef.current);
            const normalized = results
              .map((result) => normalizeIsbn(result.rawValue))
              .find((value) => value?.length === 13) ?? null;
            if (normalized) {
              onDetected(normalized);
              stop();
              return;
            }
          } catch {
            // The camera can miss frames while it focuses; continue scanning.
          }
          frameRef.current = requestAnimationFrame(scan);
        };
        frameRef.current = requestAnimationFrame(scan);
      } else {
        const [{ BarcodeFormat, BrowserMultiFormatOneDReader }, { DecodeHintType }] = await Promise.all([
          import("@zxing/browser"),
          import("@zxing/library"),
        ]);
        if (!scanningRef.current) return;
        const hints = new Map([[DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13]]]);
        const reader = new BrowserMultiFormatOneDReader(hints);
        controlsRef.current = await reader.decodeFromStream(stream, video, (result, _error, controls) => {
          const normalized = result ? normalizeIsbn(result.getText()) : null;
          if (!normalized || normalized.length !== 13 || !scanningRef.current) return;
          controls.stop();
          onDetected(normalized);
          stop();
        });
      }
    } catch (error) {
      if (scanningRef.current) setMessage(isbnCameraErrorMessage(error));
      releaseCamera();
      setOpen(false);
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }

  return (
    <>
      <button className={styles.secondaryButton} type="button" onClick={() => void start()} disabled={disabled || starting || open}>
        <span aria-hidden="true"><SiteIcon name={starting ? "loading" : "scan"} size={18} /></span> {starting ? "Відкриваємо…" : "Сканувати ISBN"}
      </button>
      {message ? <small className={styles.scannerMessage} role="status">{message}</small> : null}
      {open ? (
        <div className={styles.scannerOverlay} role="dialog" aria-modal="true" aria-labelledby="isbn-scanner-title">
          <div className={styles.scannerDialog}>
            <header><div><p>Сканування ISBN</p><h2 id="isbn-scanner-title">Наведіть камеру на штрихкод книги</h2></div><button type="button" onClick={stop} aria-label="Закрити сканер"><SiteIcon name="close" /></button></header>
            <div className={styles.scannerVideo}><video ref={videoRef} autoPlay muted playsInline /><span aria-hidden="true" /></div>
            <p>Тримайте код EAN-13 у рамці. Після розпізнавання опис буде знайдено автоматично.</p>
            <button className={styles.secondaryButton} type="button" onClick={stop}>Ввести ISBN вручну</button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function pidruchnykSearchUrl(isbn: string): string {
  const query = normalizeIsbn(isbn) || isbn.trim();
  return `https://pidruchnyk.com.ua/index.php?do=search&subaction=search&story=${encodeURIComponent(query)}`;
}

function yakabooSearchUrl(isbn: string): string {
  const query = normalizeIsbn(isbn) || isbn.trim();
  return `https://www.yakaboo.ua/ua/search/?q=${encodeURIComponent(query)}`;
}

function LocationManagementPanel({ writesEnabled, onChanged }: { writesEnabled: boolean; onChanged: () => void }) {
  const [locations, setLocations] = useState<ManagedLocation[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [createName, setCreateName] = useState("");
  const [createPublic, setCreatePublic] = useState(true);
  const [createSortOrder, setCreateSortOrder] = useState("100");
  const [editingId, setEditingId] = useState("");
  const [editName, setEditName] = useState("");
  const [editPublic, setEditPublic] = useState(true);
  const [editSortOrder, setEditSortOrder] = useState("0");

  const load = useCallback(async (preserveMessage = false) => {
    setState("loading");
    if (!preserveMessage) {
      setMessage("");
      setSuccess(false);
    }
    try {
      const response = await apiJson<{ success: true; locations: ManagedLocation[] }>("/api/librarian/locations");
      setLocations(response.locations);
      setState("ready");
      if (!preserveMessage) {
        setMessage("");
        setSuccess(false);
      }
    } catch (error) {
      setState("error");
      setMessage(errorMessage(error));
      setSuccess(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!writesEnabled || !createName.trim()) return;
    setBusyId("create");
    setMessage("");
    try {
      await apiJson("/api/librarian/locations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          name: createName.trim(),
          isPublic: createPublic,
          sortOrder: Number(createSortOrder),
        }),
      });
      setCreateName("");
      setMessage("Кабінет додано.");
      setSuccess(true);
      await load(true);
      onChanged();
    } catch (error) {
      setMessage(errorMessage(error));
      setSuccess(false);
    } finally {
      setBusyId("");
    }
  }

  function startEdit(location: ManagedLocation) {
    setEditingId(location.id);
    setEditName(location.name);
    setEditPublic(location.isPublic);
    setEditSortOrder(String(location.sortOrder));
    setMessage("");
  }

  async function update(location: ManagedLocation, changes: Record<string, unknown>, successMessage: string) {
    if (!writesEnabled) return;
    setBusyId(location.id);
    setMessage("");
    try {
      await apiJson(`/api/librarian/locations/${encodeURIComponent(location.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: crypto.randomUUID(), expectedUpdatedAt: location.updatedAt, changes }),
      });
      setEditingId("");
      setMessage(successMessage);
      setSuccess(true);
      await load(true);
      onChanged();
    } catch (error) {
      setMessage(errorMessage(error));
      setSuccess(false);
    } finally {
      setBusyId("");
    }
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>, location: ManagedLocation) {
    event.preventDefault();
    await update(location, { name: editName.trim(), isPublic: editPublic, sortOrder: Number(editSortOrder) }, "Кабінет оновлено.");
  }

  async function remove(location: ManagedLocation) {
    if (!location.canDelete || !writesEnabled) return;
    const confirmation = window.prompt(`Безповоротно видаляється лише порожній кабінет. Для підтвердження введіть точну назву:\n${location.name}`)?.trim();
    if (confirmation !== location.name) return;
    setBusyId(location.id);
    setMessage("");
    try {
      await apiJson(`/api/librarian/locations/${encodeURIComponent(location.id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: crypto.randomUUID(), expectedUpdatedAt: location.updatedAt, confirmation }),
      });
      setMessage("Порожній кабінет видалено.");
      setSuccess(true);
      await load(true);
      onChanged();
    } catch (error) {
      setMessage(errorMessage(error));
      setSuccess(false);
    } finally {
      setBusyId("");
    }
  }

  return (
    <div className={styles.locationManager}>
      <form className={styles.locationCreate} onSubmit={create}>
        <div className={styles.formHeading}><div><p>Новий запис</p><h2>Додати кабінет</h2><small>Нові місця створюються як навчальні кабінети.</small></div></div>
        <div className={styles.formGrid}>
          <EditField label="Назва кабінету" required><input value={createName} maxLength={160} onChange={(event) => setCreateName(event.target.value)} placeholder="Наприклад, Кабінет № 206" required /></EditField>
          <EditField label="Порядок у списку"><input type="number" min="0" max="9999" value={createSortOrder} onChange={(event) => setCreateSortOrder(event.target.value)} /></EditField>
          <label className={styles.receiptToggle}><input type="checkbox" aria-label="Показувати кабінет у відкритих списках" checked={createPublic} onChange={(event) => setCreatePublic(event.target.checked)} /><span><strong>Показувати у відкритих списках</strong><small>Назва може використовуватися у публічних формах.</small></span></label>
        </div>
        <div className={styles.formActions}><span>Видалити можна лише порожній кабінет без історії.</span><button className={styles.primaryButton} type="submit" disabled={!writesEnabled || busyId === "create" || !createName.trim()}>{busyId === "create" ? "Додаємо…" : "Додати кабінет"}</button></div>
      </form>
      {message && state !== "error" ? <InlineMessage tone={success ? "success" : "error"}>{message}</InlineMessage> : null}
      <section className={styles.locationDirectory} aria-labelledby="location-directory-title">
        <div className={styles.formHeading}><div><p>{locations.length} місць</p><h2 id="location-directory-title">Усі кабінети й місця</h2><small>Закриті місця залишаються в історії, але зникають із робочих списків.</small></div><button type="button" title="Оновити" aria-label="Оновити список кабінетів" onClick={() => void load()} disabled={state === "loading"}><SiteIcon name="refresh" size={18} /></button></div>
        {state === "loading" ? <PanelLoading /> : null}
        {state === "error" ? <InlineMessage tone="error">{message}</InlineMessage> : null}
        {state === "ready" ? <div className={styles.locationList}>{locations.map((location) => (
          <article key={location.id} data-status={location.status}>
            {editingId === location.id ? (
              <form onSubmit={(event) => void saveEdit(event, location)}>
                <EditField label="Назва" required><input value={editName} maxLength={160} onChange={(event) => setEditName(event.target.value)} required /></EditField>
                <EditField label="Порядок"><input type="number" min="0" max="9999" value={editSortOrder} onChange={(event) => setEditSortOrder(event.target.value)} /></EditField>
                <label><input type="checkbox" aria-label="Показувати кабінет у відкритих списках" checked={editPublic} onChange={(event) => setEditPublic(event.target.checked)} /> Публічний список</label>
                <div><button className={styles.primaryButton} type="submit" disabled={busyId === location.id}>Зберегти</button><button className={styles.secondaryButton} type="button" onClick={() => setEditingId("")}>Скасувати</button></div>
              </form>
            ) : (
              <>
                <header><div><span>{location.type === "library" ? "Бібліотека" : location.type === "classroom" ? "Кабінет" : "Інше місце"}</span><h3>{location.name}</h3><small>{location.status === "active" ? "Активний" : "Закритий"} · порядок {location.sortOrder} · {location.isPublic ? "видимий у публічних списках" : "лише для працівників"}</small></div><strong>{location.dependencies.stockQuantity} прим.</strong></header>
                <p>{location.dependencies.activeClasses ? `Класів: ${location.dependencies.activeClasses}. ` : ""}{location.dependencies.activeTeachers ? `Учителів: ${location.dependencies.activeTeachers}. ` : ""}{location.dependencies.activeReservations ? `Резервів: ${location.dependencies.activeReservations}.` : ""}</p>
                <div className={styles.locationActions}>
                  <button className={styles.secondaryButton} type="button" onClick={() => startEdit(location)} disabled={!writesEnabled || busyId === location.id}>Редагувати</button>
                  {location.status === "active" ? <button className={styles.secondaryButton} type="button" onClick={() => void update(location, { status: "inactive" }, "Кабінет закрито без втрати історії.")} disabled={!writesEnabled || busyId === location.id || !location.canDeactivate} title={location.blockers.join(", ") || "Закрити кабінет"}>Закрити</button> : <button className={styles.secondaryButton} type="button" onClick={() => void update(location, { status: "active" }, "Кабінет поновлено.")} disabled={!writesEnabled || busyId === location.id}>Поновити</button>}
                  <button className={styles.dangerButton} type="button" onClick={() => void remove(location)} disabled={!writesEnabled || busyId === location.id || !location.canDelete} title={location.canDelete ? "Видалити порожній кабінет" : "Є пов’язані дані — доступне лише закриття"}>Видалити</button>
                </div>
                {location.blockers.length ? <small className={styles.locationGuard}>Закриття зараз недоступне: {location.blockers.join(", ")}.</small> : null}
              </>
            )}
          </article>
        ))}</div> : null}
      </section>
    </div>
  );
}

type ContactProfileDraft = {
  librarianName: string;
  librarianDescription: string;
  librarianPhone: string;
  librarianEmail: string;
  assistantName: string;
  assistantDescription: string;
  assistantPhone: string;
  assistantEmail: string;
};

const EMPTY_CONTACT_PROFILE: ContactProfileDraft = {
  librarianName: "",
  librarianDescription: "",
  librarianPhone: "",
  librarianEmail: "",
  assistantName: "",
  assistantDescription: "",
  assistantPhone: "",
  assistantEmail: "",
};

function ContactsManagementPanel({ writesEnabled }: { writesEnabled: boolean }) {
  const [draft, setDraft] = useState<ContactProfileDraft>(EMPTY_CONTACT_PROFILE);
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<LoadState>("loading");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);

  const load = useCallback(async () => {
    setState("loading");
    setMessage("");
    try {
      const response = await apiJson<{
        success: true;
        profile: {
          librarian: { name: string; description: string; phone: string; email: string };
          assistant: { name: string; description: string; phone: string; email: string } | null;
          version: number;
        };
      }>("/api/librarian/contacts");
      setDraft({
        librarianName: response.profile.librarian.name,
        librarianDescription: response.profile.librarian.description,
        librarianPhone: response.profile.librarian.phone,
        librarianEmail: response.profile.librarian.email,
        assistantName: response.profile.assistant?.name ?? "",
        assistantDescription: response.profile.assistant?.description ?? "",
        assistantPhone: response.profile.assistant?.phone ?? "",
        assistantEmail: response.profile.assistant?.email ?? "",
      });
      setVersion(response.profile.version);
      setState("ready");
    } catch (error) {
      setMessage(errorMessage(error));
      setSuccess(false);
      setState("error");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function update<K extends keyof ContactProfileDraft>(key: K, value: ContactProfileDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setMessage("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!writesEnabled || version < 1) return;
    setSaving(true);
    setMessage("");
    try {
      const response = await apiJson<{
        success: true;
        profile: { version: number };
      }>("/api/librarian/contacts", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          expectedVersion: version,
          changes: draft,
        }),
      });
      setVersion(response.profile.version);
      setMessage("Контакти збережено й опубліковано на відкритому сайті.");
      setSuccess(true);
      setState("ready");
    } catch (error) {
      setMessage(errorMessage(error));
      setSuccess(false);
    } finally {
      setSaving(false);
    }
  }

  if (state === "loading") return <PanelLoading />;

  return (
    <form className={styles.createCard} onSubmit={save} aria-busy={saving}>
      <div className={styles.formHeading}>
        <div>
          <p>Публічна інформація</p>
          <h2>Контакти бібліотеки</h2>
          <small>Після збереження ці дані бачать усі у вкладці «Контакти». Не додавайте приватну інформацію, яку не хочете публікувати.</small>
        </div>
        <button type="button" title="Оновити" aria-label="Оновити контакти бібліотеки" onClick={() => void load()} disabled={saving}><SiteIcon name="refresh" size={18} /></button>
      </div>
      {message ? <InlineMessage tone={success ? "success" : "error"}>{message}</InlineMessage> : null}
      {state === "error" ? (
        <div className={styles.formActions}>
          <span>Не вдалося відкрити форму.</span>
          <button className={styles.secondaryButton} type="button" onClick={() => void load()}>Спробувати ще раз</button>
        </div>
      ) : (
        <>
          <div className={styles.formGrid}>
            <EditField label="ПІБ бібліотекаря" wide>
              <input value={draft.librarianName} maxLength={160} onChange={(event) => update("librarianName", event.target.value)} placeholder="Прізвище, ім’я та по батькові" />
            </EditField>
            <EditField label="Телефон">
              <input type="tel" value={draft.librarianPhone} maxLength={80} onChange={(event) => update("librarianPhone", event.target.value)} placeholder="+380 …" />
            </EditField>
            <EditField label="Електронна пошта">
              <input type="email" value={draft.librarianEmail} maxLength={254} onChange={(event) => update("librarianEmail", event.target.value)} placeholder="library@example.com" />
            </EditField>
            <EditField label="Інформація про бібліотекаря" wide>
              <textarea rows={5} value={draft.librarianDescription} maxLength={2000} onChange={(event) => update("librarianDescription", event.target.value)} placeholder="Напишіть години роботи, як звернутися та іншу корисну інформацію." />
            </EditField>
          </div>
          <div className={styles.formHeading}>
            <div>
              <p>Необов’язково</p>
              <h2>Помічник бібліотекаря</h2>
              <small>Залиште всі поля порожніми, доки помічника немає. Тоді цей блок не показуватиметься на сайті.</small>
            </div>
          </div>
          <div className={styles.formGrid}>
            <EditField label="ПІБ помічника" wide>
              <input value={draft.assistantName} maxLength={160} onChange={(event) => update("assistantName", event.target.value)} placeholder="Прізвище, ім’я та по батькові" />
            </EditField>
            <EditField label="Телефон помічника">
              <input type="tel" value={draft.assistantPhone} maxLength={80} onChange={(event) => update("assistantPhone", event.target.value)} />
            </EditField>
            <EditField label="Електронна пошта помічника">
              <input type="email" value={draft.assistantEmail} maxLength={254} onChange={(event) => update("assistantEmail", event.target.value)} />
            </EditField>
            <EditField label="Інформація про помічника" wide>
              <textarea rows={4} value={draft.assistantDescription} maxLength={2000} onChange={(event) => update("assistantDescription", event.target.value)} />
            </EditField>
          </div>
          <div className={styles.formActions}>
            <span>Версія даних: {version || "—"}</span>
            <button className={styles.primaryButton} type="submit" disabled={!writesEnabled || saving || version < 1}>{saving ? "Зберігаємо…" : "Зберегти й опублікувати"}</button>
          </div>
        </>
      )}
    </form>
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
      <span aria-hidden="true"><SiteIcon name="catalog" size={28} /></span>
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

function readPendingClassCirculationIntent<Payload extends Record<string, unknown>>(
  kind: ClassCirculationIntentKind,
): PendingClassCirculationIntent<Payload> | null {
  if (typeof window === "undefined") return null;
  try {
    return readStoredClassCirculationIntent<Payload>(window.sessionStorage, kind);
  } catch {
    return null;
  }
}

function writePendingClassCirculationIntent<Payload extends Record<string, unknown>>(
  intent: PendingClassCirculationIntent<Payload>,
): boolean {
  if (typeof window === "undefined") return false;
  try {
    writeStoredClassCirculationIntent(window.sessionStorage, intent);
    return true;
  } catch {
    return false;
  }
}

function clearPendingClassCirculationIntent(kind: ClassCirculationIntentKind): void {
  if (typeof window === "undefined") return;
  try {
    clearStoredClassCirculationIntent(window.sessionStorage, kind);
  } catch {
    // A completed or terminal server response remains authoritative.
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

const DEFINITIVE_ARCHIVE_FAILURES = new Set([
  "validation_failed",
  "authentication_required",
  "access_denied",
  "allowlist_not_configured",
  "cross_origin_request",
  "actor_not_mapped",
  "material_not_found",
  "material_version_conflict",
  "material_has_stock",
  "material_archive_conflict",
  "request_id_conflict",
  "unsupported_media_type",
  "invalid_json",
]);

const DEFINITIVE_CLASS_CIRCULATION_FAILURES = new Set([
  "validation_failed",
  "authentication_required",
  "access_denied",
  "allowlist_not_configured",
  "cross_origin_request",
  "actor_not_mapped",
  "class_year_not_found",
  "class_year_not_active",
  "class_year_version_conflict",
  "responsible_teacher_not_found",
  "stock_quantity_conflict",
  "insufficient_stock",
  "class_loan_not_found",
  "class_loan_already_closed",
  "class_loan_version_conflict",
  "class_loan_item_not_found",
  "return_quantity_exceeds_outstanding",
  "location_not_found",
  "return_date_invalid",
  "issue_date_outside_class_year",
  "due_date_outside_class_year",
  "return_date_before_previous_return",
  "writes_disabled",
  "class_loan_items_invalid",
  "class_loan_return_conflict",
  "request_id_conflict",
  "unsupported_media_type",
  "invalid_json",
]);

function isDefinitiveArchiveFailure(error: unknown): boolean {
  return error instanceof ApiError
    && error.status !== 408
    && error.status !== 425
    && error.status !== 429
    && DEFINITIVE_ARCHIVE_FAILURES.has(error.code);
}

function isDefinitiveInventoryFailure(error: unknown): boolean {
  return error instanceof ApiError
    && error.status !== 408
    && error.status !== 425
    && error.status !== 429
    && DEFINITIVE_INVENTORY_FAILURES.has(error.code);
}

function isDefinitiveClassCirculationFailure(error: unknown): boolean {
  return error instanceof ApiError
    && error.status !== 408
    && error.status !== 425
    && error.status !== 429
    && (
      DEFINITIVE_CLASS_CIRCULATION_FAILURES.has(error.code)
      || (error.status >= 400 && error.status < 500)
    );
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
  if (tool === "dashboard") return "Головна";
  if (tool === "create") return "Новий матеріал";
  if (tool === "receipt") return "Надходження";
  if (tool === "transfer") return "Переміщення";
  if (tool === "writeoff") return "Списання";
  if (tool === "count") return "Фактична кількість";
  if (tool === "issue") return "Видача вчителю";
  if (tool === "return") return "Повернення";
  if (tool === "class-issue") return "Видача підручників класу";
  if (tool === "class-return") return "Повернення підручників класу";
  if (tool === "locations") return "Кабінети";
  if (tool === "contacts") return "Контакти";
  if (tool === "academic-year") return "Новий навчальний рік";
  if (tool === "class-create") return "Відкрити клас";
  if (tool === "class-update") return "Змінити клас";
  if (tool === "class-close") return "Закрити клас";
  if (tool === "class-reopen") return "Поновити клас";
  if (tool === "rollover") return "Перехід на новий рік";
  return "Каталог матеріалів";
}

function toolDescription(tool: Tool): string {
  if (tool === "dashboard") return "Пошук, стан робочого місця та найчастіші операції в одному місці.";
  if (tool === "create") return "Додайте видання напряму в нову базу; CAT-ID створиться автоматично.";
  if (tool === "receipt") return "Оберіть матеріал і додайте нові примірники на баланс.";
  if (tool === "transfer") return "Перемістіть примірники між двома місцями однією атомарною операцією.";
  if (tool === "writeoff") return "Зафіксуйте пошкодження, втрату, застарілість або нестачу.";
  if (tool === "count") return "Оберіть матеріал і запишіть те, що порахували на місці.";
  if (tool === "issue") return "Оформіть видачу з конкретного місця зберігання.";
  if (tool === "return") return "Знайдіть відкриту видачу та прийміть повернення.";
  if (tool === "class-issue") return "Зберіть кілька матеріалів і видайте їх активному класу однією операцією.";
  if (tool === "class-return") return "Прийміть повне або часткове повернення комплектів від класу.";
  if (tool === "locations") return "Додавайте, перейменовуйте, закривайте або безпечно видаляйте порожні кабінети.";
  if (tool === "contacts") return "Редагуйте інформацію про бібліотекаря та майбутнього помічника для відкритого сайту.";
  if (tool === "academic-year") return "Підготуйте наступний навчальний період напряму в D1.";
  if (tool === "class-create") return "Створіть клас у навчальному році та призначте керівника й кабінет.";
  if (tool === "class-update") return "Оновіть назву, керівника, кабінет або примітку без чернетки.";
  if (tool === "class-close") return "Завершіть клас без видалення його історії.";
  if (tool === "class-reopen") return "Поверніть помилково закритий клас до активного навчального року з повним аудитом.";
  if (tool === "rollover") return "Завершіть поточний рік і перенесіть усі класи контрольованою операцією.";
  return "Швидкий пошук, усі посилання, примірники та пряме редагування.";
}

function conditionLabel(value: string | null): string {
  if (value === "good") return "добрий стан";
  if (value === "worn") return "зношений";
  if (value === "damaged") return "пошкоджений";
  return "стан не уточнено";
}

function normalizeCopyCondition(value: string | null): CopyCondition {
  if (value === "good" || value === "worn" || value === "damaged") return value;
  return "unspecified";
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

function facetInputHint(state: LoadState, pluralLabel: string): string {
  if (state === "loading") return `Оновлюємо список ${pluralLabel}…`;
  if (state === "error") return `Список ${pluralLabel} тимчасово недоступний. Значення можна ввести вручну.`;
  return "Почніть вводити — з’являться варіанти з каталогу.";
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
