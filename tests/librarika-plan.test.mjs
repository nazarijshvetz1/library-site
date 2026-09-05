import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildLibrarikaImportPlan } from "../lib/librarika-import-plan.ts";

const provenance={sourceSha256:"a".repeat(64),recoverySha256:"b".repeat(64),capturedAt:"2026-09-05T21:33:28.100Z"};
function fixture(){
  const title={Id:"1",Title:"Книга",Authors:"Автор",Year:"2020",Volume:"",ISBN:"",ISBN13:"9786170953858",Edition:"",Type:"Книга",Publisher:"Видавець",Category:"Роман",Description:"Опис"};
  const copy={...title,Id:"10","Accession No":"03","Copy No":"1",Branch:"Main"};
  const member={Id:"20","Member No":"Уч-01",Name:"Тестовий читач","Member Group":"5-IT1",Status:"Active",Email:"private@example.test",Phone:"+380000000000"};
  const loan={ID:"30","Member No":"Уч-01","Media ID":"1","ASN No":"03","Copy No":"1",Status:"Issued","Booking Date":"2026-09-01","Return Date":"2026-09-14","Issued At":"2026-09-01 10:00:00","Received At":""};
  return {titles:[title],copies:[copy],members:[member],circulations:[loan],authors:[{Name:"Автор",Nickname:"",Country:"Україна"}],publishers:[{Name:"Видавець",Email:"business@example.test",Country:"Україна"}],categories:[{Name:"Роман",Slug:"roman"}],tags:[{Name:"Архівний тег",Slug:"old"}]};
}
const captured=[{source_id:"1",identity_verified:true,page_count:100,language:null,cover:{sha256:"c".repeat(64)}}];
test("append plan preserves private source data without logins, stock or publication",async()=>{
  const plan=await buildLibrarikaImportPlan(fixture(),captured,provenance);
  assert.equal(plan.tables.library_readers[0].access_status,"inactive");
  assert.equal(plan.tables.library_readers[0].linked_teacher_user_id,null);
  assert.equal(plan.tables.library_readers[0].kind,"student");
  assert.equal(plan.tables.library_copies[0].accession_no,"03");
  assert.equal(plan.tables.library_copies[0].physical_state,"on_loan");
  assert.equal(plan.tables.library_copies[0].registration,"unreconciled");
  assert.equal(plan.tables.reader_circulations[0].issued_at,"2026-09-01 10:00:00");
  assert.equal(plan.tables.library_editions[0].material_id,null);
  assert.equal(plan.tables.library_editions[0].publication_state,"draft");
  assert.equal(JSON.parse(plan.tables.library_readers[0].source_json).Phone,"+380000000000");
  const publicJson=JSON.stringify([...plan.tables.library_catalog_entities,...plan.tables.library_editions].map(row=>row.public_metadata_json));
  assert.doesNotMatch(publicJson,/private@example|business@example|\+380/);
  assert.ok(Object.values(plan.safeguards).every(value=>value===false));
});
test("historical reviews are persisted in the private append tables, not just a sidecar",async()=>{
  const plan=await buildLibrarikaImportPlan(fixture(),[{...captured[0],review_details:[{text:"Добра книга",rating:3,date_display:"5 hours ago",source_review_id:null}]}],provenance);
  const review=plan.tables.library_historical_reviews[0];
  assert.equal(review.body,"Добра книга");assert.equal(review.rating,3);assert.equal(review.publication_state,"draft");
  assert.equal(review.source_review_id,null);
});
test("source statuses remain authoritative and missing return timestamps stay missing",async()=>{
  const data=fixture();data.circulations[0].Status="Returned";
  const plan=await buildLibrarikaImportPlan(data,captured,provenance);
  assert.equal(plan.tables.reader_circulations[0].status,"returned");
  assert.equal(plan.tables.reader_circulations[0].received_at,null);
  assert.equal(plan.tables.library_copies[0].physical_state,"unknown");
});
test("duplicate accession is preserved without arbitrarily selecting a loan copy",async()=>{
  const data=fixture();data.copies.push({...data.copies[0],Id:"11","Copy No":"2"});
  const plan=await buildLibrarikaImportPlan(data,captured,provenance);
  assert.equal(plan.tables.library_copies.length,2);assert.equal(plan.tables.reader_circulations[0].copy_id,"LRK-CP-10");
  assert.ok(plan.warnings.some(item=>item.code==="duplicate_accession_preserved"));
  data.copies[1]["Copy No"]="1";
  await assert.rejects(buildLibrarikaImportPlan(data,captured,provenance),/Unresolved circulation/);
});
test("plan refuses unmatched editions, unknown readers and duplicate active copies",async()=>{
  const missing=fixture();missing.copies[0].Year="1990";
  await assert.rejects(buildLibrarikaImportPlan(missing,captured,provenance),/Ambiguous copy edition/);
  const badMember=fixture();badMember.circulations[0]["Member No"]="other";
  await assert.rejects(buildLibrarikaImportPlan(badMember,captured,provenance),/Unresolved circulation/);
  const double=fixture();double.circulations.push({...double.circulations[0],ID:"31"});
  await assert.rejects(buildLibrarikaImportPlan(double,captured,provenance),/two active loans/);
  await assert.rejects(buildLibrarikaImportPlan(fixture(),[],provenance),/Unverified public source/);
});
test("plan is reproducible and contains no automatic teacher or source-tag matching",async()=>{
  const data=fixture();data.members[0]["Member Group"]="Викладачі";
  const first=await buildLibrarikaImportPlan(data,captured,provenance),second=await buildLibrarikaImportPlan(data,captured,provenance);
  assert.deepEqual(first,second);assert.equal(first.tables.library_readers[0].kind,"unclassified");
  assert.equal(first.tables.library_edition_entities.filter(row=>row.role==="tag").length,0);
  assert.doesNotMatch(fs.readFileSync("scripts/trial-librarika-plan.mjs","utf8"),/https?:|fetch\(|wrangler/);
});
test("authenticated taxonomy preserves distinct same-name IDs and biography as text",async()=>{
  const data=fixture();
  const taxonomy={authors:[{id:"100",name:"Автор",biography:"Точний текст <не HTML>",sourceBiographyHtml:"<b>Джерело</b>",biographyLanguage:"uk"},{id:"101",name:"Автор",biography:"Інший запис"}],publishers:[{id:"200",name:"Видавець",website:"https://example.test"}]};
  const plan=await buildLibrarikaImportPlan(data,[{...captured[0],authors:[{name:"Автор",source_id:"101"}]}],provenance,taxonomy);
  const authors=plan.tables.library_catalog_entities.filter(row=>row.kind==="author");
  assert.equal(authors.length,2);
  assert.equal(JSON.parse(authors[0].public_metadata_json).biography,"Точний текст <не HTML>");
  assert.doesNotMatch(authors[0].public_metadata_json,/<b>/);
  assert.match(authors[0].source_json,/sourceBiographyHtml/);
  assert.equal(plan.tables.library_edition_entities.find(row=>row.role==="author").entity_id,"LRK-AUTHOR-SRC-101");
});
