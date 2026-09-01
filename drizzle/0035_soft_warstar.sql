CREATE TABLE `class_loan_item_adjustments` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`class_loan_id` text NOT NULL,
	`class_loan_item_id` text NOT NULL,
	`statement_line_id` text,
	`transaction_id` text,
	`action` text NOT NULL,
	`quantity_before` integer NOT NULL,
	`quantity_after` integer NOT NULL,
	`quantity_returned_snapshot` integer NOT NULL,
	`stock_delta` integer NOT NULL,
	`location_id` text NOT NULL,
	`condition` text NOT NULL,
	`reason` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`class_loan_id`) REFERENCES `class_loans`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`class_loan_item_id`) REFERENCES `class_loan_items`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`statement_line_id`) REFERENCES `class_loan_statement_lines`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`transaction_id`) REFERENCES `class_loan_transactions`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "class_loan_item_adjustments_action_valid" CHECK("class_loan_item_adjustments"."action" in ('quantity_changed', 'removed', 'restored')),
	CONSTRAINT "class_loan_item_adjustments_quantities_valid" CHECK("class_loan_item_adjustments"."quantity_before" > 0
        and "class_loan_item_adjustments"."quantity_after" > 0
        and "class_loan_item_adjustments"."quantity_returned_snapshot" >= 0
        and "class_loan_item_adjustments"."quantity_returned_snapshot" <= "class_loan_item_adjustments"."quantity_before"
        and "class_loan_item_adjustments"."quantity_returned_snapshot" <= "class_loan_item_adjustments"."quantity_after"),
	CONSTRAINT "class_loan_item_adjustments_condition_valid" CHECK("class_loan_item_adjustments"."condition" in ('unspecified', 'good', 'worn', 'damaged')),
	CONSTRAINT "class_loan_item_adjustments_reason_present" CHECK(length(trim("class_loan_item_adjustments"."reason")) between 2 and 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_class_loan_item_adjustments_request` ON `class_loan_item_adjustments` (`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_class_loan_item_adjustments_transaction` ON `class_loan_item_adjustments` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `idx_class_loan_item_adjustments_loan_created` ON `class_loan_item_adjustments` (`class_loan_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_class_loan_item_adjustments_item_created` ON `class_loan_item_adjustments` (`class_loan_item_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `class_loan_statement_item_links` (
	`statement_line_id` text PRIMARY KEY NOT NULL,
	`class_loan_item_id` text NOT NULL,
	`origin` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`statement_line_id`) REFERENCES `class_loan_statement_lines`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`class_loan_item_id`) REFERENCES `class_loan_items`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "class_loan_statement_item_links_origin_valid" CHECK("class_loan_statement_item_links"."origin" in ('issued', 'legacy_exact', 'legacy_reviewed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_class_loan_statement_item_links_item` ON `class_loan_statement_item_links` (`class_loan_item_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_class_loan_items` (
	`id` text PRIMARY KEY NOT NULL,
	`class_loan_id` text NOT NULL,
	`material_id` text NOT NULL,
	`source_location_id` text NOT NULL,
	`condition` text DEFAULT 'unspecified' NOT NULL,
	`quantity_issued` integer NOT NULL,
	`quantity_returned` integer DEFAULT 0 NOT NULL,
	`lifecycle_status` text DEFAULT 'active' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`removed_at` text,
	`removed_by_user_id` text,
	`removal_reason` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`class_loan_id`) REFERENCES `class_loans`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`source_location_id`) REFERENCES `locations`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`removed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "class_loan_items_condition_valid" CHECK("__new_class_loan_items"."condition" in ('unspecified', 'good', 'worn', 'damaged')),
	CONSTRAINT "class_loan_items_quantity_issued_positive" CHECK("__new_class_loan_items"."quantity_issued" > 0),
	CONSTRAINT "class_loan_items_quantity_returned_valid" CHECK("__new_class_loan_items"."quantity_returned" >= 0 and "__new_class_loan_items"."quantity_returned" <= "__new_class_loan_items"."quantity_issued"),
	CONSTRAINT "class_loan_items_lifecycle_valid" CHECK("__new_class_loan_items"."lifecycle_status" in ('active', 'removed')),
	CONSTRAINT "class_loan_items_version_positive" CHECK("__new_class_loan_items"."version" > 0),
	CONSTRAINT "class_loan_items_removal_fields_consistent" CHECK(("__new_class_loan_items"."lifecycle_status" = 'active'
          and "__new_class_loan_items"."removed_at" is null
          and "__new_class_loan_items"."removed_by_user_id" is null
          and "__new_class_loan_items"."removal_reason" = '')
        or ("__new_class_loan_items"."lifecycle_status" = 'removed'
          and "__new_class_loan_items"."removed_at" is not null
          and "__new_class_loan_items"."removed_by_user_id" is not null
          and length(trim("__new_class_loan_items"."removal_reason")) > 0))
);
--> statement-breakpoint
INSERT INTO `__new_class_loan_items`(
	"id", "class_loan_id", "material_id", "source_location_id", "condition",
	"quantity_issued", "quantity_returned", "lifecycle_status", "version",
	"removed_at", "removed_by_user_id", "removal_reason", "notes", "created_at", "updated_at"
)
SELECT
	"id", "class_loan_id", "material_id", "source_location_id", "condition",
	"quantity_issued", "quantity_returned", 'active', 1,
	NULL, NULL, '', "notes", "created_at", "updated_at"
FROM `class_loan_items`;--> statement-breakpoint
DROP TABLE `class_loan_items`;--> statement-breakpoint
ALTER TABLE `__new_class_loan_items` RENAME TO `class_loan_items`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_class_loan_items_loan_material` ON `class_loan_items` (`class_loan_id`,`material_id`);--> statement-breakpoint
CREATE INDEX `idx_class_loan_items_material_loan` ON `class_loan_items` (`material_id`,`class_loan_id`);--> statement-breakpoint
CREATE INDEX `idx_class_loan_items_loan_lifecycle` ON `class_loan_items` (`class_loan_id`,`lifecycle_status`,`created_at`);--> statement-breakpoint

