import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker from "../dist-catalog/server/index.js";
import {
  catalogDetailApiUrl,
  initializeTelegramMiniApp,
  materialIdFromUrl,
  materialOrderDestination,
  materialOrderUrl,
  materialIssueText,
  materialShareText,
  matchesMaterialSearch,
  newestMaterialsByCatalogId,
  normalizeCatalogApiUrl,
  normalizeVisitSchedule,
  normalizeVisitsApiUrl,
  startOfVisitWeek,
  telegramMiniAppLaunchHash,
  titleSuggestions,
  urlWithMaterial,
  urlWithoutMaterial,
  visitBookingSelection,
  visitHorizonEnd,
  visitScheduleQueryRange,
  visitSegmentsForDate,
  visitWeekNavigation,
  visitsBookingUrl,
  visitsPublicApiUrl,
  visitWeekDates,
} from "../source/app.js";

test("builds a privacy-limited teacher order handoff URL", () => {
  const url = materialOrderUrl("https://library.example/teacher", "cat-0112");
  assert.equal(url, "https://library.example/teacher?tab=orders&material=CAT-0112");
  assert.equal(materialOrderUrl("https://library.example/librarian", "CAT-0112"), "");
  assert.equal(materialOrderUrl("https://library.example/teacher", "bad-id"), "");
  assert.doesNotMatch(url, /[?&](?:name|email|teacher|class|purpose)=/u);
});

test("keeps catalog ordering inside the Telegram Mini App and preserves the selected material", () => {
  const launchHash = "#tgWebAppData=query_id%3Ddemo%26auth_date%3D1787640000%26hash%3Dtest&tgWebAppVersion=8.0&tgWebAppPlatform=ios&tgWebAppThemeParams=%7B%22bg_color%22%3A%22%23ffffff%22%7D";
  assert.equal(telegramMiniAppLaunchHash("#catalog"), "");
  assert.equal(telegramMiniAppLaunchHash("#tgWebAppData=demo"), "");

  const destination = materialOrderDestination(
    "https://library.example/teacher",
    "cat-0112",
    launchHash,
  );
  const url = new URL(destination.url);
  assert.equal(destination.withinTelegram, true);
  assert.equal(url.pathname, "/teacher/telegram");
  assert.equal(url.searchParams.get("tab"), "orders");
  assert.equal(url.searchParams.get("material"), "CAT-0112");
  const telegramParams = new URLSearchParams(url.hash.slice(1));
  assert.equal(telegramParams.get("tgWebAppData"), "query_id=demo&auth_date=1787640000&hash=test");
  assert.equal(telegramParams.get("tgWebAppVersion"), "8.0");

  const browser = materialOrderDestination("https://library.example/teacher", "CAT-0112", "#catalog");
  assert.equal(browser.withinTelegram, false);
  assert.equal(browser.url, "https://library.example/teacher?tab=orders&material=CAT-0112");
});

test("expands the public catalog Mini App and safely requests supported fullscreen", () => {
  const calls = [];
  const connected = initializeTelegramMiniApp({
    ready: () => calls.push("ready"),
    expand: () => calls.push("expand"),
    isVersionAtLeast: (version) => version === "8.0",
    isFullscreen: false,
    requestFullscreen: () => calls.push("fullscreen"),
  });
  assert.deepEqual(connected, { connected: true, fullscreenRequested: true });
  assert.deepEqual(calls, ["ready", "expand", "fullscreen"]);
  assert.deepEqual(initializeTelegramMiniApp(null), { connected: false, fullscreenRequested: false });
  assert.equal(initializeTelegramMiniApp({
    expand: () => calls.push("older-expand"),
    isVersionAtLeast: () => false,
    requestFullscreen: () => calls.push("older-fullscreen"),
  }).fullscreenRequested, false);
  assert.equal(calls.includes("older-fullscreen"), false);
});

