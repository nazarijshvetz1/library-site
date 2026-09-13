import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import test from "node:test";
import {actor,readerDatabase,readerRequest,telegramIdentity} from "./helpers/reader-database.mjs";

const pinAuth=await import("../lib/reader-pin-auth.ts");
const readerAuth=await import("../lib/reader-auth.ts");

const authRequest=(ip="203.0.113.7")=>new Request("https://library.example.test/api/reader/session",{headers:{"CF-Connecting-IP":ip}});

test("student rows receive opaque credentials and directory exposes only name, class and login id",async()=>{
 const db=readerDatabase();
 const credentials=db.sqlite.prepare("SELECT reader_id,login_id,status,code_hmac FROM reader_credentials ORDER BY reader_id").all();
 assert.equal(credentials.length,2);
 assert.match(credentials[0].login_id,/^[0-9a-f]{32}$/u);
 assert.notEqual(credentials[0].login_id,credentials[1].login_id);
 assert.equal(credentials[0].status,"disabled");
 assert.deepEqual(await pinAuth.listReaderDirectory(db,"read",authRequest()),[]);
 await pinAuth.issueReaderWebAccess(db,actor,{readerId:"reader-a",expectedVersion:1,confirmation:"CREATE_READER_WEB_ACCESS"});
 const items=await pinAuth.listReaderDirectory(db,"read",authRequest());
 assert.equal(items.length,1);
 assert.deepEqual(Object.keys(items[0]).sort(),["classLabel","fullName","loginId"]);
 assert.equal(Object.hasOwn(items[0],"readerId"),false);
 assert.equal(Object.hasOwn(items[0],"memberNo"),false);
 await assert.rejects(()=>pinAuth.listReaderDirectory(db,"re",authRequest("203.0.113.8")),error=>error.code==="reader_search");
 db.sqlite.close();
});

test("temporary code is one-use, creates a PIN and supports repeat web sign-in",async()=>{
 const db=readerDatabase();
 const issued=await pinAuth.issueReaderWebAccess(db,actor,{readerId:"reader-a",expectedVersion:1,confirmation:"CREATE_READER_WEB_ACCESS"});
 assert.match(issued.code,/^\d{4}$/u);
 assert.match(issued.token,/^[0-9a-f]{48}$/u);
 const stored=db.sqlite.prepare("SELECT login_id,code_hmac,must_change_pin,status FROM reader_credentials WHERE reader_id='reader-a'").get();
 assert.equal(stored.status,"active");assert.equal(stored.must_change_pin,1);assert.equal(stored.code_hmac.length,64);assert.notEqual(stored.code_hmac,issued.code);
 const first=await pinAuth.beginReaderSignIn(db,authRequest(),{loginId:stored.login_id,code:issued.code});
 assert.equal(first.kind,"setup");assert.match(first.setupToken,/^[0-9a-f]{64}$/u);
 await assert.rejects(()=>pinAuth.beginReaderSignIn(db,authRequest("203.0.113.9"),{loginId:stored.login_id,code:issued.code}),error=>error.code==="invalid_reader_credentials");
 const completed=await pinAuth.completeReaderPinSetup(db,{setupToken:first.setupToken,pin:"2468",pinConfirm:"2468"});
 const identity=await readerAuth.requireReaderSession(db,readerRequest(completed.token));
 assert.equal(identity.readerId,"reader-a");
 await assert.rejects(()=>pinAuth.completeReaderPinSetup(db,{setupToken:first.setupToken,pin:"1357",pinConfirm:"1357"}),error=>error.code==="reader_setup_invalid");
 const repeat=await pinAuth.beginReaderSignIn(db,authRequest("203.0.113.10"),{loginId:stored.login_id,code:"2468"});
 assert.equal(repeat.kind,"session");
 assert.equal((await readerAuth.requireReaderSession(db,readerRequest(repeat.token))).readerId,"reader-a");
 db.sqlite.close();
});

test("a raced brute-force limit is rechecked before a correct PIN creates a session",async()=>{
 const db=readerDatabase(),ip="203.0.113.77";
 const issued=await pinAuth.issueReaderWebAccess(db,actor,{readerId:"reader-a",expectedVersion:1,confirmation:"CREATE_READER_WEB_ACCESS"});
 const credential=db.sqlite.prepare("SELECT login_id FROM reader_credentials WHERE reader_id='reader-a'").get();
 const setup=await pinAuth.beginReaderSignIn(db,authRequest("203.0.113.76"),{loginId:credential.login_id,code:issued.code});
 await pinAuth.completeReaderPinSetup(db,{setupToken:setup.setupToken,pin:"8642",pinConfirm:"8642"});
 const before=db.sqlite.prepare("SELECT COUNT(*) n FROM reader_sessions WHERE reader_id='reader-a' AND revoked_at IS NULL").get().n;
 const pairScope=createHmac("sha256",globalThis.__READER_TEST_ENV.VISIT_TEACHER_AUTH_PEPPER).update(`reader-login-pair:${ip}:${credential.login_id}`).digest("hex"),now=new Date().toISOString();
 db.beforeBatch=()=>db.sqlite.prepare("INSERT INTO reader_auth_limits(scope_hash,window_start,attempts,updated_at) VALUES(?,?,5,?)").run(pairScope,now,now);
 await assert.rejects(()=>pinAuth.beginReaderSignIn(db,authRequest(ip),{loginId:credential.login_id,code:"8642"}),error=>error.code==="reader_rate_limit"&&error.status===429);
 assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM reader_sessions WHERE reader_id='reader-a' AND revoked_at IS NULL").get().n,before);
 db.sqlite.close();
});

test("QR creates a PIN while later PIN reset revokes web sessions but preserves Telegram",async()=>{
 const db=readerDatabase();
 const issued=await pinAuth.issueReaderWebAccess(db,actor,{readerId:"reader-a",expectedVersion:1,confirmation:"CREATE_READER_WEB_ACCESS"});
 const preview=await readerAuth.previewReaderInvite(db,issued.token,"web");assert.equal(preview.fullName,"Читач reader-a");
 const web=await pinAuth.redeemReaderWebInviteWithPin(db,{token:issued.token,pin:"1357",pinConfirm:"1357"});
 assert.equal((await readerAuth.requireReaderSession(db,readerRequest(web.token))).readerId,"reader-a");
 const telegram=telegramIdentity("700","b"),telegramSession=await readerAuth.redeemReaderInvite(db,(await readerAuth.issueReaderInvite(db,actor,{readerId:"reader-b",purpose:"telegram",expectedVersion:1})).token,telegram);
 assert.equal((await readerAuth.requireReaderSession(db,readerRequest(telegramSession.token,true))).readerId,"reader-b");
 const readerVersion=Number(db.sqlite.prepare("SELECT version FROM library_readers WHERE id='reader-b'").get().version);
 await pinAuth.issueReaderWebAccess(db,actor,{readerId:"reader-b",expectedVersion:readerVersion,confirmation:"CREATE_READER_WEB_ACCESS"});
 assert.equal(db.sqlite.prepare("SELECT revoked_at FROM reader_sessions WHERE token_hash=?").get(await import("../lib/librarika-import-plan.ts").then(module=>module.sha256Text(telegramSession.token))).revoked_at,null);
 assert.equal((await readerAuth.requireReaderSession(db,readerRequest(telegramSession.token,true))).readerId,"reader-b");
 db.sqlite.close();
});
