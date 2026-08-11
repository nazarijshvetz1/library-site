import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildCatalogSearchUrl,
  editDraftToChanges,
  gradeLabel,
  holdingKey,
  materialToEditDraft,
  todayInKyiv,
} from "../lib/librarian-d1-client.ts";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("catalog search URL uses bounded D1 query filters and cursor", () => {
  const url = new URL(buildCatalogSearchUrl({
    q: "  математика  ",
    rubric: "Підручники",
    grade: "5",
    subject: "Алгебра",
    publicationType: "Підручник",
    available: true,
  }, "next-page"), "https://library.test");

  assert.equal(url.pathname, "/api/librarian/materials/search");
  assert.equal(url.searchParams.get("q"), "математика");
  assert.equal(url.searchParams.get("rubric"), "Підручники");
  assert.equal(url.searchParams.get("grade"), "5");
  assert.equal(url.searchParams.get("subject"), "Алгебра");
  assert.equal(url.searchParams.get("type"), "Підручник");
  assert.equal(url.searchParams.get("available"), "true");
  assert.equal(url.searchParams.get("sort"), "title");
  assert.equal(url.searchParams.get("limit"), "20");
  assert.equal(url.searchParams.get("cursor"), "next-page");
});

test("material edit conversion preserves nullable fields for PATCH", () => {
  const draft = materialToEditDraft({
    title: "Математика",
    rubric: "Підручники",
    publicationType: "",
    subject: "Математика",
    classFrom: 5,
    classTo: 6,
    author: "Автор",
    year: 2024,
    isbn: "",
    publisher: "Видавництво",
    notes: undefined,
  });
  draft.classTo = "";
  draft.author = "  Авторка  ";

  assert.deepEqual(editDraftToChanges(draft), {
    title: "Математика",
    rubric: "Підручники",
    publicationType: null,
    subject: "Математика",
    classFrom: 5,
    classTo: null,
    author: "Авторка",
    publicationYear: 2024,
    isbn: null,
    publisher: "Видавництво",
    notes: null,
  });
});

test("workspace helpers keep holding identity and Ukrainian labels stable", () => {
  assert.equal(holdingKey({ locationId: "LOC-001", condition: "good" }), "LOC-001\u001fgood");
  assert.equal(gradeLabel(5, 5), "5 клас");
  assert.equal(gradeLabel(5, 7), "5–7 класи");
  assert.equal(gradeLabel(null, null), "Клас не вказано");
  assert.equal(todayInKyiv(new Date("2026-08-10T22:30:00.000Z")), "2026-08-11");
});

test("new librarian route renders D1 workspace and keeps legacy workspace intact", async () => {
  const [page, workspace, client] = await Promise.all([
    read("app/librarian/page.tsx"),
    read("app/librarian/d1-workspace.tsx"),
    read("lib/librarian-d1-client.ts"),
  ]);

  assert.match(page, /import D1LibrarianWorkspace from "\.\/d1-workspace"/u);
  assert.match(page, /<D1LibrarianWorkspace/u);
  assert.match(client, /\/api\/librarian\/materials\/search/u);
  assert.match(workspace, /method: "PATCH"/u);
  assert.match(workspace, /\/api\/librarian\/stock-adjustments/u);
  assert.match(workspace, /\/api\/librarian\/library-reference/u);
  assert.match(workspace, /"\/api\/librarian\/loans"/u);
  assert.match(workspace, /\/api\/librarian\/loans\/returns/u);
  assert.match(workspace, /"\/api\/librarian\/materials"/u);
  assert.match(workspace, /\/api\/librarian\/receipts/u);
  assert.match(workspace, /initialReceipt/u);
  assert.match(workspace, /expectedQuantity: 0/u);
  assert.match(workspace, /links: linkPayload\(links\)/u);
  assert.match(workspace, /Новий матеріал/u);
  assert.match(workspace, /Надходження/u);
  assert.match(workspace, /teacher\.fullName/u);
  assert.match(workspace, /source\.quantity/u);
  assert.match(workspace, /quantityOutstanding/u);
  assert.match(workspace, /thumbnailUrl/u);
  assert.match(workspace, /item\.year/u);
  assert.doesNotMatch(workspace, /Ревізія/u);

  const legacy = await read("app/librarian/workspace.tsx");
  assert.match(legacy, /revision\.count/u);
});
