import {env} from "cloudflare:workers";
import {redirect} from "next/navigation";
import {LIBRARIKA_CATALOG_URL,librarikaBookUrl} from "@/lib/librarika";
import type {ReaderDatabase} from "@/lib/reader-core";

export const dynamic="force-dynamic";

export default async function LibraryPage({searchParams}:{searchParams:Promise<{book?:string|string[]}>}){
  const value=(await searchParams).book;
  const editionId=Array.isArray(value)?value[0]:value;
  let destination:string|null=null;
  if(editionId&&/^[A-Za-z0-9_-]{1,100}$/.test(editionId)){
    try{
      const row=await (env.DB as unknown as ReaderDatabase).prepare("SELECT source_media_id FROM library_editions WHERE id=? LIMIT 1").bind(editionId).first();
      destination=librarikaBookUrl(row?.source_media_id);
    }catch{destination=null;}
  }
  if(destination)redirect(destination);
  redirect(LIBRARIKA_CATALOG_URL);
}
