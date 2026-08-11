CREATE TABLE `academic_years` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "academic_years_status_valid" CHECK("academic_years"."status" in ('draft', 'active', 'closed')),
	CONSTRAINT "academic_years_date_order" CHECK("academic_years"."start_date" < "academic_years"."end_date"),
	CONSTRAINT "academic_years_version_positive" CHECK("academic_years"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_academic_years_label` ON `academic_years` (`label`);--> statement-breakpoint
CREATE INDEX `idx_academic_years_status_start` ON `academic_years` (`status`,`start_date`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`actor_email` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`request_id` text,
	`before_json` text,
	`after_json` text,
	`metadata_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "audit_events_action_not_blank" CHECK(length(trim("audit_events"."action")) > 0),
	CONSTRAINT "audit_events_entity_type_not_blank" CHECK(length(trim("audit_events"."entity_type")) > 0),
	CONSTRAINT "audit_events_entity_id_not_blank" CHECK(length(trim("audit_events"."entity_id")) > 0),
	CONSTRAINT "audit_events_before_json_valid" CHECK("audit_events"."before_json" is null or json_valid("audit_events"."before_json")),
	CONSTRAINT "audit_events_after_json_valid" CHECK("audit_events"."after_json" is null or json_valid("audit_events"."after_json")),
	CONSTRAINT "audit_events_metadata_json_valid" CHECK("audit_events"."metadata_json" is null or json_valid("audit_events"."metadata_json"))
);
--> statement-breakpoint
CREATE INDEX `idx_audit_events_entity_created` ON `audit_events` (`entity_type`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_events_actor_created` ON `audit_events` (`actor_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_events_request` ON `audit_events` (`request_id`);--> statement-breakpoint
CREATE TABLE `class_years` (
	`id` text PRIMARY KEY NOT NULL,
	`academic_year_id` text NOT NULL,
	`cohort_id` text NOT NULL,
	`class_name` text NOT NULL,
	`grade` integer NOT NULL,
	`code` text NOT NULL,
	`teacher_user_id` text,
	`location_id` text,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`actual_closed_date` text,
	`notes` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`academic_year_id`) REFERENCES `academic_years`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`cohort_id`) REFERENCES `cohorts`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`teacher_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "class_years_name_not_blank" CHECK(length(trim("class_years"."class_name")) > 0),
	CONSTRAINT "class_years_grade_valid" CHECK("class_years"."grade" between 1 and 11),
	CONSTRAINT "class_years_code_not_blank" CHECK(length(trim("class_years"."code")) > 0),
	CONSTRAINT "class_years_date_order" CHECK("class_years"."start_date" < "class_years"."end_date"),
	CONSTRAINT "class_years_status_valid" CHECK("class_years"."status" in ('planned', 'active', 'closed')),
	CONSTRAINT "class_years_closed_date_consistent" CHECK(("class_years"."status" = 'closed' and "class_years"."actual_closed_date" is not null)
        or ("class_years"."status" != 'closed' and "class_years"."actual_closed_date" is null)),
	CONSTRAINT "class_years_version_positive" CHECK("class_years"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_class_years_year_cohort` ON `class_years` (`academic_year_id`,`cohort_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_class_years_year_name` ON `class_years` (`academic_year_id`,`class_name`);--> statement-breakpoint
CREATE INDEX `idx_class_years_year_status_name` ON `class_years` (`academic_year_id`,`status`,`class_name`);--> statement-breakpoint
CREATE INDEX `idx_class_years_teacher_status` ON `class_years` (`teacher_user_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_class_years_location_status` ON `class_years` (`location_id`,`status`);--> statement-breakpoint
CREATE TABLE `cohorts` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "cohorts_status_valid" CHECK("cohorts"."status" in ('active', 'graduated', 'closed'))
);
--> statement-breakpoint
CREATE INDEX `idx_cohorts_status_updated` ON `cohorts` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `holdings` (
	`material_id` text NOT NULL,
	`location_id` text NOT NULL,
	`condition` text DEFAULT 'unspecified' NOT NULL,
	`quantity` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`material_id`, `location_id`, `condition`),
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "holdings_condition_valid" CHECK("holdings"."condition" in ('unspecified', 'good', 'worn', 'damaged')),
	CONSTRAINT "holdings_quantity_positive" CHECK("holdings"."quantity" > 0),
	CONSTRAINT "holdings_version_positive" CHECK("holdings"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_holdings_location_material` ON `holdings` (`location_id`,`material_id`);--> statement-breakpoint
CREATE INDEX `idx_holdings_material_quantity` ON `holdings` (`material_id`,`quantity`);--> statement-breakpoint
CREATE TABLE `inventory_transaction_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`transaction_id` text NOT NULL,
	`material_id` text NOT NULL,
	`location_id` text NOT NULL,
	`condition` text DEFAULT 'unspecified' NOT NULL,
	`quantity_delta` integer NOT NULL,
	`quantity_before` integer NOT NULL,
	`quantity_after` integer NOT NULL,
	`counted_quantity` integer,
	`loan_item_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `inventory_transactions`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`loan_item_id`) REFERENCES `loan_items`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "inventory_lines_condition_valid" CHECK("inventory_transaction_lines"."condition" in ('unspecified', 'good', 'worn', 'damaged')),
	CONSTRAINT "inventory_lines_quantities_nonnegative" CHECK("inventory_transaction_lines"."quantity_before" >= 0 and "inventory_transaction_lines"."quantity_after" >= 0),
	CONSTRAINT "inventory_lines_delta_balanced" CHECK("inventory_transaction_lines"."quantity_after" = "inventory_transaction_lines"."quantity_before" + "inventory_transaction_lines"."quantity_delta"),
	CONSTRAINT "inventory_lines_zero_delta_is_count" CHECK("inventory_transaction_lines"."quantity_delta" != 0 or "inventory_transaction_lines"."counted_quantity" is not null),
	CONSTRAINT "inventory_lines_counted_quantity_valid" CHECK("inventory_transaction_lines"."counted_quantity" is null or (
        "inventory_transaction_lines"."counted_quantity" >= 0 and "inventory_transaction_lines"."counted_quantity" = "inventory_transaction_lines"."quantity_after"
      ))
);
--> statement-breakpoint
CREATE INDEX `idx_inventory_lines_transaction` ON `inventory_transaction_lines` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `idx_inventory_lines_material_transaction` ON `inventory_transaction_lines` (`material_id`,`transaction_id`);--> statement-breakpoint
CREATE INDEX `idx_inventory_lines_location_transaction` ON `inventory_transaction_lines` (`location_id`,`transaction_id`);--> statement-breakpoint
CREATE INDEX `idx_inventory_lines_loan_item` ON `inventory_transaction_lines` (`loan_item_id`);--> statement-breakpoint
CREATE TABLE `inventory_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`kind` text NOT NULL,
	`occurred_at` text NOT NULL,
	`document_number` text,
	`reason` text,
	`notes` text DEFAULT '' NOT NULL,
	`loan_id` text,
	`actor_user_id` text NOT NULL,
	`reversal_of_id` text,
	`status` text DEFAULT 'posted' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`loan_id`) REFERENCES `loans`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`reversal_of_id`) REFERENCES `inventory_transactions`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "inventory_transactions_kind_valid" CHECK("inventory_transactions"."kind" in ('receipt', 'transfer', 'writeoff', 'stock_count', 'loan_issue', 'loan_return', 'reversal', 'import')),
	CONSTRAINT "inventory_transactions_status_valid" CHECK("inventory_transactions"."status" in ('posted', 'reversed')),
	CONSTRAINT "inventory_transactions_reversal_consistent" CHECK(("inventory_transactions"."kind" = 'reversal' and "inventory_transactions"."reversal_of_id" is not null)
        or ("inventory_transactions"."kind" != 'reversal' and "inventory_transactions"."reversal_of_id" is null)),
	CONSTRAINT "inventory_transactions_loan_consistent" CHECK("inventory_transactions"."kind" not in ('loan_issue', 'loan_return') or "inventory_transactions"."loan_id" is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_inventory_transactions_request_id` ON `inventory_transactions` (`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_inventory_transactions_reversal_of` ON `inventory_transactions` (`reversal_of_id`);--> statement-breakpoint
CREATE INDEX `idx_inventory_transactions_kind_occurred` ON `inventory_transactions` (`kind`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_inventory_transactions_loan_occurred` ON `inventory_transactions` (`loan_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_inventory_transactions_actor_occurred` ON `inventory_transactions` (`actor_user_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `loan_items` (
	`id` text PRIMARY KEY NOT NULL,
	`loan_id` text NOT NULL,
	`material_id` text NOT NULL,
	`source_location_id` text NOT NULL,
	`condition` text DEFAULT 'unspecified' NOT NULL,
	`quantity_issued` integer NOT NULL,
	`quantity_returned` integer DEFAULT 0 NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`loan_id`) REFERENCES `loans`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`source_location_id`) REFERENCES `locations`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "loan_items_condition_valid" CHECK("loan_items"."condition" in ('unspecified', 'good', 'worn', 'damaged')),
	CONSTRAINT "loan_items_quantity_issued_positive" CHECK("loan_items"."quantity_issued" > 0),
	CONSTRAINT "loan_items_quantity_returned_valid" CHECK("loan_items"."quantity_returned" >= 0 and "loan_items"."quantity_returned" <= "loan_items"."quantity_issued")
);
--> statement-breakpoint
CREATE INDEX `idx_loan_items_loan_material` ON `loan_items` (`loan_id`,`material_id`);--> statement-breakpoint
CREATE INDEX `idx_loan_items_material_loan` ON `loan_items` (`material_id`,`loan_id`);--> statement-breakpoint
CREATE TABLE `loans` (
	`id` text PRIMARY KEY NOT NULL,
	`teacher_user_id` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`issued_at` text NOT NULL,
	`due_at` text,
	`closed_at` text,
	`notes` text DEFAULT '' NOT NULL,
	`issued_by_user_id` text NOT NULL,
	`closed_by_user_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`teacher_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`issued_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`closed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "loans_status_valid" CHECK("loans"."status" in ('open', 'closed', 'cancelled')),
	CONSTRAINT "loans_due_after_issue" CHECK("loans"."due_at" is null or "loans"."due_at" >= "loans"."issued_at"),
	CONSTRAINT "loans_closed_fields_consistent" CHECK(("loans"."status" = 'closed' and "loans"."closed_at" is not null and "loans"."closed_by_user_id" is not null)
        or ("loans"."status" != 'closed' and "loans"."closed_at" is null and "loans"."closed_by_user_id" is null)),
	CONSTRAINT "loans_version_positive" CHECK("loans"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_loans_teacher_status_due` ON `loans` (`teacher_user_id`,`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `idx_loans_status_due` ON `loans` (`status`,`due_at`);--> statement-breakpoint
CREATE TABLE `locations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'other' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`is_public` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "locations_name_not_blank" CHECK(length(trim("locations"."name")) > 0),
	CONSTRAINT "locations_type_valid" CHECK("locations"."type" in ('library', 'classroom', 'office', 'other', 'service')),
	CONSTRAINT "locations_status_valid" CHECK("locations"."status" in ('active', 'inactive')),
	CONSTRAINT "locations_sort_order_nonnegative" CHECK("locations"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_locations_name` ON `locations` (`name`);--> statement-breakpoint
CREATE INDEX `idx_locations_directory` ON `locations` (`status`,`type`,`sort_order`,`name`);--> statement-breakpoint
CREATE TABLE `material_cover_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`material_id` text NOT NULL,
	`storage_provider` text NOT NULL,
	`storage_key` text,
	`external_url` text,
	`mime_type` text,
	`byte_length` integer,
	`width` integer,
	`height` integer,
	`sha256` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "material_cover_assets_provider_valid" CHECK("material_cover_assets"."storage_provider" in ('r2', 'external')),
	CONSTRAINT "material_cover_assets_location_valid" CHECK((
        "material_cover_assets"."storage_provider" = 'r2'
        and "material_cover_assets"."storage_key" is not null
        and length(trim("material_cover_assets"."storage_key")) > 0
      ) or (
        "material_cover_assets"."storage_provider" = 'external'
        and ("material_cover_assets"."external_url" glob 'https://*' or "material_cover_assets"."external_url" glob 'http://*')
      )),
	CONSTRAINT "material_cover_assets_status_valid" CHECK("material_cover_assets"."status" in ('pending', 'ready', 'failed', 'archived')),
	CONSTRAINT "material_cover_assets_dimensions_valid" CHECK(("material_cover_assets"."width" is null or "material_cover_assets"."width" > 0)
        and ("material_cover_assets"."height" is null or "material_cover_assets"."height" > 0)
        and ("material_cover_assets"."byte_length" is null or "material_cover_assets"."byte_length" >= 0)),
	CONSTRAINT "material_cover_assets_sha256_valid" CHECK("material_cover_assets"."sha256" is null or (
        length("material_cover_assets"."sha256") = 64
        and lower("material_cover_assets"."sha256") not glob '*[^0-9a-f]*'
      )),
	CONSTRAINT "material_cover_assets_version_positive" CHECK("material_cover_assets"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_material_cover_assets_material` ON `material_cover_assets` (`material_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_material_cover_assets_storage_key` ON `material_cover_assets` (`storage_key`);--> statement-breakpoint
CREATE INDEX `idx_material_cover_assets_status_updated` ON `material_cover_assets` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `material_links` (
	`id` text PRIMARY KEY NOT NULL,
	`material_id` text NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`label` text NOT NULL,
	`url` text NOT NULL,
	`is_public` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "material_links_label_not_blank" CHECK(length(trim("material_links"."label")) > 0),
	CONSTRAINT "material_links_http_url" CHECK("material_links"."url" glob 'https://*' or "material_links"."url" glob 'http://*'),
	CONSTRAINT "material_links_kind_valid" CHECK("material_links"."kind" in ('ebook', 'details', 'publisher', 'store', 'preview', 'other')),
	CONSTRAINT "material_links_status_valid" CHECK("material_links"."status" in ('active', 'broken', 'archived')),
	CONSTRAINT "material_links_sort_order_nonnegative" CHECK("material_links"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_material_links_material_url` ON `material_links` (`material_id`,`url`);--> statement-breakpoint
CREATE INDEX `idx_material_links_public_listing` ON `material_links` (`material_id`,`is_public`,`status`,`sort_order`);--> statement-breakpoint
CREATE TABLE `material_stock_totals` (
	`material_id` text PRIMARY KEY NOT NULL,
	`total_quantity` integer DEFAULT 0 NOT NULL,
	`library_quantity` integer DEFAULT 0 NOT NULL,
	`other_location_quantity` integer DEFAULT 0 NOT NULL,
	`loaned_quantity` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "material_stock_totals_nonnegative" CHECK("material_stock_totals"."total_quantity" >= 0
        and "material_stock_totals"."library_quantity" >= 0
        and "material_stock_totals"."other_location_quantity" >= 0
        and "material_stock_totals"."loaned_quantity" >= 0),
	CONSTRAINT "material_stock_totals_balanced" CHECK("material_stock_totals"."total_quantity" = "material_stock_totals"."library_quantity"
        + "material_stock_totals"."other_location_quantity"
        + "material_stock_totals"."loaned_quantity")
);
--> statement-breakpoint
CREATE INDEX `idx_material_stock_totals_available` ON `material_stock_totals` (`total_quantity`,`loaned_quantity`,`material_id`);--> statement-breakpoint
CREATE TABLE `materials` (
	`id` text PRIMARY KEY NOT NULL,
	`catalog_number` integer NOT NULL,
	`title` text NOT NULL,
	`sort_title` text NOT NULL,
	`search_text` text DEFAULT '' NOT NULL,
	`rubric` text DEFAULT '' NOT NULL,
	`publication_type` text DEFAULT '' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`class_from` integer,
	`class_to` integer,
	`author` text DEFAULT '' NOT NULL,
	`publication_year` integer,
	`isbn` text DEFAULT '' NOT NULL,
	`isbn_normalized` text DEFAULT '' NOT NULL,
	`publisher` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text,
	CONSTRAINT "materials_id_format" CHECK("materials"."id" glob 'CAT-[0-9][0-9][0-9][0-9]*' and substr("materials"."id", 5) not glob '*[^0-9]*'),
	CONSTRAINT "materials_catalog_number_positive" CHECK("materials"."catalog_number" > 0),
	CONSTRAINT "materials_title_not_blank" CHECK(length(trim("materials"."title")) > 0),
	CONSTRAINT "materials_sort_title_not_blank" CHECK(length(trim("materials"."sort_title")) > 0),
	CONSTRAINT "materials_status_valid" CHECK("materials"."status" in ('active', 'archived')),
	CONSTRAINT "materials_class_range_valid" CHECK((
        "materials"."class_from" is null and "materials"."class_to" is null
      ) or (
        "materials"."class_from" between 1 and 11
        and "materials"."class_to" between 1 and 11
        and "materials"."class_from" <= "materials"."class_to"
      )),
	CONSTRAINT "materials_publication_year_valid" CHECK("materials"."publication_year" is null or "materials"."publication_year" between 1000 and 3000),
	CONSTRAINT "materials_version_positive" CHECK("materials"."version" > 0),
	CONSTRAINT "materials_archived_at_consistent" CHECK("materials"."status" != 'active' or "materials"."archived_at" is null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_materials_catalog_number` ON `materials` (`catalog_number`);--> statement-breakpoint
CREATE INDEX `idx_materials_status_sort_title_id` ON `materials` (`status`,`sort_title`,`id`);--> statement-breakpoint
CREATE INDEX `idx_materials_status_catalog_number` ON `materials` (`status`,`catalog_number`);--> statement-breakpoint
CREATE INDEX `idx_materials_rubric_status_sort` ON `materials` (`rubric`,`status`,`sort_title`);--> statement-breakpoint
CREATE INDEX `idx_materials_subject_status_sort` ON `materials` (`subject`,`status`,`sort_title`);--> statement-breakpoint
CREATE INDEX `idx_materials_type_status_sort` ON `materials` (`publication_type`,`status`,`sort_title`);--> statement-breakpoint
CREATE INDEX `idx_materials_class_range` ON `materials` (`class_from`,`class_to`);--> statement-breakpoint
CREATE INDEX `idx_materials_isbn_normalized` ON `materials` (`isbn_normalized`);--> statement-breakpoint
CREATE TABLE `mutation_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_id` text,
	`kind` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`target_type` text,
	`target_id` text,
	`request_hash` text NOT NULL,
	`result_json` text,
	`error_code` text,
	`error_message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`draft_id`) REFERENCES `librarian_drafts`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "mutation_commands_kind_not_blank" CHECK(length(trim("mutation_commands"."kind")) > 0),
	CONSTRAINT "mutation_commands_status_valid" CHECK("mutation_commands"."status" in ('processing', 'completed', 'failed')),
	CONSTRAINT "mutation_commands_request_hash_valid" CHECK(length("mutation_commands"."request_hash") = 64 and lower("mutation_commands"."request_hash") not glob '*[^0-9a-f]*'),
	CONSTRAINT "mutation_commands_result_json_valid" CHECK("mutation_commands"."result_json" is null or json_valid("mutation_commands"."result_json")),
	CONSTRAINT "mutation_commands_completion_consistent" CHECK(("mutation_commands"."status" = 'processing' and "mutation_commands"."completed_at" is null)
        or ("mutation_commands"."status" in ('completed', 'failed') and "mutation_commands"."completed_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_mutation_commands_draft` ON `mutation_commands` (`draft_id`);--> statement-breakpoint
CREATE INDEX `idx_mutation_commands_status_updated` ON `mutation_commands` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_mutation_commands_actor_created` ON `mutation_commands` (`actor_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_mutation_commands_target` ON `mutation_commands` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`full_name` text NOT NULL,
	`sort_name` text NOT NULL,
	`email` text,
	`auth_user_id` text,
	`role` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "users_full_name_not_blank" CHECK(length(trim("users"."full_name")) > 0),
	CONSTRAINT "users_sort_name_not_blank" CHECK(length(trim("users"."sort_name")) > 0),
	CONSTRAINT "users_role_valid" CHECK("users"."role" in ('admin', 'librarian', 'teacher')),
	CONSTRAINT "users_status_valid" CHECK("users"."status" in ('active', 'inactive'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_email` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_auth_user_id` ON `users` (`auth_user_id`);--> statement-breakpoint
CREATE INDEX `idx_users_role_status_name` ON `users` (`role`,`status`,`sort_name`);--> statement-breakpoint
CREATE VIRTUAL TABLE `materials_fts` USING fts5(
	`title`,
	`author`,
	`isbn_normalized`,
	`publisher`,
	`rubric`,
	`subject`,
	`publication_type`,
	`search_text`,
	content='materials',
	content_rowid='rowid',
	tokenize='unicode61 remove_diacritics 2'
);--> statement-breakpoint
CREATE TRIGGER `materials_fts_after_insert` AFTER INSERT ON `materials` BEGIN
	INSERT INTO `materials_fts`(
		rowid, title, author, isbn_normalized, publisher, rubric, subject, publication_type, search_text
	) VALUES (
		new.rowid, new.title, new.author, new.isbn_normalized, new.publisher,
		new.rubric, new.subject, new.publication_type, new.search_text
	);
END;--> statement-breakpoint
CREATE TRIGGER `materials_fts_after_delete` AFTER DELETE ON `materials` BEGIN
	INSERT INTO `materials_fts`(
		materials_fts, rowid, title, author, isbn_normalized, publisher, rubric, subject, publication_type, search_text
	) VALUES (
		'delete', old.rowid, old.title, old.author, old.isbn_normalized, old.publisher,
		old.rubric, old.subject, old.publication_type, old.search_text
	);
END;--> statement-breakpoint
CREATE TRIGGER `materials_fts_after_update` AFTER UPDATE ON `materials` BEGIN
	INSERT INTO `materials_fts`(
		materials_fts, rowid, title, author, isbn_normalized, publisher, rubric, subject, publication_type, search_text
	) VALUES (
		'delete', old.rowid, old.title, old.author, old.isbn_normalized, old.publisher,
		old.rubric, old.subject, old.publication_type, old.search_text
	);
	INSERT INTO `materials_fts`(
		rowid, title, author, isbn_normalized, publisher, rubric, subject, publication_type, search_text
	) VALUES (
		new.rowid, new.title, new.author, new.isbn_normalized, new.publisher,
		new.rubric, new.subject, new.publication_type, new.search_text
	);
END;--> statement-breakpoint
PRAGMA optimize;
