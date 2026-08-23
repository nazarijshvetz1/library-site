import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const store = await import(pathToFileURL(path.join(root, "lib/acquisition-store.ts")).href);
const validation = await import(pathToFileURL(path.join(root, "lib/acquisition-validation.ts")).href);

class Statement {
  constructor(db, sql, bindings = []) { this.db=db; this.sql=sql; this.bindings=bindings; }
  bind(...values){return new Statement(this.db,this.sql,values);}
  async first(){return this.db.sqlite.prepare(this.sql).get(...this.bindings)??null;}
  async all(){return this.execute();}
  execute(){
    const prepared=this.db.sqlite.prepare(this.sql);
    if(/^\s*(?:select|with|pragma)/iu.test(this.sql)) return {success:true,results:prepared.all(...this.bindings),meta:{changes:0}};
    const result=prepared.run(...this.bindings);return {success:true,results:[],meta:{changes:Number(result.changes)}};
  }
}
class TestD1{
  constructor(sqlite){this.sqlite=sqlite;}
  prepare(sql){return new Statement(this,sql);}
  async batch(statements){this.sqlite.exec("BEGIN IMMEDIATE");try{const out=statements.map((statement)=>statement.execute());this.sqlite.exec("COMMIT");return out;}catch(error){this.sqlite.exec("ROLLBACK");throw error;}}
}
function context(){
  const sqlite=new DatabaseSync(":memory:");sqlite.exec("PRAGMA foreign_keys=ON");
  for(const file of fs.readdirSync(path.join(root,"drizzle")).filter((name)=>/^\d{4}_.+\.sql$/u.test(name)).sort()){
    for(const statement of fs.readFileSync(path.join(root,"drizzle",file),"utf8").split(/-->\s*statement-breakpoint/gu))if(statement.trim())sqlite.exec(statement);
  }
  const now="2026-08-23T08:00:00.000Z";
  sqlite.exec(`
    INSERT INTO users (id,full_name,sort_name,email,auth_user_id,role,status,created_at,updated_at) VALUES
      ('USR-LIB','Бібліотекар','бібліотекар','library@example.test','auth-library','librarian','active','${now}','${now}'),
      ('USR-T1','Шевченко Олена','шевченко олена',NULL,NULL,'teacher','active','${now}','${now}');
    INSERT INTO teacher_profiles (teacher_user_id,subject_position,service_contact,librarian_note,version,created_by_user_id,updated_by_user_id,created_at,updated_at)
      VALUES ('USR-T1','','','',1,'USR-LIB','USR-LIB','${now}','${now}');
    INSERT INTO visit_teacher_credentials (teacher_user_id,login_id,code_hmac,status,version,failed_attempts,code_rotated_at,created_by_user_id,updated_by_user_id,created_at,updated_at)
      VALUES ('USR-T1','teacher-login-0001','${"b".repeat(64)}','active',1,0,'${now}','USR-LIB','USR-LIB','${now}','${now}');
    INSERT INTO visit_teacher_sessions (token_hash,teacher_user_id,credential_version,pending_scope,ip_scope_hash,expires_at,last_seen_at,created_at)
      VALUES ('${"a".repeat(64)}','USR-T1',1,'teacher-pending-scope','${"c".repeat(64)}','2999-01-01T00:00:00.000Z','${now}','${now}');
    INSERT INTO academic_years (id,label,start_date,end_date,status,notes,version,created_at,updated_at)
      VALUES ('YR-2026','2026/2027','2026-09-01','2027-05-31','active','',1,'${now}','${now}');
    INSERT INTO cohorts (id,status,notes,created_at,updated_at) VALUES ('COH-7A','active','','${now}','${now}');
    INSERT INTO class_years (id,academic_year_id,cohort_id,class_name,grade,code,start_date,end_date,status,notes,version,created_at,updated_at)
      VALUES ('CY-7A','YR-2026','COH-7A','7-А',7,'А','2026-09-01','2027-05-31','active','',1,'${now}','${now}');
    INSERT INTO locations (id,name,type,status,is_public,sort_order,created_at,updated_at) VALUES ('LOC-LIB','Бібліотека','library','active',1,1,'${now}','${now}');
    INSERT INTO materials (id,catalog_number,title,sort_title,search_text,rubric,publication_type,subject,class_from,class_to,author,publication_year,isbn,isbn_normalized,publisher,notes,status,version,created_at,updated_at)
      VALUES ('CAT-0001',1,'Алгебра — 7 клас','алгебра 7 клас','алгебра','Підручники','Підручник','Математика',7,7,'Автор',2024,'','','','','active',1,'${now}','${now}');
  `);
  return {sqlite,db:new TestD1(sqlite)};
}
const teacher={teacherUserId:"USR-T1",fullName:"Шевченко Олена",credentialVersion:1,tokenHash:"a".repeat(64),pendingScope:"teacher-pending-scope",expiresAt:"2999-01-01T00:00:00.000Z",mustChangePin:false};
const librarian={userId:"auth-library",d1UserId:"USR-LIB",displayName:"Бібліотекар",email:"library@example.test",fullName:"Бібліотекар"};
function createInput(requestId=crypto.randomUUID()){return {requestId,category:"educational",sourceKind:"catalog",literatureKind:"none",materialId:"CAT-0001",title:"Буде замінено",author:"Буде замінено",publicationYear:2024,requestedQuantity:12,sourceUrl:"https://example.test/algebra",subject:"Математика",targetClass:"7-А",note:"На наступний рік"};}

