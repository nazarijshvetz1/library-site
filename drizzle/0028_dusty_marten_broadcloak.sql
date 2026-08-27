PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_class_loans` (
	`id` text PRIMARY KEY NOT NULL,
	`class_year_id` text NOT NULL,
	`responsible_teacher_user_id` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`issued_at` text NOT NULL,
	`due_at` text,
	`closed_at` text,
	`notes` text DEFAULT '' NOT NULL,
	`issue_statement_schema_version` integer DEFAULT 0 NOT NULL,
	`issue_statement_json` text DEFAULT '' NOT NULL,
	`issue_statement_origin` text DEFAULT 'legacy' NOT NULL,
	`issued_by_user_id` text NOT NULL,
	`closed_by_user_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`class_year_id`) REFERENCES `class_years`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`responsible_teacher_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`issued_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`closed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "class_loans_status_valid" CHECK("__new_class_loans"."status" in ('open', 'closed', 'cancelled')),
	CONSTRAINT "class_loans_due_after_issue" CHECK("__new_class_loans"."due_at" is null or "__new_class_loans"."due_at" >= "__new_class_loans"."issued_at"),
	CONSTRAINT "class_loans_closed_fields_consistent" CHECK(("__new_class_loans"."status" = 'closed' and "__new_class_loans"."closed_at" is not null and "__new_class_loans"."closed_by_user_id" is not null)
        or ("__new_class_loans"."status" != 'closed' and "__new_class_loans"."closed_at" is null and "__new_class_loans"."closed_by_user_id" is null)),
	CONSTRAINT "class_loans_version_positive" CHECK("__new_class_loans"."version" > 0),
	CONSTRAINT "class_loans_issue_statement_valid" CHECK(("__new_class_loans"."issue_statement_schema_version" = 0
          and "__new_class_loans"."issue_statement_json" = ''
          and "__new_class_loans"."issue_statement_origin" = 'legacy')
        or ("__new_class_loans"."issue_statement_schema_version" = 1
          and json_valid("__new_class_loans"."issue_statement_json")
          and "__new_class_loans"."issue_statement_origin" in ('issued', 'legacy_backfill')))
);
--> statement-breakpoint
INSERT INTO `__new_class_loans`("id", "class_year_id", "responsible_teacher_user_id", "status", "issued_at", "due_at", "closed_at", "notes", "issue_statement_schema_version", "issue_statement_json", "issue_statement_origin", "issued_by_user_id", "closed_by_user_id", "version", "created_at", "updated_at") SELECT "id", "class_year_id", "responsible_teacher_user_id", "status", "issued_at", "due_at", "closed_at", "notes", 0, '', 'legacy', "issued_by_user_id", "closed_by_user_id", "version", "created_at", "updated_at" FROM `class_loans`;--> statement-breakpoint
DROP TABLE `class_loans`;--> statement-breakpoint
ALTER TABLE `__new_class_loans` RENAME TO `class_loans`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_class_loans_class_status_due` ON `class_loans` (`class_year_id`,`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `idx_class_loans_status_due` ON `class_loans` (`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `idx_class_loans_teacher_status_due` ON `class_loans` (`responsible_teacher_user_id`,`status`,`due_at`);--> statement-breakpoint
CREATE TRIGGER `class_loans_issue_statement_immutable`
BEFORE UPDATE OF `issue_statement_schema_version`, `issue_statement_json`, `issue_statement_origin`
ON `class_loans`
WHEN OLD.`issue_statement_schema_version` != NEW.`issue_statement_schema_version`
  OR OLD.`issue_statement_json` != NEW.`issue_statement_json`
  OR OLD.`issue_statement_origin` != NEW.`issue_statement_origin`
BEGIN
  SELECT RAISE(ABORT, 'class issue statement is immutable');
END;
