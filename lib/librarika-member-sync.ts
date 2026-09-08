import {sha256Text} from "./librarika-import-plan.ts";
import {normalizeLibrarikaMember,type LibrarikaMemberRow,type NormalizedLibrarikaMember} from "./librarika-member-format.ts";
import {readerFail,type LibraryActor,type ReaderDatabase} from "./reader-core.ts";

const RUN_ID=/^LRK-SYNC-[A-Za-z0-9-]{20,80}$/;
const HASH=/^[0-9a-f]{64}$/;
const GENERATED_NUMBER_BASE=26000000;
const GENERATED_NUMBER_MAX=999999999;
const MAX_PART_ROWS=40;
const MAX_PARTS=200;
type ChangeRow={source_member_id:string;member_no:string;decision:"add"|"update"|"conflict";conflict_reason:string|null;candidate_reader_id:string|null;old_full_name:string|null;new_full_name:string;old_group:string|null;new_group:string;old_status:string|null;new_status:string};
type Preview={total:number;added:number;matched:number;changed:number;unchanged:number;conflicts:number;missingFromExport:number;nameChanges:number;groupChanges:number;sourceStatusChanges:number;changeRows:ChangeRow[]};
type SyncRunRow=Record<string,unknown>&{id:string;source_sha256:string;expected_rows:number;state:string;preview_json:string|null};

const candidateJoins=`FROM librarika_member_sync_rows s
  LEFT JOIN library_readers sr ON sr.source_member_id=s.source_member_id
  LEFT JOIN library_readers nr ON nr.member_no=s.member_no
  LEFT JOIN library_readers ir ON ir.id='LRK-RD-'||s.source_member_id
  LEFT JOIN reader_platform_links pe ON pe.platform='librarika' AND pe.external_member_id=s.source_member_id
  LEFT JOIN reader_platform_links pn ON pn.platform='librarika' AND pn.member_no=s.member_no
  LEFT JOIN reader_number_allocations ra ON ra.ordinal=CASE WHEN s.member_no<>'' AND s.member_no NOT GLOB '*[^0-9]*' AND CAST(s.member_no AS INTEGER) BETWEEN ${GENERATED_NUMBER_BASE+1} AND ${GENERATED_NUMBER_MAX} THEN CAST(s.member_no AS INTEGER)-${GENERATED_NUMBER_BASE} ELSE NULL END`;
const candidateId="COALESCE(sr.id,nr.id)";
const intendedReaderId="COALESCE(sr.id,nr.id,'LRK-RD-'||s.source_member_id)";
const conflictWhere=`(
  (sr.id IS NOT NULL AND sr.member_no<>s.member_no)
  OR (sr.id IS NOT NULL AND nr.id IS NOT NULL AND sr.id<>nr.id)
  OR (nr.id IS NOT NULL AND nr.source_member_id IS NOT NULL AND nr.source_member_id<>s.source_member_id)
  OR (sr.id IS NULL AND nr.id IS NOT NULL AND nr.sort_name<>s.sort_name)
  OR (sr.id IS NULL AND nr.id IS NULL AND ir.id IS NOT NULL)
  OR (pe.reader_id IS NOT NULL AND pe.reader_id<>${intendedReaderId})
  OR (pn.reader_id IS NOT NULL AND pn.reader_id<>${intendedReaderId})
  OR (ra.reader_id IS NOT NULL AND ra.reader_id<>${intendedReaderId})
)`;
const conflictReason=`CASE
  WHEN sr.id IS NOT NULL AND sr.member_no<>s.member_no THEN 'ID Librarika вже пов’язаний з іншим читацьким номером.'
  WHEN sr.id IS NOT NULL AND nr.id IS NOT NULL AND sr.id<>nr.id THEN 'ID Librarika і читацький номер вказують на різні локальні профілі.'
  WHEN nr.id IS NOT NULL AND nr.source_member_id IS NOT NULL AND nr.source_member_id<>s.source_member_id THEN 'Читацький номер уже пов’язаний з іншим ID Librarika.'
  WHEN sr.id IS NULL AND nr.id IS NOT NULL AND nr.sort_name<>s.sort_name THEN 'Читацький номер належить локальному профілю з іншим ПІБ.'
  WHEN sr.id IS NULL AND nr.id IS NULL AND ir.id IS NOT NULL THEN 'Технічний ID нового запису вже зайнятий.'
  WHEN pe.reader_id IS NOT NULL AND pe.reader_id<>${intendedReaderId} THEN 'ID Librarika вже закріплений за іншим профілем у реєстрі платформ.'
  WHEN pn.reader_id IS NOT NULL AND pn.reader_id<>${intendedReaderId} THEN 'Читацький номер уже закріплений за іншим профілем у реєстрі платформ.'
  WHEN ra.reader_id IS NOT NULL AND ra.reader_id<>${intendedReaderId} THEN 'Числовий читацький номер уже зарезервований іншому профілю.'
  ELSE NULL END`;
