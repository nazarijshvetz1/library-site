CREATE TABLE `public_library_profile` (
	`id` text PRIMARY KEY DEFAULT 'primary' NOT NULL,
	`librarian_name` text DEFAULT '' NOT NULL,
	`librarian_description` text DEFAULT '' NOT NULL,
	`librarian_phone` text DEFAULT '' NOT NULL,
	`librarian_email` text DEFAULT '' NOT NULL,
	`assistant_name` text DEFAULT '' NOT NULL,
	`assistant_description` text DEFAULT '' NOT NULL,
	`assistant_phone` text DEFAULT '' NOT NULL,
	`assistant_email` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`last_mutation_request_id` text,
	`updated_by_user_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "public_library_profile_singleton" CHECK("public_library_profile"."id" = 'primary'),
	CONSTRAINT "public_library_profile_version_positive" CHECK("public_library_profile"."version" > 0),
	CONSTRAINT "public_library_profile_librarian_name_length" CHECK(length("public_library_profile"."librarian_name") <= 160),
	CONSTRAINT "public_library_profile_librarian_description_length" CHECK(length("public_library_profile"."librarian_description") <= 2000),
	CONSTRAINT "public_library_profile_librarian_phone_length" CHECK(length("public_library_profile"."librarian_phone") <= 80),
	CONSTRAINT "public_library_profile_librarian_email_length" CHECK(length("public_library_profile"."librarian_email") <= 254),
	CONSTRAINT "public_library_profile_assistant_name_length" CHECK(length("public_library_profile"."assistant_name") <= 160),
	CONSTRAINT "public_library_profile_assistant_description_length" CHECK(length("public_library_profile"."assistant_description") <= 2000),
	CONSTRAINT "public_library_profile_assistant_phone_length" CHECK(length("public_library_profile"."assistant_phone") <= 80),
	CONSTRAINT "public_library_profile_assistant_email_length" CHECK(length("public_library_profile"."assistant_email") <= 254)
);
--> statement-breakpoint
CREATE TABLE `telegram_librarian_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`init_data_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`telegram_user_id` text NOT NULL,
	`auth_date` integer NOT NULL,
	`expires_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`revoked_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "telegram_librarian_sessions_token_hash_valid" CHECK(length("telegram_librarian_sessions"."token_hash") = 64 and lower("telegram_librarian_sessions"."token_hash") not glob '*[^0-9a-f]*'),
	CONSTRAINT "telegram_librarian_sessions_init_data_hash_valid" CHECK(length("telegram_librarian_sessions"."init_data_hash") = 64 and lower("telegram_librarian_sessions"."init_data_hash") not glob '*[^0-9a-f]*'),
	CONSTRAINT "telegram_librarian_sessions_user_not_blank" CHECK(length(trim("telegram_librarian_sessions"."telegram_user_id")) > 0),
	CONSTRAINT "telegram_librarian_sessions_auth_date_positive" CHECK("telegram_librarian_sessions"."auth_date" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_telegram_librarian_sessions_init_data` ON `telegram_librarian_sessions` (`init_data_hash`);--> statement-breakpoint
CREATE INDEX `idx_telegram_librarian_sessions_user_active` ON `telegram_librarian_sessions` (`user_id`,`revoked_at`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_telegram_librarian_sessions_expires` ON `telegram_librarian_sessions` (`expires_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_teacher_profiles` (
	`teacher_user_id` text PRIMARY KEY NOT NULL,
	`subject_position` text DEFAULT '' NOT NULL,
	`primary_location_id` text,
	`service_contact` text DEFAULT '' NOT NULL,
	`librarian_note` text DEFAULT '' NOT NULL,
	`photo_storage_key` text,
	`photo_mime_type` text,
	`photo_version` integer DEFAULT 0 NOT NULL,
	`photo_updated_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`last_mutation_request_id` text,
	`closed_at` text,
	`closed_by_user_id` text,
	`created_by_user_id` text,
	`updated_by_user_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`teacher_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`primary_location_id`) REFERENCES `locations`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`closed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "teacher_profiles_subject_length" CHECK(length("__new_teacher_profiles"."subject_position") <= 160),
	CONSTRAINT "teacher_profiles_contact_length" CHECK(length("__new_teacher_profiles"."service_contact") <= 200),
	CONSTRAINT "teacher_profiles_note_length" CHECK(length("__new_teacher_profiles"."librarian_note") <= 4000),
	CONSTRAINT "teacher_profiles_version_positive" CHECK("__new_teacher_profiles"."version" > 0),
	CONSTRAINT "teacher_profiles_photo_consistent" CHECK(("__new_teacher_profiles"."photo_storage_key" is null and "__new_teacher_profiles"."photo_mime_type" is null
          and "__new_teacher_profiles"."photo_version" = 0 and "__new_teacher_profiles"."photo_updated_at" is null)
        or ("__new_teacher_profiles"."photo_storage_key" is not null and length(trim("__new_teacher_profiles"."photo_storage_key")) > 0
          and "__new_teacher_profiles"."photo_mime_type" in ('image/jpeg','image/png','image/webp')
          and "__new_teacher_profiles"."photo_version" > 0 and "__new_teacher_profiles"."photo_updated_at" is not null)),
	CONSTRAINT "teacher_profiles_closed_fields_consistent" CHECK(("__new_teacher_profiles"."closed_at" is null and "__new_teacher_profiles"."closed_by_user_id" is null)
        or ("__new_teacher_profiles"."closed_at" is not null and "__new_teacher_profiles"."closed_by_user_id" is not null))
);
--> statement-breakpoint
INSERT INTO `__new_teacher_profiles`("teacher_user_id", "subject_position", "primary_location_id", "service_contact", "librarian_note", "photo_storage_key", "photo_mime_type", "photo_version", "photo_updated_at", "version", "last_mutation_request_id", "closed_at", "closed_by_user_id", "created_by_user_id", "updated_by_user_id", "created_at", "updated_at") SELECT "teacher_user_id", "subject_position", "primary_location_id", "service_contact", "librarian_note", NULL, NULL, 0, NULL, "version", "last_mutation_request_id", "closed_at", "closed_by_user_id", "created_by_user_id", "updated_by_user_id", "created_at", "updated_at" FROM `teacher_profiles`;--> statement-breakpoint
DROP TABLE `teacher_profiles`;--> statement-breakpoint
ALTER TABLE `__new_teacher_profiles` RENAME TO `teacher_profiles`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_teacher_profiles_location_teacher` ON `teacher_profiles` (`primary_location_id`,`teacher_user_id`);--> statement-breakpoint
CREATE INDEX `idx_teacher_profiles_updated` ON `teacher_profiles` (`updated_at`,`teacher_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_teacher_profiles_photo_storage_key` ON `teacher_profiles` (`photo_storage_key`);--> statement-breakpoint
CREATE TABLE `__new_visit_teacher_credentials` (
	`teacher_user_id` text PRIMARY KEY NOT NULL,
	`login_id` text NOT NULL,
	`code_hmac` text NOT NULL,
	`must_change_pin` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`failure_window_started_at` text,
	`locked_until` text,
	`last_login_at` text,
	`code_rotated_at` text NOT NULL,
	`code_expires_at` text,
	`last_access_command_id` text,
	`created_by_user_id` text NOT NULL,
	`updated_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`teacher_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "visit_teacher_credentials_login_id_not_blank" CHECK(length(trim("__new_visit_teacher_credentials"."login_id")) between 16 and 128),
	CONSTRAINT "visit_teacher_credentials_hmac_valid" CHECK(length("__new_visit_teacher_credentials"."code_hmac") = 64 and lower("__new_visit_teacher_credentials"."code_hmac") not glob '*[^0-9a-f]*'),
	CONSTRAINT "visit_teacher_credentials_must_change_pin_valid" CHECK("__new_visit_teacher_credentials"."must_change_pin" in (0, 1)),
	CONSTRAINT "visit_teacher_credentials_status_valid" CHECK("__new_visit_teacher_credentials"."status" in ('active', 'disabled')),
	CONSTRAINT "visit_teacher_credentials_version_positive" CHECK("__new_visit_teacher_credentials"."version" > 0),
	CONSTRAINT "visit_teacher_credentials_attempts_nonnegative" CHECK("__new_visit_teacher_credentials"."failed_attempts" >= 0),
	CONSTRAINT "visit_teacher_credentials_expiry_consistent" CHECK("__new_visit_teacher_credentials"."must_change_pin" = 1 or "__new_visit_teacher_credentials"."code_expires_at" is null),
	CONSTRAINT "visit_teacher_credentials_command_id_valid" CHECK("__new_visit_teacher_credentials"."last_access_command_id" is null or length("__new_visit_teacher_credentials"."last_access_command_id") = 36)
);
--> statement-breakpoint
INSERT INTO `__new_visit_teacher_credentials`("teacher_user_id", "login_id", "code_hmac", "must_change_pin", "status", "version", "failed_attempts", "failure_window_started_at", "locked_until", "last_login_at", "code_rotated_at", "code_expires_at", "last_access_command_id", "created_by_user_id", "updated_by_user_id", "created_at", "updated_at") SELECT "teacher_user_id", "login_id", "code_hmac", "must_change_pin", "status", "version", "failed_attempts", "failure_window_started_at", "locked_until", "last_login_at", "code_rotated_at", NULL, "last_access_command_id", "created_by_user_id", "updated_by_user_id", "created_at", "updated_at" FROM `visit_teacher_credentials`;--> statement-breakpoint
DROP TABLE `visit_teacher_credentials`;--> statement-breakpoint
ALTER TABLE `__new_visit_teacher_credentials` RENAME TO `visit_teacher_credentials`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_visit_teacher_credentials_login_id` ON `visit_teacher_credentials` (`login_id`);--> statement-breakpoint
CREATE INDEX `idx_visit_teacher_credentials_status_teacher` ON `visit_teacher_credentials` (`status`,`teacher_user_id`);--> statement-breakpoint
INSERT INTO `public_library_profile` (
	`id`,`librarian_name`,`librarian_description`,`librarian_phone`,`librarian_email`,
	`assistant_name`,`assistant_description`,`assistant_phone`,`assistant_email`,
	`version`,`created_at`,`updated_at`
) VALUES ('primary','','','','','','','','',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));--> statement-breakpoint
