import type { ChatGPTUser } from "../app/chatgpt-auth.ts";
import type { VisitTeacherIdentity } from "./visit-teacher-auth.ts";
import {
  acquisitionDuplicateKey,
  normalizedAcquisitionText,
  type AcquisitionActionInput,
  type AcquisitionCancelInput,
  type AcquisitionCreateInput,
  type AcquisitionImportInput,
  type AcquisitionImportRowInput,
  type AcquisitionStatus,
  type StudentAcquisitionCreateInput,
} from "./acquisition-validation.ts";
import {
  queueTelegramForLibrariansStatement,
  queueTelegramFromPortalNotificationStatement,
} from "./telegram-outbox.ts";

type D1Value = string | number | null;
type D1Result<T = Record<string, unknown>> = { results?: T[]; success?: boolean; meta?: { changes?: number } };
type D1Statement = {
  bind(...values: D1Value[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
};
export type AcquisitionDatabase = {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<D1Result[]>;
};

export type AcquisitionProjection = {
  id: string;
  publicNumber: string;
  requesterKind: "teacher" | "student";
  teacherUserId: string | null;
  requesterName: string;
  requesterClassName: string;
  category: "educational" | "literature";
  sourceKind: "catalog" | "manual";
  literatureKind: "none" | "fiction" | "science" | "popular_science" | "other";
  materialId: string | null;
  title: string;
  author: string;
  publicationYear: number | null;
  requestedQuantity: number;
  approvedQuantity: number | null;
  orderedQuantity: number;
  receivedQuantity: number;
  sourceUrl: string;
  subject: string;
  targetClass: string;
  requesterNote: string;
  librarianNote: string;
  clarificationMessage: string;
  rejectionReason: string;
  status: AcquisitionStatus;
  duplicateKey: string;
  duplicateCount: number;
  academicYearLabel: string;
  version: number;
  submittedAt: string;
  updatedAt: string;
};

export type AcquisitionSummary = {
  total: number;
  active: number;
  submitted: number;
  ordered: number;
  received: number;
  requestedCopies: number;
  orderedCopies: number;
  receivedCopies: number;
  duplicateGroups: number;
};

type RequestRow = {
  id: string; public_number: string; requester_kind: "teacher" | "student";
  teacher_user_id: string | null; requester_name: string; requester_class_name: string;
  category: "educational" | "literature"; source_kind: "catalog" | "manual";
  literature_kind: "none" | "fiction" | "science" | "popular_science" | "other";
  material_id: string | null; title: string; author: string; publication_year: number | null;
  requested_quantity: number; approved_quantity: number | null; ordered_quantity: number;
  received_quantity: number; source_url: string; subject: string; target_class: string;
  requester_note: string; librarian_note: string; clarification_message: string;
  rejection_reason: string; status: AcquisitionStatus; duplicate_key: string;
  academic_year_label: string; version: number; submitted_at: string; updated_at: string;
  duplicate_count: number;
};

type Actor = { id: string; email: string };
type AcademicYearRow = { id: string; label: string };

export class AcquisitionStoreError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  constructor(code: string, status: number, message: string, details?: Record<string, unknown>) {
    super(message); this.name = "AcquisitionStoreError"; this.code = code; this.status = status; this.details = details;
  }
}

const ACTIVE_STATUSES: AcquisitionStatus[] = ["submitted", "in_review", "clarification", "approved", "planned", "ordered", "partially_received"];

export async function listTeacherAcquisitionRequests(
  db: AcquisitionDatabase,
  teacherUserId: string,
  status: AcquisitionStatus | "all" = "all",
  limit = 100,
): Promise<AcquisitionProjection[]> {
  const clause = status === "all" ? "" : "AND ar.status=?";
  const bindings: D1Value[] = [teacherUserId];
  if (status !== "all") bindings.push(status);
  bindings.push(Math.min(Math.max(limit, 1), 100));
  const rows = await db.prepare(`${projectionSql()} WHERE ar.teacher_user_id=? ${clause} ORDER BY ar.created_at DESC, ar.id DESC LIMIT ?`)
    .bind(...bindings).all<RequestRow>();
  return (rows.results ?? []).map(projectRequest);
}

export async function listLibrarianAcquisitionRequests(
  db: AcquisitionDatabase,
  options: { status?: AcquisitionStatus | "active" | "all"; requesterKind?: "teacher" | "student" | "all"; query?: string; limit?: number } = {},
): Promise<{ requests: AcquisitionProjection[]; summary: AcquisitionSummary; procurementGroups: Array<{ duplicateKey: string; title: string; author: string; publicationYear: number | null; requestCount: number; requestedQuantity: number; orderedQuantity: number; receivedQuantity: number }> }> {
  const status = options.status ?? "all";
  const requesterKind = options.requesterKind ?? "all";
  const query = (options.query ?? "").trim().slice(0, 120);
  const clauses: string[] = [];
  const bindings: D1Value[] = [];
  if (status === "active") {
    clauses.push(`ar.status IN (${ACTIVE_STATUSES.map(() => "?").join(",")})`);
    bindings.push(...ACTIVE_STATUSES);
  } else if (status !== "all") {
    clauses.push("ar.status=?");
    bindings.push(status);
  }
  if (requesterKind !== "all") {
    clauses.push("ar.requester_kind=?");
    bindings.push(requesterKind);
  }
  if (query) {
    clauses.push("(ar.title LIKE ? ESCAPE '\\' OR ar.author LIKE ? ESCAPE '\\' OR ar.requester_name LIKE ? ESCAPE '\\' OR ar.public_number LIKE ? ESCAPE '\\' OR ar.material_id LIKE ? ESCAPE '\\')");
    const needle = `%${query.replace(/[\\%_]/gu, "\\$&")}%`; bindings.push(needle, needle, needle, needle, needle);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  bindings.push(Math.min(Math.max(options.limit ?? 200, 1), 500));
  const result = await db.prepare(`${projectionSql()} ${where} ORDER BY ar.updated_at DESC, ar.id DESC LIMIT ?`).bind(...bindings).all<RequestRow>();
  const requests = (result.results ?? []).map(projectRequest);
  const summaryRow = await db.prepare(`
    SELECT COUNT(*) total,
      SUM(CASE WHEN status IN ('submitted','in_review','clarification','approved','planned','ordered','partially_received') THEN 1 ELSE 0 END) active,
      SUM(CASE WHEN status='submitted' THEN 1 ELSE 0 END) submitted,
      SUM(CASE WHEN status IN ('ordered','partially_received') THEN 1 ELSE 0 END) ordered,
      SUM(CASE WHEN status='received' THEN 1 ELSE 0 END) received,
      COALESCE(SUM(requested_quantity),0) requested_copies,
      COALESCE(SUM(ordered_quantity),0) ordered_copies,
      COALESCE(SUM(received_quantity),0) received_copies,
      (SELECT COUNT(*) FROM (SELECT duplicate_key FROM acquisition_requests GROUP BY academic_year_id,duplicate_key HAVING COUNT(*)>1)) duplicate_groups
    FROM acquisition_requests
  `).first<Record<string, number>>();
  const groups = await db.prepare(`
    SELECT duplicate_key,title,author,publication_year,COUNT(*) request_count,
      SUM(requested_quantity) requested_quantity,SUM(ordered_quantity) ordered_quantity,SUM(received_quantity) received_quantity
    FROM acquisition_requests
    WHERE status NOT IN ('rejected','cancelled')
    GROUP BY academic_year_id,duplicate_key
    HAVING COUNT(*)>1
    ORDER BY requested_quantity DESC,request_count DESC,title
    LIMIT 100
  `).all<Record<string, string | number>>();
  return {
    requests,
    summary: {
      total: number(summaryRow?.total), active: number(summaryRow?.active), submitted: number(summaryRow?.submitted),
      ordered: number(summaryRow?.ordered), received: number(summaryRow?.received),
      requestedCopies: number(summaryRow?.requested_copies), orderedCopies: number(summaryRow?.ordered_copies),
      receivedCopies: number(summaryRow?.received_copies), duplicateGroups: number(summaryRow?.duplicate_groups),
    },
    procurementGroups: (groups.results ?? []).map((row) => ({
      duplicateKey: String(row.duplicate_key), title: String(row.title), author: String(row.author),
      publicationYear: nullableNumber(row.publication_year), requestCount: number(row.request_count),
      requestedQuantity: number(row.requested_quantity), orderedQuantity: number(row.ordered_quantity), receivedQuantity: number(row.received_quantity),
    })),
  };
}

export async function createTeacherAcquisitionRequest(
  db: AcquisitionDatabase,
  teacher: VisitTeacherIdentity,
  input: AcquisitionCreateInput,
): Promise<AcquisitionProjection> {
  const now = new Date().toISOString();
  await requireActiveTeacher(db, teacher, now);
  const active = await db.prepare(`SELECT COUNT(*) count FROM acquisition_requests WHERE teacher_user_id=? AND status IN ('submitted','in_review','clarification','approved','planned','ordered','partially_received')`)
    .bind(teacher.teacherUserId).first<{ count: number }>();
  if (number(active?.count) >= 50) throw new AcquisitionStoreError("request_limit_reached", 429, "У вас уже 50 активних пропозицій.");
  const year = await requireActiveAcademicYear(db);
  let title = input.title, author = input.author, publicationYear = input.publicationYear;
  if (input.sourceKind === "catalog") {
    const material = await db.prepare(`SELECT title,author,publication_year FROM materials WHERE id=? AND status='active' LIMIT 1`).bind(input.materialId).first<{ title: string; author: string; publication_year: number | null }>();
    if (!material) throw new AcquisitionStoreError("material_not_found", 404, "Матеріал із каталогу не знайдено.");
    title = material.title; author = material.author || input.author; publicationYear = material.publication_year ?? input.publicationYear;
  }
  const id = `ACQ-${input.requestId}`;
  const submissionKey = `teacher:${teacher.teacherUserId}:${input.requestId}`;
  const canonical = { ...input, title, author, publicationYear, teacherUserId: teacher.teacherUserId };
  const submissionHash = await sha256(JSON.stringify(canonical));
  const existing = await existingSubmission(db, submissionKey, submissionHash);
  if (existing) return existing;
  const publicNumber = publicRequestNumber(input.requestId, now);
  const duplicateKey = acquisitionDuplicateKey({ materialId: input.materialId, title, author, publicationYear });
  const auditId = `AUD-${crypto.randomUUID()}`;
  const eventId = `AQE-${crypto.randomUUID()}`;
  const after = requestAuditSnapshot({ id, publicNumber, status: "submitted", title, author, requestedQuantity: input.requestedQuantity });
  await db.batch([
    db.prepare(`INSERT INTO acquisition_requests (
      id,public_number,submission_key,submission_hash,requester_kind,teacher_user_id,requester_name,requester_class_year_id,requester_class_name,
      category,source_kind,literature_kind,material_id,title,author,publication_year,requested_quantity,approved_quantity,ordered_quantity,received_quantity,
      source_url,subject,target_class,requester_note,librarian_note,clarification_message,rejection_reason,status,duplicate_key,
      academic_year_id,academic_year_label,import_batch_id,source_import_key,reviewed_by_user_id,version,submitted_at,created_at,updated_at
    ) VALUES (?,?,?,?, 'teacher',?,?,NULL,'', ?,?,?,?,?,?,?,?,NULL,0,0, ?,?,?,?,'','','','submitted', ?,?,?,NULL,NULL,NULL,1,?,?,?)`)
      .bind(id, publicNumber, submissionKey, submissionHash, teacher.teacherUserId, teacher.fullName,
        input.category, input.sourceKind, input.literatureKind, input.materialId, title, author, publicationYear, input.requestedQuantity,
        input.sourceUrl, input.subject, input.targetClass, input.note, duplicateKey, year.id, year.label, now, now, now),
    db.prepare(`INSERT INTO acquisition_request_events (id,request_id,actor_user_id,actor_kind,kind,from_status,to_status,metadata_json,created_at) VALUES (?,?,?,'teacher','submitted',NULL,'submitted',?,?)`)
      .bind(eventId, id, teacher.teacherUserId, JSON.stringify({ requestedQuantity: input.requestedQuantity }), now),
    db.prepare(`INSERT INTO audit_events (id,actor_user_id,actor_email,action,entity_type,entity_id,request_id,before_json,after_json,metadata_json,created_at) VALUES (?,?,?,'acquisition_request.submit','acquisition_request',?,?,NULL,?,NULL,?)`)
      .bind(auditId, teacher.teacherUserId, `teacher:${teacher.teacherUserId}`, id, input.requestId, JSON.stringify(after), now),
    queueTelegramForLibrariansStatement(db, {
      dedupeKey: `acquisition:${id}:submitted`, auditRequestId: input.requestId, category: "orders",
      type: "acquisition_request_submitted", title: "Нова пропозиція до комплектування",
      message: `${teacher.fullName}: «${title}», ${input.requestedQuantity} прим.`, targetPath: "/librarian/acquisitions",
      entityType: "acquisition_request", entityId: id, createdAt: now,
    }),
  ]);
  return requireRequest(db, id);
}

export async function createStudentAcquisitionRequest(
  db: AcquisitionDatabase,
  request: Request,
  input: StudentAcquisitionCreateInput,
  rateLimitSecret: string,
): Promise<{ request: AcquisitionProjection; replayed: boolean }> {
  const now = new Date().toISOString();
  const year = await requireActiveAcademicYear(db);
  const classYear = await db.prepare(`SELECT cy.id,cy.class_name FROM class_years cy WHERE cy.academic_year_id=? AND cy.status='active' AND lower(trim(cy.class_name))=lower(trim(?)) LIMIT 1`)
    .bind(year.id, input.className).first<{ id: string; class_name: string }>();
  if (!classYear) throw new AcquisitionStoreError("class_not_found", 400, "Оберіть клас із чинного списку.");
  const id = `ACQ-${input.requestId}`;
  const submissionKey = `student:${input.requestId}`;
  const submissionHash = await sha256(JSON.stringify({ ...input, website: "", className: classYear.class_name }));
  const existing = await existingSubmission(db, submissionKey, submissionHash);
  if (existing) return { request: existing, replayed: true };
  await enforcePublicLimit(db, request, now, rateLimitSecret);
  const publicNumber = publicRequestNumber(input.requestId, now);
  const duplicateKey = acquisitionDuplicateKey({ materialId: null, title: input.title, author: input.author, publicationYear: input.publicationYear });
  const auditRequestId = input.requestId;
  await db.batch([
    db.prepare(`INSERT INTO acquisition_requests (
      id,public_number,submission_key,submission_hash,requester_kind,teacher_user_id,requester_name,requester_class_year_id,requester_class_name,
      category,source_kind,literature_kind,material_id,title,author,publication_year,requested_quantity,approved_quantity,ordered_quantity,received_quantity,
      source_url,subject,target_class,requester_note,librarian_note,clarification_message,rejection_reason,status,duplicate_key,
      academic_year_id,academic_year_label,import_batch_id,source_import_key,reviewed_by_user_id,version,submitted_at,created_at,updated_at
    ) VALUES (?,?,?,?, 'student',NULL,?,?,?, 'literature','manual','fiction',NULL,?,?,?,?,NULL,0,0, ?,'','',?,'','','','submitted', ?,?,?,NULL,NULL,NULL,1,?,?,?)`)
      .bind(id, publicNumber, submissionKey, submissionHash, input.fullName, classYear.id, classYear.class_name,
        input.title, input.author, input.publicationYear, input.requestedQuantity, input.sourceUrl, input.note,
        duplicateKey, year.id, year.label, now, now, now),
    db.prepare(`INSERT INTO acquisition_request_events (id,request_id,actor_user_id,actor_kind,kind,from_status,to_status,metadata_json,created_at) VALUES (?, ?, NULL,'student','submitted',NULL,'submitted',?,?)`)
      .bind(`AQE-${crypto.randomUUID()}`, id, JSON.stringify({ className: classYear.class_name }), now),
    db.prepare(`INSERT INTO audit_events (id,actor_user_id,actor_email,action,entity_type,entity_id,request_id,before_json,after_json,metadata_json,created_at) VALUES (?,NULL,'public-student@local.invalid','acquisition_request.submit','acquisition_request',?,?,NULL,?,NULL,?)`)
      .bind(`AUD-${crypto.randomUUID()}`, id, auditRequestId, JSON.stringify({ id, publicNumber, status: "submitted", title: input.title, requestedQuantity: input.requestedQuantity }), now),
    queueTelegramForLibrariansStatement(db, {
      dedupeKey: `acquisition:${id}:submitted`, auditRequestId, category: "orders",
      type: "student_book_suggestion", title: "Нова пропозиція учня",
      message: `${classYear.class_name}: «${input.title}», ${input.requestedQuantity} прим.`, targetPath: "/librarian/acquisitions",
      entityType: "acquisition_request", entityId: id, createdAt: now,
    }),
  ]);
  return { request: await requireRequest(db, id), replayed: false };
}

export async function listPublicAcquisitionReference(db: AcquisitionDatabase): Promise<{ academicYear: string; classes: Array<{ id: string; name: string }> }> {
  const year = await requireActiveAcademicYear(db);
  const rows = await db.prepare(`SELECT id,class_name FROM class_years WHERE academic_year_id=? AND status='active' ORDER BY grade,class_name,id LIMIT 200`).bind(year.id).all<{ id: string; class_name: string }>();
  return { academicYear: year.label, classes: (rows.results ?? []).map((row) => ({ id: row.id, name: row.class_name })) };
}

export async function cancelTeacherAcquisitionRequest(
  db: AcquisitionDatabase,
  teacher: VisitTeacherIdentity,
  requestId: string,
  input: AcquisitionCancelInput,
): Promise<AcquisitionProjection> {
  const now = new Date().toISOString();
  await requireActiveTeacher(db, teacher, now);
  const current = await requireRequest(db, requestId);
  if (current.teacherUserId !== teacher.teacherUserId) throw new AcquisitionStoreError("request_not_found", 404, "Заявку не знайдено.");
  if (!ACTIVE_STATUSES.includes(current.status) || current.status === "ordered" || current.status === "partially_received") {
    throw new AcquisitionStoreError("request_not_cancellable", 409, "Цю заявку вже не можна скасувати самостійно.");
  }
  if (current.version !== input.expectedVersion) throw conflict(current.version);
  let results: D1Result[];
  try {
    results = await db.batch([
      db.prepare(`UPDATE acquisition_requests SET status='cancelled',cancelled_at=?,updated_at=?,version=version+1 WHERE id=? AND teacher_user_id=? AND version=?`)
        .bind(now, now, requestId, teacher.teacherUserId, input.expectedVersion),
      db.prepare(`INSERT INTO acquisition_request_events (id,request_id,actor_user_id,actor_kind,kind,from_status,to_status,metadata_json,created_at)
        VALUES (?,(SELECT id FROM acquisition_requests WHERE id=? AND teacher_user_id=? AND version=? AND status='cancelled' AND updated_at=? AND changes()=1),?,'teacher','cancelled',?,'cancelled',?,?)`)
        .bind(`AQE-${crypto.randomUUID()}`, requestId, teacher.teacherUserId, input.expectedVersion + 1, now,
          teacher.teacherUserId, current.status, JSON.stringify({ reason: input.reason }), now),
    ]);
  } catch (error) {
    if (constraintFailure(error)) throw conflict(current.version);
    throw error;
  }
  if (!number(results[0]?.meta?.changes)) throw conflict(current.version);
  return requireRequest(db, requestId);
}

export async function applyLibrarianAcquisitionAction(
  db: AcquisitionDatabase,
  user: ChatGPTUser,
  requestId: string,
  input: AcquisitionActionInput,
): Promise<AcquisitionProjection> {
  const actor = actorFromUser(user);
  const now = new Date().toISOString();
  const current = await requireRequest(db, requestId);
  if (current.version !== input.expectedVersion) throw conflict(current.version);
  let next = current.status;
  let approved = current.approvedQuantity;
  let ordered = current.orderedQuantity;
  let received = current.receivedQuantity;
  let materialId = current.materialId;
  let clarification = current.clarificationMessage;
  let rejection = current.rejectionReason;
  let receiptAllocation = 0;
  const timestamps: Record<string, string | null> = { reviewed: null, approved: null, ordered: null, received: null, rejected: null, cancelled: null };

  if (input.action === "start_review") {
    allow(current.status, ["submitted", "clarification"]); next = "in_review"; timestamps.reviewed = now;
  } else if (input.action === "request_clarification") {
    allow(current.status, ["submitted", "in_review", "approved", "planned"]); next = "clarification"; clarification = input.message;
  } else if (input.action === "approve") {
    allow(current.status, ["submitted", "in_review", "clarification"]);
    if (input.approvedQuantity === null || input.approvedQuantity < 1) throw new AcquisitionStoreError("invalid_quantity", 400, "Погоджена кількість має бути не меншою за 1.");
    next = "approved"; approved = input.approvedQuantity; timestamps.approved = now;
  } else if (input.action === "plan") {
    allow(current.status, ["approved"]); next = "planned";
  } else if (input.action === "order") {
    allow(current.status, ["approved", "planned", "ordered"]); ordered = input.orderedQuantity ?? 0;
    const cap = approved ?? current.requestedQuantity;
    if (ordered < 1 || ordered > cap) throw new AcquisitionStoreError("invalid_quantity", 400, `Замовлена кількість має бути від 1 до ${cap}.`);
    if (ordered < received) throw new AcquisitionStoreError("invalid_quantity", 400, "Замовлена кількість не може бути меншою за вже отриману.");
    next = received > 0 ? "partially_received" : "ordered"; timestamps.ordered = now;
  } else if (input.action === "link_material") {
    allow(current.status, ["approved", "planned", "ordered", "partially_received"]);
    const material = await db.prepare(`SELECT id FROM materials WHERE id=? AND status='active' LIMIT 1`).bind(input.targetMaterialId).first<{ id: string }>();
    if (!material) throw new AcquisitionStoreError("material_not_found", 404, "Матеріал із таким CAT-ID не знайдено.");
    if (current.receivedQuantity > 0 && material.id !== current.materialId) {
      throw new AcquisitionStoreError("material_change_after_receipt", 409, "Після прив’язування надходження матеріал заявки змінювати не можна.");
    }
    materialId = material.id;
  } else if (input.action === "link_receipt") {
    allow(current.status, ["ordered", "partially_received"]);
    if (!current.materialId) throw new AcquisitionStoreError("material_link_required", 409, "Спочатку створіть або прив’яжіть матеріал у каталозі.");
    const line = await db.prepare(`
      SELECT line.id,line.material_id,line.quantity_delta,tx.status,tx.kind,
        COALESCE((SELECT SUM(a.allocated_quantity) FROM acquisition_receipt_allocations a WHERE a.inventory_transaction_line_id=line.id),0) allocated
      FROM inventory_transaction_lines line JOIN inventory_transactions tx ON tx.id=line.transaction_id
      JOIN acquisition_requests ar ON ar.id=?
      WHERE line.id=?
        AND date(tx.occurred_at)>=date(COALESCE(ar.ordered_at,ar.submitted_at))
        AND tx.created_at>=COALESCE(ar.ordered_at,ar.submitted_at) LIMIT 1
    `).bind(requestId, input.receiptLineId).first<{ id: string; material_id: string; quantity_delta: number; status: string; kind: string; allocated: number }>();
    if (!line || line.kind !== "receipt" || line.status !== "posted" || line.material_id !== current.materialId || line.quantity_delta <= 0) {
      throw new AcquisitionStoreError("receipt_line_invalid", 409, "Рядок не належить чинному надходженню цього матеріалу.");
    }
    const allocation = input.allocatedQuantity ?? 0;
    if (allocation < 1 || number(line.allocated) + allocation > line.quantity_delta) throw new AcquisitionStoreError("receipt_allocation_exceeded", 409, "Ця кількість перевищує невикористаний залишок рядка надходження.");
    if (received + allocation > ordered) throw new AcquisitionStoreError("received_quantity_exceeded", 409, "Отримана кількість не може перевищувати замовлену.");
    receiptAllocation = allocation;
    received += allocation;
    next = received === ordered ? "received" : "partially_received";
    if (next === "received") timestamps.received = now;
  } else if (input.action === "reject") {
    allow(current.status, ACTIVE_STATUSES.filter((status) => status !== "partially_received")); next = "rejected"; rejection = input.message; timestamps.rejected = now;
  } else if (input.action === "cancel") {
    allow(current.status, ACTIVE_STATUSES.filter((status) => status !== "partially_received")); next = "cancelled"; timestamps.cancelled = now;
  }

  const notificationId = current.teacherUserId ? `PN-${crypto.randomUUID()}` : null;
  const auditRequestId = input.mutationId;
  const statements: D1Statement[] = [
    db.prepare(`UPDATE acquisition_requests SET status=?,approved_quantity=?,ordered_quantity=?,received_quantity=?,material_id=?,
      librarian_note=?,clarification_message=?,rejection_reason=?,reviewed_by_user_id=?,
      reviewed_at=COALESCE(?,reviewed_at),approved_at=COALESCE(?,approved_at),ordered_at=COALESCE(?,ordered_at),
      received_at=COALESCE(?,received_at),rejected_at=COALESCE(?,rejected_at),cancelled_at=COALESCE(?,cancelled_at),
      updated_at=?,version=version+1 WHERE id=? AND version=?`)
      .bind(next, approved, ordered, received, materialId, input.message, clarification, rejection, actor.id,
        timestamps.reviewed, timestamps.approved, timestamps.ordered, timestamps.received, timestamps.rejected, timestamps.cancelled,
        now, requestId, input.expectedVersion),
  ];
  if (input.action === "link_receipt") {
    statements.push(db.prepare(`INSERT INTO acquisition_receipt_allocations
      (id,request_id,inventory_transaction_line_id,allocated_quantity,actor_user_id,created_at)
      VALUES (?,
        (SELECT id FROM acquisition_requests WHERE id=? AND version=? AND updated_at=? AND received_quantity<=ordered_quantity AND changes()=1),
        (SELECT line.id FROM inventory_transaction_lines line
          JOIN inventory_transactions tx ON tx.id=line.transaction_id
          JOIN acquisition_requests ar ON ar.id=?
          WHERE line.id=? AND tx.kind='receipt' AND tx.status='posted' AND line.quantity_delta>0
            AND line.material_id=ar.material_id
            AND date(tx.occurred_at)>=date(COALESCE(ar.ordered_at,ar.submitted_at))
            AND tx.created_at>=COALESCE(ar.ordered_at,ar.submitted_at)
            AND COALESCE((SELECT SUM(a.allocated_quantity) FROM acquisition_receipt_allocations a WHERE a.inventory_transaction_line_id=line.id),0)+?<=line.quantity_delta
            AND ar.version=? AND ar.updated_at=? AND changes()=1),
        ?,?,?)
      ON CONFLICT(request_id,inventory_transaction_line_id) DO UPDATE SET
        allocated_quantity=acquisition_receipt_allocations.allocated_quantity+excluded.allocated_quantity,
        actor_user_id=excluded.actor_user_id`)
      .bind(`ARA-${crypto.randomUUID()}`, requestId, input.expectedVersion + 1, now,
        requestId, input.receiptLineId, receiptAllocation, input.expectedVersion + 1, now,
        receiptAllocation, actor.id, now));
  }
  const guardedEventRequestSql = input.action === "link_receipt"
    ? "?"
    : "(SELECT id FROM acquisition_requests WHERE id=? AND version=? AND updated_at=? AND changes()=1)";
  statements.push(
    db.prepare(`INSERT INTO acquisition_request_events (id,request_id,actor_user_id,actor_kind,kind,from_status,to_status,metadata_json,created_at) VALUES (?,${guardedEventRequestSql},?,'librarian',?,?,?,?,?)`)
      .bind(`AQE-${crypto.randomUUID()}`,
        ...(input.action === "link_receipt" ? [requestId] : [requestId, input.expectedVersion + 1, now]),
        actor.id, input.action, current.status, next, JSON.stringify({ message: input.message, approved, ordered, received, materialId }), now),
    db.prepare(`INSERT INTO audit_events (id,actor_user_id,actor_email,action,entity_type,entity_id,request_id,before_json,after_json,metadata_json,created_at) VALUES (?,?,?,?,'acquisition_request',?,?,?,?,NULL,?)`)
      .bind(`AUD-${crypto.randomUUID()}`, actor.id, actor.email, `acquisition_request.${input.action}`, requestId, auditRequestId, JSON.stringify(current), JSON.stringify({ status: next, approved, ordered, received, materialId }), now),
  );
  if (notificationId && current.teacherUserId) {
    const copy = statusCopy(next, current.title, input.message);
    statements.push(
      db.prepare(`INSERT INTO portal_notifications (id,teacher_user_id,dedupe_key,type,title,message,entity_type,entity_id,read_at,version,created_at,updated_at) VALUES (?,?,?,?,?,?,'acquisition_request',?,NULL,1,?,?)`)
        .bind(notificationId, current.teacherUserId, `acquisition:${requestId}:v${current.version + 1}`, "acquisition_status_changed", copy.title, copy.message, requestId, now, now),
      queueTelegramFromPortalNotificationStatement(db, notificationId, "orders", "/teacher?tab=acquisition", now),
    );
  }
  let results: D1Result[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    if (constraintFailure(error)) {
      if (input.action === "link_receipt") {
        throw new AcquisitionStoreError("receipt_allocation_conflict", 409, "Надходження або його вільна кількість уже змінилися. Оновіть заявку.");
      }
      throw conflict(current.version);
    }
    throw error;
  }
  if (!number(results[0]?.meta?.changes)) throw conflict(current.version);
  return requireRequest(db, requestId);
}

export async function previewAcquisitionImport(
  db: AcquisitionDatabase,
  rows: AcquisitionImportRowInput[],
): Promise<{ valid: boolean; rows: Array<AcquisitionImportRowInput & { valid: boolean; errors: string[]; resolvedTeacherUserId: string; resolvedTeacherName: string; resolvedClassYearId: string; existingRequestId: string; duplicateCount: number }>; totals: { rows: number; valid: number; errors: number; duplicates: number; existing: number } }> {
  const year = await requireActiveAcademicYear(db);
  const existingNumbers = [...new Set(rows.map((row) => row.existingRequestNumber).filter(Boolean))];
  const materialIds = [...new Set(rows.map((row) => row.materialId).filter((value): value is string => Boolean(value)))];
  const duplicateKeys = [...new Set(rows.filter((row) => !row.existingRequestNumber).map(acquisitionDuplicateKey))];
  const existingRows = existingNumbers.length
    ? await db.prepare(`SELECT id,public_number FROM acquisition_requests WHERE public_number IN (SELECT value FROM json_each(?)) LIMIT 500`)
      .bind(JSON.stringify(existingNumbers)).all<{ id: string; public_number: string }>()
    : { results: [] };
  const teacherRows = await db.prepare(`SELECT u.id,u.full_name FROM users u JOIN teacher_profiles tp ON tp.teacher_user_id=u.id AND tp.closed_at IS NULL WHERE u.status='active' ORDER BY u.id LIMIT 5000`)
    .all<{ id: string; full_name: string }>();
  const classRows = await db.prepare(`SELECT id,class_name FROM class_years WHERE academic_year_id=? AND status='active' ORDER BY id LIMIT 1000`)
    .bind(year.id).all<{ id: string; class_name: string }>();
  const materialRows = materialIds.length
    ? await db.prepare(`SELECT id FROM materials WHERE status='active' AND id IN (SELECT value FROM json_each(?)) LIMIT 500`)
      .bind(JSON.stringify(materialIds)).all<{ id: string }>()
    : { results: [] };
  const duplicateRows = duplicateKeys.length
    ? await db.prepare(`SELECT duplicate_key,COUNT(*) count FROM acquisition_requests WHERE academic_year_id=? AND duplicate_key IN (SELECT value FROM json_each(?)) GROUP BY duplicate_key LIMIT 500`)
      .bind(year.id, JSON.stringify(duplicateKeys)).all<{ duplicate_key: string; count: number }>()
    : { results: [] };
  const existingByNumber = new Map((existingRows.results ?? []).map((item) => [item.public_number, item.id]));
  const teachersById = new Map((teacherRows.results ?? []).map((item) => [item.id, item]));
  const teachersByName = new Map<string, Array<{ id: string; full_name: string }>>();
  for (const teacher of teacherRows.results ?? []) {
    const key = normalizedAcquisitionText(teacher.full_name);
    teachersByName.set(key, [...(teachersByName.get(key) ?? []), teacher]);
  }
  const classesByName = new Map((classRows.results ?? []).map((item) => [normalizedAcquisitionText(item.class_name), item]));
  const activeMaterialIds = new Set((materialRows.results ?? []).map((item) => item.id));
  const duplicateCounts = new Map((duplicateRows.results ?? []).map((item) => [item.duplicate_key, number(item.count)]));
  const output = [];
  for (const row of rows) {
    const errors: string[] = [];
    let resolvedTeacherUserId = row.teacherUserId, resolvedTeacherName = row.teacherName, resolvedClassYearId = "";
    let existingRequestId = "";
    if (row.existingRequestNumber) {
      const existingId = existingByNumber.get(row.existingRequestNumber);
      if (!existingId) errors.push("REQUEST-ID не знайдено. Очистьте його, якщо це нова заявка.");
      else existingRequestId = existingId;
      output.push({ ...row, valid: errors.length === 0, errors, resolvedTeacherUserId, resolvedTeacherName, resolvedClassYearId, existingRequestId, duplicateCount: 0 });
      continue;
    }
    if (row.requesterKind === "teacher") {
      if (row.teacherUserId) {
        const teacher = teachersById.get(row.teacherUserId);
        if (!teacher) errors.push("Учителя не знайдено або картка закрита.");
        else { resolvedTeacherUserId = teacher.id; resolvedTeacherName = teacher.full_name; }
      } else {
        const teachers = teachersByName.get(normalizedAcquisitionText(row.teacherName)) ?? [];
        if (teachers.length < 1) errors.push("Учителя не знайдено або картка закрита.");
        else if (teachers.length > 1) errors.push("Знайдено кількох учителів з таким ПІБ. Укажіть точний USR-ID.");
        else { resolvedTeacherUserId = teachers[0].id; resolvedTeacherName = teachers[0].full_name; }
      }
    } else {
      const cls = classesByName.get(normalizedAcquisitionText(row.studentClassName));
      if (!cls) errors.push("Клас не знайдено в активному навчальному році."); else resolvedClassYearId = cls.id;
    }
    if (row.materialId) {
      if (!activeMaterialIds.has(row.materialId)) errors.push("CAT-ID не знайдено в активному каталозі.");
    }
    const duplicateKey = acquisitionDuplicateKey(row);
    output.push({ ...row, valid: errors.length === 0, errors, resolvedTeacherUserId, resolvedTeacherName, resolvedClassYearId, existingRequestId, duplicateCount: duplicateCounts.get(duplicateKey) ?? 0 });
  }
  const valid = output.filter((row) => row.valid).length;
  const duplicates = output.filter((row) => row.duplicateCount > 0).length;
  const existing = output.filter((row) => row.existingRequestId).length;
  return { valid: valid === output.length, rows: output, totals: { rows: output.length, valid, errors: output.length - valid, duplicates, existing } };
}

export async function commitAcquisitionImport(db: AcquisitionDatabase, user: ChatGPTUser, input: AcquisitionImportInput): Promise<{ replayed: boolean; imported: number; batchId: string }> {
  const actor = actorFromUser(user);
  const prior = await db.prepare(`SELECT id,imported_count FROM acquisition_import_batches WHERE workbook_sha256=? LIMIT 1`).bind(input.fileHash).first<{ id: string; imported_count: number }>();
  if (prior) return { replayed: true, imported: prior.imported_count, batchId: prior.id };
  const preview = await previewAcquisitionImport(db, input.rows);
  if (!preview.valid) throw new AcquisitionStoreError("import_validation_failed", 400, "Файл містить помилки. Виправте їх перед імпортом.", { preview });
  const now = new Date().toISOString();
  const year = await requireActiveAcademicYear(db);
  const batchId = `AIB-${input.importId}`;
  const newRows = preview.rows.filter((row) => !row.existingRequestId);
  const statements: D1Statement[] = [];
  statements.push(db.prepare(`INSERT INTO acquisition_import_batches (id,workbook_sha256,file_name,row_count,imported_count,status,result_json,created_by_user_id,created_at) VALUES (?,?,?,?,?,'completed',?,?,?)`)
    .bind(batchId, input.fileHash, input.fileName, input.rows.length, newRows.length, JSON.stringify(preview.totals), actor.id, now));
  newRows.forEach((row, index) => {
    const requestUuid = crypto.randomUUID();
    const id = `ACQ-${requestUuid}`;
    const publicNumber = publicRequestNumber(requestUuid, now);
    const sourceImportKey = `${input.fileHash}:${row.sourceSheet}:${row.sourceRow}`;
    const requesterName = row.requesterKind === "teacher" ? row.resolvedTeacherName : row.studentName;
    const teacherId = row.requesterKind === "teacher" ? row.resolvedTeacherUserId : null;
    const classYearId = row.requesterKind === "student" ? row.resolvedClassYearId : null;
    const className = row.requesterKind === "student" ? row.studentClassName : "";
    const duplicateKey = acquisitionDuplicateKey(row);
    const submissionHash = input.fileHash;
    statements.push(
      db.prepare(`INSERT INTO acquisition_requests (
        id,public_number,submission_key,submission_hash,requester_kind,teacher_user_id,requester_name,requester_class_year_id,requester_class_name,
        category,source_kind,literature_kind,material_id,title,author,publication_year,requested_quantity,approved_quantity,ordered_quantity,received_quantity,
        source_url,subject,target_class,requester_note,librarian_note,clarification_message,rejection_reason,status,duplicate_key,
        academic_year_id,academic_year_label,import_batch_id,source_import_key,reviewed_by_user_id,version,submitted_at,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,NULL,0,0, ?,?,?,?,'','','','submitted', ?,?,?,?,?,?,1,?,?,?)`)
        .bind(id, publicNumber, `import:${sourceImportKey}`, submissionHash, row.requesterKind, teacherId, requesterName, classYearId, className,
          row.category, row.sourceKind, row.literatureKind, row.materialId, row.title, row.author, row.publicationYear, row.requestedQuantity,
          row.sourceUrl, row.subject, row.targetClass, row.note, duplicateKey, year.id, year.label, batchId, sourceImportKey, actor.id, now, now, now),
      db.prepare(`INSERT INTO acquisition_request_events (id,request_id,actor_user_id,actor_kind,kind,from_status,to_status,metadata_json,created_at) VALUES (?,?,?,'import','imported',NULL,'submitted',?,?)`)
        .bind(`AQE-${crypto.randomUUID()}`, id, actor.id, JSON.stringify({ sheet: row.sourceSheet, row: row.sourceRow, index }), now),
    );
  });
  await db.batch(statements);
  return { replayed: false, imported: newRows.length, batchId };
}

export async function listAcquisitionExportRows(db: AcquisitionDatabase): Promise<AcquisitionProjection[]> {
  const rows = await db.prepare(`${projectionSql()} ORDER BY ar.created_at ASC,ar.id ASC LIMIT 10000`).all<RequestRow>();
  return (rows.results ?? []).map(projectRequest);
}

export async function listAcquisitionReceiptOptions(
  db: AcquisitionDatabase,
  requestId: string,
): Promise<Array<{ lineId: string; occurredAt: string; locationName: string; receivedQuantity: number; unallocatedQuantity: number }>> {
  const request = await requireRequest(db, requestId);
  if (!request.materialId) return [];
  const rows = await db.prepare(`
    SELECT line.id line_id,tx.occurred_at,l.name location_name,line.quantity_delta received_quantity,
      line.quantity_delta-COALESCE((SELECT SUM(a.allocated_quantity) FROM acquisition_receipt_allocations a WHERE a.inventory_transaction_line_id=line.id),0) unallocated_quantity
    FROM inventory_transaction_lines line
    JOIN inventory_transactions tx ON tx.id=line.transaction_id
    JOIN locations l ON l.id=line.location_id
    WHERE line.material_id=? AND tx.kind='receipt' AND tx.status='posted' AND line.quantity_delta>0
      AND line.quantity_delta>COALESCE((SELECT SUM(a.allocated_quantity) FROM acquisition_receipt_allocations a WHERE a.inventory_transaction_line_id=line.id),0)
      AND date(tx.occurred_at) >= date((SELECT COALESCE(ordered_at,submitted_at) FROM acquisition_requests WHERE id=?))
      AND tx.created_at >= (SELECT COALESCE(ordered_at,submitted_at) FROM acquisition_requests WHERE id=?)
      ORDER BY tx.occurred_at DESC,line.id DESC LIMIT 30
  `).bind(request.materialId, requestId, requestId).all<Record<string, string | number>>();
  return (rows.results ?? []).filter((row) => number(row.unallocated_quantity) > 0).map((row) => ({
    lineId: String(row.line_id), occurredAt: String(row.occurred_at), locationName: String(row.location_name),
    receivedQuantity: number(row.received_quantity), unallocatedQuantity: number(row.unallocated_quantity),
  }));
}

async function existingSubmission(db: AcquisitionDatabase, key: string, hash: string): Promise<AcquisitionProjection | null> {
  const row = await db.prepare(`SELECT id,submission_hash FROM acquisition_requests WHERE submission_key=? LIMIT 1`).bind(key).first<{ id: string; submission_hash: string }>();
  if (!row) return null;
  if (row.submission_hash !== hash) throw new AcquisitionStoreError("idempotency_conflict", 409, "Цей ідентифікатор уже використано для іншої заявки.");
  return requireRequest(db, row.id);
}

async function requireRequest(db: AcquisitionDatabase, id: string): Promise<AcquisitionProjection> {
  const row = await db.prepare(`${projectionSql()} WHERE ar.id=? LIMIT 1`).bind(id).first<RequestRow>();
  if (!row) throw new AcquisitionStoreError("request_not_found", 404, "Заявку не знайдено.");
  return projectRequest(row);
}

function projectionSql(): string {
  return `SELECT ar.id,ar.public_number,ar.requester_kind,ar.teacher_user_id,ar.requester_name,ar.requester_class_name,
    ar.category,ar.source_kind,ar.literature_kind,ar.material_id,ar.title,ar.author,ar.publication_year,
    ar.requested_quantity,ar.approved_quantity,ar.ordered_quantity,ar.received_quantity,ar.source_url,ar.subject,ar.target_class,
    ar.requester_note,ar.librarian_note,ar.clarification_message,ar.rejection_reason,ar.status,ar.duplicate_key,
    ar.academic_year_label,ar.version,ar.submitted_at,ar.updated_at,
    (SELECT COUNT(*) FROM acquisition_requests dup WHERE dup.academic_year_id=ar.academic_year_id AND dup.duplicate_key=ar.duplicate_key) duplicate_count
    FROM acquisition_requests ar`;
}

function projectRequest(row: RequestRow): AcquisitionProjection {
  return {
    id: row.id, publicNumber: row.public_number, requesterKind: row.requester_kind, teacherUserId: row.teacher_user_id,
    requesterName: row.requester_name, requesterClassName: row.requester_class_name, category: row.category, sourceKind: row.source_kind,
    literatureKind: row.literature_kind, materialId: row.material_id, title: row.title, author: row.author,
    publicationYear: nullableNumber(row.publication_year), requestedQuantity: number(row.requested_quantity), approvedQuantity: nullableNumber(row.approved_quantity),
    orderedQuantity: number(row.ordered_quantity), receivedQuantity: number(row.received_quantity), sourceUrl: row.source_url,
    subject: row.subject, targetClass: row.target_class, requesterNote: row.requester_note, librarianNote: row.librarian_note,
    clarificationMessage: row.clarification_message, rejectionReason: row.rejection_reason, status: row.status,
    duplicateKey: row.duplicate_key, duplicateCount: number(row.duplicate_count), academicYearLabel: row.academic_year_label,
    version: number(row.version), submittedAt: row.submitted_at, updatedAt: row.updated_at,
  };
}

async function requireActiveAcademicYear(db: AcquisitionDatabase): Promise<AcademicYearRow> {
  const rows = await db.prepare(`SELECT id,label FROM academic_years WHERE status='active' ORDER BY start_date DESC,id LIMIT 2`).all<AcademicYearRow>();
  if ((rows.results ?? []).length !== 1) throw new AcquisitionStoreError("academic_year_unavailable", 409, "Потрібно налаштувати один активний навчальний рік.");
  return (rows.results ?? [])[0];
}

async function requireActiveTeacher(db: AcquisitionDatabase, teacher: VisitTeacherIdentity, now: string): Promise<void> {
  const row = await db.prepare(`
    SELECT u.id FROM users u
    JOIN teacher_profiles tp ON tp.teacher_user_id=u.id AND tp.closed_at IS NULL
    JOIN visit_teacher_credentials c ON c.teacher_user_id=u.id
    JOIN visit_teacher_sessions s ON s.teacher_user_id=u.id AND s.credential_version=c.version
    WHERE u.id=? AND u.full_name=? AND u.status='active' AND c.status='active' AND c.version=?
      AND s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? LIMIT 1
  `).bind(teacher.teacherUserId, teacher.fullName, teacher.credentialVersion, teacher.tokenHash, now).first();
  if (!row) throw new AcquisitionStoreError("teacher_access_revoked", 401, "Доступ учителя змінився. Увійдіть ще раз.");
}

async function enforcePublicLimit(db: AcquisitionDatabase, request: Request, now: string, secret: string): Promise<void> {
  if (!secret || secret.length < 32) throw new AcquisitionStoreError("public_form_unavailable", 503, "Форма тимчасово недоступна.");
  const ip = request.headers.get("CF-Connecting-IP")?.trim() || "";
  if (!ip) throw new AcquisitionStoreError("public_form_unavailable", 503, "Форма тимчасово недоступна.");
  const scope = await hmacSha256(secret, `student-book-suggestion-ip-v1\n${ip}`);
  const accepted = await db.prepare(`
    INSERT INTO acquisition_public_rate_limits (scope_hash,attempts,window_started_at,updated_at)
    VALUES (?,1,?,?)
    ON CONFLICT(scope_hash) DO UPDATE SET
      attempts=CASE WHEN unixepoch(?) - unixepoch(window_started_at) >= 3600 THEN 1 ELSE attempts+1 END,
      window_started_at=CASE WHEN unixepoch(?) - unixepoch(window_started_at) >= 3600 THEN excluded.window_started_at ELSE window_started_at END,
      updated_at=excluded.updated_at
    WHERE unixepoch(?) - unixepoch(window_started_at) >= 3600 OR attempts < 5
    RETURNING attempts
  `).bind(scope, now, now, now, now, now).first<{ attempts: number }>();
  if (!accepted) throw new AcquisitionStoreError("rate_limited", 429, "Забагато пропозицій. Спробуйте пізніше.");
}

function allow(status: AcquisitionStatus, allowed: AcquisitionStatus[]): void {
  if (!allowed.includes(status)) throw new AcquisitionStoreError("invalid_status_transition", 409, "Ця дія недоступна для поточного стану заявки.", { currentStatus: status });
}
function conflict(version: number): AcquisitionStoreError { return new AcquisitionStoreError("version_conflict", 409, "Заявку вже змінено. Оновіть список.", { currentVersion: version }); }
function actorFromUser(user: ChatGPTUser): Actor {
  const id = user.d1UserId ?? "";
  if (!id) throw new AcquisitionStoreError("librarian_identity_unavailable", 503, "Не вдалося визначити обліковий запис бібліотекаря.");
  return { id, email: user.email || `user:${id}` };
}
function publicRequestNumber(requestId: string, now: string): string { return `КФ-${now.slice(0, 4)}-${requestId.replaceAll("-", "").slice(0, 8).toUpperCase()}`; }
function requestAuditSnapshot(value: Record<string, unknown>): Record<string, unknown> { return value; }
function statusCopy(status: AcquisitionStatus, title: string, message: string): { title: string; message: string } {
  const labels: Record<AcquisitionStatus, string> = {
    submitted: "Подано", in_review: "Розглядається", clarification: "Потрібне уточнення", approved: "Погоджено",
    planned: "Заплановано", ordered: "Замовлено", partially_received: "Частково отримано", received: "Отримано",
    rejected: "Відхилено", cancelled: "Скасовано",
  };
  return { title: `Комплектування: ${labels[status]}`, message: `«${title}».${message ? ` ${message}` : ""}` };
}
function number(value: unknown): number { const result = Number(value); return Number.isFinite(result) ? result : 0; }
function constraintFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("NOT NULL constraint failed") || message.includes("UNIQUE constraint failed");
}
function nullableNumber(value: unknown): number | null { return value === null || value === undefined ? null : number(value); }
async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function hmacSha256(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
