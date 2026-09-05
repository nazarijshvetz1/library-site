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
test("import route preserves admin, write and origin gates without logging private errors",()=>{
  const route=fs.readFileSync("app/api/librarian/librarika-import/route.ts","utf8");
  for(const guard of ["authorizeLibrarianApi()","access.role !== \"admin\"","!access.writesEnabled","!isSameOriginRequest(request)","readBoundedJson(request, 180000)"])assert.ok(route.includes(guard));
  assert.doesNotMatch(route,/console\.(?:log|warn|error)\([^\n]*error/);
  assert.doesNotMatch(route,/\.env|OPENAI_API_KEY|OR REPLACE/);
});
