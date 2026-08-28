import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("public e-textbook route exposes only the curated HTTPS projection", async () => {
  const [route, store] = await Promise.all([
    read("app/api/textbooks/route.ts"),
    read("lib/textbook-catalog-store.ts"),
  ]);
  assert.match(route, /export async function GET/u);
  assert.doesNotMatch(route, /export async function (?:POST|PATCH|DELETE)/u);
  assert.match(route, /Access-Control-Allow-Origin/u);
  assert.match(route, /Cache-Control/u);
  assert.match(route, /no-store/u);
  assert.match(store, /FROM textbook_assignments ta/u);
  assert.match(store, /ta\.status = 'published'/u);
  assert.match(store, /trim\(m\.publication_type\) = 'Підручник'/u);
  assert.match(store, /ml\.kind = 'ebook'/u);
  assert.match(store, /ml\.is_public = 1/u);
  assert.match(store, /ml\.status = 'active'/u);
  assert.ok(store.includes("ml.url GLOB 'https://*'"));
  assert.match(store, /url\.protocol !== "https:" \|\| url\.username \|\| url\.password/u);
  const publicType = store.slice(store.indexOf("export type PublicTextbook"), store.indexOf("export type ManagedTextbook"));
  assert.doesNotMatch(publicType, /materialId|notes|isbn|catalogNumber/u);
});

test("librarian textbook mutations use authorization, same-origin, bounded JSON, versions, commands, and audit", async () => {
  const [collectionRoute, itemRoute, store] = await Promise.all([
    read("app/api/librarian/textbooks/route.ts"),
    read("app/api/librarian/textbooks/[id]/route.ts"),
    read("lib/textbook-catalog-store.ts"),
  ]);
  for (const source of [collectionRoute, itemRoute]) {
    assert.match(source, /authorizeLibrarianApi/u);
    assert.match(source, /writesEnabled/u);
    assert.match(source, /isSameOriginRequest/u);
    assert.match(source, /readDraftJsonBody/u);
  }
  assert.match(itemRoute, /expectedVersion/u);
  assert.match(store, /mutation_commands/u);
  assert.match(store, /request_hash/u);
  assert.match(store, /request_id_conflict/u);
  assert.match(store, /INSERT INTO audit_events/u);
  assert.match(store, /CASE WHEN changes\(\) = 1 THEN \? ELSE NULL END/u);
  assert.match(store, /textbook_link_required/u);
  assert.match(store, /textbook_grade_mismatch/u);
});

test("student and librarian UIs provide class selection, sorting, safe external actions, and reversible hiding", async () => {
  const [publicUi, publicCss, adminUi, shell, home] = await Promise.all([
    read("app/textbooks/textbook-catalog.tsx"),
    read("app/textbooks/textbooks.module.css"),
    read("app/librarian/textbooks/textbook-management-workspace.tsx"),
    read("app/librarian/_components/librarian-shell.tsx"),
    read("app/page.tsx"),
  ]);
  for (const label of ["Оберіть клас", "Усі предмети", "Рекомендоване", "Назва А–Я", "За автором", "Спочатку новіші"]) {
    assert.match(publicUi, new RegExp(label, "u"));
  }
  assert.match(publicUi, /target="_blank" rel="noopener noreferrer"/u);
  assert.match(publicUi, /type="radio" name="grade"/u);
  assert.match(publicUi, /aria-live="polite"/u);
  assert.match(publicCss, /@media \(max-width: 720px\)/u);
  assert.match(publicCss, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/u);
  assert.match(adminUi, /Приховати/u);
  assert.match(adminUi, /Опублікувати/u);
  assert.match(adminUi, /Ручний порядок/u);
  assert.match(adminUi, /Картки фонду, примірники та історія не видаляються/u);
  assert.match(shell, /label: "Е-підручники"/u);
  assert.match(home, /href="\/textbooks"/u);
});
