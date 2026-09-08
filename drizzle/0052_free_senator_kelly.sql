CREATE TABLE `librarika_member_sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`source_sha256` text NOT NULL,
	`expected_rows` integer NOT NULL,
	`state` text DEFAULT 'uploading' NOT NULL,
	`preview_json` text,
	`actor_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`applied_at` text,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "librarika_member_sync_hash" CHECK(length("librarika_member_sync_runs"."source_sha256")=64 and "librarika_member_sync_runs"."source_sha256" not glob '*[^0-9a-f]*'),
	CONSTRAINT "librarika_member_sync_rows" CHECK("librarika_member_sync_runs"."expected_rows">0 and "librarika_member_sync_runs"."expected_rows"<=5000),
	CONSTRAINT "librarika_member_sync_state_check" CHECK("librarika_member_sync_runs"."state" in ('uploading','previewed','applied','failed')),
	CONSTRAINT "librarika_member_sync_preview" CHECK("librarika_member_sync_runs"."preview_json" is null or json_valid("librarika_member_sync_runs"."preview_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_librarika_member_sync_request` ON `librarika_member_sync_runs` (`request_id`);--> statement-breakpoint
CREATE INDEX `idx_librarika_member_sync_state` ON `librarika_member_sync_runs` (`state`,`updated_at`);--> statement-breakpoint
CREATE TABLE `librarika_member_sync_rows` (
	`run_id` text NOT NULL,
	`source_member_id` text NOT NULL,
	`member_no` text NOT NULL,
	`full_name` text NOT NULL,
	`sort_name` text NOT NULL,
	`member_group` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`source_json` text NOT NULL,
	PRIMARY KEY(`run_id`, `source_member_id`),
	FOREIGN KEY (`run_id`) REFERENCES `librarika_member_sync_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "librarika_member_sync_source_id" CHECK(length("librarika_member_sync_rows"."source_member_id")>0 and "librarika_member_sync_rows"."source_member_id" not glob '*[^0-9]*'),
	CONSTRAINT "librarika_member_sync_member_no" CHECK(length(trim("librarika_member_sync_rows"."member_no"))>0 and length("librarika_member_sync_rows"."member_no")<=50),
	CONSTRAINT "librarika_member_sync_name" CHECK(length(trim("librarika_member_sync_rows"."full_name"))>=3 and length("librarika_member_sync_rows"."full_name")<=180),
	CONSTRAINT "librarika_member_sync_group" CHECK(length("librarika_member_sync_rows"."member_group")<=120),
	CONSTRAINT "librarika_member_sync_status" CHECK("librarika_member_sync_rows"."status" in ('active','inactive')),
	CONSTRAINT "librarika_member_sync_source_json" CHECK(json_valid("librarika_member_sync_rows"."source_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_librarika_member_sync_number` ON `librarika_member_sync_rows` (`run_id`,`member_no`);--> statement-breakpoint
CREATE TABLE `librarika_member_sync_parts` (
	`run_id` text NOT NULL,
	`part_index` integer NOT NULL,
	`part_sha256` text NOT NULL,
	`row_count` integer NOT NULL,
	`received_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `part_index`),
	FOREIGN KEY (`run_id`) REFERENCES `librarika_member_sync_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "librarika_member_sync_part_index" CHECK("librarika_member_sync_parts"."part_index">=0 and "librarika_member_sync_parts"."part_index"<100),
	CONSTRAINT "librarika_member_sync_part_hash" CHECK(length("librarika_member_sync_parts"."part_sha256")=64 and "librarika_member_sync_parts"."part_sha256" not glob '*[^0-9a-f]*'),
	CONSTRAINT "librarika_member_sync_part_rows" CHECK("librarika_member_sync_parts"."row_count">0 and "librarika_member_sync_parts"."row_count"<=50)
);
