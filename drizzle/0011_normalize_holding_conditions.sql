CREATE TABLE `__condition_normalization_targets` (
	`material_id` text NOT NULL,
	`location_id` text NOT NULL,
	`condition` text NOT NULL,
	`quantity` integer NOT NULL,
	`version` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY (`material_id`, `location_id`, `condition`)
);--> statement-breakpoint
INSERT INTO `__condition_normalization_targets` (
	`material_id`, `location_id`, `condition`, `quantity`, `version`, `updated_at`
)
SELECT `material_id`, `location_id`, `condition`, `quantity`, `version`, `updated_at`
FROM `holdings`
WHERE `condition` <> 'good';--> statement-breakpoint
CREATE TABLE `__condition_normalization_guard` (
	`marker` text NOT NULL CHECK (`marker` = 'ok')
);--> statement-breakpoint
INSERT INTO `__condition_normalization_guard` (`marker`)
SELECT CASE WHEN
	(SELECT count(*) FROM `__condition_normalization_targets`) = 0
	OR (
	(SELECT count(*) FROM `__condition_normalization_targets`) = 1088
	AND (SELECT COALESCE(sum(`quantity`), 0) FROM `__condition_normalization_targets`) = 19141
	AND NOT EXISTS (
		SELECT 1
		FROM `__condition_normalization_targets` target
		JOIN `holdings` existing
			ON existing.`material_id` = target.`material_id`
			AND existing.`location_id` = target.`location_id`
			AND existing.`condition` = 'good'
	)
	AND NOT EXISTS (
		SELECT 1
		FROM `material_request_reservations` reservation
		WHERE reservation.`condition` <> 'good'
			AND reservation.`reserved_quantity` > reservation.`issued_quantity` + reservation.`released_quantity`
	)
	AND NOT EXISTS (
		SELECT 1
		FROM `loan_items` item
		JOIN `loans` loan ON loan.`id` = item.`loan_id`
		WHERE loan.`status` = 'open'
			AND item.`quantity_issued` > item.`quantity_returned`
			AND item.`condition` <> 'good'
	)
	AND NOT EXISTS (
		SELECT 1
		FROM `class_loan_items` item
		JOIN `class_loans` loan ON loan.`id` = item.`class_loan_id`
		WHERE loan.`status` = 'open'
			AND item.`quantity_issued` > item.`quantity_returned`
			AND item.`condition` <> 'good'
	)
	AND EXISTS (
		SELECT 1 FROM `users`
		WHERE `id` = 'USR-001' AND `status` = 'active' AND `role` IN ('admin', 'librarian')
	)
	)
	THEN 'ok' ELSE NULL END;--> statement-breakpoint
