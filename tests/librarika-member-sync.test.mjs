import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {actor,confirmLibrarikaBaseline,readerDatabase} from "./helpers/reader-database.mjs";
import {
  applyLibrarikaMemberSync,
  expireTemporaryLibrarikaMemberSyncRows,
  previewLibrarikaMemberSync,
  stageLibrarikaMemberSync,
  startLibrarikaMemberSync,
} from "../lib/librarika-member-sync.ts";
import {saveLibraryReader} from "../lib/library-reader-admin.ts";
import {canonicalLibrarikaMemberDataset,normalizeLibrarikaMember,projectLibrarikaMemberRows} from "../lib/librarika-member-format.ts";
import {isDailyMemberSyncCleanupTick,isFiveMinuteTick,scheduledInstant} from "../lib/worker-schedule.ts";

const member=(id,number,name,group="7-А",status="Active")=>({
  Id:String(id),
  "Member No":String(number),
  Name:name,
  "Member Group":group,
  Status:status,
});

async function previewRows(db,rows,marker){
  void marker;
  const {sourceSha256}=await canonicalLibrarikaMemberDataset(rows),requestId=crypto.randomUUID();
  const started=await startLibrarikaMemberSync(db,actor,{requestId,sourceSha256,expectedRows:rows.length});
  await stageLibrarikaMemberSync(db,actor,{runId:started.runId,sourceSha256,partIndex:0,rows});
  const result=await previewLibrarikaMemberSync(db,actor,{runId:started.runId,sourceSha256});
  return {runId:started.runId,sourceSha256,preview:result.preview};
}

async function applyPreview(db,run){
  return applyLibrarikaMemberSync(db,actor,{...run,confirmation:"APPLY_MEMBERS_WITHOUT_DELETIONS",fullBaselineConfirmation:"THIS_IS_FULL_MEMBERS_EXPORT"});
}

test("Members rows are reduced to an allowlist before upload and legacy safe numbers remain valid",async()=>{
  const raw={...member(77,"B-19","Безпечний Читач"),Email:"private@example.test",Phone:"+380000000000",Address:"Secret"};
  const projected=projectLibrarikaMemberRows([raw]);
  assert.deepEqual(projected,[member(77,"B-19","Безпечний Читач")]);
  const normalized=await normalizeLibrarikaMember(projected[0]);
  assert.equal(normalized.memberNo,"B-19");
  assert.deepEqual(Object.keys(JSON.parse(normalized.sourceJson)),["Id","Member No","Name","Member Group","Status"]);
  for(const bad of ["=1+1","+123","-123","@cmd","B 19","B/19"])await assert.rejects(normalizeLibrarikaMember(member(78,bad,"Небезпечний Читач")));
  await assert.rejects(normalizeLibrarikaMember(member(79,"B-20","Пошкоджений \uFFFD Читач")));
});

test("Members CSV adds a new pupil with a linked exact number and never deletes absent local readers",async()=>{
  const db=readerDatabase();
  try{
    const run=await previewRows(db,[member(101,26001001,"Нова Учениця")],"a");
    assert.deepEqual({...run.preview,changeRows:undefined},{total:1,added:1,matched:0,changed:0,unchanged:0,conflicts:0,missingFromExport:0,nameChanges:0,groupChanges:0,sourceStatusChanges:0,changeRows:undefined});
    assert.deepEqual(run.preview.changeRows.map(row=>({decision:row.decision,source_member_id:row.source_member_id,new_full_name:row.new_full_name})),[{decision:"add",source_member_id:"101",new_full_name:"Нова Учениця"}]);
    const applied=await applyPreview(db,run);
    assert.equal(applied.replayed,false);
    const imported=db.sqlite.prepare("SELECT source_member_id,member_no,full_name,kind,status,access_status FROM library_readers WHERE id='LRK-RD-101'").get();
    assert.deepEqual({...imported},{source_member_id:"101",member_no:"26001001",full_name:"Нова Учениця",kind:"student",status:"active",access_status:"inactive"});
    assert.deepEqual({...db.sqlite.prepare("SELECT member_no,external_member_id,state FROM reader_platform_links WHERE reader_id='LRK-RD-101'").get()},{member_no:"26001001",external_member_id:"101",state:"linked"});
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM library_readers WHERE id IN ('reader-a','reader-b')").get().n,2);
    const replay=await applyPreview(db,run);
    assert.equal(replay.replayed,true);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM library_readers WHERE source_member_id='101'").get().n,1);
  }finally{db.sqlite.close();}
});

