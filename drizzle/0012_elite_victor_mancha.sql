ALTER TABLE `visit_bookings`
ADD COLUMN `public_display_consent` integer NOT NULL DEFAULT 0
CHECK (`public_display_consent` in (0, 1));
