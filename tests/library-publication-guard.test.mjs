import test from "node:test";
import assert from "node:assert/strict";
import {readerDatabase,actor} from "./helpers/reader-database.mjs";
import {saveLibraryEdition} from "../lib/library-editor.ts";
import {getCatalogMaterialDetail,getCatalogCoverAsset,listCatalogMaterials,listCatalogMaterialFacets,parseCatalogListQuery} from "../lib/catalog-d1.ts";
test("literature cannot enter the education catalog before or after publication",async()=>{
 const db=readerDatabase();try{
  const book=await saveLibraryEdition(db,actor,{requestId:crypto.randomUUID(),title:"Неопубліковане видання",metadata:{author:"Автор",genre:"Прихована рубрика"},entityIds:[],published:false});
  db.sqlite.prepare("INSERT INTO material_cover_assets(id,material_id,status,storage_provider,storage_key,mime_type,sha256,created_at,updated_at) VALUES('cover-test',?,'ready','r2','covers/test.jpg','image/jpeg',?,'2026-09-06','2026-09-06')").run(book.materialId,"a".repeat(64));
  assert.throws(()=>parseCatalogListQuery(new URL("https://library.example.test/api/catalog-v2?fund=all"),{defaultFund:"education",allowedFunds:["education"]}),/недоступний/u);
  const educationQuery=parseCatalogListQuery(new URL("https://library.example.test/api/catalog-v2?fund=education&q="+book.materialId),{defaultFund:"education",allowedFunds:["education"]});
  const allQuery=parseCatalogListQuery(new URL("https://library.example.test/api/catalog-v2?fund=all&q="+book.materialId));
  const assertEducationHidden=async()=>{
   assert.equal(await getCatalogMaterialDetail(db,book.materialId,"public",{fund:"education"}),null);
   assert.equal((await listCatalogMaterials(db,educationQuery)).items.length,0);
   assert.equal((await listCatalogMaterialFacets(db,undefined,"public","education")).rubrics.includes("Прихована рубрика"),false);
   assert.equal(await getCatalogCoverAsset(db,book.materialId,"public","education"),null);
  };
  await assertEducationHidden();
  assert.equal((await listCatalogMaterials(db,allQuery)).items.length,0);
  assert.ok(await getCatalogMaterialDetail(db,book.materialId,"librarian"));
  assert.equal((await listCatalogMaterials(db,allQuery,{scope:"librarian"})).items.length,1);
  assert.ok(await getCatalogCoverAsset(db,book.materialId,"librarian"));
  assert.equal(await getCatalogCoverAsset(db,book.materialId,"public","literature"),null);
  db.sqlite.prepare("UPDATE library_editions SET publication_state='published' WHERE id=?").run(book.id);
  await assertEducationHidden();
  assert.equal((await listCatalogMaterials(db,allQuery)).items.length,0);
  assert.ok(await getCatalogMaterialDetail(db,book.materialId,"public",{fund:"literature"}));
  assert.ok(await getCatalogCoverAsset(db,book.materialId,"public","literature"));
 }finally{db.sqlite.close();}
});
