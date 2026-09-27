import test from "node:test";
import assert from "node:assert/strict";
import {collectPublicCatalogPages,fetchPublicCatalogPage,publicCatalogCursor,matchesForeignLanguage,isForeignLanguageRubric} from "../source/app.js";

test("public pagination preserves long opaque cursors and accepts an authoritative empty catalogue",async()=>{
 const cursor=Buffer.from("я".repeat(400)).toString("base64url");
 assert.ok(cursor.length>1000);
 assert.equal(publicCatalogCursor(cursor),cursor);
 const seen=[];
 const items=await collectPublicCatalogPages(async value=>{
  seen.push(value);
  return value?{items:[{id:"CAT-0002"}],hasMore:false}:{items:[{id:"CAT-0001"}],hasMore:true,nextCursor:cursor};
 });
 assert.deepEqual(seen,["",cursor]);assert.equal(items.length,2);
 assert.deepEqual(await collectPublicCatalogPages(async()=>({items:[],hasMore:false})),[]);
 assert.throws(()=>publicCatalogCursor("a".repeat(8193)));
 assert.throws(()=>publicCatalogCursor("broken cursor!"));
});

test("public pagination rejects partial, duplicate and cyclic data",async()=>{
 await assert.rejects(collectPublicCatalogPages(async cursor=>{
  if(cursor)throw Error("later page unavailable");
  return {items:[{id:"CAT-0001"}],hasMore:true,nextCursor:"next"};
 }),/later page/);
 await assert.rejects(collectPublicCatalogPages(async()=>({items:[{id:"CAT-0001"}],hasMore:true,nextCursor:"next"})),/повторний/);
 await assert.rejects(collectPublicCatalogPages(async()=>({items:[],hasMore:true,nextCursor:"next"})),/порожній/);
});

test("public reads omit credentials, retry transient failures, preserve cursor and normalize",async()=>{
 const calls=[];
 const page=await fetchPublicCatalogPage("https://catalog.test/api/catalog-v2","opaque",{
  fetcher:async(url,options)=>{
   calls.push({url,options});
   return calls.length<3?new Response("",{status:503}):Response.json({value:7});
  },normalize:value=>value.value,
 });
 assert.equal(page,7);assert.equal(calls.length,3);
 assert.equal(calls[0].options.credentials,"omit");
 assert.equal(calls[0].options.cache,"no-store");
 assert.equal(calls[0].url.searchParams.get("cursor"),"opaque");
});

test("public reads do not retry authorization, malformed JSON or schema failures",async()=>{
 for(const [response,normalize] of [
  [()=>new Response("",{status:403}),value=>value],
  [()=>new Response("{broken",{status:200}),value=>value],
  [()=>Response.json({}),()=>{throw Error("schema")}],
 ]){
  let calls=0;
  await assert.rejects(fetchPublicCatalogPage("https://catalog.test/api/catalog-v2","",{fetcher:async()=>{calls++;return response();},normalize}));
  assert.equal(calls,1);
 }
});

test("public timeout covers a stalled body, retries and eventually terminates",async()=>{
 let calls=0,aborts=0;
 await assert.rejects(fetchPublicCatalogPage("https://catalog.test/api/catalog-v2","",{
  timeoutMs:5,
  fetcher:async(_url,{signal})=>{
   calls++;
   return {ok:true,status:200,json:()=>new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>{aborts++;reject(Error("aborted"));},{once:true}))};
  },
 }),/catalog_network/);
 assert.equal(calls,3);assert.equal(aborts,3);
});

test("foreign-language grouping includes Cambridge STEM without changing independent subject",()=>{
 const item={rubric:"Англійська мова (Cambridge)",subject:"STEM"};
 assert.equal(matchesForeignLanguage(item,"en"),true);
 assert.equal(matchesForeignLanguage(item,"de"),false);
 assert.equal(matchesForeignLanguage(item,""),true);
 assert.equal(isForeignLanguageRubric(item.rubric),true);
 assert.equal(isForeignLanguageRubric("Математика"),false);
 assert.equal(item.subject,"STEM");
});

test("public body network failure retries but normalization TypeError does not",async()=>{
 let calls=0;
 const result=await fetchPublicCatalogPage("https://catalog.test/api/catalog-v2","",{fetcher:async()=>({ok:true,status:200,json:async()=>{calls++;if(calls===1)throw new TypeError("terminated");return {ok:true};}})});
 assert.equal(calls,2);assert.equal(result.ok,true);
 calls=0;
 await assert.rejects(fetchPublicCatalogPage("https://catalog.test/api/catalog-v2","",{fetcher:async()=>{calls++;return Response.json({});},normalize:()=>{throw new TypeError("schema");}}));
 assert.equal(calls,1);
});

