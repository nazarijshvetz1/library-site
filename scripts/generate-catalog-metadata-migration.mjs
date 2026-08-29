import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const manifestPath = path.resolve(process.argv[2] || ".migration-private/catalog-metadata-merged-20260829.apply.json");
const migrationPath = path.resolve(process.argv[3] || "drizzle/0032_fearless_alex_power.sql");
const marker = "-- catalog-metadata-data-begin";
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const originalMigration = await readFile(migrationPath, "utf8");
const schemaMigration = originalMigration.split(marker, 1)[0].trimEnd();

if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.records) || !/^[0-9a-f]{64}$/u.test(manifest.mergeSha256 || "")) {
  throw new Error("The catalog metadata application manifest is invalid.");
}

const batchId = `catalog-metadata-20260829-${manifest.mergeSha256.slice(0, 12)}`;
const createdAt = safeTimestamp(manifest.generatedAt);
const fieldRows = [];
const uniqueFields = new Set();
for (const record of manifest.records) {
  if (!/^CAT-\d{4,}$/u.test(record.materialId || "") || !/^[0-9a-f]{64}$/u.test(record.fingerprint || "")) {
    throw new Error(`Invalid material manifest record ${record.materialId || "(blank)"}.`);
  }
  const expected = record.expected ?? {};
  if (!text(expected.title)) throw new Error(`Blank expected title for ${record.materialId}.`);
  for (const field of ["isbn", "publisher"]) {
    const value = text(record.set?.[field]);
    if (!value) continue;
    const audit = record.audit?.[field] ?? {};
    if (!['exact', 'probable', 'doubtful'].includes(audit.confidence)) {
      throw new Error(`Invalid ${field} confidence for ${record.materialId}.`);
    }
    if (!text(audit.sourceProvider) || !text(audit.reasonCode)) {
      throw new Error(`Missing ${field} provenance for ${record.materialId}.`);
    }
    if (field === "isbn" && !validIsbn13(value)) {
      throw new Error(`Invalid selected ISBN for ${record.materialId}.`);
    }
    const sourceUrl = safeHttps(audit.sourceUrl);
    if (text(audit.sourceUrl) && !sourceUrl) throw new Error(`Unsafe source URL for ${record.materialId} ${field}.`);
    const uniqueKey = `${record.materialId}|${field}`;
    if (uniqueFields.has(uniqueKey)) throw new Error(`Duplicate manifest field ${uniqueKey}.`);
    uniqueFields.add(uniqueKey);
    fieldRows.push({
      id: `MME-${manifest.mergeSha256.slice(0, 10)}-${record.materialId}-${field === "isbn" ? "I" : "P"}`,
      batchId,
      materialId: record.materialId,
      field,
      value,
      normalizedValue: normalizeSearchText(value),
      confidence: audit.confidence,
      sourceProvider: text(audit.sourceProvider),
      sourceUrl,
      sourceTitle: text(audit.sourceTitle),
      reasonCode: text(audit.reasonCode),
      materialFingerprint: record.fingerprint,
      expectedTitle: text(expected.title),
      expectedAuthor: text(expected.author),
      expectedPublicationYear: normalizedYear(expected.year),
      expectedIsbn: text(expected.isbn),
      expectedPublisher: text(expected.publisher),
      createdAt,
    });
  }
}

if (!fieldRows.length) throw new Error("The catalog metadata manifest contains no field updates.");

const insertColumns = [
  "id", "batch_id", "material_id", "field", "value", "normalized_value", "confidence",
  "source_provider", "source_url", "source_title", "reason_code", "material_fingerprint",
  "expected_title", "expected_author", "expected_publication_year", "expected_isbn",
  "expected_publisher", "applied", "applied_at", "created_at",
];
const insertRows = fieldRows.map((row) => ([
  row.id, row.batchId, row.materialId, row.field, row.value, row.normalizedValue,
  row.confidence, row.sourceProvider, row.sourceUrl, row.sourceTitle, row.reasonCode,
  row.materialFingerprint, row.expectedTitle, row.expectedAuthor,
].map(sqlString)).concat([
  row.expectedPublicationYear === null ? "NULL" : String(row.expectedPublicationYear),
  sqlString(row.expectedIsbn), sqlString(row.expectedPublisher), "0", "NULL", sqlString(row.createdAt),
]));
const insertStatements = chunkInsertRows(insertRows, insertColumns, 64_000);
const guard = `e.batch_id = ${sqlString(batchId)}
      AND e.material_id = m.id
      AND e.expected_title = m.title
      AND e.expected_author = m.author
      AND e.expected_publication_year IS m.publication_year
      AND e.expected_isbn = m.isbn
      AND e.expected_publisher = m.publisher`;