test("offers bounded title suggestions with stable relevance", () => {
  const items = [
    { id: "CAT-0001", title: "Математика. 5 клас", author: "Іваненко", year: 2024 },
    { id: "CAT-0002", title: "Збірник задач з математики", author: "Петренко", year: 2023 },
    { id: "CAT-0003", title: "Українська мова", author: "Коваленко", year: 2022 },
  ];
  assert.deepEqual(titleSuggestions(items, "матем", 6).map((item) => item.id), ["CAT-0001", "CAT-0002"]);
  assert.deepEqual(titleSuggestions(items, "збір задач", 6).map((item) => item.id), ["CAT-0002"]);
  assert.deepEqual(titleSuggestions(items, "м", 6), []);
});

test("matches every search token across catalog metadata", () => {
  const item = {
    id: "CAT-0001",
    title: "Математика — 5 клас",
    author: "Іваненко",
    subject: "Математика",
    type: "Підручник",
    rubric: "Підручники",
  };
  assert.equal(matchesMaterialSearch(item, "математика 5"), true);
  assert.equal(matchesMaterialSearch(item, "іваненко підручник"), true);
  assert.equal(matchesMaterialSearch(item, "математика 10"), false);
});

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

  const api = normalizeCatalogApiUrl(
    "https://library.example/api/catalog-v2/?stale=1#fragment",
  );
  assert.equal(api, "https://library.example/api/catalog-v2");
  assert.equal(
    catalogDetailApiUrl(api, "cat-0112"),
    "https://library.example/api/catalog-v2/CAT-0112",
  );
  assert.equal(normalizeCatalogApiUrl("https://script.google.com/macros/s/demo/exec"), "");
  assert.equal(catalogDetailApiUrl(api, "../CAT-0112"), "");
});

test("normalizes the privacy-safe weekly visit schedule and derives free intervals", () => {
  const schedule = normalizeVisitSchedule({
    schemaVersion: 1,
    success: true,
    timeZone: "Europe/Kyiv",
    slotMinutes: 5,
    hours: {
      1: [{ startTime: "08:00", endTime: "12:00" }],
      2: [], 3: [], 4: [], 5: [], 6: [], 7: [],
    },
    closures: [{ date: "2026-08-10", startTime: "10:30", endTime: "11:00", status: "closed" }],
    busy: [{ date: "2026-08-10", startTime: "09:00", endTime: "09:40", status: "busy" }],
    publicBookings: [{ date: "2026-08-10", startTime: "09:00", endTime: "09:40", displayName: "Іваненко Олена", identityVerified: true, classLabel: "7-А", purpose: "private" }],
    generatedAt: "2026-08-10T06:00:00.000Z",
    privateTeacherName: "must be discarded",
  }, "2026-08-10", "2026-08-16");

  assert.deepEqual(
    visitSegmentsForDate(schedule, "2026-08-10").map(({ startTime, endTime, status }) => ({ startTime, endTime, status })),
    [
      { startTime: "08:00", endTime: "09:00", status: "free" },
      { startTime: "09:00", endTime: "09:40", status: "busy" },
      { startTime: "09:40", endTime: "10:30", status: "free" },
      { startTime: "10:30", endTime: "11:00", status: "closed" },
      { startTime: "11:00", endTime: "12:00", status: "free" },
    ],
  );
  assert.equal(schedule.publicBookings[0].displayName, "Іваненко Олена");
  assert.equal(schedule.publicBookings[0].classLabel, undefined);
  assert.equal(schedule.publicBookings[0].purpose, undefined);
  assert.equal(schedule.privateTeacherName, undefined);
  assert.throws(() => normalizeVisitSchedule({ ...schedule, slotMinutes: 15 }), /точність/);
  assert.throws(() => normalizeVisitSchedule({ ...schedule, timeZone: "UTC" }), /відповідь/);
});

