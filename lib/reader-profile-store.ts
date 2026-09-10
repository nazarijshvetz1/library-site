import {libraryCoverSql} from "./library-reader-catalog.ts";
import {readerBatch,readerFail,readerReceipt,readerReplay,requireChanged,type ReaderDatabase,type ReaderIdentity} from "./reader-core.ts";

export async function getReaderProfile(db:ReaderDatabase,identity:ReaderIdentity){
  const row=await db.prepare(`SELECT r.id,r.full_name,r.member_no,r.kind,r.source_group_label,r.version AS reader_version,
    p.display_name,p.phone,p.photo_key,p.community_enabled,p.notify_loans,p.notify_books,p.version,
    cy.class_name AS class_label,ay.label AS academic_year,
    (CASE WHEN r.linked_teacher_user_id IS NOT NULL THEN (SELECT status FROM telegram_connections tc WHERE tc.user_id=r.linked_teacher_user_id) ELSE (SELECT status FROM reader_telegram_connections tc WHERE tc.reader_id=r.id) END) AS telegram_status
    FROM library_readers r JOIN reader_profiles p ON p.reader_id=r.id
    LEFT JOIN reader_class_enrollments ce ON ce.reader_id=r.id AND ce.ended_at IS NULL
    LEFT JOIN class_years cy ON cy.id=ce.class_year_id LEFT JOIN academic_years ay ON ay.id=cy.academic_year_id
    WHERE r.id=?`).bind(identity.readerId).first();
  if(!row)readerFail("reader_profile_missing","Профіль ще не підготовлений. Зверніться до бібліотекаря.",409);
  return {id:row.id,fullName:row.full_name,memberNo:row.member_no,kind:row.kind,classLabel:row.class_label||row.source_group_label||"",classSource:row.class_label?"current":"imported",academicYear:row.academic_year||null,
    displayName:row.display_name,phone:row.phone,photoUrl:row.photo_key?"/api/reader/photo?v="+row.version:null,communityEnabled:!!row.community_enabled,notifyLoans:false,notifyBooks:false,version:Number(row.version),telegramConnected:row.telegram_status==="active",teacherLinked:identity.sessionKind==="teacher"};
}
export async function updateReaderProfile(db:ReaderDatabase,identity:ReaderIdentity,input:{requestId:string;expectedVersion:number;displayName:string;phone:string;communityEnabled:boolean;notifyLoans:boolean;notifyBooks:boolean}){
  if(Object.keys(input).sort().join(",")!==["requestId","expectedVersion","displayName","phone","communityEnabled","notifyLoans","notifyBooks"].sort().join(","))readerFail("profile_fields","Ця форма не може змінювати ім’я, клас або права читача.");
  if(typeof input.displayName!=="string"||typeof input.phone!=="string"||![input.communityEnabled,input.notifyLoans,input.notifyBooks].every(value=>typeof value==="boolean")||!Number.isInteger(input.expectedVersion)||input.expectedVersion<1)readerFail("profile_invalid","Перевірте поля профілю.");
  if(input.notifyLoans||input.notifyBooks)readerFail("reader_notifications_unavailable","Нагадування про Librarika-видачі ще не активовані: потрібне перевірене офіційне джерело строків повернення.",409);
  const displayName=input.displayName.normalize("NFKC").trim().replace(/\s+/g," "),phone=input.phone.trim();
  if(displayName.length<2||displayName.length>50||[...displayName].some(character=>character==="<"||character===">"||character.charCodeAt(0)<32)||phone.length>30||(phone&&!/^\+?[0-9() .-]{7,30}$/.test(phone))||(phone&&(phone.replace(/\D/g,"").length<7||phone.replace(/\D/g,"").length>15)))readerFail("profile_invalid","Ім’я для спільноти: 2–50 символів; телефон — до 15 цифр. Телефон можна не вказувати.");
  const replay=await readerReplay(db,identity,input.requestId,"profile",input);if(replay.replayed)return replay.replayed;
  const now=new Date().toISOString(),result={version:input.expectedVersion+1};
  const consentDay=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Kyiv"}).format(new Date(now));
  await readerBatch(db,[readerReceipt(db,identity,input.requestId,"profile",replay.hash,result,now),
    db.prepare("UPDATE reader_profiles SET display_name=?,phone=?,community_enabled=?,notify_loans_since=CASE WHEN ?=1 AND notify_loans=0 THEN ? WHEN ?=0 THEN NULL ELSE notify_loans_since END,notify_books_since=CASE WHEN ?=1 AND notify_books=0 THEN ? WHEN ?=0 THEN NULL ELSE notify_books_since END,notify_loans=?,notify_books=?,version=version+1,updated_at=? WHERE reader_id=? AND version=?").bind(displayName,phone,Number(input.communityEnabled),Number(input.notifyLoans),consentDay,Number(input.notifyLoans),Number(input.notifyBooks),now,Number(input.notifyBooks),Number(input.notifyLoans),Number(input.notifyBooks),now,identity.readerId,input.expectedVersion),requireChanged(db,1),
    db.prepare("UPDATE reader_notification_outbox SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE reader_id=? AND status IN ('pending','processing') AND ((kind='book_available' AND ?=0) OR (kind!='book_available' AND ?=0))").bind(identity.readerId,Number(input.notifyBooks),Number(input.notifyLoans)),
  ]);return result;
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
      VALUES(?,?,(SELECT e.id FROM library_editions e JOIN materials m ON m.id=e.material_id AND m.status='active' WHERE e.id=? AND e.publication_state='published'),'requested',?,1,?,?)`).bind(id,identity.readerId,input.editionId,input.note.trim(),now,now)]);
  return result;
}
export async function cancelReaderBookRequest(db:ReaderDatabase,identity:ReaderIdentity,input:{requestId:string;id:string;expectedVersion:number}){
  const replay=await readerReplay(db,identity,input.requestId,"book_request_cancel",input);if(replay.replayed)return replay.replayed;
  const now=new Date().toISOString(),result={id:input.id,status:"cancelled"};
  await readerBatch(db,[readerReceipt(db,identity,input.requestId,"book_request_cancel",replay.hash,result,now),db.prepare("UPDATE reader_book_requests SET status='cancelled',version=version+1,updated_at=? WHERE id=? AND reader_id=? AND version=? AND status IN ('requested','ready')").bind(now,input.id,identity.readerId,input.expectedVersion),requireChanged(db,1)]);return result;
}
export async function saveReaderRating(db:ReaderDatabase,identity:ReaderIdentity,input:{requestId:string;editionId:string;rating:number;body:string;expectedVersion:number}){
  if(!Number.isInteger(input.rating)||input.rating<1||input.rating>5||typeof input.body!=="string"||input.body.length>4000||!Number.isInteger(input.expectedVersion)||input.expectedVersion<0)readerFail("rating_invalid","Оберіть від 1 до 5 зірок; відгук — до 4000 символів.");
  const replay=await readerReplay(db,identity,input.requestId,"rating",input);if(replay.replayed)return replay.replayed;
  const now=new Date().toISOString(),result={version:input.expectedVersion+1,reviewState:"published"};
  const statement=input.expectedVersion===0?db.prepare(`INSERT INTO library_ratings(edition_id,reader_id,rating,body,review_state,version,created_at,updated_at)
    VALUES((SELECT e.id FROM library_editions e JOIN materials m ON m.id=e.material_id AND m.status='active' WHERE e.id=? AND e.publication_state='published'),?,?,?,?,1,?,?)`).bind(input.editionId,identity.readerId,input.rating,input.body.trim(),result.reviewState,now,now)
    :db.prepare(`UPDATE library_ratings SET rating=?,body=?,review_state=?,version=version+1,updated_at=? WHERE edition_id=? AND reader_id=? AND version=? AND EXISTS(SELECT 1 FROM library_editions e JOIN materials m ON m.id=e.material_id AND m.status='active' WHERE e.id=? AND e.publication_state='published')`).bind(input.rating,input.body.trim(),result.reviewState,now,input.editionId,identity.readerId,input.expectedVersion,input.editionId);
  await readerBatch(db,[readerReceipt(db,identity,input.requestId,"rating",replay.hash,result,now),statement,requireChanged(db,1)]);return result;
}
export async function setReaderBookSubscription(db:ReaderDatabase,identity:ReaderIdentity,input:{requestId:string;editionId:string;subscribed:boolean}){
  if(typeof input.subscribed!=="boolean")readerFail("subscription_invalid","Оберіть стан підписки.");
  const replay=await readerReplay(db,identity,input.requestId,"book_subscription",input);if(replay.replayed)return replay.replayed;
  const now=new Date().toISOString(),result={subscribed:input.subscribed};
  await readerBatch(db,[readerReceipt(db,identity,input.requestId,"book_subscription",replay.hash,result,now),input.subscribed
    ?db.prepare("INSERT INTO reader_book_subscriptions(reader_id,edition_id,created_at) VALUES(?,(SELECT e.id FROM library_editions e JOIN materials m ON m.id=e.material_id AND m.status='active' WHERE e.id=? AND e.publication_state='published'),?) ON CONFLICT(reader_id,edition_id) DO NOTHING").bind(identity.readerId,input.editionId,now)
    :db.prepare("DELETE FROM reader_book_subscriptions WHERE reader_id=? AND edition_id=?").bind(identity.readerId,input.editionId)]);return result;
}
