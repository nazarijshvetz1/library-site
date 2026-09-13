import {readerEvent,requestEvent} from './reader-events.ts';
import {readerDirectoryFieldsSql,readerFullNameSql} from './reader-teacher-directory.ts';
import {libraryCoverSql} from "./library-reader-catalog.ts";
import {readerBatch,readerFail,readerReceipt,readerReplay,requireChanged,type ReaderDatabase,type ReaderIdentity} from "./reader-core.ts";

export async function getReaderProfile(db:ReaderDatabase,identity:ReaderIdentity){
  const row=await db.prepare(`SELECT r.id,${readerFullNameSql} full_name,r.linked_teacher_user_id,r.member_no,r.kind,r.source_group_label,r.version AS reader_version,
    ${readerDirectoryFieldsSql},p.display_name,p.email,p.about,p.telegram_disconnected_at,p.photo_key,p.community_enabled,p.notify_loans,p.notify_books,p.version,
    cy.class_name AS class_label,ay.label AS academic_year,
    (CASE WHEN r.linked_teacher_user_id IS NOT NULL THEN (SELECT status FROM telegram_connections tc WHERE tc.user_id=r.linked_teacher_user_id) ELSE (SELECT status FROM reader_telegram_connections tc WHERE tc.reader_id=r.id) END) AS telegram_status
    FROM library_readers r JOIN reader_profiles p ON p.reader_id=r.id
    LEFT JOIN reader_class_enrollments ce ON ce.reader_id=r.id AND ce.ended_at IS NULL
    LEFT JOIN class_years cy ON cy.id=ce.class_year_id LEFT JOIN academic_years ay ON ay.id=cy.academic_year_id
    WHERE r.id=?`).bind(identity.readerId).first();
  if(!row)readerFail("reader_profile_missing","Профіль ще не підготовлений. Зверніться до бібліотекаря.",409);
  return {id:row.id,fullName:row.full_name,memberNo:row.member_no,kind:row.kind,classLabel:row.class_label||row.source_group_label||"",classSource:row.class_label?"current":"imported",academicYear:row.academic_year||null,
    about:row.about||"",telegramDisconnected:!!row.telegram_disconnected_at,displayName:row.display_name,phone:row.phone,email:row.email||"",photoUrl:row.has_photo?"/api/reader/photo?v="+row.profile_version+"&at="+encodeURIComponent(String(row.photo_updated_at||"")):null,subjectPosition:row.subject_position||"",primaryLocation:row.primary_location_id?{id:row.primary_location_id,name:row.primary_location_name||""}:null,teacherProfileVersion:row.teacher_profile_version?Number(row.teacher_profile_version):null,teacherProfileUpdatedAt:row.teacher_profile_updated_at||null,communityEnabled:!!row.community_enabled,notifyLoans:!row.telegram_disconnected_at&&row.telegram_status==="active",notifyBooks:false,version:Number(row.version),telegramConnected:row.telegram_status==="active"&&!row.telegram_disconnected_at,teacherLinked:!!row.linked_teacher_user_id};
}
export async function updateReaderProfile(db:ReaderDatabase,identity:ReaderIdentity,input:{requestId:string;expectedVersion:number;displayName:string;phone:string;communityEnabled:boolean;email?:string;about?:string;notifyLoans?:boolean;notifyBooks?:boolean}){
 const allowed=['requestId','expectedVersion','displayName','phone','communityEnabled','email','about','notifyLoans','notifyBooks'];
 if(Object.keys(input).some(k=>!allowed.includes(k)))readerFail('profile_fields','Ця форма не може змінювати ім’я, клас або права читача.');
 if(typeof input.displayName!=='string'||typeof input.phone!=='string'||typeof input.communityEnabled!=='boolean'||!Number.isInteger(input.expectedVersion)||input.expectedVersion<1)readerFail('profile_invalid','Перевірте поля профілю.');
 if((input.email!==undefined&&typeof input.email!=='string')||(input.about!==undefined&&typeof input.about!=='string'))readerFail('profile_invalid','Перевірте поля профілю.');
 const current=await getReaderProfile(db,identity);
 if(current.teacherLinked&&input.phone!==current.phone)readerFail('canonical_teacher_profile','Мобільний номер змінюється в основному кабінеті вчителя.',409);
 const displayName=input.displayName.normalize('NFKC').trim().replace(/\s+/g,' '),phone=input.phone.trim(),email=input.email===undefined?String(current.email):input.email.trim(),about=input.about===undefined?String(current.about):input.about.trim();
 if(displayName.length<2||displayName.length>180||/[<>\x00-\x1F]/.test(displayName)||phone.length>30||(phone&&(!/^\+?[0-9() .-]{7,30}$/.test(phone)||phone.replace(/\D/g,'').length>15))||email.length>254||(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))||about.length>300)readerFail('profile_invalid','Перевірте ім’я, телефон і email. «Про себе» — до 300 символів.');
 if(current.kind!=='student'&&about!==current.about)readerFail('profile_fields','Поле «Про себе» доступне в обліковому записі учня.');
 const replay=await readerReplay(db,identity,input.requestId,'profile',input);if(replay.replayed)return replay.replayed;
 const now=new Date().toISOString(),changes=[email!==current.email?'Електронну пошту':null,phone!==current.phone?'Мобільний номер':null,displayName!==current.displayName?'Ім’я у спільноті':null,about!==current.about?'Опис «Про себе»':null,input.communityEnabled!==current.communityEnabled?'Участь у спільноті':null].filter(Boolean);
 const result={version:input.expectedVersion+(changes.length?1:0)};
 const statements=[readerReceipt(db,identity,input.requestId,'profile',replay.hash,result,now),db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM reader_profiles WHERE reader_id=? AND version=?) THEN 1 ELSE json('profile_version_changed') END").bind(identity.readerId,input.expectedVersion)];
 if(changes.length)statements.push(db.prepare("UPDATE reader_profiles SET display_name=?,phone=CASE WHEN EXISTS(SELECT 1 FROM library_readers r WHERE r.id=reader_profiles.reader_id AND r.linked_teacher_user_id IS NOT NULL) THEN phone ELSE ? END,email=?,about=?,community_enabled=?,version=version+1,updated_at=? WHERE reader_id=? AND version=?").bind(displayName,phone,email,about,Number(input.communityEnabled),now,identity.readerId,input.expectedVersion),requireChanged(db,1),readerEvent(db,{readerId:identity.readerId,key:'profile:'+input.requestId,kind:'account',title:'Обліковий запис оновлено',body:changes.join(', ')+': зміни збережено.',tab:'profile'},now));
 await readerBatch(db,statements);return result;
}
export async function getReaderBooks(db:ReaderDatabase,identity:ReaderIdentity){
  const loans=await db.prepare(`SELECT l.id,l.status,l.issued_at,l.due_at,l.received_at,l.version,c.accession_no,c.copy_no,e.id AS edition_id,e.title,
    json_extract(e.public_metadata_json,'$.author') AS author,${libraryCoverSql} AS cover_url
    FROM reader_circulations l JOIN library_copies c ON c.id=l.copy_id JOIN library_editions e ON e.id=c.edition_id LEFT JOIN materials m ON m.id=e.material_id
    WHERE l.reader_id=? ORDER BY CASE WHEN l.status IN ('issued','overdue') THEN 0 ELSE 1 END,l.due_at DESC,l.id DESC LIMIT 300`).bind(identity.readerId).all();
  const requests=await db.prepare(`SELECT q.id,q.edition_id,q.status,q.note,q.version,q.created_at,e.title,${libraryCoverSql} AS cover_url
    FROM reader_book_requests q JOIN library_editions e ON e.id=q.edition_id LEFT JOIN materials m ON m.id=e.material_id WHERE q.reader_id=? ORDER BY q.created_at DESC LIMIT 200`).bind(identity.readerId).all();
  return {loans:loans.results||[],requests:requests.results||[]};
}
export async function getReaderBookState(db:ReaderDatabase,identity:ReaderIdentity,editionId:string){
  const rating=await db.prepare("SELECT rating,body,review_state,version FROM library_ratings WHERE edition_id=? AND reader_id=?").bind(editionId,identity.readerId).first();
  const subscription=await db.prepare("SELECT 1 AS subscribed FROM reader_book_subscriptions WHERE edition_id=? AND reader_id=?").bind(editionId,identity.readerId).first();
  const request=await db.prepare("SELECT id,status,note,version FROM reader_book_requests WHERE edition_id=? AND reader_id=? AND status IN ('requested','ready')").bind(editionId,identity.readerId).first();
  return {rating,subscribed:!!subscription,request};
}