test("keeps adjacent public bookings separate, shows directory guests, and masks unmatched guests", () => {
  const longCanonicalName = "А".repeat(81);
  const invalidCanonicalName = "Б".repeat(121);
  const schedule = normalizeVisitSchedule({
    schemaVersion: 1,
    success: true,
    timeZone: "Europe/Kyiv",
    slotMinutes: 5,
    hours: { 1: [{ startTime: "08:00", endTime: "12:00" }], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] },
    closures: [],
    busy: [{ date: "2026-08-10", startTime: "09:00", endTime: "10:00", status: "busy" }],
    publicBookings: [
      { date: "2026-08-10", startTime: "09:00", endTime: "09:30", displayName: "Іваненко Олена", identityVerified: true },
      { date: "2026-08-10", startTime: "09:30", endTime: "10:00", displayName: "Галака Наталія Григорівна", identityVerified: false, directoryMatched: true },
      { date: "2026-08-10", startTime: "10:00", endTime: "10:30", displayName: "Чуже ім’я", identityVerified: false },
      { date: "2026-08-10", startTime: "10:30", endTime: "11:00", displayName: longCanonicalName, identityVerified: false, directoryMatched: true },
      { date: "2026-08-10", startTime: "11:00", endTime: "11:30", displayName: invalidCanonicalName, identityVerified: false, directoryMatched: true },
    ],
  }, "2026-08-10", "2026-08-16");

  assert.deepEqual(
    visitSegmentsForDate(schedule, "2026-08-10")
      .filter((segment) => segment.status === "busy")
      .map(({ startTime, endTime, displayName, identityVerified }) => ({ startTime, endTime, displayName, identityVerified })),
    [
      { startTime: "09:00", endTime: "09:30", displayName: "Іваненко Олена", identityVerified: true },
      { startTime: "09:30", endTime: "10:00", displayName: "Заявлено: Галака Наталія Григорівна · гостьовий запис · особу не підтверджено", identityVerified: false },
      { startTime: "10:00", endTime: "10:30", displayName: "Непідтверджений гостьовий запис", identityVerified: false },
      { startTime: "10:30", endTime: "11:00", displayName: `Заявлено: ${longCanonicalName} · гостьовий запис · особу не підтверджено`, identityVerified: false },
      { startTime: "11:00", endTime: "11:30", displayName: "Непідтверджений гостьовий запис", identityVerified: false },
    ],
  );
});

test("creates bounded week requests and PII-free protected booking handoffs", () => {
  assert.equal(startOfVisitWeek("2026-08-12"), "2026-08-10");
  assert.deepEqual(visitWeekDates("2026-08-12"), [
    "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16",
  ]);
  assert.equal(
    visitsPublicApiUrl("https://library.example/api/visits/public", "2026-08-10", "2026-08-16"),
    "https://library.example/api/visits/public?from=2026-08-10&to=2026-08-16",
  );
  assert.equal(normalizeVisitsApiUrl("https://library.example/api/visits/private"), "");
  const selection = visitBookingSelection({ date: "2026-08-10", startTime: "09:40", endTime: "11:30", status: "free" });
  assert.deepEqual(selection, { date: "2026-08-10", startTime: "09:40", endTime: "10:20" });
  const bookingUrl = visitsBookingUrl("https://library.example/teacher", selection);
  assert.equal(bookingUrl, "https://library.example/teacher?date=2026-08-10&start=09%3A40&end=10%3A20");
  assert.doesNotMatch(bookingUrl, /teacherRef|class|fullName|surname|purpose|note/i);
  assert.equal(visitsBookingUrl("https://library.example/librarian", selection), "");
  assert.match(visitsBookingUrl("https://library.example/visits", selection), /^https:\/\/library\.example\/visits\?/u);
});

