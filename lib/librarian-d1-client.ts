export type CatalogSearchFilters = {
  q: string;
  rubric: string;
  grade: string;
  subject: string;
  publicationType: string;
  available: boolean;
};

export function filterTeachersByFullName<T extends { fullName: string }>(
  teachers: readonly T[],
  query: string,
  limit = 8,
): T[] {
  const tokens = normalizeTeacherSearchText(query).split(" ").filter(Boolean);
  const boundedLimit = Number.isInteger(limit) ? Math.min(20, Math.max(1, limit)) : 8;
  return teachers.filter((teacher) => {
    const fullName = normalizeTeacherSearchText(teacher.fullName);
    return tokens.every((token) => fullName.includes(token));
  }).slice(0, boundedLimit);
}

export type ClassCirculationIntentKind = "class-issue" | "class-return";

export type PendingClassCirculationIntent<Payload extends Record<string, unknown> = Record<string, unknown>> = {
  kind: ClassCirculationIntentKind;
  requestId: string;
  payload: Payload;
};

export type ClassIssueDraftItem = {
  key: string;
  materialId: string;
  materialTitle: string;
  materialAuthor: string;
  materialYear: number | null;
  thumbnailUrl: string;
  sourceLocationId: string;
  sourceLocationName: string;
  condition: "unspecified" | "good" | "worn" | "damaged";
  quantity: number;
  expectedAvailableQuantity: number;
};

export type ClassIssueDraft = {
  schemaVersion: 1;
  classYearId: string;
  responsibleTeacherUserId: string;
  issuedAt: string;
  dueAt: string | null;
  notes: string;
  items: ClassIssueDraftItem[];
};

type ClassCirculationStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const CLASS_CIRCULATION_STORAGE_PREFIX = "library.class-circulation.pending.v1";
const CLASS_ISSUE_DRAFT_STORAGE_KEY = "library.class-issue.draft.v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MATERIAL_IDENTIFIER_PATTERN = /^CAT-\d{4,}$/u;
const LOCATION_IDENTIFIER_PATTERN = /^LOC-\d{3,}$/u;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const CLASS_ISSUE_CONDITIONS = new Set(["unspecified", "good", "worn", "damaged"]);

