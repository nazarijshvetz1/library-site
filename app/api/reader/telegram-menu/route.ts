import {env} from 'cloudflare:workers';
import {requireReaderSession} from '@/lib/reader-auth';
import {readerJson,readerApiError,readerWriteBody,limitReaderAuth} from '@/lib/reader-api';
import {readerFail,type ReaderDatabase} from '@/lib/reader-core';
import {getRuntimeString} from '@/lib/runtime-env';
import {telegramApiRequest} from '@/lib/telegram-notifications';
import {readerTelegramKeyboard} from '@/lib/reader-telegram';
export const dynamic='force-dynamic';
export async function POST(request:Request){try{
 const db=env.DB as unknown as ReaderDatabase,who=await requireReaderSession(db,request);
 await readerWriteBody(request);await limitReaderAuth(db,request);
 const row=await db.prepare(`SELECT coalesce(tc.chat_id,rc.chat_id) chat_id FROM library_readers r
 LEFT JOIN reader_telegram_connections rc ON rc.reader_id=r.id AND rc.status='active'
 LEFT JOIN telegram_connections tc ON tc.user_id=r.linked_teacher_user_id AND tc.status='active' WHERE r.id=?`).bind(who.readerId).first();
 const token=getRuntimeString('TELEGRAM_BOT_TOKEN');if(!row?.chat_id||!token)readerFail('telegram_unavailable','Меню доступне після приєднання Telegram.',409);
 const origin=new URL(request.url).origin,keyboard=readerTelegramKeyboard(origin);
 keyboard.push([{text:'↩️ Змінити кабінет',web_app:{url:origin+'/telegram/cabinets'}}]);
 await telegramApiRequest(token,'sendMessage',{chat_id:String(row.chat_id),text:'Читацький кабінет приєднано. Оберіть потрібний розділ:',reply_markup:{inline_keyboard:keyboard}},fetch);
 await telegramApiRequest(token,'setChatMenuButton',{chat_id:String(row.chat_id),menu_button:{type:'web_app',text:'Кабінети',web_app:{url:origin+'/telegram/cabinets'}}},fetch).catch(()=>{});
 return readerJson({success:true});
 }catch(e){return readerApiError(e);}}