test("an automatically numbered local pupil links to the same Librarika member without duplication",async()=>{
  const db=readerDatabase();
  try{
    confirmLibrarikaBaseline(db);
    const created=await saveLibraryReader(db,actor,{requestId:crypto.randomUUID(),fullName:"Учень Для Зв’язування",kind:"student",classYearId:null});
    const number=db.sqlite.prepare("SELECT member_no FROM library_readers WHERE id=?").get(created.id).member_no;
    const run=await previewRows(db,[member(202,number,"Учень Для Зв’язування")],"b");
    assert.equal(run.preview.added,0);
    assert.equal(run.preview.matched,1);
    assert.equal(run.preview.changed,1);
    await applyPreview(db,run);
    assert.equal(db.sqlite.prepare("SELECT source_member_id FROM library_readers WHERE id=?").get(created.id).source_member_id,"202");
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM library_readers WHERE member_no=?").get(number).n,1);
    assert.deepEqual({...db.sqlite.prepare("SELECT external_member_id,state FROM reader_platform_links WHERE reader_id=?").get(created.id)},{external_member_id:"202",state:"linked"});
  }finally{db.sqlite.close();}
});

test("conflicting identities stay untouched while independent safe rows apply",async()=>{
  const db=readerDatabase();
  try{
    db.sqlite.prepare("UPDATE library_readers SET source_member_id='301' WHERE id='reader-a'").run();
    db.sqlite.prepare("UPDATE library_readers SET member_no='200' WHERE id='reader-b'").run();
    const run=await previewRows(db,[member(301,200,"Конфліктний Читач"),member(302,26003002,"Безпечний Читач")],"c");
    assert.equal(run.preview.conflicts,1);
    assert.match(run.preview.changeRows.find(row=>row.decision==="conflict").conflict_reason,/іншим читацьким номером/u);
    assert.equal(run.preview.added,1);
    await applyPreview(db,run);
    assert.deepEqual({...db.sqlite.prepare("SELECT member_no,full_name FROM library_readers WHERE id='reader-a'").get()},{member_no:"reader-a",full_name:"Читач reader-a"});
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM reader_platform_links WHERE external_member_id='301'").get().n,0);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM library_readers WHERE source_member_id='302'").get().n,1);
  }finally{db.sqlite.close();}
});

test("the same full CSV can be previewed again after a conflict is corrected",async()=>{
  const db=readerDatabase();
  try{
    const rows=[member(351,"reader-a","Виправлений Читач"),member(352,26000352,"Безпечний Читач")];
    const first=await previewRows(db,rows,"conflict-first");
    assert.equal(first.preview.conflicts,1);
    assert.equal(first.preview.added,1);
    await applyPreview(db,first);
    const normalized=await normalizeLibrarikaMember(rows[0]);
    db.sqlite.prepare("UPDATE library_readers SET full_name=?,sort_name=?,version=version+1 WHERE id='reader-a'").run(normalized.fullName,normalized.sortName);
    const second=await previewRows(db,rows,"conflict-retry");
    assert.notEqual(second.runId,first.runId);
    assert.equal(second.preview.conflicts,0);
    assert.equal(second.preview.changed,1);
    assert.equal(second.preview.unchanged,1);
    await applyPreview(db,second);
    assert.equal(db.sqlite.prepare("SELECT source_member_id FROM library_readers WHERE id='reader-a'").get().source_member_id,"351");
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM library_readers WHERE source_member_id='352'").get().n,1);
  }finally{db.sqlite.close();}
});

test("staged chunks are idempotent and changed retries are rejected",async()=>{
  const db=readerDatabase();
  try{
    const rows=[member(401,26004001,"Повторюваний Читач")],{sourceSha256}=await canonicalLibrarikaMemberDataset(rows);
    const started=await startLibrarikaMemberSync(db,actor,{requestId:crypto.randomUUID(),sourceSha256,expectedRows:1});
    const first=await stageLibrarikaMemberSync(db,actor,{runId:started.runId,sourceSha256,partIndex:0,rows});
    const replay=await stageLibrarikaMemberSync(db,actor,{runId:started.runId,sourceSha256,partIndex:0,rows});
    assert.equal(first.replayed,false);
    assert.equal(replay.replayed,true);
    await assert.rejects(
      stageLibrarikaMemberSync(db,actor,{runId:started.runId,sourceSha256,partIndex:0,rows:[member(401,26004001,"Інше Ім’я")]}),
      error=>error?.code==="sync_part_conflict",
    );
  }finally{db.sqlite.close();}
});

