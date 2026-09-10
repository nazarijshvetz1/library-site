import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {registerHooks} from 'node:module';
import crypto from 'node:crypto';
globalThis.__LITERATURE_TRIAL_ENV={};registerHooks({resolve(s,c,next){return s==='cloudflare:workers'?{url:'data:text/javascript,export const env=globalThis.__LITERATURE_TRIAL_ENV',shortCircuit:true}:next(s,c);}});
const [baseline,packetPath,destination]=process.argv.slice(2);
if(!destination||![baseline,packetPath,destination].every(p=>path.resolve(p).split(path.sep).includes('.migration-private'))||fs.existsSync(destination))throw Error('Use private input paths and a new offline trial database.');
fs.copyFileSync(baseline,destination,fs.constants.COPYFILE_EXCL);const sqlite=new DatabaseSync(destination);sqlite.exec('PRAGMA foreign_keys=ON');
const db={prepare(sql){const make=values=>({bind(...v){return make(v);},async all(){return {success:true,results:sqlite.prepare(sql).all(...values)};},async first(){return sqlite.prepare(sql).get(...values)||null;}});return make([]);},async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const r=[];for(const s of statements)r.push(await s.all());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
const {applyLiteratureSourceItem}=await import('../lib/literature-source-refresh.ts'),{literatureDashboard,literatureBook}=await import('../lib/literature-admin.ts');
const actorRow=sqlite.prepare("SELECT id,email FROM users WHERE role='admin' AND status='active' ORDER BY id LIMIT 1").get();if(!actorRow)throw Error('Administrator missing.');const actor={id:actorRow.id,email:actorRow.email};
const hash=query=>crypto.createHash('sha256').update(JSON.stringify(sqlite.prepare(query).all())).digest('hex');const education="SELECT * FROM materials WHERE NOT EXISTS(SELECT 1 FROM library_editions e WHERE e.material_id=materials.id AND e.fund='literature') ORDER BY id",before=hash(education),access=hash('SELECT id,access_status,access_version,linked_teacher_user_id FROM library_readers ORDER BY id');
const packet=JSON.parse(fs.readFileSync(packetPath,'utf8')),results=[];
try{for(const [index,item]of packet.items.entries()){try{const result=await applyLiteratureSourceItem(db,actor,item);results.push(result);const replay=await applyLiteratureSourceItem(db,actor,item);if(replay.id!==result.id)throw Error('Replay mismatch');console.log(JSON.stringify({step:index+1,kind:item.kind,ok:true}));}catch(e){console.log(JSON.stringify({step:index+1,kind:item.kind,code:e.code,message:e.message}));throw e;}}
 if(before!==hash(education)||access!==hash('SELECT id,access_status,access_version,linked_teacher_user_id FROM library_readers ORDER BY id'))throw Error('Protected domain changed');
 const dashboard=await literatureDashboard(db,new URL('https://local.test'));for(const result of results.filter(x=>x.kind==='book'))await literatureBook(db,result.id);
 if(sqlite.prepare('PRAGMA foreign_key_check').all().length||sqlite.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('Integrity failure');
 console.log(JSON.stringify({passed:true,stats:dashboard.stats,totalEditions:sqlite.prepare("SELECT count(*) n FROM library_editions WHERE fund='literature'").get().n,totalSourceLoans:sqlite.prepare('SELECT count(*) n FROM reader_circulations WHERE source_circulation_id IS NOT NULL').get().n,educationUnchanged:true,readerAccessUnchanged:true}));
}finally{sqlite.close();}
