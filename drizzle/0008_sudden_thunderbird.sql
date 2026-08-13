CREATE TABLE `visit_teacher_access_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text NOT NULL,
	`kind` text NOT NULL,
	`teacher_user_id` text,
	`request_hash` text NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`result_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`teacher_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "visit_teacher_access_commands_kind_valid" CHECK("visit_teacher_access_commands"."kind" in ('code.issue','code.bulk_issue','credential.enable','credential.disable','credential.unlock','sessions.revoke')),
	CONSTRAINT "visit_teacher_access_commands_hash_valid" CHECK(length("visit_teacher_access_commands"."request_hash") = 64 and lower("visit_teacher_access_commands"."request_hash") not glob '*[^0-9a-f]*'),
	CONSTRAINT "visit_teacher_access_commands_status_valid" CHECK("visit_teacher_access_commands"."status" in ('processing', 'completed', 'failed')),
	CONSTRAINT "visit_teacher_access_commands_result_valid" CHECK("visit_teacher_access_commands"."result_json" is null or json_valid("visit_teacher_access_commands"."result_json")),
	CONSTRAINT "visit_teacher_access_commands_completion_consistent" CHECK(("visit_teacher_access_commands"."status" = 'processing' and "visit_teacher_access_commands"."completed_at" is null) or ("visit_teacher_access_commands"."status" in ('completed', 'failed') and "visit_teacher_access_commands"."completed_at" is not null))
);
--> statement-breakpoint
CREATE INDEX `idx_visit_teacher_access_commands_actor_created` ON `visit_teacher_access_commands` (`actor_user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `visit_teacher_credentials` (
	`teacher_user_id` text PRIMARY KEY NOT NULL,
	`login_id` text NOT NULL,
	`code_hmac` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`failure_window_started_at` text,
	`locked_until` text,
	`last_login_at` text,
	`code_rotated_at` text NOT NULL,
	`last_access_command_id` text,
	`created_by_user_id` text NOT NULL,
	`updated_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`teacher_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "visit_teacher_credentials_login_id_not_blank" CHECK(length(trim("visit_teacher_credentials"."login_id")) between 16 and 128),
	CONSTRAINT "visit_teacher_credentials_hmac_valid" CHECK(length("visit_teacher_credentials"."code_hmac") = 64 and lower("visit_teacher_credentials"."code_hmac") not glob '*[^0-9a-f]*'),
	CONSTRAINT "visit_teacher_credentials_status_valid" CHECK("visit_teacher_credentials"."status" in ('active', 'disabled')),
	CONSTRAINT "visit_teacher_credentials_version_positive" CHECK("visit_teacher_credentials"."version" > 0),
	CONSTRAINT "visit_teacher_credentials_attempts_nonnegative" CHECK("visit_teacher_credentials"."failed_attempts" >= 0),
	CONSTRAINT "visit_teacher_credentials_command_id_valid" CHECK("visit_teacher_credentials"."last_access_command_id" is null or length("visit_teacher_credentials"."last_access_command_id") = 36)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_visit_teacher_credentials_login_id` ON `visit_teacher_credentials` (`login_id`);--> statement-breakpoint
CREATE INDEX `idx_visit_teacher_credentials_status_teacher` ON `visit_teacher_credentials` (`status`,`teacher_user_id`);--> statement-breakpoint
CREATE TABLE `visit_teacher_login_limits` (
	`scope_hash` text PRIMARY KEY NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`window_started_at` text NOT NULL,
	`blocked_until` text,
	`updated_at` text NOT NULL,
	CONSTRAINT "visit_teacher_login_limits_scope_valid" CHECK(length("visit_teacher_login_limits"."scope_hash") = 64 and lower("visit_teacher_login_limits"."scope_hash") not glob '*[^0-9a-f]*'),
	CONSTRAINT "visit_teacher_login_limits_attempts_nonnegative" CHECK("visit_teacher_login_limits"."attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_visit_teacher_login_limits_updated` ON `visit_teacher_login_limits` (`updated_at`);--> statement-breakpoint
CREATE TABLE `visit_teacher_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`teacher_user_id` text NOT NULL,
	`credential_version` integer NOT NULL,
	`pending_scope` text NOT NULL,
	`ip_scope_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`revoked_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`teacher_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "visit_teacher_sessions_token_hash_valid" CHECK(length("visit_teacher_sessions"."token_hash") = 64 and lower("visit_teacher_sessions"."token_hash") not glob '*[^0-9a-f]*'),
	CONSTRAINT "visit_teacher_sessions_ip_hash_valid" CHECK(length("visit_teacher_sessions"."ip_scope_hash") = 64 and lower("visit_teacher_sessions"."ip_scope_hash") not glob '*[^0-9a-f]*'),
	CONSTRAINT "visit_teacher_sessions_pending_scope_not_blank" CHECK(length(trim("visit_teacher_sessions"."pending_scope")) between 16 and 128),
	CONSTRAINT "visit_teacher_sessions_version_positive" CHECK("visit_teacher_sessions"."credential_version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_visit_teacher_sessions_pending_scope` ON `visit_teacher_sessions` (`pending_scope`);--> statement-breakpoint
CREATE INDEX `idx_visit_teacher_sessions_teacher_active` ON `visit_teacher_sessions` (`teacher_user_id`,`revoked_at`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_visit_teacher_sessions_expires` ON `visit_teacher_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `__visit_slot_claims_backup` AS SELECT * FROM `visit_slot_claims`;--> statement-breakpoint
DROP TABLE `visit_slot_claims`;--> statement-breakpoint
CREATE TABLE `__new_visit_bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text,
	`owner_auth_user_id` text,
	`owner_email` text,
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
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`class_year_id`) REFERENCES `class_years`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`cancelled_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "visit_bookings_owner_valid" CHECK(("__new_visit_bookings"."owner_user_id" is not null and "__new_visit_bookings"."owner_auth_user_id" is null and "__new_visit_bookings"."owner_email" is null)
        or ("__new_visit_bookings"."owner_user_id" is null and length(trim("__new_visit_bookings"."owner_auth_user_id")) > 0 and length(trim("__new_visit_bookings"."owner_email")) > 0)),
	CONSTRAINT "visit_bookings_surname_length" CHECK(length(trim("__new_visit_bookings"."surname")) between 2 and 80),
	CONSTRAINT "visit_bookings_date_valid" CHECK("__new_visit_bookings"."visit_date" glob '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
        and date("__new_visit_bookings"."visit_date", '+0 days') = "__new_visit_bookings"."visit_date"),
	CONSTRAINT "visit_bookings_time_valid" CHECK("__new_visit_bookings"."start_time" glob '[0-9][0-9]:[0-5][0-9]'
        and "__new_visit_bookings"."end_time" glob '[0-9][0-9]:[0-5][0-9]'
        and cast(substr("__new_visit_bookings"."start_time", 1, 2) as integer) between 0 and 23
        and cast(substr("__new_visit_bookings"."end_time", 1, 2) as integer) between 0 and 23
        and cast(substr("__new_visit_bookings"."start_time", 4, 2) as integer) % 5 = 0
        and cast(substr("__new_visit_bookings"."end_time", 4, 2) as integer) % 5 = 0
        and "__new_visit_bookings"."start_time" < "__new_visit_bookings"."end_time"),
	CONSTRAINT "visit_bookings_status_valid" CHECK("__new_visit_bookings"."status" in ('active', 'cancelled')),
	CONSTRAINT "visit_bookings_cancel_consistent" CHECK(("__new_visit_bookings"."status" = 'active' and "__new_visit_bookings"."cancelled_at" is null
          and "__new_visit_bookings"."cancelled_by_auth_user_id" is null and "__new_visit_bookings"."cancelled_by_user_id" is null)
        or ("__new_visit_bookings"."status" = 'cancelled' and "__new_visit_bookings"."cancelled_at" is not null
          and (("__new_visit_bookings"."cancelled_by_auth_user_id" is not null and "__new_visit_bookings"."cancelled_by_user_id" is null)
            or ("__new_visit_bookings"."cancelled_by_auth_user_id" is null and "__new_visit_bookings"."cancelled_by_user_id" is not null)))),
	CONSTRAINT "visit_bookings_version_positive" CHECK("__new_visit_bookings"."version" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_visit_bookings`("id", "owner_user_id", "owner_auth_user_id", "owner_email", "surname", "class_year_id", "class_label", "visit_date", "start_time", "end_time", "purpose", "status", "cancel_reason", "cancelled_by_auth_user_id", "cancelled_by_user_id", "version", "created_at", "updated_at", "cancelled_at")
WITH mapped AS (
  SELECT b.*,
    CASE
      WHEN (SELECT COUNT(*) FROM users u WHERE u.role='teacher' AND u.status='active'
              AND u.auth_user_id=b.owner_auth_user_id) = 1
        THEN (SELECT u.id FROM users u WHERE u.role='teacher' AND u.status='active'
              AND u.auth_user_id=b.owner_auth_user_id LIMIT 1)
      WHEN (SELECT COUNT(*) FROM users u WHERE u.role='teacher' AND u.status='active'
              AND u.auth_user_id=b.owner_auth_user_id) = 0
        AND (SELECT COUNT(*) FROM users u WHERE u.role='teacher' AND u.status='active'
              AND lower(u.email)=lower(b.owner_email)) = 1
        THEN (SELECT u.id FROM users u WHERE u.role='teacher' AND u.status='active'
              AND lower(u.email)=lower(b.owner_email) LIMIT 1)
      ELSE NULL
    END AS mapped_owner_user_id
  FROM `visit_bookings` b
)
SELECT b."id", b.mapped_owner_user_id,
       CASE WHEN b.mapped_owner_user_id IS NOT NULL THEN NULL ELSE b."owner_auth_user_id" END,
       CASE WHEN b.mapped_owner_user_id IS NOT NULL THEN NULL ELSE b."owner_email" END,
       b."surname", b."class_year_id", b."class_label", b."visit_date", b."start_time", b."end_time",
       b."purpose", b."status", b."cancel_reason", b."cancelled_by_auth_user_id", b."cancelled_by_user_id",
       b."version", b."created_at", b."updated_at", b."cancelled_at"
FROM mapped b;--> statement-breakpoint
DROP TABLE `visit_bookings`;--> statement-breakpoint
ALTER TABLE `__new_visit_bookings` RENAME TO `visit_bookings`;--> statement-breakpoint
CREATE INDEX `idx_visit_bookings_date_status_time` ON `visit_bookings` (`visit_date`,`status`,`start_time`);--> statement-breakpoint
CREATE INDEX `idx_visit_bookings_owner_status_date` ON `visit_bookings` (`owner_auth_user_id`,`status`,`visit_date`);--> statement-breakpoint
CREATE INDEX `idx_visit_bookings_owner_user_status_date` ON `visit_bookings` (`owner_user_id`,`status`,`visit_date`);--> statement-breakpoint
CREATE INDEX `idx_visit_bookings_class_date` ON `visit_bookings` (`class_year_id`,`visit_date`);--> statement-breakpoint
CREATE TABLE `visit_slot_claims` (
	`segment_key` text PRIMARY KEY NOT NULL,
	`booking_id` text,
	`closure_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`booking_id`) REFERENCES `visit_bookings`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`closure_id`) REFERENCES `visit_schedule_closures`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "visit_slot_claims_exactly_one_owner" CHECK((`booking_id` is not null and `closure_id` is null) or (`booking_id` is null and `closure_id` is not null)),
	CONSTRAINT "visit_slot_claims_key_valid" CHECK(length(`segment_key`) = 16
        and substr(`segment_key`, 1, 10) glob '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
        and substr(`segment_key`, 11, 1) = 'T'
        and substr(`segment_key`, 12, 5) glob '[0-9][0-9]:[0-5][0-9]'
        and date(substr(`segment_key`, 1, 10), '+0 days') = substr(`segment_key`, 1, 10)
        and cast(substr(`segment_key`, 12, 2) as integer) between 0 and 23
        and cast(substr(`segment_key`, 15, 2) as integer) % 5 = 0)
);--> statement-breakpoint
INSERT INTO `visit_slot_claims` (`segment_key`,`booking_id`,`closure_id`,`created_at`)
SELECT `segment_key`,`booking_id`,`closure_id`,`created_at` FROM `__visit_slot_claims_backup`;--> statement-breakpoint
DROP TABLE `__visit_slot_claims_backup`;--> statement-breakpoint
CREATE INDEX `idx_visit_slot_claims_booking` ON `visit_slot_claims` (`booking_id`);--> statement-breakpoint
CREATE INDEX `idx_visit_slot_claims_closure` ON `visit_slot_claims` (`closure_id`);
