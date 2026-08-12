CREATE TABLE `__new_visit_slot_claims` (
	`segment_key` text PRIMARY KEY NOT NULL,
	`booking_id` text,
	`closure_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`booking_id`) REFERENCES `visit_bookings`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`closure_id`) REFERENCES `visit_schedule_closures`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "visit_slot_claims_exactly_one_owner" CHECK(("__new_visit_slot_claims"."booking_id" is not null and "__new_visit_slot_claims"."closure_id" is null)
        or ("__new_visit_slot_claims"."booking_id" is null and "__new_visit_slot_claims"."closure_id" is not null)),
	CONSTRAINT "visit_slot_claims_key_valid" CHECK(length("__new_visit_slot_claims"."segment_key") = 16
        and substr("__new_visit_slot_claims"."segment_key", 1, 10) glob '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
        and substr("__new_visit_slot_claims"."segment_key", 11, 1) = 'T'
        and substr("__new_visit_slot_claims"."segment_key", 12, 5) glob '[0-9][0-9]:[0-5][0-9]'
        and date(substr("__new_visit_slot_claims"."segment_key", 1, 10), '+0 days') = substr("__new_visit_slot_claims"."segment_key", 1, 10)
        and cast(substr("__new_visit_slot_claims"."segment_key", 12, 2) as integer) between 0 and 23
        and cast(substr("__new_visit_slot_claims"."segment_key", 15, 2) as integer) % 5 = 0)
);
--> statement-breakpoint
INSERT INTO `__new_visit_slot_claims`("segment_key", "booking_id", "closure_id", "created_at") SELECT "segment_key", "booking_id", "closure_id", "created_at" FROM `visit_slot_claims`;--> statement-breakpoint
DROP TABLE `visit_slot_claims`;--> statement-breakpoint
ALTER TABLE `__new_visit_slot_claims` RENAME TO `visit_slot_claims`;--> statement-breakpoint
CREATE INDEX `idx_visit_slot_claims_booking` ON `visit_slot_claims` (`booking_id`);--> statement-breakpoint
CREATE INDEX `idx_visit_slot_claims_closure` ON `visit_slot_claims` (`closure_id`);
