import type { ChatGPTUser } from "@/app/chatgpt-auth";
import type {
  AcademicYearCreateInput,
  AcademicYearRolloverInput,
  ClassYearCloseInput,
  ClassYearCreateInput,
  ClassYearUpdateInput,
} from "@/lib/academic-admin-validation";
import { className } from "./academic-admin-validation.ts";

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

export type AcademicD1Database = {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<D1Result[]>;
};

type MutationActor = { id: string; email: string };

type StoredCommand = {
  status: string;
  request_hash: string;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
};

type AcademicYearRow = {
  id: string;
  label: string;
  start_date: string;
  end_date: string;
  status: "draft" | "active" | "closed";
  notes: string;
  version: number;
  created_at: string;
  updated_at: string;
};

type CohortRow = {
  id: string;
  status: "active" | "graduated" | "closed";
  notes: string;
  created_at: string;
  updated_at: string;
};

type ClassYearRow = {
  id: string;
  academic_year_id: string;
  cohort_id: string;
  class_name: string;
  grade: number;
  code: string;
  teacher_user_id: string | null;
  location_id: string | null;
  start_date: string;
  end_date: string;
  status: "planned" | "active" | "closed";
  actual_closed_date: string | null;
  notes: string;
  version: number;
  created_at: string;
  updated_at: string;
};

type RolloverSourceMutationRow = {
  id: string;
  cohortId: string;
  grade: number;
  expectedVersion: number;
  notes: string;
};

type RolloverTargetMutationRow = {
  id: string;
  cohortId: string;
  className: string;
  grade: number;
  code: string;
  teacherUserId: string | null;
  locationId: string | null;
  notes: string;
};

type RolloverCohortMutationRow = { id: string; status: "graduated" | "closed" };

type BulkAuditEvent = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeJson: string | null;
  afterJson: string | null;
  metadataJson: string | null;
};

export type AcademicReferenceData = {
  curators: Array<{
    id: string;
    fullName: string;
    role: "teacher" | "admin" | "librarian";
  }>;
  academicYears: Array<{
    id: string;
    label: string;
    startDate: string;
    endDate: string;
    status: string;
    notes: string;
    version: number;
  }>;
  cohorts: Array<{
    id: string;
    status: string;
    notes: string;
  }>;
  classYears: Array<{
    id: string;
    academicYearId: string;
    academicYearLabel: string;
    cohortId: string;
    className: string;
    grade: number;
    code: string;
    teacherUserId: string | null;
    teacherName: string;
    locationId: string | null;
    locationName: string;
    startDate: string;
    endDate: string;
    status: string;
    actualClosedDate: string | null;
    notes: string;
    version: number;
  }>;
};

export type AcademicYearCreateResult = {
  academicYearId: string;
  status: "draft" | "active";
  version: number;
  createdAt: string;
};

export type ClassYearMutationResult = {
  classYearId: string;
  academicYearId: string;
  cohortId: string;
  className: string;
  status: "planned" | "active" | "closed";
  version: number;
  updatedAt: string;
};

export type AcademicYearRolloverResult = {
  sourceYearId: string;
  sourceYearVersion: number;
  targetYearId: string;
  targetYearVersion: number;
  effectiveDate: string;
  promoted: Array<{
    sourceClassYearId: string;
    targetClassYearId: string;
    cohortId: string;
    className: string;
  }>;
  graduated: string[];
  closed: string[];
  completedAt: string;
};

export class AcademicAdminError extends Error {
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
    this.name = "AcademicAdminError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export async function readAcademicReferenceData(
  providedDb?: AcademicD1Database,
): Promise<AcademicReferenceData> {
  const db = database(providedDb);
  const [yearResult, cohortResult, classResult, curatorResult] = await Promise.all([
    db.prepare(`
      SELECT id, label, start_date, end_date, status, notes, version
      FROM academic_years
      ORDER BY start_date DESC, id DESC
      LIMIT 200
    `).all(),
    db.prepare(`
      SELECT id, status, notes
      FROM cohorts
      ORDER BY id ASC
      LIMIT 5000
    `).all(),
    db.prepare(`
      SELECT
        cy.id, cy.academic_year_id, ay.label AS academic_year_label,
        cy.cohort_id, cy.class_name, cy.grade, cy.code,
        cy.teacher_user_id, COALESCE(u.full_name, '') AS teacher_name,
        cy.location_id, COALESCE(l.name, '') AS location_name,
        cy.start_date, cy.end_date, cy.status, cy.actual_closed_date,
        cy.notes, cy.version
      FROM class_years cy
      JOIN academic_years ay ON ay.id = cy.academic_year_id
      LEFT JOIN users u ON u.id = cy.teacher_user_id
      LEFT JOIN locations l ON l.id = cy.location_id
      ORDER BY ay.start_date DESC, cy.grade ASC, cy.code ASC, cy.id ASC
      LIMIT 5000
    `).all(),
    db.prepare(`
      SELECT u.id, u.full_name, u.role
      FROM users u
      JOIN teacher_profiles p ON p.teacher_user_id=u.id AND p.closed_at IS NULL
      WHERE u.status = 'active'
      ORDER BY u.sort_name ASC, u.id ASC
      LIMIT 2000
    `).all(),
  ]);
  return {
    curators: (curatorResult.results ?? []).map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        id: text(row.id),
        fullName: text(row.full_name),
        role: text(row.role) as "teacher" | "admin" | "librarian",
      };
    }).filter((row) => row.id && row.fullName),
    academicYears: (yearResult.results ?? []).map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        id: text(row.id),
        label: text(row.label),
        startDate: text(row.start_date),
        endDate: text(row.end_date),
        status: text(row.status),
        notes: text(row.notes),
        version: positiveInteger(row.version),
      };
    }),
    cohorts: (cohortResult.results ?? []).map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        id: text(row.id),
        status: text(row.status),
        notes: text(row.notes),
      };
    }),
    classYears: (classResult.results ?? []).map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        id: text(row.id),
        academicYearId: text(row.academic_year_id),
        academicYearLabel: text(row.academic_year_label),
        cohortId: text(row.cohort_id),
        className: text(row.class_name),
        grade: positiveInteger(row.grade),
        code: text(row.code),
        teacherUserId: nullableText(row.teacher_user_id),
        teacherName: text(row.teacher_name),
        locationId: nullableText(row.location_id),
        locationName: text(row.location_name),
        startDate: text(row.start_date),
        endDate: text(row.end_date),
        status: text(row.status),
        actualClosedDate: nullableText(row.actual_closed_date),
        notes: text(row.notes),
        version: positiveInteger(row.version),
      };
    }),
  };
}

