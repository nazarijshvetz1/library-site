CREATE TABLE `visit_guest_rate_limits` (
	`scope_hash` text PRIMARY KEY NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`window_started_at` text NOT NULL,
	`blocked_until` text,
	`updated_at` text NOT NULL,
	CONSTRAINT "visit_guest_rate_limits_scope_valid" CHECK(length(`scope_hash`) = 64 and lower(`scope_hash`) not glob '*[^0-9a-f]*'),
	CONSTRAINT "visit_guest_rate_limits_attempts_nonnegative" CHECK(`attempts` >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_visit_guest_rate_limits_updated` ON `visit_guest_rate_limits` (`updated_at`);--> statement-breakpoint
CREATE TABLE `visit_guest_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`pending_scope` text NOT NULL,
	`ip_scope_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`revoked_at` text,
	`created_at` text NOT NULL,
	CONSTRAINT "visit_guest_sessions_token_hash_valid" CHECK(length(`token_hash`) = 64 and lower(`token_hash`) not glob '*[^0-9a-f]*'),
	CONSTRAINT "visit_guest_sessions_ip_hash_valid" CHECK(length(`ip_scope_hash`) = 64 and lower(`ip_scope_hash`) not glob '*[^0-9a-f]*'),
	CONSTRAINT "visit_guest_sessions_pending_scope_not_blank" CHECK(length(trim(`pending_scope`)) between 16 and 128)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_visit_guest_sessions_token_hash` ON `visit_guest_sessions` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_visit_guest_sessions_pending_scope` ON `visit_guest_sessions` (`pending_scope`);--> statement-breakpoint
CREATE INDEX `idx_visit_guest_sessions_expires` ON `visit_guest_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `__visit_slot_claims_0009_backup` AS SELECT * FROM `visit_slot_claims`;--> statement-breakpoint
DROP TABLE `visit_slot_claims`;--> statement-breakpoint
CREATE TABLE `__new_visit_bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_kind` text DEFAULT 'teacher' NOT NULL,
	`owner_user_id` text,
	`owner_auth_user_id` text,
	`owner_email` text,
	`guest_owner_id` text,
	`selected_teacher_user_id` text,
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
	`cancelled_by_guest_owner_id` text,
	`last_mutation_request_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`cancelled_at` text,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`guest_owner_id`) REFERENCES `visit_guest_sessions`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`selected_teacher_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`class_year_id`) REFERENCES `class_years`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`cancelled_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`cancelled_by_guest_owner_id`) REFERENCES `visit_guest_sessions`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "visit_bookings_owner_valid" CHECK(
		(`owner_kind` = 'teacher' and `owner_user_id` is not null and `owner_auth_user_id` is null and `owner_email` is null and `guest_owner_id` is null and `selected_teacher_user_id` is null)
		or (`owner_kind` = 'guest' and `owner_user_id` is null and `owner_auth_user_id` is null and `owner_email` is null and `guest_owner_id` is not null and `selected_teacher_user_id` is not null)
		or (`owner_kind` = 'legacy' and `owner_user_id` is null and length(trim(`owner_auth_user_id`)) > 0 and length(trim(`owner_email`)) > 0 and `guest_owner_id` is null and `selected_teacher_user_id` is null)
	),
	CONSTRAINT "visit_bookings_surname_length" CHECK(length(trim(`surname`)) between 2 and 80),
	CONSTRAINT "visit_bookings_date_valid" CHECK(`visit_date` glob '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' and date(`visit_date`, '+0 days') = `visit_date`),
	CONSTRAINT "visit_bookings_time_valid" CHECK(`start_time` glob '[0-9][0-9]:[0-5][0-9]' and `end_time` glob '[0-9][0-9]:[0-5][0-9]' and cast(substr(`start_time`, 1, 2) as integer) between 0 and 23 and cast(substr(`end_time`, 1, 2) as integer) between 0 and 23 and cast(substr(`start_time`, 4, 2) as integer) % 5 = 0 and cast(substr(`end_time`, 4, 2) as integer) % 5 = 0 and `start_time` < `end_time`),
	CONSTRAINT "visit_bookings_status_valid" CHECK(`status` in ('active', 'cancelled')),
	CONSTRAINT "visit_bookings_cancel_consistent" CHECK(
		(`status` = 'active' and `cancelled_at` is null and `cancelled_by_auth_user_id` is null and `cancelled_by_user_id` is null and `cancelled_by_guest_owner_id` is null)
		or (`status` = 'cancelled' and `cancelled_at` is not null and (
			(`cancelled_by_auth_user_id` is not null and `cancelled_by_user_id` is null and `cancelled_by_guest_owner_id` is null)
			or (`cancelled_by_auth_user_id` is null and `cancelled_by_user_id` is not null and `cancelled_by_guest_owner_id` is null)
			or (`cancelled_by_auth_user_id` is null and `cancelled_by_user_id` is null and `cancelled_by_guest_owner_id` is not null)
		))
	),
	CONSTRAINT "visit_bookings_version_positive" CHECK(`version` > 0),
	CONSTRAINT "visit_bookings_mutation_request_valid" CHECK(`last_mutation_request_id` is null or length(`last_mutation_request_id`) = 36)
);
--> statement-breakpoint
INSERT INTO `__new_visit_bookings` (
	`id`,`owner_kind`,`owner_user_id`,`owner_auth_user_id`,`owner_email`,`guest_owner_id`,`selected_teacher_user_id`,
	`surname`,`class_year_id`,`class_label`,`visit_date`,`start_time`,`end_time`,`purpose`,`status`,`cancel_reason`,
	`cancelled_by_auth_user_id`,`cancelled_by_user_id`,`cancelled_by_guest_owner_id`,`last_mutation_request_id`,`version`,`created_at`,`updated_at`,`cancelled_at`
)
SELECT `id`, CASE WHEN `owner_user_id` IS NOT NULL THEN 'teacher' ELSE 'legacy' END,
	`owner_user_id`,`owner_auth_user_id`,`owner_email`,NULL,NULL,
	`surname`,`class_year_id`,`class_label`,`visit_date`,`start_time`,`end_time`,`purpose`,`status`,`cancel_reason`,
	`cancelled_by_auth_user_id`,`cancelled_by_user_id`,NULL,NULL,`version`,`created_at`,`updated_at`,`cancelled_at`
FROM `visit_bookings`;--> statement-breakpoint
DROP TABLE `visit_bookings`;--> statement-breakpoint
ALTER TABLE `__new_visit_bookings` RENAME TO `visit_bookings`;--> statement-breakpoint
CREATE INDEX `idx_visit_bookings_date_status_time` ON `visit_bookings` (`visit_date`,`status`,`start_time`);--> statement-breakpoint
CREATE INDEX `idx_visit_bookings_owner_status_date` ON `visit_bookings` (`owner_auth_user_id`,`status`,`visit_date`);--> statement-breakpoint
CREATE INDEX `idx_visit_bookings_owner_user_status_date` ON `visit_bookings` (`owner_user_id`,`status`,`visit_date`);--> statement-breakpoint
CREATE INDEX `idx_visit_bookings_guest_owner_status_date` ON `visit_bookings` (`guest_owner_id`,`status`,`visit_date`);--> statement-breakpoint
CREATE INDEX `idx_visit_bookings_selected_teacher_date` ON `visit_bookings` (`selected_teacher_user_id`,`visit_date`);--> statement-breakpoint
CREATE INDEX `idx_visit_bookings_class_date` ON `visit_bookings` (`class_year_id`,`visit_date`);--> statement-breakpoint
CREATE TABLE `visit_slot_claims` (
	`segment_key` text PRIMARY KEY NOT NULL,
	`booking_id` text,
	`closure_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`booking_id`) REFERENCES `visit_bookings`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`closure_id`) REFERENCES `visit_schedule_closures`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "visit_slot_claims_exactly_one_owner" CHECK((`booking_id` is not null and `closure_id` is null) or (`booking_id` is null and `closure_id` is not null)),
	CONSTRAINT "visit_slot_claims_key_valid" CHECK(length(`segment_key`) = 16 and substr(`segment_key`, 1, 10) glob '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' and substr(`segment_key`, 11, 1) = 'T' and substr(`segment_key`, 12, 5) glob '[0-9][0-9]:[0-5][0-9]' and date(substr(`segment_key`, 1, 10), '+0 days') = substr(`segment_key`, 1, 10) and cast(substr(`segment_key`, 12, 2) as integer) between 0 and 23 and cast(substr(`segment_key`, 15, 2) as integer) % 5 = 0)
);
--> statement-breakpoint
INSERT INTO `visit_slot_claims` (`segment_key`,`booking_id`,`closure_id`,`created_at`)
SELECT `segment_key`,`booking_id`,`closure_id`,`created_at` FROM `__visit_slot_claims_0009_backup`;--> statement-breakpoint
DROP TABLE `__visit_slot_claims_0009_backup`;--> statement-breakpoint
CREATE INDEX `idx_visit_slot_claims_booking` ON `visit_slot_claims` (`booking_id`);--> statement-breakpoint
CREATE INDEX `idx_visit_slot_claims_closure` ON `visit_slot_claims` (`closure_id`);--> statement-breakpoint
CREATE TABLE `material_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`teacher_user_id` text NOT NULL,
	`status` text DEFAULT 'submitted' NOT NULL,
	`teacher_notes` text DEFAULT '' NOT NULL,
	`librarian_note` text DEFAULT '' NOT NULL,
	`rejection_reason` text DEFAULT '' NOT NULL,
	`pickup_location_id` text,
	`resulting_loan_id` text,
	`reviewed_by_user_id` text,
	`cancelled_by_user_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`submitted_at` text NOT NULL,
	`ready_at` text,
	`completed_at` text,
	`rejected_at` text,
	`cancelled_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`teacher_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`pickup_location_id`) REFERENCES `locations`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`resulting_loan_id`) REFERENCES `loans`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`cancelled_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "material_requests_status_valid" CHECK(`status` in ('submitted','in_review','ready','partially_ready','completed','rejected','cancelled')),
	CONSTRAINT "material_requests_version_positive" CHECK(`version` > 0),
	CONSTRAINT "material_requests_terminal_times" CHECK((`status` not in ('ready','partially_ready','completed') or (`ready_at` is not null and `resulting_loan_id` is not null and `pickup_location_id` is not null)) and (`status` != 'completed' or `completed_at` is not null) and (`status` != 'rejected' or `rejected_at` is not null) and (`status` != 'cancelled' or `cancelled_at` is not null))
);
--> statement-breakpoint
CREATE INDEX `idx_material_requests_teacher_created` ON `material_requests` (`teacher_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_material_requests_status_created` ON `material_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_material_requests_resulting_loan` ON `material_requests` (`resulting_loan_id`);--> statement-breakpoint
CREATE TABLE `material_request_items` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`material_id` text NOT NULL,
	`title_snapshot` text NOT NULL,
	`author_snapshot` text DEFAULT '' NOT NULL,
	`requested_quantity` integer NOT NULL,
	`approved_quantity` integer,
	`fulfilled_quantity` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `material_requests`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "material_request_items_title_not_blank" CHECK(length(trim(`title_snapshot`)) > 0),
	CONSTRAINT "material_request_items_quantity_valid" CHECK(`requested_quantity` > 0 and (`approved_quantity` is null or (`approved_quantity` >= 0 and `approved_quantity` <= `requested_quantity`)) and `fulfilled_quantity` >= 0 and (`approved_quantity` is null or `fulfilled_quantity` <= `approved_quantity`)),
	CONSTRAINT "material_request_items_sort_order_nonnegative" CHECK(`sort_order` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_material_request_items_request_material` ON `material_request_items` (`request_id`,`material_id`);--> statement-breakpoint
