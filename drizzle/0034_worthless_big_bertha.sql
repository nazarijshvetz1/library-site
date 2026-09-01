CREATE TABLE `class_loan_statement_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`class_loan_id` text NOT NULL,
	`transaction_id` text,
	`position` integer NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`title` text NOT NULL,
	`author` text DEFAULT '' NOT NULL,
	`publication_year` integer,
	`rubric` text DEFAULT '' NOT NULL,
	`quantity_issued` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`class_loan_id`) REFERENCES `class_loans`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`transaction_id`) REFERENCES `class_loan_transactions`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "class_loan_statement_lines_position_positive" CHECK("class_loan_statement_lines"."position" > 0),
	CONSTRAINT "class_loan_statement_lines_title_present" CHECK(length(trim("class_loan_statement_lines"."title")) > 0),
	CONSTRAINT "class_loan_statement_lines_quantity_positive" CHECK("class_loan_statement_lines"."quantity_issued" > 0),
	CONSTRAINT "class_loan_statement_lines_year_valid" CHECK("class_loan_statement_lines"."publication_year" is null or "class_loan_statement_lines"."publication_year" between 1000 and 3000)
);
--> statement-breakpoint
CREATE INDEX `idx_class_loan_statement_lines_loan_position` ON `class_loan_statement_lines` (`class_loan_id`,`created_at`,`position`,`id`);--> statement-breakpoint
CREATE INDEX `idx_class_loan_statement_lines_transaction` ON `class_loan_statement_lines` (`transaction_id`);--> statement-breakpoint
ALTER TABLE `class_loans` ADD `merged_into_class_loan_id` text;--> statement-breakpoint
CREATE INDEX `idx_class_loans_merged_into` ON `class_loans` (`merged_into_class_loan_id`);--> statement-breakpoint
INSERT INTO `class_loan_statement_lines` (
	`id`, `class_loan_id`, `transaction_id`, `position`, `subject`, `title`,
	`author`, `publication_year`, `rubric`, `quantity_issued`, `created_at`
)
SELECT
	'CLSL-' || cl.`id` || '-' || printf('%04d', CAST(line.key AS INTEGER) + 1),
	cl.`id`,
	(
		SELECT tx.`id`
		FROM `class_loan_transactions` tx
		WHERE tx.`class_loan_id` = cl.`id` AND tx.`kind` = 'issue'
		ORDER BY tx.`occurred_at`, tx.`created_at`, tx.`id`
		LIMIT 1
	),
	CAST(line.key AS INTEGER) + 1,
	COALESCE(json_extract(line.value, '$.subject'), ''),
	COALESCE(NULLIF(trim(json_extract(line.value, '$.title')), ''), 'Матеріал'),
	COALESCE(json_extract(line.value, '$.author'), ''),
	CASE
		WHEN CAST(json_extract(line.value, '$.publicationYear') AS INTEGER) BETWEEN 1000 AND 3000
		THEN CAST(json_extract(line.value, '$.publicationYear') AS INTEGER)
		ELSE NULL
	END,
	COALESCE(json_extract(line.value, '$.rubric'), ''),
	CASE
		WHEN CAST(json_extract(line.value, '$.quantityIssued') AS INTEGER) > 0
		THEN CAST(json_extract(line.value, '$.quantityIssued') AS INTEGER)
		ELSE 1
	END,
	cl.`created_at`
FROM `class_loans` cl, json_each(cl.`issue_statement_json`, '$.lines') line
WHERE cl.`issue_statement_schema_version` = 1
	AND cl.`issue_statement_origin` IN ('issued', 'legacy_backfill');--> statement-breakpoint
INSERT INTO `class_loan_statement_lines` (
	`id`, `class_loan_id`, `transaction_id`, `position`, `subject`, `title`,
	`author`, `publication_year`, `rubric`, `quantity_issued`, `created_at`
)
SELECT
	'CLSL-LEGACY-' || cli.`id`,
	cli.`class_loan_id`,
	NULL,
	ROW_NUMBER() OVER (
		PARTITION BY cli.`class_loan_id`
		ORDER BY cli.`created_at`, cli.`id`
	),
	COALESCE(m.`subject`, ''),
	COALESCE(NULLIF(trim(m.`title`), ''), 'Матеріал'),
	COALESCE(m.`author`, ''),
	CASE WHEN m.`publication_year` BETWEEN 1000 AND 3000 THEN m.`publication_year` ELSE NULL END,
	COALESCE(m.`rubric`, ''),
	cli.`quantity_issued`,
	cli.`created_at`
FROM `class_loan_items` cli
JOIN `class_loans` cl ON cl.`id` = cli.`class_loan_id`
JOIN `materials` m ON m.`id` = cli.`material_id`
WHERE cl.`issue_statement_schema_version` = 0;--> statement-breakpoint
CREATE TABLE `_class_loan_merge_map` (
	`duplicate_id` text PRIMARY KEY NOT NULL,
	`canonical_id` text NOT NULL
);--> statement-breakpoint
INSERT INTO `_class_loan_merge_map` (`duplicate_id`, `canonical_id`)
SELECT
	duplicate.`id`,
	(
		SELECT canonical.`id`
		FROM `class_loans` canonical
		WHERE canonical.`class_year_id` = duplicate.`class_year_id`
			AND canonical.`status` = 'open'
		ORDER BY canonical.`created_at`, canonical.`id`
		LIMIT 1
	)
FROM `class_loans` duplicate
WHERE duplicate.`status` = 'open'
	AND duplicate.`id` != (
		SELECT canonical.`id`
		FROM `class_loans` canonical
		WHERE canonical.`class_year_id` = duplicate.`class_year_id`
			AND canonical.`status` = 'open'
		ORDER BY canonical.`created_at`, canonical.`id`
		LIMIT 1
	);--> statement-breakpoint
UPDATE `class_loan_items`
SET `class_loan_id` = (
	SELECT merge_map.`canonical_id`
	FROM `_class_loan_merge_map` merge_map
	WHERE merge_map.`duplicate_id` = `class_loan_items`.`class_loan_id`
)
WHERE `class_loan_id` IN (SELECT `duplicate_id` FROM `_class_loan_merge_map`);--> statement-breakpoint
UPDATE `class_loan_transactions`
SET `class_loan_id` = (
	SELECT merge_map.`canonical_id`
	FROM `_class_loan_merge_map` merge_map
	WHERE merge_map.`duplicate_id` = `class_loan_transactions`.`class_loan_id`
)
WHERE `class_loan_id` IN (SELECT `duplicate_id` FROM `_class_loan_merge_map`);--> statement-breakpoint
UPDATE `class_loan_statement_lines`
SET `class_loan_id` = (
	SELECT merge_map.`canonical_id`
	FROM `_class_loan_merge_map` merge_map
	WHERE merge_map.`duplicate_id` = `class_loan_statement_lines`.`class_loan_id`
)
WHERE `class_loan_id` IN (SELECT `duplicate_id` FROM `_class_loan_merge_map`);--> statement-breakpoint
UPDATE `class_loans`
SET
	`version` = `version` + 1,
	`updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `id` IN (SELECT DISTINCT `canonical_id` FROM `_class_loan_merge_map`);--> statement-breakpoint
