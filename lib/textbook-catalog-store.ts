import type { ChatGPTUser } from "@/app/chatgpt-auth";

type D1Value = string | number | null;
type D1Result<T = Record<string, unknown>> = {
  results?: T[];
  meta?: { changes?: number };
};
type D1Statement = {
  bind(...values: D1Value[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
};

export type TextbookDatabase = {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<D1Result[]>;
};

export type TextbookAcademicYear = {
  id: string;
  label: string;
};

export type TextbookResource = {
  id: string;
  label: string;
  url: string;
  directPdf: boolean;
  sourceHost: string;
};

export type PublicTextbook = {
  id: string;
  grade: number;
  title: string;
  author: string;
  publicationYear: number | null;
  subject: string;
  publisher: string;
  coverUrl: string;
  sortOrder: number;
  createdAt: string;
  resources: TextbookResource[];
};

export type ManagedTextbook = {
  id: string;
  source: "fund" | "manual";
  materialId: string | null;
  materialVersion: number | null;
  grade: number;
  status: "draft" | "published" | "archived" | "deleted";
  sortOrder: number;
  version: number;
  title: string;
  author: string;
  publicationYear: number | null;
  subject: string;
  publisher: string;
  isbn: string;
  coverUrl: string;
  activeResourceCount: number;
  brokenResourceCount: number;
  primaryResourceUrl: string;
  publishedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ManualTextbookFields = {
  grade: number;
  title: string;
  author: string;
  subject: string;
  publisher: string;
  publicationYear: number | null;
  isbn: string;
  resourceUrl: string;
  coverUrl: string;
  sortOrder?: number;
};

export type TextbookCandidate = {
  materialId: string;
  materialVersion: number;
  title: string;
  author: string;
  publicationYear: number | null;
  subject: string;
  publisher: string;
  publicationType: string;
  classFrom: number | null;
  classTo: number | null;
  coverUrl: string;
  resourceUrl: string;
  activeResourceCount: number;
};

type Row = Record<string, unknown>;
type Actor = { id: string; email: string };

const LIBRARIKA_MATERIAL_MESSAGE = "Художня та наукова література ведеться у Librarika й не може бути додана до локальної полиці е-підручників.";

export class TextbookCatalogError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fieldErrors: Record<string, string>;

  constructor(
    code: string,
    status: number,
    message: string,
    fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = "TextbookCatalogError";
    this.code = code;
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

export async function listPublicTextbooks(
  db: TextbookDatabase,
  grade: number,
): Promise<{ academicYear: TextbookAcademicYear; items: PublicTextbook[] }> {
  const academicYear = await requireSingleActiveAcademicYear(db);
  const response = await db.prepare(`
    SELECT
      ta.id AS assignment_id,
      ta.grade,
      ta.sort_order,
      ta.created_at AS assignment_created_at,
      m.id AS material_id,
      m.title,
      m.author,
      m.publication_year,
      m.subject,
      m.publisher,
      ml.id AS resource_id,
      ml.label AS resource_label,
      ml.url AS resource_url,
      c.storage_provider AS cover_storage_provider,
      c.storage_key AS cover_storage_key,
      c.external_url AS cover_external_url,
      c.sha256 AS cover_sha256
    FROM textbook_assignments ta
    JOIN materials m ON m.id = ta.material_id
    JOIN material_links ml ON ml.material_id = m.id
    LEFT JOIN material_cover_assets c ON c.material_id = m.id AND c.status = 'ready'
    WHERE ta.academic_year_id = ?
      AND ta.grade = ?
      AND ta.status = 'published'
      AND m.status = 'active'
      AND m.archived_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM library_editions e
        WHERE e.material_id=m.id AND e.fund='literature'
      )
      AND ml.kind = 'ebook'
      AND ml.is_public = 1
      AND ml.status = 'active'
      AND ml.url GLOB 'https://*'
    ORDER BY ta.sort_order ASC, m.sort_title ASC, ta.id ASC,
      ml.sort_order ASC, ml.id ASC
    LIMIT 1000
  `).bind(academicYear.id, grade).all<Row>();

  const items = new Map<string, PublicTextbook>();
  for (const row of response.results ?? []) {
    const assignmentId = boundedText(row.assignment_id, 160);
    const materialId = boundedText(row.material_id, 64);
    const resourceUrl = safeHttpsUrl(row.resource_url);
    if (!assignmentId || !materialId || !resourceUrl) continue;
    let item = items.get(assignmentId);
    if (!item) {
      item = {
        id: assignmentId,
        grade,
        title: boundedText(row.title, 500),
        author: boundedText(row.author, 500),
        publicationYear: nullableYear(row.publication_year),
        subject: boundedText(row.subject, 240),
        publisher: boundedText(row.publisher, 240),
        coverUrl: coverUrl(row, materialId),
        sortOrder: nonNegativeInteger(row.sort_order),
        createdAt: boundedText(row.assignment_created_at, 40),
        resources: [],
      };
      items.set(assignmentId, item);
    }
    if (item.resources.some((resource) => resource.url === resourceUrl)) continue;
    const url = new URL(resourceUrl);
    item.resources.push({
      id: boundedText(row.resource_id, 160),
      label: boundedText(row.resource_label, 180) || "Електронна версія",
      url: resourceUrl,
      directPdf: url.pathname.toLocaleLowerCase("uk-UA").endsWith(".pdf"),
      sourceHost: url.hostname.replace(/^www\./u, ""),
    });
  }
  const manualResponse = await db.prepare(`
    SELECT id, grade, title, author, publication_year, subject, publisher,
      resource_url, cover_url, sort_order, created_at
    FROM manual_textbooks
    WHERE academic_year_id = ? AND grade = ? AND status = 'published'
      AND resource_url GLOB 'https://*'
    ORDER BY sort_order ASC, title COLLATE NOCASE ASC, id ASC
    LIMIT 1000
  `).bind(academicYear.id, grade).all<Row>();
  for (const row of manualResponse.results ?? []) {
    const id = boundedText(row.id, 160);
    const resourceUrl = safeHttpsUrl(row.resource_url);
    if (!id || !resourceUrl) continue;
    const url = new URL(resourceUrl);
    items.set(id, {
      id,
      grade,
      title: boundedText(row.title, 500),
      author: boundedText(row.author, 500),
      publicationYear: nullableYear(row.publication_year),
      subject: boundedText(row.subject, 240),
      publisher: boundedText(row.publisher, 240),
      coverUrl: safeHttpsUrl(row.cover_url),
      sortOrder: nonNegativeInteger(row.sort_order),
      createdAt: boundedText(row.created_at, 40),
      resources: [{
        id: `manual-${id}`,
        label: "Електронна версія",
        url: resourceUrl,
        directPdf: url.pathname.toLocaleLowerCase("uk-UA").endsWith(".pdf"),
        sourceHost: url.hostname.replace(/^www\./u, ""),
      }],
    });
  }
  return {
    academicYear,
    items: [...items.values()]
      .filter((item) => item.resources.length > 0)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title, "uk-UA") || a.id.localeCompare(b.id))
      .slice(0, 1000),
  };
}

export async function listManagedTextbooks(
  db: TextbookDatabase,
  input: { grade: number; q: string },
): Promise<{
  academicYear: TextbookAcademicYear;
  items: ManagedTextbook[];
  candidates: TextbookCandidate[];
}> {
  const academicYear = await requireSingleActiveAcademicYear(db);
  const response = await db.prepare(`
    SELECT
      ta.id,
      ta.material_id,
      ta.grade,
      ta.status,
      ta.sort_order,
      ta.version,
      ta.created_at,
      ta.updated_at,
      ta.published_at,
      ta.archived_at,
      m.version AS material_version,
      m.title,
      m.author,
      m.publication_year,
      m.subject,
      m.publisher,
      NULL AS isbn,
      'fund' AS source,
      (
        SELECT count(*) FROM material_links ml
        WHERE ml.material_id = m.id AND ml.kind = 'ebook'
          AND ml.is_public = 1 AND ml.status = 'active'
          AND ml.url GLOB 'https://*'
      ) AS active_resource_count,
      (
        SELECT count(*) FROM material_links ml
        WHERE ml.material_id = m.id AND ml.kind = 'ebook'
          AND (ml.is_public = 0 OR ml.status != 'active' OR ml.url NOT GLOB 'https://*')
      ) AS broken_resource_count,
      (
        SELECT ml.url FROM material_links ml
        WHERE ml.material_id = m.id AND ml.kind = 'ebook'
          AND ml.is_public = 1 AND ml.status = 'active'
          AND ml.url GLOB 'https://*'
        ORDER BY ml.sort_order ASC, ml.id ASC LIMIT 1
      ) AS primary_resource_url,
      c.storage_provider AS cover_storage_provider,
      c.storage_key AS cover_storage_key,
      c.external_url AS cover_external_url,
      c.sha256 AS cover_sha256
    FROM textbook_assignments ta
    JOIN materials m ON m.id = ta.material_id
    LEFT JOIN material_cover_assets c ON c.material_id = m.id AND c.status = 'ready'
    WHERE ta.academic_year_id = ? AND ta.grade = ?
      AND NOT EXISTS (
        SELECT 1 FROM library_editions e
        WHERE e.material_id=m.id AND e.fund='literature'
      )
    ORDER BY ta.sort_order ASC, m.sort_title ASC, ta.id ASC
    LIMIT 1000
  `).bind(academicYear.id, input.grade).all<Row>();

  const manualResponse = await db.prepare(`
    SELECT
      id, NULL AS material_id, grade, status, sort_order, version,
      created_at, updated_at, published_at, archived_at,
      NULL AS material_version, title, author, publication_year, subject,
      publisher, isbn, resource_url AS primary_resource_url,
      cover_url AS manual_cover_url, 1 AS active_resource_count,
      0 AS broken_resource_count, 'manual' AS source
    FROM manual_textbooks
    WHERE academic_year_id = ? AND grade = ? AND status != 'deleted'
    ORDER BY sort_order ASC, title COLLATE NOCASE ASC, id ASC
    LIMIT 1000
  `).bind(academicYear.id, input.grade).all<Row>();
  const items = [...(response.results ?? []), ...(manualResponse.results ?? [])]
    .map((row) => toManagedTextbook(row))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title, "uk-UA") || a.id.localeCompare(b.id))
    .slice(0, 1000);
  const candidates = input.q.length >= 2
    ? await listCandidates(db, input.grade, input.q)
    : [];
  return { academicYear, items, candidates };
}

