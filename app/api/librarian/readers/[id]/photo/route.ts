import {env} from 'cloudflare:workers';
import {authorizeLibrarianApi} from '@/lib/librarian-api';
import {coverBucket} from '@/lib/cover-storage';
import type {ReaderDatabase} from '@/lib/reader-core';
export const dynamic='force-dynamic';
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){const auth=await authorizeLibrarianApi();if(!auth.ok)return auth.response;const {id}=await params;if(!/^[A-Za-z0-9_-]{1,100}$/.test(id))return new Response(null,{status:404});const row=await (env.DB as unknown as ReaderDatabase).prepare('SELECT photo_key FROM reader_profiles WHERE reader_id=?').bind(id).first();if(!row?.photo_key)return new Response(null,{status:404});const key=String(row.photo_key);if(!key.startsWith('reader-photos/'+id+'/'))return new Response(null,{status:404});const file=await coverBucket()?.get(key);if(!file)return new Response(null,{status:404});return new Response(file.body,{headers:{'Content-Type':'image/jpeg','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'}});}