test("never advertises elapsed, too-short, or out-of-horizon visit slots", () => {
  const constraints = { today: "2026-08-12", currentTime: "10:01", horizonEnd: "2026-11-10" };
  assert.equal(visitBookingSelection(
    { date: "2026-08-11", startTime: "09:00", endTime: "10:00", status: "free" },
    40,
    constraints,
  ), null);
  assert.equal(visitBookingSelection(
    { date: "2026-08-12", startTime: "09:00", endTime: "10:20", status: "free" },
    40,
    constraints,
  ), null);
  assert.equal(visitBookingSelection(
    { date: "2026-08-13", startTime: "09:00", endTime: "09:15", status: "free" },
    40,
    constraints,
  ), null);
  assert.equal(visitBookingSelection(
    { date: "2026-11-11", startTime: "09:00", endTime: "10:00", status: "free" },
    40,
    constraints,
  ), null);
  assert.deepEqual(visitBookingSelection(
    { date: "2026-08-12", startTime: "08:00", endTime: "12:00", status: "free" },
    40,
    constraints,
  ), { date: "2026-08-12", startTime: "10:05", endTime: "10:45" });
});

test("bounds public week navigation and API reads to the 90-day booking horizon", () => {
  assert.equal(visitHorizonEnd("2026-08-12"), "2026-11-10");
  assert.deepEqual(visitWeekNavigation("2026-08-10", "2026-08-12"), {
    firstWeek: "2026-08-10", lastWeek: "2026-11-09", canPrevious: false, canNext: true,
  });
  assert.deepEqual(visitWeekNavigation("2026-11-09", "2026-08-12"), {
    firstWeek: "2026-08-10", lastWeek: "2026-11-09", canPrevious: true, canNext: false,
  });
  assert.deepEqual(visitScheduleQueryRange("2026-08-10", "2026-08-12"), { from: "2026-08-12", to: "2026-08-16" });
  assert.deepEqual(visitScheduleQueryRange("2026-11-09", "2026-08-12"), { from: "2026-11-09", to: "2026-11-10" });
});

