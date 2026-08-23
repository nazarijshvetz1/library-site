PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_acquisition_requests` (
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
	`publication_year` integer,
	`requested_quantity` integer DEFAULT 1 NOT NULL,
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
      ("__new_acquisition_requests"."requester_kind" = 'teacher' and "__new_acquisition_requests"."teacher_user_id" is not null and "__new_acquisition_requests"."requester_class_year_id" is null)
      or ("__new_acquisition_requests"."requester_kind" = 'student' and "__new_acquisition_requests"."teacher_user_id" is null and "__new_acquisition_requests"."requester_class_year_id" is not null and length(trim("__new_acquisition_requests"."requester_class_name")) > 0)),
	CONSTRAINT "acquisition_requests_category_valid" CHECK("__new_acquisition_requests"."category" in ('educational','literature')),
	CONSTRAINT "acquisition_requests_source_valid" CHECK("__new_acquisition_requests"."source_kind" in ('catalog','manual') and ("__new_acquisition_requests"."source_kind" != 'catalog' or "__new_acquisition_requests"."material_id" is not null)),
	CONSTRAINT "acquisition_requests_literature_valid" CHECK(
      ("__new_acquisition_requests"."category" = 'educational' and "__new_acquisition_requests"."literature_kind" = 'none')
      or ("__new_acquisition_requests"."category" = 'literature' and "__new_acquisition_requests"."literature_kind" in ('fiction','science','popular_science','other'))),
	CONSTRAINT "acquisition_requests_student_literature" CHECK("__new_acquisition_requests"."requester_kind" != 'student' or "__new_acquisition_requests"."category" = 'literature'),
	CONSTRAINT "acquisition_requests_text_valid" CHECK(
      length(trim("__new_acquisition_requests"."public_number")) > 0 and length(trim("__new_acquisition_requests"."submission_key")) > 0
      and length("__new_acquisition_requests"."submission_hash") = 64 and length(trim("__new_acquisition_requests"."requester_name")) > 0
      and length(trim("__new_acquisition_requests"."title")) > 0
      and ("__new_acquisition_requests"."requester_kind" = 'student' or length(trim("__new_acquisition_requests"."author")) > 0)
      and ("__new_acquisition_requests"."requester_kind" = 'student' or ("__new_acquisition_requests"."category" = 'educational' and "__new_acquisition_requests"."source_kind" = 'catalog') or length(trim("__new_acquisition_requests"."source_url")) > 0)
      and length(trim("__new_acquisition_requests"."duplicate_key")) > 0
      and length(trim("__new_acquisition_requests"."academic_year_label")) > 0),
	CONSTRAINT "acquisition_requests_year_valid" CHECK(
      ("__new_acquisition_requests"."requester_kind" = 'student' and ("__new_acquisition_requests"."publication_year" is null or "__new_acquisition_requests"."publication_year" between 1000 and 2100))
      or ("__new_acquisition_requests"."requester_kind" = 'teacher' and "__new_acquisition_requests"."publication_year" is not null and "__new_acquisition_requests"."publication_year" between 1000 and 2100)),
	CONSTRAINT "acquisition_requests_quantities_valid" CHECK(
      "__new_acquisition_requests"."requested_quantity" between 1 and 1000
      and ("__new_acquisition_requests"."approved_quantity" is null or "__new_acquisition_requests"."approved_quantity" between 0 and 1000)
      and "__new_acquisition_requests"."ordered_quantity" between 0 and 1000
      and "__new_acquisition_requests"."received_quantity" between 0 and 1000
      and "__new_acquisition_requests"."ordered_quantity" <= coalesce("__new_acquisition_requests"."approved_quantity", "__new_acquisition_requests"."requested_quantity")
      and "__new_acquisition_requests"."received_quantity" <= "__new_acquisition_requests"."ordered_quantity"),
	CONSTRAINT "acquisition_requests_status_valid" CHECK("__new_acquisition_requests"."status" in ('submitted','in_review','clarification','approved','planned','ordered','partially_received','received','rejected','cancelled')),
	CONSTRAINT "acquisition_requests_terminal_consistent" CHECK(
      ("__new_acquisition_requests"."status" = 'received' and "__new_acquisition_requests"."received_at" is not null and "__new_acquisition_requests"."received_quantity" > 0)
      or ("__new_acquisition_requests"."status" = 'rejected' and "__new_acquisition_requests"."rejected_at" is not null and length(trim("__new_acquisition_requests"."rejection_reason")) > 0)
      or ("__new_acquisition_requests"."status" = 'cancelled' and "__new_acquisition_requests"."cancelled_at" is not null)
      or ("__new_acquisition_requests"."status" not in ('received','rejected','cancelled') and "__new_acquisition_requests"."received_at" is null and "__new_acquisition_requests"."rejected_at" is null and "__new_acquisition_requests"."cancelled_at" is null)),
	CONSTRAINT "acquisition_requests_version_positive" CHECK("__new_acquisition_requests"."version" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_acquisition_requests`("id", "public_number", "submission_key", "submission_hash", "requester_kind", "teacher_user_id", "requester_name", "requester_class_year_id", "requester_class_name", "category", "source_kind", "literature_kind", "material_id", "title", "author", "publication_year", "requested_quantity", "approved_quantity", "ordered_quantity", "received_quantity", "source_url", "subject", "target_class", "requester_note", "librarian_note", "clarification_message", "rejection_reason", "status", "duplicate_key", "academic_year_id", "academic_year_label", "import_batch_id", "source_import_key", "reviewed_by_user_id", "version", "submitted_at", "reviewed_at", "approved_at", "ordered_at", "received_at", "rejected_at", "cancelled_at", "created_at", "updated_at") SELECT "id", "public_number", "submission_key", "submission_hash", "requester_kind", "teacher_user_id", "requester_name", "requester_class_year_id", "requester_class_name", "category", "source_kind", "literature_kind", "material_id", "title", "author", "publication_year", "requested_quantity", "approved_quantity", "ordered_quantity", "received_quantity", "source_url", "subject", "target_class", "requester_note", "librarian_note", "clarification_message", "rejection_reason", "status", "duplicate_key", "academic_year_id", "academic_year_label", "import_batch_id", "source_import_key", "reviewed_by_user_id", "version", "submitted_at", "reviewed_at", "approved_at", "ordered_at", "received_at", "rejected_at", "cancelled_at", "created_at", "updated_at" FROM `acquisition_requests`;--> statement-breakpoint
DROP TABLE `acquisition_requests`;--> statement-breakpoint
ALTER TABLE `__new_acquisition_requests` RENAME TO `acquisition_requests`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_acquisition_requests_public_number` ON `acquisition_requests` (`public_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_acquisition_requests_submission_key` ON `acquisition_requests` (`submission_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_acquisition_requests_source_import_key` ON `acquisition_requests` (`source_import_key`);--> statement-breakpoint
CREATE INDEX `idx_acquisition_requests_teacher_created` ON `acquisition_requests` (`teacher_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_acquisition_requests_status_created` ON `acquisition_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_acquisition_requests_duplicate_status` ON `acquisition_requests` (`academic_year_id`,`duplicate_key`,`status`);--> statement-breakpoint
CREATE INDEX `idx_acquisition_requests_year_status` ON `acquisition_requests` (`academic_year_id`,`status`);--> statement-breakpoint
PRAGMA foreign_key_check;
