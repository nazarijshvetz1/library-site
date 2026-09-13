import {normalizeCatalogSearchText} from "./catalog-d1.ts";
import {sha256Text} from "./librarika-import-plan.ts";
import {opaqueToken,readerBatch,readerFail,requireChanged,type LibraryActor,type ReaderDatabase} from "./reader-core.ts";
import {teacherAuthPepper} from "./visit-teacher-auth.ts";

const CODE_TTL_MS=48*60*60*1000,SETUP_TTL_MS=15*60*1000,SESSION_TTL_MS=12*60*60*1000;
const LOGIN_IP_LIMIT=300,LOGIN_PAIR_LIMIT=5,LOGIN_READER_LIMIT=20,DIRECTORY_IP_LIMIT=300;
const LOGIN_IP_WINDOW_MS=15*60*1000,LOGIN_PAIR_WINDOW_MS=15*60*1000,LOGIN_READER_WINDOW_MS=60*60*1000;

type CredentialRow={
 reader_id:string;login_id:string;code_hmac:string|null;must_change_pin:number;credential_status:"active"|"disabled";credential_version:number;
 failed_attempts:number;failure_window_started_at:string|null;locked_until:string|null;code_expires_at:string|null;
 reader_status:"active"|"inactive";access_status:"active"|"inactive"|"blocked";access_version:number;reader_version:number;kind:string;linked_teacher_user_id:string|null;
};
type Scope={hash:string;windowMs:number;limit:number};
export type ReaderDirectoryItem={loginId:string;fullName:string;classLabel:string};
export type ReaderLoginResult={kind:"session";token:string;expiresAt:string}|{kind:"setup";setupToken:string;expiresAt:string};

