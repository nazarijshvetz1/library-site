CREATE TABLE `library_import_cover_receipts` (
	`import_run_id` text NOT NULL,
	`sha256` text NOT NULL,
	`object_key` text NOT NULL,
	`byte_length` integer NOT NULL,
	`mime_type` text NOT NULL,
	`verified_at` text NOT NULL,
	PRIMARY KEY(`import_run_id`, `sha256`),
	FOREIGN KEY (`import_run_id`) REFERENCES `library_import_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "library_import_cover_hash" CHECK(length("library_import_cover_receipts"."sha256")=64 and "library_import_cover_receipts"."sha256" not glob '*[^0-9a-f]*'),
	CONSTRAINT "library_import_cover_key" CHECK("library_import_cover_receipts"."object_key"='librarika-covers/' || "library_import_cover_receipts"."sha256"),
	CONSTRAINT "library_import_cover_bytes" CHECK("library_import_cover_receipts"."byte_length">0 and "library_import_cover_receipts"."byte_length"<=12582912),
	CONSTRAINT "library_import_cover_mime" CHECK("library_import_cover_receipts"."mime_type" in ('image/jpeg','image/png','image/webp'))
);
