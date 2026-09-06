import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {IMPORT_COLUMNS} from '../lib/librarika-import-store.ts';

const quote=name=>'"'+name.replaceAll('"','""')+'"';
const canonicalRow=row=>JSON.stringify(Object.keys(row).sort().map(key=>[key,row[key]]));
export const rowsDigest=rows=>crypto.createHash('sha256').update(JSON.stringify(rows.map(canonicalRow).sort())).digest('hex');
export function captureTrialBaseline(db,{allowAuditAppend=false}={}){
  const tables=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'materials_fts*'").all();
  const importTables=new Set([...Object.keys(IMPORT_COLUMNS),'library_import_runs']);
  const appendTables=new Set(allowAuditAppend?['audit_events','mutation_commands']:[]);
  const result=[];
  for(const table of tables){
    const rows=db.prepare(`SELECT * FROM ${quote(table.name)}`).all();
    if(importTables.has(table.name)&&rows.length)throw new Error(`Trial requires an empty existing import table: ${table.name}`);
    result.push({...table,mode:importTables.has(table.name)?'empty-import':appendTables.has(table.name)?'append':'unchanged',digest:rowsDigest(rows),rows:appendTables.has(table.name)?rows.map(canonicalRow):[]});
  }
  return result;
}
export function verifyTrialBaseline(db,baseline){
  for(const table of baseline){
    if(db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table.name)?.sql!==table.sql)throw new Error(`Existing table DDL changed: ${table.name}`);
    const rows=db.prepare(`SELECT * FROM ${quote(table.name)}`).all();
    if(table.mode==='unchanged'&&rowsDigest(rows)!==table.digest)throw new Error(`Existing table data changed: ${table.name}`);
    if(table.mode==='append'){
      const remaining=new Map();for(const row of rows.map(canonicalRow))remaining.set(row,(remaining.get(row)||0)+1);
      for(const row of table.rows){const count=remaining.get(row)||0;if(!count)throw new Error(`Existing audit row changed: ${table.name}`);remaining.set(row,count-1);}
    }
  }
  return true;
}
export function applyPendingTrialMigrations(db,directory='drizzle'){
  if(!db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='__appgarden_migrations'").get())throw new Error('Verified Sites migration ledger is required');
  const files=fs.readdirSync(directory).filter(name=>/^\d{4}_.*\.sql$/.test(name)&&Number(name.slice(0,4))>=43).sort();
  const applied=new Set(db.prepare('SELECT name FROM __appgarden_migrations').all().map(row=>row.name));
  for(const name of applied)if(/^\d{4}_/.test(name)&&Number(name.slice(0,4))>=43&&!files.includes(name))throw new Error(`Unknown applied migration: ${name}`);
  let gap=false;for(const name of files){if(!applied.has(name))gap=true;else if(gap)throw new Error('Non-contiguous Sites migration ledger');}
  const pending=files.filter(name=>!applied.has(name));
  for(const name of pending){db.exec('BEGIN IMMEDIATE');try{db.exec(fs.readFileSync(path.join(directory,name),'utf8'));db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}}
  // This disposable trial intentionally leaves the source ledger unchanged.
  return pending;
}