export async function createAcademicYearDirect(
  user: ChatGPTUser,
  input: AcademicYearCreateInput,
  providedDb?: AcademicD1Database,
): Promise<AcademicYearCreateResult> {
  const db = database(providedDb);
  const actor = await resolveMutationActor(db, user);
  const academicYearId = `YR-${input.label.replace("/", "-")}`;
  const requestHash = await mutationHash({ kind: "academic-year.create", actorUserId: actor.id, input });
  const replay = await replayCompletedCommand<AcademicYearCreateResult>(db, input.requestId, requestHash);
  if (replay) return replay;
  const duplicate = await db.prepare(`
    SELECT id FROM academic_years WHERE id = ? OR label = ? LIMIT 1
  `).bind(academicYearId, input.label).first<{ id: string }>();
  if (duplicate) {
    throw new AcademicAdminError(
      "academic_year_conflict",
      409,
      "Навчальний рік із такою назвою вже існує.",
      { academicYearId: duplicate.id },
    );
  }
  const yearCount = await db.prepare(`SELECT count(*) AS count FROM academic_years`).first<{ count: number }>();
  const status: "draft" | "active" = Number(yearCount?.count ?? 0) === 0 ? "active" : "draft";

  const createdAt = new Date().toISOString();
  const result: AcademicYearCreateResult = {
    academicYearId,
    status,
    version: 1,
    createdAt,
  };
  const after = {
    id: academicYearId,
    label: input.label,
    startDate: input.startDate,
    endDate: input.endDate,
    status,
    notes: input.notes,
    version: 1,
  };
  const statements = [
    insertCommandStatement(db, input.requestId, requestHash, actor.id, "academic-year.create", "academic_year", academicYearId, createdAt),
    db.prepare(`
      INSERT INTO academic_years (
        id, label, start_date, end_date, status, notes, version, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, 1, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM academic_years WHERE id = ? OR label = ?
      )
        AND (? = 'draft' OR NOT EXISTS (SELECT 1 FROM academic_years))
    `).bind(
      academicYearId,
      input.label,
      input.startDate,
      input.endDate,
      status,
      input.notes,
      createdAt,
      createdAt,
      academicYearId,
      input.label,
      status,
    ),
    auditGuardStatement(db, {
      actor,
      action: "academic_year.created",
      entityType: "academic_year",
      entityId: academicYearId,
      requestId: input.requestId,
      before: null,
      after,
      metadata: null,
      createdAt,
      guardSql: "SELECT id FROM academic_years WHERE id = ? AND version = 1 AND changes() = 1",
      guardBindings: [academicYearId],
    }),
    completeCommandStatement(db, input.requestId, result, createdAt),
  ];
  try {
    const replayed = await executeIdempotentBatch<AcademicYearCreateResult>(
      db,
      statements,
      input.requestId,
      requestHash,
      "academic_year_conflict",
      "Навчальний рік змінився під час створення. Оновіть дані.",
    );
    return replayed ?? result;
  } catch (error) {
    if (isUniqueConflict(error)) {
      throw new AcademicAdminError("academic_year_conflict", 409, "Навчальний рік із такою назвою вже існує.");
    }
    throw error;
  }
}

export async function createClassYearDirect(
  user: ChatGPTUser,
  input: ClassYearCreateInput,
  providedDb?: AcademicD1Database,
): Promise<ClassYearMutationResult> {
  const db = database(providedDb);
  const actor = await resolveMutationActor(db, user);
  const requestHash = await mutationHash({ kind: "class-year.create", actorUserId: actor.id, input });
  const replay = await replayCompletedCommand<ClassYearMutationResult>(db, input.requestId, requestHash);
  if (replay) return replay;
  const year = await requireAcademicYear(db, input.academicYearId, false);
  if (year.status !== "active") {
    throw new AcademicAdminError(
      "academic_year_not_active",
      409,
      "Новий клас можна відкрити лише в активному навчальному році.",
    );
  }
  await assertClassCurator(db, input.teacherUserId);
  await assertClassLocation(db, input.locationId);
  if (input.cohortMode === "existing" && input.cohortId) {
    await requireActiveCohort(db, input.cohortId);
    const openClass = await db.prepare(`
      SELECT id FROM class_years
      WHERE cohort_id = ? AND status IN ('planned', 'active')
      LIMIT 1
    `).bind(input.cohortId).first<{ id: string }>();
    if (openClass) {
      throw new AcademicAdminError(
        "cohort_still_open",
        409,
        "Класна група вже використовується відкритим класом.",
        { classYearId: openClass.id },
      );
    }
  }
  const desiredName = className(input.grade, input.code);
  const duplicate = await db.prepare(`
    SELECT id FROM class_years
    WHERE academic_year_id = ? AND (cohort_id = ? OR class_name = ?)
    LIMIT 1
  `).bind(input.academicYearId, input.cohortId, desiredName).first<{ id: string }>();
  if (duplicate) {
    throw new AcademicAdminError(
      "duplicate_class_year",
      409,
      "Такий клас або класна група вже є в цьому навчальному році.",
      { classYearId: duplicate.id },
    );
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const cohortId = input.cohortMode === "new"
      ? await allocateCohortId(db)
      : input.cohortId as string;
    const classYearId = await allocateClassYearId(db, input.academicYearId);
    const createdAt = new Date().toISOString();
    const status = "active" as const;
    const result: ClassYearMutationResult = {
      classYearId,
      academicYearId: input.academicYearId,
      cohortId,
      className: desiredName,
      status,
      version: 1,
      updatedAt: createdAt,
    };
    const after = {
      id: classYearId,
      academicYearId: input.academicYearId,
      cohortId,
      className: desiredName,
      grade: input.grade,
      code: input.code,
      teacherUserId: input.teacherUserId,
      locationId: input.locationId,
      startDate: year.start_date,
      endDate: year.end_date,
      status,
      actualClosedDate: null,
      notes: input.notes,
      version: 1,
    };
    const statements: D1Statement[] = [
      insertCommandStatement(db, input.requestId, requestHash, actor.id, "class-year.create", "class_year", classYearId, createdAt),
    ];
    if (input.cohortMode === "new") {
      const cohortAfter = { id: cohortId, status: "active", notes: "" };
      statements.push(
        db.prepare(`
          INSERT INTO cohorts (id, status, notes, created_at, updated_at)
          VALUES (?, 'active', '', ?, ?)
        `).bind(cohortId, createdAt, createdAt),
        auditGuardStatement(db, {
          actor,
          action: "cohort.created",
          entityType: "cohort",
          entityId: cohortId,
          requestId: input.requestId,
          before: null,
          after: cohortAfter,
          metadata: { classYearId },
          createdAt,
          guardSql: "SELECT id FROM cohorts WHERE id = ? AND changes() = 1",
          guardBindings: [cohortId],
        }),
      );
    }
    statements.push(
      db.prepare(`
        INSERT INTO class_years (
          id, academic_year_id, cohort_id, class_name, grade, code,
          teacher_user_id, location_id, start_date, end_date, status,
          actual_closed_date, notes, version, created_at, updated_at
        )
        SELECT
          ?, ay.id, c.id, ?, ?, ?, ?, ?, ay.start_date, ay.end_date, ?,
          NULL, ?, 1, ?, ?
        FROM academic_years ay
        JOIN cohorts c ON c.id = ? AND c.status = 'active'
        WHERE ay.id = ? AND ay.version = ? AND ay.status = 'active'
          AND (? IS NULL OR EXISTS (
            SELECT 1 FROM users u JOIN teacher_profiles p
              ON p.teacher_user_id=u.id AND p.closed_at IS NULL
            WHERE u.id = ? AND u.status = 'active'
          ))
          AND (? IS NULL OR EXISTS (
            SELECT 1 FROM locations WHERE id = ? AND status = 'active' AND type != 'service'
          ))
          AND NOT EXISTS (
            SELECT 1 FROM class_years
            WHERE academic_year_id = ay.id AND (cohort_id = c.id OR class_name = ?)
          )
          AND NOT EXISTS (
            SELECT 1 FROM class_years
            WHERE cohort_id = c.id AND status IN ('planned', 'active')
          )
      `).bind(
        classYearId,
        desiredName,
        input.grade,
        input.code,
        input.teacherUserId,
        input.locationId,
        status,
        input.notes,
        createdAt,
        createdAt,
        cohortId,
        input.academicYearId,
        year.version,
        input.teacherUserId,
        input.teacherUserId,
        input.locationId,
        input.locationId,
        desiredName,
      ),
      auditGuardStatement(db, {
        actor,
        action: "class_year.created",
        entityType: "class_year",
        entityId: classYearId,
        requestId: input.requestId,
        before: null,
        after,
        metadata: { cohortMode: input.cohortMode },
        createdAt,
        guardSql: "SELECT id FROM class_years WHERE id = ? AND version = 1 AND changes() = 1",
        guardBindings: [classYearId],
      }),
      completeCommandStatement(db, input.requestId, result, createdAt),
    );
    try {
      const replayed = await executeIdempotentBatch<ClassYearMutationResult>(
        db,
        statements,
        input.requestId,
        requestHash,
        "class_year_conflict",
        "Дані року, групи або довідників змінилися. Оновіть форму.",
      );
      return replayed ?? result;
    } catch (error) {
      if (attempt < 2 && isAllocationConflict(error)) continue;
      if (isUniqueConflict(error)) {
        throw new AcademicAdminError("duplicate_class_year", 409, "Такий клас або класна група вже є в цьому навчальному році.");
      }
      throw error;
    }
  }
  throw new AcademicAdminError("class_year_conflict", 409, "Не вдалося безпечно призначити ID класу. Повторіть спробу.");
}

