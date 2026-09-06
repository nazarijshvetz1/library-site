import {env} from "cloudflare:workers";
import {requireReaderSession} from "@/lib/reader-auth";
import {readerApiError,readerJson,readerWriteBody} from "@/lib/reader-api";
import {readerFail,type ReaderDatabase} from "@/lib/reader-core";
import * as community from "@/lib/reader-community";
export const dynamic="force-dynamic";
export async function GET(request:Request){try{const db=env.DB as unknown as ReaderDatabase,identity=await requireReaderSession(db,request),url=new URL(request.url);let result:unknown;
  if(url.searchParams.has("blocks")){await community.requireReaderCommunity(db,identity.readerId);result=(await db.prepare("SELECT b.blocked_reader_id AS id,p.display_name FROM reader_blocks b JOIN reader_profiles p ON p.reader_id=b.blocked_reader_id WHERE b.reader_id=? ORDER BY b.created_at DESC LIMIT 500").bind(identity.readerId).all()).results||[];}
  else if(url.searchParams.has("q"))result=await community.findCommunityReaders(db,identity,url.searchParams.get("q")||"");
  else if(url.searchParams.has("thread"))result=await community.getReadingMessages(db,identity,url.searchParams.get("thread")||"");
  else result=await community.listReadingThreads(db,identity);return readerJson({success:true,result});
}catch(error){return readerApiError(error);}}
export async function POST(request:Request){try{const body=await readerWriteBody(request),db=env.DB as unknown as ReaderDatabase,identity=await requireReaderSession(db,request);let result:unknown;
  const input=body.input;
  if(!input||typeof input!=="object"||Array.isArray(input))readerFail("community_input","Некоректна дія спільноти.");
  if(body.action==="create")result=await community.createReadingThread(db,identity,input as Parameters<typeof community.createReadingThread>[2]);
  else if(body.action==="join")result=await community.joinBookDiscussion(db,identity,input as Parameters<typeof community.joinBookDiscussion>[2]);
  else if(body.action==="respond")result=await community.respondReadingInvite(db,identity,input as Parameters<typeof community.respondReadingInvite>[2]);
  else if(body.action==="invite")result=await community.inviteReadingMember(db,identity,input as Parameters<typeof community.inviteReadingMember>[2]);
  else if(body.action==="message")result=await community.sendReadingMessage(db,identity,input as Parameters<typeof community.sendReadingMessage>[2]);
  else if(body.action==="block")result=await community.blockCommunityReader(db,identity,input as Parameters<typeof community.blockCommunityReader>[2]);
  else if(body.action==="report")result=await community.reportReadingMessage(db,identity,input as Parameters<typeof community.reportReadingMessage>[2]);
  else if(body.action==="leave")result=await community.leaveReadingThread(db,identity,input as Parameters<typeof community.leaveReadingThread>[2]);
  else readerFail("community_action","Невідома дія спільноти.");return readerJson({success:true,result});
}catch(error){return readerApiError(error);}}
