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
    label: "–ù–æ–≤–∏–π –º–∞—Ç–µ—Ä—ñ–∞–ª",
    shortLabel: "–î–æ–¥–∞—Ç–∏",
    description: "–ü—ñ–¥–≥–æ—Ç—É–π—Ç–µ –±—ñ–±–ª—ñ–æ–≥—Ä–∞—Ñ—ñ—á–Ω—É –∫–∞—Ä—Ç–∫—É",
    icon: "Ôºã",
  },
  {
    kind: "material.update",
    group: "catalog",
    label: "–†–µ–¥–∞–≥—É–≤–∞–Ω–Ω—è –º–∞—Ç–µ—Ä—ñ–∞–ª—É",
    shortLabel: "–†–µ–¥–∞–≥—É–≤–∞—Ç–∏",
    description: "–ü—ñ–¥–≥–æ—Ç—É–π—Ç–µ –≤–∏–ø—Ä–∞–≤–ª–µ–Ω–Ω—è –∫–∞—Ä—Ç–∫–∏",
    icon: "‚úé",
  },
  {
    kind: "receipt.create",
    group: "movement",
    label: "–ù–∞–¥—Ö–æ–¥–∂–µ–Ω–Ω—è",
    shortLabel: "–ù–∞–¥—Ö–æ–¥–∂–µ–Ω–Ω—è",
    description: "–ó–∞—Ñ—ñ–∫—Å—É–π—Ç–µ –Ω–æ–≤—ñ –ø—Ä–∏–º—ñ—Ä–Ω–∏–∫–∏",
    icon: "‚Üì",
  },
  {
    kind: "transfer.create",
    group: "movement",
    label: "–ü–µ—Ä–µ–º—ñ—â–µ–Ω–Ω—è",
    shortLabel: "–ü–µ—Ä–µ–º—ñ—Å—Ç–∏—Ç–∏",
    description: "–ü—ñ–¥–≥–æ—Ç—É–π—Ç–µ –∑–º—ñ–Ω—É —Ä–æ–∑–º—ñ—â–µ–Ω–Ω—è",
    icon: "‚áÑ",
  },
  {
    kind: "writeoff.create",
    group: "movement",
    label: "–°–ø–∏—Å–∞–Ω–Ω—è",
    shortLabel: "–°–ø–∏—Å–∞—Ç–∏",
    description: "–ü—ñ–¥–≥–æ—Ç—É–π—Ç–µ –∞–∫—Ç —Å–ø–∏—Å–∞–Ω–Ω—è –∞–±–æ –≤—Ç—Ä–∞—Ç–∏",
    icon: "‚àí",
  },
  {
    kind: "revision.count",
    group: "movement",
    label: "–†–µ–≤—ñ–∑—ñ—è",
    shortLabel: "–†–µ–≤—ñ–∑—ñ—è",
    description: "–ó–∞–ø–∏—à—ñ—Ç—å —Ñ–∞–∫—Ç–∏—á–Ω—É –∫—ñ–ª—å–∫—ñ—Å—Ç—å",
    icon: "‚úì",
  },
  {
    kind: "academic-year.create",
    group: "classes",
    label: "–ù–æ–≤–∏–π –Ω–∞–≤—á–∞–ª—å–Ω–∏–π —Ä—ñ–∫",
    shortLabel: "–ù–æ–≤–∏–π —Ä—ñ–∫",
    description: "–ü—ñ–¥–≥–æ—Ç—É–π—Ç–µ –Ω–∞—Å—Ç—É–ø–Ω–∏–π –Ω–∞–≤—á–∞–ª—å–Ω–∏–π –ø–µ—Ä—ñ–æ–¥",
    icon: "‚ñ£",
  },
  {
    kind: "class-year.create",
    group: "classes",
    label: "–í—ñ–¥–∫—Ä–∏—Ç–∏ –∫–ª–∞—Å",
    shortLabel: "–í—ñ–¥–∫—Ä–∏—Ç–∏ –∫–ª–∞—Å",
    description: "–î–æ–¥–∞–π—Ç–µ –∫–ª–∞—Å –¥–æ –Ω–∞–≤—á–∞–ª—å–Ω–æ–≥–æ —Ä–æ–∫—É",
    icon: "+",
  },
  {
    kind: "class-year.update",
    group: "classes",
    label: "–ó–º—ñ–Ω–∏—Ç–∏ –∫–ª–∞—Å",
    shortLabel: "–ó–º—ñ–Ω–∏—Ç–∏ –∫–ª–∞—Å",
    description: "–ó–º—ñ–Ω—ñ—Ç—å –∫–µ—Ä—ñ–≤–Ω–∏–∫–∞, –∫–∞–±—ñ–Ω–µ—Ç –∞–±–æ –Ω–∞–∑–≤—É",
    icon: "‚Üª",
  },
  {
    kind: "class-year.close",
    group: "classes",
    label: "–ó–∞–∫—Ä–∏—Ç–∏ –∫–ª–∞—Å",
    shortLabel: "–ó–∞–∫—Ä–∏—Ç–∏ –∫–ª–∞—Å",
    description: "–ó–±–µ—Ä–µ–∂—ñ—Ç—å —ñ—Å—Ç–æ—Ä—ñ—é –∑–∞–∫—Ä–∏—Ç–æ–≥–æ –∫–ª–∞—Å—É",
    icon: "√ó",
  },
  {
    kind: "academic-year.rollover",
    group: "classes",
    label: "–ü–µ—Ä–µ—Ö—ñ–¥ –Ω–∞ –Ω–æ–≤–∏–π —Ä—ñ–∫",
    shortLabel: "–ü–µ—Ä–µ—Ö—ñ–¥ –∫–ª–∞—Å—ñ–≤",
    description: "–ü–µ—Ä–µ–≤–µ–¥—ñ—Ç—å –∫–ª–∞—Å–∏ –∑—ñ –∑–±–µ—Ä–µ–∂–µ–Ω–Ω—è–º —ñ—Å—Ç–æ—Ä—ñ—ó",
    icon: "‚á¢",
  },
];

const KIND_LABELS: Record<DraftKind, string> = {
  "material.create": "–ù–æ–≤–∏–π –º–∞—Ç–µ—Ä—ñ–∞–ª",
  "material.update": "–†–µ–¥–∞–≥—É–≤–∞–Ω–Ω—è –º–∞—Ç–µ—Ä—ñ–∞–ª—É",
  "receipt.create": "–ù–∞–¥—Ö–æ–¥–∂–µ–Ω–Ω—è",
  "transfer.create": "–ü–µ—Ä–µ–º—ñ—â–µ–Ω–Ω—è",
  "writeoff.create": "–°–ø–∏—Å–∞–Ω–Ω—è",
  "revision.count": "–†–µ–≤—ñ–∑—ñ—è",
  "academic-year.create": "–ù–æ–≤–∏–π –Ω–∞–≤—á–∞–ª—å–Ω–∏–π —Ä—ñ–∫",
  "class-year.create": "–í—ñ–¥–∫—Ä–∏—Ç–∏ –∫–ª–∞—Å",
  "class-year.update": "–ó–º—ñ–Ω–∏—Ç–∏ –∫–ª–∞—Å",
  "class-year.close": "–ó–∞–∫—Ä–∏—Ç–∏ –∫–ª–∞—Å",
  "academic-year.rollover": "–ü–µ—Ä–µ—Ö—ñ–¥ –Ω–∞ –Ω–æ–≤–∏–π —Ä—ñ–∫",
};

