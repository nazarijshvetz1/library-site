type D1Value = string | number | null;

export type ClassIssueStatementStatement = {
  bind(...values: D1Value[]): ClassIssueStatementStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
};

export type ClassIssueStatementDatabase = {
  prepare(sql: string): ClassIssueStatementStatement;
};

export type ClassIssueStatementLine = {
  position: number;
  subject: string;
  title: string;
  author: string;
  publicationYear: number | null;
  rubric: string;
  quantityIssued: number;
};

export type ClassIssueStatement = {
  classLoanId: string;
  schemaVersion: 1;
  origin: "issued" | "legacy_backfill";
  currentStatus: "open" | "closed" | "cancelled";
  className: string;
  academicYearLabel: string;
  classroomName: string;
  curatorName: string;
  issuedAt: string;
  dueAt: string | null;
  createdAt: string;
  lines: ClassIssueStatementLine[];
};

export type ClassIssueStatementSummary = {
  classLoanId: string;
  classYearId: string;
  className: string;
  academicYearLabel: string;
  issuedAt: string;
  dueAt: string | null;
  currentStatus: "open" | "closed" | "cancelled";
  origin: "issued" | "legacy_backfill";
  positionCount: number;
  copyCount: number;
};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export class ClassIssueStatementError extends Error {
  readonly code: "statement_not_found" | "statement_invalid" | "statement_unavailable";

  constructor(code: ClassIssueStatementError["code"], message: string) {
    super(message);
    this.name = "ClassIssueStatementError";
    this.code = code;
  }
}

export async function readClassIssueStatement(
  db: ClassIssueStatementDatabase,
  classLoanId: string,
): Promise<ClassIssueStatement> {
  const id = classLoanId.trim();
  if (!IDENTIFIER.test(id)) {
    throw new ClassIssueStatementError("statement_not_found", "Відомість не знайдено.");
  }

  let row: Record<string, unknown> | null;
  try {
    row = await db.prepare(HEADER_SQL).bind(id).first<Record<string, unknown>>();
  } catch {
    throw new ClassIssueStatementError("statement_unavailable", "Не вдалося прочитати відомість.");
  }
  if (!row) {
    throw new ClassIssueStatementError("statement_not_found", "Відомість не знайдено.");
  }

  const snapshotHeader = integer(row.schemaVersion) === 1
    ? parseSnapshotHeader(text(row.snapshotJson))
    : null;
  const managementProjection = await hasManagementProjection(db);

  let lineRows: Record<string, unknown>[];
  try {
    const result = await db.prepare(
      managementProjection ? STATEMENT_LINES_SQL : PRE_MANAGEMENT_STATEMENT_LINES_SQL,
    )
      .bind(text(row.classLoanId))
      .all<Record<string, unknown>>();
    lineRows = result.results ?? [];
  } catch {
    throw new ClassIssueStatementError("statement_unavailable", "Не вдалося прочитати позиції відомості.");
  }
  let resolvedOrigin: ClassIssueStatement["origin"] = (
    integer(row.schemaVersion) === 1 && text(row.origin) === "issued"
  ) ? "issued" : "legacy_backfill";
  if (!lineRows.length) {
    try {
      const result = await db.prepare(
        managementProjection ? LEGACY_LINES_SQL : PRE_MANAGEMENT_LEGACY_LINES_SQL,
      )
        .bind(text(row.classLoanId))
        .all<Record<string, unknown>>();
      lineRows = result.results ?? [];
      resolvedOrigin = "legacy_backfill";
    } catch {
      throw new ClassIssueStatementError("statement_unavailable", "Не вдалося відновити давню відомість.");
    }
  }
  return {
    classLoanId: text(row.classLoanId),
    schemaVersion: 1,
    origin: resolvedOrigin,
    currentStatus: status(row.currentStatus),
    className: snapshotHeader?.className ?? text(row.className),
    academicYearLabel: snapshotHeader?.academicYearLabel ?? text(row.academicYearLabel),
    classroomName: snapshotHeader?.classroomName ?? text(row.classroomName),
    curatorName: snapshotHeader?.curatorName ?? text(row.curatorName),
    issuedAt: snapshotHeader?.issuedAt ?? text(row.issuedAt),
    dueAt: nullableText(row.dueAt),
    createdAt: text(row.createdAt),
    lines: lineRows.map((line, index) => ({
      position: index + 1,
      subject: text(line.subject),
      title: text(line.title),
      author: text(line.author),
      publicationYear: nullableInteger(line.publicationYear),
      rubric: text(line.rubric),
      quantityIssued: positiveInteger(line.quantityIssued),
    })),
  };
}

