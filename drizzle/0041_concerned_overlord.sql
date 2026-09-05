CREATE TABLE `assistant_action_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_key` text NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`preview_json` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`cancelled_at` text,
	FOREIGN KEY (`session_id`) REFERENCES `assistant_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
