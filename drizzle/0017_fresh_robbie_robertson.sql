CREATE TABLE `telegram_teacher_activation_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`teacher_user_id` text,
	`credential_version` integer,
	`token_hash` text,
	`issued_by_user_id` text,
	`request_id` text,
	`bound_telegram_user_id` text,
	`bound_chat_id` text,
	`bound_username` text,
	`bound_update_id` text,
	`presented_at` text,
	`expires_at` text NOT NULL,
	`consumed_init_data_hash` text,
	`consumed_at` text,
	`revoked_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`teacher_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`issued_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "telegram_teacher_activation_kind_valid" CHECK("telegram_teacher_activation_invites"."kind" in ('generic','personal')),
	CONSTRAINT "telegram_teacher_activation_token_valid" CHECK("telegram_teacher_activation_invites"."token_hash" is null or (length("telegram_teacher_activation_invites"."token_hash") = 64 and lower("telegram_teacher_activation_invites"."token_hash") not glob '*[^0-9a-f]*')),
	CONSTRAINT "telegram_teacher_activation_receipt_valid" CHECK("telegram_teacher_activation_invites"."consumed_init_data_hash" is null or (length("telegram_teacher_activation_invites"."consumed_init_data_hash") = 64 and lower("telegram_teacher_activation_invites"."consumed_init_data_hash") not glob '*[^0-9a-f]*')),
	CONSTRAINT "telegram_teacher_activation_personal_shape" CHECK(("telegram_teacher_activation_invites"."kind"='generic' and "telegram_teacher_activation_invites"."teacher_user_id" is null and "telegram_teacher_activation_invites"."credential_version" is null
          and "telegram_teacher_activation_invites"."token_hash" is null and "telegram_teacher_activation_invites"."issued_by_user_id" is null and "telegram_teacher_activation_invites"."request_id" is null)
        or ("telegram_teacher_activation_invites"."kind"='personal' and "telegram_teacher_activation_invites"."teacher_user_id" is not null
          and "telegram_teacher_activation_invites"."credential_version" > 0 and "telegram_teacher_activation_invites"."token_hash" is not null
          and "telegram_teacher_activation_invites"."issued_by_user_id" is not null and length("telegram_teacher_activation_invites"."request_id")=36)),
	CONSTRAINT "telegram_teacher_activation_binding_consistent" CHECK(("telegram_teacher_activation_invites"."bound_telegram_user_id" is null and "telegram_teacher_activation_invites"."bound_chat_id" is null
          and "telegram_teacher_activation_invites"."bound_update_id" is null and "telegram_teacher_activation_invites"."presented_at" is null)
        or ("telegram_teacher_activation_invites"."bound_telegram_user_id" is not null and "telegram_teacher_activation_invites"."bound_chat_id" is not null
          and "telegram_teacher_activation_invites"."bound_update_id" is not null and "telegram_teacher_activation_invites"."presented_at" is not null)),
	CONSTRAINT "telegram_teacher_activation_terminal_state" CHECK(not ("telegram_teacher_activation_invites"."consumed_at" is not null and "telegram_teacher_activation_invites"."revoked_at" is not null)),
	CONSTRAINT "telegram_teacher_activation_consumption_consistent" CHECK(("telegram_teacher_activation_invites"."consumed_at" is null and "telegram_teacher_activation_invites"."consumed_init_data_hash" is null)
        or ("telegram_teacher_activation_invites"."consumed_at" is not null and "telegram_teacher_activation_invites"."consumed_init_data_hash" is not null
          and "telegram_teacher_activation_invites"."bound_telegram_user_id" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_telegram_teacher_activation_token` ON `telegram_teacher_activation_invites` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_telegram_teacher_activation_request` ON `telegram_teacher_activation_invites` (`request_id`);--> statement-breakpoint
CREATE INDEX `idx_telegram_teacher_activation_teacher_expiry` ON `telegram_teacher_activation_invites` (`teacher_user_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_telegram_teacher_activation_bound_expiry` ON `telegram_teacher_activation_invites` (`bound_telegram_user_id`,`expires_at`,`created_at`);