async function hmacHex(value:string){
 const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(teacherAuthPepper()),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const signature=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(value));
 return Array.from(new Uint8Array(signature),byte=>byte.toString(16).padStart(2,"0")).join("");
}
function constantTimeHexEqual(left:string,right:string){
 if(!/^[0-9a-f]{64}$/u.test(left)||!/^[0-9a-f]{64}$/u.test(right))return false;
 let difference=0;for(let index=0;index<left.length;index+=1)difference|=left.charCodeAt(index)^right.charCodeAt(index);return difference===0;
}
function pin(value:unknown){const normalized=typeof value==="string"?value.normalize("NFKC").trim():"";return /^\d{4}$/u.test(normalized)?normalized:null;}
function randomCode(){
 const result:string[]=[];while(result.length<4){for(const byte of crypto.getRandomValues(new Uint8Array(8))){if(byte>=250)continue;result.push(String(byte%10));if(result.length===4)break;}}return result.join("");
}
function clientIp(request:Request){
 const value=request.headers.get("CF-Connecting-IP")?.trim();
 if(value)return value.slice(0,128);
 const hostname=new URL(request.url).hostname;
 if(hostname==="localhost"||hostname==="127.0.0.1"||hostname==="[::1]")return `local:${hostname}`;
 readerFail("reader_client_ip","Не вдалося безпечно перевірити запит. Спробуйте пізніше.",503);
}
async function scopes(request:Request,loginId:string):Promise<{ip:Scope;pair:Scope;reader:Scope}>{
 const ip=clientIp(request);return {
  ip:{hash:await hmacHex(`reader-login-ip:${ip}`),windowMs:LOGIN_IP_WINDOW_MS,limit:LOGIN_IP_LIMIT},
  pair:{hash:await hmacHex(`reader-login-pair:${ip}:${loginId}`),windowMs:LOGIN_PAIR_WINDOW_MS,limit:LOGIN_PAIR_LIMIT},
  reader:{hash:await hmacHex(`reader-login-account:${loginId}`),windowMs:LOGIN_READER_WINDOW_MS,limit:LOGIN_READER_LIMIT},
 };
}
async function blocked(db:ReaderDatabase,items:Scope[],nowDate:Date){
 for(const item of items){const row=await db.prepare("SELECT attempts,window_start FROM reader_auth_limits WHERE scope_hash=? LIMIT 1").bind(item.hash).first();
  if(row&&String(row.window_start)>=new Date(nowDate.getTime()-item.windowMs).toISOString()&&Number(row.attempts)>=item.limit)return true;}
 return false;
}
function failureStatement(db:ReaderDatabase,item:Scope,nowDate:Date){
 const now=nowDate.toISOString(),cutoff=new Date(nowDate.getTime()-item.windowMs).toISOString();return db.prepare(`INSERT INTO reader_auth_limits(scope_hash,window_start,attempts,updated_at) VALUES(?,?,1,?)
  ON CONFLICT(scope_hash) DO UPDATE SET attempts=CASE WHEN reader_auth_limits.window_start<? THEN 1 ELSE reader_auth_limits.attempts+1 END,
  window_start=CASE WHEN reader_auth_limits.window_start<? THEN excluded.window_start ELSE reader_auth_limits.window_start END,updated_at=excluded.updated_at`).bind(item.hash,now,now,cutoff,cutoff);
}
function cleanupLimits(db:ReaderDatabase,nowDate:Date){return db.prepare("DELETE FROM reader_auth_limits WHERE scope_hash IN (SELECT scope_hash FROM reader_auth_limits WHERE updated_at<? ORDER BY updated_at LIMIT 100)").bind(new Date(nowDate.getTime()-2*86400000).toISOString());}
function rateGuard(rate:{ip:Scope;pair:Scope;reader:Scope},nowDate:Date){return {
 sql:`NOT EXISTS(SELECT 1 FROM reader_auth_limits WHERE
   (scope_hash=? AND window_start>=? AND attempts>=?) OR
   (scope_hash=? AND window_start>=? AND attempts>=?) OR
   (scope_hash=? AND window_start>=? AND attempts>=?))`,
 bindings:[
  rate.ip.hash,new Date(nowDate.getTime()-rate.ip.windowMs).toISOString(),rate.ip.limit,
  rate.pair.hash,new Date(nowDate.getTime()-rate.pair.windowMs).toISOString(),rate.pair.limit,
  rate.reader.hash,new Date(nowDate.getTime()-rate.reader.windowMs).toISOString(),rate.reader.limit,
 ] as (string|number)[],
};}
async function failed(db:ReaderDatabase,limits:Scope[],credential:CredentialRow|null,presented:string,nowDate:Date){
 const now=nowDate.toISOString(),windowStart=new Date(nowDate.getTime()-LOGIN_READER_WINDOW_MS).toISOString(),lockUntil=new Date(nowDate.getTime()+LOGIN_READER_WINDOW_MS).toISOString();
 const statements=limits.map(item=>failureStatement(db,item,nowDate));
 if(credential&&!constantTimeHexEqual(presented,credential.code_hmac||""))statements.push(db.prepare(`UPDATE reader_credentials SET
  failed_attempts=CASE WHEN failure_window_started_at IS NULL OR failure_window_started_at<? THEN 1 ELSE failed_attempts+1 END,
  failure_window_started_at=CASE WHEN failure_window_started_at IS NULL OR failure_window_started_at<? THEN ? ELSE failure_window_started_at END,
  locked_until=CASE WHEN failure_window_started_at IS NOT NULL AND failure_window_started_at>=? AND failed_attempts+1>=? THEN ? ELSE locked_until END,
  updated_at=? WHERE reader_id=? AND version=?`).bind(windowStart,windowStart,now,windowStart,LOGIN_READER_LIMIT,lockUntil,now,credential.reader_id,credential.credential_version));
 statements.push(cleanupLimits(db,nowDate));try{await db.batch(statements);}catch{/* Keep authentication failures generic. */}
}
function pruneWebSessions(db:ReaderDatabase,readerId:string,now:string){return db.prepare(`UPDATE reader_sessions SET revoked_at=? WHERE reader_id=? AND telegram_user_id IS NULL AND revoked_at IS NULL AND token_hash IN
 (SELECT token_hash FROM reader_sessions WHERE reader_id=? AND telegram_user_id IS NULL AND revoked_at IS NULL ORDER BY created_at DESC,token_hash DESC LIMIT -1 OFFSET 2)`).bind(now,readerId,readerId);}

