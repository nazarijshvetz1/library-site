import fs from "node:fs";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {restoreAndVerifySnapshot} from "./verify-d1-recovery.mjs";
import {sha256Text} from "../lib/librarika-import-plan.ts";
import {captureTrialBaseline,verifyTrialBaseline,applyPendingTrialMigrations} from "./librarika-trial-baseline.mjs";
import {splitLibrarikaImportTables,startLibrarikaImport,appendLibrarikaImportPart,verifyLibrarikaImport} from "../lib/librarika-import-store.ts";

const args=process.argv.slice(2);if(args.length!==3)throw new Error("Usage: trial-librarika-engine RECOVERY_DIRECTORY PLAN_JSON NEW_PRIVATE_OUTPUT_DIRECTORY");
const [recovery,planPath,output]=args.map(value=>path.resolve(value));
if(!output.split(path.sep).includes(".migration-private")||fs.existsSync(output))throw new Error("A new private output directory is required");
const snapshotText=fs.readFileSync(path.join(recovery,"snapshot.json"),"utf8"),verified=JSON.parse(fs.readFileSync(path.join(recovery,"verification.json"),"utf8"));
if(!verified.verified||await sha256Text(snapshotText)!==verified.sha256)throw new Error("Recovery changed");
const planText=fs.readFileSync(planPath,"utf8"),plan=JSON.parse(planText);
if(plan.recoverySha256!==verified.sha256)throw new Error("Plan recovery does not match");
fs.mkdirSync(output,{recursive:true});restoreAndVerifySnapshot(JSON.parse(snapshotText),path.join(output,"trial.sqlite"));
const sqlite=new DatabaseSync(path.join(output,"trial.sqlite"));
try{
  sqlite.exec("PRAGMA foreign_keys=ON");
  const before=captureTrialBaseline(sqlite,{allowAuditAppend:true});
  const pendingMigrations=applyPendingTrialMigrations(sqlite);
  const db={prepare(sql){const make=bindings=>({bind(...values){return make(values);},async all(){return{success:true,results:sqlite.prepare(sql).all(...bindings)};},async first(){return sqlite.prepare(sql).get(...bindings)??null;}});return make([]);},async batch(statements){sqlite.exec("BEGIN IMMEDIATE");try{const output=[];for(const statement of statements)output.push(await statement.all());sqlite.exec("COMMIT");return output;}catch(error){sqlite.exec("ROLLBACK");throw error;}}};
  const actor=sqlite.prepare("SELECT id,email FROM users WHERE role='admin' AND status='active' ORDER BY id LIMIT 1").get();if(!actor)throw new Error("No existing admin in local snapshot");
  const chunks=await splitLibrarikaImportTables(plan.tables);
  const header={sourceCompleteness:plan.sourceCompleteness,runId:plan.runId,sourceSha256:plan.sourceSha256,recoverySha256:plan.recoverySha256,capturedAt:plan.capturedAt,planSha256:await sha256Text(planText),counts:plan.counts,parts:chunks.map(chunk=>chunk.part)};
  await startLibrarikaImport(db,actor,header);
  for(const chunk of chunks)await appendLibrarikaImportPart(db,actor,{runId:plan.runId,index:chunk.part.index,table:chunk.part.table,rows:chunk.rows});
  const result=await verifyLibrarikaImport(db,actor,plan.runId);
  const replay=await appendLibrarikaImportPart(db,actor,{runId:plan.runId,index:0,table:chunks[0].part.table,rows:chunks[0].rows});
  if(!replay.replayed)throw new Error("Replay was not idempotent");
  verifyTrialBaseline(sqlite,before);
  if(sqlite.prepare("PRAGMA foreign_key_check").all().length||sqlite.prepare("PRAGMA integrity_check").get().integrity_check!=="ok")throw new Error("Engine trial integrity failed");
  const report={passed:true,chunks:chunks.length,result,pendingMigrations,originalOperationalTablesUnchanged:true,originalAuditRowsPreserved:true,originalTableDdlUnchanged:true,replayVerified:true,note:"Local test of the application importer, no production network calls."};
  fs.writeFileSync(path.join(output,"engine-report.json"),JSON.stringify(report,null,2),{flag:"wx"});console.log(JSON.stringify(report));
}finally{sqlite.close();}
