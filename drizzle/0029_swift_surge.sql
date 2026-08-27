CREATE TABLE `procurement_plan_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`resource_id` text NOT NULL,
	`class_id` text NOT NULL,
	`demand_mode` text DEFAULT 'per_student' NOT NULL,
	`copies_per_unit` integer DEFAULT 1 NOT NULL,
	`fixed_quantity` integer DEFAULT 0 NOT NULL,
	`reserve_quantity` integer DEFAULT 0 NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`resource_id`) REFERENCES `procurement_plan_resources`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`class_id`) REFERENCES `procurement_plan_classes`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "procurement_plan_allocations_mode_valid" CHECK("procurement_plan_allocations"."demand_mode" in ('per_student','per_class','fixed')),
	CONSTRAINT "procurement_plan_allocations_copies_valid" CHECK("procurement_plan_allocations"."copies_per_unit" between 1 and 100),
	CONSTRAINT "procurement_plan_allocations_fixed_valid" CHECK("procurement_plan_allocations"."fixed_quantity" between 0 and 100000),
	CONSTRAINT "procurement_plan_allocations_reserve_valid" CHECK("procurement_plan_allocations"."reserve_quantity" between 0 and 1000),
	CONSTRAINT "procurement_plan_allocations_version_positive" CHECK("procurement_plan_allocations"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_procurement_plan_allocations_resource_class` ON `procurement_plan_allocations` (`resource_id`,`class_id`);--> statement-breakpoint