const intendedKind=`CASE WHEN COALESCE(sr.kind,nr.kind,'unclassified')='unclassified' AND (s.member_group GLOB '[1-9]-*' OR s.member_group GLOB '1[01]-*') THEN 'student' ELSE COALESCE(sr.kind,nr.kind,'unclassified') END`;
const changedWhere=`(
  COALESCE(sr.source_member_id,nr.source_member_id,'')<>s.source_member_id
  OR COALESCE(sr.full_name,nr.full_name,'')<>s.full_name
  OR COALESCE(sr.sort_name,nr.sort_name,'')<>s.sort_name
  OR COALESCE(sr.source_group_label,nr.source_group_label,'')<>s.member_group
  OR COALESCE(sr.source_json,nr.source_json,'')<>s.source_json
  OR COALESCE(sr.source_row_sha256,nr.source_row_sha256,'')<>s.row_sha256
  OR ${intendedKind}<>COALESCE(sr.kind,nr.kind,'unclassified')
)`;

export async function startLibrarikaMemberSync(db:ReaderDatabase,actor:LibraryActor,input:{requestId:string;sourceSha256:string;expectedRows:number}){
  if(typeof input.requestId!=="string"||input.requestId.length<16||input.requestId.length>100||!HASH.test(input.sourceSha256)||!Number.isInteger(input.expectedRows)||input.expectedRows<1||input.expectedRows>5000)readerFail("sync_start_invalid","Перевірте файл експорту читачів.");
  await expireTemporaryLibrarikaMemberSyncRows(db);
  const priorRequest=await db.prepare("SELECT id,source_sha256,expected_rows,state,preview_json FROM librarika_member_sync_runs WHERE request_id=?").bind(input.requestId).first<SyncRunRow>();
  if(priorRequest)return validateStarted(priorRequest,input);
  const priorDataset=await db.prepare("SELECT id,source_sha256,expected_rows,state,preview_json FROM librarika_member_sync_runs WHERE actor_user_id=? AND source_sha256=? AND state IN ('uploading','previewed') ORDER BY created_at DESC LIMIT 1").bind(actor.id,input.sourceSha256).first<SyncRunRow>();
  if(priorDataset?.state==="uploading")return validateStarted(priorDataset,input);
  const now=new Date().toISOString(),runId="LRK-SYNC-"+crypto.randomUUID();
  let startFailed=false;
  try{
    if(priorDataset?.state==="previewed")await db.batch([
      db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM librarika_member_sync_runs WHERE id=? AND actor_user_id=? AND source_sha256=? AND state='previewed') THEN 1 ELSE json('sync_run_changed') END").bind(priorDataset.id,actor.id,input.sourceSha256),
      db.prepare("DELETE FROM librarika_member_sync_parts WHERE run_id=?").bind(priorDataset.id),
      db.prepare("DELETE FROM librarika_member_sync_rows WHERE run_id=?").bind(priorDataset.id),
      db.prepare("UPDATE librarika_member_sync_runs SET state='failed',preview_json=json_set(COALESCE(preview_json,'{}'),'$.failureReason','superseded_for_repreview'),updated_at=? WHERE id=? AND state='previewed'").bind(now,priorDataset.id),
      db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('sync_run_changed') END"),
      db.prepare("INSERT INTO librarika_member_sync_runs(id,request_id,source_sha256,expected_rows,state,upload_revision,actor_user_id,created_at,updated_at) VALUES(?,?,?,?,'uploading',0,?,?,?)").bind(runId,input.requestId,input.sourceSha256,input.expectedRows,actor.id,now,now),
    ]);
    else await db.prepare("INSERT OR IGNORE INTO librarika_member_sync_runs(id,request_id,source_sha256,expected_rows,state,upload_revision,actor_user_id,created_at,updated_at) VALUES(?,?,?,?,'uploading',0,?,?,?)").bind(runId,input.requestId,input.sourceSha256,input.expectedRows,actor.id,now,now).all();
  }catch{startFailed=true;}
  const created=await db.prepare("SELECT id,source_sha256,expected_rows,state,preview_json FROM librarika_member_sync_runs WHERE request_id=? OR (actor_user_id=? AND source_sha256=? AND state IN ('uploading','previewed')) ORDER BY CASE WHEN request_id=? THEN 0 ELSE 1 END,created_at DESC LIMIT 1").bind(input.requestId,actor.id,input.sourceSha256,input.requestId).first<SyncRunRow>();
  if(!created)readerFail("sync_start_unavailable",startFailed?"Не вдалося відкрити сеанс синхронізації. Дані не змінено.":"Не вдалося підтвердити сеанс синхронізації. Дані не змінено.",503);
  return validateStarted(created,input);
}

