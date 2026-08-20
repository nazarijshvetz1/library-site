const CAT_ID_PATTERN = /^CAT-\d{4,}$/;
const ISBN_PATTERN = /^(?:\d{13}|\d{9}[\dX])$/;
const SAFE_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export const DEFAULT_PUBLIC_CATALOG_LIMIT = 24;
export const MAX_PUBLIC_CATALOG_LIMIT = 48;
export const DEFAULT_LIBRARIAN_SEARCH_LIMIT = 12;
export const MAX_LIBRARIAN_SEARCH_LIMIT = 20;
export const MAX_CATALOG_RUBRIC_OPTIONS = 200;
export const MAX_CATALOG_FACET_OPTIONS = 200;

type D1Value = string | number | null;

export type CatalogD1Result<T = Record<string, unknown>> = {
  results?: T[];
};

export type CatalogD1PreparedStatement = {
  bind(...values: D1Value[]): CatalogD1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<CatalogD1Result<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
};

export type CatalogD1Database = {
  prepare(sql: string): CatalogD1PreparedStatement;
  batch?<T = Record<string, unknown>>(
    statements: CatalogD1PreparedStatement[],
  ): Promise<Array<CatalogD1Result<T>>>;
};

export type CatalogSort = "title" | "newest";

export type CatalogListQuery = {
  q: string;
  title: string;
  rubric: string;
  grade: number | null;
  subject: string;
  publicationType: string;
  available: boolean;
  sort: CatalogSort;
  limit: number;
  cursor: CatalogCursor | null;
};

type CatalogCursor = {
  version: 1;
  scope: string;
  sort: CatalogSort;
  sortValue: string | number;
  id: string;
};

export type CatalogSummary = {
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
  reservedQuantity: number;
};

export type CatalogLink = {
  kind: string;
  label: string;
  url: string;
  id?: string;
  isPublic?: boolean;
  sortOrder?: number;
};

export type CatalogHolding = {
  locationId: string;
  locationName: string;
  locationType: string;
  locationStatus: string;
  condition: string | null;
  physicalQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  quantity: number;
  updatedAt: string;
};

export type CatalogDetail = CatalogSummary & {
  notes?: string;
  version?: number;
  links: CatalogLink[];
  holdings: CatalogHolding[];
  cover: {
    url: string;
    mimeType: string;
    width: number | null;
    height: number | null;
    version?: number;
  } | null;
};

export type CatalogListResult = {
  items: CatalogSummary[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type CatalogMaterialFacets = {
  rubrics: string[];
  subjects: string[];
  publicationTypes: string[];
};

export type CatalogCoverAsset = {
  storageProvider: string;
  storageKey: string;
  externalUrl: string;
  mimeType: string;
  sha256: string;
};

export type CatalogCoverCacheDecision = {
  canonicalVersion: string;
  redirect: boolean;
  immutable: boolean;
};

export function catalogCoverCacheDecision(
  sha256: string,
  requestUrl: string,
): CatalogCoverCacheDecision {
  const canonicalVersion = /^[0-9a-f]{64}$/iu.test(sha256)
    ? sha256.slice(0, 12).toLowerCase()
    : "";
  const url = new URL(requestUrl);
  const requestedVersions = url.searchParams.getAll("v");
  const requestedVersion = requestedVersions[0]?.toLowerCase() ?? "";
  const hasExtraParameters = requestedVersions.length !== 1
    || [...url.searchParams.keys()].some((key) => key !== "v");
  const redirect = Boolean(
    canonicalVersion
    && (requestedVersion !== canonicalVersion || hasExtraParameters),
  );
  return {
    canonicalVersion,
    redirect,
    immutable: Boolean(
      canonicalVersion
      && !redirect
      && requestedVersion === canonicalVersion,
    ),
  };
}

export class CatalogQueryValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "CatalogQueryValidationError";
    this.field = field;
  }
}

export class CatalogDataIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogDataIntegrityError";
  }
}

export function normalizeCatalogId(value: unknown): string {
  const candidate = String(value ?? "").trim().toUpperCase();
  return candidate.length <= 32 && CAT_ID_PATTERN.test(candidate)
    ? candidate
    : "";
}

