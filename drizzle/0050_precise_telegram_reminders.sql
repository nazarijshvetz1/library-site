UPDATE `telegram_delivery_outbox`
SET
	`next_attempt_at` = CASE
		WHEN julianday((
			SELECT `scheduled_issue_at`
			FROM `material_requests`
			WHERE `material_requests`.`id` = `telegram_delivery_outbox`.`entity_id`
		), '-10 minutes') <= julianday('now')
			THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		ELSE strftime('%Y-%m-%dT%H:%M:%fZ', (
			SELECT `scheduled_issue_at`
			FROM `material_requests`
			WHERE `material_requests`.`id` = `telegram_delivery_outbox`.`entity_id`
		), '-10 minutes')
	END,
	`expires_at` = (
		SELECT `scheduled_issue_at`
		FROM `material_requests`
		WHERE `material_requests`.`id` = `telegram_delivery_outbox`.`entity_id`
	),
	`title` = CASE
		WHEN `type` = 'material_request_pickup_reminder' THEN CASE
			WHEN julianday((
				SELECT `scheduled_issue_at`
				FROM `material_requests`
				WHERE `material_requests`.`id` = `telegram_delivery_outbox`.`entity_id`
			), '-10 minutes') <= julianday('now')
				THEN 'Незабаром — отримання матеріалів'
			ELSE 'За 10 хвилин — отримання матеріалів'
		END
		ELSE CASE
			WHEN julianday((
				SELECT `scheduled_issue_at`
				FROM `material_requests`
				WHERE `material_requests`.`id` = `telegram_delivery_outbox`.`entity_id`
			), '-10 minutes') <= julianday('now')
				THEN 'Підготуйте видачу зараз'
			ELSE 'Підготуйте видачу за 10 хвилин'
		END
	END,
	`updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `status` IN ('pending', 'retry')
	AND `entity_type` = 'material_request'
	AND `type` IN ('material_request_pickup_reminder', 'material_request_prepare_reminder')
	AND EXISTS (
		SELECT 1
		FROM `material_requests`
		WHERE `material_requests`.`id` = `telegram_delivery_outbox`.`entity_id`
			AND `material_requests`.`status` IN ('ready', 'partially_ready')
			AND `scheduled_issue_at` IS NOT NULL
			AND julianday(`scheduled_issue_at`) > julianday('now')
			AND CAST(strftime('%s', `scheduled_issue_at`) AS INTEGER)
				- CAST(strftime('%s', `telegram_delivery_outbox`.`next_attempt_at`) AS INTEGER) = 300
	);
