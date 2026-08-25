import type { VisitTeacherIdentity } from "./visit-teacher-auth.ts";
import { VisitScheduleError, type VisitD1Database } from "./visit-schedule-store.ts";
import type { CoverBucket } from "./cover-storage.ts";
import { normalizeTeacherName, teacherSortName } from "./teacher-registry-validation.ts";

type ProfileRow = {
  teacher_user_id: string;
  full_name: string;
  subject_position: string;
  service_contact: string;
  primary_location_id: string | null;
  primary_location_name: string | null;
  photo_storage_key: string | null;
  photo_mime_type: string | null;
  photo_version: number;
  photo_updated_at: string | null;
  version: number;
  updated_at: string;
};

type ClassRow = {
  id: string;
  class_name: string;
  academic_year_label: string;
  status: string;
  location_id: string | null;
  location_name: string | null;
};

type LocationOptionRow = { id: string; name: string };
type CuratorOptionRow = ClassRow & { assigned_teacher_name: string | null };
type PendingCuratorRequestRow = {
  id: string;
  requested_class_year_id: string | null;
  requested_class_name: string | null;
  version: number;
  created_at: string;
};

type StoredCommand = {
  actor_user_id: string;
  target_type: string | null;
  target_id: string | null;
  status: string;
  request_hash: string;
  result_json: string | null;
};

export type TeacherOwnProfile = {
  id: string;
  fullName: string;
  subjectPosition: string;
  serviceContact: string;
  primaryLocation: { id: string; name: string } | null;
  curatedClasses: Array<{
    id: string;
    className: string;
    academicYearLabel: string;
    status: string;
    location: { id: string; name: string } | null;
  }>;
  photoUrl: string | null;
  photoVersion: number;
  profileVersion: number;
  updatedAt: string;
  options: {
    locations: Array<{ id: string; name: string }>;
    curatorClasses: Array<{
      id: string;
      className: string;
      academicYearLabel: string;
      location: { id: string; name: string } | null;
      assignedTeacherName: string | null;
    }>;
  };
  pendingCuratorRequest: {
    id: string;
    requestedClassYearId: string | null;
    requestedClassName: string | null;
    version: number;
    createdAt: string;
  } | null;
};

export type TeacherProfileUpdateInput = {
  requestId: string;
  expectedVersion: number;
  fullName?: string;
  subjectPosition: string;
  primaryLocationId: string | null;
};

export type TeacherProfileUpdateResult = {
  teacherUserId: string;
  profileVersion: number;
  updatedAt: string;
};

export type TeacherPhotoMutationResult = {
  teacherUserId: string;
  profileVersion: number;
  photoVersion: number;
  photoUrl: string | null;
  updatedAt: string;
};

export async function getTeacherOwnProfile(
  db: VisitD1Database,
  teacherUserId: string,
): Promise<TeacherOwnProfile> {
  const [row, classes, locations, curatorClasses, pendingCuratorRequest] = await Promise.all([
    readActiveProfile(db, teacherUserId),
    db.prepare(`SELECT cy.id,cy.class_name,ay.label AS academic_year_label,cy.status,
        cy.location_id,l.name AS location_name
      FROM class_years cy
      JOIN academic_years ay ON ay.id=cy.academic_year_id
      LEFT JOIN locations l ON l.id=cy.location_id
      WHERE cy.teacher_user_id=? AND cy.status IN ('planned','active')
        AND ay.status IN ('draft','active')
      ORDER BY CASE cy.status WHEN 'active' THEN 0 ELSE 1 END,
        ay.start_date DESC,cy.class_name,cy.id`)
      .bind(teacherUserId).all<ClassRow>(),
    db.prepare(`SELECT id,name FROM locations
      WHERE status='active' AND type!='service'
      ORDER BY sort_order,name,id`).all<LocationOptionRow>(),
    db.prepare(`SELECT cy.id,cy.class_name,ay.label AS academic_year_label,cy.status,
        cy.location_id,l.name AS location_name,u.full_name AS assigned_teacher_name
      FROM class_years cy
      JOIN academic_years ay ON ay.id=cy.academic_year_id
      LEFT JOIN locations l ON l.id=cy.location_id
      LEFT JOIN users u ON u.id=cy.teacher_user_id
      WHERE cy.status IN ('planned','active') AND ay.status IN ('draft','active')
      ORDER BY CASE ay.status WHEN 'active' THEN 0 ELSE 1 END,
        ay.start_date DESC,cy.grade,cy.class_name,cy.id`).all<CuratorOptionRow>(),
    db.prepare(`SELECT request.id,request.requested_class_year_id,
        class_year.class_name AS requested_class_name,request.version,request.created_at
      FROM teacher_curator_change_requests request
      LEFT JOIN class_years class_year ON class_year.id=request.requested_class_year_id
      WHERE request.teacher_user_id=? AND request.status='submitted'
      ORDER BY request.created_at DESC,request.id DESC LIMIT 1`)
      .bind(teacherUserId).first<PendingCuratorRequestRow>(),
  ]);
  return projectProfile(
    row,
    classes.results ?? [],
    locations.results ?? [],
    curatorClasses.results ?? [],
    pendingCuratorRequest,
  );
}

