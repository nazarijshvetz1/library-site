import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { restoreAndVerifySnapshot } from "./verify-d1-recovery.mjs";

const args=process.argv.slice(2);
if(args.length!==3)throw new Error("Usage: trial-librarika-plan VERIFIED_RECOVERY_DIRECTORY PLAN_JSON NEW_PRIVATE_OUTPUT_DIRECTORY");
const [recovery,planPath,output]=args.map(value=>path.resolve(value));
if(!output.split(path.sep).includes(".migration-private")||fs.existsSync(output))throw new Error("A new private trial directory is required");
const verification=JSON.parse(fs.readFileSync(path.join(recovery,"verification.json"),"utf8"));
const plan=JSON.parse(fs.readFileSync(planPath,"utf8"));
if(!verification.verified||plan.format!=="library-librarika-append"||plan.recoverySha256!==verification.sha256)throw new Error("Plan and verified recovery do not match");
const q=name=>'"'+name.replaceAll('"','""')+'"';
const hash=value=>crypto.createHash("sha256").update(value).digest("hex");
const digest=rows=>hash(JSON.stringify(rows.map(row=>JSON.stringify(Object.keys(row).sort().map(key=>[key,row[key]]))).sort()));
fs.mkdirSync(output,{recursive:true});
const snapshotBytes=fs.readFileSync(path.join(recovery,"snapshot.json"));
if(hash(snapshotBytes)!==verification.sha256)throw new Error("Original recovery snapshot changed");
restoreAndVerifySnapshot(JSON.parse(snapshotBytes.toString("utf8")),path.join(output,"trial.sqlite"));
const db=new DatabaseSync(path.join(output,"trial.sqlite"));
try{
  db.exec("PRAGMA foreign_keys=ON");
  const oldTables=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'materials_fts*'").all();
  const before=new Map(oldTables.map(table=>[table.name,digest(db.prepare(`SELECT * FROM ${q(table.name)}`).all())]));
  for(const migration of fs.readdirSync("drizzle").filter(name=>/^\d{4}_.*\.sql$/.test(name)&&Number(name.slice(0,4))>=43).sort())db.exec(fs.readFileSync(path.join("drizzle",migration),"utf8"));
  const admin=db.prepare("SELECT id FROM users WHERE role='admin' AND status='active' ORDER BY id LIMIT 1").get();
  if(!admin)throw new Error("No existing administrator in the private trial");
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO library_import_runs(id,manifest_sha256,source_exported_at,state,expected_counts_json,recovery_sha256,actor_user_id,created_at) VALUES(?,?,?,'loading',?,?,?,?)").run(plan.runId,plan.sourceSha256,plan.capturedAt,JSON.stringify(plan.counts),plan.recoverySha256,admin.id,plan.capturedAt);
  const counts={};
  for(const [table,rows] of Object.entries(plan.tables)){
    if(!["library_catalog_entities","library_editions","library_edition_entities","library_readers","library_copies","reader_circulations","library_historical_reviews"].includes(table))throw new Error("Unknown plan table");
    if(rows.length){const columns=Object.keys(rows[0]);const statement=db.prepare(`INSERT INTO ${q(table)}(${columns.map(q).join(",")}) VALUES(${columns.map(()=>"?").join(",")})`);for(const row of rows)statement.run(...columns.map(column=>row[column]));}
    const saved=db.prepare(`SELECT * FROM ${q(table)}`).all();
    if(saved.length!==plan.counts[table]||digest(saved)!==digest(rows))throw new Error(`Trial data mismatch ${table}`);
    counts[table]=saved.length;
  }
  const invariants={existingTableDataUnchanged:oldTables.every(table=>before.get(table.name)===digest(db.prepare(`SELECT * FROM ${q(table.name)}`).all())),existingTableDdlUnchanged:oldTables.every(table=>db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table.name)?.sql===table.sql),activeReaderAccess:db.prepare("SELECT count(*) AS n FROM library_readers WHERE access_status!='inactive' OR linked_teacher_user_id IS NOT NULL").get().n,publishedEditions:db.prepare("SELECT count(*) AS n FROM library_editions WHERE publication_state!='draft' OR material_id IS NOT NULL").get().n,registeredCopies:db.prepare("SELECT count(*) AS n FROM library_copies WHERE registration!='unreconciled'").get().n,openLoans:db.prepare("SELECT count(*) AS n FROM reader_circulations WHERE status IN ('issued','overdue')").get().n,foreignKeyErrors:db.prepare("PRAGMA foreign_key_check").all().length};
  if(!invariants.existingTableDataUnchanged||!invariants.existingTableDdlUnchanged||invariants.activeReaderAccess||invariants.publishedEditions||invariants.registeredCopies||invariants.foreignKeyErrors)throw new Error("Trial safety invariant failed");
  db.exec("COMMIT");
  if(db.prepare("PRAGMA integrity_check").get().integrity_check!=="ok")throw new Error("Trial integrity check failed");
  const report={passed:true,counts,invariants,sourcePlanSha256:hash(fs.readFileSync(planPath)),recoverySha256:plan.recoverySha256,note:"Local trial only. Production import, catalog activation and stock reconciliation have NOT run."};
  fs.writeFileSync(path.join(output,"trial-report.json"),JSON.stringify(report,null,2),{flag:"wx"});
  console.log(JSON.stringify(report));
}catch(error){try{db.exec("ROLLBACK");}catch{}throw error;}finally{db.close();}
