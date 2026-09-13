import {kyivLocalNow} from './visit-schedule-validation.ts';
import {getRuntimeBoolean,getRuntimeString} from './runtime-env.ts';
import {telegramApiRequest,TelegramIntegrationError} from './telegram-notifications.ts';
import {readerFail,type ReaderDatabase,type ReaderIdentity} from './reader-core.ts';

const source=`reader_circulations l JOIN library_copies c ON c.id=l.copy_id JOIN library_editions e ON e.id=c.edition_id JOIN library_readers r ON r.id=l.reader_id`;
const due=`l.accounting_mode='native' AND l.status IN ('issued','overdue') AND r.status='active' AND e.fund='literature' AND c.registration='registered' AND c.physical_state='on_loan' AND length(substr(l.due_at,1,10))=10 AND date(substr(l.due_at,1,10))=substr(l.due_at,1,10) AND substr(l.due_at,1,10)<=?`;
const siteOrigin='https://yedyna-biblioteka-liceiu.nazarijshvetz1.chatgpt.site';
type Loan={id:string;title:string;due_at:string;edition_id:string;version:number};
export async function currentDueLoans(db:ReaderDatabase,readerId:string,day:string):Promise<Loan[]>{
 const result=await db.prepare(`SELECT l.id,e.title,substr(l.due_at,1,10) due_at,e.id edition_id,l.version FROM ${source} WHERE ${due} AND r.id=? ORDER BY l.due_at,e.title,l.id LIMIT 300`).bind(day,readerId).all<Loan>();
 return result.results||[];
}
function digestBody(loans:Loan[],day:string){
 return loans.map(loan=>`• ${loan.title} — ${loan.due_at===day?'повернути сьогодні':'прострочено, повернути до '+loan.due_at}`).join('\n');
}
export function proposalMessage(db:ReaderDatabase,input:{readerId:string;proposalId:string;version:number;title:string;stage:string;reply:string},now:string){
 const labels:Record<string,string>={submitted:'Надіслано',approved:'Схвалено',ordered:'Замовлено',available:'Доступна в каталозі'};
 return db.prepare(`INSERT INTO reader_messages(id,reader_id,dedupe_key,kind,day,title,body,payload_json,target_tab,created_at,next_attempt_at)
 VALUES(?,?,?,'proposal',?,'Ваша пропозиція книги',?,?,'activity',?,?) ON CONFLICT(dedupe_key) DO NOTHING`)
 .bind(crypto.randomUUID(),input.readerId,`proposal:${input.proposalId}:${input.version}`,kyivLocalNow(new Date(now)).date,
 `${input.title}\n${labels[input.stage]||input.stage}${input.reply?'\n'+input.reply:''}`,JSON.stringify({proposalId:input.proposalId}),now,now);
}
export async function generateReaderMessages(db:ReaderDatabase,nowDate=new Date()){
 const local=kyivLocalNow(nowDate);if(local.time<'10:00')return;
 const now=nowDate.toISOString();
 await db.batch([db.prepare(`INSERT INTO reader_messages(id,reader_id,dedupe_key,kind,day,title,body,payload_json,target_tab,created_at,next_attempt_at)
 SELECT lower(hex(randomblob(16))),r.id,'loans:'||r.id||':'||?,'loan_digest',?,'Час повернути книги','Перевірте строки повернення у «Історія читання».','{}','books',?,?
 FROM ${source} WHERE ${due} GROUP BY r.id ON CONFLICT(dedupe_key) DO NOTHING`).bind(local.date,local.date,now,now,local.date)]);
}
const inboxVisible=`(rm.kind!='community' OR EXISTS(SELECT 1 FROM reader_feed_comments c JOIN reader_feed_posts fp ON fp.id=c.post_id JOIN reader_profiles cp ON cp.reader_id=c.reader_id JOIN reader_profiles owner ON owner.reader_id=rm.reader_id WHERE c.id=json_extract(rm.payload_json,'$.commentId') AND fp.id=json_extract(rm.payload_json,'$.postId') AND c.status='visible' AND fp.status='visible' AND cp.community_enabled=1 AND owner.community_enabled=1 AND NOT EXISTS(SELECT 1 FROM reader_blocks b WHERE (b.reader_id=rm.reader_id AND b.blocked_reader_id IN (c.reader_id,fp.reader_id)) OR (b.blocked_reader_id=rm.reader_id AND b.reader_id IN (c.reader_id,fp.reader_id))))) AND (rm.kind!='loan_digest' OR NOT EXISTS(SELECT 1 FROM reader_messages newer WHERE newer.reader_id=rm.reader_id AND newer.kind='loan_digest' AND (newer.created_at>rm.created_at OR (newer.created_at=rm.created_at AND newer.id>rm.id))))`;
export async function readerInbox(db:ReaderDatabase,who:ReaderIdentity,u=new URL('https://local/')){
 const category=u.searchParams.get('category')||'all',page=Number(u.searchParams.get('page')||1);
 if(!['all','library','community','account'].includes(category)||!Number.isInteger(page)||page<1||page>10000)readerFail('messages','Перевірте фільтр сповіщень.');
 const filter=category==='library'?" AND rm.kind IN ('loan_digest','proposal','request','circulation')":category==='all'?'':" AND rm.kind='"+category+"'";
 const day=kyivLocalNow().date,loans=await currentDueLoans(db,who.readerId,day);
 const base="rm.reader_id=? AND "+inboxVisible;
 const total=Number((await db.prepare("SELECT count(*) n FROM reader_messages rm WHERE "+base+filter).bind(who.readerId).first())?.n||0);
 const unread=Number((await db.prepare("SELECT count(*) n FROM reader_messages rm WHERE "+base+" AND rm.read_at IS NULL"+(!loans.length?" AND rm.kind!='loan_digest'":'')).bind(who.readerId).first())?.n||0);
 const rows=await db.prepare(`SELECT rm.id,rm.kind,rm.day,rm.title,rm.body,rm.payload_json,rm.target_tab,rm.read_at,rm.created_at,rm.delivery_status,
 CASE WHEN e.publication_state='published' AND e.fund='literature' THEN e.id END edition_id,CASE WHEN e.publication_state='published' AND e.fund='literature' THEN e.title END book_title,
 CASE WHEN e.publication_state='published' AND e.fund='literature' THEN '/api/reader/cover?id='||e.id||'&v='||e.version END cover_url
 FROM reader_messages rm LEFT JOIN library_editions e ON e.id=coalesce(json_extract(rm.payload_json,'$.editionId'),(SELECT proposal.edition_id FROM reader_literature_proposals proposal WHERE proposal.id=json_extract(rm.payload_json,'$.proposalId'))) WHERE ${base+filter} ORDER BY rm.created_at DESC,rm.id DESC LIMIT 20 OFFSET ?`).bind(who.readerId,(page-1)*20).all();
 const items=(rows.results||[]).map(row=>{const payload=JSON.parse(String(row.payload_json||'{}'));return {...row,payload,category:['community','account'].includes(String(row.kind))?row.kind:'library',...(row.kind==='loan_digest'?{body:loans.length?digestBody(loans,day):'Усі книги з цього нагадування повернуті або строк подовжено.',resolved:!loans.length,loans,edition_id:loans[0]?.edition_id,book_title:loans[0]?.title,cover_url:loans[0]?'/api/reader/cover?id='+encodeURIComponent(loans[0].edition_id):null}:{})};});
 return {items,unread,total,page,pages:Math.ceil(total/20)};
}
export async function markReaderMessage(db:ReaderDatabase,who:ReaderIdentity,id:unknown){
 if(typeof id!=='string'||id.length>100)readerFail('message','Повідомлення не знайдено.');
 await db.batch([db.prepare("UPDATE reader_messages SET read_at=coalesce(read_at,?) WHERE id=? AND reader_id=?").bind(new Date().toISOString(),id,who.readerId)]);
 return {id};
}
async function recipient(db:ReaderDatabase,readerId:string){
 return db.prepare(`SELECT r.id,(p.telegram_disconnected_at IS NULL) notify_loans,
 CASE WHEN r.linked_teacher_user_id IS NULL THEN rc.chat_id ELSE tc.chat_id END chat_id,
 CASE WHEN r.linked_teacher_user_id IS NULL THEN rc.status ELSE tc.status END connection_status,
 CASE WHEN r.linked_teacher_user_id IS NULL THEN rc.version ELSE tc.version END connection_version,
 1 bot_enabled
 FROM library_readers r LEFT JOIN reader_profiles p ON p.reader_id=r.id
 LEFT JOIN reader_telegram_connections rc ON rc.reader_id=r.id
 LEFT JOIN telegram_connections tc ON tc.user_id=r.linked_teacher_user_id
 WHERE r.id=? AND r.status='active' AND r.access_status='active'
 AND (r.linked_teacher_user_id IS NULL OR EXISTS(SELECT 1 FROM users u JOIN teacher_profiles tp ON tp.teacher_user_id=u.id WHERE u.id=r.linked_teacher_user_id AND u.status='active' AND tp.closed_at IS NULL))`).bind(readerId).first();
}
export async function deliverReaderMessages(db:ReaderDatabase,options:{now?:Date;limit?:number;send?:(chatId:string,body:string,tab:string)=>Promise<unknown>}={}){
 const nowDate=options.now||new Date(),now=nowDate.toISOString(),day=kyivLocalNow(nowDate).date;
 // A process lost after handing the request to Telegram cannot prove whether it was delivered.
 await db.batch([db.prepare("UPDATE reader_messages SET delivery_status='uncertain',last_error='delivery_result_unknown',lease_token=NULL,lease_until=NULL WHERE delivery_status='processing' AND lease_until<?").bind(now),
 db.prepare("UPDATE reader_messages SET delivery_status='cancelled',last_error='day_expired' WHERE kind='loan_digest' AND day<? AND delivery_status IN ('pending','retry')").bind(day)]);
 await db.batch([db.prepare("UPDATE reader_messages SET delivery_status='pending',next_attempt_at=? WHERE delivery_status='unavailable' AND last_error IN ('telegram_unavailable','connection_unavailable') AND next_attempt_at<=? AND (kind!='loan_digest' OR day=?)").bind(now,now,day)]);
 const rows=await db.prepare("SELECT * FROM reader_messages WHERE delivery_status IN ('pending','retry') AND next_attempt_at<=? ORDER BY created_at,id LIMIT ?").bind(now,Math.max(1,Math.min(30,options.limit||10))).all();
 const token=getRuntimeString('TELEGRAM_BOT_TOKEN');
 const enabled=Boolean(options.send)||(getRuntimeBoolean('TELEGRAM_NOTIFICATIONS_ENABLED')&&Boolean(token));
 let sent=0;
 for(const row of rows.results||[]){
  let body=String(row.body),payload=String(row.payload_json);
  if(row.kind==='loan_digest'){
   const loans=await currentDueLoans(db,String(row.reader_id),day);
   if(!loans.length){await db.batch([db.prepare("UPDATE reader_messages SET delivery_status='cancelled',last_error='returned_or_extended' WHERE id=? AND delivery_status IN ('pending','retry')").bind(String(row.id))]);continue;}
   body=digestBody(loans,day);payload=JSON.stringify({loans});
  }
  const to=await recipient(db,String(row.reader_id));
  if(!to||!to.notify_loans||!to.bot_enabled||to.connection_status!=='active'||!to.chat_id||!enabled){
   // Keep the website notice. A later explicit opt-in can send today's pending notice.
   await db.batch([db.prepare("UPDATE reader_messages SET delivery_status=?,body=?,payload_json=?,last_error=?,next_attempt_at=? WHERE id=? AND delivery_status IN ('pending','retry')").bind(!to?.notify_loans||!to?.bot_enabled?'disabled':'unavailable',body,payload,!enabled?'telegram_unavailable':!to?.notify_loans?'notifications_disabled':'connection_unavailable',new Date(nowDate.getTime()+300000).toISOString(),String(row.id))]);continue;
  }
  const lease=crypto.randomUUID(),until=new Date(nowDate.getTime()+60000).toISOString();
  const claimed=await db.batch([db.prepare("UPDATE reader_messages SET delivery_status='processing',lease_token=?,lease_until=?,body=?,payload_json=?,attempts=attempts+1 WHERE id=? AND delivery_status IN ('pending','retry') RETURNING id").bind(lease,until,body,payload,String(row.id))]);
  if(!claimed[0]?.results?.length)continue;
  if(row.kind==='loan_digest'){
   const fresh=await currentDueLoans(db,String(row.reader_id),day);
   if(!fresh.length){await db.batch([db.prepare("UPDATE reader_messages SET delivery_status='cancelled',lease_token=NULL,lease_until=NULL,last_error='returned_or_extended' WHERE id=? AND lease_token=?").bind(String(row.id),lease)]);continue;}
   body=digestBody(fresh,day);payload=JSON.stringify({loans:fresh});
   await db.batch([db.prepare("UPDATE reader_messages SET body=?,payload_json=? WHERE id=? AND lease_token=?").bind(body,payload,String(row.id),lease)]);
  }
  const latest=await recipient(db,String(row.reader_id));
  const guard=await db.prepare("SELECT 1 ok FROM reader_messages WHERE id=? AND lease_token=? AND delivery_status='processing' AND NOT EXISTS(SELECT 1 FROM json_each(?,'$.loans') j WHERE NOT EXISTS(SELECT 1 FROM reader_circulations l WHERE l.id=json_extract(j.value,'$.id') AND l.version=json_extract(j.value,'$.version') AND l.status IN ('issued','overdue')) )").bind(String(row.id),lease,payload).first();
  if(!guard||!latest?.notify_loans||!latest.bot_enabled||latest.connection_status!=='active'||latest.chat_id!==to.chat_id||latest.connection_version!==to.connection_version){
   await db.batch([db.prepare("UPDATE reader_messages SET delivery_status='disabled',lease_token=NULL,lease_until=NULL,last_error='recipient_changed' WHERE id=? AND lease_token=?").bind(String(row.id),lease)]);continue;
  }
  try{
   const message=String(row.title)+'\n\n'+body.slice(0,3400)+'\n\nСтатус оновлюється в кабінеті читача.';
   if(options.send)await options.send(String(to.chat_id),message,String(row.target_tab));
   else await telegramApiRequest(token!,'sendMessage',{chat_id:String(to.chat_id),text:message,link_preview_options:{is_disabled:true},reply_markup:{inline_keyboard:[[{text:row.target_tab==='books'?'📖 Історія читання':'🕘 Мої пропозиції',web_app:{url:siteOrigin+'/reader/telegram?tab='+row.target_tab}}]]}},fetch);
   await db.batch([db.prepare("UPDATE reader_messages SET delivery_status='sent',sent_at=?,lease_token=NULL,lease_until=NULL,last_error=NULL WHERE id=? AND lease_token=?").bind(now,String(row.id),lease)]);sent++;
  }catch(error){
   const code=error instanceof TelegramIntegrationError?error.code:'telegram_network_error';
   const ambiguous=['telegram_timeout','telegram_network_error'].includes(code),permanent=['telegram_blocked','telegram_rejected'].includes(code);
   const attempts=Number(row.attempts)+1,seconds=Math.max(60,Number((error as any)?.retryAfterSeconds)||Math.min(3600,60*2**Math.min(attempts,6)));
   await db.batch([db.prepare("UPDATE reader_messages SET delivery_status=?,next_attempt_at=?,last_error=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?").bind(ambiguous?'uncertain':permanent||attempts>=8?'unavailable':'retry',new Date(nowDate.getTime()+seconds*1000).toISOString(),code,String(row.id),lease)]);
   if(code==='telegram_rate_limited')break;
  }
 }
 return {sent};
}
export async function runNativeReaderNotifications(db:ReaderDatabase,now=new Date()){
 await generateReaderMessages(db,now);return deliverReaderMessages(db,{now});
}
export function invalidateReaderDigest(db:ReaderDatabase,readerId:string,now:string){
 return db.prepare("UPDATE reader_messages SET delivery_status=CASE WHEN delivery_status='processing' THEN 'uncertain' ELSE 'pending' END,lease_token=NULL,lease_until=NULL,next_attempt_at=? WHERE reader_id=? AND kind='loan_digest' AND delivery_status IN ('pending','retry','processing')").bind(now,readerId);
}
