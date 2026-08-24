CREATE TABLE `teacher_curator_change_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`teacher_user_id` text NOT NULL,
	`current_class_year_id` text,
	`requested_class_year_id` text NOT NULL,
	`status` text DEFAULT 'submitted' NOT NULL,
	`teacher_note` text DEFAULT '' NOT NULL,
	`librarian_note` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`last_mutation_request_id` text,
	`resolved_by_user_id` text,
	`resolved_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`teacher_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`current_class_year_id`) REFERENCES `class_years`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`requested_class_year_id`) REFERENCES `class_years`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`resolved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "teacher_curator_requests_status_valid" CHECK(`status` in ('submitted','approved','rejected','cancelled')),
	CONSTRAINT "teacher_curator_requests_note_length" CHECK(length(`teacher_note`) <= 1000 and length(`librarian_note`) <= 2000),
	CONSTRAINT "teacher_curator_requests_version_positive" CHECK(`version` > 0),
	CONSTRAINT "teacher_curator_requests_changes_class" CHECK(`current_class_year_id` is null or `current_class_year_id` != `requested_class_year_id`),
	CONSTRAINT "teacher_curator_requests_resolution_consistent" CHECK(
		(`status` = 'submitted' and `resolved_at` is null and `resolved_by_user_id` is null)
		or (`status` in ('approved','rejected') and `resolved_at` is not null and `resolved_by_user_id` is not null)
		or (`status` = 'cancelled' and `resolved_at` is not null and `resolved_by_user_id` is null)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_teacher_curator_requests_open_teacher`
	ON `teacher_curator_change_requests` (`teacher_user_id`) WHERE `status` = 'submitted';
--> statement-breakpoint
CREATE INDEX `idx_teacher_curator_requests_status_created`
	ON `teacher_curator_change_requests` (`status`,`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_teacher_curator_requests_teacher_created`
	ON `teacher_curator_change_requests` (`teacher_user_id`,`created_at`,`id`);
--> statement-breakpoint
ALTER TABLE `portal_notifications` ADD `deleted_at` text;
