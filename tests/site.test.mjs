import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker from "../dist/server/index.js";

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
  assert.match(source, /getSheetByName\("Матеріали"\)|requiredSheet_\(spreadsheet, "Матеріали"\)/);
  assert.match(source, /LOC-007/);
  assert.match(source, /LOC-008/);
  assert.match(source, /validCallback_/);
  assert.doesNotMatch(source, /getSheetByName\("Користувачі"\)|requiredSheet_\(spreadsheet, "Користувачі"\)/);
  assert.doesNotMatch(source, /setValue|setValues|appendRow|deleteRow/);
});

test("creates a project-safe GitHub Pages build", async () => {
  const html = await readFile(new URL("../dist-pages/index.html", import.meta.url), "utf8");
  assert.match(html, /src="\.\/config\.js"/);
  assert.match(html, /href="\.\/library-logo\.png"/);
  assert.match(html, /https:\/\/nazarijshvetz1\.github\.io\/library-site\/og\.png/);
  assert.doesNotMatch(html, /\{\{SITE_ORIGIN\}\}/);
});
