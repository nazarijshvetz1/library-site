CREATE TABLE `assistant_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_key` text NOT NULL,
	`created_day` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`tool_calls` integer DEFAULT 0 NOT NULL,
	`text_turns` integer DEFAULT 0 NOT NULL,
	`provider_call_id` text,
	`closed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_assistant_sessions_actor_day` ON `assistant_sessions` (`actor_key`,`created_day`);--> statement-breakpoint
CREATE TABLE `assistant_visit_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_key` text NOT NULL,
	`session_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`class_label` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`confirmed_at` text,
	`result_json` text,
	FOREIGN KEY (`session_id`) REFERENCES `assistant_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_assistant_visit_drafts_session` ON `assistant_visit_drafts` (`session_id`,`created_at`);