export async function updateTeacherOwnProfile(
  db: VisitD1Database,
  teacher: VisitTeacherIdentity,
  input: TeacherProfileUpdateInput,
): Promise<TeacherProfileUpdateResult> {
  const current = await readActiveProfile(db, teacher.teacherUserId);
  const requestHash = await sha256Json({
    kind: "teacher.profile.self_update",
    teacherUserId: teacher.teacherUserId,
    input,
  });
  const replay = await replayTeacherProfileUpdate(
    db,
    teacher.teacherUserId,
    input.requestId,
    requestHash,
  );
  if (replay) return replay;
  if (current.version !== input.expectedVersion) throw profileVersionConflict(current.version);
  if (input.primaryLocationId) {
    const location = await db.prepare(`SELECT id FROM locations
      WHERE id=? AND status='active' AND type!='service' LIMIT 1`)
      .bind(input.primaryLocationId).first<{ id: string }>();
    if (!location) {
      throw new VisitScheduleError("teacher_profile_location_invalid", 400, "Оберіть активний кабінет зі списку.");
    }
  }
  const fullName = input.fullName === undefined ? current.full_name : normalizeTeacherName(input.fullName);
  if (fullName.length < 3 || fullName.length > 120 || fullName.split(/\s+/u).length < 2) {
    throw new VisitScheduleError("teacher_profile_name_invalid", 400, "Укажіть прізвище та ім’я (до 120 символів).");
  }
  if (teacherSortName(fullName) !== teacherSortName(current.full_name)) {
    const duplicate = await db.prepare(`SELECT id FROM users WHERE sort_name=? AND id<>? LIMIT 1`)
      .bind(teacherSortName(fullName), teacher.teacherUserId).first<{ id: string }>();
    if (duplicate) {
      throw new VisitScheduleError("teacher_profile_name_duplicate", 409, "Учитель із таким ПІБ уже є у базі. Зверніться до бібліотекаря.");
    }
  }
  if (current.full_name === fullName
    && current.subject_position === input.subjectPosition
    && current.primary_location_id === input.primaryLocationId) {
    throw new VisitScheduleError("teacher_profile_no_changes", 400, "Нові дані не відрізняються від поточних.");
  }
  const now = new Date().toISOString();
  const result: TeacherProfileUpdateResult = {
    teacherUserId: teacher.teacherUserId,
    profileVersion: input.expectedVersion + 1,
    updatedAt: now,
  };
  const before = {
    fullName: current.full_name,
    subjectPosition: current.subject_position,
    primaryLocationId: current.primary_location_id,
    version: current.version,
  };
  const after = {
    fullName,
    subjectPosition: input.subjectPosition,
    primaryLocationId: input.primaryLocationId,
    version: result.profileVersion,
  };
  await db.batch([
    db.prepare(`INSERT INTO mutation_commands(
        id,draft_id,kind,actor_user_id,status,target_type,target_id,request_hash,
        result_json,error_code,error_message,created_at,updated_at,completed_at)
      SELECT ?,NULL,'teacher.profile.self_update',teacher.id,'processing','teacher',teacher.id,?,
        NULL,NULL,NULL,?,?,NULL
      FROM users teacher
      JOIN teacher_profiles profile ON profile.teacher_user_id=teacher.id AND profile.closed_at IS NULL
      JOIN visit_teacher_credentials credential ON credential.teacher_user_id=teacher.id
        AND credential.status='active' AND credential.version=?
      JOIN visit_teacher_sessions session ON session.teacher_user_id=teacher.id
        AND session.credential_version=credential.version AND session.token_hash=?
        AND session.revoked_at IS NULL AND session.expires_at>?
      WHERE teacher.id=? AND teacher.full_name=? AND teacher.status='active'
        AND profile.version=?`)
      .bind(
        input.requestId,
        requestHash,
        now,
        now,
        teacher.credentialVersion,
        teacher.tokenHash,
        now,
        teacher.teacherUserId,
        teacher.fullName,
        input.expectedVersion,
      ),
    db.prepare(`UPDATE users SET full_name=?,sort_name=?,updated_at=?
      WHERE id=? AND full_name=? AND status='active'
        AND EXISTS(SELECT 1 FROM teacher_profiles profile
          WHERE profile.teacher_user_id=users.id AND profile.version=? AND profile.closed_at IS NULL)
        AND EXISTS(SELECT 1 FROM mutation_commands command
          WHERE command.id=? AND command.actor_user_id=users.id
            AND command.status='processing' AND command.request_hash=?)`)
      .bind(
        fullName,
        teacherSortName(fullName),
        now,
        teacher.teacherUserId,
        current.full_name,
        input.expectedVersion,
        input.requestId,
        requestHash,
      ),
    db.prepare(`UPDATE teacher_profiles
      SET subject_position=?,primary_location_id=?,version=version+1,
        last_mutation_request_id=?,updated_by_user_id=?,updated_at=?
      WHERE teacher_user_id=? AND version=? AND closed_at IS NULL
        AND (? IS NULL OR EXISTS(
          SELECT 1 FROM locations WHERE id=? AND status='active' AND type!='service'
        ))
        AND EXISTS(SELECT 1 FROM mutation_commands command
          WHERE command.id=? AND command.actor_user_id=teacher_profiles.teacher_user_id
            AND command.status='processing' AND command.target_type='teacher'
            AND command.target_id=teacher_profiles.teacher_user_id AND command.request_hash=?)`)
      .bind(
        input.subjectPosition,
        input.primaryLocationId,
        input.requestId,
        teacher.teacherUserId,
        now,
        teacher.teacherUserId,
        input.expectedVersion,
        input.primaryLocationId,
        input.primaryLocationId,
        input.requestId,
        requestHash,
      ),
    db.prepare(`INSERT INTO audit_events(
        id,actor_user_id,actor_email,action,entity_type,entity_id,request_id,
        before_json,after_json,metadata_json,created_at)
      SELECT ?,?,'teacher-profile@local.invalid','teacher.profile.self_updated','teacher',
        profile.teacher_user_id,?,?,?,NULL,?
      FROM teacher_profiles profile
      WHERE profile.teacher_user_id=? AND profile.version=?
        AND profile.last_mutation_request_id=?`)
      .bind(
        `AUD-${crypto.randomUUID()}`,
        teacher.teacherUserId,
        input.requestId,
        JSON.stringify(before),
        JSON.stringify(after),
        now,
        teacher.teacherUserId,
        result.profileVersion,
        input.requestId,
      ),
    db.prepare(`UPDATE mutation_commands
      SET status='completed',result_json=?,updated_at=?,completed_at=?
      WHERE id=? AND actor_user_id=? AND request_hash=? AND status='processing'
        AND EXISTS(SELECT 1 FROM audit_events audit
          WHERE audit.request_id=mutation_commands.id AND audit.entity_type='teacher'
            AND audit.entity_id=mutation_commands.target_id)`)
      .bind(
        JSON.stringify(result),
        now,
        now,
        input.requestId,
        teacher.teacherUserId,
        requestHash,
      ),
  ]);
  const completed = await replayTeacherProfileUpdate(
    db,
    teacher.teacherUserId,
    input.requestId,
    requestHash,
  );
  if (!completed) {
    const fresh = await readActiveProfile(db, teacher.teacherUserId);
    throw profileVersionConflict(fresh.version);
  }
  return completed;
}

