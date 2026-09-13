import {env} from 'cloudflare:workers';
import {requireReaderSession} from '@/lib/reader-auth';
import {readerApiError,readerJson,readerWriteBody} from '@/lib/reader-api';
import {changeReaderTelegram} from '@/lib/reader-telegram-channel';
import {getReaderProfile} from '@/lib/reader-profile-store';
import type {ReaderDatabase} from '@/lib/reader-core';
export async function POST(request:Request){try{const db=env.DB as unknown as ReaderDatabase,who=await requireReaderSession(db,request),body=await readerWriteBody(request),result=await changeReaderTelegram(db,who,body as any);return readerJson({success:true,result,profile:await getReaderProfile(db,who)});}catch(e){return readerApiError(e);}}