export async function updateClassYearDirect(
  user: ChatGPTUser,
  classYearId: string,
  input: ClassYearUpdateInput,
  providedDb?: AcademicD1Database,
): Promise<ClassYearMutationResult> {
  const db = database(providedDb);
  const actor = await resolveMutationActor(db, user);
  const requestHash = await mutationHash({ kind: "class-year.update", actorUserId: actor.id, classYearId, input });
  const replay = await replayCompletedCommand<ClassYearMutationResult>(db, input.requestId, requestHash);
  if (replay) return replay;
  const beforeRow = await requireClassYear(db, classYearId);
  if (beforeRow.status === "closed") {
    throw new AcademicAdminError("class_year_closed", 409, "Закритий клас не можна редагувати.");
  }
  if (beforeRow.version !== input.expectedVersion) {
    throw versionConflict(classYearId, beforeRow.version);
  }
  const teacherUserId = Object.hasOwn(input.changes, "teacherUserId")
    ? input.changes.teacherUserId ?? null
    : beforeRow.teacher_user_id;
  const locationId = Object.hasOwn(input.changes, "locationId")
    ? input.changes.locationId ?? null
    : beforeRow.location_id;
  await assertClassCurator(db, teacherUserId);
  await assertClassLocation(db, locationId);
  const grade = input.changes.grade ?? beforeRow.grade;
  const code = input.changes.code ?? beforeRow.code;
  const desiredName = className(grade, code);
  const notes = Object.hasOwn(input.changes, "notes")
    ? input.changes.notes ?? ""
    : beforeRow.notes;
  const duplicate = await db.prepare(`
    SELECT id FROM class_years
    WHERE academic_year_id = ? AND class_name = ? AND id != ?
    LIMIT 1
  `).bind(beforeRow.academic_year_id, desiredName, classYearId).first<{ id: string }>();
  if (duplicate) {
    throw new AcademicAdminError("duplicate_class_year", 409, "Клас із такою назвою вже існує в навчальному році.", { classYearId: duplicate.id });
  }
  const before = classYearSnapshot(beforeRow);
  const updatedAt = new Date().toISOString();
  const after = {
    ...before,
    className: desiredName,
    grade,
    code,
    teacherUserId,
    locationId,
    notes,
    version: beforeRow.version + 1,
  };
  if (stableStringify({ ...before, version: 0 }) === stableStringify({ ...after, version: 0 })) {
    throw new AcademicAdminError("no_changes", 400, "Нові значення не відрізняються від поточних.");
  }
  const result: ClassYearMutationResult = {
    classYearId,
    academicYearId: beforeRow.academic_year_id,
    cohortId: beforeRow.cohort_id,
    className: desiredName,
    status: beforeRow.status,
    version: beforeRow.version + 1,
    updatedAt,
  };
  const statements = [
    insertCommandStatement(db, input.requestId, requestHash, actor.id, "class-year.update", "class_year", classYearId, updatedAt),
    db.prepare(`
      UPDATE class_years
      SET class_name = ?, grade = ?, code = ?, teacher_user_id = ?,
          location_id = ?, notes = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND status != 'closed'
        AND (? IS NULL OR EXISTS (
          SELECT 1 FROM users u JOIN teacher_profiles p
            ON p.teacher_user_id=u.id AND p.closed_at IS NULL
          WHERE u.id = ? AND u.status = 'active'
        ))
        AND (? IS NULL OR EXISTS (
          SELECT 1 FROM locations WHERE id = ? AND status = 'active' AND type != 'service'
        ))
        AND NOT EXISTS (
          SELECT 1 FROM class_years other
          WHERE other.academic_year_id = class_years.academic_year_id
            AND other.class_name = ? AND other.id != class_years.id
        )
    `).bind(
      desiredName,
      grade,
      code,
      teacherUserId,
      locationId,
      notes,
      updatedAt,
      classYearId,
      input.expectedVersion,
      teacherUserId,
      teacherUserId,
      locationId,
      locationId,
      desiredName,
    ),
    auditGuardStatement(db, {
      actor,
      action: "class_year.updated",
      entityType: "class_year",
      entityId: classYearId,
      requestId: input.requestId,
      before,
      after,
      metadata: input.reason ? { reason: input.reason } : null,
      createdAt: updatedAt,
      guardSql: "SELECT id FROM class_years WHERE id = ? AND version = ? AND changes() = 1",
      guardBindings: [classYearId, result.version],
    }),
    completeCommandStatement(db, input.requestId, result, updatedAt),
  ];
  const replayed = await executeIdempotentBatch<ClassYearMutationResult>(
    db,
    statements,
    input.requestId,
    requestHash,
    "class_year_version_conflict",
    "Клас уже змінився. Оновіть дані перед повторним збереженням.",
  );
  return replayed ?? result;
}

