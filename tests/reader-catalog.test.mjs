import test from "node:test";
import assert from "node:assert/strict";
import {readerDatabase} from "./helpers/reader-database.mjs";
const catalog=await import("../lib/library-reader-catalog.ts");
function setup(){const db=readerDatabase();db.sqlite.exec(`INSERT INTO materials(id,catalog_number,title,sort_title,search_text,author,created_at,updated_at) VALUES('CAT-2000',2000,'Книга','книга','книга автор','Автор','2026-09-06','2026-09-06');UPDATE library_editions SET material_id='CAT-2000',source_json='{"PrivateSource":"secret"}' WHERE id='edition';INSERT INTO materials(id,catalog_number,title,sort_title,search_text,created_at,updated_at) VALUES('CAT-2001',2001,'Посібник','посібник','посібник','2026-09-06','2026-09-06');
  INSERT INTO library_catalog_entities(id,kind,name,slug,public_metadata_json,source_json) VALUES('author','author','Автор','author','{"biography":"Біографія <b>як текст</b>"}','{"privateContact":"secret"}');INSERT INTO library_edition_entities(edition_id,entity_id,role) VALUES('edition','author','author');
  INSERT INTO locations(id,name,type,status,created_at,updated_at) VALUES('loc','Бібліотека','library','active','2026-09-06','2026-09-06');INSERT INTO holdings(material_id,location_id,condition,quantity,version,updated_at) VALUES('CAT-2000','loc','unspecified',2,1,'2026-09-06');
  INSERT INTO library_copies(id,edition_id,accession_no,copy_no,location_id,registration,physical_state,created_at,updated_at) VALUES('copy-a','edition','003','1','loc','registered','on_shelf','2026-09-06','2026-09-06'),('copy-b','edition','003','2','loc','registered','on_shelf','2026-09-06','2026-09-06');`);return db;}
test("fund separation and Ukrainian normalized search use the same canonical database",async()=>{const db=setup();try{
  const list=await catalog.listReaderCatalog(db,new URL("https://example.test/?q=КНИГА&author=author"));assert.equal(list.total,1);assert.equal(list.items[0].title,"Книга");
  const education=await catalog.listReaderCatalog(db,new URL("https://example.test/?fund=education"));assert.equal(education.total,1);assert.equal(education.items[0].title,"Посібник");
  db.sqlite.exec("UPDATE library_editions SET publication_state='draft'");assert.equal((await catalog.listReaderCatalog(db,new URL("https://example.test/"))).total,0);
}finally{db.sqlite.close();}});
test("public book and author projections never include private source JSON",async()=>{const db=setup();try{
  const book=await catalog.getReaderCatalogBook(db,"edition"),author=await catalog.getReaderCatalogEntity(db,"author");assert.doesNotMatch(JSON.stringify({book,author}),/secret|PrivateSource|privateContact/);
  assert.equal(author.metadata.biography,"Біографія <b>як текст</b>");assert.equal((await catalog.readerCatalogFacets(db))[0].count,1);
}finally{db.sqlite.close();}});
test("scan preserves duplicate accession choices and never matches empty ISBN accidentally",async()=>{const db=setup();try{
  assert.equal((await catalog.scanReaderCatalog(db,"003")).matches.length,2);
  assert.equal((await catalog.scanReaderCatalog(db,"copy-a")).matches.length,1);
  assert.equal((await catalog.scanReaderCatalog(db,"https://yedyna-biblioteka-liceiu.nazarijshvetz1.chatgpt.site/library?book=edition")).matches.length,2);
  assert.equal((await catalog.scanReaderCatalog(db,"unknown-code")).matches.length,0);
  await assert.rejects(catalog.scanReaderCatalog(db,"https://evil.example/?copy=copy-a"));
}finally{db.sqlite.close();}});

test("a draft mapped edition cannot escape through the canonical CAT fallback",async()=>{const db=setup();try{db.sqlite.exec("UPDATE library_editions SET publication_state='draft'");await assert.rejects(catalog.getReaderCatalogBook(db,"edition"));await assert.rejects(catalog.getReaderCatalogBook(db,"CAT-2000"));assert.equal((await catalog.scanReaderCatalog(db,"copy-a")).matches.length,0);}finally{db.sqlite.close();}});
