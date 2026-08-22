type D1Value = string | number | null;

export type LibraryExportResult<T = Record<string, unknown>> = {
  success?: boolean;
  results?: T[];
};

export type LibraryExportStatement = {
  bind(...values: D1Value[]): LibraryExportStatement;
  all<T = Record<string, unknown>>(): Promise<LibraryExportResult<T>>;
};

export type LibraryExportDatabase = {
  prepare(sql: string): LibraryExportStatement;
  batch<T = Record<string, unknown>>(
    statements: LibraryExportStatement[],
  ): Promise<Array<LibraryExportResult<T>>>;
};

export type ExportMaterial = {
  id: string;
  catalogNumber: number;
  rubric: string;
  publicationType: string;
  subject: string;
  classFrom: number | null;
  classTo: number | null;
  title: string;
  author: string;
  publicationYear: number | null;
  isbn: string;
  publisher: string;
  electronicUrl: string;
  notes: string;
  status: string;
  totalQuantity: number;
  libraryQuantity: number;
  otherLocationQuantity: number;
  loanedQuantity: number;
  reservedQuantity: number;
};

export type ExportHolding = {
  materialId: string;
  title: string;
  subject: string;
  locationId: string;
  locationName: string;
  locationType: string;
  condition: string;
  quantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  updatedAt: string;
};

export type ExportTeacher = {
  id: string;
  fullName: string;
  status: string;
  subjectPosition: string;
  primaryLocation: string;
  serviceContact: string;
  librarianNote: string;
  updatedAt: string;
};

export type ExportClass = {
  id: string;
  academicYear: string;
  className: string;
  grade: number;
  code: string;
  teacherName: string;
  locationName: string;
  startDate: string;
  endDate: string;
  status: string;
  notes: string;
};

export type ExportTeacherLoan = {
  loanId: string;
  itemId: string;
  teacherUserId: string;
  teacherName: string;
  status: string;
  issuedAt: string;
  dueAt: string;
  closedAt: string;
  materialId: string;
  title: string;
  subject: string;
  sourceLocation: string;
  condition: string;
  quantityIssued: number;
  quantityReturned: number;
  remainingQuantity: number;
  loanNotes: string;
  itemNotes: string;
};

export type ExportClassLoan = {
  classLoanId: string;
  itemId: string;
  classYearId: string;
  academicYear: string;
  className: string;
  responsibleTeacher: string;
  status: string;
  issuedAt: string;
  dueAt: string;
  closedAt: string;
  materialId: string;
  title: string;
  subject: string;
  sourceLocation: string;
  condition: string;
  quantityIssued: number;
  quantityReturned: number;
  remainingQuantity: number;
  loanNotes: string;
  itemNotes: string;
};

export type ExportMaterialRequest = {
  requestId: string;
  itemId: string;
  teacherUserId: string;
  teacherName: string;
  status: string;
  submittedAt: string;
  readyAt: string;
  completedAt: string;
  dueAt: string;
  pickupLocation: string;
  teacherNotes: string;
  librarianNote: string;
  rejectionReason: string;
  resultingLoanId: string;
  materialId: string;
  title: string;
  author: string;
  requestedQuantity: number;
  approvedQuantity: number | null;
  fulfilledQuantity: number;
  activeReservedQuantity: number;
};

export type LibraryExportSnapshot = {
  generatedAt: string;
  materials: ExportMaterial[];
  holdings: ExportHolding[];
  teachers: ExportTeacher[];
  classes: ExportClass[];
  teacherLoans: ExportTeacherLoan[];
  classLoans: ExportClassLoan[];
  materialRequests: ExportMaterialRequest[];
};

const MAX_ROWS_PER_BLOCK = 50_000;
const MAX_TOTAL_ROWS = 100_000;

export class LibraryExportError extends Error {
  readonly code: "export_too_large" | "export_unavailable";

  constructor(
    code: "export_too_large" | "export_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "LibraryExportError";
    this.code = code;
  }
}

