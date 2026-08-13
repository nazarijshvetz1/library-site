CREATE TABLE `teacher_profiles` (
	`teacher_user_id` text PRIMARY KEY NOT NULL,
	`subject_position` text DEFAULT '' NOT NULL,
	`primary_location_id` text,
	`service_contact` text DEFAULT '' NOT NULL,
	`librarian_note` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`last_mutation_request_id` text,
	`closed_at` text,
	`closed_by_user_id` text,
	`created_by_user_id` text,
	`updated_by_user_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`teacher_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`primary_location_id`) REFERENCES `locations`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`closed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "teacher_profiles_subject_length" CHECK(length(`subject_position`) <= 160),
	CONSTRAINT "teacher_profiles_contact_length" CHECK(length(`service_contact`) <= 200),
	CONSTRAINT "teacher_profiles_note_length" CHECK(length(`librarian_note`) <= 4000),
	CONSTRAINT "teacher_profiles_version_positive" CHECK(`version` > 0),
	CONSTRAINT "teacher_profiles_closed_fields_consistent" CHECK(
		(`closed_at` is null and `closed_by_user_id` is null)
		or (`closed_at` is not null and `closed_by_user_id` is not null)
	)
);--> statement-breakpoint
CREATE INDEX `idx_teacher_profiles_location_teacher` ON `teacher_profiles` (`primary_location_id`,`teacher_user_id`);--> statement-breakpoint
CREATE INDEX `idx_teacher_profiles_updated` ON `teacher_profiles` (`updated_at`,`teacher_user_id`);--> statement-breakpoint
INSERT INTO `teacher_profiles` (
	`teacher_user_id`, `subject_position`, `primary_location_id`, `service_contact`,
	`librarian_note`, `version`, `last_mutation_request_id`, `closed_at`,
	`closed_by_user_id`, `created_by_user_id`, `updated_by_user_id`, `created_at`, `updated_at`
)
SELECT `id`, '', NULL, '', '', 1, NULL, NULL, NULL, NULL, NULL, `created_at`, `updated_at`
FROM `users`
WHERE `role` = 'teacher';--> statement-breakpoint
ALTER TABLE `material_request_items` RENAME TO `__legacy_material_request_items`;--> statement-breakpoint
ALTER TABLE `material_request_events` RENAME TO `__legacy_material_request_events`;--> statement-breakpoint
ALTER TABLE `material_requests` RENAME TO `__legacy_material_requests`;--> statement-breakpoint
CREATE TABLE `material_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`teacher_user_id` text NOT NULL,
	`status` text DEFAULT 'submitted' NOT NULL,
	`teacher_notes` text DEFAULT '' NOT NULL,
	`librarian_note` text DEFAULT '' NOT NULL,
	`rejection_reason` text DEFAULT '' NOT NULL,
	`pickup_location_id` text,
	`resulting_loan_id` text,
	`due_at` text,
	`reviewed_by_user_id` text,
	`cancelled_by_user_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`submitted_at` text NOT NULL,
	`ready_at` text,
	`completed_at` text,
	`rejected_at` text,
	`cancelled_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`teacher_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`pickup_location_id`) REFERENCES `locations`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`resulting_loan_id`) REFERENCES `loans`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`cancelled_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "material_requests_status_valid" CHECK(`status` in ('submitted','in_review','ready','partially_ready','completed','rejected','cancelled')),
	CONSTRAINT "material_requests_version_positive" CHECK(`version` > 0),
	CONSTRAINT "material_requests_terminal_times" CHECK(
		(`status` not in ('ready','partially_ready','completed') or (`ready_at` is not null and `pickup_location_id` is not null))
		and (`status` != 'completed' or `completed_at` is not null)
		and (`status` != 'rejected' or `rejected_at` is not null)
		and (`status` != 'cancelled' or `cancelled_at` is not null)
	)
);--> statement-breakpoint
INSERT INTO `material_requests` (
	`id`,`teacher_user_id`,`status`,`teacher_notes`,`librarian_note`,`rejection_reason`,
	`pickup_location_id`,`resulting_loan_id`,`due_at`,`reviewed_by_user_id`,`cancelled_by_user_id`,
	`version`,`submitted_at`,`ready_at`,`completed_at`,`rejected_at`,`cancelled_at`,`created_at`,`updated_at`
)
SELECT
	`id`,`teacher_user_id`,`status`,`teacher_notes`,`librarian_note`,`rejection_reason`,
	`pickup_location_id`,`resulting_loan_id`,
	(SELECT `due_at` FROM `loans` WHERE `loans`.`id`=`__legacy_material_requests`.`resulting_loan_id`),
	`reviewed_by_user_id`,`cancelled_by_user_id`,
	`version`,`submitted_at`,`ready_at`,`completed_at`,`rejected_at`,`cancelled_at`,`created_at`,`updated_at`
