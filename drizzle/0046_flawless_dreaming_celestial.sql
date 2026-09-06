CREATE TABLE `reader_auth_limits` (
	`scope_hash` text PRIMARY KEY NOT NULL,
	`window_start` text NOT NULL,
	`attempts` integer NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER reader_telegram_owner_insert BEFORE INSERT ON reader_telegram_connections WHEN NEW.status='active' BEGIN
  SELECT RAISE(ABORT,'telegram_reader_owner_conflict') WHERE EXISTS(SELECT 1 FROM telegram_connections WHERE telegram_user_id=NEW.telegram_user_id AND status='active');
END;
--> statement-breakpoint
CREATE TRIGGER reader_telegram_owner_update BEFORE UPDATE ON reader_telegram_connections WHEN NEW.status='active' BEGIN
  SELECT RAISE(ABORT,'telegram_reader_owner_conflict') WHERE EXISTS(SELECT 1 FROM telegram_connections WHERE telegram_user_id=NEW.telegram_user_id AND status='active');
END;
--> statement-breakpoint
CREATE TRIGGER staff_telegram_reader_insert BEFORE INSERT ON telegram_connections WHEN NEW.status='active' BEGIN
  SELECT RAISE(ABORT,'telegram_reader_owner_conflict') WHERE EXISTS(SELECT 1 FROM reader_telegram_connections WHERE telegram_user_id=NEW.telegram_user_id AND status='active');
END;
--> statement-breakpoint
CREATE TRIGGER staff_telegram_reader_update BEFORE UPDATE ON telegram_connections WHEN NEW.status='active' BEGIN
  SELECT RAISE(ABORT,'telegram_reader_owner_conflict') WHERE EXISTS(SELECT 1 FROM reader_telegram_connections WHERE telegram_user_id=NEW.telegram_user_id AND status='active');
END;
--> statement-breakpoint
CREATE TRIGGER reader_telegram_receipt_guard BEFORE INSERT ON reader_telegram_receipts BEGIN
  SELECT RAISE(ABORT,'telegram_cross_role_replay') WHERE EXISTS(SELECT 1 FROM telegram_mini_app_auth_receipts WHERE init_data_hash=NEW.init_data_hash);
END;
--> statement-breakpoint
CREATE TRIGGER staff_telegram_reader_receipt_guard BEFORE INSERT ON telegram_mini_app_auth_receipts BEGIN
  SELECT RAISE(ABORT,'telegram_cross_role_replay') WHERE EXISTS(SELECT 1 FROM reader_telegram_receipts WHERE init_data_hash=NEW.init_data_hash);
END;
--> statement-breakpoint
CREATE TRIGGER library_copy_movement_no_update BEFORE UPDATE ON library_copy_movements BEGIN SELECT RAISE(ABORT,'copy_movement_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER library_copy_movement_no_delete BEFORE DELETE ON library_copy_movements BEGIN SELECT RAISE(ABORT,'copy_movement_immutable'); END;
