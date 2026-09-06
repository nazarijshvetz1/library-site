import {env} from "cloudflare:workers";
import {coverBucket,jpegDimensions} from "@/lib/cover-storage";
import {requireReaderSession} from "@/lib/reader-auth";
import {readerApiError,readerJson,readerWriteBody} from "@/lib/reader-api";
import {readerBatch,readerFail,readerReceipt,readerReplay,requireChanged,type ReaderDatabase} from "@/lib/reader-core";
import {cleanReaderPhotos} from "@/lib/reader-photo-cleanup";
export const dynamic="force-dynamic";
export async function GET(request:Request){try{const db=env.DB as unknown as ReaderDatabase,identity=await requireReaderSession(db,request);
  const profile=await db.prepare("SELECT photo_key FROM reader_profiles WHERE reader_id=?").bind(identity.readerId).first();
  const key=profile?.photo_key;if(typeof key!=="string"||!key.startsWith("reader-photos/"+identity.readerId+"/"))return new Response(null,{status:404,headers:{"Cache-Control":"private, no-store"}});
  const file=await coverBucket()?.get(key);if(!file)return new Response(null,{status:404,headers:{"Cache-Control":"private, no-store"}});
  return new Response(file.body,{headers:{"Content-Type":"image/jpeg","Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Cross-Origin-Resource-Policy":"same-origin"}});
}catch(error){return readerApiError(error);}}
export async function POST(request:Request){try{const db=env.DB as unknown as ReaderDatabase,identity=await requireReaderSession(db,request),body=await readerWriteBody(request,1300000);
  if(Object.keys(body).sort().join(",")!==["requestId","expectedVersion","base64"].sort().join(",")||typeof body.base64!=="string"||!Number.isInteger(body.expectedVersion)||Number(body.expectedVersion)<1||!/^[A-Za-z0-9+/]+={0,2}$/.test(body.base64))readerFail("photo_invalid","Оберіть фото через форму профілю.");
  const bytes=Uint8Array.from(atob(body.base64),char=>char.charCodeAt(0));
  const dimensions=jpegDimensions(bytes);if(bytes.length>900*1024||!dimensions||dimensions.width>600||dimensions.height>900)readerFail("photo_invalid","Потрібне підготовлене JPEG-фото до 900 КБ та 600 × 900 пікселів.");
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),byte=>byte.toString(16).padStart(2,"0")).join("");
  const input={expectedVersion:body.expectedVersion,sha256:hash},requestId=String(body.requestId),replay=await readerReplay(db,identity,requestId,"photo",input);if(replay.replayed)return readerJson({success:true,result:replay.replayed});
  const bucket=coverBucket();if(!bucket)readerFail("photo_storage","Сховище фото тимчасово недоступне.",503);
  const previous=await db.prepare("SELECT photo_key,version FROM reader_profiles WHERE reader_id=?").bind(identity.readerId).first();
  if(Number(previous?.version)!==Number(body.expectedVersion))readerFail("photo_version","Профіль змінився. Оновіть сторінку перед завантаженням фото.",409);
  const key=`reader-photos/${identity.readerId}/${crypto.randomUUID()}.jpg`,now=new Date().toISOString(),result={version:Number(body.expectedVersion)+1};
  await db.batch([db.prepare("INSERT INTO reader_photo_cleanup(key,not_before,created_at) VALUES(?,?,?)").bind(key,new Date(Date.now()+86400000).toISOString(),now)]);
  await bucket.put(key,bytes.buffer,{httpMetadata:{contentType:"image/jpeg"},customMetadata:{readerId:identity.readerId,sha256:hash}});
  await readerBatch(db,[readerReceipt(db,identity,requestId,"photo",replay.hash,result,now),db.prepare("INSERT OR IGNORE INTO reader_photo_cleanup(key,not_before,created_at) SELECT photo_key,?,? FROM reader_profiles WHERE reader_id=? AND photo_key IS NOT NULL").bind(now,now,identity.readerId),db.prepare("UPDATE reader_profiles SET photo_key=?,photo_mime='image/jpeg',version=version+1,updated_at=? WHERE reader_id=? AND version=?").bind(key,now,identity.readerId,Number(body.expectedVersion)),requireChanged(db,1),db.prepare("DELETE FROM reader_photo_cleanup WHERE key=?").bind(key)]);
  await cleanReaderPhotos(db,bucket);
  return readerJson({success:true,result});
}catch(error){return readerApiError(error);}}
export async function DELETE(request:Request){try{const db=env.DB as unknown as ReaderDatabase,identity=await requireReaderSession(db,request),body=await readerWriteBody(request);
  if(Object.keys(body).sort().join(",")!=="expectedVersion,requestId"||!Number.isInteger(body.expectedVersion)||Number(body.expectedVersion)<1)readerFail("photo_invalid","Оновіть профіль.");
  const requestId=String(body.requestId),replay=await readerReplay(db,identity,requestId,"photo_remove",body);if(replay.replayed)return readerJson({success:true,result:replay.replayed});
  const now=new Date().toISOString(),result={version:Number(body.expectedVersion)+1};
  await readerBatch(db,[readerReceipt(db,identity,requestId,"photo_remove",replay.hash,result,now),db.prepare("INSERT OR IGNORE INTO reader_photo_cleanup(key,not_before,created_at) SELECT photo_key,?,? FROM reader_profiles WHERE reader_id=? AND photo_key IS NOT NULL").bind(now,now,identity.readerId),db.prepare("UPDATE reader_profiles SET photo_key=NULL,photo_mime=NULL,version=version+1,updated_at=? WHERE reader_id=? AND version=?").bind(now,identity.readerId,Number(body.expectedVersion)),requireChanged(db,1)]);
  const bucket=coverBucket();if(bucket)await cleanReaderPhotos(db,bucket);
  return readerJson({success:true,result});
}catch(error){return readerApiError(error);}}
