DROP TRIGGER IF EXISTS `trg_librarian_drafts_audit_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_librarian_drafts_audit_update`;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_librarian_draft_events_draft_revision`
ON `librarian_draft_events` (`draft_id`, `revision`);
--> statement-breakpoint
PRAGMA optimize;
