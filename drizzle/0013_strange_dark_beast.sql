ALTER TABLE `visit_teacher_credentials`
ADD COLUMN `must_change_pin` integer NOT NULL DEFAULT 1
CHECK (`must_change_pin` in (0, 1));
