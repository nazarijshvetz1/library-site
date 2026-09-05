CREATE TABLE `assistant_consents` (
	`actor_key` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`accepted_at` text,
	`revoked_at` text,
	`revision` integer DEFAULT 1 NOT NULL
);