const SCENARIO_GROUPS = [
  { id: "catalog" as const, label: "–ö–∞—Ç–∞–ª–æ–≥" },
  { id: "movement" as const, label: "–û–±–ª—ñ–∫ –ø—Ä–∏–º—ñ—Ä–Ω–∏–∫—ñ–≤" },
  { id: "classes" as const, label: "–ù–∞–≤—á–∞–ª—å–Ω—ñ —Ä–æ–∫–∏ –π –∫–ª–∞—Å–∏" },
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
  const [loadMessage, setLoadMessage] = useState("–ó–∞–≤–∞–Ω—Ç–∞–∂—É—î–º–æ —Å–ª—É–∂–±–æ–≤—ñ –¥–∞–Ω—ñ‚Ä¶");
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [apiStats, setApiStats] = useState<Record<string, unknown>>({});
  const [referenceData, setReferenceData] = useState<ReferenceData>(EMPTY_REFERENCE_DATA);
  const [referenceState, setReferenceState] = useState<ReferenceState>({
    phase: "loading",
    message: "–ó–∞–≤–∞–Ω—Ç–∞–∂—É—î–º–æ –∑–∞—Ö–∏—â–µ–Ω—ñ –¥–æ–≤—ñ–¥–Ω–∏–∫–∏‚Ä¶",
    generatedAt: null,
  });
  const [submitState, setSubmitState] = useState<SubmitState>({
    phase: "idle",
    message: "",
  });

  const loadWorkspace = useCallback(async (signal?: AbortSignal) => {
    setLoadState("loading");
    setLoadMessage("–ó–∞–≤–∞–Ω—Ç–∞–∂—É—î–º–æ —Å–ª—É–∂–±–æ–≤—ñ –¥–∞–Ω—ñ‚Ä¶");
    setReferenceState((current) => ({
      ...current,
      phase: "loading",
      message: "–ó–∞–≤–∞–Ω—Ç–∞–∂—É—î–º–æ –∑–∞—Ö–∏—â–µ–Ω—ñ –¥–æ–≤—ñ–¥–Ω–∏–∫–∏‚Ä¶",
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
        throw new Error(readApiError(catalogBody, "–ù–µ –≤–¥–∞–ª–æ—Å—è –∑–∞–≤–∞–Ω—Ç–∞–∂–∏—Ç–∏ –∫–∞—Ç–∞–ª–æ–≥"));
      }
      if (!draftsResponse.ok || draftsBody.success !== true) {
        throw new Error(readApiError(draftsBody, "–ù–µ –≤–¥–∞–ª–æ—Å—è –∑–∞–≤–∞–Ω—Ç–∞–∂–∏—Ç–∏ —á–µ—Ä–Ω–µ—Ç–∫–∏"));
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
          message: "–ó–∞—Ö–∏—â–µ–Ω—ñ –¥–æ–≤—ñ–¥–Ω–∏–∫–∏ –∑–∞–≤–∞–Ω—Ç–∞–∂–µ–Ω–æ",
          generatedAt: typeof referenceBody.generatedAt === "string"
            ? referenceBody.generatedAt
            : null,
        });
      } else {
        setReferenceData(EMPTY_REFERENCE_DATA);
        setReferenceState({
          phase: "error",
          message: readApiError(referenceBody, "–ó–∞—Ö–∏—â–µ–Ω—ñ –¥–æ–≤—ñ–¥–Ω–∏–∫–∏ —Ç–∏–º—á–∞—Å–æ–≤–æ –Ω–µ–¥–æ—Å—Ç—É–ø–Ω—ñ"),
          generatedAt: null,
        });
      }
      setLoadState("ready");
      setLoadMessage("–î–∞–Ω—ñ –≥–æ—Ç–æ–≤—ñ –¥–æ —Ä–æ–±–æ—Ç–∏");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setLoadState("error");
      setLoadMessage(error instanceof Error ? error.message : "–°—Ç–∞–ª–∞—Å—è –ø–æ–º–∏–ª–∫–∞ –∑–∞–≤–∞–Ω—Ç–∞–∂–µ–Ω–Ω—è");
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
      setSubmitState({ phase: "saving", message: "–ó–±–µ—Ä—ñ–≥–∞—î–º–æ —á–µ—Ä–Ω–µ—Ç–∫—É‚Ä¶" });

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
            ? "–ß–µ—Ä–Ω–µ—Ç–∫–∞ –∑–º—ñ–Ω–∏–ª–∞—Å—è –≤ —ñ–Ω—à—ñ–π –≤–∫–ª–∞–¥—Ü—ñ –∞–±–æ –≤–∂–µ –Ω–∞–¥—ñ—Å–ª–∞–Ω–∞. –î–∞–Ω—ñ –Ω–µ –ø–µ—Ä–µ–∑–∞–ø–∏—Å–∞–Ω–æ ‚Äî –æ–Ω–æ–≤—ñ—Ç—å —Å–ø–∏—Å–æ–∫ —ñ –≤—ñ–¥–∫—Ä–∏–π—Ç–µ —á–µ—Ä–Ω–µ—Ç–∫—É –∑–Ω–æ–≤—É."
            : fieldMessage || readApiError(body, "–ù–µ –≤–¥–∞–ª–æ—Å—è –∑–±–µ—Ä–µ–≥—Ç–∏ —á–µ—Ä–Ω–µ—Ç–∫—É");
          setSubmitState({ phase: "error", message });
          return { draft: null, fieldErrors, stale };
        }

        setDrafts((current) => [body.draft, ...current.filter((item) => item.id !== body.draft.id)]);
        setEditingDraft((current) => current?.id === body.draft.id ? body.draft : current);
        setSubmitState({
          phase: "success",
          message: `–ß–µ—Ä–Ω–µ—Ç–∫—É ${shortDraftId(body.draft.id)} –∑–±–µ—Ä–µ–∂–µ–Ω–æ. Google Sheets –Ω–µ –∑–º—ñ–Ω–µ–Ω–æ.`,
        });
        return { draft: body.draft as SavedDraft, fieldErrors: {} };
      } catch (error) {
        setSubmitState({
          phase: "error",
          message: error instanceof Error ? error.message : "–ù–µ –≤–¥–∞–ª–æ—Å—è –∑–±–µ—Ä–µ–≥—Ç–∏ —á–µ—Ä–Ω–µ—Ç–∫—É",
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
          ? "–ù–∞–¥—Å–∏–ª–∞—î–º–æ —á–µ—Ä–Ω–µ—Ç–∫—É –Ω–∞ –ø–µ—Ä–µ–≤—ñ—Ä–∫—É‚Ä¶"ﬂç7“⁄$z{-ÆÈ‹j◊ù&WGW&‚GóVˆb&ˆGíÊW'&˜"””“'7G&ñÊr"Ú&ˆGíÊW'&˜"¢f∆∆&6≥∞ß–†¶gVÊ7Fñˆ‚f˜&÷DfñV∆DW'&˜'2áf«VS¢VÊ∂Ê˜v‚ì¢7G&ñÊr∞¢ñbÇó5&V6˜&Báf«VRíí&WGW&‚"#∞¢6ˆÁ7B÷W76vW2“ˆ&¶V7BÁf«VW2áf«VRíÊfñ«FW"ÇÜóFV“ì¢óFV“ó27G&ñÊr”‚GóVˆbóFV“””“'7G&ñÊr"ì∞¢&WGW&‚÷W76vW2Ê¶ˆñ‚Ç""ì∞ß–†¶gVÊ7Fñˆ‚&VDfñV∆DW'&˜'2áf«VS¢VÊ∂Ê˜v‚ì¢&V6˜&C«7G&ñÊr¬7G&ñÊs‚∞¢ñbÇó5&V6˜&Báf«VRíí&WGW&‚∑”∞¢&WGW&‚ˆ&¶V7BÊg&ˆ‘VÁG&ñW2Ä¢ˆ&¶V7BÊVÁG&ñW2áf«VRíÊfñ«FW"ÇÜVÁG'íì¢VÁG'íó2∑7G&ñÊr¬7G&ñÊu“”‚GóVˆbVÁG'ï≥“””“'7G&ñÊr"í¿¢ì∞ß–†¶gVÊ7Fñˆ‚ó5&V6˜&Báf«VS¢VÊ∂Ê˜v‚ì¢f«VRó2&V6˜&C«7G&ñÊr¬VÊ∂Ê˜v„‚∞¢&WGW&‚&ˆˆ∆V‚áf«VRíbbGóVˆbf«VR””“&ˆ&¶V7B"bb'&íÊó4'&íáf«VRì∞ß–†¶gVÊ7Fñˆ‚Ê˜&÷∆ó¶U&VfW&VÊ6TFFáf«VS¢&V6˜&C«7G&ñÊr¬VÊ∂Ê˜v„‚ì¢&VfW&VÊ6TFF∞¢6ˆÁ7BFV6ÜW'2“'&íÊó4'&íáf«VRÁFV6ÜW'2ê¢Úf«VRÁFV6ÜW'2Êf∆D÷ÇÜóFV“ì¢&VfW&VÊ6UFV6ÜW%µ“”‚∞¢ñbÇó5&V6˜&BÜóFV“íí&WGW&‚µ”∞¢6ˆÁ7BñB“&VEFWáBÜóFV“¬≤&ñB%“ì∞¢6ˆÁ7BÊ÷R“&VEFWáBÜóFV“¬≤&Ê÷R%“ì∞¢ñbÇıÂU5"’∆G≥2«“B˜RÁFW7BÜñBí«¬Ê÷Rí&WGW&‚µ”∞¢&WGW&‚∑≤ñB¬Ê÷R¬&ˆ∆S¢&VEFWáBÜóFV“¬≤'&ˆ∆R%“í¬7FGW3¢&VEFWáBÜóFV“¬≤'7FGW2%“í’”∞¢“ê¢¢µ”∞¢6ˆÁ7B∆ˆ6FñˆÁ2“'&íÊó4'&íáf«VRÊ∆ˆ6FñˆÁ2ê¢Úf«VRÊ∆ˆ6FñˆÁ2Êf∆D÷ÇÜóFV“ì¢&VfW&VÊ6T∆ˆ6FñˆÂµ“”‚∞¢ñbÇó5&V6˜&BÜóFV“íí&WGW&‚µ”∞¢6ˆÁ7BñB“&VEFWáBÜóFV“¬≤&ñB%“ì∞¢6ˆÁ7BÊ÷R“&VEFWáBÜóFV“¬≤&Ê÷R%“ì∞¢ñbÇı‰ƒÙ2’∆G≥2«“B˜RÁFW7BÜñBí«¬Ê÷R«¬ñB””“$ƒÙ2”r"«¬ñB””“$ƒÙ2”Ç"í&WGW&‚µ”∞¢&WGW&‚∑≤ñB¬Ê÷R¬GóS¢&VEFWáBÜóFV“¬≤'GóR%“í¬7FGW3¢&VEFWáBÜóFV“¬≤'7FGW2%“í’”∞¢“ê¢¢µ”∞¢6ˆÁ7B6FV÷ñ5ñV'2“'&íÊó4'&íáf«VRÊ6FV÷ñ5ñV'2ê¢Úf«VRÊ6FV÷ñ5ñV'2Êf∆D÷ÇÜóFV“ì¢&VfW&VÊ6T6FV÷ñ5ñV%µ“”‚∞¢ñbÇó5&V6˜&BÜóFV“íí&WGW&‚µ”∞¢6ˆÁ7BñB“&VEFWáBÜóFV“¬≤&ñB%“ì∞¢6ˆÁ7B∆&V¬“&VEFWáBÜóFV“¬≤&∆&V¬%“ì∞¢ñbÇıÂï"”#∆G≥'“”#∆G≥'“B˜RÁFW7BÜñBí«¬ı„#∆G≥'’¬Û#∆G≥'“B˜RÁFW7BÜ∆&V¬íí&WGW&‚µ”∞¢&WGW&‚∑∞¢ñB¿¢∆&V¬¿¢7F'DFFS¢&VEFWáBÜóFV“¬≤'7F'DFFR%“í¿¢VÊDFFS¢&VEFWáBÜóFV“¬≤&VÊDFFR%“í¿¢7FGW3¢&VEFWáBÜóFV“¬≤'7FGW2%“í¿¢Ê˜FW3¢&VEFWáBÜóFV“¬≤&Ê˜FW2%“í¿¢’”∞¢“ê¢¢µ”∞¢6ˆÁ7B6∆75ñV'2“'&íÊó4'&íáf«VRÊ6∆75ñV'2ê¢Úf«VRÊ6∆75ñV'2Êf∆D÷ÇÜóFV“ì¢&VfW&VÊ6T6∆75ñV%µ“”‚∞¢ñbÇó5&V6˜&BÜóFV“íí&WGW&‚µ”∞¢6ˆÁ7BñB“&VEFWáBÜóFV“¬≤&ñB%“ì∞¢6ˆÁ7B6FV÷ñ5ñV$ñB“&VEFWáBÜóFV“¬≤&6FV÷ñ5ñV$ñB%“ì∞¢ñbÇı‰5í”#∆G≥'“’∆G≥2«“B˜RÁFW7BÜñBí«¬ıÂï"”#∆G≥'“”#∆G≥'“B˜RÁFW7BÜ6FV÷ñ5ñV$ñBíí&WGW&‚µ”∞¢6ˆÁ7Bw&FR“&VDÁV÷&W"ÜóFV“¬≤&w&FR%“ì∞¢&WGW&‚∑∞¢ñB¿¢6FV÷ñ5ñV$ñB¿¢6FV÷ñ5ñV$∆&V√¢&VEFWáBÜóFV“¬≤&6FV÷ñ5ñV$∆&V¬%“í¿¢6ˆÜ˜'DñC¢&VEFWáBÜóFV“¬≤&6ˆÜ˜'DñB%“í¿¢6∆74Ê÷S¢&VEFWáBÜóFV“¬≤&6∆74Ê÷R%“í¿¢w&FR¿¢6ˆFS¢&VEFWáBÜóFV“¬≤&6ˆFR%“í¿¢FV6ÜW$Ê÷S¢&VEFWáBÜóFV“¬≤'FV6ÜW$Ê÷R%“í¿¢FV6ÜW%W6W$ñC¢&VEFWáBÜóFV“¬≤'FV6ÜW%W6W$ñB%“í¿¢∆ˆ6Fñˆ‰Ê÷S¢&VEFWáBÜóFV“¬≤&∆ˆ6Fñˆ‰Ê÷R%“í¿¢∆ˆ6Fñˆ‰ñC¢&VEFWáBÜóFV“¬≤&∆ˆ6Fñˆ‰ñB%“í¿¢7F'DFFS¢&VEFWáBÜóFV“¬≤'7F'DFFR%“í¿¢VÊDFFS¢&VEFWáBÜóFV“¬≤&VÊDFFR%“í¿¢7FGW3¢&VEFWáBÜóFV“¬≤'7FGW2%“í¿¢7GVƒ6∆˜6VDFFS¢&VEFWáBÜóFV“¬≤&7GVƒ6∆˜6VDFFR%“í¿¢Ê˜FW3¢&VEFWáBÜóFV“¬≤&Ê˜FW2%“í¿¢’”∞¢“ê¢¢µ”∞¢&WGW&‚≤FV6ÜW'2¬∆ˆ6FñˆÁ2¬6FV÷ñ5ñV'2¬6∆75ñV'2”∞ß–†¶gVÊ7Fñˆ‚&VEFWáBá&V6˜&C¢&V6˜&C«7G&ñÊr¬VÊ∂Ê˜v„‚¬∂Wó3¢7G&ñÊuµ“ì¢7G&ñÊr∞¢f˜"Ü6ˆÁ7B∂Wíˆb∂Wó2í∞¢6ˆÁ7Bf«VR“&V6˜&E∂∂Wï”∞¢ñbáGóVˆbf«VR””“'7G&ñÊr"bbf«VRÁG&ñ“Çíí&WGW&‚f«VRÁG&ñ“Çì∞¢ñbáGóVˆbf«VR””“&ÁV÷&W""í&WGW&‚7G&ñÊráf«VRì∞¢–¢&WGW&‚"#∞ß–†¶gVÊ7Fñˆ‚ñÊóFñƒfñV∆Báñ∆ˆC¢&V6˜&C«7G&ñÊr¬VÊ∂Ê˜v„‚¬∂Wì¢7G&ñÊrì¢7G&ñÊr∞¢6ˆÁ7Bf«VR“ñ∆ˆE∂∂Wï”∞¢&WGW&‚GóVˆbf«VR””“'7G&ñÊr"«¬GóVˆbf«VR””“&ÁV÷&W""Ú7G&ñÊráf«VRí¢"#∞ß–†¶gVÊ7Fñˆ‚ÊW7FVE&V6˜&Báñ∆ˆC¢&V6˜&C«7G&ñÊr¬VÊ∂Ê˜v„‚¬∂Wì¢7G&ñÊrì¢&V6˜&C«7G&ñÊr¬VÊ∂Ê˜v„‚∞¢&WGW&‚ó5&V6˜&Báñ∆ˆE∂∂Wï“íÚñ∆ˆE∂∂Wï“2&V6˜&C«7G&ñÊr¬VÊ∂Ê˜v„‚¢∑”∞ß–†¶gVÊ7Fñˆ‚ñÊóFñƒ&ˆˆ∆V‰fñV∆BÄ¢ñ∆ˆC¢&V6˜&C«7G&ñÊr¬VÊ∂Ê˜v„‚¿¢∂Wì¢7G&ñÊr¿¢f∆∆&6≥¢&ˆˆ∆V‚¿¢ì¢7G&ñÊr∞¢6ˆÁ7Bf«VR“ñ∆ˆE∂∂Wï”∞¢&WGW&‚f«VR””“G'VR«¬f«VR””“'G'VR ¢Ú'G'VR ¢¢f«VR””“f«6R«¬f«VR””“&f«6R ¢Ú&f«6R ¢¢f∆∆&6≤Ú'G'VR"¢&f«6R#∞ß–†¶gVÊ7Fñˆ‚ÁV∆∆&∆TFó&V7F˜'îñÊóFñ¬áñ∆ˆC¢&V6˜&C«7G&ñÊr¬VÊ∂Ê˜v„‚¬∂Wì¢7G&ñÊrì¢7G&ñÊr∞¢&WGW&‚ˆ&¶V7BÊÜ4˜v‚áñ∆ˆB¬∂Wííbbñ∆ˆE∂∂Wï“””“ÁV∆¿¢Ú%ıˆ6∆V%ıÚ ¢¢ñÊóFñƒfñV∆Báñ∆ˆB¬∂Wíì∞ß–†¶gVÊ7Fñˆ‚&˜FV7FVD∆ˆ6FñˆÁ2á&VfW&VÊ6TFF¢&VfW&VÊ6TFFì¢&VfW&VÊ6T∆ˆ6FñˆÂµ“∞¢&WGW&‚&VfW&VÊ6TFFÊ∆ˆ6FñˆÁ0¢Êfñ«FW"ÇÜ∆ˆ6Fñˆ‚í”‚Ä¢ı‰ƒÙ2’∆G≥2«“B˜RÁFW7BÜ∆ˆ6Fñˆ‚ÊñBê¢bb∆ˆ6Fñˆ‚ÊñB”“$ƒÙ2”r ¢bb∆ˆ6Fñˆ‚ÊñB”“$ƒÙ2”Ç ¢bb∆ˆ6Fñˆ‚ÊÊ÷RÁG&ñ“Çê¢íê¢Á6˜'BÇÜ∆VgB¬&ñváBí”‚∆VgBÊÊ÷RÊ∆ˆ6∆T6ˆ◊&Rá&ñváBÊÊ÷R¬'V≤"¬≤ÁV÷W&ñ3¢G'VR“íì∞ß–†¶gVÊ7Fñˆ‚VÊóVT6ˆÜ˜'G2Ü6∆75ñV'3¢&VfW&VÊ6T6∆75ñV%µ“ì¢'&ì«≤ñC¢7G&ñÊs≤∆&V√¢7G&ñÊr”‚∞¢6ˆÁ7B6ˆÜ˜'G2“ÊWr÷«7G&ñÊr¬7G&ñÊs‚Çì∞¢6∆75ñV'2Êf˜$V6ÇÇÜóFV“í”‚∞¢ñbÇı‰4ÙÇ’∆G≥2«“B˜RÁFW7BÜóFV“Ê6ˆÜ˜'DñBíí&WGW&„∞¢6ˆÁ7B∆&V¬“∂óFV“Ê6∆74Ê÷R¬óFV“Ê6FV÷ñ5ñV$∆&V≈“Êfñ«FW"Ñ&ˆˆ∆V‚íÊ¶ˆñ‚Ç"+r"í«¬óFV“Ê6ˆÜ˜'DñC∞¢6ˆÜ˜'G2Á6WBÜóFV“Ê6ˆÜ˜'DñB¬∆&V¬ì∞¢“ì∞¢&WGW&‚≤‚‚Ê6ˆÜ˜'G5“Ê÷ÇÖ∂ñB¬∆&V≈“í”‚á≤ñB¬∆&V¬“íê¢Á6˜'BÇÜ∆VgB¬&ñváBí”‚∆VgBÊ∆&V¬Ê∆ˆ6∆T6ˆ◊&Rá&ñváBÊ∆&V¬¬'V≤"¬≤ÁV÷W&ñ3¢G'VR“íì∞ß–†¶gVÊ7Fñˆ‚ÊWáD6FV÷ñ5ñV$ñBÄ¢6˜W&6UñV$ñC¢7G&ñÊr¿¢ñV'3¢&VfW&VÊ6T6FV÷ñ5ñV%µ“¿¢ì¢7G&ñÊr∞¢6ˆÁ7B÷F6Ç“6˜W&6UñV$ñBÊ÷F6ÇÇıÂï"“É#∆G≥'“í“É#∆G≥'“íB˜Rì∞¢ñbÇ÷F6Çí&WGW&‚"#∞¢6ˆÁ7BWáV7FVB“ï"“G¥ÁV÷&W"Ü÷F6Ö≥“í≤““G¥ÁV÷&W"Ü÷F6Ö≥%“í≤÷∞¢&WGW&‚ñV'2Á6ˆ÷RÇáñV"í”‚ñV"ÊñB””“WáV7FVBíÚWáV7FVB¢"#∞ß–†¶gVÊ7Fñˆ‚'Vñ∆E&ˆ∆∆˜fW%&˜w2Ä¢6˜W&6UñV$ñC¢7G&ñÊr¿¢&VfW&VÊ6TFF¢&VfW&VÊ6TFF¿¢ì¢&ˆ∆∆˜fW%&˜uµ“∞¢6ˆÁ7B6fT∆ˆ6FñˆÁ2“&˜FV7FVD∆ˆ6FñˆÁ2á&VfW&VÊ6TFFì∞¢&WGW&‚&VfW&VÊ6TFFÊ6∆75ñV'0¢Êfñ«FW"ÇÜóFV“í”‚Ä¢óFV“Ê6FV÷ñ5ñV$ñB””“6˜W&6UñV$ñ@¢bbı‰5í”#∆G≥'“’∆G≥2«“B˜RÁFW7BÜóFV“ÊñBê¢bbı‰4ÙÇ’∆G≥2«“B˜RÁFW7BÜóFV“Ê6ˆÜ˜'DñBê¢bbGóVˆbóFV“Êw&FR””“&ÁV÷&W" ¢bbóFV“Êw&FR„“¢bbóFV“Êw&FR√“¢bbóFV“Ê7GVƒ6∆˜6VDFFP¢bbˆ6∆˜6VGÕ}≠ç"ˆíÁFW7BÜóFV“Á7FGW2ê¢íê¢Á6˜'BÇÜ∆VgB¬&ñváBí”‚∆VgBÊ6∆74Ê÷RÊ∆ˆ6∆T6ˆ◊&Rá&ñváBÊ6∆74Ê÷R¬'V≤"¬≤ÁV÷W&ñ3¢G'VR“íê¢Ê÷ÇÜóFV“í”‚∞¢6ˆÁ7B∆ˆ6Fñˆ‚“6fT∆ˆ6FñˆÁ2ÊfñÊBÇÜ6ÊFñFFRí”‚6ÊFñFFRÊñB””“óFV“Ê∆ˆ6Fñˆ‰ñBì∞¢6ˆÁ7BFV6ÜW"“&VfW&VÊ6TFFÁFV6ÜW'2ÊfñÊBÇÜ6ÊFñFFRí”‚6ÊFñFFRÊñB””“óFV“ÁFV6ÜW%W6W$ñBì∞¢6ˆÁ7Bw&GVFR“óFV“Êw&FR””“∞¢&WGW&‚∞¢6˜W&6T6∆75ñV$ñC¢óFV“ÊñB¿¢6ˆÜ˜'DñC¢óFV“Ê6ˆÜ˜'DñB¿¢6˜W&6Tw&FS¢óFV“Êw&FR¿¢6∆74Ê÷S¢óFV“Ê6∆74Ê÷R«¬G∂óFV“Êw&FW““G∂óFV“Ê6ˆFW÷¿¢7Fñˆ„¢w&GVFRÚ&w&GVFR"¢'&ˆ÷˜FR"¿¢‚‚‚Üw&GVFRÚ∑“¢∞¢F&vWDw&FS¢óFV“Êw&FR≤¿¢F&vWD6ˆFS¢óFV“Ê6ˆFR«¬6∆746ˆFTg&ˆ‘Ê÷RÜóFV“Ê6∆74Ê÷Rí¿¢“í¿¢‚‚‚áFV6ÜW"Ú≤FV6ÜW%W6W$ñC¢FV6ÜW"ÊñB¬FV6ÜW$Ê÷S¢FV6ÜW"ÊÊ÷R“¢∑“í¿¢‚‚‚Ü∆ˆ6Fñˆ‚Ú≤∆ˆ6Fñˆ‰ñC¢∆ˆ6Fñˆ‚ÊñB¬∆ˆ6Fñˆ‰Ê÷S¢∆ˆ6Fñˆ‚ÊÊ÷R“¢∑“í¿¢“6Fó6fñW2&ˆ∆∆˜fW%&˜s∞¢“ì∞ß–†¶gVÊ7Fñˆ‚&ˆ∆∆˜fW%&˜w4g&ˆ’ñ∆ˆBÄ¢ñ∆ˆC¢&V6˜&C«7G&ñÊr¬VÊ∂Ê˜v„‚¿¢&VfW&VÊ6TFF¢&VfW&VÊ6TFF¿¢ì¢&ˆ∆∆˜fW%&˜uµ“∞¢ñbÇ'&íÊó4'&íáñ∆ˆBÊ6∆76W2íí&WGW&‚µ”∞¢&WGW&‚ñ∆ˆBÊ6∆76W2Êf∆D÷ÇÜóFV“ì¢&ˆ∆∆˜fW%&˜uµ“”‚∞¢ñbÇó5&V6˜&BÜóFV“íí&WGW&‚µ”∞¢6ˆÁ7B6˜W&6T6∆75ñV$ñB“&VEFWáBÜóFV“¬≤'6˜W&6T6∆75ñV$ñB%“ì∞¢6ˆÁ7B6ˆÜ˜'DñB“&VEFWáBÜóFV“¬≤&6ˆÜ˜'DñB%“ì∞¢6ˆÁ7B6˜W&6Tw&FR“&VDÁV÷&W"ÜóFV“¬≤'6˜W&6Tw&FR%“ì∞¢6ˆÁ7B7Fñˆ‚“&VEFWáBÜóFV“¬≤&7Fñˆ‚%“ì∞¢6ˆÁ7B6˜W&6T6∆72“&VfW&VÊ6TFFÊ6∆75ñV'2ÊfñÊBÇÜ6ÊFñFFRí”‚Ä¢6ÊFñFFRÊñB””“6˜W&6T6∆75ñV$ñ@¢íì∞¢ñbÄ¢ı‰5í”#∆G≥'“’∆G≥2«“B˜RÁFW7Bá6˜W&6T6∆75ñV$ñBê¢«¬ı‰4ÙÇ’∆G≥2«“B˜RÁFW7BÜ6ˆÜ˜'DñBê¢«¬6˜W&6Tw&FR””“ÁV∆¿¢«¬≤'&ˆ÷˜FR"¬&w&GVFR"¬&6∆˜6R"¬'6∂ó%“ÊñÊ6«VFW2Ü7Fñˆ‚ê¢í&WGW&‚µ”∞¢&WGW&‚∑∞¢6˜W&6T6∆75ñV$ñB¿¢6ˆÜ˜'DñB¿¢6˜W&6Tw&FR¿¢6∆74Ê÷S¢6˜W&6T6∆73ÚÊ6∆74Ê÷P¢«¬&VEFWáBÜóFV“¬≤&6∆74Ê÷R%“ê¢«¬G∑6˜W&6Tw&FW““G∑6˜W&6T6∆73ÚÊ6ˆFR«¬&VEFWáBÜóFV“¬≤'F&vWD6ˆFR%“í«¬#Ú'÷¿¢7Fñˆ„¢7Fñˆ‚2&ˆ∆∆˜fW%&˜u≤&7Fñˆ‚%“¿¢‚‚‚á&VDÁV÷&W"ÜóFV“¬≤'F&vWDw&FR%“í”“ÁV∆¬Ú≤F&vWDw&FS¢&VDÁV÷&W"ÜóFV“¬≤'F&vWDw&FR%“í“¢∑“í¿¢‚‚‚á&VEFWáBÜóFV“¬≤'F&vWD6ˆFR%“íÚ≤F&vWD6ˆFS¢&VEFWáBÜóFV“¬≤'F&vWD6ˆFR%“í“¢∑“í¿¢‚‚‚á&VEFWáBÜóFV“¬≤'FV6ÜW%W6W$ñB%“íÚ≤FV6ÜW%W6W$ñC¢&VEFWáBÜóFV“¬≤'FV6ÜW%W6W$ñB%“í¬FV6ÜW$Ê÷S¢&VEFWáBÜóFV“¬≤'FV6ÜW$Ê÷R%“í“¢∑“í¿¢‚‚‚á&VEFWáBÜóFV“¬≤&∆ˆ6Fñˆ‰ñB%“íÚ≤∆ˆ6Fñˆ‰ñC¢&VEFWáBÜóFV“¬≤&∆ˆ6Fñˆ‰ñB%“í¬∆ˆ6Fñˆ‰Ê÷S¢&VEFWáBÜóFV“¬≤&∆ˆ6Fñˆ‰Ê÷R%“í“¢∑“í¿¢‚‚‚á&VEFWáBÜóFV“¬≤&˜fW'&ñFU&V6ˆ‚%“íÚ≤˜fW'&ñFU&V6ˆ„¢&VEFWáBÜóFV“¬≤&˜fW'&ñFU&V6ˆ‚%“í“¢∑“í¿¢‚‚‚á&VEFWáBÜóFV“¬≤&Ê˜FW2%“íÚ≤Ê˜FW3¢&VEFWáBÜóFV“¬≤&Ê˜FW2%“í“¢∑“í¿¢’”∞¢“ì∞ß–†¶gVÊ7Fñˆ‚7G&ó&ˆ∆∆˜fW$Fó7∆îfñV∆G2á&˜s¢&ˆ∆∆˜fW%&˜rì¢&V6˜&C«7G&ñÊr¬VÊ∂Ê˜v„‚∞¢&WGW&‚∞¢6˜W&6T6∆75ñV$ñC¢&˜rÁ6˜W&6T6∆75ñV$ñB¿¢6ˆÜ˜'DñC¢&˜rÊ6ˆÜ˜'DñB¿¢6˜W&6Tw&FS¢&˜rÁ6˜W&6Tw&FR¿¢7Fñˆ„¢&˜rÊ7Fñˆ‚¿¢‚‚‚á&˜rÊ7Fñˆ‚””“'&ˆ÷˜FR"Ú∞¢F&vWDw&FS¢&˜rÁF&vWDw&FR¿¢F&vWD6ˆFS¢&˜rÁF&vWD6ˆFR¿¢‚‚‚á&˜rÁFV6ÜW%W6W$ñBbb&˜rÁFV6ÜW$Ê÷RÚ≤FV6ÜW%W6W$ñC¢&˜rÁFV6ÜW%W6W$ñB¬FV6ÜW$Ê÷S¢&˜rÁFV6ÜW$Ê÷R“¢∑“í¿¢‚‚‚á&˜rÊ∆ˆ6Fñˆ‰ñBbb&˜rÊ∆ˆ6Fñˆ‰Ê÷RÚ≤∆ˆ6Fñˆ‰ñC¢&˜rÊ∆ˆ6Fñˆ‰ñB¬∆ˆ6Fñˆ‰Ê÷S¢&˜rÊ∆ˆ6Fñˆ‰Ê÷R“¢∑“í¿¢“¢∑“í¿¢‚‚‚á&˜rÊ˜fW'&ñFU&V6ˆ‚Ú≤˜fW'&ñFU&V6ˆ„¢&˜rÊ˜fW'&ñFU&V6ˆ‚“¢∑“í¿¢‚‚‚á&˜rÊÊ˜FW2Ú≤Ê˜FW3¢&˜rÊÊ˜FW2“¢∑“í¿¢”∞ß–†¶gVÊ7Fñˆ‚6∆746ˆFTg&ˆ‘Ê÷Ráf«VS¢7G&ñÊrì¢7G&ñÊr∞¢&WGW&‚f«VRÊ÷F6ÇÇıÂ∆G≥√'““Ç‚≤íB˜RìÚÂ≥“ÛÚ"#∞ß–†¶gVÊ7Fñˆ‚∂ñÊDÊVVG4÷FW&ñ¬Ü∂ñÊC¢G&gD∂ñÊBì¢&ˆˆ∆V‚∞¢&WGW&‚∞¢&÷FW&ñ¬ÁWFFR"¿¢'&V6VóBÊ7&VFR"¿¢'G&Á6fW"Ê7&VFR"¿¢'w&óFVˆfbÊ7&VFR"¿¢'&Wfó6ñˆ‚Ê6˜VÁB"¿¢“ÊñÊ6«VFW2Ü∂ñÊBì∞ß–†¶gVÊ7Fñˆ‚ó5˜6óFófU&Wfó6ñˆ‚áf«VS¢VÊ∂Ê˜v‚ì¢f«VRó2ÁV÷&W"∞¢&WGW&‚GóVˆbf«VR””“&ÁV÷&W""bbÁV÷&W"Êó4ñÁFVvW"áf«VRíbbf«VR‚∞ß–†¶gVÊ7Fñˆ‚G&gE7FGW4∆&V¬á7FGW3¢7G&ñÊrì¢7G&ñÊr∞¢6ˆÁ7B∆&V«3¢&V6˜&C«7G&ñÊr¬7G&ñÊs‚“∞¢G&gC¢-
}]›]-≠"¿¢&VGïˆf˜%˜&WfñWs¢-	Ì}m≠=B˝]]-m≠Ç"¿¢6Ê6V∆∆VC¢-
≠Ì-›‚"¿¢&˜fVE˜VÊFñÊuˆ«ì¢-	˝Ì=ÌMm]›‚M‚-›]]››Ú"¿¢∆ñVC¢-	-›]]›‚"¿¢fñ∆VC¢-	˝ÌÕçΩ≠-›]]››Ú"¿¢”∞¢&WGW&‚∆&V«5∑7FGW5“ÛÚ7FGW3∞ß–†¶gVÊ7Fñˆ‚&VDÁV÷&W"á&V6˜&C¢&V6˜&C«7G&ñÊr¬VÊ∂Ê˜v„‚¬∂Wó3¢7G&ñÊuµ“ì¢ÁV÷&W"¬ÁV∆¬∞¢f˜"Ü6ˆÁ7B∂Wíˆb∂Wó2í∞¢6ˆÁ7B&r“&V6˜&E∂∂Wï”∞¢ñbá&r””“ÁV∆¬«¬&r””“VÊFVfñÊVB«¬&r””“""í6ˆÁFñÁVS∞¢6ˆÁ7Bf«VR“ÁV÷&W"á&rì∞¢ñbÑÁV÷&W"Êó4fñÊóFRáf«VRíí&WGW&‚f«VS∞¢–¢&WGW&‚ÁV∆√∞ß–†¶gVÊ7Fñˆ‚6F∆ˆu'V'&ñ72Ü6F∆ˆs¢6F∆ˆt÷FW&ñ≈µ“ì¢7G&ñÊuµ“∞¢6ˆÁ7Bf«VW2“ÊWr6WBÖ∞¢-	˝mM=}›ç≠Çb]]-ÌÕ-mr"¿¢-
ÌÌ}b-≠Ì›-ÌΩÕ›b}Ìçç-Ç¬}m›ç≠Ç"¿¢-	MçM≠-ç}›bíMÌ-mM≠Ì-bÕ-]mΩÇ"¿¢-	Õ]-ÌMç}›Ωm-]-="¿¢-	}	›	‚b	›	Õ
""¿¢“ì∞¢6F∆ˆrÊf˜$V6ÇÇÜ÷FW&ñ¬í”‚∞¢6ˆÁ7B'V'&ñ2“&VEFWáBÜ÷FW&ñ¬¬≤''V'&ñ2%“ì∞¢ñbá'V'&ñ2íf«VW2ÊFBá'V'&ñ2ì∞¢“ì∞¢&WGW&‚≤‚‚Áf«VW5“Á6˜'BÇÜ∆VgB¬&ñváBí”‚∆VgBÊ∆ˆ6∆T6ˆ◊&Rá&ñváB¬'V≤"íì∞ß–†¶gVÊ7Fñˆ‚6F∆ˆt∆ˆ6FñˆÁ2Ü6F∆ˆs¢6F∆ˆt÷FW&ñ≈µ“ì¢7G&ñÊuµ“∞¢6ˆÁ7Bf«VW2“ÊWr6WBÖ≤-	mΩmÌ-]≠%“ì∞¢6F∆ˆrÊf˜$V6ÇÇÜ÷FW&ñ¬í”‚∞¢6ˆÁ7B7Fˆ6≤“÷FW&ñ¬Á7Fˆ6≥∞¢ñbÇó5&V6˜&Bá7Fˆ6≤í«¬'&íÊó4'&íá7Fˆ6≤Ê∆ˆ6FñˆÁ2íí&WGW&„∞¢7Fˆ6≤Ê∆ˆ6FñˆÁ2Êf˜$V6ÇÇÜVÁG'íí”‚∞¢ñbÇó5&V6˜&BÜVÁG'ííí&WGW&„∞¢6ˆÁ7BÊ÷R“&VEFWáBÜVÁG'í¬≤&Ê÷R%“ì∞¢ñbÜÊ÷Ríf«VW2ÊFBÜÊ÷Rì∞¢“ì∞¢“ì∞¢&WGW&‚≤‚‚Áf«VW5“Á6˜'BÇÜ∆VgB¬&ñváBí”‚∆VgBÊ∆ˆ6∆T6ˆ◊&Rá&ñváB¬'V≤"¬≤ÁV÷W&ñ3¢G'VR“íì∞ß–†¶gVÊ7Fñˆ‚÷FW&ñƒñFVÁFñfñW"Ü÷FW&ñ√¢6F∆ˆt÷FW&ñ¬ì¢7G&ñÊr∞¢&WGW&‚&VEFWáBÜ÷FW&ñ¬¬≤&6DñB"¬&6EˆñB"¬&÷FW&ñƒñB"¬&÷FW&ñ≈ˆñB"¬&ñB"¬&ó6&‚%“ì∞ß–†¶gVÊ7Fñˆ‚÷FW&ñƒFó7∆ïFóF∆RÜ÷FW&ñ√¢6F∆ˆt÷FW&ñ¬ì¢7G&ñÊr∞¢&WGW&‚&VEFWáBÜ÷FW&ñ¬¬≤'FóF∆R"¬&Ê÷R%“í«¬-	Õ-]m≤]r›}-Ç#∞ß–†¶gVÊ7Fñˆ‚÷FW&ñƒ÷WFÜ÷FW&ñ√¢6F∆ˆt÷FW&ñ¬ì¢7G&ñÊr∞¢&WGW&‚∞¢&VEFWáBÜ÷FW&ñ¬¬≤&WFÜ˜""¬&WFÜ˜'2%“í¿¢÷FW&ñƒ6∆74∆&V¬Ü÷FW&ñ¬í¿¢&VEFWáBÜ÷FW&ñ¬¬≤&ó6&‚%“í¿¢“Êfñ«FW"Ñ&ˆˆ∆V‚íÊ¶ˆñ‚Ç"+r"í«¬-	MÌM-≠Ì-bM›b-mM=-›b#∞ß–†¶gVÊ7Fñˆ‚÷FW&ñƒ6∆74∆&V¬Ü÷FW&ñ√¢6F∆ˆt÷FW&ñ¬ì¢7G&ñÊr∞¢6ˆÁ7BWá∆ñ6óB“&VEFWáBÜ÷FW&ñ¬¬≤&w&FR"¬&6∆74Ê÷R"¬&6∆72%“ì∞¢ñbÜWá∆ñ6óBí&WGW&‚Wá∆ñ6óC∞¢6ˆÁ7B6∆74g&ˆ““&VDÁV÷&W"Ü÷FW&ñ¬¬≤&6∆74g&ˆ“%“ì∞¢6ˆÁ7B6∆75FÚ“&VDÁV÷&W"Ü÷FW&ñ¬¬≤&6∆75FÚ%“ì∞¢ñbÇ6∆74g&ˆ“í&WGW&‚"#∞¢ñbÇ6∆75FÚ«¬6∆75FÚ””“6∆74g&ˆ“í&WGW&‚G∂6∆74g&ˆ◊“≠Ω∞¢&WGW&‚G∂6∆74g&ˆ◊ﬁ(	2G∂6∆75F˜“≠ΩÜ∞ß–†¶gVÊ7Fñˆ‚÷FW&ñ≈6V&6ÖFWáBÜ÷FW&ñ√¢6F∆ˆt÷FW&ñ¬ì¢7G&ñÊr∞¢&WGW&‚Ê˜&÷∆ó¶U6V&6ÇÖ∞¢÷FW&ñƒñFVÁFñfñW"Ü÷FW&ñ¬í¿¢÷FW&ñƒFó7∆ïFóF∆RÜ÷FW&ñ¬í¿¢÷FW&ñƒ÷WFÜ÷FW&ñ¬í¿¢&VEFWáBÜ÷FW&ñ¬¬≤'7V&¶V7B"¬''V'&ñ2%“í¿¢“Ê¶ˆñ‚Ç""íì∞ß–†¶gVÊ7Fñˆ‚Ê˜&÷∆ó¶U6V&6Çáf«VS¢7G&ñÊrì¢7G&ñÊr∞¢&WGW&‚f«VRÁFÙ∆ˆ6∆T∆˜vW$66RÇ'V≤’T"íÁ&W∆6RÇıµ«5¬ﬁ(	>(	E“≤ˆwR¬""íÁG&ñ“Çì∞ß–†¶gVÊ7Fñˆ‚G&gE&ñ÷'ïFWáBÜG&gC¢6fVDG&gBì¢7G&ñÊr∞¢6ˆÁ7Bñ∆ˆB“ó5&V6˜&BÜG&gBÁñ∆ˆBíÚG&gBÁñ∆ˆB¢∑”∞¢&WGW&‚&VEFWáBáñ∆ˆB¬∞¢'FóF∆R"¿¢&÷FW&ñ≈FóF∆R"¿¢&÷FW&ñƒñB"¿¢&∆&V¬"¿¢&6∆75ñV$ñB"¿¢'F&vWEñV$ñB"¿¢&6FV÷ñ5ñV$ñB"¿¢“í«¬¥î‰EÙƒ$T≈5∂G&gBÊ∂ñÊE“«¬-
}]›]-≠#∞ß–†¶gVÊ7Fñˆ‚6Ü˜'DG&gDñBáf«VS¢VÊ∂Ê˜v‚ì¢7G&ñÊr∞¢ñbáGóVˆbf«VR”“'7G&ñÊr"í&WGW&‚---Ì]›‚#∞¢&WGW&‚(IbG∑f«VRÁ6∆ñ6RÉ¬Çó÷∞ß–†¶gVÊ7Fñˆ‚f˜&÷DÁV÷&W"áf«VS¢ÁV÷&W"ì¢7G&ñÊr∞¢&WGW&‚ÊWrñÁF¬‰ÁV÷&W$f˜&÷BÇ'V≤’T"íÊf˜&÷Báf«VRì∞ß–†¶gVÊ7Fñˆ‚f˜&÷DFFUFñ÷Ráf«VS¢7G&ñÊrì¢7G&ñÊr∞¢6ˆÁ7BFFR“ÊWrFFRáf«VRì∞¢ñbÑÁV÷&W"Êó4Ê‚ÜFFRÊvWEFñ÷RÇííí&WGW&‚-ùÌù›‚#∞¢&WGW&‚ÊWrñÁF¬‰FFUFñ÷Tf˜&÷BÇ'V≤’T"¬≤Fì¢#"÷FñvóB"¬÷ˆÁFÉ¢#"÷FñvóB"¬Ü˜W#¢#"÷FñvóB"¬÷ñÁWFS¢#"÷FñvóB"“íÊf˜&÷BÜFFRì∞ß–†¶gVÊ7Fñˆ‚ó5FˆFíáf«VS¢7G&ñÊrì¢&ˆˆ∆V‚∞¢6ˆÁ7BFFR“ÊWrFFRáf«VRì∞¢6ˆÁ7BÊ˜r“ÊWrFFRÇì∞¢&WGW&‚FFRÊvWDgV∆≈ñV"Çí””“Ê˜rÊvWDgV∆≈ñV"Çê¢bbFFRÊvWD÷ˆÁFÇÇí””“Ê˜rÊvWD÷ˆÁFÇÇê¢bbFFRÊvWDFFRÇí””“Ê˜rÊvWDFFRÇì∞ß–†¶gVÊ7Fñˆ‚FˆFïf«VRÇì¢7G&ñÊr∞¢6ˆÁ7BÊ˜r“ÊWrFFRÇì∞¢6ˆÁ7B∆ˆ6ƒFFR“ÊWrFFRÜÊ˜rÊvWEFñ÷RÇí“Ê˜rÊvWEFñ÷W¶ˆÊTˆfg6WBÇí¢cÛì∞¢&WGW&‚∆ˆ6ƒFFRÁFÙï4ı7G&ñÊrÇíÁ6∆ñ6RÉ¬ì∞ß–