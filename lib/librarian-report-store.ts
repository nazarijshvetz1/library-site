type D1Value = string | number | null;

export type LibrarianReportStatement = {
  bind(...values: D1Value[]): LibrarianReportStatement;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
};

export type LibrarianReportDatabase = {
  prepare(sql: string): LibrarianReportStatement;
};

export const LIBRARIAN_REPORT_KINDS = [
  "returns",
  "provision",
  "movement",
  "inventory",
  "acquisitions",
  "visits",
  "annual",
] as const;

export type LibrarianReportKind = (typeof LIBRARIAN_REPORT_KINDS)[number];
export type LibrarianReportData = {
  kind: LibrarianReportKind;
  from: string;
  to: string;
  generatedAt: string;
  sections: Array<{ key: string; rows: Record<string, unknown>[] }>;
};

export class LibrarianReportError extends Error {
  readonly code: "invalid_report" | "invalid_period" | "report_too_large" | "report_unavailable";
  constructor(code: LibrarianReportError["code"], message: string) {
    super(message);
    this.name = "LibrarianReportError";
    this.code = code;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_ROWS = 20_000;

export function isLibrarianReportKind(value: string): value is LibrarianReportKind {
  return (LIBRARIAN_REPORT_KINDS as readonly string[]).includes(value);
}

export async function readLibrarianReport(
  db: LibrarianReportDatabase,
  kind: LibrarianReportKind,
  from: string,
  to: string,
  generatedAt = new Date().toISOString(),
): Promise<LibrarianReportData> {
  validatePeriod(from, to);
  const definitions = REPORT_QUERIES[kind];
  try {
    const sections = [];
    for (const definition of definitions) {
      const result = await db.prepare(definition.sql).bind(...definition.bind(from, to)).all<Record<string, unknown>>();
      const rows = result.results ?? [];
      if (rows.length > MAX_ROWS) {
        throw new LibrarianReportError("report_too_large", "У звіті забагато рядків. Виберіть коротший період.");
      }
      sections.push({ key: definition.key, rows });
    }
    return { kind, from, to, generatedAt, sections };
  } catch (error) {
    if (error instanceof LibrarianReportError) throw error;
    throw new LibrarianReportError("report_unavailable", "Не вдалося прочитати дані для звіту.");
  }
}

function validatePeriod(from: string, to: string) {
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || from > to) {
    throw new LibrarianReportError("invalid_period", "Перевірте початкову та кінцеву дату звіту.");
  }
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
  if (!Number.isFinite(days) || days > 3660) {
    throw new LibrarianReportError("invalid_period", "Один звіт може охоплювати не більше 10 років.");
  }
}

type QueryDefinition = { key: string; sql: string; bind: (from: string, to: string) => D1Value[] };
const period = (from: string, to: string) => [from, to];
const none = () => [] as D1Value[];

const REPORT_QUERIES: Record<LibrarianReportKind, QueryDefinition[]> = {
  returns: [
    {
      key: "teachers",
      bind: period,
      sql: `SELECT u.full_name AS borrower, l.issued_at AS issuedAt, l.due_at AS dueAt,
        m.subject AS subject, m.title AS title, m.author AS author,
        m.publication_year AS publicationYear,
        li.quantity_issued AS quantityIssued, li.quantity_returned AS quantityReturned,
        li.quantity_issued - li.quantity_returned AS outstanding
      FROM loans l
      JOIN users u ON u.id = l.teacher_user_id
      JOIN loan_items li ON li.loan_id = l.id
      JOIN materials m ON m.id = li.material_id
      WHERE l.status = 'open' AND li.quantity_issued > li.quantity_returned
        AND substr(l.issued_at, 1, 10) BETWEEN ? AND ?
      ORDER BY COALESCE(l.due_at, '9999-12-31'), u.sort_name, m.sort_title
      LIMIT 20001`,
    },
    {
      key: "classes",
      bind: period,
      sql: `SELECT cy.class_name AS borrower, ay.label AS academicYear,
        cl.issued_at AS issuedAt, cl.due_at AS dueAt,
        m.subject AS subject, m.title AS title, m.author AS author,
        m.publication_year AS publicationYear,
        cli.quantity_issued AS quantityIssued, cli.quantity_returned AS quantityReturned,
        cli.quantity_issued - cli.quantity_returned AS outstanding
      FROM class_loans cl
      JOIN class_years cy ON cy.id = cl.class_year_id
      JOIN academic_years ay ON ay.id = cy.academic_year_id
      JOIN class_loan_items cli ON cli.class_loan_id = cl.id
      JOIN materials m ON m.id = cli.material_id
      WHERE cl.status = 'open' AND cli.quantity_issued > cli.quantity_returned
        AND substr(cl.issued_at, 1, 10) BETWEEN ? AND ?
      ORDER BY COALESCE(cl.due_at, '9999-12-31'), cy.grade, cy.code, m.sort_title
      LIMIT 20001`,
    },
  ],
  provision: [{
    key: "distribution",
    bind: period,
    sql: `SELECT ay.label AS academicYear, cy.class_name AS className,
      COALESCE(curator.full_name, '') AS curatorName,
      m.subject AS subject, m.title AS title, m.author AS author,
      m.publication_year AS publicationYear,
      SUM(cli.quantity_issued) AS issued,
      SUM(cli.quantity_returned) AS returned,
      SUM(cli.quantity_issued - cli.quantity_returned) AS outstanding,
      MAX(COALESCE(mst.library_quantity + mst.other_location_quantity - mst.reserved_quantity, 0)) AS availableNow
    FROM class_loans cl
    JOIN class_years cy ON cy.id = cl.class_year_id
    JOIN academic_years ay ON ay.id = cy.academic_year_id
    LEFT JOIN users curator ON curator.id = cy.teacher_user_id
    JOIN class_loan_items cli ON cli.class_loan_id = cl.id
    JOIN materials m ON m.id = cli.material_id
    LEFT JOIN material_stock_totals mst ON mst.material_id = m.id
    WHERE substr(cl.issued_at, 1, 10) BETWEEN ? AND ? AND cl.status != 'cancelled'
    GROUP BY ay.label, cy.class_name, cy.grade, cy.code, curator.full_name,
      m.subject, m.title, m.author, m.publication_year, m.sort_title, m.id
    ORDER BY ay.label DESC, cy.grade, cy.code, m.subject, m.sort_title
    LIMIT 20001`,
  }],
  movement: [
    {
      key: "fund",
      bind: period,
      sql: `SELECT it.occurred_at AS occurredAt, it.kind AS kind, it.document_number AS documentNumber,
        m.title AS title, m.author AS author, m.subject AS subject,
        location.name AS locationName, itl.condition AS condition,
        itl.quantity_delta AS quantityDelta, itl.quantity_before AS quantityBefore,
        itl.quantity_after AS quantityAfter, COALESCE(it.reason, it.notes, '') AS reason
      FROM inventory_transactions it
      JOIN inventory_transaction_lines itl ON itl.transaction_id = it.id
      JOIN materials m ON m.id = itl.material_id
      JOIN locations location ON location.id = itl.location_id
      WHERE substr(it.occurred_at, 1, 10) BETWEEN ? AND ?
      ORDER BY it.occurred_at DESC, m.sort_title, location.sort_order
      LIMIT 20001`,
    },
    {
      key: "classes",
      bind: period,
      sql: `SELECT clt.occurred_at AS occurredAt, clt.kind AS kind,
        cy.class_name AS className, m.title AS title, m.author AS author,
        m.subject AS subject, location.name AS locationName,
        cltl.condition AS condition, cltl.quantity_delta AS quantityDelta,
        cltl.quantity_before AS quantityBefore, cltl.quantity_after AS quantityAfter,
        clt.notes AS reason
      FROM class_loan_transactions clt
      JOIN class_loans cl ON cl.id = clt.class_loan_id
      JOIN class_years cy ON cy.id = cl.class_year_id
      JOIN class_loan_transaction_lines cltl ON cltl.transaction_id = clt.id
      JOIN materials m ON m.id = cltl.material_id
      JOIN locations location ON location.id = cltl.location_id
      WHERE substr(clt.occurred_at, 1, 10) BETWEEN ? AND ?
      ORDER BY clt.occurred_at DESC, cy.grade, cy.code, m.sort_title
      LIMIT 20001`,
    },
  ],
  inventory: [{
    key: "inventory",
    bind: none,
    sql: `SELECT m.title AS title, m.author AS author, m.subject AS subject,
      m.publication_year AS publicationYear, location.name AS locationName,
      h.condition AS condition, h.quantity AS systemQuantity,
      (SELECT itl.counted_quantity
       FROM inventory_transaction_lines itl
       JOIN inventory_transactions it ON it.id = itl.transaction_id
       WHERE it.kind = 'stock_count' AND itl.material_id = h.material_id
         AND itl.location_id = h.location_id AND itl.condition = h.condition
       ORDER BY it.occurred_at DESC, it.created_at DESC LIMIT 1) AS lastCountedQuantity,
      (SELECT it.occurred_at
       FROM inventory_transaction_lines itl
       JOIN inventory_transactions it ON it.id = itl.transaction_id
       WHERE it.kind = 'stock_count' AND itl.material_id = h.material_id
         AND itl.location_id = h.location_id AND itl.condition = h.condition
       ORDER BY it.occurred_at DESC, it.created_at DESC LIMIT 1) AS lastCountedAt
    FROM holdings h
    JOIN materials m ON m.id = h.material_id
    JOIN locations location ON location.id = h.location_id
    ORDER BY location.sort_order, location.name, m.subject, m.sort_title
    LIMIT 20001`,
  }],
  acquisitions: [{
    key: "acquisitions",
    bind: period,
    sql: `SELECT ar.public_number AS requestNumber, ar.submitted_at AS submittedAt,
      ar.requester_kind AS requesterKind, ar.requester_name AS requesterName,
      ar.requester_class_name AS requesterClassName, ar.category AS category,
      ar.literature_kind AS literatureKind, ar.title AS title, ar.author AS author,
      ar.publication_year AS publicationYear, ar.subject AS subject,
      ar.target_class AS targetClass, ar.requested_quantity AS requestedQuantity,
      ar.approved_quantity AS approvedQuantity, ar.ordered_quantity AS orderedQuantity,
      ar.received_quantity AS receivedQuantity, ar.status AS status,
      ar.source_url AS sourceUrl, ar.requester_note AS requesterNote,
      ar.librarian_note AS librarianNote
    FROM acquisition_requests ar
    WHERE substr(ar.submitted_at, 1, 10) BETWEEN ? AND ?
    ORDER BY ar.submitted_at DESC, ar.public_number DESC
    LIMIT 20001`,
  }],
  visits: [{
    key: "visits",
    bind: period,
    sql: `SELECT vb.visit_date AS visitDate, vb.start_time AS startTime,
      vb.end_time AS endTime,
      COALESCE(owner.full_name, selected_teacher.full_name, vb.surname) AS teacherName,
      COALESCE(cy.class_name, vb.class_label, '') AS className,
      vb.purpose AS purpose, vb.status AS status, vb.cancel_reason AS cancelReason
    FROM visit_bookings vb
    LEFT JOIN users owner ON owner.id = vb.owner_user_id
    LEFT JOIN users selected_teacher ON selected_teacher.id = vb.selected_teacher_user_id
    LEFT JOIN class_years cy ON cy.id = vb.class_year_id
    WHERE vb.visit_date BETWEEN ? AND ?
    ORDER BY vb.visit_date, vb.start_time, teacherName
    LIMIT 20001`,
  }],
  annual: [{
    key: "annual",
    bind: period,
    sql: `WITH period(fromDate, toDate) AS (SELECT ?, ?)
    SELECT
      (SELECT COUNT(*) FROM materials WHERE status = 'active') AS activeMaterials,
      (SELECT COALESCE(SUM(total_quantity), 0) FROM material_stock_totals) AS totalCopies,
      (SELECT COALESCE(SUM(CASE WHEN itl.quantity_delta > 0 THEN itl.quantity_delta ELSE 0 END), 0)
       FROM inventory_transactions it JOIN inventory_transaction_lines itl ON itl.transaction_id = it.id, period p
       WHERE it.kind IN ('receipt','import') AND substr(it.occurred_at, 1, 10) BETWEEN p.fromDate AND p.toDate) AS receivedCopies,
      (SELECT COALESCE(SUM(CASE WHEN itl.quantity_delta < 0 THEN -itl.quantity_delta ELSE 0 END), 0)
       FROM inventory_transactions it JOIN inventory_transaction_lines itl ON itl.transaction_id = it.id, period p
       WHERE it.kind = 'writeoff' AND substr(it.occurred_at, 1, 10) BETWEEN p.fromDate AND p.toDate) AS writtenOffCopies,
      (SELECT COALESCE(SUM(li.quantity_issued), 0) FROM loans l JOIN loan_items li ON li.loan_id = l.id, period p
       WHERE substr(l.issued_at, 1, 10) BETWEEN p.fromDate AND p.toDate) AS issuedToTeachers,
      (SELECT COALESCE(SUM(cli.quantity_issued), 0) FROM class_loans cl JOIN class_loan_items cli ON cli.class_loan_id = cl.id, period p
       WHERE substr(cl.issued_at, 1, 10) BETWEEN p.fromDate AND p.toDate) AS issuedToClasses,
      (SELECT COUNT(*) FROM visit_bookings vb, period p
       WHERE vb.visit_date BETWEEN p.fromDate AND p.toDate AND vb.status = 'active') AS activeVisitBookings,
      (SELECT COUNT(*) FROM visit_bookings vb, period p
       WHERE vb.visit_date BETWEEN p.fromDate AND p.toDate AND vb.status = 'cancelled') AS cancelledVisitBookings,
      (SELECT COUNT(*) FROM acquisition_requests ar, period p
       WHERE substr(ar.submitted_at, 1, 10) BETWEEN p.fromDate AND p.toDate) AS acquisitionRequests,
      (SELECT COUNT(*) FROM acquisition_requests ar, period p
       WHERE substr(ar.submitted_at, 1, 10) BETWEEN p.fromDate AND p.toDate AND ar.status = 'received') AS receivedAcquisitions,
      (SELECT COUNT(*) FROM users u JOIN teacher_profiles tp ON tp.teacher_user_id = u.id
       WHERE u.role = 'teacher' AND u.status = 'active' AND tp.closed_at IS NULL) AS activeTeachers,
      (SELECT COUNT(*) FROM class_years cy JOIN academic_years ay ON ay.id = cy.academic_year_id
       WHERE cy.status = 'active' AND ay.status = 'active') AS activeClasses`,
  }],
};
