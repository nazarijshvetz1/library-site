import {libraryCoverSql} from "./library-reader-catalog.ts";
import {normalizeCatalogSearchText} from "./catalog-d1.ts";
import {beginLibraryCommand,finishLibraryCommand,libraryCommand} from "./library-copy-store.ts";
import {readerBatch,readerFail,readerResource,requireChanged,type LibraryActor,type ReaderDatabase} from "./reader-core.ts";
const GENERATED_NUMBER_BASE=26000000,GENERATED_NUMBER_MAX=999999999;
const generatedOrdinal=(value:string)=>/^[0-9]+$/.test(value)&&Number(value)>GENERATED_NUMBER_BASE&&Number(value)<=GENERATED_NUMBER_MAX?Number(value)-GENERATED_NUMBER_BASE:null;

export async function listLibraryReaders(db:ReaderDatabase,url:URL){
  const query=normalizeCatalogSearchText(url.searchParams.get("q")||"");if(query.length>100)readerFail("reader_search","Скоротіть пошуковий запит.");
  const rows=await db.prepare(`SELECT r.id,r.full_name,r.member_no,r.kind,r.status,r.access_status,r.version,r.source_group_label,r.linked_teacher_user_id,
    cy.class_name,ce.class_year_id,p.phone,p.display_name,p.photo_key IS NOT NULL AS has_photo,
    (SELECT status FROM reader_telegram_connections WHERE reader_id=r.id) AS telegram_status,
    COALESCE((SELECT state FROM reader_platform_links WHERE reader_id=r.id AND platform='librarika'),CASE WHEN r.source_member_id IS NOT NULL THEN 'linked' ELSE 'not_queued' END) AS librarika_status
    FROM library_readers r LEFT JOIN reader_profiles p ON p.reader_id=r.id LEFT JOIN reader_class_enrollments ce ON ce.reader_id=r.id AND ce.ended_at IS NULL LEFT JOIN class_years cy ON cy.id=ce.class_year_id
    WHERE (?='' OR r.sort_name LIKE ? ESCAPE '!' OR r.member_no LIKE ? ESCAPE '!') ORDER BY r.sort_name,r.id LIMIT 600`).bind(query,"%"+query.replace(/[!%_]/g,v=>"!"+v)+"%","%"+query.replace(/[!%_]/g,v=>"!"+v)+"%").all();return rows.results||[];
}
export async function libraryReaderOptions(db:ReaderDatabase){const results=await db.batch([
  db.prepare("SELECT c.id,c.class_name,a.label AS year_label FROM class_years c JOIN academic_years a ON a.id=c.academic_year_id WHERE c.status IN ('active','planned') ORDER BY a.start_date DESC,c.grade,c.class_name"),
  db.prepare("SELECT u.id,u.full_name FROM users u JOIN teacher_profiles p ON p.teacher_user_id=u.id WHERE u.status='active' AND p.closed_at IS NULL ORDER BY u.sort_name,u.id"),
  db.prepare("SELECT id,name,type FROM locations WHERE status='active' AND type!='service' ORDER BY sort_order,name"),
]);return {classes:results[0].results||[],teachers:results[1].results||[],locations:results[2].results||[]};}
export async function saveLibraryReader(db:ReaderDatabase,actor:LibraryActor,input:{requestId:string;id?:string;expectedVersion?:number;fullName:string;memberNo?:string|null;kind:string;classYearId:string|null}){
  const requestedMemberNo=typeof input.memberNo==="string"?input.memberNo.trim():"",automaticNumber=!input.id&&!requestedMemberNo;
  if(typeof input.fullName!=="string"||input.fullName.trim().length<3||input.fullName.length>180||requestedMemberNo.length>50||(input.id&&!requestedMemberNo)||(input.id&&(!Number.isInteger(input.expectedVersion)||Number(input.expectedVersion)<1))||!["student","teacher","staff","other","unclassified"].includes(input.kind)||(input.classYearId&&!readerResource(input.classYearId)))readerFail("reader_fields","Перевірте ім’я, номер квитка, категорію та клас.");
  if(input.kind!=="student"&&input.classYearId)readerFail("reader_class","Клас призначається лише учневі.");
  if(!input.id&&requestedMemberNo&&!/^[\p{L}\p{N}][\p{L}\p{N}-]{0,49}$/u.test(requestedMemberNo))readerFail("reader_number_format","Читацький номер може містити лише літери, цифри та дефіс і має починатися з літери або цифри.");
  if(!input.id&&!await db.prepare("SELECT 1 ok FROM librarika_member_sync_runs WHERE state='applied' AND is_full_baseline=1 LIMIT 1").first())readerFail("reader_baseline_required","Спочатку синхронізуйте й окремо підтвердьте повний CSV Members із Librarika. Це захищає від повторення вже зайнятого читацького номера.",409);
  if(!input.id&&requestedMemberNo&&generatedOrdinal(requestedMemberNo)!==null)readerFail("reader_number_reserved","Цей числовий діапазон створює сайт. Для автоматичного номера залиште поле порожнім.",409);
  if(input.id){
    const existing=await db.prepare(`SELECT r.member_no,r.source_member_id,
      (SELECT state FROM reader_platform_links WHERE reader_id=r.id AND platform='librarika') AS librarika_state
      FROM library_readers r WHERE r.id=?`).bind(input.id).first();
    if(!existing)readerFail("reader_missing","Картку читача не знайдено.",404);
    if((existing.source_member_id||existing.librarika_state==="linked")&&requestedMemberNo!==existing.member_no)readerFail("reader_number_locked","Після зв’язування з Librarika читацький номер не можна змінити без окремої звірки.",409);
    if(requestedMemberNo!==existing.member_no&&!/^[\p{L}\p{N}][\p{L}\p{N}-]{0,49}$/u.test(requestedMemberNo))readerFail("reader_number_format","Читацький номер може містити лише літери, цифри та дефіс і має починатися з літери або цифри.");
    if(requestedMemberNo!==existing.member_no&&generatedOrdinal(requestedMemberNo)!==null)readerFail("reader_number_reserved","Цей числовий діапазон створює сайт. Оберіть інший номер або залиште чинний.",409);
  }
  const command=await libraryCommand(db,actor,input.requestId,"library.reader.save",input);if(command.replayed){const saved=await db.prepare("SELECT member_no FROM library_readers WHERE id=?").bind(String(command.replayed.id||"")).first();return {...command.replayed,memberNo:saved?.member_no||null};}
  const now=new Date().toISOString(),id=input.id||"READER-"+crypto.randomUUID(),result={id,version:input.id?Number(input.expectedVersion)+1:1},fullName=input.fullName.trim().replace(/\s+/g," "),desiredPayload=JSON.stringify({fullName,kind:input.kind,classYearId:input.classYearId});
  const statements=[beginLibraryCommand(db,actor,input.requestId,"library.reader.save",command.hash,id,now,"library_reader")];
  if(input.id)statements.push(db.prepare("UPDATE library_readers SET full_name=?,sort_name=?,member_no=?,kind=?,version=version+1,updated_at=? WHERE id=? AND version=? AND (linked_teacher_user_id IS NULL OR kind=?) AND (member_no=? OR (source_member_id IS NULL AND NOT EXISTS(SELECT 1 FROM reader_platform_links p WHERE p.reader_id=library_readers.id AND p.platform='librarika' AND p.state='linked')))").bind(fullName,normalizeCatalogSearchText(fullName),requestedMemberNo,input.kind,now,id,Number(input.expectedVersion),input.kind,requestedMemberNo),requireChanged(db,1));
  else if(automaticNumber)statements.push(
    db.prepare("INSERT INTO reader_number_allocations(request_id,reader_id,created_at) VALUES(?,?,?)").bind(input.requestId,id,now),
    db.prepare("INSERT INTO library_readers(id,member_no,full_name,sort_name,kind,status,access_status,created_at,updated_at) SELECT ?,CAST(26000000+ordinal AS TEXT),?,?,?,'active','inactive',?,? FROM reader_number_allocations WHERE request_id=?").bind(id,fullName,normalizeCatalogSearchText(fullName),input.kind,now,now,input.requestId),
  );
  else statements.push(db.prepare("INSERT INTO library_readers(id,member_no,full_name,sort_name,kind,status,access_status,created_at,updated_at) VALUES(?,?,?,?,?,'active','inactive',?,?)").bind(id,requestedMemberNo,fullName,normalizeCatalogSearchText(fullName),input.kind,now,now));
  statements.push(db.prepare("INSERT INTO reader_profiles(reader_id,display_name,updated_at) VALUES(?,'Читач',?) ON CONFLICT(reader_id) DO NOTHING").bind(id,now));
  if(input.classYearId)statements.push(db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM class_years WHERE id=? AND status IN ('active','planned')) THEN 1 ELSE json('class_closed') END").bind(input.classYearId));
  statements.push(db.prepare("UPDATE reader_class_enrollments SET ended_at=? WHERE reader_id=? AND ended_at IS NULL AND class_year_id IS NOT ?").bind(now,id,input.classYearId));
  if(input.classYearId)statements.push(db.prepare("INSERT INTO reader_class_enrollments(id,reader_id,class_year_id,observed_at) SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM reader_class_enrollments WHERE reader_id=? AND ended_at IS NULL)").bind(crypto.randomUUID(),id,input.classYearId,now,id));
  statements.push(db.prepare(`INSERT INTO reader_platform_links(reader_id,platform,member_no,external_member_id,state,desired_payload_json,created_at,updated_at)
    SELECT id,'librarika',member_no,source_member_id,CASE WHEN source_member_id IS NULL THEN 'manual_required' ELSE 'linked' END,?,?,? FROM library_readers WHERE id=?
    ON CONFLICT(reader_id,platform) DO UPDATE SET member_no=excluded.member_no,external_member_id=COALESCE(reader_platform_links.external_member_id,excluded.external_member_id),state=reader_platform_links.state,desired_payload_json=CASE WHEN reader_platform_links.state IN ('linked','disabled') THEN reader_platform_links.desired_payload_json ELSE excluded.desired_payload_json END,updated_at=excluded.updated_at`).bind(desiredPayload,now,now,id));
  statements.push(...finishLibraryCommand(db,actor,input.requestId,"library.reader.save",id,result,now,"library_reader"));await readerBatch(db,statements);const saved=await db.prepare("SELECT member_no FROM library_readers WHERE id=?").bind(id).first();return {...result,memberNo:saved?.member_no||null};
}
export async function changeReaderAccess(db:ReaderDatabase,actor:LibraryActor,input:{requestId:string;readerId:string;expectedVersion:number;action:"disable"|"unblock"|"disconnect";confirmation:string}){
  if(!["disable","unblock","disconnect"].includes(input.action)||input.confirmation!=="CONFIRM_READER_ACCESS")readerFail("reader_access","Підтвердьте зміну доступу читача.");
  const command=await libraryCommand(db,actor,input.requestId,"library.reader.access",input);if(command.replayed)return command.replayed;
  const now=new Date().toISOString(),result={id:input.readerId,action:input.action,version:input.expectedVersion+1};
  await readerBatch(db,[beginLibraryCommand(db,actor,input.requestId,"library.reader.access",command.hash,input.readerId,now),
    db.prepare("UPDATE library_readers SET access_status=CASE WHEN ?='unblock' AND linked_teacher_user_id IS NOT NULL AND EXISTS(SELECT 1 FROM users u JOIN teacher_profiles p ON p.teacher_user_id=u.id WHERE u.id=library_readers.linked_teacher_user_id AND u.status='active' AND p.closed_at IS NULL) THEN 'active' ELSE ? END,access_version=access_version+1,version=version+1,updated_at=? WHERE id=? AND version=?").bind(input.action,input.action==="disable"?"blocked":"inactive",now,input.readerId,input.expectedVersion),requireChanged(db,1),
    db.prepare("UPDATE reader_sessions SET revoked_at=? WHERE reader_id=? AND revoked_at IS NULL").bind(now,input.readerId),
    db.prepare("UPDATE reader_invites SET revoked_at=? WHERE reader_id=? AND consumed_at IS NULL AND revoked_at IS NULL").bind(now,input.readerId),
    db.prepare("UPDATE reader_telegram_connections SET status=?,disabled_at=?,version=version+1 WHERE reader_id=?").bind(input.action==="disable"?"blocked":"disabled",now,input.readerId),
    db.prepare("UPDATE reader_notification_outbox SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE reader_id=? AND status IN ('pending','processing')").bind(input.readerId),
    ...finishLibraryCommand(db,actor,input.requestId,"library.reader.access",input.readerId,result,now)]);return result;
}
export async function linkReaderTeacher(db:ReaderDatabase,actor:LibraryActor,input:{requestId:string;readerId:string;expectedVersion:number;teacherUserId:string;confirmation:string}){
  const teacher=await db.prepare("SELECT u.id,u.full_name FROM users u JOIN teacher_profiles p ON p.teacher_user_id=u.id WHERE u.id=? AND u.status='active' AND p.closed_at IS NULL").bind(input.teacherUserId).first();
  if(!teacher||input.confirmation!==teacher.full_name)readerFail("teacher_link_confirmation","Введіть точне повне ім’я обраного вчителя для підтвердження відповідності.");
  const command=await libraryCommand(db,actor,input.requestId,"library.reader.teacher_link",input);if(command.replayed)return command.replayed;
  const now=new Date().toISOString(),result={id:input.readerId,teacherUserId:input.teacherUserId,version:input.expectedVersion+1};
  await readerBatch(db,[beginLibraryCommand(db,actor,input.requestId,"library.reader.teacher_link",command.hash,input.readerId,now),
    db.prepare("UPDATE library_readers SET linked_teacher_user_id=(SELECT u.id FROM users u JOIN teacher_profiles p ON p.teacher_user_id=u.id WHERE u.id=? AND u.full_name=? AND u.status='active' AND p.closed_at IS NULL),kind='teacher',access_status='active',access_version=access_version+1,version=version+1,updated_at=? WHERE id=? AND version=? AND kind!='student' AND status='active' AND access_status!='blocked' AND linked_teacher_user_id IS NULL AND EXISTS(SELECT 1 FROM users u JOIN teacher_profiles p ON p.teacher_user_id=u.id WHERE u.id=? AND u.full_name=? AND u.status='active' AND p.closed_at IS NULL)").bind(input.teacherUserId,input.confirmation,now,input.readerId,input.expectedVersion,input.teacherUserId,input.confirmation),requireChanged(db,1),
    db.prepare("INSERT INTO reader_profiles(reader_id,display_name,updated_at) VALUES(?,'Читач',?) ON CONFLICT(reader_id) DO NOTHING").bind(input.readerId,now),
    db.prepare("UPDATE reader_sessions SET revoked_at=? WHERE reader_id=? AND revoked_at IS NULL").bind(now,input.readerId),db.prepare("UPDATE reader_invites SET revoked_at=? WHERE reader_id=? AND consumed_at IS NULL AND revoked_at IS NULL").bind(now,input.readerId),
    db.prepare("UPDATE reader_telegram_connections SET status='disabled',version=version+1,disabled_at=? WHERE reader_id=?").bind(now,input.readerId),
    ...finishLibraryCommand(db,actor,input.requestId,"library.reader.teacher_link",input.readerId,result,now)]);return result;
}
export async function listReaderCirculations(db:ReaderDatabase,url:URL){
  const status=url.searchParams.get("status")||"all",readerId=url.searchParams.get("reader")||"",query=normalizeCatalogSearchText(url.searchParams.get("q")||"");if(!["all","issued","overdue","returned","pending","reserved","cancelled"].includes(status)||query.length>100)readerFail("loan_filter","Перевірте фільтри видач.");
  const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Kyiv"}).format(new Date());
  const filter=status==="all"?"1":status==="overdue"?"l.status IN ('issued','overdue') AND l.due_at IS NOT NULL AND substr(l.due_at,1,10)<?":status==="issued"?"l.status IN ('issued','overdue')":"l.status=?";
  const bindings:(string|number)[]=[];if(!["all","issued"].includes(status))bindings.push(status==="overdue"?today:status);
  const rows=await db.prepare(`SELECT l.id,l.copy_id,l.reader_id,l.status,l.issued_at,l.due_at,l.received_at,l.accounting_mode,l.version,c.version AS copy_version,c.accession_no,c.copy_no,c.location_id,c.condition,e.id AS edition_id,e.title,${libraryCoverSql} cover_url,r.full_name,r.member_no,r.source_group_label
    FROM reader_circulations l JOIN library_copies c ON c.id=l.copy_id JOIN library_editions e ON e.id=c.edition_id LEFT JOIN materials m ON m.id=e.material_id JOIN library_readers r ON r.id=l.reader_id WHERE (${filter}) AND (?='' OR r.id=?) AND (?='' OR r.sort_name LIKE ? ESCAPE '!' OR m.search_text LIKE ? ESCAPE '!' OR e.title LIKE ? ESCAPE '!') ORDER BY CASE WHEN l.status IN ('issued','overdue') THEN 0 ELSE 1 END,l.due_at,l.id LIMIT 1000`).bind(...bindings,readerId,readerId,query,"%"+query.replace(/[!%_]/g,v=>"!"+v)+"%","%"+query.replace(/[!%_]/g,v=>"!"+v)+"%","%"+(url.searchParams.get("q")||"").replace(/[!%_]/g,v=>"!"+v)+"%").all();return rows.results||[];
}
export async function listLibrarianCopies(db:ReaderDatabase,url:URL){const editionId=url.searchParams.get("edition")||"",code=(url.searchParams.get("code")||"").trim();if(!editionId&&!code)return[];if(code.length>120)readerFail("copy_code","Код завеликий.");
  const rows=await db.prepare(`SELECT c.id,c.edition_id,c.accession_no,c.copy_no,c.location_id,c.condition,c.physical_state,c.registration,c.version,e.title,
   (SELECT l.id FROM reader_circulations l WHERE l.copy_id=c.id AND l.status IN ('issued','overdue')) circulation_id FROM library_copies c JOIN library_editions e ON e.id=c.edition_id LEFT JOIN materials m ON m.id=e.material_id
   WHERE (?<>'' AND e.id=?) OR (?<>'' AND (c.id=? OR e.id=? OR c.accession_no=? OR json_extract(e.public_metadata_json,'$.isbn13')=? OR json_extract(e.public_metadata_json,'$.isbn')=?)) ORDER BY e.title,c.copy_no,c.id LIMIT 200`).bind(editionId,editionId,code,code,code,code,code,code).all();return rows.results||[];
}
export async function libraryReaderDashboard(db:ReaderDatabase){const stats=await db.prepare(`SELECT
  (SELECT COUNT(*) FROM library_readers) readers,
  (SELECT COUNT(*) FROM reader_platform_links WHERE platform='librarika' AND state='linked') linked,
  (SELECT COUNT(*) FROM reader_platform_links WHERE platform='librarika' AND state IN ('pending','processing','manual_required')) pending,
  (SELECT COUNT(*) FROM reader_platform_links WHERE platform='librarika' AND state IN ('conflict','failed')) conflicts,
  EXISTS(SELECT 1 FROM librarika_member_sync_runs WHERE state='applied' AND is_full_baseline=1) baseline_ready`).first();return {counts:stats};}
