import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createD1RecoverySnapshot, quoteRecoveryIdentifier } from "../lib/d1-recovery-snapshot.ts";
import fs from "node:fs";
import { restoreAndVerifySnapshot } from "../scripts/verify-d1-recovery.mjs";

function adapter(sqlite) {
  return { prepare(sql) { return { sql, async all() { return { success: true, results: sqlite.prepare(sql).all() }; } }; },
    async batch(statements) { sqlite.exec("BEGIN"); try { const values = await Promise.all(statements.map(s => s.all())); sqlite.exec("COMMIT"); return values; } catch (e) { sqlite.exec("ROLLBACK"); throw e; } } };
}
test("read-only recovery keeps private tables and excludes rebuildable FTS internals", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE records(id TEXT PRIMARY KEY, title TEXT); CREATE TABLE private_access(id TEXT PRIMARY KEY, token_hash TEXT); CREATE VIRTUAL TABLE records_fts USING fts5(title,content='records'); INSERT INTO records VALUES('01','Книга'); INSERT INTO private_access VALUES('p','hash-only');");
  const snapshot = JSON.parse((await createD1RecoverySnapshot(adapter(sqlite))).json);
  assert.equal(snapshot.rowCount, 2); assert.equal(snapshot.tables.length, 2);
  assert.equal(snapshot.tables.find(t => t.name === "private_access").rows[0].token_hash, "hash-only");
  assert.deepEqual(snapshot.rebuildVirtualTables, ["records_fts"]);
  assert.equal(restoreAndVerifySnapshot(snapshot).verified, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM records").get().n, 1);
  sqlite.close();
});
test("recovery round-trip preserves blobs and installs side-effect triggers after rows", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE records(id TEXT PRIMARY KEY, bytes BLOB); CREATE TABLE audit(id TEXT); CREATE TRIGGER records_audit AFTER INSERT ON records BEGIN INSERT INTO audit VALUES(new.id); END; INSERT INTO records VALUES('one',x'00ff80');");
  const snapshot = JSON.parse((await createD1RecoverySnapshot(adapter(sqlite))).json);
  assert.deepEqual(snapshot.tables.find(table => table.name === "records").rows[0].bytes, {$blobHex:"00FF80"});
  assert.equal(restoreAndVerifySnapshot(snapshot).rows, 2);
  sqlite.close();
});
test("recovery refuses non-rebuildable virtual data", async () => {
  const sqlite = new DatabaseSync(":memory:"); sqlite.exec("CREATE VIRTUAL TABLE standalone USING fts5(title)");
  await assert.rejects(createD1RecoverySnapshot(adapter(sqlite))); sqlite.close();
});
test("recovery retains AUTOINCREMENT high-water values and stays query-bounded", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE sequence_test(id INTEGER PRIMARY KEY AUTOINCREMENT); INSERT INTO sequence_test VALUES(100); DELETE FROM sequence_test;");
  for (let n = 0; n < 100; n++) sqlite.exec(`CREATE TABLE records_${n}(id TEXT PRIMARY KEY)`);
  const db = adapter(sqlite); let queryCount = 0;
  const original = db.prepare; db.prepare = (sql) => { queryCount++; return original(sql); };
  const snapshot = JSON.parse((await createD1RecoverySnapshot(db)).json);
  assert.equal(snapshot.tables.find(table => table.name === "sqlite_sequence").rows[0].seq, 100);
  assert.equal(queryCount, 5); assert.equal(restoreAndVerifySnapshot(snapshot).verified, true); sqlite.close();
});
test("recovery refuses partial batches and concurrent schema changes", async () => {
  const schema = [{ type: "table", name: "test", tbl_name: "test", sql: "CREATE TABLE test(id TEXT)" }];
  const db = { prepare(sql) { return { async all() { return {results:sql.includes("pragma_table_xinfo") ? [{table_name:"test",column_name:"id"}] : schema}; } }; }, async batch() { return [{results:schema},{results:[]},{results:[]}]; } };
  await assert.rejects(createD1RecoverySnapshot(db), /Схема змінилася/);
});
test("recovery identifiers cannot introduce a second statement", () => {
  assert.equal(quoteRecoveryIdentifier('a";drop table x;--'), '"a"";drop table x;--"');
  assert.throws(() => quoteRecoveryIdentifier("bad\0name"));
});
test("recovery endpoint is administrator-only and never cached", () => {
  const code = fs.readFileSync("app/api/librarian/recovery-export/route.ts", "utf8");
  assert.match(code, /authorizeLibrarianApi\(\)/); assert.match(code, /access\.role !== "admin"/); assert.match(code, /private, no-store/);
});
test("full current application schema round-trips with D1 function and SQL bounds", async () => {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of fs.readdirSync("drizzle").filter(name => /^\d{4}_.*\.sql$/.test(name)).sort()) sqlite.exec(fs.readFileSync("drizzle/" + file, "utf8"));
  const db = adapter(sqlite); const original = db.prepare; let queryCount = 0;
  db.prepare = sql => {
    queryCount++; assert.ok(Buffer.byteLength(sql) < 100000);
    return original(sql);
  };
  const snapshot = JSON.parse((await createD1RecoverySnapshot(db)).json);
  assert.ok(queryCount < 30); assert.ok(snapshot.tables.length > 40);
  assert.equal(restoreAndVerifySnapshot(snapshot).verified, true); sqlite.close();
});
