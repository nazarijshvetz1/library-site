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
  assert.match(store, /FROM manual_textbooks/u);
  assert.match(store, /manual_textbooks[\s\S]*?status = 'published'/u);
  assert.match(store, /ta\.status = 'published'/u);
  assert.doesNotMatch(store, /WHERE[\s\S]*?ta\.status = 'published'[\s\S]*?trim\(m\.publication_type\) = 'Підручник'/u);
  assert.match(store, /ml\.kind = 'ebook'/u);
  assert.match(store, /ml\.is_public = 1/u);
  assert.match(store, /ml\.status = 'active'/u);
  assert.ok(store.includes("ml.url GLOB 'https://*'"));
  assert.match(store, /url\.protocol !== "https:" \|\| url\.username \|\| url\.password/u);
  const publicType = store.slice(store.indexOf("export type PublicTextbook"), store.indexOf("export type ManagedTextbook"));
  assert.doesNotMatch(publicType, /materialId|notes|isbn|catalogNumber/u);
});

test("librarian textbook mutations use authorization, same-origin, bounded JSON, versions, commands, and audit", async () => {
  const [collectionRoute, itemRoute, linkRoute, store, validation, migration] = await Promise.all([
    read("app/api/librarian/textbooks/route.ts"),
    read("app/api/librarian/textbooks/[id]/route.ts"),
    read("app/api/librarian/materials/[id]/ebook-links/route.ts"),
    read("lib/textbook-catalog-store.ts"),
    read("lib/textbook-manual-validation.ts"),
    read("drizzle/0033_burly_human_fly.sql"),
  ]);
  for (const source of [collectionRoute, itemRoute, linkRoute]) {
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
  assert.match(store, /requireResource: input\.publish/u);
  assert.match(store, /input\.action === "restore"[\s\S]*?status = "draft"/u);
  assert.match(store, /Every active[\s\S]*fund card may therefore be assigned to a grade/u);
  assert.match(store, /publicationType: boundedText\(row\.publication_type/u);
  assert.match(linkRoute, /validateMaterialEbookLinkCreateInput/u);
  assert.match(linkRoute, /appendMaterialEbookLinkDirect/u);
  assert.match(store, /AS active_resource_count/u);
  assert.match(store, /filter\(\(candidate\) => candidate\.materialId\)/u);
  assert.match(collectionRoute, /createManualTextbook/u);
  assert.match(itemRoute, /action !== "edit"[\s\S]*?action !== "delete"/u);
  assert.match(itemRoute, /validateManualTextbookFields/u);
  assert.match(validation, /validIsbn/u);
  assert.match(validation, /url\.protocol === "https:"/u);
  assert.match(store, /status != 'deleted'/u);
  assert.match(store, /textbook\.manual\.created/u);
  assert.match(migration, /CREATE TABLE `manual_textbooks`/u);
  assert.match(migration, /FOREIGN KEY \(`academic_year_id`\)/u);
});

test("librarian fund candidate search matches every token and keeps existing assignments actionable", async () => {
  const [store, adminUi] = await Promise.all([
    read("lib/textbook-catalog-store.ts"),
    read("app/librarian/textbooks/textbook-management-workspace.tsx"),
  ]);
  const candidateSearchStart = store.indexOf("async function listCandidates(");
  const candidateSearchEnd = store.indexOf("async function requireManagedTextbook(", candidateSearchStart);
  assert.ok(candidateSearchStart >= 0 && candidateSearchEnd > candidateSearchStart);
  const candidateSearch = store.slice(candidateSearchStart, candidateSearchEnd);
  assert.match(candidateSearch, /const tokens = normalized\.split\(" "\)\.filter\(Boolean\)\.slice\(0, 12\)/u);
  assert.ok(candidateSearch.includes('(instr(lower(m.search_text), ?) > 0 OR instr(lower(m.id), ?) > 0)'));
  assert.ok(candidateSearch.includes('.join(" AND ")'));
  assert.match(candidateSearch, /const tokenBindings = tokens\.flatMap\(\(token\) => \[token, token\]\)/u);
  assert.match(candidateSearch, /\.bind\(\.\.\.tokenBindings, grade\)/u);
  assert.doesNotMatch(candidateSearch, /LIMIT 1000/u);
  assert.doesNotMatch(candidateSearch, /NOT EXISTS/u);
  assert.doesNotMatch(candidateSearch, /FROM textbook_assignments/u);

  const searchable = "cat 0610 історія україни 9 клас власов в";
  const tokens = "історія україни власов".split(" ");
  assert.equal(tokens.every((token) => searchable.includes(token)), true);
  assert.equal(searchable.includes(tokens.join(" ")), false);

  const candidateUiStart = adminUi.indexOf("candidates.map((candidate) => {");
  const candidateUiEnd = adminUi.indexOf("</aside>", candidateUiStart);
  assert.ok(candidateUiStart >= 0 && candidateUiEnd > candidateUiStart);
  const candidateUi = adminUi.slice(candidateUiStart, candidateUiEnd);
  assert.match(candidateUi, /const existingItem = items\.find\(\(item\) => item\.source === "fund" && item\.materialId === candidate\.materialId\)/u);
  assert.match(candidateUi, /existingItem\?\.status === "archived"[\s\S]*?changeItem\(existingItem, "restore"\)[\s\S]*?Повернути до списку/u);
  assert.match(candidateUi, /existingItem && existingItem\.status !== "archived"[\s\S]*?setSelectedItemId\(existingItem\.id\)[\s\S]*?Відкрити картку/u);
  assert.match(candidateUi, /!existingItem && candidate\.resourceUrl/u);
  assert.match(candidateUi, /!existingItem && !candidate\.resourceUrl/u);
  assert.match(adminUi, /Матеріалів фонду з таким запитом не знайдено/u);
  assert.doesNotMatch(adminUi, /Вільних карток фонду з таким запитом не знайдено/u);
});

test("student and librarian UIs provide class selection, sorting, safe external actions, and reversible hiding", async () => {
  const [publicUi, publicCss, adminUi, shell, home, telegramCabinet, telegramLaunch] = await Promise.all([
    read("app/textbooks/textbook-catalog.tsx"),
    read("app/textbooks/textbooks.module.css"),
    read("app/librarian/textbooks/textbook-management-workspace.tsx"),
    read("app/librarian/_components/librarian-shell.tsx"),
    read("app/page.tsx"),
    read("app/librarian/telegram/cabinet/page.tsx"),
    read("app/librarian/telegram/page.tsx"),
  ]);
  for (const label of ["Оберіть клас", "Усі предмети", "Рекомендоване", "Назва А–Я", "За автором", "Спочатку новіші"]) {
    assert.match(publicUi, new RegExp(label, "u"));
  }
  assert.match(publicUi, /target="_blank" rel="noopener noreferrer"/u);
  assert.match(publicUi, /Відкрити електронну версію/u);
  assert.match(publicUi, /Перевірені зовнішні джерела/u);
  assert.match(publicUi, /type="radio" name="grade"/u);
  assert.match(publicUi, /Повернутися в каталог/u);
  assert.match(publicUi, /До кабінету вчителя/u);
  assert.match(publicUi, /aria-live="polite"/u);
  assert.match(publicUi, /referrerPolicy="no-referrer"/u);
  assert.match(publicUi, /onError=\{\(\) => setCoverFailed\(true\)\}/u);
  assert.match(publicUi, /<strong>Єдина бібліотека<\/strong><small>Міжнародний ліцей МАУП<\/small>/u);
  assert.match(publicCss, /@media \(max-width: 720px\)/u);
  assert.match(publicCss, /\.brand small \{ display: block; font-size: 9px; \}/u);
  assert.doesNotMatch(publicCss, /\.brand small \{ display: none; \}/u);
  assert.match(publicCss, /@media \(max-width: 390px\)[\s\S]*\.brand img \{ width: 34px; height: 34px; flex: 0 0 34px; \}/u);
  assert.match(publicCss, /@media \(max-width: 390px\)[\s\S]*\.navCurrent \{ min-height: 34px !important;[\s\S]*white-space: nowrap; \}/u);
  assert.match(publicCss, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/u);
  assert.match(adminUi, /Вилучити зі списку/u);
  assert.match(adminUi, /Повернути до списку/u);
  assert.match(adminUi, /Опублікувати/u);
  assert.match(adminUi, /У списку/u);
  assert.match(adminUi, /Чернетки/u);
  assert.match(adminUi, /Ручний порядок/u);
  assert.match(adminUi, /не впливатиме на фізичний фонд, залишки, видачі чи звіти/u);
  assert.match(adminUi, /Керувати в картці/u);
  assert.match(adminUi, /function ManagedTextbookModal/u);
  assert.match(adminUi, /Місце у «Рекомендованому»/u);
  assert.match(adminUi, /Додати покликання/u);
  assert.match(adminUi, /Додати до списку/u);
  assert.match(adminUi, /Зберегти й опублікувати/u);
  assert.match(adminUi, /Пошук охоплює весь активний фонд/u);
  assert.match(adminUi, /Додати е-підручник вручну/u);
  assert.match(adminUi, /Зберегти чернетку/u);
  assert.match(adminUi, /Зберегти й опублікувати/u);
  assert.match(adminUi, /HTTPS-покликання на обкладинку/u);
  assert.match(adminUi, /Видалити ручний запис/u);
  assert.match(adminUi, /if \(!item\.materialId \|\| item\.materialVersion === null\)/u);
  assert.doesNotMatch(adminUi, /encodeURIComponent\(item\.materialId\)/u);
  assert.match(adminUi, /const loadRequestRef = useRef\(0\)/u);
  assert.match(adminUi, /requestId !== loadRequestRef\.current/u);
  assert.match(adminUi, /setItems\(\[\]\)/u);
  assert.match(adminUi, /responseBody/u);
  assert.match(adminUi, /Сервіс е-підручників тимчасово недоступний/u);
  assert.match(adminUi, /telegramMiniApp=\{telegramMiniApp\}/u);
  assert.match(shell, /label: "Е-підручники"/u);
  assert.match(shell, /label: "Підручники й посібники"[\s\S]*?label: "Художня та наукова література"[\s\S]*?label: "Новий матеріал"[\s\S]*?label: "Е-підручники"/u);
  assert.match(telegramCabinet, /target === "textbooks"[\s\S]*?<TextbookManagementWorkspace[\s\S]*?telegramMiniApp/u);
  assert.match(telegramLaunch, /value === "textbooks"/u);
  assert.match(home, /href="\/textbooks"/u);
});