export async function stageLibrarikaMemberSync(db:ReaderDatabase,actor:LibraryActor,input:{runId:string;sourceSha256:string;partIndex:number;rows:LibrarikaMemberRow[]}){
  if(!RUN_ID.test(input.runId)||!HASH.test(input.sourceSha256)||!Number.isInteger(input.partIndex)||input.partIndex<0||input.partIndex>=MAX_PARTS||!Array.isArray(input.rows)||input.rows.length<1||input.rows.length>MAX_PART_ROWS)readerFail("sync_part_invalid","Частина експорту некоректна.");
  let rows:NormalizedLibrarikaMember[];
  try{rows=await Promise.all(input.rows.map(normalizeLibrarikaMember));}catch(error){readerFail("sync_member_invalid",error instanceof Error?error.message:"Некоректний рядок експорту.");}
  const identities=new Set<string>(),numbers=new Set<string>();
  for(const row of rows){if(identities.has(row.sourceMemberId)||numbers.has(row.memberNo))readerFail("sync_part_conflict","У частині повторюється ID або читацький номер.",409);identities.add(row.sourceMemberId);numbers.add(row.memberNo);}
  const partSha256=await sha256Text(JSON.stringify(rows.map(row=>row.sourceJson)));
  const existing=await db.prepare("SELECT part_sha256,row_count FROM librarika_member_sync_parts WHERE run_id=? AND part_index=?").bind(input.runId,input.partIndex).first();
  if(existing)return validatePart(existing,partSha256,rows.length,input.partIndex);
  const now=new Date().toISOString();
  const statements=[
    db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM librarika_member_sync_runs WHERE id=? AND source_sha256=? AND actor_user_id=? AND state='uploading') THEN 1 ELSE json('sync_run_changed') END").bind(input.runId,input.sourceSha256,actor.id),
    ...rows.map(row=>db.prepare(`INSERT INTO librarika_member_sync_rows(run_id,source_member_id,member_no,full_name,sort_name,member_group,status,source_json,row_sha256,decision)
      VALUES(?,?,?,?,?,?,?,?,?,'pending')`).bind(input.runId,row.sourceMemberId,row.memberNo,row.fullName,row.sortName,row.memberGroup,row.status,row.sourceJson,row.rowSha256)),
    db.prepare("INSERT INTO librarika_member_sync_parts(run_id,part_index,part_sha256,row_count,received_at) VALUES(?,?,?,?,?)").bind(input.runId,input.partIndex,partSha256,rows.length,now),
    db.prepare("UPDATE librarika_member_sync_runs SET upload_revision=upload_revision+1,updated_at=? WHERE id=? AND source_sha256=? AND actor_user_id=? AND state='uploading'").bind(now,input.runId,input.sourceSha256,actor.id),
    db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('sync_run_changed') END"),
  ];
  try{await db.batch(statements);}catch(error){
    const replay=await db.prepare("SELECT part_sha256,row_count FROM librarika_member_sync_parts WHERE run_id=? AND part_index=?").bind(input.runId,input.partIndex).first();
    if(replay)return validatePart(replay,partSha256,rows.length,input.partIndex);
    if(/unique|constraint/i.test(String(error)))readerFail("sync_part_conflict","У файлі повторюється ID або читацький номер. Дані не застосовано.",409);
    readerFail("sync_stage_unavailable","Частину файлу не прийнято. Дані не застосовано; повторіть перевірку цього самого файлу.",503);
  }
  return {partIndex:input.partIndex,rowCount:rows.length,replayed:false};
}

