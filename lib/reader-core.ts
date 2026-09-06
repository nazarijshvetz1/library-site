import type {VisitD1Database} from "./visit-schedule-store.ts";
import {sha256Text} from "./librarika-import-plan.ts";
export type ReaderDatabase=VisitD1Database;
export type ReaderIdentity={readerId:string;accessVersion:number;tokenHash:string;sessionKind:"reader"|"teacher"};
export type LibraryActor={id:string;email:string};
export class ReaderError extends Error {code:string;status:number;constructor(code:string,status:number,message:string){super(message);this.code=code;this.status=status;}}
export function readerFail(code:string,message:string,status=400):never{throw new ReaderError(code,status,message);}
export function opaqueToken(bytes=32){return Array.from(crypto.getRandomValues(new Uint8Array(bytes)),value=>value.toString(16).padStart(2,"0")).join("");}
export const uuidValid=(value:unknown):value is string=>typeof value==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export const readerResource=(value:unknown):value is string=>typeof value==="string"&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
export const stableJson=(value:unknown):string=>value===null||typeof value!=="object"?JSON.stringify(value):Array.isArray(value)?`[${value.map(stableJson).join(",")}]`:`{${Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+stableJson((value as Record<string,unknown>)[key])).join(",")}}`;
export function readerGuard(identity:ReaderIdentity,now:string){
  const sql=identity.sessionKind==="reader"?`SELECT r.id FROM library_readers r JOIN reader_sessions s ON s.reader_id=r.id
    WHERE r.id=? AND r.status='active' AND r.access_status='active' AND r.access_version=?
      AND s.token_hash=? AND s.access_version=r.access_version AND s.expires_at>? AND s.revoked_at IS NULL
      AND (s.telegram_user_id IS NULL OR EXISTS(SELECT 1 FROM reader_telegram_connections tc WHERE tc.reader_id=r.id AND tc.telegram_user_id=s.telegram_user_id AND tc.status='active'))`
    :`SELECT r.id FROM library_readers r JOIN users u ON u.id=r.linked_teacher_user_id JOIN visit_teacher_credentials c ON c.teacher_user_id=u.id JOIN visit_teacher_sessions s ON s.teacher_user_id=u.id
      WHERE r.id=? AND r.status='active' AND r.access_status='active' AND r.access_version=? AND r.kind!='student'
        AND s.token_hash=? AND s.expires_at>? AND s.revoked_at IS NULL AND s.credential_version=c.version
        AND c.status='active' AND c.must_change_pin=0 AND u.status='active'
        AND EXISTS(SELECT 1 FROM teacher_profiles cap WHERE cap.teacher_user_id=u.id AND cap.closed_at IS NULL)`;
  return {sql,bindings:[identity.readerId,identity.accessVersion,identity.tokenHash,now] as (string|number)[]};
}
export async function readerReplay(db:ReaderDatabase,identity:ReaderIdentity,requestId:string,kind:string,input:unknown){
  if(!uuidValid(requestId))readerFail("request_invalid","Оновіть сторінку та повторіть дію.");
  const hash=await sha256Text(stableJson({kind,input}));
  const saved=await db.prepare("SELECT reader_id,kind,request_hash,result_json FROM reader_mutation_receipts WHERE id=?").bind(requestId).first();
  if(saved&&(saved.reader_id!==identity.readerId||saved.kind!==kind||saved.request_hash!==hash))readerFail("request_conflict","Ідентифікатор дії вже використаний з іншими даними.",409);
  return {hash,replayed:saved?JSON.parse(String(saved.result_json)):null};
}
export function readerReceipt(db:ReaderDatabase,identity:ReaderIdentity,requestId:string,kind:string,hash:string,result:unknown,now:string){
  const guard=readerGuard(identity,now);
  return db.prepare(`INSERT INTO reader_mutation_receipts(id,reader_id,kind,request_hash,result_json,created_at) VALUES(?,(${guard.sql}),?,?,?,?)`).bind(requestId,...guard.bindings,kind,hash,JSON.stringify(result),now);
}
export function requireChanged(db:ReaderDatabase,expected:number){
  // An empty SELECT cannot abort D1; a CHECK violation can. No disposable sentinel rows are needed.
  return db.prepare("SELECT CASE WHEN changes()=? THEN 1 ELSE json('reader_concurrent_change') END AS guarded").bind(expected);
}
export async function readerBatch(db:ReaderDatabase,statements:Parameters<ReaderDatabase["batch"]>[0]){
  try{await db.batch(statements);}catch{readerFail("concurrent_change","Дані або доступ уже змінилися. Оновіть сторінку та повторіть дію.",409);}
}
