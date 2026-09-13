import {sha256Text} from "./librarika-import-plan.ts";
import {readerBatch,requireChanged,type ReaderDatabase} from "./reader-core.ts";

type Message={chatId:string;telegramUserId:string;chatType:string;text:string};
type Send=(body:Record<string,unknown>)=>Promise<unknown>;
/** Uses the existing, secret-verified webhook and bot. An invitation never authenticates from /start alone. */
export async function processReaderTelegramMessage(db:ReaderDatabase,input:{message:Message;updateId:string;payloadHash:string;siteOrigin:string;miniAppEnabled?:boolean;send:Send}){
  const {message,updateId,payloadHash,send}=input;
  if(message.chatType!=="private"||message.chatId!==message.telegramUserId)return null;
  if(/^\/start(?:@[A-Za-z0-9_]+)?\s+teacher$/.test(message.text.trim()))return null;
  const text=message.text.trim(),invite=text.match(/^\/start(?:@[A-Za-z0-9_]+)?\s+ra_([a-f0-9]{48})$/),readerStart=/^\/start(?:@[A-Za-z0-9_]+)?\s+reader$/.test(text);
  const old=await db.prepare("SELECT 1 ok FROM telegram_connections WHERE (telegram_user_id=? OR chat_id=?) AND status='active'").bind(message.telegramUserId,message.chatId).first();
  if(old&&!invite&&!readerStart)return null;
  const connection=old?null:await db.prepare("SELECT c.reader_id,c.version,r.access_version FROM reader_telegram_connections c JOIN library_readers r ON r.id=c.reader_id WHERE c.telegram_user_id=? AND c.chat_id=? AND c.status='active' AND r.status='active' AND r.access_status='active' AND r.linked_teacher_user_id IS NULL").bind(message.telegramUserId,message.chatId).first();
  if(!invite&&!readerStart&&!connection)return null;
  const command=text.match(/^\/(start|menu|cabinet|help|books|profile|catalog|notifications|stop|disconnect)(?:@[A-Za-z0-9_]+)?$/)?.[1]||"menu";
  const now=new Date().toISOString(),outcome=invite?"reader_invite":old?"reader_teacher_help":connection?"reader_"+command:"reader_join_help";
  const existing=await db.prepare("SELECT payload_hash,outcome FROM telegram_webhook_updates WHERE update_id=?").bind(updateId).first();
  if(existing){if(existing.payload_hash!==payloadHash)throw new Error("webhook_update_conflict");return {outcome:String(existing.outcome),duplicate:true};}
  const statements=[db.prepare("INSERT INTO telegram_webhook_updates(update_id,payload_hash,outcome,processed_at) VALUES(?,?,?,?)").bind(updateId,payloadHash,outcome,now)];
  if(connection&&(command==="stop"||command==="disconnect")){
    statements.push(db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM reader_telegram_connections c JOIN library_readers r ON r.id=c.reader_id WHERE c.reader_id=? AND c.telegram_user_id=? AND c.chat_id=? AND c.version=? AND c.status='active' AND r.access_version=? AND r.access_status='active') THEN 1 ELSE json('reader_connection_changed') END").bind(String(connection.reader_id),message.telegramUserId,message.chatId,Number(connection.version),Number(connection.access_version)),
      db.prepare("UPDATE reader_profiles SET telegram_disconnected_at=?,notify_loans=0,notify_books=0,version=version+1,updated_at=? WHERE reader_id=?").bind(now,now,String(connection.reader_id)),
      db.prepare("UPDATE reader_notification_outbox SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE reader_id=? AND status IN ('pending','processing')").bind(String(connection.reader_id)));
    if(command==="disconnect")statements.push(
      db.prepare("UPDATE reader_telegram_connections SET status='disabled',version=version+1,disabled_at=? WHERE reader_id=? AND version=?").bind(now,String(connection.reader_id),Number(connection.version)),requireChanged(db,1),
      db.prepare("UPDATE reader_sessions SET revoked_at=? WHERE reader_id=? AND telegram_user_id IS NOT NULL AND revoked_at IS NULL").bind(now,String(connection.reader_id)),
      db.prepare("UPDATE reader_invites SET revoked_at=? WHERE reader_id=? AND revoked_at IS NULL AND consumed_at IS NULL").bind(now,String(connection.reader_id)));
  }
  if(connection&&(command==="stop"||command==="disconnect"))statements.push(db.prepare("UPDATE reader_messages SET delivery_status=CASE WHEN delivery_status='processing' THEN 'uncertain' ELSE 'disabled' END,lease_token=NULL,lease_until=NULL,last_error='notifications_disabled' WHERE reader_id=? AND delivery_status IN ('pending','retry','processing')").bind(String(connection.reader_id)));
  await readerBatch(db,statements);
  let reply="Вітаємо в «Єдиній бібліотеці»!\n\nХудожні та наукові книги, бронювання і читацька спільнота — у вашому особистому кабінеті.\n\nДля першого входу оберіть «Активувати вперше» та введіть одноразовий код бібліотекаря. Код і PIN вводьте лише у захищеному вікні.",path="/reader/telegram";
  if(old)reply="Ваш Telegram уже приєднаний до кабінету вчителя або бібліотекаря. Для активного вчителя читацький профіль зв’язується з чинним кабінетом; повторна реєстрація не потрібна. Неоднозначні збіги імен перевіряє бібліотекар.";
  else if(invite){
    const hash=await sha256Text(invite[1]);
    const valid=await db.prepare("SELECT 1 ok FROM reader_invites i JOIN library_readers r ON r.id=i.reader_id WHERE i.token_hash=? AND i.purpose='telegram' AND i.expires_at>? AND i.consumed_at IS NULL AND i.revoked_at IS NULL AND i.access_version=r.access_version AND r.status='active' AND r.access_status!='blocked' AND r.linked_teacher_user_id IS NULL").bind(hash,now).first();
    if(valid){reply="Персональне запрошення до бібліотеки. Відкрийте кабінет і перевірте, що вказане ім’я — ваше. Приєднання відбудеться лише після вашого підтвердження.";path+="#invite="+invite[1];}
    else reply="Запрошення недійсне або вже використане. Попросіть бібліотекаря про нове персональне запрошення.";
  }else if(connection){
    reply=command==="stop"?"Сповіщення Telegram вимкнено. Для відновлення скористайтеся повторним приєднанням у кабінеті. Актуальні строки — у «Історія читання» читацького кабінету.":command==="disconnect"?"Telegram від’єднано, попередні читацькі сеанси завершено. Історію видач у бібліотеці збережено. Для нового приєднання увійдіть зі своїм PIN.":command==="catalog"?"Каталог художньої та наукової літератури: оберіть книгу, подайте заявку на бронювання або напишіть відгук.":"Ваш читацький кабінет: каталог, власні видачі, бронювання, відгуки, спільнота та обліковий запис.";
    if(command==="books"){
      reply="Книги на руках, строки повернення та статуси заявок — у «Історія читання».";
    }
    if(command==="notifications")reply="Строки повернення доступні в читацькому кабінеті. Нагадування про повернення з’являються в кабінеті о 10:00 за Києвом. Після приєднання Telegram повідомлення надходять автоматично. /stop вимикає сповіщення бота.";
    if(["books","profile","catalog"].includes(command))path+="?tab="+command;
  }
  const url=new URL(path,input.siteOrigin).toString();
  const web=(text:string,path:string)=>({text,...(input.miniAppEnabled!==false?{web_app:{url:new URL(path,input.siteOrigin).toString()}}:{url:new URL(path.replace("/reader/telegram","/reader"),input.siteOrigin).toString()})});
  const keyboard=invite?[[web("Підтвердити свій профіль",path)]]:(connection&&command!=="disconnect")||old?readerTelegramKeyboard(input.siteOrigin,input.miniAppEnabled!==false):[
    [web("🔑 Увійти","/reader/telegram?mode=login")],
    [web("✨ Активувати вперше","/reader/telegram?mode=activate")],
    [web("📚 Переглянути каталог","/reader/catalog?telegram=1")],
  ];
  keyboard.push([web("↩️ Змінити кабінет","/telegram/cabinets")]);
  try{await send({chat_id:message.chatId,text:reply,link_preview_options:{is_disabled:true},reply_markup:{inline_keyboard:keyboard}});}catch{/* State and receipt are committed; another command can safely redisplay the menu. */}
  return {outcome,duplicate:false};
}
export function readerTelegramKeyboard(origin:string,miniAppEnabled=true){
 const button=(label:string,tab:string)=>({text:label,...(miniAppEnabled?{web_app:{url:new URL('/reader/telegram?tab='+tab,origin).toString()}}:{url:new URL('/reader?tab='+tab,origin).toString()})});
 return [
 [button('🏠 Головна','home'),button('📚 Каталог','catalog')],
 [button('📖 Історія читання','books'),button('💬 Спільнота','community')],
 [button('🕘 Активність','activity'),button('👤 Обліковий запис','profile')],
 [button('➕ Запропонувати книгу','activity&action=propose')],
 ];
}
