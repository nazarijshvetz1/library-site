CREATE TABLE `manual_textbooks` (
	`id` text PRIMARY KEY NOT NULL,
	`academic_year_id` text NOT NULL,
	`grade` integer NOT NULL,
	`title` text NOT NULL,
	`author` text DEFAULT '' NOT NULL,
	`subject` text NOT NULL,
	`publisher` text DEFAULT '' NOT NULL,
	`publication_year` integer,
	`isbn` text DEFAULT '' NOT NULL,
	`resource_url` text NOT NULL,
	`cover_url` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by_user_id` text NOT NULL,
	`updated_by_user_id` text NOT NULL,
	`published_at` text,
	`archived_at` text,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`academic_year_id`) REFERENCES `academic_years`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "manual_textbooks_grade_valid" CHECK("manual_textbooks"."grade" between 1 and 11),
	CONSTRAINT "manual_textbooks_status_valid" CHECK("manual_textbooks"."status" in ('draft', 'published', 'archived', 'deleted')),
	CONSTRAINT "manual_textbooks_title_not_blank" CHECK(length(trim("manual_textbooks"."title")) between 1 and 500),
	CONSTRAINT "manual_textbooks_subject_not_blank" CHECK(length(trim("manual_textbooks"."subject")) between 1 and 240),
	CONSTRAINT "manual_textbooks_resource_https" CHECK("manual_textbooks"."resource_url" glob 'https://*'),
	CONSTRAINT "manual_textbooks_cover_https" CHECK("manual_textbooks"."cover_url" = '' or "manual_textbooks"."cover_url" glob 'https://*'),
	CONSTRAINT "manual_textbooks_year_valid" CHECK("manual_textbooks"."publication_year" is null or "manual_textbooks"."publication_year" between 1000 and 3000),
	CONSTRAINT "manual_textbooks_sort_order_nonnegative" CHECK("manual_textbooks"."sort_order" >= 0),
	CONSTRAINT "manual_textbooks_version_positive" CHECK("manual_textbooks"."version" > 0),
	CONSTRAINT "manual_textbooks_dates_consistent" CHECK((
        "manual_textbooks"."status" = 'draft'
        and "manual_textbooks"."published_at" is null
        and "manual_textbooks"."archived_at" is null
        and "manual_textbooks"."deleted_at" is null
      ) or (
        "manual_textbooks"."status" = 'published'
        and "manual_textbooks"."published_at" is not null
        and "manual_textbooks"."archived_at" is null
        and "manual_textbooks"."deleted_at" is null
      ) or (
        "manual_textbooks"."status" = 'archived'
        and "manual_textbooks"."archived_at" is not null
        and "manual_textbooks"."deleted_at" is null
      ) or (
        "manual_textbooks"."status" = 'deleted'
        and "manual_textbooks"."deleted_at" is not null
      ))
);
--> statement-breakpoint
CREATE INDEX `idx_manual_textbooks_public_listing` ON `manual_textbooks` (`academic_year_id`,`status`,`grade`,`sort_order`,`id`);--> statement-breakpoint
CREATE INDEX `idx_manual_textbooks_management` ON `manual_textbooks` (`academic_year_id`,`grade`,`status`,`sort_order`);