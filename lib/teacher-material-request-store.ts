import type { ChatGPTUser } from "../app/chatgpt-auth.ts";
import type { VisitTeacherIdentity } from "./visit-teacher-auth.ts";
import { kyivToday } from "./visit-schedule-validation.ts";
import {
  queueTelegramForLibrariansStatement,
  queueTelegramFromPortalNotificationStatement,
} from "./telegram-outbox.ts";
import type {
  MaterialRequestActionInput,
  MaterialRequestCancelInput,
  MaterialRequestCreateInput,
  MaterialRequestIssueInput,
  MaterialRequestReadyInput,
  MaterialRequestReleaseInput,
  NotificationReadInput,
} from "./teacher-material-request-validation.ts";

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

export type TeacherMaterialRequestDatabase = {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<D1Result[]>;
};

export type MaterialRequestStatus =
  | "submitted"
  | "in_review"
  | "ready"
  | "partially_ready"
  | "completed"
  | "rejected"
  | "cancelled";

export type MaterialRequestItemProjection = {
  id: string;
  materialId: string;
  title: string;
  author: string;
  material: {
    id: string;
    title: string;
    author: string;
    year: number | null;
    thumbnailUrl: string;
  };
  requestedQuantity: number;
  approvedQuantity: number;
  fulfilledQuantity: number;
  reservedQuantity: number;
  sortOrder: number;
  reservations: MaterialRequestReservationProjection[];
};

export type MaterialRequestReservationProjection = {
  id: string;
  sourceLocationId: string;
  sourceLocationName: string;
  condition: string;
  reservedQuantity: number;
  issuedQuantity: number;
  releasedQuantity: number;
  remainingQuantity: number;
  createdAt: string;
  updatedAt: string;
};

export type MaterialRequestProjection = {
  id: string;
  teacherUserId: string;
  teacherName: string;
  teacher: { id: string; fullName: string };
  status: MaterialRequestStatus;
  teacherNotes: string;
  librarianNote: string | null;
  rejectionReason: string | null;
  pickupLocationId: string | null;
  pickupLocationName: string | null;
  pickupLocation: { id: string; name: string } | null;
  resultingLoanId: string | null;
  dueAt: string | null;
  version: number;
  submittedAt: string;
  readyAt: string | null;
  completedAt: string | null;
  rejectedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  items: MaterialRequestItemProjection[];
};

export type PortalNotificationProjection = {
  id: string;
  type: string;
  title: string;
  message: string;
  entityType: string;
  entityId: string;
  read: boolean;
  readAt: string | null;
  version: number;
  createdAt: string;
};

export type MaterialRequestPage = {
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
};

type StoredCommand = {
  actor_user_id: string;
  status: string;
  request_hash: string;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
};

type RequestRow = {
  id: string;
  teacher_user_id: string;
  teacher_name: string;
  status: MaterialRequestStatus;
  teacher_notes: string;
  librarian_note: string;
  rejection_reason: string;
  pickup_location_id: string | null;
  pickup_location_name: string | null;
  resulting_loan_id: string | null;
  due_at: string | null;
  version: number;
  submitted_at: string;
  ready_at: string | null;
  completed_at: string | null;
  rejected_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
  item_id: string;
  material_id: string;
  title_snapshot: string;
  author_snapshot: string;
  requested_quantity: number;
  approved_quantity: number | null;
  fulfilled_quantity: number;
  sort_order: number;
  publication_year: number | null;
  cover_storage_provider: string | null;
  cover_storage_key: string | null;
  cover_external_url: string | null;
  cover_sha256: string | null;
  reservations_json: string;
  new_count?: number;
};

type MutationActor = { id: string; email: string };

export const ACTIVE_MATERIAL_REQUEST_LIMIT = 20;

export class TeacherMaterialRequestError extends Error {
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
    this.name = "TeacherMaterialRequestError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export async function listTeacherMaterialRequests(
  db: TeacherMaterialRequestDatabase,
  teacherUserId: string,
  options: { status?: MaterialRequestStatus | "all"; limit?: number; cursor?: string | null } = {},
): Promise<MaterialRequestProjection[]> {
  return (await listTeacherMaterialRequestPage(db, teacherUserId, options)).requests;
}

export async function listTeacherMaterialRequestPage(
  db: TeacherMaterialRequestDatabase,
  teacherUserId: string,
  options: { status?: MaterialRequestStatus | "all"; limit?: number; cursor?: string | null } = {},
): Promise<{ requests: MaterialRequestProjection[]; page: MaterialRequestPage }> {
  const status = options.status ?? "all";
  const limit = boundedLimit(options.limit, 50, 100);
  const cursor = decodeListCursor(options.cursor, "descending");
  const statusClause = status === "all" ? "" : "AND mr.status = ?";
  const cursorClause = cursor
    ? "AND (mr.created_at < ? OR (mr.created_at = ? AND mr.id < ?))"
    : "";
  const bindings: D1Value[] = [teacherUserId];
  if (status !== "all") bindings.push(status);
  if (cursor) bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
  bindings.push(limit + 1);
  const response = await db.prepare(`
    WITH selected AS (
      SELECT mr.id
      FROM material_requests mr
      WHERE mr.teacher_user_id = ? ${statusClause} ${cursorClause}
      ORDER BY mr.created_at DESC, mr.id DESC
      LIMIT ?
    )
    ${requestProjectionSql()}
    WHERE mr.id IN (SELECT id FROM selected)
    ORDER BY mr.created_at DESC, mr.id DESC, mri.sort_order, mri.id
  `).bind(...bindings).all<RequestRow>();
  const allRequests = mapRequestRows(response.results ?? []);
  const hasMore = allRequests.length > limit;
  const requests = allRequests.slice(0, limit);
  return {
    requests,
    page: {
      limit,
      hasMore,
      nextCursor: hasMore && requests.length > 0
        ? encodeListCursor({ createdAt: requests.at(-1)!.createdAt, id: requests.at(-1)!.id })
        : null,
    },
  };
}

export async function createTeacherMaterialRequest(
  db: TeacherMaterialRequestDatabase,
  teacher: VisitTeacherIdentity,
  input: MaterialRequestCreateInput,
): Promise<MaterialRequestProjection> {
  const requestHash = await mutationHash({
    kind: "material_request.create",
    actorUserId: teacher.teacherUserId,
    input,
  });
  const replay = await replayCompletedCommand<MaterialRequestProjection>(
    db,
    input.requestId,
    teacher.teacherUserId,
    requestHash,
  );
  if (replay) return replay;

  const authNow = new Date().toISOString();
  await requireActiveTeacherPrincipal(db, teacher, authNow);

  const activeRequestCount = await countActiveMaterialRequests(db, teacher.teacherUserId);
  if (activeRequestCount >= ACTIVE_MATERIAL_REQUEST_LIMIT) {
    throw requestLimitReachedError();
  }

  const materialRows = await db.prepare(`
    WITH requested AS (
      SELECT
        CAST(json_extract(value, '$.materialId') AS TEXT) AS material_id,
        CAST(json_extract(value, '$.quantity') AS INTEGER) AS qty,
        CAST(key AS INTEGER) AS sort_order
      FROM json_each(?)
    )
    SELECT requested.material_id, requested.qty, requested.sort_order,
           m.id, m.title, m.author, m.publication_year,
           cover.storage_provider AS cover_storage_provider,
           cover.storage_key AS cover_storage_key,
           cover.external_url AS cover_external_url,
           cover.sha256 AS cover_sha256
    FROM requested
    LEFT JOIN materials m ON m.id = requested.material_id
      AND m.status = 'active' AND m.archived_at IS NULL
    LEFT JOIN material_cover_assets cover
      ON cover.material_id=m.id AND cover.status='ready'
    ORDER BY requested.sort_order
  `).bind(JSON.stringify(input.items)).all<{
    material_id: string;
    qty: number;
    sort_order: number;
    id: string | null;
    title: string | null;
    author: string | null;
    publication_year: number | null;
    cover_storage_provider: string | null;
    cover_storage_key: string | null;
    cover_external_url: string | null;
    cover_sha256: string | null;
  }>();
  const rows = materialRows.results ?? [];
  if (rows.length !== input.items.length || rows.some((row) => !row.id || !row.title)) {
    const missing = rows.find((row) => !row.id)?.material_id ?? "";
    throw new TeacherMaterialRequestError(
      "material_not_found",
      404,
      "Один із матеріалів більше недоступний у каталозі.",
      missing ? { materialId: missing } : undefined,
    );
  }

  const createdAt = new Date().toISOString();
  const materialRequestId = `MRQ-${crypto.randomUUID()}`;
  const eventId = `MRE-${crypto.randomUUID()}`;
  const snapshots = rows.map((row) => ({
    materialId: row.material_id,
    title: String(row.title ?? ""),
    author: String(row.author ?? ""),
    year: nullableYear(row.publication_year),
    thumbnailUrl: coverUrlFromParts(
      row.material_id,
      row.cover_storage_provider,
      row.cover_storage_key,
      row.cover_external_url,
      row.cover_sha256,
    ),
    qty: Number(row.qty),
    sortOrder: Number(row.sort_order),
    itemId: `MRI-${crypto.randomUUID()}`,
  }));
  const result: MaterialRequestProjection = {
    id: materialRequestId,
    teacherUserId: teacher.teacherUserId,
    teacherName: teacher.fullName,
    teacher: { id: teacher.teacherUserId, fullName: teacher.fullName },
    status: "submitted",
    teacherNotes: input.notes ?? "",
    librarianNote: null,
    rejectionReason: null,
    pickupLocationId: null,
    pickupLocationName: null,
    pickupLocation: null,
    resultingLoanId: null,
    dueAt: null,
    version: 1,
    submittedAt: createdAt,
    readyAt: null,
    completedAt: null,
    rejectedAt: null,
    cancelledAt: null,
    createdAt,
    updatedAt: createdAt,
    items: snapshots.map((item) => ({
      id: item.itemId,
      materialId: item.materialId,
      title: item.title,
      author: item.author,
      material: {
        id: item.materialId,
        title: item.title,
        author: item.author,
        year: item.year,
        thumbnailUrl: item.thumbnailUrl,
      },
      requestedQuantity: item.qty,
      approvedQuantity: 0,
      fulfilledQuantity: 0,
      reservedQuantity: 0,
      sortOrder: item.sortOrder,
      reservations: [],
    })),
  };
  const statements: D1Statement[] = [
    insertCommandStatement(
      db,
      input.requestId,
      requestHash,
      teacher.teacherUserId,
      "material_request.create",
      "material_request",
      materialRequestId,
      createdAt,
    ),
    db.prepare(`
      INSERT INTO material_requests (
        id, teacher_user_id, status, teacher_notes, librarian_note,
        rejection_reason, pickup_location_id, resulting_loan_id,
        reviewed_by_user_id, cancelled_by_user_id, version, submitted_at,
        ready_at, completed_at, rejected_at, cancelled_at, created_at, updated_at
      )
      SELECT ?, u.id, 'submitted', ?, '', '', NULL, NULL, NULL, NULL, 1,
             ?, NULL, NULL, NULL, NULL, ?, ?
      FROM users u
      JOIN teacher_profiles profile ON profile.teacher_user_id=u.id AND profile.closed_at IS NULL
      WHERE u.id = ? AND u.full_name=? AND u.status = 'active'
        AND EXISTS (
          SELECT 1
          FROM visit_teacher_credentials credential
          JOIN visit_teacher_sessions session
            ON session.teacher_user_id=credential.teacher_user_id
            AND session.credential_version=credential.version
          WHERE credential.teacher_user_id=u.id AND credential.status='active'
            AND credential.version=? AND session.token_hash=?
            AND session.revoked_at IS NULL AND session.expires_at>?
        )
        AND (
          SELECT COUNT(*) FROM material_requests active_request
          WHERE active_request.teacher_user_id=u.id
            AND active_request.status IN ('submitted','in_review','ready','partially_ready')
        ) < ?
    `).bind(
      materialRequestId,
      input.notes ?? "",
      createdAt,
      createdAt,
      createdAt,
      teacher.teacherUserId,
      teacher.fullName,
      teacher.credentialVersion,
      teacher.tokenHash,
      authNow,
      ACTIVE_MATERIAL_REQUEST_LIMIT,
    ),
    db.prepare(`
      WITH requested AS (
        SELECT
          CAST(json_extract(value, '$.itemId') AS TEXT) AS item_id,
          CAST(json_extract(value, '$.materialId') AS TEXT) AS material_id,
          CAST(json_extract(value, '$.title') AS TEXT) AS title_snapshot,
          CAST(json_extract(value, '$.author') AS TEXT) AS author_snapshot,
          CAST(json_extract(value, '$.qty') AS INTEGER) AS qty,
          CAST(json_extract(value, '$.sortOrder') AS INTEGER) AS sort_order
        FROM json_each(?)
      )
      INSERT INTO material_request_items (
        id, request_id, material_id, title_snapshot, author_snapshot,
        requested_quantity, approved_quantity, fulfilled_quantity,
        sort_order, created_at, updated_at
      )
      SELECT requested.item_id, mr.id, m.id, requested.title_snapshot,
             requested.author_snapshot, requested.qty, NULL, 0,
             requested.sort_order, ?, ?
      FROM requested
      JOIN material_requests mr ON mr.id = ? AND mr.teacher_user_id = ?
      JOIN materials m ON m.id = requested.material_id
        AND m.status = 'active' AND m.archived_at IS NULL
    `).bind(
      JSON.stringify(snapshots),
      createdAt,
      createdAt,
      materialRequestId,
      teacher.teacherUserId,
    ),
    db.prepare(`
      INSERT INTO material_request_events (
        id, request_id, actor_user_id, actor_kind, kind,
        from_status, to_status, metadata_json, created_at
      ) VALUES (
        ?, (
          SELECT mr.id FROM material_requests mr
          WHERE mr.id = ? AND mr.teacher_user_id = ?
            AND (SELECT COUNT(*) FROM material_request_items WHERE request_id = mr.id) = ?
        ), ?, 'teacher', 'submitted', NULL, 'submitted', ?, ?
      )
    `).bind(
      eventId,
      materialRequestId,
      teacher.teacherUserId,
      snapshots.length,
      teacher.teacherUserId,
      JSON.stringify({ itemCount: snapshots.length }),
      createdAt,
    ),
    db.prepare(`
      INSERT INTO audit_events (
        id, actor_user_id, actor_email, action, entity_type, entity_id,
        request_id, before_json, after_json, metadata_json, created_at
      ) VALUES (?, ?, 'teacher-code@local.invalid', 'material_request.submitted',
        'material_request', (
          SELECT mr.id FROM material_requests mr
          WHERE mr.id = ? AND mr.teacher_user_id = ?
            AND EXISTS (SELECT 1 FROM material_request_events WHERE id = ? AND request_id = mr.id)
        ), ?, NULL, ?, ?, ?)
    `).bind(
      `AUD-${crypto.randomUUID()}`,
      teacher.teacherUserId,
      materialRequestId,
      teacher.teacherUserId,
      eventId,
      input.requestId,
      JSON.stringify(result),
      JSON.stringify({ itemCount: snapshots.length }),
      createdAt,
    ),
    queueTelegramForLibrariansStatement(db, {
      dedupeKey: `material-request:${materialRequestId}:submitted:${input.requestId}`,
      auditRequestId: input.requestId,
      category: "orders",
      type: "material_request_submitted",
      title: "Нове замовлення вчителя",
      message: `${teacher.fullName}: ${snapshots.length} позиц., ${snapshots.reduce((sum, item) => sum + item.qty, 0)} примірн.`,
      targetPath: "/librarian/teachers",
      entityType: "material_request",
      entityId: materialRequestId,
      createdAt,
    }),
    completeCommandStatement(db, input.requestId, result, createdAt),
  ];
  try {
    const replayed = await executeIdempotentBatch<MaterialRequestProjection>(
      db,
      statements,
      input.requestId,
      teacher.teacherUserId,
      requestHash,
      "material_request_conflict",
    "Заявку не створено, бо дані каталогу змінилися. Оновіть каталог і спробуйте ще раз.",
    );
    return replayed ?? result;
  } catch (error) {
    if (
      error instanceof TeacherMaterialRequestError
      && error.code === "material_request_conflict"
    ) {
      await requireActiveTeacherPrincipal(db, teacher, new Date().toISOString());
      if (await countActiveMaterialRequests(db, teacher.teacherUserId) >= ACTIVE_MATERIAL_REQUEST_LIMIT) {
        throw requestLimitReachedError();
      }
    }
    throw error;
  }
}

