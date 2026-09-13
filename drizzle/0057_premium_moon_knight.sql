CREATE TABLE `reader_credentials` (
	`reader_id` text PRIMARY KEY NOT NULL,
	`login_id` text NOT NULL,
	`code_hmac` text,
	`must_change_pin` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'disabled' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`failure_window_started_at` text,
	`locked_until` text,
	`code_expires_at` text,
	`last_login_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`reader_id`) REFERENCES `library_readers`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "reader_credential_login" CHECK(length("reader_credentials"."login_id")=32),
	CONSTRAINT "reader_credential_status" CHECK("reader_credentials"."status" in ('active','disabled')),
	CONSTRAINT "reader_credential_flags" CHECK("reader_credentials"."must_change_pin" in (0,1) and "reader_credentials"."version">0 and "reader_credentials"."failed_attempts">=0),
	CONSTRAINT "reader_credential_hmac" CHECK("reader_credentials"."code_hmac" is null or length("reader_credentials"."code_hmac")=64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reader_credentials_login_id_unique` ON `reader_credentials` (`login_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reader_credentials_login` ON `reader_credentials` (`login_id`);--> statement-breakpoint
CREATE INDEX `idx_reader_credentials_status` ON `reader_credentials` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `reader_pin_setup_grants` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`reader_id` text NOT NULL,
	`credential_version` integer NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`revoked_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`reader_id`) REFERENCES `library_readers`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "reader_pin_setup_hash" CHECK(length("reader_pin_setup_grants"."token_hash")=64),
	CONSTRAINT "reader_pin_setup_version" CHECK("reader_pin_setup_grants"."credential_version">0)
);
--> statement-breakpoint
CREATE INDEX `idx_reader_pin_setup_owner` ON `reader_pin_setup_grants` (`reader_id`,`expires_at`);
--> statement-breakpoint
INSERT INTO `reader_credentials` (
	`reader_id`,`login_id`,`code_hmac`,`must_change_pin`,`status`,`version`,
	`failed_attempts`,`created_at`,`updated_at`
)
SELECT `id`,lower(hex(randomblob(16))),NULL,1,'disabled',1,0,`created_at`,`updated_at`
FROM `library_readers`
WHERE `kind`='student' AND `linked_teacher_user_id` IS NULL
ON CONFLICT(`reader_id`) DO NOTHING;
--> statement-breakpoint
CREATE TRIGGER `reader_credentials_student_insert`
AFTER INSERT ON `library_readers`
WHEN NEW.`kind`='student' AND NEW.`linked_teacher_user_id` IS NULL
BEGIN
	INSERT INTO `reader_credentials` (
		`reader_id`,`login_id`,`code_hmac`,`must_change_pin`,`status`,`version`,
		`failed_attempts`,`created_at`,`updated_at`
	) VALUES (NEW.`id`,lower(hex(randomblob(16))),NULL,1,'disabled',1,0,NEW.`created_at`,NEW.`updated_at`)
	ON CONFLICT(`reader_id`) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER `reader_credentials_student_kind`
AFTER UPDATE OF `kind`,`linked_teacher_user_id` ON `library_readers`
WHEN NEW.`kind`='student' AND NEW.`linked_teacher_user_id` IS NULL
BEGIN
	INSERT INTO `reader_credentials` (
		`reader_id`,`login_id`,`code_hmac`,`must_change_pin`,`status`,`version`,
		`failed_attempts`,`created_at`,`updated_at`
	) VALUES (NEW.`id`,lower(hex(randomblob(16))),NULL,1,'disabled',1,0,NEW.`updated_at`,NEW.`updated_at`)
	ON CONFLICT(`reader_id`) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER `reader_credentials_nonstudent_kind`
AFTER UPDATE OF `kind`,`linked_teacher_user_id` ON `library_readers`
WHEN NEW.`kind`!='student' OR NEW.`linked_teacher_user_id` IS NOT NULL
BEGIN
	UPDATE `reader_credentials`
	SET `status`='disabled',`code_hmac`=NULL,`must_change_pin`=1,
		`code_expires_at`=NULL,`locked_until`=NULL,`failed_attempts`=0,
		`version`=`version`+1,`updated_at`=NEW.`updated_at`
	WHERE `reader_id`=NEW.`id`;
	UPDATE `reader_pin_setup_grants`
	SET `revoked_at`=NEW.`updated_at`
	WHERE `reader_id`=NEW.`id` AND `consumed_at` IS NULL AND `revoked_at` IS NULL;
	UPDATE `reader_sessions`
	SET `revoked_at`=NEW.`updated_at`
	WHERE `reader_id`=NEW.`id` AND `revoked_at` IS NULL;
	UPDATE `reader_invites`
	SET `revoked_at`=NEW.`updated_at`
	WHERE `reader_id`=NEW.`id` AND `consumed_at` IS NULL AND `revoked_at` IS NULL;
END;
