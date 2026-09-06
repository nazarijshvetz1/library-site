import {env} from 'cloudflare:workers';
import {authorizeLibrarianApi,isSameOriginRequest,librarianJson,librarianError} from '@/lib/librarian-api';
import {readBoundedJson} from '@/lib/bounded-json';
import {coverBucket} from '@/lib/cover-storage';
import {importLibrarikaCover} from '@/lib/librarika-cover-import';
import {ReaderError,type ReaderDatabase} from '@/lib/reader-core';
export const dynamic='force-dynamic';
export async function POST(request:Request){const auth=await authorizeLibrarianApi();if(!auth.ok)return auth.response;if(auth.value.access.role!=='admin'||!auth.value.access.writesEnabled||!auth.value.user.d1UserId)return librarianError(403,'admin_required','Потрібен активний доступ адміністратора до запису.',false);if(!isSameOriginRequest(request))return librarianError(403,'origin','Запит має бути з цього сайту.',true);try{const input=await readBoundedJson(request,12*1024*1024+1024),bucket=coverBucket();if(!bucket)return librarianError(503,'storage_missing','Сховище обкладинок недоступне.',true);return librarianJson({success:true,result:await importLibrarikaCover(env.DB as unknown as ReaderDatabase,bucket,{id:auth.value.user.d1UserId,email:auth.value.user.email||''},input as Parameters<typeof importLibrarikaCover>[3])});}catch(e){return e instanceof ReaderError?librarianError(e.status,e.code,e.message,true):librarianError(503,'cover_import_failed','Не вдалося підтвердити обкладинку. Повтор тієї самої обкладинки безпечний.',true);}}
