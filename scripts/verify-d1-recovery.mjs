import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const quote = (value) => '"' + String(value).replaceAll('"', '""') + '"';
const digest = (rows) => crypto.createHash("sha256").update(JSON.stringify(rows.map(row => JSON.stringify(Object.keys(row).sort().map(key => [key, normalize(row[key])]))).sort())).digest("hex");
function normalize(value) {
  if (value instanceof Uint8Array || Array.isArray(value)) return { $blobHex: Buffer.from(value).toString("hex").toUpperCase() };
  if (value && typeof value === "object" && Array.isArray(value.$blob)) return { $blobHex: Buffer.from(value.$blob).toString("hex").toUpperCase() };
  return value;
}
function decode(value) {
  if (value && typeof value === "object" && typeof value.$blobHex === "string") {
    if (!/^(?:[0-9a-f]{2})*$/i.test(value.$blobHex)) throw new Error("Invalid BLOB hex");
    return Buffer.from(value.$blobHex, "hex");
  }
  if (value && typeof value === "object" && Array.isArray(value.$blob)) {
    if (!value.$blob.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error("Invalid BLOB");
    return Buffer.from(value.$blob);
  }
  return value;
}

/** Offline drill only. Never accepts an existing database, network or production handle. */
export function restoreAndVerifySnapshot(snapshot, databasePath = ":memory:") {
  if (snapshot.format !== "library-d1-recovery" || snapshot.version !== 1 || !Array.isArray(snapshot.schema) || !Array.isArray(snapshot.tables)) throw new Error("Invalid recovery format");
  if (databasePath !== ":memory:" && fs.existsSync(databasePath)) throw new Error("Refusing to overwrite an existing database");
  const names = snapshot.tables.map(table => table.name);
  if (new Set(names).size !== names.length || snapshot.rowCount !== snapshot.tables.reduce((n, table) => n + table.rows.length, 0)) throw new Error("Invalid recovery table count");
  const virtualNames = snapshot.rebuildVirtualTables ?? [];
  const excluded = new Set(virtualNames.flatMap(name => [name, ...["_data", "_idx", "_content", "_docsize", "_config"].map(suffix => name + suffix)]));
  const ordinarySchema = snapshot.schema.filter(item => item.type === "table" && !excluded.has(item.name));
  if (JSON.stringify(ordinarySchema.map(item => item.name).sort()) !== JSON.stringify([...names].sort())) throw new Error("Missing recovery table");
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    for (const table of ordinarySchema) if (table.name !== "sqlite_sequence") db.exec(table.sql);
    for (const table of snapshot.tables) {
      // AUTOINCREMENT table creation creates this SQLite-owned table automatically.
      if (table.name === "sqlite_sequence") continue;
      const columns = db.prepare(`PRAGMA table_xinfo(${quote(table.name)})`).all().filter(column => column.hidden === 0).map(column => column.name);
      const statement = db.prepare(`INSERT INTO ${quote(table.name)} (${columns.map(quote).join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
      for (const row of table.rows) statement.run(...columns.map(column => decode(row[column])));
    }
    const sequence = snapshot.tables.find(table => table.name === "sqlite_sequence");
    if (sequence) {
      db.exec("DELETE FROM sqlite_sequence");
      for (const row of sequence.rows) db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)").run(row.name, row.seq);
    }
    for (const name of virtualNames) {
      const table = snapshot.schema.find(item => item.name === name && item.type === "table");
      if (!table || !/\bUSING\s+fts5\s*\(/i.test(table.sql) || !/\bcontent\s*=\s*'[^']+'/i.test(table.sql)) throw new Error("Unsupported virtual table");
      db.exec(table.sql);
      db.exec(`INSERT INTO ${quote(name)}(${quote(name)}) VALUES('rebuild'); INSERT INTO ${quote(name)}(${quote(name)}, rank) VALUES('integrity-check', 1)`);
    }
    for (const type of ["index", "view", "trigger"]) for (const item of snapshot.schema.filter(item => item.type === type && !excluded.has(item.tbl_name))) db.exec(item.sql);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Recovery foreign-key check failed");
    if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") throw new Error("Recovery integrity check failed");
    const tableDigests = snapshot.tables.map(table => {
      const rows = db.prepare(`SELECT * FROM ${quote(table.name)}`).all();
      if (rows.length !== table.rows.length || digest(rows) !== digest(table.rows)) throw new Error(`Recovery data mismatch in ${table.name}`);
      return { name: table.name, rows: rows.length, sha256: digest(rows) };
    });
    const restoredSchema = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND (name NOT GLOB 'sqlite_*' OR name='sqlite_sequence') AND name NOT GLOB '_cf_*' ORDER BY type,name").all();
    const expectedSchema = snapshot.schema.map(({type,name,sql}) => ({type,name,sql}));
    if (digest(restoredSchema) !== digest(expectedSchema)) throw new Error("Recovery schema mismatch");
    db.exec("COMMIT; PRAGMA foreign_keys=ON");
    if (db.prepare("PRAGMA foreign_keys").get().foreign_keys !== 1 || db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Post-commit recovery check failed");
    return { verified: true, tables: names.length, rows: snapshot.rowCount, virtualTablesRebuilt: virtualNames, tableDigests };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* No transaction after a committed check. */ }
    throw error;
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2) throw new Error("Usage: node scripts/verify-d1-recovery.mjs SNAPSHOT_JSON NEW_PRIVATE_OUTPUT_DIRECTORY");
  const [source, output] = args.map(value => path.resolve(value));
  if (!output.split(path.sep).includes(".migration-private") || fs.existsSync(output)) throw new Error("A new .migration-private output directory is required");
  fs.mkdirSync(output, { recursive: true });
  const bytes = fs.readFileSync(source);
  fs.writeFileSync(path.join(output, "snapshot.json"), bytes, { flag: "wx" });
  const report = restoreAndVerifySnapshot(JSON.parse(bytes.toString("utf8")), path.join(output, "restored-local.sqlite"));
  const manifest = { ...report, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), verifiedAt: new Date().toISOString(), scope: "Logical D1 application data. R2 objects and runtime secrets are separate recovery dependencies." };
  fs.writeFileSync(path.join(output, "verification.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ verified: report.verified, tables: report.tables, rows: report.rows, sha256: manifest.sha256, output }));
}
