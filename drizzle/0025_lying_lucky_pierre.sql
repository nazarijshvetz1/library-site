ALTER TABLE `acquisition_requests` ADD `librarian_hidden_at` text;--> statement-breakpoint
ALTER TABLE `acquisition_requests` ADD `librarian_hidden_by_user_id` text REFERENCES users(id);--> statement-breakpoint
CREATE INDEX `idx_acquisition_requests_librarian_hidden` ON `acquisition_requests` (`librarian_hidden_at`,`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `material_requests` ADD `librarian_hidden_at` text;--> statement-breakpoint
ALTER TABLE `material_requests` ADD `librarian_hidden_by_user_id` text REFERENCES users(id);--> statement-breakpoint
CREATE INDEX `idx_material_requests_librarian_hidden` ON `material_requests` (`librarian_hidden_at`,`status`,`created_at`);