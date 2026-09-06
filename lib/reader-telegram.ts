import {sha256Text} from "./librarika-import-plan.ts";
import {readerBatch,requireChanged,type ReaderDatabase} from "./reader-core.ts";

type Message={chatId:string;telegramUserId:string;chatType:string;text:string};
type Send=(body:Record<string,unknown>)=>Promise<unknown>;
/** Uses the existing, secret-verified webhook and bot. An invitation never authenticates from /start alone. */
export async function processReaderTelegramMessage(db:ReaderDatabase,input:{message:Message;updateId:string;payloadHash:string;siteOrigin:string;send:Send}){
  const {message,updateId,payloadHash,send}=input;
  if(message.chatType!=="private"||message.chatId!==message.telegramUserId)return null;
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
      db.prepare("UPDATE reader_profiles SET notify_loans=0,notify_books=0,version=version+1,updated_at=? WHERE reader_id=?").bind(now,String(connection.reader_id)),
      db.prepare("UPDATE reader_notification_outbox SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE reader_id=? AND status IN ('pending','processing')").bind(String(connection.reader_id)));
    if(command==="disconnect")statements.push(
      db.prepare("UPDATE reader_telegram_connections SET status='disabled',version=version+1,disabled_at=? WHERE reader_id=? AND version=?").bind(now,String(connection.reader_id),Number(connection.version)),requireChanged(db,1),
      db.prepare("UPDATE library_readers SET access_version=access_version+1,version=version+1,updated_at=? WHERE id=? AND access_version=?").bind(now,String(connection.reader_id),Number(connection.access_version)),requireChanged(db,1),
      db.prepare("UPDATE reader_sessions SET revoked_at=? WHERE reader_id=? AND revoked_at IS NULL").bind(now,String(connection.reader_id)),
      db.prepare("UPDATE reader_invites SET revoked_at=? WHERE reader_id=? AND revoked_at IS NULL AND consumed_at IS NULL").bind(now,String(connection.reader_id)));
  }
  await readerBatch(db,statements);
  let reply="Єдина бібліотека ліцею\nКаталог відкритий для всіх. Для особистого кабінету попросіть бібліотекаря про персональне запрошення.",path="/reader/telegram";
  if(old)reply="Ваш Telegram уже приєднаний до кабінету вчителя або бібліотекаря. Учитель відкриває читацький кабінет після звірки квитка бібліотекарем; повторна реєстрація не потрібна.";
  else if(invite){
    const hash=await sha256Text(invite[1]);
    const valid=await db.prepare("SELECT 1 ok FROM reader_invites i JOIN library_readers r ON r.id=i.reader_id WHERE i.token_hash=? AND i.purpose='telegram' AND i.expires_at>? AND i.consumed_at IS NULL AND i.revoked_at IS NULL AND i.access_version=r.access_version AND r.status='active' AND r.access_status!='blocked' AND r.linked_teacher_user_id IS NULL").bind(hash,now).first();
    if(valid){reply="Персональне запрошення до бібліотеки. Відкрийте кабінет і перевірте, що вказане ім’я — ваше. Приєднання відбудеться лише після вашого підтвердження.";path+="#invite="+invite[1];}
    else reply="Запрошення недійсне або вже використане. Попросіть бібліотекаря про нове персональне запрошення.";
  }else if(connection){
    reply=command==="stop"?"Нагадування про книги вимкнено. Видачі й доступ до кабінету збережено. Увімкнути нагадування можна у профілі.":command==="disconnect"?"Telegram від’єднано, попередні читацькі сеанси завершено. Книги та історію збережено. Для нового приєднання потрібне персональне запрошення.":"Ваш читацький кабінет: каталог, сканер, мої книги, профіль і спільнота. Оцінки, замовлення й повідомлення доступні всередині кабінету.";
    if(command==="books"){
      // Re-read the exact current connection immediately before returning private loan information.
      const loans=await db.prepare("SELECT e.title,l.due_at FROM reader_circulations l JOIN library_copies c ON c.id=l.copy_id JOIN library_editions e ON e.id=c.edition_id JOIN library_readers r ON r.id=l.reader_id JOIN reader_telegram_connections tc ON tc.reader_id=r.id WHERE r.id=? AND r.access_version=? AND r.status='active' AND r.access_status='active' AND tc.telegram_user_id=? AND tc.chat_id=? AND tc.version=? AND tc.status='active' AND l.status IN ('issued','overdue') ORDER BY l.due_at,l.id LIMIT 15").bind(String(connection.reader_id),Number(connection.access_version),message.telegramUserId,message.chatId,Number(connection.version)).all();
      reply=(loans.results||[]).length?"Книги на руках (до 15 записів):\n"+(loans.results||[]).map(row=>String(row.title).slice(0,150)+" — повернути до "+(row.due_at?String(row.due_at).slice(0,10):"узгодження з бібліотекарем")).join("\n"):"Активних видач немає або доступ уже змінився. Повна актуальна історія — у кабінеті.";
    }
    if(command==="notifications")reply="Нагадування надходять лише після вашої згоди у профілі. Окремо можна обрати строки повернення та появу книг за підпискою. /stop вимикає обидва види.";
    if(["books","profile","catalog"].includes(command))path+="?tab="+(command==="profile"?"profile":command==="books"?"books":"catalog");
  }
  const url=new URL(path,input.siteOrigin).toString();
  try{await send({chat_id:message.chatId,text:reply,link_preview_options:{is_disabled:true},reply_markup:{inline_keyboard:[[{text:"Відкрити читацький кабінет",web_app:{url}}],[{text:"Переглянути каталог",url:new URL("/library",input.siteOrigin).toString()}]]}});}catch{/* State and receipt are committed; another command can safely redisplay the menu. */}
  return {outcome,duplicate:false};
}