test("wires teacher collections, sharing, error reporting, and mobile dialog safety", async () => {
  const [html, app, css, brand, system] = await Promise.all([
    readFile(new URL("../source/index.html", import.meta.url), "utf8"),
    readFile(new URL("../source/app.js", import.meta.url), "utf8"),
    readFile(new URL("../source/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../source/brand.css", import.meta.url), "utf8"),
    readFile(new URL("../source/system.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="collectionGrid"/);
  assert.match(html, /href="#contacts"[^>]*>Контакти<\/a>/u);
  assert.match(html, /id="contacts"/u);
  assert.match(html, /id="contactsGrid" hidden/u);
  assert.match(app, /normalizeContactsApiUrl/u);
  assert.match(app, /textContent = value/u);
  assert.doesNotMatch(app, /contactsGrid\.innerHTML/u);
  assert.match(html, /id="titleSuggestions" role="listbox"/);
  assert.match(html, /<option value="">Усі<\/option>/);
  assert.match(html, /href="\/styles\.css\?v=20260826-2"/);
  assert.match(html, /href="\/brand\.css\?v=20260831-1"/);
  assert.match(html, /href="\/system\.css\?v=20260827-1"/);
  assert.match(brand, /\.stats\s*\{[^}]*margin-top:\s*24px;/s);
  assert.match(html, /<head>[\s\S]*?src="https:\/\/telegram\.org\/js\/telegram-web-app\.js\?63"[\s\S]*?<\/head>/u);
  assert.match(html, /type="module" src="\/app\.js\?v=20260827-1"/);
  assert.match(html, /id="filterBackdrop" hidden/u);
  assert.match(html, /id="filterClose"[^>]+aria-label="Закрити фільтри"/u);
  assert.match(html, /id="filterApply"[^>]*>Показати результати<\/button>/u);
  assert.match(app, /function setFilterDrawerOpen\(open/u);
  assert.match(app, /const fallbackTitle = cleanText\(item\.title \|\| item\.subject/u);
  assert.match(app, /cover-fallback-long/u);
  assert.match(app, /event\.key !== "Escape"/u);
  assert.match(app, /elements\.filterBackdrop\.addEventListener\("click"/u);
  assert.match(app, /elements\.filterToggle\.setAttribute\("aria-expanded", String\(shouldOpen\)\)/u);
  assert.match(css, /\.filter-toggle\{display:none;/u);
  assert.match(css, /@media\(max-width:820px\)\{[^}]*?(?:\{[^}]*\}[^}]*)*?\.filter-toggle\{display:inline-flex\}/u);
  assert.doesNotMatch(css, /\.showcase-footer button,\.filter-toggle,[^{]+\{display:inline-flex/u);
  assert.match(system, /\.filter-backdrop:not\(\[hidden\]\)/u);
  assert.match(system, /\.filter-close\s*\{/u);
  assert.match(system, /\.filter-apply\s*\{/u);
  assert.match(system, /height:\s*max-content/u);
  assert.match(html, /class="icon-sprite"/u);
  assert.match(app, /const uiIcon =/u);
  assert.doesNotMatch(html, /[⌕☷✓←→↗○✦×＋]/u);
  assert.doesNotMatch(app, /[⌕☷✓←→↗○✦×＋]/u);
  assert.match(html, /class="hero-decoration"/u);
  assert.match(html, /href="https:\/\/yedyna-biblioteka-liceiu\.nazarijshvetz1\.chatgpt\.site\/librarian"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(app, /librarianButton|Режим бібліотекаря підключимо/);
  assert.match(app, /Останні додані до каталогу/);
  assert.match(app, /function openLinkedMaterial\(\)/);
  assert.match(app, /openLinkedMaterial\(\);/);
  assert.match(app, /history\.pushState/);
  assert.match(app, /history\.replaceState/);
  assert.match(app, /addEventListener\("popstate"/);
  assert.match(app, /navigator\.share/);
  assert.match(app, /data-title-suggestion/);
  assert.match(app, /item\.author \|\| "Автор не вказаний"/);
  assert.match(app, /item\.year \|\| "Рік не вказаний"/);
  assert.match(app, /data-report-error/);
  assert.match(app, /class="material-links"/);
  assert.match(app, /<button class="material-card-action" type="button" data-details="\$\{escapeHtml\(item\.id\)\}" aria-label="Відкрити інформацію про/u);
  assert.match(app, /<div class="cover-wrap">/u);
  assert.match(app, /<span class="details-button" aria-hidden="true">Детальніше/u);
  assert.doesNotMatch(app, /class="cover-wrap cover-button"/u);
  assert.match(app, /class="card-stock"/u);
  assert.match(app, /class="quantity available-quantity\$\{available \? "" : " none"\}"/u);
  assert.match(app, /<strong>\$\{escapeHtml\(item\.availableQuantity\)\}<\/strong><span>Доступно<\/span>/u);
  assert.match(app, /class="order-material-button"/u);
  assert.match(app, /Замовити \$\{uiIcon\("arrow-right"\)\}/u);
  assert.match(app, /data-order-material=/u);
  assert.match(app, /window\.location\.assign\(destination\.url\)/u);
  const orderRenderer = app.slice(app.indexOf("function renderMaterialDialog"), app.indexOf("async function loadMaterialDetail"));
  assert.match(orderRenderer, /<button class="order-material-button" type="button" data-order-material=/u);
  assert.match(orderRenderer, /<a class="order-material-button"[^>]+target="_blank" rel="noopener noreferrer"/u);
  assert.doesNotMatch(orderRenderer, /Telegram\.WebApp\.openLink|window\.open/u);
  assert.match(app, /target="_blank" rel="noopener noreferrer"/);
  assert.match(app, /raw\.thumbnailUrl/);
  assert.match(app, /raw\.publicationType/);
  assert.match(css, /max-height:calc\(100dvh - 12px\)/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(system, /--catalog-top-inset:\s*calc\(\s*max\(env\(safe-area-inset-top\), var\(--tg-safe-area-inset-top, 0px\)\)\s*\+\s*var\(--tg-content-safe-area-inset-top, 0px\)\s*\);/u);
  assert.doesNotMatch(system, /max\(env\(safe-area-inset-top\), var\(--tg-content-safe-area-inset-top/u);
  assert.match(system, /padding-top:\s*var\(--catalog-top-inset\)/u);
  assert.match(system, /top:\s*var\(--catalog-top-inset\)/u);
  assert.match(system, /\.skip-link:focus\s*\{\s*top:\s*calc\(var\(--catalog-top-inset\) \+ 8px\)/u);
  assert.match(system, /caret-color:\s*#1f5a3c/u);
  assert.match(system, /-webkit-text-fill-color:\s*#15372f/u);
  assert.match(system, /@supports \(caret-animation: manual\)/u);
  assert.match(app, /function scheduleSearchRender\(\)/u);
  assert.match(app, /window\.setTimeout\([\s\S]*?, 140\);/u);
  assert.match(app, /addEventListener\("compositionstart"/u);
  assert.match(app, /addEventListener\("compositionend"/u);
  assert.match(app, /event\.isComposing \|\| searchCompositionActive/u);
  const searchInputHandler = app.slice(
    app.indexOf('elements.search.addEventListener("input"'),
    app.indexOf('elements.search.addEventListener("focus"'),
  );
  assert.match(searchInputHandler, /scheduleSearchRender\(\)/u);
  assert.doesNotMatch(searchInputHandler, /resetLimitAndRender/u);
  assert.match(css, /min-height:44px/);
  assert.match(brand, /\.hero \{[\s\S]*?z-index: 4;[\s\S]*?overflow: visible;/u);
  assert.match(brand, /\.hero-decoration \{[\s\S]*?overflow: hidden;[\s\S]*?pointer-events: none;/u);
  assert.match(brand, /\.stats \{[\s\S]*?z-index: 3;/u);
  assert.match(brand, /@media \(max-width: 820px\)[\s\S]*?\.stats \{ margin: 24px 16px 0;/u);
  assert.match(brand, /@media \(max-width: 820px\)[\s\S]*?\.site-header \{[\s\S]*?-webkit-backdrop-filter: none;[\s\S]*?backdrop-filter: none;/u);
  assert.match(brand, /@media \(max-width: 820px\)[\s\S]*?\.site-header \.site-nav \{[\s\S]*?position: fixed;/u);
  assert.match(css, /\.title-suggestions/);
  assert.match(css, /\.material-card-action\{position:absolute;z-index:6;inset:0;/u);
  assert.match(css, /\.material-card-action:focus-visible\{outline:3px solid var\(--lime\)/u);
  assert.match(css, /\.card-stock\{display:flex;align-items:flex-end;gap:18px\}/u);
  assert.match(css, /\.available-quantity\.none strong\{color:#a05744\}/u);
  assert.match(css, /\.dialog-order/);
  assert.match(html, /class="hero-assurances"/u);
  assert.match(html, /class="suggestion-cta"/u);
  assert.match(html, /клас, своє ім’я, назву та автора книги/u);
  assert.match(html, /href="https:\/\/yedyna-biblioteka-liceiu\.nazarijshvetz1\.chatgpt\.site\/suggest-book"/u);
  assert.match(html, /aria-labelledby="material-dialog-title" aria-describedby="material-dialog-note"/u);
  assert.match(app, /id="material-dialog-title"/u);
  assert.match(app, /id="material-dialog-note"/u);
  assert.match(app, /function renderLinkedMaterialStatus/u);
  assert.match(app, /loadMaterialDetail\(id\)\.then/u);
  assert.match(app, /Number\(error\?\.status\) === 404/u);
  assert.match(app, /if \(!summary && !cachedDetail\) return false/u);
  assert.match(app, /data-retry-linked-material/u);
  assert.match(app, /retry: !missing/u);
  assert.match(app, /if \(linkedId\) openLinkedMaterial\(\)/u);
  assert.match(app, /Матеріал із таким CAT-ID не знайдено/u);
  assert.match(brand, /--gold: #cda252/u);
  assert.match(brand, /\.suggestion-cta/u);
  assert.match(brand, /env\(safe-area-inset-bottom\)/u);
  assert.match(brand, /grid-template-columns:\s*repeat\(6, minmax\(0, 1fr\)\)/u);
  assert.match(brand, /@media \(prefers-reduced-motion: reduce\)/u);
});

test("ships an accessible responsive public visit schedule and protected handoff", async () => {
  const [html, app, css, config] = await Promise.all([
    readFile(new URL("../source/index.html", import.meta.url), "utf8"),
    readFile(new URL("../source/app.js", import.meta.url), "utf8"),
    readFile(new URL("../source/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../source/config.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /href="#visit-schedule"[^>]*>Графік<\/a>/);
  assert.match(html, /href="https:\/\/yedyna-biblioteka-liceiu\.nazarijshvetz1\.chatgpt\.site\/teacher"[\s\S]*>Кабінет учителя<\/a>/);
  assert.match(html, /class="teacher-nav-link"[\s\S]*data-primary-section="teacher"[\s\S]*>Кабінет учителя<\/a>/);
  assert.match(html, /data-primary-section="textbooks"[\s\S]*href="https:\/\/yedyna-biblioteka-liceiu\.nazarijshvetz1\.chatgpt\.site\/textbooks"[\s\S]*>Е-підручники<\/a>/u);
  const primaryNavigation = html.match(/data-primary-section=/gu) ?? [];
  assert.equal(primaryNavigation.length, 6);
  for (const label of ["Каталог", "Е-книги", "Кабінет", "Графік", "Як це працює", "Контакти"]) {
    assert.match(html, new RegExp(`data-mobile-label="${label}"`, "u"));
  }
  assert.match(html, /href="#contacts"[^>]*data-primary-section="contacts"[^>]*>Контакти<\/a>/u);
  assert.match(html, /href="#how-it-works"[^>]*data-primary-section="how-it-works"[^>]*>Як користуватися<\/a>/);
  assert.match(html, /Перевірте наявність/);
  assert.match(html, /Запишіться до бібліотеки/);
  assert.match(html, /Почніть у Telegram/);
  assert.match(html, /вперше активувати кабінет/);
  assert.match(html, /https:\/\/t\.me\/MAUP_Library_Bot/);
  assert.match(html, /id="visit-schedule" aria-labelledby="visit-schedule-title"/);
  assert.match(html, /Графік доступний усім без входу/);
  assert.match(html, /видно ПІБ та точний час/);
  assert.match(html, /id="visitScheduleStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="visitScheduleContent"[^>]*aria-busy="true"/);
  assert.match(html, /data-visit-status="free"[\s\S]*Вільно/);
  assert.match(html, /data-visit-status="busy"[\s\S]*Заброньовано/);
  assert.match(html, /data-visit-status="closed"[\s\S]*Бібліотека зачинена/);
  assert.match(html, /data-visit-status="unavailable"[\s\S]*Недоступно для запису/);
  assert.match(app, /fetch\(url, \{ headers: \{ Accept: "application\/json" \}, cache: "no-store" \}\)/);
  assert.match(app, /target="_blank" rel="noopener noreferrer"/);
  assert.match(app, /visitsBookingUrl\(config\.visitsBookingUrl/);
  assert.match(app, /publicBookings: normalizeVisitPublicBookings/u);
  assert.match(app, /segment\.displayName \|\| "Заброньовано"/u);
  assert.match(app, /Непідтверджений гостьовий запис/u);
  assert.match(app, /Заявлено: \$\{normalizedName\} · гостьовий запис · особу не підтверджено/u);
  assert.match(app, /elements\.visitPrevWeek\.disabled = !navigation\.canPrevious/);
  assert.match(app, /data-visit-booking="true"/);
  assert.doesNotMatch(app, /localStorage.*visit|sessionStorage.*visit|fetch\([^\n]*method:\s*"POST"/);
  assert.match(config, /visitsApiUrl:\s*"https:\/\/yedyna-biblioteka-liceiu\.nazarijshvetz1\.chatgpt\.site\/api\/visits\/public"/);
  assert.match(config, /visitsBookingUrl:\s*"https:\/\/yedyna-biblioteka-liceiu\.nazarijshvetz1\.chatgpt\.site\/teacher"/);
  assert.match(css, /\.site-header \.site-nav a\[data-primary-section\]\{display:flex\}/);
  const brandCss = await readFile(new URL("../source/brand.css", import.meta.url), "utf8");
  assert.match(brandCss, /@media \(max-width: 390px\)[\s\S]*content: attr\(data-mobile-label\)[\s\S]*overflow-wrap: anywhere/u);
  assert.match(css, /\.how-it-works ol\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(app, /hash === "#how-it-works"/);
  assert.match(css, /\.visit-slot>a,[^{]+\{display:flex;min-height:54px/);
  assert.match(css, /@media\(max-width:560px\)[\s\S]*\.visit-days[^}]*grid-template-columns:1fr/);
  assert.match(css, /@media\(min-width:821px\) and \(max-width:1180px\)[\s\S]*grid-template-areas:"brand librarian" "nav nav"/);
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

test("ships paginated public D1 sync with a GitHub Pages fallback", async () => {
  const home = await worker.fetch(new Request("https://example.test/"));
  const html = await home.text();
  assert.match(html, /Показано локальну резервну копію каталогу/);
  assert.match(html, /<script src="\/config\.js"><\/script>/);

  const configResponse = await worker.fetch(new Request("https://example.test/config.js"));
  assert.equal(configResponse.status, 200);
  assert.match(
    await configResponse.text(),
    /catalogApiUrl:\s*"https:\/\/yedyna-biblioteka-liceiu\.nazarijshvetz1\.chatgpt\.site\/api\/catalog-v2"/,
  );
  assert.match(home.headers.get("content-security-policy"), /connect-src 'self' https:\/\/yedyna-biblioteka-liceiu\.nazarijshvetz1\.chatgpt\.site/);
  assert.match(home.headers.get("content-security-policy"), /script-src 'self' https:\/\/telegram\.org/);
  assert.doesNotMatch(home.headers.get("content-security-policy"), /script\.google\.com/);

  const app = await (await worker.fetch(new Request("https://example.test/app.js"))).text();
  assert.match(app, /schemaVersion\) !== 2/);
  assert.match(app, /url\.searchParams\.set\("limit", "48"\)/);
  assert.match(app, /catalogDetailApiUrl/);
  assert.doesNotMatch(app, /jsonpPayload|libraryCatalogCallback/);
});

test("keeps D1 catalog reads cross-origin while librarian APIs remain app-guarded", async () => {
  const [listRoute, detailRoute, coverRoute, librarianRoute] = await Promise.all([
    readFile(new URL("../app/api/catalog-v2/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/catalog-v2/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/catalog-v2/covers/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/librarian/materials/search/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(listRoute, /"Access-Control-Allow-Origin": "\*"/);
  assert.match(detailRoute, /"Access-Control-Allow-Origin": "\*"/);
  assert.match(coverRoute, /"Access-Control-Allow-Origin": "\*"/);
  assert.match(librarianRoute, /authorizeLibrarianApi\(\)/);
});

test("landing page describes the implemented direct D1 workflow", async () => {
  const landing = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(landing, /Фактичний залишок/);
  assert.match(landing, /Видача вчителям/);
  assert.match(landing, /відразу зберігаються у захищеній базі/);
  assert.doesNotMatch(landing, /Спочатку чернетка|<strong>Ревізія<\/strong>|<strong>Переміщення<\/strong>/);
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
