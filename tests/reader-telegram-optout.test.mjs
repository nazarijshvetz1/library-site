import assert from 'node:assert/strict';
import test from 'node:test';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const repo=process.cwd();
const sourceUrl=pathToFileURL(resolve(repo,'lib/telegram-notifications.ts')).href;
const {readerDatabase,publishReaderFixture}=await import(pathToFileURL(resolve(repo,'tests/helpers/reader-database.mjs')).href);
Object.assign(globalThis.__READER_TEST_ENV,{
  TELEGRAM_LINKING_ENABLED:'true',TELEGRAM_NOTIFICATIONS_ENABLED:'true',
  TELEGRAM_BOT_USERNAME:'LibraryTestBot',TELEGRAM_WEBHOOK_SECRET:'synthetic-test-webhook-secret',
  TELEGRAM_SITE_ORIGIN:'https://library.example.test',
});
const telegram=await import(sourceUrl);
const notifications=await import(pathToFileURL(resolve(repo,'lib/reader-notifications.ts')).href);

function fixture(teacher=true){
  const db=readerDatabase();publishReaderFixture(db);
  // Add D1 mutation metadata used by the existing Telegram receipt handler.
  const prepare=db.prepare.bind(db);
  db.prepare=sql=>{const wrap=statement=>({bind(...args){return wrap(statement.bind(...args));},first:()=>statement.first(),async all(){const result=await statement.all();return {...result,meta:{changes:Number(db.sqlite.prepare('SELECT changes() n').get().n)}};}});return wrap(prepare(sql));};
  const now='2026-09-06T08:00:00.000Z';
  db.sqlite.exec("UPDATE library_readers SET access_status='active';");
  for(const id of ['reader-a','reader-b'])db.sqlite.prepare(`INSERT INTO reader_profiles
    (reader_id,display_name,community_enabled,notify_loans,notify_books,notify_loans_since,notify_books_since,updated_at)
    VALUES(?,'Тестовий читач',1,1,1,'2026-09-06','2026-09-06T07:00:00.000Z',?)`).run(id,now);
  if(teacher){
    db.sqlite.prepare("INSERT INTO users(id,full_name,sort_name,role,status,created_at,updated_at) VALUES('teacher','Тестовий учитель','тестовий учитель','teacher','active',?,?)").run(now,now);
    db.sqlite.prepare("INSERT INTO teacher_profiles(teacher_user_id,created_at,updated_at) VALUES('teacher',?,?)").run(now,now);
    db.sqlite.exec("UPDATE library_readers SET kind='teacher',linked_teacher_user_id='teacher' WHERE id='reader-a'");
    db.sqlite.prepare("INSERT INTO telegram_connections(user_id,telegram_user_id,chat_id,status,notify_orders,notify_visits,linked_at,created_at,updated_at) VALUES('teacher','100','100','active',1,1,?,?,?)").run(now,now,now);
  }else db.sqlite.prepare("INSERT INTO reader_telegram_connections(telegram_user_id,reader_id,chat_id,linked_at) VALUES('100','reader-a','100',?)").run(now);
  db.sqlite.prepare("INSERT INTO reader_telegram_connections(telegram_user_id,reader_id,chat_id,linked_at) VALUES('200','reader-b','200',?)").run(now);
  for(const id of ['reader-a','reader-b']){
    db.sqlite.prepare("INSERT INTO reader_book_subscriptions(reader_id,edition_id,created_at) VALUES(?,'edition',?)").run(id,now);
    for(const status of ['pending','processing','sent','failed'])db.sqlite.prepare(`INSERT INTO reader_notification_outbox
      (id,reader_id,edition_id,kind,due_date,status,next_attempt_at,lease_token,lease_until,created_at)
      VALUES(?,?,'edition','book_available',?,?,?,?,?,?)`).run(id+'-'+status,id,now,status,now,status==='processing'?'old-lease':null,status==='processing'?'2099-01-01T00:00:00.000Z':null,now);
  }
  db.sqlite.prepare("INSERT INTO locations(id,name,type,status,created_at,updated_at) VALUES('loc','Тестова бібліотека','library','active',?,?)").run(now,now);
  db.sqlite.prepare("INSERT INTO holdings(material_id,location_id,condition,quantity,updated_at) VALUES('CAT-3000','loc','good',1,?)").run(now);
  db.sqlite.prepare("INSERT INTO library_copies(id,edition_id,accession_no,location_id,condition,registration,physical_state,created_at,updated_at) VALUES('copy','edition','test-copy','loc','good','registered','on_shelf',?,?)").run(now,now);
  return db;
}
function message(updateId,text){return {update_id:updateId,message:{text,chat:{id:100,type:'private'},from:{id:100}}};}
function callback(updateId,enabled){return {update_id:updateId,callback_query:{id:'synthetic-'+updateId,from:{id:100},data:'telegram-notifications:'+(enabled?'on':'off'),message:{message_id:1,chat:{id:100,type:'private'}}}};}
async function deliver(db,payload){return telegram.processTelegramWebhookUpdate(db,JSON.stringify(payload),payload,async()=>Response.json({ok:true,result:{message_id:1}}),'https://library.example.test');}
function profile(db,id='reader-a'){return {...db.sqlite.prepare('SELECT notify_loans,notify_books,notify_loans_since,notify_books_since,community_enabled,display_name,version FROM reader_profiles WHERE reader_id=?').get(id)};}
function queued(db,id='reader-a'){return db.sqlite.prepare('SELECT id,status,lease_token,lease_until FROM reader_notification_outbox WHERE reader_id=? ORDER BY id').all(id).map(row=>({...row}));}
function assertMuted(db,before,{clearConsent=true}={}){
  const after=profile(db);assert.equal(after.notify_loans,0);assert.equal(after.notify_books,0);
  if(clearConsent){assert.equal(after.notify_loans_since,null);assert.equal(after.notify_books_since,null);}
  assert.equal(after.community_enabled,before.community_enabled);assert.equal(after.display_name,before.display_name);assert.equal(after.version,before.version+1);
  for(const row of queued(db))assert.equal(row.status,row.id.endsWith('-pending')||row.id.endsWith('-processing')?'cancelled':row.id.endsWith('-sent')?'sent':'failed');
  for(const row of queued(db).filter(row=>row.status==='cancelled')){assert.equal(row.lease_token,null);assert.equal(row.lease_until,null);}
  assert.equal(db.sqlite.prepare("SELECT access_status FROM library_readers WHERE id='reader-a'").get().access_status,'active');
  assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
}

