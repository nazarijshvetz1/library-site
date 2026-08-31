import type { CatalogD1Database } from "@/lib/catalog-d1";

export type LibraryTeacher = {
  id: string;
  fullName: string;
};

export type LibraryLocation = {
  id: string;
  name: string;
  type: string;
  isPublic: boolean;
};

export type OpenLoanItem = {
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

export type OpenLoan = {
  loanId: string;
  teacherUserId: string;
  teacherName: string;
  issuedAt: string;
  dueAt: string | null;
  notes: string;
  version: number;
  items: OpenLoanItem[];
};

export type OpenClassLoanItem = {
  classLoanItemId: string;
  materialId: string;
  materialTitle: string;
  materialAuthor: string;
  materialYear: number | null;
  sourceLocationId: string;
  sourceLocationName: string;
  condition: string;
  quantityIssued: number;
  quantityReturned: number;
  quantityOutstanding: number;
};

export type OpenClassLoan = {
  classLoanId: string;
  classYearId: string;
  className: string;
  academicYearId: string;
  academicYearLabel: string;
  cohortId: string;
  curatorUserId: string | null;
  responsibleTeacherUserId: string;
  responsibleTeacherName: string;
  status: "open";
  issuedAt: string;
  dueAt: string | null;
  notes: string;
  version: number;
  items: OpenClassLoanItem[];
};

type DirectoryRow = Record<string, unknown>;

export async function readLibraryReferenceData(
  db: CatalogD1Database,
): Promise<{ teachers: LibraryTeacher[]; locations: LibraryLocation[] }> {
  const [teacherResult, locationResult] = await Promise.all([
    db.prepare(`
      SELECT u.id, u.full_name
      FROM users u
      JOIN teacher_profiles tp ON tp.teacher_user_id = u.id AND tp.closed_at IS NULL
      WHERE u.status = 'active'
      ORDER BY u.sort_name ASC, u.id ASC
      LIMIT 1000
    `).all(),
    db.prepare(`
      SELECT id, name, type, is_public
      FROM locations
      WHERE status = 'active'
      ORDER BY sort_order ASC, name ASC, id ASC
      LIMIT 1000
    `).all(),
  ]);
  return {
    teachers: (teacherResult.results ?? []).map((row) => ({
      id: boundedText((row as DirectoryRow).id, 64),
      fullName: boundedText((row as DirectoryRow).full_name, 300),
    })).filter((row) => row.id && row.fullName),
    locations: (locationResult.results ?? []).map((row) => ({
      id: boundedText((row as DirectoryRow).id, 64),
      name: boundedText((row as DirectoryRow).name, 240),
      type: boundedText((row as DirectoryRow).type, 80),
      isPublic: Number((row as DirectoryRow).is_public) === 1,
    })).filter((row) => row.id && row.name),
  };
}

export async function listOpenLoans(
  db: CatalogD1Database,
  options: { teacherUserId?: string; limit?: number } = {},
): Promise<OpenLoan[]> {
  const teacherUserId = boundedText(options.teacherUserId, 64);
  const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 100)));
  const bindings: Array<string | number> = [];
  const teacherFilter = teacherUserId ? "AND teacher_user_id = ?" : "";
  if (teacherUserId) bindings.push(teacherUserId);
  bindings.push(limit);
  const result = await db.prepare(`
    SELECT
      l.id AS loan_id,
      l.teacher_user_id,
      u.full_name AS teacher_name,
      l.issued_at,
      l.due_at,
      l.notes,
      l.version,
      li.id AS loan_item_id,
      li.material_id,
      m.catalog_number AS material_catalog_number,
      m.title AS material_title,
      m.author AS material_author,
      m.publication_year AS material_year,
      m.isbn_normalized AS material_isbn,
      c.storage_provider AS cover_storage_provider,
      c.storage_key AS cover_storage_key,
      c.external_url AS cover_external_url,
      c.sha256 AS cover_sha256,
      li.source_location_id,
      loc.name AS source_location_name,
      li.condition,
      li.quantity_issued,
      li.quantity_returned
    FROM (
      SELECT id
      FROM loans
      WHERE status = 'open'
      ${teacherFilter}
      ORDER BY COALESCE(due_at, '9999-12-31') ASC, issued_at ASC, id ASC
      LIMIT ?
    ) selected
    JOIN loans l ON l.id = selected.id
    JOIN users u ON u.id = l.teacher_user_id
    JOIN loan_items li ON li.loan_id = l.id
    JOIN materials m ON m.id = li.material_id
    LEFT JOIN material_cover_assets c ON c.material_id = m.id AND c.status = 'ready'
    JOIN locations loc ON loc.id = li.source_location_id
    WHERE li.quantity_returned < li.quantity_issued
    ORDER BY l.issued_at DESC, COALESCE(l.due_at, '9999-12-31') ASC,
      l.id ASC, li.created_at ASC, li.id ASC
  `).bind(...bindings).all();

  const loans = new Map<string, OpenLoan>();
  for (const rawRow of result.results ?? []) {
    const row = rawRow as DirectoryRow;
    const loanId = boundedText(row.loan_id, 64);
    const loanItemId = boundedText(row.loan_item_id, 64);
    const materialId = boundedText(row.material_id, 64);
    if (!loanId || !loanItemId || !materialId) continue;
    let loan = loans.get(loanId);
    if (!loan) {
      loan = {
        loanId,
        teacherUserId: boundedText(row.teacher_user_id, 64),
        teacherName: boundedText(row.teacher_name, 300),
        issuedAt: boundedText(row.issued_at, 40),
        dueAt: boundedText(row.due_at, 40) || null,
        notes: boundedText(row.notes, 4_000),
        version: positiveInteger(row.version),
        items: [],
      };
      loans.set(loanId, loan);
    }
    const issued = nonNegativeInteger(row.quantity_issued);
    const returned = Math.min(issued, nonNegativeInteger(row.quantity_returned));
    loan.items.push({
      loanItemId,
      materialId,
      materialCatalogNumber: nonNegativeInteger(row.material_catalog_number),
      materialTitle: boundedText(row.material_title, 500),
      materialAuthor: boundedText(row.material_author, 500),
      materialYear: nullableYear(row.material_year),
      materialIsbn: boundedText(row.material_isbn, 40),
      coverUrl: materialCoverUrl(row, materialId),
      sourceLocationId: boundedText(row.source_location_id, 64),
      sourceLocationName: boundedText(row.source_location_name, 240),
      condition: boundedText(row.condition, 80) || "unspecified",
      quantityIssued: issued,
      quantityReturned: returned,
      quantityOutstanding: issued - returned,
    });
  }
  return [...loans.values()];
}

