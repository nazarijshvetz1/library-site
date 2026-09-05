type RecoveryResult = { results?: Record<string, unknown>[]; success?: boolean };
type RecoveryStatement = { all(): Promise<RecoveryResult> };
export type RecoveryDatabase = { prepare(sql: string): RecoveryStatement; batch(statements: RecoveryStatement[]): Promise<RecoveryResult[]> };
const SCHEMA_QUERY = "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type, name";
export const MAX_RECOVERY_ROWS = 100000;
export const MAX_RECOVERY_BYTES = 32 * 1024 * 1024;

export function quoteRecoveryIdentifier(value: string) {
  if (!value || value.length > 160 || /[\x00-\x1f]/.test(value)) throw new Error("Некоректна назва таблиці.");
  return '"' + value.replaceAll('"', '""') + '"';
}

/** Read-only, one atomic batch. Only actual schema identifiers can select tables. */
export async function createD1RecoverySnapshot(db: RecoveryDatabase) {
  const initial = await db.prepare(SCHEMA_QUERY).all();
  if (initial.success === false || !Array.isArray(initial.results)) throw new Error("Не вдалося прочитати схему.");
  const schema = initial.results;
  // Fail closed instead of silently losing sequence high-water marks or virtual data.
  if (schema.some((row) => /\bAUTOINCREMENT\b/i.test(String(row.sql)))) throw new Error("Схема потребує розширеного резервного експорту послідовностей.");
  for (const row of schema.filter((item) => /^CREATE VIRTUAL TABLE/i.test(String(item.sql)))) {
    const content = /\bcontent\s*=\s*'([^']+)'/i.exec(String(row.sql));
    if (!/\bUSING\s+fts5\s*\(/i.test(String(row.sql)) || !content || !schema.some((item) => item.type === "table" && item.name === content[1])) throw new Error("Непідтримувана віртуальна таблиця для повного відновлення.");
  }
  const virtual = schema.filter((row) => row.type === "table" && /^CREATE VIRTUAL TABLE/i.test(String(row.sql))).map((row) => String(row.name));
  const shadowSuffixes = ["_data", "_idx", "_content", "_docsize", "_config"];
  const tables = schema.filter((row) => row.type === "table" && !virtual.includes(String(row.name)) && !virtual.some((name) => shadowSuffixes.some((suffix) => row.name === name + suffix)));
  if (!tables.length || tables.length > 150) throw new Error("Непідтримувана кількість таблиць для резервного експорту.");
  const reads = tables.map((table) => db.prepare(`SELECT * FROM ${quoteRecoveryIdentifier(String(table.name))} LIMIT ${MAX_RECOVERY_ROWS + 1}`));
  const result = await db.batch([db.prepare(SCHEMA_QUERY), ...reads, db.prepare(SCHEMA_QUERY)]);
  if (result.length !== reads.length + 2 || result.some((item) => item.success === false || !Array.isArray(item.results))) throw new Error("Неповний резервний експорт.");
  if (JSON.stringify(result[0].results) !== JSON.stringify(schema) || JSON.stringify(result.at(-1)!.results) !== JSON.stringify(schema)) throw new Error("Схема змінилася під час резервного експорту. Повторіть знімок.");
  let rows = 0;
  const data = tables.map((table, index) => {
    const values = result[index + 1].results!;
    rows += values.length;
    if (rows > MAX_RECOVERY_ROWS) throw new Error("Знімок перевищує безпечний обсяг. Частковий файл не створено.");
    const encoded = values.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => {
      // D1 returns BLOB columns as numeric arrays; JSON SQL columns remain strings.
      const bytes = value instanceof Uint8Array ? Array.from(value) : value instanceof ArrayBuffer ? Array.from(new Uint8Array(value)) : Array.isArray(value) ? value : null;
      if (bytes && !bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error("Непідтримуване значення BLOB.");
      return [key, bytes ? { $blob: bytes } : value];
    })));
    return { name: String(table.name), rows: encoded };
  });
  const snapshot = { format: "library-d1-recovery", version: 1, capturedAt: new Date().toISOString(), schema, tables: data, rebuildVirtualTables: virtual, rowCount: rows };
  const json = JSON.stringify(snapshot, (_key, value) => value instanceof Uint8Array ? { $blob: Array.from(value) } : value instanceof ArrayBuffer ? { $blob: Array.from(new Uint8Array(value)) } : value);
  if (new TextEncoder().encode(json).length > MAX_RECOVERY_BYTES) throw new Error("Знімок перевищує безпечний розмір. Частковий файл не створено.");
  return { json, tables: data.length, rows };
}
