import test from "node:test";
import assert from "node:assert/strict";
import {readerDatabase,actor} from "./helpers/reader-database.mjs";
import {importLibrarikaCover} from "../lib/librarika-cover-import.ts";
test("cover import binds raster bytes to the verified source hash and replays in existing storage",async()=>{
 const db=readerDatabase(),objects=new Map();let puts=0;
 try{
  const bytes=Uint8Array.from([255,216,255,224,0,1,2,3]),sha256=Buffer.from(await crypto.subtle.digest("SHA-256",bytes)).toString("hex"),run="LRK-IMPORT-"+"a".repeat(24);
  db.sqlite.prepare("INSERT INTO library_import_runs(id,manifest_sha256,source_exported_at,state,expected_counts_json,recovery_sha256,actor_user_id,created_at) VALUES(?,?,'2026-09-06','verified','{}',?,'admin','2026-09-06')").run(run,"a".repeat(64),"b".repeat(64));
  db.sqlite.prepare("UPDATE library_editions SET import_run_id=?,public_metadata_json=? WHERE id='edition'").run(run,JSON.stringify({coverSha256:sha256}));
  const bucket={async head(key){return objects.get(key)||null;},async put(key,body,options){puts++;objects.set(key,options);}};
  const input={runId:run,sha256,mime:"image/jpeg",base64:Buffer.from(bytes).toString("base64")};
  assert.equal((await importLibrarikaCover(db,bucket,actor,input)).verified,true);assert.equal((await importLibrarikaCover(db,bucket,actor,input)).replayed,true);assert.equal(puts,1);
  for(const bad of [{...input,runId:"another"},{...input,sha256:"c".repeat(64)},{...input,mime:"image/png"},{...input,base64:Buffer.from([255,216,255,1]).toString("base64")}]){
   await assert.rejects(importLibrarikaCover(db,bucket,actor,bad));
  }
  assert.equal(puts,1);db.sqlite.exec("UPDATE users SET status='inactive' WHERE id='admin'");await assert.rejects(importLibrarikaCover(db,bucket,actor,input));
 }finally{db.sqlite.close();}
});