CREATE INDEX `idx_procurement_plan_allocations_class` ON `procurement_plan_allocations` (`class_id`,`resource_id`);--> statement-breakpoint
CREATE TABLE `procurement_plan_classes` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`source_class_year_id` text,
	`class_name` text NOT NULL,
	`grade` integer NOT NULL,
	`student_count` integer,
	`notes` text DEFAULT '' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `procurement_plans`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`source_class_year_id`) REFERENCES `class_years`(`id`) ON UPDATE cascade ON DELETE set null,
	CONSTRAINT "procurement_plan_classes_name_not_blank" CHECK(length(trim("procurement_plan_classes"."class_name")) > 0),
	CONSTRAINT "procurement_plan_classes_grade_valid" CHECK("procurement_plan_classes"."grade" between 1 and 11),
	CONSTRAINT "procurement_plan_classes_students_valid" CHECK("procurement_plan_classes"."student_count" is null or "procurement_plan_classes"."student_count" between 0 and 500),
	CONSTRAINT "procurement_plan_classes_order_valid" CHECK("procurement_plan_classes"."sort_order" >= 0),
	CONSTRAINT "procurement_plan_classes_version_positive" CHECK("procurement_plan_classes"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_procurement_plan_classes_name` ON `procurement_plan_classes` (`plan_id`,`class_name`);--> statement-breakpoint
CREATE INDEX `idx_procurement_plan_classes_order` ON `procurement_plan_classes` (`plan_id`,`grade`,`sort_order`,`class_name`);--> statement-breakpoint
CREATE TABLE `procurement_plan_resources` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`material_id` text,
	`category` text NOT NULL,
	`stock_mode` text DEFAULT 'reusable' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`title` text NOT NULL,
	`author` text DEFAULT '' NOT NULL,
	`publisher` text DEFAULT '' NOT NULL,
	`publication_year` integer,
	`source_url` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`usable_quantity_override` integer,
	`additional_incoming_quantity` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `procurement_plans`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "procurement_plan_resources_category_valid" CHECK("procurement_plan_resources"."category" in ('textbook','workbook','assessment','exercises','atlas','other')),
	CONSTRAINT "procurement_plan_resources_stock_mode_valid" CHECK("procurement_plan_resources"."stock_mode" in ('reusable','consumable')),
	CONSTRAINT "procurement_plan_resources_title_not_blank" CHECK(length(trim("procurement_plan_resources"."title")) > 0),
	CONSTRAINT "procurement_plan_resources_year_valid" CHECK("procurement_plan_resources"."publication_year" is null or "procurement_plan_resources"."publication_year" between 1000 and 2100),
	CONSTRAINT "procurement_plan_resources_usable_valid" CHECK("procurement_plan_resources"."usable_quantity_override" is null or "procurement_plan_resources"."usable_quantity_override" between 0 and 100000),
	CONSTRAINT "procurement_plan_resources_incoming_valid" CHECK("procurement_plan_resources"."additional_incoming_quantity" between 0 and 100000),
	CONSTRAINT "procurement_plan_resources_order_valid" CHECK("procurement_plan_resources"."sort_order" >= 0),
	CONSTRAINT "procurement_plan_resources_version_positive" CHECK("procurement_plan_resources"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_procurement_plan_resources_material` ON `procurement_plan_resources` (`plan_id`,`material_id`);--> statement-breakpoint
CREATE INDEX `idx_procurement_plan_resources_category_order` ON `procurement_plan_resources` (`plan_id`,`category`,`sort_order`,`title`);--> statement-breakpoint
CREATE TABLE `procurement_plan_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`payload_json` text NOT NULL,
	`payload_sha256` text NOT NULL,
	`inventory_cutoff_at` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `procurement_plans`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "procurement_plan_snapshots_sequence_positive" CHECK("procurement_plan_snapshots"."sequence" > 0),
	CONSTRAINT "procurement_plan_snapshots_schema_positive" CHECK("procurement_plan_snapshots"."schema_version" > 0),
	CONSTRAINT "procurement_plan_snapshots_payload_valid" CHECK(json_valid("procurement_plan_snapshots"."payload_json")),
	CONSTRAINT "procurement_plan_snapshots_hash_valid" CHECK(length("procurement_plan_snapshots"."payload_sha256") = 64 and lower("procurement_plan_snapshots"."payload_sha256") not glob '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_procurement_plan_snapshots_sequence` ON `procurement_plan_snapshots` (`plan_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_procurement_plan_snapshots_created` ON `procurement_plan_snapshots` (`plan_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `procurement_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`academic_year_id` text,
	`academic_year_label` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`default_reserve` integer DEFAULT 0 NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`revision_confirmed_at` text,
	`revision_confirmed_by_user_id` text,
	`finalized_at` text,
	`finalized_by_user_id` text,
	`created_by_user_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`academic_year_id`) REFERENCES `academic_years`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`revision_confirmed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`finalized_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "procurement_plans_year_not_blank" CHECK(length(trim("procurement_plans"."academic_year_label")) > 0),
	CONSTRAINT "procurement_plans_title_not_blank" CHECK(length(trim("procurement_plans"."title")) > 0),
	CONSTRAINT "procurement_plans_status_valid" CHECK("procurement_plans"."status" in ('draft','finalized','archived')),
	CONSTRAINT "procurement_plans_reserve_valid" CHECK("procurement_plans"."default_reserve" between 0 and 1000),
	CONSTRAINT "procurement_plans_version_positive" CHECK("procurement_plans"."version" > 0),
	CONSTRAINT "procurement_plans_finalized_consistent" CHECK(("procurement_plans"."status" = 'finalized' and "procurement_plans"."finalized_at" is not null and "procurement_plans"."finalized_by_user_id" is not null) or ("procurement_plans"."status" != 'finalized'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_procurement_plans_year_label` ON `procurement_plans` (`academic_year_label`);--> statement-breakpoint
CREATE INDEX `idx_procurement_plans_status_updated` ON `procurement_plans` (`status`,`updated_at`);--> statement-breakpoint
CREATE TRIGGER `procurement_plan_snapshots_no_update`
BEFORE UPDATE ON `procurement_plan_snapshots`
BEGIN
	SELECT RAISE(ABORT, 'procurement_plan_snapshot_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `procurement_plan_snapshots_no_delete`
BEFORE DELETE ON `procurement_plan_snapshots`
BEGIN
	SELECT RAISE(ABORT, 'procurement_plan_snapshot_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `procurement_plan_snapshots_parent_finalized`
BEFORE INSERT ON `procurement_plan_snapshots`
WHEN NOT EXISTS (
	SELECT 1 FROM `procurement_plans`
	WHERE `id` = NEW.`plan_id` AND `status` = 'finalized' AND `finalized_at` = NEW.`inventory_cutoff_at`
)
BEGIN
	SELECT RAISE(ABORT, 'procurement_plan_snapshot_parent_not_finalized');
END;--> statement-breakpoint
CREATE TRIGGER `procurement_plan_classes_before_insert`
BEFORE INSERT ON `procurement_plan_classes`
BEGIN
	UPDATE `procurement_plans` SET `version` = `version` + 1, `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ','now')
	WHERE `id` = NEW.`plan_id` AND `status` = 'draft';
	SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'procurement_plan_locked') END;
END;--> statement-breakpoint
CREATE TRIGGER `procurement_plan_classes_before_update`
BEFORE UPDATE ON `procurement_plan_classes`
BEGIN
	SELECT CASE WHEN NEW.`plan_id` != OLD.`plan_id` THEN RAISE(ABORT, 'procurement_plan_scope_immutable') END;
	UPDATE `procurement_plans` SET `version` = `version` + 1, `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ','now')
	WHERE `id` = NEW.`plan_id` AND `status` = 'draft';
	SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'procurement_plan_locked') END;
END;--> statement-breakpoint
CREATE TRIGGER `procurement_plan_classes_before_delete`
BEFORE DELETE ON `procurement_plan_classes`
BEGIN
	UPDATE `procurement_plans` SET `version` = `version` + 1, `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ','now')
	WHERE `id` = OLD.`plan_id` AND `status` = 'draft';
	SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'procurement_plan_locked') END;
END;--> statement-breakpoint
CREATE TRIGGER `procurement_plan_resources_before_insert`
BEFORE INSERT ON `procurement_plan_resources`
BEGIN
	UPDATE `procurement_plans` SET `version` = `version` + 1, `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ','now')
	WHERE `id` = NEW.`plan_id` AND `status` = 'draft';
	SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'procurement_plan_locked') END;
END;--> statement-breakpoint
CREATE TRIGGER `procurement_plan_resources_before_update`
BEFORE UPDATE ON `procurement_plan_resources`
BEGIN
	SELECT CASE WHEN NEW.`plan_id` != OLD.`plan_id` THEN RAISE(ABORT, 'procurement_plan_scope_immutable') END;
	UPDATE `procurement_plans` SET `version` = `version` + 1, `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ','now')
	WHERE `id` = NEW.`plan_id` AND `status` = 'draft';
	SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'procurement_plan_locked') END;
END;--> statement-breakpoint
CREATE TRIGGER `procurement_plan_resources_before_delete`
BEFORE DELETE ON `procurement_plan_resources`
BEGIN
	UPDATE `procurement_plans` SET `version` = `version` + 1, `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ','now')
	WHERE `id` = OLD.`plan_id` AND `status` = 'draft';
	SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'procurement_plan_locked') END;
END;--> statement-breakpoint
CREATE TRIGGER `procurement_plan_allocations_before_insert`
BEFORE INSERT ON `procurement_plan_allocations`
BEGIN
	SELECT CASE WHEN
		(SELECT `plan_id` FROM `procurement_plan_resources` WHERE `id` = NEW.`resource_id`) !=
		(SELECT `plan_id` FROM `procurement_plan_classes` WHERE `id` = NEW.`class_id`)
	THEN RAISE(ABORT, 'procurement_plan_allocation_scope_invalid') END;
	UPDATE `procurement_plans` SET `version` = `version` + 1, `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ','now')
	WHERE `id` = (SELECT `plan_id` FROM `procurement_plan_resources` WHERE `id` = NEW.`resource_id`) AND `status` = 'draft';
	SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'procurement_plan_locked') END;
END;--> statement-breakpoint
CREATE TRIGGER `procurement_plan_allocations_before_update`
BEFORE UPDATE ON `procurement_plan_allocations`
BEGIN
	SELECT CASE WHEN NEW.`resource_id` != OLD.`resource_id` THEN RAISE(ABORT, 'procurement_plan_scope_immutable') END;
	SELECT CASE WHEN
		(SELECT `plan_id` FROM `procurement_plan_resources` WHERE `id` = NEW.`resource_id`) !=
		(SELECT `plan_id` FROM `procurement_plan_classes` WHERE `id` = NEW.`class_id`)
	THEN RAISE(ABORT, 'procurement_plan_allocation_scope_invalid') END;
	UPDATE `procurement_plans` SET `version` = `version` + 1, `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ','now')
	WHERE `id` = (SELECT `plan_id` FROM `procurement_plan_resources` WHERE `id` = NEW.`resource_id`) AND `status` = 'draft';
	SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'procurement_plan_locked') END;
END;--> statement-breakpoint
CREATE TRIGGER `procurement_plan_allocations_before_delete`
BEFORE DELETE ON `procurement_plan_allocations`
BEGIN
	UPDATE `procurement_plans` SET `version` = `version` + 1, `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ','now')
	WHERE `id` = COALESCE(
		(SELECT `plan_id` FROM `procurement_plan_resources` WHERE `id` = OLD.`resource_id`),
		(SELECT `plan_id` FROM `procurement_plan_classes` WHERE `id` = OLD.`class_id`)
	) AND `status` = 'draft';
	SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'procurement_plan_locked') END;
END;