test("acquisition validation has no ISBN and freezes exact request shapes",()=>{
  assert.equal(validation.validateAcquisitionCreateInput(createInput()).ok,true);
  assert.equal(validation.validateAcquisitionCreateInput({...createInput(),sourceUrl:"",subject:"",targetClass:""}).ok,true);
  assert.equal(validation.validateAcquisitionCreateInput({...createInput(),sourceKind:"manual",materialId:null,sourceUrl:""}).ok,false);
  assert.equal(validation.validateAcquisitionCreateInput({...createInput(),sourceKind:"manual",materialId:null,subject:""}).ok,false);
  assert.equal(validation.validateAcquisitionCreateInput({...createInput(),sourceKind:"manual",materialId:null,targetClass:""}).ok,false);
  assert.equal(validation.validateAcquisitionCreateInput({...createInput(),category:"literature",literatureKind:"fiction",sourceUrl:""}).ok,false);
  assert.equal(validation.validateAcquisitionCreateInput({...createInput(),isbn:"123"}).ok,false);
  assert.equal(validation.validateStudentAcquisitionCreateInput({requestId:crypto.randomUUID(),fullName:"Іваненко Марія",className:"7-А",title:"Книга",author:"Автор",publicationYear:2024,requestedQuantity:1,sourceUrl:"https://example.test/book",note:"",website:"",startedAt:new Date(Date.now()-3000).toISOString()}).ok,true);
  const optional=validation.validateStudentAcquisitionCreateInput({requestId:crypto.randomUUID(),fullName:"Іваненко Марія",className:"7-А",title:"Книга",note:"",website:"",startedAt:new Date(Date.now()-3000).toISOString()});
  assert.equal(optional.ok,true);assert.equal(optional.value.author,"");assert.equal(optional.value.publicationYear,null);assert.equal(optional.value.requestedQuantity,1);assert.equal(optional.value.sourceUrl,"");
  assert.equal(validation.validateStudentAcquisitionCreateInput({...optional.value,publicationYear:999}).ok,false);
  assert.equal(validation.validateStudentAcquisitionCreateInput({...optional.value,requestedQuantity:0}).ok,false);
  assert.equal(validation.validateStudentAcquisitionCreateInput({...optional.value,sourceUrl:"javascript:alert(1)"}).ok,false);
  assert.equal(validation.validateStudentAcquisitionCreateInput({...optional.value,title:""}).ok,false);
});

test("teacher proposal is idempotent and catalog snapshots are authoritative",async()=>{
  const {sqlite,db}=context();const requestId=crypto.randomUUID();const input=createInput(requestId);
  const first=await store.createTeacherAcquisitionRequest(db,teacher,input);const replay=await store.createTeacherAcquisitionRequest(db,teacher,input);
  assert.deepEqual(replay,first);assert.equal(first.title,"Алгебра — 7 клас");assert.equal(first.author,"Автор");assert.equal(first.status,"submitted");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM acquisition_requests").get().n,1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM audit_events WHERE entity_type='acquisition_request'").get().n,1);
});

