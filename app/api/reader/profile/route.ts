import {env} from "cloudflare:workers";
import {requireReaderSession} from "@/lib/reader-auth";
import {getReaderProfile,updateReaderProfile} from "@/lib/reader-profile-store";
import {readerApiError,readerJson,readerWriteBody} from "@/lib/reader-api";
import type {ReaderDatabase} from "@/lib/reader-core";
export const dynamic="force-dynamic";
export async function GET(request:Request){try{const db=env.DB as unknown as ReaderDatabase;return readerJson({success:true,profile:await getReaderProfile(db,await requireReaderSession(db,request))});}catch(error){return readerApiError(error);}}
export async function PATCH(request:Request){try{const body=await readerWriteBody(request),db=env.DB as unknown as ReaderDatabase,identity=await requireReaderSession(db,request);await updateReaderProfile(db,identity,body as Parameters<typeof updateReaderProfile>[2]);return readerJson({success:true,profile:await getReaderProfile(db,identity)});}catch(error){return readerApiError(error);}}
