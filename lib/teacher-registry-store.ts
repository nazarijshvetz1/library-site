import type { ChatGPTUser } from "../app/chatgpt-auth.ts";
import type {
  TeacherCreateInput,
  TeacherDeleteInput,
  TeacherUpdateInput,
} from "./teacher-registry-validation.ts";
import { normalizeTeacherName, teacherSortName } from "./teacher-registry-validation.ts";

type D1Value = string | number | null;
type D1Result<T = unknown> = { results?: T[]; success?: boolean; meta?: { changes?: number } };
type D1Statement = {
  bind(...values: D1Value[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
};
export type TeacherRegistryDatabase = {
  prepare(sql: string): D1Statement;
  batch<T = unknown>(statements: D1Statement[]): Promise<Array<D1Result<T>>>;
};

export type TeacherStatus = "active" | "inactive";
export type TeacherListOptions = {
  status: TeacherStatus | "all";
  attention: "all" | "orders" | "overdue" | "visits" | "access";
  query: string;
  limit: number;
  cursor: string | null;
};

export class TeacherRegistryError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    status: number,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TeacherRegistryError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

type TeacherBaseRow = {
  id: string;
  full_name: string;
  account_role: "teacher" | "admin" | "librarian";
  user_status: TeacherStatus;
  subject_position: string | null;
  primary_location_id: string | null;
  location_name: string | null;
  service_contact: string | null;
  librarian_note: string | null;
  version: number | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  credential_status: "active" | "disabled" | null;
  credential_version: number | null;
  last_login_at: string | null;
  locked_until: string | null;
  active_sessions: number;
  open_requests: number;
  open_loans: number;
  overdue_loans: number;
  ready_uncollected: number;
  upcoming_visits: number;
};

export async function listTeacherRegistry(
  db: TeacherRegistryDatabase,
  options: TeacherListOptions,
) {
  const now = new Date().toISOString();
  const cursor = decodeCursor(options.cursor);
  const where: string[] = ["1=1"];
  const today = kyivDate(now);
  const values: D1Value[] = [now, now, today];
  if (options.status !== "all") {
    where.push("CASE WHEN u.status='active' AND p.closed_at IS NULL THEN 'active' ELSE 'inactive' END=?");
    values.push(options.status);
  }
  const query = options.query.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (query) {
    where.push("instr(u.sort_name, ?) > 0");
    values.push(teacherSortName(query));
  }
  if (options.attention === "orders") where.push(`EXISTS(SELECT 1 FROM material_requests filter_mr
    WHERE filter_mr.teacher_user_id=u.id AND filter_mr.status IN ('submitted','in_review','ready','partially_ready'))`);
  if (options.attention === "overdue") {
    where.push(`EXISTS(SELECT 1 FROM loans filter_loan WHERE filter_loan.teacher_user_id=u.id
      AND filter_loan.status='open' AND filter_loan.due_at IS NOT NULL AND filter_loan.due_at<?)`);
    values.push(now);
  }
  if (options.attention === "visits") {
    where.push(`EXISTS(SELECT 1 FROM visit_bookings filter_visit WHERE
      (filter_visit.owner_user_id=u.id OR filter_visit.selected_teacher_user_id=u.id)
      AND filter_visit.status='active' AND filter_visit.visit_date>=?)`);
    values.push(today);
  }
  if (options.attention === "access") {
    where.push(`u.status='active' AND p.closed_at IS NULL AND (c.teacher_user_id IS NULL OR c.status='disabled'
      OR (c.status='active' AND c.locked_until>?))`);
    values.push(now);
  }
  if (cursor) {
    where.push("(u.sort_name > ? OR (u.sort_name=? AND u.id>?))");
    values.push(cursor.sortName, cursor.sortName, cursor.id);
  }
  values.push(options.limit + 1);
  const rows = await db.prepare(`${teacherSelectSql()}
    WHERE ${where.join(" AND ")}
    ORDER BY u.sort_name,u.id LIMIT ?`).bind(...values).all<TeacherBaseRow>();
  const all = rows.results ?? [];
  const pageRows = all.slice(0, options.limit);
  const teachers = pageRows.map((row) => projectTeacher(row, now, false));
  const last = pageRows.at(-1);
  const [counts, locations] = await Promise.all([
    registryCounters(db, now),
    db.prepare(`SELECT id,name,type FROM locations WHERE status='active'
      ORDER BY sort_order,name,id`).all<{ id: string; name: string; type: string }>(),
  ]);
  return {
    counters: counts,
    teachers,
    locations: locations.results ?? [],
    page: {
      limit: options.limit,
      hasMore: all.length > options.limit,
      nextCursor: all.length > options.limit && last
        ? encodeCursor({ sortName: teacherSortName(last.full_name), id: last.id })
        : null,
    },
  };
}

export async function getTeacherRegistryDetail(db: TeacherRegistryDatabase, teacherId: string) {
  const now = new Date().toISOString();
  const row = await db.prepare(`${teacherSelectSql()} WHERE u.id=? LIMIT 1`)
    .bind(now, now, kyivDate(now), teacherId).first<TeacherBaseRow>();
  if (!row) throw new TeacherRegistryError("teacher_not_found", 404, "Картку вчителя не знайдено.");

  const [classes, visits, requests, requestItems, loans, loanItems, classResponsibilities, notifications, history, dependencies] = await Promise.all([
    db.prepare(`SELECT cy.id,cy.class_name,cy.grade,cy.code,cy.status,cy.start_date,cy.end_date,l.name AS location_name
      FROM class_years cy LEFT JOIN locations l ON l.id=cy.location_id
      WHERE cy.teacher_user_id=? ORDER BY CASE cy.status WHEN 'active' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END,cy.end_date DESC,cy.id DESC LIMIT 100`)
      .bind(teacherId).all<Record<string, unknown>>(),
    db.prepare(`SELECT id,owner_kind,surname,class_label,visit_date,start_time,end_time,purpose,status,version
      FROM visit_bookings WHERE (owner_user_id=? OR selected_teacher_user_id=?) AND visit_date>=? AND status='active'
      ORDER BY visit_date,start_time,id LIMIT 100`).bind(teacherId, teacherId, kyivDate(now)).all<Record<string, unknown>>(),
    db.prepare(`SELECT mr.id,mr.status,mr.teacher_notes,mr.librarian_note,mr.version,mr.submitted_at,mr.updated_at,
      COALESCE((SELECT SUM(i.requested_quantity) FROM material_request_items i WHERE i.request_id=mr.id),0) AS requested_quantity
      FROM material_requests mr WHERE mr.teacher_user_id=? ORDER BY mr.created_at DESC,mr.id DESC LIMIT 100`)
      .bind(teacherId).all<Record<string, unknown>>(),
    db.prepare(`SELECT i.id,i.request_id,i.material_id,i.title_snapshot,i.author_snapshot,
      i.requested_quantity,i.approved_quantity,i.fulfilled_quantity,
      COALESCE(SUM(r.reserved_quantity-r.issued_quantity-r.released_quantity),0) AS reserved_quantity
      FROM material_request_items i
      LEFT JOIN material_request_reservations r ON r.request_item_id=i.id
      WHERE i.request_id IN (SELECT id FROM material_requests WHERE teacher_user_id=?
        ORDER BY created_at DESC,id DESC LIMIT 100)
      GROUP BY i.id,i.request_id,i.material_id,i.title_snapshot,i.author_snapshot,
        i.requested_quantity,i.approved_quantity,i.fulfilled_quantity
      ORDER BY i.request_id,i.sort_order,i.id LIMIT 500`).bind(teacherId).all<Record<string, unknown>>(),
    db.prepare(`SELECT l.id,l.status,l.issued_at,l.due_at,l.closed_at,l.notes,l.version,
      COALESCE((SELECT SUM(li.quantity_issued-li.quantity_returned) FROM loan_items li WHERE li.loan_id=l.id),0) AS outstanding_quantity
      FROM loans l WHERE l.teacher_user_id=? ORDER BY l.issued_at DESC,l.id DESC LIMIT 100`)
      .bind(teacherId).all<Record<string, unknown>>(),
    db.prepare(`SELECT li.id,li.loan_id,li.material_id,m.title,m.author,li.source_location_id,
      loc.name AS source_location_name,li.condition,li.quantity_issued,li.quantity_returned,
      (li.quantity_issued-li.quantity_returned) AS outstanding_quantity
      FROM loan_items li JOIN materials m ON m.id=li.material_id
      JOIN locations loc ON loc.id=li.source_location_id
      WHERE li.loan_id IN (SELECT id FROM loans WHERE teacher_user_id=?
        ORDER BY issued_at DESC,id DESC LIMIT 100)
      ORDER BY li.loan_id,li.created_at,li.id LIMIT 500`).bind(teacherId).all<Record<string, unknown>>(),
    db.prepare(`SELECT cl.id,cl.status,cl.issued_at,cl.due_at,cl.closed_at,cl.version,cy.class_name,
      COALESCE((SELECT SUM(cli.quantity_issued-cli.quantity_returned) FROM class_loan_items cli WHERE cli.class_loan_id=cl.id),0) AS outstanding_quantity
      FROM class_loans cl JOIN class_years cy ON cy.id=cl.class_year_id
      WHERE cl.responsible_teacher_user_id=? ORDER BY cl.issued_at DESC,cl.id DESC LIMIT 100`)
      .bind(teacherId).all<Record<string, unknown>>(),
    db.prepare(`SELECT id,type,title,message,entity_type,entity_id,read_at,version,created_at
      FROM portal_notifications WHERE teacher_user_id=? ORDER BY created_at DESC,id DESC LIMIT 50`)
      .bind(teacherId).all<Record<string, unknown>>(),
    db.prepare(`SELECT id,actor_email,action,before_json,after_json,metadata_json,created_at
      FROM audit_events WHERE entity_type='teacher' AND entity_id=? ORDER BY created_at DESC,id DESC LIMIT 100`)
      .bind(teacherId).all<Record<string, unknown>>(),
    dependencySummary(db, teacherId, now),
  ]);
  const notificationItems = notifications.results ?? [];
  return {
    teacher: projectTeacher(row, now, true),
    assignedClasses: classes.results ?? [],
    futureVisits: visits.results ?? [],
    requests: attachChildItems(requests.results ?? [], requestItems.results ?? [], "request_id"),
    loans: attachChildItems(loans.results ?? [], loanItems.results ?? [], "loan_id"),
    classResponsibilities: classResponsibilities.results ?? [],
    notifications: {
      unreadCount: notificationItems.filter((value) => value.read_at === null).length,
      items: notificationItems,
    },
    history: history.results ?? [],
    dependencySummary: dependencies,
  };
}

export async function createTeacherRegistryCard(
  db: TeacherRegistryDatabase,
  actorUser: ChatGPTUser,
  input: TeacherCreateInput,
) {
  const actor = await resolveActor(db, actorUser);
  const requestHash = await sha256Json({ kind: "teacher.create", actor: actor.id, input });
  const replay = await mutationReplay(db, input.requestId, requestHash);
  if (replay) return replay;
  const fullName = normalizeTeacherName(input.fullName);
  await ensureNoDuplicate(db, fullName, null, input.forceDuplicate);
  await ensureLocation(db, input.primaryLocationId);
  const now = new Date().toISOString();
  const teacherId = `USR-TEA-${crypto.randomUUID()}`;
  const result = { teacherId };
  try {
    await db.batch([
      commandStart(db, input.requestId, "teacher.create", actor.id, requestHash, teacherId, now),
      db.prepare(`INSERT INTO users(id,full_name,sort_name,email,auth_user_id,role,status,created_at,updated_at)
        SELECT ?,?,?,NULL,NULL,'teacher','active',?,? WHERE EXISTS(
          SELECT 1 FROM mutation_commands WHERE id=? AND request_hash=? AND status='processing')`)
        .bind(teacherId, fullName, teacherSortName(fullName), now, now, input.requestId, requestHash),
      db.prepare(`INSERT INTO teacher_profiles(teacher_user_id,subject_position,primary_location_id,service_contact,librarian_note,
        version,last_mutation_request_id,closed_at,closed_by_user_id,created_by_user_id,updated_by_user_id,created_at,updated_at)
        SELECT ?,?,?,?,?,1,?,NULL,NULL,?,?,?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=?)
          AND EXISTS(SELECT 1 FROM mutation_commands WHERE id=? AND request_hash=? AND status='processing')`)
        .bind(teacherId, input.subjectPosition, input.primaryLocationId, input.serviceContact, input.librarianNote,
          input.requestId, actor.id, actor.id, now, now, teacherId, input.requestId, requestHash),
      guardedAuditInsert(db, actor, "teacher.created", teacherId, input.requestId, null, {
        fullName, subjectPosition: input.subjectPosition, primaryLocationId: input.primaryLocationId,
        serviceContact: input.serviceContact, librarianNote: input.librarianNote, version: 1,
      }, now, `EXISTS(SELECT 1 FROM users u JOIN teacher_profiles p ON p.teacher_user_id=u.id
        WHERE u.id=? AND u.role='teacher' AND u.status='active' AND u.full_name=? AND u.sort_name=?
          AND p.version=1 AND p.last_mutation_request_id=? AND p.subject_position=?
          AND p.primary_location_id IS ? AND p.service_contact=? AND p.librarian_note=?)`,
        [teacherId, fullName, teacherSortName(fullName), input.requestId, input.subjectPosition,
          input.primaryLocationId, input.serviceContact, input.librarianNote]),
      commandComplete(db, input.requestId, requestHash, result, now),
    ]);
  } catch (error) {
    const recovered = await completedMutationReplay(db, input.requestId, requestHash);
    if (recovered) return recovered;
    throw error;
  }
  return result;
}

export async function updateTeacherRegistryCard(
  db: TeacherRegistryDatabase,
  actorUser: ChatGPTUser,
  teacherId: string,
  input: TeacherUpdateInput,
) {
  const actor = await resolveActor(db, actorUser);
  const requestHash = await sha256Json({ kind: `teacher.${input.action}`, actor: actor.id, teacherId, input });
  const replay = await mutationReplay(db, input.requestId, requestHash);
  if (replay) return replay;
  const current = await getMutableTeacher(db, teacherId);
  if (current.version !== input.expectedVersion) throw versionConflict(current.version);
  if (input.action === "update") {
    const fullName = input.changes.fullName === undefined ? current.fullName : normalizeTeacherName(input.changes.fullName);
    await ensureNoDuplicate(db, fullName, teacherId, input.forceDuplicate);
    const locationId = input.changes.primaryLocationId === undefined ? current.primaryLocationId : input.changes.primaryLocationId;
    await ensureLocation(db, locationId);
    return updateProfile(db, actor, current, input, fullName, locationId, requestHash);
  }
  if (input.action === "close") return closeTeacher(db, actor, current, input, requestHash);
  return restoreTeacher(db, actor, current, input, requestHash);
}

export async function deleteEmptyTeacherRegistryCard(
  db: TeacherRegistryDatabase,
  actorUser: ChatGPTUser,
  teacherId: string,
  input: TeacherDeleteInput,
) {
  const actor = await resolveActor(db, actorUser);
  const requestHash = await sha256Json({ kind: "teacher.delete_empty", actor: actor.id, teacherId, input });
  const replay = await mutationReplay(db, input.requestId, requestHash);
  if (replay) return replay;
  const current = await getMutableTeacher(db, teacherId);
  if (current.version !== input.expectedVersion) throw versionConflict(current.version);
  if (current.accountRole !== "teacher") {
    throw new TeacherRegistryError(
      "teacher_delete_staff_role",
      409,
      "Картку працівника з правами адміністратора або бібліотекаря не можна видалити. Її можна лише закрити.",
      { accountRole: current.accountRole },
    );
  }
  const dependencies = await dependencySummary(db, teacherId, new Date().toISOString());
  if (dependencies.totalDependencies > 0) {
    throw new TeacherRegistryError("teacher_delete_blocked", 409, "Картка має пов’язані дані й не може бути видалена.", { dependencies });
  }
  const now = new Date().toISOString();
  // The audit deliberately does not reference users.id, so the deletion remains documented.
  const result = { deleted: true, teacherId };
  try {
    await db.batch([
      commandStart(db, input.requestId, "teacher.delete_empty", actor.id, requestHash, teacherId, now),
      db.prepare(`DELETE FROM teacher_profiles WHERE teacher_user_id=? AND version=?
        AND EXISTS(SELECT 1 FROM mutation_commands WHERE id=? AND request_hash=? AND status='processing')
        AND ${noTeacherDependenciesSql("teacher_profiles.teacher_user_id")}`)
        .bind(teacherId, input.expectedVersion, input.requestId, requestHash),
      db.prepare(`DELETE FROM users WHERE id=? AND role='teacher'
        AND NOT EXISTS(SELECT 1 FROM teacher_profiles WHERE teacher_user_id=users.id)
        AND ${noTeacherDependenciesSql("users.id")}`)
        .bind(teacherId),
      guardedAuditInsert(db, actor, "teacher.deleted_empty", teacherId, input.requestId, {
        fullName: current.fullName,
        status: current.status,
        version: current.version,
      }, null, now, "NOT EXISTS(SELECT 1 FROM users WHERE id=?)", [teacherId]),
      commandComplete(db, input.requestId, requestHash, result, now),
    ]);
  } catch (error) {
    const recovered = await completedMutationReplay(db, input.requestId, requestHash);
    if (recovered) return recovered;
    const freshDependencies = await dependencySummary(db, teacherId, now);
    if (freshDependencies.totalDependencies > 0) {
      throw new TeacherRegistryError("teacher_delete_blocked", 409, "Картка має пов’язані дані й не може бути видалена.", { dependencies: freshDependencies });
    }
    const fresh = await db.prepare(`SELECT p.version FROM users u JOIN teacher_profiles p ON p.teacher_user_id=u.id
      WHERE u.id=? LIMIT 1`).bind(teacherId).first<{ version: number }>();
    if (fresh && Number(fresh.version) !== input.expectedVersion) throw versionConflict(Number(fresh.version));
    throw error;
  }
  return result;
}

function teacherSelectSql() {
  return `SELECT u.id,u.full_name,u.role AS account_role,
    CASE WHEN u.status='active' AND p.closed_at IS NULL THEN 'active' ELSE 'inactive' END AS user_status,
    p.subject_position,p.primary_location_id,
    loc.name AS location_name,p.service_contact,p.librarian_note,p.version,p.closed_at,
    u.created_at,COALESCE(p.updated_at,u.updated_at) AS updated_at,
    c.status AS credential_status,c.version AS credential_version,c.last_login_at,c.locked_until,
    (SELECT COUNT(*) FROM visit_teacher_sessions s WHERE s.teacher_user_id=u.id AND s.revoked_at IS NULL AND s.expires_at>?) AS active_sessions,
    (SELECT COUNT(*) FROM material_requests mr WHERE mr.teacher_user_id=u.id AND mr.status IN ('submitted','in_review','ready','partially_ready')) AS open_requests,
    (SELECT COUNT(*) FROM loans ln WHERE ln.teacher_user_id=u.id AND ln.status='open') AS open_loans,
    (SELECT COUNT(*) FROM loans ln WHERE ln.teacher_user_id=u.id AND ln.status='open' AND ln.due_at IS NOT NULL AND ln.due_at<?) AS overdue_loans,
    (SELECT COUNT(*) FROM material_requests mr WHERE mr.teacher_user_id=u.id AND mr.status IN ('ready','partially_ready')) AS ready_uncollected
    ,(SELECT COUNT(*) FROM visit_bookings vb WHERE (vb.owner_user_id=u.id OR vb.selected_teacher_user_id=u.id)
      AND vb.status='active' AND vb.visit_date>=?) AS upcoming_visits
    FROM users u JOIN teacher_profiles p ON p.teacher_user_id=u.id
    LEFT JOIN locations loc ON loc.id=p.primary_location_id
    LEFT JOIN visit_teacher_credentials c ON c.teacher_user_id=u.id`;
}

function projectTeacher(row: TeacherBaseRow, now: string, includePrivate: boolean) {
  const version = Number(row.version ?? 1);
  const credentialStatus = row.credential_status === "active" && row.locked_until && row.locked_until > now
    ? "locked" as const
    : row.credential_status;
  return {
    id: row.id,
    fullName: row.full_name,
    accountRole: row.account_role,
    status: row.user_status,
    subjectPosition: row.subject_position ?? "",
    primaryLocation: row.primary_location_id && row.location_name
      ? { id: row.primary_location_id, name: row.location_name }
      : null,
    serviceContact: row.service_contact ?? "",
    ...(includePrivate ? { librarianNote: row.librarian_note ?? "", closedAt: row.closed_at } : {}),
    version,
    access: {
      hasCode: row.credential_status !== null,
      status: credentialStatus,
      version: row.credential_version === null ? null : Number(row.credential_version),
      lastLoginAt: row.last_login_at,
      lockedUntil: row.locked_until,
      activeSessions: Number(row.active_sessions),
    },
    attention: {
      openRequests: Number(row.open_requests),
      openLoans: Number(row.open_loans),
      overdueLoans: Number(row.overdue_loans),
      readyUncollected: Number(row.ready_uncollected),
      openOrders: Number(row.open_requests),
      upcomingVisits: Number(row.upcoming_visits),
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function registryCounters(db: TeacherRegistryDatabase, now: string) {
  const row = await db.prepare(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN u.status='active' AND p.closed_at IS NULL THEN 1 ELSE 0 END) AS active,
    SUM(CASE WHEN u.status<>'active' OR p.closed_at IS NOT NULL THEN 1 ELSE 0 END) AS inactive,
    SUM(CASE WHEN u.status='active' AND p.closed_at IS NULL AND c.teacher_user_id IS NOT NULL THEN 1 ELSE 0 END) AS with_code,
    SUM(CASE WHEN u.status='active' AND p.closed_at IS NULL AND c.teacher_user_id IS NULL THEN 1 ELSE 0 END) AS without_code,
    SUM(CASE WHEN u.status='active' AND p.closed_at IS NULL AND c.status='active' AND c.locked_until>? THEN 1 ELSE 0 END) AS locked,
    SUM(CASE WHEN EXISTS(SELECT 1 FROM loans l WHERE l.teacher_user_id=u.id AND l.status='open') THEN 1 ELSE 0 END) AS with_open_loans,
    SUM(CASE WHEN EXISTS(SELECT 1 FROM loans l WHERE l.teacher_user_id=u.id AND l.status='open' AND l.due_at IS NOT NULL AND l.due_at<?) THEN 1 ELSE 0 END) AS with_overdue_loans,
    SUM(CASE WHEN EXISTS(SELECT 1 FROM material_requests mr WHERE mr.teacher_user_id=u.id AND mr.status IN ('submitted','in_review','ready','partially_ready')) THEN 1 ELSE 0 END) AS with_open_requests
    ,(SELECT COUNT(*) FROM material_requests WHERE status='submitted') AS new_orders
    ,(SELECT COUNT(*) FROM material_requests WHERE status IN ('ready','partially_ready')) AS ready_for_pickup
    ,(SELECT COUNT(*) FROM loans WHERE status='open' AND due_at IS NOT NULL AND due_at<?) AS overdue_loans
    ,(SELECT COUNT(*) FROM visit_bookings WHERE status='active' AND visit_date>=?) AS upcoming_visits
    FROM users u JOIN teacher_profiles p ON p.teacher_user_id=u.id
    LEFT JOIN visit_teacher_credentials c ON c.teacher_user_id=u.id`)
    .bind(now, now, now, kyivDate(now)).first<Record<string, number | null>>();
  const value = row ?? {};
  return {
    total: Number(value.total ?? 0), active: Number(value.active ?? 0), inactive: Number(value.inactive ?? 0),
    withCode: Number(value.with_code ?? 0), withoutCode: Number(value.without_code ?? 0), locked: Number(value.locked ?? 0),
    withOpenLoans: Number(value.with_open_loans ?? 0), withOverdueLoans: Number(value.with_overdue_loans ?? 0),
    withOpenRequests: Number(value.with_open_requests ?? 0),
    newOrders: Number(value.new_orders ?? 0),
    readyForPickup: Number(value.ready_for_pickup ?? 0),
    overdueLoans: Number(value.overdue_loans ?? 0),
    upcomingVisits: Number(value.upcoming_visits ?? 0),
  };
}

async function dependencySummary(
  db: TeacherRegistryDatabase,
  teacherId: string,
  now: string,
): Promise<Record<string, number> & { totalDependencies: number }> {
  const row = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM visit_teacher_credentials WHERE teacher_user_id=?) AS credentials,
    (SELECT COUNT(*) FROM visit_teacher_sessions WHERE teacher_user_id=?) AS sessions,
    (SELECT COUNT(*) FROM visit_teacher_access_commands WHERE teacher_user_id=? OR actor_user_id=?) AS access_commands,
    (SELECT COUNT(*) FROM visit_bookings WHERE owner_user_id=? OR selected_teacher_user_id=?) AS visits,
    (SELECT COUNT(*) FROM visit_bookings WHERE (owner_user_id=? OR selected_teacher_user_id=?) AND status='active' AND visit_date>=?) AS future_active_visits,
    (SELECT COUNT(*) FROM material_requests WHERE teacher_user_id=?) AS requests,
    (SELECT COUNT(*) FROM material_requests WHERE teacher_user_id=? AND status IN ('submitted','in_review','ready','partially_ready')) AS active_requests,
    (SELECT COUNT(*) FROM loans WHERE teacher_user_id=?) AS loans,
    (SELECT COUNT(*) FROM loans WHERE teacher_user_id=? AND status='open') AS open_loans,
    (SELECT COUNT(*) FROM class_years WHERE teacher_user_id=?) AS class_assignments,
    (SELECT COUNT(*) FROM class_years WHERE teacher_user_id=? AND status IN ('active','planned')) AS active_class_assignments,
    (SELECT COUNT(*) FROM class_loans WHERE responsible_teacher_user_id=?) AS class_responsibilities,
    (SELECT COUNT(*) FROM portal_notifications WHERE teacher_user_id=?) AS notifications,
    ((SELECT COUNT(*) FROM teacher_profiles WHERE teacher_user_id<>? AND
        (closed_by_user_id=? OR created_by_user_id=? OR updated_by_user_id=?))
      +(SELECT COUNT(*) FROM visit_teacher_credentials WHERE created_by_user_id=? OR updated_by_user_id=?)
      +(SELECT COUNT(*) FROM class_loans WHERE issued_by_user_id=? OR closed_by_user_id=?)
      +(SELECT COUNT(*) FROM class_loan_transactions WHERE actor_user_id=?)
      +(SELECT COUNT(*) FROM loans WHERE issued_by_user_id=? OR closed_by_user_id=?)
      +(SELECT COUNT(*) FROM inventory_transactions WHERE actor_user_id=?)
      +(SELECT COUNT(*) FROM visit_schedule_hours WHERE updated_by_user_id=?)
      +(SELECT COUNT(*) FROM visit_schedule_closures WHERE created_by_user_id=? OR cancelled_by_user_id=?)
      +(SELECT COUNT(*) FROM visit_bookings WHERE cancelled_by_user_id=?)
      +(SELECT COUNT(*) FROM material_requests WHERE reviewed_by_user_id=? OR cancelled_by_user_id=?)
      +(SELECT COUNT(*) FROM material_request_events WHERE actor_user_id=?)
      +(SELECT COUNT(*) FROM audit_events WHERE actor_user_id=?)
      +(SELECT COUNT(*) FROM mutation_commands WHERE actor_user_id=?)) AS actor_references`)
    .bind(
      teacherId, teacherId, teacherId, teacherId,
      teacherId, teacherId, teacherId, teacherId, kyivDate(now),
      ...Array.from({ length: 29 }, () => teacherId),
    ).first<Record<string, number>>();
  const counts = Object.fromEntries(Object.entries(row ?? {}).map(([key, value]) => [camel(key), Number(value)]));
  const totalDependencies = Number(counts.credentials ?? 0) + Number(counts.sessions ?? 0) + Number(counts.accessCommands ?? 0) + Number(counts.visits ?? 0)
    + Number(counts.requests ?? 0) + Number(counts.loans ?? 0) + Number(counts.classAssignments ?? 0)
    + Number(counts.classResponsibilities ?? 0) + Number(counts.notifications ?? 0) + Number(counts.actorReferences ?? 0);
  return { ...counts, totalDependencies };
}

async function getMutableTeacher(db: TeacherRegistryDatabase, teacherId: string) {
  const row = await db.prepare(`SELECT u.id,u.full_name,u.sort_name,u.role AS account_role,
    CASE WHEN u.status='active' AND p.closed_at IS NULL THEN 'active' ELSE 'inactive' END AS status,
    p.subject_position,p.primary_location_id,
    p.service_contact,p.librarian_note,p.version,p.closed_at,p.last_mutation_request_id
    FROM users u JOIN teacher_profiles p ON p.teacher_user_id=u.id WHERE u.id=? LIMIT 1`)
    .bind(teacherId).first<{
      id: string; full_name: string; sort_name: string; account_role: "teacher" | "admin" | "librarian";
      status: TeacherStatus; subject_position: string;
      primary_location_id: string | null; service_contact: string; librarian_note: string; version: number;
      closed_at: string | null; last_mutation_request_id: string | null;
    }>();
  if (!row) throw new TeacherRegistryError("teacher_not_found", 404, "Картку вчителя не знайдено.");
  return {
    id: row.id, fullName: row.full_name, sortName: row.sort_name, accountRole: row.account_role, status: row.status,
    subjectPosition: row.subject_position, primaryLocationId: row.primary_location_id,
    serviceContact: row.service_contact, librarianNote: row.librarian_note, version: Number(row.version),
    closedAt: row.closed_at, lastMutationRequestId: row.last_mutation_request_id,
  };
}

async function updateProfile(
  db: TeacherRegistryDatabase,
  actor: { id: string; email: string },
  current: Awaited<ReturnType<typeof getMutableTeacher>>,
  input: TeacherUpdateInput,
  fullName: string,
  locationId: string | null,
  requestHash: string,
) {
  const next = {
    fullName,
    subjectPosition: input.changes.subjectPosition ?? current.subjectPosition,
    primaryLocationId: locationId,
    serviceContact: input.changes.serviceContact ?? current.serviceContact,
    librarianNote: input.changes.librarianNote ?? current.librarianNote,
    status: current.status,
    version: current.version + 1,
  };
  const now = new Date().toISOString();
  const result = { teacherId: current.id, version: next.version };
  try {
    await db.batch([
      commandStart(db, input.requestId, "teacher.update", actor.id, requestHash, current.id, now),
      db.prepare(`UPDATE users SET full_name=?,sort_name=?,updated_at=? WHERE id=?
        AND EXISTS(SELECT 1 FROM teacher_profiles WHERE teacher_user_id=users.id AND version=?)
        AND EXISTS(SELECT 1 FROM mutation_commands WHERE id=? AND request_hash=? AND status='processing')`)
        .bind(fullName, teacherSortName(fullName), now, current.id, input.expectedVersion, input.requestId, requestHash),
      db.prepare(`UPDATE teacher_profiles SET subject_position=?,primary_location_id=?,service_contact=?,librarian_note=?,
        version=version+1,last_mutation_request_id=?,updated_by_user_id=?,updated_at=?
        WHERE teacher_user_id=? AND version=?
          AND EXISTS(SELECT 1 FROM mutation_commands WHERE id=? AND request_hash=? AND status='processing')`)
        .bind(next.subjectPosition, next.primaryLocationId, next.serviceContact, next.librarianNote,
          input.requestId, actor.id, now, current.id, input.expectedVersion, input.requestId, requestHash),
      guardedAuditInsert(db, actor, "teacher.updated", current.id, input.requestId, current, next, now,
        `EXISTS(SELECT 1 FROM users u JOIN teacher_profiles p ON p.teacher_user_id=u.id
          WHERE u.id=? AND u.full_name=? AND u.sort_name=?
            AND CASE WHEN u.status='active' AND p.closed_at IS NULL THEN 'active' ELSE 'inactive' END=?
            AND p.version=? AND p.last_mutation_request_id=? AND p.subject_position=?
            AND p.primary_location_id IS ? AND p.service_contact=? AND p.librarian_note=?)`,
        [current.id, next.fullName, teacherSortName(next.fullName), next.status, next.version, input.requestId,
          next.subjectPosition, next.primaryLocationId, next.serviceContact, next.librarianNote]),
      commandComplete(db, input.requestId, requestHash, result, now),
    ]);
  } catch (error) {
    const recovered = await completedMutationReplay(db, input.requestId, requestHash);
    if (recovered) return recovered;
    const fresh = await getMutableTeacher(db, current.id);
    if (fresh.version !== input.expectedVersion) throw versionConflict(fresh.version);
    throw error;
  }
  return result;
}

async function closeTeacher(
  db: TeacherRegistryDatabase,
  actor: { id: string; email: string },
  current: Awaited<ReturnType<typeof getMutableTeacher>>,
  input: TeacherUpdateInput,
  requestHash: string,
) {
  if (current.status === "inactive") throw new TeacherRegistryError("teacher_already_closed", 409, "Картку вже закрито.");
  const now = new Date().toISOString();
  const dependencies = await dependencySummary(db, current.id, now);
  const blockers = {
    activeRequests: Number(dependencies.activeRequests ?? 0),
    futureActiveVisits: Number(dependencies.futureActiveVisits ?? 0),
    activeClassAssignments: Number(dependencies.activeClassAssignments ?? 0),
  };
  if (Object.values(blockers).some((count) => count > 0)) {
    throw new TeacherRegistryError("teacher_close_blocked", 409, "Спочатку завершіть активні заявки, майбутні відвідування та призначення класів.", { blockers, dependencies });
  }
  const result = { teacherId: current.id, version: current.version + 1, status: "inactive" };
  const currentKyivDate = kyivDate(now);
  try {
    await db.batch([
      commandStart(db, input.requestId, "teacher.close", actor.id, requestHash, current.id, now),
      db.prepare(`UPDATE users SET status=CASE WHEN role='teacher' THEN 'inactive' ELSE status END,updated_at=?
        WHERE id=? AND role IN ('teacher','admin','librarian') AND status='active'
        AND EXISTS(SELECT 1 FROM teacher_profiles WHERE teacher_user_id=users.id AND version=?)
        AND EXISTS(SELECT 1 FROM mutation_commands WHERE id=? AND request_hash=? AND status='processing')
        AND ${noCloseBlockersSql("users.id")}`)
        .bind(now, current.id, input.expectedVersion, input.requestId, requestHash, currentKyivDate),
      db.prepare(`UPDATE teacher_profiles SET version=version+1,last_mutation_request_id=?,closed_at=?,closed_by_user_id=?,
        updated_by_user_id=?,updated_at=? WHERE teacher_user_id=? AND version=?
        AND EXISTS(SELECT 1 FROM users WHERE id=teacher_profiles.teacher_user_id
          AND ((role='teacher' AND status='inactive') OR (role IN ('admin','librarian') AND status='active')))
        AND EXISTS(SELECT 1 FROM mutation_commands WHERE id=? AND request_hash=? AND status='processing')`)
        .bind(input.requestId, now, actor.id, actor.id, now, current.id, input.expectedVersion, input.requestId, requestHash),
      db.prepare(`UPDATE visit_teacher_credentials SET status='disabled',version=version+1,failed_attempts=0,
        failure_window_started_at=NULL,locked_until=NULL,updated_by_user_id=?,updated_at=? WHERE teacher_user_id=?
        AND EXISTS(SELECT 1 FROM teacher_profiles WHERE teacher_user_id=? AND last_mutation_request_id=?)`)
        .bind(actor.id, now, current.id, current.id, input.requestId),
      db.prepare(`UPDATE visit_teacher_sessions SET revoked_at=? WHERE teacher_user_id=? AND revoked_at IS NULL
        AND EXISTS(SELECT 1 FROM teacher_profiles WHERE teacher_user_id=? AND last_mutation_request_id=?)`)
        .bind(now, current.id, current.id, input.requestId),
      guardedAuditInsert(db, actor, "teacher.closed", current.id, input.requestId, current,
        { ...result, reason: input.reason }, now,
        `EXISTS(SELECT 1 FROM users u JOIN teacher_profiles p ON p.teacher_user_id=u.id
          WHERE u.id=? AND ((u.role='teacher' AND u.status='inactive')
              OR (u.role IN ('admin','librarian') AND u.status='active'))
            AND p.version=? AND p.last_mutation_request_id=?
            AND p.closed_at=? AND p.closed_by_user_id=?
            AND NOT EXISTS(SELECT 1 FROM visit_teacher_credentials c WHERE c.teacher_user_id=u.id AND c.status<>'disabled')
            AND NOT EXISTS(SELECT 1 FROM visit_teacher_sessions s WHERE s.teacher_user_id=u.id AND s.revoked_at IS NULL)
            AND ${noCloseBlockersSql("u.id")})`,
        [current.id, result.version, input.requestId, now, actor.id, currentKyivDate]),
      commandComplete(db, input.requestId, requestHash, result, now),
    ]);
  } catch (error) {
    const recovered = await completedMutationReplay(db, input.requestId, requestHash);
    if (recovered) return recovered;
    const fresh = await getMutableTeacher(db, current.id);
    if (fresh.version !== input.expectedVersion) throw versionConflict(fresh.version);
    const freshDependencies = await dependencySummary(db, current.id, now);
    const freshBlockers = {
      activeRequests: Number(freshDependencies.activeRequests ?? 0),
      futureActiveVisits: Number(freshDependencies.futureActiveVisits ?? 0),
      activeClassAssignments: Number(freshDependencies.activeClassAssignments ?? 0),
    };
    if (Object.values(freshBlockers).some((count) => count > 0)) {
      throw new TeacherRegistryError("teacher_close_blocked", 409, "Спочатку завершіть активні заявки, майбутні відвідування та призначення класів.", { blockers: freshBlockers, dependencies: freshDependencies });
    }
    throw error;
  }
  return result;
}

async function restoreTeacher(
  db: TeacherRegistryDatabase,
  actor: { id: string; email: string },
  current: Awaited<ReturnType<typeof getMutableTeacher>>,
  input: TeacherUpdateInput,
  requestHash: string,
) {
  if (current.status === "active") throw new TeacherRegistryError("teacher_already_active", 409, "Картка вже активна.");
  const now = new Date().toISOString();
  const result = { teacherId: current.id, version: current.version + 1, status: "active" };
  try {
    await db.batch([
      commandStart(db, input.requestId, "teacher.restore", actor.id, requestHash, current.id, now),
      db.prepare(`UPDATE users SET status=CASE WHEN role='teacher' THEN 'active' ELSE status END,updated_at=?
        WHERE id=? AND role IN ('teacher','admin','librarian')
          AND ((role='teacher' AND status='inactive') OR (role IN ('admin','librarian') AND status='active'))
        AND EXISTS(SELECT 1 FROM teacher_profiles WHERE teacher_user_id=users.id AND version=?)
        AND EXISTS(SELECT 1 FROM mutation_commands WHERE id=? AND request_hash=? AND status='processing')`)
        .bind(now, current.id, input.expectedVersion, input.requestId, requestHash),
      db.prepare(`UPDATE teacher_profiles SET version=version+1,last_mutation_request_id=?,closed_at=NULL,closed_by_user_id=NULL,
        updated_by_user_id=?,updated_at=? WHERE teacher_user_id=? AND version=?
        AND EXISTS(SELECT 1 FROM users WHERE id=teacher_profiles.teacher_user_id AND status='active')
        AND EXISTS(SELECT 1 FROM mutation_commands WHERE id=? AND request_hash=? AND status='processing')`)
        .bind(input.requestId, actor.id, now, current.id, input.expectedVersion, input.requestId, requestHash),
      guardedAuditInsert(db, actor, "teacher.restored", current.id, input.requestId, current,
        { ...result, reason: input.reason }, now,
        `EXISTS(SELECT 1 FROM users u JOIN teacher_profiles p ON p.teacher_user_id=u.id
          WHERE u.id=? AND u.status='active' AND p.version=? AND p.last_mutation_request_id=?
            AND p.closed_at IS NULL AND p.closed_by_user_id IS NULL)`,
        [current.id, result.version, input.requestId]),
      commandComplete(db, input.requestId, requestHash, result, now),
    ]);
  } catch (error) {
    const recovered = await completedMutationReplay(db, input.requestId, requestHash);
    if (recovered) return recovered;
    const fresh = await getMutableTeacher(db, current.id);
    if (fresh.version !== input.expectedVersion) throw versionConflict(fresh.version);
    throw error;
  }
  return result;
}

async function ensureNoDuplicate(db: TeacherRegistryDatabase, fullName: string, excludeId: string | null, forced: boolean) {
  const rows = await db.prepare(`SELECT u.id,u.full_name,
    CASE WHEN u.status='active' AND p.closed_at IS NULL THEN 'active' ELSE 'inactive' END AS status
    FROM users u JOIN teacher_profiles p ON p.teacher_user_id=u.id WHERE u.sort_name=?
    AND (? IS NULL OR u.id<>?) ORDER BY status DESC,u.id LIMIT 10`).bind(teacherSortName(fullName), excludeId, excludeId)
    .all<{ id: string; full_name: string; status: TeacherStatus }>();
  const duplicates = (rows.results ?? []).map((row) => ({ id: row.id, fullName: row.full_name, status: row.status }));
  if (duplicates.length && !forced) throw new TeacherRegistryError("teacher_duplicate_warning", 409, "Вже існує картка зі схожим ПІБ.", { duplicates });
}

async function ensureLocation(db: TeacherRegistryDatabase, locationId: string | null) {
  if (!locationId) return;
  const row = await db.prepare(`SELECT id FROM locations WHERE id=? AND status='active' LIMIT 1`).bind(locationId).first();
  if (!row) throw new TeacherRegistryError("location_not_found", 404, "Активний кабінет не знайдено.");
}

async function resolveActor(db: TeacherRegistryDatabase, user: ChatGPTUser) {
  const rows = await db.prepare(`SELECT id FROM users WHERE status='active' AND role IN ('admin','librarian')
    AND (auth_user_id=? OR lower(email)=lower(?)) ORDER BY id LIMIT 2`).bind(user.userId, user.email).all<{ id: string }>();
  if ((rows.results ?? []).length !== 1) throw new TeacherRegistryError("actor_not_mapped", 403, "Обліковий запис не прив’язаний до одного активного бібліотекаря.");
  return { id: rows.results![0].id, email: user.email };
}

async function mutationReplay(db: TeacherRegistryDatabase, requestId: string, requestHash: string) {
  const row = await db.prepare(`SELECT request_hash,status,result_json FROM mutation_commands WHERE id=? LIMIT 1`)
    .bind(requestId).first<{ request_hash: string; status: string; result_json: string | null }>();
  if (!row) return null;
  if (row.request_hash !== requestHash) throw new TeacherRegistryError("request_id_conflict", 409, "Цей номер запиту вже використано для іншої дії.");
  if (row.status !== "completed" || !row.result_json) throw new TeacherRegistryError("request_in_progress", 409, "Попередня дія ще виконується. Оновіть сторінку.");
  return JSON.parse(row.result_json) as Record<string, unknown>;
}

async function completedMutationReplay(db: TeacherRegistryDatabase, requestId: string, requestHash: string) {
  const row = await db.prepare(`SELECT request_hash,status,result_json FROM mutation_commands WHERE id=? LIMIT 1`)
    .bind(requestId).first<{ request_hash: string; status: string; result_json: string | null }>();
  if (!row) return null;
  if (row.request_hash !== requestHash) throw new TeacherRegistryError("request_id_conflict", 409, "Цей номер запиту вже використано для іншої дії.");
  return row.status === "completed" && row.result_json
    ? JSON.parse(row.result_json) as Record<string, unknown>
    : null;
}

function commandStart(
  db: TeacherRegistryDatabase,
  id: string,
  kind: string,
  actorId: string,
  requestHash: string,
  targetId: string,
  now: string,
) {
  return db.prepare(`INSERT INTO mutation_commands(id,draft_id,kind,actor_user_id,status,target_type,target_id,request_hash,
    result_json,error_code,error_message,created_at,updated_at,completed_at)
    VALUES(?,NULL,?,(SELECT id FROM users WHERE id=? AND status='active' AND role IN ('admin','librarian')),
      'processing','teacher',?,?,NULL,NULL,NULL,?,?,NULL)`)
    .bind(id, kind, actorId, targetId, requestHash, now, now);
}

function commandComplete(
  db: TeacherRegistryDatabase,
  id: string,
  requestHash: string,
  result: unknown,
  now: string,
) {
  return db.prepare(`UPDATE mutation_commands SET status='completed',result_json=?,updated_at=?,completed_at=?
    WHERE id=? AND request_hash=? AND status='processing'`)
    .bind(JSON.stringify(result), now, now, id, requestHash);
}

function guardedAuditInsert(
  db: TeacherRegistryDatabase,
  actor: { id: string; email: string },
  action: string,
  teacherId: string,
  requestId: string,
  before: unknown,
  after: unknown,
  now: string,
  guardSql: string,
  guardBindings: D1Value[],
) {
  return db.prepare(`INSERT INTO audit_events(id,actor_user_id,actor_email,action,entity_type,entity_id,request_id,
    before_json,after_json,metadata_json,created_at) VALUES(?,?,?,CASE WHEN ${guardSql} THEN ? ELSE NULL END,
    'teacher',?,?,?,?,'{}',?)`)
    .bind(`AUD-${crypto.randomUUID()}`, actor.id, actor.email, ...guardBindings, action, teacherId, requestId,
      before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), now);
}

function versionConflict(actualVersion: number) {
  return new TeacherRegistryError("teacher_version_conflict", 409, "Картку вже змінено. Оновіть сторінку.", { actualVersion });
}

function noCloseBlockersSql(teacherExpression: string): string {
  return `NOT EXISTS(SELECT 1 FROM material_requests mr WHERE mr.teacher_user_id=${teacherExpression}
      AND mr.status IN ('submitted','in_review','ready','partially_ready'))
    AND NOT EXISTS(SELECT 1 FROM visit_bookings vb WHERE (vb.owner_user_id=${teacherExpression}
      OR vb.selected_teacher_user_id=${teacherExpression}) AND vb.status='active' AND vb.visit_date>=?)
    AND NOT EXISTS(SELECT 1 FROM class_years cy WHERE cy.teacher_user_id=${teacherExpression}
      AND cy.status IN ('active','planned'))`;
}

function noTeacherDependenciesSql(teacherExpression: string): string {
  return `NOT EXISTS(SELECT 1 FROM visit_teacher_credentials c WHERE c.teacher_user_id=${teacherExpression})
    AND NOT EXISTS(SELECT 1 FROM visit_teacher_sessions s WHERE s.teacher_user_id=${teacherExpression})
    AND NOT EXISTS(SELECT 1 FROM visit_teacher_access_commands ac WHERE ac.teacher_user_id=${teacherExpression}
      OR ac.actor_user_id=${teacherExpression})
    AND NOT EXISTS(SELECT 1 FROM teacher_profiles other WHERE other.teacher_user_id<>${teacherExpression}
      AND (other.closed_by_user_id=${teacherExpression} OR other.created_by_user_id=${teacherExpression}
        OR other.updated_by_user_id=${teacherExpression}))
    AND NOT EXISTS(SELECT 1 FROM visit_teacher_credentials c2 WHERE c2.created_by_user_id=${teacherExpression}
      OR c2.updated_by_user_id=${teacherExpression})
    AND NOT EXISTS(SELECT 1 FROM visit_bookings vb WHERE vb.owner_user_id=${teacherExpression}
      OR vb.selected_teacher_user_id=${teacherExpression} OR vb.cancelled_by_user_id=${teacherExpression})
    AND NOT EXISTS(SELECT 1 FROM material_requests mr WHERE mr.teacher_user_id=${teacherExpression}
      OR mr.reviewed_by_user_id=${teacherExpression} OR mr.cancelled_by_user_id=${teacherExpression})
    AND NOT EXISTS(SELECT 1 FROM loans l WHERE l.teacher_user_id=${teacherExpression}
      OR l.issued_by_user_id=${teacherExpression} OR l.closed_by_user_id=${teacherExpression})
    AND NOT EXISTS(SELECT 1 FROM class_years cy WHERE cy.teacher_user_id=${teacherExpression})
    AND NOT EXISTS(SELECT 1 FROM class_loans cl WHERE cl.responsible_teacher_user_id=${teacherExpression}
      OR cl.issued_by_user_id=${teacherExpression} OR cl.closed_by_user_id=${teacherExpression})
    AND NOT EXISTS(SELECT 1 FROM class_loan_transactions ct WHERE ct.actor_user_id=${teacherExpression})
    AND NOT EXISTS(SELECT 1 FROM inventory_transactions it WHERE it.actor_user_id=${teacherExpression})
    AND NOT EXISTS(SELECT 1 FROM visit_schedule_hours vh WHERE vh.updated_by_user_id=${teacherExpression})
    AND NOT EXISTS(SELECT 1 FROM visit_schedule_closures vc WHERE vc.created_by_user_id=${teacherExpression}
      OR vc.cancelled_by_user_id=${teacherExpression})
    AND NOT EXISTS(SELECT 1 FROM portal_notifications pn WHERE pn.teacher_user_id=${teacherExpression})
    AND NOT EXISTS(SELECT 1 FROM material_request_events me WHERE me.actor_user_id=${teacherExpression})
    AND NOT EXISTS(SELECT 1 FROM audit_events ae WHERE ae.actor_user_id=${teacherExpression})
    AND NOT EXISTS(SELECT 1 FROM mutation_commands mc WHERE mc.actor_user_id=${teacherExpression})`;
}

function camel(value: string) {
  return value.replace(/_([a-z])/gu, (_, letter: string) => letter.toUpperCase());
}

function attachChildItems(
  parents: Array<Record<string, unknown>>,
  children: Array<Record<string, unknown>>,
  parentKey: string,
): Array<Record<string, unknown> & { items: Array<Record<string, unknown>> }> {
  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const child of children) {
    const key = String(child[parentKey] ?? "");
    const group = grouped.get(key) ?? [];
    group.push(child);
    grouped.set(key, group);
  }
  return parents.map((parent) => ({ ...parent, items: grouped.get(String(parent.id)) ?? [] }));
}

function encodeCursor(value: { sortName: string; id: string }): string {
  return base64UrlEncode(JSON.stringify(value));
}

function decodeCursor(value: string | null): { sortName: string; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(base64UrlDecode(value)) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("invalid");
    const row = parsed as Record<string, unknown>;
    if (typeof row.sortName !== "string" || typeof row.id !== "string" || row.sortName.length > 200 || row.id.length > 128) throw new Error("invalid");
    return { sortName: row.sortName, id: row.id };
  } catch {
    throw new TeacherRegistryError("invalid_cursor", 400, "Некоректна сторінка списку.");
  }
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function sha256Json(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function kyivDate(instant: string | Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(typeof instant === "string" ? new Date(instant) : instant);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
