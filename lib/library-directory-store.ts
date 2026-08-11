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
  materialTitle: string;
  materialYear: number | null;
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

type DirectoryRow = Record<string, unknown>;

export async function readLibraryReferenceData(
  db: CatalogD1Database,
): Promise<{ teachers: LibraryTeacher[]; locations: LibraryLocation[] }> {
  const [teacherResult, locationResult] = await Promise.all([
    db.prepare(`
      SELECT id, full_name
      FROM users
      WHERE role = 'teacher' AND status = 'active'
      ORDER BY sort_name ASC, id ASC
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
      m.title AS material_title,
      m.publication_year AS material_year,
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
    JOIN locations loc ON loc.id = li.source_location_id
    WHERE li.quantity_returned < li.quantity_issued
    ORDER BY COALESCE(l.due_at, '9999-12-31') ASC, l.issued_at ASC,
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
      materialTitle: boundedText(row.material_title, 500),
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
