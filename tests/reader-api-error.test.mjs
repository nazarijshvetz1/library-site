import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const source=await readFile(new URL("../lib/reader-api.ts",import.meta.url),"utf8");

test("reader API preserves only safe Telegram validation errors",()=>{
  assert.match(source,/error instanceof VisitScheduleError/u);
  assert.match(source,/error\.code==="telegram_init_data_invalid"\|\|error\.code==="telegram_init_data_expired"/u);
  assert.match(source,/\{status:401\}/u);
  assert.match(source,/code:"reader_unavailable"/u);
  assert.doesNotMatch(source,/if\(error instanceof VisitScheduleError\)return readerJson/u);
});
