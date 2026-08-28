CREATE TABLE `textbook_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`academic_year_id` text NOT NULL,
	`material_id` text NOT NULL,
	`grade` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`published_at` text,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`academic_year_id`) REFERENCES `academic_years`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "textbook_assignments_grade_valid" CHECK("textbook_assignments"."grade" between 1 and 11),
	CONSTRAINT "textbook_assignments_status_valid" CHECK("textbook_assignments"."status" in ('draft', 'published', 'archived')),
	CONSTRAINT "textbook_assignments_sort_order_nonnegative" CHECK("textbook_assignments"."sort_order" >= 0),
	CONSTRAINT "textbook_assignments_version_positive" CHECK("textbook_assignments"."version" > 0),
	CONSTRAINT "textbook_assignments_dates_consistent" CHECK((
        "textbook_assignments"."status" = 'draft'
        and "textbook_assignments"."published_at" is null
        and "textbook_assignments"."archived_at" is null
      ) or (
        "textbook_assignments"."status" = 'published'
        and "textbook_assignments"."published_at" is not null
        and "textbook_assignments"."archived_at" is null
      ) or (
        "textbook_assignments"."status" = 'archived'
        and "textbook_assignments"."archived_at" is not null
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_textbook_assignments_year_grade_material` ON `textbook_assignments` (`academic_year_id`,`grade`,`material_id`);--> statement-breakpoint
CREATE INDEX `idx_textbook_assignments_public_listing` ON `textbook_assignments` (`academic_year_id`,`status`,`grade`,`sort_order`,`id`);--> statement-breakpoint
CREATE INDEX `idx_textbook_assignments_material_status` ON `textbook_assignments` (`material_id`,`status`);
--> statement-breakpoint
WITH RECURSIVE grades(grade) AS (
	SELECT 1
	UNION ALL
	SELECT grade + 1 FROM grades WHERE grade < 11
)
INSERT OR IGNORE INTO textbook_assignments (
	id, academic_year_id, material_id, grade, status, sort_order, version,
	published_at, archived_at, created_at, updated_at
)
SELECT
	'TXT-SEED-' || lower(hex(randomblob(16))),
	ay.id,
	m.id,
	grades.grade,
	'published',
	m.catalog_number,
	1,
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
	NULL,
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM academic_years ay
JOIN materials m
	ON m.status = 'active'
	AND m.archived_at IS NULL
	AND trim(m.publication_type) = 'Підручник'
JOIN grades
	ON m.class_from IS NOT NULL
	AND m.class_to IS NOT NULL
	AND grades.grade BETWEEN m.class_from AND m.class_to
WHERE ay.status = 'active'
	AND EXISTS (
		SELECT 1 FROM material_links ml
		WHERE ml.material_id = m.id
			AND ml.kind = 'ebook'
			AND ml.is_public = 1
			AND ml.status = 'active'
			AND ml.url GLOB 'https://*'
	);
