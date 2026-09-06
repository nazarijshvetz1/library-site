CREATE TABLE `library_copy_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`copy_id` text NOT NULL,
	`circulation_id` text,
	`command_id` text NOT NULL,
	`kind` text NOT NULL,
	`previous_state` text NOT NULL,
	`next_state` text NOT NULL,
	`source_location_id` text,
	`destination_location_id` text,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`copy_id`) REFERENCES `library_copies`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`circulation_id`) REFERENCES `reader_circulations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`command_id`) REFERENCES `mutation_commands`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`destination_location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "library_copy_movement_kind" CHECK("library_copy_movements"."kind" in ('register','issue','return','transfer','condition','withdraw','reconcile'))
);
--> statement-breakpoint
CREATE INDEX `idx_library_copy_movement` ON `library_copy_movements` (`copy_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `library_ratings` (
	`edition_id` text NOT NULL,
	`reader_id` text NOT NULL,
	`rating` integer NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`review_state` text DEFAULT 'pending' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`edition_id`, `reader_id`),
	FOREIGN KEY (`edition_id`) REFERENCES `library_editions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reader_id`) REFERENCES `library_readers`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "library_rating_value" CHECK("library_ratings"."rating" between 1 and 5),
	CONSTRAINT "library_review_state" CHECK("library_ratings"."review_state" in ('pending','published','hidden')),
	CONSTRAINT "library_review_body" CHECK(length("library_ratings"."body")<=4000)
);
--> statement-breakpoint
CREATE INDEX `idx_library_rating_public` ON `library_ratings` (`edition_id`,`review_state`);--> statement-breakpoint
CREATE TABLE `reader_blocks` (
	`reader_id` text NOT NULL,
	`blocked_reader_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`reader_id`, `blocked_reader_id`),
	FOREIGN KEY (`reader_id`) REFERENCES `library_readers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`blocked_reader_id`) REFERENCES `library_readers`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "reader_block_self" CHECK("reader_blocks"."reader_id"!="reader_blocks"."blocked_reader_id")
);
--> statement-breakpoint
CREATE TABLE `reader_book_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`reader_id` text NOT NULL,
	`edition_id` text NOT NULL,
	`status` text DEFAULT 'requested' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`fulfilled_circulation_id` text,
	FOREIGN KEY (`reader_id`) REFERENCES `library_readers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`edition_id`) REFERENCES `library_editions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`fulfilled_circulation_id`) REFERENCES `reader_circulations`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "reader_request_status" CHECK("reader_book_requests"."status" in ('requested','ready','fulfilled','cancelled','rejected'))
);
--> statement-breakpoint
CREATE INDEX `idx_reader_request_owner` ON `reader_book_requests` (`reader_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_reader_request_edition` ON `reader_book_requests` (`edition_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reader_request_open` ON `reader_book_requests` (`reader_id`,`edition_id`) WHERE "reader_book_requests"."status" in ('requested','ready');--> statement-breakpoint
CREATE TABLE `reader_book_subscriptions` (
	`reader_id` text NOT NULL,
	`edition_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`reader_id`, `edition_id`),
	FOREIGN KEY (`reader_id`) REFERENCES `library_readers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`edition_id`) REFERENCES `library_editions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `reader_invites` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`reader_id` text NOT NULL,
	`access_version` integer NOT NULL,
	`purpose` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`revoked_at` text,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`reader_id`) REFERENCES `library_readers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "reader_invite_purpose" CHECK("reader_invites"."purpose" in ('web','telegram')),
	CONSTRAINT "reader_invite_hash" CHECK(length("reader_invites"."token_hash")=64)
);
--> statement-breakpoint
CREATE INDEX `idx_reader_invite_reader` ON `reader_invites` (`reader_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `reader_mutation_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`reader_id` text NOT NULL,
	`kind` text NOT NULL,
	`request_hash` text NOT NULL,
	`result_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`reader_id`) REFERENCES `library_readers`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "reader_receipt_json" CHECK(json_valid("reader_mutation_receipts"."result_json"))
);
--> statement-breakpoint
CREATE INDEX `idx_reader_receipt_owner` ON `reader_mutation_receipts` (`reader_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `reader_notification_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`reader_id` text NOT NULL,
	`circulation_id` text,
	`edition_id` text,
	`kind` text NOT NULL,
	`expected_version` integer,
	`due_date` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`lease_token` text,
	`lease_until` text,
	`created_at` text NOT NULL,
	`sent_at` text,
	`last_error` text,
	FOREIGN KEY (`reader_id`) REFERENCES `library_readers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`circulation_id`) REFERENCES `reader_circulations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`edition_id`) REFERENCES `library_editions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "reader_notification_kind" CHECK("reader_notification_outbox"."kind" in ('due_soon','due_today','overdue','book_available')),
	CONSTRAINT "reader_notification_status" CHECK("reader_notification_outbox"."status" in ('pending','processing','sent','cancelled','failed'))
);
--> statement-breakpoint
CREATE INDEX `idx_reader_notification_queue` ON `reader_notification_outbox` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `reader_profiles` (
	`reader_id` text PRIMARY KEY NOT NULL,
	`display_name` text DEFAULT 'Читач' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`photo_key` text,
	`photo_mime` text,
	`community_enabled` integer DEFAULT 0 NOT NULL,
	`notify_loans` integer DEFAULT 0 NOT NULL,
	`notify_books` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`reader_id`) REFERENCES `library_readers`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "reader_profile_flags" CHECK("reader_profiles"."community_enabled" in (0,1) and "reader_profiles"."notify_loans" in (0,1) and "reader_profiles"."notify_books" in (0,1)),
	CONSTRAINT "reader_profile_version" CHECK("reader_profiles"."version">0)
);
--> statement-breakpoint
CREATE TABLE `reader_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`reader_id` text NOT NULL,
	`access_version` integer NOT NULL,
	`telegram_user_id` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`reader_id`) REFERENCES `library_readers`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "reader_session_hash" CHECK(length("reader_sessions"."token_hash")=64)
);
--> statement-breakpoint
CREATE INDEX `idx_reader_session_owner` ON `reader_sessions` (`reader_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `reader_telegram_connections` (
	`telegram_user_id` text PRIMARY KEY NOT NULL,
	`reader_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`linked_at` text NOT NULL,
	`disabled_at` text,
	`last_failure_at` text,
	FOREIGN KEY (`reader_id`) REFERENCES `library_readers`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "reader_telegram_status" CHECK("reader_telegram_connections"."status" in ('active','disabled','blocked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reader_telegram_owner` ON `reader_telegram_connections` (`reader_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reader_telegram_chat` ON `reader_telegram_connections` (`chat_id`);--> statement-breakpoint
CREATE TABLE `reader_telegram_receipts` (
	`init_data_hash` text PRIMARY KEY NOT NULL,
	`telegram_user_id` text NOT NULL,
	`reader_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`reader_id`) REFERENCES `library_readers`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `reading_memberships` (
	`thread_id` text NOT NULL,
	`reader_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`status` text DEFAULT 'invited' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`thread_id`, `reader_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `reading_threads`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reader_id`) REFERENCES `library_readers`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "reading_membership_role" CHECK("reading_memberships"."role" in ('owner','moderator','member')),
	CONSTRAINT "reading_membership_status" CHECK("reading_memberships"."status" in ('invited','accepted','declined','left','removed'))
);
--> statement-breakpoint
CREATE INDEX `idx_reading_member_threads` ON `reading_memberships` (`reader_id`,`status`);--> statement-breakpoint
CREATE TABLE `reading_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`reader_id` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`edition_id` text,
	`status` text DEFAULT 'visible' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `reading_threads`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reader_id`) REFERENCES `library_readers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`edition_id`) REFERENCES `library_editions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "reading_message_body" CHECK(length("reading_messages"."body")<=4000 and (length(trim("reading_messages"."body"))>0 or "reading_messages"."edition_id" is not null)),
	CONSTRAINT "reading_message_status" CHECK("reading_messages"."status" in ('visible','removed','hidden'))
);
--> statement-breakpoint
CREATE INDEX `idx_reading_message_thread` ON `reading_messages` (`thread_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `reading_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`reporter_reader_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`message_id` text,
	`reason` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text,
	`resolved_by` text,
	FOREIGN KEY (`reporter_reader_id`) REFERENCES `library_readers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`thread_id`) REFERENCES `reading_threads`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`message_id`) REFERENCES `reading_messages`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "reading_report_reason" CHECK(length(trim("reading_reports"."reason")) between 5 and 2000),
	CONSTRAINT "reading_report_status" CHECK("reading_reports"."status" in ('open','resolved','dismissed'))
);
--> statement-breakpoint
CREATE INDEX `idx_reading_reports_open` ON `reading_reports` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `reading_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`owner_reader_id` text NOT NULL,
	`edition_id` text,
	`direct_pair_key` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_reader_id`) REFERENCES `library_readers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`edition_id`) REFERENCES `library_editions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "reading_thread_kind" CHECK("reading_threads"."kind" in ('book','group','direct')),
	CONSTRAINT "reading_thread_status" CHECK("reading_threads"."status" in ('active','closed','hidden')),
	CONSTRAINT "reading_thread_direct_key" CHECK(("reading_threads"."kind"='direct' and "reading_threads"."direct_pair_key" is not null) or ("reading_threads"."kind"!='direct' and "reading_threads"."direct_pair_key" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reading_direct_pair` ON `reading_threads` (`direct_pair_key`);--> statement-breakpoint
CREATE INDEX `idx_reading_book_thread` ON `reading_threads` (`edition_id`,`kind`,`status`);