const applicable = `(${guard})
      AND ((e.field = 'isbn' AND trim(m.isbn) = '') OR (e.field = 'publisher' AND trim(m.publisher) = ''))`;
const valueFor = (field, column) => `(SELECT e.${column} FROM material_metadata_enrichments e
    WHERE ${guard} AND e.field = '${field}' LIMIT 1)`;

const dataSql = [
  marker,
  `-- batch ${batchId}; ${manifest.records.length} materials; ${fieldRows.length} guarded field proposals`,
  ...insertStatements,
  `UPDATE materials AS m
SET isbn = CASE WHEN trim(m.isbn) = '' THEN COALESCE(${valueFor("isbn", "value")}, m.isbn) ELSE m.isbn END,
    isbn_normalized = CASE WHEN trim(m.isbn) = '' THEN COALESCE(${valueFor("isbn", "normalized_value")}, m.isbn_normalized) ELSE m.isbn_normalized END,
    publisher = CASE WHEN trim(m.publisher) = '' THEN COALESCE(${valueFor("publisher", "value")}, m.publisher) ELSE m.publisher END,
    search_text = trim(m.search_text || ' ' || COALESCE((
      SELECT group_concat(e.normalized_value, ' ')
      FROM material_metadata_enrichments e
      WHERE ${applicable}
    ), '')),
    version = m.version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE m.status = 'active'
  AND m.archived_at IS NULL
  AND EXISTS (SELECT 1 FROM material_metadata_enrichments e WHERE ${applicable});`,
  `UPDATE material_metadata_enrichments AS e
SET applied = 1,
    applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE e.batch_id = ${sqlString(batchId)}
  AND EXISTS (
    SELECT 1 FROM materials m
    WHERE m.id = e.material_id
      AND m.status = 'active'
      AND m.archived_at IS NULL
      AND m.title = e.expected_title
      AND m.author = e.expected_author
      AND m.publication_year IS e.expected_publication_year
      AND ((e.field = 'isbn' AND m.isbn = e.value) OR (e.field = 'publisher' AND m.publisher = e.value))
  );`,
  "INSERT INTO materials_fts(materials_fts) VALUES('rebuild');",
  "INSERT INTO materials_fts(materials_fts, rank) VALUES('integrity-check', 1);",
  "PRAGMA optimize;",
].map((statement) => statement.startsWith("--") ? statement : `${statement}\n--> statement-breakpoint`);

const output = `${schemaMigration}\n--> statement-breakpoint\n${dataSql.join("\n")}\n`;
for (const [index, statement] of output.split("--> statement-breakpoint").entries()) {
  const bytes = Buffer.byteLength(statement, "utf8");
  if (bytes > 70_000) throw new Error(`Migration statement ${index + 1} is too large: ${bytes} bytes.`);
}
await writeFile(migrationPath, output, "utf8");
console.log(JSON.stringify({ migrationPath, batchId, materials: manifest.records.length, fields: fieldRows.length, insertStatements: insertStatements.length }, null, 2));

function chunkInsertRows(rows, columns, byteLimit) {
  const prefix = `INSERT INTO material_metadata_enrichments (${columns.join(",")})\n`;
  const statements = [];
  let current = [];
  const render = (values) => `${prefix}SELECT ${columns.join(",")} FROM (\n${values.map((row, rowIndex) =>
    `SELECT ${row.map((value, columnIndex) => rowIndex === 0 ? `${value} AS ${columns[columnIndex]}` : value).join(",")}`
  ).join("\nUNION ALL\n")}\n) AS staged\nWHERE EXISTS (SELECT 1 FROM materials m WHERE m.id = staged.material_id);`;
  for (const row of rows) {
    const candidate = render([...current, row]);
    if (current.length && Buffer.byteLength(candidate, "utf8") > byteLimit) {
      statements.push(render(current));
      current = [row];
    } else {
      current.push(row);
    }
  }
  if (current.length) statements.push(render(current));
  return statements;
}

function normalizeSearchText(value) {
  return text(value).normalize("NFKC").toLocaleLowerCase("uk-UA")
    .replace(/[’`]/gu, "'")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .trim();
}

function normalizedYear(value) {
  const year = Number(value);
  return Number.isInteger(year) && year >= 1000 && year <= 3000 ? year : null;
}

function validIsbn13(value) {
  const isbn = text(value).replace(/[^\d]/gu, "");
  if (!/^(?:978|979)\d{10}$/u.test(isbn)) return false;
  const sum = [...isbn.slice(0, 12)].reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return (10 - sum % 10) % 10 === Number(isbn[12]);
}

function safeTimestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid manifest timestamp.");
  return date.toISOString();
}

function safeHttps(value) {
  if (!text(value)) return "";
  try {
    const url = new URL(text(value));
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : "";
  } catch {
    return "";
  }
}

function sqlString(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