export async function getTeacherPhotoAsset(
  db: VisitD1Database,
  teacherUserId: string,
): Promise<{ storageKey: string; mimeType: string; version: number; updatedAt: string } | null> {
  const row = await db.prepare(`SELECT p.photo_storage_key,p.photo_mime_type,p.photo_version,p.photo_updated_at
    FROM users u JOIN teacher_profiles p ON p.teacher_user_id=u.id
    WHERE u.id=? AND u.status='active' AND p.closed_at IS NULL LIMIT 1`)
    .bind(teacherUserId).first<{
      photo_storage_key: string | null;
      photo_mime_type: string | null;
      photo_version: number;
      photo_updated_at: string | null;
    }>();
  if (!row?.photo_storage_key || !row.photo_mime_type || !row.photo_updated_at) return null;
  return {
    storageKey: row.photo_storage_key,
    mimeType: row.photo_mime_type,
    version: Number(row.photo_version),
    updatedAt: row.photo_updated_at,
  };
}

export async function replaceTeacherPhotoDirect(
  db: VisitD1Database,
  bucket: CoverBucket,
  teacher: VisitTeacherIdentity,
  input: {
    requestId: string;
    expectedVersion: number;
    bytes: ArrayBuffer;
    sha256: string;
    width: number;
    height: number;
  },
): Promise<TeacherPhotoMutationResult> {
  const current = await readActiveProfile(db, teacher.teacherUserId);
  const requestHash = await sha256Json({
    kind: "teacher.photo.replace",
    teacherUserId: teacher.teacherUserId,
    expectedVersion: input.expectedVersion,
    sha256: input.sha256,
  });
  const replay = await replayPhotoMutation(db, teacher.teacherUserId, input.requestId, requestHash);
  if (replay) return replay;
  if (current.version !== input.expectedVersion) throw profileVersionConflict(current.version);

  const now = new Date().toISOString();
  const storageKey = `teacher-photos/${safeTeacherKey(teacher.teacherUserId)}/${input.sha256}.jpg`;
  const result: TeacherPhotoMutationResult = {
    teacherUserId: teacher.teacherUserId,
    profileVersion: current.version + 1,
    photoVersion: current.photo_version + 1,
    photoUrl: teacherPhotoUrl("teacher", teacher.teacherUserId, current.photo_version + 1, now),
    updatedAt: now,
  };

  await bucket.put(storageKey, input.bytes, {
    httpMetadata: { contentType: "image/jpeg" },
    customMetadata: {
      teacherUserId: teacher.teacherUserId,
      sha256: input.sha256,
      width: String(input.width),
      height: String(input.height),
      uploadedAt: now,
    },
  });

  try {
    await db.batch([
      db.prepare(`INSERT INTO mutation_commands(
          id,draft_id,kind,actor_user_id,status,target_type,target_id,request_hash,
          result_json,error_code,error_message,created_at,updated_at,completed_at)
        SELECT ?,NULL,'teacher.photo.replace',?,'processing','teacher_photo',?,?,NULL,NULL,NULL,?,?,NULL
        FROM teacher_profiles p JOIN users u ON u.id=p.teacher_user_id
        WHERE p.teacher_user_id=? AND p.version=? AND p.closed_at IS NULL AND u.status='active'`)
        .bind(input.requestId, teacher.teacherUserId, teacher.teacherUserId, requestHash,
          now, now, teacher.teacherUserId, input.expectedVersion),
      db.prepare(`UPDATE teacher_profiles SET photo_storage_key=?,photo_mime_type='image/jpeg',
          photo_version=photo_version+1,photo_updated_at=?,version=version+1,
          last_mutation_request_id=?,updated_by_user_id=?,updated_at=?
        WHERE teacher_user_id=? AND version=? AND closed_at IS NULL
          AND EXISTS(SELECT 1 FROM mutation_commands WHERE id=? AND actor_user_id=?
            AND request_hash=? AND status='processing')`)
        .bind(storageKey, now, input.requestId, teacher.teacherUserId, now,
          teacher.teacherUserId, input.expectedVersion, input.requestId,
          teacher.teacherUserId, requestHash),
      db.prepare(`INSERT INTO audit_events(
          id,actor_user_id,actor_email,action,entity_type,entity_id,request_id,
          before_json,after_json,metadata_json,created_at)
        SELECT ?,?,'teacher-profile@local.invalid','teacher.photo.replaced','teacher',p.teacher_user_id,?,
          ?,?,?,?
        FROM teacher_profiles p
        WHERE p.teacher_user_id=? AND p.version=? AND p.last_mutation_request_id=?
          AND p.photo_storage_key=?`)
        .bind(`AUD-${crypto.randomUUID()}`, teacher.teacherUserId, input.requestId,
          JSON.stringify(photoSnapshot(current)),
          JSON.stringify({ photoVersion: result.photoVersion, updatedAt: now }),
          JSON.stringify({ sha256: input.sha256, width: input.width, height: input.height }),
          now, teacher.teacherUserId, result.profileVersion, input.requestId, storageKey),
      db.prepare(`UPDATE mutation_commands SET status='completed',result_json=?,updated_at=?,completed_at=?
        WHERE id=? AND actor_user_id=? AND request_hash=? AND status='processing'
          AND EXISTS(SELECT 1 FROM teacher_profiles p WHERE p.teacher_user_id=?
            AND p.version=? AND p.last_mutation_request_id=? AND p.photo_storage_key=?)`)
        .bind(JSON.stringify(result), now, now, input.requestId, teacher.teacherUserId,
          requestHash, teacher.teacherUserId, result.profileVersion, input.requestId, storageKey),
    ]);
  } catch (error) {
    const raced = await replayPhotoMutation(db, teacher.teacherUserId, input.requestId, requestHash);
    if (raced) return raced;
    await deleteUnreferencedPhoto(db, bucket, storageKey);
    throw error;
  }

  const completed = await replayPhotoMutation(db, teacher.teacherUserId, input.requestId, requestHash);
  if (!completed) {
    await deleteUnreferencedPhoto(db, bucket, storageKey);
    const fresh = await readActiveProfile(db, teacher.teacherUserId);
    throw profileVersionConflict(fresh.version);
  }
  if (current.photo_storage_key && current.photo_storage_key !== storageKey) {
    await deleteUnreferencedPhoto(db, bucket, current.photo_storage_key);
  }
  return completed;
}