export async function closeClassYearDirect(
  user: ChatGPTUser,
  classYearId: string,
  input: ClassYearCloseInput,
  providedDb?: AcademicD1Database,
): Promise<ClassYearMutationResult> {
  const db = database(providedDb);
  const actor = await resolveMutationActor(db, user);
  const requestHash = await mutationHash({ kind: "class-year.close", actorUserId: actor.id, classYearId, input });
  const replay = await replayCompletedCommand<ClassYearMutationResult>(db, input.requestId, requestHash);
  if (replay) return replay;
  const beforeRow = await requireClassYear(db, classYearId);
  if (beforeRow.status === "closed") throw new AcademicAdminError("class_year_closed", 409, "Клас уже закрито.");
  if (beforeRow.version !== input.expectedVersion) throw versionConflict(classYearId, beforeRow.version);
  const openLoan = await findOpenClassLoan(db, [classYearId]);
  if (openLoan) throw classHasOpenLoans(openLoan);
  if (input.reason === "graduated" && (beforeRow.grade !== 11 || !input.closeCohort)) {
    throw new AcademicAdminError(
      "graduation_requires_final_grade",
      409,
      "Випуск дозволений лише для 11 класу із закриттям класної групи.",
    );
  }
  if (input.actualClosedDate < beforeRow.start_date) {
    throw new AcademicAdminError("close_date_invalid", 400, "Дата закриття не може передувати даті відкриття класу.");
  }
  if (input.closeCohort) {
    const other = await db.prepare(`
      SELECT id FROM class_years
      WHERE cohort_id = ? AND id != ? AND status IN ('planned', 'active')
      LIMIT 1
    `).bind(beforeRow.cohort_id, classYearId).first<{ id: string }>();
    if (other) {
      throw new AcademicAdminError(
        "cohort_still_open",
        409,
        "Група ще використовується іншим відкритим класом.",
        { classYearId: other.id },
      );
    }
  }
  const before = classYearSnapshot(beforeRow);
  const updatedAt = new Date().toISOString();
  const notes = input.notes || beforeRow.notes;
  const after = {
    ...before,
    status: "closed",
    actualClosedDate: input.actualClosedDate,
    notes,
    version: beforeRow.version + 1,
  };
  const result: ClassYearMutationResult = {
    classYearId,
    academicYearId: beforeRow.academic_year_id,
    cohortId: beforeRow.cohort_id,
    className: beforeRow.class_name,
    status: "closed",
    version: beforeRow.version + 1,
    updatedAt,
  };
  const statements: D1Statement[] = [
    insertCommandStatement(db, input.requestId, requestHash, actor.id, "class-year.close", "class_year", classYearId, updatedAt),
    db.prepare(`
      UPDATE class_years
      SET status = 'closed', actual_closed_date = ?, notes = ?,
          version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND status IN ('planned', 'active')
        AND NOT EXISTS (
          SELECT 1 FROM class_loans
          WHERE class_year_id = ? AND status = 'open'
        )
    `).bind(
      input.actualClosedDate,
      notes,
      updatedAt,
      classYearId,
      input.expectedVersion,
      classYearId,
    ),
    auditGuardStatement(db, {
      actor,
      action: "class_year.closed",
      entityType: "class_year",
      entityId: classYearId,
      requestId: input.requestId,
      before,
      after,
      metadata: { reason: input.reason, closeCohort: input.closeCohort },
      createdAt: updatedAt,
      guardSql: "SELECT id FROM class_years WHERE id = ? AND version = ? AND status = 'closed' AND changes() = 1",
      guardBindings: [classYearId, result.version],
    }),
  ];
  if (input.closeCohort) {
    const cohort = await requireActiveCohort(db, beforeRow.cohort_id);
    const cohortStatus = input.reason === "graduated" ? "graduated" : "closed";
    statements.push(
      db.prepare(`
        UPDATE cohorts
        SET status = ?, updated_at = ?
        WHERE id = ? AND status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM class_years
            WHERE cohort_id = ? AND status IN ('planned', 'active')
          )
      `).bind(cohortStatus, updatedAt, cohort.id, cohort.id),
      auditGuardStatement(db, {
        actor,
        action: "cohort.closed",
        entityType: "cohort",
        entityId: cohort.id,
        requestId: input.requestId,
        before: cohortSnapshot(cohort),
        after: { ...cohortSnapshot(cohort), status: cohortStatus },
        metadata: { reason: input.reason, classYearId },
        createdAt: updatedAt,
        guardSql: "SELECT id FROM cohorts WHERE id = ? AND status = ? AND changes() = 1",
        guardBindings: [cohort.id, cohortStatus],
      }),
    );
  }
  statements.push(completeCommandStatement(db, input.requestId, result, updatedAt));
  try {
    const replayed = await executeIdempotentBatch<ClassYearMutationResult>(
      db,
      statements,
      input.requestId,
      requestHash,
      "class_year_version_conflict",
      "Клас або група вже змінилися. Оновіть дані перед повторним закриттям.",
    );
    return replayed ?? result;
  } catch (error) {
    const racedLoan = await findOpenClassLoan(db, [classYearId]);
    if (racedLoan) throw classHasOpenLoans(racedLoan);
    throw error;
  }
}

