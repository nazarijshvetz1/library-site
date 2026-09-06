import {getRuntimeBoolean,getRuntimeString} from "./runtime-env.ts";
import {telegramApiRequest,TelegramIntegrationError,type TelegramFetcher} from "./telegram-notifications.ts";
import type {ReaderDatabase} from "./reader-core.ts";

const SITE="https://yedyna-biblioteka-liceiu.nazarijshvetz1.chatgpt.site";
const recipient=`(CASE WHEN r.linked_teacher_user_id IS NULL THEN
 (SELECT tc.chat_id FROM reader_telegram_connections tc WHERE tc.reader_id=r.id AND tc.status='active')
 ELSE (SELECT tc.chat_id FROM telegram_connections tc JOIN users u ON u.id=tc.user_id JOIN teacher_profiles tp ON tp.teacher_user_id=u.id WHERE tc.user_id=r.linked_teacher_user_id AND tc.status='active' AND u.status='active' AND tp.closed_at IS NULL) END)`;
export async function queueReaderNotifications(db:ReaderDatabase,now=new Date().toISOString()){
  const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Kyiv"}).format(new Date(now));
  // Consent time is an explicit floor: imported past-due debts cannot trigger a launch-day broadcast.
  await db.batch([
    db.prepare(`INSERT INTO reader_notification_outbox(id,reader_id,circulation_id,edition_id,kind,expected_version,due_date,next_attempt_at,created_at)
      SELECT 'loan:'||l.id||':'||l.version||':'||k.kind,l.reader_id,l.id,c.edition_id,k.kind,l.version,substr(l.due_at,1,10),?,?
      FROM reader_circulations l JOIN library_copies c ON c.id=l.copy_id JOIN library_readers r ON r.id=l.reader_id JOIN reader_profiles p ON p.reader_id=r.id
      JOIN (SELECT 'due_soon' kind,3 offset UNION ALL SELECT 'due_today',0 UNION ALL SELECT 'overdue',-1) k
      WHERE l.accounting_mode='native' AND l.status IN ('issued','overdue') AND r.status='active' AND r.access_status='active' AND p.notify_loans=1 AND p.notify_loans_since IS NOT NULL
        AND substr(l.due_at,1,10)>=substr(p.notify_loans_since,1,10) AND date(substr(l.due_at,1,10))=date(?,printf('%+d days',k.offset)) AND ${recipient} IS NOT NULL
        AND EXISTS(SELECT 1 FROM library_editions e JOIN materials m ON m.id=e.material_id WHERE e.id=c.edition_id AND e.publication_state='published' AND m.status='active')
        AND NOT EXISTS(SELECT 1 FROM reader_notification_outbox o WHERE o.id='loan:'||l.id||':'||l.version||':'||k.kind)
      LIMIT 20 ON CONFLICT(id) DO NOTHING`).bind(now,now,today),
    db.prepare(`INSERT INTO reader_notification_outbox(id,reader_id,edition_id,kind,due_date,next_attempt_at,created_at)
      SELECT 'book:'||s.reader_id||':'||s.edition_id||':'||s.created_at,s.reader_id,s.edition_id,'book_available',s.created_at,?,?
      FROM reader_book_subscriptions s JOIN reader_profiles p ON p.reader_id=s.reader_id JOIN library_readers r ON r.id=s.reader_id JOIN library_editions e ON e.id=s.edition_id JOIN materials m ON m.id=e.material_id
      WHERE r.status='active' AND r.access_status='active' AND p.notify_books=1 AND p.notify_books_since IS NOT NULL AND e.publication_state='published' AND m.status='active' AND ${recipient} IS NOT NULL
        AND EXISTS(SELECT 1 FROM library_copies c WHERE c.edition_id=e.id AND c.registration='registered' AND c.physical_state='on_shelf')
        AND NOT EXISTS(SELECT 1 FROM reader_notification_outbox o WHERE o.id='book:'||s.reader_id||':'||s.edition_id||':'||s.created_at AND o.status!='cancelled')
      LIMIT 20 ON CONFLICT(id) DO UPDATE SET status='pending',next_attempt_at=excluded.next_attempt_at,lease_token=NULL,lease_until=NULL WHERE reader_notification_outbox.status='cancelled'`).bind(now,now),
    // A worker interruption might have happened after Telegram accepted a message. Do not blindly send it twice.
    db.prepare("UPDATE reader_notification_outbox SET status='failed',lease_token=NULL,lease_until=NULL,last_error='delivery_uncertain' WHERE status='processing' AND lease_until<?").bind(now),
  ]);
}
export async function drainReaderNotifications(db:ReaderDatabase,options:{botToken:string;now?:string;fetcher?:TelegramFetcher;limit?:number}){
  const now=options.now||new Date().toISOString(),sent={attempted:0,sent:0,cancelled:0,failed:0};
  const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Kyiv"}).format(new Date(now));
  for(let index=0;index<Math.min(options.limit||2,5);index++){
    const lease=crypto.randomUUID(),leaseUntil=new Date(Date.parse(now)+60000).toISOString();
    const claimed=await db.batch([db.prepare("UPDATE reader_notification_outbox SET status='processing',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=(SELECT id FROM reader_notification_outbox WHERE status='pending' AND next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT 1) AND status='pending' RETURNING id,attempts").bind(lease,leaseUntil,now)]);
    const claim=claimed[0]?.results?.[0];if(!claim)break;sent.attempted++;
    const current=await db.prepare(`SELECT o.id,o.kind,o.due_date,o.edition_id,e.title,${recipient} chat_id FROM reader_notification_outbox o JOIN library_readers r ON r.id=o.reader_id JOIN reader_profiles p ON p.reader_id=r.id JOIN library_editions e ON e.id=o.edition_id JOIN materials m ON m.id=e.material_id
      WHERE o.id=? AND o.status='processing' AND o.lease_token=? AND o.lease_until>? AND r.status='active' AND r.access_status='active' AND e.publication_state='published' AND m.status='active'
      AND ((o.kind!='book_available' AND p.notify_loans=1 AND p.notify_loans_since IS NOT NULL AND o.due_date>=substr(p.notify_loans_since,1,10)
        AND ((o.kind='due_today' AND o.due_date=?) OR (o.kind='due_soon' AND o.due_date>?) OR (o.kind='overdue' AND o.due_date<?))
        AND EXISTS(SELECT 1 FROM reader_circulations l WHERE l.id=o.circulation_id AND l.reader_id=r.id AND l.accounting_mode='native' AND l.version=o.expected_version AND substr(l.due_at,1,10)=o.due_date AND l.status IN ('issued','overdue')))
       OR (o.kind='book_available' AND p.notify_books=1 AND p.notify_books_since IS NOT NULL AND EXISTS(SELECT 1 FROM reader_book_subscriptions s WHERE s.reader_id=r.id AND s.edition_id=e.id AND s.created_at=o.due_date)
        AND EXISTS(SELECT 1 FROM library_copies c WHERE c.edition_id=e.id AND c.registration='registered' AND c.physical_state='on_shelf')))
      AND ${recipient} IS NOT NULL`).bind(String(claim.id),lease,now,today,today,today).first();
    if(!current){await db.batch([db.prepare("UPDATE reader_notification_outbox SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=? AND status='processing'").bind(String(claim.id),lease)]);sent.cancelled++;continue;}
    const title=String(current.title).slice(0,300),date=String(current.due_date),message=current.kind==='book_available'?`Книга «${title}» є в бібліотеці. Можна надіслати замовлення; це ще не бронювання примірника.`:current.kind==='overdue'?`Нагадуємо: строк повернення книги «${title}» минув ${date}. Поверніть її або узгодьте новий строк із бібліотекарем.`:`Книгу «${title}» потрібно повернути ${current.kind==='due_today'?'сьогодні':date}.`;
    try{
      await telegramApiRequest(options.botToken,"sendMessage",{chat_id:current.chat_id,text:"Єдина бібліотека ліцею\n"+message,link_preview_options:{is_disabled:true},reply_markup:{inline_keyboard:[[{text:"Мої книги й налаштування",web_app:{url:SITE+"/reader/telegram?tab="+(current.kind==='book_available'?'catalog':'books')}}]]}},options.fetcher||fetch);
      await db.batch([db.prepare("UPDATE reader_notification_outbox SET status='sent',sent_at=?,lease_token=NULL,lease_until=NULL,last_error=NULL WHERE id=? AND lease_token=? AND status='processing'").bind(now,String(claim.id),lease)]);sent.sent++;
    }catch(error){
      const rateLimited=error instanceof TelegramIntegrationError&&error.code==='telegram_rate_limited'&&Number(claim.attempts)<5;
      const retryAt=new Date(Date.parse(now)+1000*Math.max(60,error instanceof TelegramIntegrationError?error.retryAfterSeconds||60:60)).toISOString();
      await db.batch([db.prepare("UPDATE reader_notification_outbox SET status=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL,last_error=? WHERE id=? AND lease_token=? AND status='processing'").bind(rateLimited?'pending':'failed',retryAt,error instanceof TelegramIntegrationError?error.code:'delivery_uncertain',String(claim.id),lease)]);sent.failed++;
    }
  }return sent;
}
export async function runReaderMaintenance(db:ReaderDatabase){
  const token=getRuntimeString("TELEGRAM_BOT_TOKEN");if(!getRuntimeBoolean("LIBRARIAN_WRITES_ENABLED")||!getRuntimeBoolean("TELEGRAM_NOTIFICATIONS_ENABLED")||!token)return;
  await queueReaderNotifications(db);return drainReaderNotifications(db,{botToken:token,limit:2});
}