export async function createTextbookAssignment(
  db: TextbookDatabase,
  user: ChatGPTUser,
  input: { requestId: string; materialId: string; grade: number; publish: boolean },
): Promise<ManagedTextbook> {
  const requestHash = await mutationHash({ kind: "textbook.assignment.create", ...input });
  const replay = await replayCompletedCommand<ManagedTextbook>(db, input.requestId, requestHash);
  if (replay) return replay;

  const [actor, academicYear] = await Promise.all([
    resolveActor(db, user),
    requireSingleActiveAcademicYear(db),
  ]);
  const material = await requireEligibleMaterial(db, input.materialId, input.grade, {
    requireResource: input.publish,
  });
  const existing = await db.prepare(`
    SELECT id FROM textbook_assignments
    WHERE academic_year_id = ? AND grade = ? AND material_id = ?
    LIMIT 1
  `).bind(academicYear.id, input.grade, input.materialId).first<{ id: string }>();
  if (existing) {
    throw new TextbookCatalogError(
      "textbook_assignment_exists",
      409,
      "Цей підручник уже є у списку обраного класу.",
    );
  }

  const now = new Date().toISOString();
  const id = `TXT-${crypto.randomUUID()}`;
  const status = input.publish ? "published" : "draft";
  const sortOrder = await nextTextbookSortOrder(db, academicYear.id, input.grade);
  const result: ManagedTextbook = {
    id,
    source: "fund",
    materialId: input.materialId,
    grade: input.grade,
    status,
    sortOrder,
    version: 1,
    materialVersion: material.materialVersion,
    title: material.title,
    author: material.author,
    publicationYear: material.publicationYear,
    subject: material.subject,
    publisher: material.publisher,
    isbn: "",
    coverUrl: material.coverUrl,
    activeResourceCount: material.activeResourceCount,
    brokenResourceCount: material.brokenResourceCount,
    primaryResourceUrl: material.primaryResourceUrl,
    publishedAt: input.publish ? now : null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const statements = [
    educationalMaterialGuardStatement(db, input.materialId),
    insertCommandStatement(db, input.requestId, requestHash, actor.id, "textbook.assignment.create", id, now),
    db.prepare(`
      INSERT INTO textbook_assignments (
        id, academic_year_id, material_id, grade, status, sort_order, version,
        published_at, archived_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, ?, ?)
    `).bind(
      id,
      academicYear.id,
      input.materialId,
      input.grade,
      status,
      sortOrder,
      input.publish ? now : null,
      now,
      now,
    ),
    auditStatement(db, actor, input.requestId, "textbook.assignment.created", id, null, result, now, false),
    completeCommandStatement(db, input.requestId, result, now),
  ];
  try {
    await db.batch(statements);
    return result;
  } catch (error) {
    const completed = await replayCompletedCommand<ManagedTextbook>(db, input.requestId, requestHash);
    if (completed) return completed;
    await assertEducationalMaterial(db, input.materialId);
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (message.includes("idx_textbook_assignments_year_grade_material")) {
      throw new TextbookCatalogError("textbook_assignment_exists", 409, "Цей підручник уже є у списку обраного класу.");
    }
    throw error;
  }
}

export async function createManualTextbook(
  db: TextbookDatabase,
  user: ChatGPTUser,
  input: { requestId: string; publish: boolean } & ManualTextbookFields,
): Promise<ManagedTextbook> {
  const requestHash = await mutationHash({ kind: "textbook.manual.create", ...input });
  const replay = await replayCompletedCommand<ManagedTextbook>(db, input.requestId, requestHash);
  if (replay) return replay;
  const [actor, academicYear] = await Promise.all([
    resolveActor(db, user),
    requireSingleActiveAcademicYear(db),
  ]);
  const now = new Date().toISOString();
  const id = `TXM-${crypto.randomUUID()}`;
  const status = input.publish ? "published" : "draft";
  const sortOrder = input.sortOrder ?? await nextTextbookSortOrder(db, academicYear.id, input.grade);
  const duplicate = await db.prepare(`
    SELECT id FROM manual_textbooks
    WHERE academic_year_id = ? AND grade = ? AND resource_url = ? AND status != 'deleted'
    LIMIT 1
  `).bind(academicYear.id, input.grade, input.resourceUrl).first<{ id: string }>();
  if (duplicate) {
    throw new TextbookCatalogError("manual_textbook_exists", 409, "Е-підручник із цим покликанням уже є у списку обраного класу.");
  }
  const result: ManagedTextbook = {
    id,
    source: "manual",
    materialId: null,
    materialVersion: null,
    grade: input.grade,
    status,
    sortOrder,
    version: 1,
    title: input.title,
    author: input.author,
    publicationYear: input.publicationYear,
    subject: input.subject,
    publisher: input.publisher,
    isbn: input.isbn,
    coverUrl: input.coverUrl,
    activeResourceCount: 1,
    brokenResourceCount: 0,
    primaryResourceUrl: input.resourceUrl,
    publishedAt: input.publish ? now : null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const entityType = "manual_textbook";
  const statements = [
    insertCommandStatement(db, input.requestId, requestHash, actor.id, "textbook.manual.create", id, now, entityType),
    db.prepare(`
      INSERT INTO manual_textbooks (
        id, academic_year_id, grade, title, author, subject, publisher,
        publication_year, isbn, resource_url, cover_url, status, sort_order,
        version, created_by_user_id, updated_by_user_id, published_at,
        archived_at, deleted_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, NULL, ?, ?)
    `).bind(
      id,
      academicYear.id,
      input.grade,
      input.title,
      input.author,
      input.subject,
      input.publisher,
      input.publicationYear,
      input.isbn,
      input.resourceUrl,
      input.coverUrl,
      status,
      sortOrder,
      actor.id,
      actor.id,
      input.publish ? now : null,
      now,
      now,
    ),
    auditStatement(db, actor, input.requestId, "textbook.manual.created", id, null, result, now, false, entityType),
    completeCommandStatement(db, input.requestId, result, now),
  ];
  try {
    await db.batch(statements);
    return result;
  } catch (error) {
    const completed = await replayCompletedCommand<ManagedTextbook>(db, input.requestId, requestHash);
    if (completed) return completed;
    throw error;
  }
}

export async function mutateTextbookAssignment(
  db: TextbookDatabase,
  user: ChatGPTUser,
  id: string,
  input: {
    requestId: string;
    expectedVersion: number;
    action: "publish" | "archive" | "restore" | "reorder" | "edit" | "delete";
    sortOrder?: number;
    fields?: ManualTextbookFields;
  },
): Promise<ManagedTextbook> {
  const requestHash = await mutationHash({ kind: "textbook.entry.update", id, ...input });
  const replay = await replayCompletedCommand<ManagedTextbook>(db, input.requestId, requestHash);
  if (replay) return replay;
  const actor = await resolveActor(db, user);
  const before = await requireManagedTextbook(db, id);
  if (before.source === "fund" && before.materialId) {
    await assertEducationalMaterial(db, before.materialId);
  }
  if (before.version !== input.expectedVersion) {
    throw new TextbookCatalogError("version_conflict", 409, "Список уже змінився. Оновіть сторінку й повторіть дію.");
  }

  const now = timestampAfter(before.updatedAt);
  let status = before.status;
  let publishedAt = before.publishedAt;
  let archivedAt = before.archivedAt;
  let sortOrder = before.sortOrder;
  let result: ManagedTextbook = { ...before };
  if (before.status === "deleted") {
    throw new TextbookCatalogError("textbook_entry_deleted", 410, "Цей ручний запис уже видалено.");
  }
  if (input.action === "archive") {
    if (before.status === "archived") throw new TextbookCatalogError("no_changes", 400, "Підручник уже вилучено зі списку.");
    status = "archived";
    archivedAt = now;
  } else if (input.action === "publish") {
    if (before.status === "published") throw new TextbookCatalogError("no_changes", 400, "Підручник уже опубліковано.");
    if (before.source === "fund") {
      if (!before.materialId) throw new TextbookCatalogError("material_not_found", 404, "Матеріал не знайдено.");
      await requireEligibleMaterial(db, before.materialId, before.grade, { requireResource: true });
    }
    status = "published";
    publishedAt = now;
    archivedAt = null;
  } else if (input.action === "restore") {
    if (before.status !== "archived") throw new TextbookCatalogError("no_changes", 400, "Підручник уже є у списку.");
    if (before.source === "fund") {
      if (!before.materialId) throw new TextbookCatalogError("material_not_found", 404, "Матеріал не знайдено.");
      await requireEligibleMaterial(db, before.materialId, before.grade, { requireResource: false });
    }
    status = "draft";
    publishedAt = null;
    archivedAt = null;
  } else if (input.action === "reorder") {
    if (input.sortOrder === undefined || input.sortOrder === before.sortOrder) {
      throw new TextbookCatalogError("no_changes", 400, "Вкажіть новий порядок показу.");
    }
    sortOrder = input.sortOrder;
  } else if (input.action === "edit") {
    if (before.source !== "manual" || !input.fields) {
      throw new TextbookCatalogError("manual_textbook_required", 400, "Редагувати бібліографічні дані можна лише у ручному записі.");
    }
    const academicYear = await requireSingleActiveAcademicYear(db);
    const duplicate = await db.prepare(`
      SELECT id FROM manual_textbooks
      WHERE academic_year_id = ? AND grade = ? AND resource_url = ?
        AND status != 'deleted' AND id != ?
      LIMIT 1
    `).bind(academicYear.id, input.fields.grade, input.fields.resourceUrl, id).first<{ id: string }>();
    if (duplicate) {
      throw new TextbookCatalogError("manual_textbook_exists", 409, "Е-підручник із цим покликанням уже є у списку обраного класу.");
    }
    sortOrder = input.fields.sortOrder ?? (
      input.fields.grade === before.grade
        ? before.sortOrder
        : await nextTextbookSortOrder(db, academicYear.id, input.fields.grade)
    );
    result = {
      ...before,
      grade: input.fields.grade,
      title: input.fields.title,
      author: input.fields.author,
      subject: input.fields.subject,
      publisher: input.fields.publisher,
      publicationYear: input.fields.publicationYear,
      isbn: input.fields.isbn,
      primaryResourceUrl: input.fields.resourceUrl,
      coverUrl: input.fields.coverUrl,
      sortOrder,
    };
  } else if (input.action === "delete") {
    if (before.source !== "manual") {
      throw new TextbookCatalogError("manual_textbook_required", 400, "Повністю видалити можна лише ручний запис е-підручника.");
    }
    status = "deleted";
  } else {
    throw new TextbookCatalogError("invalid_textbook_action", 400, "Некоректна дія з е-підручником.");
  }

  result = {
    ...result,
    status,
    sortOrder,
    version: before.version + 1,
    publishedAt,
    archivedAt,
    updatedAt: now,
  };
  const entityType = before.source === "manual" ? "manual_textbook" : "textbook_assignment";
  const actionPrefix = before.source === "manual" ? "textbook.manual" : "textbook.assignment";
  const update = before.source === "manual"
    ? db.prepare(`
      UPDATE manual_textbooks
      SET grade = ?, title = ?, author = ?, subject = ?, publisher = ?,
        publication_year = ?, isbn = ?, resource_url = ?, cover_url = ?,
        status = ?, sort_order = ?, version = version + 1,
        updated_by_user_id = ?, published_at = ?, archived_at = ?,
        deleted_at = CASE WHEN ? = 'deleted' THEN ? ELSE NULL END,
        updated_at = ?
      WHERE id = ? AND version = ? AND status != 'deleted'
    `).bind(
      result.grade,
      result.title,
      result.author,
      result.subject,
      result.publisher,
      result.publicationYear,
      result.isbn,
      result.primaryResourceUrl,
      result.coverUrl,
      status,
      sortOrder,
      actor.id,
      publishedAt,
      archivedAt,
      status,
      status === "deleted" ? now : null,
      now,
      id,
      input.expectedVersion,
    )
    : db.prepare(`
      UPDATE textbook_assignments
      SET status = ?, sort_order = ?, version = version + 1,
        published_at = ?, archived_at = ?, updated_at = ?
      WHERE id = ? AND version = ?
    `).bind(status, sortOrder, publishedAt, archivedAt, now, id, input.expectedVersion);
  const statements = [
    ...(before.source === "fund" && before.materialId
      ? [educationalMaterialGuardStatement(db, before.materialId)]
      : []),
    insertCommandStatement(db, input.requestId, requestHash, actor.id, `${actionPrefix}.${input.action}`, id, now, entityType),
    update,
    auditStatement(
      db,
      actor,
      input.requestId,
      `${actionPrefix}.${input.action}`,
      id,
      before,
      result,
      now,
      true,
      entityType,
    ),
    completeCommandStatement(db, input.requestId, result, now),
  ];
  try {
    await db.batch(statements);
    return result;
  } catch (error) {
    const completed = await replayCompletedCommand<ManagedTextbook>(db, input.requestId, requestHash);
    if (completed) return completed;
    if (before.source === "fund" && before.materialId) {
      await assertEducationalMaterial(db, before.materialId);
    }
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (message.includes("NOT NULL constraint failed: audit_events.entity_id")) {
      throw new TextbookCatalogError("version_conflict", 409, "Список уже змінився. Оновіть сторінку й повторіть дію.");
    }
    throw error;
  }
}

async function listCandidates(
  db: TextbookDatabase,
  grade: number,
  q: string,
): Promise<TextbookCandidate[]> {
  const normalized = normalizeSearch(q);
  if (!normalized) return [];
  const tokens = normalized.split(" ").filter(Boolean).slice(0, 12);
  const tokenPredicates = tokens
    .map(() => "(instr(lower(m.search_text), ?) > 0 OR instr(lower(m.id), ?) > 0)")
    .join(" AND ");
  const tokenBindings = tokens.flatMap((token) => [token, token]);
  const response = await db.prepare(`
    SELECT
      m.id AS material_id,
      m.version AS material_version,
      m.title,
      m.author,
      m.publication_year,
      m.subject,
      m.publisher,
      m.publication_type,
      m.class_from,
      m.class_to,
      (
        SELECT count(*) FROM material_links ml
        WHERE ml.material_id = m.id AND ml.kind = 'ebook'
          AND ml.is_public = 1 AND ml.status = 'active'
          AND ml.url GLOB 'https://*'
      ) AS active_resource_count,
      (
        SELECT ml.url FROM material_links ml
        WHERE ml.material_id = m.id AND ml.kind = 'ebook'
          AND ml.is_public = 1 AND ml.status = 'active'
          AND ml.url GLOB 'https://*'
        ORDER BY ml.sort_order ASC, ml.id ASC LIMIT 1
      ) AS resource_url,
      c.storage_provider AS cover_storage_provider,
      c.storage_key AS cover_storage_key,
      c.external_url AS cover_external_url,
      c.sha256 AS cover_sha256
    FROM materials m
    LEFT JOIN material_cover_assets c ON c.material_id = m.id AND c.status = 'ready'
    WHERE m.status = 'active'
      AND m.archived_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM library_editions e
        WHERE e.material_id=m.id AND e.fund='literature'
      )
      AND ${tokenPredicates}
    ORDER BY
      CASE
        WHEN m.class_from IS NOT NULL AND m.class_to IS NOT NULL
          AND ? BETWEEN m.class_from AND m.class_to THEN 0
        WHEN m.class_from IS NULL AND m.class_to IS NULL THEN 1
        ELSE 2
      END,
      m.sort_title ASC,
      m.id ASC
  `).bind(...tokenBindings, grade).all<Row>();
  return (response.results ?? []).map((row) => {
    const materialId = boundedText(row.material_id, 64);
    return {
      materialId,
      materialVersion: positiveInteger(row.material_version),
      title: boundedText(row.title, 500),
      author: boundedText(row.author, 500),
      publicationYear: nullableYear(row.publication_year),
      subject: boundedText(row.subject, 240),
      publisher: boundedText(row.publisher, 240),
      publicationType: boundedText(row.publication_type, 120),
      classFrom: nullableGrade(row.class_from),
      classTo: nullableGrade(row.class_to),
      coverUrl: coverUrl(row, materialId),
      resourceUrl: safeHttpsUrl(row.resource_url),
      activeResourceCount: nonNegativeInteger(row.active_resource_count),
    };
  }).filter((candidate) => candidate.materialId);
}

async function requireManagedTextbook(db: TextbookDatabase, id: string): Promise<ManagedTextbook> {
  const row = await db.prepare(`
    SELECT
      ta.id,
      ta.material_id,
      ta.grade,
      ta.status,
      ta.sort_order,
      ta.version,
      ta.created_at,
      ta.updated_at,
      ta.published_at,
      ta.archived_at,
      m.version AS material_version,
      m.title,
      m.author,
      m.publication_year,
      m.subject,
      m.publisher,
      NULL AS isbn,
      'fund' AS source,
      (
        SELECT count(*) FROM material_links ml
        WHERE ml.material_id = m.id AND ml.kind = 'ebook'
          AND ml.is_public = 1 AND ml.status = 'active'
          AND ml.url GLOB 'https://*'
      ) AS active_resource_count,
      (
        SELECT count(*) FROM material_links ml
        WHERE ml.material_id = m.id AND ml.kind = 'ebook'
          AND (ml.is_public = 0 OR ml.status != 'active' OR ml.url NOT GLOB 'https://*')
      ) AS broken_resource_count,
      (
        SELECT ml.url FROM material_links ml
        WHERE ml.material_id = m.id AND ml.kind = 'ebook'
          AND ml.is_public = 1 AND ml.status = 'active'
          AND ml.url GLOB 'https://*'
        ORDER BY ml.sort_order ASC, ml.id ASC LIMIT 1
      ) AS primary_resource_url,
      c.storage_provider AS cover_storage_provider,
      c.storage_key AS cover_storage_key,
      c.external_url AS cover_external_url,
      c.sha256 AS cover_sha256
    FROM textbook_assignments ta
    JOIN materials m ON m.id = ta.material_id
    LEFT JOIN material_cover_assets c ON c.material_id = m.id AND c.status = 'ready'
    WHERE ta.id = ? LIMIT 1
  `).bind(id).first<Row>();
  if (row) return toManagedTextbook(row);
  const manualRow = await db.prepare(`
    SELECT
      id, NULL AS material_id, grade, status, sort_order, version,
      created_at, updated_at, published_at, archived_at,
      NULL AS material_version, title, author, publication_year, subject,
      publisher, isbn, resource_url AS primary_resource_url,
      cover_url AS manual_cover_url, 1 AS active_resource_count,
      0 AS broken_resource_count, 'manual' AS source
    FROM manual_textbooks
    WHERE id = ? LIMIT 1
  `).bind(id).first<Row>();
  if (!manualRow) throw new TextbookCatalogError("textbook_assignment_not_found", 404, "Запис е-підручника не знайдено.");
  return toManagedTextbook(manualRow);
}

async function requireEligibleMaterial(
  db: TextbookDatabase,
  materialId: string,
  grade: number,
  options: { requireResource: boolean } = { requireResource: true },
): Promise<{
  title: string;
  author: string;
  publicationYear: number | null;
  subject: string;
  publisher: string;
  coverUrl: string;
  activeResourceCount: number;
  brokenResourceCount: number;
  primaryResourceUrl: string;
  materialVersion: number;
}> {
  const row = await db.prepare(`
    SELECT
      m.id,
      m.version AS material_version,
      m.title,
      m.author,
      m.publication_year,
      m.subject,
      m.publisher,
      m.publication_type,
      m.class_from,
      m.class_to,
      m.status,
      m.archived_at,
      EXISTS(
        SELECT 1 FROM library_editions e
        WHERE e.material_id=m.id AND e.fund='literature'
      ) AS is_literature,
      (
        SELECT count(*) FROM material_links ml
        WHERE ml.material_id = m.id AND ml.kind = 'ebook'
          AND ml.is_public = 1 AND ml.status = 'active'
          AND ml.url GLOB 'https://*'
      ) AS active_resource_count,
      (
        SELECT count(*) FROM material_links ml
        WHERE ml.material_id = m.id AND ml.kind = 'ebook'
          AND (ml.is_public = 0 OR ml.status != 'active' OR ml.url NOT GLOB 'https://*')
      ) AS broken_resource_count,
      (
        SELECT ml.url FROM material_links ml
        WHERE ml.material_id = m.id AND ml.kind = 'ebook'
          AND ml.is_public = 1 AND ml.status = 'active'
          AND ml.url GLOB 'https://*'
        ORDER BY ml.sort_order ASC, ml.id ASC LIMIT 1
      ) AS primary_resource_url,
      c.storage_provider AS cover_storage_provider,
      c.storage_key AS cover_storage_key,
      c.external_url AS cover_external_url,
      c.sha256 AS cover_sha256
    FROM materials m
    LEFT JOIN material_cover_assets c ON c.material_id = m.id AND c.status = 'ready'
    WHERE m.id = ? LIMIT 1
  `).bind(materialId).first<Row>();
  if (!row) throw new TextbookCatalogError("material_not_found", 404, "Матеріал не знайдено.");
  if (Number(row.is_literature) === 1) {
    throw new TextbookCatalogError(
      "librarika_authoritative",
      410,
      LIBRARIKA_MATERIAL_MESSAGE,
    );
  }
  if (boundedText(row.status, 20) !== "active" || row.archived_at) {
    throw new TextbookCatalogError("textbook_not_eligible", 409, "Архівний матеріал не можна опублікувати.");
  }
  // The librarian curates the electronic shelf explicitly.  Every active
  // fund card may therefore be assigned to a grade, even when an imported
  // record has no publication type or class range yet.  The assignment — not
  // imperfect legacy metadata — is the authoritative inclusion decision.
  void grade;
  const activeResourceCount = nonNegativeInteger(row.active_resource_count);
  if (options.requireResource && activeResourceCount < 1) {
    throw new TextbookCatalogError("textbook_link_required", 409, "Спочатку додайте до картки активне публічне HTTPS-посилання типу «Електронна версія».");
  }
  return {
    title: boundedText(row.title, 500),
    author: boundedText(row.author, 500),
    publicationYear: nullableYear(row.publication_year),
    subject: boundedText(row.subject, 240),
    publisher: boundedText(row.publisher, 240),
    coverUrl: coverUrl(row, materialId),
    activeResourceCount,
    brokenResourceCount: nonNegativeInteger(row.broken_resource_count),
    primaryResourceUrl: safeHttpsUrl(row.primary_resource_url),
    materialVersion: positiveInteger(row.material_version),
  };
}

async function assertEducationalMaterial(
  db: TextbookDatabase,
  materialId: string,
): Promise<void> {
  const row = await db.prepare(`
    SELECT 1 AS found FROM library_editions
    WHERE material_id=? AND fund='literature'
    LIMIT 1
  `).bind(materialId).first<{ found: number }>();
  if (row) {
    throw new TextbookCatalogError(
      "librarika_authoritative",
      410,
      LIBRARIKA_MATERIAL_MESSAGE,
    );
  }
}

function educationalMaterialGuardStatement(
  db: TextbookDatabase,
  materialId: string,
): D1Statement {
  return db.prepare(`
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM library_editions
      WHERE material_id=? AND fund='literature'
    ) THEN 1 ELSE json('librarika_authoritative') END
  `).bind(materialId);
}

async function requireSingleActiveAcademicYear(db: TextbookDatabase): Promise<TextbookAcademicYear> {
  const response = await db.prepare(`
    SELECT id, label FROM academic_years
    WHERE status = 'active'
    ORDER BY start_date DESC, id ASC
    LIMIT 2
  `).all<{ id: string; label: string }>();
  const rows = response.results ?? [];
  if (rows.length === 0) {
    throw new TextbookCatalogError("active_academic_year_missing", 503, "Активний навчальний рік ще не налаштовано.");
  }
  if (rows.length > 1) {
    throw new TextbookCatalogError("active_academic_year_conflict", 503, "У системі одночасно активні кілька навчальних років.");
  }
  return { id: boundedText(rows[0].id, 160), label: boundedText(rows[0].label, 80) };
}

function toManagedTextbook(row: Row): ManagedTextbook {
  const materialId = boundedText(row.material_id, 64);
  const status = boundedText(row.status, 20);
  const source = boundedText(row.source, 20) === "manual" ? "manual" : "fund";
  return {
    id: boundedText(row.id, 160),
    source,
    materialId: source === "manual" ? null : materialId,
    materialVersion: source === "manual" ? null : positiveInteger(row.material_version),
    grade: gradeInteger(row.grade),
    status: status === "published" || status === "archived" || status === "deleted" ? status : "draft",
    sortOrder: nonNegativeInteger(row.sort_order),
    version: positiveInteger(row.version),
    title: boundedText(row.title, 500),
    author: boundedText(row.author, 500),
    publicationYear: nullableYear(row.publication_year),
    subject: boundedText(row.subject, 240),
    publisher: boundedText(row.publisher, 240),
    isbn: boundedText(row.isbn, 32),
    coverUrl: source === "manual" ? safeHttpsUrl(row.manual_cover_url) : coverUrl(row, materialId),
    activeResourceCount: nonNegativeInteger(row.active_resource_count),
    brokenResourceCount: nonNegativeInteger(row.broken_resource_count),
    primaryResourceUrl: safeHttpsUrl(row.primary_resource_url),
    publishedAt: boundedText(row.published_at, 40) || null,
    archivedAt: boundedText(row.archived_at, 40) || null,
    createdAt: boundedText(row.created_at, 40),
    updatedAt: boundedText(row.updated_at, 40),
  };
}

async function nextTextbookSortOrder(
  db: TextbookDatabase,
  academicYearId: string,
  grade: number,
): Promise<number> {
  const row = await db.prepare(`
    SELECT COALESCE(MAX(sort_order), -10) + 10 AS next_order
    FROM (
      SELECT sort_order FROM textbook_assignments
      WHERE academic_year_id = ? AND grade = ?
      UNION ALL
      SELECT sort_order FROM manual_textbooks
      WHERE academic_year_id = ? AND grade = ? AND status != 'deleted'
    )
  `).bind(academicYearId, grade, academicYearId, grade).first<{ next_order: number }>();
  return Math.max(0, nonNegativeInteger(row?.next_order));
}

async function resolveActor(db: TextbookDatabase, user: ChatGPTUser): Promise<Actor> {
  const response = await db.prepare(`
    SELECT id FROM users
    WHERE status = 'active' AND role IN ('admin', 'librarian')
      AND ((? IS NOT NULL AND id = ?)
        OR (? IS NULL AND (auth_user_id = ? OR lower(email) = lower(?))))
    ORDER BY id LIMIT 2
  `).bind(
    user.d1UserId ?? null,
    user.d1UserId ?? null,
    user.d1UserId ?? null,
    user.userId,
    user.email,
  ).all<{ id: string }>();
  const rows = response.results ?? [];
  if (rows.length !== 1) {
    throw new TextbookCatalogError("actor_not_mapped", 403, "Обліковий запис не прив’язано до активного бібліотекаря.");
  }
  return { id: rows[0].id, email: user.email.toLocaleLowerCase("uk-UA") };
}

function insertCommandStatement(
  db: TextbookDatabase,
  requestId: string,
  requestHash: string,
  actorUserId: string,
  kind: string,
  targetId: string,
  createdAt: string,
  entityType = "textbook_assignment",
): D1Statement {
  return db.prepare(`
    INSERT INTO mutation_commands (
      id, draft_id, kind, actor_user_id, status, target_type, target_id,
      request_hash, result_json, error_code, error_message,
      created_at, updated_at, completed_at
    ) VALUES (?, NULL, ?, ?, 'processing', ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL)
  `).bind(requestId, kind, actorUserId, entityType, targetId, requestHash, createdAt, createdAt);
}

function completeCommandStatement(
  db: TextbookDatabase,
  requestId: string,
  result: unknown,
  completedAt: string,
): D1Statement {
  return db.prepare(`
    UPDATE mutation_commands
    SET status = 'completed', result_json = ?, updated_at = ?, completed_at = ?
    WHERE id = ? AND status = 'processing'
  `).bind(JSON.stringify(result), completedAt, completedAt, requestId);
}

function auditStatement(
  db: TextbookDatabase,
  actor: Actor,
  requestId: string,
  action: string,
  entityId: string,
  before: unknown,
  after: unknown,
  createdAt: string,
  guardPreviousChange: boolean,
  entityType = "textbook_assignment",
): D1Statement {
  const entityExpression = guardPreviousChange ? "CASE WHEN changes() = 1 THEN ? ELSE NULL END" : "?";
  return db.prepare(`
    INSERT INTO audit_events (
      id, actor_user_id, actor_email, action, entity_type, entity_id,
      request_id, before_json, after_json, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ${entityExpression}, ?, ?, ?, NULL, ?)
  `).bind(
    `AUD-${crypto.randomUUID()}`,
    actor.id,
    actor.email,
    action,
    entityType,
    entityId,
    requestId,
    before === null ? null : JSON.stringify(before),
    after === null ? null : JSON.stringify(after),
    createdAt,
  );
}

async function replayCompletedCommand<T>(
  db: TextbookDatabase,
  requestId: string,
  requestHash: string,
): Promise<T | null> {
  const command = await db.prepare(`
    SELECT status, request_hash, result_json, error_code, error_message
    FROM mutation_commands WHERE id = ? LIMIT 1
  `).bind(requestId).first<{
    status: string;
    request_hash: string;
    result_json: string | null;
    error_code: string | null;
    error_message: string | null;
  }>();
  if (!command) return null;
  if (command.request_hash !== requestHash) {
    throw new TextbookCatalogError("request_id_conflict", 409, "Цей номер запиту вже використано для іншої зміни.");
  }
  if (command.status === "processing") {
    throw new TextbookCatalogError("mutation_in_progress", 409, "Зміна ще виконується. Оновіть список за кілька секунд.");
  }
  if (command.status === "failed") {
    throw new TextbookCatalogError(command.error_code || "mutation_failed", 409, command.error_message || "Зміну не виконано.");
  }
  if (command.status !== "completed" || !command.result_json) {
    throw new TextbookCatalogError("mutation_result_invalid", 503, "Збережений результат зміни пошкоджено.");
  }
  try {
    return JSON.parse(command.result_json) as T;
  } catch {
    throw new TextbookCatalogError("mutation_result_invalid", 503, "Збережений результат зміни пошкоджено.");
  }
}

async function mutationHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function coverUrl(row: Row, materialId: string): string {
  const external = safeHttpsUrl(row.cover_external_url);
  if (external) return external;
  if (boundedText(row.cover_storage_provider, 40) !== "r2" || !boundedText(row.cover_storage_key, 500)) return "";
  const hash = /^[0-9a-f]{64}$/iu.test(String(row.cover_sha256 ?? ""))
    ? `?v=${String(row.cover_sha256).slice(0, 12).toLocaleLowerCase("uk-UA")}`
    : "";
  return `/api/catalog-v2/covers/${encodeURIComponent(materialId)}${hash}`;
}

function safeHttpsUrl(value: unknown): string {
  const candidate = boundedText(value, 2_000);
  if (!candidate) return "";
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeSearch(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("uk-UA").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function boundedText(value: unknown, max: number): string {
  const text = String(value ?? "").normalize("NFC").trim();
  return text.length <= max ? text : text.slice(0, max);
}

function nonNegativeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function positiveInteger(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 1;
}

function gradeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 11 ? number : 1;
}

function nullableGrade(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 11 ? number : null;
}

function nullableYear(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 1000 && number <= 3000 ? number : null;
}

function timestampAfter(previous: string): string {
  const now = Date.now();
  const previousTime = Date.parse(previous);
  return new Date(Number.isFinite(previousTime) && now <= previousTime ? previousTime + 1 : now).toISOString();
}
