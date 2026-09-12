import {readerPhotoAsset} from '@/lib/reader-teacher-directory';
import {env} from 'cloudflare:workers';
import {authorizeLibrarianApi} from '@/lib/librarian-api';
import {coverBucket} from '@/lib/cover-storage';
import type {ReaderDatabase} from '@/lib/reader-core';
export const dynamic='force-dynamic';
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){const auth=await authorizeLibrarianApi();if(!auth.ok)return auth.response;const {id}=await params;if(!/^[A-Za-z0-9_-]{1,100}$/.test(id))return new Response(null,{status:404});const asset=await readerPhotoAsset(env.DB as unknown as ReaderDatabase,id);if(!asset)return new Response(null,{status:404,headers:{'Cache-Control':'private, no-store'}});const key=asset.storageKey;const file=await coverBucket()?.get(key);if(!file)return new Response(null,{status:404});return new Response(file.body,{headers:{'Content-Type':asset.mimeType,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'}});}
