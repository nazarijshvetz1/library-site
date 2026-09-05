import test from "node:test";
import assert from "node:assert/strict";
import { Miniflare } from "miniflare";
import { createD1RecoverySnapshot } from "../lib/d1-recovery-snapshot.ts";
import { restoreAndVerifySnapshot } from "../scripts/verify-d1-recovery.mjs";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

test("recovery executes against the local Cloudflare D1 runtime, not only SQLite", async () => {
  const mf = new Miniflare({ modules:true, script:"export default { fetch() { return new Response('local recovery test'); } }", compatibilityDate:"2026-05-22", d1Databases:["DB"] });
  try {
    const db = await mf.getD1Database("DB");
    await db.prepare("CREATE TABLE records(id INTEGER PRIMARY KEY AUTOINCREMENT, " + Array.from({length:36}, (_, i) => `field_${i} TEXT`).join(",") + ")").run();
    await db.prepare("INSERT INTO records(id,field_1) VALUES(1,'local fixture')").run();
    const snapshot = JSON.parse((await createD1RecoverySnapshot(db)).json);
    assert.equal(snapshot.tables.find(table => table.name === "records").rows[0].field_1, "local fixture");
    assert.equal(restoreAndVerifySnapshot(snapshot).verified, true);
  } finally { await mf.dispose(); }
});
test("complete application schema exports inside workerd D1", async () => {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of fs.readdirSync("drizzle").filter(name => /^\d{4}_.*\.sql$/.test(name)).sort()) sqlite.exec(fs.readFileSync("drizzle/" + file, "utf8"));
  const schema = sqlite.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*'").all();
  sqlite.close();
  const mf = new Miniflare({ modules:true, script:"export default { fetch() { return new Response('local recovery test'); } }", compatibilityDate:"2026-05-22", d1Databases:["DB"] });
  try {
    const db = await mf.getD1Database("DB");
    for (const type of ["table", "index", "view", "trigger"]) {
      for (const item of schema.filter(item => item.type === type && !/^materials_fts_/.test(item.name))) await db.prepare(item.sql).run();
    }
    await db.prepare("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)").run();
    const snapshot = JSON.parse((await createD1RecoverySnapshot(db)).json);
    assert.equal(restoreAndVerifySnapshot(snapshot).verified, true);
  } finally { await mf.dispose(); }
});