export async function listClassIssueStatements(
  db: ClassIssueStatementDatabase,
  classYearId: string | null = null,
): Promise<ClassIssueStatementSummary[]> {
  const selectedId = classYearId?.trim() ?? "";
  if (selectedId && !IDENTIFIER.test(selectedId)) {
    throw new ClassIssueStatementError("statement_not_found", "Клас не знайдено.");
  }
  try {
    const managementProjection = await hasManagementProjection(db);
    const result = await db.prepare(
      managementProjection ? LIST_SQL : PRE_MANAGEMENT_LIST_SQL,
    ).bind(selectedId, selectedId).all<Record<string, unknown>>();
    return (result.results ?? []).map((row) => ({
      classLoanId: text(row.classLoanId),
      classYearId: text(row.classYearId),
      className: text(row.className),
      academicYearLabel: text(row.academicYearLabel),
      issuedAt: text(row.issuedAt),
      dueAt: nullableText(row.dueAt),
      currentStatus: status(row.currentStatus),
      origin: integer(row.schemaVersion) === 1 && text(row.origin) === "issued" ? "issued" : "legacy_backfill",
      positionCount: integer(row.positionCount),
      copyCount: integer(row.copyCount),
    }));
  } catch {
    throw new ClassIssueStatementError("statement_unavailable", "Не вдалося завантажити історію відомостей.");
  }
}

async function hasManagementProjection(db: ClassIssueStatementDatabase): Promise<boolean> {
  let row: Record<string, unknown> | null;
  try {
    row = await db.prepare(`
      SELECT
        EXISTS(
          SELECT 1 FROM sqlite_master
          WHERE type = 'table' AND name = 'class_loan_statement_item_links'
        ) AS hasLinks,
        EXISTS(
          SELECT 1 FROM pragma_table_info('class_loan_items')
          WHERE name = 'lifecycle_status'
        ) AS hasLifecycle
    `).first<Record<string, unknown>>();
  } catch {
    throw new ClassIssueStatementError(
      "statement_unavailable",
      "Не вдалося визначити версію відомості.",
    );
  }
  const hasLinks = integer(row?.hasLinks) === 1;
  const hasLifecycle = integer(row?.hasLifecycle) === 1;
  if (hasLinks !== hasLifecycle) {
    throw new ClassIssueStatementError(
      "statement_unavailable",
      "Оновлення схеми відомості не завершено.",
    );
  }
  return hasLinks;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function nullableText(value: unknown): string | null {
  const valueText = text(value);
  return valueText || null;
}

function integer(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function positiveInteger(value: unknown): number {
  return Math.max(0, integer(value));
}

function nullableInteger(value: unknown): number | null {
  return value == null || value === "" ? null : integer(value);
}

function parseSnapshotHeader(value: string): Pick<
  ClassIssueStatement,
  "className" | "academicYearLabel" | "classroomName" | "curatorName" | "issuedAt" | "dueAt"
> {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.lines)) throw new Error("schema");
    return {
      className: text(parsed.className),
      academicYearLabel: text(parsed.academicYearLabel),
      classroomName: text(parsed.classroomName),
      curatorName: text(parsed.curatorName),
      issuedAt: text(parsed.issuedAt),
      dueAt: nullableText(parsed.dueAt),
    };
  } catch {
    throw new ClassIssueStatementError("statement_invalid", "Збережена відомість пошкоджена.");
  }
}

function status(value: unknown): ClassIssueStatement["currentStatus"] {
  return value === "closed" || value === "cancelled" ? value : "open";
}

const HEADER_SQL = `
  WITH RECURSIVE resolved(id, merged_into_class_loan_id, depth) AS (
    SELECT id, merged_into_class_loan_id, 0
    FROM class_loans
    WHERE id = ?
    UNION ALL
    SELECT next.id, next.merged_into_class_loan_id, resolved.depth + 1
    FROM class_loans next
    JOIN resolved ON next.id = resolved.merged_into_class_loan_id
    WHERE resolved.merged_into_class_loan_id IS NOT NULL AND resolved.depth < 31
  ), canonical AS (
    SELECT id
    FROM resolved
    ORDER BY depth DESC
    LIMIT 1
  )
  SELECT cl.id AS classLoanId, cl.status AS currentStatus, cl.issued_at AS issuedAt,
    cl.due_at AS dueAt, cl.created_at AS createdAt,
    cl.issue_statement_schema_version AS schemaVersion,
    cl.issue_statement_json AS snapshotJson, cl.issue_statement_origin AS origin,
    cy.class_name AS className, ay.label AS academicYearLabel,
    COALESCE(classroom.name, '') AS classroomName,
    COALESCE(curator.full_name, '') AS curatorName
  FROM class_loans cl
  JOIN class_years cy ON cy.id = cl.class_year_id
  JOIN academic_years ay ON ay.id = cy.academic_year_id
  LEFT JOIN locations classroom ON classroom.id = cy.location_id
  LEFT JOIN users curator ON curator.id = cy.teacher_user_id
  WHERE cl.id = (SELECT id FROM canonical)
  LIMIT 1`;

