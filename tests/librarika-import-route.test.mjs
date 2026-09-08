import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {readBoundedJson} from "../lib/bounded-json.ts";
test("bounded upload rejects streaming overflow, invalid JSON and non-object values",async()=>{
  const request=text=>new Request("https://example.test",{method:"POST",headers:{"Content-Type":"application/json"},body:text});
  assert.deepEqual(await readBoundedJson(request('{"value":1}'),20),{value:1});
  await assert.rejects(readBoundedJson(request('{"value":"'+"x".repeat(30)+'"}'),20));
  await assert.rejects(readBoundedJson(request("[]"),20));
  await assert.rejects(readBoundedJson(request("null"),20));
});
test("retired full import cannot mutate the local database and points to the sync center",()=>{
  const route=fs.readFileSync("app/api/librarian/librarika-import/route.ts","utf8");
  for(const method of ["GET","POST","PUT","PATCH","DELETE"])assert.match(route,new RegExp(`export const ${method}=retiredImport`));
  assert.match(route,/status:410/u);
  assert.match(route,/librarika_import_retired/u);
  assert.match(route,/syncUrl:"\/librarian\/sync"/u);
  assert.match(route,/LIBRARIKA_CATALOG_URL/u);
  assert.doesNotMatch(route,/cloudflare:workers|librarika-import-store|readBoundedJson|startLibrarikaImport|appendLibrarikaImportPart/u);
  const page=fs.readFileSync("app/librarian/migration/page.tsx","utf8");
  assert.match(page,/redirect\("\/librarian\/literature"\)/u);
  assert.doesNotMatch(page,/ImportUpload|CoverUpload|ActivationUpload/u);
});