-- Rows created for schema-0 loans and append backfills encode the item id.
INSERT OR IGNORE INTO `class_loan_statement_item_links` (
	`statement_line_id`, `class_loan_item_id`, `origin`, `created_at`
)
SELECT sl.`id`, cli.`id`, 'legacy_exact', sl.`created_at`
FROM `class_loan_statement_lines` sl
JOIN `class_loan_items` cli
	ON sl.`id` IN ('CLSL-LEGACY-' || cli.`id`, 'CLSL-APPEND-BACKFILL-' || cli.`id`)
	AND cli.`class_loan_id` = sl.`class_loan_id`;--> statement-breakpoint

-- A transaction containing exactly one statement line and one item is unambiguous.
INSERT OR IGNORE INTO `class_loan_statement_item_links` (
	`statement_line_id`, `class_loan_item_id`, `origin`, `created_at`
)
SELECT sl.`id`, txl.`class_loan_item_id`, 'legacy_exact', sl.`created_at`
FROM `class_loan_statement_lines` sl
JOIN `class_loan_transaction_lines` txl ON txl.`transaction_id` = sl.`transaction_id`
JOIN `class_loan_transactions` tx
	ON tx.`id` = sl.`transaction_id` AND tx.`kind` = 'issue'
JOIN `class_loan_items` cli
	ON cli.`id` = txl.`class_loan_item_id`
	AND cli.`class_loan_id` = sl.`class_loan_id`
WHERE sl.`transaction_id` IS NOT NULL
	AND (SELECT COUNT(*) FROM `class_loan_statement_lines` x WHERE x.`transaction_id` = sl.`transaction_id`) = 1
	AND (SELECT COUNT(DISTINCT y.`class_loan_item_id`) FROM `class_loan_transaction_lines` y WHERE y.`transaction_id` = sl.`transaction_id`) = 1;--> statement-breakpoint

