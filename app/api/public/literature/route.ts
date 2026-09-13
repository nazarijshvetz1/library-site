import {env} from 'cloudflare:workers';
import {cabinetCatalog,cabinetEntities,cabinetEntity,cabinetPublicBook} from '@/lib/reader-cabinet-catalog';
import {readerJson,readerApiError} from '@/lib/reader-api';
import {readerFail,type ReaderDatabase} from '@/lib/reader-core';
export const dynamic='force-dynamic';
// Only published bibliographic projections; no readers, reviews, loans, or source data.
export async function GET(request:Request){try{const db=env.DB as unknown as ReaderDatabase,u=new URL(request.url),view=u.searchParams.get('view')||'catalog';
 const result=view==='catalog'?await cabinetCatalog(db,u):view==='entities'?await cabinetEntities(db,u):view==='entity'?await cabinetEntity(db,u):view==='book'?{book:await cabinetPublicBook(db,u.searchParams.get('id')||'')}:readerFail('view','Розділ недоступний.',404);
 return readerJson({success:true,result});}catch(e){return readerApiError(e);}}
