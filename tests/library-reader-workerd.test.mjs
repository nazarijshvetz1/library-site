import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {Miniflare} from 'miniflare';
import {saveLibraryEdition} from '../lib/library-editor.ts';
import {registerLibraryCopy,issueReaderCopy,returnReaderCopy} from '../lib/library-copy-store.ts';

test('reader copy receipt, stock guards and return execute on actual workerd D1',async()=>{
 const sqlite=new DatabaseSync(':memory:');for(const file of fs.readdirSync('drizzle').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort())sqlite.exec(fs.readFileSync('drizzle/'+file,'utf8'));const schema=sqlite.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*'").all();sqlite.close();
 const mf=new Miniflare({modules:true,script:"export default {fetch(){return new Response('reader D1 local test')}}",compatibilityDate:'2026-05-22',d1Databases:['DB']});
 try{const db=await mf.getD1Database('DB');for(const type of ['table','index','view','trigger'])for(const item of schema.filter(item=>item.type===type&&!/^materials_fts_/.test(item.name)))await db.prepare(item.sql).run();
 await db.prepare("INSERT INTO users(id,full_name,sort_name,email,role,status,created_at,updated_at) VALUES('admin','Admin','admin','admin@example.test','admin','active','2026-09-06','2026-09-06')").run();await db.prepare("INSERT INTO library_readers(id,member_no,full_name,sort_name,kind,status,access_status,created_at,updated_at) VALUES('reader','1','Читач','читач','student','active','inactive','2026-09-06','2026-09-06')").run();await db.prepare("INSERT INTO locations(id,name,type,status,created_at,updated_at) VALUES('loc','Бібліотека','library','active','2026-09-06','2026-09-06')").run();const actor={id:'admin',email:'admin@example.test'};
 const book=await saveLibraryEdition(db,actor,{requestId:crypto.randomUUID(),title:'Книга',metadata:{author:'Автор'},entityIds:[],published:true});const copy=await registerLibraryCopy(db,actor,{requestId:crypto.randomUUID(),editionId:book.id,expectedEditionVersion:1,accessionNo:'001',copyNo:'1',locationId:'loc',condition:'good'});const input={requestId:crypto.randomUUID(),copyId:copy.id,expectedCopyVersion:1,readerId:'reader',expectedReaderVersion:1,issuedAt:'2026-09-06',dueAt:'2026-09-20',confirmation:'ISSUE_THIS_COPY'},loan=await issueReaderCopy(db,actor,input);assert.equal((await issueReaderCopy(db,actor,input)).id,loan.id);assert.equal((await db.prepare('SELECT count(*) n FROM holdings').first()).n,0);await returnReaderCopy(db,actor,{requestId:crypto.randomUUID(),circulationId:loan.id,expectedCirculationVersion:1,expectedCopyVersion:2,returnLocationId:'loc',condition:'good',returnedAt:'2026-09-07',confirmation:'RETURN_THIS_COPY'});assert.equal((await db.prepare('SELECT total_quantity FROM material_stock_totals').first()).total_quantity,1);assert.equal((await db.prepare('SELECT count(*) n FROM library_copy_movements').first()).n,3);await assert.rejects(db.prepare('DELETE FROM holdings').run());assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length,0);
 }finally{await mf.dispose();}
});