test("a number-only match with a different normalized name is a conflict, not an identity takeover",async()=>{
  const db=readerDatabase();
  try{
    const run=await previewRows(db,[member(501,"reader-a","Зовсім Інша Людина")],"e");
    assert.equal(run.preview.conflicts,1);
    assert.equal(run.preview.matched,0);
    await applyPreview(db,run);
    assert.deepEqual({...db.sqlite.prepare("SELECT source_member_id,full_name FROM library_readers WHERE id='reader-a'").get()},{source_member_id:null,full_name:"Читач reader-a"});
  }finally{db.sqlite.close();}
});

test("apply aborts when a previewed reader changes and never creates a duplicate",async()=>{
  const db=readerDatabase();
  try{
    confirmLibrarikaBaseline(db);
    const created=await saveLibraryReader(db,actor,{requestId:crypto.randomUUID(),fullName:"Учень Перед Зміною",kind:"student",classYearId:null});
    const rows=[member(601,created.memberNo,"Учень Перед Зміною")];
    const run=await previewRows(db,rows,"f");
    db.sqlite.prepare("UPDATE library_readers SET version=version+1 WHERE id=?").run(created.id);
    await assert.rejects(applyPreview(db,run),error=>error?.code==="sync_apply_changed");
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM library_readers WHERE source_member_id='601'").get().n,0);
    assert.equal(db.sqlite.prepare("SELECT state FROM librarika_member_sync_runs WHERE id=?").get(run.runId).state,"failed");
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM librarika_member_sync_rows WHERE run_id=?").get(run.runId).n,0);
    const retried=await previewRows(db,rows,"f-retry");
    assert.notEqual(retried.runId,run.runId);
    assert.equal(retried.preview.changed,1);
    await applyPreview(db,retried);
    assert.equal(db.sqlite.prepare("SELECT source_member_id FROM library_readers WHERE id=?").get(created.id).source_member_id,"601");
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM library_readers WHERE member_no=?").get(created.memberNo).n,1);
  }finally{db.sqlite.close();}
});

test("a late CSV part cannot enter a frozen preview",async()=>{
  const db=readerDatabase();
  try{
    const rows=[member(701,27000701,"Перший Читач")],{sourceSha256}=await canonicalLibrarikaMemberDataset(rows);
    const started=await startLibrarikaMemberSync(db,actor,{requestId:crypto.randomUUID(),sourceSha256,expectedRows:1});
    await stageLibrarikaMemberSync(db,actor,{runId:started.runId,sourceSha256,partIndex:0,rows});
    await previewLibrarikaMemberSync(db,actor,{runId:started.runId,sourceSha256});
    await assert.rejects(stageLibrarikaMemberSync(db,actor,{runId:started.runId,sourceSha256,partIndex:1,rows:[member(702,27000702,"Пізній Читач")]}));
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM librarika_member_sync_rows WHERE run_id=?").get(started.runId).n,1);
  }finally{db.sqlite.close();}
});

test("Librarika source status is recorded without disabling an existing local cabinet",async()=>{
  const db=readerDatabase();
  try{
    const initial=await previewRows(db,[member(801,28000801,"Активний Читач")],"g");await applyPreview(db,initial);
    const next=await previewRows(db,[member(801,28000801,"Активний Читач","7-А","Inactive")],"h");
    await applyPreview(db,next);
    const row=db.sqlite.prepare("SELECT status,source_json FROM library_readers WHERE source_member_id='801'").get();
    assert.equal(row.status,"active");
    assert.equal(JSON.parse(row.source_json).Status,"Inactive");
  }finally{db.sqlite.close();}
});

test("an imported number in the generated range advances the atomic allocator",async()=>{
  const db=readerDatabase();
  try{
    const run=await previewRows(db,[member(901,26000001,"Імпортований Учень")],"i");await applyPreview(db,run);
    const created=await saveLibraryReader(db,actor,{requestId:crypto.randomUUID(),fullName:"Наступний Учень",kind:"student",classYearId:null});
    assert.equal(created.memberNo,"26000002");
  }finally{db.sqlite.close();}
});

test("ordinary profile edits preserve an in-progress external-link lease",async()=>{
  const db=readerDatabase();
  try{
    confirmLibrarikaBaseline(db);
    const created=await saveLibraryReader(db,actor,{requestId:crypto.randomUUID(),fullName:"Учень В Черзі",kind:"student",classYearId:null});
    db.sqlite.prepare("UPDATE reader_platform_links SET state='processing',lease_token='lease',lease_until='2099-01-01T00:00:00.000Z' WHERE reader_id=?").run(created.id);
    await saveLibraryReader(db,actor,{requestId:crypto.randomUUID(),id:created.id,expectedVersion:1,fullName:"Учень В Черзі Оновлений",memberNo:created.memberNo,kind:"student",classYearId:null});
    assert.deepEqual({...db.sqlite.prepare("SELECT state,lease_token,lease_until FROM reader_platform_links WHERE reader_id=?").get(created.id)},{state:"processing",lease_token:"lease",lease_until:"2099-01-01T00:00:00.000Z"});
  }finally{db.sqlite.close();}
});