for(const trigger of ['stop','button'])test(`linked teacher ${trigger} mutes reader notices atomically, exact-owner only, replay safe`,async()=>{
  const db=fixture();try{const before=profile(db),other=profile(db,'reader-b'),otherQueue=queued(db,'reader-b');
    const payload=trigger==='stop'?message(101,'/stop'):callback(101,false);
    const first=await deliver(db,payload);assert.equal(first.outcome,'notifications_disabled');assert.equal(first.duplicate,false);
    assertMuted(db,before);assert.deepEqual(profile(db,'reader-b'),other);assert.deepEqual(queued(db,'reader-b'),otherQueue);
    assert.deepEqual({...db.sqlite.prepare("SELECT status,notify_orders,notify_visits FROM telegram_connections WHERE user_id='teacher'").get()},{status:'active',notify_orders:0,notify_visits:0});
    const stopped=profile(db),queue=queued(db);assert.equal((await deliver(db,payload)).duplicate,true);assert.deepEqual(profile(db),stopped);assert.deepEqual(queued(db),queue);
    for(const payload of [message(102,'/start'),callback(103,true)]){await deliver(db,payload);assert.deepEqual(profile(db),stopped,'legacy enable/start must not create reader consent');assert.deepEqual(queued(db),queue);}
    await notifications.runReaderMaintenance(db);assert.deepEqual(queued(db),queue,'later maintenance must not requeue opted-out reader');
  }finally{db.sqlite.close();}
});

test('legacy enable and /start preserve an existing independent reader opt-in exactly',async()=>{
  const db=fixture();try{const before=profile(db),queue=queued(db);for(const payload of [callback(201,true),message(202,'/start')]){await deliver(db,payload);assert.deepEqual(profile(db),before);assert.deepEqual(queued(db),queue);}}finally{db.sqlite.close();}
});

test('forged teacher callback cannot mute the linked reader with chat/user mismatch',async()=>{
  const db=fixture();try{const before=profile(db),queue=queued(db),payload=callback(301,false);payload.callback_query.from.id=200;await deliver(db,payload);assert.deepEqual(profile(db),before);assert.deepEqual(queued(db),queue);}finally{db.sqlite.close();}
});

test('direct student /stop already clears both notices and leases without disabling access',async()=>{
  const db=fixture(false);try{const before=profile(db),other=profile(db,'reader-b'),payload=message(401,'/stop');assert.equal((await deliver(db,payload)).outcome,'reader_stop');assertMuted(db,before,{clearConsent:false});assert.deepEqual(profile(db,'reader-b'),other);assert.equal(db.sqlite.prepare("SELECT status FROM reader_telegram_connections WHERE reader_id='reader-a'").get().status,'active');const stopped=profile(db);assert.equal((await deliver(db,payload)).duplicate,true);await deliver(db,message(402,'/start'));assert.deepEqual(profile(db),stopped);}finally{db.sqlite.close();}
});

test('reader cancellation failure rolls back the teacher opt-out, consent changes, and webhook receipt together',async()=>{
  const db=fixture();try{
    const before=profile(db),queue=queued(db),connection={...db.sqlite.prepare("SELECT * FROM telegram_connections WHERE user_id='teacher'").get()};
    db.sqlite.exec("CREATE TEMP TRIGGER synthetic_cancel_failure BEFORE UPDATE ON reader_notification_outbox WHEN NEW.reader_id='reader-a' AND NEW.status='cancelled' BEGIN SELECT RAISE(ABORT,'synthetic_cancel_failure'); END;");
    await assert.rejects(deliver(db,message(501,'/stop')),/synthetic_cancel_failure/);
    assert.deepEqual(profile(db),before);assert.deepEqual(queued(db),queue);assert.deepEqual({...db.sqlite.prepare("SELECT * FROM telegram_connections WHERE user_id='teacher'").get()},connection);assert.equal(db.sqlite.prepare("SELECT count(*) n FROM telegram_webhook_updates WHERE update_id='501'").get().n,0);
  }finally{db.sqlite.close();}
});
