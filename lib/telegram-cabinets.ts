import type {ReaderDatabase} from './reader-core.ts';
export async function processCabinetSelection(db:ReaderDatabase,input:{message:{chatId:string;telegramUserId:string;text:string};updateId:string;payloadHash:string;origin:string;botUsername:string|null;miniAppEnabled?:boolean;send:(body:Record<string,unknown>)=>Promise<unknown>}){
 if(!/^\/(start|menu|cabinet|cabinets|help)(?:@[A-Za-z0-9_]+)?$/.test(input.message.text.trim()))return null;
 const old=await db.prepare('SELECT payload_hash FROM telegram_webhook_updates WHERE update_id=?').bind(input.updateId).first();
 if(old)return {outcome:'cabinet_selector',duplicate:true};
 await db.batch([db.prepare("INSERT INTO telegram_webhook_updates(update_id,payload_hash,outcome,processed_at) VALUES(?,?,'cabinet_selector',?)").bind(input.updateId,input.payloadHash,new Date().toISOString())]);
 const button=(text:string,path:string)=>({text,...(input.miniAppEnabled!==false?{web_app:{url:new URL(path,input.origin).toString()}}:{url:new URL(path.replace("/librarian/telegram","/librarian").replace("/teacher/telegram","/teacher").replace("/reader/telegram","/reader"),input.origin).toString()})});
 const teacher=input.botUsername?{text:'🎓 Кабінет учителя',url:'https://t.me/'+input.botUsername+'?start=teacher'}:button('🎓 Кабінет учителя','/teacher/telegram');
 const reader=input.botUsername?{text:'📚 Кабінет читача',url:'https://t.me/'+input.botUsername+'?start=reader'}:button('📚 Кабінет читача','/reader/telegram');
 await input.send({chat_id:input.message.chatId,text:'Єдина бібліотека. Оберіть свій кабінет:\n\n🎓 Учитель — підручники та замовлення.\n📚 Читач — художня та наукова література.\n🏛 Бібліотекар — керування бібліотекою.',reply_markup:{inline_keyboard:[[teacher],[reader],[button('🏛 Кабінет бібліотекаря','/librarian/telegram?target=home')]]}}).catch(()=>undefined);
 return {outcome:'cabinet_selector',duplicate:false};
}
