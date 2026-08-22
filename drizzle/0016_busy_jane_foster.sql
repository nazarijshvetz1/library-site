PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_visit_teacher_access_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text NOT NULL,
	`kind` text NOT NULL,
	`teacher_user_id` text,
	`request_hash` text NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`result_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`teacher_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "visit_teacher_access_commands_kind_valid" CHECK("__new_visit_teacher_access_commands"."kind" in ('code.issue','code.bulk_issue','code.import','credential.enable','credential.disable','credential.unlock','sessions.revoke')),
	CONSTRAINT "visit_teacher_access_commands_hash_valid" CHECK(length("__new_visit_teacher_access_commands"."request_hash") = 64 and lower("__new_visit_teacher_access_commands"."request_hash") not glob '*[^0-9a-f]*'),
	CONSTRAINT "visit_teacher_access_commands_status_valid" CHECK("__new_visit_teacher_access_commands"."status" in ('processing', 'completed', 'failed')),
	CONSTRAINT "visit_teacher_access_commands_result_valid" CHECK("__new_visit_teacher_access_commands"."result_json" is null or json_valid("__new_visit_teacher_access_commands"."result_json")),
	CONSTRAINT "visit_teacher_access_commands_completion_consistent" CHECK(("__new_visit_teacher_access_commands"."status" = 'processing' and "__new_visit_teacher_access_commands"."completed_at" is null) or ("__new_visit_teacher_access_commands"."status" in ('completed', 'failed') and "__new_visit_teacher_access_commands"."completed_at" is not null))
);
--> statement-breakpoint
INSERT INTO `__new_visit_teacher_access_commands`("id", "actor_user_id", "kind", "teacher_user_id", "request_hash", "status", "result_json", "created_at", "updated_at", "completed_at") SELECT "id", "actor_user_id", "kind", "teacher_user_id", "request_hash", "status", "result_json", "created_at", "updated_at", "completed_at" FROM `visit_teacher_access_commands`;--> statement-breakpoint
DROP TABLE `visit_teacher_access_commands`;--> statement-breakpoint
ALTER TABLE `__new_visit_teacher_access_commands` RENAME TO `visit_teacher_access_commands`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_visit_teacher_access_commands_actor_created` ON `visit_teacher_access_commands` (`actor_user_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `__version35_preflight` (
	`valid` integer NOT NULL,
	CONSTRAINT `version35_preflight_valid` CHECK (`valid` = 1)
);
--> statement-breakpoint
INSERT INTO `__version35_preflight` (`valid`)
SELECT CASE WHEN (SELECT COUNT(*) FROM `users`) = 0 THEN 1 WHEN
  (SELECT COUNT(*) FROM `users`
    WHERE `id` IN ('USR-006','USR-007','USR-008','USR-009')
      AND `role`='admin' AND `status`='active') = 4
  AND EXISTS (SELECT 1 FROM `users`
    WHERE `id`='USR-006' AND `full_name`='Орел Галина Миколаївна')
  AND EXISTS (SELECT 1 FROM `users`
    WHERE `id`='USR-007' AND `full_name`='Галака Наталія Григорівна')
  AND EXISTS (SELECT 1 FROM `users`
    WHERE `id`='USR-008' AND `full_name`='Єгорова Олена Ігорівна')
  AND EXISTS (SELECT 1 FROM `users`
    WHERE `id`='USR-009' AND `full_name`='Плахотнюк Володимир Віталійович')
  AND NOT EXISTS (SELECT 1 FROM `teacher_profiles`
    WHERE `teacher_user_id` IN ('USR-006','USR-007','USR-008','USR-009'))
  AND EXISTS (SELECT 1 FROM `academic_years`
    WHERE `id`='YR-2026-2027' AND `end_date`='2027-08-31')
  AND EXISTS (SELECT 1 FROM `academic_years`
    WHERE `id`='YR-2027-2028' AND `end_date`='2028-08-31')
  AND NOT EXISTS (SELECT 1 FROM `class_years`
    WHERE `academic_year_id`='YR-2026-2027' AND `end_date`<>'2027-08-31')
  AND NOT EXISTS (SELECT 1 FROM `class_years`
    WHERE `academic_year_id`='YR-2027-2028' AND `end_date`<>'2028-08-31')
  AND NOT EXISTS (SELECT 1 FROM `class_loans`
    WHERE `status`='open' AND `due_at` IS NOT NULL
      AND `due_at` > CASE
        WHEN `class_year_id` IN (SELECT `id` FROM `class_years`
          WHERE `academic_year_id`='YR-2026-2027') THEN '2027-05-31'
        WHEN `class_year_id` IN (SELECT `id` FROM `class_years`
          WHERE `academic_year_id`='YR-2027-2028') THEN '2028-05-31'
        ELSE `due_at`
      END)
THEN 1 ELSE 0 END;
--> statement-breakpoint
DROP TABLE `__version35_preflight`;
--> statement-breakpoint
UPDATE `users`
SET `full_name`='Єгорова Альона Ігорівна',
    `sort_name`='єгорова альона ігорівна',
    `updated_at`=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE `id`='USR-008' AND `role`='admin' AND `status`='active'
  AND `full_name`='Єгорова Олена Ігорівна';
--> statement-breakpoint
INSERT INTO `teacher_profiles` (
  `teacher_user_id`,`subject_position`,`primary_location_id`,`service_contact`,
  `librarian_note`,`version`,`last_mutation_request_id`,`closed_at`,
  `closed_by_user_id`,`created_by_user_id`,`updated_by_user_id`,`created_at`,`updated_at`
)
SELECT `u`.`id`,'',NULL,'','',1,NULL,NULL,NULL,NULL,NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM `users` `u`
WHERE `u`.`id` IN ('USR-006','USR-007','USR-008','USR-009')
  AND `u`.`role`='admin' AND `u`.`status`='active'
  AND NOT EXISTS (SELECT 1 FROM `teacher_profiles` `p` WHERE `p`.`teacher_user_id`=`u`.`id`);
--> statement-breakpoint
UPDATE `academic_years`
SET `end_date`='2027-05-31',`version`=`version`+1,
    `updated_at`=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE `id`='YR-2026-2027' AND `end_date`='2027-08-31';
--> statement-breakpoint
UPDATE `academic_years`
SET `end_date`='2028-05-31',`version`=`version`+1,
    `updated_at`=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE `id`='YR-2027-2028' AND `end_date`='2028-08-31';
--> statement-breakpoint
UPDATE `class_years`
SET `end_date`='2027-05-31',`version`=`version`+1,
    `updated_at`=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE `academic_year_id`='YR-2026-2027' AND `end_date`='2027-08-31';
--> statement-breakpoint
UPDATE `class_years`
SET `end_date`='2028-05-31',`version`=`version`+1,
    `updated_at`=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE `academic_year_id`='YR-2027-2028' AND `end_date`='2028-08-31';
--> statement-breakpoint
UPDATE `class_years`
SET `notes`=replace(`notes`,'Єгорова Олена Ігорівна','Єгорова Альона Ігорівна'),
    `version`=`version`+1,
    `updated_at`=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE `teacher_user_id`='USR-008' AND `notes` LIKE '%Єгорова Олена Ігорівна%';
