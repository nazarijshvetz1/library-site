import {requireVisitTeacherSession} from "./visit-teacher-auth.ts";
import {sha256Text} from "./librarika-import-plan.ts";
import type {TelegramMiniAppIdentity} from "./telegram-mini-app-auth.ts";
import {opaqueToken,readerBatch,readerFail,requireChanged,type ReaderDatabase,type ReaderIdentity,type LibraryActor} from "./reader-core.ts";

export const READER_COOKIE="__Host-library_reader",READER_TELEGRAM_COOKIE="__Host-library_reader_telegram";
const SESSION_SECONDS=12*60*60;
export function readerSessionCookie(token:string,telegram=false){return `${telegram?READER_TELEGRAM_COOKIE:READER_COOKIE}=${token}; Path=/; HttpOnly; Secure; Max-Age=${token?SESSION_SECONDS:0}; SameSite=${telegram?"None; Partitioned":"Lax"}`;}
export function readerTelegramRequest(request:Request){try{const ref=new URL(request.headers.get("referer")||"");return ref.origin===new URL(request.url).origin&&[/^\/reader\/telegram(?:\/|$)/,/^\/teacher\/telegram(?:\/|$)/].some(pattern=>pattern.test(ref.pathname));}catch{return false;}}
function tokens(request:Request){const cookieName=readerTelegramRequest(request)?READER_TELEGRAM_COOKIE:READER_COOKIE;return (request.headers.get("cookie")||"").split(";").map(value=>value.trim().split("=")).filter(([name,value])=>name===cookieName&&/^[0-9a-f]{64}$/.test(value||"")).map(([,value])=>value);}
function scopedReader(request:Request,identity:ReaderIdentity){
  const expected=request.headers.get("x-reader-id");
  if(expected&&expected!==identity.readerId)readerFail("reader_changed","В іншій вкладці змінився профіль. Оновіть кабінет перед дією.",409);
  if(!["GET","HEAD"].includes(request.method)&&!expected)readerFail("reader_scope_required","Оновіть кабінет перед дією.",409);
  return identity;
}
export async function requireReaderSession(db:ReaderDatabase,request:Request):Promise<ReaderIdentity>{
  const now=new Date().toISOString();
  for(const token of tokens(request)){
    const hash=await sha256Text(token);
    const row=await db.prepare(`SELECT r.id,r.access_version FROM reader_sessions s JOIN library_readers r ON r.id=s.reader_id
      WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND r.status='active' AND r.access_status='active' AND r.access_version=s.access_version
        AND (s.telegram_user_id IS NULL OR EXISTS(SELECT 1 FROM reader_telegram_connections c WHERE c.reader_id=r.id AND c.telegram_user_id=s.telegram_user_id AND c.status='active'))`).bind(hash,now).first();
    if(row)return scopedReader(request,{readerId:String(row.id),accessVersion:Number(row.access_version),tokenHash:hash,sessionKind:"reader"});
  }
  if((request.headers.get("cookie")||"").includes("__Host-visit_teacher")){
    try{
      const teacher=await requireVisitTeacherSession(db,request);
      const row=await db.prepare("SELECT id,access_version FROM library_readers WHERE linked_teacher_user_id=? AND kind!='student' AND status='active' AND access_status='active'").bind(teacher.teacherUserId).first();
      if(row)return scopedReader(request,{readerId:String(row.id),accessVersion:Number(row.access_version),tokenHash:teacher.tokenHash,sessionKind:"teacher"});
    }catch{/* Reader access does not weaken teacher PIN setup or session validation. */}
  }
  readerFail("reader_auth_required","Увійдіть через Telegram або персональне запрошення бібліотекаря.",401);
}

