import {saveLibraryEdition} from './library-editor.ts';
import {saveLiteratureEntity,assertLiterature,literatureDate} from './literature-admin.ts';
import {libraryCommand,beginLibraryCommand,finishLibraryCommand,registerLibraryCopy,issueReaderCopy,returnReaderCopy,SOURCE_LOCATION} from './library-copy-store.ts';
import {readerBatch,readerFail,requireChanged,stableJson,type ReaderDatabase,type LibraryActor} from './reader-core.ts';
import {sha256Text} from './librarika-import-plan.ts';
type Row=Record<string,unknown>;
type Input=Row&{requestId:string;kind:string;sourceId:string};
const sourceId=(value:unknown)=>{if(typeof value!=='string'||!/^\d{1,15}$/.test(value))readerFail('source_id','Некоректний номер джерела.');return value;};
const object=(v:unknown):Row=>{if(!v||typeof v!=='object'||Array.isArray(v))readerFail('source_object','Некоректний запис архіву.');return v as Row;};
const date=(v:unknown)=>literatureDate(String(v||'').slice(0,10));
async function stepId(id:string,step:string){const h=await sha256Text(id+':'+step);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
async function entityId(db:ReaderDatabase,kind:string,id:string){if(/^[A-Za-z0-9_-]{1,100}$/.test(id)&&id.startsWith('LRK-')){const match=await db.prepare('SELECT id FROM library_catalog_entities WHERE id=? AND kind=?').bind(id,kind).first();if(match)return id;}sourceId(id);const legacy=`LRK-${kind.toUpperCase()}-SRC-${id}`;const result=await db.prepare("SELECT id FROM library_catalog_entities WHERE kind=? AND (id=? OR json_extract(source_json,'$.sourceId')=?)").bind(kind,legacy,id).all();if(result.results?.length!==1)readerFail('source_entity','Довідник джерела ще не перенесено або збіг неоднозначний.',409);return String(result.results[0].id);}
export async function previewLiteratureSourceItem(db:ReaderDatabase,input:Input){
 sourceId(input.sourceId);if(!['book','entity','loan'].includes(input.kind))readerFail('source_kind','Невідомий вид архівного запису.');
 const table=input.kind==='book'?'library_editions':input.kind==='loan'?'reader_circulations':'library_catalog_entities';
 const column=input.kind==='book'?'source_media_id':input.kind==='loan'?'source_circulation_id':"json_extract(source_json,'$.sourceId')";
 const existing=await db.prepare(`SELECT id,version FROM ${table} WHERE ${column}=?`).bind(input.sourceId).first();
 return {kind:input.kind,sourceId:input.sourceId,existingId:existing?.id||null,label:String(input.title||input.name||input.sourceId)};
}
// One source record per request; exact receipts make a partially completed batch
// resumable. No delete, account activation, message sending or textbook mutation.
export async function applyLiteratureSourceItem(db:ReaderDatabase,actor:LibraryActor,input:Input){
 await previewLiteratureSourceItem(db,input);
 const command=await libraryCommand(db,actor,input.requestId,'literature.source',input);if(command.replayed)return command.replayed;
 let id='',result:Row={};const now=new Date().toISOString(),sourceRow=object(input.sourceRow); if(!await db.prepare('SELECT id FROM mutation_commands WHERE id=?').bind(input.requestId).first())await readerBatch(db,[beginLibraryCommand(db,actor,input.requestId,'literature.source',command.hash,input.sourceId,now)]); const complete=async(value:Row)=>{await readerBatch(db,finishLibraryCommand(db,actor,input.requestId,'literature.source',String(value.id),value,now));return value;}; const child=async(step:string)=>{const row=await db.prepare("SELECT result_json FROM mutation_commands WHERE id=? AND actor_user_id=? AND status='completed'").bind(await stepId(input.requestId,step),actor.id).first();return row?JSON.parse(String(row.result_json)):null;};
 if(input.kind==='entity'){
  const kind=String(input.entityKind);if(!['author','publisher','genre','tag','series'].includes(kind))readerFail('source_kind','Невідомий довідник.');
  const legacy=await db.prepare("SELECT id FROM library_catalog_entities WHERE id=? OR (kind=? AND json_extract(source_json,'$.sourceId')=?)").bind(`LRK-${kind.toUpperCase()}-SRC-${input.sourceId}`,kind,input.sourceId).first();if(legacy){if((await child('entity'))?.id===legacy.id)return complete({id:legacy.id,kind:input.kind,sourceId:input.sourceId});readerFail('source_exists','Цей довідник уже існує; автоматичне перезаписування заборонено.',409);}
  const saved=await saveLiteratureEntity(db,actor,{requestId:await stepId(input.requestId,'entity'),kind,name:input.name,metadata:input.metadata});id=String(saved.id);
  await readerBatch(db,[db.prepare("UPDATE library_catalog_entities SET source_json=? WHERE id=? AND source_json='{}'").bind(JSON.stringify({sourceId:input.sourceId,row:sourceRow}),id),requireChanged(db,1)]);
 }else if(input.kind==='book'){
  const existing=await db.prepare('SELECT id FROM library_editions WHERE source_media_id=?').bind(input.sourceId).first();if(existing){const prior=await child('book'),copy=await child('copy');if(prior?.id===existing.id&&copy?.id)return complete({id:existing.id,copyId:copy.id,version:1,kind:input.kind,sourceId:input.sourceId});readerFail('source_exists','Це видання вже перенесено; повторне створення заборонено.',409);}
  if(String(sourceRow.Id)!==input.sourceId||String(sourceRow.Title).trim()!==String(input.title).trim())readerFail('source_title','Назва або номер не відповідають CSV.');
  const entities=object(input.entities),ids:string[]=[];for(const kind of ['author','publisher','genre'])if(entities[kind])ids.push(await entityId(db,kind,String(entities[kind])));
  const copy=object(input.copy),copySource=object(copy.sourceRow);if(String(copySource.Id)!==sourceId(copy.sourceId)||copySource['Accession No']!==copy.accessionNo||typeof copy.accessionNo!=='string'||!copy.accessionNo.trim()||copy.accessionNo.length>80)readerFail('source_copy','Номер примірника не відповідає CSV.');
  const duplicateCopy=await db.prepare('SELECT id FROM library_copies WHERE accession_no=? OR source_copy_id=?').bind(copy.accessionNo,String(copy.sourceId)).first();if(duplicateCopy&&duplicateCopy.id!==(await child('copy'))?.id)readerFail('source_copy_exists','Примірник з таким номером уже існує.',409);
  const saved=await saveLibraryEdition(db,actor,{requestId:await stepId(input.requestId,'book'),title:String(input.title),metadata:object(input.metadata) as Record<string,string>,entityIds:ids,published:true});id=String(saved.id);
  const registered=await registerLibraryCopy(db,actor,{requestId:await stepId(input.requestId,'copy'),editionId:id,expectedEditionVersion:1,accessionNo:String(copy.accessionNo),copyNo:String(copy.copyNo||''),locationId:SOURCE_LOCATION,condition:'unspecified'});
  // Both links are atomic; native copies were created by the stock ledger above.
  await readerBatch(db,[db.prepare("UPDATE library_editions SET source_media_id=?,source_json=?,source_row_sha256=? WHERE id=? AND source_media_id IS NULL AND fund='literature'").bind(input.sourceId,JSON.stringify(sourceRow),await sha256Text(stableJson(sourceRow)),id),requireChanged(db,1),db.prepare("UPDATE library_copies SET source_copy_id=?,source_json=?,source_row_sha256=? WHERE id=? AND source_copy_id IS NULL AND edition_id=?").bind(String(copy.sourceId),JSON.stringify(copySource),await sha256Text(stableJson(copySource)),String(registered.id),id),requireChanged(db,1)]);
  result={copyId:registered.id,version:1};
 }else{
  if(String(sourceRow.ID)!==input.sourceId)readerFail('source_loan','Номер видачі не відповідає CSV.');
  const copy=await db.prepare("SELECT c.*,e.material_id,e.source_media_id FROM library_copies c JOIN library_editions e ON e.id=c.edition_id WHERE c.source_copy_id=? AND e.fund='literature' AND c.registration='registered'").bind(sourceId(input.sourceCopyId)).first(),reader=await db.prepare('SELECT id,version,member_no FROM library_readers WHERE source_member_id=?').bind(sourceId(input.sourceMemberId)).first();
  if(!copy||!reader||String(copy.source_media_id)!==String(sourceRow['Media ID'])||String(copy.accession_no)!==String(sourceRow['ASN No'])||String(reader.member_no)!==String(sourceRow['Member No']))readerFail('source_mapping','Немає точного збігу книги, примірника й читацького номера.',409);
  const existing=await db.prepare('SELECT * FROM reader_circulations WHERE source_circulation_id=?').bind(input.sourceId).first();
  const prior=input.previousSourceRow?object(input.previousSourceRow):null,ownIssue=await child('issue'),ownReturn=await child('return'); if(existing&&stableJson(JSON.parse(String(existing.source_json)))===stableJson(sourceRow))return complete({id:existing.id,kind:input.kind,sourceId:input.sourceId});
  if(existing){if(!prior||stableJson(JSON.parse(String(existing.source_json)))!==stableJson(prior)||existing.copy_id!==copy.id||existing.reader_id!==reader.id||existing.accounting_mode!=='native'||Number(existing.version)!==Number(input.expectedVersion)+(ownIssue?.id===existing.id?1:0)+(ownReturn?.id===existing.id?1:0))readerFail('source_changed','Видачу вже змінено після попереднього знімка. Потрібна ручна звірка.',409);id=String(existing.id);}
  else if(prior)readerFail('source_missing','Попередню видачу не знайдено.',409);
  const status=String(sourceRow.Status).toLowerCase(),issued=date(sourceRow['Issued At']||sourceRow['Booking Date']),due=date(sourceRow['Return Date']);
  if(!['issued','overdue','returned','reserved','cancelled'].includes(status))readerFail('source_status','Непідтримуваний стан джерела.');
  if(!existing&&status==='returned'){
   // A source return is history, not a new issue/return performed today.
   // Preserve an absent actual return timestamp rather than inventing one.
   id='RLOAN-'+await stepId(input.requestId,'history');
   await readerBatch(db,[db.prepare(`INSERT INTO reader_circulations(id,source_circulation_id,copy_id,reader_id,status,issued_at,due_at,received_at,accounting_mode,source_json,source_row_sha256,created_at,updated_at)
    VALUES(?,?,(SELECT id FROM library_copies WHERE id=? AND version=? AND registration='registered' AND physical_state='on_shelf'),(SELECT id FROM library_readers WHERE id=? AND version=?),'returned',?,?,?,'native',?,?,?,?)`).bind(id,input.sourceId,String(copy.id),Number(input.expectedCopyVersion),String(reader.id),Number(input.expectedReaderVersion),issued,due,sourceRow['Received At']?date(sourceRow['Received At']):null,JSON.stringify(sourceRow),await sha256Text(stableJson(sourceRow)),now,now)]);
  }else if(existing&&['reserved','cancelled'].includes(status)){
   if(!['pending','reserved'].includes(String(existing.status)))readerFail('source_transition','Неможливо змінити поточний стан без руху примірника.',409);
   await readerBatch(db,[db.prepare("UPDATE reader_circulations SET status=?,due_at=?,source_json=?,source_row_sha256=?,version=version+1,updated_at=? WHERE id=? AND version=? AND status IN ('pending','reserved')").bind(status,due,JSON.stringify(sourceRow),await sha256Text(stableJson(sourceRow)),now,id,Number(input.expectedVersion)),requireChanged(db,1)]);
  }else if(!existing||['pending','reserved'].includes(String(existing.status))||ownIssue?.id===existing.id){
   if(!['issued','overdue','returned'].includes(status))readerFail('source_transition','Цей перехід потребує ручного керування.',409);
   const issuedResult=await issueReaderCopy(db,actor,{requestId:await stepId(input.requestId,'issue'),copyId:String(copy.id),expectedCopyVersion:Number(input.expectedCopyVersion),readerId:String(reader.id),expectedReaderVersion:Number(input.expectedReaderVersion),issuedAt:issued,dueAt:due,confirmation:'ISSUE_THIS_COPY',...(existing?{reservationId:id,expectedReservationVersion:Number(input.expectedVersion)}:{})});id=String(issuedResult.id);
   if(status==='returned')await returnReaderCopy(db,actor,{requestId:await stepId(input.requestId,'return'),circulationId:id,expectedCirculationVersion:existing?Number(input.expectedVersion)+1:1,expectedCopyVersion:Number(input.expectedCopyVersion)+1,returnLocationId:SOURCE_LOCATION,condition:String(copy.condition),returnedAt:date(sourceRow['Received At']),confirmation:'RETURN_THIS_COPY'});
  }else readerFail('source_transition','Цю вже оформлену видачу слід звірити вручну.',409);
  await readerBatch(db,[db.prepare("UPDATE reader_circulations SET source_circulation_id=?,source_json=?,source_row_sha256=? WHERE id=? AND (source_circulation_id IS NULL OR source_circulation_id=?)").bind(input.sourceId,JSON.stringify(sourceRow),await sha256Text(stableJson(sourceRow)),id,input.sourceId),requireChanged(db,1)]);
 }
 result={...result,id,kind:input.kind,sourceId:input.sourceId};
 return complete(result);
}
