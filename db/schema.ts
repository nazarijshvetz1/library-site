import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const draftKinds = [
  "material.create",
  "material.update",
  "receipt.create",
  "transfer.create",
  "writeoff.create",
  "revision.count",
  "academic-year.create",
  "class-year.create",
  "class-year.update",
  "class-year.close",
  "academic-year.rollover",
] as const;

const draftStatuses = [
  "draft",
  "ready_for_review",
  "cancelled",
  "approved_pending_apply",
  "applied",
  "failed",
] as const;

export const librarianDrafts = sqliteTable(
  "librarian_drafts",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    ownerEmail: text("owner_email").notNull(),
    kind: text("kind", { enum: draftKinds }).notNull(),
    payloadJson: text("payload_json").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    revision: integer("revision").notNull().default(1),
    status: text("status", { enum: draftStatuses }).notNull(),
    groupId: text("group_id"),
    targetKey: text("target_key"),
    updatedByUserId: text("updated_by_user_id"),
    updatedByEmail: text("updated_by_email"),
    submittedAt: text("submitted_at"),
    cancelledAt: text("cancelled_at"),
    reviewedAt: text("reviewed_at"),
    reviewedByUserId: text("reviewed_by_user_id"),
    reviewedByEmail: text("reviewed_by_email"),
    reviewNote: text("review_note"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_librarian_drafts_owner_updated").on(
      table.ownerUserId,
      table.updatedAt,
    ),
    index("idx_librarian_drafts_owner_status_updated").on(
      table.ownerUserId,
      table.status,
      table.updatedAt,
    ),
    index("idx_librarian_drafts_group_updated").on(
      table.groupId,
      table.updatedAt,
    ),
  ],
);

export const librarianDraftEvents = sqliteTable(
  "librarian_draft_events",
  {
    id: text("id").primaryKey(),
    draftId: text("draft_id")
      .notNull()
      .references(() => librarianDrafts.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").notNull(),
    actorEmail: text("actor_email").notNull(),
    action: text("action", {
      enum: [
        "created",
        "updated",
        "submitted",
        "cancelled",
        "approved",
        "returned_for_changes",
        "applied",
        "failed",
      ],
    }).notNull(),
    fromStatus: text("from_status", { enum: draftStatuses }),
    toStatus: text("to_status", { enum: draftStatuses }).notNull(),
    revision: integer("revision").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_librarian_draft_events_draft_created").on(
      table.draftId,
      table.createdAt,
    ),
    uniqueIndex("idx_librarian_draft_events_draft_revision").on(
      table.draftId,
      table.revision,
    ),
  ],
);

const materialStatuses = ["active", "archived"] as const;
const linkKinds = [
  "ebook",
  "details",
  "publisher",
  "store",
  "preview",
  "other",
] as const;
const linkStatuses = ["active", "broken", "archived"] as const;
const coverProviders = ["r2", "external"] as const;
const coverStatuses = ["pending", "ready", "failed", "archived"] as const;
const locationTypes = ["library", "classroom", "office", "other", "service"] as const;
const directoryStatuses = ["active", "inactive"] as const;
const userRoles = ["admin", "librarian", "teacher"] as const;
const holdingConditions = ["unspecified", "good", "worn", "damaged"] as const;
const academicYearStatuses = ["draft", "active", "closed"] as const;
const cohortStatuses = ["active", "graduated", "closed"] as const;
const classYearStatuses = ["planned", "active", "closed"] as const;
const loanStatuses = ["open", "closed", "cancelled"] as const;
const classLoanTransactionKinds = ["issue", "return"] as const;
const inventoryTransactionKinds = [
  "receipt",
  "transfer",
  "writeoff",
  "stock_count",
  "loan_issue",
  "loan_return",
  "reversal",
  "import",
] as const;
const inventoryTransactionStatuses = ["posted", "reversed"] as const;
const mutationCommandStatuses = ["processing", "completed", "failed"] as const;
const visitBookingStatuses = ["active", "cancelled"] as const;
const visitBookingOwnerKinds = ["teacher", "guest", "legacy"] as const;
const visitClosureStatuses = ["active", "cancelled"] as const;
const visitHourStatuses = ["active", "inactive"] as const;
const visitTeacherCredentialStatuses = ["active", "disabled"] as const;
const visitTeacherAccessCommandKinds = [
  "code.issue",
  "code.bulk_issue",
  "code.import",
  "credential.enable",
  "credential.disable",
  "credential.unlock",
  "sessions.revoke",
] as const;
const materialRequestStatuses = [
  "submitted",
  "in_review",
  "ready",
  "partially_ready",
  "completed",
  "rejected",
  "cancelled",
] as const;
const materialRequestActorKinds = ["teacher", "librarian", "system"] as const;
const acquisitionRequesterKinds = ["teacher", "student"] as const;
const acquisitionCategories = ["educational", "literature"] as const;
const acquisitionSourceKinds = ["catalog", "manual"] as const;
const acquisitionLiteratureKinds = ["none", "fiction", "science", "popular_science", "other"] as const;
const acquisitionRequestStatuses = [
  "submitted",
  "in_review",
  "clarification",
  "approved",
  "planned",
  "ordered",
  "partially_received",
  "received",
  "rejected",
  "cancelled",
] as const;
const acquisitionActorKinds = ["teacher", "student", "librarian", "import", "system"] as const;
const acquisitionImportStatuses = ["completed"] as const;

/**
 * Canonical bibliographic record. `id` is the durable CAT-ID while
 * `catalogNumber` exists for numeric sorting and allocation. Search text is a
 * rebuildable normalized projection used as a safe fallback when FTS is not
 * available.
 */
export const materials = sqliteTable(
  "materials",
  {
    id: text("id").primaryKey(),
    catalogNumber: integer("catalog_number").notNull(),
    title: text("title").notNull(),
    sortTitle: text("sort_title").notNull(),
    searchText: text("search_text").notNull().default(""),
    rubric: text("rubric").notNull().default(""),
    publicationType: text("publication_type").notNull().default(""),
    subject: text("subject").notNull().default(""),
    classFrom: integer("class_from"),
    classTo: integer("class_to"),
    author: text("author").notNull().default(""),
    publicationYear: integer("publication_year"),
    isbn: text("isbn").notNull().default(""),
    isbnNormalized: text("isbn_normalized").notNull().default(""),
    publisher: text("publisher").notNull().default(""),
    notes: text("notes").notNull().default(""),
    status: text("status", { enum: materialStatuses }).notNull().default("active"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    archivedAt: text("archived_at"),
  },
  (table) => [
    uniqueIndex("idx_materials_catalog_number").on(table.catalogNumber),
    index("idx_materials_status_sort_title_id").on(
      table.status,
      table.sortTitle,
      table.id,
    ),
    index("idx_materials_status_catalog_number").on(
      table.status,
      table.catalogNumber,
    ),
    index("idx_materials_rubric_status_sort").on(
      table.rubric,
      table.status,
      table.sortTitle,
    ),
    index("idx_materials_subject_status_sort").on(
      table.subject,
      table.status,
      table.sortTitle,
    ),
    index("idx_materials_type_status_sort").on(
      table.publicationType,
      table.status,
      table.sortTitle,
    ),
    index("idx_materials_class_range").on(table.classFrom, table.classTo),
    index("idx_materials_isbn_normalized").on(table.isbnNormalized),
    check(
      "materials_id_format",
      sql`${table.id} glob 'CAT-[0-9][0-9][0-9][0-9]*' and substr(${table.id}, 5) not glob '*[^0-9]*'`,
    ),
    check("materials_catalog_number_positive", sql`${table.catalogNumber} > 0`),
    check("materials_title_not_blank", sql`length(trim(${table.title})) > 0`),
    check("materials_sort_title_not_blank", sql`length(trim(${table.sortTitle})) > 0`),
    check(
      "materials_status_valid",
      sql`${table.status} in ('active', 'archived')`,
    ),
    check(
      "materials_class_range_valid",
      sql`(
        ${table.classFrom} is null and ${table.classTo} is null
      ) or (
        ${table.classFrom} between 1 and 11
        and ${table.classTo} between 1 and 11
        and ${table.classFrom} <= ${table.classTo}
      )`,
    ),
    check(
      "materials_publication_year_valid",
      sql`${table.publicationYear} is null or ${table.publicationYear} between 1000 and 3000`,
    ),
    check("materials_version_positive", sql`${table.version} > 0`),
    check(
      "materials_archived_at_consistent",
      sql`${table.status} != 'active' or ${table.archivedAt} is null`,
    ),
  ],
);

export const materialLinks = sqliteTable(
  "material_links",
  {
    id: text("id").primaryKey(),
    materialId: text("material_id")
      .notNull()
      .references(() => materials.id, { onDelete: "restrict", onUpdate: "cascade" }),
    kind: text("kind", { enum: linkKinds }).notNull().default("other"),
    label: text("label").notNull(),
    url: text("url").notNull(),
    isPublic: integer("is_public", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    status: text("status", { enum: linkStatuses }).notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_material_links_material_url").on(table.materialId, table.url),
    index("idx_material_links_public_listing").on(
      table.materialId,
      table.isPublic,
      table.status,
      table.sortOrder,
    ),
    check("material_links_label_not_blank", sql`length(trim(${table.label})) > 0`),
    check(
      "material_links_http_url",
      sql`${table.url} glob 'https://*' or ${table.url} glob 'http://*'`,
    ),
    check(
      "material_links_kind_valid",
      sql`${table.kind} in ('ebook', 'details', 'publisher', 'store', 'preview', 'other')`,
    ),
    check(
      "material_links_status_valid",
      sql`${table.status} in ('active', 'broken', 'archived')`,
    ),
    check("material_links_sort_order_nonnegative", sql`${table.sortOrder} >= 0`),
  ],
);

/** One current cover metadata row per material; bytes live in R2 or at a legacy HTTPS URL. */
export const materialCoverAssets = sqliteTable(
  "material_cover_assets",
  {
    id: text("id").primaryKey(),
    materialId: text("material_id")
      .notNull()
      .references(() => materials.id, { onDelete: "restrict", onUpdate: "cascade" }),
    storageProvider: text("storage_provider", { enum: coverProviders }).notNull(),
    storageKey: text("storage_key"),
    externalUrl: text("external_url"),
    mimeType: text("mime_type"),
    byteLength: integer("byte_length"),
    width: integer("width"),
    height: integer("height"),
    sha256: text("sha256"),
    status: text("status", { enum: coverStatuses }).notNull().default("pending"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_material_cover_assets_material").on(table.materialId),
    uniqueIndex("idx_material_cover_assets_storage_key").on(table.storageKey),
    index("idx_material_cover_assets_status_updated").on(table.status, table.updatedAt),
    check(
      "material_cover_assets_provider_valid",
      sql`${table.storageProvider} in ('r2', 'external')`,
    ),
    check(
      "material_cover_assets_location_valid",
      sql`(
        ${table.storageProvider} = 'r2'
        and ${table.storageKey} is not null
        and length(trim(${table.storageKey})) > 0
      ) or (
        ${table.storageProvider} = 'external'
        and (${table.externalUrl} glob 'https://*' or ${table.externalUrl} glob 'http://*')
      )`,
    ),
    check(
      "material_cover_assets_status_valid",
      sql`${table.status} in ('pending', 'ready', 'failed', 'archived')`,
    ),
    check(
      "material_cover_assets_dimensions_valid",
      sql`(${table.width} is null or ${table.width} > 0)
        and (${table.height} is null or ${table.height} > 0)
        and (${table.byteLength} is null or ${table.byteLength} >= 0)`,
    ),
    check(
      "material_cover_assets_sha256_valid",
      sql`${table.sha256} is null or (
        length(${table.sha256}) = 64
        and lower(${table.sha256}) not glob '*[^0-9a-f]*'
      )`,
    ),
    check("material_cover_assets_version_positive", sql`${table.version} > 0`),
  ],
);

export const locations = sqliteTable(
  "locations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type", { enum: locationTypes }).notNull().default("other"),
    status: text("status", { enum: directoryStatuses }).notNull().default("active"),
    isPublic: integer("is_public", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_locations_name").on(table.name),
    index("idx_locations_directory").on(table.status, table.type, table.sortOrder, table.name),
    check("locations_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check(
      "locations_type_valid",
      sql`${table.type} in ('library', 'classroom', 'office', 'other', 'service')`,
    ),
    check(
      "locations_status_valid",
      sql`${table.status} in ('active', 'inactive')`,
    ),
    check("locations_sort_order_nonnegative", sql`${table.sortOrder} >= 0`),
  ],
);

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    fullName: text("full_name").notNull(),
    sortName: text("sort_name").notNull(),
    email: text("email"),
    authUserId: text("auth_user_id"),
    role: text("role", { enum: userRoles }).notNull(),
    status: text("status", { enum: directoryStatuses }).notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_users_email").on(table.email),
    uniqueIndex("idx_users_auth_user_id").on(table.authUserId),
    index("idx_users_role_status_name").on(table.role, table.status, table.sortName),
    check("users_full_name_not_blank", sql`length(trim(${table.fullName})) > 0`),
    check("users_sort_name_not_blank", sql`length(trim(${table.sortName})) > 0`),
    check(
      "users_role_valid",
      sql`${table.role} in ('admin', 'librarian', 'teacher')`,
    ),
    check(
      "users_status_valid",
      sql`${table.status} in ('active', 'inactive')`,
    ),
  ],
);

