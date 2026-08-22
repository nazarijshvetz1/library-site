import {
  guestTeacherRef,
  resolveGuestTeacherRef,
  type VisitGuestIdentity,
} from "./visit-guest-auth.ts";
import {
  isoWeekday,
  kyivLocalNow,
  visitDateInHorizon,
  visitSegments,
  VISIT_MAX_ACTIVE_BOOKINGS,
  type VisitBookingCreateInput,
} from "./visit-schedule-validation.ts";
import { VisitScheduleError, type VisitD1Database } from "./visit-schedule-store.ts";
import type {
  GuestVisitCancelInput,
  GuestVisitCreateInput,
  VisitBookingUpdateInput,
} from "./visit-portal-validation.ts";
import { queueTelegramForLibrariansStatement } from "./telegram-outbox.ts";

export type GuestVisitBooking = {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  teacher: { teacherRef: string; fullName: string };
  publicDisplayConsent: boolean;
  classYearId: string | null;
  classLabel: string | null;
  purpose: string | null;
  status: "active" | "cancelled";
  version: number;
  createdAt: string;
  cancelledAt: string | null;
};

type GuestBookingRow = {
  id: string;
  guest_owner_id: string;
  selected_teacher_user_id: string;
  surname: string;
  class_year_id: string | null;
  class_label: string | null;
  visit_date: string;
  start_time: string;
  end_time: string;
  public_display_consent: number;
  purpose: string;
  status: "active" | "cancelled";
  version: number;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
};

type StoredCommand = {
  owner_auth_user_id: string;
  status: string;
  request_hash: string;
  result_json: string | null;
};

export async function listOwnGuestVisits(
  db: VisitD1Database,
  guest: VisitGuestIdentity,
  range: { from: string; to: string },
): Promise<GuestVisitBooking[]> {
  const rows = await db.prepare(`SELECT id,guest_owner_id,selected_teacher_user_id,surname,
      class_year_id,class_label,visit_date,start_time,end_time,public_display_consent,purpose,status,version,
      created_at,updated_at,cancelled_at
    FROM visit_bookings
    WHERE owner_kind='guest' AND guest_owner_id=? AND visit_date BETWEEN ? AND ?
    ORDER BY visit_date,start_time,id LIMIT 101`)
    .bind(guest.guestOwnerId, range.from, range.to).all<GuestBookingRow>();
  if ((rows.results ?? []).length > 100) {
    throw new VisitScheduleError("result_limit_exceeded", 409, "Забагато бронювань у вибраному діапазоні.");
  }
  return Promise.all((rows.results ?? []).map(mapGuestBooking));
}

