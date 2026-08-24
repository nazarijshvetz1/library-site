import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  LIBRARIAN_SECTIONS,
  LIBRARY_EMBLEM_URL,
  librarianSectionHref,
  librarianUtilityHref,
} from "../app/librarian/_components/librarian-routes.ts";

const expectedWebRoutes = {
  home: "/librarian",
  fund: "/librarian?tool=catalog",
  circulation: "/librarian?tool=issue",
  orders: "/librarian/orders",
  visits: "/librarian/visits",
  teachers: "/librarian/teachers",
  acquisitions: "/librarian/acquisitions",
  management: "/librarian?tool=locations",
};

const expectedTelegramRoutes = {
  home: "/librarian/telegram/cabinet?target=home",
  fund: "/librarian/telegram/cabinet?target=home&tool=catalog",
  circulation: "/librarian/telegram/cabinet?target=home&tool=issue",
  orders: "/librarian/telegram/cabinet?target=teachers&tab=orders",
  visits: "/librarian/telegram/cabinet?target=visits",
  teachers: "/librarian/telegram/cabinet?target=teachers",
  acquisitions: "/librarian/telegram/cabinet?target=acquisitions",
  management: "/librarian/telegram/cabinet?target=home&tool=locations",
};

test("shared librarian route helper freezes web and Telegram Mini App destinations", () => {
  assert.deepEqual([...LIBRARIAN_SECTIONS], Object.keys(expectedWebRoutes));
  for (const section of LIBRARIAN_SECTIONS) {
    assert.equal(librarianSectionHref(section, false), expectedWebRoutes[section]);
    assert.equal(librarianSectionHref(section, true), expectedTelegramRoutes[section]);
  }
  assert.equal(librarianUtilityHref("publicCatalog", false), "https://nazarijshvetz1.github.io/library-site/");
  assert.equal(librarianUtilityHref("publicCatalog", true), "https://nazarijshvetz1.github.io/library-site/");
  assert.equal(librarianUtilityHref("excelExport", false), "/librarian/export");
  assert.equal(librarianUtilityHref("excelExport", true), null);
  assert.equal(librarianUtilityHref("excelImport", false), "/librarian/import");
  assert.equal(librarianUtilityHref("excelImport", true), null);
  assert.equal(librarianUtilityHref("telegram", false), "/librarian/teachers?tab=telegram");
  assert.equal(librarianUtilityHref("telegram", true), "/librarian/telegram/cabinet?target=teachers&tab=telegram");
});

test("LibrarianShell keeps the official emblem, full-page navigation, and accessible mobile drawer", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../app/librarian/_components/librarian-shell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/librarian/_components/librarian-shell.module.css", import.meta.url), "utf8"),
  ]);

  assert.equal(LIBRARY_EMBLEM_URL, "https://nazarijshvetz1.github.io/library-site/library-logo.png");
  assert.match(source, /<img src=\{LIBRARY_EMBLEM_URL\}/u);
  assert.match(source, /<strong>Єдина бібліотека<\/strong>/u);
  assert.match(source, /<small>Міжнародний ліцей МАУП<\/small>/u);
  assert.doesNotMatch(source, /next\/link|<Link\b|<svg\b/iu);
  assert.match(source, /aria-current=\{active \? "page" : undefined\}/u);
  assert.match(source, /aria-expanded=\{drawerOpen\}/u);
  assert.match(source, /aria-controls="librarian-more-menu"/u);
  assert.match(source, /role="dialog"/u);
  assert.match(source, /aria-modal="true"/u);
  assert.match(source, /event\.key === "Escape"/u);
  assert.match(source, /event\.key !== "Tab"/u);
  assert.match(source, /excelExportHref \? <a href=\{excelExportHref\}>Експорт/u);
  assert.match(source, /excelImportHref \? <a href=\{excelImportHref\}>Імпорт/u);
  assert.match(source, /className=\{styles\.sidebarUtilities\}/u);
  assert.match(source, /<div className=\{`\$\{styles\.shell\}/u);
  assert.doesNotMatch(source, /<main\b/u);

  for (const label of ["Головна", "Фонд", "Видача", "Заявки", "Ще", "Відвідування", "Вчителі", "Комплектування", "Керування"]) {
    assert.match(source, new RegExp(label, "u"));
  }
  assert.match(css, /min-height:\s*44px/u);
  assert.match(css, /min-height:\s*48px/u);
  assert.match(css, /@media \(max-width:\s*840px\)/u);
  assert.match(css, /env\(safe-area-inset-bottom\)/u);
});