export async function limitReaderDirectory(db:ReaderDatabase,request:Request){
 const nowDate=new Date(),minute=new Date(Math.floor(nowDate.getTime()/60000)*60000).toISOString(),scope=await hmacHex(`reader-directory-ip:${clientIp(request)}`);
 const result=await db.batch([db.prepare(`INSERT INTO reader_auth_limits(scope_hash,window_start,attempts,updated_at) VALUES(?,?,1,?)
  ON CONFLICT(scope_hash) DO UPDATE SET attempts=CASE WHEN reader_auth_limits.window_start=excluded.window_start THEN reader_auth_limits.attempts+1 ELSE 1 END,
  window_start=excluded.window_start,updated_at=excluded.updated_at RETURNING attempts`).bind(scope,minute,nowDate.toISOString()),cleanupLimits(db,nowDate)]);
 if(Number(result[0]?.results?.[0]?.attempts||999)>DIRECTORY_IP_LIMIT)readerFail("reader_rate_limit","Забагато запитів. Спробуйте за хвилину.",429);
}

export async function listReaderDirectory(db:ReaderDatabase,query:string,request:Request):Promise<ReaderDirectoryItem[]>{
 await limitReaderDirectory(db,request);const normalized=normalizeCatalogSearchText(query.normalize("NFKC").trim().replace(/\s+/gu," "));
 if(normalized.length<3||normalized.length>80)readerFail("reader_search","Введіть від 3 до 80 символів прізвища або імені.");
 const like="%"+normalized.replace(/[!%_]/gu,value=>"!"+value)+"%";
 const rows=await db.prepare(`SELECT c.login_id,r.full_name,COALESCE(cy.class_name,r.source_group_label,'') class_label
  FROM library_readers r JOIN reader_credentials c ON c.reader_id=r.id
  LEFT JOIN reader_class_enrollments ce ON ce.reader_id=r.id AND ce.ended_at IS NULL
  LEFT JOIN class_years cy ON cy.id=ce.class_year_id
  WHERE r.kind='student' AND r.status='active' AND r.access_status='active' AND r.linked_teacher_user_id IS NULL AND c.status='active'
    AND r.sort_name LIKE ? ESCAPE '!'
  ORDER BY r.sort_name,r.id LIMIT 11`).bind(like).all();
 const results=rows.results||[];if(results.length>10)readerFail("reader_search_broad","Знайдено забагато збігів. Уточніть ім’я.");
 return results.map(row=>({loginId:String(row.login_id),fullName:String(row.full_name),classLabel:String(row.class_label||"")}));
}

async function credentialByLogin(db:ReaderDatabase,loginId:string){return db.prepare(`SELECT c.reader_id,c.login_id,c.code_hmac,c.must_change_pin,c.status credential_status,c.version credential_version,
 c.failed_attempts,c.failure_window_started_at,c.locked_until,c.code_expires_at,r.status reader_status,r.access_status,r.access_version,r.version reader_version,r.kind,r.linked_teacher_user_id
 FROM reader_credentials c JOIN library_readers r ON r.id=c.reader_id WHERE c.login_id=? LIMIT 1`).bind(loginId).first<CredentialRow>();}