export async function previewLibrarikaMemberSync(db:ReaderDatabase,actor:LibraryActor,input:{runId:string;sourceSha256:string}){
  const run=await requireRun(db,actor,input.runId,input.sourceSha256,["uploading","previewed"]);
  if(run.state==="previewed")return {runId:input.runId,state:"previewed",preview:await loadPreview(db,input.runId,run.preview_json)};
  const staged=await db.prepare("SELECT source_json FROM librarika_member_sync_rows WHERE run_id=? ORDER BY source_member_id").bind(input.runId).all();
  if((staged.results||[]).length!==Number(run.expected_rows))readerFail("sync_incomplete",`Отримано ${(staged.results||[]).length} із ${Number(run.expected_rows)} рядків. Завантажте цей самий файл ще раз.`,409);
  const verifiedHash=await sha256Text(JSON.stringify((staged.results||[]).map(row=>String(row.source_json))));
  if(verifiedHash!==input.sourceSha256)readerFail("sync_hash_mismatch","Вміст частин не відповідає вибраному CSV. Синхронізацію зупинено.",409);
  const now=new Date().toISOString();
  const candidates=`WITH candidates AS (SELECT s.run_id,s.source_member_id,${candidateId} AS candidate_reader_id,COALESCE(sr.version,nr.version) AS candidate_version,${conflictReason} AS conflict_reason,
      CASE WHEN ${conflictWhere} THEN 'conflict' WHEN ${candidateId} IS NULL THEN 'add' WHEN ${changedWhere} THEN 'update' ELSE 'unchanged' END AS decision
      ${candidateJoins} WHERE s.run_id=?)`;
  const statements=[
    db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM librarika_member_sync_runs WHERE id=? AND source_sha256=? AND actor_user_id=? AND state='uploading' AND upload_revision=? AND expected_rows=(SELECT COUNT(*) FROM librarika_member_sync_rows WHERE run_id=?)) THEN 1 ELSE json('sync_run_changed') END").bind(input.runId,input.sourceSha256,actor.id,Number(run.upload_revision),input.runId),
    db.prepare(`${candidates} UPDATE librarika_member_sync_rows AS target SET
      decision=(SELECT decision FROM candidates WHERE candidates.run_id=target.run_id AND candidates.source_member_id=target.source_member_id),
      conflict_reason=(SELECT conflict_reason FROM candidates WHERE candidates.run_id=target.run_id AND candidates.source_member_id=target.source_member_id),
      candidate_reader_id=(SELECT candidate_reader_id FROM candidates WHERE candidates.run_id=target.run_id AND candidates.source_member_id=target.source_member_id),
      candidate_version=(SELECT candidate_version FROM candidates WHERE candidates.run_id=target.run_id AND candidates.source_member_id=target.source_member_id)
      WHERE target.run_id=?`).bind(input.runId,input.runId),
    db.prepare("SELECT CASE WHEN changes()=(SELECT expected_rows FROM librarika_member_sync_runs WHERE id=?) THEN 1 ELSE json('sync_preview_rows_changed') END").bind(input.runId),
    db.prepare(`UPDATE librarika_member_sync_runs SET state='previewed',preview_json=(SELECT json_object(
      'total',COUNT(*),'added',SUM(decision='add'),'matched',SUM(decision IN ('update','unchanged')),'changed',SUM(decision='update'),
      'unchanged',SUM(decision='unchanged'),'conflicts',SUM(decision='conflict'),
      'missingFromExport',(SELECT COUNT(*) FROM library_readers r WHERE r.source_member_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM librarika_member_sync_rows x WHERE x.run_id=? AND x.source_member_id=r.source_member_id)),
      'nameChanges',SUM(decision='update' AND EXISTS(SELECT 1 FROM library_readers r WHERE r.id=librarika_member_sync_rows.candidate_reader_id AND r.full_name<>librarika_member_sync_rows.full_name)),
      'groupChanges',SUM(decision='update' AND EXISTS(SELECT 1 FROM library_readers r WHERE r.id=librarika_member_sync_rows.candidate_reader_id AND r.source_group_label<>librarika_member_sync_rows.member_group)),
      'sourceStatusChanges',SUM(decision='update' AND EXISTS(SELECT 1 FROM library_readers r WHERE r.id=librarika_member_sync_rows.candidate_reader_id AND lower(COALESCE(json_extract(r.source_json,'$.Status'),''))<>librarika_member_sync_rows.status))
    ) FROM librarika_member_sync_rows WHERE run_id=?),updated_at=? WHERE id=? AND source_sha256=? AND actor_user_id=? AND state='uploading' AND upload_revision=?`).bind(input.runId,input.runId,now,input.runId,input.sourceSha256,actor.id,Number(run.upload_revision)),
    db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('sync_run_changed') END"),
  ];
  try{await db.batch(statements);}catch{readerFail("sync_preview_changed","Дані змінилися під час перевірки. Нічого не застосовано; повторіть перевірку файлу.",409);}
  const saved=await db.prepare("SELECT preview_json FROM librarika_member_sync_runs WHERE id=? AND state='previewed'").bind(input.runId).first();
  return {runId:input.runId,state:"previewed",preview:await loadPreview(db,input.runId,saved?.preview_json)};
}