test("librarian workflow cannot receive stock without a posted receipt allocation",async()=>{
  const {sqlite,db}=context();let request=await store.createTeacherAcquisitionRequest(db,teacher,createInput());
  request=await store.applyLibrarianAcquisitionAction(db,librarian,request.id,{mutationId:crypto.randomUUID(),expectedVersion:request.version,action:"approve",approvedQuantity:12,orderedQuantity:null,targetMaterialId:null,receiptLineId:"",allocatedQuantity:null,message:""});
  request=await store.applyLibrarianAcquisitionAction(db,librarian,request.id,{mutationId:crypto.randomUUID(),expectedVersion:request.version,action:"order",approvedQuantity:null,orderedQuantity:12,targetMaterialId:null,receiptLineId:"",allocatedQuantity:null,message:""});
  await assert.rejects(()=>store.applyLibrarianAcquisitionAction(db,librarian,request.id,{mutationId:crypto.randomUUID(),expectedVersion:request.version,action:"link_receipt",approvedQuantity:null,orderedQuantity:null,targetMaterialId:null,receiptLineId:"LINE-NONE",allocatedQuantity:3,message:""}),error=>error instanceof store.AcquisitionStoreError&&error.code==="receipt_line_invalid");
  const now=new Date(Date.now()+60_000).toISOString();
  sqlite.prepare(`INSERT INTO inventory_transactions (id,request_id,kind,actor_user_id,occurred_at,notes,status,created_at) VALUES ('TX-1','receipt-test','receipt','USR-LIB',?,'','posted',?)`).run(now.slice(0,10),now);
  sqlite.prepare(`INSERT INTO inventory_transaction_lines (id,transaction_id,material_id,location_id,condition,quantity_delta,quantity_before,quantity_after,created_at) VALUES ('LINE-1','TX-1','CAT-0001','LOC-LIB','good',5,0,5,?)`).run(now);
  request=await store.applyLibrarianAcquisitionAction(db,librarian,request.id,{mutationId:crypto.randomUUID(),expectedVersion:request.version,action:"link_receipt",approvedQuantity:null,orderedQuantity:null,targetMaterialId:null,receiptLineId:"LINE-1",allocatedQuantity:5,message:""});
  assert.equal(request.status,"partially_received");assert.equal(request.receivedQuantity,5);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM acquisition_receipt_allocations").get().n,1);
});

test("anonymous proposal validates the active class and records only a private request",async()=>{
  const {sqlite,db}=context();
  const input={requestId:crypto.randomUUID(),fullName:"Іваненко Марія",className:"7-А",title:"Цікава книга",author:"Письменник",publicationYear:2023,requestedQuantity:1,sourceUrl:"https://example.test/book",note:"Для читання",website:"",startedAt:new Date(Date.now()-3000).toISOString()};
  const publicRequest=()=>new Request("https://library.test/api/public/book-suggestions",{headers:{"user-agent":"test","CF-Connecting-IP":"203.0.113.1"}});
  const result=await store.createStudentAcquisitionRequest(db,publicRequest(),input,"s".repeat(40));
  assert.equal(result.request.requesterKind,"student");assert.equal(result.request.requesterClassName,"7-А");assert.equal(result.request.category,"literature");
  for(let index=2;index<=5;index+=1)await store.createStudentAcquisitionRequest(db,publicRequest(),{...input,requestId:crypto.randomUUID(),title:`Цікава книга ${index}`},"s".repeat(40));
  await assert.rejects(()=>store.createStudentAcquisitionRequest(db,publicRequest(),{...input,requestId:crypto.randomUUID(),title:"Шоста книга"},"s".repeat(40)),error=>error instanceof store.AcquisitionStoreError&&error.code==="rate_limited");
  assert.equal(sqlite.prepare("SELECT attempts FROM acquisition_public_rate_limits").get().attempts,5);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM acquisition_requests").get().n,5);
});