export async function cancelTeacherMaterialRequest(
  db: TeacherMaterialRequestDatabase,
  teacher: VisitTeacherIdentity,
  materialRequestId: string,
  input: MaterialRequestCancelInput,
): Promise<MaterialRequestProjection> {
  const requestHash = await mutationHash({
    kind: "material_request.cancel",
    actorUserId: teacher.teacherUserId,
    materialRequestId,
    input,
  });
  const replay = await replayCompletedCommand<MaterialRequestProjection>(
    db,
    input.requestId,
    teacher.teacherUserId,
    requestHash,
  );
  if (replay) return replay;
  await requireActiveTeacherPrincipal(db, teacher, new Date().toISOString());
  const existing = await db.prepare(`
    SELECT status, version FROM material_requests
    WHERE id = ? AND teacher_user_id = ? LIMIT 1
  `).bind(materialRequestId, teacher.teacherUserId).first<{
    status: MaterialRequestStatus;
    version: number;
  }>();
  if (!existing) throw new TeacherMaterialRequestError("request_not_found", 404, "Заявку не знайдено.");
  if (Number(existing.version) !== input.expectedVersion) {
    throw new TeacherMaterialRequestError("request_version_conflict", 409, "Заявка вже змінилася. Оновіть сторінку.");
  }
  if (existing.status !== "submitted" && existing.status !== "in_review") {
    throw new TeacherMaterialRequestError("request_not_cancellable", 409, "Цю заявку вже не можна скасувати.");
  }
  const cancelledAt = new Date().toISOString();
  const current = await getMaterialRequest(db, materialRequestId);
  if (!current) throw new TeacherMaterialRequestError("request_not_found", 404, "Заявку не знайдено.");
  const result: MaterialRequestProjection = {
    ...current,
    status: "cancelled" as const,
    version: input.expectedVersion + 1,
    updatedAt: cancelledAt,
    cancelledAt,
  };
  const eventId = `MRE-${crypto.randomUUID()}`;
  const statements = [
    insertCommandStatement(
      db,
      input.requestId,
      requestHash,
      teacher.teacherUserId,
      "material_request.cancel",
      "material_request",
      materialRequestId,
      cancelledAt,
    ),
    db.prepare(`
      INSERT INTO material_request_events (
        id, request_id, actor_user_id, actor_kind, kind,
        from_status, to_status, metadata_json, created_at
      ) VALUES (?, (
        SELECT mr.id
        FROM material_requests mr
        JOIN users teacher ON teacher.id=mr.teacher_user_id
          AND teacher.full_name=? AND teacher.status='active'
        JOIN teacher_profiles profile ON profile.teacher_user_id=teacher.id AND profile.closed_at IS NULL
        JOIN visit_teacher_credentials credential
          ON credential.teacher_user_id=teacher.id AND credential.status='active'
          AND credential.version=?
        JOIN visit_teacher_sessions session
          ON session.teacher_user_id=teacher.id
          AND session.credential_version=credential.version
          AND session.token_hash=? AND session.revoked_at IS NULL AND session.expires_at>?
        JOIN mutation_commands command ON command.id=?
          AND command.actor_user_id=mr.teacher_user_id
          AND command.status='processing'
          AND command.target_type='material_request'
          AND command.target_id=mr.id
          AND command.request_hash=?
        WHERE mr.id=? AND mr.teacher_user_id=? AND mr.status=? AND mr.version=?
      ), ?, 'teacher', 'cancelled', ?, 'cancelled', ?, ?)
    `).bind(
      eventId,
      teacher.fullName,
      teacher.credentialVersion,
      teacher.tokenHash,
      cancelledAt,
      input.requestId,
      requestHash,
      materialRequestId,
      teacher.teacherUserId,
      existing.status,
      input.expectedVersion,
      teacher.teacherUserId,
      existing.status,
      input.reason ? JSON.stringify({ reason: input.reason }) : null,
      cancelledAt,
    ),
    db.prepare(`
      UPDATE material_requests
      SET status = 'cancelled', cancelled_by_user_id = ?, cancelled_at = ?,
          version = version + 1, updated_at = ?
      WHERE id = ? AND teacher_user_id = ? AND version = ? AND status = ?
        AND EXISTS (
          SELECT 1 FROM material_request_events
          WHERE id=? AND request_id=material_requests.id
            AND actor_user_id=? AND from_status=? AND to_status='cancelled'
        )
    `).bind(
      teacher.teacherUserId,
      cancelledAt,
      cancelledAt,
      materialRequestId,
      teacher.teacherUserId,
      input.expectedVersion,
      existing.status,
      eventId,
      teacher.teacherUserId,
      existing.status,
    ),
    db.prepare(`
      INSERT INTO audit_events (
        id, actor_user_id, actor_email, action, entity_type, entity_id,
        request_id, before_json, after_json, metadata_json, created_at
      ) VALUES (?, ?, 'teacher-code@local.invalid', 'material_request.cancelled',
        'material_request', (
          SELECT mr.id
          FROM material_request_events event
          JOIN material_requests mr ON mr.id=event.request_id
          WHERE event.id=? AND mr.status='cancelled' AND mr.version=?
            AND mr.cancelled_by_user_id=? AND mr.cancelled_at=? AND mr.updated_at=?
        ), ?, ?, ?, NULL, ?)
    `).bind(
      `AUD-${crypto.randomUUID()}`,
      teacher.teacherUserId,
      eventId,
      input.expectedVersion + 1,
      teacher.teacherUserId,
      cancelledAt,
      cancelledAt,
      input.requestId,
      JSON.stringify({ status: existing.status, version: input.expectedVersion }),
      JSON.stringify(result),
      cancelledAt,
    ),
    queueTelegramForLibrariansStatement(db, {
      dedupeKey: `material-request:${materialRequestId}:cancelled:${input.requestId}`,
      auditRequestId: input.requestId,
      category: "orders",
      type: "material_request_cancelled",
      title: "Замовлення скасовано",
      message: `${teacher.fullName} скасував(-ла) своє замовлення.${input.reason ? ` Причина: ${input.reason}` : ""}`,
      targetPath: "/librarian/teachers",
      entityType: "material_request",
      entityId: materialRequestId,
      createdAt: cancelledAt,
    }),
    completeCommandStatement(db, input.requestId, result, cancelledAt),
  ];
  try {
    const replayed = await executeIdempotentBatch<typeof result>(
    db,
    statements,
    input.requestId,
    teacher.teacherUserId,
    requestHash,
    "request_version_conflict",
    "Заявка вже змінилася. Оновіть сторінку.",
    );
    return replayed ?? result;
  } catch (error) {
    if (error instanceof TeacherMaterialRequestError && error.code === "request_version_conflict") {
      await requireActiveTeacherPrincipal(db, teacher, new Date().toISOString());
    }
    throw error;
  }
}

export async function listLibrarianMaterialRequests(
  db: TeacherMaterialRequestDatabase,
  options: {
    status?: MaterialRequestStatus | "active" | "all";
    limit?: number;
    cursor?: string | null;
  } = {},
): Promise<{ requests: MaterialRequestProjection[]; newCount: number; page: MaterialRequestPage }> {
  const status = options.status ?? "all";
  const limit = boundedLimit(options.limit, 100, 100);
  const cursor = decodeListCursor(options.cursor, "ranked");
  const statusClause = status === "all"
    ? ""
    : status === "active"
      ? "AND mr.status IN ('submitted','in_review','ready','partially_ready')"
      : "AND mr.status = ?";
  const rankSql = `CASE mr.status WHEN 'submitted' THEN 0 WHEN 'in_review' THEN 1
    WHEN 'partially_ready' THEN 2 WHEN 'ready' THEN 3 ELSE 4 END`;
  const cursorClause = cursor && typeof cursor.rank === "number"
    ? `AND (${rankSql} > ? OR (${rankSql} = ? AND
        (mr.created_at > ? OR (mr.created_at = ? AND mr.id > ?))))`
    : "";
  const bindings: D1Value[] = [];
  if (status !== "all" && status !== "active") bindings.push(status);
  if (cursor && typeof cursor.rank === "number") {
    bindings.push(cursor.rank, cursor.rank, cursor.createdAt, cursor.createdAt, cursor.id);
  }
  bindings.push(limit + 1);
  const [response, count] = await Promise.all([
    db.prepare(`
      WITH selected AS (
        SELECT mr.id
        FROM material_requests mr
        WHERE 1 = 1 ${statusClause} ${cursorClause}
        ORDER BY
          ${rankSql},
          mr.created_at ASC, mr.id ASC
        LIMIT ?
      )
      ${requestProjectionSql()}
      WHERE mr.id IN (SELECT id FROM selected)
      ORDER BY
        ${rankSql},
        mr.created_at ASC, mr.id ASC, mri.sort_order, mri.id
    `).bind(...bindings).all<RequestRow>(),
    db.prepare(`
      SELECT COUNT(*) AS new_count
      FROM material_requests
      WHERE status = 'submitted'
    `).first<{ new_count: number }>(),
  ]);
  const allRequests = mapRequestRows(response.results ?? []);
  const hasMore = allRequests.length > limit;
  const requests = allRequests.slice(0, limit);
  const last = requests.at(-1);
  return {
    requests,
    newCount: Math.max(0, Number(count?.new_count) || 0),
    page: {
      limit,
      hasMore,
      nextCursor: hasMore && last
        ? encodeListCursor({ createdAt: last.createdAt, id: last.id, rank: materialRequestStatusRank(last.status) })
        : null,
    },
  };
}