export async function deleteTeacherPhotoDirect(
  db: VisitD1Database,
  bucket: CoverBucket,
  teacher: VisitTeacherIdentity,
  input: { requestId: string; expectedVersion: number },
): Promise<TeacherPhotoMutationResult> {
  const current = await readActiveProfile(db, teacher.teacherUserId);
  const requestHash = await sha256Json({
    kind: "teacher.photo.delete",
    teacherUserId: teacher.teacherUserId,
    expectedVersion: input.expectedVersion,
  });
  const replay = await replayPhotoMutation(db, teacher.teacherUserId, input.requestId, requestHash);
  if (replay) return replay;
  if (current.version !== input.expectedVersion) throw profileVersionConflict(current.version);
  if (!current.photo_storage_key) {
    throw new VisitScheduleError("teacher_photo_missing", 409, "Фото профілю вже відсутнє.");
  }
  const oldStorageKey = current.photo_storage_key;
  const now = new Date().toISOString();
  const result: TeacherPhotoMutationResult = {
    teacherUserId: teacher.teacherUserId,
    profileVersion: current.version + 1,
    photoVersion: 0,
    photoUrl: null,
    updatedAt: now,
  };
  await db.batch([
    db.prepare(`INSERT INTO mutation_commands(
        id,draft_id,kind,actor_user_id,status,target_type,target_id,request_hash,
        result_json,error_code,error_message,created_at,updated_at,completed_at)
      SELECT ?,NULL,'teacher.photo.delete',?,'processing','teacher_photo',?,?,NULL,NULL,NULL,?,?,NULL
      FROM teacher_profiles p JOIN users u ON u.id=p.teacher_user_id
      WHERE p.teacher_user_id=? AND p.version=? AND p.photo_storage_key=?
        AND p.closed_at IS NULL AND u.status='active'`)
      .bind(input.requestId, teacher.teacherUserId, teacher.teacherUserId, requestHash,
        now, now, teacher.teacherUserId, input.expectedVersion, oldStorageKey),
    db.prepare(`UPDATE teacher_profiles SET photo_storage_key=NULL,photo_mime_type=NULL,
        photo_version=0,photo_updated_at=NULL,version=version+1,last_mutation_request_id=?,
        updated_by_user_id=?,updated_at=?
      WHERE teacher_user_id=? AND version=? AND photo_storage_key=? AND closed_at IS NULL
        AND EXISTS(SELECT 1 FROM mutation_commands WHERE id=? AND actor_user_id=?
          AND request_hash=? AND status='processing')`)
      .bind(input.requestId, teacher.teacherUserId, now, teacher.teacherUserId,
        input.expectedVersion, oldStorageKey, input.requestId, teacher.teacherUserId, requestHash),
    db.prepare(`INSERT INTO audit_events(
        id,actor_user_id,actor_email,action,entity_type,entity_id,request_id,
        before_json,after_json,metadata_json,created_at)
      SELECT ?,?,'teacher-profile@local.invalid','teacher.photo.deleted','teacher',p.teacher_user_id,?,
        ?,?,NULL,?
      FROM teacher_profiles p
      WHERE p.teacher_user_id=? AND p.version=? AND p.last_mutation_request_id=?
        AND p.photo_storage_key IS NULL`)
      .bind(`AUD-${crypto.randomUUID()}`, teacher.teacherUserId, input.requestId,
        JSON.stringify(photoSnapshot(current)), JSON.stringify({ photoVersion: 0, updatedAt: now }),
        now, teacher.teacherUserId, result.profileVersion, input.requestId),
    db.prepare(`UPDATE mutation_commands SET status='completed',result_json=?,updated_at=?,completed_at=?
      WHERE id=? AND actor_user_id=? AND request_hash=? AND status='processing'
        AND EXISTS(SELECT 1 FROM teacher_profiles p WHERE p.teacher_user_id=?
          AND p.version=? AND p.last_mutation_request_id=? AND p.photo_storage_key IS NULL)`)
      .bind(JSON.stringify(result), now, now, input.requestId, teacher.teacherUserId,
        requestHash, teacher.teacherUserId, result.profileVersion, input.requestId),
  ]);
  const completed = await replayPhotoMutation(db, teacher.teacherUserId, input.requestId, requestHash);
  if (!completed) {
    const fresh = await readActiveProfile(db, teacher.teacherUserId);
    throw profileVersionConflict(fresh.version);
  }
  await deleteUnreferencedPhoto(db, bucket, oldStorageKey);
  return completed;
}