FROM `__legacy_material_requests`;--> statement-breakpoint
CREATE TABLE `material_request_items` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`material_id` text NOT NULL,
	`title_snapshot` text NOT NULL,
	`author_snapshot` text DEFAULT '' NOT NULL,
	`requested_quantity` integer NOT NULL,
	`approved_quantity` integer,
	`fulfilled_quantity` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `material_requests`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "material_request_items_title_not_blank" CHECK(length(trim(`title_snapshot`)) > 0),
	CONSTRAINT "material_request_items_quantity_valid" CHECK(
		`requested_quantity` > 0
		and (`approved_quantity` is null or (`approved_quantity` >= 0 and `approved_quantity` <= `requested_quantity`))
		and `fulfilled_quantity` >= 0
		and (`approved_quantity` is null or `fulfilled_quantity` <= `approved_quantity`)
	),
	CONSTRAINT "material_request_items_sort_order_nonnegative" CHECK(`sort_order` >= 0)
);--> statement-breakpoint
INSERT INTO `material_request_items` (
	`id`,`request_id`,`material_id`,`title_snapshot`,`author_snapshot`,`requested_quantity`,
	`approved_quantity`,`fulfilled_quantity`,`sort_order`,`created_at`,`updated_at`
)
SELECT
	`id`,`request_id`,`material_id`,`title_snapshot`,`author_snapshot`,`requested_quantity`,
	`approved_quantity`,`fulfilled_quantity`,`sort_order`,`created_at`,`updated_at`
FROM `__legacy_material_request_items`;--> statement-breakpoint
CREATE TABLE `material_request_events` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`actor_user_id` text,
	`actor_kind` text NOT NULL,
	`kind` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`metadata_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `material_requests`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "material_request_events_actor_kind_valid" CHECK(`actor_kind` in ('teacher','librarian','system')),
	CONSTRAINT "material_request_events_actor_consistent" CHECK(
		(`actor_kind` = 'system' and `actor_user_id` is null)
		or (`actor_kind` in ('teacher','librarian') and `actor_user_id` is not null)
	),
	CONSTRAINT "material_request_events_kind_not_blank" CHECK(length(trim(`kind`)) > 0),
	CONSTRAINT "material_request_events_metadata_valid" CHECK(`metadata_json` is null or json_valid(`metadata_json`))
);--> statement-breakpoint
INSERT INTO `material_request_events` (
	`id`,`request_id`,`actor_user_id`,`actor_kind`,`kind`,`from_status`,`to_status`,`metadata_json`,`created_at`
)
SELECT
	`id`,`request_id`,`actor_user_id`,`actor_kind`,`kind`,`from_status`,`to_status`,`metadata_json`,`created_at`
FROM `__legacy_material_request_events`;--> statement-breakpoint
DROP TABLE `__legacy_material_request_items`;--> statement-breakpoint
DROP TABLE `__legacy_material_request_events`;--> statement-breakpoint
DROP TABLE `__legacy_material_requests`;--> statement-breakpoint
CREATE INDEX `idx_material_requests_teacher_created` ON `material_requests` (`teacher_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_material_requests_status_created` ON `material_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_material_requests_resulting_loan` ON `material_requests` (`resulting_loan_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_material_request_items_request_material` ON `material_request_items` (`request_id`,`material_id`);--> statement-breakpoint
CREATE INDEX `idx_material_request_items_material_request` ON `material_request_items` (`material_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `idx_material_request_events_request_created` ON `material_request_events` (`request_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `material_stock_totals` ADD COLUMN `reserved_quantity` integer NOT NULL DEFAULT 0
	CHECK (`reserved_quantity` >= 0 AND `reserved_quantity` <= `library_quantity` + `other_location_quantity`);--> statement-breakpoint
DROP INDEX `idx_material_stock_totals_available`;--> statement-breakpoint
CREATE INDEX `idx_material_stock_totals_available` ON `material_stock_totals`
	(`total_quantity`,`loaned_quantity`,`reserved_quantity`,`material_id`);--> statement-breakpoint
CREATE TABLE `material_request_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`request_item_id` text NOT NULL,
	`material_id` text NOT NULL,
	`source_location_id` text NOT NULL,
	`condition` text NOT NULL,
	`reserved_quantity` integer NOT NULL,
	`issued_quantity` integer DEFAULT 0 NOT NULL,
	`released_quantity` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `material_requests`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`request_item_id`) REFERENCES `material_request_items`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`source_location_id`) REFERENCES `locations`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "material_request_reservations_condition_valid" CHECK(`condition` in ('unspecified', 'good', 'worn', 'damaged')),
	CONSTRAINT "material_request_reservations_quantities_valid" CHECK(
		`reserved_quantity` > 0
		and `issued_quantity` >= 0
		and `released_quantity` >= 0
		and `issued_quantity` + `released_quantity` <= `reserved_quantity`
	)
);--> statement-breakpoint
CREATE INDEX `idx_request_reservations_request_item` ON `material_request_reservations` (`request_id`,`request_item_id`);--> statement-breakpoint
CREATE INDEX `idx_request_reservations_stock` ON `material_request_reservations` (`material_id`,`source_location_id`,`condition`);--> statement-breakpoint
CREATE TRIGGER material_request_reservations_insert_guard BEFORE INSERT ON material_request_reservations BEGIN
 SELECT RAISE(ABORT,'reservation_stock_conflict') WHERE NOT EXISTS (SELECT 1 FROM material_requests mr JOIN material_request_items item ON item.id=NEW.request_item_id AND item.request_id=mr.id AND item.material_id=NEW.material_id JOIN materials m ON m.id=NEW.material_id AND m.status='active' AND m.archived_at IS NULL JOIN locations l ON l.id=NEW.source_location_id AND l.status='active' AND l.type!='service' JOIN holdings h ON h.material_id=NEW.material_id AND h.location_id=NEW.source_location_id AND h.condition=NEW.condition WHERE mr.id=NEW.request_id AND mr.status IN ('submitted','in_review','ready','partially_ready') AND h.quantity >= NEW.reserved_quantity-NEW.issued_quantity-NEW.released_quantity + COALESCE((SELECT SUM(r.reserved_quantity-r.issued_quantity-r.released_quantity) FROM material_request_reservations r WHERE r.material_id=NEW.material_id AND r.source_location_id=NEW.source_location_id AND r.condition=NEW.condition AND r.reserved_quantity>r.issued_quantity+r.released_quantity),0));