export async function beginReaderSignIn(db:ReaderDatabase,request:Request,input:{loginId:string;code:string}):Promise<ReaderLoginResult>{
 const loginId=typeof input.loginId==="string"?input.loginId.trim():"",code=pin(input.code),nowDate=new Date(),now=nowDate.toISOString(),rate=await scopes(request,loginId),limits=[rate.ip,rate.pair,rate.reader];
 if(await blocked(db,limits,nowDate))readerFail("reader_rate_limit","Забагато спроб входу. Спробуйте пізніше.",429);
 const credential=/^[0-9a-f]{32}$/u.test(loginId)?await credentialByLogin(db,loginId):null;
 const context=credential?.must_change_pin?"reader-temp":"reader-pin",presented=await hmacHex(`${context}:${credential?.reader_id||"unknown"}:${code||String(input.code||"")}`);
 const active=Boolean(code&&credential&&credential.reader_status==="active"&&credential.kind==="student"&&!credential.linked_teacher_user_id&&credential.access_status!=="blocked"&&credential.credential_status==="active"&&(!credential.locked_until||credential.locked_until<=now)&&(!credential.must_change_pin||Boolean(credential.code_expires_at&&credential.code_expires_at>now))&&constantTimeHexEqual(presented,credential.code_hmac||"")&&(credential.must_change_pin||credential.access_status==="active"));
 if(!active||!credential){await failed(db,limits,credential,presented,nowDate);readerFail("invalid_reader_credentials","Не вдалося увійти. Перевірте обраний профіль і код.",401);}
 const guard=rateGuard(rate,nowDate);
 if(credential.must_change_pin){
  const setupToken=opaqueToken(),setupHash=await sha256Text(setupToken),expiresAt=new Date(nowDate.getTime()+SETUP_TTL_MS).toISOString();
  try{await readerBatch(db,[
   db.prepare(`UPDATE reader_credentials SET code_hmac=NULL,code_expires_at=NULL,failed_attempts=0,failure_window_started_at=NULL,locked_until=NULL,updated_at=?
    WHERE reader_id=? AND version=? AND code_hmac=? AND must_change_pin=1 AND status='active' AND code_expires_at>? AND ${guard.sql}`).bind(now,credential.reader_id,credential.credential_version,presented,now,...guard.bindings),requireChanged(db,1),
   db.prepare("UPDATE reader_pin_setup_grants SET revoked_at=? WHERE reader_id=? AND consumed_at IS NULL AND revoked_at IS NULL").bind(now,credential.reader_id),
   db.prepare("INSERT INTO reader_pin_setup_grants(token_hash,reader_id,credential_version,expires_at,created_at) VALUES(?,?,?,?,?)").bind(setupHash,credential.reader_id,credential.credential_version,expiresAt,now),
   db.prepare("DELETE FROM reader_auth_limits WHERE scope_hash IN (?,?)").bind(rate.pair.hash,rate.reader.hash),cleanupLimits(db,nowDate),
  ]);}catch{if(await blocked(db,limits,nowDate))readerFail("reader_rate_limit","Забагато спроб входу. Спробуйте пізніше.",429);readerFail("invalid_reader_credentials","Не вдалося увійти. Перевірте обраний профіль і код.",401);}
  return {kind:"setup",setupToken,expiresAt};
 }
 const token=opaqueToken(),tokenHash=await sha256Text(token),expiresAt=new Date(nowDate.getTime()+SESSION_TTL_MS).toISOString();
 try{await readerBatch(db,[
  db.prepare(`UPDATE reader_credentials SET failed_attempts=0,failure_window_started_at=NULL,locked_until=NULL,last_login_at=?,updated_at=?
   WHERE reader_id=? AND version=? AND code_hmac=? AND status='active' AND must_change_pin=0 AND ${guard.sql}`).bind(now,now,credential.reader_id,credential.credential_version,presented,...guard.bindings),requireChanged(db,1),
  pruneWebSessions(db,credential.reader_id,now),
  db.prepare("INSERT INTO reader_sessions(token_hash,reader_id,access_version,credential_version,telegram_user_id,created_at,expires_at) VALUES(?,?,?,?,NULL,?,?)").bind(tokenHash,credential.reader_id,credential.access_version,credential.credential_version,now,expiresAt),
  db.prepare("DELETE FROM reader_auth_limits WHERE scope_hash IN (?,?)").bind(rate.pair.hash,rate.reader.hash),cleanupLimits(db,nowDate)]);}catch{if(await blocked(db,limits,nowDate))readerFail("reader_rate_limit","Забагато спроб входу. Спробуйте пізніше.",429);readerFail("invalid_reader_credentials","Не вдалося увійти. Перевірте обраний профіль і код.",401);}
 return {kind:"session",token,expiresAt};
}

