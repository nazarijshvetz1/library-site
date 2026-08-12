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
const visitClosureStatuses = ["active", "cancelled"] as const;
const visitHourStatuses = ["active", "inactive"] as const;

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
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_material_stock_totals_available").on(
      table.totalQuantity,
      table.loanedQuantity,
      table.materialId,
    ),
    check(
      "material_stock_totals_nonnegative",
      sql`${table.totalQuantity} >= 0
        and ${table.libraryQuantity} >= 0
        and ${table.otherLocationQuantity} >= 0
        and ${table.loanedQuantity} >= 0`,
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

/** SIWC-owned bookings. Public serializers must never expose owner or class fields. */
export const visitBookings = sqliteTable(
  "visit_bookings",
  {
    id: text("id").primaryKey(),
    ownerAuthUserId: text("owner_auth_user_id").notNull(),
    ownerEmail: text("owner_email").notNull(),
    surname: text("surname").notNull(),
    classYearId: text("class_year_id").references(() => classYears.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    classLabel: text("class_label"),
    visitDate: text("visit_date").notNull(),
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    purpose: text("purpose").notNull().default(""),
    status: text("status", { enum: visitBookingStatuses }).notNull().default("active"),
    cancelReason: text("cancel_reason").notNull().default(""),
    cancelledByAuthUserId: text("cancelled_by_auth_user_id"),
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
    index("idx_visit_bookings_class_date").on(table.classYearId, table.visitDate),
    check("visit_bookings_owner_not_blank", sql`length(trim(${table.ownerAuthUserId})) > 0`),
    check("visit_bookings_email_not_blank", sql`length(trim(${table.ownerEmail})) > 0`),
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
      "visit_bookings_cancel_consistent",
      sql`(${table.status} = 'active' and ${table.cancelledAt} is null
          and ${table.cancelledByAuthUserId} is null and ${table.cancelledByUserId} is null)
        or (${table.status} = 'cancelled' and ${table.cancelledAt} is not null
          and ((${table.cancelledByAuthUserId} is not null and ${table.cancelledByUserId} is null)
            or (${table.cancelledByAuthUserId} is null and ${table.cancelledByUserId} is not null)))`,
    ),
    check("visit_bookings_version_positive", sql`${table.version} > 0`),
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
