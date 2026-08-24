import type { ChatGPTUser } from "../app/chatgpt-auth.ts";
import type { VisitTeacherIdentity } from "./visit-teacher-auth.ts";

type D1Value = string | number | null;
type D1Result<T = Record<string, unknown>> = {
  results?: T[];
  success?: boolean;
  meta?: { changes?: number };
};
type D1Statement = {
  bind(...values: D1Value[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
};

export type TeacherCuratorRequestDatabase = {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<D1Result[]>;
};

export type TeacherCuratorRequestStatus =
  | "submitted"
  | "approved"
  | "rejected"
  | "cancelled";

export type CuratorClassProjection = {
  id: string;
  className: string;
  academicYearLabel: string;
};

export type TeacherCuratorRequestProjection = {
  id: string;
  teacher: { id: string; fullName: string };
  currentClass: CuratorClassProjection | null;
  requestedClass: CuratorClassProjection;
  status: TeacherCuratorRequestStatus;
  teacherNote: string;
  librarianNote: string;
  version: number;
  resolvedBy: { id: string; fullName: string } | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SubmitTeacherCuratorRequestInput = {
  mutationRequestId: string;
  expectedVersion: number | null;
  requestedClassYearId: string;
  teacherNote: string;
};

export type CancelTeacherCuratorRequestInput = {
  mutationRequestId: string;
  expectedVersion: number;
};

export type DecideTeacherCuratorRequestInput = {
  requestId: string;
  expectedVersion: number;
  decision: "approve" | "reject";
};

type RequestRow = {
  id: string;
  teacher_user_id: string;
  teacher_name: string;
  current_class_year_id: string | null;
  current_class_name: string | null;
  current_academic_year_label: string | null;
  requested_class_year_id: string;
  requested_class_name: string;
  requested_academic_year_label: string;
  status: TeacherCuratorRequestStatus;
  teacher_note: string;
  librarian_note: string;
  version: number;
  resolved_by_user_id: string | null;
  resolved_by_name: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

type ClassRow = {
  id: string;
  class_name: string;
  academic_year_label: string;
  teacher_user_id: string | null;
  status: string;
  version: number;
};

type StoredCommand = {
  actor_user_id: string;
  status: string;
  request_hash: string;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
};

type LibrarianActor = { id: string; email: string; fullName: string };

export class TeacherCuratorRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "TeacherCuratorRequestError";
    this.code = code;
    this.status = status;
  }
}

export async function listTeacherCuratorRequests(
  db: TeacherCuratorRequestDatabase,
  options: { status?: TeacherCuratorRequestStatus | "all"; limit?: number } = {},
): Promise<TeacherCuratorRequestProjection[]> {
  const status = options.status ?? "submitted";
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);
  const statusClause = status === "all" ? "" : "AND request.status=?";
  const bindings: D1Value[] = [];
  if (status !== "all") bindings.push(status);
  bindings.push(limit);
  const response = await db.prepare(`${requestProjectionSql()}
    WHERE 1=1 ${statusClause}
    ORDER BY request.created_at DESC, request.id DESC
    LIMIT ?
  `).bind(...bindings).all<RequestRow>();
  return (response.results ?? []).map(projectRequest);
}

export async function submitTeacherCuratorRequest(
  db: TeacherCuratorRequestDatabase,
  teacher: VisitTeacherIdentity,
  input: SubmitTeacherCuratorRequestInput,
): Promise<TeacherCuratorRequestProjection> {
  const requestHash = await mutationHash("teacher_curator_request.submit", {
    expectedVersion: input.expectedVersion,
    requestedClassYearId: input.requestedClassYearId,
    teacherNote: input.teacherNote,
  });
  const replay = await replayCompletedCommand<TeacherCuratorRequestProjection>(
    db,
    input.mutationRequestId,
    teacher.teacherUserId,
    requestHash,
  );
  if (replay) return replay;

  const currentClasses = await readTeacherCurrentClasses(db, teacher.teacherUserId);
  if (currentClasses.length > 1) {
    throw new TeacherCuratorRequestError(
      "current_curator_ambiguous",
      409,
      "За вчителем закріплено кілька класів. Зміну має виконати бібліотекар.",
    );
  }
  const currentClass = currentClasses[0] ?? null;
  const requestedClass = await readClass(db, input.requestedClassYearId);
  if (!requestedClass || !["planned", "active"].includes(requestedClass.status)) {
    throw new TeacherCuratorRequestError("requested_class_unavailable", 409, "Обраний клас уже недоступний.");
  }
  if (requestedClass.teacher_user_id && requestedClass.teacher_user_id !== teacher.teacherUserId) {
    throw new TeacherCuratorRequestError("curator_class_taken", 409, "Обраний клас уже закріплено за іншим учителем.");
  }
  if (currentClass?.id === requestedClass.id) {
    throw new TeacherCuratorRequestError("curator_request_no_change", 409, "Цей клас уже закріплено за вами.");
  }

  const pending = await readSubmittedRequestForTeacher(db, teacher.teacherUserId);
  if (pending && input.expectedVersion === null) {
    throw new TeacherCuratorRequestError(
      "curator_request_version_required",
      409,
      "Заявка вже існує. Оновіть сторінку перед заміною.",
    );
  }
  if (!pending && input.expectedVersion !== null) {
    throw new TeacherCuratorRequestError("curator_request_not_found", 409, "Попередню заявку вже опрацьовано.");
  }
  if (pending && pending.version !== input.expectedVersion) {
    throw new TeacherCuratorRequestError("curator_request_version_conflict", 409, "Заявка вже змінилася. Оновіть сторінку.");
  }

  const now = new Date().toISOString();
  const requestId = pending?.id ?? `TCR-${crypto.randomUUID()}`;
  const nextVersion = pending ? pending.version + 1 : 1;
  const result: TeacherCuratorRequestProjection = {
    id: requestId,
    teacher: { id: teacher.teacherUserId, fullName: teacher.fullName },
    currentClass: currentClass ? projectClass(currentClass) : null,
    requestedClass: projectClass(requestedClass),
    status: "submitted",
    teacherNote: input.teacherNote,
    librarianNote: "",
    version: nextVersion,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: pending?.createdAt ?? now,
    updatedAt: now,
  };
  const statements: D1Statement[] = [
    teacherCommandStatement(
      db,
      teacher,
      input.mutationRequestId,
      requestHash,
      pending ? "teacher_curator_request.replace" : "teacher_curator_request.create",
      requestId,
      now,
    ),
  ];

  if (pending) {
    statements.push(db.prepare(`
      UPDATE teacher_curator_change_requests
      SET current_class_year_id=?, requested_class_year_id=?, teacher_note=?,
          librarian_note='', version=version+1, last_mutation_request_id=?,
          resolved_by_user_id=NULL, resolved_at=NULL, updated_at=?
      WHERE id=? AND teacher_user_id=? AND status='submitted' AND version=?
        AND EXISTS (SELECT 1 FROM mutation_commands command
          WHERE command.id=? AND command.actor_user_id=? AND command.status='processing'
            AND command.target_type='teacher_curator_request' AND command.target_id=?
            AND command.request_hash=?)
        AND EXISTS (SELECT 1 FROM class_years target
          JOIN academic_years target_year ON target_year.id=target.academic_year_id
          WHERE target.id=? AND target.status IN ('planned','active')
            AND target_year.status IN ('draft','active') AND target.teacher_user_id IS NULL)
        AND ((? IS NULL AND NOT EXISTS (SELECT 1 FROM class_years owned
              JOIN academic_years owned_year ON owned_year.id=owned.academic_year_id
              WHERE owned.teacher_user_id=? AND owned.status IN ('planned','active')
                AND owned_year.status IN ('draft','active')))
          OR (? IS NOT NULL AND (SELECT COUNT(*) FROM class_years owned
              JOIN academic_years owned_year ON owned_year.id=owned.academic_year_id
              WHERE owned.teacher_user_id=? AND owned.status IN ('planned','active')
                AND owned_year.status IN ('draft','active'))=1
            AND EXISTS (SELECT 1 FROM class_years owned
              JOIN academic_years owned_year ON owned_year.id=owned.academic_year_id
              WHERE owned.id=? AND owned.teacher_user_id=? AND owned.status IN ('planned','active')
                AND owned_year.status IN ('draft','active'))))
    `).bind(
      currentClass?.id ?? null,
      requestedClass.id,
      input.teacherNote,
      input.mutationRequestId,
      now,
      requestId,
      teacher.teacherUserId,
      pending.version,
      input.mutationRequestId,
      teacher.teacherUserId,
      requestId,
      requestHash,
      requestedClass.id,
      currentClass?.id ?? null,
      teacher.teacherUserId,
      currentClass?.id ?? null,
      teacher.teacherUserId,
      currentClass?.id ?? null,
      teacher.teacherUserId,
    ));
  } else {
    statements.push(db.prepare(`
      INSERT INTO teacher_curator_change_requests (
        id,teacher_user_id,current_class_year_id,requested_class_year_id,status,
        teacher_note,librarian_note,version,last_mutation_request_id,
        resolved_by_user_id,resolved_at,created_at,updated_at
      )
      SELECT ?,? ,?,?,'submitted',?,'',1,?,NULL,NULL,?,?
      WHERE EXISTS (SELECT 1 FROM mutation_commands command
          WHERE command.id=? AND command.actor_user_id=? AND command.status='processing'
            AND command.target_type='teacher_curator_request' AND command.target_id=?
            AND command.request_hash=?)
        AND NOT EXISTS (SELECT 1 FROM teacher_curator_change_requests open_request
          WHERE open_request.teacher_user_id=? AND open_request.status='submitted')
        AND EXISTS (SELECT 1 FROM class_years target
          JOIN academic_years target_year ON target_year.id=target.academic_year_id
          WHERE target.id=? AND target.status IN ('planned','active')
            AND target_year.status IN ('draft','active') AND target.teacher_user_id IS NULL)
        AND ((? IS NULL AND NOT EXISTS (SELECT 1 FROM class_years owned
              JOIN academic_years owned_year ON owned_year.id=owned.academic_year_id
              WHERE owned.teacher_user_id=? AND owned.status IN ('planned','active')
                AND owned_year.status IN ('draft','active')))
          OR (? IS NOT NULL AND (SELECT COUNT(*) FROM class_years owned
              JOIN academic_years owned_year ON owned_year.id=owned.academic_year_id
              WHERE owned.teacher_user_id=? AND owned.status IN ('planned','active')
                AND owned_year.status IN ('draft','active'))=1
            AND EXISTS (SELECT 1 FROM class_years owned
              JOIN academic_years owned_year ON owned_year.id=owned.academic_year_id
              WHERE owned.id=? AND owned.teacher_user_id=? AND owned.status IN ('planned','active')
                AND owned_year.status IN ('draft','active'))))
    `).bind(
      requestId,
      teacher.teacherUserId,
      currentClass?.id ?? null,
      requestedClass.id,
      input.teacherNote,
      input.mutationRequestId,
      now,
      now,
      input.mutationRequestId,
      teacher.teacherUserId,
      requestId,
      requestHash,
      teacher.teacherUserId,
      requestedClass.id,
      currentClass?.id ?? null,
      teacher.teacherUserId,
      currentClass?.id ?? null,
      teacher.teacherUserId,
      currentClass?.id ?? null,
      teacher.teacherUserId,
    ));
  }

  statements.push(
    finalAuditStatement(db, {
      actorUserId: teacher.teacherUserId,
      actorEmail: "teacher-code@local.invalid",
      action: pending ? "teacher_curator_request.replaced" : "teacher_curator_request.submitted",
      entityId: requestId,
      mutationRequestId: input.mutationRequestId,
      expectedFinalVersion: nextVersion,
      expectedFinalStatus: "submitted",
      before: pending ?? null,
      after: result,
      createdAt: now,
    }),
    completeCommandStatement(db, input.mutationRequestId, result, now),
  );
  return executeMutation(
    db,
    statements,
    input.mutationRequestId,
    teacher.teacherUserId,
    requestHash,
    "curator_request_conflict",
    "Заявку не збережено, бо дані класу або заявка змінилися.",
  );
}

export async function cancelTeacherCuratorRequest(
  db: TeacherCuratorRequestDatabase,
  teacher: VisitTeacherIdentity,
  input: CancelTeacherCuratorRequestInput,
): Promise<TeacherCuratorRequestProjection> {
  const requestHash = await mutationHash("teacher_curator_request.cancel", {
    expectedVersion: input.expectedVersion,
  });
  const replay = await replayCompletedCommand<TeacherCuratorRequestProjection>(
    db,
    input.mutationRequestId,
    teacher.teacherUserId,
    requestHash,
  );
  if (replay) return replay;
  const current = await readSubmittedRequestForTeacher(db, teacher.teacherUserId);
  if (!current) throw new TeacherCuratorRequestError("curator_request_not_found", 404, "Активну заявку не знайдено.");
  if (current.version !== input.expectedVersion) {
    throw new TeacherCuratorRequestError("curator_request_version_conflict", 409, "Заявка вже змінилася. Оновіть сторінку.");
  }
  const now = new Date().toISOString();
  const result: TeacherCuratorRequestProjection = {
    ...current,
    status: "cancelled",
    version: current.version + 1,
    resolvedAt: now,
    updatedAt: now,
  };
  const statements = [
    teacherCommandStatement(db, teacher, input.mutationRequestId, requestHash, "teacher_curator_request.cancel", current.id, now),
    db.prepare(`
      UPDATE teacher_curator_change_requests
      SET status='cancelled', version=version+1, last_mutation_request_id=?,
          resolved_by_user_id=NULL, resolved_at=?, updated_at=?
      WHERE id=? AND teacher_user_id=? AND status='submitted' AND version=?
        AND EXISTS (SELECT 1 FROM mutation_commands command
          WHERE command.id=? AND command.actor_user_id=? AND command.status='processing'
            AND command.target_type='teacher_curator_request' AND command.target_id=?
            AND command.request_hash=?)
    `).bind(
      input.mutationRequestId,
      now,
      now,
      current.id,
      teacher.teacherUserId,
      current.version,
      input.mutationRequestId,
      teacher.teacherUserId,
      current.id,
      requestHash,
    ),
    finalAuditStatement(db, {
      actorUserId: teacher.teacherUserId,
      actorEmail: "teacher-code@local.invalid",
      action: "teacher_curator_request.cancelled",
      entityId: current.id,
      mutationRequestId: input.mutationRequestId,
      expectedFinalVersion: result.version,
      expectedFinalStatus: "cancelled",
      before: current,
      after: result,
      createdAt: now,
    }),
    completeCommandStatement(db, input.mutationRequestId, result, now),
  ];
  return executeMutation(
    db,
    statements,
    input.mutationRequestId,
    teacher.teacherUserId,
    requestHash,
    "curator_request_version_conflict",
    "Заявка вже змінилася. Оновіть сторінку.",
  );
}

export async function decideTeacherCuratorRequest(
  db: TeacherCuratorRequestDatabase,
  user: ChatGPTUser,
  input: DecideTeacherCuratorRequestInput,
): Promise<TeacherCuratorRequestProjection> {
  const actor = await resolveLibrarianActor(db, user);
  const requestHash = await mutationHash("teacher_curator_request.decision", input);
  const mutationRequestId = `TCRD-${(await sha256Hex(`${actor.id}:${input.requestId}:${input.expectedVersion}:${input.decision}`)).slice(0, 48)}`;
  const replay = await replayCompletedCommand<TeacherCuratorRequestProjection>(
    db,
    mutationRequestId,
    actor.id,
    requestHash,
  );
  if (replay) return replay;
  const current = await readRequest(db, input.requestId);
  if (!current) throw new TeacherCuratorRequestError("curator_request_not_found", 404, "Заявку не знайдено.");
  if (current.version !== input.expectedVersion || current.status !== "submitted") {
    throw new TeacherCuratorRequestError("curator_request_version_conflict", 409, "Заявка вже опрацьована або змінилася.");
  }

  const now = new Date().toISOString();
  const result: TeacherCuratorRequestProjection = {
    ...current,
    status: input.decision === "approve" ? "approved" : "rejected",
    version: current.version + 1,
    resolvedBy: { id: actor.id, fullName: actor.fullName },
    resolvedAt: now,
    updatedAt: now,
  };
  const statements: D1Statement[] = [
    librarianCommandStatement(db, mutationRequestId, requestHash, actor.id, input.decision, current.id, now),
  ];

  if (input.decision === "approve") {
    await assertApprovalAvailable(db, current);
    if (current.currentClass) {
      statements.push(db.prepare(`
        UPDATE class_years
        SET teacher_user_id=NULL, version=version+1, updated_at=?
        WHERE id=? AND teacher_user_id=? AND status IN ('planned','active')
          AND EXISTS (SELECT 1 FROM academic_years year
            WHERE year.id=class_years.academic_year_id AND year.status IN ('draft','active'))
          AND EXISTS (SELECT 1 FROM mutation_commands command
            WHERE command.id=? AND command.actor_user_id=? AND command.status='processing'
              AND command.target_id=? AND command.request_hash=?)
      `).bind(now, current.currentClass.id, current.teacher.id, mutationRequestId, actor.id, current.id, requestHash));
    }
    statements.push(db.prepare(`
      UPDATE class_years
      SET teacher_user_id=?, version=version+1, updated_at=?
      WHERE id=? AND teacher_user_id IS NULL AND status IN ('planned','active')
        AND EXISTS (SELECT 1 FROM academic_years year
          WHERE year.id=class_years.academic_year_id AND year.status IN ('draft','active'))
        AND EXISTS (SELECT 1 FROM mutation_commands command
          WHERE command.id=? AND command.actor_user_id=? AND command.status='processing'
            AND command.target_id=? AND command.request_hash=?)
    `).bind(current.teacher.id, now, current.requestedClass.id, mutationRequestId, actor.id, current.id, requestHash));
    statements.push(db.prepare(`
      UPDATE teacher_curator_change_requests
      SET status='approved', librarian_note='', version=version+1,
          last_mutation_request_id=?, resolved_by_user_id=?, resolved_at=?, updated_at=?
      WHERE id=? AND status='submitted' AND version=?
        AND EXISTS (SELECT 1 FROM users actor
          WHERE actor.id=? AND actor.status='active' AND actor.role IN ('admin','librarian'))
        AND EXISTS (SELECT 1 FROM class_years requested
          JOIN academic_years requested_year ON requested_year.id=requested.academic_year_id
          WHERE requested.id=requested_class_year_id AND requested.teacher_user_id=?
            AND requested.status IN ('planned','active')
            AND requested_year.status IN ('draft','active'))
        AND (current_class_year_id IS NULL OR EXISTS (SELECT 1 FROM class_years previous
          JOIN academic_years previous_year ON previous_year.id=previous.academic_year_id
          WHERE previous.id=current_class_year_id AND previous.teacher_user_id IS NULL
            AND previous.status IN ('planned','active')
            AND previous_year.status IN ('draft','active')))
        AND NOT EXISTS (SELECT 1 FROM class_years extra
          JOIN academic_years extra_year ON extra_year.id=extra.academic_year_id
          WHERE extra.teacher_user_id=? AND extra.status IN ('planned','active')
            AND extra_year.status IN ('draft','active') AND extra.id!=requested_class_year_id)
    `).bind(
      mutationRequestId,
      actor.id,
      now,
      now,
      current.id,
      current.version,
      actor.id,
      current.teacher.id,
      current.teacher.id,
    ));
  } else {
    statements.push(db.prepare(`
      UPDATE teacher_curator_change_requests
      SET status='rejected', librarian_note='', version=version+1,
          last_mutation_request_id=?, resolved_by_user_id=?, resolved_at=?, updated_at=?
      WHERE id=? AND status='submitted' AND version=?
        AND EXISTS (SELECT 1 FROM users actor
          WHERE actor.id=? AND actor.status='active' AND actor.role IN ('admin','librarian'))
        AND EXISTS (SELECT 1 FROM mutation_commands command
          WHERE command.id=? AND command.actor_user_id=? AND command.status='processing'
            AND command.target_id=? AND command.request_hash=?)
    `).bind(mutationRequestId, actor.id, now, now, current.id, current.version, actor.id,
      mutationRequestId, actor.id, current.id, requestHash));
  }

  statements.push(
    finalAuditStatement(db, {
      actorUserId: actor.id,
      actorEmail: actor.email,
      action: input.decision === "approve"
        ? "teacher_curator_request.approved"
        : "teacher_curator_request.rejected",
      entityId: current.id,
      mutationRequestId,
      expectedFinalVersion: result.version,
      expectedFinalStatus: result.status,
      before: current,
      after: result,
      createdAt: now,
    }),
  );
  if (input.decision === "approve") {
    if (current.currentClass) {
      statements.push(classAuditStatement(db, actor, mutationRequestId, current.currentClass.id,
        "teacher_curator_request.unassigned_class", current.teacher.id, null, now));
    }
    statements.push(classAuditStatement(db, actor, mutationRequestId, current.requestedClass.id,
      "teacher_curator_request.assigned_class", null, current.teacher.id, now));
  }
  statements.push(completeCommandStatement(db, mutationRequestId, result, now));
  return executeMutation(
    db,
    statements,
    mutationRequestId,
    actor.id,
    requestHash,
    input.decision === "approve" ? "curator_assignment_conflict" : "curator_request_version_conflict",
    input.decision === "approve"
      ? "Клас або заявка змінилися. Призначення не виконано."
      : "Заявка вже опрацьована або змінилася.",
  );
}

async function assertApprovalAvailable(
  db: TeacherCuratorRequestDatabase,
  request: TeacherCuratorRequestProjection,
): Promise<void> {
  const requested = await readClass(db, request.requestedClass.id);
  if (!requested || !["planned", "active"].includes(requested.status)) {
    throw new TeacherCuratorRequestError("requested_class_unavailable", 409, "Обраний клас уже недоступний.");
  }
  if (requested.teacher_user_id && requested.teacher_user_id !== request.teacher.id) {
    throw new TeacherCuratorRequestError("curator_class_taken", 409, "Клас уже закріплено за іншим учителем.");
  }
  if (requested.teacher_user_id === request.teacher.id) {
    throw new TeacherCuratorRequestError("curator_assignment_conflict", 409, "Клас уже закріплено за цим учителем поза заявкою.");
  }
  if (request.currentClass) {
    const current = await readClass(db, request.currentClass.id);
    if (!current || current.teacher_user_id !== request.teacher.id || !["planned", "active"].includes(current.status)) {
      throw new TeacherCuratorRequestError("curator_assignment_conflict", 409, "Поточне призначення вчителя вже змінилося.");
    }
  }
  const owned = await readTeacherCurrentClasses(db, request.teacher.id);
  if (owned.length !== (request.currentClass ? 1 : 0)
    || (request.currentClass && owned[0]?.id !== request.currentClass.id)) {
    throw new TeacherCuratorRequestError("curator_assignment_conflict", 409, "Призначення вчителя вже змінилися.");
  }
}

function requestProjectionSql(): string {
  return `SELECT request.id,request.teacher_user_id,teacher.full_name AS teacher_name,
      request.current_class_year_id,current_class.class_name AS current_class_name,
      current_year.label AS current_academic_year_label,
      request.requested_class_year_id,requested_class.class_name AS requested_class_name,
      requested_year.label AS requested_academic_year_label,
      request.status,request.teacher_note,request.librarian_note,request.version,
      request.resolved_by_user_id,resolver.full_name AS resolved_by_name,
      request.resolved_at,request.created_at,request.updated_at
    FROM teacher_curator_change_requests request
    JOIN users teacher ON teacher.id=request.teacher_user_id
    LEFT JOIN class_years current_class ON current_class.id=request.current_class_year_id
    LEFT JOIN academic_years current_year ON current_year.id=current_class.academic_year_id
    JOIN class_years requested_class ON requested_class.id=request.requested_class_year_id
    JOIN academic_years requested_year ON requested_year.id=requested_class.academic_year_id
    LEFT JOIN users resolver ON resolver.id=request.resolved_by_user_id`;
}

async function readRequest(
  db: TeacherCuratorRequestDatabase,
  id: string,
): Promise<TeacherCuratorRequestProjection | null> {
  const row = await db.prepare(`${requestProjectionSql()} WHERE request.id=? LIMIT 1`).bind(id).first<RequestRow>();
  return row ? projectRequest(row) : null;
}

async function readSubmittedRequestForTeacher(
  db: TeacherCuratorRequestDatabase,
  teacherUserId: string,
): Promise<TeacherCuratorRequestProjection | null> {
  const row = await db.prepare(`${requestProjectionSql()}
    WHERE request.teacher_user_id=? AND request.status='submitted'
    ORDER BY request.created_at DESC,request.id DESC LIMIT 1
  `).bind(teacherUserId).first<RequestRow>();
  return row ? projectRequest(row) : null;
}

async function readClass(
  db: TeacherCuratorRequestDatabase,
  id: string,
): Promise<ClassRow | null> {
  return db.prepare(`SELECT class.id,class.class_name,year.label AS academic_year_label,
      class.teacher_user_id,class.status,class.version
    FROM class_years class JOIN academic_years year ON year.id=class.academic_year_id
    WHERE class.id=? AND year.status IN ('draft','active') LIMIT 1`).bind(id).first<ClassRow>();
}

async function readTeacherCurrentClasses(
  db: TeacherCuratorRequestDatabase,
  teacherUserId: string,
): Promise<ClassRow[]> {
  const response = await db.prepare(`SELECT class.id,class.class_name,year.label AS academic_year_label,
      class.teacher_user_id,class.status,class.version
    FROM class_years class JOIN academic_years year ON year.id=class.academic_year_id
    WHERE class.teacher_user_id=? AND class.status IN ('planned','active')
      AND year.status IN ('draft','active')
    ORDER BY class.start_date DESC,class.class_name,class.id LIMIT 2
  `).bind(teacherUserId).all<ClassRow>();
  return response.results ?? [];
}

function projectClass(row: ClassRow): CuratorClassProjection {
  return { id: row.id, className: row.class_name, academicYearLabel: row.academic_year_label };
}

function projectRequest(row: RequestRow): TeacherCuratorRequestProjection {
  return {
    id: row.id,
    teacher: { id: row.teacher_user_id, fullName: row.teacher_name },
    currentClass: row.current_class_year_id && row.current_class_name && row.current_academic_year_label
      ? { id: row.current_class_year_id, className: row.current_class_name, academicYearLabel: row.current_academic_year_label }
      : null,
    requestedClass: {
      id: row.requested_class_year_id,
      className: row.requested_class_name,
      academicYearLabel: row.requested_academic_year_label,
    },
    status: row.status,
    teacherNote: row.teacher_note,
    librarianNote: row.librarian_note,
    version: Number(row.version),
    resolvedBy: row.resolved_by_user_id && row.resolved_by_name
      ? { id: row.resolved_by_user_id, fullName: row.resolved_by_name }
      : null,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function teacherCommandStatement(
  db: TeacherCuratorRequestDatabase,
  teacher: VisitTeacherIdentity,
  id: string,
  requestHash: string,
  kind: string,
  targetId: string,
  now: string,
): D1Statement {
  return db.prepare(`INSERT INTO mutation_commands (
      id,draft_id,kind,actor_user_id,status,target_type,target_id,request_hash,
      result_json,error_code,error_message,created_at,updated_at,completed_at
    ) VALUES (?,NULL,?,(
      SELECT user.id FROM users user
      JOIN teacher_profiles profile ON profile.teacher_user_id=user.id AND profile.closed_at IS NULL
      JOIN visit_teacher_credentials credential ON credential.teacher_user_id=user.id
        AND credential.status='active' AND credential.version=?
      JOIN visit_teacher_sessions session ON session.teacher_user_id=user.id
        AND session.credential_version=credential.version AND session.token_hash=?
        AND session.revoked_at IS NULL AND session.expires_at>?
      WHERE user.id=? AND user.full_name=? AND user.status='active'
    ),'processing','teacher_curator_request',?,?,NULL,NULL,NULL,?,?,NULL)
  `).bind(
    id,
    kind,
    teacher.credentialVersion,
    teacher.tokenHash,
    now,
    teacher.teacherUserId,
    teacher.fullName,
    targetId,
    requestHash,
    now,
    now,
  );
}

function librarianCommandStatement(
  db: TeacherCuratorRequestDatabase,
  id: string,
  requestHash: string,
  actorUserId: string,
  decision: "approve" | "reject",
  targetId: string,
  now: string,
): D1Statement {
  return db.prepare(`INSERT INTO mutation_commands (
      id,draft_id,kind,actor_user_id,status,target_type,target_id,request_hash,
      result_json,error_code,error_message,created_at,updated_at,completed_at
    ) VALUES (?,NULL,?,(
      SELECT id FROM users WHERE id=? AND status='active' AND role IN ('admin','librarian')
    ),'processing','teacher_curator_request',?,?,NULL,NULL,NULL,?,?,NULL)
  `).bind(id, `teacher_curator_request.${decision}`, actorUserId, targetId, requestHash, now, now);
}

function finalAuditStatement(
  db: TeacherCuratorRequestDatabase,
  input: {
    actorUserId: string;
    actorEmail: string;
    action: string;
    entityId: string;
    mutationRequestId: string;
    expectedFinalVersion: number;
    expectedFinalStatus: TeacherCuratorRequestStatus;
    before: unknown;
    after: unknown;
    createdAt: string;
  },
): D1Statement {
  return db.prepare(`INSERT INTO audit_events (
      id,actor_user_id,actor_email,action,entity_type,entity_id,request_id,
      before_json,after_json,metadata_json,created_at
    ) VALUES (?,?,?,?,'teacher_curator_request',(
      SELECT request.id FROM teacher_curator_change_requests request
      WHERE request.id=? AND request.version=? AND request.status=?
        AND request.last_mutation_request_id=?
    ),?,?,?,NULL,?)
  `).bind(
    `AUD-${crypto.randomUUID()}`,
    input.actorUserId,
    input.actorEmail,
    input.action,
    input.entityId,
    input.expectedFinalVersion,
    input.expectedFinalStatus,
    input.mutationRequestId,
    input.mutationRequestId,
    input.before === null ? null : JSON.stringify(input.before),
    JSON.stringify(input.after),
    input.createdAt,
  );
}

function classAuditStatement(
  db: TeacherCuratorRequestDatabase,
  actor: LibrarianActor,
  mutationRequestId: string,
  classYearId: string,
  action: string,
  beforeTeacherUserId: string | null,
  afterTeacherUserId: string | null,
  createdAt: string,
): D1Statement {
  return db.prepare(`INSERT INTO audit_events (
      id,actor_user_id,actor_email,action,entity_type,entity_id,request_id,
      before_json,after_json,metadata_json,created_at
    ) SELECT ?,?,?,?,'class_year',class.id,?,?,?,NULL,?
      FROM class_years class
      JOIN teacher_curator_change_requests request ON request.last_mutation_request_id=?
        AND request.status='approved'
      WHERE class.id=?
  `).bind(
    `AUD-${crypto.randomUUID()}`,
    actor.id,
    actor.email,
    action,
    mutationRequestId,
    JSON.stringify({ teacherUserId: beforeTeacherUserId }),
    JSON.stringify({ teacherUserId: afterTeacherUserId }),
    createdAt,
    mutationRequestId,
    classYearId,
  );
}

function completeCommandStatement(
  db: TeacherCuratorRequestDatabase,
  id: string,
  result: unknown,
  completedAt: string,
): D1Statement {
  return db.prepare(`UPDATE mutation_commands
    SET status='completed',result_json=?,updated_at=?,completed_at=?
    WHERE id=? AND status='processing'
      AND EXISTS (SELECT 1 FROM audit_events audit
        WHERE audit.request_id=mutation_commands.id
          AND audit.entity_type=mutation_commands.target_type
          AND audit.entity_id=mutation_commands.target_id)
  `).bind(JSON.stringify(result), completedAt, completedAt, id);
}

async function executeMutation<T>(
  db: TeacherCuratorRequestDatabase,
  statements: D1Statement[],
  commandId: string,
  actorUserId: string,
  requestHash: string,
  conflictCode: string,
  conflictMessage: string,
): Promise<T> {
  try {
    await db.batch(statements);
  } catch (error) {
    const replay = await replayCompletedCommand<T>(db, commandId, actorUserId, requestHash);
    if (replay) return replay;
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (message.includes("NOT NULL constraint failed: mutation_commands.actor_user_id")) {
      throw new TeacherCuratorRequestError("actor_access_revoked", 403, "Доступ змінився. Увійдіть знову.");
    }
    if (message.includes("UNIQUE constraint failed: mutation_commands.id")) {
      throw new TeacherCuratorRequestError("mutation_in_progress", 409, "Операція вже виконується.");
    }
    if (message.includes("idx_teacher_curator_requests_open_teacher")
      || message.includes("teacher_curator_change_requests.teacher_user_id")) {
      throw new TeacherCuratorRequestError("curator_request_pending", 409, "У вас уже є заявка, що очікує рішення.");
    }
    if (message.includes("NOT NULL constraint failed: audit_events.entity_id")) {
      throw new TeacherCuratorRequestError(conflictCode, 409, conflictMessage);
    }
    throw error;
  }
  const completed = await replayCompletedCommand<T>(db, commandId, actorUserId, requestHash);
  if (!completed) {
    throw new TeacherCuratorRequestError("mutation_result_invalid", 503, "Не вдалося підтвердити результат операції.");
  }
  return completed;
}

async function replayCompletedCommand<T>(
  db: TeacherCuratorRequestDatabase,
  requestId: string,
  actorUserId: string,
  requestHash: string,
): Promise<T | null> {
  const command = await db.prepare(`SELECT actor_user_id,status,request_hash,result_json,
      error_code,error_message FROM mutation_commands WHERE id=? LIMIT 1
  `).bind(requestId).first<StoredCommand>();
  if (!command) return null;
  if (command.actor_user_id !== actorUserId || command.request_hash !== requestHash) {
    throw new TeacherCuratorRequestError("request_id_conflict", 409, "Цей ідентифікатор уже використано для іншої операції.");
  }
  if (command.status === "processing") {
    throw new TeacherCuratorRequestError("mutation_in_progress", 409, "Операція ще виконується.");
  }
  if (command.status === "failed") {
    throw new TeacherCuratorRequestError(command.error_code || "mutation_failed", 409,
      command.error_message || "Операцію не виконано.");
  }
  if (command.status !== "completed" || !command.result_json) {
    throw new TeacherCuratorRequestError("mutation_result_invalid", 503, "Збережений результат операції пошкоджено.");
  }
  try {
    return JSON.parse(command.result_json) as T;
  } catch {
    throw new TeacherCuratorRequestError("mutation_result_invalid", 503, "Збережений результат операції пошкоджено.");
  }
}

async function resolveLibrarianActor(
  db: TeacherCuratorRequestDatabase,
  user: ChatGPTUser,
): Promise<LibrarianActor> {
  const exactId = user.d1UserId ?? null;
  const response = await db.prepare(`SELECT id,email,full_name FROM users
    WHERE status='active' AND role IN ('admin','librarian') AND email IS NOT NULL
      AND ((? IS NOT NULL AND id=?)
        OR (? IS NULL AND (auth_user_id=? OR lower(email)=lower(?))))
    ORDER BY id LIMIT 2
  `).bind(exactId, exactId, exactId, user.userId, user.email).all<{
    id: string; email: string; full_name: string;
  }>();
  const rows = response.results ?? [];
  if (rows.length !== 1) {
    throw new TeacherCuratorRequestError("actor_not_mapped", 403, "Обліковий запис не прив’язано до активного бібліотекаря.");
  }
  return { id: rows[0].id, email: rows[0].email.toLowerCase(), fullName: rows[0].full_name };
}

async function mutationHash(kind: string, payload: unknown): Promise<string> {
  return sha256Hex(`${kind}:${JSON.stringify(payload)}`);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