const STATEMENT_LINES_SQL = `
  SELECT trim(statement.subject) AS subject, trim(statement.title) AS title,
    trim(statement.author) AS author,
    statement.publication_year AS publicationYear,
    trim(statement.rubric) AS rubric,
    SUM(
      CASE
        WHEN link.statement_line_id IS NULL THEN statement.quantity_issued
        WHEN item.lifecycle_status = 'active' THEN item.quantity_issued
        ELSE 0
      END
    ) AS quantityIssued,
    MIN(statement.created_at) AS firstCreatedAt,
    MIN(statement.position) AS firstPosition,
    MIN(statement.id) AS firstId
  FROM class_loan_statement_lines statement
  LEFT JOIN class_loan_statement_item_links link
    ON link.statement_line_id = statement.id
  LEFT JOIN class_loan_items item ON item.id = link.class_loan_item_id
  WHERE statement.class_loan_id = ?
  GROUP BY trim(statement.subject), trim(statement.title), trim(statement.author),
    statement.publication_year, trim(statement.rubric)
  HAVING quantityIssued > 0
  ORDER BY firstCreatedAt, firstPosition, firstId`;

const PRE_MANAGEMENT_STATEMENT_LINES_SQL = `
  SELECT trim(subject) AS subject, trim(title) AS title, trim(author) AS author,
    publication_year AS publicationYear, trim(rubric) AS rubric,
    SUM(quantity_issued) AS quantityIssued,
    MIN(created_at) AS firstCreatedAt, MIN(position) AS firstPosition,
    MIN(id) AS firstId
  FROM class_loan_statement_lines
  WHERE class_loan_id = ?
  GROUP BY trim(subject), trim(title), trim(author), publication_year, trim(rubric)
  ORDER BY firstCreatedAt, firstPosition, firstId`;

const LEGACY_LINES_SQL = `
  SELECT trim(m.subject) AS subject, trim(m.title) AS title, trim(m.author) AS author,
    m.publication_year AS publicationYear, trim(m.rubric) AS rubric,
    SUM(cli.quantity_issued) AS quantityIssued,
    MIN(cli.created_at) AS firstCreatedAt, MIN(cli.id) AS firstId
  FROM class_loan_items cli
  JOIN materials m ON m.id = cli.material_id
  WHERE cli.class_loan_id = ? AND cli.lifecycle_status = 'active'
  GROUP BY trim(m.subject), trim(m.title), trim(m.author), m.publication_year, trim(m.rubric)
  ORDER BY firstCreatedAt, firstId`;

const PRE_MANAGEMENT_LEGACY_LINES_SQL = `
  SELECT trim(m.subject) AS subject, trim(m.title) AS title, trim(m.author) AS author,
    m.publication_year AS publicationYear, trim(m.rubric) AS rubric,
    SUM(cli.quantity_issued) AS quantityIssued,
    MIN(cli.created_at) AS firstCreatedAt, MIN(cli.id) AS firstId
  FROM class_loan_items cli
  JOIN materials m ON m.id = cli.material_id
  WHERE cli.class_loan_id = ?
  GROUP BY trim(m.subject), trim(m.title), trim(m.author), m.publication_year, trim(m.rubric)
  ORDER BY firstCreatedAt, firstId`;

