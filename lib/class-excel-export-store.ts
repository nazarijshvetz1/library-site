type D1Value = string | number | null;

export type ClassExcelExportResult<T = Record<string, unknown>> = {
  success?: boolean;
  results?: T[];
};

export type ClassExcelExportStatement = {
  bind(...values: D1Value[]): ClassExcelExportStatement;
  all<T = Record<string, unknown>>(): Promise<ClassExcelExportResult<T>>;
};

export type ClassExcelExportDatabase = {
  prepare(sql: string): ClassExcelExportStatement;
  batch<T = Record<string, unknown>>(
    statements: ClassExcelExportStatement[],
  ): Promise<Array<ClassExcelExportResult<T>>>;
};

export type ClassExportOption = {
  id: string;
  academicYear: string;
  className: string;
  teacherName: string;
  locationName: string;
  remainingQuantity: number;
};

export type ClassExportLine = {
  subject: string;
  title: string;
  author: string;
  publicationYear: number | null;
  rubric: string;
  publicationType: string;
  issuedAt: string;
  remainingQuantity: number;
};

export type ClassExportDocument = ClassExportOption & {
  lines: ClassExportLine[];
};

export type ClassExportSnapshot = {
  generatedAt: string;
  classes: ClassExportDocument[];
};

const MAX_CLASSES = 100;
const MAX_LINES = 20_000;
const CLASS_YEAR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export class ClassExcelExportError extends Error {
  readonly code: "class_not_found" | "export_too_large" | "export_unavailable";

  constructor(
    code: "class_not_found" | "export_too_large" | "export_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "ClassExcelExportError";
    this.code = code;
  }
}

export async function readClassExportSnapshot(
  db: ClassExcelExportDatabase,
  classYearId: string | null = null,
  generatedAt = new Date().toISOString(),
): Promise<ClassExportSnapshot> {
  const selectedId = classYearId?.trim() ?? "";
  if (selectedId && !CLASS_YEAR_ID.test(selectedId)) {
    throw new ClassExcelExportError("class_not_found", "Обраний клас не знайдено.");
  }

  let results: Array<ClassExcelExportResult<Record<string, unknown>>>;
  try {
    results = await db.batch<Record<string, unknown>>([
      db.prepare(CLASSES_SQL).bind(selectedId, selectedId, MAX_CLASSES + 1),
      db.prepare(LINES_SQL).bind(selectedId, selectedId, MAX_LINES + 1),
    ]);
  } catch {
    throw new ClassExcelExportError(
      "export_unavailable",
      "Не вдалося прочитати видачі класам для Excel-експорту.",
    );
  }

  if (results.length !== 2) {
    throw new ClassExcelExportError(
      "export_unavailable",
      "Отримано неповний набір даних для експорту класів.",
    );
  }
  const classRows = results[0].results ?? [];
  const lineRows = results[1].results ?? [];
  if (classRows.length > MAX_CLASSES || lineRows.length > MAX_LINES) {
    throw new ClassExcelExportError(
      "export_too_large",
      "Даних по класах забагато для безпечного експорту одним завантаженням.",
    );
  }
  if (selectedId && classRows.length === 0) {
    throw new ClassExcelExportError("class_not_found", "Обраний активний клас не знайдено.");
  }

  const classes = classRows.map(classRow);
  const documents = new Map(classes.map((item) => [item.id, { ...item, lines: [] as ClassExportLine[] }]));
  for (const row of lineRows) {
    const classYear = documents.get(text(row.classYearId));
    if (!classYear) continue;
    classYear.lines.push(lineRow(row));
  }

  return { generatedAt, classes: [...documents.values()] };
}

function classRow(row: Record<string, unknown>): ClassExportOption {
  return {
    id: text(row.id),
    academicYear: text(row.academicYear),
    className: text(row.className),
    teacherName: text(row.teacherName) || "Не призначено",
    locationName: text(row.locationName) || "Не призначено",
    remainingQuantity: integer(row.remainingQuantity),
  };
}

function lineRow(row: Record<string, unknown>): ClassExportLine {
  return {
    subject: text(row.subject) || "Не вказано",
    title: text(row.title),
    author: text(row.author),
    publicationYear: nullableInteger(row.publicationYear),
    rubric: text(row.rubric) || "Не вказано",
    publicationType: text(row.publicationType),
    issuedAt: text(row.issuedAt),
    remainingQuantity: integer(row.remainingQuantity),
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function integer(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function nullableInteger(value: unknown): number | null {
  return value == null || value === "" ? null : integer(value);
}

const CLASSES_SQL = `
  SELECT cy.id AS id, ay.label AS academicYear, cy.class_name AS className,
    COALESCE(teacher.full_name, '') AS teacherName,
    COALESCE(location.name, '') AS locationName,
    COALESCE(SUM(CASE WHEN cl.status = 'open'
      THEN MAX(cli.quantity_issued - cli.quantity_returned, 0) ELSE 0 END), 0) AS remainingQuantity
  FROM class_years cy
  JOIN academic_years ay ON ay.id = cy.academic_year_id
  LEFT JOIN users teacher ON teacher.id = cy.teacher_user_id
  LEFT JOIN locations location ON location.id = cy.location_id
  LEFT JOIN class_loans cl ON cl.class_year_id = cy.id
  LEFT JOIN class_loan_items cli ON cli.class_loan_id = cl.id
  WHERE cy.status = 'active' AND ay.status = 'active'
    AND (? = '' OR cy.id = ?)
  GROUP BY cy.id, ay.label, cy.class_name, teacher.full_name, location.name, cy.grade, cy.code
  ORDER BY cy.grade, cy.code, cy.class_name, cy.id
  LIMIT ?`;

const LINES_SQL = `
  SELECT cl.class_year_id AS classYearId, m.subject AS subject, m.title AS title,
    m.author AS author, m.publication_year AS publicationYear, m.rubric AS rubric,
    m.publication_type AS publicationType, substr(cl.issued_at, 1, 10) AS issuedAt,
    SUM(cli.quantity_issued - cli.quantity_returned) AS remainingQuantity
  FROM class_loans cl
  JOIN class_loan_items cli ON cli.class_loan_id = cl.id
  JOIN class_years cy ON cy.id = cl.class_year_id
  JOIN academic_years ay ON ay.id = cy.academic_year_id
  JOIN materials m ON m.id = cli.material_id
  WHERE cl.status = 'open' AND cy.status = 'active' AND ay.status = 'active'
    AND cli.quantity_issued > cli.quantity_returned
    AND (? = '' OR cl.class_year_id = ?)
  GROUP BY cl.class_year_id, m.subject, m.title, m.author, m.publication_year,
    m.rubric, m.publication_type, substr(cl.issued_at, 1, 10), m.sort_title, m.id
  ORDER BY cl.class_year_id, m.subject, m.sort_title, m.title, cl.issued_at, m.id
  LIMIT ?`;