export async function listOpenClassLoans(
  db: CatalogD1Database,
  options: { classYearId?: string; teacherUserId?: string; limit?: number } = {},
): Promise<OpenClassLoan[]> {
  const classYearId = boundedText(options.classYearId, 128);
  const teacherUserId = boundedText(options.teacherUserId, 64);
  const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 100)));
  const bindings: Array<string | number> = [];
  const classFilter = classYearId ? "AND class_year_id = ?" : "";
  const teacherFilter = teacherUserId
    ? "AND (responsible_teacher_user_id = ? OR EXISTS (SELECT 1 FROM class_years curator WHERE curator.id = class_year_id AND curator.teacher_user_id = ?))"
    : "";
  if (classYearId) bindings.push(classYearId);
  if (teacherUserId) bindings.push(teacherUserId, teacherUserId);
  bindings.push(limit);
  const result = await db.prepare(`
    SELECT
      cl.id AS class_loan_id,
      cl.class_year_id,
      cy.class_name,
      cy.academic_year_id,
      ay.label AS academic_year_label,
      cy.cohort_id,
      cy.teacher_user_id AS curator_user_id,
      cl.responsible_teacher_user_id,
      teacher.full_name AS responsible_teacher_name,
      cl.status,
      cl.issued_at,
      cl.due_at,
      cl.notes,
      cl.version,
      cli.id AS class_loan_item_id,
      cli.material_id,
      m.title AS material_title,
      m.author AS material_author,
      m.publication_year AS material_year,
      cli.source_location_id,
      loc.name AS source_location_name,
      cli.condition,
      cli.quantity_issued,
      cli.quantity_returned
    FROM (
      SELECT id
      FROM class_loans
      WHERE status = 'open'
      ${classFilter}
      ${teacherFilter}
      ORDER BY COALESCE(due_at, '9999-12-31') ASC, issued_at ASC, id ASC
      LIMIT ?
    ) selected
    JOIN class_loans cl ON cl.id = selected.id
    JOIN class_years cy ON cy.id = cl.class_year_id
    JOIN academic_years ay ON ay.id = cy.academic_year_id
    JOIN users teacher ON teacher.id = cl.responsible_teacher_user_id
    JOIN class_loan_items cli ON cli.class_loan_id = cl.id
    JOIN materials m ON m.id = cli.material_id
    JOIN locations loc ON loc.id = cli.source_location_id
    WHERE cli.quantity_returned < cli.quantity_issued
    ORDER BY COALESCE(cl.due_at, '9999-12-31') ASC, cl.issued_at ASC,
      cl.id ASC, cli.created_at ASC, cli.id ASC
  `).bind(...bindings).all();

  const loans = new Map<string, OpenClassLoan>();
  for (const rawRow of result.results ?? []) {
    const row = rawRow as DirectoryRow;
    const classLoanId = boundedText(row.class_loan_id, 128);
    const classLoanItemId = boundedText(row.class_loan_item_id, 128);
    const materialId = boundedText(row.material_id, 64);
    if (!classLoanId || !classLoanItemId || !materialId) continue;
    let loan = loans.get(classLoanId);
    if (!loan) {
      loan = {
        classLoanId,
        classYearId: boundedText(row.class_year_id, 128),
        className: boundedText(row.class_name, 300),
        academicYearId: boundedText(row.academic_year_id, 128),
        academicYearLabel: boundedText(row.academic_year_label, 64),
        cohortId: boundedText(row.cohort_id, 128),
        curatorUserId: boundedText(row.curator_user_id, 64) || null,
        responsibleTeacherUserId: boundedText(row.responsible_teacher_user_id, 128),
        responsibleTeacherName: boundedText(row.responsible_teacher_name, 300),
        status: "open",
        issuedAt: boundedText(row.issued_at, 40),
        dueAt: boundedText(row.due_at, 40) || null,
        notes: boundedText(row.notes, 4_000),
        version: positiveInteger(row.version),
        items: [],
      };
      loans.set(classLoanId, loan);
    }
    const issued = nonNegativeInteger(row.quantity_issued);
    const returned = Math.min(issued, nonNegativeInteger(row.quantity_returned));
    loan.items.push({
      classLoanItemId,
      materialId,
      materialTitle: boundedText(row.material_title, 500),
      materialAuthor: boundedText(row.material_author, 500),
      materialYear: nullableYear(row.material_year),
      sourceLocationId: boundedText(row.source_location_id, 64),
      sourceLocationName: boundedText(row.source_location_name, 240),
      condition: boundedText(row.condition, 80) || "unspecified",
      quantityIssued: issued,
      quantityReturned: returned,
      quantityOutstanding: issued - returned,
    });
  }
  return [...loans.values()];
}

function boundedText(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

function nonNegativeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function positiveInteger(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 1;
}

function nullableYear(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1000 && number <= 9999
    ? number
    : null;
}

function materialCoverUrl(row: DirectoryRow, materialId: string): string {
  const external = safeHttpsUrl(row.cover_external_url);
  if (external) return external;
  const provider = boundedText(row.cover_storage_provider, 40).toLowerCase();
  const key = boundedText(row.cover_storage_key, 500);
  if (provider !== "r2" || !key) return "";
  const hash = /^[0-9a-f]{64}$/iu.test(String(row.cover_sha256 ?? ""))
    ? `?v=${String(row.cover_sha256).slice(0, 12).toLowerCase()}`
    : "";
  return `/api/catalog-v2/covers/${encodeURIComponent(materialId)}${hash}`;
}

function safeHttpsUrl(value: unknown): string {
  const candidate = boundedText(value, 2_000);
  if (!candidate) return "";
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : "";
  } catch {
    return "";
  }
}
