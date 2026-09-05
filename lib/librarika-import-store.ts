import { sha256Text } from "./librarika-import-plan.ts";

type Value=string|number|null;
type Row=Record<string,Value>;
type Result={results?:Record<string,unknown>[];success?:boolean};
type Statement={bind(...values:Value[]):Statement;all():Promise<Result>;first<T=Record<string,unknown>>():Promise<T|null>};
export type LibrarikaImportDatabase={prepare(sql:string):Statement;batch(statements:Statement[]):Promise<Result[]>};
export type ImportActor={id:string;email:string};
export const IMPORT_COLUMNS:Record<string,string[]>={
  library_catalog_entities:["id","kind","name","slug","public_metadata_json","source_json","import_run_id","version"],
  library_editions:["id","source_media_id","material_id","fund","title","public_metadata_json","source_json","source_row_sha256","import_run_id","publication_state","version","created_at","updated_at"],
  library_edition_entities:["edition_id","entity_id","role"],
  library_readers:["id","source_member_id","member_no","full_name","sort_name","kind","status","access_status","access_version","linked_teacher_user_id","source_group_label","source_group_id","source_json","source_row_sha256","import_run_id","version","created_at","updated_at"],
  library_copies:["id","source_copy_id","edition_id","accession_no","copy_no","location_id","condition","physical_state","registration","source_json","source_row_sha256","import_run_id","version","created_at","updated_at"],
  reader_circulations:["id","source_circulation_id","copy_id","reader_id","status","issued_at","due_at","received_at","accounting_mode","legacy_loan_item_id","legacy_class_loan_item_id","source_json","source_row_sha256","import_run_id","version","created_at","updated_at"],
  library_historical_reviews:["id","edition_id","source_review_id","rating","body","source_date_display","source_json","source_row_sha256","import_run_id","publication_state","captured_at"],
};
type Part={index:number;table:string;rows:number;sha256:string};
export type ImportStart={runId:string;sourceSha256:string;recoverySha256:string;capturedAt:string;planSha256:string;counts:Record<string,number>;parts:Part[]};
export class LibrarikaImportError extends Error { code:string; status:number; constructor(code:string, status:number, message:string){super(message);this.code=code;this.status=status;} }
function fail(code:string,message:string,status=400):never{throw new LibrarikaImportError(code,status,message);}
const isHash=(value:unknown):value is string=>typeof value==="string"&&/^[0-9a-f]{64}$/.test(value);
const runPattern=/^LRK-IMPORT-[0-9a-f]{24}$/;
const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
const stable=(value:unknown):string=>value===null||typeof value!=="object"?JSON.stringify(value):Array.isArray(value)?`[${value.map(stable).join(",")}]`:`{${Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>JSON.stringify(key)+":"+stable(item)).join(",")}}`;
const uuidFromHash=(hash:string)=>`${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;

export async function splitLibrarikaImportTables(tables:Record<string,Row[]>) {
  const chunks:{part:Part;rows:Row[]}[]=[];
  for(const table of Object.keys(IMPORT_COLUMNS)){
    let pending:Row[]=[];
    for(const row of tables[table]||[]){
      if(pending.length&&(pending.length>=20||new TextEncoder().encode(JSON.stringify([...pending,row])).length>110000)){
        chunks.push({part:{index:chunks.length,table,rows:pending.length,sha256:await sha256Text(stable(pending))},rows:pending});pending=[];
      }
      if(new TextEncoder().encode(JSON.stringify(row)).length>110000)fail("row_too_large","Один запис перевищує безпечний розмір імпорту.");
      pending.push(row);
    }
    if(pending.length)chunks.push({part:{index:chunks.length,table,rows:pending.length,sha256:await sha256Text(stable(pending))},rows:pending});
  }
  return chunks;
}

export async function startLibrarikaImport(db:LibrarikaImportDatabase,actor:ImportActor,input:ImportStart){
  validateStart(input);
  const stored=await db.prepare("SELECT id,manifest_sha256,recovery_sha256,expected_counts_json,reconciliation_json,state FROM library_import_runs WHERE id=?").bind(input.runId).first();
  const contract={planSha256:input.planSha256,parts:input.parts};
  if(stored){
    const prior=JSON.parse(String(stored.reconciliation_json||"{}"));
    if(stored.manifest_sha256!==input.sourceSha256||stored.recovery_sha256!==input.recoverySha256||stable(JSON.parse(String(stored.expected_counts_json)))!==stable(input.counts)||stable(prior.contract)!==stable(contract))fail("run_conflict","Цей ідентифікатор уже має інший план імпорту.",409);
    return {runId:input.runId,state:stored.state,replayed:true};
  }
  const now=new Date().toISOString();
  const command=uuidFromHash(await sha256Text(input.runId+":start"));
  const requestHash=await sha256Text(stable(input));
  await db.batch([
    db.prepare("INSERT INTO library_import_runs(id,manifest_sha256,source_exported_at,state,expected_counts_json,reconciliation_json,recovery_sha256,actor_user_id,created_at) VALUES(?,?,?,'loading',?,?,?,(SELECT id FROM users WHERE id=? AND role='admin' AND status='active'),?)").bind(input.runId,input.sourceSha256,input.capturedAt,JSON.stringify(input.counts),JSON.stringify({contract}),input.recoverySha256,actor.id,now),
    completedCommand(db,command,requestHash,actor.id,input.runId,{phase:"start"},now),
    audit(db,command,actor,input.runId,{phase:"start",counts:input.counts,planSha256:input.planSha256},now),
  ]);
  return {runId:input.runId,state:"loading",replayed:false};
}

export async function appendLibrarikaImportPart(db:LibrarikaImportDatabase,actor:ImportActor,input:{runId:string;index:number;table:string;rows:Row[]}){
  if(!input||!runPattern.test(input.runId)||!Number.isInteger(input.index)||input.index<0||!Object.hasOwn(IMPORT_COLUMNS,input.table))fail("part_invalid","Некоректна частина імпорту.");
  const run=await db.prepare("SELECT state,actor_user_id,reconciliation_json FROM library_import_runs WHERE id=?").bind(input.runId).first();
  if(!run)fail("run_missing","Спочатку потрібно створити план імпорту.",409);
  const contract=JSON.parse(String(run.reconciliation_json)).contract;
  const part:Part|undefined=contract?.parts?.[input.index];
  if(!part||part.index!==input.index||part.table!==input.table||!Array.isArray(input.rows)||part.rows!==input.rows.length)fail("part_mismatch","Частина не відповідає збереженому плану.",409);
  const payloadHash=await sha256Text(stable(input.rows));
  if(payloadHash!==part.sha256)fail("part_hash_mismatch","Контрольна сума частини змінилася.",409);
  const command=uuidFromHash(await sha256Text(input.runId+":part:"+input.index));
  const stored=await db.prepare("SELECT request_hash,result_json,status FROM mutation_commands WHERE id=?").bind(command).first();
  if(stored){if(stored.request_hash!==payloadHash||stored.status!=="completed")fail("part_conflict","Частину вже записано з іншими даними.",409);return {...JSON.parse(String(stored.result_json)),replayed:true};}
  if(run.state!=="loading"||run.actor_user_id!==actor.id)fail("run_closed","Імпорт закрито або належить іншому адміністратору.",409);
  await validateRows(input.table,input.rows,input.runId);
  const columns=IMPORT_COLUMNS[input.table];
  const now=new Date().toISOString(), result={runId:input.runId,index:input.index,table:input.table,rows:input.rows.length,sha256:payloadHash};
  const payload=JSON.stringify(input.rows);
  const prior=contract.parts.slice(0,input.index) as Part[];
  const priorCommands=await Promise.all(prior.map(async item=>uuidFromHash(await sha256Text(input.runId+":part:"+item.index))));
  const values=columns.map(column=>`json_extract(incoming.value,'$.${column}')`).join(",");
  const parentReferences:Record<string,[string,string][]>= {
    library_edition_entities:[["edition_id","library_editions"],["entity_id","library_catalog_entities"]],
    library_copies:[["edition_id","library_editions"]],
    reader_circulations:[["copy_id","library_copies"],["reader_id","library_readers"]],
    library_historical_reviews:[["edition_id","library_editions"]],
  };
  const parents=parentReferences[input.table]||[];
  const parentGuard=parents.length?" WHERE "+parents.map(([field,table])=>`EXISTS(SELECT 1 FROM ${quote(table)} parent WHERE parent.id=json_extract(incoming.value,'$.${field}') AND parent.import_run_id=?)`).join(" AND "):"";
  const gate="SELECT u.id FROM users u JOIN library_import_runs r ON r.id=? AND r.actor_user_id=u.id WHERE u.id=? AND u.role='admin' AND u.status='active' AND r.state='loading' AND (SELECT COUNT(*) FROM mutation_commands WHERE id IN (SELECT value FROM json_each(?)) AND status='completed')=?";
  await db.batch([
    db.prepare(`INSERT INTO mutation_commands(id,kind,actor_user_id,status,target_type,target_id,request_hash,result_json,created_at,updated_at,completed_at) VALUES(?,'librarika_append',(${gate}),'completed','library_import',?,?,?,?,?,?)`).bind(command,input.runId,actor.id,JSON.stringify(priorCommands),priorCommands.length,input.runId,payloadHash,JSON.stringify(result),now,now,now),
    db.prepare(`INSERT INTO ${quote(input.table)}(${columns.map(quote).join(",")}) SELECT ${values} FROM json_each(?) incoming${parentGuard}`).bind(payload,...parents.map(()=>input.runId)),
    // changes() is tied to the immediately preceding INSERT; a partial row set aborts the whole batch.
    db.prepare("INSERT INTO audit_events(id,actor_user_id,actor_email,action,entity_type,entity_id,request_id,metadata_json,created_at) VALUES((SELECT ? WHERE changes()=?),?,?,'librarika_append','library_import',?,?,?,?)").bind("LRK-AUD-"+command,input.rows.length,actor.id,actor.email,input.runId,command,JSON.stringify(result),now),
  ]);
  return {...result,replayed:false};
}

export async function readLibrarikaImportStatus(db:LibrarikaImportDatabase,runId:string){
  if(!runPattern.test(runId))fail("run_invalid","Некоректний ідентифікатор імпорту.");
  const run=await db.prepare("SELECT id,state,expected_counts_json,reconciliation_json,created_at,verified_at FROM library_import_runs WHERE id=?").bind(runId).first();
  if(!run)return null;
  const commands=await db.prepare("SELECT result_json FROM mutation_commands WHERE target_type='library_import' AND target_id=? AND kind='librarika_append' AND status='completed'").bind(runId).all();
  return {runId:run.id,state:run.state,counts:JSON.parse(String(run.expected_counts_json)),completedParts:(commands.results||[]).map(row=>JSON.parse(String(row.result_json)).index).filter(Number.isInteger),createdAt:run.created_at,verifiedAt:run.verified_at};
}

export async function verifyLibrarikaImport(db:LibrarikaImportDatabase,actor:ImportActor,runId:string){
  if(!runPattern.test(runId))fail("run_invalid","Некоректний ідентифікатор імпорту.");
  const run=await db.prepare("SELECT state,actor_user_id,expected_counts_json,reconciliation_json FROM library_import_runs WHERE id=?").bind(runId).first();
  if(!run||run.actor_user_id!==actor.id)fail("run_missing","План імпорту цього адміністратора не знайдено.",409);
  const reconciliation=JSON.parse(String(run.reconciliation_json)),expected=JSON.parse(String(run.expected_counts_json));
  if(run.state==="verified"||run.state==="reconciled")return {runId,state:run.state,verification:reconciliation.verification,replayed:true};
  if(run.state!=="loading")fail("run_closed","План недоступний для перевірки.",409);
  const parts:Part[]=reconciliation.contract.parts;
  const ids=await Promise.all(parts.map(async part=>uuidFromHash(await sha256Text(runId+":part:"+part.index))));
  const actual:Record<string,number>={};
  for(const table of Object.keys(IMPORT_COLUMNS)){
    const count=await db.prepare(table==="library_edition_entities"?"SELECT count(*) AS n FROM library_edition_entities x JOIN library_editions e ON e.id=x.edition_id WHERE e.import_run_id=?":`SELECT count(*) AS n FROM ${quote(table)} WHERE import_run_id=?`).bind(runId).first<{n:number}>();
    actual[table]=Number(count?.n||0);
    if(actual[table]!==expected[table])fail("counts_incomplete","Не всі записи плану перенесено. Імпорт залишається прихованим.",409);
  }
  const checks=await db.prepare(`SELECT
    (SELECT count(*) FROM library_readers WHERE import_run_id=? AND (access_status!='inactive' OR linked_teacher_user_id IS NOT NULL)) AS access_count,
    (SELECT count(*) FROM library_editions WHERE import_run_id=? AND (publication_state!='draft' OR material_id IS NOT NULL)) AS publication_count,
    (SELECT count(*) FROM library_copies WHERE import_run_id=? AND registration!='unreconciled') AS stock_count,
    (SELECT count(*) FROM reader_circulations WHERE import_run_id=? AND accounting_mode!='unreconciled') AS accounting_count,
    (SELECT count(*) FROM reader_circulations WHERE import_run_id=? AND status IN ('issued','overdue')) AS open_loans
  `).bind(runId,runId,runId,runId,runId).first<Record<string,number>>();
  if(!checks||checks.access_count||checks.publication_count||checks.stock_count||checks.accounting_count)fail("verification_failed","Виявлено передчасну активацію даних.",409);
  const now=new Date().toISOString(),verification={counts:actual,openLoans:checks.open_loans,verifiedAt:now,loginActivation:0,stockDelta:0,publications:0};
  const command=uuidFromHash(await sha256Text(runId+":verify"));
  const countGuards=Object.keys(IMPORT_COLUMNS).map(table=>table==="library_edition_entities"?"(SELECT count(*) FROM library_edition_entities x JOIN library_editions e ON e.id=x.edition_id WHERE e.import_run_id=library_import_runs.id)=CAST(json_extract(expected_counts_json,'$.library_edition_entities') AS INTEGER)":`(SELECT count(*) FROM ${quote(table)} WHERE import_run_id=library_import_runs.id)=CAST(json_extract(expected_counts_json,'$.${table}') AS INTEGER)`).join(" AND ");
  const safetyGuards=[
    "NOT EXISTS(SELECT 1 FROM library_readers WHERE import_run_id=library_import_runs.id AND (access_status!='inactive' OR linked_teacher_user_id IS NOT NULL))",
    "NOT EXISTS(SELECT 1 FROM library_editions WHERE import_run_id=library_import_runs.id AND (publication_state!='draft' OR material_id IS NOT NULL))",
    "NOT EXISTS(SELECT 1 FROM library_copies WHERE import_run_id=library_import_runs.id AND (registration!='unreconciled' OR location_id IS NOT NULL))",
    "NOT EXISTS(SELECT 1 FROM reader_circulations WHERE import_run_id=library_import_runs.id AND (accounting_mode!='unreconciled' OR legacy_loan_item_id IS NOT NULL OR legacy_class_loan_item_id IS NOT NULL))",
    "NOT EXISTS(SELECT 1 FROM library_historical_reviews WHERE import_run_id=library_import_runs.id AND publication_state!='draft')",
  ].join(" AND ");
  await db.batch([
    db.prepare(`UPDATE library_import_runs SET state='verified',verified_at=?,reconciliation_json=? WHERE id=? AND state='loading' AND actor_user_id=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND role='admin' AND status='active') AND (SELECT count(*) FROM mutation_commands WHERE id IN (SELECT value FROM json_each(?)) AND status='completed')=? AND ${countGuards} AND ${safetyGuards}`).bind(now,JSON.stringify({...reconciliation,verification}),runId,actor.id,actor.id,JSON.stringify(ids),ids.length),
    db.prepare("INSERT INTO audit_events(id,actor_user_id,actor_email,action,entity_type,entity_id,request_id,metadata_json,created_at) VALUES((SELECT ? WHERE changes()=1),?,?,'librarika_verified','library_import',?,?,?,?)").bind("LRK-AUD-"+command,actor.id,actor.email,runId,command,JSON.stringify(verification),now),
    completedCommand(db,command,await sha256Text(stable(verification)),actor.id,runId,verification,now),
  ]);
  return {runId,state:"verified",verification,replayed:false};
}

function validateStart(input:ImportStart){
  if(!input||!runPattern.test(input.runId)||input.runId!=="LRK-IMPORT-"+input.sourceSha256?.slice(0,24)||![input.sourceSha256,input.recoverySha256,input.planSha256].every(isHash)||!Number.isFinite(Date.parse(input.capturedAt)))fail("plan_invalid","Некоректний план або контрольні суми.");
  if(!input.counts||Object.keys(input.counts).some(table=>!Object.hasOwn(IMPORT_COLUMNS,table))||!Array.isArray(input.parts)||input.parts.length>1000)fail("plan_invalid","Некоректна структура плану.");
  const counts:Record<string,number>={};
  for(const [index,part]of input.parts.entries()){
    if(part.index!==index||!Object.hasOwn(IMPORT_COLUMNS,part.table)||!isHash(part.sha256)||!Number.isInteger(part.rows)||part.rows<1||part.rows>20)fail("plan_invalid","Некоректний список частин.");
    counts[part.table]=(counts[part.table]||0)+part.rows;
  }
  for(const table of Object.keys(IMPORT_COLUMNS))if(!Number.isInteger(input.counts[table])||input.counts[table]<0||input.counts[table]>20000||(counts[table]||0)!==input.counts[table])fail("plan_counts","Кількість записів не відповідає частинам плану.");
}
async function validateRows(table:string,rows:Row[],runId:string){
  const allowed=IMPORT_COLUMNS[table];
  if(!rows.length||rows.length>20||new TextEncoder().encode(JSON.stringify(rows)).length>120000)fail("rows_invalid","Перевищено безпечний обсяг частини.");
  for(const row of rows){
    if(!row||Object.keys(row).length!==allowed.length||Object.keys(row).some(key=>!allowed.includes(key))||Object.values(row).some(value=>value!==null&&typeof value!=="string"&&typeof value!=="number"))fail("rows_invalid","Некоректні поля запису.");
    if("import_run_id"in row&&row.import_run_id!==runId)fail("row_run_mismatch","Запис належить іншому імпорту.");
    if("version"in row&&row.version!==1)fail("row_version","Імпорт має додавати нові записи.");
    for(const key of ["source_json","public_metadata_json"])if(key in row){try{JSON.parse(String(row[key]));}catch{fail("row_json","Некоректні джерельні дані.");}}
    if("public_metadata_json"in row){
      const metadata=JSON.parse(String(row.public_metadata_json));
      const keys=table==="library_editions"?["author","coauthors","editors","illustrators","publisher","year","edition","volume","isbn","isbn10","isbn13","issn","asin","lccn","ddc","oclc","upc","callNumber","genre","subject","type","description","annotation","pages","language","series","sourceUrl","referenceUrl","coverSha256","coverKind","coverUrl"]:["nickname","country","dateOfBirth","yearDied","biography","biographyLanguage","website","description","sourceAuthorIds","sourcePublisherIds","publications","awards"];
      if(!metadata||Array.isArray(metadata)||typeof metadata!=="object"||Object.keys(metadata).some(key=>!keys.includes(key)))fail("public_metadata_fields","Публічні дані містять непогоджені поля.");
    }
    if("source_row_sha256"in row&&(!isHash(row.source_row_sha256)||await sha256Text(String(row.source_json))!==row.source_row_sha256))fail("row_hash","Змінено джерельний рядок.");
    if(table==="library_editions"&&(row.material_id!==null||row.publication_state!=="draft"))fail("premature_publication","Імпорт не може публікувати або об'єднувати матеріали.");
    if(table==="library_readers"&&(row.access_status!=="inactive"||row.access_version!==1||row.linked_teacher_user_id!==null))fail("premature_access","Імпорт не може активувати доступ читача.");
    if(table==="library_copies"&&(row.registration!=="unreconciled"||row.location_id!==null||!["unknown","on_loan"].includes(String(row.physical_state))))fail("premature_stock","Імпорт не може змінювати оперативні залишки.");
    if(table==="reader_circulations"&&(row.accounting_mode!=="unreconciled"||row.legacy_loan_item_id!==null||row.legacy_class_loan_item_id!==null))fail("premature_accounting","Імпорт не може змінювати чинні видачі.");
    if(table==="library_historical_reviews"&&row.publication_state!=="draft")fail("premature_review","Історичні відгуки спочатку перевіряються.");
  }
}
function completedCommand(db:LibrarikaImportDatabase,id:string,hash:string,actorId:string,runId:string,result:unknown,now:string){return db.prepare("INSERT INTO mutation_commands(id,kind,actor_user_id,status,target_type,target_id,request_hash,result_json,created_at,updated_at,completed_at) VALUES(?,'librarika_import_start',?,'completed','library_import',?,?,?,?,?,?)").bind(id,actorId,runId,hash,JSON.stringify(result),now,now,now);}
function audit(db:LibrarikaImportDatabase,id:string,actor:ImportActor,runId:string,metadata:unknown,now:string){return db.prepare("INSERT INTO audit_events(id,actor_user_id,actor_email,action,entity_type,entity_id,request_id,metadata_json,created_at) VALUES(?,?,?,'librarika_import','library_import',?,?,?,?)").bind("LRK-AUD-"+id,actor.id,actor.email,runId,id,JSON.stringify(metadata),now);}
