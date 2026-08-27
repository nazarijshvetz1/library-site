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

  const schemaVersion = integer(row.schemaVersion);
  const origin = text(row.origin);
  if (schemaVersion === 1 && origin === "issued") {
    const parsed = parseSnapshot(text(row.snapshotJson));
    return {
      classLoanId: id,
      ...parsed,
      origin: "issued",
      currentStatus: status(row.currentStatus),
      createdAt: text(row.createdAt),
    };
  }

  let lineRows: Record<string, unknown>[];
  try {
    const result = await db.prepare(LEGACY_LINES_SQL).bind(id).all<Record<string, unknown>>();
    lineRows = result.results ?? [];
  } catch {
    throw new ClassIssueStatementError("statement_unavailable", "Не вдалося відновити давню відомість.");
  }
  return {
    classLoanId: id,
    schemaVersion: 1,
    origin: "legacy_backfill",
    currentStatus: status(row.currentStatus),
    className: text(row.className),
    academicYearLabel: text(row.academicYearLabel),
    classroomName: text(row.classroomName),
    curatorName: text(row.curatorName),
    issuedAt: text(row.issuedAt),
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
    const result = await db.prepare(LIST_SQL).bind(selectedId, selectedId).all<Record<string, unknown>>();
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

function parseSnapshot(value: string): Omit<ClassIssueStatement, "classLoanId" | "origin" | "currentStatus" | "createdAt"> {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.lines)) throw new Error("schema");
    const lines = parsed.lines.map((raw, index) => {
      const line = raw as Record<string, unknown>;
      const title = text(line.title);
      if (!title) throw new Error("title");
      return {
        position: positiveInteger(line.position) || index + 1,
        subject: text(line.subject),
        title,
        author: text(line.author),
        publicationYear: nullableInteger(line.publicationYear),
        rubric: text(line.rubric),
        quantityIssued: positiveInteger(line.quantityIssued),
      };
    });
    return {
      schemaVersion: 1,
      className: text(parsed.className),
      academicYearLabel: text(parsed.academicYearLabel),
      classroomName: text(parsed.classroomName),
      curatorName: text(parsed.curatorName),
      issuedAt: text(parsed.issuedAt),
      dueAt: nullableText(parsed.dueAt),
      lines,
    };
  } catch {
    throw new ClassIssueStatementError("statement_invalid", "Збережена відомість пошкоджена.");
  }
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

function status(value: unknown): ClassIssueStatement["currentStatus"] {
  return value === "closed" || value === "cancelled" ? value : "open";
}

const HEADER_SQL = `
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
  WHERE cl.id = ?
  LIMIT 1`;

const LEGACY_LINES_SQL = `
  SELECT m.subject AS subject, m.title AS title, m.author AS author,
    m.publication_year AS publicationYear, m.rubric AS rubric,
    cli.quantity_issued AS quantityIssued
  FROM class_loan_items cli
  JOIN materials m ON m.id = cli.material_id
  WHERE cli.class_loan_id = ?
  ORDER BY cli.created_at, cli.id`;

const LIST_SQL = `
  SELECT cl.id AS classLoanId, cl.class_year_id AS classYearId,
    cy.class_name AS className, ay.label AS academicYearLabel,
    cl.issued_at AS issuedAt, cl.due_at AS dueAt, cl.status AS currentStatus,
    cl.issue_statement_schema_version AS schemaVersion, cl.issue_statement_origin AS origin,
    COUNT(cli.id) AS positionCount, COALESCE(SUM(cli.quantity_issued), 0) AS copyCount
  FROM class_loans cl
  JOIN class_years cy ON cy.id = cl.class_year_id
  JOIN academic_years ay ON ay.id = cy.academic_year_id
  LEFT JOIN class_loan_items cli ON cli.class_loan_id = cl.id
  WHERE (? = '' OR cl.class_year_id = ?)
  GROUP BY cl.id, cl.class_year_id, cy.class_name, ay.label, cl.issued_at,
    cl.due_at, cl.status, cl.issue_statement_schema_version, cl.issue_statement_origin,
    cl.created_at
  ORDER BY cl.issued_at DESC, cl.created_at DESC, cl.id DESC
  LIMIT 500`;