export function teacherPhotoUrl(
  audience: "teacher" | "librarian",
  teacherUserId: string,
  photoVersion: number,
  updatedAt: string | null,
): string | null {
  if (photoVersion < 1 || !updatedAt) return null;
  const token = `${photoVersion}-${Date.parse(updatedAt) || updatedAt}`;
  return audience === "teacher"
    ? `/api/teacher/profile/photo?v=${encodeURIComponent(token)}`
    : `/api/librarian/teachers/${encodeURIComponent(teacherUserId)}/photo?v=${encodeURIComponent(token)}`;
}

async function readActiveProfile(db: VisitD1Database, teacherUserId: string): Promise<ProfileRow> {
  const row = await db.prepare(`SELECT p.teacher_user_id,u.full_name,p.subject_position,p.service_contact,
      p.primary_location_id,l.name AS primary_location_name,p.photo_storage_key,p.photo_mime_type,
      p.photo_version,p.photo_updated_at,p.version,p.updated_at
    FROM users u JOIN teacher_profiles p ON p.teacher_user_id=u.id
    LEFT JOIN locations l ON l.id=p.primary_location_id
    WHERE u.id=? AND u.status='active' AND p.closed_at IS NULL LIMIT 1`)
    .bind(teacherUserId).first<ProfileRow>();
  if (!row) throw new VisitScheduleError("teacher_profile_not_found", 404, "Активний профіль учителя не знайдено.");
  return { ...row, version: Number(row.version), photo_version: Number(row.photo_version) };
}

