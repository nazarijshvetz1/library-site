CREATE TABLE `reader_messages` (
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
	CONSTRAINT "reader_message_kind" CHECK("reader_messages"."kind" in ('loan_digest','proposal')),
	CONSTRAINT "reader_message_delivery_status" CHECK("reader_messages"."delivery_status" in ('pending','processing','retry','sent','unavailable','disabled','cancelled','uncertain'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reader_message_dedupe` ON `reader_messages` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_reader_message_owner` ON `reader_messages` (`reader_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_reader_message_delivery` ON `reader_messages` (`delivery_status`,`next_attempt_at`);--> statement-breakpoint
ALTER TABLE `reader_literature_proposals` ADD `workflow_status` text CHECK(workflow_status IS NULL OR workflow_status IN ('submitted','approved','ordered','available'));
--> statement-breakpoint
ALTER TABLE `reader_literature_proposals` ADD `edition_id` text REFERENCES `library_editions`(`id`) ON DELETE restrict;