test("member sync settles a processing platform link and clears its lease",async()=>{
  const db=readerDatabase();
  try{
    confirmLibrarikaBaseline(db);
    const created=await saveLibraryReader(db,actor,{requestId:crypto.randomUUID(),fullName:"Учень Із Черги",kind:"student",classYearId:null});
    db.sqlite.prepare("UPDATE reader_platform_links SET state='processing',lease_token='lease',lease_until='2099-01-01T00:00:00.000Z' WHERE reader_id=?").run(created.id);
    const run=await previewRows(db,[member(1001,created.memberNo,"Учень Із Черги")],"processing");
    await applyPreview(db,run);
    assert.deepEqual(
      {...db.sqlite.prepare("SELECT state,external_member_id,lease_token,lease_until FROM reader_platform_links WHERE reader_id=?").get(created.id)},
      {state:"linked",external_member_id:"1001",lease_token:null,lease_until:null},
    );
  }finally{db.sqlite.close();}
});

test("scheduled cleanup purges stale personal-data staging without touching applied syncs",async()=>{
  const db=readerDatabase();
  try{
    const uploadingRows=[member(1101,26001101,"Тимчасовий Читач")],uploadingHash=(await canonicalLibrarikaMemberDataset(uploadingRows)).sourceSha256;
    const uploading=await startLibrarikaMemberSync(db,actor,{requestId:crypto.randomUUID(),sourceSha256:uploadingHash,expectedRows:1});
    await stageLibrarikaMemberSync(db,actor,{runId:uploading.runId,sourceSha256:uploadingHash,partIndex:0,rows:uploadingRows});
    const previewed=await previewRows(db,[member(1102,26001102,"Переглянутий Читач")],"cleanup-preview");
    const applied=await previewRows(db,[member(1103,26001103,"Збережений Читач")],"cleanup-applied");
    await applyPreview(db,applied);
    db.sqlite.prepare("UPDATE librarika_member_sync_runs SET updated_at='2026-08-01T00:00:00.000Z' WHERE id IN (?,?)").run(uploading.runId,previewed.runId);
    await expireTemporaryLibrarikaMemberSyncRows(db,"2026-09-08T08:00:00.000Z");
    assert.equal(db.sqlite.prepare("SELECT state FROM librarika_member_sync_runs WHERE id=?").get(uploading.runId).state,"failed");
    assert.equal(db.sqlite.prepare("SELECT state FROM librarika_member_sync_runs WHERE id=?").get(previewed.runId).state,"failed");
    assert.equal(db.sqlite.prepare("SELECT state FROM librarika_member_sync_runs WHERE id=?").get(applied.runId).state,"applied");
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM librarika_member_sync_parts WHERE run_id IN (?,?)").get(uploading.runId,previewed.runId).n,0);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM librarika_member_sync_rows WHERE run_id IN (?,?)").get(uploading.runId,previewed.runId).n,0);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM library_readers WHERE source_member_id='1103'").get().n,1);
  }finally{db.sqlite.close();}
});

test("worker uses the scheduled event time for bounded maintenance ticks",()=>{
  const source=fs.readFileSync("worker/index.ts","utf8");
  const panel=fs.readFileSync("app/librarian/sync/member-sync-panel.tsx","utf8");
  assert.match(source,/expireTemporaryLibrarikaMemberSyncRows\(env\.DB\)/u);
  assert.match(source,/recordScheduledHeartbeat\(env\.DB,scheduledAt\)/u);
  assert.match(source,/scheduledInstant\(controller\)/u);
  assert.match(source,/isDailyMemberSyncCleanupTick\(scheduledAt\)/u);
  assert.match(panel,/Фактичний scheduled trigger/u);
  const dailyEvent=Date.parse("2026-09-08T01:17:00.000Z"),fiveMinuteEvent=Date.parse("2026-09-08T01:15:00.000Z");
  assert.equal(isDailyMemberSyncCleanupTick(scheduledInstant({scheduledTime:dailyEvent},Date.parse("2026-09-08T03:44:00.000Z"))),true);
  assert.equal(isFiveMinuteTick(scheduledInstant({scheduledTime:fiveMinuteEvent},Date.parse("2026-09-08T03:44:00.000Z"))),true);
  assert.equal(isDailyMemberSyncCleanupTick(scheduledInstant({scheduledTime:fiveMinuteEvent})),false);
});
