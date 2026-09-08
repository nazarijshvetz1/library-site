import test from "node:test";
import assert from "node:assert/strict";
import {actor,confirmLibrarikaBaseline,readerDatabase} from "./helpers/reader-database.mjs";
import {saveLibraryReader} from "../lib/library-reader-admin.ts";

test("new readers receive one idempotent numeric member number and a visible Librarika handoff state",async()=>{
  const db=readerDatabase();
  try{
    confirmLibrarikaBaseline(db);
    const requestId=crypto.randomUUID();
    const input={requestId,fullName:"Нова Учениця",memberNo:"",kind:"student",classYearId:null};
    const created=await saveLibraryReader(db,actor,input);
    const replay=await saveLibraryReader(db,actor,input);
    assert.deepEqual(replay,created);
    assert.equal(created.memberNo,"26000001");
    const row=db.sqlite.prepare("SELECT member_no FROM library_readers WHERE id=?").get(created.id);
    assert.match(row.member_no,/^[0-9]+$/);
    assert.equal(row.member_no,"26000001");
    assert.equal(db.sqlite.prepare("SELECT count(*) n FROM reader_number_allocations WHERE request_id=?").get(requestId).n,1);
    const link=db.sqlite.prepare("SELECT member_no,state,external_member_id FROM reader_platform_links WHERE reader_id=?").get(created.id);
    assert.deepEqual({...link},{member_no:"26000001",state:"manual_required",external_member_id:null});
  }finally{db.sqlite.close();}
});

test("the site-generated numeric namespace cannot be occupied through manual reader creation",async()=>{
  const db=readerDatabase();
  try{
    confirmLibrarikaBaseline(db);
    await assert.rejects(
      saveLibraryReader(db,actor,{requestId:crypto.randomUUID(),fullName:"Ручний Учень",memberNo:"26000001",kind:"student",classYearId:null}),
      error=>error?.code==="reader_number_reserved",
    );
    const created=await saveLibraryReader(db,actor,{requestId:crypto.randomUUID(),fullName:"Автоматичний Учень",kind:"student",classYearId:null});
    assert.equal(created.memberNo,"26000001");
  }finally{db.sqlite.close();}
});

test("automatic member numbers are unique and existing numbers are preserved",async()=>{
  const db=readerDatabase();
  try{
    confirmLibrarikaBaseline(db);
    const first=await saveLibraryReader(db,actor,{requestId:crypto.randomUUID(),fullName:"Перший Учень",kind:"student",classYearId:null});
    const second=await saveLibraryReader(db,actor,{requestId:crypto.randomUUID(),fullName:"Другий Учень",kind:"student",classYearId:null});
    assert.equal(db.sqlite.prepare("SELECT member_no FROM library_readers WHERE id=?").get(first.id).member_no,"26000001");
    assert.equal(db.sqlite.prepare("SELECT member_no FROM library_readers WHERE id=?").get(second.id).member_no,"26000002");
    assert.equal(db.sqlite.prepare("SELECT member_no FROM library_readers WHERE id='reader-a'").get().member_no,"reader-a");
  }finally{db.sqlite.close();}
});

test("a Librarika-linked member number is locked from ordinary editing",async()=>{
  const db=readerDatabase();
  try{
    db.sqlite.prepare("UPDATE library_readers SET source_member_id='42' WHERE id='reader-a'").run();
    await assert.rejects(
      saveLibraryReader(db,actor,{requestId:crypto.randomUUID(),id:"reader-a",expectedVersion:1,fullName:"Читач reader-a",memberNo:"999",kind:"student",classYearId:null}),
      error=>error?.code==="reader_number_locked",
    );
    assert.equal(db.sqlite.prepare("SELECT member_no FROM library_readers WHERE id='reader-a'").get().member_no,"reader-a");
  }finally{db.sqlite.close();}
});

test("automatic allocation is blocked until a full Members baseline is explicitly confirmed",async()=>{
  const db=readerDatabase();
  try{
    await assert.rejects(
      saveLibraryReader(db,actor,{requestId:crypto.randomUUID(),fullName:"Учень До Звірки",kind:"student",classYearId:null}),
      error=>error?.code==="reader_baseline_required",
    );
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM reader_number_allocations").get().n,0);
  }finally{db.sqlite.close();}
});
