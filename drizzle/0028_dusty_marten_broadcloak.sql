ALTER TABLE `class_loans` ADD `issue_statement_schema_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `class_loans` ADD `issue_statement_json` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `class_loans` ADD `issue_statement_origin` text DEFAULT 'legacy' NOT NULL
  CONSTRAINT "class_loans_issue_statement_valid" CHECK((`issue_statement_schema_version` = 0
      AND `issue_statement_json` = ''
      AND `issue_statement_origin` = 'legacy')
    OR (`issue_statement_schema_version` = 1
      AND json_valid(`issue_statement_json`)
      AND `issue_statement_origin` in ('issued', 'legacy_backfill')));--> statement-breakpoint
CREATE TRIGGER `class_loans_issue_statement_immutable`
BEFORE UPDATE OF `issue_statement_schema_version`, `issue_statement_json`, `issue_statement_origin`
ON `class_loans`
WHEN OLD.`issue_statement_schema_version` != NEW.`issue_statement_schema_version`
  OR OLD.`issue_statement_json` != NEW.`issue_statement_json`
  OR OLD.`issue_statement_origin` != NEW.`issue_statement_origin`
BEGIN
  SELECT RAISE(ABORT, 'class issue statement is immutable');
END;
