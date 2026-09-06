import {env} from "cloudflare:workers";
import {requireReaderSession} from "@/lib/reader-auth";
import {cancelReaderBookRequest,getReaderBooks,getReaderBookState,requestReaderBook,saveReaderRating,setReaderBookSubscription} from "@/lib/reader-profile-store";
import {readerApiError,readerJson,readerWriteBody} from "@/lib/reader-api";
import {readerFail,type ReaderDatabase} from "@/lib/reader-core";
export const dynamic="force-dynamic";
export async function GET(request:Request){try{const db=env.DB as unknown as ReaderDatabase,identity=await requireReaderSession(db,request),edition=new URL(request.url).searchParams.get("edition");return readerJson({success:true,...(edition?await getReaderBookState(db,identity,edition):await getReaderBooks(db,identity))});}catch(error){return readerApiError(error);}}
export async function POST(request:Request){try{const body=await readerWriteBody(request),db=env.DB as unknown as ReaderDatabase,identity=await requireReaderSession(db,request);let result:unknown;
  if(body.action==="request")result=await requestReaderBook(db,identity,body.input as Parameters<typeof requestReaderBook>[2]);
  else if(body.action==="cancel")result=await cancelReaderBookRequest(db,identity,body.input as Parameters<typeof cancelReaderBookRequest>[2]);
  else if(body.action==="rating")result=await saveReaderRating(db,identity,body.input as Parameters<typeof saveReaderRating>[2]);
  else if(body.action==="subscribe")result=await setReaderBookSubscription(db,identity,body.input as Parameters<typeof setReaderBookSubscription>[2]);
  else readerFail("action_invalid","Невідома дія.");
  return readerJson({success:true,result});
}catch(error){return readerApiError(error);}}
