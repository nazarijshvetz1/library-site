CREATE TABLE `acquisition_import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`workbook_sha256` text NOT NULL,
	`file_name` text NOT NULL,
	`row_count` integer NOT NULL,
	`imported_count` integer NOT NULL,
	`status` text DEFAULT 'completed' NOT NULL,
	`result_json` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "acquisition_import_batches_hash_valid" CHECK(length("acquisition_import_batches"."workbook_sha256") = 64),
	CONSTRAINT "acquisition_import_batches_file_not_blank" CHECK(length(trim("acquisition_import_batches"."file_name")) > 0),
	CONSTRAINT "acquisition_import_batches_counts_valid" CHECK("acquisition_import_batches"."row_count" > 0 and "acquisition_import_batches"."imported_count" >= 0 and "acquisition_import_batches"."imported_count" <= "acquisition_import_batches"."row_count"),
	CONSTRAINT "acquisition_import_batches_status_valid" CHECK("acquisition_import_batches"."status" = 'completed'),
	CONSTRAINT "acquisition_import_batches_result_valid" CHECK(json_valid("acquisition_import_batches"."result_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_acquisition_import_batches_sha256` ON `acquisition_import_batches` (`workbook_sha256`);--> statement-breakpoint
CREATE INDEX `idx_acquisition_import_batches_created` ON `acquisition_import_batches` (`created_at`);--> statement-breakpoint
CREATE TABLE `acquisition_public_rate_limits` (
	`scope_hash` text PRIMARY KEY NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`window_started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "acquisition_public_limits_hash_valid" CHECK(length("acquisition_public_rate_limits"."scope_hash") = 64),
	CONSTRAINT "acquisition_public_limits_attempts_valid" CHECK("acquisition_public_rate_limits"."attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_acquisition_public_limits_updated` ON `acquisition_public_rate_limits` (`updated_at`);--> statement-breakpoint
CREATE TABLE `acquisition_receipt_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`inventory_transaction_line_id` text NOT NULL,
	`allocated_quantity` integer NOT NULL,
	`actor_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `acquisition_requests`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`inventory_transaction_line_id`) REFERENCES `inventory_transaction_lines`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "acquisition_receipt_allocated_positive" CHECK("acquisition_receipt_allocations"."allocated_quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_acquisition_receipt_request_line` ON `acquisition_receipt_allocations` (`request_id`,`inventory_transaction_line_id`);--> statement-breakpoint
CREATE INDEX `idx_acquisition_receipt_line` ON `acquisition_receipt_allocations` (`inventory_transaction_line_id`);--> statement-breakpoint
CREATE TABLE `acquisition_request_events` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`actor_user_id` text,
	`actor_kind` text NOT NULL,
	`kind` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`metadata_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `acquisition_requests`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "acquisition_request_events_actor_valid" CHECK("acquisition_request_events"."actor_kind" in ('teacher','student','librarian','import','system')),
	CONSTRAINT "acquisition_request_events_actor_consistent" CHECK(
      ("acquisition_request_events"."actor_kind" in ('student','system') and "acquisition_request_events"."actor_user_id" is null)
      or ("acquisition_request_events"."actor_kind" in ('teacher','librarian','import') and "acquisition_request_events"."actor_user_id" is not null)),
	CONSTRAINT "acquisition_request_events_kind_not_blank" CHECK(length(trim("acquisition_request_events"."kind")) > 0),
	CONSTRAINT "acquisition_request_events_metadata_valid" CHECK("acquisition_request_events"."metadata_json" is null or json_valid("acquisition_request_events"."metadata_json"))
);
--> statement-breakpoint
CREATE INDEX `idx_acquisition_request_events_request_created` ON `acquisition_request_events` (`request_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `acquisition_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`public_number` text NOT NULL,
	`submission_key` text NOT NULL,
	`submission_hash` text NOT NULL,
	`requester_kind` text NOT NULL,
	`teacher_user_id` text,
	`requester_name` text NOT NULL,
	`requester_class_year_id` text,
	`requester_class_name` text DEFAULT '' NOT NULL,
	`category` text NOT NULL,
	`source_kind` text NOT NULL,
	`literature_kind` text DEFAULT 'none' NOT NULL,
	`material_id` text,
	`title` text NOT NULL,
	`author` text NOT NULL,
	`publication_year` integer NOT NULL,
	`requested_quantity` integer NOT NULL,
	`approved_quantity` integer,
	`ordered_quantity` integer DEFAULT 0 NOT NULL,
	`received_quantity` integer DEFAULT 0 NOT NULL,
	`source_url` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`target_class` text DEFAULT '' NOT NULL,
	`requester_note` text DEFAULT '' NOT NULL,
	`librarian_note` text DEFAULT '' NOT NULL,
	`clarification_message` text DEFAULT '' NOT NULL,
	`rejection_reason` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'submitted' NOT NULL,
	`duplicate_key` text NOT NULL,
	`academic_year_id` text NOT NULL,
	`academic_year_label` text DEFAULT '' NOT NULL,
	`import_batch_id` text,
	`source_import_key` text,
	`reviewed_by_user_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`submitted_at` text NOT NULL,
	`reviewed_at` text,
	`approved_at` text,
	`ordered_at` text,
	`received_at` text,
	`rejected_at` text,
	`cancelled_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`teacher_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`requester_class_year_id`) REFERENCES `class_years`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`academic_year_id`) REFERENCES `academic_years`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`import_batch_id`) REFERENCES `acquisition_import_batches`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "acquisition_requests_requester_valid" CHECK(
      ("acquisition_requests"."requester_kind" = 'teacher' and "acquisition_requests"."teacher_user_id" is not null and "acquisition_requests"."requester_class_year_id" is null)
      or ("acquisition_requests"."requester_kind" = 'student' and "acquisition_requests"."teacher_user_id" is null and "acquisition_requests"."requester_class_year_id" is not null and length(trim("acquisition_requests"."requester_class_name")) > 0)),
	CONSTRAINT "acquisition_requests_category_valid" CHECK("acquisition_requests"."category" in ('educational','literature')),
	CONSTRAINT "acquisition_requests_source_valid" CHECK("acquisition_requests"."source_kind" in ('catalog','manual') and ("acquisition_requests"."source_kind" != 'catalog' or "acquisition_requests"."material_id" is not null)),
	CONSTRAINT "acquisition_requests_literature_valid" CHECK(
      ("acquisition_requests"."category" = 'educational' and "acquisition_requests"."literature_kind" = 'none')
      or ("acquisition_requests"."category" = 'literature' and "acquisition_requests"."literature_kind" in ('fiction','science','popular_science','other'))),
	CONSTRAINT "acquisition_requests_student_literature" CHECK("acquisition_requests"."requester_kind" != 'student' or "acquisition_requests"."category" = 'literature'),
	CONSTRAINT "acquisition_requests_text_valid" CHECK(
      length(trim("acquisition_requests"."public_number")) > 0 and length(trim("acquisition_requests"."submission_key")) > 0
      and length("acquisition_requests"."submission_hash") = 64 and length(trim("acquisition_requests"."requester_name")) > 0
      and length(trim("acquisition_requests"."title")) > 0 and length(trim("acquisition_requests"."author")) > 0
      and length(trim("acquisition_requests"."source_url")) > 0 and length(trim("acquisition_requests"."duplicate_key")) > 0
      and length(trim("acquisition_requests"."academic_year_label")) > 0),
	CONSTRAINT "acquisition_requests_year_valid" CHECK("acquisition_requests"."publication_year" between 1000 and 2100),
	CONSTRAINT "acquisition_requests_quantities_valid" CHECK(
      "acquisition_requests"."requested_quantity" between 1 and 1000
      and ("acquisition_requests"."approved_quantity" is null or "acquisition_requests"."approved_quantity" between 0 and 1000)
      and "acquisition_requests"."ordered_quantity" between 0 and 1000
      and "acquisition_requests"."received_quantity" between 0 and 1000
      and "acquisition_requests"."ordered_quantity" <= coalesce("acquisition_requests"."approved_quantity", "acquisition_requests"."requested_quantity")
      and "acquisition_requests"."received_quantity" <= "acquisition_requests"."ordered_quantity"),
	CONSTRAINT "acquisition_requests_status_valid" CHECK("acquisition_requests"."status" in ('submitted','in_review','clarification','approved','planned','ordered','partially_received','received','rejected','cancelled')),
	CONSTRAINT "acquisition_requests_terminal_consistent" CHECK(
      ("acquisition_requests"."status" = 'received' and "acquisition_requests"."received_at" is not null and "acquisition_requests"."received_quantity" > 0)
      or ("acquisition_requests"."status" = 'rejected' and "acquisition_requests"."rejected_at" is not null and length(trim("acquisition_requests"."rejection_reason")) > 0)
      or ("acquisition_requests"."status" = 'cancelled' and "acquisition_requests"."cancelled_at" is not null)
      or ("acquisition_requests"."status" not in ('received','rejected','cancelled') and "acquisition_requests"."received_at" is null and "acquisition_requests"."rejected_at" is null and "acquisition_requests"."cancelled_at" is null)),
	CONSTRAINT "acquisition_requests_version_positive" CHECK("acquisition_requests"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_acquisition_requests_public_number` ON `acquisition_requests` (`public_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_acquisition_requests_submission_key` ON `acquisition_requests` (`submission_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_acquisition_requests_source_import_key` ON `acquisition_requests` (`source_import_key`);--> statement-breakpoint
CREATE INDEX `idx_acquisition_requests_teacher_created` ON `acquisition_requests` (`teacher_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_acquisition_requests_status_created` ON `acquisition_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_acquisition_requests_duplicate_status` ON `acquisition_requests` (`academic_year_id`,`duplicate_key`,`status`);--> statement-breakpoint
CREATE INDEX `idx_acquisition_requests_year_status` ON `acquisition_requests` (`academic_year_id`,`status`);