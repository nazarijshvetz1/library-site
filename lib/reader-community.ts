import {readerBatch,readerFail,readerReceipt,readerReplay,readerResource,readerGuard,requireChanged,type ReaderDatabase,type ReaderIdentity} from "./reader-core.ts";

const blockSql="EXISTS(SELECT 1 FROM reader_blocks b WHERE (b.reader_id=? AND b.blocked_reader_id=?) OR (b.reader_id=? AND b.blocked_reader_id=?))";
const publicBookThread="(t.kind!='book' OR EXISTS(SELECT 1 FROM library_editions e JOIN materials material ON material.id=e.material_id AND material.status='active' WHERE e.id=t.edition_id AND e.publication_state='published'))";
export async function requireReaderCommunity(db:ReaderDatabase,readerId:string){const row=await db.prepare("SELECT 1 ok FROM reader_profiles p JOIN library_readers r ON r.id=p.reader_id WHERE r.id=? AND r.status='active' AND r.access_status='active' AND p.community_enabled=1").bind(readerId).first();if(!row)readerFail("community_disabled","Увімкни читацьку спільноту в профілі, щоб долучитися до спілкування.",403);}
function communityGate(db:ReaderDatabase,identity:ReaderIdentity){return db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM reader_profiles WHERE reader_id=? AND community_enabled=1) THEN 1 ELSE json('community_disabled') END").bind(identity.readerId);}
function memberGate(db:ReaderDatabase,identity:ReaderIdentity,threadId:string){return db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM reading_memberships mm JOIN reading_threads t ON t.id=mm.thread_id WHERE mm.reader_id=? AND mm.thread_id=? AND mm.status='accepted' AND t.status='active' AND ${publicBookThread}) THEN 1 ELSE json('membership_required') END`).bind(identity.readerId,threadId);}
function directGate(db:ReaderDatabase,threadId:string){return db.prepare(`SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM reading_threads t WHERE t.id=? AND t.kind='direct' AND (
  (SELECT count(*) FROM reading_memberships m JOIN library_readers r ON r.id=m.reader_id JOIN reader_profiles p ON p.reader_id=r.id WHERE m.thread_id=t.id AND m.status='accepted' AND r.status='active' AND r.access_status='active' AND p.community_enabled=1)!=2 OR EXISTS(SELECT 1 FROM reading_memberships a JOIN reading_memberships b ON b.thread_id=a.thread_id AND a.reader_id!=b.reader_id JOIN reader_blocks block ON block.reader_id=a.reader_id AND block.blocked_reader_id=b.reader_id WHERE a.thread_id=t.id))) THEN 1 ELSE json('direct_not_accepted') END`).bind(threadId);}

export async function listReadingThreads(db:ReaderDatabase,identity:ReaderIdentity){await requireReaderCommunity(db,identity.readerId);
  const rows=await db.prepare(`SELECT t.id,t.kind,t.title,t.edition_id,t.owner_reader_id,t.updated_at,m.status AS membership_status,m.role,
    (SELECT p.display_name FROM reading_memberships other JOIN reader_profiles p ON p.reader_id=other.reader_id WHERE other.thread_id=t.id AND other.reader_id!=? LIMIT 1) AS partner_name
    FROM reading_threads t JOIN reading_memberships m ON m.thread_id=t.id WHERE m.reader_id=? AND m.status IN ('accepted','invited') AND t.status='active' AND ${publicBookThread} ORDER BY t.updated_at DESC,t.id LIMIT 100`).bind(identity.readerId,identity.readerId).all();return rows.results||[];}
export async function findCommunityReaders(db:ReaderDatabase,identity:ReaderIdentity,query:string){await requireReaderCommunity(db,identity.readerId);query=query.normalize("NFKC").trim();if(query.length<2||query.length>50)return[];
  // Only opt-in display names. No student names, phones, classes, member numbers or borrowing histories.
  const rows=await db.prepare(`SELECT r.id,p.display_name FROM reader_profiles p JOIN library_readers r ON r.id=p.reader_id WHERE r.id!=? AND p.community_enabled=1 AND r.status='active' AND r.access_status='active' ORDER BY p.display_name,r.id LIMIT 1000`).bind(identity.readerId).all();
  const blocks=await db.prepare("SELECT reader_id,blocked_reader_id FROM reader_blocks WHERE reader_id=? OR blocked_reader_id=?").bind(identity.readerId,identity.readerId).all();
  const excluded=new Set((blocks.results||[]).map(row=>String(row.reader_id===identity.readerId?row.blocked_reader_id:row.reader_id)));
  return (rows.results||[]).filter(row=>!excluded.has(String(row.id))&&String(row.display_name).toLocaleLowerCase("uk").includes(query.toLocaleLowerCase("uk"))).slice(0,20);
}
export async function getReadingMessages(db:ReaderDatabase,identity:ReaderIdentity,threadId:string){await requireReaderCommunity(db,identity.readerId);
  const member=await db.prepare(`SELECT 1 ok FROM reading_memberships m JOIN reading_threads t ON t.id=m.thread_id WHERE m.thread_id=? AND m.reader_id=? AND m.status='accepted' AND t.status='active' AND ${publicBookThread}`).bind(threadId,identity.readerId).first();if(!member)readerFail("thread_private","Спочатку прийми запрошення до розмови.",403);
  const guard=readerGuard(identity,new Date().toISOString());
  const messages=await db.prepare(`SELECT x.id,x.reader_id,x.body,x.edition_id,x.created_at,p.display_name,e.title AS book_title FROM reading_messages x JOIN reader_profiles p ON p.reader_id=x.reader_id LEFT JOIN library_editions e ON e.id=x.edition_id AND e.publication_state='published' AND EXISTS(SELECT 1 FROM materials material WHERE material.id=e.material_id AND material.status='active')
    WHERE x.thread_id=? AND x.status='visible'
      AND EXISTS(${guard.sql}) AND EXISTS(SELECT 1 FROM reader_profiles rp WHERE rp.reader_id=? AND rp.community_enabled=1)
      AND EXISTS(SELECT 1 FROM reading_memberships live JOIN reading_threads t ON t.id=live.thread_id WHERE live.thread_id=x.thread_id AND live.reader_id=? AND live.status='accepted' AND t.status='active' AND ${publicBookThread})
      AND NOT EXISTS(SELECT 1 FROM reader_blocks b WHERE (b.reader_id=? AND b.blocked_reader_id=x.reader_id) OR (b.blocked_reader_id=? AND b.reader_id=x.reader_id))
    ORDER BY x.created_at DESC,x.id DESC LIMIT 100`).bind(threadId,...guard.bindings,identity.readerId,identity.readerId,identity.readerId,identity.readerId).all();
  return (messages.results||[]).reverse();
}

export async function createReadingThread(db:ReaderDatabase,identity:ReaderIdentity,input:{requestId:string;kind:"book"|"group"|"direct";title:string;editionId?:string;recipientId?:string}){
  await requireReaderCommunity(db,identity.readerId);if(!["book","group","direct"].includes(input.kind)||typeof input.title!=="string"||input.title.trim().length>120)readerFail("thread_invalid","Вкажи назву читацької групи до 120 символів.");
  if(input.kind==="group"&&input.title.trim().length<3)readerFail("thread_invalid","Назва групи має містити щонайменше 3 символи.");
  if(input.kind==="direct"&&(!readerResource(input.recipientId)||input.recipientId===identity.readerId))readerFail("thread_recipient","Оберіть іншого учасника спільноти.");
  if(input.kind==="book"&&!readerResource(input.editionId))readerFail("thread_book","Оберіть книгу каталогу.");
  const replay=await readerReplay(db,identity,input.requestId,"thread_create",input);if(replay.replayed)return replay.replayed;
  const now=new Date().toISOString(),pair=input.kind==="direct"?[identity.readerId,input.recipientId!].sort().join(":"):null;
  const existing=input.kind==="direct"?await db.prepare("SELECT id FROM reading_threads WHERE direct_pair_key=? AND status='active'").bind(pair).first():input.kind==="book"?await db.prepare("SELECT id FROM reading_threads WHERE kind='book' AND edition_id=? AND status='active' ORDER BY created_at LIMIT 1").bind(input.editionId!).first():null;
  if(input.kind==="direct"&&!existing&&await db.prepare("SELECT 1 ok FROM reading_threads WHERE direct_pair_key=?").bind(pair).first())readerFail("conversation_closed","Цю особисту розмову закрито. За потреби створіть нову читацьку групу й запросіть учасника.",409);
  if(existing){
    const result={id:existing.id,existing:true};
    const statements=[readerReceipt(db,identity,input.requestId,"thread_create",replay.hash,result,now),communityGate(db,identity)];
    if(input.kind==="book")statements.push(joinStatement(db,identity,String(existing.id),now),requireChanged(db,1));
    else statements.push(db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM reading_memberships WHERE thread_id=? AND reader_id=? AND status IN ('accepted','invited')) THEN 1 ELSE json('conversation_closed') END").bind(String(existing.id),identity.readerId));
    await readerBatch(db,statements);return result;
  }
  const id=crypto.randomUUID(),result={id,kind:input.kind};
  const statements=[readerReceipt(db,identity,input.requestId,"thread_create",replay.hash,result,now),communityGate(db,identity)];
  if(input.kind==="direct")statements.push(db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM library_readers r JOIN reader_profiles p ON p.reader_id=r.id WHERE r.id=? AND r.status='active' AND r.access_status='active' AND p.community_enabled=1) AND NOT ${blockSql} THEN 1 ELSE json('recipient_unavailable') END`).bind(input.recipientId!,identity.readerId,input.recipientId!,input.recipientId!,identity.readerId));
  statements.push(db.prepare(`INSERT INTO reading_threads(id,kind,title,owner_reader_id,edition_id,direct_pair_key,status,created_at,updated_at)
    VALUES(?,?,CASE WHEN ?='book' THEN (SELECT e.title FROM library_editions e JOIN materials material ON material.id=e.material_id AND material.status='active' WHERE e.id=? AND e.publication_state='published') ELSE ? END,?,?,?,'active',?,?)`).bind(id,input.kind,input.kind,input.editionId||null,input.kind==="direct"?"Особиста розмова":input.title.trim(),identity.readerId,input.kind==="book"?input.editionId!:null,pair,now,now));
  statements.push(db.prepare("INSERT INTO reading_memberships(thread_id,reader_id,role,status,created_at,updated_at) VALUES(?,?,'owner','accepted',?,?)").bind(id,identity.readerId,now,now));
  if(input.kind==="direct")statements.push(db.prepare("INSERT INTO reading_memberships(thread_id,reader_id,role,status,created_at,updated_at) VALUES(?,?,'member','invited',?,?)").bind(id,input.recipientId!,now,now));
  await readerBatch(db,statements);return result;
}
function joinStatement(db:ReaderDatabase,identity:ReaderIdentity,threadId:string,now:string){return db.prepare(`INSERT INTO reading_memberships(thread_id,reader_id,role,status,created_at,updated_at) VALUES((SELECT t.id FROM reading_threads t WHERE t.id=? AND t.kind='book' AND t.status='active' AND ${publicBookThread}),?,'member','accepted',?,?)
    ON CONFLICT(thread_id,reader_id) DO UPDATE SET status='accepted',updated_at=excluded.updated_at WHERE reading_memberships.status IN ('invited','left','accepted')`).bind(threadId,identity.readerId,now,now);}
