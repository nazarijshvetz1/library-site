import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  LIBRARIAN_SECTIONS,
  LIBRARY_EMBLEM_URL,
  librarianSectionHref,
  librarianToolHref,
  librarianUtilityHref,
} from "../app/librarian/_components/librarian-routes.ts";

const expectedWebRoutes = {
  home: "/librarian",
  fund: "/librarian?tool=catalog",
  circulation: "/librarian?tool=return",
  orders: "/librarian/orders",
  visits: "/librarian/visits",
  teachers: "/librarian/teachers",
  acquisitions: "/librarian/acquisitions",
  reports: "/librarian/reports",
  management: "/librarian?tool=locations",
};

const expectedTelegramRoutes = {
  home: "/librarian/telegram/cabinet?target=home",
  fund: "/librarian/telegram/cabinet?target=home&tool=catalog",
  circulation: "/librarian/telegram/cabinet?target=home&tool=return",
  orders: "/librarian/telegram/cabinet?target=teachers&tab=orders",
  visits: "/librarian/telegram/cabinet?target=visits",
  teachers: "/librarian/telegram/cabinet?target=teachers",
  acquisitions: "/librarian/telegram/cabinet?target=acquisitions",
  reports: "/librarian/telegram/cabinet?target=reports",
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
  assert.equal(librarianUtilityHref("excelExport", false), "/librarian/reports");
  assert.equal(librarianUtilityHref("excelExport", true), null);
  assert.equal(librarianUtilityHref("excelImport", false), "/librarian/import");
  assert.equal(librarianUtilityHref("excelImport", true), null);
  assert.equal(librarianUtilityHref("telegram", false), "/librarian/teachers?tab=telegram");
  assert.equal(librarianUtilityHref("telegram", true), "/librarian/telegram/cabinet?target=teachers&tab=telegram");
  assert.equal(librarianToolHref("catalog", false), "/librarian?tool=catalog");
  assert.equal(librarianToolHref("catalog", true), "/librarian/telegram/cabinet?target=home&tool=catalog");
});

test("LibrarianShell keeps the official emblem, full-page navigation, and accessible mobile drawer", async () => {
  const [source, css, workspaceCss] = await Promise.all([
    readFile(new URL("../app/librarian/_components/librarian-shell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/librarian/_components/librarian-shell.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/librarian/d1-workspace.module.css", import.meta.url), "utf8"),
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
  assert.match(source, /excelExportHref \? <a href=\{excelExportHref\}>Звіти/u);
  assert.match(source, /excelImportHref \? <a href=\{excelImportHref\}>Імпорт/u);
  assert.match(source, /className=\{styles\.sidebarUtilities\}/u);
  assert.match(source, /subsections\?: LibrarianSubsection\[\]/u);
  assert.match(source, /activeSubsection\?: string/u);
  assert.match(source, /onSubsectionNavigate\?: \(id: string\) => void/u);
  assert.match(source, /function standardLibrarianSubsections\(telegramMiniApp: boolean\)/u);
  assert.match(source, /label: "Каталог"[\s\S]*?label: "Новий матеріал"[\s\S]*?label: "Е-підручники"/u);
  assert.match(source, /function mergeSubsections/u);
  assert.match(source, /function SectionControl/u);
  assert.match(source, /if \(onToggle\) \{[\s\S]*?<button/u);
  assert.match(source, /aria-expanded=\{expanded\}/u);
  assert.match(source, /aria-controls=\{controlsId\}/u);
  assert.match(source, /expanded && nested\.length/u);
  assert.match(source, /openDrawerForSection\(event\.currentTarget, item\.id\)/u);
  assert.match(source, /aria-expanded=\{drawerOpen && expandedSection === item\.id\}/u);
  assert.match(source, /subsection\.section === activeSection \? onSubsectionNavigate : undefined/u);
  for (const subsection of ["Видача вчителю", "Повернення", "Видача класу", "Повернення класу", "Планування фонду"]) {
    assert.match(source, new RegExp(subsection, "u"));
  }
  assert.match(source, /aria-label="Назад до попередньої сторінки"/u);
  assert.match(source, /aria-label="Вперед до наступної сторінки"/u);
  assert.match(source, /window\.sessionStorage\.getItem\(key\)/u);
  assert.match(source, /window\.location\.assign\(destination\)/u);
  assert.match(source, /"librarian:navigation-change"/u);
  assert.match(source, /<div className=\{`\$\{styles\.shell\}/u);
  assert.doesNotMatch(source, /<main\b/u);

  for (const label of ["Головна", "Фонд", "Видача", "Заявки", "Ще", "Відвідування", "Вчителі", "Комплектування", "Звіти", "Керування"]) {
    assert.match(source, new RegExp(label, "u"));
  }
  assert.match(css, /min-height:\s*44px/u);
  assert.match(css, /min-height:\s*48px/u);
  assert.match(css, /@media \(max-width:\s*840px\)/u);
  assert.match(css, /env\(safe-area-inset-bottom\)/u);
  assert.match(css, /\.brand \{ width: 100%; max-width: 100%; overflow: hidden; \}/u);
  assert.match(css, /\.account > a \{ flex: 0 0 auto; white-space: nowrap; \}/u);
  assert.match(css, /\.content :is\(input,select,textarea\) \{ min-width: 0; max-width: 100%; font-size: 16px!important; \}/u);
  assert.match(css, /\.drawer > header button:focus-visible \{[\s\S]*?box-shadow: 0 0 0 3px rgba\(35, 88, 59, \.2\);/u);
  assert.match(css, /\.sectionToggle \{[\s\S]*?width: 100%[\s\S]*?cursor: pointer/u);
  assert.match(css, /\.sectionToggle \{[\s\S]*?appearance: none;[\s\S]*?background: transparent;/u);
  assert.match(css, /\.sectionToggle\[aria-expanded="true"\] \.sectionChevron/u);
  assert.match(workspaceCss, /\.resultCopy strong,[\s\S]*?\.selectedSummary strong \{[\s\S]*?white-space: normal;[\s\S]*?overflow-wrap: anywhere;/u);
});