export async function rolloverAcademicYearDirect(
  user: ChatGPTUser,
  input: AcademicYearRolloverInput,
  providedDb?: AcademicD1Database,
): Promise<AcademicYearRolloverResult> {
  const db = database(providedDb);
  const actor = await resolveMutationActor(db, user);
  const requestHash = await mutationHash({ kind: "academic-year.rollover", actorUserId: actor.id, input });
  const replay = await replayCompletedCommand<AcademicYearRolloverResult>(db, input.requestId, requestHash);
  if (replay) return replay;
  const sourceYear = await requireAcademicYear(db, input.sourceYearId, false);
  const targetYear = await requireAcademicYear(db, input.targetYearId, false);
  if (sourceYear.status !== "active") {
    throw new AcademicAdminError("source_year_not_active", 409, "Перехід дозволений лише з активного навчального року.");
  }
  if (targetYear.status !== "draft") {
    throw new AcademicAdminError("target_year_not_draft", 409, "Цільовий навчальний рік має бути чернеткою.");
  }
  if (sourceYear.version !== input.sourceYearVersion || targetYear.version !== input.targetYearVersion) {
    throw new AcademicAdminError("academic_year_version_conflict", 409, "Навчальні роки вже змінилися. Оновіть план переходу.");
  }
  if (input.effectiveDate < targetYear.start_date || input.effectiveDate > targetYear.end_date) {
    throw new AcademicAdminError("rollover_date_invalid", 400, "Дата переходу має належати цільовому навчальному року.");
  }
  const sourceRows = await listOpenClassYears(db, input.sourceYearId);
  const openSourceLoan = await findOpenClassLoan(
    db,
    sourceRows.map((row) => row.id),
  );
  if (openSourceLoan) throw classHasOpenLoans(openSourceLoan);
  const inputIds = new Set(input.classes.map((item) => item.sourceClassYearId));
  const missing = sourceRows.filter((row) => !inputIds.has(row.id)).map((row) => row.id);
  const foreign = input.classes.filter((item) => !sourceRows.some((row) => row.id === item.sourceClassYearId)).map((item) => item.sourceClassYearId);
  if (missing.length || foreign.length || sourceRows.length !== input.classes.length) {
    throw new AcademicAdminError(
      "rollover_plan_incomplete",
      409,
      "План має охоплювати всі відкриті класи вихідного року без зайвих рядків.",
      { missingClassYearIds: missing, foreignClassYearIds: foreign },
    );
  }
  const targetExisting = await db.prepare(`
    SELECT id FROM class_years WHERE academic_year_id = ? LIMIT 1
  `).bind(targetYear.id).first<{ id: string }>();
  if (targetExisting) {
    throw new AcademicAdminError("target_year_not_empty", 409, "У цільовому році вже є класи.", { classYearId: targetExisting.id });
  }

  const rowById = new Map(sourceRows.map((row) => [row.id, row]));
  const desiredTeacherIds = new Set<string>();
  const desiredLocationIds = new Set<string>();
  for (const item of input.classes) {
    const row = rowById.get(item.sourceClassYearId) as ClassYearRow;
    if (
      row.version !== item.expectedVersion
      || row.cohort_id !== item.cohortId
      || row.grade !== item.sourceGrade
    ) {
      throw new AcademicAdminError(
        "class_year_version_conflict",
        409,
        "Один із класів уже змінився. Оновіть план переходу.",
        { classYearId: row.id, currentVersion: row.version },
      );
    }
    if (item.action === "promote") {
      const teacherUserId = Object.hasOwn(item, "teacherUserId") ? item.teacherUserId ?? null : row.teacher_user_id;
      const locationId = Object.hasOwn(item, "locationId") ? item.locationId ?? null : row.location_id;
      if (teacherUserId) desiredTeacherIds.add(teacherUserId);
      if (locationId) desiredLocationIds.add(locationId);
    }
  }
  const cohortById = await loadAndValidateRolloverReferences(
    db,
    sourceYear.id,
    [...new Set(input.classes.map((item) => item.cohortId))],
    [...desiredTeacherIds],
    [...desiredLocationIds],
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const promotedInputs = input.classes.filter((item) => item.action === "promote");
    const allocatedIds = await allocateClassYearIds(db, targetYear.id, promotedInputs.length);
    const promotedIdBySource = new Map(promotedInputs.map((item, index) => [item.sourceClassYearId, allocatedIds[index]]));
    const completedAt = new Date().toISOString();
    const result: AcademicYearRolloverResult = {
      sourceYearId: sourceYear.id,
      sourceYearVersion: sourceYear.version + 1,
      targetYearId: targetYear.id,
      targetYearVersion: targetYear.version + 1,
      effectiveDate: input.effectiveDate,
      promoted: [],
      graduated: [],
      closed: [],
      completedAt,
    };
    const statements: D1Statement[] = [
      insertCommandStatement(db, input.requestId, requestHash, actor.id, "academic-year.rollover", "academic_year", targetYear.id, completedAt),
      db.prepare(`
        UPDATE mutation_commands
        SET kind = CASE
          WHEN NOT EXISTS (
            SELECT 1 FROM class_years WHERE academic_year_id = ?
          ) THEN kind
          ELSE NULL
        END
        WHERE id = ? AND status = 'processing'
      `).bind(targetYear.id, input.requestId),
    ];
    const sourceMutationRows: RolloverSourceMutationRow[] = [];
    const sourceAuditEvents: BulkAuditEvent[] = [];
    const targetMutationRows: RolloverTargetMutationRow[] = [];
    const targetAuditEvents: BulkAuditEvent[] = [];
    const cohortMutationRows: RolloverCohortMutationRow[] = [];
    const cohortAuditEvents: BulkAuditEvent[] = [];

    for (const item of input.classes) {
      const source = rowById.get(item.sourceClassYearId) as ClassYearRow;
      const sourceBefore = classYearSnapshot(source);
      const sourceAfter = {
        ...sourceBefore,
        status: "closed",
        actualClosedDate: input.effectiveDate,
        notes: item.notes || source.notes,
        version: source.version + 1,
      };
      sourceMutationRows.push({
        id: source.id,
        cohortId: item.cohortId,
        grade: item.sourceGrade,
        expectedVersion: item.expectedVersion,
        notes: item.notes || source.notes,
      });
      sourceAuditEvents.push(createBulkAuditEvent({
        action: "class_year.closed",
        entityType: "class_year",
        entityId: source.id,
        before: sourceBefore,
        after: sourceAfter,
        metadata: { reason: item.action, rolloverTargetYearId: targetYear.id },
      }));

      if (item.action === "promote") {
        const targetClassYearId = promotedIdBySource.get(source.id) as string;
        const teacherUserId = Object.hasOwn(item, "teacherUserId") ? item.teacherUserId ?? null : source.teacher_user_id;
        const locationId = Object.hasOwn(item, "locationId") ? item.locationId ?? null : source.location_id;
        const targetGrade = item.targetGrade as number;
        const targetCode = item.targetCode as string;
        const targetName = className(targetGrade, targetCode);
        const targetNotes = item.notes ?? "";
        const targetAfter = {
          id: targetClassYearId,
          academicYearId: targetYear.id,
          cohortId: source.cohort_id,
          className: targetName,
          grade: targetGrade,
          code: targetCode,
          teacherUserId,
          locationId,
          startDate: targetYear.start_date,
          endDate: targetYear.end_date,
          status: "active",
          actualClosedDate: null,
          notes: targetNotes,
          version: 1,
        };
        result.promoted.push({
          sourceClassYearId: source.id,
          targetClassYearId,
          cohortId: source.cohort_id,
          className: targetName,
        });
        targetMutationRows.push({
          id: targetClassYearId,
          cohortId: source.cohort_id,
          className: targetName,
          grade: targetGrade,
          code: targetCode,
          teacherUserId,
          locationId,
          notes: targetNotes,
        });
        targetAuditEvents.push(createBulkAuditEvent({
          action: "class_year.created",
          entityType: "class_year",
          entityId: targetClassYearId,
          before: null,
          after: targetAfter,
          metadata: {
            rolloverSourceClassYearId: source.id,
            overrideReason: item.overrideReason || null,
          },
        }));
      } else {
        const cohort = cohortById.get(source.cohort_id) as CohortRow;
        const nextStatus = item.action === "graduate" ? "graduated" : "closed";
        if (item.action === "graduate") result.graduated.push(source.id);
        else result.closed.push(source.id);
        cohortMutationRows.push({ id: cohort.id, status: nextStatus });
        cohortAuditEvents.push(createBulkAuditEvent({
          action: "cohort.closed",
          entityType: "cohort",
          entityId: cohort.id,
          before: cohortSnapshot(cohort),
          after: { ...cohortSnapshot(cohort), status: nextStatus },
          metadata: { reason: item.action, sourceClassYearId: source.id },
        }));
      }
    }

    statements.push(
      bulkCloseSourceClassesStatement(db, sourceMutationRows, sourceYear.id, input.effectiveDate, completedAt),
      changesGuardStatement(db, input.requestId, sourceMutationRows.length),
      bulkAuditStatement(db, actor, input.requestId, sourceAuditEvents, completedAt),
    );
    if (targetMutationRows.length) {
      statements.push(
        bulkCreateTargetClassesStatement(db, targetMutationRows, targetYear, completedAt),
        changesGuardStatement(db, input.requestId, targetMutationRows.length),
        bulkAuditStatement(db, actor, input.requestId, targetAuditEvents, completedAt),
      );
    }
    if (cohortMutationRows.length) {
      statements.push(
        bulkCloseCohortsStatement(db, cohortMutationRows, completedAt),
        changesGuardStatement(db, input.requestId, cohortMutationRows.length),
        bulkAuditStatement(db, actor, input.requestId, cohortAuditEvents, completedAt),
      );
    }

    statements.push(
      db.prepare(`
        UPDATE academic_years
        SET status = 'closed', version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM class_years
            WHERE academic_year_id = ? AND status IN ('planned', 'active')
          )
      `).bind(completedAt, sourceYear.id, input.sourceYearVersion, sourceYear.id),
      auditGuardStatement(db, {
        actor,
        action: "academic_year.closed",
        entityType: "academic_year",
        entityId: sourceYear.id,
        requestId: input.requestId,
        before: academicYearSnapshot(sourceYear),
        after: { ...academicYearSnapshot(sourceYear), status: "closed", version: sourceYear.version + 1 },
        metadata: { targetYearId: targetYear.id, effectiveDate: input.effectiveDate },
        createdAt: completedAt,
        guardSql: "SELECT id FROM academic_years WHERE id = ? AND version = ? AND status = 'closed' AND changes() = 1",
        guardBindings: [sourceYear.id, sourceYear.version + 1],
      }),
      db.prepare(`
        UPDATE academic_years
        SET status = 'active', version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'draft'
          AND NOT EXISTS (
            SELECT 1 FROM academic_years WHERE id != ? AND status = 'active'
          )
      `).bind(completedAt, targetYear.id, input.targetYearVersion, targetYear.id),
      auditGuardStatement(db, {
        actor,
        action: "academic_year.activated",
        entityType: "academic_year",
        entityId: targetYear.id,
        requestId: input.requestId,
        before: academicYearSnapshot(targetYear),
        after: { ...academicYearSnapshot(targetYear), status: "active", version: targetYear.version + 1 },
        metadata: { sourceYearId: sourceYear.id, effectiveDate: input.effectiveDate, notes: input.notes || null },
        createdAt: completedAt,
        guardSql: "SELECT id FROM academic_years WHERE id = ? AND version = ? AND status = 'active' AND changes() = 1",
        guardBindings: [targetYear.id, targetYear.version + 1],
      }),
      completeCommandStatement(db, input.requestId, result, completedAt),
    );

    try {
      const replayed = await executeIdempotentBatch<AcademicYearRolloverResult>(
        db,
        statements,
        input.requestId,
        requestHash,
        "rollover_conflict",
        "Рік, клас або довідник змінився під час переходу. Оновіть план.",
      );
      return replayed ?? result;
    } catch (error) {
      const racedLoan = await findOpenClassLoan(
        db,
        sourceRows.map((row) => row.id),
      );
      if (racedLoan) throw classHasOpenLoans(racedLoan);
      if (attempt < 2 && isClassAllocationConflict(error)) continue;
      if (isUniqueConflict(error)) {
        throw new AcademicAdminError("rollover_conflict", 409, "Цільові класи вже існують або конфліктують між собою.");
      }
      throw error;
    }
  }
  throw new AcademicAdminError("rollover_conflict", 409, "Не вдалося безпечно призначити ID цільових класів.");
}

