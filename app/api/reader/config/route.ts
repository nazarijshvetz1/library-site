import {telegramMiniAppPublicConfiguration} from "@/lib/telegram-mini-app-auth";
import {readerJson} from "@/lib/reader-api";
export const dynamic="force-dynamic";
export async function GET(){return readerJson({success:true,telegram:telegramMiniAppPublicConfiguration()});}
