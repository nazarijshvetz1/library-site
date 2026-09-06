import {normalizeIsbn} from "./isbn.ts";
import {readerFail,type ReaderDatabase} from "./reader-core.ts";

async function requireRun(db:ReaderDatabase,runId:string,planSha256:string){
 if(!/^LRK-IMPORT-[0-9a-f]{24}$/.test(runId)||!/^[0-9a-f]{64}$/.test(planSha256))readerFail("activation_plan","Потрібен перевірений план перенесення.");
 const run=await db.prepare("SELECT state,reconciliation_json,expected_counts_json FROM library_import_runs WHERE id=?").bind(runId).first();
 const contract=run?JSON.parse(String(run.reconciliation_json)).contract:null;
 if(!run||!["verified","reconciled"].includes(String(run.state))||contract?.planSha256!==planSha256||contract?.sourceCompleteness?.authorDetailsComplete!==true||contract.sourceCompleteness.authorsPending?.length!==0)readerFail("activation_not_ready","План має бути повністю зібраний, завантажений і перевірений.",409);
 return run;
}
export async function requireLibrarikaActivationEdition(db:ReaderDatabase,runId:string,planSha256:string,editionId:string){
 await requireRun(db,runId,planSha256);
 if(!await db.prepare("SELECT id FROM library_editions WHERE id=? AND import_run_id=?").bind(editionId,runId).first())readerFail("activation_edition","Видання не належить цьому плану.",409);
}
export async function getLibrarikaActivation(db:ReaderDatabase,runId:string,planSha256:string){
 const run=await requireRun(db,runId,planSha256);
 const coverCounts=await db.prepare("SELECT count(DISTINCT json_extract(e.public_metadata_json,'$.coverSha256')) required,(SELECT count(*) FROM library_import_cover_receipts cr WHERE cr.import_run_id=?) confirmed FROM library_editions e WHERE e.import_run_id=? AND coalesce(json_extract(e.public_metadata_json,'$.coverKind'),'')!='placeholder' AND length(json_extract(e.public_metadata_json,'$.coverSha256'))=64 AND NOT EXISTS(SELECT 1 FROM library_import_cover_receipts cr WHERE cr.import_run_id=e.import_run_id AND cr.sha256=json_extract(e.public_metadata_json,'$.coverSha256'))").bind(runId,runId).first();
 if(Number(coverCounts?.required||0)>0)readerFail("activation_covers","Спочатку потрібно підтвердити всі обкладинки у сховищі сайту.",409);
 const expected=JSON.parse(String(run.expected_counts_json));
 const rows=await db.prepare(`SELECT e.id,e.title,e.version,e.material_id,
  (SELECT count(*) FROM library_copies c WHERE c.edition_id=e.id) copies,
  (SELECT count(*) FROM reader_circulations l JOIN library_copies c ON c.id=l.copy_id WHERE c.edition_id=e.id AND l.status IN ('issued','overdue')) loaned,
  COALESCE(NULLIF(json_extract(e.public_metadata_json,'$.isbn13'),''),json_extract(e.public_metadata_json,'$.isbn')) isbn
  FROM library_editions e WHERE e.import_run_id=? ORDER BY e.id LIMIT 20001`).bind(runId).all();
 const materials=await db.prepare("SELECT id,isbn_normalized FROM materials WHERE status='active' AND archived_at IS NULL AND isbn_normalized<>''").all();
 const matches=new Map<string,string[]>();for(const material of materials.results||[]){const key=String(material.isbn_normalized);matches.set(key,[...matches.get(key)||[],String(material.id)]);}
 const editions=(rows.results||[]).map(row=>({id:String(row.id),title:String(row.title),version:Number(row.version),material_id:row.material_id?String(row.material_id):null,copies:Number(row.copies),loaned:Number(row.loaned),matches:matches.get(normalizeIsbn(String(row.isbn||""))||"")||[]}));
 if(editions.length!==expected.library_editions||editions.length>20000)readerFail("activation_counts","Кількість видань не відповідає плану.",409);
 return {runId,planSha256,editions,total:editions.length,activated:editions.filter(e=>e.material_id).length};
}