export function readClassIssueDraft(storage: ClassCirculationStorage): ClassIssueDraft | null {
  try {
    const raw = storage.getItem(CLASS_ISSUE_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as unknown;
    return isClassIssueDraft(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeClassIssueDraft(
  storage: ClassCirculationStorage,
  draft: ClassIssueDraft,
): void {
  if (!isClassIssueDraft(draft)) throw new TypeError("Invalid class issue draft.");
  storage.setItem(CLASS_ISSUE_DRAFT_STORAGE_KEY, JSON.stringify(draft));
}

export function clearClassIssueDraft(storage: ClassCirculationStorage): void {
  storage.removeItem(CLASS_ISSUE_DRAFT_STORAGE_KEY);
}

export function readPendingClassCirculationIntent<Payload extends Record<string, unknown>>(
  storage: ClassCirculationStorage,
  kind: ClassCirculationIntentKind,
): PendingClassCirculationIntent<Payload> | null {
  try {
    const raw = storage.getItem(classCirculationStorageKey(kind));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingClassCirculationIntent<Payload>>;
    if (
      value.kind !== kind
      || typeof value.requestId !== "string"
      || !UUID_PATTERN.test(value.requestId)
      || !isPlainObject(value.payload)
      || value.payload.requestId !== value.requestId
    ) return null;
    return value as PendingClassCirculationIntent<Payload>;
  } catch {
    return null;
  }
}

export function writePendingClassCirculationIntent<Payload extends Record<string, unknown>>(
  storage: ClassCirculationStorage,
  intent: PendingClassCirculationIntent<Payload>,
): void {
  storage.setItem(classCirculationStorageKey(intent.kind), JSON.stringify(intent));
}

export function clearPendingClassCirculationIntent(
  storage: ClassCirculationStorage,
  kind: ClassCirculationIntentKind,
): void {
  storage.removeItem(classCirculationStorageKey(kind));
}

export type MaterialEditDraft = {
  title: string;
  rubric: string;
  publicationType: string;
  subject: string;
  classFrom: string;
  classTo: string;
  author: string;
  publicationYear: string;
  isbn: string;
  publisher: string;
  notes: string;
};

export type EditableMaterial = {
  title: string;
  rubric: string;
  publicationType: string;
  subject: string;
  classFrom: number | null;
  classTo: number | null;
  author: string;
  year: number | null;
  isbn: string;
  publisher: string;
  notes?: string;
};

export function buildCatalogSearchUrl(
  filters: CatalogSearchFilters,
  cursor: string | null = null,
): string {
  const params = new URLSearchParams();
  appendText(params, "q", filters.q);
  appendText(params, "rubric", filters.rubric);
  appendText(params, "grade", filters.grade);
  appendText(params, "subject", filters.subject);
  appendText(params, "type", filters.publicationType);
  if (filters.available) params.set("available", "true");
  params.set("sort", filters.q.trim() ? "title" : "newest");
  params.set("limit", "20");
  if (cursor) params.set("cursor", cursor);
  return `/api/librarian/materials/search?${params.toString()}`;
}

export function materialToEditDraft(
  material: EditableMaterial,
): MaterialEditDraft {
  return {
    title: material.title,
    rubric: material.rubric,
    publicationType: material.publicationType,
    subject: material.subject,
    classFrom: optionalNumberText(material.classFrom),
    classTo: optionalNumberText(material.classTo),
    author: material.author,
    publicationYear: optionalNumberText(material.year),
    isbn: material.isbn,
    publisher: material.publisher,
    notes: material.notes ?? "",
  };
}

export function editDraftToChanges(draft: MaterialEditDraft) {
  return {
    title: draft.title.trim(),
    rubric: draft.rubric.trim(),
    publicationType: optionalText(draft.publicationType),
    subject: optionalText(draft.subject),
    classFrom: optionalInteger(draft.classFrom),
    classTo: optionalInteger(draft.classTo),
    author: optionalText(draft.author),
    publicationYear: optionalInteger(draft.publicationYear),
    isbn: optionalText(draft.isbn),
    publisher: optionalText(draft.publisher),
    notes: optionalText(draft.notes),
  };
}

export function holdingKey(input: {
  locationId: string;
  condition: string | null;
}): string {
  return `${input.locationId}\u001f${input.condition || "unspecified"}`;
}

export function gradeLabel(
  classFrom: number | null,
  classTo: number | null,
): string {
  if (classFrom === null && classTo === null) return "Клас не вказано";
  if (classFrom === classTo || classTo === null) return `${classFrom} клас`;
  if (classFrom === null) return `до ${classTo} класу`;
  return `${classFrom}–${classTo} класи`;
}

export function todayInKyiv(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function suggestNextAcademicYearStart(
  academicYears: ReadonlyArray<{ endDate?: unknown; label?: unknown }>,
  fallbackYear = new Date().getFullYear(),
): number {
  const storedEndYears = academicYears.flatMap((year) => [
    ...academicYearCandidates(year.endDate, /^((?:19|20|21)\d{2})-\d{2}-\d{2}$/gu),
    ...academicYearCandidates(year.label, /(?:19|20|21)\d{2}/gu),
  ]);
  return storedEndYears.length ? Math.max(...storedEndYears) : fallbackYear;
}

export function resolveLoanDueAtForSubmission(
  ...candidates: unknown[]
): string | null {
  return resolveLiveFormTextForSubmission(...candidates);
}

export function resolveLiveFormTextForSubmission(
  ...candidates: unknown[]
): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.trim();
    if (normalized) return normalized;
  }
  return null;
}

function academicYearCandidates(value: unknown, pattern: RegExp): number[] {
  if (typeof value !== "string") return [];
  return [...value.matchAll(pattern)]
    .flatMap((match) => {
      const parsed = Number(match[1] ?? match[0]);
      return Number.isInteger(parsed) ? [parsed] : [];
    });
}

function appendText(params: URLSearchParams, key: string, value: string) {
  const normalized = value.trim();
  if (normalized) params.set(key, normalized);
}

function optionalNumberText(value: number | null): string {
  return value === null ? "" : String(value);
}

function optionalText(value: string): string | null {
  const normalized = value.trim();
  return normalized || null;
}

function optionalInteger(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

function classCirculationStorageKey(kind: ClassCirculationIntentKind): string {
  return `${CLASS_CIRCULATION_STORAGE_PREFIX}.${kind}`;
}

function isClassIssueDraft(value: unknown): value is ClassIssueDraft {
  if (!isPlainObject(value)) return false;
  if (
    value.schemaVersion !== 1
    || typeof value.classYearId !== "string"
    || !SAFE_IDENTIFIER_PATTERN.test(value.classYearId)
    || typeof value.responsibleTeacherUserId !== "string"
    || !SAFE_IDENTIFIER_PATTERN.test(value.responsibleTeacherUserId)
    || typeof value.issuedAt !== "string"
    || !ISO_DATE_PATTERN.test(value.issuedAt)
    || !(value.dueAt === null || typeof value.dueAt === "string" && ISO_DATE_PATTERN.test(value.dueAt))
    || typeof value.notes !== "string"
    || value.notes.length > 2_000
    || !Array.isArray(value.items)
    || value.items.length < 1
    || value.items.length > 100
  ) return false;
  const keys = new Set<string>();
  for (const item of value.items) {
    if (!isPlainObject(item)) return false;
    const condition = item.condition;
    const expectedKey = typeof item.materialId === "string"
      && typeof item.sourceLocationId === "string"
      && typeof condition === "string"
      ? `${item.materialId}\u001e${item.sourceLocationId}\u001e${condition}`
      : "";
    if (
      typeof item.key !== "string"
      || item.key !== expectedKey
      || keys.has(item.key)
      || typeof item.materialId !== "string"
      || !MATERIAL_IDENTIFIER_PATTERN.test(item.materialId)
      || typeof item.materialTitle !== "string"
      || !item.materialTitle.trim()
      || item.materialTitle.length > 500
      || typeof item.materialAuthor !== "string"
      || item.materialAuthor.length > 500
      || !(item.materialYear === null || typeof item.materialYear === "number"
        && Number.isInteger(item.materialYear) && item.materialYear >= 1000 && item.materialYear <= 2100)
      || typeof item.thumbnailUrl !== "string"
      || item.thumbnailUrl.length > 2_048
      || typeof item.sourceLocationId !== "string"
      || !LOCATION_IDENTIFIER_PATTERN.test(item.sourceLocationId)
      || typeof item.sourceLocationName !== "string"
      || !item.sourceLocationName.trim()
      || item.sourceLocationName.length > 240
      || typeof condition !== "string"
      || !CLASS_ISSUE_CONDITIONS.has(condition)
      || typeof item.quantity !== "number"
      || !Number.isInteger(item.quantity)
      || item.quantity < 1
      || typeof item.expectedAvailableQuantity !== "number"
      || !Number.isInteger(item.expectedAvailableQuantity)
      || item.expectedAvailableQuantity < item.quantity
      || item.expectedAvailableQuantity > 1_000_000
    ) return false;
    keys.add(item.key);
  }
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeTeacherSearchText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("uk-UA");
}
