import test from "node:test";
import assert from "node:assert/strict";
import {readerDatabase,actor,readerRequest,publishReaderFixture} from "./helpers/reader-database.mjs";
const auth=await import("../lib/reader-auth.ts"),store=await import("../lib/reader-profile-store.ts");
async function login(db,id="reader-a"){if(!db.sqlite.prepare("SELECT material_id FROM library_editions WHERE id='edition'").get().material_id)publishReaderFixture(db);const invite=await auth.issueReaderInvite(db,actor,{readerId:id,purpose:"web",expectedVersion:1});const session=await auth.redeemReaderInvite(db,invite.token);return auth.requireReaderSession(db,readerRequest(session.token));}
test("profile holds personal data, has opt-in defaults and cannot change class or identity",async()=>{
  const db=readerDatabase();try{const identity=await login(db);const profile=await store.getReaderProfile(db,identity);assert.equal(profile.notifyLoans,false);assert.equal(profile.communityEnabled,false);
    const input={requestId:crypto.randomUUID(),expectedVersion:1,displayName:"Книголюб",phone:"+380000000000",communityEnabled:true,notifyLoans:true,notifyBooks:false};
    await store.updateReaderProfile(db,identity,input);assert.equal((await store.updateReaderProfile(db,identity,input)).version,2);
    await assert.rejects(store.updateReaderProfile(db,identity,{...input,requestId:crypto.randomUUID(),classId:"other"}));
    const next=await store.getReaderProfile(db,identity);assert.equal(next.phone,"+380000000000");assert.equal(next.fullName,"Читач reader-a");
    assert.deepEqual(await store.getReaderBooks(db,identity),{loans:[],requests:[]});
  }finally{db.sqlite.close();}
});
test("book request needs confirmation, replays once and another reader cannot cancel it",async()=>{
  const db=readerDatabase();try{const a=await login(db),b=await login(db,"reader-b");const input={requestId:crypto.randomUUID(),editionId:"edition",note:"Примітка",confirmation:"CONFIRM_BOOK_REQUEST"};
    await assert.rejects(store.requestReaderBook(db,a,{...input,confirmation:""}));
    const result=await store.requestReaderBook(db,a,input);assert.equal((await store.requestReaderBook(db,a,input)).id,result.id);
    await assert.rejects(store.cancelReaderBookRequest(db,b,{requestId:crypto.randomUUID(),id:result.id,expectedVersion:1}));
    await store.cancelReaderBookRequest(db,a,{requestId:crypto.randomUUID(),id:result.id,expectedVersion:1});
    assert.equal(db.sqlite.prepare("SELECT status FROM reader_book_requests WHERE id=?").get(result.id).status,"cancelled");
  }finally{db.sqlite.close();}
});
test("one reader rating per edition, review moderation and access race are enforced",async()=>{
  const db=readerDatabase();try{const identity=await login(db);await store.saveReaderRating(db,identity,{requestId:crypto.randomUUID(),editionId:"edition",rating:3,body:"Мій відгук",expectedVersion:0});
    const rating=db.sqlite.prepare("SELECT rating,review_state FROM library_ratings").get();assert.equal(rating.rating,3);assert.equal(rating.review_state,"pending");
    await assert.rejects(store.saveReaderRating(db,identity,{requestId:crypto.randomUUID(),editionId:"edition",rating:5,body:"Другий",expectedVersion:0}));
    db.beforeBatch=()=>db.sqlite.exec("UPDATE library_readers SET access_version=access_version+1 WHERE id='reader-a'");
    await assert.rejects(store.setReaderBookSubscription(db,identity,{requestId:crypto.randomUUID(),editionId:"edition",subscribed:true}));
    assert.equal(db.sqlite.prepare("SELECT count(*) n FROM reader_book_subscriptions").get().n,0);
  }finally{db.sqlite.close();}
});