export async function completeReaderPinSetup(db:ReaderDatabase,input:{setupToken:string;pin:string;pinConfirm:string}){
 const chosen=pin(input.pin),confirm=pin(input.pinConfirm);if(!chosen||chosen!==confirm)readerFail("reader_pin","Введіть однаковий 4-значний PIN у двох полях.");
 const token=typeof input.setupToken==="string"?input.setupToken.trim():"";if(!/^[0-9a-f]{64}$/u.test(token))readerFail("reader_setup_invalid","Час створення PIN минув. Почніть вхід ще раз.",401);
 const hash=await sha256Text(token),nowDate=new Date(),now=nowDate.toISOString();
 const row=await db.prepare(`SELECT g.reader_id,g.credential_version,c.version current_credential_version,r.access_version,r.version reader_version
  FROM reader_pin_setup_grants g JOIN reader_credentials c ON c.reader_id=g.reader_id JOIN library_readers r ON r.id=g.reader_id
  WHERE g.token_hash=? AND g.expires_at>? AND g.consumed_at IS NULL AND g.revoked_at IS NULL AND g.credential_version=c.version
   AND c.status='active' AND c.must_change_pin=1 AND r.kind='student' AND r.status='active' AND r.access_status!='blocked' AND r.linked_teacher_user_id IS NULL LIMIT 1`).bind(hash,now).first();
 if(!row)readerFail("reader_setup_invalid","Час створення PIN минув. Почніть вхід ще раз.",401);
 const readerId=String(row.reader_id),credentialVersion=Number(row.current_credential_version),nextCredentialVersion=credentialVersion+1,accessVersion=Number(row.access_version),newHmac=await hmacHex(`reader-pin:${readerId}:${chosen}`),session=opaqueToken(),sessionHash=await sha256Text(session),expiresAt=new Date(nowDate.getTime()+SESSION_TTL_MS).toISOString();
 await readerBatch(db,[
  db.prepare("UPDATE reader_pin_setup_grants SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?").bind(now,hash,now),requireChanged(db,1),
  db.prepare("UPDATE reader_credentials SET code_hmac=?,must_change_pin=0,status='active',version=version+1,failed_attempts=0,failure_window_started_at=NULL,locked_until=NULL,code_expires_at=NULL,last_login_at=?,updated_at=? WHERE reader_id=? AND version=? AND status='active' AND must_change_pin=1").bind(newHmac,now,now,readerId,credentialVersion),requireChanged(db,1),
  db.prepare("UPDATE library_readers SET access_status='active',version=version+1,updated_at=? WHERE id=? AND version=? AND kind='student' AND status='active' AND access_status!='blocked' AND linked_teacher_user_id IS NULL").bind(now,readerId,Number(row.reader_version)),requireChanged(db,1),
  db.prepare("UPDATE reader_sessions SET revoked_at=? WHERE reader_id=? AND telegram_user_id IS NULL AND revoked_at IS NULL").bind(now,readerId),
  db.prepare("UPDATE reader_invites SET revoked_at=? WHERE reader_id=? AND purpose='web' AND consumed_at IS NULL AND revoked_at IS NULL").bind(now,readerId),
  db.prepare("UPDATE reader_pin_setup_grants SET revoked_at=? WHERE reader_id=? AND token_hash!=? AND consumed_at IS NULL AND revoked_at IS NULL").bind(now,readerId,hash),
  db.prepare("INSERT INTO reader_profiles(reader_id,display_name,updated_at) VALUES(?,'Читач',?) ON CONFLICT(reader_id) DO NOTHING").bind(readerId,now),
  db.prepare("INSERT INTO reader_sessions(token_hash,reader_id,access_version,credential_version,telegram_user_id,created_at,expires_at) VALUES(?,?,?,?,NULL,?,?)").bind(sessionHash,readerId,accessVersion,nextCredentialVersion,now,expiresAt),
 ]);return {token:session,expiresAt};
}

