PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_telegram_connections` (
	`user_id` text PRIMARY KEY NOT NULL,
	`telegram_user_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`username` text,
	`status` text DEFAULT 'active' NOT NULL,
	`notify_orders` integer DEFAULT true NOT NULL,
	`notify_visits` integer DEFAULT true NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`menu_delivered_version` integer DEFAULT 0 NOT NULL,
	`menu_claim_version` integer,
	`menu_claimed_at` text,
	`linked_at` text NOT NULL,
	`disabled_at` text,
	`last_success_at` text,
	`last_failure_at` text,
	`last_error_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "telegram_connections_user_id_not_blank" CHECK(length(trim("__new_telegram_connections"."telegram_user_id")) > 0),
	CONSTRAINT "telegram_connections_chat_id_not_blank" CHECK(length(trim("__new_telegram_connections"."chat_id")) > 0),
	CONSTRAINT "telegram_connections_status_valid" CHECK("__new_telegram_connections"."status" in ('active','disabled','blocked')),
	CONSTRAINT "telegram_connections_version_positive" CHECK("__new_telegram_connections"."version" > 0),
	CONSTRAINT "telegram_connections_menu_version_non_negative" CHECK("__new_telegram_connections"."menu_delivered_version" >= 0),
	CONSTRAINT "telegram_connections_menu_claim_consistent" CHECK(("__new_telegram_connections"."menu_claim_version" is null and "__new_telegram_connections"."menu_claimed_at" is null)
        or ("__new_telegram_connections"."menu_claim_version" is not null and "__new_telegram_connections"."menu_claim_version" > 0
          and "__new_telegram_connections"."menu_claimed_at" is not null)),
	CONSTRAINT "telegram_connections_disabled_fields_consistent" CHECK(("__new_telegram_connections"."status"='active' and "__new_telegram_connections"."disabled_at" is null)
        or ("__new_telegram_connections"."status"!='active' and "__new_telegram_connections"."disabled_at" is not null))
);
--> statement-breakpoint
INSERT INTO `__new_telegram_connections`("user_id", "telegram_user_id", "chat_id", "username", "status", "notify_orders", "notify_visits", "version", "menu_delivered_version", "menu_claim_version", "menu_claimed_at", "linked_at", "disabled_at", "last_success_at", "last_failure_at", "last_error_code", "created_at", "updated_at") SELECT "user_id", "telegram_user_id", "chat_id", "username", "status", "notify_orders", "notify_visits", "version", 0, NULL, NULL, "linked_at", "disabled_at", "last_success_at", "last_failure_at", "last_error_code", "created_at", "updated_at" FROM `telegram_connections`;--> statement-breakpoint
DROP TABLE `telegram_connections`;--> statement-breakpoint
ALTER TABLE `__new_telegram_connections` RENAME TO `telegram_connections`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_telegram_connections_user` ON `telegram_connections` (`telegram_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_telegram_connections_chat` ON `telegram_connections` (`chat_id`);--> statement-breakpoint
CREATE INDEX `idx_telegram_connections_status_user` ON `telegram_connections` (`status`,`user_id`);
