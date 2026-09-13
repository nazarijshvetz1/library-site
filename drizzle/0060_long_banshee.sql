PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_reader_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`reader_id` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`kind` text NOT NULL,
	`day` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`target_tab` text NOT NULL,
	`read_at` text,
	`created_at` text NOT NULL,
	`delivery_status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`lease_token` text,
	`lease_until` text,
	`sent_at` text,
	`last_error` text,
	FOREIGN KEY (`reader_id`) REFERENCES `library_readers`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "reader_message_kind" CHECK("__new_reader_messages"."kind" in ('loan_digest','proposal','request','circulation','community','account')),
	CONSTRAINT "reader_message_delivery_status" CHECK("__new_reader_messages"."delivery_status" in ('pending','processing','retry','sent','unavailable','disabled','cancelled','uncertain','site_only'))
);
--> statement-breakpoint
INSERT INTO `__new_reader_messages`("id", "reader_id", "dedupe_key", "kind", "day", "title", "body", "payload_json", "target_tab", "read_at", "created_at", "delivery_status", "attempts", "next_attempt_at", "lease_token", "lease_until", "sent_at", "last_error") SELECT "id", "reader_id", "dedupe_key", "kind", "day", "title", "body", "payload_json", "target_tab", "read_at", "created_at", "delivery_status", "attempts", "next_attempt_at", "lease_token", "lease_until", "sent_at", "last_error" FROM `reader_messages`;--> statement-breakpoint
DROP TABLE `reader_messages`;--> statement-breakpoint
ALTER TABLE `__new_reader_messages` RENAME TO `reader_messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reader_message_dedupe` ON `reader_messages` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_reader_message_owner` ON `reader_messages` (`reader_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_reader_message_delivery` ON `reader_messages` (`delivery_status`,`next_attempt_at`);--> statement-breakpoint
ALTER TABLE `reader_profiles` ADD `about` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `reader_profiles` ADD `telegram_disconnected_at` text;--> statement-breakpoint
ALTER TABLE `reader_feed_comments` ADD `parent_comment_id` text;
--> statement-breakpoint
-- Preserve an explicit historical reader /stop; default unchecked consent is not a mute.
UPDATE reader_profiles SET telegram_disconnected_at=updated_at WHERE notify_loans=0 AND EXISTS(SELECT 1 FROM telegram_webhook_updates w WHERE w.outcome='reader_stop' AND w.processed_at=reader_profiles.updated_at);
