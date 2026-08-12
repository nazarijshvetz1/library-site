import type { ChatGPTUser } from "../app/chatgpt-auth.ts";
import type { TeacherAccessMode } from "./visit-schedule-api.ts";
import {
  isoWeekday,
  kyivLocalNow,
  kyivToday,
  visitDateInHorizon,
  visitSegments,
  VISIT_MAX_ACTIVE_BOOKINGS,
  VISIT_SLOT_MINUTES,
  VISIT_TIME_ZONE,
  type VisitBookingCreateInput,
  type VisitCancelInput,
  type VisitClosureCreateInput,
} from "./visit-schedule-validation.ts";

type D1Value = string | number | null;
type D1Result<T = Record<string, unknown>> = { results?: T[]; success?: boolean; meta?: { changes?: number } };
type D1Statement = {
  bind(...values: D1Value[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
};

export type VisitD1Database = {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<D1Result[]>;
};

export type VisitInterval = { startTime: string; endTime: string };
export type VisitHours = Record<string, VisitInterval[]>;
export type PublicVisitClosure = { date: string; startTime: string; endTime: string; status: "closed" };
export type PublicVisitBusy = { date: string; startTime: string; endTime: string; status: "busy" };
export type VisitClassYear = { id: string; label: string; version: number };

export type VisitBooking = {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  surname: string;
  classYearId: string | null;
  classLabel: string | null;
  purpose: string | null;
  status: "active" | "cancelled";
  version: number;
  createdAt: string;
  cancelledAt: string | null;
};

export type PrivateVisitBooking = VisitBooking & { ownerEmail: string };
export type VisitClosure = PublicVisitClosure & {
  id: string;
  reason: string;
  state: "active" | "cancelled";
  version: number;
  createdAt: string;
  cancelledAt: string | null;
};

type ScheduleOptions = {
  ownerAuthUserId?: string;
  includeClasses?: boolean;
  includePrivateBookings?: boolean;
  status?: "active" | "cancelled" | "all";
  limit?: number;
  futureOnly?: { date: string; time: string };
};

type BookingRow = {
  id: string;
  owner_auth_user_id: string;
  owner_email: string;
  surname: string;
  class_year_id: string | null;
  class_label: string | null;
  visit_date: string;
  start_time: string;
  end_time: string;
  purpose: string;
  status: "active" | "cancelled";
  version: number;
  created_at: string;
  cancelled_at: string | null;
};

type ClosureRow = {
  id: string;
  visit_date: string;
  start_time: string;
  end_time: string;
  status: "active" | "cancelled";
  reason: string;
  version: number;
  created_at: string;
  cancelled_at: string | null;
};

type StoredCommand = {
  owner_auth_user_id: string;
  status: string;
  request_hash: string;
  result_json: string | null;
};

type MutationActor = { id: string; email: string };
const MAX_SCHEDULE_ROWS = 3000;

export class VisitScheduleError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(
    code: string,
    status: number,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function readVisitSchedule(
  db: VisitD1Database,
  range: { from: string; to: string },
  options: ScheduleOptions = {},
) {
  const limit = Math.min(100, Math.max(1, options.limit ?? 100));
  const [hoursRows, closureRows, busyRows] = await Promise.all([
    db.prepare(`SELECT weekday, start_time, end_time, status FROM visit_schedule_hours ORDER BY weekday`).all<{
      weekday: number; start_time: string; end_time: string; status: "active" | "inactive";
    }>(),
    db.prepare(`
      SELECT id, visit_date, start_time, end_time, status, reason, version, created_at, cancelled_at
      FROM visit_schedule_closures
      WHERE visit_date BETWEEN ? AND ? AND status = 'active'
      ORDER BY visit_date, start_time, id LIMIT 3001
    `).bind(range.from, range.to).all<ClosureRow>(),
    db.prepare(`
      SELECT visit_date, start_time, end_time
      FROM visit_bookings
      WHERE visit_date BETWEEN ? AND ? AND status = 'active'
      ORDER BY visit_date, start_time, id LIMIT 3001
    `).bind(range.from, range.to).all<{ visit_date: string; start_time: string; end_time: string }>(),
  ]);
  assertScheduleBound(closureRows.results, "закриттів");
  assertScheduleBound(busyRows.results, "бронювань");

  const result: {
    timeZone: typeof VISIT_TIME_ZONE;
    slotMinutes: number;
    hours: VisitHours;
    closures: PublicVisitClosure[];
    busy: PublicVisitBusy[];
    classYears?: VisitClassYear[];
    bookings?: Array<VisitBooking | PrivateVisitBooking>;
    adminClosures?: VisitClosure[];
  } = {
    timeZone: VISIT_TIME_ZONE,
    slotMinutes: VISIT_SLOT_MINUTES,
    hours: serializeHours(hoursRows.results ?? []),
    closures: (closureRows.results ?? []).map(publicClosure),
    busy: mergeBusy((busyRows.results ?? []).map((row) => ({
      date: row.visit_date,
      startTime: row.start_time,
      endTime: row.end_time,
      status: "busy" as const,
    }))),
  };

  if (options.includeClasses) {
    const rows = await db.prepare(`
      SELECT id, class_name, version FROM class_years
      WHERE status = 'active' ORDER BY grade, code, id LIMIT 101
    `).all<{ id: string; class_name: string; version: number }>();
    assertResultBound(rows.results, "класів");
    result.classYears = (rows.results ?? []).map((row) => ({
      id: row.id, label: row.class_name, version: Number(row.version),
    }));
  }

  if (options.ownerAuthUserId || options.includePrivateBookings) {
    const status = options.status ?? "all";
    const statusSql = status === "all" ? "" : "AND status = ?";
    const ownerSql = options.ownerAuthUserId ? "AND owner_auth_user_id = ?" : "";
    const futureSql = options.futureOnly ? "AND (visit_date > ? OR (visit_date = ? AND start_time > ?))" : "";
    const bindings: D1Value[] = [range.from, range.to];
    if (status !== "all") bindings.push(status);
    if (options.ownerAuthUserId) bindings.push(options.ownerAuthUserId);
    if (options.futureOnly) bindings.push(options.futureOnly.date, options.futureOnly.date, options.futureOnly.time);
    bindings.push(limit + 1);
    const rows = await db.prepare(`
      SELECT id, owner_auth_user_id, owner_email, surname, class_year_id, class_label,
             visit_date, start_time, end_time, purpose, status, version, created_at, cancelled_at
      FROM visit_bookings
      WHERE visit_date BETWEEN ? AND ? ${statusSql} ${ownerSql} ${futureSql}
      ORDER BY visit_date, start_time, id LIMIT ?
    `).bind(...bindings).all<BookingRow>();
    if ((rows.results ?? []).length > limit) throw resultLimitError("бронювань");
    result.bookings = (rows.results ?? []).map((row) => options.includePrivateBookings
      ? privateBooking(row)
      : booking(row));
  }

  if (options.includePrivateBookings) {
    const rows = await db.prepare(`
      SELECT id, visit_date, start_time, end_time, status, reason, version, created_at, cancelled_at
      FROM visit_schedule_closures
      WHERE visit_date BETWEEN ? AND ?
      ORDER BY visit_date, start_time, id LIMIT 101
    `).bind(range.from, range.to).all<ClosureRow>();
    assertResultBound(rows.results, "закриттів");
    result.adminClosures = (rows.results ?? []).map(closure);
  }
  return result;
}

export async function createVisitBooking(
  db: VisitD1Database,
  user: ChatGPTUser,
  input: VisitBookingCreateInput,
  accessMode: TeacherAccessMode,
): Promise<VisitBooking> {
  const owner = user.userId;
  const requestHash = await mutationHash({ kind: "visit_booking_create", owner, input });
  const replayed = await replayCompletedCommand<VisitBooking>(db, input.requestId, requestHash, owner);
  if (replayed) return replayed;

  const localNow = kyivLocalNow();
  const today = localNow.date;
  if (!visitDateInHorizon(input.date, today)) {
    throw new VisitScheduleError("outside_booking_horizon", 400, "Дата має бути від сьогодні до наступних 90 днів.");
  }
  if (input.date === today && input.startTime <= localNow.time) {
    throw new VisitScheduleError("visit_time_elapsed", 409, "Оберіть майбутній час відвідування.");
  }
  const weekday = isoWeekday(input.date);
  await requireBusinessInterval(db, weekday, input.startTime, input.endTime);
  const classYear = input.classYearId
    ? await db.prepare(`SELECT id, class_name FROM class_years WHERE id = ? AND status = 'active' LIMIT 1`)
      .bind(input.classYearId).first<{ id: string; class_name: string }>()
    : null;
  if (input.classYearId && !classYear) {
    throw new VisitScheduleError("class_year_not_active", 409, "Обраний клас уже не є активним. Оновіть список класів.");
  }
  const activeCount = await db.prepare(`
    SELECT COUNT(*) AS total FROM visit_bookings
    WHERE owner_auth_user_id = ? AND status = 'active' AND visit_date >= ?
  `).bind(owner, today).first<{ total: number }>();
  if (Number(activeCount?.total ?? 0) >= VISIT_MAX_ACTIVE_BOOKINGS) {
    throw new VisitScheduleError("booking_limit_reached", 429, "Досягнуто ліміт 20 активних майбутніх бронювань.");
  }

  const id = `VIS-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const result: VisitBooking = {
    id,
    date: input.date,
    startTime: input.startTime,
    endTime: input.endTime,
    surname: input.surname,
    classYearId: classYear?.id ?? null,
    classLabel: classYear?.class_name ?? null,
    purpose: input.purpose,
    status: "active",
    version: 1,
    createdAt: now,
    cancelledAt: null,
  };
  const segments = visitSegments(input.date, input.startTime, input.endTime);
  const fallback = defaultBusinessInterval();
  const statements = [
    insertVisitCommand(db, input.requestId, owner, "visit_booking_create", requestHash, id, now),
    db.prepare(`
      INSERT INTO visit_bookings (
        id, owner_auth_user_id, owner_email, surname, class_year_id, class_label,
        visit_date, start_time, end_time, purpose, status, cancel_reason,
        cancelled_by_auth_user_id, cancelled_by_user_id, version,
        created_at, updated_at, cancelled_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', '', NULL, NULL, 1, ?, ?, NULL
      WHERE (? IS NULL OR EXISTS (
        SELECT 1 FROM class_years WHERE id = ? AND status = 'active'
      ))
      AND (SELECT COUNT(*) FROM visit_bookings
        WHERE owner_auth_user_id = ? AND status = 'active' AND visit_date >= ?) < ?
      AND (? > ?)
      AND (? = 1 OR EXISTS (
        SELECT 1 FROM users
        WHERE status = 'active' AND role = 'teacher'
          AND (auth_user_id = ? OR lower(email) = lower(?))
      ))
      AND (
        EXISTS (SELECT 1 FROM visit_schedule_hours
          WHERE weekday = ? AND status = 'active' AND start_time <= ? AND end_time >= ?)
        OR (NOT EXISTS (SELECT 1 FROM visit_schedule_hours WHERE weekday = ?)
          AND ? BETWEEN 1 AND 5 AND ? >= ? AND ? <= ?)
      )
    `).bind(
      id, owner, user.email.toLowerCase(), input.surname, classYear?.id ?? null,
      classYear?.class_name ?? null, input.date, input.startTime, input.endTime,
      input.purpose ?? "", now, now,
      input.classYearId, input.classYearId,
      owner, today, VISIT_MAX_ACTIVE_BOOKINGS,
      `${input.date}T${input.startTime}`, `${localNow.date}T${localNow.time}`,
      accessMode === "allowlist" ? 1 : 0, user.userId, user.email,
      weekday, input.startTime, input.endTime,
      weekday, weekday, input.startTime, fallback.startTime, input.endTime, fallback.endTime,
    ),
    db.prepare(`
      INSERT INTO visit_slot_claims (segment_key, booking_id, closure_id, created_at)
      SELECT CAST(value AS TEXT),
             CASE WHEN EXISTS (SELECT 1 FROM visit_bookings WHERE id = ? AND status = 'active') THEN ? ELSE NULL END,
             NULL, ?
      FROM json_each(?)
    `).bind(id, id, now, JSON.stringify(segments)),
    auditStatement(db, {
      id: `AUD-${crypto.randomUUID()}`, actorUserId: null, actorEmail: user.email,
      action: "visit.booking.create", entityType: "visit_booking", entityId: id,
      requestId: input.requestId, before: null, after: result, metadata: null,
      createdAt: now, expectedPreviousChanges: segments.length,
    }),
    completeVisitCommand(db, input.requestId, result, now),
  ];

  try {
    await db.batch(statements);
    return result;
  } catch (error) {
    const replay = await replayCompletedCommand<VisitBooking>(db, input.requestId, requestHash, owner);
    if (replay) return replay;
    await diagnoseCreateBooking(db, input, owner, today, localNow.time, user, accessMode);
    if (isSlotConflict(error)) {
      throw new VisitScheduleError("slot_unavailable", 409, "Цей час щойно зайняли. Оберіть інший проміжок.");
    }
    throw new VisitScheduleError("visit_booking_unavailable", 503, "Не вдалося зберегти бронювання. Спробуйте ще раз.");
  }
}

export async function cancelOwnVisitBooking(
  db: VisitD1Database,
  user: ChatGPTUser,
  bookingId: string,
  input: VisitCancelInput,
  accessMode: TeacherAccessMode,
): Promise<VisitBooking> {
  return cancelBooking(db, user, bookingId, input, null, accessMode);
}

export async function cancelAdminVisitBooking(
  db: VisitD1Database,
  user: ChatGPTUser,
  bookingId: string,
  input: VisitCancelInput,
): Promise<PrivateVisitBooking> {
  const actor = await resolveLibrarianActor(db, user);
  return cancelBooking(db, user, bookingId, input, actor, null) as Promise<PrivateVisitBooking>;
}

async function cancelBooking(
  db: VisitD1Database,
  user: ChatGPTUser,
  bookingId: string,
  input: VisitCancelInput,
  actor: MutationActor | null,
  teacherAccessMode: TeacherAccessMode | null,
): Promise<VisitBooking | PrivateVisitBooking> {
  const ownerKey = actor ? `admin:${actor.id}` : user.userId;
  const requestHash = await mutationHash({
    kind: actor ? "visit_booking_admin_cancel" : "visit_booking_cancel",
    ownerKey, bookingId, input,
  });
  const replayed = await replayCompletedCommand<PrivateVisitBooking>(db, input.requestId, requestHash, ownerKey);
  if (replayed) return actor ? replayed : stripOwner(replayed);
  const ownerGuard = actor ? "" : "AND owner_auth_user_id = ?";
  const bindings: D1Value[] = [bookingId];
  if (!actor) bindings.push(user.userId);
  const row = await db.prepare(`
    SELECT id, owner_auth_user_id, owner_email, surname, class_year_id, class_label,
           visit_date, start_time, end_time, purpose, status, version, created_at, cancelled_at
    FROM visit_bookings WHERE id = ? ${ownerGuard} LIMIT 1
  `).bind(...bindings).first<BookingRow>();
  if (!row) throw new VisitScheduleError("booking_not_found", 404, "Бронювання не знайдено.");
  if (row.status !== "active" || Number(row.version) !== input.expectedVersion) {
    throw new VisitScheduleError("booking_version_conflict", 409, "Бронювання вже змінилося. Оновіть сторінку.");
  }
  const cancellationNow = kyivLocalNow();
  if (!actor && `${row.visit_date}T${row.start_time}` <= `${cancellationNow.date}T${cancellationNow.time}`) {
    throw new VisitScheduleError("booking_not_cancellable", 409, "Розпочатий або минулий візит учитель уже не може скасувати.");
  }
  const now = new Date().toISOString();
  const privateResult: PrivateVisitBooking = {
    ...privateBooking(row), status: "cancelled", version: Number(row.version) + 1, cancelledAt: now,
  };
  const updateOwnerSql = actor ? "" : "AND owner_auth_user_id = ?";
  const accessGuardSql = actor
    ? "AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active' AND role IN ('admin','librarian'))"
    : `AND (? = 1 OR EXISTS (SELECT 1 FROM users WHERE status = 'active' AND role = 'teacher'
        AND (auth_user_id = ? OR lower(email) = lower(?))))
       AND (visit_date || 'T' || start_time) > ?`;
  const accessBindings: D1Value[] = actor
    ? [actor.id]
    : [teacherAccessMode === "allowlist" ? 1 : 0, user.userId, user.email, `${cancellationNow.date}T${cancellationNow.time}`];
  const updateBindings: D1Value[] = [
    input.reason ?? "", actor ? null : user.userId, actor?.id ?? null, now, now,
    bookingId, input.expectedVersion,
  ];
  if (!actor) updateBindings.push(user.userId);
  const statements = [
    insertVisitCommand(db, input.requestId, ownerKey, actor ? "visit_booking_admin_cancel" : "visit_booking_cancel", requestHash, bookingId, now),
    db.prepare(`
      DELETE FROM visit_slot_claims
      WHERE booking_id = ? AND EXISTS (
        SELECT 1 FROM visit_bookings WHERE id = ? AND status = 'active' AND version = ? ${updateOwnerSql} ${accessGuardSql}
      )
    `).bind(bookingId, bookingId, input.expectedVersion, ...(!actor ? [user.userId] : []), ...accessBindings),
    db.prepare(`
      UPDATE visit_bookings
      SET status = 'cancelled', cancel_reason = ?, cancelled_by_auth_user_id = ?,
          cancelled_by_user_id = ?, cancelled_at = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND status = 'active' AND version = ? ${updateOwnerSql} ${accessGuardSql}
    `).bind(...updateBindings, ...accessBindings),
    auditStatement(db, {
      id: `AUD-${crypto.randomUUID()}`, actorUserId: actor?.id ?? null, actorEmail: user.email,
      action: actor ? "visit.booking.admin_cancel" : "visit.booking.cancel",
      entityType: "visit_booking", entityId: bookingId, requestId: input.requestId,
      before: privateBooking(row), after: privateResult,
      metadata: actor ? { reason: input.reason } : null, createdAt: now, expectedPreviousChanges: 1,
    }),
    completeVisitCommand(db, input.requestId, privateResult, now),
  ];
  try {
    await db.batch(statements);
    return actor ? privateResult : stripOwner(privateResult);
  } catch (error) {
    const replay = await replayCompletedCommand<PrivateVisitBooking>(db, input.requestId, requestHash, ownerKey);
    if (replay) return actor ? replay : stripOwner(replay);
    if (!actor && teacherAccessMode === "directory") {
      const teacher = await db.prepare(`SELECT id FROM users WHERE status='active' AND role='teacher'
        AND (auth_user_id=? OR lower(email)=lower(?)) LIMIT 1`).bind(user.userId, user.email).first();
      if (!teacher) throw new VisitScheduleError("teacher_access_denied", 403, "Доступ учителя було відкликано. Зверніться до бібліотекаря.");
    }
    if (!actor) {
      const current = await db.prepare(`SELECT visit_date, start_time FROM visit_bookings WHERE id=? LIMIT 1`)
        .bind(bookingId).first<{ visit_date: string; start_time: string }>();
      if (current && `${current.visit_date}T${current.start_time}` <= `${cancellationNow.date}T${cancellationNow.time}`) {
        throw new VisitScheduleError("booking_not_cancellable", 409, "Розпочатий або минулий візит учитель уже не може скасувати.");
      }
    }
    if (actor) {
      const activeActor = await db.prepare(`SELECT id FROM users WHERE id=? AND status='active' AND role IN ('admin','librarian') LIMIT 1`)
        .bind(actor.id).first();
      if (!activeActor) throw new VisitScheduleError("actor_not_mapped", 403, "Доступ бібліотекаря було відкликано.");
    }
    if (isGuardFailure(error)) {
      throw new VisitScheduleError("booking_version_conflict", 409, "Бронювання вже змінилося. Оновіть сторінку.");
    }
    throw new VisitScheduleError("visit_booking_unavailable", 503, "Не вдалося скасувати бронювання. Спробуйте ще раз.");
  }
}

export async function createVisitClosure(
  db: VisitD1Database,
  user: ChatGPTUser,
  input: VisitClosureCreateInput,
): Promise<VisitClosure> {
  const actor = await resolveLibrarianActor(db, user);
  const ownerKey = `admin:${actor.id}`;
  const requestHash = await mutationHash({ kind: "visit_closure_create", ownerKey, input });
  const replayed = await replayCompletedCommand<VisitClosure>(db, input.requestId, requestHash, ownerKey);
  if (replayed) return replayed;
  const today = kyivToday();
  if (!visitDateInHorizon(input.date, today)) {
    throw new VisitScheduleError("outside_booking_horizon", 400, "Закриття можна створити від сьогодні до наступних 90 днів.");
  }
  const weekday = isoWeekday(input.date);
  await requireBusinessInterval(db, weekday, input.startTime, input.endTime);
  const fallback = defaultBusinessInterval();
  const now = new Date().toISOString();
  const id = `VCL-${crypto.randomUUID()}`;
  const segments = visitSegments(input.date, input.startTime, input.endTime);
  const result: VisitClosure = {
    id, date: input.date, startTime: input.startTime, endTime: input.endTime,
    status: "closed", reason: input.reason, state: "active", version: 1,
    createdAt: now, cancelledAt: null,
  };
  const statements = [
    insertVisitCommand(db, input.requestId, ownerKey, "visit_closure_create", requestHash, id, now),
    db.prepare(`
      INSERT INTO visit_schedule_closures (
        id, visit_date, start_time, end_time, status, reason, created_by_user_id,
        cancelled_by_user_id, version, created_at, updated_at, cancelled_at
      )
      SELECT ?, ?, ?, ?, 'active', ?, ?, NULL, 1, ?, ?, NULL
      WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active' AND role IN ('admin','librarian'))
      AND (
        EXISTS (SELECT 1 FROM visit_schedule_hours
          WHERE weekday = ? AND status = 'active' AND start_time <= ? AND end_time >= ?)
        OR (NOT EXISTS (SELECT 1 FROM visit_schedule_hours WHERE weekday = ?)
          AND ? BETWEEN 1 AND 5 AND ? >= ? AND ? <= ?)
      )
    `).bind(
      id, input.date, input.startTime, input.endTime, input.reason, actor.id, now, now,
      actor.id, weekday, input.startTime, input.endTime,
      weekday, weekday, input.startTime, fallback.startTime, input.endTime, fallback.endTime,
    ),
    db.prepare(`
      INSERT INTO visit_slot_claims (segment_key, booking_id, closure_id, created_at)
      SELECT CAST(value AS TEXT), NULL,
             CASE WHEN EXISTS (SELECT 1 FROM visit_schedule_closures WHERE id = ? AND status = 'active') THEN ? ELSE NULL END,
             ? FROM json_each(?)
    `).bind(id, id, now, JSON.stringify(segments)),
    auditStatement(db, {
      id: `AUD-${crypto.randomUUID()}`, actorUserId: actor.id, actorEmail: user.email,
      action: "visit.closure.create", entityType: "visit_schedule_closure", entityId: id,
      requestId: input.requestId, before: null, after: result, metadata: null,
      createdAt: now, expectedPreviousChanges: segments.length,
    }),
    completeVisitCommand(db, input.requestId, result, now),
  ];
  try {
    await db.batch(statements);
    return result;
  } catch (error) {
    const replay = await replayCompletedCommand<VisitClosure>(db, input.requestId, requestHash, ownerKey);
    if (replay) return replay;
    if (isSlotConflict(error)) {
      throw new VisitScheduleError("slot_unavailable", 409, "Цей проміжок містить бронювання або інше закриття.");
    }
    if (isGuardFailure(error)) {
      throw new VisitScheduleError("outside_business_hours", 409, "Закриття має бути в межах робочих годин бібліотеки.");
    }
    throw new VisitScheduleError("visit_closure_unavailable", 503, "Не вдалося закрити проміжок. Спробуйте ще раз.");
  }
}

export async function cancelVisitClosure(
  db: VisitD1Database,
  user: ChatGPTUser,
  closureId: string,
  input: VisitCancelInput,
): Promise<VisitClosure> {
  const actor = await resolveLibrarianActor(db, user);
  const ownerKey = `admin:${actor.id}`;
  const requestHash = await mutationHash({ kind: "visit_closure_cancel", ownerKey, closureId, input });
  const replayed = await replayCompletedCommand<VisitClosure>(db, input.requestId, requestHash, ownerKey);
  if (replayed) return replayed;
  const row = await db.prepare(`
    SELECT id, visit_date, start_time, end_time, status, reason, version, created_at, cancelled_at
    FROM visit_schedule_closures WHERE id = ? LIMIT 1
  `).bind(closureId).first<ClosureRow>();
  if (!row) throw new VisitScheduleError("closure_not_found", 404, "Закриття розкладу не знайдено.");
  if (row.status !== "active" || Number(row.version) !== input.expectedVersion) {
    throw new VisitScheduleError("closure_version_conflict", 409, "Закриття вже змінилося. Оновіть сторінку.");
  }
  const now = new Date().toISOString();
  const result: VisitClosure = {
    ...closure(row), state: "cancelled", version: Number(row.version) + 1, cancelledAt: now,
  };
  const statements = [
    insertVisitCommand(db, input.requestId, ownerKey, "visit_closure_cancel", requestHash, closureId, now),
    db.prepare(`
      DELETE FROM visit_slot_claims WHERE closure_id = ? AND EXISTS (
        SELECT 1 FROM visit_schedule_closures WHERE id = ? AND status = 'active' AND version = ?
          AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status='active' AND role IN ('admin','librarian'))
      )
    `).bind(closureId, closureId, input.expectedVersion, actor.id),
    db.prepare(`
      UPDATE visit_schedule_closures
      SET status = 'cancelled', cancelled_by_user_id = ?, cancelled_at = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND status = 'active' AND version = ?
        AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status='active' AND role IN ('admin','librarian'))
    `).bind(actor.id, now, now, closureId, input.expectedVersion, actor.id),
    auditStatement(db, {
      id: `AUD-${crypto.randomUUID()}`, actorUserId: actor.id, actorEmail: user.email,
      action: "visit.closure.cancel", entityType: "visit_schedule_closure", entityId: closureId,
      requestId: input.requestId, before: closure(row), after: result, metadata: null,
      createdAt: now, expectedPreviousChanges: 1,
    }),
    completeVisitCommand(db, input.requestId, result, now),
  ];
  try {
    await db.batch(statements);
    return result;
  } catch (error) {
    const replay = await replayCompletedCommand<VisitClosure>(db, input.requestId, requestHash, ownerKey);
    if (replay) return replay;
    if (isGuardFailure(error)) {
      throw new VisitScheduleError("closure_version_conflict", 409, "Закриття вже змінилося. Оновіть сторінку.");
    }
    throw new VisitScheduleError("visit_closure_unavailable", 503, "Не вдалося відкрити проміжок. Спробуйте ще раз.");
  }
}

function serializeHours(rows: Array<{ weekday: number; start_time: string; end_time: string; status: "active" | "inactive" }>): VisitHours {
  const fallback = defaultBusinessInterval();
  const byDay = new Map(rows.map((row) => [Number(row.weekday), row]));
  const result: VisitHours = {};
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    const row = byDay.get(weekday);
    if (row) {
      result[String(weekday)] = row.status === "active" && validInterval(row.start_time, row.end_time)
        ? [{ startTime: row.start_time, endTime: row.end_time }]
        : [];
    } else {
      result[String(weekday)] = weekday <= 5 ? [fallback] : [];
    }
  }
  return result;
}

async function requireBusinessInterval(db: VisitD1Database, weekday: number, startTime: string, endTime: string) {
  const row = await db.prepare(`
    SELECT start_time, end_time, status FROM visit_schedule_hours WHERE weekday = ? LIMIT 1
  `).bind(weekday).first<{ start_time: string; end_time: string; status: "active" | "inactive" }>();
  const interval = row
    ? (row.status === "active" && validInterval(row.start_time, row.end_time)
      ? { startTime: row.start_time, endTime: row.end_time }
      : null)
    : (weekday <= 5 ? defaultBusinessInterval() : null);
  if (!interval || startTime < interval.startTime || endTime > interval.endTime) {
    throw new VisitScheduleError("outside_business_hours", 409, "Оберіть час у межах робочих годин бібліотеки.");
  }
  return interval;
}

async function diagnoseCreateBooking(
  db: VisitD1Database,
  input: VisitBookingCreateInput,
  owner: string,
  today: string,
  currentTime: string,
  user: ChatGPTUser,
  accessMode: TeacherAccessMode,
) {
  if (input.date === today && input.startTime <= currentTime) {
    throw new VisitScheduleError("visit_time_elapsed", 409, "Оберіть майбутній час відвідування.");
  }
  if (input.classYearId) {
    const active = await db.prepare(`SELECT id FROM class_years WHERE id = ? AND status = 'active' LIMIT 1`)
      .bind(input.classYearId).first();
    if (!active) throw new VisitScheduleError("class_year_not_active", 409, "Обраний клас уже не є активним. Оновіть список класів.");
  }
  if (accessMode === "directory") {
    const teacher = await db.prepare(`
      SELECT id FROM users WHERE status = 'active' AND role = 'teacher'
        AND (auth_user_id = ? OR lower(email) = lower(?)) LIMIT 1
    `).bind(user.userId, user.email).first();
    if (!teacher) {
      throw new VisitScheduleError("teacher_access_denied", 403, "Доступ учителя було відкликано. Зверніться до бібліотекаря.");
    }
  }
  const count = await db.prepare(`
    SELECT COUNT(*) AS total FROM visit_bookings
    WHERE owner_auth_user_id = ? AND status = 'active' AND visit_date >= ?
  `).bind(owner, today).first<{ total: number }>();
  if (Number(count?.total ?? 0) >= VISIT_MAX_ACTIVE_BOOKINGS) {
    throw new VisitScheduleError("booking_limit_reached", 429, "Досягнуто ліміт 20 активних майбутніх бронювань.");
  }
  await requireBusinessInterval(db, isoWeekday(input.date), input.startTime, input.endTime);
}

function defaultBusinessInterval(): VisitInterval {
  return { startTime: "08:00", endTime: "17:00" };
}

function validInterval(start: string, end: string): boolean {
  const re = /^(?:[01]\d|2[0-3]):(?:[0-5]\d)$/u;
  if (!re.test(start) || !re.test(end) || start >= end) return false;
  return Number(start.slice(3)) % 5 === 0 && Number(end.slice(3)) % 5 === 0;
}

function publicClosure(row: ClosureRow): PublicVisitClosure {
  return { date: row.visit_date, startTime: row.start_time, endTime: row.end_time, status: "closed" };
}

function closure(row: ClosureRow): VisitClosure {
  return {
    id: row.id, ...publicClosure(row), reason: row.reason,
    state: row.status, version: Number(row.version), createdAt: row.created_at,
    cancelledAt: row.cancelled_at,
  };
}

function booking(row: BookingRow): VisitBooking {
  return {
    id: row.id, date: row.visit_date, startTime: row.start_time, endTime: row.end_time,
    surname: row.surname, classYearId: row.class_year_id, classLabel: row.class_label,
    purpose: row.purpose || null, status: row.status, version: Number(row.version),
    createdAt: row.created_at, cancelledAt: row.cancelled_at,
  };
}

function privateBooking(row: BookingRow): PrivateVisitBooking {
  return { ...booking(row), ownerEmail: row.owner_email };
}

function stripOwner(value: PrivateVisitBooking): VisitBooking {
  return {
    id: value.id, date: value.date, startTime: value.startTime, endTime: value.endTime,
    surname: value.surname, classYearId: value.classYearId, classLabel: value.classLabel,
    purpose: value.purpose, status: value.status, version: value.version,
    createdAt: value.createdAt, cancelledAt: value.cancelledAt,
  };
}

function mergeBusy(rows: PublicVisitBusy[]): PublicVisitBusy[] {
  const merged: PublicVisitBusy[] = [];
  for (const row of rows) {
    const previous = merged.at(-1);
    if (previous && previous.date === row.date && previous.endTime >= row.startTime) {
      if (row.endTime > previous.endTime) previous.endTime = row.endTime;
    } else {
      merged.push({ ...row });
    }
  }
  return merged;
}

async function resolveLibrarianActor(db: VisitD1Database, user: ChatGPTUser): Promise<MutationActor> {
  const rows = await db.prepare(`
    SELECT id FROM users
    WHERE status = 'active' AND role IN ('admin','librarian')
      AND (auth_user_id = ? OR lower(email) = lower(?))
    ORDER BY CASE WHEN auth_user_id = ? THEN 0 ELSE 1 END, id LIMIT 2
  `).bind(user.userId, user.email, user.userId).all<{ id: string }>();
  if ((rows.results ?? []).length !== 1) {
    throw new VisitScheduleError("actor_not_mapped", 403, "Обліковий запис не прив’язано до одного активного бібліотекаря.");
  }
  return { id: rows.results![0].id, email: user.email.toLowerCase() };
}

function insertVisitCommand(
  db: VisitD1Database,
  requestId: string,
  owner: string,
  kind: string,
  requestHash: string,
  targetId: string,
  now: string,
) {
  return db.prepare(`
    INSERT INTO visit_mutation_commands (
      id, owner_auth_user_id, kind, request_hash, status, target_id,
      result_json, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, 'processing', ?, NULL, ?, ?, NULL)
  `).bind(requestId, owner, kind, requestHash, targetId, now, now);
}

function completeVisitCommand(db: VisitD1Database, requestId: string, result: unknown, now: string) {
  return db.prepare(`
    UPDATE visit_mutation_commands
    SET status = 'completed', result_json = ?, updated_at = ?, completed_at = ?
    WHERE id = ? AND status = 'processing'
  `).bind(JSON.stringify(result), now, now, requestId);
}

function auditStatement(db: VisitD1Database, input: {
  id: string; actorUserId: string | null; actorEmail: string; action: string;
  entityType: string; entityId: string; requestId: string;
  before: unknown; after: unknown; metadata: unknown; createdAt: string;
  expectedPreviousChanges: number;
}) {
  return db.prepare(`
    INSERT INTO audit_events (
      id, actor_user_id, actor_email, action, entity_type, entity_id,
      request_id, before_json, after_json, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, CASE WHEN changes() = ? THEN ? ELSE NULL END,
      ?, ?, ?, ?, ?)
  `).bind(
    input.id, input.actorUserId, input.actorEmail.toLowerCase(), input.action, input.entityType,
    input.expectedPreviousChanges, input.entityId, input.requestId,
    input.before === null ? null : JSON.stringify(input.before),
    input.after === null ? null : JSON.stringify(input.after),
    input.metadata === null ? null : JSON.stringify(input.metadata), input.createdAt,
  );
}

async function replayCompletedCommand<T>(
  db: VisitD1Database,
  requestId: string,
  requestHash: string,
  owner: string,
): Promise<T | null> {
  const command = await db.prepare(`
    SELECT owner_auth_user_id, status, request_hash, result_json
    FROM visit_mutation_commands WHERE id = ? LIMIT 1
  `).bind(requestId).first<StoredCommand>();
  if (!command) return null;
  if (command.owner_auth_user_id !== owner || command.request_hash !== requestHash) {
    throw new VisitScheduleError("request_id_conflict", 409, "Цей requestId уже використано для іншої зміни.");
  }
  if (command.status === "processing") {
    throw new VisitScheduleError("mutation_in_progress", 409, "Зміна ще виконується. Оновіть результат за кілька секунд.");
  }
  if (command.status !== "completed" || !command.result_json) {
    throw new VisitScheduleError("mutation_result_invalid", 503, "Збережений результат зміни пошкоджено.");
  }
  try {
    return JSON.parse(command.result_json) as T;
  } catch {
    throw new VisitScheduleError("mutation_result_invalid", 503, "Збережений результат зміни пошкоджено.");
  }
}

async function mutationHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableStringify(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
}

function assertResultBound<T>(rows: T[] | undefined, label: string) {
  if ((rows ?? []).length > 100) throw resultLimitError(label);
}

function assertScheduleBound<T>(rows: T[] | undefined, label: string) {
  if ((rows ?? []).length > MAX_SCHEDULE_ROWS) throw resultLimitError(label);
}

function resultLimitError(label: string) {
  return new VisitScheduleError("visit_result_limit", 400, `Знайдено понад 100 ${label}. Звузьте діапазон дат.`);
}

function isSlotConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("UNIQUE constraint failed: visit_slot_claims.segment_key");
}

function isGuardFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("NOT NULL constraint failed: audit_events.entity_id")
    || message.includes("CHECK constraint failed: visit_slot_claims_exactly_one_owner");
}