export async function applyLibrarikaMemberSync(db:ReaderDatabase,actor:LibraryActor,input:{runId:string;sourceSha256:string;confirmation:string;fullBaselineConfirmation:string}){
  if(input.confirmation!=="APPLY_MEMBERS_WITHOUT_DELETIONS"||input.fullBaselineConfirmation!=="THIS_IS_FULL_MEMBERS_EXPORT")readerFail("sync_confirmation","Підтвердьте, що це повний Members-експорт, і синхронізацію без видалень.");
  const run=await requireRun(db,actor,input.runId,input.sourceSha256,["previewed","applied"]);
  const preview=parsePreview(run.preview_json);
  if(run.state==="applied")return {runId:input.runId,state:"applied",...preview,replayed:true};
  const now=new Date().toISOString();
  const guardSql=`SELECT CASE WHEN EXISTS(SELECT 1 FROM librarika_member_sync_runs WHERE id=? AND source_sha256=? AND actor_user_id=? AND state='previewed')
    AND NOT EXISTS(SELECT 1 FROM librarika_member_sync_rows s WHERE s.run_id=? AND (
      s.decision='pending'
      OR (s.decision IN ('update','unchanged') AND NOT EXISTS(SELECT 1 FROM library_readers r WHERE r.id=s.candidate_reader_id AND r.version=s.candidate_version AND r.member_no=s.member_no AND (r.source_member_id=s.source_member_id OR (r.source_member_id IS NULL AND r.sort_name=s.sort_name))))
      OR (s.decision='add' AND (EXISTS(SELECT 1 FROM library_readers r WHERE r.source_member_id=s.source_member_id OR r.member_no=s.member_no OR r.id='LRK-RD-'||s.source_member_id)
        OR EXISTS(SELECT 1 FROM reader_platform_links p WHERE p.platform='librarika' AND (p.external_member_id=s.source_member_id OR p.member_no=s.member_no))
        OR EXISTS(SELECT 1 FROM reader_number_allocations a WHERE a.ordinal=CASE WHEN s.member_no<>'' AND s.member_no NOT GLOB '*[^0-9]*' AND CAST(s.member_no AS INTEGER) BETWEEN ${GENERATED_NUMBER_BASE+1} AND ${GENERATED_NUMBER_MAX} THEN CAST(s.member_no AS INTEGER)-${GENERATED_NUMBER_BASE} ELSE NULL END)))
    )) THEN 1 ELSE json('sync_candidates_changed') END`;
  const statements=[
    db.prepare(guardSql).bind(input.runId,input.sourceSha256,actor.id,input.runId),
    db.prepare(`INSERT OR IGNORE INTO reader_number_allocations(ordinal,request_id,reader_id,created_at)
      SELECT CAST(member_no AS INTEGER)-${GENERATED_NUMBER_BASE},'librarika:'||source_member_id,'LRK-RD-'||source_member_id,? FROM librarika_member_sync_rows
      WHERE run_id=? AND decision='add' AND member_no<>'' AND member_no NOT GLOB '*[^0-9]*' AND CAST(member_no AS INTEGER) BETWEEN ${GENERATED_NUMBER_BASE+1} AND ${GENERATED_NUMBER_MAX}`).bind(now,input.runId),
    db.prepare(`UPDATE library_readers AS r SET
      source_member_id=(SELECT source_member_id FROM librarika_member_sync_rows s WHERE s.run_id=? AND s.candidate_reader_id=r.id AND s.decision='update'),
      full_name=(SELECT full_name FROM librarika_member_sync_rows s WHERE s.run_id=? AND s.candidate_reader_id=r.id AND s.decision='update'),
      sort_name=(SELECT sort_name FROM librarika_member_sync_rows s WHERE s.run_id=? AND s.candidate_reader_id=r.id AND s.decision='update'),
      kind=CASE WHEN r.kind='unclassified' AND EXISTS(SELECT 1 FROM librarika_member_sync_rows s WHERE s.run_id=? AND s.candidate_reader_id=r.id AND s.decision='update' AND (s.member_group GLOB '[1-9]-*' OR s.member_group GLOB '1[01]-*')) THEN 'student' ELSE r.kind END,
      source_group_label=(SELECT member_group FROM librarika_member_sync_rows s WHERE s.run_id=? AND s.candidate_reader_id=r.id AND s.decision='update'),
      source_json=(SELECT source_json FROM librarika_member_sync_rows s WHERE s.run_id=? AND s.candidate_reader_id=r.id AND s.decision='update'),
      source_row_sha256=(SELECT row_sha256 FROM librarika_member_sync_rows s WHERE s.run_id=? AND s.candidate_reader_id=r.id AND s.decision='update'),
      version=version+1,updated_at=? WHERE id IN (SELECT candidate_reader_id FROM librarika_member_sync_rows WHERE run_id=? AND decision='update')`).bind(input.runId,input.runId,input.runId,input.runId,input.runId,input.runId,input.runId,now,input.runId),
    db.prepare(`INSERT INTO library_readers(id,source_member_id,member_no,full_name,sort_name,kind,status,access_status,source_group_label,source_json,source_row_sha256,created_at,updated_at)
      SELECT 'LRK-RD-'||source_member_id,source_member_id,member_no,full_name,sort_name,CASE WHEN member_group GLOB '[1-9]-*' OR member_group GLOB '1[01]-*' THEN 'student' ELSE 'unclassified' END,
        status,'inactive',member_group,source_json,row_sha256,?,? FROM librarika_member_sync_rows WHERE run_id=? AND decision='add'`).bind(now,now,input.runId),
    db.prepare(`INSERT INTO reader_profiles(reader_id,display_name,updated_at)
      SELECT r.id,'Читач',? FROM librarika_member_sync_rows s JOIN library_readers r ON r.source_member_id=s.source_member_id WHERE s.run_id=? AND s.decision<>'conflict'
      ON CONFLICT(reader_id) DO NOTHING`).bind(now,input.runId),
    db.prepare(`INSERT INTO reader_platform_links(reader_id,platform,member_no,external_member_id,state,desired_payload_json,last_checked_at,created_at,updated_at)
      SELECT r.id,'librarika',r.member_no,r.source_member_id,'linked','{}',?,?,? FROM librarika_member_sync_rows s JOIN library_readers r ON r.source_member_id=s.source_member_id WHERE s.run_id=? AND s.decision<>'conflict'
      ON CONFLICT(reader_id,platform) DO UPDATE SET member_no=excluded.member_no,external_member_id=excluded.external_member_id,state=CASE WHEN reader_platform_links.state='disabled' THEN 'disabled' ELSE 'linked' END,
        lease_token=NULL,lease_until=NULL,last_checked_at=excluded.last_checked_at,last_error=NULL,updated_at=excluded.updated_at`).bind(now,now,now,input.runId),
    db.prepare("DELETE FROM librarika_member_sync_parts WHERE run_id=?").bind(input.runId),
    db.prepare("DELETE FROM librarika_member_sync_rows WHERE run_id=?").bind(input.runId),
    db.prepare("UPDATE librarika_member_sync_runs SET state='applied',is_full_baseline=1,applied_at=?,updated_at=? WHERE id=? AND state='previewed'").bind(now,now,input.runId),
    db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('sync_run_changed') END"),
  ];
  try{await db.batch(statements);}catch{
    try{
      const settled=await db.prepare("SELECT state,preview_json FROM librarika_member_sync_runs WHERE id=? AND actor_user_id=?").bind(input.runId,actor.id).first();
      if(settled?.state==="applied")return {runId:input.runId,state:"applied",...parsePreview(settled.preview_json),replayed:true};
      await db.batch([
        db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM librarika_member_sync_runs WHERE id=? AND actor_user_id=? AND state='previewed') THEN 1 ELSE json('sync_run_changed') END").bind(input.runId,actor.id),
        db.prepare("DELETE FROM librarika_member_sync_parts WHERE run_id=?").bind(input.runId),
        db.prepare("DELETE FROM librarika_member_sync_rows WHERE run_id=?").bind(input.runId),
        db.prepare("UPDATE librarika_member_sync_runs SET state='failed',preview_json=json_set(COALESCE(preview_json,'{}'),'$.failureReason','apply_changed'),updated_at=? WHERE id=? AND actor_user_id=? AND state='previewed'").bind(now,input.runId,actor.id),
        db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('sync_run_changed') END"),
      ]);
    }catch{/* Preserve the original safe conflict response if cleanup loses a concurrent race. */}
    readerFail("sync_apply_changed","Картки читачів змінилися після перегляду. Нічого не застосовано; перевірте файл ще раз.",409);
  }
  return {runId:input.runId,state:"applied",...preview,replayed:false};
}