export async function joinBookDiscussion(db:ReaderDatabase,identity:ReaderIdentity,input:{requestId:string;threadId:string}){
  const replay=await readerReplay(db,identity,input.requestId,"thread_join",input);if(replay.replayed)return replay.replayed;const now=new Date().toISOString(),result={id:input.threadId};
  await readerBatch(db,[readerReceipt(db,identity,input.requestId,"thread_join",replay.hash,result,now),communityGate(db,identity),joinStatement(db,identity,input.threadId,now),requireChanged(db,1)]);return result;
}
export async function respondReadingInvite(db:ReaderDatabase,identity:ReaderIdentity,input:{requestId:string;threadId:string;accept:boolean}){
  if(typeof input.accept!=="boolean")readerFail("invite_response","Оберіть відповідь на запрошення.");const replay=await readerReplay(db,identity,input.requestId,"thread_response",input);if(replay.replayed)return replay.replayed;
  const now=new Date().toISOString(),result={id:input.threadId,status:input.accept?"accepted":"declined"};
  await readerBatch(db,[readerReceipt(db,identity,input.requestId,"thread_response",replay.hash,result,now),communityGate(db,identity),db.prepare("UPDATE reading_memberships SET status=?,updated_at=? WHERE thread_id=? AND reader_id=? AND status='invited' AND EXISTS(SELECT 1 FROM reading_threads WHERE id=? AND status='active')").bind(result.status,now,input.threadId,identity.readerId,input.threadId),requireChanged(db,1)]);return result;
}
export async function inviteReadingMember(db:ReaderDatabase,identity:ReaderIdentity,input:{requestId:string;threadId:string;recipientId:string}){
  if(!readerResource(input.recipientId)||input.recipientId===identity.readerId)readerFail("member_invalid","Оберіть іншого учасника.");const replay=await readerReplay(db,identity,input.requestId,"thread_invite",input);if(replay.replayed)return replay.replayed;
  const now=new Date().toISOString(),result={id:input.threadId};
  await readerBatch(db,[readerReceipt(db,identity,input.requestId,"thread_invite",replay.hash,result,now),communityGate(db,identity),db.prepare(`INSERT INTO reading_memberships(thread_id,reader_id,role,status,created_at,updated_at)
    VALUES((SELECT t.id FROM reading_threads t JOIN reading_memberships m ON m.thread_id=t.id WHERE t.id=? AND t.kind='group' AND t.status='active' AND m.reader_id=? AND m.status='accepted' AND m.role IN ('owner','moderator') AND (SELECT count(*) FROM reading_memberships WHERE thread_id=t.id AND status IN ('accepted','invited'))<100),
      (SELECT r.id FROM library_readers r JOIN reader_profiles p ON p.reader_id=r.id WHERE r.id=? AND r.status='active' AND r.access_status='active' AND p.community_enabled=1 AND NOT ${blockSql}),'member','invited',?,?)
    ON CONFLICT(thread_id,reader_id) DO UPDATE SET status='invited',updated_at=excluded.updated_at WHERE reading_memberships.status='left'`).bind(input.threadId,identity.readerId,input.recipientId,identity.readerId,input.recipientId,input.recipientId,identity.readerId,now,now),requireChanged(db,1)]);return result;
}
export async function sendReadingMessage(db:ReaderDatabase,identity:ReaderIdentity,input:{requestId:string;threadId:string;body:string;editionId?:string|null}){
  if(typeof input.body!=="string"||input.body.length>4000||(!input.body.trim()&&!input.editionId)||!readerResource(input.threadId)||(input.editionId&&!readerResource(input.editionId)))readerFail("message_invalid","Напиши повідомлення до 4000 символів або обери книгу.");
  const replay=await readerReplay(db,identity,input.requestId,"message",input);if(replay.replayed)return replay.replayed;const now=new Date().toISOString(),id=crypto.randomUUID(),result={id};
  await readerBatch(db,[readerReceipt(db,identity,input.requestId,"message",replay.hash,result,now),communityGate(db,identity),memberGate(db,identity,input.threadId),directGate(db,input.threadId),
    db.prepare(`SELECT CASE WHEN (SELECT count(*) FROM reading_messages WHERE reader_id=? AND created_at>?)<20 THEN 1 ELSE json('message_rate_limit') END`).bind(identity.readerId,new Date(Date.now()-60000).toISOString()),
    db.prepare("SELECT CASE WHEN ? IS NULL OR EXISTS(SELECT 1 FROM library_editions e JOIN materials material ON material.id=e.material_id AND material.status='active' WHERE e.id=? AND e.publication_state='published') THEN 1 ELSE json('book_unavailable') END").bind(input.editionId||null,input.editionId||null),
    db.prepare(`INSERT INTO reading_messages(id,thread_id,reader_id,body,edition_id,status,created_at) VALUES(?,?,?,?,?,'visible',?)`).bind(id,input.threadId,identity.readerId,input.body.trim(),input.editionId||null,now),
    db.prepare("UPDATE reading_threads SET updated_at=? WHERE id=?").bind(now,input.threadId)]);return result;
}
export async function blockCommunityReader(db:ReaderDatabase,identity:ReaderIdentity,input:{requestId:string;readerId:string;blocked:boolean}){
  if(!readerResource(input.readerId)||input.readerId===identity.readerId||typeof input.blocked!=="boolean")readerFail("block_invalid","Некоректний учасник.");const replay=await readerReplay(db,identity,input.requestId,"reader_block",input);if(replay.replayed)return replay.replayed;
  const now=new Date().toISOString(),result={blocked:input.blocked};
  await readerBatch(db,[readerReceipt(db,identity,input.requestId,"reader_block",replay.hash,result,now),communityGate(db,identity),input.blocked?db.prepare("INSERT INTO reader_blocks(reader_id,blocked_reader_id,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING").bind(identity.readerId,input.readerId,now):db.prepare("DELETE FROM reader_blocks WHERE reader_id=? AND blocked_reader_id=?").bind(identity.readerId,input.readerId)]);return result;
}
export async function reportReadingMessage(db:ReaderDatabase,identity:ReaderIdentity,input:{requestId:string;threadId:string;messageId:string;reason:string}){
  if(typeof input.reason!=="string"||input.reason.trim().length<5||input.reason.length>2000)readerFail("report_reason","Опиши причину звернення: від 5 до 2000 символів.");const replay=await readerReplay(db,identity,input.requestId,"reading_report",input);if(replay.replayed)return replay.replayed;const now=new Date().toISOString(),id=crypto.randomUUID(),result={id};
  await readerBatch(db,[readerReceipt(db,identity,input.requestId,"reading_report",replay.hash,result,now),communityGate(db,identity),memberGate(db,identity,input.threadId),db.prepare("INSERT INTO reading_reports(id,reporter_reader_id,thread_id,message_id,reason,status,created_at) SELECT ?,?,?,id,?,'open',? FROM reading_messages WHERE id=? AND thread_id=?").bind(id,identity.readerId,input.threadId,input.reason.trim(),now,input.messageId,input.threadId),requireChanged(db,1)]);return result;
}
export async function leaveReadingThread(db:ReaderDatabase,identity:ReaderIdentity,input:{requestId:string;threadId:string}){
  const replay=await readerReplay(db,identity,input.requestId,"thread_leave",input);if(replay.replayed)return replay.replayed;const now=new Date().toISOString(),result={id:input.threadId};
  await readerBatch(db,[readerReceipt(db,identity,input.requestId,"thread_leave",replay.hash,result,now),communityGate(db,identity),db.prepare("UPDATE reading_memberships SET status='left',updated_at=? WHERE thread_id=? AND reader_id=? AND status IN ('accepted','invited')").bind(now,input.threadId,identity.readerId),requireChanged(db,1),
    db.prepare("UPDATE reading_threads SET status='closed',updated_at=? WHERE id=? AND ((kind='group' AND owner_reader_id=?) OR kind='direct')").bind(now,input.threadId,identity.readerId)]);return result;
}
