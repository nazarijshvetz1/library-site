import type { ChatGPTUser } from "@/app/chatgpt-auth";

type D1Value = string | number | null;
type D1Result<T = Record<string, unknown>> = { results?: T[]; meta?: { changes?: number } };
type D1Statement = {
  bind(...values: D1Value[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
};

export type LocationRegistryDatabase = {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<D1Result[]>;
};

type LocationRow = {
  id: string;
  name: string;
  type: string;
  status: "active" | "inactive";
  is_public: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
  stock_quantity: number;
  active_reservations: number;
  active_classes: number;
  active_teachers: number;
  ready_requests: number;
  teacher_profile_refs: number;
  class_year_refs: number;
  holding_refs: number;
  class_loan_item_refs: number;
  class_loan_line_refs: number;
  loan_item_refs: number;
  inventory_line_refs: number;
  request_refs: number;
  reservation_refs: number;
};

export type ManagedLocation = {
  id: string;
  name: string;
  type: string;
  status: "active" | "inactive";
  isPublic: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  dependencies: {
    stockQuantity: number;
    activeReservations: number;
    activeClasses: number;
    activeTeachers: number;
    readyRequests: number;
    totalReferences: number;
  };
  canDelete: boolean;
  canDeactivate: boolean;
  blockers: string[];
};

type MutationActor = { id: string; email: string };

export class LocationRegistryError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fieldErrors: Record<string, string>;

  constructor(
    code: string,
    status: number,
    message: string,
    fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = "LocationRegistryError";
    this.code = code;
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

export async function listManagedLocations(db: LocationRegistryDatabase): Promise<ManagedLocation[]> {
  const response = await db.prepare(locationDirectorySql()).all<LocationRow>();
  return (response.results ?? []).map(toManagedLocation);
}

export async function createManagedLocation(
  db: LocationRegistryDatabase,
  user: ChatGPTUser,
  input: { requestId: string; name: string; isPublic: boolean; sortOrder: number },
): Promise<ManagedLocation> {
  const actor = await resolveActor(db, user);
  const name = normalizeName(input.name);
  await assertUniqueName(db, name, null);
  const id = `LOC-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const after = { id, name, type: "classroom", status: "active", isPublic: input.isPublic, sortOrder: input.sortOrder };
  await db.batch([
    db.prepare(`
      INSERT INTO locations (id, name, type, status, is_public, sort_order, created_at, updated_at)
      VALUES (?, ?, 'classroom', 'active', ?, ?, ?, ?)
    `).bind(id, name, input.isPublic ? 1 : 0, input.sortOrder, now, now),
    auditStatement(db, actor, input.requestId, "location.created", id, null, after, now, false),
  ]);
  return requireLocation(db, id);
}

export async function updateManagedLocation(
  db: LocationRegistryDatabase,
  user: ChatGPTUser,
  id: string,
  input: {
    requestId: string;
    expectedUpdatedAt: string;
    changes: { name?: string; isPublic?: boolean; sortOrder?: number; status?: "active" | "inactive" };
  },
): Promise<ManagedLocation> {
  const actor = await resolveActor(db, user);
  const before = await requireLocation(db, id);
  if (before.updatedAt !== input.expectedUpdatedAt) {
    throw new LocationRegistryError("location_version_conflict", 409, "Кабінет уже змінився. Оновіть список і повторіть дію.");
  }
  if (before.type === "library" && input.changes.status === "inactive") {
    throw new LocationRegistryError("library_location_protected", 409, "Основне місце бібліотеки не можна закрити.");
  }
  if (input.changes.status === "inactive" && !before.canDeactivate) {
    throw new LocationRegistryError("location_in_use", 409, `Спочатку усуньте активні зв’язки: ${before.blockers.join(", ")}.`);
  }
  const name = input.changes.name === undefined ? before.name : normalizeName(input.changes.name);
  await assertUniqueName(db, name, id);
  const next = {
    name,
    isPublic: input.changes.isPublic ?? before.isPublic,
    sortOrder: input.changes.sortOrder ?? before.sortOrder,
    status: input.changes.status ?? before.status,
  };
  if (next.name === before.name && next.isPublic === before.isPublic && next.sortOrder === before.sortOrder && next.status === before.status) {
    throw new LocationRegistryError("no_changes", 400, "Нові значення не відрізняються від поточних.");
  }
  const now = timestampAfter(before.updatedAt);
  const deactivationGuard = next.status === "inactive" ? `
        AND type != 'library'
        AND NOT EXISTS (SELECT 1 FROM holdings h WHERE h.location_id = locations.id AND h.quantity > 0)
        AND NOT EXISTS (
          SELECT 1 FROM material_request_reservations r
          WHERE r.source_location_id = locations.id
            AND r.reserved_quantity > r.issued_quantity + r.released_quantity
        )
        AND NOT EXISTS (
          SELECT 1 FROM class_years cy
          WHERE cy.location_id = locations.id AND cy.status IN ('planned', 'active')
        )
        AND NOT EXISTS (
          SELECT 1 FROM teacher_profiles tp JOIN users u ON u.id = tp.teacher_user_id
          WHERE tp.primary_location_id = locations.id AND u.status = 'active'
        )
        AND NOT EXISTS (
          SELECT 1 FROM material_requests mr
          WHERE mr.pickup_location_id = locations.id AND mr.status IN ('ready', 'partially_ready')
        )
      ` : "";
  const results = await db.batch([
    db.prepare(`
      UPDATE locations
      SET name = ?, is_public = ?, sort_order = ?, status = ?, updated_at = ?
      WHERE id = ? AND updated_at = ?
      ${deactivationGuard}
    `).bind(next.name, next.isPublic ? 1 : 0, next.sortOrder, next.status, now, id, input.expectedUpdatedAt),
    auditStatement(db, actor, input.requestId, "location.updated", id, before, { ...before, ...next, updatedAt: now }, now, true),
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    if (next.status === "inactive") {
      const current = await requireLocation(db, id);
      if (current.status === "active" && !current.canDeactivate) {
        throw new LocationRegistryError("location_in_use", 409, `Спочатку усуньте активні зв’язки: ${current.blockers.join(", ")}.`);
      }
    }
    throw new LocationRegistryError("location_version_conflict", 409, "Кабінет уже змінився. Оновіть список і повторіть дію.");
  }
  return requireLocation(db, id);
}

export async function deleteManagedLocation(
  db: LocationRegistryDatabase,
  user: ChatGPTUser,
  id: string,
  input: { requestId: string; expectedUpdatedAt: string; confirmation: string },
): Promise<{ locationId: string }> {
  const actor = await resolveActor(db, user);
  const before = await requireLocation(db, id);
  if (before.updatedAt !== input.expectedUpdatedAt) {
    throw new LocationRegistryError("location_version_conflict", 409, "Кабінет уже змінився. Оновіть список і повторіть дію.");
  }
  if (before.type === "library") {
    throw new LocationRegistryError("library_location_protected", 409, "Основне місце бібліотеки не можна видалити.");
  }
  if (input.confirmation !== before.name) {
    throw new LocationRegistryError("confirmation_mismatch", 400, "Для підтвердження введіть точну назву кабінету.", { confirmation: "Назва не збігається." });
  }
  if (!before.canDelete) {
    throw new LocationRegistryError("location_has_history", 409, "Кабінет має пов’язані дані, тому його можна лише закрити.");
  }
  const now = new Date().toISOString();
  const results = await db.batch([
    db.prepare(`DELETE FROM locations WHERE id = ? AND updated_at = ?`).bind(id, input.expectedUpdatedAt),
    auditStatement(db, actor, input.requestId, "location.deleted", id, before, null, now, true),
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    throw new LocationRegistryError("location_version_conflict", 409, "Кабінет уже змінився. Оновіть список і повторіть дію.");
  }
  return { locationId: id };
}

async function requireLocation(db: LocationRegistryDatabase, id: string): Promise<ManagedLocation> {
  const row = await db.prepare(`SELECT * FROM (${locationDirectorySql()}) directory WHERE id = ?`).bind(id).first<LocationRow>();
  if (!row) throw new LocationRegistryError("location_not_found", 404, "Кабінет не знайдено.");
  return toManagedLocation(row);
}

function locationDirectorySql(): string {
  return `
    SELECT l.*,
      COALESCE((SELECT SUM(h.quantity) FROM holdings h WHERE h.location_id = l.id), 0) AS stock_quantity,
      COALESCE((SELECT SUM(r.reserved_quantity-r.issued_quantity-r.released_quantity) FROM material_request_reservations r WHERE r.source_location_id = l.id AND r.reserved_quantity > r.issued_quantity+r.released_quantity), 0) AS active_reservations,
      (SELECT COUNT(*) FROM class_years cy WHERE cy.location_id = l.id AND cy.status IN ('planned','active')) AS active_classes,
      (SELECT COUNT(*) FROM teacher_profiles tp JOIN users u ON u.id=tp.teacher_user_id WHERE tp.primary_location_id = l.id AND u.status='active') AS active_teachers,
      (SELECT COUNT(*) FROM material_requests mr WHERE mr.pickup_location_id = l.id AND mr.status IN ('ready','partially_ready')) AS ready_requests,
      (SELECT COUNT(*) FROM teacher_profiles tp WHERE tp.primary_location_id = l.id) AS teacher_profile_refs,
      (SELECT COUNT(*) FROM class_years cy WHERE cy.location_id = l.id) AS class_year_refs,
      (SELECT COUNT(*) FROM holdings h WHERE h.location_id = l.id) AS holding_refs,
      (SELECT COUNT(*) FROM class_loan_items cli WHERE cli.source_location_id = l.id) AS class_loan_item_refs,
      (SELECT COUNT(*) FROM class_loan_transaction_lines cltl WHERE cltl.location_id = l.id) AS class_loan_line_refs,
      (SELECT COUNT(*) FROM loan_items li WHERE li.source_location_id = l.id) AS loan_item_refs,
      (SELECT COUNT(*) FROM inventory_transaction_lines itl WHERE itl.location_id = l.id) AS inventory_line_refs,
      (SELECT COUNT(*) FROM material_requests mr WHERE mr.pickup_location_id = l.id) AS request_refs,
      (SELECT COUNT(*) FROM material_request_reservations r WHERE r.source_location_id = l.id) AS reservation_refs
    FROM locations l
    GROUP BY l.id
    ORDER BY CASE l.status WHEN 'active' THEN 0 ELSE 1 END, l.sort_order, l.name, l.id
  `;
}

function toManagedLocation(row: LocationRow): ManagedLocation {
  const totalReferences = [row.teacher_profile_refs, row.class_year_refs, row.holding_refs, row.class_loan_item_refs,
    row.class_loan_line_refs, row.loan_item_refs, row.inventory_line_refs, row.request_refs, row.reservation_refs]
    .reduce((sum, value) => sum + nonNegative(value), 0);
  const dependencies = {
    stockQuantity: nonNegative(row.stock_quantity),
    activeReservations: nonNegative(row.active_reservations),
    activeClasses: nonNegative(row.active_classes),
    activeTeachers: nonNegative(row.active_teachers),
    readyRequests: nonNegative(row.ready_requests),
    totalReferences,
  };
  const blockers: string[] = [];
  if (row.type === "library") blockers.push("основне місце бібліотеки");
  if (dependencies.stockQuantity) blockers.push(`${dependencies.stockQuantity} примірників`);
  if (dependencies.activeReservations) blockers.push(`${dependencies.activeReservations} активних резервів`);
  if (dependencies.activeClasses) blockers.push(`${dependencies.activeClasses} відкритих класів`);
  if (dependencies.activeTeachers) blockers.push(`${dependencies.activeTeachers} активних карток учителів`);
  if (dependencies.readyRequests) blockers.push(`${dependencies.readyRequests} готових замовлень`);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    status: row.status,
    isPublic: Number(row.is_public) === 1,
    sortOrder: nonNegative(row.sort_order),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dependencies,
    canDelete: row.type !== "library" && totalReferences === 0,
    canDeactivate: blockers.length === 0,
    blockers,
  };
}

async function assertUniqueName(db: LocationRegistryDatabase, name: string, exceptId: string | null): Promise<void> {
  const response = await db.prepare(`SELECT id, name FROM locations WHERE (? IS NULL OR id != ?) LIMIT 2000`).bind(exceptId, exceptId).all<{ id: string; name: string }>();
  const normalized = name.toLocaleLowerCase("uk-UA");
  if ((response.results ?? []).some((row) => normalizeName(row.name).toLocaleLowerCase("uk-UA") === normalized)) {
    throw new LocationRegistryError("location_name_conflict", 409, "Кабінет із такою назвою вже існує.", { name: "Виберіть іншу назву." });
  }
}

async function resolveActor(db: LocationRegistryDatabase, user: ChatGPTUser): Promise<MutationActor> {
  const response = await db.prepare(`
    SELECT id FROM users
    WHERE status='active' AND role IN ('admin','librarian')
      AND ((? IS NOT NULL AND id=?)
        OR (? IS NULL AND (auth_user_id=? OR lower(email)=lower(?))))
    ORDER BY id LIMIT 2
  `).bind(user.d1UserId ?? null, user.d1UserId ?? null, user.d1UserId ?? null, user.userId, user.email).all<{ id: string }>();
  const rows = response.results ?? [];
  if (rows.length !== 1) throw new LocationRegistryError("actor_not_mapped", 403, "Обліковий запис не прив’язано до активного бібліотекаря.");
  return { id: rows[0].id, email: user.email.toLowerCase() };
}

function auditStatement(
  db: LocationRegistryDatabase,
  actor: MutationActor,
  requestId: string,
  action: string,
  entityId: string,
  before: unknown,
  after: unknown,
  createdAt: string,
  guardPreviousChange: boolean,
): D1Statement {
  return db.prepare(`
    INSERT INTO audit_events (id, actor_user_id, actor_email, action, entity_type, entity_id, request_id, before_json, after_json, metadata_json, created_at)
    SELECT ?, ?, ?, ?, 'location', ?, ?, ?, ?, NULL, ?
    ${guardPreviousChange ? "WHERE changes() = 1" : ""}
  `).bind(`AUD-${crypto.randomUUID()}`, actor.id, actor.email, action, entityId, requestId,
    before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), createdAt);
}

function normalizeName(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

function nonNegative(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function timestampAfter(previous: string): string {
  const now = Date.now();
  const previousTime = Date.parse(previous);
  return new Date(Number.isFinite(previousTime) && now <= previousTime ? previousTime + 1 : now).toISOString();
}
