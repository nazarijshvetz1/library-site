CREATE TABLE `class_loan_items` (
	`id` text PRIMARY KEY NOT NULL,
	`class_loan_id` text NOT NULL,
	`material_id` text NOT NULL,
	`source_location_id` text NOT NULL,
	`condition` text DEFAULT 'unspecified' NOT NULL,
	`quantity_issued` integer NOT NULL,
	`quantity_returned` integer DEFAULT 0 NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`class_loan_id`) REFERENCES `class_loans`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`source_location_id`) REFERENCES `locations`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "class_loan_items_condition_valid" CHECK("class_loan_items"."condition" in ('unspecified', 'good', 'worn', 'damaged')),
	CONSTRAINT "class_loan_items_quantity_issued_positive" CHECK("class_loan_items"."quantity_issued" > 0),
	CONSTRAINT "class_loan_items_quantity_returned_valid" CHECK("class_loan_items"."quantity_returned" >= 0 and "class_loan_items"."quantity_returned" <= "class_loan_items"."quantity_issued")
);
--> statement-breakpoint
CREATE INDEX `idx_class_loan_items_loan_material` ON `class_loan_items` (`class_loan_id`,`material_id`);--> statement-breakpoint
CREATE INDEX `idx_class_loan_items_material_loan` ON `class_loan_items` (`material_id`,`class_loan_id`);--> statement-breakpoint
CREATE TABLE `class_loan_transaction_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`transaction_id` text NOT NULL,
	`class_loan_item_id` text NOT NULL,
	`material_id` text NOT NULL,
	`location_id` text NOT NULL,
	`condition` text DEFAULT 'unspecified' NOT NULL,
	`quantity_delta` integer NOT NULL,
	`quantity_before` integer NOT NULL,
	`quantity_after` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `class_loan_transactions`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`class_loan_item_id`) REFERENCES `class_loan_items`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "class_loan_lines_condition_valid" CHECK("class_loan_transaction_lines"."condition" in ('unspecified', 'good', 'worn', 'damaged')),
	CONSTRAINT "class_loan_lines_quantities_nonnegative" CHECK("class_loan_transaction_lines"."quantity_before" >= 0 and "class_loan_transaction_lines"."quantity_after" >= 0),
	CONSTRAINT "class_loan_lines_delta_balanced" CHECK("class_loan_transaction_lines"."quantity_after" = "class_loan_transaction_lines"."quantity_before" + "class_loan_transaction_lines"."quantity_delta"),
	CONSTRAINT "class_loan_lines_delta_nonzero" CHECK("class_loan_transaction_lines"."quantity_delta" != 0)
);
--> statement-breakpoint
CREATE INDEX `idx_class_loan_lines_transaction` ON `class_loan_transaction_lines` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `idx_class_loan_lines_item` ON `class_loan_transaction_lines` (`class_loan_item_id`);--> statement-breakpoint
CREATE INDEX `idx_class_loan_lines_material_transaction` ON `class_loan_transaction_lines` (`material_id`,`transaction_id`);--> statement-breakpoint
CREATE TABLE `class_loan_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`class_loan_id` text NOT NULL,
	`kind` text NOT NULL,
	`occurred_at` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`actor_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`class_loan_id`) REFERENCES `class_loans`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "class_loan_transactions_kind_valid" CHECK("class_loan_transactions"."kind" in ('issue', 'return'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_class_loan_transactions_request` ON `class_loan_transactions` (`request_id`);--> statement-breakpoint
CREATE INDEX `idx_class_loan_transactions_loan_occurred` ON `class_loan_transactions` (`class_loan_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_class_loan_transactions_actor_occurred` ON `class_loan_transactions` (`actor_user_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `class_loans` (
	`id` text PRIMARY KEY NOT NULL,
	`class_year_id` text NOT NULL,
	`responsible_teacher_user_id` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`issued_at` text NOT NULL,
	`due_at` text,
	`closed_at` text,
	`notes` text DEFAULT '' NOT NULL,
	`issued_by_user_id` text NOT NULL,
	`closed_by_user_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`class_year_id`) REFERENCES `class_years`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`responsible_teacher_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`issued_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`closed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "class_loans_status_valid" CHECK("class_loans"."status" in ('open', 'closed', 'cancelled')),
	CONSTRAINT "class_loans_due_after_issue" CHECK("class_loans"."due_at" is null or "class_loans"."due_at" >= "class_loans"."issued_at"),
	CONSTRAINT "class_loans_closed_fields_consistent" CHECK(("class_loans"."status" = 'closed' and "class_loans"."closed_at" is not null and "class_loans"."closed_by_user_id" is not null)
        or ("class_loans"."status" != 'closed' and "class_loans"."closed_at" is null and "class_loans"."closed_by_user_id" is null)),
	CONSTRAINT "class_loans_version_positive" CHECK("class_loans"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_class_loans_class_status_due` ON `class_loans` (`class_year_id`,`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `idx_class_loans_status_due` ON `class_loans` (`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `idx_class_loans_teacher_status_due` ON `class_loans` (`responsible_teacher_user_id`,`status`,`due_at`);