export async function redeemReaderWebInviteWithPin(db:ReaderDatabase,input:{token:string;pin:string;pinConfirm:string}){
 const chosen=pin(input.pin),confirm=pin(input.pinConfirm);if(!chosen||chosen!==confirm)readerFail("reader_pin","Введіть однаковий 4-значний PIN у двох полях.");
 if(!/^[0-9a-f]{48}$/u.test(input.token))readerFail("invite_invalid","Запрошення недійсне або вже використане.",401);
 const hash=await sha256Text(input.token),nowDate=new Date(),now=nowDate.toISOString();
 const row=await db.prepare(`SELECT i.reader_id,i.access_version,c.version credential_version,r.version reader_version
  FROM reader_invites i JOIN library_readers r ON r.id=i.reader_id JOIN reader_credentials c ON c.reader_id=r.id
  WHERE i.token_hash=? AND i.purpose='web' AND i.expires_at>? AND i.consumed_at IS NULL AND i.revoked_at IS NULL
   AND i.access_version=r.access_version AND r.kind='student' AND r.status='active' AND r.access_status!='blocked' AND r.linked_teacher_user_id IS NULL LIMIT 1`).bind(hash,now).first();
 if(!row)readerFail("invite_invalid","Запрошення недійсне або вже використане. Зверніться до бібліотекаря.",401);
 const readerId=String(row.reader_id),accessVersion=Number(row.access_version),credentialVersion=Number(row.credential_version),nextCredentialVersion=credentialVersion+1,newHmac=await hmacHex(`reader-pin:${readerId}:${chosen}`),session=opaqueToken(),sessionHash=await sha256Text(session),expiresAt=new Date(nowDate.getTime()+SESSION_TTL_MS).toISOString();
 await readerBatch(db,[
  db.prepare("UPDATE reader_invites SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?").bind(now,hash,now),requireChanged(db,1),
  db.prepare("UPDATE reader_credentials SET code_hmac=?,must_change_pin=0,status='active',version=version+1,failed_attempts=0,failure_window_started_at=NULL,locked_until=NULL,code_expires_at=NULL,last_login_at=?,updated_at=? WHERE reader_id=? AND version=?").bind(newHmac,now,now,readerId,credentialVersion),requireChanged(db,1),
  db.prepare("UPDATE library_readers SET access_status='active',version=version+1,updated_at=? WHERE id=? AND version=? AND kind='student' AND status='active' AND access_status!='blocked'").bind(now,readerId,Number(row.reader_version)),requireChanged(db,1),
  db.prepare("UPDATE reader_sessions SET revoked_at=? WHERE reader_id=? AND telegram_user_id IS NULL AND revoked_at IS NULL").bind(now,readerId),
  db.prepare("UPDATE reader_invites SET revoked_at=? WHERE reader_id=? AND purpose='web' AND token_hash!=? AND consumed_at IS NULL AND revoked_at IS NULL").bind(now,readerId,hash),
  db.prepare("UPDATE reader_pin_setup_grants SET revoked_at=? WHERE reader_id=? AND consumed_at IS NULL AND revoked_at IS NULL").bind(now,readerId),
  db.prepare("INSERT INTO reader_profiles(reader_id,display_name,updated_at) VALUES(?,'Читач',?) ON CONFLICT(reader_id) DO NOTHING").bind(readerId,now),
  db.prepare("INSERT INTO reader_sessions(token_hash,reader_id,access_version,credential_version,telegram_user_id,created_at,expires_at) VALUES(?,?,?,?,NULL,?,?)").bind(sessionHash,readerId,accessVersion,nextCredentialVersion,now,expiresAt),
 ]);return {token:session,expiresAt};
}