export function normalizeCatalogSearchText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("uk-UA")
    .replace(/[’`]/gu, "'")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function normalizeCatalogIsbn(value: unknown): string {
  const normalized = String(value ?? "")
    .toUpperCase()
    .replace(/[\s-]+/gu, "");
  return ISBN_PATTERN.test(normalized) ? normalized : "";
}

export function parseCatalogListQuery(
  input: URL | string,
  options: {
    defaultLimit?: number;
    maxLimit?: number;
  } = {},
): CatalogListQuery {
  const url = input instanceof URL ? input : new URL(input);
  const defaultLimit = boundedConfiguredLimit(
    options.defaultLimit ?? DEFAULT_PUBLIC_CATALOG_LIMIT,
    DEFAULT_PUBLIC_CATALOG_LIMIT,
  );
  const maxLimit = boundedConfiguredLimit(
    options.maxLimit ?? MAX_PUBLIC_CATALOG_LIMIT,
    MAX_PUBLIC_CATALOG_LIMIT,
  );
  const limit = parseLimit(url.searchParams.get("limit"), defaultLimit, maxLimit);
  const q = readBoundedParameter(url, "q", 180);
  const title = readBoundedParameter(url, "title", 180);
  const rubric = readBoundedParameter(url, "rubric", 180);
  const subject = readBoundedParameter(url, "subject", 180);
  const publicationType = readBoundedParameter(url, "type", 120);
  const grade = parseGrade(url.searchParams.get("grade"));
  const available = parseBooleanParameter(
    url.searchParams.get("available"),
    "available",
  );
  const sort = parseSort(url.searchParams.get("sort"));
  const queryWithoutCursor: Omit<CatalogListQuery, "cursor"> = {
    q,
    title,
    rubric,
    grade,
    subject,
    publicationType,
    available,
    sort,
    limit,
  };
  const cursorText = url.searchParams.get("cursor");
  const cursor = cursorText
    ? decodeCatalogCursor(cursorText, catalogQueryScope(queryWithoutCursor))
    : null;
  return { ...queryWithoutCursor, cursor };
}

export async function listCatalogMaterials(
  db: CatalogD1Database,
  query: CatalogListQuery,
): Promise<CatalogListResult> {
  let statement = buildCatalogListStatement(query, true);
  let response: CatalogD1Result;
  try {
    response = await db.prepare(statement.sql).bind(...statement.bindings).all();
  } catch (error) {
    if (!statement.usesFts || !isMissingFtsError(error)) throw error;
    statement = buildCatalogListStatement(query, false);
    response = await db.prepare(statement.sql).bind(...statement.bindings).all();
  }
  const rawRows = Array.isArray(response.results) ? response.results : [];
  const hasMore = rawRows.length > query.limit;
  const visibleRows = rawRows.slice(0, query.limit);
  const items = visibleRows.map((row) => mapSummaryRow(asRow(row)));
  const lastRow = visibleRows.at(-1);
  const nextCursor = hasMore && lastRow
    ? encodeCatalogCursor(cursorFromRow(asRow(lastRow), query))
    : null;
  return { items, nextCursor, hasMore };
}

export async function listCatalogRubrics(
  db: CatalogD1Database,
  limit = MAX_CATALOG_RUBRIC_OPTIONS,
): Promise<string[]> {
  return listCatalogFacetValues(db, "rubric", 180, limit);
}

export async function listCatalogMaterialFacets(
  db: CatalogD1Database,
  limit = MAX_CATALOG_FACET_OPTIONS,
): Promise<CatalogMaterialFacets> {
  const [rubrics, subjects, publicationTypes] = await Promise.all([
    listCatalogFacetValues(db, "rubric", 180, limit),
    listCatalogFacetValues(db, "subject", 180, limit),
    listCatalogFacetValues(db, "publication_type", 120, limit),
  ]);
  return { rubrics, subjects, publicationTypes };
}

export async function getCatalogMaterialDetail(
  db: CatalogD1Database,
  materialId: string,
  scope: "public" | "librarian",
): Promise<CatalogDetail | null> {
  const id = normalizeCatalogId(materialId);
  if (!id) return null;

  const statements = [
    db.prepare(detailMaterialSql(scope)).bind(id),
    db.prepare(detailLinksSql(scope)).bind(id),
    db.prepare(detailHoldingsSql(scope)).bind(id),
  ];
  const [materialResult, linksResult, holdingsResult] = await executeBatch(
    db,
    statements,
  );
  const materialRow = materialResult.results?.[0];
  if (!materialRow) return null;

  const rawMaterial = asRow(materialRow);
  const summary = mapSummaryRow(rawMaterial);
  const links = (linksResult.results ?? [])
    .map((row) => mapLinkRow(asRow(row), scope))
    .filter((link): link is CatalogLink => link !== null);
  const holdings = (holdingsResult.results ?? []).map((row) =>
    mapHoldingRow(asRow(row), scope),
  );
  const coverUrl = coverUrlFromRow(rawMaterial);
  const mimeType = safeImageMimeType(rawMaterial.cover_mime_type);
  const cover = coverUrl
    ? {
        url: coverUrl,
        mimeType,
        width: nullablePositiveInteger(rawMaterial.cover_width),
        height: nullablePositiveInteger(rawMaterial.cover_height),
        ...(scope === "librarian"
          ? { version: positiveInteger(rawMaterial.cover_version) }
          : {}),
      }
    : null;

  return {
    ...summary,
    ...(scope === "librarian"
      ? {
          notes: boundedText(rawMaterial.notes, 4_000),
          version: positiveInteger(rawMaterial.version),
        }
      : {}),
    links,
    holdings,
    cover,
  };
}

export async function getCatalogCoverAsset(
  db: CatalogD1Database,
  materialId: string,
): Promise<CatalogCoverAsset | null> {
  const id = normalizeCatalogId(materialId);
  if (!id) return null;
  const row = await db.prepare(`
    SELECT
      c.storage_provider, c.storage_key, c.external_url, c.mime_type, c.sha256
    FROM material_cover_assets c
    JOIN materials m ON m.id = c.material_id
    WHERE c.material_id = ? AND c.status = 'ready'
      AND m.status = 'active' AND m.archived_at IS NULL
    LIMIT 1
  `).bind(id).first();
  if (!row) return null;
  const source = asRow(row);
  const storageProvider = boundedText(source.storage_provider, 40).toLowerCase();
  const storageKey = safeStorageKey(source.storage_key);
  const externalUrl = safeExternalImageUrl(source.external_url);
  const mimeType = safeImageMimeType(source.mime_type);
  const sha256 = /^[0-9a-f]{64}$/i.test(String(source.sha256 ?? ""))
    ? String(source.sha256).toLowerCase()
    : "";
  if (storageProvider === "r2" && storageKey && mimeType) {
    return { storageProvider, storageKey, externalUrl: "", mimeType, sha256 };
  }
  if (externalUrl) {
    return {
      storageProvider: storageProvider || "external",
      storageKey: "",
      externalUrl,
      mimeType,
      sha256,
    };
  }
  return null;
}

export function encodeCatalogCursor(cursor: CatalogCursor): string {
  return encodeBase64Url(JSON.stringify({
    v: cursor.version,
    s: cursor.scope,
    o: cursor.sort,
    k: cursor.sortValue,
    i: cursor.id,
  }));
}

function buildCatalogListStatement(query: CatalogListQuery, useFts: boolean): {
  sql: string;
  bindings: D1Value[];
  usesFts: boolean;
} {
  const predicates = ["m.status = 'active'", "m.archived_at IS NULL"];
  const bindings: D1Value[] = [];
  const exactId = normalizeCatalogId(query.q);
  const exactIsbn = normalizeCatalogIsbn(query.q);
  const normalizedQuery = normalizeCatalogSearchText(query.q);
  let didUseFts = false;

  if (exactId) {
    predicates.push("m.id = ?");
    bindings.push(exactId);
  } else if (exactIsbn) {
    predicates.push("m.isbn_normalized = ?");
    bindings.push(exactIsbn);
  } else if (normalizedQuery) {
    const fullTextQuery = useFts ? ftsQuery(normalizedQuery) : "";
    if (fullTextQuery) {
      predicates.push(
        "m.rowid IN (SELECT rowid FROM materials_fts WHERE materials_fts MATCH ?)",
      );
      bindings.push(fullTextQuery);
      didUseFts = true;
    } else {
      predicates.push("m.search_text LIKE ? ESCAPE '!'");
      bindings.push(`%${escapeLike(normalizedQuery)}%`);
    }
  }
  const normalizedTitle = normalizeCatalogSearchText(query.title);
  const titleTokens = normalizedTitle
    .split(" ")
    .map((token) => token.trim().slice(0, 64))
    .filter((token) => /[\p{L}\p{N}]/u.test(token))
    .slice(0, 16);
  for (const token of titleTokens) {
    predicates.push("m.sort_title LIKE ? ESCAPE '!'");
    bindings.push(`%${escapeLike(token)}%`);
  }
  if (query.rubric) {
    predicates.push("m.rubric = ?");
    bindings.push(query.rubric);
  }
  if (query.grade !== null) {
    predicates.push("m.class_from <= ? AND COALESCE(m.class_to, m.class_from) >= ?");
    bindings.push(query.grade, query.grade);
  }
  if (query.subject) {
    predicates.push("m.subject = ?");
    bindings.push(query.subject);
  }
  if (query.publicationType) {
    predicates.push("m.publication_type = ?");
    bindings.push(query.publicationType);
  }
  if (query.available) {
    predicates.push(
      "MAX(0, COALESCE(st.total_quantity, 0) - COALESCE(st.loaned_quantity, 0) - COALESCE(st.reserved_quantity, 0)) > 0",
    );
  }

  if (query.cursor) {
    if (query.sort === "newest") {
      predicates.push(
        "(m.catalog_number < ? OR (m.catalog_number = ? AND m.id < ?))",
      );
      bindings.push(
        Number(query.cursor.sortValue),
        Number(query.cursor.sortValue),
        query.cursor.id,
      );
    } else {
      predicates.push(
        "(m.sort_title > ? OR (m.sort_title = ? AND m.id > ?))",
      );
      bindings.push(
        String(query.cursor.sortValue),
        String(query.cursor.sortValue),
        query.cursor.id,
      );
    }
  }

  const orderBy = query.sort === "newest"
    ? "m.catalog_number DESC, m.id DESC"
    : "m.sort_title ASC, m.id ASC";
  bindings.push(query.limit + 1);

  return {
    sql: `
      SELECT
        m.id,
        m.catalog_number,
        m.title,
        m.sort_title AS cursor_sort_title,
        m.author,
        m.publication_year,
        m.isbn_normalized,
        m.rubric,
        m.subject,
        m.publication_type,
        m.class_from,
        m.class_to,
        m.publisher,
        c.storage_provider AS cover_storage_provider,
        c.storage_key AS cover_storage_key,
        c.external_url AS cover_external_url,
        c.mime_type AS cover_mime_type,
        c.width AS cover_width,
        c.height AS cover_height,
        c.sha256 AS cover_sha256,
        COALESCE(st.total_quantity, 0) AS total_quantity,
        COALESCE(st.library_quantity, 0) AS library_quantity,
        COALESCE(st.other_location_quantity, 0) AS other_location_quantity,
        COALESCE(st.loaned_quantity, 0) AS loaned_quantity,
        COALESCE(st.reserved_quantity, 0) AS reserved_quantity
      FROM materials m
      LEFT JOIN material_stock_totals st ON st.material_id = m.id
      LEFT JOIN material_cover_assets c
        ON c.material_id = m.id AND c.status = 'ready'
      WHERE ${predicates.join(" AND ")}
      ORDER BY ${orderBy}
      LIMIT ?
    `,
    bindings,
    usesFts: didUseFts,
  };
}

function detailMaterialSql(scope: "public" | "librarian"): string {
  return `
    SELECT
      m.id,
      m.catalog_number,
      m.title,
      m.sort_title AS cursor_sort_title,
      m.author,
      m.publication_year,
      m.isbn_normalized,
      m.rubric,
      m.subject,
      m.publication_type,
      m.class_from,
      m.class_to,
      m.publisher,
      ${scope === "librarian" ? "m.notes" : "NULL AS notes"},
      ${scope === "librarian" ? "m.version" : "NULL AS version"},
      c.storage_provider AS cover_storage_provider,
      c.storage_key AS cover_storage_key,
      c.external_url AS cover_external_url,
      c.mime_type AS cover_mime_type,
      c.width AS cover_width,
      c.height AS cover_height,
      c.sha256 AS cover_sha256,
      ${scope === "librarian" ? "c.version" : "NULL"} AS cover_version,
      COALESCE(st.total_quantity, 0) AS total_quantity,
      COALESCE(st.library_quantity, 0) AS library_quantity,
      COALESCE(st.other_location_quantity, 0) AS other_location_quantity,
      COALESCE(st.loaned_quantity, 0) AS loaned_quantity,
      COALESCE(st.reserved_quantity, 0) AS reserved_quantity
    FROM materials m
    LEFT JOIN material_stock_totals st ON st.material_id = m.id
    LEFT JOIN material_cover_assets c
      ON c.material_id = m.id AND c.status = 'ready'
    WHERE m.id = ? AND m.status = 'active' AND m.archived_at IS NULL
    LIMIT 1
  `;
}

function detailLinksSql(scope: "public" | "librarian"): string {
  return `
    SELECT
      ${scope === "librarian" ? "id, is_public, sort_order," : ""}
      kind, label, url
    FROM material_links
    WHERE material_id = ? AND status = 'active'
      ${scope === "public" ? "AND is_public = 1" : ""}
    ORDER BY sort_order ASC, id ASC
  `;
}

function detailHoldingsSql(scope: "public" | "librarian"): string {
  if (scope === "public") {
    return `
      SELECT
        l.id AS location_id,
        l.name AS location_name,
        l.type AS location_type,
        l.status AS location_status,
        NULL AS condition,
        SUM(h.quantity) AS physical_quantity,
        COALESCE((
          SELECT SUM(reservation.reserved_quantity-reservation.issued_quantity-reservation.released_quantity)
          FROM material_request_reservations reservation
          WHERE reservation.material_id=h.material_id
            AND reservation.source_location_id=l.id
            AND reservation.reserved_quantity>reservation.issued_quantity+reservation.released_quantity
        ), 0) AS reserved_quantity,
        MAX(0, SUM(h.quantity)-COALESCE((
          SELECT SUM(reservation.reserved_quantity-reservation.issued_quantity-reservation.released_quantity)
          FROM material_request_reservations reservation
          WHERE reservation.material_id=h.material_id
            AND reservation.source_location_id=l.id
            AND reservation.reserved_quantity>reservation.issued_quantity+reservation.released_quantity
        ), 0)) AS quantity,
        MAX(h.updated_at) AS updated_at
      FROM holdings h
      JOIN locations l ON l.id = h.location_id
      WHERE h.material_id = ? AND h.quantity > 0
        AND l.status = 'active' AND l.is_public = 1
      GROUP BY l.id, l.name, l.type, l.status, l.sort_order
      ORDER BY l.sort_order ASC, l.name ASC, l.id ASC
    `;
  }
  return `
    SELECT
      l.id AS location_id,
      l.name AS location_name,
      l.type AS location_type,
      l.status AS location_status,
      h.condition,
      h.quantity AS physical_quantity,
      COALESCE((
        SELECT SUM(reservation.reserved_quantity-reservation.issued_quantity-reservation.released_quantity)
        FROM material_request_reservations reservation
        WHERE reservation.material_id=h.material_id
          AND reservation.source_location_id=h.location_id
          AND reservation.condition=h.condition
          AND reservation.reserved_quantity>reservation.issued_quantity+reservation.released_quantity
      ), 0) AS reserved_quantity,
      MAX(0, h.quantity-COALESCE((
        SELECT SUM(reservation.reserved_quantity-reservation.issued_quantity-reservation.released_quantity)
        FROM material_request_reservations reservation
        WHERE reservation.material_id=h.material_id
          AND reservation.source_location_id=h.location_id
          AND reservation.condition=h.condition
          AND reservation.reserved_quantity>reservation.issued_quantity+reservation.released_quantity
      ), 0)) AS quantity,
      h.updated_at
    FROM holdings h
    JOIN locations l ON l.id = h.location_id
    WHERE h.material_id = ? AND h.quantity > 0
    ORDER BY l.sort_order ASC, l.name ASC, h.condition ASC, l.id ASC
  `;
}

function mapSummaryRow(row: Record<string, unknown>): CatalogSummary {
  const id = normalizeCatalogId(row.id);
  const title = boundedText(row.title, 500);
  if (!id || !title) {
    throw new CatalogDataIntegrityError("Catalog row has an invalid identifier or title");
  }
  const totalQuantity = nonNegativeInteger(row.total_quantity);
  const loanedQuantity = Math.min(totalQuantity, nonNegativeInteger(row.loaned_quantity));
  const reservedQuantity = Math.min(
    Math.max(0, totalQuantity - loanedQuantity),
    nonNegativeInteger(row.reserved_quantity),
  );
  const classFrom = nullableGrade(row.class_from);
  const classTo = nullableGrade(row.class_to) ?? classFrom;
  return {
    id,
    title,
    author: boundedText(row.author, 400),
    year: nullablePublicationYear(row.publication_year),
    isbn: normalizeCatalogIsbn(row.isbn_normalized),
    rubric: boundedText(row.rubric, 180),
    subject: boundedText(row.subject, 180),
    publicationType: boundedText(row.publication_type, 120),
    classFrom,
    classTo,
    publisher: boundedText(row.publisher, 240),
    thumbnailUrl: coverUrlFromRow(row),
    totalQuantity,
    availableQuantity: Math.max(0, totalQuantity - loanedQuantity - reservedQuantity),
    libraryQuantity: nonNegativeInteger(row.library_quantity),
    otherLocationQuantity: nonNegativeInteger(row.other_location_quantity),
    loanedQuantity,
    reservedQuantity,
  };
}

function mapLinkRow(
  row: Record<string, unknown>,
  scope: "public" | "librarian",
): CatalogLink | null {
  const url = safeHttpUrl(row.url);
  if (!url) return null;
  const link: CatalogLink = {
    kind: boundedText(row.kind, 40) || "information",
    label: boundedText(row.label, 160) || "Відкрити посилання",
    url,
  };
  if (scope === "librarian") {
    const id = boundedText(row.id, 80);
    if (!id) return null;
    link.id = id;
    link.isPublic = Number(row.is_public) === 1;
    link.sortOrder = nonNegativeInteger(row.sort_order);
  }
  return link;
}

function mapHoldingRow(
  row: Record<string, unknown>,
  scope: "public" | "librarian",
): CatalogHolding {
  const locationId = boundedText(row.location_id, 64);
  const locationName = boundedText(row.location_name, 180);
  if (!locationId || !locationName) {
    throw new CatalogDataIntegrityError("Holding row has an invalid location");
  }
  const physicalQuantity = nonNegativeInteger(row.physical_quantity);
  const reservedQuantity = Math.min(physicalQuantity, nonNegativeInteger(row.reserved_quantity));
  const availableQuantity = Math.max(0, physicalQuantity - reservedQuantity);
  return {
    locationId,
    locationName,
    locationType: boundedText(row.location_type, 120),
    locationStatus: boundedText(row.location_status, 80),
    condition: scope === "librarian"
      ? boundedText(row.condition, 80) || null
      : null,
    physicalQuantity,
    reservedQuantity,
    availableQuantity,
    // Backwards-compatible effective availability used by existing issue forms.
    quantity: Math.min(availableQuantity, nonNegativeInteger(row.quantity)),
    updatedAt: boundedText(row.updated_at, 40),
  };
}

type CatalogFacetColumn = "rubric" | "subject" | "publication_type";

async function listCatalogFacetValues(
  db: CatalogD1Database,
  column: CatalogFacetColumn,
  maximumLength: number,
  limit: number,
): Promise<string[]> {
  const boundedLimit = Number.isInteger(limit)
    ? Math.max(1, Math.min(limit, MAX_CATALOG_FACET_OPTIONS))
    : MAX_CATALOG_FACET_OPTIONS;
  const response = await db.prepare(`
    SELECT DISTINCT TRIM(${column}) AS value
    FROM materials
    WHERE status = 'active' AND archived_at IS NULL
      AND TRIM(${column}) != ''
    ORDER BY value ASC
    LIMIT ?
  `).bind(boundedLimit).all();
  const values = (response.results ?? [])
    .map((row) => boundedText(asRow(row).value, maximumLength))
    .filter((value) => value && !containsControlCharacter(value));
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right, "uk-UA", { sensitivity: "base" })
  );
}

function coverUrlFromRow(row: Record<string, unknown>): string {
  const external = safeExternalImageUrl(row.cover_external_url);
  if (external) return external;
  const provider = boundedText(row.cover_storage_provider, 40).toLowerCase();
  const storageKey = safeStorageKey(row.cover_storage_key);
  if (provider !== "r2" || !storageKey) return "";
  const id = normalizeCatalogId(row.id);
  if (!id) return "";
  const hash = /^[0-9a-f]{64}$/i.test(String(row.cover_sha256 ?? ""))
    ? `?v=${String(row.cover_sha256).slice(0, 12).toLowerCase()}`
    : "";
  return `/api/catalog-v2/covers/${encodeURIComponent(id)}${hash}`;
}

async function executeBatch(
  db: CatalogD1Database,
  statements: CatalogD1PreparedStatement[],
): Promise<Array<CatalogD1Result<Record<string, unknown>>>> {
  if (db.batch) {
    return db.batch<Record<string, unknown>>(statements);
  }
  return Promise.all(statements.map((statement) => statement.all()));
}

function cursorFromRow(
  row: Record<string, unknown>,
  query: CatalogListQuery,
): CatalogCursor {
  const id = normalizeCatalogId(row.id);
  if (!id) throw new CatalogDataIntegrityError("Cursor row has an invalid identifier");
  if (query.sort === "newest") {
    const catalogNumber = positiveInteger(row.catalog_number);
    if (!catalogNumber) {
      throw new CatalogDataIntegrityError("Cursor row has an invalid catalog number");
    }
    return {
      version: 1,
      scope: catalogQueryScope(query),
      sort: query.sort,
      sortValue: catalogNumber,
      id,
    };
  }
  return {
    version: 1,
    scope: catalogQueryScope(query),
    sort: query.sort,
    sortValue: boundedText(row.cursor_sort_title, 600),
    id,
  };
}

function decodeCatalogCursor(value: string, expectedScope: string): CatalogCursor {
  if (value.length > 1_000 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new CatalogQueryValidationError("cursor", "Некоректний курсор каталогу.");
  }
  try {
    const parsed: unknown = JSON.parse(decodeBase64Url(value));
    if (!isRecord(parsed)) throw new Error("cursor object expected");
    const version = parsed.v;
    const scope = parsed.s;
    const sort = parsed.o;
    const sortValue = parsed.k;
    const id = normalizeCatalogId(parsed.i);
    if (
      version !== 1
      || scope !== expectedScope
      || (sort !== "title" && sort !== "newest")
      || sort !== expectedScopeSort(expectedScope)
      || !id
    ) {
      throw new Error("cursor metadata mismatch");
    }
    if (
      (sort === "title" && (typeof sortValue !== "string" || sortValue.length > 600))
      || (sort === "newest" && (!Number.isInteger(sortValue) || Number(sortValue) < 1))
    ) {
      throw new Error("cursor sort value invalid");
    }
    return {
      version: 1,
      scope,
      sort,
      sortValue: sortValue as string | number,
      id,
    };
  } catch (error) {
    if (error instanceof CatalogQueryValidationError) throw error;
    throw new CatalogQueryValidationError("cursor", "Курсор не відповідає поточному пошуку.");
  }
}

function catalogQueryScope(
  query: Omit<CatalogListQuery, "cursor"> | CatalogListQuery,
): string {
  const canonicalParts: Array<string | number | boolean | null> = [
    normalizeCatalogSearchText(query.q),
    query.rubric,
    query.grade,
    query.subject,
    query.publicationType,
    query.available,
    query.sort,
  ];
  const normalizedTitle = normalizeCatalogSearchText(query.title);
  if (normalizedTitle) canonicalParts.push(`title:${normalizedTitle}`);
  return `${query.sort}:${fnv1a(JSON.stringify(canonicalParts))}`;
}

function expectedScopeSort(scope: string): CatalogSort | "" {
  if (scope.startsWith("title:")) return "title";
  if (scope.startsWith("newest:")) return "newest";
  return "";
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function parseSort(value: string | null): CatalogSort {
  const candidate = (value || "title").trim().toLowerCase();
  if (candidate === "title" || candidate === "newest") return candidate;
  throw new CatalogQueryValidationError("sort", "Непідтримуване сортування каталогу.");
}

function parseGrade(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  if (!/^\d{1,2}$/u.test(value.trim())) {
    throw new CatalogQueryValidationError("grade", "Клас має бути числом від 1 до 11.");
  }
  const grade = Number(value);
  if (!Number.isInteger(grade) || grade < 1 || grade > 11) {
    throw new CatalogQueryValidationError("grade", "Клас має бути числом від 1 до 11.");
  }
  return grade;
}

function parseBooleanParameter(value: string | null, field: string): boolean {
  if (value === null || value.trim() === "" || /^(?:0|false)$/iu.test(value.trim())) {
    return false;
  }
  if (/^(?:1|true)$/iu.test(value.trim())) return true;
  throw new CatalogQueryValidationError(field, "Логічний фільтр має значення true або false.");
}

function parseLimit(value: string | null, fallback: number, maximum: number): number {
  if (value === null || value.trim() === "") return Math.min(fallback, maximum);
  if (!/^\d{1,4}$/u.test(value.trim())) {
    throw new CatalogQueryValidationError("limit", "Некоректний розмір сторінки.");
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CatalogQueryValidationError("limit", "Некоректний розмір сторінки.");
  }
  return Math.min(parsed, maximum);
}

function boundedConfiguredLimit(value: number, fallback: number): number {
  return Number.isInteger(value) && value >= 1 && value <= 100
    ? value
    : fallback;
}

function readBoundedParameter(url: URL, name: string, maximum: number): string {
  const value = (url.searchParams.get(name) || "").trim();
  if (value.length > maximum || containsControlCharacter(value)) {
    throw new CatalogQueryValidationError(name, `Параметр ${name} задовгий або некоректний.`);
  }
  return value;
}

function escapeLike(value: string): string {
  return value.replace(/!/gu, "!!").replace(/%/gu, "!%").replace(/_/gu, "!_");
}

function ftsQuery(normalizedQuery: string): string {
  const tokens = normalizedQuery
    .split(" ")
    .map((token) => token.trim().slice(0, 64))
    .filter((token) => /[\p{L}\p{N}]/u.test(token))
    .slice(0, 16);
  return tokens.map((token) => `"${token.replace(/"/gu, '""')}"*`).join(" AND ");
}

function isMissingFtsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /no such table:\s*materials_fts|no such module:\s*fts5/iu.test(message);
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function decodeBase64Url(value: string): string {
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/")
    + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function safeExternalImageUrl(value: unknown): string {
  try {
    const url = new URL(String(value ?? "").trim());
    if (url.protocol !== "https:" || url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function safeHttpUrl(value: unknown): string {
  try {
    const url = new URL(String(value ?? "").trim());
    if (!/^https?:$/u.test(url.protocol) || url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function safeStorageKey(value: unknown): string {
  const key = String(value ?? "").trim();
  if (
    !key
    || key.length > 512
    || key.startsWith("/")
    || key.split("/").some((part) => !part || part === "." || part === "..")
    || key.includes("\\")
    || containsControlCharacter(key)
  ) return "";
  return key;
}

function safeImageMimeType(value: unknown): string {
  const mimeType = String(value ?? "").trim().toLowerCase();
  return SAFE_IMAGE_MIME_TYPES.has(mimeType) ? mimeType : "";
}

function nullablePublicationYear(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1500 && number <= 3000
    ? number
    : null;
}

function nullableGrade(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 11
    ? number
    : null;
}

function positiveInteger(value: unknown): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function nullablePositiveInteger(value: unknown): number | null {
  const number = positiveInteger(value);
  return number || null;
}

function nonNegativeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function boundedText(value: unknown, maximum: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.slice(0, maximum);
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function asRow(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new CatalogDataIntegrityError("Catalog query returned an invalid row");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
