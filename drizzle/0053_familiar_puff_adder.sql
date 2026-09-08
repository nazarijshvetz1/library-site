PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_librarika_member_sync_parts` (
	`run_id` text NOT NULL,
	`part_index` integer NOT NULL,
	`part_sha256` text NOT NULL,
	`row_count` integer NOT NULL,
	`received_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `part_index`),
	FOREIGN KEY (`run_id`) REFERENCES `librarika_member_sync_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "librarika_member_sync_part_index" CHECK("__new_librarika_member_sync_parts"."part_index">=0 and "__new_librarika_member_sync_parts"."part_index"<200),
	CONSTRAINT "librarika_member_sync_part_hash" CHECK(length("__new_librarika_member_sync_parts"."part_sha256")=64 and "__new_librarika_member_sync_parts"."part_sha256" not glob '*[^0-9a-f]*'),
	CONSTRAINT "librarika_member_sync_part_rows" CHECK("__new_librarika_member_sync_parts"."row_count">0 and "__new_librarika_member_sync_parts"."row_count"<=40)
);
--> statement-breakpoint
INSERT INTO `__new_librarika_member_sync_parts`("run_id", "part_index", "part_sha256", "row_count", "received_at") SELECT "run_id", "part_index", "part_sha256", "row_count", "received_at" FROM `librarika_member_sync_parts`;--> statement-breakpoint
DROP TABLE `librarika_member_sync_parts`;--> statement-breakpoint
ALTER TABLE `__new_librarika_member_sync_parts` RENAME TO `librarika_member_sync_parts`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_librarika_member_sync_rows` (
	`run_id` text NOT NULL,
	`source_member_id` text NOT NULL,
	`member_no` text NOT NULL,
	`full_name` text NOT NULL,
	`sort_name` text NOT NULL,
	`member_group` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`source_json` text NOT NULL,
	`row_sha256` text NOT NULL,
	`decision` text DEFAULT 'pending' NOT NULL,
	`conflict_reason` text,
	`candidate_reader_id` text,
	`candidate_version` integer,
	PRIMARY KEY(`run_id`, `source_member_id`),
	FOREIGN KEY (`run_id`) REFERENCES `librarika_member_sync_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "librarika_member_sync_source_id" CHECK(length("__new_librarika_member_sync_rows"."source_member_id")>0 and "__new_librarika_member_sync_rows"."source_member_id" not glob '*[^0-9]*'),
	CONSTRAINT "librarika_member_sync_member_no" CHECK(length(trim("__new_librarika_member_sync_rows"."member_no"))>0 and length("__new_librarika_member_sync_rows"."member_no")<=50),
	CONSTRAINT "librarika_member_sync_name" CHECK(length(trim("__new_librarika_member_sync_rows"."full_name"))>=3 and length("__new_librarika_member_sync_rows"."full_name")<=180),
	CONSTRAINT "librarika_member_sync_group" CHECK(length("__new_librarika_member_sync_rows"."member_group")<=120),
	CONSTRAINT "librarika_member_sync_status" CHECK("__new_librarika_member_sync_rows"."status" in ('active','inactive')),
	CONSTRAINT "librarika_member_sync_source_json" CHECK(json_valid("__new_librarika_member_sync_rows"."source_json")),
	CONSTRAINT "librarika_member_sync_row_hash" CHECK(length("__new_librarika_member_sync_rows"."row_sha256")=64 and "__new_librarika_member_sync_rows"."row_sha256" not glob '*[^0-9a-f]*'),
	CONSTRAINT "librarika_member_sync_decision" CHECK("__new_librarika_member_sync_rows"."decision" in ('pending','add','update','unchanged','conflict')),
	CONSTRAINT "librarika_member_sync_conflict_reason" CHECK(("__new_librarika_member_sync_rows"."decision"='conflict' and length(trim("__new_librarika_member_sync_rows"."conflict_reason"))>0) or ("__new_librarika_member_sync_rows"."decision"<>'conflict' and "__new_librarika_member_sync_rows"."conflict_reason" is null)),
	CONSTRAINT "librarika_member_sync_candidate" CHECK(("__new_librarika_member_sync_rows"."decision" in ('update','unchanged') and "__new_librarika_member_sync_rows"."candidate_reader_id" is not null and "__new_librarika_member_sync_rows"."candidate_version">0) or ("__new_librarika_member_sync_rows"."decision" in ('pending','add') and "__new_librarika_member_sync_rows"."candidate_reader_id" is null and "__new_librarika_member_sync_rows"."candidate_version" is null) or ("__new_librarika_member_sync_rows"."decision"='conflict' and (("__new_librarika_member_sync_rows"."candidate_reader_id" is null and "__new_librarika_member_sync_rows"."candidate_version" is null) or ("__new_librarika_member_sync_rows"."candidate_reader_id" is not null and "__new_librarika_member_sync_rows"."candidate_version">0))))
);
--> statement-breakpoint
INSERT INTO `__new_librarika_member_sync_rows`("run_id", "source_member_id", "member_no", "full_name", "sort_name", "member_group", "status", "source_json", "row_sha256", "decision", "conflict_reason", "candidate_reader_id", "candidate_version") SELECT "run_id", "source_member_id", "member_no", "full_name", "sort_name", "member_group", "status", "source_json", lower(hex(randomblob(32))), 'pending', NULL, NULL, NULL FROM `librarika_member_sync_rows`;--> statement-breakpoint
DROP TABLE `librarika_member_sync_rows`;--> statement-breakpoint
ALTER TABLE `__new_librarika_member_sync_rows` RENAME TO `librarika_member_sync_rows`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_librarika_member_sync_number` ON `librarika_member_sync_rows` (`run_id`,`member_no`);--> statement-breakpoint
CREATE TABLE `__new_librarika_member_sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`source_sha256` text NOT NULL,
	`expected_rows` integer NOT NULL,
	`state` text DEFAULT 'uploading' NOT NULL,
	`upload_revision` integer DEFAULT 0 NOT NULL,
	`is_full_baseline` integer DEFAULT false NOT NULL,
	`preview_json` text,
	`actor_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`applied_at` text,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "librarika_member_sync_hash" CHECK(length("__new_librarika_member_sync_runs"."source_sha256")=64 and "__new_librarika_member_sync_runs"."source_sha256" not glob '*[^0-9a-f]*'),
	CONSTRAINT "librarika_member_sync_rows" CHECK("__new_librarika_member_sync_runs"."expected_rows">0 and "__new_librarika_member_sync_runs"."expected_rows"<=5000),
	CONSTRAINT "librarika_member_sync_revision" CHECK("__new_librarika_member_sync_runs"."upload_revision">=0),
	CONSTRAINT "librarika_member_sync_baseline" CHECK("__new_librarika_member_sync_runs"."is_full_baseline" in (0,1)),
	CONSTRAINT "librarika_member_sync_state_check" CHECK("__new_librarika_member_sync_runs"."state" in ('uploading','previewed','applied','failed')),
	CONSTRAINT "librarika_member_sync_preview" CHECK("__new_librarika_member_sync_runs"."preview_json" is null or json_valid("__new_librarika_member_sync_runs"."preview_json"))
);
--> statement-breakpoint
INSERT INTO `__new_librarika_member_sync_runs`("id", "request_id", "source_sha256", "expected_rows", "state", "upload_revision", "is_full_baseline", "preview_json", "actor_user_id", "created_at", "updated_at", "applied_at") SELECT "id", "request_id", "source_sha256", "expected_rows", "state", 0, 0, "preview_json", "actor_user_id", "created_at", "updated_at", "applied_at" FROM `librarika_member_sync_runs`;--> statement-breakpoint
DROP TABLE `librarika_member_sync_runs`;--> statement-breakpoint
ALTER TABLE `__new_librarika_member_sync_runs` RENAME TO `librarika_member_sync_runs`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_librarika_member_sync_request` ON `librarika_member_sync_runs` (`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_librarika_member_sync_dataset` ON `librarika_member_sync_runs` (`actor_user_id`,`source_sha256`) WHERE `state` in ('uploading','previewed');--> statement-breakpoint
CREATE INDEX `idx_librarika_member_sync_state` ON `librarika_member_sync_runs` (`state`,`updated_at`);--> statement-breakpoint
CREATE TABLE `__new_reader_platform_links` (
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
	CONSTRAINT "reader_platform_name" CHECK("__new_reader_platform_links"."platform" in ('librarika')),
	CONSTRAINT "reader_platform_state" CHECK("__new_reader_platform_links"."state" in ('pending','processing','linked','conflict','manual_required','failed','disabled')),
	CONSTRAINT "reader_platform_member_number" CHECK(length(trim("__new_reader_platform_links"."member_no"))>0 and length("__new_reader_platform_links"."member_no")<=50),
	CONSTRAINT "reader_platform_linked_identity" CHECK("__new_reader_platform_links"."state"!='linked' or "__new_reader_platform_links"."external_member_id" is not null),
	CONSTRAINT "reader_platform_lease" CHECK(("__new_reader_platform_links"."state"='processing' and "__new_reader_platform_links"."lease_token" is not null and "__new_reader_platform_links"."lease_until" is not null) or ("__new_reader_platform_links"."state"!='processing' and "__new_reader_platform_links"."lease_token" is null and "__new_reader_platform_links"."lease_until" is null)),
	CONSTRAINT "reader_platform_attempts" CHECK("__new_reader_platform_links"."attempts">=0),
	CONSTRAINT "reader_platform_payload" CHECK(json_valid("__new_reader_platform_links"."desired_payload_json"))
);
--> statement-breakpoint
INSERT INTO `__new_reader_platform_links`("reader_id", "platform", "member_no", "external_member_id", "state", "desired_payload_json", "attempts", "lease_token", "lease_until", "last_attempt_at", "last_checked_at", "last_error", "created_at", "updated_at") SELECT "reader_id", "platform", "member_no", "external_member_id", "state", "desired_payload_json", "attempts", "lease_token", "lease_until", "last_attempt_at", "last_checked_at", "last_error", "created_at", "updated_at" FROM `reader_platform_links`;--> statement-breakpoint
DROP TABLE `reader_platform_links`;--> statement-breakpoint
ALTER TABLE `__new_reader_platform_links` RENAME TO `reader_platform_links`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reader_platform_external` ON `reader_platform_links` (`platform`,`external_member_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reader_platform_member_number` ON `reader_platform_links` (`platform`,`member_no`);--> statement-breakpoint
CREATE INDEX `idx_reader_platform_queue` ON `reader_platform_links` (`platform`,`state`,`updated_at`,`reader_id`);--> statement-breakpoint
UPDATE `telegram_delivery_outbox`
SET `status`='dead',`lease_token`=NULL,`lease_expires_at`=NULL,
	`last_error_code`='pickup_reminders_withdrawn',
	`last_error_message`='Нагадування про підготовку та отримання вимкнено.',
	`updated_at`=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE `entity_type`='material_request'
	AND `type` IN ('material_request_pickup_reminder','material_request_prepare_reminder')
	AND `status` IN ('pending','processing','retry');--> statement-breakpoint
PRAGMA foreign_keys=ON;