export async function issueReaderWebAccess(db:ReaderDatabase,actor:LibraryActor,input:{readerId:string;expectedVersion:number;confirmation:string}){
 if(input.confirmation!=="CREATE_READER_WEB_ACCESS"||!Number.isInteger(input.expectedVersion)||input.expectedVersion<1)readerFail("reader_access","Оновіть картку читача та повторіть дію.");
 const row=await db.prepare(`SELECT r.id,r.version,r.access_version,c.version credential_version FROM library_readers r JOIN reader_credentials c ON c.reader_id=r.id
  WHERE r.id=? AND r.version=? AND r.kind='student' AND r.status='active' AND r.access_status!='blocked' AND r.linked_teacher_user_id IS NULL LIMIT 1`).bind(input.readerId,input.expectedVersion).first();
 if(!row)readerFail("reader_changed","Учня не знайдено або його дані змінилися.",409);
 const code=randomCode(),codeHmac=await hmacHex(`reader-temp:${input.readerId}:${code}`),token=opaqueToken(24),tokenHash=await sha256Text(token),nowDate=new Date(),now=nowDate.toISOString(),expiresAt=new Date(nowDate.getTime()+CODE_TTL_MS).toISOString(),nextCredentialVersion=Number(row.credential_version)+1;
 await readerBatch(db,[
  db.prepare("UPDATE reader_credentials SET code_hmac=?,must_change_pin=1,status='active',version=version+1,failed_attempts=0,failure_window_started_at=NULL,locked_until=NULL,code_expires_at=?,updated_at=? WHERE reader_id=? AND version=?").bind(codeHmac,expiresAt,now,input.readerId,Number(row.credential_version)),requireChanged(db,1),
  db.prepare("UPDATE library_readers SET access_status='active',version=version+1,updated_at=? WHERE id=? AND version=? AND kind='student' AND status='active' AND access_status!='blocked'").bind(now,input.readerId,input.expectedVersion),requireChanged(db,1),
  db.prepare("UPDATE reader_sessions SET revoked_at=? WHERE reader_id=? AND telegram_user_id IS NULL AND revoked_at IS NULL").bind(now,input.readerId),
  db.prepare("UPDATE reader_invites SET revoked_at=? WHERE reader_id=? AND purpose='web' AND consumed_at IS NULL AND revoked_at IS NULL").bind(now,input.readerId),
  db.prepare("UPDATE reader_pin_setup_grants SET revoked_at=? WHERE reader_id=? AND consumed_at IS NULL AND revoked_at IS NULL").bind(now,input.readerId),
  db.prepare("INSERT INTO reader_invites(token_hash,reader_id,access_version,purpose,expires_at,created_at,created_by) VALUES(?,?,?,'web',?,?,?)").bind(tokenHash,input.readerId,Number(row.access_version),expiresAt,now,actor.id),
  db.prepare("INSERT INTO audit_events(id,actor_user_id,actor_email,action,entity_type,entity_id,metadata_json,created_at) VALUES(?,?,?,'reader_web_access','library_reader',?,?,?)").bind(crypto.randomUUID(),actor.id,actor.email,input.readerId,JSON.stringify({expiresAt,credentialVersion:nextCredentialVersion}),now),
 ]);return {code,token,expiresAt,readerVersion:input.expectedVersion+1,credentialVersion:nextCredentialVersion};
}