function database(value?: AcademicD1Database): AcademicD1Database {
  if (!value) throw new AcademicAdminError("database_unavailable", 503, "База даних тимчасово недоступна.");
  return value;
}

async function resolveMutationActor(
  db: AcademicD1Database,
  user: ChatGPTUser,
): Promise<MutationActor> {
  const response = await db.prepare(`
    SELECT id, email
    FROM users
    WHERE status = 'active' AND role IN ('admin', 'librarian')
      AND (auth_user_id = ? OR lower(email) = lower(?))
    ORDER BY CASE WHEN auth_user_id = ? THEN 0 ELSE 1 END, id
    LIMIT 2
  `).bind(user.userId, user.email, user.userId).all<{ id: string; email: string | null }>();
  const rows = response.results ?? [];
  if (rows.length !== 1) {
    throw new AcademicAdminError(
      "actor_not_mapped",
      403,
      rows.length > 1
        ? "Обліковий запис бібліотекаря налаштовано неоднозначно."
        : "Обліковий запис не прив’язано до активного бібліотекаря.",
    );
  }
  return { id: rows[0].id, email: user.email.toLowerCase() };
}

async function requireAcademicYear(
  db: AcademicD1Database,
  id: string,
  allowClosed: boolean,
): Promise<AcademicYearRow> {
  const row = await db.prepare(`
    SELECT id, label, start_date, end_date, status, notes, version, created_at, updated_at
    FROM academic_years WHERE id = ? LIMIT 1
  `).bind(id).first<AcademicYearRow>();
  if (!row) throw new AcademicAdminError("academic_year_not_found", 404, "Навчальний рік не знайдено.");
  if (!allowClosed && row.status === "closed") {
    throw new AcademicAdminError("academic_year_closed", 409, "Навчальний рік уже закрито.");
  }
  return row;
}

async function requireClassYear(db: AcademicD1Database, id: string): Promise<ClassYearRow> {
  const row = await db.prepare(`
    SELECT
      id, academic_year_id, cohort_id, class_name, grade, code,
      teacher_user_id, location_id, start_date, end_date, status,
      actual_closed_date, notes, version, created_at, updated_at
    FROM class_years WHERE id = ? LIMIT 1
  `).bind(id).first<ClassYearRow>();
  if (!row) throw new AcademicAdminError("class_year_not_found", 404, "Клас не знайдено.");
  return row;
}

async function listOpenClassYears(
  db: AcademicD1Database,
  academicYearId: string,
): Promise<ClassYearRow[]> {
  const response = await db.prepare(`
    SELECT
      id, academic_year_id, cohort_id, class_name, grade, code,
      teacher_user_id, location_id, start_date, end_date, status,
      actual_closed_date, notes, version, created_at, updated_at
    FROM class_years
    WHERE academic_year_id = ? AND status IN ('planned', 'active')
    ORDER BY grade, code, id
    LIMIT 101
  `).bind(academicYearId).all<ClassYearRow>();
  const rows = response.results ?? [];
  if (rows.length > 100) throw new AcademicAdminError("rollover_too_large", 409, "Один перехід підтримує не більше 100 класів.");
  return rows;
}

async function requireActiveCohort(db: AcademicD1Database, id: string): Promise<CohortRow> {
  const row = await db.prepare(`
    SELECT id, status, notes, created_at, updated_at
    FROM cohorts WHERE id = ? LIMIT 1
  `).bind(id).first<CohortRow>();
  if (!row) throw new AcademicAdminError("cohort_not_found", 404, "Класну групу не знайдено.");
  if (row.status !== "active") throw new AcademicAdminError("cohort_closed", 409, "Класна група вже закрита.");
  return row;
}

async function assertClassCurator(db: AcademicD1Database, id: string | null): Promise<void> {
  if (!id) return;
  const row = await db.prepare(`
    SELECT u.id FROM users u
    JOIN teacher_profiles p ON p.teacher_user_id=u.id AND p.closed_at IS NULL
    WHERE u.id = ? AND u.status = 'active' LIMIT 1
  `).bind(id).first<{ id: string }>();
  if (!row) throw new AcademicAdminError("teacher_not_found", 404, "Активного вчителя не знайдено.");
}

async function assertClassLocation(db: AcademicD1Database, id: string | null): Promise<void> {
  if (!id) return;
  const row = await db.prepare(`
    SELECT id FROM locations
    WHERE id = ? AND status = 'active' AND type != 'service'
    LIMIT 1
  `).bind(id).first<{ id: string }>();
  if (!row) throw new AcademicAdminError("location_not_found", 404, "Активний кабінет не знайдено.");
}

async function loadAndValidateRolloverReferences(
  db: AcademicD1Database,
  sourceYearId: string,
  cohortIds: string[],
  teacherIds: string[],
  locationIds: string[],
): Promise<Map<string, CohortRow>> {
  const cohortResponse = await db.prepare(`
    SELECT c.id, c.status, c.notes, c.created_at, c.updated_at
    FROM cohorts c
    JOIN json_each(?) requested ON requested.value = c.id
  `).bind(JSON.stringify(cohortIds)).all<CohortRow>();
  const cohortById = new Map((cohortResponse.results ?? []).map((row) => [row.id, row]));
  for (const id of cohortIds) {
    const cohort = cohortById.get(id);
    if (!cohort) {
      throw new AcademicAdminError("cohort_not_found", 404, "Класну групу не знайдено.", { cohortId: id });
    }
    if (cohort.status !== "active") {
      throw new AcademicAdminError("cohort_closed", 409, "Класна група вже закрита.", { cohortId: id });
    }
  }

  if (teacherIds.length) {
    const teacherResponse = await db.prepare(`
      SELECT u.id
      FROM users u
      JOIN json_each(?) requested ON requested.value = u.id
      JOIN teacher_profiles p ON p.teacher_user_id=u.id AND p.closed_at IS NULL
      WHERE u.status = 'active'
    `).bind(JSON.stringify(teacherIds)).all<{ id: string }>();
    const found = new Set((teacherResponse.results ?? []).map((row) => row.id));
    const missing = teacherIds.find((id) => !found.has(id));
    if (missing) {
      throw new AcademicAdminError("teacher_not_found", 404, "Активного вчителя не знайдено.", { teacherUserId: missing });
    }
  }

  if (locationIds.length) {
    const locationResponse = await db.prepare(`
      SELECT l.id
      FROM locations l
      JOIN json_each(?) requested ON requested.value = l.id
      WHERE l.status = 'active' AND l.type != 'service'
    `).bind(JSON.stringify(locationIds)).all<{ id: string }>();
    const found = new Set((locationResponse.results ?? []).map((row) => row.id));
    const missing = locationIds.find((id) => !found.has(id));
    if (missing) {
      throw new AcademicAdminError("location_not_found", 404, "Активний кабінет не знайдено.", { locationId: missing });
    }
  }

  const otherOpenClass = await db.prepare(`
    SELECT cy.id, cy.cohort_id
    FROM class_years cy
    JOIN json_each(?) requested ON requested.value = cy.cohort_id
    WHERE cy.academic_year_id != ? AND cy.status IN ('planned', 'active')
    LIMIT 1
  `).bind(JSON.stringify(cohortIds), sourceYearId).first<{ id: string; cohort_id: string }>();
  if (otherOpenClass) {
    throw new AcademicAdminError(
      "cohort_still_open",
      409,
      "Класна група використовується в іншому відкритому році.",
      { cohortId: otherOpenClass.cohort_id, classYearId: otherOpenClass.id },
    );
  }
  return cohortById;
}

