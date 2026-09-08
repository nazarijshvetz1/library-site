import type {ReaderDatabase} from "./reader-core.ts";

export const READER_NOTIFICATION_AUTOMATION_STATE=Object.freeze({
  enabled:false,
  mode:"suspended_pending_verified_librarika_circulation_sync",
  source:"librarika",
  reason:"librarika_circulation_sync_unverified",
} as const);

export async function runReaderMaintenance(db:ReaderDatabase){
  const result=await db.batch([
    db.prepare(`UPDATE reader_notification_outbox
      SET status='cancelled',lease_token=NULL,lease_until=NULL,last_error=?
      WHERE status IN ('pending','processing')`).bind(READER_NOTIFICATION_AUTOMATION_STATE.reason),
  ]);
  return {...READER_NOTIFICATION_AUTOMATION_STATE,cancelled:Number(result[0]?.meta?.changes??0)};
}
