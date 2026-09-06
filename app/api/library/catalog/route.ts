import {env} from "cloudflare:workers";
import {getReaderCatalogBook,getReaderCatalogEntity,listReaderCatalog,readerCatalogFacets,scanReaderCatalog} from "@/lib/library-reader-catalog";
import {readerApiError,readerJson} from "@/lib/reader-api";
import type {ReaderDatabase} from "@/lib/reader-core";
export const dynamic="force-dynamic";
export async function GET(request:Request){try{const url=new URL(request.url),db=env.DB as unknown as ReaderDatabase;let result:unknown;
  if(url.searchParams.has("book"))result=await getReaderCatalogBook(db,url.searchParams.get("book")||"");
  else if(url.searchParams.has("entity"))result=await getReaderCatalogEntity(db,url.searchParams.get("entity")||"");
  else if(url.searchParams.has("scan"))result=await scanReaderCatalog(db,url.searchParams.get("scan")||"");
  else if(url.searchParams.has("facets"))result=await readerCatalogFacets(db);
  else result=await listReaderCatalog(db,url);
  return readerJson({success:true,result});
}catch(error){return readerApiError(error);}}
