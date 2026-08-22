CREATE TABLE `__version38_production_guard` (
	`should_apply` integer NOT NULL,
	`valid` integer NOT NULL,
	CONSTRAINT `version38_should_apply_valid` CHECK (`should_apply` IN (0,1)),
	CONSTRAINT `version38_production_state_valid` CHECK (`should_apply` = 0 OR `valid` = 1)
);
--> statement-breakpoint
INSERT INTO `__version38_production_guard` (`should_apply`,`valid`)
SELECT
  CASE WHEN EXISTS (SELECT 1 FROM `users`
      WHERE `id` IN ('USR-006','USR-007','USR-008','USR-009'))
    OR EXISTS (SELECT 1 FROM `class_years` WHERE `id`='CY-2026-001')
    OR EXISTS (SELECT 1 FROM `cohorts` WHERE `id`='COH-001')
  THEN 1 ELSE 0 END,
  CASE WHEN
    EXISTS (SELECT 1 FROM `users` WHERE `id`='USR-001'
      AND `full_name`='Швець Назарій Миколайович'
      AND `email`='nazarijshvetz1@gmail.com' AND `role`='admin' AND `status`='active')
    AND (SELECT COUNT(*) FROM `users`
      WHERE (`id`='USR-006' AND `full_name`='Орел Галина Миколаївна'
          AND `sort_name`='орел галина миколаївна')
        OR (`id`='USR-007' AND `full_name`='Галака Наталія Григорівна'
          AND `sort_name`='галака наталія григорівна')
        OR (`id`='USR-008' AND `full_name`='Єгорова Альона Ігорівна'
          AND `sort_name`='єгорова альона ігорівна')
        OR (`id`='USR-009' AND `full_name`='Плахотнюк Володимир Віталійович'
          AND `sort_name`='плахотнюк володимир віталійович')) = 4
    AND (SELECT COUNT(*) FROM `users`
      WHERE `id` IN ('USR-006','USR-007','USR-008','USR-009')
        AND `role`='admin' AND `status`='active') = 4
    AND (SELECT COUNT(*) FROM `teacher_profiles`
      WHERE `teacher_user_id` IN ('USR-006','USR-007','USR-008','USR-009')
        AND `closed_at` IS NULL) = 4
    AND EXISTS (SELECT 1 FROM `academic_years`
      WHERE `id`='YR-2026-2027' AND `label`='2026/2027'
        AND `start_date`='2026-09-01' AND `end_date`='2027-05-31' AND `status`='active')
    AND EXISTS (SELECT 1 FROM `class_years`
      WHERE `id`='CY-2026-001' AND `academic_year_id`='YR-2026-2027'
        AND `cohort_id`='COH-001' AND `class_name`='1-А' AND `grade`=1 AND `code`='А'
        AND `status`='closed' AND `actual_closed_date`='2026-09-01' AND `version`=3)
    AND EXISTS (SELECT 1 FROM `cohorts` WHERE `id`='COH-001' AND `status`='closed')
    AND NOT EXISTS (SELECT 1 FROM `class_years`
      WHERE `cohort_id`='COH-001' AND `id`<>'CY-2026-001' AND `status` IN ('planned','active'))
  THEN 1 ELSE 0 END;
--> statement-breakpoint
UPDATE `telegram_librarian_sessions`
SET `revoked_at`=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    `last_seen_at`=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE `user_id` IN ('USR-006','USR-007','USR-008','USR-009') AND `revoked_at` IS NULL
  AND (SELECT `should_apply` FROM `__version38_production_guard`)=1;
--> statement-breakpoint
UPDATE `telegram_delivery_outbox`
SET `status`='dead',`lease_token`=NULL,`lease_expires_at`=NULL,
    `last_error_code`='recipient_role_changed',
    `last_error_message`='Одержувач більше не має ролі бібліотекаря.',
    `updated_at`=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE `recipient_user_id` IN ('USR-006','USR-007','USR-008','USR-009')
  AND `target_path` GLOB '/librarian*' AND `status` IN ('pending','processing','retry')
  AND (SELECT `should_apply` FROM `__version38_production_guard`)=1;
--> statement-breakpoint
UPDATE `users`
SET `role`='teacher',`updated_at`=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE `id` IN ('USR-006','USR-007','USR-008','USR-009')
  AND `role`='admin' AND `status`='active'
  AND (SELECT `should_apply` FROM `__version38_production_guard`)=1;
--> statement-breakpoint
INSERT INTO `audit_events` (
  `id`,`actor_user_id`,`actor_email`,`action`,`entity_type`,`entity_id`,`request_id`,
  `before_json`,`after_json`,`metadata_json`,`created_at`
)
SELECT 'AUD-V38-ROLE-' || substr(`u`.`id`,5), 'USR-001',
  'nazarijshvetz1@gmail.com','user.role.changed','user',`u`.`id`,
  'VERSION-38-TEACHER-ROLE',json_object('role','admin','status','active'),
  json_object('role','teacher','status','active'),
  json_object('reason','Переведено з адміністрації до вчителів за підтвердженим запитом бібліотекаря.'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM `users` `u`
WHERE `u`.`id` IN ('USR-006','USR-007','USR-008','USR-009')
  AND `u`.`role`='teacher' AND `u`.`status`='active'
  AND (SELECT `should_apply` FROM `__version38_production_guard`)=1;
--> statement-breakpoint
UPDATE `cohorts`
SET `status`='active',`updated_at`=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE `id`='COH-001' AND `status`='closed'
  AND (SELECT `should_apply` FROM `__version38_production_guard`)=1;
--> statement-breakpoint
UPDATE `class_years`
SET `status`='active',`actual_closed_date`=NULL,`version`=`version`+1,
    `updated_at`=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE `id`='CY-2026-001' AND `status`='closed'
  AND `actual_closed_date`='2026-09-01' AND `version`=3
  AND (SELECT `should_apply` FROM `__version38_production_guard`)=1;
--> statement-breakpoint
INSERT INTO `audit_events` (
  `id`,`actor_user_id`,`actor_email`,`action`,`entity_type`,`entity_id`,`request_id`,
  `before_json`,`after_json`,`metadata_json`,`created_at`
)
SELECT 'AUD-V38-REOPEN-CY-2026-001','USR-001','nazarijshvetz1@gmail.com',
  'class_year.reopened','class_year','CY-2026-001','VERSION-38-REOPEN-1-A',
  json_object('status','closed','actualClosedDate','2026-09-01','version',3,'cohortStatus','closed'),
  json_object('status','active','actualClosedDate',NULL,'version',4,'cohortStatus','active'),
  json_object('reason','Помилково закритий клас поновлено за підтвердженим запитом бібліотекаря.'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE EXISTS (SELECT 1 FROM `class_years`
    WHERE `id`='CY-2026-001' AND `status`='active' AND `actual_closed_date` IS NULL AND `version`=4)
  AND EXISTS (SELECT 1 FROM `cohorts` WHERE `id`='COH-001' AND `status`='active')
  AND (SELECT `should_apply` FROM `__version38_production_guard`)=1;
--> statement-breakpoint
DROP TABLE `__version38_production_guard`;
