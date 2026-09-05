import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {IMPORT_COLUMNS,startLibrarikaImport,appendLibrarikaImportPart,readLibrarikaImportStatus,splitLibrarikaImportTables,verifyLibrarikaImport} from "../lib/librarika-import-store.ts";
import {sha256Text} from "../lib/librarika-import-plan.ts";

const actor={id:"migration-admin",email:"admin@example.test"};
const runId="LRK-IMPORT-"+"a".repeat(24);
function database(){
  const sqlite=new DatabaseSync(":memory:");
  for(const name of fs.readdirSync("drizzle").filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort())sqlite.exec(fs.readFileSync("drizzle/"+name,"utf8"));
  sqlite.exec("PRAGMA foreign_keys=ON");
  sqlite.prepare("INSERT INTO users(id,full_name,sort_name,email,role,status,created_at,updated_at) VALUES(?,'Admin','admin',?,'admin','active','2026-09-06','2026-09-06')").run(actor.id,actor.email);
  const db={prepare(sql){const make=bindings=>({bind(...values){return make(values);},async all(){return {success:true,results:sqlite.prepare(sql).all(...bindings)};},async first(){return sqlite.prepare(sql).get(...bindings)??null;}});return make([]);},async batch(statements){sqlite.exec("BEGIN IMMEDIATE");try{const output=[];for(const statement of statements)output.push(await statement.all());sqlite.exec("COMMIT");return output;}catch(error){sqlite.exec("ROLLBACK");throw error;}},sqlite};
  return db;
}
async function setup(db,extra={}){
  const tables=Object.fromEntries(Object.keys(IMPORT_COLUMNS).map(table=>[table,[]]));
  tables.library_catalog_entities=[{id:"LRK-TAG-1",kind:"tag",name:"Тег",slug:"test",public_metadata_json:"{}",source_json:"[]",import_run_id:runId,version:1},...extra.entities||[]];
  if(extra.mutate)extra.mutate(tables);
  const chunks=await splitLibrarikaImportTables(tables);
  const input={runId,sourceSha256:"a".repeat(64),recoverySha256:"b".repeat(64),planSha256:"c".repeat(64),capturedAt:"2026-09-05T21:33:28.100Z",counts:Object.fromEntries(Object.entries(tables).map(([table,rows])=>[table,rows.length])),parts:chunks.map(chunk=>chunk.part)};
  await startLibrarikaImport(db,actor,input);return {chunks,input};
}
test("append import replays safely and leaves old users, holdings and stock unchanged",async()=>{
  const db=database();try{
    const {chunks,input}=await setup(db);
    await assert.rejects(verifyLibrarikaImport(db,actor,runId),/Не всі записи/);
    assert.equal((await startLibrarikaImport(db,actor,input)).replayed,true);
    const part={runId,index:0,table:chunks[0].part.table,rows:chunks[0].rows};
    assert.equal((await appendLibrarikaImportPart(db,actor,part)).replayed,false);
    assert.equal((await appendLibrarikaImportPart(db,actor,part)).replayed,true);
    assert.deepEqual((await readLibrarikaImportStatus(db,runId)).completedParts,[0]);
    assert.equal(db.sqlite.prepare("SELECT count(*) n FROM library_catalog_entities").get().n,1);
    assert.equal(db.sqlite.prepare("SELECT count(*) n FROM users").get().n,1);
    assert.equal(db.sqlite.prepare("SELECT count(*) n FROM holdings").get().n,0);
    assert.equal(db.sqlite.prepare("SELECT count(*) n FROM material_stock_totals").get().n,0);
    assert.equal((await verifyLibrarikaImport(db,actor,runId)).state,"verified");
    assert.equal((await verifyLibrarikaImport(db,actor,runId)).replayed,true);
  }finally{db.sqlite.close();}
});
test("a modified part, reused run with different plan or private public field is rejected",async()=>{
  const db=database();try{
    const {chunks,input}=await setup(db);
    await assert.rejects(startLibrarikaImport(db,actor,{...input,planSha256:"d".repeat(64)}),/інший план/);
    await assert.rejects(appendLibrarikaImportPart(db,actor,{runId,index:0,table:chunks[0].part.table,rows:[{...chunks[0].rows[0],name:"Змінений"}]}),/Контрольна сума/);
  }finally{db.sqlite.close();}
  const privateDb=database();try{
    const {chunks}=await setup(privateDb,{mutate:tables=>{tables.library_catalog_entities[0].public_metadata_json=JSON.stringify({phone:"private"});}});
    await assert.rejects(appendLibrarikaImportPart(privateDb,actor,{runId,index:0,table:chunks[0].part.table,rows:chunks[0].rows}),/непогоджені поля/);
    assert.equal(privateDb.sqlite.prepare("SELECT count(*) n FROM library_catalog_entities").get().n,0);
  }finally{privateDb.sqlite.close();}
});
test("a chunk failure rolls back the receipt and every row; revoked admin loses inside batch",async()=>{
  for(const revoked of [false,true]){
    const db=database();try{
      const {chunks}=await setup(db,{entities:revoked?[]:[{id:"LRK-TAG-1",kind:"tag",name:"Другий",slug:"second",public_metadata_json:"{}",source_json:"[]",import_run_id:runId,version:1}]});
      if(revoked)db.sqlite.prepare("UPDATE users SET status='inactive' WHERE id=?").run(actor.id);
      await assert.rejects(appendLibrarikaImportPart(db,actor,{runId,index:0,table:chunks[0].part.table,rows:chunks[0].rows}));
      assert.equal(db.sqlite.prepare("SELECT count(*) n FROM library_catalog_entities").get().n,0);
      assert.equal(db.sqlite.prepare("SELECT count(*) n FROM mutation_commands WHERE kind='librarika_append'").get().n,0);
    }finally{db.sqlite.close();}
  }
});
test("chunk count and payload budgets are deterministic",async()=>{
  const rows=Array.from({length:45},(_,n)=>({id:String(n),value:"x"}));
  const chunks=await splitLibrarikaImportTables({library_catalog_entities:rows});
  assert.deepEqual(chunks.map(chunk=>chunk.part.rows),[20,20,5]);
  assert.deepEqual(chunks,await splitLibrarikaImportTables({library_catalog_entities:rows}));
});
test("cross-run parent links abort the entire part and its receipt",async()=>{
  const db=database();try{
    const {chunks}=await setup(db,{mutate:tables=>{tables.library_edition_entities=[{edition_id:"foreign-edition",entity_id:"LRK-TAG-1",role:"tag"}];}});
    const foreign="LRK-IMPORT-"+"e".repeat(24);
    db.sqlite.prepare("INSERT INTO library_import_runs(id,manifest_sha256,source_exported_at,state,expected_counts_json,recovery_sha256,actor_user_id,created_at) VALUES(?,?,?,'loading','{}',?,?,?)").run(foreign,"e".repeat(64),"2026-09-06","b".repeat(64),actor.id,"2026-09-06");
    db.sqlite.prepare("INSERT INTO library_editions(id,source_media_id,fund,title,public_metadata_json,source_json,import_run_id,publication_state,version,created_at,updated_at) VALUES('foreign-edition','99','literature','Чужий план','{}','{}',?,'draft',1,'2026-09-06','2026-09-06')").run(foreign);
    await appendLibrarikaImportPart(db,actor,{runId,index:0,table:chunks[0].part.table,rows:chunks[0].rows});
    await assert.rejects(appendLibrarikaImportPart(db,actor,{runId,index:1,table:chunks[1].part.table,rows:chunks[1].rows}));
    assert.equal(db.sqlite.prepare("SELECT count(*) n FROM library_edition_entities").get().n,0);
    assert.deepEqual((await readLibrarikaImportStatus(db,runId)).completedParts,[0]);
  }finally{db.sqlite.close();}
});
test("verify reasserts publication safety atomically after preflight",async()=>{
  const db=database();try{
    const hash=await sha256Text("{}");
    const {chunks}=await setup(db,{mutate:tables=>{tables.library_editions=[{id:"edition",source_media_id:"1",material_id:null,fund:"literature",title:"Книга",public_metadata_json:"{}",source_json:"{}",source_row_sha256:hash,import_run_id:runId,publication_state:"draft",version:1,created_at:"2026-09-06",updated_at:"2026-09-06"}];}});
    for(const chunk of chunks)await appendLibrarikaImportPart(db,actor,{runId,index:chunk.part.index,table:chunk.part.table,rows:chunk.rows});
    const batch=db.batch.bind(db);
    db.batch=async statements=>{db.sqlite.exec("UPDATE library_editions SET publication_state='published' WHERE id='edition'");return batch(statements);};
    await assert.rejects(verifyLibrarikaImport(db,actor,runId));
    assert.equal(db.sqlite.prepare("SELECT state FROM library_import_runs WHERE id=?").get(runId).state,"loading");
    assert.equal(db.sqlite.prepare("SELECT count(*) n FROM audit_events WHERE action='librarika_verified'").get().n,0);
  }finally{db.sqlite.close();}
});
