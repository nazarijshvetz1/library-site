import test from 'node:test';
import assert from 'node:assert/strict';
import {readerDatabase,actor} from './helpers/reader-database.mjs';
const editor=await import('../lib/library-editor.ts'),copies=await import('../lib/library-copy-store.ts');
test('canonical edits synchronize the edition and a later description edit cannot restore stale titles',async()=>{
 const db=readerDatabase();try{
  const {updateMaterialDirect}=await import('../lib/library-mutation-store.ts');
  const input={requestId:crypto.randomUUID(),title:'Стара назва',metadata:{author:'Старий автор',description:'Опис',isbn13:'9786170953858'},entityIds:[],published:true};
  const book=await editor.saveLibraryEdition(db,actor,input);
  db.sqlite.prepare("UPDATE library_editions SET source_json='{\"original\":true}' WHERE id=?").run(book.id);
  await updateMaterialDirect({userId:'auth-admin',d1UserId:actor.id,email:actor.email},book.materialId,{requestId:crypto.randomUUID(),expectedVersion:1,changes:{title:'Виправлена назва',author:'Виправлений автор',isbn:null}},db);
  const current=await editor.getLibrarianEdition(db,book.id);
  assert.equal(current.title,'Виправлена назва');assert.equal(current.metadata.author,'Виправлений автор');assert.equal(current.version,2);
  assert.equal(current.metadata.isbn13,'');assert.equal(current.metadata.isbn10,'');
  await editor.saveLibraryEdition(db,actor,{...input,requestId:crypto.randomUUID(),id:book.id,expectedVersion:current.version,expectedMaterialVersion:current.material_version,title:current.title,metadata:{...current.metadata,description:'Новий опис'}});
  assert.equal(db.sqlite.prepare('SELECT title FROM materials WHERE id=?').get(book.materialId).title,'Виправлена назва');
  assert.equal(db.sqlite.prepare('SELECT source_json FROM library_editions WHERE id=?').get(book.id).source_json,'{"original":true}');
 }finally{db.sqlite.close();}
});
test('public field names, cleared birth date and long Ukrainian text survive the HTTP boundary',async()=>{
 const db=readerDatabase();try{
  const {readBoundedJson}=await import('../lib/bounded-json.ts');
  const {getReaderCatalogBook}=await import('../lib/library-reader-catalog.ts');
  const input={requestId:crypto.randomUUID(),title:'Книга',metadata:{type:'Роман',ddc:'821',description:'ї'.repeat(20000)},entityIds:[],published:true};
  const body=await readBoundedJson(new Request('https://library.example.test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'edition_save',input})}),400000);
  const book=await editor.saveLibraryEdition(db,actor,body.input),visible=await getReaderCatalogBook(db,book.id);
  assert.equal(visible.metadata.type,'Роман');assert.equal(visible.metadata.ddc,'821');assert.equal(visible.metadata.description.length,20000);
  const author=await editor.saveLibraryEntity(db,actor,{requestId:crypto.randomUUID(),kind:'author',name:'Автор',metadata:{dateOfBirth:'1900'}});
  await editor.saveLibraryEntity(db,actor,{requestId:crypto.randomUUID(),id:author.id,expectedVersion:1,kind:'author',name:'Автор',metadata:{dateOfBirth:''}});
  assert.equal(JSON.parse(db.sqlite.prepare('SELECT public_metadata_json FROM library_catalog_entities WHERE id=?').get(author.id).public_metadata_json).dateOfBirth,'');
 }finally{db.sqlite.close();}
});
test('manual edition and exact copy registration stay separate and replay without duplicate stock',async()=>{const db=readerDatabase();try{const input={requestId:crypto.randomUUID(),title:'Нова книга',metadata:{author:'Автор',isbn13:'9786170953858'},entityIds:[],published:true};const book=await editor.saveLibraryEdition(db,actor,input);assert.equal((await editor.saveLibraryEdition(db,actor,input)).id,book.id);assert.equal(db.sqlite.prepare('SELECT total_quantity FROM material_stock_totals WHERE material_id=?').get(book.materialId).total_quantity,0);db.sqlite.exec("INSERT INTO locations(id,name,type,status,created_at,updated_at) VALUES('loc','Бібліотека','library','active','2026-09-06','2026-09-06')");const copyInput={requestId:crypto.randomUUID(),editionId:book.id,expectedEditionVersion:1,accessionNo:'NEW-001',copyNo:'1',locationId:'loc',condition:'good'},copy=await copies.registerLibraryCopy(db,actor,copyInput);assert.equal((await copies.registerLibraryCopy(db,actor,copyInput)).id,copy.id);assert.equal(db.sqlite.prepare('SELECT total_quantity FROM material_stock_totals WHERE material_id=?').get(book.materialId).total_quantity,1);await assert.rejects(copies.registerLibraryCopy(db,actor,{...copyInput,requestId:crypto.randomUUID()}));await copies.moveLibraryCopy(db,actor,{requestId:crypto.randomUUID(),copyId:copy.id,expectedVersion:1,action:'transfer',locationId:'loc',condition:'worn',note:'Огляд стану',confirmation:'CONFIRM_COPY_MOVEMENT'});assert.equal(db.sqlite.prepare('SELECT quantity FROM holdings').get().quantity,1);assert.equal(db.sqlite.prepare('SELECT condition FROM library_copies WHERE id=?').get(copy.id).condition,'worn');await copies.moveLibraryCopy(db,actor,{requestId:crypto.randomUUID(),copyId:copy.id,expectedVersion:2,action:'withdraw',note:'Пошкоджено',confirmation:'CONFIRM_COPY_MOVEMENT'});assert.equal(db.sqlite.prepare('SELECT total_quantity FROM material_stock_totals WHERE material_id=?').get(book.materialId).total_quantity,0);assert.equal(db.sqlite.prepare('SELECT count(*) n FROM library_copy_movements').get().n,3);assert.equal(db.sqlite.prepare('PRAGMA foreign_key_check').all().length,0);}finally{db.sqlite.close();}});
test('edition update preserves source fields and rejects concurrent canonical edits',async()=>{const db=readerDatabase();try{const input={requestId:crypto.randomUUID(),title:'Книга',metadata:{annotation:'Анотація'},entityIds:[],published:true},book=await editor.saveLibraryEdition(db,actor,input);db.sqlite.prepare("UPDATE library_editions SET source_json='{\"original\":true}',public_metadata_json=json_set(public_metadata_json,'$.sourceUrl','https://source.example/') WHERE id=?").run(book.id);await editor.saveLibraryEdition(db,actor,{...input,requestId:crypto.randomUUID(),id:book.id,expectedVersion:1,expectedMaterialVersion:1,title:'Оновлена книга',metadata:{description:'Опис'}});const value=await editor.getLibrarianEdition(db,book.id);assert.equal(value.metadata.annotation,'Анотація');assert.equal(value.metadata.description,'Опис');assert.equal(value.metadata.sourceUrl,'https://source.example/');assert.equal(db.sqlite.prepare('SELECT source_json FROM library_editions WHERE id=?').get(book.id).source_json,'{"original":true}');await assert.rejects(editor.saveLibraryEdition(db,actor,{...input,requestId:crypto.randomUUID(),id:book.id,expectedVersion:2,expectedMaterialVersion:1}));}finally{db.sqlite.close();}});
