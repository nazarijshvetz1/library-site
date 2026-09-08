import {env} from "cloudflare:workers";
import {authorizeLibrarianApi,isSameOriginRequest,librarianError,librarianJson} from "@/lib/librarian-api";
import {readBoundedJson} from "@/lib/bounded-json";
import {ReaderError,type ReaderDatabase} from "@/lib/reader-core";
import {applyLibrarikaMemberSync,librarikaMemberSyncStatus,previewLibrarikaMemberSync,stageLibrarikaMemberSync,startLibrarikaMemberSync} from "@/lib/librarika-member-sync";

export const dynamic="force-dynamic";

export async function GET(){
  const auth=await authorizeLibrarianApi();if(!auth.ok)return auth.response;
  try{return librarianJson({success:true,result:await librarikaMemberSyncStatus(env.DB as unknown as ReaderDatabase)});}catch(error){return failure(error);}
}

export async function POST(request:Request){
  const auth=await authorizeLibrarianApi();if(!auth.ok)return auth.response;
  if(auth.value.access.role!=="admin"||!auth.value.access.writesEnabled||!auth.value.user.d1UserId)return librarianError(403,"admin_required","Синхронізація доступна адміністратору з увімкненим записом.",false);
  if(!isSameOriginRequest(request))return librarianError(403,"origin","Запит має надійти з цього сайту.",true);
  try{
    const body=await readBoundedJson(request,420000),input=body.input;
    if(!input||typeof input!=="object"||Array.isArray(input))return librarianError(400,"sync_input","Некоректні дані синхронізації.",true);
    const db=env.DB as unknown as ReaderDatabase,actor={id:auth.value.user.d1UserId,email:auth.value.user.email||""};let result:unknown;
    if(body.action==="start")result=await startLibrarikaMemberSync(db,actor,input as Parameters<typeof startLibrarikaMemberSync>[2]);
    else if(body.action==="stage")result=await stageLibrarikaMemberSync(db,actor,input as Parameters<typeof stageLibrarikaMemberSync>[2]);
    else if(body.action==="preview")result=await previewLibrarikaMemberSync(db,actor,input as Parameters<typeof previewLibrarikaMemberSync>[2]);
    else if(body.action==="apply")result=await applyLibrarikaMemberSync(db,actor,input as Parameters<typeof applyLibrarikaMemberSync>[2]);
    else return librarianError(400,"sync_action","Невідома дія синхронізації.",true);
    return librarianJson({success:true,result});
  }catch(error){return failure(error);}
}

function failure(error:unknown){return error instanceof ReaderError?librarianError(error.status,error.code,error.message,true):librarianError(503,"librarika_sync_unavailable","Не вдалося підтвердити синхронізацію. Дані не видалено; оновіть сторінку й повторіть той самий запуск.",true);}
