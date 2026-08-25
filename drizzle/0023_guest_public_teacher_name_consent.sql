ALTER TABLE `visit_bookings`
ADD COLUMN `public_teacher_name_consent` integer NOT NULL DEFAULT 0
CHECK (`public_teacher_name_consent` in (0, 1));
