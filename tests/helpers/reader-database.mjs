import fs from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {registerHooks} from "node:module";
globalThis.__READER_TEST_ENV={VISIT_TEACHER_CODE_AUTH_ENABLED:"true",VISIT_TEACHER_AUTH_PEPPER:"reader-tests-only-not-real-secret-0123456789",LIBRARIAN_WRITES_ENABLED:"true",TELEGRAM_MINI_APP_ENABLED:"true",TELEGRAM_BOT_TOKEN:"123456:test-only-token"};
registerHooks({resolve(specifier,context,next){if(specifier==="cloudflare:workers")return {url:"data:text/javascript,export const env=globalThis.__READER_TEST_ENV",shortCircuit:true};return next(specifier,context);}});
export function readerDatabase(){
  const sqlite=new DatabaseSync(":memory:");
  for(const file of fs.readdirSync("drizzle").filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort())sqlite.exec(fs.readFileSync("drizzle/"+file,"utf8"));
  sqlite.exec("PRAGMA foreign_keys=ON");
  const db={sqlite,beforeBatch:null,prepare(sql){const make=bindings=>({bind(...values){return make(values);},async all(){return {success:true,results:sqlite.prepare(sql).all(...bindings)};},async first(){return sqlite.prepare(sql).get(...bindings)??null;}});return make([]);},async batch(statements){if(this.beforeBatch){const hook=this.beforeBatch;this.beforeBatch=null;await hook();}sqlite.exec("BEGIN IMMEDIATE");try{const result=[];for(const item of statements)result.push(await item.all());sqlite.exec("COMMIT");return result;}catch(error){sqlite.exec("ROLLBACK");throw error;}}};
  const now=new Date().toISOString();
  sqlite.prepare("INSERT INTO users(id,full_name,sort_name,email,role,status,created_at,updated_at) VALUES('admin','Admin','admin','admin@example.test','admin','active',?,?)").run(now,now);
  for(const id of ["reader-a","reader-b"])sqlite.prepare("INSERT INTO library_readers(id,member_no,full_name,sort_name,kind,status,access_status,created_at,updated_at) VALUES(?,?,?,?,'student','active','inactive',?,?)").run(id,id,"Читач "+id,id,now,now);
  sqlite.prepare("INSERT INTO library_editions(id,source_media_id,fund,title,publication_state,created_at,updated_at) VALUES('edition','1','literature','Книга','published',?,?)").run(now,now);
  return db;
}
export const actor={id:"admin",email:"admin@example.test"};
export function publishReaderFixture(db){db.sqlite.exec("INSERT INTO materials(id,catalog_number,title,sort_title,search_text,created_at,updated_at) VALUES('CAT-3000',3000,'Книга','книга','книга','2026-09-06','2026-09-06'); UPDATE library_editions SET material_id='CAT-3000' WHERE id='edition';");}
export function readerRequest(token,telegram=false){return new Request("https://library.example.test/api/reader/profile",{headers:{Cookie:`${telegram?"__Host-library_reader_telegram":"__Host-library_reader"}=${token}`,Referer:`https://library.example.test/reader${telegram?"/telegram":""}`}});}
export const telegramIdentity=(user="100",hash="a")=>({telegramUserId:user,initDataHash:hash.repeat(64),authDate:Math.floor(Date.now()/1000),expiresAt:new Date(Date.now()+300000).toISOString()});
