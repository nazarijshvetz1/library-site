import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {registerHooks} from 'node:module';

registerHooks({resolve(s,c,next){return s==='cloudflare:workers'?{url:'data:text/javascript,export const env={}',shortCircuit:true}:next(s,c);}});
const [baseline,destination,expectedCount]=process.argv.slice(2);
if(!destination||![baseline,destination].every(p=>path.resolve(p).split(path.sep).includes('.migration-private'))||fs.existsSync(destination))throw Error('Use a private backup and a new offline trial file.');
fs.copyFileSync(baseline,destination,fs.constants.COPYFILE_EXCL);
const sqlite=new DatabaseSync(destination);sqlite.exec('PRAGMA foreign_keys=ON');
const db={prepare(sql){const make=values=>({bind(...v){return make(v);},async all(){return {success:true,results:sqlite.prepare(sql).all(...values)};},async first(){return sqlite.prepare(sql).get(...values)||null;}});return make([]);},async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const r=[];for(const s of statements)r.push(await s.all());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
const {literatureClassPlan,applyLiteratureClasses}=await import('../lib/literature-class-alignment.ts');
const row=sqlite.prepare("SELECT id,email FROM users WHERE role='admin' AND status='active' ORDER BY id LIMIT 1").get();if(!row)throw Error('Administrator missing.');const actor={id:row.id,email:row.email};
const tables=sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(x=>x.name).filter(x=>!['reader_class_enrollments','mutation_commands','audit_events'].includes(x));
const hash=name=>crypto.createHash('sha256').update(JSON.stringify(sqlite.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"').all())).digest('hex');
try{
 const before=new Map(tables.map(t=>[t,hash(t)])),plan=await literatureClassPlan(db);assert.equal(plan.assignments.length,Number(expectedCount));
 for(let i=0;i<plan.assignments.length;i+=20){const input={requestId:crypto.randomUUID(),assignments:plan.assignments.slice(i,i+20)};await applyLiteratureClasses(db,actor,input);await applyLiteratureClasses(db,actor,input);}
 const count=sqlite.prepare('SELECT count(*) n FROM reader_class_enrollments WHERE ended_at IS NULL').get().n;
 await applyLiteratureClasses(db,actor,{requestId:crypto.randomUUID(),assignments:plan.assignments.slice(0,20)});
 assert.equal(sqlite.prepare('SELECT count(*) n FROM reader_class_enrollments WHERE ended_at IS NULL').get().n,count);
 await assert.rejects(applyLiteratureClasses(db,actor,{requestId:crypto.randomUUID(),assignments:[{...plan.assignments[0],expectedVersion:999999}]}));
 assert.equal((await literatureClassPlan(db)).assignments.length,0);
 for(const name of tables)assert.equal(hash(name),before.get(name),'Protected table changed: '+name);
 assert.equal(sqlite.prepare('PRAGMA foreign_key_check').all().length,0);assert.equal(sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 console.log(JSON.stringify({passed:true,assigned:plan.assignments.length,classes:plan.summary.length,excluded:plan.excluded.length,protectedTablesUnchanged:tables.length,retriesWithoutDuplicates:true,staleVersionRejected:true}));
}finally{sqlite.close();}
