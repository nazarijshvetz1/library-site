import test from "node:test";
import assert from "node:assert/strict";
import {readerDatabase,actor,readerRequest,telegramIdentity} from "./helpers/reader-database.mjs";
const auth=await import("../lib/reader-auth.ts");
const api=await import("../lib/reader-api.ts");

test("reader import has no login; one-use invite activates only its exact reader",async()=>{
  const db=readerDatabase();try{
    await assert.rejects(auth.requireReaderSession(db,readerRequest("a".repeat(64))),error=>error.status===401);
    const invite=await auth.issueReaderInvite(db,actor,{readerId:"reader-a",purpose:"web",expectedVersion:1});
    assert.match(invite.token,/^[0-9a-f]{48}$/);assert.equal(invite.readerVersion,2);
    const session=await auth.redeemReaderInvite(db,invite.token),identity=await auth.requireReaderSession(db,readerRequest(session.token));
    assert.equal(identity.readerId,"reader-a");assert.equal(db.sqlite.prepare("SELECT version FROM library_readers WHERE id='reader-a'").get().version,3);
    await assert.rejects(auth.redeemReaderInvite(db,invite.token));
    assert.equal(db.sqlite.prepare("SELECT access_status FROM library_readers WHERE id='reader-b'").get().access_status,"inactive");
    assert.ok(!JSON.stringify(db.sqlite.prepare("SELECT * FROM reader_invites").all()).includes(invite.token));
    assert.ok(!JSON.stringify(db.sqlite.prepare("SELECT * FROM reader_sessions").all()).includes(session.token));
    assert.equal(db.sqlite.prepare("SELECT count(*) n FROM reader_notification_outbox").get().n,0);
  }finally{db.sqlite.close();}
});
test("revoked invite and actor races roll back activation and issuance",async()=>{
  const db=readerDatabase();try{
    const invite=await auth.issueReaderInvite(db,actor,{readerId:"reader-a",purpose:"web",expectedVersion:1});
    db.beforeBatch=()=>db.sqlite.exec("UPDATE reader_invites SET revoked_at='2026-09-06'");
    await assert.rejects(auth.redeemReaderInvite(db,invite.token));
    assert.equal(db.sqlite.prepare("SELECT count(*) n FROM reader_sessions").get().n,0);
    db.beforeBatch=()=>db.sqlite.exec("UPDATE users SET status='inactive' WHERE id='admin'");
    await assert.rejects(auth.issueReaderInvite(db,actor,{readerId:"reader-b",purpose:"web",expectedVersion:1}));
    assert.equal(db.sqlite.prepare("SELECT version FROM library_readers WHERE id='reader-b'").get().version,1);
  }finally{db.sqlite.close();}
});
test("Telegram rebind cannot resurrect an old session and signed launch cannot replay",async()=>{
  const db=readerDatabase();try{
    const invite=await auth.issueReaderInvite(db,actor,{readerId:"reader-a",purpose:"telegram",expectedVersion:1});
    const first=await auth.redeemReaderInvite(db,invite.token,telegramIdentity());
    assert.equal((await auth.requireReaderSession(db,readerRequest(first.token,true))).readerId,"reader-a");
    await assert.rejects(auth.createReaderTelegramSession(db,telegramIdentity()));
    db.sqlite.exec("UPDATE reader_telegram_connections SET status='disabled',version=version+1");
    const rebind=await auth.issueReaderInvite(db,actor,{readerId:"reader-a",purpose:"telegram",expectedVersion:3});
    await auth.redeemReaderInvite(db,rebind.token,telegramIdentity("100","b"));
    await assert.rejects(auth.requireReaderSession(db,readerRequest(first.token,true)));
    const next=await auth.createReaderTelegramSession(db,telegramIdentity("100","c"));
    assert.equal((await auth.requireReaderSession(db,readerRequest(next.token,true))).readerId,"reader-a");
  }finally{db.sqlite.close();}
});
test("web and Mini App cookies cannot select the other surface reader",async()=>{
  const db=readerDatabase();try{
    const web=await auth.issueReaderInvite(db,actor,{readerId:"reader-a",purpose:"web",expectedVersion:1});
    const webSession=await auth.redeemReaderInvite(db,web.token);
    const tg=await auth.issueReaderInvite(db,actor,{readerId:"reader-b",purpose:"telegram",expectedVersion:1});
    const tgSession=await auth.redeemReaderInvite(db,tg.token,telegramIdentity());
    for(const reversed of [false,true]){
      const cookies=[`__Host-library_reader=${webSession.token}`,`__Host-library_reader_telegram=${tgSession.token}`];if(reversed)cookies.reverse();
      for(const telegram of [false,true]){const request=readerRequest("",telegram);request.headers.set("Cookie",cookies.join("; "));assert.equal((await auth.requireReaderSession(db,request)).readerId,telegram?"reader-b":"reader-a");}
    }
  }finally{db.sqlite.close();}
});
test("reader API bounds authentication attempts and private cache",async()=>{
  const db=readerDatabase();try{
    const request=new Request("https://library.example.test/api/reader/session",{headers:{"CF-Connecting-IP":"203.0.113.8"}});
    for(let index=0;index<30;index++)await api.limitReaderAuth(db,request);
    await assert.rejects(api.limitReaderAuth(db,request),error=>error.status===429);
    assert.equal(api.readerJson({success:true}).headers.get("Cache-Control"),"private, no-store");
  }finally{db.sqlite.close();}
});
