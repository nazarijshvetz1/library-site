CREATE TABLE `migration_import_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_sha256` text NOT NULL,
	`source_bundle_sha256` text NOT NULL,
	`object_key` text NOT NULL,
	`status` text NOT NULL,
	`plan_bytes` integer NOT NULL,
	`expected_rows` integer,
	`insert_statements` integer,
	`preflight_json` text,
	`verification_json` text,
	`created_by_user_id` text NOT NULL,
	`created_by_email` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`committed_at` text,
	`verified_at` text,
	`cleaned_at` text,
	`last_error_code` text,
	CONSTRAINT `migration_import_runs_plan_hash_valid` CHECK(length(`plan_sha256`) = 64 AND `plan_sha256` NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT `migration_import_runs_source_hash_valid` CHECK(length(`source_bundle_sha256`) = 64 AND `source_bundle_sha256` NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT `migration_import_runs_object_private` CHECK(`object_key` = '_migration/library-d1/' || `plan_sha256` || '/' || `id` || '.json'),
	CONSTRAINT `migration_import_runs_status_valid` CHECK(`status` IN ('uploaded', 'preflighted', 'committed', 'verified', 'cleaned')),
	CONSTRAINT `migration_import_runs_plan_bytes_valid` CHECK(`plan_bytes` > 0 AND `plan_bytes` <= 6291456),
	CONSTRAINT `migration_import_runs_expected_rows_valid` CHECK(`expected_rows` IS NULL OR `expected_rows` > 0),
	CONSTRAINT `migration_import_runs_statement_count_valid` CHECK(`insert_statements` IS NULL OR (`insert_statements` > 0 AND `insert_statements` <= 43)),
	CONSTRAINT `migration_import_runs_actor_valid` CHECK(length(trim(`created_by_user_id`)) > 0 AND length(trim(`created_by_email`)) > 0),
	CONSTRAINT `migration_import_runs_preflight_json_valid` CHECK(`preflight_json` IS NULL OR json_valid(`preflight_json`)),
	CONSTRAINT `migration_import_runs_verification_json_valid` CHECK(`verification_json` IS NULL OR json_valid(`verification_json`))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_migration_import_runs_plan_sha256` ON `migration_import_runs` (`plan_sha256`);
--> statement-breakpoint
CREATE INDEX `idx_migration_import_runs_status_expires` ON `migration_import_runs` (`status`,`expires_at`);
