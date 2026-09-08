import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";

const repo=process.cwd();
const {readerDatabase}=await import(pathToFileURL(resolve(repo,"tests/helpers/reader-database.mjs")).href);
const notifications=await import(pathToFileURL(resolve(repo,"lib/reader-notifications.ts")).href);
const now="2026-09-08T08:00:00.000Z";

function fixture(){
  const db=readerDatabase();
  db.sqlite.prepare("INSERT INTO reader_profiles(reader_id,display_name,notify_loans,notify_books,updated_at) VALUES('reader-a','Учень',1,1,?)").run(now);
  db.sqlite.prepare("INSERT INTO reader_telegram_connections(telegram_user_id,reader_id,chat_id,status,linked_at) VALUES('100','reader-a','100','active',?)").run(now);
  db.sqlite.prepare("INSERT INTO reader_sessions(token_hash,reader_id,access_version,expires_at,created_at) VALUES(?,'reader-a',1,'2099-01-01T00:00:00.000Z',?)").run("a".repeat(64),now);
  for(const status of ["pending","processing","sent","failed","cancelled"]){
    db.sqlite.prepare(`INSERT INTO reader_notification_outbox
      (id,reader_id,edition_id,kind,due_date,status,next_attempt_at,lease_token,lease_until,created_at,last_error)
      VALUES(?, 'reader-a','edition','book_available',?,?,?,?,?,?,?)`).run(
        `notice-${status}`,now,status,now,status==="processing"?"lease":null,status==="processing"?"2099-01-01T00:00:00.000Z":null,now,status==="failed"?"historic_failure":null,
      );
  }
  return db;
}

function rows(db){return db.sqlite.prepare("SELECT id,status,lease_token,lease_until,last_error FROM reader_notification_outbox ORDER BY id").all().map(row=>({...row}));}

test("reader reminders remain suspended until verified Librarika circulation sync exists",async()=>{
  const db=fixture();
  try{
    const profile={...db.sqlite.prepare("SELECT * FROM reader_profiles WHERE reader_id='reader-a'").get()};
    const connection={...db.sqlite.prepare("SELECT * FROM reader_telegram_connections WHERE reader_id='reader-a'").get()};
    const session={...db.sqlite.prepare("SELECT * FROM reader_sessions WHERE reader_id='reader-a'").get()};
    const result=await notifications.runReaderMaintenance(db);
    assert.deepEqual({...notifications.READER_NOTIFICATION_AUTOMATION_STATE},{enabled:false,mode:"suspended_pending_verified_librarika_circulation_sync",source:"librarika",reason:"librarika_circulation_sync_unverified"});
    assert.equal(result.enabled,false);
    const byId=Object.fromEntries(rows(db).map(row=>[row.id,row]));
    for(const status of ["pending","processing"]){
      assert.equal(byId[`notice-${status}`].status,"cancelled");
      assert.equal(byId[`notice-${status}`].lease_token,null);
      assert.equal(byId[`notice-${status}`].lease_until,null);
      assert.equal(byId[`notice-${status}`].last_error,"librarika_circulation_sync_unverified");
    }
    assert.equal(byId["notice-sent"].status,"sent");
    assert.equal(byId["notice-failed"].status,"failed");
    assert.equal(byId["notice-failed"].last_error,"historic_failure");
    assert.equal(byId["notice-cancelled"].status,"cancelled");
    assert.deepEqual({...db.sqlite.prepare("SELECT * FROM reader_profiles WHERE reader_id='reader-a'").get()},profile);
    assert.deepEqual({...db.sqlite.prepare("SELECT * FROM reader_telegram_connections WHERE reader_id='reader-a'").get()},connection);
    assert.deepEqual({...db.sqlite.prepare("SELECT * FROM reader_sessions WHERE reader_id='reader-a'").get()},session);
    const afterFirst=rows(db);
    await notifications.runReaderMaintenance(db);
    assert.deepEqual(rows(db),afterFirst,"maintenance is idempotent");
  }finally{db.sqlite.close();}
});

test("suspended maintenance contains no local circulation, subscription, or Telegram delivery path",()=>{
  const source=fs.readFileSync("lib/reader-notifications.ts","utf8");
  assert.doesNotMatch(source,/reader_circulations|reader_book_subscriptions|telegramApiRequest|TELEGRAM_BOT_TOKEN/u);
  assert.match(source,/status IN \('pending','processing'\)/u);
});
