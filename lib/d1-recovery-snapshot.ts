type RecoveryResult = { results?: Record<string, unknown>[]; success?: boolean };
type RecoveryStatement = { all(): Promise<RecoveryResult> };
export type RecoveryDatabase = { prepare(sql: string): RecoveryStatement; batch(statements: RecoveryStatement[]): Promise<RecoveryResult[]> };
const SCHEMA_QUERY = "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND (name NOT GLOB 'sqlite_*' OR name = 'sqlite_sequence') AND name NOT GLOB '_cf_*' ORDER BY type, name";
const COLUMNS_QUERY = "SELECT s.name AS table_name, p.name AS column_name FROM sqlite_schema AS s JOIN pragma_table_xinfo(s.name) AS p WHERE s.type = 'table' AND (s.name NOT GLOB 'sqlite_*' OR s.name = 'sqlite_sequence') AND s.name NOT GLOB '_cf_*' ORDER BY s.name, p.cid";
export const MAX_RECOVERY_ROWS = 100000;
export const MAX_RECOVERY_BYTES = 32 * 1024 * 1024;
const MAX_TABLE_SELECTS_PER_QUERY = 5;

export function quoteRecoveryIdentifier(value: string) {
  const hasControlCharacter = Array.from(value).some((character) => character.charCodeAt(0) <= 0x1f);
  if (!value || value.length > 160 || hasControlCharacter) throw new Error("Некоректна назва таблиці.");
  return '"' + value.replaceAll('"', '""') + '"';
}

/** Read-only, one atomic batch. Only actual schema identifiers can select tables. */
export async function createD1RecoverySnapshot(db: RecoveryDatabase) {
  const initial = await db.prepare(SCHEMA_QUERY).all();
  if (initial.success === false || !Array.isArray(initial.results)) throw new Error("Не вдалося прочитати схему.");
  const schema = initial.results;
  // Fail closed instead of silently losing non-rebuildable virtual data.
  for (const row of schema.filter((item) => /^CREATE VIRTUAL TABLE/i.test(String(item.sql)))) {
    const content = /\bcontent\s*=\s*'([^']+)'/i.exec(String(row.sql));
    if (!/\bUSING\s+fts5\s*\(/i.test(String(row.sql)) || !content || !schema.some((item) => item.type === "table" && item.name === content[1])) throw new Error("Непідтримувана віртуальна таблиця для повного відновлення.");
  }
  const virtual = schema.filter((row) => row.type === "table" && /^CREATE VIRTUAL TABLE/i.test(String(row.sql))).map((row) => String(row.name));
  const shadowSuffixes = ["_data", "_idx", "_content", "_docsize", "_config"];
  const tables = schema.filter((row) => row.type === "table" && !virtual.includes(String(row.name)) && !virtual.some((name) => shadowSuffixes.some((suffix) => row.name === name + suffix)));
  if (!tables.length || tables.length > 150) throw new Error("Непідтримувана кількість таблиць для резервного експорту.");
  const columns = await db.prepare(COLUMNS_QUERY).all();
  if (columns.success === false || !Array.isArray(columns.results)) throw new Error("Не вдалося прочитати структуру таблиць.");
  const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  // One union query, not one query per table: stays below D1's per-request budget.
  const selects = tables.map((table) => {
    const names = columns.results!.filter((column) => column.table_name === table.name).map((column) => String(column.column_name));
    if (!names.length || names.length > 60) throw new Error("Непідтримувана структура резервної таблиці.");
    const fields = names.map((name) => {
      const id = quoteRecoveryIdentifier(name);
      return `${literal(name)}, CASE WHEN typeof(${id}) = 'blob' THEN json_object('$blobHex', hex(${id})) ELSE ${id} END`;
    });
    // D1 allows 32 function arguments: each object gets at most 16 key/value pairs.
    const objects: string[] = [];
    for (let index = 0; index < fields.length; index += 16) objects.push(`json_object(${fields.slice(index, index + 16).join(", ")})`);
    return `SELECT ${literal(String(table.name))} AS table_name, json_array(${objects.join(", ")}) AS row_json FROM ${quoteRecoveryIdentifier(String(table.name))}`;
  });
  const readQueries: string[] = [];
  let pending: string[] = [];
  for (const select of selects) {
    if (pending.length >= MAX_TABLE_SELECTS_PER_QUERY || (new TextEncoder().encode([...pending, select].join(" UNION ALL ")).length > 75000 && pending.length)) {
      readQueries.push(pending.join(" UNION ALL ") + ` LIMIT ${MAX_RECOVERY_ROWS + 1}`); pending = [];
    }
    pending.push(select);
  }
  if (pending.length) readQueries.push(pending.join(" UNION ALL ") + ` LIMIT ${MAX_RECOVERY_ROWS + 1}`);
  if (readQueries.length > 32) throw new Error("Запит резервного експорту перевищує безпечний розмір.");
  const result = await db.batch([db.prepare(SCHEMA_QUERY), ...readQueries.map(sql => db.prepare(sql)), db.prepare(SCHEMA_QUERY)]);
  if (result.length !== readQueries.length + 2 || result.some((item) => item.success === false || !Array.isArray(item.results))) throw new Error("Неповний резервний експорт.");
  if (JSON.stringify(result[0].results) !== JSON.stringify(schema) || JSON.stringify(result.at(-1)!.results) !== JSON.stringify(schema)) throw new Error("Схема змінилася під час резервного експорту. Повторіть знімок.");
  const exportedRows = result.slice(1, -1).flatMap(item => item.results!);
  const rows = exportedRows.length;
  if (rows > MAX_RECOVERY_ROWS) throw new Error("Знімок перевищує безпечний обсяг. Частковий файл не створено.");
  const byTable = new Map(tables.map((table) => [String(table.name), [] as Record<string, unknown>[]]));
  for (const row of exportedRows) {
    const target = byTable.get(String(row.table_name));
    if (!target || typeof row.row_json !== "string") throw new Error("Некоректний рядок резервного експорту.");
    const objects = JSON.parse(row.row_json);
    if (!Array.isArray(objects)) throw new Error("Некоректна структура резервного рядка.");
    target.push(Object.assign({}, ...objects));
  }
  const data = Array.from(byTable, ([name, values]) => ({ name, rows: values }));
  const snapshot = { format: "library-d1-recovery", version: 1, capturedAt: new Date().toISOString(), schema, tables: data, rebuildVirtualTables: virtual, rowCount: rows };
  const json = JSON.stringify(snapshot, (_key, value) => value instanceof Uint8Array ? { $blob: Array.from(value) } : value instanceof ArrayBuffer ? { $blob: Array.from(new Uint8Array(value)) } : value);
  if (new TextEncoder().encode(json).length > MAX_RECOVERY_BYTES) throw new Error("Знімок перевищує безпечний розмір. Частковий файл не створено.");
  return { json, tables: data.length, rows };
}