export async function listMaterialRequestPickupLocations(
  db: TeacherMaterialRequestDatabase,
): Promise<Array<{ id: string; name: string; type: string; isPublic: true; status: "active" }>> {
  const response = await db.prepare(`
    SELECT id, name, type
    FROM locations
    WHERE status = 'active' AND is_public = 1
    ORDER BY sort_order, name, id
    LIMIT 500
  `).all<{ id: string; name: string; type: string }>();
  return (response.results ?? []).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    type: String(row.type),
    isPublic: true,
    status: "active",
  }));
}

export async function applyLibrarianMaterialRequestAction(
  db: TeacherMaterialRequestDatabase,
  user: ChatGPTUser,
  materialRequestId: string,
  input: MaterialRequestActionInput,
): Promise<Record<string, unknown>> {
  const actor = await resolveLibrarianActor(db, user);
  const requestHash = await mutationHash({
    kind: `material_request.${input.action}`,
    actorUserId: actor.id,
    materialRequestId,
    input,
  });
  const replay = await replayCompletedCommand<Record<string, unknown>>(
    db,
    input.requestId,
    actor.id,
    requestHash,
  );
  if (replay) return replay;
  const current = await getMaterialRequest(db, materialRequestId);
  if (!current) throw new TeacherMaterialRequestError("request_not_found", 404, "Заявку не знайдено.");
  if (current.version !== input.expectedVersion) {
    throw new TeacherMaterialRequestError("request_version_conflict", 409, "Заявка вже змінилася. Оновіть чергу.");
  }
  if (input.action === "ready") {
    return readyMaterialRequest(db, actor, current, input, requestHash);
  }
  if (input.action === "issue") {
    return issueMaterialRequest(db, actor, current, input, requestHash);
  }
  if (input.action === "release") {
    return releaseMaterialRequest(db, actor, current, input, requestHash);
  }
  if (input.action === "complete") {
    const items = current.items.flatMap((item) => item.reservations)
      .filter((reservation) => reservation.remainingQuantity > 0)
      .map((reservation) => ({
        reservationId: reservation.id,
        quantity: reservation.remainingQuantity,
      }));
    if (!items.length) {
      if (current.resultingLoanId
        && (current.status === "ready" || current.status === "partially_ready")) {
        // Before reservation support, "ready" already created the loan and
        // reduced holdings. Completing that legacy row must only record the
        // physical handoff; issuing it again would double-decrement stock.
        return transitionMaterialRequest(db, actor, current, input, requestHash);
      }
      throw new TeacherMaterialRequestError(
        "nothing_to_issue",
        409,
        "У заявці немає підготовлених примірників для видачі.",
      );
    }
    return issueMaterialRequest(db, actor, current, {
      ...input,
      action: "issue",
      issuedAt: kyivToday(),
      dueAt: current.dueAt,
      items,
    }, requestHash);
  }
  return transitionMaterialRequest(db, actor, current, input, requestHash);
}