test("anonymous proposal persists omitted metadata without synthetic values",async()=>{
  const {sqlite,db}=context();
  const validated=validation.validateStudentAcquisitionCreateInput({requestId:crypto.randomUUID(),fullName:"Петренко Андрій",className:"7-А",title:"Нова книга",note:"",website:"",startedAt:new Date(Date.now()-3000).toISOString()});
  assert.equal(validated.ok,true);
  const request=new Request("https://library.test/api/public/book-suggestions",{headers:{"user-agent":"test","CF-Connecting-IP":"203.0.113.20"}});
  const first=await store.createStudentAcquisitionRequest(db,request,validated.value,"s".repeat(40));
  const replay=await store.createStudentAcquisitionRequest(db,request,validated.value,"s".repeat(40));
  assert.equal(replay.replayed,true);assert.deepEqual(replay.request,first.request);
  assert.equal(first.request.author,"");assert.equal(first.request.publicationYear,null);assert.equal(first.request.requestedQuantity,1);assert.equal(first.request.sourceUrl,"");
  const stored=sqlite.prepare("SELECT author,publication_year,requested_quantity,source_url FROM acquisition_requests WHERE id=?").get(first.request.id);
  assert.equal(stored.author,"");assert.equal(stored.publication_year,null);assert.equal(stored.requested_quantity,1);assert.equal(stored.source_url,"");
});

test("Excel preview resolves identities and repeated workbook commit is idempotent",async()=>{
  const {sqlite,db}=context();const fileHash="d".repeat(64);
  const rows=[{sourceSheet:"Дозамовлення",sourceRow:2,requesterKind:"teacher",teacherUserId:"USR-T1",teacherName:"Шевченко Олена",studentName:"",studentClassName:"",category:"educational",sourceKind:"catalog",literatureKind:"none",materialId:"CAT-0001",title:"Алгебра — 7 клас",author:"Автор",publicationYear:2024,requestedQuantity:4,sourceUrl:"https://example.test/algebra",subject:"Математика",targetClass:"7-А",note:""}];
  const preview=await store.previewAcquisitionImport(db,rows);assert.equal(preview.valid,true);
  const input={mode:"commit",importId:crypto.randomUUID(),fileName:"Комплектування.xlsx",fileHash,confirmation:"IMPORT_ACQUISITION_REQUESTS",rows};
  const first=await store.commitAcquisitionImport(db,librarian,input);const replay=await store.commitAcquisitionImport(db,librarian,input);
  assert.equal(first.imported,1);assert.equal(first.replayed,false);assert.equal(replay.replayed,true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM acquisition_import_batches").get().n,1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM acquisition_requests").get().n,1);
});

test("acquisition interfaces expose catalog metadata, optional student fields and a local printable QR",()=>{
  const teacherUi=fs.readFileSync(path.join(root,"app/teacher/acquisition/teacher-acquisition-panel.tsx"),"utf8");
  const studentUi=fs.readFileSync(path.join(root,"app/suggest-book/suggest-book-form.tsx"),"utf8");
  const librarianUi=fs.readFileSync(path.join(root,"app/librarian/acquisitions/acquisition-workspace.tsx"),"utf8");
  const librarianCss=fs.readFileSync(path.join(root,"app/librarian/acquisitions/acquisition-workspace.module.css"),"utf8");
  assert.match(teacherUi,/thumbnailUrl/u);assert.match(teacherUi,/classFrom/u);assert.match(teacherUi,/\/api\/catalog-v2\/\$\{encodeURIComponent\(item\.id\)\}/u);
  assert.match(teacherUi,/setSourceUrl\(detail\.links\.find/u);assert.match(teacherUi,/required=\{!existingCatalogMaterial\}/u);
  assert.match(studentUi,/publicationYear:year\.trim\(\)\?Number\(year\):null/u);assert.match(studentUi,/requestedQuantity:quantity\.trim\(\)\?Number\(quantity\):null/u);
  assert.doesNotMatch(studentUi,/Автор \*<input/u);assert.doesNotMatch(studentUi,/Покликання на книгу \*<input/u);
  assert.match(librarianUi,/new URL\("\/suggest-book", window\.location\.origin\)/u);assert.match(librarianUi,/QRCodeWriter/u);
  assert.match(librarianUi,/Копіювати QR-код/u);assert.match(librarianUi,/Завантажити QR/u);assert.match(librarianUi,/Друкувати QR/u);
  assert.doesNotMatch(librarianUi,/api\.qrserver|chart\.googleapis/iu);assert.match(librarianCss,/acquisition-student-qr-print/u);assert.match(librarianCss,/@page\{size:A4 portrait/u);
});
