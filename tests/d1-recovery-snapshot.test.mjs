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
  assert.deepEqual(snapshot.tables.find(table => table.name === "records").rows[0].bytes, {$blob:[0,255,128]});
  assert.equal(restoreAndVerifySnapshot(snapshot).rows, 2);
  sqlite.close();
});
test("recovery refuses non-rebuildable virtual data and sequence loss", async () => {
  for (const sql of ["CREATE VIRTUAL TABLE standalone USING fts5(title)", "CREATE TABLE records(id INTEGER PRIMARY KEY AUTOINCREMENT)"]) {
    const sqlite = new DatabaseSync(":memory:"); sqlite.exec(sql);
    await assert.rejects(createD1RecoverySnapshot(adapter(sqlite)));
    sqlite.close();
  }
});
test("recovery refuses partial batches and concurrent schema changes", async () => {
  const schema = [{ type: "table", name: "test", tbl_name: "test", sql: "CREATE TABLE test(id TEXT)" }];
  const db = { prepare() { return { async all() { return {results:schema}; } }; }, async batch() { return [{results:schema},{results:[]},{results:[]}]; } };
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