function projectProfile(
  row: ProfileRow,
  classes: ClassRow[],
  locations: LocationOptionRow[],
  curatorClasses: CuratorOptionRow[],
  pendingCuratorRequest: PendingCuratorRequestRow | null,
): TeacherOwnProfile {
  return {
    id: row.teacher_user_id,
    fullName: row.full_name,
    subjectPosition: row.subject_position || "",
    serviceContact: row.service_contact || "",
    primaryLocation: row.primary_location_id && row.primary_location_name
      ? { id: row.primary_location_id, name: row.primary_location_name }
      : null,
    curatedClasses: classes.map((item) => ({
      id: item.id,
      className: item.class_name,
      academicYearLabel: item.academic_year_label,
      status: item.status,
      location: item.location_id && item.location_name
        ? { id: item.location_id, name: item.location_name }
        : null,
    })),
    photoUrl: teacherPhotoUrl("teacher", row.teacher_user_id, row.photo_version, row.photo_updated_at),
    photoVersion: row.photo_version,
    profileVersion: row.version,
    updatedAt: row.updated_at,
    options: {
      locations: locations.map((item) => ({ id: item.id, name: item.name })),
      curatorClasses: curatorClasses.map((item) => ({
        id: item.id,
        className: item.class_name,
        academicYearLabel: item.academic_year_label,
        location: item.location_id && item.location_name
          ? { id: item.location_id, name: item.location_name }
          : null,
        assignedTeacherName: item.assigned_teacher_name,
      })),
    },
    pendingCuratorRequest: pendingCuratorRequest ? {
      id: pendingCuratorRequest.id,
      requestedClassYearId: pendingCuratorRequest.requested_class_year_id,
      requestedClassName: pendingCuratorRequest.requested_class_name,
      version: Number(pendingCuratorRequest.version),
      createdAt: pendingCuratorRequest.created_at,
    } : null,
  };
}

