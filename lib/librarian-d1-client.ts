export type CatalogSearchFilters = {
  q: string;
  rubric: string;
  grade: string;
  subject: string;
  publicationType: string;
  available: boolean;
};

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