export async function listTeacherNotifications(
  db: TeacherMaterialRequestDatabase,
  teacherUserId: string,
  options: number | { limit?: number; cursor?: string | null } = 50,
): Promise<{
  notifications: PortalNotificationProjection[];
  unreadCount: number;
  page: MaterialRequestPage;
}> {
  const safeLimit = boundedLimit(typeof options === "number" ? options : options.limit, 50, 100);
  const cursor = decodeListCursor(typeof options === "number" ? null : options.cursor, "descending");
  const cursorClause = cursor
    ? "AND (created_at < ? OR (created_at = ? AND id < ?))"
    : "";
  const notificationBindings: D1Value[] = [teacherUserId];
  if (cursor) notificationBindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
  notificationBindings.push(safeLimit + 1);
  const [response, count] = await Promise.all([
    db.prepare(`
      SELECT id, type, title, message, entity_type, entity_id,
             read_at, version, created_at
      FROM portal_notifications
      WHERE teacher_user_id = ? ${cursorClause}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).bind(...notificationBindings).all<{
      id: string;
      type: string;
      title: string;
      message: string;
      entity_type: string;
      entity_id: string;
      read_at: string | null;
      version: number;
      created_at: string;
    }>(),
    db.prepare(`
      SELECT COUNT(*) AS unread_count
      FROM portal_notifications
      WHERE teacher_user_id = ? AND read_at IS NULL
    `).bind(teacherUserId).first<{ unread_count: number }>(),
  ]);
  const allNotifications = (response.results ?? []).map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      message: row.message,
      entityType: row.entity_type,
      entityId: row.entity_id,
      read: row.read_at !== null,
      readAt: row.read_at,
      version: Number(row.version),
      createdAt: row.created_at,
    }));
  const hasMore = allNotifications.length > safeLimit;
  const notifications = allNotifications.slice(0, safeLimit);
  const last = notifications.at(-1);
  return {
    notifications,
    unreadCount: Math.max(0, Number(count?.unread_count) || 0),
    page: {
      limit: safeLimit,
      hasMore,
      nextCursor: hasMore && last
        ? encodeListCursor({ createdAt: last.createdAt, id: last.id })
        : null,
    },
  };
}

export async function markTeacherNotificationRead(
  db: TeacherMaterialRequestDatabase,
  teacher: VisitTeacherIdentity,
  notificationId: string,
  input: NotificationReadInput,
): Promise<PortalNotificationProjection> {
  const requestHash = await mutationHash({
    kind: "portal_notifications.read",
    actorUserId: teacher.teacherUserId,
    notificationId,
    input,
  });
  const replay = await replayCompletedCommand<PortalNotificationProjection>(
    db,
    input.requestId,
    teacher.teacherUserId,
    requestHash,
  );
  if (replay) return replay;
  await requireActiveTeacherPrincipal(db, teacher, new Date().toISOString());
  const existing = await db.prepare(`
    SELECT id, type, title, message, entity_type, entity_id,
           version, read_at, created_at
    FROM portal_notifications
    WHERE id=? AND teacher_user_id=? LIMIT 1
  `).bind(notificationId, teacher.teacherUserId).first<{
    version: number;
    read_at: string | null;
    id: string;
    type: string;
    title: string;
    message: string;
    entity_type: string;
    entity_id: string;
    created_at: string;
  }>();
  if (!existing) {
    throw new TeacherMaterialRequestError("notification_not_found", 404, "Сповіщення не знайдено.");
  }
  if (Number(existing.version) !== input.expectedVersion) {
    throw new TeacherMaterialRequestError("notification_version_conflict", 409, "Сповіщення вже змінилося.");
  }
  if (existing.read_at) {
    throw new TeacherMaterialRequestError("notification_already_read", 409, "Сповіщення вже прочитано.");
  }
  const readAt = new Date().toISOString();
  const result: PortalNotificationProjection = {
    id: existing.id,
    type: existing.type,
    title: existing.title,
    message: existing.message,
    entityType: existing.entity_type,
    entityId: existing.entity_id,
    read: true,
    readAt,
    version: input.expectedVersion + 1,
    createdAt: existing.created_at,
  };
  const auditId = `AUD-${crypto.randomUUID()}`;
  const statements = [
    insertCommandStatement(
      db,
      input.requestId,
      requestHash,
      teacher.teacherUserId,
      "portal_notifications.read",
      "portal_notification",
      notificationId,
      readAt,
    ),
    db.prepare(`
      INSERT INTO audit_events (
        id, actor_user_id, actor_email, action, entity_type, entity_id,
        request_id, before_json, after_json, metadata_json, created_at
      ) VALUES (?, ?, 'teacher-code@local.invalid', 'portal_notifications.read',
        'portal_notification', (
          SELECT notification.id
          FROM portal_notifications notification
          JOIN users teacher ON teacher.id=notification.teacher_user_id
            AND teacher.full_name=? AND teacher.status='active'
          JOIN teacher_profiles profile ON profile.teacher_user_id=teacher.id AND profile.closed_at IS NULL
          JOIN visit_teacher_credentials credential
            ON credential.teacher_user_id=teacher.id AND credential.status='active'
            AND credential.version=?
          JOIN visit_teacher_sessions session
            ON session.teacher_user_id=teacher.id
            AND session.credential_version=credential.version
            AND session.token_hash=? AND session.revoked_at IS NULL AND session.expires_at>?
          JOIN mutation_commands command ON command.id=?
            AND command.actor_user_id=notification.teacher_user_id
            AND command.status='processing'
            AND command.target_type='portal_notification'
            AND command.target_id=notification.id
            AND command.request_hash=?
          WHERE notification.id=? AND notification.teacher_user_id=?
            AND notification.version=? AND notification.read_at IS NULL
        ), ?, NULL, NULL, ?, ?)
    `).bind(
      auditId,
      teacher.teacherUserId,
      teacher.fullName,
      teacher.credentialVersion,
      teacher.tokenHash,
      readAt,
      input.requestId,
      requestHash,
      notificationId,
      teacher.teacherUserId,
      input.expectedVersion,
      input.requestId,
      JSON.stringify({ read: true }),
      readAt,
    ),
    db.prepare(`
      UPDATE portal_notifications
      SET read_at = ?, version = version + 1, updated_at = ?
      WHERE teacher_user_id = ? AND id = ? AND version = ? AND read_at IS NULL
        AND EXISTS (
          SELECT 1 FROM audit_events
          WHERE id=? AND entity_type='portal_notification'
            AND entity_id=portal_notifications.id AND request_id=?
        )
    `).bind(
      readAt,
      readAt,
      teacher.teacherUserId,
      notificationId,
      input.expectedVersion,
      auditId,
      input.requestId,
    ),
    completeCommandStatement(db, input.requestId, result, readAt),
  ];
  try {
    const replayed = await executeIdempotentBatch<typeof result>(
    db,
    statements,
    input.requestId,
    teacher.teacherUserId,
    requestHash,
    "notification_update_conflict",
    "Не вдалося оновити сповіщення. Спробуйте ще раз.",
    );
    return replayed ?? result;
  } catch (error) {
    if (error instanceof TeacherMaterialRequestError && error.code === "notification_update_conflict") {
      await requireActiveTeacherPrincipal(db, teacher, new Date().toISOString());
    }
    throw error;
  }
}

async function transitionMaterialRequest(
  db: TeacherMaterialRequestDatabase,
  actor: MutationActor,
  current: MaterialRequestProjection,
  input: Exclude<MaterialRequestActionInput, MaterialRequestReadyInput>,
  requestHash: string,
): Promise<Record<string, unknown>> {
  const allowed = input.action === "start_review"
    ? ["submitted"]
    : input.action === "reject"
      ? ["submitted", "in_review"]
      : ["ready", "partially_ready"];
  if (!allowed.includes(current.status)) {
    throw new TeacherMaterialRequestError(
      "invalid_request_transition",
      409,
      "Ця зміна статусу вже недоступна.",
      { status: current.status },
    );
  }
  const now = new Date().toISOString();
  const toStatus: MaterialRequestStatus = input.action === "start_review"
    ? "in_review"
    : input.action === "reject"
      ? "rejected"
      : "completed";
  const result = {
    requestId: current.id,
    status: toStatus,
    version: current.version + 1,
    updatedAt: now,
  };
  const eventId = `MRE-${crypto.randomUUID()}`;
  const notificationId = `NTF-${crypto.randomUUID()}`;
  const notification = transitionNotification(input, current);
  const updateSql = input.action === "start_review"
    ? `UPDATE material_requests SET status='in_review', librarian_note=?,
         reviewed_by_user_id=?, version=version+1, updated_at=?
       WHERE id=? AND version=? AND status='submitted'`
    : input.action === "reject"
      ? `UPDATE material_requests SET status='rejected', librarian_note=?,
           rejection_reason=?, reviewed_by_user_id=?, rejected_at=?,
           version=version+1, updated_at=?
         WHERE id=? AND version=? AND status IN ('submitted','in_review')`
      : `UPDATE material_requests SET status='completed', librarian_note=?,
           reviewed_by_user_id=?, completed_at=?, version=version+1, updated_at=?
         WHERE id=? AND version=? AND status IN ('ready','partially_ready')`;
  const updateBindings: D1Value[] = input.action === "start_review"
    ? ["", actor.id, now, current.id, current.version]
    : input.action === "reject"
      ? ["", input.reason, actor.id, now, now, current.id, current.version]
      : ["", actor.id, now, now, current.id, current.version];
  const statements: D1Statement[] = [
    insertCommandStatement(
      db,
      input.requestId,
      requestHash,
      actor.id,
      `material_request.${input.action}`,
      "material_request",
      current.id,
      now,
    ),
    db.prepare(`
      INSERT INTO material_request_events (
        id, request_id, actor_user_id, actor_kind, kind,
        from_status, to_status, metadata_json, created_at
      ) VALUES (?, (
        SELECT mr.id
        FROM material_requests mr
        JOIN users actor ON actor.id=?
          AND actor.role IN ('admin','librarian') AND actor.status='active'
        JOIN mutation_commands command ON command.id=?
          AND command.actor_user_id=actor.id
          AND command.status='processing'
          AND command.target_type='material_request'
          AND command.target_id=mr.id
          AND command.request_hash=?
        WHERE mr.id=? AND mr.status=? AND mr.version=?
      ), ?, 'librarian', ?, ?, ?, ?, ?)
    `).bind(
      eventId,
      actor.id,
      input.requestId,
      requestHash,
      current.id,
      current.status,
      current.version,
      actor.id,
      input.action,
      current.status,
      toStatus,
      input.action === "reject" ? JSON.stringify({ reason: input.reason }) : null,
      now,
    ),
    db.prepare(`${updateSql}
      AND EXISTS (
        SELECT 1 FROM material_request_events
        WHERE id=? AND request_id=material_requests.id
          AND actor_user_id=? AND from_status=? AND to_status=?
      )`).bind(...updateBindings, eventId, actor.id, current.status, toStatus),
    db.prepare(`
      INSERT INTO portal_notifications (
        id, teacher_user_id, dedupe_key, type, title, message,
        entity_type, entity_id, read_at, version, created_at, updated_at
      )
      SELECT ?, mr.teacher_user_id, ?, ?, ?, ?, 'material_request', mr.id,
             NULL, 1, ?, ?
      FROM material_requests mr
      WHERE mr.id=? AND mr.status=? AND mr.version=?
        AND mr.reviewed_by_user_id=?
        AND (${input.action === "reject"
          ? "mr.rejected_at=? AND mr.rejection_reason=?"
          : input.action === "complete"
            ? "mr.completed_at=?"
            : "mr.updated_at=?"})
        AND EXISTS (
          SELECT 1 FROM material_request_events
          WHERE id=? AND request_id=mr.id AND actor_user_id=?
            AND kind=? AND from_status=? AND to_status=?
        )
    `).bind(
      notificationId,
      `material-request:${current.id}:${input.action}:${input.requestId}`,
      notification.type,
      notification.title,
      notification.message,
      now,
      now,
      current.id,
      toStatus,
      current.version + 1,
      actor.id,
      now,
      ...(input.action === "reject" ? [input.reason] : []),
      eventId,
      actor.id,
      input.action,
      current.status,
      toStatus,
    ),
    queueTelegramFromPortalNotificationStatement(
      db,
      notificationId,
      "orders",
      "/teacher?tab=notifications",
      now,
    ),
    requestAuditStatement(
      db,
      actor,
      input.requestId,
      current,
      result,
      eventId,
      { status: toStatus, version: current.version + 1, updatedAt: now },
      now,
    ),
    completeCommandStatement(db, input.requestId, result, now),
  ];
  const replayed = await executeIdempotentBatch<typeof result>(
    db,
    statements,
    input.requestId,
    actor.id,
    requestHash,
    "request_version_conflict",
    "Заявка вже змінилася. Оновіть чергу.",
  );
  return replayed ?? result;
}

async function readyMaterialRequest(
  db: TeacherMaterialRequestDatabase,
  actor: MutationActor,
  current: MaterialRequestProjection,
  input: MaterialRequestReadyInput,
  requestHash: string,
): Promise<Record<string, unknown>> {
  if (!["submitted", "in_review", "ready", "partially_ready"].includes(current.status)) {
    throw new TeacherMaterialRequestError(
      "invalid_request_transition",
      409,
      "Цю заявку вже не можна підготувати.",
      { status: current.status },
    );
  }
  const currentByItem = new Map(current.items.map((item) => [item.id, item]));
  const targets = input.items.map((item) => {
    const requested = currentByItem.get(item.itemId);
    if (!requested || item.approvedQuantity > requested.requestedQuantity) {
      throw new TeacherMaterialRequestError(
        "request_items_mismatch",
        409,
        "Підтверджена кількість не відповідає заявці.",
        { itemId: item.itemId },
      );
    }
    if (item.approvedQuantity < requested.approvedQuantity) {
      throw new TeacherMaterialRequestError(
        "reservation_quantity_decrease_requires_release",
        409,
        "Для зменшення підготовленої кількості скористайтеся дією «Не забрано».",
        { itemId: item.itemId, approvedQuantity: requested.approvedQuantity },
      );
    }
    return {
      ...item,
      materialId: requested.materialId,
      deltaQuantity: item.approvedQuantity - requested.approvedQuantity,
    };
  });
  const dueBase = kyivToday();
  if (input.dueAt && input.dueAt < dueBase) {
    throw new TeacherMaterialRequestError(
      "invalid_due_date",
      400,
      "Дата повернення не може бути в минулому.",
    );
  }
  const deltas = targets.filter((item) => item.deltaQuantity > 0);
  const settingsChanged = input.pickupLocationId !== current.pickupLocationId
    || input.dueAt !== current.dueAt;
  if (!deltas.length && !settingsChanged) {
    throw new TeacherMaterialRequestError(
      "nothing_to_reserve",
      409,
      "Підготовлена кількість не змінилася.",
    );
  }

  const availability = deltas.length
    ? await db.prepare(`
        WITH requested AS (
          SELECT
            CAST(json_extract(value, '$.itemId') AS TEXT) AS item_id,
            CAST(json_extract(value, '$.materialId') AS TEXT) AS material_id,
            CAST(json_extract(value, '$.sourceLocationId') AS TEXT) AS source_location_id,
            CAST(json_extract(value, '$.condition') AS TEXT) AS condition,
            CAST(json_extract(value, '$.deltaQuantity') AS INTEGER) AS reserve_quantity,
            CAST(json_extract(value, '$.expectedAvailableQuantity') AS INTEGER) AS expected_quantity,
            CAST(key AS INTEGER) AS sort_order
          FROM json_each(?)
        ), active_reservations AS (
          SELECT material_id, source_location_id, condition,
                 SUM(reserved_quantity-issued_quantity-released_quantity) AS quantity
          FROM material_request_reservations
          WHERE reserved_quantity>issued_quantity+released_quantity
          GROUP BY material_id, source_location_id, condition
        )
        SELECT requested.*, m.id AS active_material_id,
               source.id AS active_source_id,
               COALESCE(h.quantity, 0) AS physical_quantity,
               COALESCE(active_reservations.quantity, 0) AS reserved_quantity,
               pickup.id AS pickup_id, pickup.name AS pickup_name
        FROM requested
        LEFT JOIN materials m ON m.id=requested.material_id
          AND m.status='active' AND m.archived_at IS NULL
        LEFT JOIN locations source ON source.id=requested.source_location_id
          AND source.status='active' AND source.type!='service'
        LEFT JOIN holdings h ON h.material_id=requested.material_id
          AND h.location_id=requested.source_location_id
          AND h.condition=requested.condition
        LEFT JOIN active_reservations ON active_reservations.material_id=requested.material_id
          AND active_reservations.source_location_id=requested.source_location_id
          AND active_reservations.condition=requested.condition
        LEFT JOIN locations pickup ON pickup.id=?
          AND pickup.status='active' AND pickup.is_public=1
        ORDER BY requested.sort_order
      `).bind(JSON.stringify(deltas), input.pickupLocationId).all<{
        item_id: string;
        material_id: string;
        source_location_id: string;
        condition: string;
        reserve_quantity: number;
        expected_quantity: number;
        active_material_id: string | null;
        active_source_id: string | null;
        physical_quantity: number;
        reserved_quantity: number;
        pickup_id: string | null;
        pickup_name: string | null;
      }>()
    : { results: [] };
  const pickup = await db.prepare(`
    SELECT id, name FROM locations
    WHERE id=? AND status='active' AND is_public=1 LIMIT 1
  `).bind(input.pickupLocationId).first<{ id: string; name: string }>();
  if (!pickup) {
    throw new TeacherMaterialRequestError(
      "pickup_location_not_found",
      404,
      "Оберіть активне публічне місце отримання.",
    );
  }
  const states = availability.results ?? [];
  if (states.length !== deltas.length) {
    throw new TeacherMaterialRequestError("request_items_mismatch", 409, "Не вдалося перевірити всі позиції заявки.");
  }
  for (const state of states) {
    if (!state.active_material_id || !state.active_source_id) {
      throw new TeacherMaterialRequestError(
        "fulfillment_source_not_found",
        404,
        "Матеріал або місце зберігання більше недоступні.",
        { materialId: state.material_id },
      );
    }
    const effective = Math.max(
      0,
      Number(state.physical_quantity) - Number(state.reserved_quantity),
    );
    if (effective !== Number(state.expected_quantity)) {
      throw new TeacherMaterialRequestError(
        "reservation_stock_conflict",
        409,
        "Доступна кількість змінилася. Оновіть заявку.",
        { materialId: state.material_id, currentQuantity: effective },
      );
    }
    if (Number(state.reserve_quantity) > effective) {
      throw new TeacherMaterialRequestError(
        "insufficient_stock",
        409,
        "У вибраному місці недостатньо вільних примірників.",
        { materialId: state.material_id, currentQuantity: effective },
      );
    }
  }

  const now = new Date().toISOString();
  const reservationRows = states.map((state) => ({
    id: `MRR-${crypto.randomUUID()}`,
    itemId: state.item_id,
    materialId: state.material_id,
    sourceLocationId: state.source_location_id,
    condition: state.condition,
    quantity: Number(state.reserve_quantity),
    expectedAvailableQuantity: Number(state.expected_quantity),
  }));
  const targetByItem = new Map(targets.map((item) => [item.itemId, item.approvedQuantity]));
  const itemApprovals = current.items.map((item) => ({
    itemId: item.id,
    approvedQuantity: targetByItem.get(item.id) ?? item.approvedQuantity,
  }));
  const status: "ready" | "partially_ready" = itemApprovals.every((item) =>
    item.approvedQuantity === currentByItem.get(item.itemId)?.requestedQuantity
  ) ? "ready" : "partially_ready";
  const result = {
    requestId: current.id,
    status,
    version: current.version + 1,
    updatedAt: now,
    readyAt: current.readyAt ?? now,
    dueAt: input.dueAt,
    pickupLocationId: pickup.id,
    pickupLocationName: pickup.name,
    reserved: reservationRows.map((row) => ({
      reservationId: row.id,
      itemId: row.itemId,
      materialId: row.materialId,
      quantity: row.quantity,
    })),
  };
  const eventId = `MRE-${crypto.randomUUID()}`;
  const notificationId = `NTF-${crypto.randomUUID()}`;
  const statements: D1Statement[] = [
    insertCommandStatement(
      db,
      input.requestId,
      requestHash,
      actor.id,
      "material_request.ready",
      "material_request",
      current.id,
      now,
    ),
  ];
  for (const reservation of reservationRows) {
    statements.push(db.prepare(`
      INSERT INTO material_request_reservations (
        id, request_id, request_item_id, material_id, source_location_id,
        condition, reserved_quantity, issued_quantity, released_quantity,
        created_at, updated_at
      )
      SELECT ?, mr.id, item.id, item.material_id, holding.location_id,
             holding.condition, ?, 0, 0, ?, ?
      FROM material_requests mr
      JOIN material_request_items item ON item.request_id=mr.id AND item.id=?
        AND item.material_id=?
      JOIN holdings holding ON holding.material_id=item.material_id
        AND holding.location_id=? AND holding.condition=?
      JOIN locations source ON source.id=holding.location_id
        AND source.status='active' AND source.type!='service'
      WHERE mr.id=? AND mr.version=?
        AND mr.status IN ('submitted','in_review','ready','partially_ready')
        AND holding.quantity-COALESCE((
          SELECT SUM(active.reserved_quantity-active.issued_quantity-active.released_quantity)
          FROM material_request_reservations active
          WHERE active.material_id=holding.material_id
            AND active.source_location_id=holding.location_id
            AND active.condition=holding.condition
            AND active.reserved_quantity>active.issued_quantity+active.released_quantity
        ), 0)=?
    `).bind(
      reservation.id,
      reservation.quantity,
      now,
      now,
      reservation.itemId,
      reservation.materialId,
      reservation.sourceLocationId,
      reservation.condition,
      current.id,
      current.version,
      reservation.expectedAvailableQuantity,
    ));
  }
  statements.push(
    db.prepare(`
      WITH updates AS (
        SELECT CAST(json_extract(value, '$.itemId') AS TEXT) AS item_id,
               CAST(json_extract(value, '$.approvedQuantity') AS INTEGER) AS approved_quantity
        FROM json_each(?)
      )
      UPDATE material_request_items AS item
      SET approved_quantity=(SELECT approved_quantity FROM updates WHERE item_id=item.id),
          updated_at=?
      WHERE item.request_id=? AND EXISTS (SELECT 1 FROM updates WHERE item_id=item.id)
    `).bind(JSON.stringify(itemApprovals), now, current.id),
    db.prepare(`
      UPDATE material_requests
      SET status=?, librarian_note='', rejection_reason='', pickup_location_id=?,
          due_at=?, reviewed_by_user_id=?, ready_at=COALESCE(ready_at, ?),
          version=version+1, updated_at=?
      WHERE id=? AND version=?
        AND status IN ('submitted','in_review','ready','partially_ready')
        AND (SELECT COUNT(*) FROM material_request_items WHERE request_id=?)=?
        AND (SELECT COUNT(*) FROM material_request_reservations
             WHERE id IN (SELECT CAST(value AS TEXT) FROM json_each(?)))=?
    `).bind(
      status,
      input.pickupLocationId,
      input.dueAt,
      actor.id,
      now,
      now,
      current.id,
      current.version,
      current.id,
      current.items.length,
      JSON.stringify(reservationRows.map((row) => row.id)),
      reservationRows.length,
    ),
    db.prepare(`
      INSERT INTO material_request_events (
        id, request_id, actor_user_id, actor_kind, kind,
        from_status, to_status, metadata_json, created_at
      ) VALUES (?, (
        SELECT id FROM material_requests
        WHERE id=? AND status=? AND version=? AND updated_at=?
      ), ?, 'librarian', 'ready', ?, ?, ?, ?)
    `).bind(
      eventId,
      current.id,
      status,
      current.version + 1,
      now,
      actor.id,
      current.status,
      status,
      JSON.stringify({
        pickupLocationId: input.pickupLocationId,
        dueAt: input.dueAt,
        reservations: result.reserved,
      }),
      now,
    ),
    db.prepare(`
      INSERT INTO portal_notifications (
        id, teacher_user_id, dedupe_key, type, title, message,
        entity_type, entity_id, read_at, version, created_at, updated_at
      )
      SELECT ?, mr.teacher_user_id, ?, 'material_request_ready',
             'Замовлення підготовлено', ?, 'material_request', mr.id,
             NULL, 1, ?, ?
      FROM material_requests mr
      WHERE mr.id=? AND EXISTS (
        SELECT 1 FROM material_request_events WHERE id=? AND request_id=mr.id
      )
    `).bind(
      notificationId,
      `material-request:${current.id}:ready:${input.requestId}`,
      `Замовлення зарезервовано. Місце отримання: ${pickup.name}.`,
      now,
      now,
      current.id,
      eventId,
    ),
    queueTelegramFromPortalNotificationStatement(
      db,
      notificationId,
      "orders",
      "/teacher?tab=notifications",
      now,
    ),
  );
  if (reservationRows.length) {
    statements.push(rebuildStockTotalsBulkStatement(
      db,
      [...new Set(reservationRows.map((row) => row.materialId))],
      now,
    ));
  }
  statements.push(
    requestAuditStatement(
      db,
      actor,
      input.requestId,
      current,
      result,
      eventId,
      { status, version: current.version + 1, updatedAt: now },
      now,
    ),
    completeCommandStatement(db, input.requestId, result, now),
  );
  if (statements.length > 50) {
    throw new TeacherMaterialRequestError("request_too_large", 400, "У заявці забагато позицій.");
  }
  const replayed = await executeIdempotentBatch<typeof result>(
    db,
    statements,
    input.requestId,
    actor.id,
    requestHash,
    "reservation_stock_conflict",
    "Залишок або заявка змінилися. Оновіть чергу.",
  );
  return replayed ?? result;
}

async function issueMaterialRequest(
  db: TeacherMaterialRequestDatabase,
  actor: MutationActor,
  current: MaterialRequestProjection,
  input: MaterialRequestIssueInput,
  requestHash: string,
): Promise<Record<string, unknown>> {
  if (current.status !== "ready" && current.status !== "partially_ready") {
    throw new TeacherMaterialRequestError(
      "invalid_request_transition",
      409,
      "Видати можна лише підготовлене замовлення.",
      { status: current.status },
    );
  }
  if (input.issuedAt > kyivToday()) {
    throw new TeacherMaterialRequestError(
      "invalid_issue_date",
      400,
      "Дата фактичної видачі не може бути в майбутньому.",
    );
  }
  if (input.dueAt && input.dueAt < input.issuedAt) {
    throw new TeacherMaterialRequestError(
      "invalid_due_date",
      400,
      "Дата повернення не може передувати даті видачі.",
    );
  }
  const reservationIndex = new Map<string, {
    item: MaterialRequestItemProjection;
    reservation: MaterialRequestReservationProjection;
  }>();
  for (const item of current.items) {
    for (const reservation of item.reservations) {
      reservationIndex.set(reservation.id, { item, reservation });
    }
  }
  const issueRows = input.items.map((entry) => {
    const indexed = reservationIndex.get(entry.reservationId);
    if (!indexed) {
      throw new TeacherMaterialRequestError(
        "reservation_not_found",
        404,
        "Резерв не знайдено у цій заявці.",
        { reservationId: entry.reservationId },
      );
    }
    if (entry.quantity > indexed.reservation.remainingQuantity) {
      throw new TeacherMaterialRequestError(
        "reservation_quantity_exceeded",
        409,
        "Кількість видачі перевищує активний резерв.",
        { reservationId: entry.reservationId, remainingQuantity: indexed.reservation.remainingQuantity },
      );
    }
    return {
      reservationId: entry.reservationId,
      requestItemId: indexed.item.id,
      materialId: indexed.item.materialId,
      sourceLocationId: indexed.reservation.sourceLocationId,
      condition: indexed.reservation.condition,
      quantity: entry.quantity,
      reservedBefore: indexed.reservation.reservedQuantity,
      issuedBefore: indexed.reservation.issuedQuantity,
      releasedBefore: indexed.reservation.releasedQuantity,
      issuedAfter: indexed.reservation.issuedQuantity + entry.quantity,
      loanItemId: `LI-${crypto.randomUUID()}`,
      lineId: `LINE-${crypto.randomUUID()}`,
    };
  });
  if (!issueRows.length) {
    throw new TeacherMaterialRequestError("nothing_to_issue", 409, "Немає примірників для видачі.");
  }

  const holdingResponse = await db.prepare(`
    WITH requested AS (
      SELECT DISTINCT
        CAST(json_extract(value, '$.materialId') AS TEXT) AS material_id,
        CAST(json_extract(value, '$.sourceLocationId') AS TEXT) AS location_id,
        CAST(json_extract(value, '$.condition') AS TEXT) AS condition
      FROM json_each(?)
    )
    SELECT requested.material_id, requested.location_id, requested.condition,
           h.quantity, h.version
    FROM requested
    LEFT JOIN holdings h ON h.material_id=requested.material_id
      AND h.location_id=requested.location_id AND h.condition=requested.condition
  `).bind(JSON.stringify(issueRows)).all<{
    material_id: string;
    location_id: string;
    condition: string;
    quantity: number | null;
    version: number | null;
  }>();
  const holdingGroups = new Map<string, {
    materialId: string;
    locationId: string;
    condition: string;
    quantity: number;
    version: number;
  }>();
  for (const row of holdingResponse.results ?? []) {
    holdingGroups.set(stockKey(row.material_id, row.location_id, row.condition), {
      materialId: row.material_id,
      locationId: row.location_id,
      condition: row.condition,
      quantity: Number(row.quantity ?? 0),
      version: Number(row.version ?? 0),
    });
  }
  const workingGroups = new Map([...holdingGroups].map(([key, value]) => [key, { ...value }]));
  for (const row of issueRows) {
    const group = workingGroups.get(stockKey(row.materialId, row.sourceLocationId, row.condition));
    if (!group || group.version < 1 || group.quantity < row.quantity) {
      throw new TeacherMaterialRequestError(
        "reservation_stock_conflict",
        409,
        "Фізичний залишок підготовлених примірників змінився.",
        { materialId: row.materialId },
      );
    }
    Object.assign(row, {
      quantityBefore: group.quantity,
      versionBefore: group.version,
      quantityAfter: group.quantity - row.quantity,
      versionAfter: group.version + 1,
    });
    group.quantity -= row.quantity;
    group.version += 1;
  }

  const existingLoan = current.resultingLoanId
    ? await db.prepare(`
        SELECT id, teacher_user_id, status, version, issued_at, due_at
        FROM loans WHERE id=? LIMIT 1
      `).bind(current.resultingLoanId).first<{
        id: string;
        teacher_user_id: string;
        status: string;
        version: number;
        issued_at: string;
        due_at: string | null;
      }>()
    : null;
  if (current.resultingLoanId && (
    !existingLoan
    || existingLoan.teacher_user_id !== current.teacherUserId
    || existingLoan.status !== "open"
  )) {
    throw new TeacherMaterialRequestError(
      "request_loan_closed",
      409,
      "Пов’язану видачу вже закрито. Залишок резерву можна лише звільнити.",
    );
  }

  const now = new Date().toISOString();
  const loanId = existingLoan?.id ?? `LOAN-${crypto.randomUUID()}`;
  const transactionId = `TX-${crypto.randomUUID()}`;
  const issuedByItem = new Map<string, number>();
  for (const row of issueRows) {
    issuedByItem.set(row.requestItemId, (issuedByItem.get(row.requestItemId) ?? 0) + row.quantity);
  }
  const totalActiveBefore = current.items.flatMap((item) => item.reservations)
    .reduce((sum, reservation) => sum + reservation.remainingQuantity, 0);
  const issuedNow = issueRows.reduce((sum, row) => sum + row.quantity, 0);
  const activeAfter = totalActiveBefore - issuedNow;
  const status: MaterialRequestStatus = activeAfter === 0
    ? "completed"
    : current.items.every((item) => item.approvedQuantity === item.requestedQuantity)
      ? "ready"
      : "partially_ready";
  const result = {
    requestId: current.id,
    status,
    version: current.version + 1,
    updatedAt: now,
    completedAt: status === "completed" ? now : null,
    resultingLoanId: loanId,
    loan: {
      loanId,
      status: "open",
      teacherUserId: current.teacherUserId,
      issuedAt: existingLoan?.issued_at ?? input.issuedAt,
      dueAt: input.dueAt,
      transactionId,
      items: issueRows.map((row) => ({
        loanItemId: row.loanItemId,
        reservationId: row.reservationId,
        materialId: row.materialId,
        quantityIssued: row.quantity,
        quantityReturned: 0,
      })),
    },
  };
  const eventId = `MRE-${crypto.randomUUID()}`;
  const notificationId = `NTF-${crypto.randomUUID()}`;
  const statements: D1Statement[] = [
    insertCommandStatement(
      db,
      input.requestId,
      requestHash,
      actor.id,
      "material_request.issue",
      "material_request",
      current.id,
      now,
    ),
    db.prepare(`
      WITH updates AS (
        SELECT
          CAST(json_extract(value, '$.reservationId') AS TEXT) AS reservation_id,
          CAST(json_extract(value, '$.reservedBefore') AS INTEGER) AS reserved_before,
          CAST(json_extract(value, '$.issuedBefore') AS INTEGER) AS issued_before,
          CAST(json_extract(value, '$.releasedBefore') AS INTEGER) AS released_before,
          CAST(json_extract(value, '$.issuedAfter') AS INTEGER) AS issued_after
        FROM json_each(?)
      )
      UPDATE material_request_reservations AS reservation
      SET issued_quantity=(SELECT issued_after FROM updates WHERE reservation_id=reservation.id),
          updated_at=?
      WHERE reservation.request_id=? AND EXISTS (
        SELECT 1 FROM updates
        WHERE reservation_id=reservation.id
          AND reserved_before=reservation.reserved_quantity
          AND issued_before=reservation.issued_quantity
          AND released_before=reservation.released_quantity
          AND issued_after<=reservation.reserved_quantity-reservation.released_quantity
      )
    `).bind(JSON.stringify(issueRows), now, current.id),
    db.prepare(`
      WITH updates AS (
        SELECT CAST(json_extract(value, '$.requestItemId') AS TEXT) AS item_id,
               SUM(CAST(json_extract(value, '$.quantity') AS INTEGER)) AS quantity
        FROM json_each(?) GROUP BY item_id
      )
      UPDATE material_request_items AS item
      SET fulfilled_quantity=fulfilled_quantity+(
            SELECT quantity FROM updates WHERE item_id=item.id
          ), updated_at=?
      WHERE item.request_id=? AND EXISTS (
        SELECT 1 FROM updates WHERE item_id=item.id
          AND item.fulfilled_quantity+quantity<=item.approved_quantity
      )
    `).bind(JSON.stringify(issueRows), now, current.id),
  ];
  if (existingLoan) {
    statements.push(db.prepare(`
      UPDATE loans
      SET due_at=?, version=version+1, updated_at=?
      WHERE id=? AND teacher_user_id=? AND status='open' AND version=?
        AND (SELECT COUNT(*) FROM material_request_reservations reservation
             JOIN json_each(?) supplied
               ON CAST(json_extract(supplied.value, '$.reservationId') AS TEXT)=reservation.id
             WHERE reservation.request_id=?
               AND reservation.issued_quantity=CAST(json_extract(supplied.value, '$.issuedAfter') AS INTEGER))=?
    `).bind(
      input.dueAt,
      now,
      loanId,
      current.teacherUserId,
      existingLoan.version,
      JSON.stringify(issueRows),
      current.id,
      issueRows.length,
    ));
  } else {
    statements.push(db.prepare(`
      INSERT INTO loans (
        id, teacher_user_id, status, issued_at, due_at, closed_at, notes,
        issued_by_user_id, closed_by_user_id, version, created_at, updated_at
      )
      SELECT ?, mr.teacher_user_id, 'open', ?, ?, NULL, '', ?, NULL, 1, ?, ?
      FROM material_requests mr
      WHERE mr.id=? AND mr.version=?
        AND (SELECT COUNT(*) FROM material_request_reservations reservation
             JOIN json_each(?) supplied
               ON CAST(json_extract(supplied.value, '$.reservationId') AS TEXT)=reservation.id
             WHERE reservation.request_id=mr.id
               AND reservation.issued_quantity=CAST(json_extract(supplied.value, '$.issuedAfter') AS INTEGER))=?
    `).bind(
      loanId,
      input.issuedAt,
      input.dueAt,
      actor.id,
      now,
      now,
      current.id,
      current.version,
      JSON.stringify(issueRows),
      issueRows.length,
    ));
  }
  statements.push(db.prepare(`
    INSERT INTO inventory_transactions (
      id, request_id, kind, occurred_at, document_number, reason, notes,
      loan_id, actor_user_id, reversal_of_id, status, created_at
    )
    SELECT ?, ?, 'loan_issue', ?, NULL, NULL, '', loan.id, ?, NULL, 'posted', ?
    FROM loans loan WHERE loan.id=? AND loan.status='open'
  `).bind(transactionId, input.requestId, input.issuedAt, actor.id, now, loanId));

  for (const row of issueRows) {
    const typedRow = row as typeof row & {
      quantityBefore: number;
      versionBefore: number;
      quantityAfter: number;
      versionAfter: number;
    };
    statements.push(
      db.prepare(`
        INSERT INTO loan_items (
          id, loan_id, material_id, source_location_id, condition,
          quantity_issued, quantity_returned, notes, created_at, updated_at
        )
        SELECT ?, ?, reservation.material_id, reservation.source_location_id,
               reservation.condition, ?, 0, '', ?, ?
        FROM material_request_reservations reservation
        WHERE reservation.id=? AND reservation.request_id=?
          AND reservation.issued_quantity=?
          AND EXISTS (SELECT 1 FROM loans WHERE id=? AND status='open')
      `).bind(
        row.loanItemId,
        loanId,
        row.quantity,
        now,
        now,
        row.reservationId,
        current.id,
        row.issuedAfter,
        loanId,
      ),
    );
    if (typedRow.quantityAfter === 0) {
      statements.push(db.prepare(`
        DELETE FROM holdings
        WHERE material_id=? AND location_id=? AND condition=?
          AND quantity=? AND version=?
      `).bind(
        row.materialId,
        row.sourceLocationId,
        row.condition,
        typedRow.quantityBefore,
        typedRow.versionBefore,
      ));
    } else {
      statements.push(db.prepare(`
        UPDATE holdings
        SET quantity=?, version=?, updated_at=?
        WHERE material_id=? AND location_id=? AND condition=?
          AND quantity=? AND version=?
      `).bind(
        typedRow.quantityAfter,
        typedRow.versionAfter,
        now,
        row.materialId,
        row.sourceLocationId,
        row.condition,
        typedRow.quantityBefore,
        typedRow.versionBefore,
      ));
    }
    statements.push(db.prepare(`
      INSERT INTO inventory_transaction_lines (
        id, transaction_id, material_id, location_id, condition,
        quantity_delta, quantity_before, quantity_after, counted_quantity,
        loan_item_id, created_at
      ) VALUES (?, ?, (
        SELECT item.material_id FROM loan_items item
        WHERE item.id=? AND item.loan_id=? AND item.quantity_issued=?
          AND EXISTS (
            SELECT 1 FROM material_request_reservations reservation
            WHERE reservation.id=? AND reservation.request_id=?
              AND reservation.issued_quantity=?
          )
          AND (
            (? > 0 AND EXISTS (
              SELECT 1 FROM holdings holding
              WHERE holding.material_id=item.material_id
                AND holding.location_id=item.source_location_id
                AND holding.condition=item.condition
                AND holding.quantity=? AND holding.version=?
            ))
            OR (? = 0 AND NOT EXISTS (
              SELECT 1 FROM holdings holding
              WHERE holding.material_id=item.material_id
                AND holding.location_id=item.source_location_id
                AND holding.condition=item.condition
            ))
          )
      ), ?, ?, ?, ?, ?, NULL, ?, ?)
    `).bind(
      row.lineId,
      transactionId,
      row.loanItemId,
      loanId,
      row.quantity,
      row.reservationId,
      current.id,
      row.issuedAfter,
      typedRow.quantityAfter,
      typedRow.quantityAfter,
      typedRow.versionAfter,
      typedRow.quantityAfter,
      row.sourceLocationId,
      row.condition,
      -row.quantity,
      typedRow.quantityBefore,
      typedRow.quantityAfter,
      row.loanItemId,
      now,
    ));
  }
  statements.push(
    db.prepare(`
      UPDATE material_requests
      SET status=?, resulting_loan_id=COALESCE(resulting_loan_id, ?), due_at=?,
          completed_at=?, version=version+1, updated_at=?
      WHERE id=? AND version=? AND status IN ('ready','partially_ready')
        AND (resulting_loan_id IS NULL OR resulting_loan_id=?)
        AND EXISTS (SELECT 1 FROM loans WHERE id=? AND teacher_user_id=material_requests.teacher_user_id)
        AND (SELECT COUNT(*) FROM material_request_reservations reservation
             JOIN json_each(?) supplied
               ON CAST(json_extract(supplied.value, '$.reservationId') AS TEXT)=reservation.id
             WHERE reservation.request_id=material_requests.id
               AND reservation.issued_quantity=CAST(json_extract(supplied.value, '$.issuedAfter') AS INTEGER))=?
    `).bind(
      status,
      loanId,
      input.dueAt,
      status === "completed" ? now : null,
      now,
      current.id,
      current.version,
      loanId,
      loanId,
      JSON.stringify(issueRows),
      issueRows.length,
    ),
    db.prepare(`
      INSERT INTO material_request_events (
        id, request_id, actor_user_id, actor_kind, kind,
        from_status, to_status, metadata_json, created_at
      ) VALUES (?, (
        SELECT id FROM material_requests
        WHERE id=? AND status=? AND version=? AND resulting_loan_id=? AND updated_at=?
      ), ?, 'librarian', 'issue', ?, ?, ?, ?)
    `).bind(
      eventId,
      current.id,
      status,
      current.version + 1,
      loanId,
      now,
      actor.id,
      current.status,
      status,
      JSON.stringify({ loanId, transactionId, issuedAt: input.issuedAt, dueAt: input.dueAt, items: input.items }),
      now,
    ),
    db.prepare(`
      INSERT INTO portal_notifications (
        id, teacher_user_id, dedupe_key, type, title, message,
        entity_type, entity_id, read_at, version, created_at, updated_at
      )
      SELECT ?, mr.teacher_user_id, ?, 'material_request_issued',
             'Матеріали видано', ?, 'material_request', mr.id,
             NULL, 1, ?, ?
      FROM material_requests mr
      WHERE mr.id=? AND EXISTS (
        SELECT 1 FROM material_request_events WHERE id=? AND request_id=mr.id
      )
    `).bind(
      notificationId,
      `material-request:${current.id}:issue:${input.requestId}`,
      `Видано ${issuedNow} примірн. Строк повернення: ${input.dueAt ?? "без визначеного строку"}.`,
      now,
      now,
      current.id,
      eventId,
    ),
    queueTelegramFromPortalNotificationStatement(
      db,
      notificationId,
      "orders",
      "/teacher?tab=notifications",
      now,
    ),
    rebuildStockTotalsBulkStatement(db, [...new Set(issueRows.map((row) => row.materialId))], now),
    requestAuditStatement(
      db,
      actor,
      input.requestId,
      current,
      result,
      eventId,
      { status, version: current.version + 1, updatedAt: now, resultingLoanId: loanId },
      now,
    ),
    db.prepare(`
      INSERT INTO audit_events (
        id, actor_user_id, actor_email, action, entity_type, entity_id,
        request_id, before_json, after_json, metadata_json, created_at
      ) VALUES (?, ?, ?, 'loan.issued', 'loan', (
        SELECT resulting_loan_id FROM material_requests
        WHERE id=? AND resulting_loan_id=? AND EXISTS (
          SELECT 1 FROM material_request_events WHERE id=? AND request_id=material_requests.id
        )
      ), ?, NULL, ?, ?, ?)
    `).bind(
      `AUD-${crypto.randomUUID()}`,
      actor.id,
      actor.email,
      current.id,
      loanId,
      eventId,
      input.requestId,
      JSON.stringify(result.loan),
      JSON.stringify({ transactionId, materialRequestId: current.id }),
      now,
    ),
    completeCommandStatement(db, input.requestId, result, now),
  );
  if (statements.length > 50) {
    throw new TeacherMaterialRequestError(
      "request_too_large",
      400,
      "У заявці забагато позицій для однієї безпечної видачі.",
    );
  }
  const replayed = await executeIdempotentBatch<typeof result>(
    db,
    statements,
    input.requestId,
    actor.id,
    requestHash,
    "request_version_conflict",
    "Заявка вже змінилася. Оновіть чергу.",
  );
  return replayed ?? result;
}

async function releaseMaterialRequest(
  db: TeacherMaterialRequestDatabase,
  actor: MutationActor,
  current: MaterialRequestProjection,
  input: MaterialRequestReleaseInput,
  requestHash: string,
): Promise<Record<string, unknown>> {
  if (current.status !== "ready" && current.status !== "partially_ready") {
    throw new TeacherMaterialRequestError(
      "invalid_request_transition",
      409,
      "Звільнити можна лише активний резерв.",
      { status: current.status },
    );
  }
  const reservationIndex = new Map<string, {
    item: MaterialRequestItemProjection;
    reservation: MaterialRequestReservationProjection;
  }>();
  for (const item of current.items) {
    for (const reservation of item.reservations) {
      reservationIndex.set(reservation.id, { item, reservation });
    }
  }
  const releaseRows = input.items.map((entry) => {
    const indexed = reservationIndex.get(entry.reservationId);
    if (!indexed) {
      throw new TeacherMaterialRequestError(
        "reservation_not_found",
        404,
        "Резерв не знайдено у цій заявці.",
        { reservationId: entry.reservationId },
      );
    }
    if (entry.quantity > indexed.reservation.remainingQuantity) {
      throw new TeacherMaterialRequestError(
        "reservation_quantity_exceeded",
        409,
        "Кількість звільнення перевищує активний резерв.",
        { reservationId: entry.reservationId, remainingQuantity: indexed.reservation.remainingQuantity },
      );
    }
    return {
      reservationId: entry.reservationId,
      requestItemId: indexed.item.id,
      materialId: indexed.item.materialId,
      quantity: entry.quantity,
      reservedBefore: indexed.reservation.reservedQuantity,
      issuedBefore: indexed.reservation.issuedQuantity,
      releasedBefore: indexed.reservation.releasedQuantity,
      releasedAfter: indexed.reservation.releasedQuantity + entry.quantity,
    };
  });
  if (!releaseRows.length) {
    throw new TeacherMaterialRequestError("nothing_to_release", 409, "Немає резерву для звільнення.");
  }
  const releasedByItem = new Map<string, number>();
  for (const row of releaseRows) {
    releasedByItem.set(row.requestItemId, (releasedByItem.get(row.requestItemId) ?? 0) + row.quantity);
  }
  const totalActiveBefore = current.items.flatMap((item) => item.reservations)
    .reduce((sum, reservation) => sum + reservation.remainingQuantity, 0);
  const releasedNow = releaseRows.reduce((sum, row) => sum + row.quantity, 0);
  const activeAfter = totalActiveBefore - releasedNow;
  const fulfilledTotal = current.items.reduce((sum, item) => sum + item.fulfilledQuantity, 0);
  const approvedAfter = current.items.map((item) => ({
    itemId: item.id,
    requestedQuantity: item.requestedQuantity,
    approvedQuantity: item.approvedQuantity - (releasedByItem.get(item.id) ?? 0),
  }));
  const status: MaterialRequestStatus = activeAfter === 0
    ? fulfilledTotal > 0 ? "completed" : "cancelled"
    : approvedAfter.every((item) => item.approvedQuantity === item.requestedQuantity)
      ? "ready"
      : "partially_ready";
  const now = new Date().toISOString();
  const result = {
    requestId: current.id,
    status,
    version: current.version + 1,
    updatedAt: now,
    releasedQuantity: releasedNow,
    releaseReason: input.reason,
    items: input.items,
  };
  const eventId = `MRE-${crypto.randomUUID()}`;
  const notificationId = `NTF-${crypto.randomUUID()}`;
  const statements: D1Statement[] = [
    insertCommandStatement(
      db,
      input.requestId,
      requestHash,
      actor.id,
      "material_request.release",
      "material_request",
      current.id,
      now,
    ),
    db.prepare(`
      WITH updates AS (
        SELECT
          CAST(json_extract(value, '$.reservationId') AS TEXT) AS reservation_id,
          CAST(json_extract(value, '$.reservedBefore') AS INTEGER) AS reserved_before,
          CAST(json_extract(value, '$.issuedBefore') AS INTEGER) AS issued_before,
          CAST(json_extract(value, '$.releasedBefore') AS INTEGER) AS released_before,
          CAST(json_extract(value, '$.releasedAfter') AS INTEGER) AS released_after
        FROM json_each(?)
      )
      UPDATE material_request_reservations AS reservation
      SET released_quantity=(SELECT released_after FROM updates WHERE reservation_id=reservation.id),
          updated_at=?
      WHERE reservation.request_id=? AND EXISTS (
        SELECT 1 FROM updates
        WHERE reservation_id=reservation.id
          AND reserved_before=reservation.reserved_quantity
          AND issued_before=reservation.issued_quantity
          AND released_before=reservation.released_quantity
          AND released_after<=reservation.reserved_quantity-reservation.issued_quantity
      )
    `).bind(JSON.stringify(releaseRows), now, current.id),
    db.prepare(`
      WITH updates AS (
        SELECT CAST(json_extract(value, '$.requestItemId') AS TEXT) AS item_id,
               SUM(CAST(json_extract(value, '$.quantity') AS INTEGER)) AS quantity
        FROM json_each(?) GROUP BY item_id
      )
      UPDATE material_request_items AS item
      SET approved_quantity=approved_quantity-(
            SELECT quantity FROM updates WHERE item_id=item.id
          ), updated_at=?
      WHERE item.request_id=? AND EXISTS (
        SELECT 1 FROM updates WHERE item_id=item.id
          AND item.approved_quantity-quantity>=item.fulfilled_quantity
      )
    `).bind(JSON.stringify(releaseRows), now, current.id),
    db.prepare(`
      UPDATE material_requests
      SET status=?, completed_at=?, cancelled_at=?, cancelled_by_user_id=?,
          librarian_note=?, version=version+1, updated_at=?
      WHERE id=? AND version=? AND status IN ('ready','partially_ready')
        AND (SELECT COUNT(*) FROM material_request_reservations reservation
             JOIN json_each(?) supplied
               ON CAST(json_extract(supplied.value, '$.reservationId') AS TEXT)=reservation.id
             WHERE reservation.request_id=material_requests.id
               AND reservation.released_quantity=CAST(json_extract(supplied.value, '$.releasedAfter') AS INTEGER))=?
    `).bind(
      status,
      status === "completed" ? now : null,
      status === "cancelled" ? now : null,
      status === "cancelled" ? actor.id : null,
      input.reason,
      now,
      current.id,
      current.version,
      JSON.stringify(releaseRows),
      releaseRows.length,
    ),
    db.prepare(`
      INSERT INTO material_request_events (
        id, request_id, actor_user_id, actor_kind, kind,
        from_status, to_status, metadata_json, created_at
      ) VALUES (?, (
        SELECT id FROM material_requests
        WHERE id=? AND status=? AND version=? AND updated_at=?
      ), ?, 'librarian', 'release', ?, ?, ?, ?)
    `).bind(
      eventId,
      current.id,
      status,
      current.version + 1,
      now,
      actor.id,
      current.status,
      status,
      JSON.stringify({ reason: input.reason, items: input.items }),
      now,
    ),
    db.prepare(`
      INSERT INTO portal_notifications (
        id, teacher_user_id, dedupe_key, type, title, message,
        entity_type, entity_id, read_at, version, created_at, updated_at
      )
      SELECT ?, mr.teacher_user_id, ?, 'material_request_released',
             'Резерв замовлення звільнено', ?, 'material_request', mr.id,
             NULL, 1, ?, ?
      FROM material_requests mr
      WHERE mr.id=? AND EXISTS (
        SELECT 1 FROM material_request_events WHERE id=? AND request_id=mr.id
      )
    `).bind(
      notificationId,
      `material-request:${current.id}:release:${input.requestId}`,
      `Звільнено ${releasedNow} зарезервованих примірн. Причина: ${input.reason}`,
      now,
      now,
      current.id,
      eventId,
    ),
    queueTelegramFromPortalNotificationStatement(
      db,
      notificationId,
      "orders",
      "/teacher?tab=notifications",
      now,
    ),
    rebuildStockTotalsBulkStatement(db, [...new Set(releaseRows.map((row) => row.materialId))], now),
    requestAuditStatement(
      db,
      actor,
      input.requestId,
      current,
      result,
      eventId,
      {
        status,
        version: current.version + 1,
        updatedAt: now,
        ...(current.resultingLoanId ? { resultingLoanId: current.resultingLoanId } : {}),
      },
      now,
    ),
    completeCommandStatement(db, input.requestId, result, now),
  ];
  const replayed = await executeIdempotentBatch<typeof result>(
    db,
    statements,
    input.requestId,
    actor.id,
    requestHash,
    "request_version_conflict",
    "Заявка вже змінилася. Оновіть чергу.",
  );
  return replayed ?? result;
}

function transitionNotification(
  input: Exclude<MaterialRequestActionInput, MaterialRequestReadyInput>,
  current: MaterialRequestProjection,
): { type: string; title: string; message: string } {
  if (input.action === "start_review") {
    return {
      type: "material_request_in_review",
      title: "Заявку взято в роботу",
      message: "Бібліотекар почав опрацьовувати ваше замовлення.",
    };
  }
  if (input.action === "reject") {
    return {
      type: "material_request_rejected",
      title: "Заявку відхилено",
      message: `Причина: ${input.reason}`,
    };
  }
  return {
    type: "material_request_completed",
    title: "Заявку завершено",
    message: current.resultingLoanId
      ? "Видачу за заявкою завершено."
      : "Заявку завершено бібліотекарем.",
  };
}

export async function getMaterialRequest(
  db: TeacherMaterialRequestDatabase,
  materialRequestId: string,
): Promise<MaterialRequestProjection | null> {
  const response = await db.prepare(`
    ${requestProjectionSql()}
    WHERE mr.id=?
    ORDER BY mri.sort_order, mri.id
  `).bind(materialRequestId).all<RequestRow>();
  return mapRequestRows(response.results ?? [])[0] ?? null;
}

function requestProjectionSql(): string {
  return `
    SELECT
      mr.id, mr.teacher_user_id, teacher.full_name AS teacher_name,
      mr.status, mr.teacher_notes, mr.librarian_note, mr.rejection_reason,
      mr.pickup_location_id, pickup.name AS pickup_location_name,
      mr.resulting_loan_id, mr.due_at, mr.version, mr.submitted_at, mr.ready_at,
      mr.completed_at, mr.rejected_at, mr.cancelled_at,
      mr.created_at, mr.updated_at,
      mri.id AS item_id, mri.material_id, mri.title_snapshot,
      mri.author_snapshot, mri.requested_quantity, mri.approved_quantity,
      mri.fulfilled_quantity, mri.sort_order, material.publication_year,
      cover.storage_provider AS cover_storage_provider,
      cover.storage_key AS cover_storage_key,
      cover.external_url AS cover_external_url,
      cover.sha256 AS cover_sha256,
      COALESCE((
        SELECT json_group_array(json_object(
          'id', reservation.id,
          'sourceLocationId', reservation.source_location_id,
          'sourceLocationName', source.name,
          'condition', reservation.condition,
          'reservedQuantity', reservation.reserved_quantity,
          'issuedQuantity', reservation.issued_quantity,
          'releasedQuantity', reservation.released_quantity,
          'createdAt', reservation.created_at,
          'updatedAt', reservation.updated_at
        ))
        FROM material_request_reservations reservation
        JOIN locations source ON source.id=reservation.source_location_id
        WHERE reservation.request_item_id=mri.id
      ), '[]') AS reservations_json
    FROM material_requests mr
    JOIN users teacher ON teacher.id=mr.teacher_user_id
    JOIN material_request_items mri ON mri.request_id=mr.id
    JOIN materials material ON material.id=mri.material_id
    LEFT JOIN locations pickup ON pickup.id=mr.pickup_location_id
    LEFT JOIN material_cover_assets cover
      ON cover.material_id=mri.material_id AND cover.status='ready'
  `;
}

function mapRequestRows(rows: RequestRow[]): MaterialRequestProjection[] {
  const requests = new Map<string, MaterialRequestProjection>();
  for (const row of rows) {
    let request = requests.get(row.id);
    if (!request) {
      request = {
        id: row.id,
        teacherUserId: row.teacher_user_id,
        teacherName: row.teacher_name,
        teacher: { id: row.teacher_user_id, fullName: row.teacher_name },
        status: row.status,
        teacherNotes: String(row.teacher_notes ?? ""),
        librarianNote: emptyToNull(row.librarian_note),
        rejectionReason: emptyToNull(row.rejection_reason),
        pickupLocationId: row.pickup_location_id,
        pickupLocationName: row.pickup_location_name,
        pickupLocation: row.pickup_location_id && row.pickup_location_name
          ? { id: row.pickup_location_id, name: row.pickup_location_name }
          : null,
        resultingLoanId: row.resulting_loan_id,
        dueAt: row.due_at,
        version: Number(row.version),
        submittedAt: row.submitted_at,
        readyAt: row.ready_at,
        completedAt: row.completed_at,
        rejectedAt: row.rejected_at,
        cancelledAt: row.cancelled_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        items: [],
      };
      requests.set(row.id, request);
    }
    const reservations = parseReservationRows(row.reservations_json);
    request.items.push({
      id: row.item_id,
      materialId: row.material_id,
      title: row.title_snapshot,
      author: row.author_snapshot,
      material: {
        id: row.material_id,
        title: row.title_snapshot,
        author: row.author_snapshot,
        year: nullableYear(row.publication_year),
        thumbnailUrl: requestCoverUrl(row),
      },
      requestedQuantity: Number(row.requested_quantity),
      approvedQuantity: row.approved_quantity === null ? 0 : Number(row.approved_quantity),
      fulfilledQuantity: Number(row.fulfilled_quantity),
      reservedQuantity: reservations.reduce((total, reservation) => total + reservation.remainingQuantity, 0),
      sortOrder: Number(row.sort_order),
      reservations,
    });
  }
  return [...requests.values()];
}

function parseReservationRows(value: string): MaterialRequestReservationProjection[] {
  try {
    const rows = JSON.parse(value) as Array<Record<string, unknown>>;
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => {
      const reservedQuantity = Math.max(0, Number(row.reservedQuantity) || 0);
      const issuedQuantity = Math.max(0, Number(row.issuedQuantity) || 0);
      const releasedQuantity = Math.max(0, Number(row.releasedQuantity) || 0);
      return {
        id: String(row.id ?? ""),
        sourceLocationId: String(row.sourceLocationId ?? ""),
        sourceLocationName: String(row.sourceLocationName ?? ""),
        condition: String(row.condition ?? "unspecified"),
        reservedQuantity,
        issuedQuantity,
        releasedQuantity,
        remainingQuantity: Math.max(0, reservedQuantity - issuedQuantity - releasedQuantity),
        createdAt: String(row.createdAt ?? ""),
        updatedAt: String(row.updatedAt ?? ""),
      };
    }).filter((row) => row.id);
  } catch {
    return [];
  }
}

function requestAuditStatement(
  db: TeacherMaterialRequestDatabase,
  actor: MutationActor,
  commandId: string,
  before: MaterialRequestProjection,
  after: unknown,
  eventId: string,
  marker: {
    status: MaterialRequestStatus;
    version: number;
    updatedAt: string;
    resultingLoanId?: string;
  },
  createdAt: string,
): D1Statement {
  return db.prepare(`
    INSERT INTO audit_events (
      id, actor_user_id, actor_email, action, entity_type, entity_id,
      request_id, before_json, after_json, metadata_json, created_at
    ) VALUES (?, ?, ?, 'material_request.updated', 'material_request', (
      SELECT mr.id
      FROM material_request_events event
      JOIN material_requests mr ON mr.id=event.request_id
      WHERE event.id=? AND mr.status=? AND mr.version=? AND mr.updated_at=?
        AND (? IS NULL OR mr.resulting_loan_id=?)
    ), ?, ?, ?, ?, ?)
  `).bind(
    `AUD-${crypto.randomUUID()}`,
    actor.id,
    actor.email,
    eventId,
    marker.status,
    marker.version,
    marker.updatedAt,
    marker.resultingLoanId ?? null,
    marker.resultingLoanId ?? null,
    commandId,
    JSON.stringify({ status: before.status, version: before.version }),
    JSON.stringify(after),
    JSON.stringify({ eventId }),
    createdAt,
  );
}

function rebuildStockTotalsBulkStatement(
  db: TeacherMaterialRequestDatabase,
  materialIds: string[],
  updatedAt: string,
): D1Statement {
  return db.prepare(`
    WITH requested AS (
      SELECT DISTINCT CAST(value AS TEXT) AS material_id FROM json_each(?)
    )
    INSERT INTO material_stock_totals (
      material_id, total_quantity, library_quantity,
      other_location_quantity, loaned_quantity, reserved_quantity, updated_at
    )
    SELECT
      m.id,
      COALESCE(SUM(h.quantity), 0) + COALESCE(outstanding.quantity, 0),
      COALESCE(SUM(CASE WHEN l.type='library' THEN h.quantity ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN l.type!='library' THEN h.quantity ELSE 0 END), 0),
      COALESCE(outstanding.quantity, 0),
      COALESCE(reservations.quantity, 0), ?
    FROM requested
    JOIN materials m ON m.id=requested.material_id
    LEFT JOIN holdings h ON h.material_id=m.id
    LEFT JOIN locations l ON l.id=h.location_id
    LEFT JOIN (
      SELECT material_id, SUM(quantity) AS quantity
      FROM (
        SELECT li.material_id, li.quantity_issued-li.quantity_returned AS quantity
        FROM loan_items li JOIN loans lo ON lo.id=li.loan_id
        WHERE lo.status!='cancelled' AND li.quantity_issued>li.quantity_returned
        UNION ALL
        SELECT cli.material_id, cli.quantity_issued-cli.quantity_returned AS quantity
        FROM class_loan_items cli JOIN class_loans clo ON clo.id=cli.class_loan_id
        WHERE clo.status!='cancelled' AND cli.quantity_issued>cli.quantity_returned
      ) outstanding_rows GROUP BY material_id
    ) outstanding ON outstanding.material_id=m.id
    LEFT JOIN (
      SELECT material_id,
             SUM(reserved_quantity-issued_quantity-released_quantity) AS quantity
      FROM material_request_reservations
      WHERE reserved_quantity>issued_quantity+released_quantity
      GROUP BY material_id
    ) reservations ON reservations.material_id=m.id
    GROUP BY m.id, outstanding.quantity, reservations.quantity
    ON CONFLICT(material_id) DO UPDATE SET
      total_quantity=excluded.total_quantity,
      library_quantity=excluded.library_quantity,
      other_location_quantity=excluded.other_location_quantity,
      loaned_quantity=excluded.loaned_quantity,
      reserved_quantity=excluded.reserved_quantity,
      updated_at=excluded.updated_at
  `).bind(JSON.stringify(materialIds), updatedAt);
}

async function resolveLibrarianActor(
  db: TeacherMaterialRequestDatabase,
  user: ChatGPTUser,
): Promise<MutationActor> {
  const response = await db.prepare(`
    SELECT id
    FROM users
    WHERE status='active' AND role IN ('admin','librarian')
      AND ((? IS NOT NULL AND id=?)
        OR (? IS NULL AND (auth_user_id=? OR lower(email)=lower(?))))
    ORDER BY id
    LIMIT 2
  `).bind(user.d1UserId ?? null, user.d1UserId ?? null, user.d1UserId ?? null, user.userId, user.email).all<{ id: string }>();
  const rows = response.results ?? [];
  if (rows.length !== 1) {
    throw new TeacherMaterialRequestError(
      "actor_not_mapped",
      403,
      rows.length > 1
        ? "Обліковий запис бібліотекаря налаштовано неоднозначно."
        : "Обліковий запис не прив’язано до активного бібліотекаря.",
    );
  }
  return { id: rows[0].id, email: user.email.toLowerCase() };
}

function insertCommandStatement(
  db: TeacherMaterialRequestDatabase,
  id: string,
  requestHash: string,
  actorUserId: string,
  kind: string,
  targetType: string,
  targetId: string,
  createdAt: string,
): D1Statement {
  const requiresLibrarianRole = new Set([
    "material_request.start_review",
    "material_request.reject",
    "material_request.complete",
    "material_request.ready",
    "material_request.issue",
    "material_request.release",
  ]).has(kind);
  return db.prepare(`
    INSERT INTO mutation_commands (
      id, draft_id, kind, actor_user_id, status, target_type, target_id,
      request_hash, result_json, error_code, error_message,
      created_at, updated_at, completed_at
    ) VALUES (?, NULL, ?, (
      SELECT id FROM users WHERE id=? AND status='active'
        ${requiresLibrarianRole ? "AND role IN ('admin','librarian')" : ""}
    ), 'processing', ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL)
  `).bind(
    id,
    kind,
    actorUserId,
    targetType,
    targetId,
    requestHash,
    createdAt,
    createdAt,
  );
}

function completeCommandStatement(
  db: TeacherMaterialRequestDatabase,
  id: string,
  result: unknown,
  completedAt: string,
): D1Statement {
  return db.prepare(`
    UPDATE mutation_commands
    SET status='completed', result_json=?, updated_at=?, completed_at=?
    WHERE id=? AND status='processing'
      AND EXISTS (
        SELECT 1 FROM audit_events
        WHERE request_id=mutation_commands.id
          AND entity_type=mutation_commands.target_type
          AND entity_id=mutation_commands.target_id
      )
  `).bind(JSON.stringify(result), completedAt, completedAt, id);
}

async function executeIdempotentBatch<T>(
  db: TeacherMaterialRequestDatabase,
  statements: D1Statement[],
  requestId: string,
  actorUserId: string,
  requestHash: string,
  conflictCode: string,
  conflictMessage: string,
): Promise<T | null> {
  try {
    await db.batch(statements);
    return null;
  } catch (error) {
    const replay = await replayCompletedCommand<T>(
      db,
      requestId,
      actorUserId,
      requestHash,
    );
    if (replay) return replay;
    const errorMessage = error instanceof Error ? error.message : String(error ?? "");
    if (errorMessage.includes("NOT NULL constraint failed: mutation_commands.actor_user_id")) {
      throw new TeacherMaterialRequestError(
        "actor_access_revoked",
        403,
        "Доступ бібліотекаря було вимкнено. Увійдіть знову.",
      );
    }
    if (
      errorMessage.includes("reservation_stock_conflict")
      || errorMessage.includes("reserved_stock_conflict")
    ) {
      throw new TeacherMaterialRequestError(
        "reservation_stock_conflict",
        409,
        "Доступна кількість або резерв змінилися. Оновіть чергу.",
      );
    }
    if (isExpectedConflict(error)) {
      throw new TeacherMaterialRequestError(conflictCode, 409, conflictMessage);
    }
    throw error;
  }
}

async function replayCompletedCommand<T>(
  db: TeacherMaterialRequestDatabase,
  requestId: string,
  actorUserId: string,
  requestHash: string,
): Promise<T | null> {
  const command = await db.prepare(`
    SELECT actor_user_id, status, request_hash, result_json,
           error_code, error_message
    FROM mutation_commands WHERE id=? LIMIT 1
  `).bind(requestId).first<StoredCommand>();
  if (!command) return null;
  if (command.actor_user_id !== actorUserId || command.request_hash !== requestHash) {
    throw new TeacherMaterialRequestError(
      "request_id_conflict",
      409,
      "Цей request ID уже використано для іншої операції.",
    );
  }
  if (command.status === "processing") {
    throw new TeacherMaterialRequestError(
      "mutation_in_progress",
      409,
      "Операція ще виконується. Оновіть результат за кілька секунд.",
    );
  }
  if (command.status === "failed") {
    throw new TeacherMaterialRequestError(
      command.error_code || "mutation_failed",
      409,
      command.error_message || "Операцію не виконано.",
    );
  }
  if (command.status !== "completed" || !command.result_json) {
    throw new TeacherMaterialRequestError(
      "mutation_result_invalid",
      503,
      "Збережений результат операції пошкоджено.",
    );
  }
  try {
    return JSON.parse(command.result_json) as T;
  } catch {
    throw new TeacherMaterialRequestError(
      "mutation_result_invalid",
      503,
      "Збережений результат операції пошкоджено.",
    );
  }
}

function isExpectedConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("UNIQUE constraint failed: mutation_commands.id")
    || message.includes("UNIQUE constraint failed: portal_notifications.dedupe_key")
    || message.includes("NOT NULL constraint failed: material_request_events.request_id")
    || message.includes("NOT NULL constraint failed: audit_events.entity_id")
    || message.includes("NOT NULL constraint failed: inventory_transaction_lines.material_id")
    || message.includes("NOT NULL constraint failed: loan_items.material_id")
    || message.includes("NOT NULL constraint failed: loan_items.source_location_id")
    || message.includes("NOT NULL constraint failed: mutation_commands.actor_user_id")
    || message.includes("reserved_stock_conflict")
    || message.includes("reservation_stock_conflict")
    || message.includes("FOREIGN KEY constraint failed");
}

function stockKey(materialId: string, locationId: string, condition: string): string {
  return `${materialId}\u0000${locationId}\u0000${condition}`;
}

async function countActiveMaterialRequests(
  db: TeacherMaterialRequestDatabase,
  teacherUserId: string,
): Promise<number> {
  const row = await db.prepare(`
    SELECT COUNT(*) AS active_count
    FROM material_requests
    WHERE teacher_user_id=?
      AND status IN ('submitted','in_review','ready','partially_ready')
  `).bind(teacherUserId).first<{ active_count: number }>();
  return Math.max(0, Number(row?.active_count) || 0);
}

async function requireActiveTeacherPrincipal(
  db: TeacherMaterialRequestDatabase,
  teacher: VisitTeacherIdentity,
  now: string,
): Promise<void> {
  const active = await db.prepare(`
    SELECT teacher_user.id
    FROM users teacher_user
    JOIN teacher_profiles profile
      ON profile.teacher_user_id=teacher_user.id AND profile.closed_at IS NULL
    JOIN visit_teacher_credentials credential
      ON credential.teacher_user_id=teacher_user.id
    JOIN visit_teacher_sessions session
      ON session.teacher_user_id=teacher_user.id
      AND session.credential_version=credential.version
    WHERE teacher_user.id=? AND teacher_user.full_name=?
      AND teacher_user.status='active'
      AND credential.status='active' AND credential.version=?
      AND session.token_hash=? AND session.revoked_at IS NULL
      AND session.expires_at>? LIMIT 1
  `).bind(
    teacher.teacherUserId,
    teacher.fullName,
    teacher.credentialVersion,
    teacher.tokenHash,
    now,
  ).first();
  if (!active) {
    throw new TeacherMaterialRequestError(
      "teacher_access_revoked",
      401,
      "Доступ учителя змінився. Увійдіть ще раз.",
    );
  }
}

function requestLimitReachedError(): TeacherMaterialRequestError {
  return new TeacherMaterialRequestError(
    "request_limit_reached",
    429,
    "У вас забагато активних заявок. Дочекайтеся завершення або скасуйте одну із заявок.",
    { limit: ACTIVE_MATERIAL_REQUEST_LIMIT },
  );
}

type ListCursor = { createdAt: string; id: string; rank?: number };

function encodeListCursor(cursor: ListCursor): string {
  return btoa(JSON.stringify({ v: 1, ...cursor }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeListCursor(
  value: string | null | undefined,
  order: "descending" | "ranked",
): ListCursor | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    if (value.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("cursor syntax");
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(base64)) as Record<string, unknown>;
    const createdAt = typeof parsed.createdAt === "string" ? parsed.createdAt : "";
    const id = typeof parsed.id === "string" ? parsed.id : "";
    const rank = parsed.rank;
    if (
      parsed.v !== 1
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(createdAt)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id)
      || (order === "ranked" && (!Number.isInteger(rank) || Number(rank) < 0 || Number(rank) > 4))
      || (order === "descending" && rank !== undefined)
    ) {
      throw new Error("cursor shape");
    }
    return { createdAt, id, ...(order === "ranked" ? { rank: Number(rank) } : {}) };
  } catch {
    throw new TeacherMaterialRequestError(
      "invalid_cursor",
      400,
      "Некоректний курсор сторінки. Оновіть список і спробуйте ще раз.",
    );
  }
}

function materialRequestStatusRank(status: MaterialRequestStatus): number {
  switch (status) {
    case "submitted": return 0;
    case "in_review": return 1;
    case "partially_ready": return 2;
    case "ready": return 3;
    default: return 4;
  }
}

async function mutationHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stableStringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(object[key])}`
  ).join(",")}}`;
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && Number(value) >= 1
    ? Math.min(Number(value), maximum)
    : fallback;
}

function emptyToNull(value: string | null): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

function nullableYear(value: unknown): number | null {
  const year = Number(value);
  return Number.isSafeInteger(year) && year >= 1500 && year <= 3000 ? year : null;
}

function requestCoverUrl(row: RequestRow): string {
  return coverUrlFromParts(
    row.material_id,
    row.cover_storage_provider,
    row.cover_storage_key,
    row.cover_external_url,
    row.cover_sha256,
  );
}

function coverUrlFromParts(
  materialId: string,
  storageProvider: string | null,
  storageKey: string | null,
  externalUrl: string | null,
  sha256: string | null,
): string {
  const external = String(externalUrl ?? "").trim();
  try {
    const url = new URL(external);
    if (url.protocol === "https:" && !url.username && !url.password) return url.toString();
  } catch {
    // Fall through to a first-party R2 route or no cover.
  }
  const provider = String(storageProvider ?? "").toLowerCase();
  const key = String(storageKey ?? "");
  if (provider !== "r2" || !key || key.startsWith("/") || key.includes("\\")) return "";
  const version = /^[0-9a-f]{64}$/iu.test(String(sha256 ?? ""))
    ? `?v=${String(sha256).slice(0, 12).toLowerCase()}`
    : "";
  return `/api/catalog-v2/covers/${encodeURIComponent(materialId)}${version}`;
}