/** Administrator-issued, expiring, one-use capability. No bulk activation or identity guessing. */
export async function issueReaderInvite(db:ReaderDatabase,actor:LibraryActor,input:{readerId:string;purpose:"web"|"telegram";expectedVersion:number}){
  if(!["web","telegram"].includes(input.purpose)||!Number.isInteger(input.expectedVersion)||input.expectedVersion<1)readerFail("invite_invalid","Оновіть профіль читача.");
  const reader=await db.prepare("SELECT id,access_version,version FROM library_readers WHERE id=? AND status='active' AND access_status!='blocked' AND linked_teacher_user_id IS NULL").bind(input.readerId).first();
  if(!reader||reader.version!==input.expectedVersion)readerFail("reader_changed","Читача не знайдено або його дані змінилися.",409);
  const token=opaqueToken(24),hash=await sha256Text(token),now=new Date().toISOString(),expiresAt=new Date(Date.now()+48*60*60*1000).toISOString(),auditId=crypto.randomUUID();
  await readerBatch(db,[
    db.prepare(`INSERT INTO reader_invites(token_hash,reader_id,access_version,purpose,expires_at,created_at,created_by)
      VALUES(?,(SELECT id FROM library_readers WHERE id=? AND version=? AND status='active' AND access_status!='blocked' AND linked_teacher_user_id IS NULL
        AND (?='web' OR NOT EXISTS(SELECT 1 FROM reader_telegram_connections c WHERE c.reader_id=library_readers.id AND c.status IN ('active','blocked')))),?,?,?, ?,
        (SELECT id FROM users WHERE id=? AND role IN ('admin','librarian') AND status='active'))`).bind(hash,input.readerId,input.expectedVersion,input.purpose,Number(reader.access_version),input.purpose,expiresAt,now,actor.id),
    db.prepare("UPDATE library_readers SET version=version+1,updated_at=? WHERE id=? AND version=?").bind(now,input.readerId,input.expectedVersion),requireChanged(db,1),
    db.prepare("UPDATE reader_invites SET revoked_at=? WHERE reader_id=? AND token_hash!=? AND consumed_at IS NULL AND revoked_at IS NULL").bind(now,input.readerId,hash),
    db.prepare("INSERT INTO audit_events(id,actor_user_id,actor_email,action,entity_type,entity_id,metadata_json,created_at) VALUES(?,?,?,'reader_invite','library_reader',?,?,?)").bind(auditId,actor.id,actor.email,input.readerId,JSON.stringify({purpose:input.purpose,expiresAt}),now),
  ]);
  return {token,purpose:input.purpose,expiresAt,readerVersion:input.expectedVersion+1};
}

export async function redeemReaderInvite(db:ReaderDatabase,token:string,telegram?:TelegramMiniAppIdentity){
  if(!/^[0-9a-f]{48}$/.test(token))readerFail("invite_invalid","Запрошення недійсне або вже використане.",401);
  const hash=await sha256Text(token),now=new Date().toISOString();
  const invite=await db.prepare(`SELECT i.reader_id,i.access_version FROM reader_invites i JOIN library_readers r ON r.id=i.reader_id
    WHERE i.token_hash=? AND i.purpose=? AND i.expires_at>? AND i.consumed_at IS NULL AND i.revoked_at IS NULL
      AND i.access_version=r.access_version AND r.status='active' AND r.access_status!='blocked' AND r.linked_teacher_user_id IS NULL`).bind(hash,telegram?"telegram":"web",now).first();
  if(!invite)readerFail("invite_invalid","Запрошення недійсне або вже використане. Зверніться до бібліотекаря.",401);
  const readerId=String(invite.reader_id),session=opaqueToken(),sessionHash=await sha256Text(session),expiresAt=new Date(Date.now()+SESSION_SECONDS*1000).toISOString();
  const statements=[db.prepare(`UPDATE reader_invites SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?
    AND EXISTS(SELECT 1 FROM library_readers r WHERE r.id=reader_invites.reader_id AND r.access_version=reader_invites.access_version AND r.status='active' AND r.access_status!='blocked' AND r.linked_teacher_user_id IS NULL)` ).bind(now,hash,now),requireChanged(db,1)];
  if(telegram){
    statements.push(db.prepare(`INSERT INTO reader_telegram_receipts(init_data_hash,telegram_user_id,reader_id,expires_at,created_at)
      VALUES(?,?,(SELECT ? WHERE NOT EXISTS(SELECT 1 FROM telegram_connections WHERE telegram_user_id=? AND status='active') AND NOT EXISTS(SELECT 1 FROM telegram_mini_app_auth_receipts WHERE init_data_hash=?)),?,?)`).bind(telegram.initDataHash,telegram.telegramUserId,readerId,telegram.telegramUserId,telegram.initDataHash,telegram.expiresAt,now));
    statements.push(db.prepare("UPDATE reader_sessions SET revoked_at=? WHERE reader_id=? AND telegram_user_id IS NOT NULL AND revoked_at IS NULL").bind(now,readerId));
    statements.push(db.prepare(`INSERT INTO reader_telegram_connections(telegram_user_id,reader_id,chat_id,status,version,linked_at)
      VALUES(?,?,?,'active',1,?) ON CONFLICT(reader_id) DO UPDATE SET telegram_user_id=excluded.telegram_user_id,chat_id=excluded.chat_id,status='active',version=reader_telegram_connections.version+1,linked_at=excluded.linked_at,disabled_at=NULL
      WHERE reader_telegram_connections.status='disabled'`).bind(telegram.telegramUserId,readerId,telegram.telegramUserId,now),requireChanged(db,1));
  }
  statements.push(db.prepare("UPDATE library_readers SET access_status='active',version=version+1,updated_at=? WHERE id=? AND access_version=?").bind(now,readerId,Number(invite.access_version)),requireChanged(db,1));
  statements.push(db.prepare("INSERT INTO reader_profiles(reader_id,display_name,updated_at) VALUES(?,'Читач',?) ON CONFLICT(reader_id) DO NOTHING").bind(readerId,now));
  statements.push(pruneSessions(db,readerId,now),db.prepare("INSERT INTO reader_sessions(token_hash,reader_id,access_version,telegram_user_id,created_at,expires_at) VALUES(?,?,?,?,?,?)").bind(sessionHash,readerId,Number(invite.access_version),telegram?.telegramUserId||null,now,expiresAt));
  await readerBatch(db,statements);
  return {token:session,expiresAt};
}