export async function librarikaMemberSyncStatus(db:ReaderDatabase){
  const latest=await db.prepare("SELECT id,state,expected_rows,is_full_baseline,preview_json,created_at,updated_at,applied_at FROM librarika_member_sync_runs ORDER BY created_at DESC LIMIT 1").first();
  const links=await db.prepare(`SELECT state,COUNT(*) count FROM (SELECT COALESCE((SELECT state FROM reader_platform_links p WHERE p.reader_id=r.id AND p.platform='librarika'),CASE WHEN r.source_member_id IS NULL THEN 'not_queued' ELSE 'linked' END) state FROM library_readers r) GROUP BY state ORDER BY state`).all();
  const worker=await db.prepare("SELECT scheduled_at,observed_at FROM worker_schedule_status WHERE id='minute'").first();
  return {latest:latest?{...latest,preview:latest.preview_json?parsePreview(latest.preview_json):null,preview_json:undefined}:null,links:links.results||[],worker:worker||null};
}

async function loadPreview(db:ReaderDatabase,runId:string,value:unknown):Promise<Preview>{
  const counts=parsePreview(value);
  const changes=await db.prepare(`SELECT s.source_member_id,s.member_no,s.decision,s.conflict_reason,s.candidate_reader_id,
    r.full_name AS old_full_name,s.full_name AS new_full_name,r.source_group_label AS old_group,s.member_group AS new_group,
    lower(COALESCE(json_extract(r.source_json,'$.Status'),'')) AS old_status,s.status AS new_status
    FROM librarika_member_sync_rows s LEFT JOIN library_readers r ON r.id=s.candidate_reader_id
    WHERE s.run_id=? AND s.decision IN ('add','update','conflict')
    ORDER BY CASE s.decision WHEN 'conflict' THEN 0 WHEN 'update' THEN 1 ELSE 2 END,s.full_name,s.source_member_id LIMIT 5000`).bind(runId).all();
  const changeRows=(changes.results||[]) as ChangeRow[];
  if(changeRows.length!==counts.added+counts.changed+counts.conflicts)readerFail("sync_preview_incomplete","Поіменний список змін неповний. Нічого не застосовуйте; повторіть перевірку.",409);
  return {...counts,changeRows};
}
function parsePreview(value:unknown):Omit<Preview,"changeRows">{const parsed=JSON.parse(String(value||"{}")) as Record<string,unknown>;return {total:Number(parsed.total)||0,added:Number(parsed.added)||0,matched:Number(parsed.matched)||0,changed:Number(parsed.changed)||0,unchanged:Number(parsed.unchanged)||0,conflicts:Number(parsed.conflicts)||0,missingFromExport:Number(parsed.missingFromExport)||0,nameChanges:Number(parsed.nameChanges)||0,groupChanges:Number(parsed.groupChanges)||0,sourceStatusChanges:Number(parsed.sourceStatusChanges)||0};}
function validateStarted(row:Record<string,unknown>,input:{sourceSha256:string;expectedRows:number}){if(row.source_sha256!==input.sourceSha256||Number(row.expected_rows)!==input.expectedRows)readerFail("sync_request_conflict","Цей ідентифікатор уже використано для іншого файлу.",409);if(row.state==="failed")readerFail("sync_retry_required","Попередню перевірку завершено без змін. Виберіть CSV ще раз, щоб створити новий перегляд.",409);return {runId:String(row.id),state:String(row.state),expectedRows:Number(row.expected_rows),preview:row.preview_json?parsePreview(row.preview_json):null};}
function validatePart(row:Record<string,unknown>,hash:string,count:number,index:number){if(row.part_sha256!==hash||Number(row.row_count)!==count)readerFail("sync_part_conflict","Цю частину вже завантажено з іншим вмістом.",409);return {partIndex:index,rowCount:count,replayed:true};}
async function requireRun(db:ReaderDatabase,actor:LibraryActor,runId:string,sourceSha256:string,states:string[]){if(!RUN_ID.test(runId)||!HASH.test(sourceSha256))readerFail("sync_run_invalid","Некоректний сеанс синхронізації.");const run=await db.prepare("SELECT * FROM librarika_member_sync_runs WHERE id=?").bind(runId).first();if(!run||run.source_sha256!==sourceSha256||run.actor_user_id!==actor.id||!states.includes(String(run.state)))readerFail("sync_run_changed","Сеанс синхронізації вже змінено або він не належить цьому запуску.",409);return run;}
export async function expireTemporaryLibrarikaMemberSyncRows(db:ReaderDatabase,now=new Date().toISOString()){const nowMs=Date.parse(now),uploadingCutoff=new Date(nowMs-24*60*60*1000).toISOString(),previewCutoff=new Date(nowMs-7*24*60*60*1000).toISOString();try{await db.batch([
  db.prepare("DELETE FROM librarika_member_sync_parts WHERE run_id IN (SELECT id FROM librarika_member_sync_runs WHERE (state='uploading' AND updated_at<?) OR (state='previewed' AND updated_at<?))").bind(uploadingCutoff,previewCutoff),
  db.prepare("DELETE FROM librarika_member_sync_rows WHERE run_id IN (SELECT id FROM librarika_member_sync_runs WHERE (state='uploading' AND updated_at<?) OR (state='previewed' AND updated_at<?))").bind(uploadingCutoff,previewCutoff),
  db.prepare("UPDATE librarika_member_sync_runs SET state='failed',preview_json=json_object('reason','expired'),updated_at=? WHERE (state='uploading' AND updated_at<?) OR (state='previewed' AND updated_at<?)").bind(now,uploadingCutoff,previewCutoff),
]);}catch{readerFail("sync_cleanup_unavailable","Не вдалося безпечно підготувати центр синхронізації. Дані читачів не змінено.",503);}}