CREATE INDEX `idx_material_request_items_material_request` ON `material_request_items` (`material_id`,`request_id`);--> statement-breakpoint
CREATE TABLE `material_request_events` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`actor_user_id` text,
	`actor_kind` text NOT NULL,
	`kind` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`metadata_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `material_requests`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "material_request_events_actor_kind_valid" CHECK(`actor_kind` in ('teacher','librarian','system')),
	CONSTRAINT "material_request_events_actor_consistent" CHECK((`actor_kind` = 'system' and `actor_user_id` is null) or (`actor_kind` in ('teacher','librarian') and `actor_user_id` is not null)),
	CONSTRAINT "material_request_events_kind_not_blank" CHECK(length(trim(`kind`)) > 0),
	CONSTRAINT "material_request_events_metadata_valid" CHECK(`metadata_json` is null or json_valid(`metadata_json`))
);
--> statement-breakpoint
CREATE INDEX `idx_material_request_events_request_created` ON `material_request_events` (`request_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `portal_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`teacher_user_id` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`read_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`teacher_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "portal_notifications_dedupe_not_blank" CHECK(length(trim(`dedupe_key`)) > 0),
	CONSTRAINT "portal_notifications_type_not_blank" CHECK(length(trim(`type`)) > 0),
	CONSTRAINT "portal_notifications_title_not_blank" CHECK(length(trim(`title`)) > 0),
	CONSTRAINT "portal_notifications_entity_not_blank" CHECK(length(trim(`entity_type`)) > 0 and length(trim(`entity_id`)) > 0),
	CONSTRAINT "portal_notifications_version_positive" CHECK(`version` > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_portal_notifications_dedupe` ON `portal_notifications` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_portal_notifications_teacher_read_created` ON `portal_notifications` (`teacher_user_id`,`read_at`,`created_at`);--> statement-breakpoint
PRAGMA optimize;