async function allocateCohortId(db: AcademicD1Database): Promise<string> {
  const row = await db.prepare(`
    SELECT COALESCE(MAX(CAST(substr(id, 5) AS INTEGER)), 0) AS maximum
    FROM cohorts WHERE id GLOB 'COH-[0-9]*'
  `).first<{ maximum: number }>();
  return `COH-${String(Number(row?.maximum ?? 0) + 1).padStart(3, "0")}`;
}

async function allocateClassYearId(
  db: AcademicD1Database,
  academicYearId: string,
): Promise<string> {
  const prefix = `CY-${academicYearId.slice(3, 7)}-`;
  const row = await db.prepare(`
    SELECT COALESCE(MAX(CAST(substr(id, 9) AS INTEGER)), 0) AS maximum
    FROM class_years WHERE id GLOB ?
  `).bind(`${prefix}*`).first<{ maximum: number }>();
  return `${prefix}${String(Number(row?.maximum ?? 0) + 1).padStart(3, "0")}`;
}

async function allocateClassYearIds(
  db: AcademicD1Database,
  academicYearId: string,
  count: number,
): Promise<string[]> {
  if (count === 0) return [];
  const first = await allocateClassYearId(db, academicYearId);
  const separator = first.lastIndexOf("-");
  const prefix = first.slice(0, separator + 1);
  const start = Number(first.slice(separator + 1));
  return Array.from({ length: count }, (_, index) => `${prefix}${String(start + index).padStart(3, "0")}`);
}

function academicYearSnapshot(row: AcademicYearRow) {
  return {
    id: row.id,
    label: row.label,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    notes: row.notes,
    version: Number(row.version),
  };
}

function cohortSnapshot(row: CohortRow) {
  return { id: row.id, status: row.status, notes: row.notes };
}

function classYearSnapshot(row: ClassYearRow) {
  return {
    id: row.id,
    academicYearId: row.academic_year_id,
    cohortId: row.cohort_id,
    className: row.class_name,
    grade: Number(row.grade),
    code: row.code,
    teacherUserId: row.teacher_user_id,
    locationId: row.location_id,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    actualClosedDate: row.actual_closed_date,
    notes: row.notes,
    version: Number(row.version),
  };
}

function insertCommandStatement(
  db: AcademicD1Database,
  requestId: string,
  requestHash: string,
  actorUserId: string,
  kind: string,
  targetType: string,
  targetId: string,
  createdAt: string,
): D1Statement {
  return db.prepare(`
    INSERT INTO mutation_commands (
      id, draft_id, kind, actor_user_id, status, target_type, target_id,
      request_hash, result_json, error_code, error_message,
      created_at, updated_at, completed_at
    ) VALUES (?, NULL, ?, ?, 'processing', ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL)
  `).bind(requestId, kind, actorUserId, targetType, targetId, requestHash, createdAt, createdAt);
}

function completeCommandStatement(
  db: AcademicD1Database,
  requestId: string,
  result: unknown,
  completedAt: string,
): D1Statement {
  return db.prepare(`
    UPDATE mutation_commands
    SET status = 'completed', result_json = ?, updated_at = ?, completed_at = ?
    WHERE id = ? AND status = 'processing'
  `).bind(JSON.stringify(result), completedAt, completedAt, requestId);
}

function bulkCloseSourceClassesStatement(
  db: AcademicD1Database,
  rows: RolloverSourceMutationRow[],
  sourceYearId: string,
  effectiveDate: string,
  updatedAt: string,
): D1Statement {
  return db.prepare(`
    WITH items AS (
      SELECT
        json_extract(value, '$.id') AS id,
        json_extract(value, '$.cohortId') AS cohort_id,
        CAST(json_extract(value, '$.grade') AS INTEGER) AS grade,
        CAST(json_extract(value, '$.expectedVersion') AS INTEGER) AS expected_version,
        json_extract(value, '$.notes') AS notes
      FROM json_each(?)
    )
    UPDATE class_years AS cy
    SET status = 'closed', actual_closed_date = ?, notes = items.notes,
        version = cy.version + 1, updated_at = ?
    FROM items
    WHERE cy.id = items.id AND cy.academic_year_id = ?
      AND cy.cohort_id = items.cohort_id AND cy.grade = items.grade
      AND cy.version = items.expected_version
      AND cy.status IN ('planned', 'active')
      AND NOT EXISTS (
        SELECT 1 FROM class_loans
        WHERE class_year_id = cy.id AND status = 'open'
      )
  `).bind(JSON.stringify(rows), effectiveDate, updatedAt, sourceYearId);
}

function bulkCreateTargetClassesStatement(
  db: AcademicD1Database,
  rows: RolloverTargetMutationRow[],
  targetYear: AcademicYearRow,
  createdAt: string,
): D1Statement {
  return db.prepare(`
    WITH items AS (
      SELECT
        json_extract(value, '$.id') AS id,
        json_extract(value, '$.cohortId') AS cohort_id,
        json_extract(value, '$.className') AS class_name,
        CAST(json_extract(value, '$.grade') AS INTEGER) AS grade,
        json_extract(value, '$.code') AS code,
        json_extract(value, '$.teacherUserId') AS teacher_user_id,
        json_extract(value, '$.locationId') AS location_id,
        json_extract(value, '$.notes') AS notes
      FROM json_each(?)
    )
    INSERT INTO class_years (
      id, academic_year_id, cohort_id, class_name, grade, code,
      teacher_user_id, location_id, start_date, end_date, status,
      actual_closed_date, notes, version, created_at, updated_at
    )
    SELECT
      items.id, ay.id, cohorts.id, items.class_name, items.grade, items.code,
      items.teacher_user_id, items.location_id, ay.start_date, ay.end_date,
      'active', NULL, items.notes, 1, ?, ?
    FROM items
    JOIN academic_years ay ON ay.id = ? AND ay.version = ? AND ay.status = 'draft'
    JOIN cohorts ON cohorts.id = items.cohort_id AND cohorts.status = 'active'
    WHERE (items.teacher_user_id IS NULL OR EXISTS (
        SELECT 1 FROM users u JOIN teacher_profiles p
          ON p.teacher_user_id=u.id AND p.closed_at IS NULL
        WHERE u.id = items.teacher_user_id AND u.status = 'active'
      ))
      AND (items.location_id IS NULL OR EXISTS (
        SELECT 1 FROM locations
        WHERE id = items.location_id AND status = 'active' AND type != 'service'
      ))
      AND NOT EXISTS (
        SELECT 1 FROM class_years existing_target
        WHERE existing_target.academic_year_id = ay.id
          AND (existing_target.cohort_id = items.cohort_id OR existing_target.class_name = items.class_name)
      )
      AND NOT EXISTS (
        SELECT 1 FROM class_years existing_open
        WHERE existing_open.cohort_id = items.cohort_id
          AND existing_open.status IN ('planned', 'active')
      )
  `).bind(JSON.stringify(rows), createdAt, createdAt, targetYear.id, targetYear.version);
}