INSERT INTO `inventory_transactions` (
	`id`, `request_id`, `kind`, `occurred_at`, `document_number`, `reason`, `notes`,
	`loan_id`, `actor_user_id`, `reversal_of_id`, `status`, `created_at`
)
SELECT
	'ITX-CONDITION-GOOD-20260820',
	'78fbd9be-8b51-4f76-93e6-3ab9e376c8e4',
	'import',
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
	'CONDITION-GOOD-2026-08-20',
	'condition_normalization',
	'Усі поточні примірники каталогу переведено у добрий стан.',
	NULL,
	'USR-001',
	NULL,
	'posted',
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `__condition_normalization_guard`
WHERE EXISTS (SELECT 1 FROM `__condition_normalization_targets`);--> statement-breakpoint
INSERT INTO `inventory_transaction_lines` (
	`id`, `transaction_id`, `material_id`, `location_id`, `condition`,
	`quantity_delta`, `quantity_before`, `quantity_after`, `counted_quantity`,
	`loan_item_id`, `created_at`
)
SELECT
	'ITL-CONDITION-OLD-' || target.`material_id` || '-' || target.`location_id` || '-' || target.`condition`,
	'ITX-CONDITION-GOOD-20260820',
	target.`material_id`,
	target.`location_id`,
	target.`condition`,
	-target.`quantity`,
	target.`quantity`,
	0,
	NULL,
	NULL,
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `__condition_normalization_targets` target;--> statement-breakpoint
INSERT INTO `inventory_transaction_lines` (
	`id`, `transaction_id`, `material_id`, `location_id`, `condition`,
	`quantity_delta`, `quantity_before`, `quantity_after`, `counted_quantity`,
	`loan_item_id`, `created_at`
)
SELECT
	'ITL-CONDITION-GOOD-' || target.`material_id` || '-' || target.`location_id`,
	'ITX-CONDITION-GOOD-20260820',
	target.`material_id`,
	target.`location_id`,
	'good',
	target.`quantity`,
	0,
	target.`quantity`,
	NULL,
	NULL,
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `__condition_normalization_targets` target;--> statement-breakpoint
UPDATE `holdings`
SET
	`condition` = 'good',
	`version` = `version` + 1,
	`updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `condition` <> 'good';--> statement-breakpoint
INSERT INTO `audit_events` (
	`id`, `actor_user_id`, `actor_email`, `action`, `entity_type`, `entity_id`,
	`request_id`, `before_json`, `after_json`, `metadata_json`, `created_at`
)
SELECT
	'AUDIT-CONDITION-GOOD-20260820',
	'USR-001',
	COALESCE((SELECT `email` FROM `users` WHERE `id` = 'USR-001'), 'system@library.local'),
	'holdings.condition_normalized',
	'inventory_transaction',
	'ITX-CONDITION-GOOD-20260820',
	'78fbd9be-8b51-4f76-93e6-3ab9e376c8e4',
	json_object(
		'condition', 'mixed',
		'changedRows', (SELECT count(*) FROM `__condition_normalization_targets`),
		'changedCopies', (SELECT COALESCE(sum(`quantity`), 0) FROM `__condition_normalization_targets`),
		'totalRows', (SELECT count(*) FROM `holdings`),
		'totalCopies', (SELECT COALESCE(sum(`quantity`), 0) FROM `holdings`)
	),
	json_object(
		'condition', 'good',
		'changedRows', (SELECT count(*) FROM `__condition_normalization_targets`),
		'changedCopies', (SELECT COALESCE(sum(`quantity`), 0) FROM `__condition_normalization_targets`),
		'totalRows', (SELECT count(*) FROM `holdings`),
		'totalCopies', (SELECT COALESCE(sum(`quantity`), 0) FROM `holdings`)
	),
	json_object(
		'transactionId', 'ITX-CONDITION-GOOD-20260820',
		'targetCondition', 'good',
		'historicalRecordsPreserved', json('true')
	),
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `__condition_normalization_guard`
WHERE EXISTS (SELECT 1 FROM `__condition_normalization_targets`);--> statement-breakpoint
DELETE FROM `__condition_normalization_guard`;--> statement-breakpoint
INSERT INTO `__condition_normalization_guard` (`marker`)
SELECT CASE WHEN
	NOT EXISTS (SELECT 1 FROM `holdings` WHERE `condition` <> 'good')
	AND (SELECT count(*) FROM `inventory_transaction_lines` WHERE `transaction_id` = 'ITX-CONDITION-GOOD-20260820')
		= 2 * (SELECT count(*) FROM `__condition_normalization_targets`)
	AND NOT EXISTS (
		SELECT 1
		FROM `__condition_normalization_targets` target
		LEFT JOIN `holdings` current
			ON current.`material_id` = target.`material_id`
			AND current.`location_id` = target.`location_id`
			AND current.`condition` = 'good'
		WHERE current.`material_id` IS NULL
			OR current.`quantity` <> target.`quantity`
			OR current.`version` <> target.`version` + 1
	)
	AND NOT EXISTS (
		SELECT 1
		FROM `inventory_transaction_lines`
		WHERE `transaction_id` = 'ITX-CONDITION-GOOD-20260820'
		GROUP BY `material_id`, `location_id`
		HAVING sum(`quantity_delta`) <> 0
	)
	THEN 'ok' ELSE NULL END;--> statement-breakpoint
DROP TABLE `__condition_normalization_guard`;--> statement-breakpoint
DROP TABLE `__condition_normalization_targets`;