export async function createGuestVisitBooking(
  db: VisitD1Database,
  guest: VisitGuestIdentity,
  input: GuestVisitCreateInput,
): Promise<GuestVisitBooking> {
  const ownerKey = `guest:${guest.guestOwnerId}`;
  const requestHash = await mutationHash({ kind: "visit_guest_create", ownerKey, input });
  const replay = await replayGuestCommand<GuestVisitBooking>(db, input.requestId, requestHash, ownerKey);
  if (replay) return replay;
  const teacher = await resolveGuestTeacherRef(db, input.teacherRef);
  if (!teacher) throw new VisitScheduleError("teacher_not_found", 404, "Оберіть активного вчителя зі списку.");
  const localNow = kyivLocalNow();
  await validateBookableInterval(db, input, localNow);
  const classYear = await activeClassYear(db, input.classYearId);
  const activeCount = await db.prepare(`SELECT COUNT(*) AS total FROM visit_bookings
    WHERE owner_kind='guest' AND guest_owner_id=? AND status='active' AND visit_date>=?`)
    .bind(guest.guestOwnerId, localNow.date).first<{ total: number }>();
  if (Number(activeCount?.total ?? 0) >= VISIT_MAX_ACTIVE_BOOKINGS) {
    throw new VisitScheduleError("booking_limit_reached", 429, "Досягнуто ліміт активних майбутніх бронювань.");
  }

  const id = `VIS-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const result: GuestVisitBooking = {
    id,
    date: input.date,
    startTime: input.startTime,
    endTime: input.endTime,
    teacher: { teacherRef: input.teacherRef, fullName: teacher.fullName },
    publicDisplayConsent: input.publicDisplayConsent,
    classYearId: classYear?.id ?? null,
    classLabel: classYear?.class_name ?? null,
    purpose: input.purpose,
    status: "active",
    version: 1,
    createdAt: now,
    cancelledAt: null,
  };
  const segments = visitSegments(input.date, input.startTime, input.endTime);
  const weekday = isoWeekday(input.date);
  const fallback = { startTime: "08:00", endTime: "17:00" };
  const statements = [
    insertCommand(db, input.requestId, ownerKey, "visit_guest_create", requestHash, id, now),
    db.prepare(`INSERT INTO visit_bookings (
      id,owner_kind,owner_user_id,owner_auth_user_id,owner_email,guest_owner_id,selected_teacher_user_id,
      surname,class_year_id,class_label,visit_date,start_time,end_time,public_display_consent,purpose,status,cancel_reason,
      cancelled_by_auth_user_id,cancelled_by_user_id,cancelled_by_guest_owner_id,last_mutation_request_id,
      version,created_at,updated_at,cancelled_at
    ) SELECT
      ?,'guest',NULL,NULL,NULL,?,?,
      ?,?,?,?,?,?,?,?,'active','',NULL,NULL,NULL,?,1,?,?,NULL
      WHERE EXISTS (SELECT 1 FROM visit_guest_sessions
        WHERE id=? AND token_hash=? AND revoked_at IS NULL AND expires_at>?)
      AND EXISTS (SELECT 1 FROM users u JOIN teacher_profiles p
        ON p.teacher_user_id=u.id AND p.closed_at IS NULL
        WHERE u.id=? AND u.status='active' AND u.full_name=?)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM class_years WHERE id=? AND status='active'))
      AND (SELECT COUNT(*) FROM visit_bookings WHERE owner_kind='guest' AND guest_owner_id=?
        AND status='active' AND visit_date>=?)<?
      AND ?>?
      AND (EXISTS (SELECT 1 FROM visit_schedule_hours WHERE weekday=? AND status='active'
            AND start_time<=? AND end_time>=?)
        OR (NOT EXISTS (SELECT 1 FROM visit_schedule_hours WHERE weekday=?)
          AND ? BETWEEN 1 AND 5 AND ?>=? AND ?<=?))`)
      .bind(
        id, guest.guestOwnerId, teacher.id, teacher.fullName, classYear?.id ?? null,
        classYear?.class_name ?? null, input.date, input.startTime, input.endTime,
        input.publicDisplayConsent === true ? 1 : 0, input.purpose ?? "",
        input.requestId, now, now, guest.guestOwnerId, guest.tokenHash, now,
        teacher.id, teacher.fullName, input.classYearId, input.classYearId,
        guest.guestOwnerId, localNow.date, VISIT_MAX_ACTIVE_BOOKINGS,
        `${input.date}T${input.startTime}`, `${localNow.date}T${localNow.time}`,
        weekday, input.startTime, input.endTime, weekday, weekday,
        input.startTime, fallback.startTime, input.endTime, fallback.endTime,
      ),
    db.prepare(`INSERT INTO visit_slot_claims (segment_key,booking_id,closure_id,created_at)
      SELECT CAST(value AS TEXT),CASE WHEN EXISTS (
        SELECT 1 FROM visit_bookings WHERE id=? AND owner_kind='guest' AND guest_owner_id=?
          AND status='active' AND version=1
      ) THEN ? ELSE NULL END,NULL,? FROM json_each(?)`)
      .bind(id, guest.guestOwnerId, id, now, JSON.stringify(segments)),
    auditClaim(db, guest, input.requestId, id, result, segments.length, now, "visit.guest_booking.create"),
    queueTelegramForLibrariansStatement(db, {
      dedupeKey: `visit-booking:${id}:guest-created:${input.requestId}`,
      auditRequestId: input.requestId,
      category: "visits",
      type: "visit_guest_booking_created",
      title: "Новий гостьовий запис до бібліотеки",
      message: `${teacher.fullName}: ${input.date}, ${input.startTime}–${input.endTime}${classYear?.class_name ? `, ${classYear.class_name}` : ""}.`,
      targetPath: "/librarian/visits",
      entityType: "visit_booking",
      entityId: id,
      createdAt: now,
    }),
    completeCommand(db, input.requestId, result, now),
  ];
  try {
    await db.batch(statements);
    return result;
  } catch (error) {
    const replayed = await replayGuestCommand<GuestVisitBooking>(db, input.requestId, requestHash, ownerKey);
    if (replayed) return replayed;
    await diagnoseGuestCreate(db, guest, input, teacher.id, localNow, now);
    if (slotConflict(error)) throw new VisitScheduleError("slot_unavailable", 409, "Цей час уже зайнято.");
    throw new VisitScheduleError("visit_booking_unavailable", 503, "Не вдалося зберегти бронювання.");
  }
}

export async function updateGuestVisitBooking(
  db: VisitD1Database,
  guest: VisitGuestIdentity,
  bookingId: string,
  input: VisitBookingUpdateInput,
): Promise<GuestVisitBooking> {
  const ownerKey = `guest:${guest.guestOwnerId}`;
  const requestHash = await mutationHash({ kind: "visit_guest_update", ownerKey, bookingId, input });
  const replay = await replayGuestCommand<GuestVisitBooking>(db, input.requestId, requestHash, ownerKey);
  if (replay) return replay;
  const row = await ownGuestBooking(db, guest.guestOwnerId, bookingId);
  if (!row) throw new VisitScheduleError("booking_not_found", 404, "Бронювання не знайдено.");
  if (row.status !== "active" || Number(row.version) !== input.expectedVersion) {
    throw new VisitScheduleError("booking_version_conflict", 409, "Бронювання вже змінилося.");
  }
  const localNow = kyivLocalNow();
  if (`${row.visit_date}T${row.start_time}` <= `${localNow.date}T${localNow.time}`) {
    throw new VisitScheduleError("booking_not_editable", 409, "Розпочатий або минулий візит змінити не можна.");
  }
  await validateBookableInterval(db, input, localNow);
  const classYear = await activeClassYear(db, input.classYearId);
  const now = new Date().toISOString();
  const result: GuestVisitBooking = {
    id: row.id,
    date: input.date,
    startTime: input.startTime,
    endTime: input.endTime,
    teacher: { teacherRef: await guestTeacherRef(row.selected_teacher_user_id), fullName: row.surname },
    publicDisplayConsent: input.publicDisplayConsent,
    classYearId: classYear?.id ?? null,
    classLabel: classYear?.class_name ?? null,
    purpose: input.purpose,
    status: "active",
    version: input.expectedVersion + 1,
    createdAt: row.created_at,
    cancelledAt: null,
  };
  const segments = visitSegments(input.date, input.startTime, input.endTime);
  const weekday = isoWeekday(input.date);
  const fallback = { startTime: "08:00", endTime: "17:00" };
  const sessionGuard = `EXISTS (SELECT 1 FROM visit_guest_sessions s WHERE s.id=? AND s.token_hash=?
    AND s.revoked_at IS NULL AND s.expires_at>?)`;
  const statements = [
    insertCommand(db, input.requestId, ownerKey, "visit_guest_update", requestHash, bookingId, now),
    db.prepare(`DELETE FROM visit_slot_claims WHERE booking_id=? AND EXISTS (
      SELECT 1 FROM visit_bookings WHERE id=? AND owner_kind='guest' AND guest_owner_id=?
        AND status='active' AND version=? AND ${sessionGuard}
    )`).bind(bookingId, bookingId, guest.guestOwnerId, input.expectedVersion,
      guest.guestOwnerId, guest.tokenHash, now),
    db.prepare(`UPDATE visit_bookings SET class_year_id=?,class_label=?,visit_date=?,start_time=?,end_time=?,
        public_display_consent=?,purpose=?,last_mutation_request_id=?,version=version+1,updated_at=?
      WHERE id=? AND owner_kind='guest' AND guest_owner_id=? AND status='active' AND version=?
        AND ${sessionGuard}
        AND EXISTS (SELECT 1 FROM users u JOIN teacher_profiles p
          ON p.teacher_user_id=u.id AND p.closed_at IS NULL
          WHERE u.id=selected_teacher_user_id AND u.status='active')
        AND (? IS NULL OR EXISTS (SELECT 1 FROM class_years WHERE id=? AND status='active'))
        AND ?>?
        AND (EXISTS (SELECT 1 FROM visit_schedule_hours WHERE weekday=? AND status='active'
              AND start_time<=? AND end_time>=?)
          OR (NOT EXISTS (SELECT 1 FROM visit_schedule_hours WHERE weekday=?)
            AND ? BETWEEN 1 AND 5 AND ?>=? AND ?<=?))`)
      .bind(
        classYear?.id ?? null, classYear?.class_name ?? null, input.date, input.startTime,
        input.endTime, input.publicDisplayConsent === true ? 1 : 0, input.purpose ?? "",
        input.requestId, now, bookingId, guest.guestOwnerId,
        input.expectedVersion, guest.guestOwnerId, guest.tokenHash, now,
        input.classYearId, input.classYearId,
        `${input.date}T${input.startTime}`, `${localNow.date}T${localNow.time}`,
        weekday, input.startTime, input.endTime, weekday, weekday,
        input.startTime, fallback.startTime, input.endTime, fallback.endTime,
      ),
    db.prepare(`INSERT INTO visit_slot_claims (segment_key,booking_id,closure_id,created_at)
      SELECT CAST(value AS TEXT),CASE WHEN EXISTS (
        SELECT 1 FROM visit_bookings WHERE id=? AND owner_kind='guest' AND guest_owner_id=?
          AND status='active' AND version=? AND last_mutation_request_id=? AND visit_date=? AND start_time=? AND end_time=?
      ) THEN ? ELSE NULL END,NULL,? FROM json_each(?)`)
      .bind(bookingId, guest.guestOwnerId, result.version, input.requestId, input.date, input.startTime,
        input.endTime, bookingId, now, JSON.stringify(segments)),
    auditClaim(db, guest, input.requestId, bookingId, result, segments.length, now, "visit.guest_booking.update"),
    queueTelegramForLibrariansStatement(db, {
      dedupeKey: `visit-booking:${bookingId}:guest-updated:${input.requestId}`,
      auditRequestId: input.requestId,
      category: "visits",
      type: "visit_guest_booking_updated",
      title: "Гостьовий запис змінено",
      message: `${row.surname}: ${input.date}, ${input.startTime}–${input.endTime}${classYear?.class_name ? `, ${classYear.class_name}` : ""}.`,
      targetPath: "/librarian/visits",
      entityType: "visit_booking",
      entityId: bookingId,
      createdAt: now,
    }),
    completeCommand(db, input.requestId, result, now),
  ];
  try {
    await db.batch(statements);
    return result;
  } catch (error) {
    const replayed = await replayGuestCommand<GuestVisitBooking>(db, input.requestId, requestHash, ownerKey);
    if (replayed) return replayed;
    if (slotConflict(error)) throw new VisitScheduleError("slot_unavailable", 409, "Цей час уже зайнято.");
    const current = await ownGuestBooking(db, guest.guestOwnerId, bookingId);
    if (!current || current.version !== input.expectedVersion || current.status !== "active") {
      throw new VisitScheduleError("booking_version_conflict", 409, "Бронювання вже змінилося.");
    }
    throw new VisitScheduleError("visit_booking_unavailable", 503, "Не вдалося змінити бронювання.");
  }
}

export async function cancelGuestVisitBooking(
  db: VisitD1Database,
  guest: VisitGuestIdentity,
  bookingId: string,
  input: GuestVisitCancelInput,
): Promise<GuestVisitBooking> {
  const ownerKey = `guest:${guest.guestOwnerId}`;
  const requestHash = await mutationHash({ kind: "visit_guest_cancel", ownerKey, bookingId, input });
  const replay = await replayGuestCommand<GuestVisitBooking>(db, input.requestId, requestHash, ownerKey);
  if (replay) return replay;
  const row = await ownGuestBooking(db, guest.guestOwnerId, bookingId);
  if (!row) throw new VisitScheduleError("booking_not_found", 404, "Бронювання не знайдено.");
  if (row.status !== "active" || row.version !== input.expectedVersion) {
    throw new VisitScheduleError("booking_version_conflict", 409, "Бронювання вже змінилося.");
  }
  const localNow = kyivLocalNow();
  if (`${row.visit_date}T${row.start_time}` <= `${localNow.date}T${localNow.time}`) {
    throw new VisitScheduleError("booking_not_cancellable", 409, "Розпочатий або минулий візит скасувати не можна.");
  }
  const now = new Date().toISOString();
  const result = await mapGuestBooking({
    ...row, status: "cancelled", version: row.version + 1, updated_at: now, cancelled_at: now,
  });
  const guard = `EXISTS (SELECT 1 FROM visit_guest_sessions WHERE id=? AND token_hash=?
    AND revoked_at IS NULL AND expires_at>?)`;
  const statements = [
    insertCommand(db, input.requestId, ownerKey, "visit_guest_cancel", requestHash, bookingId, now),
    db.prepare(`DELETE FROM visit_slot_claims WHERE booking_id=? AND EXISTS (
      SELECT 1 FROM visit_bookings WHERE id=? AND owner_kind='guest' AND guest_owner_id=?
        AND status='active' AND version=? AND ${guard})`)
      .bind(bookingId, bookingId, guest.guestOwnerId, input.expectedVersion,
        guest.guestOwnerId, guest.tokenHash, now),
    db.prepare(`UPDATE visit_bookings SET status='cancelled',cancel_reason=?,
        cancelled_by_auth_user_id=NULL,cancelled_by_user_id=NULL,cancelled_by_guest_owner_id=?,
        cancelled_at=?,last_mutation_request_id=?,updated_at=?,version=version+1
      WHERE id=? AND owner_kind='guest' AND guest_owner_id=? AND status='active' AND version=?
        AND ${guard}`)
      .bind(input.reason ?? "", guest.guestOwnerId, now, input.requestId, now, bookingId,
        guest.guestOwnerId, input.expectedVersion, guest.guestOwnerId, guest.tokenHash, now),
    db.prepare(`INSERT INTO audit_events (
      id,actor_user_id,actor_email,action,entity_type,entity_id,request_id,
      before_json,after_json,metadata_json,created_at
    ) VALUES (?,NULL,'guest@local.invalid','visit.guest_booking.cancel','visit_booking',
      CASE WHEN EXISTS (SELECT 1 FROM visit_bookings WHERE id=? AND owner_kind='guest'
        AND guest_owner_id=? AND status='cancelled' AND version=? AND cancelled_at=?
        AND last_mutation_request_id=?
        AND cancelled_by_guest_owner_id=?) AND NOT EXISTS (
          SELECT 1 FROM visit_slot_claims WHERE booking_id=?
        ) THEN ? ELSE NULL END,?,?,?,NULL,?)`)
      .bind(`AUD-${crypto.randomUUID()}`, bookingId, guest.guestOwnerId, result.version, now,
        input.requestId, guest.guestOwnerId, bookingId, bookingId, input.requestId, JSON.stringify(await mapGuestBooking(row)),
        JSON.stringify(result), now),
    queueTelegramForLibrariansStatement(db, {
      dedupeKey: `visit-booking:${bookingId}:guest-cancelled:${input.requestId}`,
      auditRequestId: input.requestId,
      category: "visits",
      type: "visit_guest_booking_cancelled",
      title: "Гостьовий запис скасовано",
      message: `${row.surname}: ${row.visit_date}, ${row.start_time}–${row.end_time}.`,
      targetPath: "/librarian/visits",
      entityType: "visit_booking",
      entityId: bookingId,
      createdAt: now,
    }),
    completeCommand(db, input.requestId, result, now),
  ];
  try {
    await db.batch(statements);
    return result;
  } catch {
    const replayed = await replayGuestCommand<GuestVisitBooking>(db, input.requestId, requestHash, ownerKey);
    if (replayed) return replayed;
    const current = await ownGuestBooking(db, guest.guestOwnerId, bookingId);
    if (!current || current.status !== "active" || current.version !== input.expectedVersion) {
      throw new VisitScheduleError("booking_version_conflict", 409, "Бронювання вже змінилося.");
    }
    throw new VisitScheduleError("visit_booking_unavailable", 503, "Не вдалося скасувати бронювання.");
  }
}

async function ownGuestBooking(db: VisitD1Database, guestOwnerId: string, bookingId: string) {
  return db.prepare(`SELECT id,guest_owner_id,selected_teacher_user_id,surname,class_year_id,class_label,
      visit_date,start_time,end_time,public_display_consent,purpose,status,version,created_at,updated_at,cancelled_at
    FROM visit_bookings WHERE id=? AND owner_kind='guest' AND guest_owner_id=? LIMIT 1`)
    .bind(bookingId, guestOwnerId).first<GuestBookingRow>();
}

async function activeClassYear(db: VisitD1Database, id: string | null) {
  if (!id) return null;
  const row = await db.prepare(`SELECT id,class_name FROM class_years WHERE id=? AND status='active' LIMIT 1`)
    .bind(id).first<{ id: string; class_name: string }>();
  if (!row) throw new VisitScheduleError("class_year_not_active", 409, "Обраний клас уже неактивний.");
  return row;
}

async function validateBookableInterval(
  db: VisitD1Database,
  input: VisitBookingCreateInput,
  localNow: { date: string; time: string },
) {
  if (!visitDateInHorizon(input.date, localNow.date)) {
    throw new VisitScheduleError("outside_booking_horizon", 400, "Дата має бути в межах наступних 90 днів.");
  }
  if (`${input.date}T${input.startTime}` <= `${localNow.date}T${localNow.time}`) {
    throw new VisitScheduleError("visit_time_elapsed", 409, "Оберіть майбутній час.");
  }
  const weekday = isoWeekday(input.date);
  const rows = await db.prepare(`SELECT start_time,end_time,status FROM visit_schedule_hours
    WHERE weekday=? ORDER BY start_time LIMIT 101`).bind(weekday)
    .all<{ start_time: string; end_time: string; status: string }>();
  if ((rows.results ?? []).length > 100) throw new VisitScheduleError("schedule_invalid", 503, "Некоректний розклад.");
  const configured = rows.results ?? [];
  const open = configured.length
    ? configured.some((row) => row.status === "active" && row.start_time <= input.startTime && row.end_time >= input.endTime)
    : weekday >= 1 && weekday <= 5 && input.startTime >= "08:00" && input.endTime <= "17:00";
  if (!open) throw new VisitScheduleError("outside_business_hours", 409, "Час поза годинами роботи бібліотеки.");
}

async function diagnoseGuestCreate(
  db: VisitD1Database,
  guest: VisitGuestIdentity,
  input: VisitBookingCreateInput,
  teacherUserId: string,
  localNow: { date: string; time: string },
  now: string,
) {
  const session = await db.prepare(`SELECT id FROM visit_guest_sessions
    WHERE id=? AND token_hash=? AND revoked_at IS NULL AND expires_at>? LIMIT 1`)
    .bind(guest.guestOwnerId, guest.tokenHash, now).first();
  if (!session) throw new VisitScheduleError("guest_session_expired", 401, "Гостьова сесія завершилася.");
  const teacher = await db.prepare(`SELECT u.id FROM users u JOIN teacher_profiles p
    ON p.teacher_user_id=u.id AND p.closed_at IS NULL
    WHERE u.id=? AND u.status='active' LIMIT 1`)
    .bind(teacherUserId).first();
  if (!teacher) throw new VisitScheduleError("teacher_not_found", 404, "Учитель уже неактивний.");
  await activeClassYear(db, input.classYearId);
  await validateBookableInterval(db, input, localNow);
  const count = await db.prepare(`SELECT COUNT(*) total FROM visit_bookings
    WHERE owner_kind='guest' AND guest_owner_id=? AND status='active' AND visit_date>=?`)
    .bind(guest.guestOwnerId, localNow.date).first<{ total: number }>();
  if (Number(count?.total ?? 0) >= VISIT_MAX_ACTIVE_BOOKINGS) {
    throw new VisitScheduleError("booking_limit_reached", 429, "Досягнуто ліміт активних бронювань.");
  }
}

async function mapGuestBooking(row: GuestBookingRow): Promise<GuestVisitBooking> {
  return {
    id: row.id,
    date: row.visit_date,
    startTime: row.start_time,
    endTime: row.end_time,
    teacher: { teacherRef: await guestTeacherRef(row.selected_teacher_user_id), fullName: row.surname },
    publicDisplayConsent: Number(row.public_display_consent) === 1,
    classYearId: row.class_year_id,
    classLabel: row.class_label,
    purpose: row.purpose || null,
    status: row.status,
    version: Number(row.version),
    createdAt: row.created_at,
    cancelledAt: row.cancelled_at,
  };
}

function insertCommand(
  db: VisitD1Database,
  requestId: string,
  ownerKey: string,
  kind: string,
  requestHash: string,
  targetId: string,
  now: string,
) {
  return db.prepare(`INSERT INTO visit_mutation_commands (
    id,owner_auth_user_id,kind,request_hash,status,target_id,result_json,created_at,updated_at,completed_at
  ) VALUES (?,?,?,?,'processing',?,NULL,?,?,NULL)`)
    .bind(requestId, ownerKey, kind, requestHash, targetId, now, now);
}

function completeCommand(db: VisitD1Database, requestId: string, result: unknown, now: string) {
  return db.prepare(`UPDATE visit_mutation_commands SET status='completed',result_json=?,updated_at=?,completed_at=?
    WHERE id=? AND status='processing'`).bind(JSON.stringify(result), now, now, requestId);
}

function auditClaim(
  db: VisitD1Database,
  guest: VisitGuestIdentity,
  requestId: string,
  bookingId: string,
  result: GuestVisitBooking,
  expectedClaims: number,
  now: string,
  action: string,
) {
  return db.prepare(`INSERT INTO audit_events (
    id,actor_user_id,actor_email,action,entity_type,entity_id,request_id,
    before_json,after_json,metadata_json,created_at
  ) VALUES (?,NULL,'guest@local.invalid',?,'visit_booking',CASE WHEN EXISTS (
      SELECT 1 FROM visit_bookings WHERE id=? AND owner_kind='guest' AND guest_owner_id=?
        AND status='active' AND version=? AND last_mutation_request_id=?
    ) AND (SELECT COUNT(*) FROM visit_slot_claims WHERE booking_id=?)=? THEN ? ELSE NULL END,
    ?,NULL,?,NULL,?)`)
    .bind(`AUD-${crypto.randomUUID()}`, action, bookingId, guest.guestOwnerId, result.version,
      requestId, bookingId, expectedClaims, bookingId, requestId, JSON.stringify(result), now);
}

async function replayGuestCommand<T>(
  db: VisitD1Database,
  requestId: string,
  requestHash: string,
  ownerKey: string,
): Promise<T | null> {
  const command = await db.prepare(`SELECT owner_auth_user_id,status,request_hash,result_json
    FROM visit_mutation_commands WHERE id=? LIMIT 1`).bind(requestId).first<StoredCommand>();
  if (!command) return null;
  if (command.owner_auth_user_id !== ownerKey || command.request_hash !== requestHash) {
    throw new VisitScheduleError("request_id_conflict", 409, "Цей requestId уже використано для іншої зміни.");
  }
  if (command.status === "processing") throw new VisitScheduleError("mutation_in_progress", 409, "Зміна ще виконується.");
  if (command.status !== "completed" || !command.result_json) {
    throw new VisitScheduleError("mutation_result_invalid", 503, "Збережений результат пошкоджено.");
  }
  try { return JSON.parse(command.result_json) as T; } catch {
    throw new VisitScheduleError("mutation_result_invalid", 503, "Збережений результат пошкоджено.");
  }
}

async function mutationHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableStringify(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function slotConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /visit_slot_claims|UNIQUE constraint failed|PRIMARY KEY/iu.test(message);
}

export function safeVisitResourceId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}