function bulkCloseCohortsStatement(
  db: AcademicD1Database,
  rows: RolloverCohortMutationRow[],
  updatedAt: string,
): D1Statement {
  return db.prepare(`
    WITH items AS (
      SELECT
        json_extract(value, '$.id') AS id,
        json_extract(value, '$.status') AS status
      FROM json_each(?)
    )
    UPDATE cohorts AS cohort
    SET status = items.status, updated_at = ?
    FROM items
    WHERE cohort.id = items.id AND cohort.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM class_years
        WHERE cohort_id = cohort.id AND status IN ('planned', 'active')
      )
  `).bind(JSON.stringify(rows), updatedAt);
}

function changesGuardStatement(
  db: AcademicD1Database,
  requestId: string,
  expectedChanges: number,
): D1Statement {
  return db.prepare(`
    UPDATE mutation_commands
    SET kind = CASE WHEN changes() = ? THEN kind ELSE NULL END
    WHERE id = ? AND status = 'processing'
  `).bind(expectedChanges, requestId);
}

function createBulkAuditEvent(input: {
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  metadata: unknown;
}): BulkAuditEvent {
  return {
    id: crypto.randomUUID(),
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    beforeJson: input.before === null ? null : JSON.stringify(input.before),
    afterJson: input.after === null ? null : JSON.stringify(input.after),
    metadataJson: input.metadata === null ? null : JSON.stringify(input.metadata),
  };
}

function bulkAuditStatement(
  db: AcademicD1Database,
  actor: MutationActor,
  requestId: string,
  events: BulkAuditEvent[],
  createdAt: string,
): D1Statement {
  return db.prepare(`
    WITH events AS (
      SELECT
        json_extract(value, '$.id') AS id,
        json_extract(value, '$.action') AS action,
        json_extract(value, '$.entityType') AS entity_type,
        json_extract(value, '$.entityId') AS entity_id,
        json_extract(value, '$.beforeJson') AS before_json,
        json_extract(value, '$.afterJson') AS after_json,
        json_extract(value, '$.metadataJson') AS metadata_json
      FROM json_each(?)
    )
    INSERT INTO audit_events (
      id, actor_user_id, actor_email, action, entity_type, entity_id,
      request_id, before_json, after_json, metadata_json, created_at
    )
    SELECT
      events.id, ?, ?, events.action, events.entity_type, events.entity_id,
      ?, events.before_json, events.after_json, events.metadata_json, ?
    FROM events
  `).bind(JSON.stringify(events), actor.id, actor.email, requestId, createdAt);
}

function auditGuardStatement(
  db: AcademicD1Database,
  input: {
    actor: MutationActor;
    action: string;
    entityType: string;
    entityId: string;
    requestId: string;
    before: unknown;
    after: unknown;
    metadata: unknown;
    createdAt: string;
    guardSql: string;
    guardBindings: D1Value[];
  },
): D1Statement {
  return db.prepare(`
    INSERT INTO audit_events (
      id, actor_user_id, actor_email, action, entity_type, entity_id,
      request_id, before_json, after_json, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, (${input.guardSql}), ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    input.actor.id,
    input.actor.email,
    input.action,
    input.entityType,
    ...input.guardBindings,
    input.requestId,
    input.before === null ? null : JSON.stringify(input.before),
    input.after === null ? null : JSON.stringify(input.after),
    input.metadata === null ? null : JSON.stringify(input.metadata),
    input.createdAt,
  );
}

async function executeIdempotentBatch<T>(
  db: AcademicD1Database,
  statements: D1Statement[],
  requestId: string,
  requestHash: string,
  conflictCode: string,
  conflictMessage: string,
): Promise<T | null> {
  try {
    await db.batch(statements);
    return null;
  } catch (error) {
    const replay = await replayCompletedCommand<T>(db, requestId, requestHash);
    if (replay) return replay;
    if (isOptimisticGuardFailure(error)) {
      throw new AcademicAdminError(conflictCode, 409, conflictMessage);
    }
    throw error;
  }
}

async function replayCompletedCommand<T>(
  db: AcademicD1Database,
  requestId: string,
  requestHash: string,
): Promise<T | null> {
  const command = await db.prepare(`
    SELECT status, request_hash, result_json, error_code, error_message
    FROM mutation_commands WHERE id = ? LIMIT 1
  `).bind(requestId).first<StoredCommand>();
  if (!command) return null;
  if (command.request_hash !== requestHash) {
    throw new AcademicAdminError("request_id_conflict", 409, "Цей request ID вже використано для іншої зміни.");
  }
  if (command.status === "processing") {
    throw new AcademicAdminError("mutation_in_progress", 409, "Зміна ще виконується. Повторіть перевірку результату.");
  }
  if (command.status === "failed") {
    throw new AcademicAdminError(command.error_code || "mutation_failed", 409, command.error_message || "Зміну не виконано.");
  }
  if (command.status !== "completed" || !command.result_json) {
    throw new AcademicAdminError("mutation_result_invalid", 503, "Збережений результат зміни пошкоджено.");
  }
  try {
    return JSON.parse(command.result_json) as T;
  } catch {
    throw new AcademicAdminError("mutation_result_invalid", 503, "Збережений результат зміни пошкоджено.");
  }
}

function versionConflict(classYearId: string, currentVersion: number): AcademicAdminError {
  return new AcademicAdminError(
    "class_year_version_conflict",
    409,
    "Клас уже змінився. Оновіть дані.",
    { classYearId, currentVersion },
  );
}

async function findOpenClassLoan(
  db: AcademicD1Database,
  classYearIds: string[],
): Promise<{ classYearId: string; classLoanId: string } | null> {
  if (classYearIds.length === 0) return null;
  const row = await db.prepare(`
    WITH requested AS (
      SELECT CAST(value AS TEXT) AS class_year_id FROM json_each(?)
    )
    SELECT cl.class_year_id, cl.id AS class_loan_id
    FROM requested
    JOIN class_loans cl ON cl.class_year_id = requested.class_year_id
    WHERE cl.status = 'open'
    ORDER BY cl.class_year_id, cl.id
    LIMIT 1
  `).bind(JSON.stringify(classYearIds)).first<{
    class_year_id: string;
    class_loan_id: string;
  }>();
  return row
    ? { classYearId: row.class_year_id, classLoanId: row.class_loan_id }
    : null;
}

function classHasOpenLoans(openLoan: {
  classYearId: string;
  classLoanId: string;
}): AcademicAdminError {
  return new AcademicAdminError(
    "class_has_open_loans",
    409,
    "Клас має неповернену видачу. Спочатку поверніть усі примірники, а потім закрийте клас або виконайте перехід року.",
    openLoan,
  );
}

function isOptimisticGuardFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("NOT NULL constraint failed: audit_events.entity_id")
    || message.includes("NOT NULL constraint failed: mutation_commands.kind");
}

function isUniqueConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("UNIQUE constraint failed");
}

function isAllocationConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("UNIQUE constraint failed: cohorts.id")
    || message.includes("UNIQUE constraint failed: class_years.id");
}

function isClassAllocationConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("UNIQUE constraint failed: class_years.id");
}

async function mutationHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function nullableText(value: unknown): string | null {
  const result = text(value);
  return result || null;
}

function positiveInteger(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 1;
}
