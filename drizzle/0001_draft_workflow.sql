ALTER TABLE `librarian_drafts` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `librarian_drafts` ADD `revision` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `librarian_drafts` ADD `group_id` text;
--> statement-breakpoint
ALTER TABLE `librarian_drafts` ADD `target_key` text;
--> statement-breakpoint
ALTER TABLE `librarian_drafts` ADD `updated_by_user_id` text;
--> statement-breakpoint
ALTER TABLE `librarian_drafts` ADD `updated_by_email` text;
--> statement-breakpoint
ALTER TABLE `librarian_drafts` ADD `submitted_at` text;
--> statement-breakpoint
ALTER TABLE `librarian_drafts` ADD `cancelled_at` text;
--> statement-breakpoint
ALTER TABLE `librarian_drafts` ADD `reviewed_at` text;
--> statement-breakpoint
ALTER TABLE `librarian_drafts` ADD `reviewed_by_user_id` text;
--> statement-breakpoint
ALTER TABLE `librarian_drafts` ADD `reviewed_by_email` text;
--> statement-breakpoint
ALTER TABLE `librarian_drafts` ADD `review_note` text;
--> statement-breakpoint
CREATE INDEX `idx_librarian_drafts_owner_status_updated`
ON `librarian_drafts` (`owner_user_id`, `status`, `updated_at`);
--> statement-breakpoint
CREATE INDEX `idx_librarian_drafts_group_updated`
ON `librarian_drafts` (`group_id`, `updated_at`);
--> statement-breakpoint
CREATE TABLE `librarian_draft_events` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_email` text NOT NULL,
	`action` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`draft_id`) REFERENCES `librarian_drafts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_librarian_draft_events_draft_created`
ON `librarian_draft_events` (`draft_id`, `created_at`);
--> statement-breakpoint
INSERT INTO `librarian_draft_events` (
	`id`, `draft_id`, `actor_user_id`, `actor_email`, `action`,
	`from_status`, `to_status`, `revision`, `created_at`
)
SELECT
	lower(hex(randomblob(16))), `id`, `owner_user_id`, `owner_email`,
	'created', NULL, `status`, `revision`, `created_at`
FROM `librarian_drafts`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_librarian_draft_events_draft_revision`
ON `librarian_draft_events` (`draft_id`, `revision`);
--> statement-breakpoint
PRAGMA optimize;