END;--> statement-breakpoint
CREATE TRIGGER material_request_reservations_update_guard BEFORE UPDATE ON material_request_reservations BEGIN
 SELECT RAISE(ABORT,'reservation_stock_conflict') WHERE NEW.request_id!=OLD.request_id OR NEW.request_item_id!=OLD.request_item_id OR NEW.material_id!=OLD.material_id OR NEW.source_location_id!=OLD.source_location_id OR NEW.condition!=OLD.condition OR NEW.reserved_quantity!=OLD.reserved_quantity OR NEW.issued_quantity<OLD.issued_quantity OR NEW.released_quantity<OLD.released_quantity OR (NEW.issued_quantity>OLD.issued_quantity AND NOT EXISTS (SELECT 1 FROM materials m JOIN locations l ON l.id=NEW.source_location_id WHERE m.id=NEW.material_id AND m.status='active' AND m.archived_at IS NULL AND l.status='active' AND l.type!='service')) OR NOT EXISTS (SELECT 1 FROM holdings h WHERE h.material_id=NEW.material_id AND h.location_id=NEW.source_location_id AND h.condition=NEW.condition AND h.quantity >= NEW.reserved_quantity-NEW.issued_quantity-NEW.released_quantity + COALESCE((SELECT SUM(r.reserved_quantity-r.issued_quantity-r.released_quantity) FROM material_request_reservations r WHERE r.material_id=NEW.material_id AND r.source_location_id=NEW.source_location_id AND r.condition=NEW.condition AND r.id!=OLD.id AND r.reserved_quantity>r.issued_quantity+r.released_quantity),0));
END;--> statement-breakpoint
CREATE TRIGGER holdings_reserved_update_guard BEFORE UPDATE OF quantity ON holdings BEGIN
 SELECT RAISE(ABORT,'reserved_stock_conflict') WHERE NEW.quantity < COALESCE((SELECT SUM(r.reserved_quantity-r.issued_quantity-r.released_quantity) FROM material_request_reservations r WHERE r.material_id=OLD.material_id AND r.source_location_id=OLD.location_id AND r.condition=OLD.condition AND r.reserved_quantity>r.issued_quantity+r.released_quantity),0);
END;--> statement-breakpoint
CREATE TRIGGER holdings_reserved_delete_guard BEFORE DELETE ON holdings BEGIN
 SELECT RAISE(ABORT,'reserved_stock_conflict') WHERE EXISTS (SELECT 1 FROM material_request_reservations r WHERE r.material_id=OLD.material_id AND r.source_location_id=OLD.location_id AND r.condition=OLD.condition AND r.reserved_quantity>r.issued_quantity+r.released_quantity);
END;--> statement-breakpoint
CREATE TRIGGER materials_reserved_archive_guard BEFORE UPDATE OF status, archived_at ON materials BEGIN
 SELECT RAISE(ABORT,'material_reserved_conflict') WHERE (NEW.status!='active' OR NEW.archived_at IS NOT NULL) AND EXISTS (SELECT 1 FROM material_request_reservations r WHERE r.material_id=OLD.id AND r.reserved_quantity>r.issued_quantity+r.released_quantity);
END;
