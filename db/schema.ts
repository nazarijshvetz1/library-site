import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  ],
);
