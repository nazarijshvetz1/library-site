CREATE TABLE `reader_number_allocations` (
	`ordinal` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` text NOT NULL,
	`reader_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "reader_number_allocation_ordinal" CHECK("reader_number_allocations"."ordinal">0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reader_number_allocation_request` ON `reader_number_allocations` (`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reader_number_allocation_reader` ON `reader_number_allocations` (`reader_id`);--> statement-breakpoint
INSERT OR IGNORE INTO `reader_number_allocations` (`ordinal`,`request_id`,`reader_id`,`created_at`)
SELECT CAST(`member_no` AS INTEGER)-26000000,'legacy:'||`id`,`id`,`created_at`
FROM `library_readers`
WHERE `member_no`<>'' AND `member_no` NOT GLOB '*[^0-9]*'
  AND CAST(`member_no` AS INTEGER) BETWEEN 26000001 AND 999999999;--> statement-breakpoint
CREATE TABLE `reader_platform_links` (
	`reader_id` text NOT NULL,
	`platform` text NOT NULL,
	`member_no` text NOT NULL,
	`external_member_id` text,
	`state` text DEFAULT 'manual_required' NOT NULL,
	`desired_payload_json` text DEFAULT '{}' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`lease_until` text,
	`last_attempt_at` text,
	`last_checked_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`reader_id`, `platform`),
	FOREIGN KEY (`reader_id`) REFERENCES `library_readers`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "reader_platform_name" CHECK("reader_platform_links"."platform" in ('librarika')),
	CONSTRAINT "reader_platform_state" CHECK("reader_platform_links"."state" in ('pending','processing','linked','conflict','manual_required','failed','disabled')),
	CONSTRAINT "reader_platform_attempts" CHECK("reader_platform_links"."attempts">=0),
	CONSTRAINT "reader_platform_payload" CHECK(json_valid("reader_platform_links"."desired_payload_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reader_platform_external` ON `reader_platform_links` (`platform`,`external_member_id`);--> statement-breakpoint
CREATE INDEX `idx_reader_platform_queue` ON `reader_platform_links` (`platform`,`state`,`updated_at`,`reader_id`);
