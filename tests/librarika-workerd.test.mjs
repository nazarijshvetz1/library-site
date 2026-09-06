import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {Miniflare} from "miniflare";
import {buildLibrarikaImportPlan} from "../lib/librarika-import-plan.ts";
import {startLibrarikaImport,appendLibrarikaImportPart,verifyLibrarikaImport,splitLibrarikaImportTables} from "../lib/librarika-import-store.ts";

test("append engine and safety guards execute against Cloudflare D1 runtime",{timeout:60000},async()=>{
  const sqlite=new DatabaseSync(":memory:");
  for(const name of fs.readdirSync("drizzle").filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort())sqlite.exec(fs.readFileSync("drizzle/"+name,"utf8"));
  const schema=sqlite.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*'").all();sqlite.close();
  const mf=new Miniflare({modules:true,script:"export default { fetch(){return new Response('test');} }",compatibilityDate:"2026-05-22",d1Databases:["DB"]});
  try{
    const db=await mf.getD1Database("DB");
    for(const type of ["table","index","view","trigger"])for(const item of schema.filter(row=>row.type===type&&!/^materials_fts_/.test(row.name)))await db.prepare(item.sql).run();
    const actor={id:"runtime-admin",email:"admin@example.test"};
    await db.prepare("INSERT INTO users(id,full_name,sort_name,email,role,status,created_at,updated_at) VALUES(?,'Admin','admin',?,'admin','active','2026-09-06','2026-09-06')").bind(actor.id,actor.email).run();
    const title={Id:"1",Title:"Книга",Authors:"Автор",Publisher:"Видавництво",Year:"2020",Type:"Book"};
    const plan=await buildLibrarikaImportPlan({titles:[title],copies:[{...title,Id:"2","Accession No":"01","Copy No":"1"}],members:[{Id:"3",Name:"Тестовий читач","Member No":"У-1",Status:"Active","Member Group":"5-IT1"}],circulations:[{ID:"4","Member No":"У-1","Media ID":"1","ASN No":"01","Copy No":"1",Status:"Overdue","Booking Date":"2026-09-01","Issued At":"2026-09-01 12:30:00","Return Date":"2026-09-05"}],authors:[{Name:"Автор"}],publishers:[{Name:"Видавництво"}],categories:[],tags:[]},[{source_id:"1",identity_verified:true,review_details:[{text:"Відгук",rating:3}]}],{sourceSha256:"d".repeat(64),recoverySha256:"e".repeat(64),capturedAt:"2026-09-06T00:00:00Z"});
    const chunks=await splitLibrarikaImportTables(plan.tables);
    await startLibrarikaImport(db,actor,{...plan,sourceCompleteness:{authorDetailsComplete:true,authorsVerified:1,authorsPending:[]},planSha256:"f".repeat(64),parts:chunks.map(chunk=>chunk.part)});
    for(const chunk of chunks)await appendLibrarikaImportPart(db,actor,{runId:plan.runId,index:chunk.part.index,table:chunk.part.table,rows:chunk.rows});
    assert.equal((await verifyLibrarikaImport(db,actor,plan.runId)).verification.openLoans,1);
    assert.equal((await appendLibrarikaImportPart(db,actor,{runId:plan.runId,index:0,table:chunks[0].part.table,rows:chunks[0].rows})).replayed,true);
    assert.equal((await db.prepare("SELECT count(*) n FROM holdings").first()).n,0);
  }finally{await mf.dispose();}
});