export async function listReaderRequests(db:ReaderDatabase){return (await db.prepare(`SELECT q.*,r.full_name,r.member_no,r.version reader_version,e.title,${libraryCoverSql} cover_url FROM reader_book_requests q JOIN library_readers r ON r.id=q.reader_id JOIN library_editions e ON e.id=q.edition_id LEFT JOIN materials m ON m.id=e.material_id ORDER BY CASE WHEN q.status IN ('requested','ready') THEN 0 ELSE 1 END,q.created_at DESC LIMIT 500`).all()).results||[];}
export async function setReaderRequestStatus(db:ReaderDatabase,actor:LibraryActor,input:{requestId:string;id:string;expectedVersion:number;status:string}){
  if(!["ready","rejected"].includes(input.status))readerFail("request_status","Оберіть підготовку або відхилення замовлення.");const command=await libraryCommand(db,actor,input.requestId,"library.reader.request",input);if(command.replayed)return command.replayed;const now=new Date().toISOString(),result={id:input.id,status:input.status,version:input.expectedVersion+1};
  await readerBatch(db,[beginLibraryCommand(db,actor,input.requestId,"library.reader.request",command.hash,input.id,now),db.prepare("UPDATE reader_book_requests SET status=?,version=version+1,updated_at=? WHERE id=? AND version=? AND status IN ('requested','ready')").bind(input.status,now,input.id,input.expectedVersion),requireChanged(db,1),...finishLibraryCommand(db,actor,input.requestId,"library.reader.request",input.id,result,now)]);return result;
}
export async function libraryModerationQueue(db:ReaderDatabase){const results=await db.batch([
  db.prepare("SELECT x.edition_id,x.reader_id,x.rating,x.body,x.review_state,x.version,e.title,p.display_name FROM library_ratings x JOIN library_editions e ON e.id=x.edition_id JOIN reader_profiles p ON p.reader_id=x.reader_id WHERE x.review_state='pending' ORDER BY x.updated_at LIMIT 200"),
  db.prepare("SELECT r.id,r.reason,r.created_at,r.thread_id,r.message_id,x.body,x.reader_id AS author_id,x.edition_id,p.display_name AS author_name,reporter.display_name AS reporter_name,t.kind FROM reading_reports r JOIN reading_messages x ON x.id=r.message_id JOIN reader_profiles p ON p.reader_id=x.reader_id JOIN reader_profiles reporter ON reporter.reader_id=r.reporter_reader_id JOIN reading_threads t ON t.id=r.thread_id WHERE r.status='open' ORDER BY r.created_at LIMIT 200"),
]);return {reviews:results[0].results||[],reports:results[1].results||[]};}
export async function moderateReaderContent(db:ReaderDatabase,actor:LibraryActor,input:{requestId:string;kind:"review"|"report";editionId?:string;readerId?:string;expectedVersion?:number;id?:string;publish?:boolean;hideMessage?:boolean}){
  const command=await libraryCommand(db,actor,input.requestId,"library.reader.moderate",input);if(command.replayed)return command.replayed;const now=new Date().toISOString(),target=input.kind==="review"?String(input.editionId):String(input.id),result={id:target,kind:input.kind};const statements=[beginLibraryCommand(db,actor,input.requestId,"library.reader.moderate",command.hash,target,now)];
  if(input.kind==="review"&&typeof input.publish==="boolean")statements.push(db.prepare("UPDATE library_ratings SET review_state=?,version=version+1,updated_at=? WHERE edition_id=? AND reader_id=? AND version=? AND review_state='pending'").bind(input.publish?"published":"hidden",now,String(input.editionId),String(input.readerId),Number(input.expectedVersion)),requireChanged(db,1));
  else if(input.kind==="report"&&typeof input.hideMessage==="boolean"){
    if(input.hideMessage)statements.push(db.prepare("UPDATE reading_messages SET status='hidden' WHERE id=(SELECT message_id FROM reading_reports WHERE id=? AND status='open')").bind(String(input.id)),requireChanged(db,1));
    statements.push(db.prepare("UPDATE reading_reports SET status=?,resolved_at=?,resolved_by=? WHERE id=? AND status='open'").bind(input.hideMessage?"resolved":"dismissed",now,actor.id,String(input.id)),requireChanged(db,1));
  }else readerFail("moderation_action","Перевірте дію модерації.");
  statements.push(...finishLibraryCommand(db,actor,input.requestId,"library.reader.moderate",target,result,now));await readerBatch(db,statements);return result;
}