export async function readLibraryExportSnapshot(
  db: LibraryExportDatabase,
  generatedAt = new Date().toISOString(),
): Promise<LibraryExportSnapshot> {
  const statements = [
    db.prepare(MATERIALS_SQL).bind(MAX_ROWS_PER_BLOCK + 1),
    db.prepare(HOLDINGS_SQL).bind(MAX_ROWS_PER_BLOCK + 1),
    db.prepare(TEACHERS_SQL).bind(MAX_ROWS_PER_BLOCK + 1),
    db.prepare(CLASSES_SQL).bind(MAX_ROWS_PER_BLOCK + 1),
    db.prepare(TEACHER_LOANS_SQL).bind(MAX_ROWS_PER_BLOCK + 1),
    db.prepare(CLASS_LOANS_SQL).bind(MAX_ROWS_PER_BLOCK + 1),
    db.prepare(MATERIAL_REQUESTS_SQL).bind(MAX_ROWS_PER_BLOCK + 1),
  ];

  let results: Array<LibraryExportResult<Record<string, unknown>>>;
  try {
    results = await db.batch<Record<string, unknown>>(statements);
  } catch {
    throw new LibraryExportError(
      "export_unavailable",
      "Не вдалося прочитати дані для Excel-експорту.",
    );
  }

  if (results.length !== statements.length) {
    throw new LibraryExportError(
      "export_unavailable",
      "Отримано неповний набір даних для Excel-експорту.",
    );
  }

  const blocks = results.map((result) => result.results ?? []);
  if (blocks.some((rows) => rows.length > MAX_ROWS_PER_BLOCK)) {
    throw new LibraryExportError(
      "export_too_large",
      "Один із розділів бази завеликий для безпечного експорту одним файлом.",
    );
  }
  if (blocks.reduce((total, rows) => total + rows.length, 0) > MAX_TOTAL_ROWS) {
    throw new LibraryExportError(
      "export_too_large",
      "Загальний обсяг бази завеликий для безпечного експорту одним файлом.",
    );
  }

  return {
    generatedAt,
    materials: blocks[0].map(materialRow),
    holdings: blocks[1].map(holdingRow),
    teachers: blocks[2].map(teacherRow),
    classes: blocks[3].map(classRow),
    teacherLoans: blocks[4].map(teacherLoanRow),
    classLoans: blocks[5].map(classLoanRow),
    materialRequests: blocks[6].map(materialRequestRow),
  };
}

function materialRow(row: Record<string, unknown>): ExportMaterial {
  return {
    id: text(row.id), catalogNumber: integer(row.catalogNumber), rubric: text(row.rubric),
    publicationType: text(row.publicationType), subject: text(row.subject),
    classFrom: nullableInteger(row.classFrom), classTo: nullableInteger(row.classTo),
    title: text(row.title), author: text(row.author), publicationYear: nullableInteger(row.publicationYear),
    isbn: text(row.isbn), publisher: text(row.publisher), electronicUrl: text(row.electronicUrl),
    notes: text(row.notes), status: text(row.status), totalQuantity: integer(row.totalQuantity),
    libraryQuantity: integer(row.libraryQuantity), otherLocationQuantity: integer(row.otherLocationQuantity),
    loanedQuantity: integer(row.loanedQuantity), reservedQuantity: integer(row.reservedQuantity),
  };
}

function holdingRow(row: Record<string, unknown>): ExportHolding {
  return {
    materialId: text(row.materialId), title: text(row.title), subject: text(row.subject),
    locationId: text(row.locationId), locationName: text(row.locationName), locationType: text(row.locationType),
    condition: text(row.condition), quantity: integer(row.quantity), reservedQuantity: integer(row.reservedQuantity),
    availableQuantity: integer(row.availableQuantity), updatedAt: text(row.updatedAt),
  };
}

function teacherRow(row: Record<string, unknown>): ExportTeacher {
  return {
    id: text(row.id), fullName: text(row.fullName), status: text(row.status),
    subjectPosition: text(row.subjectPosition), primaryLocation: text(row.primaryLocation),
    serviceContact: text(row.serviceContact), librarianNote: text(row.librarianNote), updatedAt: text(row.updatedAt),
  };
}

function classRow(row: Record<string, unknown>): ExportClass {
  return {
    id: text(row.id), academicYear: text(row.academicYear), className: text(row.className),
    grade: integer(row.grade), code: text(row.code), teacherName: text(row.teacherName),
    locationName: text(row.locationName), startDate: text(row.startDate), endDate: text(row.endDate),
    status: text(row.status), notes: text(row.notes),
  };
}

function teacherLoanRow(row: Record<string, unknown>): ExportTeacherLoan {
  return {
    loanId: text(row.loanId), itemId: text(row.itemId), teacherUserId: text(row.teacherUserId),
    teacherName: text(row.teacherName), status: text(row.status), issuedAt: text(row.issuedAt),
    dueAt: text(row.dueAt), closedAt: text(row.closedAt), materialId: text(row.materialId),
    title: text(row.title), subject: text(row.subject), sourceLocation: text(row.sourceLocation),
    condition: text(row.condition), quantityIssued: integer(row.quantityIssued),
    quantityReturned: integer(row.quantityReturned), remainingQuantity: integer(row.remainingQuantity),
    loanNotes: text(row.loanNotes), itemNotes: text(row.itemNotes),
  };
}

