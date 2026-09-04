ALTER TABLE `telegram_delivery_outbox` ADD `expires_at` text;
--> statement-breakpoint
UPDATE `telegram_delivery_outbox`
SET `expires_at` = (
	SELECT `scheduled_issue_at`
	FROM `material_requests`
	WHERE `material_requests`.`id` = `telegram_delivery_outbox`.`entity_id`
)
WHERE `expires_at` IS NULL
	AND `entity_type` = 'material_request'
	AND `type` IN ('material_request_pickup_reminder', 'material_request_prepare_reminder')
	AND EXISTS (
		SELECT 1
		FROM `material_requests`
		WHERE `material_requests`.`id` = `telegram_delivery_outbox`.`entity_id`
			AND `scheduled_issue_at` IS NOT NULL
	);
