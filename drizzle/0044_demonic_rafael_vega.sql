CREATE TABLE `library_historical_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`edition_id` text NOT NULL,
	`source_review_id` text,
	`rating` integer,
	`body` text NOT NULL,
	`source_date_display` text DEFAULT '' NOT NULL,
	`source_json` text NOT NULL,
	`source_row_sha256` text NOT NULL,
	`import_run_id` text NOT NULL,
	`publication_state` text DEFAULT 'draft' NOT NULL,
	`captured_at` text NOT NULL,
	FOREIGN KEY (`edition_id`) REFERENCES `library_editions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`import_run_id`) REFERENCES `library_import_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "library_historical_rating" CHECK("library_historical_reviews"."rating" is null or "library_historical_reviews"."rating" between 1 and 5),
	CONSTRAINT "library_historical_body" CHECK(length(trim("library_historical_reviews"."body"))>0),
	CONSTRAINT "library_historical_json" CHECK(json_valid("library_historical_reviews"."source_json")),
	CONSTRAINT "library_historical_publication" CHECK("library_historical_reviews"."publication_state" in ('draft','published','hidden'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_library_historical_review_source` ON `library_historical_reviews` (`source_review_id`);--> statement-breakpoint
CREATE INDEX `idx_library_historical_review_edition` ON `library_historical_reviews` (`edition_id`,`publication_state`);