CREATE TABLE `librarian_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`owner_email` text NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_librarian_drafts_owner_updated`
ON `librarian_drafts` (`owner_user_id`, `updated_at`);
--> statement-breakpoint
PRAGMA optimize;
