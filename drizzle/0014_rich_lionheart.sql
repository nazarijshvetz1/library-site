CREATE TABLE `telegram_connections` (
	`user_id` text PRIMARY KEY NOT NULL,
	`telegram_user_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`username` text,
	`status` text DEFAULT 'active' NOT NULL,
	`notify_orders` integer DEFAULT true NOT NULL,
	`notify_visits` integer DEFAULT true NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`linked_at` text NOT NULL,
	`disabled_at` text,
	`last_success_at` text,
	`last_failure_at` text,
	`last_error_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "telegram_connections_user_id_not_blank" CHECK(length(trim("telegram_connections"."telegram_user_id")) > 0),
	CONSTRAINT "telegram_connections_chat_id_not_blank" CHECK(length(trim("telegram_connections"."chat_id")) > 0),
	CONSTRAINT "telegram_connections_status_valid" CHECK("telegram_connections"."status" in ('active','disabled','blocked')),
	CONSTRAINT "telegram_connections_version_positive" CHECK("telegram_connections"."version" > 0),
	CONSTRAINT "telegram_connections_disabled_fields_consistent" CHECK(("telegram_connections"."status"='active' and "telegram_connections"."disabled_at" is null)
        or ("telegram_connections"."status"!='active' and "telegram_connections"."disabled_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_telegram_connections_user` ON `telegram_connections` (`telegram_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_telegram_connections_chat` ON `telegram_connections` (`chat_id`);--> statement-breakpoint
CREATE INDEX `idx_telegram_connections_status_user` ON `telegram_connections` (`status`,`user_id`);--> statement-breakpoint
CREATE TABLE `telegram_delivery_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`recipient_user_id` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`category` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`target_path` text DEFAULT '' NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`lease_token` text,
	`lease_expires_at` text,
	`telegram_message_id` text,
	`last_error_code` text,
	`last_error_message` text,
	`sent_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`recipient_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "telegram_delivery_outbox_dedupe_not_blank" CHECK(length(trim("telegram_delivery_outbox"."dedupe_key")) > 0),
	CONSTRAINT "telegram_delivery_outbox_category_valid" CHECK("telegram_delivery_outbox"."category" in ('orders','visits','system')),
	CONSTRAINT "telegram_delivery_outbox_status_valid" CHECK("telegram_delivery_outbox"."status" in ('pending','processing','retry','sent','dead')),
	CONSTRAINT "telegram_delivery_outbox_attempts_valid" CHECK("telegram_delivery_outbox"."attempts" >= 0 and "telegram_delivery_outbox"."attempts" <= 20),
	CONSTRAINT "telegram_delivery_outbox_target_safe" CHECK("telegram_delivery_outbox"."target_path"='' or "telegram_delivery_outbox"."target_path" glob '/*'),
	CONSTRAINT "telegram_delivery_outbox_lease_consistent" CHECK(("telegram_delivery_outbox"."lease_token" is null and "telegram_delivery_outbox"."lease_expires_at" is null)
        or ("telegram_delivery_outbox"."lease_token" is not null and "telegram_delivery_outbox"."lease_expires_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_telegram_delivery_outbox_dedupe` ON `telegram_delivery_outbox` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_telegram_delivery_outbox_due` ON `telegram_delivery_outbox` (`status`,`next_attempt_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_telegram_delivery_outbox_recipient_created` ON `telegram_delivery_outbox` (`recipient_user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `telegram_link_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`consumed_update_id` text,
	`revoked_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "telegram_link_tokens_hash_valid" CHECK(length("telegram_link_tokens"."token_hash") = 64 and lower("telegram_link_tokens"."token_hash") not glob '*[^0-9a-f]*'),
	CONSTRAINT "telegram_link_tokens_terminal_state" CHECK(not ("telegram_link_tokens"."consumed_at" is not null and "telegram_link_tokens"."revoked_at" is not null)),
	CONSTRAINT "telegram_link_tokens_consumption_consistent" CHECK(("telegram_link_tokens"."consumed_at" is null and "telegram_link_tokens"."consumed_update_id" is null)
        or ("telegram_link_tokens"."consumed_at" is not null and "telegram_link_tokens"."consumed_update_id" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_telegram_link_tokens_hash` ON `telegram_link_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_telegram_link_tokens_user_expiry` ON `telegram_link_tokens` (`user_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `telegram_webhook_updates` (
	`update_id` text PRIMARY KEY NOT NULL,
	`payload_hash` text NOT NULL,
	`outcome` text NOT NULL,
	`processed_at` text NOT NULL,
	CONSTRAINT "telegram_webhook_updates_id_not_blank" CHECK(length(trim("telegram_webhook_updates"."update_id")) > 0),
	CONSTRAINT "telegram_webhook_updates_hash_valid" CHECK(length("telegram_webhook_updates"."payload_hash") = 64 and lower("telegram_webhook_updates"."payload_hash") not glob '*[^0-9a-f]*'),
	CONSTRAINT "telegram_webhook_updates_outcome_not_blank" CHECK(length(trim("telegram_webhook_updates"."outcome")) > 0)
);
