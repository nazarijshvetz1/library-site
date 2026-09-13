import {readerBatch,readerFail,readerReceipt,readerReplay,requireChanged,type ReaderDatabase,type ReaderIdentity} from './reader-core.ts';
import {readerEvent} from './reader-events.ts';
export async function changeReaderTelegram(db:ReaderDatabase,who:ReaderIdentity,input:{requestId:string;expectedVersion:number;action:'connect'|'disconnect';confirmation:string}){
 if(!['connect','disconnect'].includes(input.action)||input.confirmation!==(input.action==='disconnect'?'DISCONNECT_READER_TELEGRAM':'CONNECT_READER_TELEGRAM')||!Number.isInteger(input.expectedVersion))readerFail('telegram_confirmation','Підтвердьте дію.');
 const r=await readerReplay(db,who,input.requestId,'reader_telegram_channel',input);if(r.replayed)return r.replayed;
 const reader=await db.prepare('SELECT id,linked_teacher_user_id FROM library_readers WHERE id=?').bind(who.readerId).first();
 if(input.action==='connect'&&(!reader?.linked_teacher_user_id||who.sessionKind!=='teacher'))readerFail('telegram_link','Повторно увійдіть через Telegram зі своїм PIN.',409);
 const now=new Date().toISOString(),connect=input.action==='connect';
 const current=await db.prepare('SELECT telegram_user_id FROM reader_sessions WHERE token_hash=? AND reader_id=?').bind(who.tokenHash,who.readerId).first();
 const result={connected:connect,version:input.expectedVersion+1,reauthenticate:!connect&&!!current?.telegram_user_id};
 const statements=[readerReceipt(db,who,input.requestId,'reader_telegram_channel',r.hash,result,now)];
 if(connect)statements.push(db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM library_readers r JOIN telegram_connections c ON c.user_id=r.linked_teacher_user_id JOIN users u ON u.id=c.user_id WHERE r.id=? AND c.status='active' AND u.status='active') THEN 1 ELSE json('telegram_link_missing') END").bind(who.readerId));
 statements.push(db.prepare("UPDATE reader_profiles SET telegram_disconnected_at=?,notify_loans=?,version=version+1,updated_at=? WHERE reader_id=? AND version=?").bind(connect?null:now,Number(connect),now,who.readerId,input.expectedVersion),requireChanged(db,1));
 if(!connect&&!reader?.linked_teacher_user_id)statements.push(db.prepare("UPDATE reader_telegram_connections SET status='disabled',disabled_at=?,version=version+1 WHERE reader_id=? AND status='active'").bind(now,who.readerId),db.prepare("UPDATE reader_sessions SET revoked_at=? WHERE reader_id=? AND telegram_user_id IS NOT NULL AND revoked_at IS NULL").bind(now,who.readerId));
 statements.push(db.prepare("UPDATE reader_messages SET delivery_status=CASE WHEN delivery_status='processing' THEN 'uncertain' ELSE ? END,lease_token=NULL,lease_until=NULL,next_attempt_at=? WHERE reader_id=? AND kind IN ('loan_digest','proposal') AND delivery_status IN ('pending','retry','processing','disabled','unavailable') AND (kind!='loan_digest' OR day=?)").bind(connect?'pending':'disabled',now,who.readerId,new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv'}).format(new Date(now))));
 if(!connect)statements.push(db.prepare("UPDATE reader_notification_outbox SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE reader_id=? AND status IN ('pending','processing')").bind(who.readerId));
 statements.push(readerEvent(db,{readerId:who.readerId,key:'telegram:'+input.requestId,kind:'account',title:connect?'Telegram приєднано':'Telegram від’єднано',body:connect?'Повідомлення про повернення та пропозиції надходитимуть автоматично.':'Повідомлення залишаються у кабінеті. Відправлення в Telegram припинено.',tab:'profile'},now));
 await readerBatch(db,statements);return result;
}
