import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  CatalogQueryValidationError,
  getCatalogCoverAsset,
  getCatalogMaterialDetail,
  listCatalogMaterials,
  normalizeCatalogSearchText,
  parseCatalogListQuery,
} from "../lib/catalog-d1.ts";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

class MockD1Statement {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new MockD1Statement(this.database, this.sql, bindings);
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.bindings) };
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.bindings) ?? null;
  }
}

class MockD1Database {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new MockD1Statement(this.database, sql);
  }

  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.all()));
  }
}

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE materials (
      id TEXT PRIMARY KEY,
      catalog_number INTEGER NOT NULL UNIQUE,
      title TEXT NOT NULL,
      sort_title TEXT NOT NULL,
      search_text TEXT NOT NULL,
      rubric TEXT NOT NULL,
      publication_type TEXT NOT NULL,
      subject TEXT NOT NULL,
      class_from INTEGER,
      class_to INTEGER,
      author TEXT NOT NULL,
      publication_year INTEGER,
      isbn TEXT NOT NULL,
      isbn_normalized TEXT NOT NULL,
      publisher TEXT NOT NULL,
      notes TEXT NOT NULL,
      status TEXT NOT NULL,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );
    CREATE TABLE material_cover_assets (
      id TEXT PRIMARY KEY,
      material_id TEXT NOT NULL UNIQUE,
      storage_provider TEXT NOT NULL,
      storage_key TEXT,
      external_url TEXT,
      mime_type TEXT,
      width INTEGER,
      height INTEGER,
      sha256 TEXT,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE material_links (
      id TEXT PRIMARY KEY,
      material_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      url TEXT NOT NULL,
      is_public INTEGER NOT NULL,
      sort_order INTEGER NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE locations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      is_public INTEGER NOT NULL,
      sort_order INTEGER NOT NULL
    );
    CREATE TABLE holdings (
      material_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      condition TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE material_stock_totals (
      material_id TEXT PRIMARY KEY,
      total_quantity INTEGER NOT NULL,
      library_quantity INTEGER NOT NULL,
      other_location_quantity INTEGER NOT NULL,
      loaned_quantity INTEGER NOT NULL
    );
    CREATE INDEX idx_materials_status_sort ON materials(status, sort_title, id);
    CREATE INDEX idx_holdings_material ON holdings(material_id);
    CREATE VIRTUAL TABLE materials_fts USING fts5(
      title, author, isbn_normalized, publisher, rubric, subject,
      publication_type, search_text,
      content='materials', content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER materials_fts_after_insert AFTER INSERT ON materials BEGIN
      INSERT INTO materials_fts(
        rowid, title, author, isbn_normalized, publisher, rubric,
        subject, publication_type, search_text
      ) VALUES (
        new.rowid, new.title, new.author, new.isbn_normalized, new.publisher,
        new.rubric, new.subject, new.publication_type, new.search_text
      );
    END;
  `);

  const insertMaterial = sqlite.prepare(`
    INSERT INTO materials (
      id, catalog_number, title, sort_title, search_text, rubric,
      publication_type, subject, class_from, class_to, author,
      publication_year, isbn, isbn_normalized, publisher, notes,
      status, version, created_at, updated_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `);
  const time = "2026-08-11T10:00:00.000Z";
  const rows = [
    [
      "CAT-0001", 1, "Математика. 1 клас", "математика 1 клас",
      normalizeCatalogSearchText("CAT-0001 Математика 1 клас Петренко 9786170000001"),
      "Підручники", "Підручник", "Математика", 1, 1, "О. Петренко",
      2023, "9786170000001", "9786170000001", "Освіта", "Службова примітка",
      "active", time, time, null,
    ],
    [
      "CAT-0002", 2, "Атлас з історії", "атлас з історії",
      normalizeCatalogSearchText("CAT-0002 Атлас з історії 9786170000002"),
      "Зошити", "Атлас", "Історія", 5, 5, "",
      2020, "9786170000002", "9786170000002", "Картографія", "",
      "active", time, time, null,
    ],
    [
      "CAT-0010", 10, "Фізика. Збірник", "фізика збірник",
      normalizeCatalogSearchText("CAT-0010 Фізика збірник"),
      "Збірники", "Збірник", "Фізика", 10, 11, "І. Автор",
      2024, "", "", "Ліцей", "",
      "active", time, time, null,
    ],
    [
      "CAT-0003", 3, "Архівна книга", "архівна книга",
      normalizeCatalogSearchText("CAT-0003 Архівна книга"),
      "Інше", "Книга", "", null, null, "",
      1999, "", "", "", "",
      "archived", time, time, time,
    ],
  ];
  for (const row of rows) insertMaterial.run(...row);

  sqlite.prepare(`
    INSERT INTO material_cover_assets
      (id, material_id, storage_provider, storage_key, external_url, mime_type,
       width, height, sha256, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)
  `).run(
    "cover-1", "CAT-0001", "r2", "covers/CAT-0001.jpg", null,
    "image/jpeg", 600, 900, "a".repeat(64), time,
  );
  sqlite.prepare(`
    INSERT INTO material_cover_assets
      (id, material_id, storage_provider, storage_key, external_url, mime_type,
       width, height, sha256, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)
  `).run(
    "cover-2", "CAT-0002", "external", null,
    "https://raw.githubusercontent.com/example/covers/CAT-0002.jpg",
    "image/jpeg", 600, 900, "b".repeat(64), time,
  );

  const insertTotals = sqlite.prepare(`
    INSERT INTO material_stock_totals
      (material_id, total_quantity, library_quantity, other_location_quantity, loaned_quantity)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertTotals.run("CAT-0001", 8, 3, 3, 2);
  insertTotals.run("CAT-0002", 0, 0, 0, 0);
  insertTotals.run("CAT-0010", 2, 0, 0, 2);

  sqlite.exec(`
    INSERT INTO locations VALUES ('LOC-001', 'Бібліотека', 'library', 'active', 1, 1);
    INSERT INTO locations VALUES ('LOC-007', 'Службове місце', 'service', 'active', 0, 99);
    INSERT INTO holdings VALUES ('CAT-0001', 'LOC-001', 'good', 2, '${time}');
    INSERT INTO holdings VALUES ('CAT-0001', 'LOC-001', 'worn', 1, '${time}');
    INSERT INTO holdings VALUES ('CAT-0001', 'LOC-007', 'good', 3, '${time}');
    INSERT INTO material_links VALUES (
      'link-1', 'CAT-0001', 'ebook', 'Електронна книга',
      'https://example.com/book', 1, 1, 'active'
    );
    INSERT INTO material_links VALUES (
      'link-2', 'CAT-0001', 'details', 'Службове джерело',
      'https://internal.example.com/record', 0, 2, 'active'
    );
  `);
  return { sqlite, db: new MockD1Database(sqlite) };
}

test("catalog list applies bounded filters and returns year, stock and thumbnail", async () => {
  const { sqlite, db } = fixture();
  try {
    const query = parseCatalogListQuery(
      "https://catalog.test/api/catalog-v2?q=математика&rubric=Підручники&grade=1&subject=Математика&type=Підручник&available=true&limit=200",
    );
    assert.equal(query.limit, 48);
    const result = await listCatalogMaterials(db, query);
    assert.equal(result.items.length, 1);
    assert.deepEqual(result.items[0], {
      id: "CAT-0001",
      title: "Математика. 1 клас",
      author: "О. Петренко",
      year: 2023,
      isbn: "9786170000001",
      rubric: "Підручники",
      subject: "Математика",
      publicationType: "Підручник",
      classFrom: 1,
      classTo: 1,
      publisher: "Освіта",
      thumbnailUrl: "/api/catalog-v2/covers/CAT-0001?v=aaaaaaaaaaaa",
      totalQuantity: 8,
      availableQuantity: 6,
      libraryQuantity: 3,
      otherLocationQuantity: 3,
      loanedQuantity: 2,
    });
  } finally {
    sqlite.close();
  }
});

test("cursor pagination is stable, scoped to filters and supports newest sorting", async () => {
  const { sqlite, db } = fixture();
  try {
    const firstQuery = parseCatalogListQuery(
      "https://catalog.test/api/catalog-v2?limit=1&sort=title",
    );
    const first = await listCatalogMaterials(db, firstQuery);
    assert.equal(first.items[0].id, "CAT-0002");
    assert.equal(first.hasMore, true);
    assert.ok(first.nextCursor);

    const secondQuery = parseCatalogListQuery(
      `https://catalog.test/api/catalog-v2?limit=1&sort=title&cursor=${first.nextCursor}`,
    );
    const second = await listCatalogMaterials(db, secondQuery);
    assert.equal(second.items[0].id, "CAT-0001");
    assert.notEqual(second.items[0].id, first.items[0].id);

    assert.throws(
      () => parseCatalogListQuery(
        `https://catalog.test/api/catalog-v2?limit=1&sort=title&rubric=Інше&cursor=${first.nextCursor}`,
      ),
      CatalogQueryValidationError,
    );

    const newest = await listCatalogMaterials(
      db,
      parseCatalogListQuery("https://catalog.test/api/catalog-v2?sort=newest"),
    );
    assert.deepEqual(newest.items.map((item) => item.id), [
      "CAT-0010",
      "CAT-0002",
      "CAT-0001",
    ]);
  } finally {
    sqlite.close();
  }
});

test("exact ISBN search and available filter use indexed canonical fields", async () => {
  const { sqlite, db } = fixture();
  try {
    const isbn = await listCatalogMaterials(
      db,
      parseCatalogListQuery("https://catalog.test/api/catalog-v2?q=978-617-000-000-2"),
    );
    assert.deepEqual(isbn.items.map((item) => item.id), ["CAT-0002"]);

    const available = await listCatalogMaterials(
      db,
      parseCatalogListQuery("https://catalog.test/api/catalog-v2?available=1&sort=newest"),
    );
    assert.deepEqual(available.items.map((item) => item.id), ["CAT-0001"]);
  } finally {
    sqlite.close();
  }
});

test("text search falls back safely while the FTS migration is unavailable", async () => {
  const { sqlite, db } = fixture();
  try {
    sqlite.exec("DROP TABLE materials_fts");
    const result = await listCatalogMaterials(
      db,
      parseCatalogListQuery("https://catalog.test/api/catalog-v2?q=математика"),
    );
    assert.deepEqual(result.items.map((item) => item.id), ["CAT-0001"]);
  } finally {
    sqlite.close();
  }
});

test("public detail excludes notes, private links and service holdings", async () => {
  const { sqlite, db } = fixture();
  try {
    const material = await getCatalogMaterialDetail(db, "CAT-0001", "public");
    assert.ok(material);
    assert.equal("notes" in material, false);
    assert.deepEqual(material.links, [{
      kind: "ebook",
      label: "Електронна книга",
      url: "https://example.com/book",
    }]);
    assert.equal(material.holdings.length, 1);
    assert.equal(material.holdings[0].locationId, "LOC-001");
    assert.equal(material.holdings[0].quantity, 3);
    assert.equal(material.holdings[0].condition, null);
  } finally {
    sqlite.close();
  }
});

test("librarian detail exposes notes, all links and condition-level holdings", async () => {
  const { sqlite, db } = fixture();
  try {
    const material = await getCatalogMaterialDetail(db, "CAT-0001", "librarian");
    assert.ok(material);
    assert.equal(material.notes, "Службова примітка");
    assert.equal(material.links.length, 2);
    assert.equal(material.holdings.length, 3);
    assert.deepEqual(
      material.holdings.map((holding) => [holding.locationId, holding.condition, holding.quantity]),
      [
        ["LOC-001", "good", 2],
        ["LOC-001", "worn", 1],
        ["LOC-007", "good", 3],
      ],
    );
  } finally {
    sqlite.close();
  }
});

test("cover asset lookup returns only safe ready R2 metadata", async () => {
  const { sqlite, db } = fixture();
  try {
    assert.deepEqual(await getCatalogCoverAsset(db, "CAT-0001"), {
      storageProvider: "r2",
      storageKey: "covers/CAT-0001.jpg",
      externalUrl: "",
      mimeType: "image/jpeg",
      sha256: "a".repeat(64),
    });
    assert.equal(await getCatalogCoverAsset(db, "../CAT-0001"), null);
  } finally {
    sqlite.close();
  }
});

test("public routes are cacheable and librarian material routes require authorization", async () => {
  const [publicList, publicDetail, cover, privateSearch, privateDetail] = await Promise.all([
    read("app/api/catalog-v2/route.ts"),
    read("app/api/catalog-v2/[id]/route.ts"),
    read("app/api/catalog-v2/covers/[id]/route.ts"),
    read("app/api/librarian/materials/search/route.ts"),
    read("app/api/librarian/materials/[id]/route.ts"),
  ]);
  assert.match(publicList, /stale-while-revalidate=300/);
  assert.match(publicDetail, /getCatalogMaterialDetail\([\s\S]*"public"/);
  assert.match(cover, /COVER_UPLOADS\.get\(asset\.storageKey\)/);
  assert.match(cover, /max-age=31536000, immutable/);
  assert.match(privateSearch, /authorizeLibrarianApi\(\)/);
  assert.match(privateDetail, /authorizeLibrarianApi\(\)/);
  assert.match(privateDetail, /getCatalogMaterialDetail\([\s\S]*"librarian"/);
});