UPDATE `class_loans`
SET
	`status` = 'cancelled',
	`merged_into_class_loan_id` = (
		SELECT merge_map.`canonical_id`
		FROM `_class_loan_merge_map` merge_map
		WHERE merge_map.`duplicate_id` = `class_loans`.`id`
	),
	`notes` = CASE
		WHEN trim(`notes`) = '' THEN 'Об’єднано зі спільною видачею класу.'
		ELSE `notes` || char(10) || 'Об’єднано зі спільною видачею класу.'
	END,
	`version` = `version` + 1,
	`updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `id` IN (SELECT `duplicate_id` FROM `_class_loan_merge_map`);--> statement-breakpoint
DROP TABLE `_class_loan_merge_map`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_class_loans_one_open_per_class` ON `class_loans` (`class_year_id`) WHERE "class_loans"."status" = 'open';--> statement-breakpoint
CREATE TRIGGER `class_loan_statement_lines_immutable_update`
BEFORE UPDATE ON `class_loan_statement_lines`
BEGIN
	SELECT RAISE(ABORT, 'class issue statement line is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `class_loan_statement_lines_immutable_delete`
BEFORE DELETE ON `class_loan_statement_lines`
BEGIN
	SELECT RAISE(ABORT, 'class issue statement line is immutable');
END;