export async function requestReaderBook(db:ReaderDatabase,identity:ReaderIdentity,input:{requestId:string;editionId:string;note:string;confirmation:string}){
  if(input.confirmation!=="CONFIRM_BOOK_REQUEST"||typeof input.note!=="string"||input.note.length>1000)readerFail("request_confirm","Підтвердьте замовлення книги; примітка — до 1000 символів.");
  const replay=await readerReplay(db,identity,input.requestId,"book_request",input);if(replay.replayed)return replay.replayed;
  const now=new Date().toISOString(),id=crypto.randomUUID(),result={id,status:"requested"};
  await readerBatch(db,[readerReceipt(db,identity,input.requestId,"book_request",replay.hash,result,now),
    db.prepare(`INSERT INTO reader_book_requests(id,reader_id,edition_id,status,note,version,created_at,updated_at)
      VALUES(?,?,(SELECT e.id FROM library_editions e LEFT JOIN materials m ON m.id=e.material_id WHERE e.id=? AND e.fund='literature' AND e.publication_state='published' AND (m.id IS NULL OR m.status='active')),'requested',?,1,?,?)`).bind(id,identity.readerId,input.editionId,input.note.trim(),now,now),requestEvent(db,id,now)]);
  return result;
}
export async function cancelReaderBookRequest(db:ReaderDatabase,identity:ReaderIdentity,input:{requestId:string;id:string;expectedVersion:number}){
  const replay=await readerReplay(db,identity,input.requestId,"book_request_cancel",input);if(replay.replayed)return replay.replayed;
  const now=new Date().toISOString(),result={id:input.id,status:"cancelled"};
  await readerBatch(db,[readerReceipt(db,identity,input.requestId,"book_request_cancel",replay.hash,result,now),db.prepare("UPDATE reader_book_requests SET status='cancelled',version=version+1,updated_at=? WHERE id=? AND reader_id=? AND version=? AND status IN ('requested','ready')").bind(now,input.id,identity.readerId,input.expectedVersion),requireChanged(db,1),requestEvent(db,input.id,now)]);return result;
}
export async function saveReaderRating(db:ReaderDatabase,identity:ReaderIdentity,input:{requestId:string;editionId:string;rating:number;body:string;expectedVersion:number}){
  if(!Number.isInteger(input.rating)||input.rating<1||input.rating>5||typeof input.body!=="string"||input.body.length>4000||!Number.isInteger(input.expectedVersion)||input.expectedVersion<0)readerFail("rating_invalid","Оберіть від 1 до 5 зірок; відгук — до 4000 символів.");
  const replay=await readerReplay(db,identity,input.requestId,"rating",input);if(replay.replayed)return replay.replayed;
  const now=new Date().toISOString(),result={version:input.expectedVersion+1,reviewState:"published"};
  const statement=input.expectedVersion===0?db.prepare(`INSERT INTO library_ratings(edition_id,reader_id,rating,body,review_state,version,created_at,updated_at)
    VALUES((SELECT e.id FROM library_editions e LEFT JOIN materials m ON m.id=e.material_id WHERE e.id=? AND e.fund='literature' AND e.publication_state='published' AND (m.id IS NULL OR m.status='active')),?,?,?,?,1,?,?)`).bind(input.editionId,identity.readerId,input.rating,input.body.trim(),result.reviewState,now,now)
    :db.prepare(`UPDATE library_ratings SET rating=?,body=?,review_state=?,version=version+1,updated_at=? WHERE edition_id=? AND reader_id=? AND version=? AND EXISTS(SELECT 1 FROM library_editions e LEFT JOIN materials m ON m.id=e.material_id WHERE e.id=? AND e.fund='literature' AND e.publication_state='published' AND (m.id IS NULL OR m.status='active'))`).bind(input.rating,input.body.trim(),result.reviewState,now,input.editionId,identity.readerId,input.expectedVersion,input.editionId);
  await readerBatch(db,[readerReceipt(db,identity,input.requestId,"rating",replay.hash,result,now),statement,requireChanged(db,1)]);return result;
}
export async function setReaderBookSubscription(db:ReaderDatabase,identity:ReaderIdentity,input:{requestId:string;editionId:string;subscribed:boolean}){
  if(typeof input.subscribed!=="boolean")readerFail("subscription_invalid","Оберіть стан підписки.");
  const replay=await readerReplay(db,identity,input.requestId,"book_subscription",input);if(replay.replayed)return replay.replayed;
  const now=new Date().toISOString(),result={subscribed:input.subscribed};
  await readerBatch(db,[readerReceipt(db,identity,input.requestId,"book_subscription",replay.hash,result,now),input.subscribed
    ?db.prepare("INSERT INTO reader_book_subscriptions(reader_id,edition_id,created_at) VALUES(?,(SELECT e.id FROM library_editions e LEFT JOIN materials m ON m.id=e.material_id WHERE e.id=? AND e.fund='literature' AND e.publication_state='published' AND (m.id IS NULL OR m.status='active')),?) ON CONFLICT(reader_id,edition_id) DO NOTHING").bind(identity.readerId,input.editionId,now)
    :db.prepare("DELETE FROM reader_book_subscriptions WHERE reader_id=? AND edition_id=?").bind(identity.readerId,input.editionId)]);return result;
}
