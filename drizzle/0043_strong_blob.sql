CREATE TABLE `library_catalog_entities` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`public_metadata_json` text DEFAULT '{}' NOT NULL,
	`source_json` text DEFAULT '{}' NOT NULL,
	`import_run_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`import_run_id`) REFERENCES `library_import_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "library_entity_kind" CHECK("library_catalog_entities"."kind" in ('author','publisher','genre','tag','series')),
	CONSTRAINT "library_entity_name" CHECK(length(trim("library_catalog_entities"."name"))>0),
	CONSTRAINT "library_entity_metadata" CHECK(json_valid("library_catalog_entities"."public_metadata_json") and json_valid("library_catalog_entities"."source_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_library_entity_slug` ON `library_catalog_entities` (`kind`,`slug`);--> statement-breakpoint
CREATE INDEX `idx_library_entity_name` ON `library_catalog_entities` (`kind`,`name`);--> statement-breakpoint
CREATE TABLE `library_copies` (
	`id` text PRIMARY KEY NOT NULL,
	`source_copy_id` text,
	`edition_id` text NOT NULL,
	`accession_no` text NOT NULL,
	`copy_no` text DEFAULT '' NOT NULL,
	`location_id` text,
	`condition` text DEFAULT 'unspecified' NOT NULL,
	`physical_state` text DEFAULT 'unknown' NOT NULL,
	`registration` text DEFAULT 'unreconciled' NOT NULL,
	`source_json` text DEFAULT '{}' NOT NULL,
	`source_row_sha256` text,
	`import_run_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`edition_id`) REFERENCES `library_editions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`import_run_id`) REFERENCES `library_import_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "library_copy_condition" CHECK("library_copies"."condition" in ('unspecified','good','worn','damaged')),
	CONSTRAINT "library_copy_state" CHECK("library_copies"."physical_state" in ('unknown','on_shelf','on_loan','withdrawn')),
	CONSTRAINT "library_copy_registration" CHECK("library_copies"."registration" in ('unreconciled','registered')),
	CONSTRAINT "library_copy_registration_consistency" CHECK("library_copies"."registration"='unreconciled' or ("library_copies"."location_id" is not null and "library_copies"."physical_state"!='unknown')),
	CONSTRAINT "library_copy_source_json" CHECK(json_valid("library_copies"."source_json")),
	CONSTRAINT "library_copy_version" CHECK("library_copies"."version">0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_library_copy_source` ON `library_copies` (`source_copy_id`);--> statement-breakpoint
CREATE INDEX `idx_library_copy_accession` ON `library_copies` (`accession_no`);--> statement-breakpoint
CREATE INDEX `idx_library_copy_stock` ON `library_copies` (`edition_id`,`location_id`,`condition`,`registration`,`physical_state`);--> statement-breakpoint
CREATE TABLE `library_edition_entities` (
	`edition_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`edition_id`, `entity_id`, `role`),
	FOREIGN KEY (`edition_id`) REFERENCES `library_editions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`entity_id`) REFERENCES `library_catalog_entities`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "library_edition_entity_role" CHECK("library_edition_entities"."role" in ('author','coauthor','editor','illustrator','publisher','genre','tag','series'))
);
--> statement-breakpoint
CREATE INDEX `idx_library_edition_entity` ON `library_edition_entities` (`entity_id`,`edition_id`);--> statement-breakpoint
CREATE TABLE `library_editions` (
	`id` text PRIMARY KEY NOT NULL,
	`source_media_id` text,
	`material_id` text,
	`fund` text DEFAULT 'literature' NOT NULL,
	`title` text NOT NULL,
	`public_metadata_json` text DEFAULT '{}' NOT NULL,
	`source_json` text DEFAULT '{}' NOT NULL,
	`source_row_sha256` text,
	`import_run_id` text,
	`publication_state` text DEFAULT 'draft' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`import_run_id`) REFERENCES `library_import_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "library_edition_title" CHECK(length(trim("library_editions"."title"))>0),
	CONSTRAINT "library_edition_fund" CHECK("library_editions"."fund" in ('education','literature')),
	CONSTRAINT "library_edition_publication" CHECK("library_editions"."publication_state" in ('draft','published','archived')),
	CONSTRAINT "library_edition_metadata" CHECK(json_valid("library_editions"."public_metadata_json") and json_valid("library_editions"."source_json")),
	CONSTRAINT "library_edition_version" CHECK("library_editions"."version">0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_library_editions_source` ON `library_editions` (`source_media_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_library_editions_material` ON `library_editions` (`material_id`);--> statement-breakpoint
CREATE INDEX `idx_library_editions_fund_title` ON `library_editions` (`fund`,`publication_state`,`title`,`id`);--> statement-breakpoint
CREATE TABLE `library_import_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`manifest_sha256` text NOT NULL,
	`source_exported_at` text NOT NULL,
	`state` text DEFAULT 'loading' NOT NULL,
	`expected_counts_json` text NOT NULL,
	`reconciliation_json` text,
	`recovery_sha256` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`verified_at` text,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "library_import_state" CHECK("library_import_runs"."state" in ('loading','verified','reconciled')),
	CONSTRAINT "library_import_counts_json" CHECK(json_valid("library_import_runs"."expected_counts_json")),
	CONSTRAINT "library_import_reconciliation_json" CHECK("library_import_runs"."reconciliation_json" is null or json_valid("library_import_runs"."reconciliation_json")),
	CONSTRAINT "library_import_manifest_hash" CHECK(length("library_import_runs"."manifest_sha256")=64 and "library_import_runs"."manifest_sha256" not glob '*[^0-9a-f]*'),
	CONSTRAINT "library_import_recovery_hash" CHECK(length("library_import_runs"."recovery_sha256")=64 and "library_import_runs"."recovery_sha256" not glob '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_library_import_manifest` ON `library_import_runs` (`manifest_sha256`);--> statement-breakpoint
CREATE TABLE `library_readers` (
	`id` text PRIMARY KEY NOT NULL,
	`source_member_id` text,
	`member_no` text NOT NULL,
	`full_name` text NOT NULL,
	`sort_name` text NOT NULL,
	`kind` text DEFAULT 'unclassified' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`access_status` text DEFAULT 'inactive' NOT NULL,
	`access_version` integer DEFAULT 1 NOT NULL,
	`linked_teacher_user_id` text,
	`source_group_label` text DEFAULT '' NOT NULL,
	`source_group_id` text,
	`source_json` text DEFAULT '{}' NOT NULL,
	`source_row_sha256` text,
	`import_run_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`linked_teacher_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`import_run_id`) REFERENCES `library_import_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "library_reader_name" CHECK(length(trim("library_readers"."full_name"))>0 and length(trim("library_readers"."sort_name"))>0),
	CONSTRAINT "library_reader_kind" CHECK("library_readers"."kind" in ('student','teacher','staff','other','unclassified')),
	CONSTRAINT "library_reader_status" CHECK("library_readers"."status" in ('active','inactive')),
	CONSTRAINT "library_reader_access" CHECK("library_readers"."access_status" in ('inactive','active','blocked')),
	CONSTRAINT "library_reader_student_isolation" CHECK("library_readers"."kind"!='student' or "library_readers"."linked_teacher_user_id" is null),
	CONSTRAINT "library_reader_versions" CHECK("library_readers"."version">0 and "library_readers"."access_version">0),
	CONSTRAINT "library_reader_source_json" CHECK(json_valid("library_readers"."source_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_library_readers_source` ON `library_readers` (`source_member_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_library_readers_number` ON `library_readers` (`member_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_library_readers_teacher` ON `library_readers` (`linked_teacher_user_id`);--> statement-breakpoint
CREATE INDEX `idx_library_readers_directory` ON `library_readers` (`kind`,`status`,`sort_name`,`id`);--> statement-breakpoint
CREATE TABLE `reader_circulations` (
	`id` text PRIMARY KEY NOT NULL,
	`source_circulation_id` text,
	`copy_id` text NOT NULL,
	`reader_id` text NOT NULL,
	`status` text NOT NULL,
	`issued_at` text,
	`due_at` text,
	`received_at` text,
	`accounting_mode` text DEFAULT 'unreconciled' NOT NULL,
	`legacy_loan_item_id` text,
	`legacy_class_loan_item_id` text,
	`source_json` text DEFAULT '{}' NOT NULL,
	`source_row_sha256` text,
	`import_run_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`copy_id`) REFERENCES `library_copies`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reader_id`) REFERENCES `library_readers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`legacy_loan_item_id`) REFERENCES `loan_items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`legacy_class_loan_item_id`) REFERENCES `class_loan_items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`import_run_id`) REFERENCES `library_import_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "reader_circulation_status" CHECK("reader_circulations"."status" in ('issued','overdue','returned','cancelled','pending','reserved')),
	CONSTRAINT "reader_circulation_accounting" CHECK(("reader_circulations"."accounting_mode" in ('unreconciled','native') and "reader_circulations"."legacy_loan_item_id" is null and "reader_circulations"."legacy_class_loan_item_id" is null) or ("reader_circulations"."accounting_mode"='legacy_teacher' and "reader_circulations"."legacy_loan_item_id" is not null and "reader_circulations"."legacy_class_loan_item_id" is null) or ("reader_circulations"."accounting_mode"='legacy_class' and "reader_circulations"."legacy_class_loan_item_id" is not null and "reader_circulations"."legacy_loan_item_id" is null)),
	CONSTRAINT "reader_circulation_json" CHECK(json_valid("reader_circulations"."source_json")),
	CONSTRAINT "reader_circulation_version" CHECK("reader_circulations"."version">0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reader_circulation_source` ON `reader_circulations` (`source_circulation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reader_outstanding_copy` ON `reader_circulations` (`copy_id`) WHERE "reader_circulations"."status" in ('issued','overdue');--> statement-breakpoint
CREATE INDEX `idx_reader_circulation_reader` ON `reader_circulations` (`reader_id`,`status`,`due_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_reader_circulation_copy` ON `reader_circulations` (`copy_id`,`status`);--> statement-breakpoint
CREATE TABLE `reader_class_enrollments` (
	`id` text PRIMARY KEY NOT NULL,
	`reader_id` text NOT NULL,
	`class_year_id` text NOT NULL,
	`observed_at` text NOT NULL,
	`ended_at` text,
	`import_run_id` text,
	FOREIGN KEY (`reader_id`) REFERENCES `library_readers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`class_year_id`) REFERENCES `class_years`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`import_run_id`) REFERENCES `library_import_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "reader_enrollment_dates" CHECK("reader_class_enrollments"."ended_at" is null or "reader_class_enrollments"."ended_at">="reader_class_enrollments"."observed_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reader_current_class` ON `reader_class_enrollments` (`reader_id`) WHERE "reader_class_enrollments"."ended_at" is null;--> statement-breakpoint
CREATE INDEX `idx_reader_enrollment_class` ON `reader_class_enrollments` (`class_year_id`,`ended_at`,`reader_id`);