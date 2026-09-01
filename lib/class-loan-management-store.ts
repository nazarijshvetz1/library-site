import type { CatalogD1Database } from "@/lib/catalog-d1";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DEFAULT_HISTORY_LIMIT = 80;
const MAX_HISTORY_LIMIT = 200;

type Row = Record<string, unknown>;

export type ClassLoanLifecycleStatus = "active" | "removed";
export type ClassLoanStatus = "open" | "closed" | "cancelled";
export type ClassLoanStatementLinkOrigin =
  | "issued"
  | "legacy_exact"
  | "legacy_reviewed";

export type ClassLoanManagementHeader = {
  requestedClassLoanId: string;
  classLoanId: string;
  aliasResolved: boolean;
  resolutionDepth: number;
  classYearId: string;
  className: string;
  classYearStatus: "planned" | "active" | "closed";
  academicYearId: string;
  academicYearLabel: string;
  cohortId: string;
  curatorUserId: string | null;
  curatorName: string;
  classroomId: string | null;
  classroomName: string;
  responsibleTeacherUserId: string;
  responsibleTeacherName: string;
  status: ClassLoanStatus;
  issuedAt: string;
  dueAt: string | null;
  closedAt: string | null;
  notes: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ClassLoanManagementItem = {
  classLoanItemId: string;
  classLoanId: string;
  materialId: string;
  catalogNumber: number;
  title: string;
  author: string;
  publicationYear: number | null;
  isbn: string;
  subject: string;
  rubric: string;
  thumbnailUrl: string;
  sourceLocationId: string;
  sourceLocationName: string;
  sourceLocationType: string;
  condition: string;
  lifecycleStatus: ClassLoanLifecycleStatus;
  version: number;
  removedAt: string | null;
  removedByUserId: string | null;
  removedByName: string;
  removalReason: string;
  quantityIssued: number;
  quantityReturned: number;
  quantityOutstanding: number;
  effectiveQuantityIssued: number;
  holdingQuantity: number;
  reservedQuantity: number;
  currentAvailableAtSource: number;
  itemIssuedAt: string;
  itemCreatedAt: string;
  itemUpdatedAt: string;
  statementLinked: boolean;
  statementLineId: string | null;
  statementLinkOrigin: ClassLoanStatementLinkOrigin | null;
  editable: boolean;
  editBlockedReason: "loan_not_open" | "statement_item_link_missing" | null;
};

export type ClassLoanHistoryLine = {
  lineId: string;
  classLoanItemId: string;
  materialId: string;
  title: string;
  quantityDelta: number;
  quantityBefore: number;
  quantityAfter: number;
  locationId: string;
  locationName: string;
  condition: string;
};

export type ClassLoanTransactionHistoryEvent = {
  kind: "issue" | "return";
  id: string;
  transactionId: string;
  requestId: string;
  occurredAt: string;
  createdAt: string;
  actorUserId: string;
  actorName: string;
  actorEmail: string;
  notes: string;
  lines: ClassLoanHistoryLine[];
};

export type ClassLoanAdjustmentHistoryEvent = {
  kind: "adjustment";
  id: string;
  adjustmentId: string;
  requestId: string;
  transactionId: string | null;
  action: "quantity_changed" | "removed" | "restored";
  occurredAt: string;
  createdAt: string;
  actorUserId: string;
  actorName: string;
  actorEmail: string;
  classLoanItemId: string;
  statementLineId: string | null;
  materialId: string;
  title: string;
  locationId: string;
  locationName: string;
  condition: string;
  quantityBefore: number;
  quantityAfter: number;
  quantityReturnedSnapshot: number;
  stockDelta: number;
  reason: string;
};

export type ClassLoanMetadataHistoryEvent = {
  kind: "metadata";
  id: string;
  auditEventId: string;
  requestId: string | null;
  action: string;
  occurredAt: string;
  createdAt: string;
  actorUserId: string;
  actorName: string;
  actorEmail: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
};

export type ClassLoanManagementHistoryEvent =
  | ClassLoanTransactionHistoryEvent
  | ClassLoanAdjustmentHistoryEvent
  | ClassLoanMetadataHistoryEvent;

export type ClassLoanLegacyStatementCandidate = {
  statementLineId: string;
  title: string;
  author: string;
  publicationYear: number | null;
  subject: string;
  rubric: string;
  quantityIssued: number;
};

export type ClassLoanManagementRecord = {
  header: ClassLoanManagementHeader;
  items: ClassLoanManagementItem[];
  history: ClassLoanManagementHistoryEvent[];
  legacyStatementCandidates: ClassLoanLegacyStatementCandidate[];
  historyLimit: number;
  historyTruncated: boolean;
};

export type ClassLoanManagementReadOptions = {
  historyLimit?: number;
};

export class ClassLoanManagementError extends Error {
  readonly code:
    | "class_loan_not_found"
    | "class_loan_alias_invalid"
    | "class_loan_management_unavailable";
  readonly status: number;

  constructor(code: ClassLoanManagementError["code"], message: string) {
    super(message);
    this.name = "ClassLoanManagementError";
    this.code = code;
    this.status = code === "class_loan_not_found"
      ? 404
      : code === "class_loan_alias_invalid"
        ? 409
        : 503;
  }
}

export async function readClassLoanManagement(
  db: CatalogD1Database,
  classLoanId: string,
  options: ClassLoanManagementReadOptions = {},
): Promise<ClassLoanManagementRecord> {
  const requestedClassLoanId = classLoanId.trim();
  if (!IDENTIFIER.test(requestedClassLoanId)) {
    throw new ClassLoanManagementError(
      "class_loan_not_found",
      "Видачу на клас не знайдено.",
    );
  }
  const historyLimit = boundedHistoryLimit(options.historyLimit);

  try {
    const headerRow = await db.prepare(HEADER_SQL)
      .bind(requestedClassLoanId)
      .first<Row>();
    if (!headerRow) {
      throw new ClassLoanManagementError(
        "class_loan_not_found",
        "Видачу на клас не знайдено.",
      );
    }
    if (nullableText(headerRow.canonicalMergedIntoClassLoanId)) {
      throw new ClassLoanManagementError(
        "class_loan_alias_invalid",
        "Не вдалося однозначно визначити основну видачу на клас.",
      );
    }

    const header = projectHeader(requestedClassLoanId, headerRow);
    const queryLimit = historyLimit + 1;
    const [
      itemResult,
      transactionResult,
      adjustmentResult,
      metadataResult,
      legacyStatementCandidateResult,
    ] =
      await Promise.all([
        db.prepare(ITEMS_SQL).bind(header.classLoanId).all<Row>(),
        db.prepare(TRANSACTION_HISTORY_SQL)
          .bind(header.classLoanId, queryLimit)
          .all<Row>(),
        db.prepare(ADJUSTMENT_HISTORY_SQL)
          .bind(header.classLoanId, queryLimit)
          .all<Row>(),
        db.prepare(METADATA_HISTORY_SQL)
          .bind(header.classLoanId, queryLimit)
          .all<Row>(),
        db.prepare(LEGACY_STATEMENT_CANDIDATES_SQL)
          .bind(header.classLoanId)
          .all<Row>(),
      ]);

    const items = (itemResult.results ?? []).map((row) => projectItem(row, header));
    const transactionHistory = projectTransactionHistory(transactionResult.results ?? []);
    const adjustmentHistory = (adjustmentResult.results ?? []).map(projectAdjustmentHistory);
    const metadataHistory = (metadataResult.results ?? []).map(projectMetadataHistory);
    const allHistory = [
      ...transactionHistory,
      ...adjustmentHistory,
      ...metadataHistory,
    ].sort(compareHistoryNewestFirst);

    return {
      header,
      items,
      history: allHistory.slice(0, historyLimit),
      legacyStatementCandidates: (legacyStatementCandidateResult.results ?? [])
        .map(projectLegacyStatementCandidate),
      historyLimit,
      historyTruncated: allHistory.length > historyLimit
        || transactionHistory.length > historyLimit
        || adjustmentHistory.length > historyLimit
        || metadataHistory.length > historyLimit,
    };
  } catch (error) {
    if (error instanceof ClassLoanManagementError) throw error;
    throw new ClassLoanManagementError(
      "class_loan_management_unavailable",
      "Не вдалося завантажити керування видачею на клас.",
    );
  }
}

function projectLegacyStatementCandidate(row: Row): ClassLoanLegacyStatementCandidate {
  return {
    statementLineId: text(row.statementLineId),
    title: text(row.title) || "Матеріал",
    author: text(row.author),
    publicationYear: nullableYear(row.publicationYear),
    subject: text(row.subject),
    rubric: text(row.rubric),
    quantityIssued: nonNegativeInteger(row.quantityIssued),
  };
}

function projectHeader(
  requestedClassLoanId: string,
  row: Row,
): ClassLoanManagementHeader {
  const canonicalId = text(row.classLoanId);
  return {
    requestedClassLoanId,
    classLoanId: canonicalId,
    aliasResolved: canonicalId !== requestedClassLoanId,
    resolutionDepth: nonNegativeInteger(row.resolutionDepth),
    classYearId: text(row.classYearId),
    className: text(row.className),
    classYearStatus: classYearStatus(row.classYearStatus),
    academicYearId: text(row.academicYearId),
    academicYearLabel: text(row.academicYearLabel),
    cohortId: text(row.cohortId),
    curatorUserId: nullableText(row.curatorUserId),
    curatorName: text(row.curatorName),
    classroomId: nullableText(row.classroomId),
    classroomName: text(row.classroomName),
    responsibleTeacherUserId: text(row.responsibleTeacherUserId),
    responsibleTeacherName: text(row.responsibleTeacherName),
    status: classLoanStatus(row.status),
    issuedAt: text(row.issuedAt),
    dueAt: nullableText(row.dueAt),
    closedAt: nullableText(row.closedAt),
    notes: boundedText(row.notes, 4_000),
    version: positiveInteger(row.version),
    createdAt: text(row.createdAt),
    updatedAt: text(row.updatedAt),
  };
}

function projectItem(
  row: Row,
  header: ClassLoanManagementHeader,
): ClassLoanManagementItem {
  const lifecycleStatus = row.lifecycleStatus === "removed" ? "removed" : "active";
  const quantityIssued = nonNegativeInteger(row.quantityIssued);
  const quantityReturned = Math.min(
    quantityIssued,
    nonNegativeInteger(row.quantityReturned),
  );
  const holdingQuantity = nonNegativeInteger(row.holdingQuantity);
  const reservedQuantity = nonNegativeInteger(row.reservedQuantity);
  const statementLineId = nullableText(row.statementLineId);
  const statementLinked = statementLineId !== null;
  const editable = header.status === "open"
    && header.classYearStatus === "active"
    && statementLinked;
  return {
    classLoanItemId: text(row.classLoanItemId),
    classLoanId: header.classLoanId,
    materialId: text(row.materialId),
    catalogNumber: nonNegativeInteger(row.catalogNumber),
    title: text(row.title),
    author: text(row.author),
    publicationYear: nullableYear(row.publicationYear),
    isbn: text(row.isbn),
    subject: text(row.subject),
    rubric: text(row.rubric),
    thumbnailUrl: materialCoverUrl(row),
    sourceLocationId: text(row.sourceLocationId),
    sourceLocationName: text(row.sourceLocationName),
    sourceLocationType: text(row.sourceLocationType),
    condition: text(row.condition) || "unspecified",
    lifecycleStatus,
    version: positiveInteger(row.itemVersion),
    removedAt: nullableText(row.removedAt),
    removedByUserId: nullableText(row.removedByUserId),
    removedByName: text(row.removedByName),
    removalReason: boundedText(row.removalReason, 2_000),
    quantityIssued,
    quantityReturned,
    quantityOutstanding: lifecycleStatus === "active"
      ? Math.max(0, quantityIssued - quantityReturned)
      : 0,
    effectiveQuantityIssued: lifecycleStatus === "active" ? quantityIssued : 0,
    holdingQuantity,
    reservedQuantity,
    currentAvailableAtSource: Math.max(0, holdingQuantity - reservedQuantity),
    itemIssuedAt: text(row.itemIssuedAt) || header.issuedAt,
    itemCreatedAt: text(row.itemCreatedAt),
    itemUpdatedAt: text(row.itemUpdatedAt),
    statementLinked,
    statementLineId,
    statementLinkOrigin: statementLinkOrigin(row.statementLinkOrigin),
    editable,
    editBlockedReason: editable
      ? null
      : header.status !== "open" || header.classYearStatus !== "active"
        ? "loan_not_open"
        : "statement_item_link_missing",
  };
}

function projectTransactionHistory(rows: Row[]): ClassLoanTransactionHistoryEvent[] {
  const events = new Map<string, ClassLoanTransactionHistoryEvent>();
  for (const row of rows) {
    const transactionId = text(row.transactionId);
    if (!transactionId) continue;
    let event = events.get(transactionId);
    if (!event) {
      event = {
        kind: row.transactionKind === "return" ? "return" : "issue",
        id: `transaction:${transactionId}`,
        transactionId,
        requestId: text(row.requestId),
        occurredAt: text(row.occurredAt),
        createdAt: text(row.transactionCreatedAt),
        actorUserId: text(row.actorUserId),
        actorName: text(row.actorName),
        actorEmail: text(row.actorEmail),
        notes: boundedText(row.notes, 2_000),
        lines: [],
      };
      events.set(transactionId, event);
    }
    const lineId = nullableText(row.lineId);
    if (!lineId) continue;
    event.lines.push({
      lineId,
      classLoanItemId: text(row.classLoanItemId),
      materialId: text(row.materialId),
      title: text(row.materialTitle),
      quantityDelta: integer(row.quantityDelta),
      quantityBefore: nonNegativeInteger(row.quantityBefore),
      quantityAfter: nonNegativeInteger(row.quantityAfter),
      locationId: text(row.locationId),
      locationName: text(row.locationName),
      condition: text(row.condition) || "unspecified",
    });
  }
  return [...events.values()];
}

function projectAdjustmentHistory(row: Row): ClassLoanAdjustmentHistoryEvent {
  const adjustmentId = text(row.adjustmentId);
  return {
    kind: "adjustment",
    id: `adjustment:${adjustmentId}`,
    adjustmentId,
    requestId: text(row.requestId),
    transactionId: nullableText(row.transactionId),
    action: adjustmentAction(row.action),
    occurredAt: text(row.createdAt),
    createdAt: text(row.createdAt),
    actorUserId: text(row.actorUserId),
    actorName: text(row.actorName),
    actorEmail: text(row.actorEmail),
    classLoanItemId: text(row.classLoanItemId),
    statementLineId: nullableText(row.statementLineId),
    materialId: text(row.materialId),
    title: text(row.materialTitle),
    locationId: text(row.locationId),
    locationName: text(row.locationName),
    condition: text(row.condition) || "unspecified",
    quantityBefore: nonNegativeInteger(row.quantityBefore),
    quantityAfter: nonNegativeInteger(row.quantityAfter),
    quantityReturnedSnapshot: nonNegativeInteger(row.quantityReturnedSnapshot),
    stockDelta: integer(row.stockDelta),
    reason: boundedText(row.reason, 2_000),
  };
}

function projectMetadataHistory(row: Row): ClassLoanMetadataHistoryEvent {
  const auditEventId = text(row.auditEventId);
  return {
    kind: "metadata",
    id: `metadata:${auditEventId}`,
    auditEventId,
    requestId: nullableText(row.requestId),
    action: text(row.action),
    occurredAt: text(row.createdAt),
    createdAt: text(row.createdAt),
    actorUserId: text(row.actorUserId),
    actorName: text(row.actorName),
    actorEmail: text(row.actorEmail),
    before: parseJsonObject(row.beforeJson),
    after: parseJsonObject(row.afterJson),
    metadata: parseJsonObject(row.metadataJson),
  };
}

function compareHistoryNewestFirst(
  left: ClassLoanManagementHistoryEvent,
  right: ClassLoanManagementHistoryEvent,
): number {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

function boundedHistoryLimit(value: number | undefined): number {
  if (!Number.isSafeInteger(value)) return DEFAULT_HISTORY_LIMIT;
  return Math.min(MAX_HISTORY_LIMIT, Math.max(1, Number(value)));
}

function classLoanStatus(value: unknown): ClassLoanStatus {
  return value === "closed" || value === "cancelled" ? value : "open";
}

function classYearStatus(value: unknown): "planned" | "active" | "closed" {
  return value === "planned" || value === "closed" ? value : "active";
}

function statementLinkOrigin(value: unknown): ClassLoanStatementLinkOrigin | null {
  return value === "issued" || value === "legacy_exact" || value === "legacy_reviewed"
    ? value
    : null;
}

function adjustmentAction(value: unknown): ClassLoanAdjustmentHistoryEvent["action"] {
  return value === "removed" || value === "restored" ? value : "quantity_changed";
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function boundedText(value: unknown, maximum: number): string {
  return text(value).slice(0, maximum);
}

function nullableText(value: unknown): string | null {
  const result = text(value);
  return result || null;
}

function integer(value: unknown): number {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? Math.trunc(result) : 0;
}

function nonNegativeInteger(value: unknown): number {
  return Math.max(0, integer(value));
}

function positiveInteger(value: unknown): number {
  return Math.max(1, integer(value));
}

function nullableYear(value: unknown): number | null {
  const year = integer(value);
  return year >= 1000 && year <= 3000 ? year : null;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  const source = text(value);
  if (!source) return null;
  try {
    const parsed: unknown = JSON.parse(source);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function materialCoverUrl(row: Row): string {
  const externalUrl = safeExternalImageUrl(row.coverExternalUrl);
  if (externalUrl) return externalUrl;
  if (text(row.coverStorageProvider).toLowerCase() !== "r2") return "";
  const storageKey = safeStorageKey(row.coverStorageKey);
  if (!storageKey) return "";
  const materialId = text(row.materialId);
  const sha256 = text(row.coverSha256);
  const version = /^[0-9a-f]{64}$/iu.test(sha256)
    ? `?v=${sha256.slice(0, 12).toLowerCase()}`
    : "";
  return `/api/catalog-v2/covers/${encodeURIComponent(materialId)}${version}`;
}

function safeExternalImageUrl(value: unknown): string {
  try {
    const url = new URL(text(value));
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : "";
  } catch {
    return "";
  }
}

function safeStorageKey(value: unknown): string {
  const key = text(value);
  if (
    !key
    || key.length > 512
    || key.startsWith("/")
    || key.includes("\\")
    || key.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    return "";
  }
  return key;
}

const HEADER_SQL = `
  WITH RECURSIVE resolved(
    id, merged_into_class_loan_id, depth, path, cycle
  ) AS (
    SELECT id, merged_into_class_loan_id, 0, '|' || id || '|', 0
    FROM class_loans
    WHERE id = ?
    UNION ALL
    SELECT next.id, next.merged_into_class_loan_id, resolved.depth + 1,
      resolved.path || next.id || '|',
      CASE WHEN instr(resolved.path, '|' || next.id || '|') > 0 THEN 1 ELSE 0 END
    FROM class_loans next
    JOIN resolved ON next.id = resolved.merged_into_class_loan_id
    WHERE resolved.merged_into_class_loan_id IS NOT NULL
      AND resolved.depth < 31
      AND resolved.cycle = 0
  ), canonical AS (
    SELECT id, merged_into_class_loan_id, depth
    FROM resolved
    ORDER BY depth DESC
    LIMIT 1
  )
  SELECT
    cl.id AS classLoanId,
    canonical.depth AS resolutionDepth,
    canonical.merged_into_class_loan_id AS canonicalMergedIntoClassLoanId,
    cl.class_year_id AS classYearId,
    cy.class_name AS className,
    cy.status AS classYearStatus,
    cy.academic_year_id AS academicYearId,
    ay.label AS academicYearLabel,
    cy.cohort_id AS cohortId,
    cy.teacher_user_id AS curatorUserId,
    COALESCE(curator.full_name, '') AS curatorName,
    cy.location_id AS classroomId,
    COALESCE(classroom.name, '') AS classroomName,
    cl.responsible_teacher_user_id AS responsibleTeacherUserId,
    teacher.full_name AS responsibleTeacherName,
    cl.status,
    cl.issued_at AS issuedAt,
    cl.due_at AS dueAt,
    cl.closed_at AS closedAt,
    cl.notes,
    cl.version,
    cl.created_at AS createdAt,
    cl.updated_at AS updatedAt
  FROM canonical
  JOIN class_loans cl ON cl.id = canonical.id
  JOIN class_years cy ON cy.id = cl.class_year_id
  JOIN academic_years ay ON ay.id = cy.academic_year_id
  JOIN users teacher ON teacher.id = cl.responsible_teacher_user_id
  LEFT JOIN users curator ON curator.id = cy.teacher_user_id
  LEFT JOIN locations classroom ON classroom.id = cy.location_id
  LIMIT 1`;

const ITEMS_SQL = `
  SELECT
    cli.id AS classLoanItemId,
    cli.class_loan_id AS classLoanId,
    cli.material_id AS materialId,
    m.catalog_number AS catalogNumber,
    m.title,
    m.author,
    m.publication_year AS publicationYear,
    m.isbn_normalized AS isbn,
    m.subject,
    m.rubric,
    cover.storage_provider AS coverStorageProvider,
    cover.storage_key AS coverStorageKey,
    cover.external_url AS coverExternalUrl,
    cover.sha256 AS coverSha256,
    cli.source_location_id AS sourceLocationId,
    location.name AS sourceLocationName,
    location.type AS sourceLocationType,
    cli.condition,
    cli.lifecycle_status AS lifecycleStatus,
    cli.version AS itemVersion,
    cli.removed_at AS removedAt,
    cli.removed_by_user_id AS removedByUserId,
    COALESCE(removed_by.full_name, '') AS removedByName,
    cli.removal_reason AS removalReason,
    cli.quantity_issued AS quantityIssued,
    cli.quantity_returned AS quantityReturned,
    COALESCE(holding.quantity, 0) AS holdingQuantity,
    COALESCE(reservations.quantity, 0) AS reservedQuantity,
    COALESCE((
      SELECT MIN(issue_transaction.occurred_at)
      FROM class_loan_transaction_lines issue_line
      JOIN class_loan_transactions issue_transaction
        ON issue_transaction.id = issue_line.transaction_id
        AND issue_transaction.kind = 'issue'
      WHERE issue_line.class_loan_item_id = cli.id
        AND NOT EXISTS (
          SELECT 1 FROM class_loan_item_adjustments adjustment
          WHERE adjustment.transaction_id = issue_transaction.id
        )
    ), '') AS itemIssuedAt,
    cli.created_at AS itemCreatedAt,
    cli.updated_at AS itemUpdatedAt,
    statement_link.statement_line_id AS statementLineId,
    statement_link.origin AS statementLinkOrigin
  FROM class_loan_items cli
  JOIN materials m ON m.id = cli.material_id
  JOIN locations location ON location.id = cli.source_location_id
  LEFT JOIN users removed_by ON removed_by.id = cli.removed_by_user_id
  LEFT JOIN material_cover_assets cover
    ON cover.material_id = m.id AND cover.status = 'ready'
  LEFT JOIN holdings holding
    ON holding.material_id = cli.material_id
    AND holding.location_id = cli.source_location_id
    AND holding.condition = cli.condition
  LEFT JOIN (
    SELECT material_id, source_location_id, condition,
      SUM(reserved_quantity - issued_quantity - released_quantity) AS quantity
    FROM material_request_reservations
    WHERE reserved_quantity > issued_quantity + released_quantity
    GROUP BY material_id, source_location_id, condition
  ) reservations
    ON reservations.material_id = cli.material_id
    AND reservations.source_location_id = cli.source_location_id
    AND reservations.condition = cli.condition
  LEFT JOIN class_loan_statement_item_links statement_link
    ON statement_link.class_loan_item_id = cli.id
  WHERE cli.class_loan_id = ?
  ORDER BY
    CASE cli.lifecycle_status WHEN 'active' THEN 0 ELSE 1 END,
    cli.created_at,
    cli.id`;

const TRANSACTION_HISTORY_SQL = `
  WITH selected AS (
    SELECT id
    FROM class_loan_transactions transaction_candidate
    WHERE class_loan_id = ? AND kind IN ('issue', 'return')
      AND NOT EXISTS (
        SELECT 1
        FROM class_loan_item_adjustments adjustment
        WHERE adjustment.transaction_id = transaction_candidate.id
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  )
  SELECT
    tx.id AS transactionId,
    tx.request_id AS requestId,
    tx.kind AS transactionKind,
    tx.occurred_at AS occurredAt,
    tx.created_at AS transactionCreatedAt,
    tx.actor_user_id AS actorUserId,
    COALESCE(actor.full_name, '') AS actorName,
    COALESCE(actor.email, '') AS actorEmail,
    tx.notes,
    line.id AS lineId,
    line.class_loan_item_id AS classLoanItemId,
    line.material_id AS materialId,
    COALESCE(material.title, '') AS materialTitle,
    line.quantity_delta AS quantityDelta,
    line.quantity_before AS quantityBefore,
    line.quantity_after AS quantityAfter,
    line.location_id AS locationId,
    COALESCE(location.name, '') AS locationName,
    line.condition
  FROM selected
  JOIN class_loan_transactions tx ON tx.id = selected.id
  LEFT JOIN users actor ON actor.id = tx.actor_user_id
  LEFT JOIN class_loan_transaction_lines line
    ON line.transaction_id = tx.id
  LEFT JOIN materials material ON material.id = line.material_id
  LEFT JOIN locations location ON location.id = line.location_id
  ORDER BY tx.created_at DESC, tx.id DESC, line.created_at, line.id`;

const ADJUSTMENT_HISTORY_SQL = `
  SELECT
    adjustment.id AS adjustmentId,
    adjustment.request_id AS requestId,
    adjustment.transaction_id AS transactionId,
    adjustment.action,
    adjustment.created_at AS createdAt,
    adjustment.actor_user_id AS actorUserId,
    COALESCE(actor.full_name, '') AS actorName,
    COALESCE(actor.email, '') AS actorEmail,
    adjustment.class_loan_item_id AS classLoanItemId,
    adjustment.statement_line_id AS statementLineId,
    item.material_id AS materialId,
    COALESCE(material.title, '') AS materialTitle,
    adjustment.location_id AS locationId,
    COALESCE(location.name, '') AS locationName,
    adjustment.condition,
    adjustment.quantity_before AS quantityBefore,
    adjustment.quantity_after AS quantityAfter,
    adjustment.quantity_returned_snapshot AS quantityReturnedSnapshot,
    adjustment.stock_delta AS stockDelta,
    adjustment.reason
  FROM class_loan_item_adjustments adjustment
  JOIN class_loan_items item ON item.id = adjustment.class_loan_item_id
  LEFT JOIN materials material ON material.id = item.material_id
  LEFT JOIN locations location ON location.id = adjustment.location_id
  LEFT JOIN users actor ON actor.id = adjustment.actor_user_id
  WHERE adjustment.class_loan_id = ?
  ORDER BY adjustment.created_at DESC, adjustment.id DESC
  LIMIT ?`;

const METADATA_HISTORY_SQL = `
  SELECT
    audit.id AS auditEventId,
    audit.request_id AS requestId,
    audit.action,
    audit.created_at AS createdAt,
    audit.actor_user_id AS actorUserId,
    COALESCE(actor.full_name, '') AS actorName,
    COALESCE(audit.actor_email, actor.email, '') AS actorEmail,
    audit.before_json AS beforeJson,
    audit.after_json AS afterJson,
    audit.metadata_json AS metadataJson
  FROM audit_events audit
  LEFT JOIN users actor ON actor.id = audit.actor_user_id
  WHERE audit.entity_type = 'class_loan'
    AND audit.entity_id = ?
    AND audit.action NOT IN (
      'class_loan.issued',
      'class_loan.appended',
      'class_loan.returned',
      'class_loan.item_adjusted',
      'class_loan.item_removed',
      'class_loan.item_restored'
    )
  ORDER BY audit.created_at DESC, audit.id DESC
  LIMIT ?`;

const LEGACY_STATEMENT_CANDIDATES_SQL = `
  SELECT line.id AS statementLineId, line.title, line.author,
    line.publication_year AS publicationYear, line.subject, line.rubric,
    line.quantity_issued AS quantityIssued
  FROM class_loan_statement_lines line
  LEFT JOIN class_loan_statement_item_links linked
    ON linked.statement_line_id = line.id
  WHERE line.class_loan_id = ? AND linked.statement_line_id IS NULL
  ORDER BY line.position, line.created_at, line.id`;
