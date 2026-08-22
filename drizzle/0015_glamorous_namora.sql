CREATE TABLE `telegram_mini_app_auth_receipts` (
	`init_data_hash` text PRIMARY KEY NOT NULL,
	`telegram_user_id` text NOT NULL,
	`teacher_user_id` text NOT NULL,
	`session_token_hash` text NOT NULL,
	`auth_date` integer NOT NULL,
	`consumed_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`teacher_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "telegram_mini_app_auth_hash_valid" CHECK(length("telegram_mini_app_auth_receipts"."init_data_hash") = 64 and lower("telegram_mini_app_auth_receipts"."init_data_hash") not glob '*[^0-9a-f]*'),
	CONSTRAINT "telegram_mini_app_auth_session_hash_valid" CHECK(length("telegram_mini_app_auth_receipts"."session_token_hash") = 64 and lower("telegram_mini_app_auth_receipts"."session_token_hash") not glob '*[^0-9a-f]*'),
	CONSTRAINT "telegram_mini_app_auth_user_not_blank" CHECK(length(trim("telegram_mini_app_auth_receipts"."telegram_user_id")) > 0),
	CONSTRAINT "telegram_mini_app_auth_date_positive" CHECK("telegram_mini_app_auth_receipts"."auth_date" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_telegram_mini_app_auth_session` ON `telegram_mini_app_auth_receipts` (`session_token_hash`);--> statement-breakpoint
CREATE INDEX `idx_telegram_mini_app_auth_expires` ON `telegram_mini_app_auth_receipts` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_telegram_mini_app_auth_teacher_created` ON `telegram_mini_app_auth_receipts` (`teacher_user_id`,`created_at`);