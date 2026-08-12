CREATE TABLE `visit_bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_auth_user_id` text NOT NULL,
	`owner_email` text NOT NULL,
	`surname` text NOT NULL,
	`class_year_id` text,
	`class_label` text,
	`visit_date` text NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`purpose` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`cancel_reason` text DEFAULT '' NOT NULL,
	`cancelled_by_auth_user_id` text,
	`cancelled_by_user_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`cancelled_at` text,
	FOREIGN KEY (`class_year_id`) REFERENCES `class_years`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`cancelled_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "visit_bookings_owner_not_blank" CHECK(length(trim("visit_bookings"."owner_auth_user_id")) > 0),
	CONSTRAINT "visit_bookings_email_not_blank" CHECK(length(trim("visit_bookings"."owner_email")) > 0),
	CONSTRAINT "visit_bookings_surname_length" CHECK(length(trim("visit_bookings"."surname")) between 2 and 80),
	CONSTRAINT "visit_bookings_date_valid" CHECK("visit_bookings"."visit_date" glob '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
        and date("visit_bookings"."visit_date", '+0 days') = "visit_bookings"."visit_date"),
	CONSTRAINT "visit_bookings_time_valid" CHECK("visit_bookings"."start_time" glob '[0-9][0-9]:[0-5][0-9]'
        and "visit_bookings"."end_time" glob '[0-9][0-9]:[0-5][0-9]'
        and cast(substr("visit_bookings"."start_time", 1, 2) as integer) between 0 and 23
        and cast(substr("visit_bookings"."end_time", 1, 2) as integer) between 0 and 23
        and cast(substr("visit_bookings"."start_time", 4, 2) as integer) % 5 = 0
        and cast(substr("visit_bookings"."end_time", 4, 2) as integer) % 5 = 0
        and "visit_bookings"."start_time" < "visit_bookings"."end_time"),
	CONSTRAINT "visit_bookings_status_valid" CHECK("visit_bookings"."status" in ('active', 'cancelled')),
	CONSTRAINT "visit_bookings_cancel_consistent" CHECK(("visit_bookings"."status" = 'active' and "visit_bookings"."cancelled_at" is null
          and "visit_bookings"."cancelled_by_auth_user_id" is null and "visit_bookings"."cancelled_by_user_id" is null)
        or ("visit_bookings"."status" = 'cancelled' and "visit_bookings"."cancelled_at" is not null
          and (("visit_bookings"."cancelled_by_auth_user_id" is not null and "visit_bookings"."cancelled_by_user_id" is null)
            or ("visit_bookings"."cancelled_by_auth_user_id" is null and "visit_bookings"."cancelled_by_user_id" is not null)))),
	CONSTRAINT "visit_bookings_version_positive" CHECK("visit_bookings"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_visit_bookings_date_status_time` ON `visit_bookings` (`visit_date`,`status`,`start_time`);--> statement-breakpoint
CREATE INDEX `idx_visit_bookings_owner_status_date` ON `visit_bookings` (`owner_auth_user_id`,`status`,`visit_date`);--> statement-breakpoint
CREATE INDEX `idx_visit_bookings_class_date` ON `visit_bookings` (`class_year_id`,`visit_date`);--> statement-breakpoint
CREATE TABLE `visit_mutation_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_auth_user_id` text NOT NULL,
	`kind` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`target_id` text,
	`result_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	CONSTRAINT "visit_commands_owner_not_blank" CHECK(length(trim("visit_mutation_commands"."owner_auth_user_id")) > 0),
	CONSTRAINT "visit_commands_kind_not_blank" CHECK(length(trim("visit_mutation_commands"."kind")) > 0),
	CONSTRAINT "visit_commands_hash_valid" CHECK(length("visit_mutation_commands"."request_hash") = 64 and lower("visit_mutation_commands"."request_hash") not glob '*[^0-9a-f]*'),
	CONSTRAINT "visit_commands_status_valid" CHECK("visit_mutation_commands"."status" in ('processing', 'completed', 'failed')),
	CONSTRAINT "visit_commands_result_valid" CHECK("visit_mutation_commands"."result_json" is null or json_valid("visit_mutation_commands"."result_json")),
	CONSTRAINT "visit_commands_completion_consistent" CHECK(("visit_mutation_commands"."status" = 'processing' and "visit_mutation_commands"."completed_at" is null)
        or ("visit_mutation_commands"."status" in ('completed', 'failed') and "visit_mutation_commands"."completed_at" is not null))
);
--> statement-breakpoint
CREATE INDEX `idx_visit_commands_owner_created` ON `visit_mutation_commands` (`owner_auth_user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `visit_schedule_closures` (
	`id` text PRIMARY KEY NOT NULL,
	`visit_date` text NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`created_by_user_id` text NOT NULL,
	`cancelled_by_user_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`cancelled_at` text,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`cancelled_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "visit_closures_date_valid" CHECK("visit_schedule_closures"."visit_date" glob '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
        and date("visit_schedule_closures"."visit_date", '+0 days') = "visit_schedule_closures"."visit_date"),
	CONSTRAINT "visit_closures_time_valid" CHECK("visit_schedule_closures"."start_time" glob '[0-9][0-9]:[0-5][0-9]'
        and "visit_schedule_closures"."end_time" glob '[0-9][0-9]:[0-5][0-9]'
        and cast(substr("visit_schedule_closures"."start_time", 1, 2) as integer) between 0 and 23
        and cast(substr("visit_schedule_closures"."end_time", 1, 2) as integer) between 0 and 23
        and cast(substr("visit_schedule_closures"."start_time", 4, 2) as integer) % 5 = 0
        and cast(substr("visit_schedule_closures"."end_time", 4, 2) as integer) % 5 = 0
        and "visit_schedule_closures"."start_time" < "visit_schedule_closures"."end_time"),
	CONSTRAINT "visit_closures_status_valid" CHECK("visit_schedule_closures"."status" in ('active', 'cancelled')),
	CONSTRAINT "visit_closures_cancel_consistent" CHECK(("visit_schedule_closures"."status" = 'active' and "visit_schedule_closures"."cancelled_at" is null and "visit_schedule_closures"."cancelled_by_user_id" is null)
        or ("visit_schedule_closures"."status" = 'cancelled' and "visit_schedule_closures"."cancelled_at" is not null and "visit_schedule_closures"."cancelled_by_user_id" is not null)),
	CONSTRAINT "visit_closures_version_positive" CHECK("visit_schedule_closures"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_visit_closures_date_status_time` ON `visit_schedule_closures` (`visit_date`,`status`,`start_time`);--> statement-breakpoint
CREATE TABLE `visit_schedule_hours` (
	`weekday` integer PRIMARY KEY NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_by_user_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "visit_hours_weekday_valid" CHECK("visit_schedule_hours"."weekday" between 1 and 7),
	CONSTRAINT "visit_hours_time_valid" CHECK("visit_schedule_hours"."start_time" glob '[0-9][0-9]:[0-5][0-9]'
        and "visit_schedule_hours"."end_time" glob '[0-9][0-9]:[0-5][0-9]'
        and cast(substr("visit_schedule_hours"."start_time", 1, 2) as integer) between 0 and 23
        and cast(substr("visit_schedule_hours"."end_time", 1, 2) as integer) between 0 and 23
        and cast(substr("visit_schedule_hours"."start_time", 4, 2) as integer) % 5 = 0
        and cast(substr("visit_schedule_hours"."end_time", 4, 2) as integer) % 5 = 0
        and "visit_schedule_hours"."start_time" < "visit_schedule_hours"."end_time"),
	CONSTRAINT "visit_hours_status_valid" CHECK("visit_schedule_hours"."status" in ('active', 'inactive')),
	CONSTRAINT "visit_hours_version_positive" CHECK("visit_schedule_hours"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE `visit_slot_claims` (
	`segment_key` text PRIMARY KEY NOT NULL,
	`booking_id` text,
	`closure_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`booking_id`) REFERENCES `visit_bookings`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`closure_id`) REFERENCES `visit_schedule_closures`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "visit_slot_claims_exactly_one_owner" CHECK(("visit_slot_claims"."booking_id" is not null and "visit_slot_claims"."closure_id" is null)
        or ("visit_slot_claims"."booking_id" is null and "visit_slot_claims"."closure_id" is not null)),
	CONSTRAINT "visit_slot_claims_key_valid" CHECK("visit_slot_claims"."segment_key" glob '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-9][0-9]:[0-5][0-9]'
        and date(substr("visit_slot_claims"."segment_key", 1, 10), '+0 days') = substr("visit_slot_claims"."segment_key", 1, 10)
        and cast(substr("visit_slot_claims"."segment_key", 12, 2) as integer) between 0 and 23
        and cast(substr("visit_slot_claims"."segment_key", 15, 2) as integer) % 5 = 0)
);
--> statement-breakpoint
CREATE INDEX `idx_visit_slot_claims_booking` ON `visit_slot_claims` (`booking_id`);--> statement-breakpoint
CREATE INDEX `idx_visit_slot_claims_closure` ON `visit_slot_claims` (`closure_id`);