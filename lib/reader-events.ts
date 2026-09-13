import {kyivLocalNow} from './visit-schedule-validation.ts';
import type {ReaderDatabase} from './reader-core.ts';

type EventInput={readerId:string;key:string;kind:'request'|'circulation'|'community'|'account';title:string;body:string;tab:'books'|'community'|'profile';payload?:Record<string,unknown>};
/** Event and source mutation share the same D1 transaction. These are website-only events. */
export function readerEvent(db:ReaderDatabase,input:EventInput,now:string){
 return db.prepare("INSERT INTO reader_messages(id,reader_id,dedupe_key,kind,day,title,body,payload_json,target_tab,created_at,next_attempt_at,delivery_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,'site_only') ON CONFLICT(dedupe_key) DO NOTHING")
 .bind(crypto.randomUUID(),input.readerId,input.key,input.kind,kyivLocalNow(new Date(now)).date,input.title,input.body,JSON.stringify(input.payload||{}),input.tab,now,now);
}
export function requestEvent(db:ReaderDatabase,id:string,now:string){
 return db.prepare(`INSERT INTO reader_messages(id,reader_id,dedupe_key,kind,day,title,body,payload_json,target_tab,created_at,next_attempt_at,delivery_status)
 SELECT lower(hex(randomblob(16))),q.reader_id,'request:'||q.id||':'||q.version,'request',?,CASE q.status WHEN 'ready' THEN 'Книжка готова до видачі' WHEN 'requested' THEN 'Запит на бронювання надіслано' WHEN 'fulfilled' THEN 'Книжку видано' WHEN 'rejected' THEN 'Бронювання відхилено' ELSE 'Бронювання скасовано' END,
 e.title,json_object('editionId',e.id,'requestId',q.id,'status',q.status),'books',?,?,'site_only' FROM reader_book_requests q JOIN library_editions e ON e.id=q.edition_id WHERE q.id=? AND e.fund='literature' ON CONFLICT(dedupe_key) DO NOTHING`)
 .bind(kyivLocalNow(new Date(now)).date,now,now,id);
}
export function circulationEvent(db:ReaderDatabase,id:string,title:string,now:string){
 return db.prepare(`INSERT INTO reader_messages(id,reader_id,dedupe_key,kind,day,title,body,payload_json,target_tab,created_at,next_attempt_at,delivery_status)
 SELECT lower(hex(randomblob(16))),l.reader_id,'circulation:'||l.id||':'||l.version,'circulation',?,?,e.title||CASE WHEN l.status IN ('issued','overdue') THEN ' · Повернути до '||substr(l.due_at,1,10) ELSE '' END,json_object('editionId',e.id,'circulationId',l.id,'status',l.status),'books',?,?,'site_only' FROM reader_circulations l JOIN library_copies c ON c.id=l.copy_id JOIN library_editions e ON e.id=c.edition_id WHERE l.id=? AND e.fund='literature' AND l.accounting_mode='native' ON CONFLICT(dedupe_key) DO NOTHING`)
 .bind(kyivLocalNow(new Date(now)).date,title,now,now,id);
}
export function commentEvents(db:ReaderDatabase,id:string,now:string){
 return db.prepare(`INSERT INTO reader_messages(id,reader_id,dedupe_key,kind,day,title,body,payload_json,target_tab,created_at,next_attempt_at,delivery_status)
 SELECT lower(hex(randomblob(16))),recipient.id,'comment:'||c.id||':'||recipient.id,'community',?,'Нова відповідь у спільноті',CASE WHEN parent.reader_id=recipient.id THEN 'На ваш коментар відповіли.' ELSE 'На ваш допис відповіли.' END,json_object('postId',p.id,'commentId',c.id),'community',?,?,'site_only'
 FROM reader_feed_comments c JOIN reader_feed_posts p ON p.id=c.post_id LEFT JOIN reader_feed_comments parent ON parent.id=c.parent_comment_id
 JOIN library_readers recipient ON (recipient.id=p.reader_id OR recipient.id=parent.reader_id) JOIN reader_profiles rp ON rp.reader_id=recipient.id
 WHERE c.id=? AND c.reader_id!=recipient.id AND c.status='visible' AND p.status='visible' AND rp.community_enabled=1 AND recipient.status='active' AND recipient.access_status='active'
 AND NOT EXISTS(SELECT 1 FROM reader_blocks b WHERE (b.reader_id=recipient.id AND b.blocked_reader_id=c.reader_id) OR (b.blocked_reader_id=recipient.id AND b.reader_id=c.reader_id)) ON CONFLICT(dedupe_key) DO NOTHING`).bind(kyivLocalNow(new Date(now)).date,now,now,id);
}
