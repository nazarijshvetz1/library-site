import {env} from 'cloudflare:workers';
import {requireReaderSession} from '@/lib/reader-auth';
import {communityReaderProfile} from '@/lib/reader-community-profile';
import {readerPhotoAsset} from '@/lib/reader-teacher-directory';
import {coverBucket} from '@/lib/cover-storage';
import {readerApiError,readerJson} from '@/lib/reader-api';
import type {ReaderDatabase} from '@/lib/reader-core';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{
 const db=env.DB as unknown as ReaderDatabase,who=await requireReaderSession(db,request),u=new URL(request.url),id=u.searchParams.get('id')||'';
 const profile=await communityReaderProfile(db,who,id);
 if(u.searchParams.get('photo')==='1'){
  const asset=await readerPhotoAsset(db,id),file=asset?await coverBucket()?.get(asset.storageKey):null;
  return file?new Response(file.body,{headers:{'Content-Type':asset!.mimeType,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'}}):new Response(null,{status:404});
 }
 return readerJson({success:true,result:profile});
}catch(e){return readerApiError(e);}}
