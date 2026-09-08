import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {LIBRARIKA_CATALOG_URL,librarikaBookUrl} from "../lib/librarika.ts";

test("student portal exposes one external fiction catalogue and no local textbook catalogue",()=>{
  const portal=fs.readFileSync("app/reader/reader-portal.tsx","utf8");
  assert.equal(LIBRARIKA_CATALOG_URL,"https://librarylyceummaup.librarika.com/search");
  assert.match(portal,/Каталог художньої літератури/u);
  assert.match(portal,/LIBRARIKA_CATALOG_URL/u);
  assert.doesNotMatch(portal,/ReaderCatalog|catalog-panel|Е-підручники/u);
  assert.doesNotMatch(portal,/BookDialog|EntityDialog/u);
});

test("legacy book links can only resolve to a fixed numeric Librarika destination",()=>{
  assert.equal(librarikaBookUrl("13752524"),"https://librarylyceummaup.librarika.com/search/detail/13752524");
  for(const value of ["",0,"-1","abc","1?next=https://evil.example","https://evil.example/1",null]){
    assert.equal(librarikaBookUrl(value),null);
  }
  const route=fs.readFileSync("app/library/page.tsx","utf8");
  assert.match(route,/SELECT source_media_id FROM library_editions/u);
  assert.match(route,/redirect\(LIBRARIKA_CATALOG_URL\)/u);
  assert.doesNotMatch(route,/sourceUrl|public_metadata_json/u);
});

test("local reader circulation, reservation, rating and subscription API is fully retired",()=>{
  const route=fs.readFileSync("app/api/reader/books/route.ts","utf8");
  for(const method of ["GET","POST","PUT","PATCH","DELETE"])assert.match(route,new RegExp(`export const ${method}=retiredReaderBooks`));
  assert.match(route,/status:410/u);
  assert.match(route,/librarika_authoritative/u);
  assert.doesNotMatch(route,/cloudflare:workers|reader-profile-store|ReaderDatabase|requestReaderBook|saveReaderRating|setReaderBookSubscription/u);
  const panel=fs.readFileSync("app/reader/books-panel.tsx","utf8");
  assert.match(panel,/Актуальні дані — у Librarika/u);
  assert.doesNotMatch(panel,/readerFetch|ReaderLoan|reader_circulations/u);
  const bot=fs.readFileSync("lib/reader-telegram.ts","utf8");
  assert.doesNotMatch(bot,/reader_circulations/u);
  assert.match(bot,/перевірена проєкція/u);
});

test("the retired local fiction catalog cannot be called directly",()=>{
  const route=fs.readFileSync("app/api/library/catalog/route.ts","utf8");
  for(const method of ["GET","POST","PUT","PATCH","DELETE"])assert.match(route,new RegExp(`export const ${method}=retiredCatalog`));
  assert.match(route,/status:410/u);
  assert.match(route,/librarika_authoritative/u);
  assert.match(route,/LIBRARIKA_CATALOG_URL/u);
  assert.doesNotMatch(route,/cloudflare:workers|library-reader-catalog|ReaderDatabase/u);
  const education=fs.readFileSync("app/api/catalog-v2/route.ts","utf8");
  const facets=fs.readFileSync("app/api/catalog-v2/facets/route.ts","utf8");
  assert.match(education,/defaultFund: "education"/u);
  assert.match(education,/allowedFunds: \["education"\]/u);
  assert.match(facets,/"education"/u);
  for(const path of ["app/api/library/material-covers/[id]/route.ts","app/api/library/covers/[sha]/route.ts"]){
    const coverRoute=fs.readFileSync(path,"utf8");
    for(const method of ["GET","HEAD","POST","PUT","PATCH","DELETE"])assert.match(coverRoute,new RegExp(`export const ${method} = retired`));
    assert.match(coverRoute,/status: 410/u);
    assert.match(coverRoute,/librarika_authoritative/u);
    assert.doesNotMatch(coverRoute,/publicCatalogCoverResponse|cover-storage|cloudflare:workers/u);
  }
});

test("librarian-side legacy fiction reads and cover writes are retired",()=>{
  const readers=fs.readFileSync("app/api/librarian/readers/route.ts","utf8");
  assert.match(readers,/\["circulations","copies","requests","moderation","edition","entities","activation","editions"\]/u);
  assert.match(readers,/librarika_authoritative/u);
  assert.doesNotMatch(readers,/library-editor|librarika-activation/u);
  const covers=fs.readFileSync("app/api/librarian/librarika-covers/route.ts","utf8");
  for(const method of ["GET","POST","PUT","PATCH","DELETE"])assert.match(covers,new RegExp(`export const ${method}=retiredCoverImport`));
  assert.match(covers,/status:410/u);
  assert.doesNotMatch(covers,/cover-storage|librarika-cover-import|cloudflare:workers/u);
});

test("reader community keeps chats but does not depend on the retired local fiction catalogue",()=>{
  const source=fs.readFileSync("lib/reader-community.ts","utf8");
  assert.match(source,/librarika_authoritative/u);
  assert.match(source,/activeCommunityThread/u);
  assert.doesNotMatch(source,/library_editions|JOIN materials/u);
  assert.match(source,/t\.kind!='book'/u);
});
