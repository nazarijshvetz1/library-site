ALTER TABLE `reader_profiles` ADD `notify_loans_since` text CHECK(notify_loans_since IS NULL OR (length(notify_loans_since)=10 AND date(notify_loans_since)=notify_loans_since));--> statement-breakpoint
ALTER TABLE `reader_profiles` ADD `notify_books_since` text;