async function replayPhotoMutation(
  db: VisitD1Database,
  teacherUserId: string,
  requestId: string,
  requestHash: string,
): Promise<TeacherPhotoMutationResult | null> {
  const command = await db.prepare(`SELECT actor_user_id,target_type,target_id,status,request_hash,result_json
    FROM mutation_commands WHERE id=? LIMIT 1`).bind(requestId).first<StoredCommand>();
  if (!command) return null;
  if (command.actor_user_id !== teacherUserId || command.target_type !== "teacher_photo"
    || command.target_id !== teacherUserId || command.request_hash !== requestHash) {
    throw new VisitScheduleError("request_id_conflict", 409, "Цей requestId уже використано для іншої зміни.");
  }
  if (command.status !== "completed" || !command.result_json) {
    throw new VisitScheduleError("mutation_in_progress", 409, "Зміна фото ще виконується. Оновіть профіль.");
  }
  try {
    return JSON.parse(command.result_json) as TeacherPhotoMutationResult;
  } catch {
    throw new VisitScheduleError("mutation_result_invalid", 503, "Збережений результат зміни фото пошкоджено.");
  }
}

async function replayTeacherProfileUpdate(
  db: VisitD1Database,
  teacherUserId: string,
  requestId: string,
  requestHash: string,
): Promise<TeacherProfileUpdateResult | null> {
  const command = await db.prepare(`SELECT actor_user_id,target_type,target_id,status,request_hash,result_json
    FROM mutation_commands WHERE id=? LIMIT 1`).bind(requestId).first<StoredCommand>();
  if (!command) return null;
  if (command.actor_user_id !== teacherUserId || command.target_type !== "teacher"
    || command.target_id !== teacherUserId || command.request_hash !== requestHash) {
    throw new VisitScheduleError("request_id_conflict", 409, "Цей requestId уже використано для іншої зміни.");
  }
  if (command.status !== "completed" || !command.result_json) {
    throw new VisitScheduleError("mutation_in_progress", 409, "Зміна профілю ще виконується. Оновіть сторінку.");
  }
  try {
    return JSON.parse(command.result_json) as TeacherProfileUpdateResult;
  } catch {
    throw new VisitScheduleError("mutation_result_invalid", 503, "Збережений результат зміни профілю пошкоджено.");
  }
}

async function deleteUnreferencedPhoto(
  db: VisitD1Database,
  bucket: CoverBucket,
  storageKey: string,
): Promise<void> {
  const reference = await db.prepare(`SELECT teacher_user_id FROM teacher_profiles
    WHERE photo_storage_key=? LIMIT 1`).bind(storageKey).first<{ teacher_user_id: string }>();
  if (reference) return;
  try { await bucket.delete(storageKey); } catch { /* An unreachable old object can be cleaned later. */ }
}

function photoSnapshot(row: ProfileRow) {
  return {
    photoVersion: row.photo_version,
    hasPhoto: Boolean(row.photo_storage_key),
    updatedAt: row.photo_updated_at,
  };
}

function profileVersionConflict(currentVersion: number) {
  return new VisitScheduleError("teacher_profile_version_conflict", 409,
    `Профіль уже змінився (версія ${currentVersion}). Оновіть сторінку та повторіть дію.`);
}

function safeTeacherKey(value: string): string {
  return value.replace(/[^a-z0-9_-]/giu, "-").slice(0, 120);
}

async function sha256Json(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