/** Librarian-managed teacher details kept separate from authentication identity. */
export const teacherProfiles = sqliteTable(
  "teacher_profiles",
  {
    teacherUserId: text("teacher_user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    subjectPosition: text("subject_position").notNull().default(""),
    primaryLocationId: text("primary_location_id").references(() => locations.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    serviceContact: text("service_contact").notNull().default(""),
    librarianNote: text("librarian_note").notNull().default(""),
    photoStorageKey: text("photo_storage_key"),
    photoMimeType: text("photo_mime_type"),
    photoVersion: integer("photo_version").notNull().default(0),
    photoUpdatedAt: text("photo_updated_at"),
    version: integer("version").notNull().default(1),
    lastMutationRequestId: text("last_mutation_request_id"),
    closedAt: text("closed_at"),
    closedByUserId: text("closed_by_user_id").references(() => users.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_teacher_profiles_location_teacher").on(table.primaryLocationId, table.teacherUserId),
    index("idx_teacher_profiles_updated").on(table.updatedAt, table.teacherUserId),
    uniqueIndex("idx_teacher_profiles_photo_storage_key").on(table.photoStorageKey),
    check("teacher_profiles_subject_length", sql`length(${table.subjectPosition}) <= 160`),
    check("teacher_profiles_contact_length", sql`length(${table.serviceContact}) <= 200`),
    check("teacher_profiles_note_length", sql`length(${table.librarianNote}) <= 4000`),
    check("teacher_profiles_version_positive", sql`${table.version} > 0`),
    check(
      "teacher_profiles_photo_consistent",
      sql`(${table.photoStorageKey} is null and ${table.photoMimeType} is null
          and ${table.photoVersion} = 0 and ${table.photoUpdatedAt} is null)
        or (${table.photoStorageKey} is not null and length(trim(${table.photoStorageKey})) > 0
          and ${table.photoMimeType} in ('image/jpeg','image/png','image/webp')
          and ${table.photoVersion} > 0 and ${table.photoUpdatedAt} is not null)`,
    ),
    check(
      "teacher_profiles_closed_fields_consistent",
      sql`(${table.closedAt} is null and ${table.closedByUserId} is null)
        or (${table.closedAt} is not null and ${table.closedByUserId} is not null)`,
    ),
  ],
);

/** App-owned credentials for teachers who use the public visit scheduler. */
export const visitTeacherCredentials = sqliteTable(
  "visit_teacher_credentials",
  {
    teacherUserId: text("teacher_user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    loginId: text("login_id").notNull(),
    codeHmac: text("code_hmac").notNull(),
    mustChangePin: integer("must_change_pin", { mode: "boolean" }).notNull().default(true),
    status: text("status", { enum: visitTeacherCredentialStatuses }).notNull().default("active"),
    version: integer("version").notNull().default(1),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    failureWindowStartedAt: text("failure_window_started_at"),
    lockedUntil: text("locked_until"),
    lastLoginAt: text("last_login_at"),
    codeRotatedAt: text("code_rotated_at").notNull(),
    codeExpiresAt: text("code_expires_at"),
    lastAccessCommandId: text("last_access_command_id"),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    updatedByUserId: text("updated_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_visit_teacher_credentials_login_id").on(table.loginId),
    index("idx_visit_teacher_credentials_status_teacher").on(table.status, table.teacherUserId),
    check("visit_teacher_credentials_login_id_not_blank", sql`length(trim(${table.loginId})) between 16 and 128`),
    check("visit_teacher_credentials_hmac_valid", sql`length(${table.codeHmac}) = 64 and lower(${table.codeHmac}) not glob '*[^0-9a-f]*'`),
    check("visit_teacher_credentials_must_change_pin_valid", sql`${table.mustChangePin} in (0, 1)`),
    check("visit_teacher_credentials_status_valid", sql`${table.status} in ('active', 'disabled')`),
    check("visit_teacher_credentials_version_positive", sql`${table.version} > 0`),
    check("visit_teacher_credentials_attempts_nonnegative", sql`${table.failedAttempts} >= 0`),
    check(
      "visit_teacher_credentials_expiry_consistent",
      sql`${table.mustChangePin} = 1 or ${table.codeExpiresAt} is null`,
    ),
    check(
      "visit_teacher_credentials_command_id_valid",
      sql`${table.lastAccessCommandId} is null or length(${table.lastAccessCommandId}) = 36`,
    ),
  ],
);

/** Browser sessions store only a SHA-256 token digest, never the cookie token. */
export const visitTeacherSessions = sqliteTable(
  "visit_teacher_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    teacherUserId: text("teacher_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    credentialVersion: integer("credential_version").notNull(),
    pendingScope: text("pending_scope").notNull(),
    ipScopeHash: text("ip_scope_hash").notNull(),
    expiresAt: text("expires_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_visit_teacher_sessions_pending_scope").on(table.pendingScope),
    index("idx_visit_teacher_sessions_teacher_active").on(table.teacherUserId, table.revokedAt, table.expiresAt),
    index("idx_visit_teacher_sessions_expires").on(table.expiresAt),
    check("visit_teacher_sessions_token_hash_valid", sql`length(${table.tokenHash}) = 64 and lower(${table.tokenHash}) not glob '*[^0-9a-f]*'`),
    check("visit_teacher_sessions_ip_hash_valid", sql`length(${table.ipScopeHash}) = 64 and lower(${table.ipScopeHash}) not glob '*[^0-9a-f]*'`),
    check("visit_teacher_sessions_pending_scope_not_blank", sql`length(trim(${table.pendingScope})) between 16 and 128`),
    check("visit_teacher_sessions_version_positive", sql`${table.credentialVersion} > 0`),
  ],
);

/** Fixed-window login throttles keyed by a peppered digest of the client IP. */
export const visitTeacherLoginLimits = sqliteTable(
  "visit_teacher_login_limits",
  {
    scopeHash: text("scope_hash").primaryKey(),
    attempts: integer("attempts").notNull().default(0),
    windowStartedAt: text("window_started_at").notNull(),
    blockedUntil: text("blocked_until"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_visit_teacher_login_limits_updated").on(table.updatedAt),
    check("visit_teacher_login_limits_scope_valid", sql`length(${table.scopeHash}) = 64 and lower(${table.scopeHash}) not glob '*[^0-9a-f]*'`),
    check("visit_teacher_login_limits_attempts_nonnegative", sql`${table.attempts} >= 0`),
  ],
);

/** Anonymous browser ownership for unverified visit bookings. Only token digests are stored. */
export const visitGuestSessions = sqliteTable(
  "visit_guest_sessions",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    pendingScope: text("pending_scope").notNull(),
    ipScopeHash: text("ip_scope_hash").notNull(),
    expiresAt: text("expires_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_visit_guest_sessions_token_hash").on(table.tokenHash),
    uniqueIndex("idx_visit_guest_sessions_pending_scope").on(table.pendingScope),
    index("idx_visit_guest_sessions_expires").on(table.expiresAt),
    check("visit_guest_sessions_token_hash_valid", sql`length(${table.tokenHash}) = 64 and lower(${table.tokenHash}) not glob '*[^0-9a-f]*'`),
    check("visit_guest_sessions_ip_hash_valid", sql`length(${table.ipScopeHash}) = 64 and lower(${table.ipScopeHash}) not glob '*[^0-9a-f]*'`),
    check("visit_guest_sessions_pending_scope_not_blank", sql`length(trim(${table.pendingScope})) between 16 and 128`),
  ],
);

/** Coarse abuse limits for anonymous session creation and visit mutations. */
export const visitGuestRateLimits = sqliteTable(
  "visit_guest_rate_limits",
  {
    scopeHash: text("scope_hash").primaryKey(),
    attempts: integer("attempts").notNull().default(0),
    windowStartedAt: text("window_started_at").notNull(),
    blockedUntil: text("blocked_until"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_visit_guest_rate_limits_updated").on(table.updatedAt),
    check("visit_guest_rate_limits_scope_valid", sql`length(${table.scopeHash}) = 64 and lower(${table.scopeHash}) not glob '*[^0-9a-f]*'`),
    check("visit_guest_rate_limits_attempts_nonnegative", sql`${table.attempts} >= 0`),
  ],
);

/** Idempotency receipts for librarian credential administration; never stores plaintext codes. */
export const visitTeacherAccessCommands = sqliteTable(
  "visit_teacher_access_commands",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    kind: text("kind", { enum: visitTeacherAccessCommandKinds }).notNull(),
    teacherUserId: text("teacher_user_id").references(() => users.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    requestHash: text("request_hash").notNull(),
    status: text("status", { enum: mutationCommandStatuses }).notNull().default("processing"),
    resultJson: text("result_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("idx_visit_teacher_access_commands_actor_created").on(table.actorUserId, table.createdAt),
    check("visit_teacher_access_commands_kind_valid", sql`${table.kind} in ('code.issue','code.bulk_issue','code.import','credential.enable','credential.disable','credential.unlock','sessions.revoke')`),
    check("visit_teacher_access_commands_hash_valid", sql`length(${table.requestHash}) = 64 and lower(${table.requestHash}) not glob '*[^0-9a-f]*'`),
    check("visit_teacher_access_commands_status_valid", sql`${table.status} in ('processing', 'completed', 'failed')`),
    check("visit_teacher_access_commands_result_valid", sql`${table.resultJson} is null or json_valid(${table.resultJson})`),
    check("visit_teacher_access_commands_completion_consistent", sql`(${table.status} = 'processing' and ${table.completedAt} is null) or (${table.status} in ('completed', 'failed') and ${table.completedAt} is not null)`),
  ],
);

/** Sparse on-hand stock. A zero balance is represented by the absence of a row. */
export const holdings = sqliteTable(
  "holdings",
  {
    materialId: text("material_id")
      .notNull()
      .references(() => materials.id, { onDelete: "restrict", onUpdate: "cascade" }),
    locationId: text("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    condition: text("condition", { enum: holdingConditions })
      .notNull()
      .default("unspecified"),
    quantity: integer("quantity").notNull(),
    version: integer("version").notNull().default(1),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.materialId, table.locationId, table.condition] }),
    index("idx_holdings_location_material").on(table.locationId, table.materialId),
    index("idx_holdings_material_quantity").on(table.materialId, table.quantity),
    check(
      "holdings_condition_valid",
      sql`${table.condition} in ('unspecified', 'good', 'worn', 'damaged')`,
    ),
    check("holdings_quantity_positive", sql`${table.quantity} > 0`),
    check("holdings_version_positive", sql`${table.version} > 0`),
  ],
);

/** Rebuildable summary used by catalog cards and availability filters. */
export const materialStockTotals = sqliteTable(
  "material_stock_totals",
  {
    materialId: text("material_id")
      .primaryKey()
      .references(() => materials.id, { onDelete: "restrict", onUpdate: "cascade" }),
    totalQuantity: integer("total_quantity").notNull().default(0),
    libraryQuantity: integer("library_quantity").notNull().default(0),
    otherLocationQuantity: integer("other_location_quantity").notNull().default(0),
    loanedQuantity: integer("loaned_quantity").notNull().default(0),
    reservedQuantity: integer("reserved_quantity").notNull().default(0),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_material_stock_totals_available").on(
      table.totalQuantity,
      table.loanedQuantity,
      table.reservedQuantity,
      table.materialId,
    ),
    check(
      "material_stock_totals_nonnegative",
      sql`${table.totalQuantity} >= 0
        and ${table.libraryQuantity} >= 0
        and ${table.otherLocationQuantity} >= 0
        and ${table.loanedQuantity} >= 0
        and ${table.reservedQuantity} >= 0
        and ${table.reservedQuantity} <= ${table.libraryQuantity} + ${table.otherLocationQuantity}`,
    ),
    check(
      "material_stock_totals_balanced",
      sql`${table.totalQuantity} = ${table.libraryQuantity}
        + ${table.otherLocationQuantity}
        + ${table.loanedQuantity}`,
    ),
  ],
);

export const academicYears = sqliteTable(
  "academic_years",
  {
    id: text("id").primaryKey(),
    label: text("label").notNull(),
    startDate: text("start_date").notNull(),
    endDate: text("end_date").notNull(),
    status: text("status", { enum: academicYearStatuses }).notNull().default("draft"),
    notes: text("notes").notNull().default(""),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_academic_years_label").on(table.label),
    index("idx_academic_years_status_start").on(table.status, table.startDate),
    check(
      "academic_years_status_valid",
      sql`${table.status} in ('draft', 'active', 'closed')`,
    ),
    check("academic_years_date_order", sql`${table.startDate} < ${table.endDate}`),
    check("academic_years_version_positive", sql`${table.version} > 0`),
  ],
);

/** Stable class identity that survives annual renaming and promotion. */
export const cohorts = sqliteTable(
  "cohorts",
  {
    id: text("id").primaryKey(),
    status: text("status", { enum: cohortStatuses }).notNull().default("active"),
    notes: text("notes").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_cohorts_status_updated").on(table.status, table.updatedAt),
    check(
      "cohorts_status_valid",
      sql`${table.status} in ('active', 'graduated', 'closed')`,
    ),
  ],
);

export const classYears = sqliteTable(
  "class_years",
  {
    id: text("id").primaryKey(),
    academicYearId: text("academic_year_id")
      .notNull()
      .references(() => academicYears.id, { onDelete: "restrict", onUpdate: "cascade" }),
    cohortId: text("cohort_id")
      .notNull()
      .references(() => cohorts.id, { onDelete: "restrict", onUpdate: "cascade" }),
    className: text("class_name").notNull(),
    grade: integer("grade").notNull(),
    code: text("code").notNull(),
    teacherUserId: text("teacher_user_id").references(() => users.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    locationId: text("location_id").references(() => locations.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    startDate: text("start_date").notNull(),
    endDate: text("end_date").notNull(),
    status: text("status", { enum: classYearStatuses }).notNull().default("planned"),
    actualClosedDate: text("actual_closed_date"),
    notes: text("notes").notNull().default(""),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_class_years_year_cohort").on(table.academicYearId, table.cohortId),
    uniqueIndex("idx_class_years_year_name").on(table.academicYearId, table.className),
    index("idx_class_years_year_status_name").on(
      table.academicYearId,
      table.status,
      table.className,
    ),
    index("idx_class_years_teacher_status").on(table.teacherUserId, table.status),
    index("idx_class_years_location_status").on(table.locationId, table.status),
    check("class_years_name_not_blank", sql`length(trim(${table.className})) > 0`),
    check("class_years_grade_valid", sql`${table.grade} between 1 and 11`),
    check("class_years_code_not_blank", sql`length(trim(${table.code})) > 0`),
    check("class_years_date_order", sql`${table.startDate} < ${table.endDate}`),
    check(
      "class_years_status_valid",
      sql`${table.status} in ('planned', 'active', 'closed')`,
    ),
    check(
      "class_years_closed_date_consistent",
      sql`(${table.status} = 'closed' and ${table.actualClosedDate} is not null)
        or (${table.status} != 'closed' and ${table.actualClosedDate} is null)`,
    ),
    check("class_years_version_positive", sql`${table.version} > 0`),
  ],
);

const teacherCuratorRequestStatuses = [
  "submitted",
  "approved",
  "rejected",
  "cancelled",
] as const;

/** Teacher-originated curator changes that require an explicit librarian decision. */
export const teacherCuratorChangeRequests = sqliteTable(
  "teacher_curator_change_requests",
  {
    id: text("id").primaryKey(),
    teacherUserId: text("teacher_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    currentClassYearId: text("current_class_year_id").references(() => classYears.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    requestedClassYearId: text("requested_class_year_id")
      .notNull()
      .references(() => classYears.id, { onDelete: "restrict", onUpdate: "cascade" }),
    status: text("status", { enum: teacherCuratorRequestStatuses })
      .notNull()
      .default("submitted"),
    teacherNote: text("teacher_note").notNull().default(""),
    librarianNote: text("librarian_note").notNull().default(""),
    version: integer("version").notNull().default(1),
    lastMutationRequestId: text("last_mutation_request_id"),
    resolvedByUserId: text("resolved_by_user_id").references(() => users.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    resolvedAt: text("resolved_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_teacher_curator_requests_open_teacher")
      .on(table.teacherUserId)
      .where(sql`${table.status} = 'submitted'`),
    index("idx_teacher_curator_requests_status_created").on(table.status, table.createdAt, table.id),
    index("idx_teacher_curator_requests_teacher_created").on(table.teacherUserId, table.createdAt, table.id),
    check("teacher_curator_requests_status_valid", sql`${table.status} in ('submitted','approved','rejected','cancelled')`),
    check("teacher_curator_requests_note_length", sql`length(${table.teacherNote}) <= 1000 and length(${table.librarianNote}) <= 2000`),
    check("teacher_curator_requests_version_positive", sql`${table.version} > 0`),
    check("teacher_curator_requests_changes_class", sql`${table.currentClassYearId} is null or ${table.currentClassYearId} != ${table.requestedClassYearId}`),
    check(
      "teacher_curator_requests_resolution_consistent",
      sql`(${table.status} = 'submitted' and ${table.resolvedAt} is null and ${table.resolvedByUserId} is null)
        or (${table.status} in ('approved','rejected') and ${table.resolvedAt} is not null and ${table.resolvedByUserId} is not null)
        or (${table.status} = 'cancelled' and ${table.resolvedAt} is not null and ${table.resolvedByUserId} is null)`,
    ),
  ],
);

/**
 * Annual class-level circulation. This stays separate from teacher loans so
 * the existing teacher borrower invariant remains intact.
 */
export const classLoans = sqliteTable(
  "class_loans",
  {
    id: text("id").primaryKey(),
    classYearId: text("class_year_id")
      .notNull()
      .references(() => classYears.id, { onDelete: "restrict", onUpdate: "cascade" }),
    responsibleTeacherUserId: text("responsible_teacher_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    status: text("status", { enum: loanStatuses }).notNull().default("open"),
    issuedAt: text("issued_at").notNull(),
    dueAt: text("due_at"),
    closedAt: text("closed_at"),
    notes: text("notes").notNull().default(""),
    issuedByUserId: text("issued_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    closedByUserId: text("closed_by_user_id").references(() => users.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_class_loans_class_status_due").on(
      table.classYearId,
      table.status,
      table.dueAt,
    ),
    index("idx_class_loans_status_due").on(table.status, table.dueAt),
    index("idx_class_loans_teacher_status_due").on(
      table.responsibleTeacherUserId,
      table.status,
      table.dueAt,
    ),
    check(
      "class_loans_status_valid",
      sql`${table.status} in ('open', 'closed', 'cancelled')`,
    ),
    check(
      "class_loans_due_after_issue",
      sql`${table.dueAt} is null or ${table.dueAt} >= ${table.issuedAt}`,
    ),
    check(
      "class_loans_closed_fields_consistent",
      sql`(${table.status} = 'closed' and ${table.closedAt} is not null and ${table.closedByUserId} is not null)
        or (${table.status} != 'closed' and ${table.closedAt} is null and ${table.closedByUserId} is null)`,
    ),
    check("class_loans_version_positive", sql`${table.version} > 0`),
  ],
);

export const classLoanItems = sqliteTable(
  "class_loan_items",
  {
    id: text("id").primaryKey(),
    classLoanId: text("class_loan_id")
      .notNull()
      .references(() => classLoans.id, { onDelete: "restrict", onUpdate: "cascade" }),
    materialId: text("material_id")
      .notNull()
      .references(() => materials.id, { onDelete: "restrict", onUpdate: "cascade" }),
    sourceLocationId: text("source_location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    condition: text("condition", { enum: holdingConditions })
      .notNull()
      .default("unspecified"),
    quantityIssued: integer("quantity_issued").notNull(),
    quantityReturned: integer("quantity_returned").notNull().default(0),
    notes: text("notes").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_class_loan_items_loan_material").on(table.classLoanId, table.materialId),
    index("idx_class_loan_items_material_loan").on(table.materialId, table.classLoanId),
    check(
      "class_loan_items_condition_valid",
      sql`${table.condition} in ('unspecified', 'good', 'worn', 'damaged')`,
    ),
    check("class_loan_items_quantity_issued_positive", sql`${table.quantityIssued} > 0`),
    check(
      "class_loan_items_quantity_returned_valid",
      sql`${table.quantityReturned} >= 0 and ${table.quantityReturned} <= ${table.quantityIssued}`,
    ),
  ],
);

/** Immutable, actor-attributed stock ledger for class circulation. */
export const classLoanTransactions = sqliteTable(
  "class_loan_transactions",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull(),
    classLoanId: text("class_loan_id")
      .notNull()
      .references(() => classLoans.id, { onDelete: "restrict", onUpdate: "cascade" }),
    kind: text("kind", { enum: classLoanTransactionKinds }).notNull(),
    occurredAt: text("occurred_at").notNull(),
    notes: text("notes").notNull().default(""),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_class_loan_transactions_request").on(table.requestId),
    index("idx_class_loan_transactions_loan_occurred").on(
      table.classLoanId,
      table.occurredAt,
    ),
    index("idx_class_loan_transactions_actor_occurred").on(
      table.actorUserId,
      table.occurredAt,
    ),
    check(
      "class_loan_transactions_kind_valid",
      sql`${table.kind} in ('issue', 'return')`,
    ),
  ],
);

export const classLoanTransactionLines = sqliteTable(
  "class_loan_transaction_lines",
  {
    id: text("id").primaryKey(),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => classLoanTransactions.id, {
        onDelete: "restrict",
        onUpdate: "cascade",
      }),
    classLoanItemId: text("class_loan_item_id")
      .notNull()
      .references(() => classLoanItems.id, { onDelete: "restrict", onUpdate: "cascade" }),
    materialId: text("material_id")
      .notNull()
      .references(() => materials.id, { onDelete: "restrict", onUpdate: "cascade" }),
    locationId: text("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    condition: text("condition", { enum: holdingConditions })
      .notNull()
      .default("unspecified"),
    quantityDelta: integer("quantity_delta").notNull(),
    quantityBefore: integer("quantity_before").notNull(),
    quantityAfter: integer("quantity_after").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_class_loan_lines_transaction").on(table.transactionId),
    index("idx_class_loan_lines_item").on(table.classLoanItemId),
    index("idx_class_loan_lines_material_transaction").on(
      table.materialId,
      table.transactionId,
    ),
    check(
      "class_loan_lines_condition_valid",
      sql`${table.condition} in ('unspecified', 'good', 'worn', 'damaged')`,
    ),
    check(
      "class_loan_lines_quantities_nonnegative",
      sql`${table.quantityBefore} >= 0 and ${table.quantityAfter} >= 0`,
    ),
    check(
      "class_loan_lines_delta_balanced",
      sql`${table.quantityAfter} = ${table.quantityBefore} + ${table.quantityDelta}`,
    ),
    check("class_loan_lines_delta_nonzero", sql`${table.quantityDelta} != 0`),
  ],
);

export const loans = sqliteTable(
  "loans",
  {
    id: text("id").primaryKey(),
    teacherUserId: text("teacher_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    status: text("status", { enum: loanStatuses }).notNull().default("open"),
    issuedAt: text("issued_at").notNull(),
    dueAt: text("due_at"),
    closedAt: text("closed_at"),
    notes: text("notes").notNull().default(""),
    issuedByUserId: text("issued_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    closedByUserId: text("closed_by_user_id").references(() => users.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_loans_teacher_status_due").on(
      table.teacherUserId,
      table.status,
      table.dueAt,
    ),
    index("idx_loans_status_due").on(table.status, table.dueAt),
    check(
      "loans_status_valid",
      sql`${table.status} in ('open', 'closed', 'cancelled')`,
    ),
    check(
      "loans_due_after_issue",
      sql`${table.dueAt} is null or ${table.dueAt} >= ${table.issuedAt}`,
    ),
    check(
      "loans_closed_fields_consistent",
      sql`(${table.status} = 'closed' and ${table.closedAt} is not null and ${table.closedByUserId} is not null)
        or (${table.status} != 'closed' and ${table.closedAt} is null and ${table.closedByUserId} is null)`,
    ),
    check("loans_version_positive", sql`${table.version} > 0`),
  ],
);

export const loanItems = sqliteTable(
  "loan_items",
  {
    id: text("id").primaryKey(),
    loanId: text("loan_id")
      .notNull()
      .references(() => loans.id, { onDelete: "restrict", onUpdate: "cascade" }),
    materialId: text("material_id")
      .notNull()
      .references(() => materials.id, { onDelete: "restrict", onUpdate: "cascade" }),
    sourceLocationId: text("source_location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    condition: text("condition", { enum: holdingConditions })
      .notNull()
      .default("unspecified"),
    quantityIssued: integer("quantity_issued").notNull(),
    quantityReturned: integer("quantity_returned").notNull().default(0),
    notes: text("notes").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_loan_items_loan_material").on(table.loanId, table.materialId),
    index("idx_loan_items_material_loan").on(table.materialId, table.loanId),
    check(
      "loan_items_condition_valid",
      sql`${table.condition} in ('unspecified', 'good', 'worn', 'damaged')`,
    ),
    check("loan_items_quantity_issued_positive", sql`${table.quantityIssued} > 0`),
    check(
      "loan_items_quantity_returned_valid",
      sql`${table.quantityReturned} >= 0 and ${table.quantityReturned} <= ${table.quantityIssued}`,
    ),
  ],
);

export const inventoryTransactions = sqliteTable(
  "inventory_transactions",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull(),
    kind: text("kind", { enum: inventoryTransactionKinds }).notNull(),
    occurredAt: text("occurred_at").notNull(),
    documentNumber: text("document_number"),
    reason: text("reason"),
    notes: text("notes").notNull().default(""),
    loanId: text("loan_id").references(() => loans.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    reversalOfId: text("reversal_of_id").references(
      (): AnySQLiteColumn => inventoryTransactions.id,
      { onDelete: "restrict", onUpdate: "cascade" },
    ),
    status: text("status", { enum: inventoryTransactionStatuses })
      .notNull()
      .default("posted"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_inventory_transactions_request_id").on(table.requestId),
    uniqueIndex("idx_inventory_transactions_reversal_of").on(table.reversalOfId),
    index("idx_inventory_transactions_kind_occurred").on(table.kind, table.occurredAt),
    index("idx_inventory_transactions_loan_occurred").on(table.loanId, table.occurredAt),
    index("idx_inventory_transactions_actor_occurred").on(
      table.actorUserId,
      table.occurredAt,
    ),
    check(
      "inventory_transactions_kind_valid",
      sql`${table.kind} in ('receipt', 'transfer', 'writeoff', 'stock_count', 'loan_issue', 'loan_return', 'reversal', 'import')`,
    ),
    check(
      "inventory_transactions_status_valid",
      sql`${table.status} in ('posted', 'reversed')`,
    ),
    check(
      "inventory_transactions_reversal_consistent",
      sql`(${table.kind} = 'reversal' and ${table.reversalOfId} is not null)
        or (${table.kind} != 'reversal' and ${table.reversalOfId} is null)`,
    ),
    check(
      "inventory_transactions_loan_consistent",
      sql`${table.kind} not in ('loan_issue', 'loan_return') or ${table.loanId} is not null`,
    ),
  ],
);

/**
 * Signed per-location ledger lines. Transfers use a negative source line and a
 * positive destination line; stock counts may use a zero delta to record a
 * verified unchanged quantity.
 */
export const inventoryTransactionLines = sqliteTable(
  "inventory_transaction_lines",
  {
    id: text("id").primaryKey(),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => inventoryTransactions.id, {
        onDelete: "restrict",
        onUpdate: "cascade",
      }),
    materialId: text("material_id")
      .notNull()
      .references(() => materials.id, { onDelete: "restrict", onUpdate: "cascade" }),
    locationId: text("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    condition: text("condition", { enum: holdingConditions })
      .notNull()
      .default("unspecified"),
    quantityDelta: integer("quantity_delta").notNull(),
    quantityBefore: integer("quantity_before").notNull(),
    quantityAfter: integer("quantity_after").notNull(),
    countedQuantity: integer("counted_quantity"),
    loanItemId: text("loan_item_id").references(() => loanItems.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_inventory_lines_transaction").on(table.transactionId),
    index("idx_inventory_lines_material_transaction").on(
      table.materialId,
      table.transactionId,
    ),
    index("idx_inventory_lines_location_transaction").on(
      table.locationId,
      table.transactionId,
    ),
    index("idx_inventory_lines_loan_item").on(table.loanItemId),
    check(
      "inventory_lines_condition_valid",
      sql`${table.condition} in ('unspecified', 'good', 'worn', 'damaged')`,
    ),
    check(
      "inventory_lines_quantities_nonnegative",
      sql`${table.quantityBefore} >= 0 and ${table.quantityAfter} >= 0`,
    ),
    check(
      "inventory_lines_delta_balanced",
      sql`${table.quantityAfter} = ${table.quantityBefore} + ${table.quantityDelta}`,
    ),
    check(
      "inventory_lines_zero_delta_is_count",
      sql`${table.quantityDelta} != 0 or ${table.countedQuantity} is not null`,
    ),
    check(
      "inventory_lines_counted_quantity_valid",
      sql`${table.countedQuantity} is null or (
        ${table.countedQuantity} >= 0 and ${table.countedQuantity} = ${table.quantityAfter}
      )`,
    ),
  ],
);

/** Weekly opening hours in Europe/Kyiv. Missing rows use the runtime defaults. */
export const visitScheduleHours = sqliteTable(
  "visit_schedule_hours",
  {
    weekday: integer("weekday").primaryKey(),
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    status: text("status", { enum: visitHourStatuses }).notNull().default("active"),
    version: integer("version").notNull().default(1),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("visit_hours_weekday_valid", sql`${table.weekday} between 1 and 7`),
    check(
      "visit_hours_time_valid",
      sql`${table.startTime} glob '[0-9][0-9]:[0-5][0-9]'
        and ${table.endTime} glob '[0-9][0-9]:[0-5][0-9]'
        and cast(substr(${table.startTime}, 1, 2) as integer) between 0 and 23
        and cast(substr(${table.endTime}, 1, 2) as integer) between 0 and 23
        and cast(substr(${table.startTime}, 4, 2) as integer) % 5 = 0
        and cast(substr(${table.endTime}, 4, 2) as integer) % 5 = 0
        and ${table.startTime} < ${table.endTime}`,
    ),
    check(
      "visit_hours_status_valid",
      sql`${table.status} in ('active', 'inactive')`,
    ),
    check("visit_hours_version_positive", sql`${table.version} > 0`),
  ],
);

/** Librarian-managed exceptions to weekly hours. */
export const visitScheduleClosures = sqliteTable(
  "visit_schedule_closures",
  {
    id: text("id").primaryKey(),
    visitDate: text("visit_date").notNull(),
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    status: text("status", { enum: visitClosureStatuses }).notNull().default("active"),
    reason: text("reason").notNull().default(""),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    cancelledByUserId: text("cancelled_by_user_id").references(() => users.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    cancelledAt: text("cancelled_at"),
  },
  (table) => [
    index("idx_visit_closures_date_status_time").on(
      table.visitDate,
      table.status,
      table.startTime,
    ),
    check(
      "visit_closures_date_valid",
      sql`${table.visitDate} glob '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
        and date(${table.visitDate}, '+0 days') = ${table.visitDate}`,
    ),
    check(
      "visit_closures_time_valid",
      sql`${table.startTime} glob '[0-9][0-9]:[0-5][0-9]'
        and ${table.endTime} glob '[0-9][0-9]:[0-5][0-9]'
        and cast(substr(${table.startTime}, 1, 2) as integer) between 0 and 23
        and cast(substr(${table.endTime}, 1, 2) as integer) between 0 and 23
        and cast(substr(${table.startTime}, 4, 2) as integer) % 5 = 0
        and cast(substr(${table.endTime}, 4, 2) as integer) % 5 = 0
        and ${table.startTime} < ${table.endTime}`,
    ),
    check(
      "visit_closures_status_valid",
      sql`${table.status} in ('active', 'cancelled')`,
    ),
    check(
      "visit_closures_cancel_consistent",
      sql`(${table.status} = 'active' and ${table.cancelledAt} is null and ${table.cancelledByUserId} is null)
        or (${table.status} = 'cancelled' and ${table.cancelledAt} is not null and ${table.cancelledByUserId} is not null)`,
    ),
    check("visit_closures_version_positive", sql`${table.version} > 0`),
  ],
);

/** Verified-teacher, unverified-guest, and legacy visit bookings with explicit ownership. */
export const visitBookings = sqliteTable(
  "visit_bookings",
  {
    id: text("id").primaryKey(),
    ownerKind: text("owner_kind", { enum: visitBookingOwnerKinds }).notNull().default("teacher"),
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    ownerAuthUserId: text("owner_auth_user_id"),
    ownerEmail: text("owner_email"),
    guestOwnerId: text("guest_owner_id").references(() => visitGuestSessions.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    selectedTeacherUserId: text("selected_teacher_user_id").references(() => users.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    surname: text("surname").notNull(),
    classYearId: text("class_year_id").references(() => classYears.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    classLabel: text("class_label"),
    visitDate: text("visit_date").notNull(),
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    publicDisplayConsent: integer("public_display_consent", { mode: "boolean" }).notNull().default(false),
    publicTeacherNameConsent: integer("public_teacher_name_consent", { mode: "boolean" }).notNull().default(false),
    purpose: text("purpose").notNull().default(""),
    status: text("status", { enum: visitBookingStatuses }).notNull().default("active"),
    cancelReason: text("cancel_reason").notNull().default(""),
    cancelledByAuthUserId: text("cancelled_by_auth_user_id"),
    cancelledByUserId: text("cancelled_by_user_id").references(() => users.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    cancelledByGuestOwnerId: text("cancelled_by_guest_owner_id").references(() => visitGuestSessions.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    lastMutationRequestId: text("last_mutation_request_id"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    cancelledAt: text("cancelled_at"),
  },
  (table) => [
    index("idx_visit_bookings_date_status_time").on(
      table.visitDate,
      table.status,
      table.startTime,
    ),
    index("idx_visit_bookings_owner_status_date").on(
      table.ownerAuthUserId,
      table.status,
      table.visitDate,
    ),
    index("idx_visit_bookings_owner_user_status_date").on(
      table.ownerUserId,
      table.status,
      table.visitDate,
    ),
    index("idx_visit_bookings_guest_owner_status_date").on(
      table.guestOwnerId,
      table.status,
      table.visitDate,
    ),
    index("idx_visit_bookings_selected_teacher_date").on(
      table.selectedTeacherUserId,
      table.visitDate,
    ),
    index("idx_visit_bookings_class_date").on(table.classYearId, table.visitDate),
    check(
      "visit_bookings_owner_valid",
      sql`(${table.ownerKind} = 'teacher' and ${table.ownerUserId} is not null
          and ${table.ownerAuthUserId} is null and ${table.ownerEmail} is null
          and ${table.guestOwnerId} is null and ${table.selectedTeacherUserId} is null)
        or (${table.ownerKind} = 'guest' and ${table.ownerUserId} is null
          and ${table.ownerAuthUserId} is null and ${table.ownerEmail} is null
          and ${table.guestOwnerId} is not null and ${table.selectedTeacherUserId} is not null)
        or (${table.ownerKind} = 'legacy' and ${table.ownerUserId} is null
          and length(trim(${table.ownerAuthUserId})) > 0 and length(trim(${table.ownerEmail})) > 0
          and ${table.guestOwnerId} is null and ${table.selectedTeacherUserId} is null)`,
    ),
    check("visit_bookings_surname_length", sql`length(trim(${table.surname})) between 2 and 80`),
    check(
      "visit_bookings_date_valid",
      sql`${table.visitDate} glob '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
        and date(${table.visitDate}, '+0 days') = ${table.visitDate}`,
    ),
    check(
      "visit_bookings_time_valid",
      sql`${table.startTime} glob '[0-9][0-9]:[0-5][0-9]'
        and ${table.endTime} glob '[0-9][0-9]:[0-5][0-9]'
        and cast(substr(${table.startTime}, 1, 2) as integer) between 0 and 23
        and cast(substr(${table.endTime}, 1, 2) as integer) between 0 and 23
        and cast(substr(${table.startTime}, 4, 2) as integer) % 5 = 0
        and cast(substr(${table.endTime}, 4, 2) as integer) % 5 = 0
        and ${table.startTime} < ${table.endTime}`,
    ),
    check(
      "visit_bookings_status_valid",
      sql`${table.status} in ('active', 'cancelled')`,
    ),
    check(
      "visit_bookings_public_display_consent_valid",
      sql`${table.publicDisplayConsent} in (0, 1)`,
    ),
    check(
      "visit_bookings_public_teacher_name_consent_valid",
      sql`${table.publicTeacherNameConsent} in (0, 1)`,
    ),
    check(
      "visit_bookings_cancel_consistent",
      sql`(${table.status} = 'active' and ${table.cancelledAt} is null
          and ${table.cancelledByAuthUserId} is null and ${table.cancelledByUserId} is null
          and ${table.cancelledByGuestOwnerId} is null)
        or (${table.status} = 'cancelled' and ${table.cancelledAt} is not null
          and ((${table.cancelledByAuthUserId} is not null and ${table.cancelledByUserId} is null
              and ${table.cancelledByGuestOwnerId} is null)
            or (${table.cancelledByAuthUserId} is null and ${table.cancelledByUserId} is not null
              and ${table.cancelledByGuestOwnerId} is null)
            or (${table.cancelledByAuthUserId} is null and ${table.cancelledByUserId} is null
              and ${table.cancelledByGuestOwnerId} is not null)))`,
    ),
    check("visit_bookings_version_positive", sql`${table.version} > 0`),
    check("visit_bookings_mutation_request_valid", sql`${table.lastMutationRequestId} is null or length(${table.lastMutationRequestId}) = 36`),
  ],
);

/** One row per five-minute Kyiv-local segment; the primary key is the race guard. */
export const visitSlotClaims = sqliteTable(
  "visit_slot_claims",
  {
    segmentKey: text("segment_key").primaryKey(),
    bookingId: text("booking_id")
      .references(() => visitBookings.id, { onDelete: "restrict", onUpdate: "cascade" }),
    closureId: text("closure_id")
      .references(() => visitScheduleClosures.id, { onDelete: "restrict", onUpdate: "cascade" }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_visit_slot_claims_booking").on(table.bookingId),
    index("idx_visit_slot_claims_closure").on(table.closureId),
    check(
      "visit_slot_claims_exactly_one_owner",
      sql`(${table.bookingId} is not null and ${table.closureId} is null)
        or (${table.bookingId} is null and ${table.closureId} is not null)`,
    ),
    check(
      "visit_slot_claims_key_valid",
      sql`length(${table.segmentKey}) = 16
        and substr(${table.segmentKey}, 1, 10) glob '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
        and substr(${table.segmentKey}, 11, 1) = 'T'
        and substr(${table.segmentKey}, 12, 5) glob '[0-9][0-9]:[0-5][0-9]'
        and date(substr(${table.segmentKey}, 1, 10), '+0 days') = substr(${table.segmentKey}, 1, 10)
        and cast(substr(${table.segmentKey}, 12, 2) as integer) between 0 and 23
        and cast(substr(${table.segmentKey}, 15, 2) as integer) % 5 = 0`,
    ),
  ],
);

/** Idempotency receipts for SIWC teachers, who need not exist in `users`. */
export const visitMutationCommands = sqliteTable(
  "visit_mutation_commands",
  {
    id: text("id").primaryKey(),
    ownerAuthUserId: text("owner_auth_user_id").notNull(),
    kind: text("kind").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status", { enum: mutationCommandStatuses }).notNull().default("processing"),
    targetId: text("target_id"),
    resultJson: text("result_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("idx_visit_commands_owner_created").on(table.ownerAuthUserId, table.createdAt),
    check("visit_commands_owner_not_blank", sql`length(trim(${table.ownerAuthUserId})) > 0`),
    check("visit_commands_kind_not_blank", sql`length(trim(${table.kind})) > 0`),
    check(
      "visit_commands_hash_valid",
      sql`length(${table.requestHash}) = 64 and lower(${table.requestHash}) not glob '*[^0-9a-f]*'`,
    ),
    check(
      "visit_commands_status_valid",
      sql`${table.status} in ('processing', 'completed', 'failed')`,
    ),
    check(
      "visit_commands_result_valid",
      sql`${table.resultJson} is null or json_valid(${table.resultJson})`,
    ),
    check(
      "visit_commands_completion_consistent",
      sql`(${table.status} = 'processing' and ${table.completedAt} is null)
        or (${table.status} in ('completed', 'failed') and ${table.completedAt} is not null)`,
    ),
  ],
);

/** Idempotency receipt for all direct D1 mutations, including optional legacy drafts. */
export const mutationCommands = sqliteTable(
  "mutation_commands",
  {
    id: text("id").primaryKey(),
    draftId: text("draft_id").references(() => librarianDrafts.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    kind: text("kind").notNull(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    status: text("status", { enum: mutationCommandStatuses })
      .notNull()
      .default("processing"),
    targetType: text("target_type"),
    targetId: text("target_id"),
    requestHash: text("request_hash").notNull(),
    resultJson: text("result_json"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    uniqueIndex("idx_mutation_commands_draft").on(table.draftId),
    index("idx_mutation_commands_status_updated").on(table.status, table.updatedAt),
    index("idx_mutation_commands_actor_created").on(table.actorUserId, table.createdAt),
    index("idx_mutation_commands_target").on(table.targetType, table.targetId),
    check("mutation_commands_kind_not_blank", sql`length(trim(${table.kind})) > 0`),
    check(
      "mutation_commands_status_valid",
      sql`${table.status} in ('processing', 'completed', 'failed')`,
    ),
    check(
      "mutation_commands_request_hash_valid",
      sql`length(${table.requestHash}) = 64 and lower(${table.requestHash}) not glob '*[^0-9a-f]*'`,
    ),
    check(
      "mutation_commands_result_json_valid",
      sql`${table.resultJson} is null or json_valid(${table.resultJson})`,
    ),
    check(
      "mutation_commands_completion_consistent",
      sql`(${table.status} = 'processing' and ${table.completedAt} is null)
        or (${table.status} in ('completed', 'failed') and ${table.completedAt} is not null)`,
    ),
  ],
);

/** Append-only cross-domain history. Domain deletes are represented as status changes. */
export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id").references(() => users.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    actorEmail: text("actor_email").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    requestId: text("request_id"),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
    metadataJson: text("metadata_json"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_audit_events_entity_created").on(
      table.entityType,
      table.entityId,
      table.createdAt,
    ),
    index("idx_audit_events_actor_created").on(table.actorUserId, table.createdAt),
    index("idx_audit_events_request").on(table.requestId),
    check("audit_events_action_not_blank", sql`length(trim(${table.action})) > 0`),
    check("audit_events_entity_type_not_blank", sql`length(trim(${table.entityType})) > 0`),
    check("audit_events_entity_id_not_blank", sql`length(trim(${table.entityId})) > 0`),
    check(
      "audit_events_before_json_valid",
      sql`${table.beforeJson} is null or json_valid(${table.beforeJson})`,
    ),
    check(
      "audit_events_after_json_valid",
      sql`${table.afterJson} is null or json_valid(${table.afterJson})`,
    ),
    check(
      "audit_events_metadata_json_valid",
      sql`${table.metadataJson} is null or json_valid(${table.metadataJson})`,
    ),
  ],
);

/** Teacher request workflow. Preparation reserves stock; only physical issue creates a loan. */
export const materialRequests = sqliteTable(
  "material_requests",
  {
    id: text("id").primaryKey(),
    teacherUserId: text("teacher_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    status: text("status", { enum: materialRequestStatuses }).notNull().default("submitted"),
    teacherNotes: text("teacher_notes").notNull().default(""),
    librarianNote: text("librarian_note").notNull().default(""),
    rejectionReason: text("rejection_reason").notNull().default(""),
    pickupLocationId: text("pickup_location_id").references(() => locations.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    resultingLoanId: text("resulting_loan_id").references(() => loans.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    dueAt: text("due_at"),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    cancelledByUserId: text("cancelled_by_user_id").references(() => users.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    version: integer("version").notNull().default(1),
    submittedAt: text("submitted_at").notNull(),
    readyAt: text("ready_at"),
    completedAt: text("completed_at"),
    rejectedAt: text("rejected_at"),
    cancelledAt: text("cancelled_at"),
    librarianHiddenAt: text("librarian_hidden_at"),
    librarianHiddenByUserId: text("librarian_hidden_by_user_id").references(() => users.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_material_requests_teacher_created").on(table.teacherUserId, table.createdAt),
    index("idx_material_requests_status_created").on(table.status, table.createdAt),
    index("idx_material_requests_librarian_hidden").on(table.librarianHiddenAt, table.status, table.createdAt),
    uniqueIndex("idx_material_requests_resulting_loan").on(table.resultingLoanId),
    check("material_requests_status_valid", sql`${table.status} in ('submitted','in_review','ready','partially_ready','completed','rejected','cancelled')`),
    check("material_requests_version_positive", sql`${table.version} > 0`),
    check("material_requests_terminal_times", sql`
      (${table.status} not in ('ready','partially_ready','completed') or (${table.readyAt} is not null and ${table.pickupLocationId} is not null))
      and (${table.status} != 'completed' or ${table.completedAt} is not null)
      and (${table.status} != 'rejected' or ${table.rejectedAt} is not null)
      and (${table.status} != 'cancelled' or ${table.cancelledAt} is not null)`),
  ],
);

export const materialRequestItems = sqliteTable(
  "material_request_items",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id")
      .notNull()
      .references(() => materialRequests.id, { onDelete: "cascade", onUpdate: "cascade" }),
    materialId: text("material_id")
      .notNull()
      .references(() => materials.id, { onDelete: "restrict", onUpdate: "cascade" }),
    titleSnapshot: text("title_snapshot").notNull(),
    authorSnapshot: text("author_snapshot").notNull().default(""),
    requestedQuantity: integer("requested_quantity").notNull(),
    approvedQuantity: integer("approved_quantity"),
    fulfilledQuantity: integer("fulfilled_quantity").notNull().default(0),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_material_request_items_request_material").on(table.requestId, table.materialId),
    index("idx_material_request_items_material_request").on(table.materialId, table.requestId),
    check("material_request_items_title_not_blank", sql`length(trim(${table.titleSnapshot})) > 0`),
    check("material_request_items_quantity_valid", sql`${table.requestedQuantity} > 0
      and (${table.approvedQuantity} is null or (${table.approvedQuantity} >= 0 and ${table.approvedQuantity} <= ${table.requestedQuantity}))
      and ${table.fulfilledQuantity} >= 0
      and (${table.approvedQuantity} is null or ${table.fulfilledQuantity} <= ${table.approvedQuantity})`),
    check("material_request_items_sort_order_nonnegative", sql`${table.sortOrder} >= 0`),
  ],
);

/**
 * Physical copies put aside for a teacher request. Holdings remain physical
 * until issue; the active amount is reserved - issued - released.
 */
export const materialRequestReservations = sqliteTable(
  "material_request_reservations",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id")
      .notNull()
      .references(() => materialRequests.id, { onDelete: "cascade", onUpdate: "cascade" }),
    requestItemId: text("request_item_id")
      .notNull()
      .references(() => materialRequestItems.id, { onDelete: "cascade", onUpdate: "cascade" }),
    materialId: text("material_id")
      .notNull()
      .references(() => materials.id, { onDelete: "restrict", onUpdate: "cascade" }),
    sourceLocationId: text("source_location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    condition: text("condition", { enum: holdingConditions }).notNull(),
    reservedQuantity: integer("reserved_quantity").notNull(),
    issuedQuantity: integer("issued_quantity").notNull().default(0),
    releasedQuantity: integer("released_quantity").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_request_reservations_request_item").on(table.requestId, table.requestItemId),
    index("idx_request_reservations_stock").on(
      table.materialId,
      table.sourceLocationId,
      table.condition,
    ),
    check(
      "material_request_reservations_condition_valid",
      sql`${table.condition} in ('unspecified', 'good', 'worn', 'damaged')`,
    ),
    check(
      "material_request_reservations_quantities_valid",
      sql`${table.reservedQuantity} > 0
        and ${table.issuedQuantity} >= 0
        and ${table.releasedQuantity} >= 0
        and ${table.issuedQuantity} + ${table.releasedQuantity} <= ${table.reservedQuantity}`,
    ),
  ],
);

/** Immutable request history; metadata must never contain credentials or session tokens. */
export const materialRequestEvents = sqliteTable(
  "material_request_events",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id")
      .notNull()
      .references(() => materialRequests.id, { onDelete: "cascade", onUpdate: "cascade" }),
    actorUserId: text("actor_user_id").references(() => users.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    actorKind: text("actor_kind", { enum: materialRequestActorKinds }).notNull(),
    kind: text("kind").notNull(),
    fromStatus: text("from_status", { enum: materialRequestStatuses }),
    toStatus: text("to_status", { enum: materialRequestStatuses }).notNull(),
    metadataJson: text("metadata_json"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_material_request_events_request_created").on(table.requestId, table.createdAt),
    check("material_request_events_actor_kind_valid", sql`${table.actorKind} in ('teacher','librarian','system')`),
    check("material_request_events_actor_consistent", sql`(${table.actorKind} = 'system' and ${table.actorUserId} is null)
      or (${table.actorKind} in ('teacher','librarian') and ${table.actorUserId} is not null)`),
    check("material_request_events_kind_not_blank", sql`length(trim(${table.kind})) > 0`),
    check("material_request_events_metadata_valid", sql`${table.metadataJson} is null or json_valid(${table.metadataJson})`),
  ],
);

/** Excel provenance for acquisition imports. The original workbook is not retained. */
export const acquisitionImportBatches = sqliteTable(
  "acquisition_import_batches",
  {
    id: text("id").primaryKey(),
    workbookSha256: text("workbook_sha256").notNull(),
    fileName: text("file_name").notNull(),
    rowCount: integer("row_count").notNull(),
    importedCount: integer("imported_count").notNull(),
    status: text("status", { enum: acquisitionImportStatuses }).notNull().default("completed"),
    resultJson: text("result_json").notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_acquisition_import_batches_sha256").on(table.workbookSha256),
    index("idx_acquisition_import_batches_created").on(table.createdAt),
    check("acquisition_import_batches_hash_valid", sql`length(${table.workbookSha256}) = 64`),
    check("acquisition_import_batches_file_not_blank", sql`length(trim(${table.fileName})) > 0`),
    check("acquisition_import_batches_counts_valid", sql`${table.rowCount} > 0 and ${table.importedCount} >= 0 and ${table.importedCount} <= ${table.rowCount}`),
    check("acquisition_import_batches_status_valid", sql`${table.status} = 'completed'`),
    check("acquisition_import_batches_result_valid", sql`json_valid(${table.resultJson})`),
  ],
);

/** Requests to acquire new copies or new titles. This never reserves or issues current stock. */
export const acquisitionRequests = sqliteTable(
  "acquisition_requests",
  {
    id: text("id").primaryKey(),
    publicNumber: text("public_number").notNull(),
    submissionKey: text("submission_key").notNull(),
    submissionHash: text("submission_hash").notNull(),
    requesterKind: text("requester_kind", { enum: acquisitionRequesterKinds }).notNull(),
    teacherUserId: text("teacher_user_id").references(() => users.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    requesterName: text("requester_name").notNull(),
    requesterClassYearId: text("requester_class_year_id").references(() => classYears.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    requesterClassName: text("requester_class_name").notNull().default(""),
    category: text("category", { enum: acquisitionCategories }).notNull(),
    sourceKind: text("source_kind", { enum: acquisitionSourceKinds }).notNull(),
    literatureKind: text("literature_kind", { enum: acquisitionLiteratureKinds }).notNull().default("none"),
    materialId: text("material_id").references(() => materials.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    title: text("title").notNull(),
    author: text("author").notNull(),
    publicationYear: integer("publication_year"),
    requestedQuantity: integer("requested_quantity").notNull().default(1),
    approvedQuantity: integer("approved_quantity"),
    orderedQuantity: integer("ordered_quantity").notNull().default(0),
    receivedQuantity: integer("received_quantity").notNull().default(0),
    sourceUrl: text("source_url").notNull(),
    subject: text("subject").notNull().default(""),
    targetClass: text("target_class").notNull().default(""),
    requesterNote: text("requester_note").notNull().default(""),
    librarianNote: text("librarian_note").notNull().default(""),
    clarificationMessage: text("clarification_message").notNull().default(""),
    rejectionReason: text("rejection_reason").notNull().default(""),
    status: text("status", { enum: acquisitionRequestStatuses }).notNull().default("submitted"),
    duplicateKey: text("duplicate_key").notNull(),
    academicYearId: text("academic_year_id")
      .notNull()
      .references(() => academicYears.id, {
        onDelete: "restrict",
        onUpdate: "cascade",
      }),
    academicYearLabel: text("academic_year_label").notNull().default(""),
    importBatchId: text("import_batch_id").references(() => acquisitionImportBatches.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    sourceImportKey: text("source_import_key"),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    version: integer("version").notNull().default(1),
    submittedAt: text("submitted_at").notNull(),
    reviewedAt: text("reviewed_at"),
    approvedAt: text("approved_at"),
    orderedAt: text("ordered_at"),
    receivedAt: text("received_at"),
    rejectedAt: text("rejected_at"),
    cancelledAt: text("cancelled_at"),
    teacherHiddenAt: text("teacher_hidden_at"),
    librarianHiddenAt: text("librarian_hidden_at"),
    librarianHiddenByUserId: text("librarian_hidden_by_user_id").references(() => users.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_acquisition_requests_public_number").on(table.publicNumber),
    uniqueIndex("idx_acquisition_requests_submission_key").on(table.submissionKey),
    uniqueIndex("idx_acquisition_requests_source_import_key").on(table.sourceImportKey),
    index("idx_acquisition_requests_teacher_created").on(table.teacherUserId, table.createdAt),
    index("idx_acquisition_requests_status_created").on(table.status, table.createdAt),
    index("idx_acquisition_requests_duplicate_status").on(table.academicYearId, table.duplicateKey, table.status),
    index("idx_acquisition_requests_year_status").on(table.academicYearId, table.status),
    index("idx_acquisition_requests_librarian_hidden").on(table.librarianHiddenAt, table.status, table.createdAt),
    check("acquisition_requests_requester_valid", sql`
      (${table.requesterKind} = 'teacher' and ${table.teacherUserId} is not null and ${table.requesterClassYearId} is null)
      or (${table.requesterKind} = 'student' and ${table.teacherUserId} is null and ${table.requesterClassYearId} is not null and length(trim(${table.requesterClassName})) > 0)`),
    check("acquisition_requests_category_valid", sql`${table.category} in ('educational','literature')`),
    check("acquisition_requests_source_valid", sql`${table.sourceKind} in ('catalog','manual') and (${table.sourceKind} != 'catalog' or ${table.materialId} is not null)`),
    check("acquisition_requests_literature_valid", sql`
      (${table.category} = 'educational' and ${table.literatureKind} = 'none')
      or (${table.category} = 'literature' and ${table.literatureKind} in ('fiction','science','popular_science','other'))`),
    check("acquisition_requests_student_literature", sql`${table.requesterKind} != 'student' or ${table.category} = 'literature'`),
    check("acquisition_requests_text_valid", sql`
      length(trim(${table.publicNumber})) > 0 and length(trim(${table.submissionKey})) > 0
      and length(${table.submissionHash}) = 64 and length(trim(${table.requesterName})) > 0
      and length(trim(${table.title})) > 0
      and (${table.requesterKind} = 'student' or length(trim(${table.author})) > 0)
      and (${table.requesterKind} = 'student' or (${table.category} = 'educational' and ${table.sourceKind} = 'catalog') or length(trim(${table.sourceUrl})) > 0)
      and length(trim(${table.duplicateKey})) > 0
      and length(trim(${table.academicYearLabel})) > 0`),
    check("acquisition_requests_year_valid", sql`
      (${table.requesterKind} = 'student' and (${table.publicationYear} is null or ${table.publicationYear} between 1000 and 2100))
      or (${table.requesterKind} = 'teacher' and ${table.publicationYear} is not null and ${table.publicationYear} between 1000 and 2100)`),
    check("acquisition_requests_quantities_valid", sql`
      ${table.requestedQuantity} between 1 and 1000
      and (${table.approvedQuantity} is null or ${table.approvedQuantity} between 0 and 1000)
      and ${table.orderedQuantity} between 0 and 1000
      and ${table.receivedQuantity} between 0 and 1000
      and ${table.orderedQuantity} <= coalesce(${table.approvedQuantity}, ${table.requestedQuantity})
      and ${table.receivedQuantity} <= ${table.orderedQuantity}`),
    check("acquisition_requests_status_valid", sql`${table.status} in ('submitted','in_review','clarification','approved','planned','ordered','partially_received','received','rejected','cancelled')`),
    check("acquisition_requests_terminal_consistent", sql`
      (${table.status} = 'received' and ${table.receivedAt} is not null and ${table.receivedQuantity} > 0)
      or (${table.status} = 'rejected' and ${table.rejectedAt} is not null and length(trim(${table.rejectionReason})) > 0)
      or (${table.status} = 'cancelled' and ${table.cancelledAt} is not null)
      or (${table.status} not in ('received','rejected','cancelled') and ${table.receivedAt} is null and ${table.rejectedAt} is null and ${table.cancelledAt} is null)`),
    check("acquisition_requests_version_positive", sql`${table.version} > 0`),
  ],
);

/** Immutable history for every acquisition request. */
export const acquisitionRequestEvents = sqliteTable(
  "acquisition_request_events",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id")
      .notNull()
      .references(() => acquisitionRequests.id, { onDelete: "cascade", onUpdate: "cascade" }),
    actorUserId: text("actor_user_id").references(() => users.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    actorKind: text("actor_kind", { enum: acquisitionActorKinds }).notNull(),
    kind: text("kind").notNull(),
    fromStatus: text("from_status", { enum: acquisitionRequestStatuses }),
    toStatus: text("to_status", { enum: acquisitionRequestStatuses }).notNull(),
    metadataJson: text("metadata_json"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_acquisition_request_events_request_created").on(table.requestId, table.createdAt),
    check("acquisition_request_events_actor_valid", sql`${table.actorKind} in ('teacher','student','librarian','import','system')`),
    check("acquisition_request_events_actor_consistent", sql`
      (${table.actorKind} in ('student','system') and ${table.actorUserId} is null)
      or (${table.actorKind} in ('teacher','librarian','import') and ${table.actorUserId} is not null)`),
    check("acquisition_request_events_kind_not_blank", sql`length(trim(${table.kind})) > 0`),
    check("acquisition_request_events_metadata_valid", sql`${table.metadataJson} is null or json_valid(${table.metadataJson})`),
  ],
);

/** Receipt lines allocated to procurement requests. Stock is posted by the existing receipt workflow. */
export const acquisitionReceiptAllocations = sqliteTable(
  "acquisition_receipt_allocations",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id")
      .notNull()
      .references(() => acquisitionRequests.id, { onDelete: "restrict", onUpdate: "cascade" }),
    inventoryTransactionLineId: text("inventory_transaction_line_id")
      .notNull()
      .references(() => inventoryTransactionLines.id, { onDelete: "restrict", onUpdate: "cascade" }),
    allocatedQuantity: integer("allocated_quantity").notNull(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_acquisition_receipt_request_line").on(table.requestId, table.inventoryTransactionLineId),
    index("idx_acquisition_receipt_line").on(table.inventoryTransactionLineId),
    check("acquisition_receipt_allocated_positive", sql`${table.allocatedQuantity} > 0`),
  ],
);

/** Privacy-preserving rate limit for anonymous student submissions. */
export const acquisitionPublicRateLimits = sqliteTable(
  "acquisition_public_rate_limits",
  {
    scopeHash: text("scope_hash").primaryKey(),
    attempts: integer("attempts").notNull().default(0),
    windowStartedAt: text("window_started_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_acquisition_public_limits_updated").on(table.updatedAt),
    check("acquisition_public_limits_hash_valid", sql`length(${table.scopeHash}) = 64`),
    check("acquisition_public_limits_attempts_valid", sql`${table.attempts} >= 0`),
  ],
);

/** In-app notifications for authenticated teachers. */
export const portalNotifications = sqliteTable(
  "portal_notifications",
  {
    id: text("id").primaryKey(),
    teacherUserId: text("teacher_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    dedupeKey: text("dedupe_key").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    readAt: text("read_at"),
    deletedAt: text("deleted_at"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_portal_notifications_dedupe").on(table.dedupeKey),
    index("idx_portal_notifications_teacher_read_created").on(table.teacherUserId, table.readAt, table.createdAt),
    check("portal_notifications_dedupe_not_blank", sql`length(trim(${table.dedupeKey})) > 0`),
    check("portal_notifications_type_not_blank", sql`length(trim(${table.type})) > 0`),
    check("portal_notifications_title_not_blank", sql`length(trim(${table.title})) > 0`),
    check("portal_notifications_entity_not_blank", sql`length(trim(${table.entityType})) > 0 and length(trim(${table.entityId})) > 0`),
    check("portal_notifications_version_positive", sql`${table.version} > 0`),
  ],
);

const telegramConnectionStatuses = ["active", "disabled", "blocked"] as const;
const telegramDeliveryStatuses = ["pending", "processing", "retry", "sent", "dead"] as const;
const telegramNotificationCategories = ["orders", "visits", "system"] as const;
const telegramTeacherActivationKinds = ["generic", "personal"] as const;

/** Private Telegram chats explicitly linked by a signed-in library user. */
export const telegramConnections = sqliteTable(
  "telegram_connections",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    telegramUserId: text("telegram_user_id").notNull(),
    chatId: text("chat_id").notNull(),
    username: text("username"),
    status: text("status", { enum: telegramConnectionStatuses }).notNull().default("active"),
    notifyOrders: integer("notify_orders", { mode: "boolean" }).notNull().default(true),
    notifyVisits: integer("notify_visits", { mode: "boolean" }).notNull().default(true),
    version: integer("version").notNull().default(1),
    linkedAt: text("linked_at").notNull(),
    disabledAt: text("disabled_at"),
    lastSuccessAt: text("last_success_at"),
    lastFailureAt: text("last_failure_at"),
    lastErrorCode: text("last_error_code"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_telegram_connections_user").on(table.telegramUserId),
    uniqueIndex("idx_telegram_connections_chat").on(table.chatId),
    index("idx_telegram_connections_status_user").on(table.status, table.userId),
    check("telegram_connections_user_id_not_blank", sql`length(trim(${table.telegramUserId})) > 0`),
    check("telegram_connections_chat_id_not_blank", sql`length(trim(${table.chatId})) > 0`),
    check("telegram_connections_status_valid", sql`${table.status} in ('active','disabled','blocked')`),
    check("telegram_connections_version_positive", sql`${table.version} > 0`),
    check(
      "telegram_connections_disabled_fields_consistent",
      sql`(${table.status}='active' and ${table.disabledAt} is null)
        or (${table.status}!='active' and ${table.disabledAt} is not null)`,
    ),
  ],
);

/** Short-lived, one-use Telegram deep-link tokens. Only their SHA-256 digest is stored. */
export const telegramLinkTokens = sqliteTable(
  "telegram_link_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
    consumedUpdateId: text("consumed_update_id"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_telegram_link_tokens_hash").on(table.tokenHash),
    index("idx_telegram_link_tokens_user_expiry").on(table.userId, table.expiresAt),
    check(
      "telegram_link_tokens_hash_valid",
      sql`length(${table.tokenHash}) = 64 and lower(${table.tokenHash}) not glob '*[^0-9a-f]*'`,
    ),
    check(
      "telegram_link_tokens_terminal_state",
      sql`not (${table.consumedAt} is not null and ${table.revokedAt} is not null)`,
    ),
    check(
      "telegram_link_tokens_consumption_consistent",
      sql`(${table.consumedAt} is null and ${table.consumedUpdateId} is null)
        or (${table.consumedAt} is not null and ${table.consumedUpdateId} is not null)`,
    ),
  ],
);

/**
 * Short-lived Telegram teacher activation grants.
 *
 * Generic grants are created only after an unlinked user sends /start in a
 * private bot chat. Personal grants are issued by a librarian, contain only a
 * random token in the deep link, and are bound to the first private Telegram
 * account that presents them. Plaintext tokens, access codes and PINs are
 * never stored here.
 */
export const telegramTeacherActivationInvites = sqliteTable(
  "telegram_teacher_activation_invites",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: telegramTeacherActivationKinds }).notNull(),
    teacherUserId: text("teacher_user_id").references(() => users.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    credentialVersion: integer("credential_version"),
    tokenHash: text("token_hash"),
    issuedByUserId: text("issued_by_user_id").references(() => users.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    requestId: text("request_id"),
    boundTelegramUserId: text("bound_telegram_user_id"),
    boundChatId: text("bound_chat_id"),
    boundUsername: text("bound_username"),
    boundUpdateId: text("bound_update_id"),
    presentedAt: text("presented_at"),
    expiresAt: text("expires_at").notNull(),
    consumedInitDataHash: text("consumed_init_data_hash"),
    consumedAt: text("consumed_at"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_telegram_teacher_activation_token").on(table.tokenHash),
    uniqueIndex("idx_telegram_teacher_activation_request").on(table.requestId),
    index("idx_telegram_teacher_activation_teacher_expiry").on(
      table.teacherUserId,
      table.expiresAt,
    ),
    index("idx_telegram_teacher_activation_bound_expiry").on(
      table.boundTelegramUserId,
      table.expiresAt,
      table.createdAt,
    ),
    check("telegram_teacher_activation_kind_valid", sql`${table.kind} in ('generic','personal')`),
    check(
      "telegram_teacher_activation_token_valid",
      sql`${table.tokenHash} is null or (length(${table.tokenHash}) = 64 and lower(${table.tokenHash}) not glob '*[^0-9a-f]*')`,
    ),
    check(
      "telegram_teacher_activation_receipt_valid",
      sql`${table.consumedInitDataHash} is null or (length(${table.consumedInitDataHash}) = 64 and lower(${table.consumedInitDataHash}) not glob '*[^0-9a-f]*')`,
    ),
    check(
      "telegram_teacher_activation_personal_shape",
      sql`(${table.kind}='generic' and ${table.teacherUserId} is null and ${table.credentialVersion} is null
          and ${table.tokenHash} is null and ${table.issuedByUserId} is null and ${table.requestId} is null)
        or (${table.kind}='personal' and ${table.teacherUserId} is not null
          and ${table.credentialVersion} > 0 and ${table.tokenHash} is not null
          and ${table.issuedByUserId} is not null and length(${table.requestId})=36)`,
    ),
    check(
      "telegram_teacher_activation_binding_consistent",
      sql`(${table.boundTelegramUserId} is null and ${table.boundChatId} is null
          and ${table.boundUpdateId} is null and ${table.presentedAt} is null)
        or (${table.boundTelegramUserId} is not null and ${table.boundChatId} is not null
          and ${table.boundUpdateId} is not null and ${table.presentedAt} is not null)`,
    ),
    check(
      "telegram_teacher_activation_terminal_state",
      sql`not (${table.consumedAt} is not null and ${table.revokedAt} is not null)`,
    ),
    check(
      "telegram_teacher_activation_consumption_consistent",
      sql`(${table.consumedAt} is null and ${table.consumedInitDataHash} is null)
        or (${table.consumedAt} is not null and ${table.consumedInitDataHash} is not null
          and ${table.boundTelegramUserId} is not null)`,
    ),
  ],
);

/** Durable at-least-once delivery queue for Telegram mirrors of site events. */
export const telegramDeliveryOutbox = sqliteTable(
  "telegram_delivery_outbox",
  {
    id: text("id").primaryKey(),
    recipientUserId: text("recipient_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    dedupeKey: text("dedupe_key").notNull(),
    category: text("category", { enum: telegramNotificationCategories }).notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    targetPath: text("target_path").notNull().default(""),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    status: text("status", { enum: telegramDeliveryStatuses }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: text("next_attempt_at").notNull(),
    leaseToken: text("lease_token"),
    leaseExpiresAt: text("lease_expires_at"),
    telegramMessageId: text("telegram_message_id"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    sentAt: text("sent_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_telegram_delivery_outbox_dedupe").on(table.dedupeKey),
    index("idx_telegram_delivery_outbox_due").on(table.status, table.nextAttemptAt, table.createdAt),
    index("idx_telegram_delivery_outbox_recipient_created").on(table.recipientUserId, table.createdAt),
    check("telegram_delivery_outbox_dedupe_not_blank", sql`length(trim(${table.dedupeKey})) > 0`),
    check("telegram_delivery_outbox_category_valid", sql`${table.category} in ('orders','visits','system')`),
    check("telegram_delivery_outbox_status_valid", sql`${table.status} in ('pending','processing','retry','sent','dead')`),
    check("telegram_delivery_outbox_attempts_valid", sql`${table.attempts} >= 0 and ${table.attempts} <= 20`),
    check("telegram_delivery_outbox_target_safe", sql`${table.targetPath}='' or ${table.targetPath} glob '/*'`),
    check(
      "telegram_delivery_outbox_lease_consistent",
      sql`(${table.leaseToken} is null and ${table.leaseExpiresAt} is null)
        or (${table.leaseToken} is not null and ${table.leaseExpiresAt} is not null)`,
    ),
  ],
);

/** Idempotency receipts for Telegram webhook updates. */
export const telegramWebhookUpdates = sqliteTable(
  "telegram_webhook_updates",
  {
    updateId: text("update_id").primaryKey(),
    payloadHash: text("payload_hash").notNull(),
    outcome: text("outcome").notNull(),
    processedAt: text("processed_at").notNull(),
  },
  (table) => [
    check("telegram_webhook_updates_id_not_blank", sql`length(trim(${table.updateId})) > 0`),
    check(
      "telegram_webhook_updates_hash_valid",
      sql`length(${table.payloadHash}) = 64 and lower(${table.payloadHash}) not glob '*[^0-9a-f]*'`,
    ),
    check("telegram_webhook_updates_outcome_not_blank", sql`length(trim(${table.outcome})) > 0`),
  ],
);

/** One-use receipts for exchanging signed Telegram Mini App data for a teacher session. */
export const telegramMiniAppAuthReceipts = sqliteTable(
  "telegram_mini_app_auth_receipts",
  {
    initDataHash: text("init_data_hash").primaryKey(),
    telegramUserId: text("telegram_user_id").notNull(),
    teacherUserId: text("teacher_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    sessionTokenHash: text("session_token_hash").notNull(),
    authDate: integer("auth_date").notNull(),
    consumedAt: text("consumed_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_telegram_mini_app_auth_session").on(table.sessionTokenHash),
    index("idx_telegram_mini_app_auth_expires").on(table.expiresAt),
    index("idx_telegram_mini_app_auth_teacher_created").on(table.teacherUserId, table.createdAt),
    check(
      "telegram_mini_app_auth_hash_valid",
      sql`length(${table.initDataHash}) = 64 and lower(${table.initDataHash}) not glob '*[^0-9a-f]*'`,
    ),
    check(
      "telegram_mini_app_auth_session_hash_valid",
      sql`length(${table.sessionTokenHash}) = 64 and lower(${table.sessionTokenHash}) not glob '*[^0-9a-f]*'`,
    ),
    check("telegram_mini_app_auth_user_not_blank", sql`length(trim(${table.telegramUserId})) > 0`),
    check("telegram_mini_app_auth_date_positive", sql`${table.authDate} > 0`),
  ],
);

/** Short-lived sessions created only from a validated librarian Telegram Mini App launch. */
export const telegramLibrarianSessions = sqliteTable(
  "telegram_librarian_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    initDataHash: text("init_data_hash").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    telegramUserId: text("telegram_user_id").notNull(),
    authDate: integer("auth_date").notNull(),
    expiresAt: text("expires_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_telegram_librarian_sessions_init_data").on(table.initDataHash),
    index("idx_telegram_librarian_sessions_user_active").on(
      table.userId,
      table.revokedAt,
      table.expiresAt,
    ),
    index("idx_telegram_librarian_sessions_expires").on(table.expiresAt),
    check(
      "telegram_librarian_sessions_token_hash_valid",
      sql`length(${table.tokenHash}) = 64 and lower(${table.tokenHash}) not glob '*[^0-9a-f]*'`,
    ),
    check(
      "telegram_librarian_sessions_init_data_hash_valid",
      sql`length(${table.initDataHash}) = 64 and lower(${table.initDataHash}) not glob '*[^0-9a-f]*'`,
    ),
    check(
      "telegram_librarian_sessions_user_not_blank",
      sql`length(trim(${table.telegramUserId})) > 0`,
    ),
    check("telegram_librarian_sessions_auth_date_positive", sql`${table.authDate} > 0`),
  ],
);

/** Public contact card edited by the librarian and rendered in the public catalog. */
export const publicLibraryProfile = sqliteTable(
  "public_library_profile",
  {
    id: text("id").primaryKey().default("primary"),
    librarianName: text("librarian_name").notNull().default(""),
    librarianDescription: text("librarian_description").notNull().default(""),
    librarianPhone: text("librarian_phone").notNull().default(""),
    librarianEmail: text("librarian_email").notNull().default(""),
    assistantName: text("assistant_name").notNull().default(""),
    assistantDescription: text("assistant_description").notNull().default(""),
    assistantPhone: text("assistant_phone").notNull().default(""),
    assistantEmail: text("assistant_email").notNull().default(""),
    version: integer("version").notNull().default(1),
    lastMutationRequestId: text("last_mutation_request_id"),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("public_library_profile_singleton", sql`${table.id} = 'primary'`),
    check("public_library_profile_version_positive", sql`${table.version} > 0`),
    check("public_library_profile_librarian_name_length", sql`length(${table.librarianName}) <= 160`),
    check("public_library_profile_librarian_description_length", sql`length(${table.librarianDescription}) <= 2000`),
    check("public_library_profile_librarian_phone_length", sql`length(${table.librarianPhone}) <= 80`),
    check("public_library_profile_librarian_email_length", sql`length(${table.librarianEmail}) <= 254`),
    check("public_library_profile_assistant_name_length", sql`length(${table.assistantName}) <= 160`),
    check("public_library_profile_assistant_description_length", sql`length(${table.assistantDescription}) <= 2000`),
    check("public_library_profile_assistant_phone_length", sql`length(${table.assistantPhone}) <= 80`),
    check("public_library_profile_assistant_email_length", sql`length(${table.assistantEmail}) <= 254`),
  ],
);

const migrationImportStatuses = [
  "uploaded",
  "preflighted",
  "committed",
  "verified",
  "cleaned",
] as const;

/** Durable state for the short-lived, staging-only, hash-pinned import gate. */
export const migrationImportRuns = sqliteTable(
  "migration_import_runs",
  {
    id: text("id").primaryKey(),
    planSha256: text("plan_sha256").notNull(),
    sourceBundleSha256: text("source_bundle_sha256").notNull(),
    objectKey: text("object_key").notNull(),
    status: text("status", { enum: migrationImportStatuses }).notNull(),
    planBytes: integer("plan_bytes").notNull(),
    expectedRows: integer("expected_rows"),
    insertStatements: integer("insert_statements"),
    preflightJson: text("preflight_json"),
    verificationJson: text("verification_json"),
    createdByUserId: text("created_by_user_id").notNull(),
    createdByEmail: text("created_by_email").notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    committedAt: text("committed_at"),
    verifiedAt: text("verified_at"),
    cleanedAt: text("cleaned_at"),
    lastErrorCode: text("last_error_code"),
  },
  (table) => [
    uniqueIndex("idx_migration_import_runs_plan_sha256").on(table.planSha256),
    index("idx_migration_import_runs_status_expires").on(table.status, table.expiresAt),
    check(
      "migration_import_runs_plan_hash_valid",
      sql`length(${table.planSha256}) = 64 and ${table.planSha256} not glob '*[^0-9a-f]*'`,
    ),
    check(
      "migration_import_runs_source_hash_valid",
      sql`length(${table.sourceBundleSha256}) = 64 and ${table.sourceBundleSha256} not glob '*[^0-9a-f]*'`,
    ),
    check(
      "migration_import_runs_object_private",
      sql`${table.objectKey} = '_migration/library-d1/' || ${table.planSha256} || '/' || ${table.id} || '.json'`,
    ),
    check(
      "migration_import_runs_status_valid",
      sql`${table.status} in ('uploaded', 'preflighted', 'committed', 'verified', 'cleaned')`,
    ),
    check(
      "migration_import_runs_plan_bytes_valid",
      sql`${table.planBytes} > 0 and ${table.planBytes} <= 6291456`,
    ),
    check(
      "migration_import_runs_expected_rows_valid",
      sql`${table.expectedRows} is null or ${table.expectedRows} > 0`,
    ),
    check(
      "migration_import_runs_statement_count_valid",
      sql`${table.insertStatements} is null or (${table.insertStatements} > 0 and ${table.insertStatements} <= 43)`,
    ),
    check(
      "migration_import_runs_actor_valid",
      sql`length(trim(${table.createdByUserId})) > 0 and length(trim(${table.createdByEmail})) > 0`,
    ),
    check(
      "migration_import_runs_preflight_json_valid",
      sql`${table.preflightJson} is null or json_valid(${table.preflightJson})`,
    ),
    check(
      "migration_import_runs_verification_json_valid",
      sql`${table.verificationJson} is null or json_valid(${table.verificationJson})`,
    ),
  ],
);