export async function previewReaderInvite(db:ReaderDatabase,token:string,purpose:string){
  if(!/^[0-9a-f]{48}$/.test(token)||!["web","telegram"].includes(purpose))readerFail("invite_invalid","Запрошення недійсне.",401);
  const row=await db.prepare(`SELECT r.full_name FROM reader_invites i JOIN library_readers r ON r.id=i.reader_id WHERE i.token_hash=? AND i.purpose=? AND i.expires_at>? AND i.consumed_at IS NULL AND i.revoked_at IS NULL AND i.access_version=r.access_version AND r.status='active' AND r.access_status!='blocked' AND r.linked_teacher_user_id IS NULL`).bind(await sha256Text(token),purpose,new Date().toISOString()).first();
  if(!row)readerFail("invite_invalid","Запрошення недійсне або вже використане. Зверніться до бібліотекаря.",401);return {fullName:row.full_name};
}

export async function createReaderTelegramSession(db:ReaderDatabase,telegram:TelegramMiniAppIdentity){
  const now=new Date().toISOString();
  const connection=await db.prepare(`SELECT r.id,r.access_version,c.version FROM reader_telegram_connections c JOIN library_readers r ON r.id=c.reader_id
    WHERE c.telegram_user_id=? AND c.status='active' AND r.status='active' AND r.access_status='active' AND r.linked_teacher_user_id IS NULL`).bind(telegram.telegramUserId).first();
  if(!connection)readerFail("reader_telegram_unlinked","Цей Telegram ще не приєднано. Отримайте персональне запрошення бібліотекаря.",401);
  const token=opaqueToken(),hash=await sha256Text(token),expiresAt=new Date(Date.now()+SESSION_SECONDS*1000).toISOString();
  await readerBatch(db,[
    db.prepare(`INSERT INTO reader_telegram_receipts(init_data_hash,telegram_user_id,reader_id,expires_at,created_at)
      VALUES(?,?,(SELECT r.id FROM library_readers r JOIN reader_telegram_connections c ON c.reader_id=r.id
        WHERE r.id=? AND r.access_version=? AND r.status='active' AND r.access_status='active' AND c.telegram_user_id=? AND c.version=? AND c.status='active'
          AND NOT EXISTS(SELECT 1 FROM telegram_connections WHERE telegram_user_id=? AND status='active')
          AND NOT EXISTS(SELECT 1 FROM telegram_mini_app_auth_receipts WHERE init_data_hash=?)),?,?)`).bind(telegram.initDataHash,telegram.telegramUserId,String(connection.id),Number(connection.access_version),telegram.telegramUserId,Number(connection.version),telegram.telegramUserId,telegram.initDataHash,telegram.expiresAt,now),
    pruneSessions(db,String(connection.id),now),
    db.prepare("INSERT INTO reader_sessions(token_hash,reader_id,access_version,telegram_user_id,created_at,expires_at) VALUES(?,?,?,?,?,?)").bind(hash,String(connection.id),Number(connection.access_version),telegram.telegramUserId,now,expiresAt),
  ]);
  return {token,expiresAt};
}
export async function logoutReader(db:ReaderDatabase,request:Request){
  for(const token of tokens(request))await db.batch([db.prepare("UPDATE reader_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL").bind(new Date().toISOString(),await sha256Text(token))]);
}
function pruneSessions(db:ReaderDatabase,readerId:string,now:string){return db.prepare("UPDATE reader_sessions SET revoked_at=? WHERE reader_id=? AND revoked_at IS NULL AND token_hash IN (SELECT token_hash FROM reader_sessions WHERE reader_id=? AND revoked_at IS NULL ORDER BY created_at DESC,token_hash DESC LIMIT -1 OFFSET 2)").bind(now,readerId,readerId);}
