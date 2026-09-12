CREATE TABLE `reader_feed_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`reader_id` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'visible' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `reader_feed_posts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reader_id`) REFERENCES `library_readers`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "reader_feed_comment_status" CHECK("reader_feed_comments"."status" in ('visible','hidden','removed')),
	CONSTRAINT "reader_feed_comment_body" CHECK(length("reader_feed_comments"."body")<=2000)
);
--> statement-breakpoint
CREATE INDEX `idx_reader_feed_comments` ON `reader_feed_comments` (`post_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_reader_feed_comment_owner` ON `reader_feed_comments` (`reader_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `reader_feed_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`reader_id` text NOT NULL,
	`edition_id` text,
	`body` text NOT NULL,
	`status` text DEFAULT 'visible' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`reader_id`) REFERENCES `library_readers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`edition_id`) REFERENCES `library_editions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "reader_feed_status" CHECK("reader_feed_posts"."status" in ('visible','hidden','removed')),
	CONSTRAINT "reader_feed_body" CHECK(length("reader_feed_posts"."body")<=4000)
);
--> statement-breakpoint
CREATE INDEX `idx_reader_feed_status` ON `reader_feed_posts` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_reader_feed_owner` ON `reader_feed_posts` (`reader_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `reader_literature_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`reader_id` text NOT NULL,
	`title` text NOT NULL,
	`author` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'submitted' NOT NULL,
	`reply` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`reader_id`) REFERENCES `library_readers`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "literature_proposal_status" CHECK("reader_literature_proposals"."status" in ('submitted','in_review','approved','received','rejected'))
);
--> statement-breakpoint
CREATE INDEX `idx_literature_proposal_owner` ON `reader_literature_proposals` (`reader_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_literature_proposal_status` ON `reader_literature_proposals` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `reader_recent_views` (
	`reader_id` text NOT NULL,
	`edition_id` text NOT NULL,
	`viewed_at` text NOT NULL,
	PRIMARY KEY(`reader_id`, `edition_id`),
	FOREIGN KEY (`reader_id`) REFERENCES `library_readers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`edition_id`) REFERENCES `library_editions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_reader_recent_owner` ON `reader_recent_views` (`reader_id`,`viewed_at`);--> statement-breakpoint
ALTER TABLE `reader_profiles` ADD `email` text DEFAULT '' NOT NULL;