import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker from "../dist-catalog/server/index.js";
import {
  materialIdFromUrl,
  materialIssueText,
  materialShareText,
  newestMaterialsByCatalogId,
  urlWithMaterial,
  urlWithoutMaterial,
} from "../source/app.js";

test("serves the Ukrainian catalog homepage", async () => {
  const response = await worker.fetch(new Request("https://example.test/"));
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Єдина бібліотека ліцею/);
  assert.match(html, /Навчальні матеріали/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("serves catalog data and rejects unknown paths", async () => {
  const dataResponse = await worker.fetch(new Request("https://example.test/catalog-data.js"));
  const data = await dataResponse.text();
  assert.match(data, /CAT-\d{4}/);
  const missing = await worker.fetch(new Request("https://example.test/private"));
  assert.equal(missing.status, 404);
});

test("creates safe direct links and honest latest-catalog selections", () => {
  const direct = urlWithMaterial("https://example.test/library-site/?grade=7#catalog", "cat-0112");
  assert.equal(direct, "https://example.test/library-site/?grade=7&material=CAT-0112#catalog");
  assert.equal(materialIdFromUrl(direct), "CAT-0112");
  assert.equal(urlWithoutMaterial(direct), "https://example.test/library-site/?grade=7#catalog");
  assert.equal(materialIdFromUrl("https://example.test/?material=../CAT-0112"), "");

  const input = [{ id: "CAT-0009" }, { id: "CAT-0112" }, { id: "CAT-0100" }];
  assert.deepEqual(newestMaterialsByCatalogId(input, 2).map((item) => item.id), ["CAT-0112", "CAT-0100"]);
  assert.deepEqual(input.map((item) => item.id), ["CAT-0009", "CAT-0112", "CAT-0100"]);

  const item = { id: "CAT-0112", title: "Математика, 2 клас" };
  assert.match(materialShareText(item, direct), /CAT-0112/);
  assert.match(materialShareText(item, direct), /https:\/\/example\.test\/library-site/);
  assert.match(materialIssueText(item, direct), /Що потрібно виправити:/);
  assert.match(materialIssueText(item, direct), /CAT-0112/);
});

test("wires teacher collections, sharing, error reporting, and mobile dialog safety", async () => {
  const [html, app, css] = await Promise.all([
    readFile(new URL("../source/index.html", import.meta.url), "utf8"),
    readFile(new URL("../source/app.js", import.meta.url), "utf8"),
    readFile(new URL("../source/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="collectionGrid"/);
  assert.match(html, /type="module" src="\/app\.js"/);
  assert.match(app, /Останні додані до каталогу/);
  assert.match(app, /function openLinkedMaterial\(\)/);
  assert.match(app, /openLinkedMaterial\(\);/);
  assert.match(app, /history\.pushState/);
  assert.match(app, /history\.replaceState/);
  assert.match(app, /addEventListener\("popstate"/);
  assert.match(app, /navigator\.share/);
  assert.match(app, /data-report-error/);
  assert.match(css, /max-height:calc\(100dvh - 12px\)/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /min-height:44px/);
});

test("serves the official logo and live placement data", async () => {
  const logo = await worker.fetch(new Request("https://example.test/library-logo.png"));
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get("content-type"), "image/png");
  assert.ok((await logo.arrayBuffer()).byteLength > 1000);

  const balances = await worker.fetch(new Request("https://example.test/balance-data.js"));
  const text = await balances.text();
  assert.match(text, /Бібліотека/);
  assert.match(text, /"library":/);
  assert.match(text, /"other":/);
});

test("ships an opt-in Google Sheets sync with a local fallback", async () => {
  const home = await worker.fetch(new Request("https://example.test/"));
  const html = await home.text();
  assert.match(html, /Показано перевірену копію бази/);
  assert.match(html, /<script src="\/config\.js"><\/script>/);

  const configResponse = await worker.fetch(new Request("https://example.test/config.js"));
  assert.equal(configResponse.status, 200);
  assert.match(await configResponse.text(), /apiUrl:\s*"(?:https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec)?"/);
  assert.match(home.headers.get("content-security-policy"), /https:\/\/script\.google\.com/);
});

test("public Apps Script API is read-only and excludes private sheets", async () => {
  const source = await readFile(new URL("../apps-script/PublicCatalogApi.gs", import.meta.url), "utf8");
  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /function doGet\(e\)/);
  assert.doesNotMatch(source, /function\s+do(?:Post|Put|Delete)\s*\(/i);
  assert.match(source, /getSheetByName\("Матеріали"\)|requiredSheet_\(spreadsheet, "Матеріали"\)/);
  assert.match(source, /LOC-007/);
  assert.match(source, /LOC-008/);
  assert.match(source, /validCallback_/);
  assert.doesNotMatch(source, /getSheetByName\("Користувачі"\)|requiredSheet_\(spreadsheet, "Користувачі"\)/);
  assert.doesNotMatch(source, /setValue|setValues|appendRow|deleteRow|insertRow|clearContent/);
});

test("creates a project-safe GitHub Pages build", async () => {
  const html = await readFile(new URL("../dist-pages/index.html", import.meta.url), "utf8");
  assert.match(html, /src="\.\/config\.js"/);
  assert.match(html, /href="\.\/library-logo\.png"/);
  assert.match(html, /https:\/\/nazarijshvetz1\.github\.io\/library-site\/og\.png/);
  assert.doesNotMatch(html, /\{\{SITE_ORIGIN\}\}/);
});
