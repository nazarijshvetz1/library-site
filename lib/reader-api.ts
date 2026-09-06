import {getRuntimeBoolean} from "./runtime-env.ts";
import {isSameOriginRequest} from "./request-origin.ts";
import {readBoundedJson} from "./bounded-json.ts";
import {ReaderError,readerFail,type ReaderDatabase} from "./reader-core.ts";
import {teacherAuthPepper} from "./visit-teacher-auth.ts";
export function readerJson(value:unknown,init:ResponseInit={}){const headers=new Headers(init.headers);headers.set("Cache-Control","private, no-store");headers.set("Content-Type","application/json; charset=utf-8");headers.set("X-Content-Type-Options","nosniff");return Response.json(value,{...init,headers});}
export function readerApiError(error:unknown){if(error instanceof ReaderError)return readerJson({success:false,code:error.code,error:error.message},{status:error.status});return readerJson({success:false,code:"reader_unavailable",error:"Не вдалося виконати дію. Оновіть сторінку та спробуйте ще раз."},{status:503});}
export async function readerWriteBody(request:Request,limit=48000){
  if(!getRuntimeBoolean("LIBRARIAN_WRITES_ENABLED"))readerFail("writes_disabled","Запис тимчасово вимкнено адміністратором.",503);
  if(!isSameOriginRequest(request))readerFail("cross_origin_request","Запит має надійти з цього сайту.",403);
  try{return await readBoundedJson(request,limit);}catch{readerFail("body_invalid","Надіслано некоректні або завеликі дані.");}
}
export async function limitReaderAuth(db:ReaderDatabase,request:Request){
  const now=new Date(),minute=new Date(Math.floor(now.getTime()/60000)*60000).toISOString();
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(teacherAuthPepper()),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const digest=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode("reader-auth:"+(request.headers.get("CF-Connecting-IP")||"unknown")));
  const scope=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("");
  const result=await db.batch([db.prepare(`INSERT INTO reader_auth_limits(scope_hash,window_start,attempts,updated_at) VALUES(?,?,1,?)
    ON CONFLICT(scope_hash) DO UPDATE SET attempts=CASE WHEN reader_auth_limits.window_start=excluded.window_start THEN reader_auth_limits.attempts+1 ELSE 1 END,window_start=excluded.window_start,updated_at=excluded.updated_at RETURNING attempts`).bind(scope,minute,now.toISOString()),
    db.prepare("DELETE FROM reader_auth_limits WHERE scope_hash IN (SELECT scope_hash FROM reader_auth_limits WHERE updated_at<? LIMIT 20)").bind(new Date(now.getTime()-86400000).toISOString())]);
  if(Number(result[0]?.results?.[0]?.attempts||999)>30)readerFail("reader_rate_limit","Забагато спроб входу. Зачекайте хвилину.",429);
}
