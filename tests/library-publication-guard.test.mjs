import test from "node:test";
import assert from "node:assert/strict";
import {readerDatabase,actor} from "./helpers/reader-database.mjs";
import {saveLibraryEdition} from "../lib/library-editor.ts";
import {searchAssistantCatalog} from "../lib/assistant-search.ts";
import {getCatalogMaterialDetail,getCatalogCoverAsset,listCatalogMaterials,listCatalogMaterialFacets,parseCatalogListQuery} from "../lib/catalog-d1.ts";
test("draft literature cannot bypass publication through legacy public catalog, facets or cover routes",async()=>{
 const db=readerDatabase();try{
  const book=await saveLibraryEdition(db,actor,{requestId:crypto.randomUUID(),title:"Неопубліковане видання",metadata:{author:"Автор",genre:"Прихована рубрика"},entityIds:[],published:false});
  db.sqlite.prepare("INSERT INTO material_cover_assets(id,material_id,status,storage_provider,storage_key,mime_type,sha256,created_at,updated_at) VALUES('cover-test',?,'ready','r2','covers/test.jpg','image/jpeg',?,'2026-09-06','2026-09-06')").run(book.materialId,"a".repeat(64));
  const query=parseCatalogListQuery(new URL("https://library.example.test/api/catalog-v2?fund=all&q="+book.materialId),{defaultFund:"education"});
  assert.equal(await getCatalogMaterialDetail(db,book.materialId,"public"),null);
  assert.equal((await listCatalogMaterials(db,query)).items.length,0);
  assert.equal((await listCatalogMaterialFacets(db)).rubrics.includes("Прихована рубрика"),false);
  assert.equal(await getCatalogCoverAsset(db,book.materialId),null);
  assert.ok(await getCatalogMaterialDetail(db,book.materialId,"librarian"));
  assert.equal((await listCatalogMaterials(db,query,{scope:"librarian"})).items.length,1);
  assert.ok(await getCatalogCoverAsset(db,book.materialId,"librarian"));
  assert.equal((await searchAssistantCatalog(db,{query:book.materialId},true)).items.length,1);
  assert.equal((await searchAssistantCatalog(db,{query:book.materialId},false)).items.length,0);
  db.sqlite.prepare("UPDATE library_editions SET publication_state='published' WHERE id=?").run(book.id);
  assert.ok(await getCatalogMaterialDetail(db,book.materialId,"public"));
  assert.equal((await listCatalogMaterials(db,query)).items.length,1);
  assert.ok(await getCatalogCoverAsset(db,book.materialId));
 }finally{db.sqlite.close();}
});