function classLoanRow(row: Record<string, unknown>): ExportClassLoan {
  return {
    classLoanId: text(row.classLoanId), itemId: text(row.itemId), classYearId: text(row.classYearId),
    academicYear: text(row.academicYear), className: text(row.className),
    responsibleTeacher: text(row.responsibleTeacher), status: text(row.status), issuedAt: text(row.issuedAt),
    dueAt: text(row.dueAt), closedAt: text(row.closedAt), materialId: text(row.materialId),
    title: text(row.title), subject: text(row.subject), sourceLocation: text(row.sourceLocation),
    condition: text(row.condition), quantityIssued: integer(row.quantityIssued),
    quantityReturned: integer(row.quantityReturned), remainingQuantity: integer(row.remainingQuantity),
    loanNotes: text(row.loanNotes), itemNotes: text(row.itemNotes),
  };
}

function materialRequestRow(row: Record<string, unknown>): ExportMaterialRequest {
  return {
    requestId: text(row.requestId), itemId: text(row.itemId), teacherUserId: text(row.teacherUserId),
    teacherName: text(row.teacherName), status: text(row.status), submittedAt: text(row.submittedAt),
    readyAt: text(row.readyAt), completedAt: text(row.completedAt), dueAt: text(row.dueAt),
    pickupLocation: text(row.pickupLocation), teacherNotes: text(row.teacherNotes),
    librarianNote: text(row.librarianNote), rejectionReason: text(row.rejectionReason),
    resultingLoanId: text(row.resultingLoanId), materialId: text(row.materialId), title: text(row.title),
    author: text(row.author), requestedQuantity: integer(row.requestedQuantity),
    approvedQuantity: nullableInteger(row.approvedQuantity), fulfilledQuantity: integer(row.fulfilledQuantity),
    activeReservedQuantity: integer(row.activeReservedQuantity),
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function integer(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function nullableInteger(value: unknown): number | null {
  return value == null || value === "" ? null : integer(value);
}

const MATERIALS_SQL = `
  SELECT m.id AS id, m.catalog_number AS catalogNumber, m.rubric AS rubric,
    m.publication_type AS publicationType, m.subject AS subject,
    m.class_from AS classFrom, m.class_to AS classTo, m.title AS title,
    m.author AS author, m.publication_year AS publicationYear, m.isbn AS isbn,
    m.publisher AS publisher, m.notes AS notes, m.status AS status,
    COALESCE(st.total_quantity, 0) AS totalQuantity,
    COALESCE(st.library_quantity, 0) AS libraryQuantity,
    COALESCE(st.other_location_quantity, 0) AS otherLocationQuantity,
    COALESCE(st.loaned_quantity, 0) AS loanedQuantity,
    COALESCE(st.reserved_quantity, 0) AS reservedQuantity,
    COALESCE((SELECT ml.url FROM material_links ml
      WHERE ml.material_id = m.id AND ml.status = 'active' AND ml.is_public = 1
      ORDER BY ml.sort_order, ml.id LIMIT 1), '') AS electronicUrl
  FROM materials m
  LEFT JOIN material_stock_totals st ON st.material_id = m.id
  ORDER BY m.catalog_number, m.id
  LIMIT ?`;

const HOLDINGS_SQL = `
  WITH active_reservations AS (
    SELECT material_id, source_location_id, condition,
      SUM(reserved_quantity - issued_quantity - released_quantity) AS reserved_quantity
    FROM material_request_reservations
    GROUP BY material_id, source_location_id, condition
  )
  SELECT h.material_id AS materialId, m.title AS title, m.subject AS subject,
    h.location_id AS locationId, l.name AS locationName, l.type AS locationType,
    h.condition AS condition, h.quantity AS quantity,
    COALESCE(r.reserved_quantity, 0) AS reservedQuantity,
    h.quantity - COALESCE(r.reserved_quantity, 0) AS availableQuantity,
    h.updated_at AS updatedAt
  FROM holdings h
  JOIN materials m ON m.id = h.material_id
  JOIN locations l ON l.id = h.location_id
  LEFT JOIN active_reservations r ON r.material_id = h.material_id
    AND r.source_location_id = h.location_id AND r.condition = h.condition
  ORDER BY m.catalog_number, l.sort_order, l.name, h.condition
  LIMIT ?`;

const TEACHERS_SQL = `
  SELECT u.id AS id, u.full_name AS fullName,
    CASE WHEN u.status='active' AND tp.closed_at IS NULL THEN 'active' ELSE 'inactive' END AS status,
    COALESCE(tp.subject_position, '') AS subjectPosition,
    COALESCE(l.name, '') AS primaryLocation,
    COALESCE(tp.service_contact, '') AS serviceContact,
    COALESCE(tp.librarian_note, '') AS librarianNote,
    COALESCE(tp.updated_at, u.updated_at) AS updatedAt
  FROM users u
  JOIN teacher_profiles tp ON tp.teacher_user_id = u.id
  LEFT JOIN locations l ON l.id = tp.primary_location_id
  ORDER BY u.sort_name, u.id
  LIMIT ?`;

const CLASSES_SQL = `
  SELECT cy.id AS id, ay.label AS academicYear, cy.class_name AS className,
    cy.grade AS grade, cy.code AS code, COALESCE(u.full_name, '') AS teacherName,
    COALESCE(l.name, '') AS locationName, cy.start_date AS startDate,
    cy.end_date AS endDate, cy.status AS status, cy.notes AS notes
  FROM class_years cy
  JOIN academic_years ay ON ay.id = cy.academic_year_id
  LEFT JOIN users u ON u.id = cy.teacher_user_id
  LEFT JOIN locations l ON l.id = cy.location_id
  ORDER BY ay.start_date DESC, cy.grade, cy.class_name, cy.id
  LIMIT ?`;

const TEACHER_LOANS_SQL = `
  SELECT l.id AS loanId, li.id AS itemId, l.teacher_user_id AS teacherUserId,
    u.full_name AS teacherName, l.status AS status, l.issued_at AS issuedAt,
    COALESCE(l.due_at, '') AS dueAt, COALESCE(l.closed_at, '') AS closedAt,
    li.material_id AS materialId, m.title AS title, m.subject AS subject,
    loc.name AS sourceLocation, li.condition AS condition,
    li.quantity_issued AS quantityIssued, li.quantity_returned AS quantityReturned,
    li.quantity_issued - li.quantity_returned AS remainingQuantity,
    l.notes AS loanNotes, li.notes AS itemNotes
  FROM loans l
  JOIN loan_items li ON li.loan_id = l.id
  JOIN users u ON u.id = l.teacher_user_id
  JOIN materials m ON m.id = li.material_id
  JOIN locations loc ON loc.id = li.source_location_id
  ORDER BY l.issued_at DESC, l.id, m.catalog_number, li.id
  LIMIT ?`;

const CLASS_LOANS_SQL = `
  SELECT cl.id AS classLoanId, cli.id AS itemId, cl.class_year_id AS classYearId,
    ay.label AS academicYear, cy.class_name AS className,
    u.full_name AS responsibleTeacher, cl.status AS status,
    cl.issued_at AS issuedAt, COALESCE(cl.due_at, '') AS dueAt,
    COALESCE(cl.closed_at, '') AS closedAt, cli.material_id AS materialId,
    m.title AS title, m.subject AS subject, loc.name AS sourceLocation,
    cli.condition AS condition, cli.quantity_issued AS quantityIssued,
    cli.quantity_returned AS quantityReturned,
    cli.quantity_issued - cli.quantity_returned AS remainingQuantity,
    cl.notes AS loanNotes, cli.notes AS itemNotes
  FROM class_loans cl
  JOIN class_loan_items cli ON cli.class_loan_id = cl.id
  JOIN class_years cy ON cy.id = cl.class_year_id
  JOIN academic_years ay ON ay.id = cy.academic_year_id
  JOIN users u ON u.id = cl.responsible_teacher_user_id
  JOIN materials m ON m.id = cli.material_id
  JOIN locations loc ON loc.id = cli.source_location_id
  ORDER BY cl.issued_at DESC, cl.id, m.catalog_number, cli.id
  LIMIT ?`;

const MATERIAL_REQUESTS_SQL = `
  WITH reservation_totals AS (
    SELECT request_item_id,
      SUM(reserved_quantity - issued_quantity - released_quantity) AS active_reserved
    FROM material_request_reservations
    GROUP BY request_item_id
  )
  SELECT mr.id AS requestId, mri.id AS itemId, mr.teacher_user_id AS teacherUserId,
    u.full_name AS teacherName, mr.status AS status, mr.submitted_at AS submittedAt,
    COALESCE(mr.ready_at, '') AS readyAt, COALESCE(mr.completed_at, '') AS completedAt,
    COALESCE(mr.due_at, '') AS dueAt, COALESCE(loc.name, '') AS pickupLocation,
    mr.teacher_notes AS teacherNotes, mr.librarian_note AS librarianNote,
    mr.rejection_reason AS rejectionReason, COALESCE(mr.resulting_loan_id, '') AS resultingLoanId,
    mri.material_id AS materialId, mri.title_snapshot AS title,
    mri.author_snapshot AS author, mri.requested_quantity AS requestedQuantity,
    mri.approved_quantity AS approvedQuantity, mri.fulfilled_quantity AS fulfilledQuantity,
    COALESCE(rt.active_reserved, 0) AS activeReservedQuantity
  FROM material_requests mr
  JOIN material_request_items mri ON mri.request_id = mr.id
  JOIN users u ON u.id = mr.teacher_user_id
  LEFT JOIN locations loc ON loc.id = mr.pickup_location_id
  LEFT JOIN reservation_totals rt ON rt.request_item_id = mri.id
  ORDER BY mr.submitted_at DESC, mr.id, mri.sort_order, mri.id
  LIMIT ?`;