-- Multi-line legacy issues are linked only when bibliography and issued quantity
-- identify one item and one statement row inside the same transaction.
INSERT OR IGNORE INTO `class_loan_statement_item_links` (
	`statement_line_id`, `class_loan_item_id`, `origin`, `created_at`
)
SELECT sl.`id`, candidate.`class_loan_item_id`, 'legacy_exact', sl.`created_at`
FROM `class_loan_statement_lines` sl
JOIN (
	SELECT
		txl.`transaction_id`, txl.`class_loan_item_id`, txl.`material_id`,
		ABS(txl.`quantity_delta`) AS `issued_quantity`
	FROM `class_loan_transaction_lines` txl
	JOIN `class_loan_transactions` tx
		ON tx.`id` = txl.`transaction_id` AND tx.`kind` = 'issue'
) candidate ON candidate.`transaction_id` = sl.`transaction_id`
JOIN `class_loan_items` cli
	ON cli.`id` = candidate.`class_loan_item_id`
	AND cli.`class_loan_id` = sl.`class_loan_id`
JOIN `materials` m ON m.`id` = candidate.`material_id`
WHERE sl.`title` = COALESCE(NULLIF(trim(m.`title`), ''), 'Матеріал')
	AND sl.`author` = COALESCE(m.`author`, '')
	AND COALESCE(sl.`publication_year`, 0) = COALESCE(m.`publication_year`, 0)
	AND sl.`subject` = COALESCE(m.`subject`, '')
	AND sl.`rubric` = COALESCE(m.`rubric`, '')
	AND sl.`quantity_issued` = candidate.`issued_quantity`
	AND (
		SELECT COUNT(*)
		FROM `class_loan_transaction_lines` txl2
		JOIN `materials` m2 ON m2.`id` = txl2.`material_id`
		WHERE txl2.`transaction_id` = sl.`transaction_id`
			AND COALESCE(NULLIF(trim(m2.`title`), ''), 'Матеріал') = sl.`title`
			AND COALESCE(m2.`author`, '') = sl.`author`
			AND COALESCE(m2.`publication_year`, 0) = COALESCE(sl.`publication_year`, 0)
			AND COALESCE(m2.`subject`, '') = sl.`subject`
			AND COALESCE(m2.`rubric`, '') = sl.`rubric`
			AND ABS(txl2.`quantity_delta`) = sl.`quantity_issued`
	) = 1
	AND (
		SELECT COUNT(*)
		FROM `class_loan_statement_lines` sl2
		WHERE sl2.`transaction_id` = sl.`transaction_id`
			AND sl2.`title` = sl.`title`
			AND sl2.`author` = sl.`author`
			AND COALESCE(sl2.`publication_year`, 0) = COALESCE(sl.`publication_year`, 0)
			AND sl2.`subject` = sl.`subject`
			AND sl2.`rubric` = sl.`rubric`
			AND sl2.`quantity_issued` = sl.`quantity_issued`
	) = 1;--> statement-breakpoint

CREATE TRIGGER `class_loan_statement_item_links_immutable_update`
BEFORE UPDATE ON `class_loan_statement_item_links`
BEGIN
	SELECT RAISE(ABORT, 'class issue statement item link is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `class_loan_statement_item_links_immutable_delete`
BEFORE DELETE ON `class_loan_statement_item_links`
BEGIN
	SELECT RAISE(ABORT, 'class issue statement item link is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `class_loan_item_adjustments_immutable_update`
BEFORE UPDATE ON `class_loan_item_adjustments`
BEGIN
	SELECT RAISE(ABORT, 'class loan item adjustment is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `class_loan_item_adjustments_immutable_delete`
BEFORE DELETE ON `class_loan_item_adjustments`
BEGIN
	SELECT RAISE(ABORT, 'class loan item adjustment is immutable');
END;
