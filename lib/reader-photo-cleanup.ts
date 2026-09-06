import type {ReaderDatabase} from "./reader-core.ts";
type PhotoBucket={delete(key:string):Promise<void>};
// Only unique, never-reused photo object keys are eligible; no catalog or other R2 assets.
export async function cleanReaderPhotos(db:ReaderDatabase,bucket:PhotoBucket,now=new Date().toISOString()){
  const rows=await db.prepare("SELECT key FROM reader_photo_cleanup WHERE not_before<=? ORDER BY not_before LIMIT 10").bind(now).all();
  for(const row of rows.results||[]){const key=String(row.key);if(!/^reader-photos\/[A-Za-z0-9_-]+\/[a-f0-9-]{36}\.jpg$/.test(key))continue;
    const used=await db.prepare("SELECT 1 ok FROM reader_profiles WHERE photo_key=?").bind(key).first();if(used)continue;
    try{await bucket.delete(key);await db.batch([db.prepare("DELETE FROM reader_photo_cleanup WHERE key=? AND NOT EXISTS(SELECT 1 FROM reader_profiles WHERE photo_key=?)").bind(key,key)]);}catch{/* Durable candidate is retried by subsequent profile mutations / scheduled maintenance. */}
  }
}