const LIST_SQL = `
  WITH statement_bibliography AS (
    SELECT statement.class_loan_id,
      trim(statement.subject) AS subject, trim(statement.title) AS title,
      trim(statement.author) AS author, statement.publication_year,
      trim(statement.rubric) AS rubric,
      SUM(
        CASE
          WHEN link.statement_line_id IS NULL THEN statement.quantity_issued
          WHEN item.lifecycle_status = 'active' THEN item.quantity_issued
          ELSE 0
        END
      ) AS quantityIssued
    FROM class_loan_statement_lines statement
    LEFT JOIN class_loan_statement_item_links link
      ON link.statement_line_id = statement.id
    LEFT JOIN class_loan_items item ON item.id = link.class_loan_item_id
    GROUP BY statement.class_loan_id, trim(statement.subject), trim(statement.title),
      trim(statement.author), statement.publication_year, trim(statement.rubric)
    HAVING quantityIssued > 0
  ), statement_counts AS (
    SELECT class_loan_id, COUNT(*) AS positionCount,
      COALESCE(SUM(quantityIssued), 0) AS copyCount
    FROM statement_bibliography
    GROUP BY class_loan_id
  ), legacy_bibliography AS (
    SELECT cli.class_loan_id, trim(m.subject) AS subject, trim(m.title) AS title,
      trim(m.author) AS author, m.publication_year, trim(m.rubric) AS rubric,
      SUM(cli.quantity_issued) AS quantityIssued
    FROM class_loan_items cli
    JOIN materials m ON m.id = cli.material_id
    WHERE cli.lifecycle_status = 'active'
    GROUP BY cli.class_loan_id, trim(m.subject), trim(m.title), trim(m.author),
      m.publication_year, trim(m.rubric)
  ), legacy_counts AS (
    SELECT class_loan_id, COUNT(*) AS positionCount,
      COALESCE(SUM(quantityIssued), 0) AS copyCount
    FROM legacy_bibliography
    GROUP BY class_loan_id
  )
  SELECT cl.id AS classLoanId, cl.class_year_id AS classYearId,
    cy.class_name AS className, ay.label AS academicYearLabel,
    cl.issued_at AS issuedAt, cl.due_at AS dueAt, cl.status AS currentStatus,
    cl.issue_statement_schema_version AS schemaVersion, cl.issue_statement_origin AS origin,
    CASE WHEN COALESCE(statement_counts.positionCount, 0) > 0
      THEN statement_counts.positionCount ELSE COALESCE(legacy_counts.positionCount, 0) END AS positionCount,
    CASE WHEN COALESCE(statement_counts.positionCount, 0) > 0
      THEN statement_counts.copyCount ELSE COALESCE(legacy_counts.copyCount, 0) END AS copyCount
  FROM class_loans cl
  JOIN class_years cy ON cy.id = cl.class_year_id
  JOIN academic_years ay ON ay.id = cy.academic_year_id
  LEFT JOIN statement_counts ON statement_counts.class_loan_id = cl.id
  LEFT JOIN legacy_counts ON legacy_counts.class_loan_id = cl.id
  WHERE cl.merged_into_class_loan_id IS NULL
    AND (? = '' OR cl.class_year_id = ?)
  ORDER BY cl.issued_at DESC, cl.created_at DESC, cl.id DESC
  LIMIT 500`;

const PRE_MANAGEMENT_LIST_SQL = `
  WITH statement_bibliography AS (
    SELECT class_loan_id, trim(subject) AS subject, trim(title) AS title,
      trim(author) AS author, publication_year, trim(rubric) AS rubric,
      SUM(quantity_issued) AS quantityIssued
    FROM class_loan_statement_lines
    GROUP BY class_loan_id, trim(subject), trim(title), trim(author),
      publication_year, trim(rubric)
  ), statement_counts AS (
    SELECT class_loan_id, COUNT(*) AS positionCount,
      COALESCE(SUM(quantityIssued), 0) AS copyCount
    FROM statement_bibliography
    GROUP BY class_loan_id
  ), legacy_bibliography AS (
    SELECT cli.class_loan_id, trim(m.subject) AS subject, trim(m.title) AS title,
      trim(m.author) AS author, m.publication_year, trim(m.rubric) AS rubric,
      SUM(cli.quantity_issued) AS quantityIssued
    FROM class_loan_items cli
    JOIN materials m ON m.id = cli.material_id
    GROUP BY cli.class_loan_id, trim(m.subject), trim(m.title), trim(m.author),
      m.publication_year, trim(m.rubric)
  ), legacy_counts AS (
    SELECT class_loan_id, COUNT(*) AS positionCount,
      COALESCE(SUM(quantityIssued), 0) AS copyCount
    FROM legacy_bibliography
    GROUP BY class_loan_id
  )
  SELECT cl.id AS classLoanId, cl.class_year_id AS classYearId,
    cy.class_name AS className, ay.label AS academicYearLabel,
    cl.issued_at AS issuedAt, cl.due_at AS dueAt, cl.status AS currentStatus,
    cl.issue_statement_schema_version AS schemaVersion,
    cl.issue_statement_origin AS origin,
    CASE WHEN COALESCE(statement_counts.positionCount, 0) > 0
      THEN statement_counts.positionCount
      ELSE COALESCE(legacy_counts.positionCount, 0) END AS positionCount,
    CASE WHEN COALESCE(statement_counts.positionCount, 0) > 0
      THEN statement_counts.copyCount
      ELSE COALESCE(legacy_counts.copyCount, 0) END AS copyCount
  FROM class_loans cl
  JOIN class_years cy ON cy.id = cl.class_year_id
  JOIN academic_years ay ON ay.id = cy.academic_year_id
  LEFT JOIN statement_counts ON statement_counts.class_loan_id = cl.id
  LEFT JOIN legacy_counts ON legacy_counts.class_loan_id = cl.id
  WHERE cl.merged_into_class_loan_id IS NULL
    AND (? = '' OR cl.class_year_id = ?)
  ORDER BY cl.issued_at DESC, cl.created_at DESC, cl.id DESC
  LIMIT 500`;
