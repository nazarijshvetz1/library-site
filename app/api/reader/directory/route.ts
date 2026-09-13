import {env} from "cloudflare:workers";
import {readerApiError,readerJson} from "@/lib/reader-api";
import {type ReaderDatabase} from "@/lib/reader-core";
import {listReaderDirectory} from "@/lib/reader-pin-auth";

export const dynamic="force-dynamic";
export async function GET(request:Request){
 try{
  const query=new URL(request.url).searchParams.get("q")||"";
  return readerJson({success:true,items:await listReaderDirectory(env.DB as unknown as ReaderDatabase,query,request)});
 }catch(error){return readerApiError(error);}
}
