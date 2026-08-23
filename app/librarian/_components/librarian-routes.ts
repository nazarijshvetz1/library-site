export const LIBRARIAN_SECTIONS = [
  "home",
  "fund",
  "circulation",
  "orders",
  "visits",
  "teachers",
  "acquisitions",
  "management",
] as const;

export type LibrarianSection = (typeof LIBRARIAN_SECTIONS)[number];

export type LibrarianUtility = "publicCatalog" | "excelExport" | "excelImport" | "telegram";

export const PUBLIC_CATALOG_URL = "https://nazarijshvetz1.github.io/library-site/";
export const LIBRARY_EMBLEM_URL = `${PUBLIC_CATALOG_URL}library-logo.png`;

const WEB_SECTION_ROUTES: Record<LibrarianSection, string> = {
  home: "/librarian",
  fund: "/librarian?tool=catalog",
  circulation: "/librarian?tool=issue",
  orders: "/librarian/orders",
  visits: "/librarian/visits",
  teachers: "/librarian/teachers",
  acquisitions: "/librarian/acquisitions",
  management: "/librarian?tool=locations",
};

const TELEGRAM_SECTION_ROUTES: Record<LibrarianSection, string> = {
  home: "/librarian/telegram/cabinet?target=home",
  fund: "/librarian/telegram/cabinet?target=home&tool=catalog",
  circulation: "/librarian/telegram/cabinet?target=home&tool=issue",
  orders: "/librarian/telegram/cabinet?target=teachers&tab=orders",
  visits: "/librarian/telegram/cabinet?target=visits",
  teachers: "/librarian/telegram/cabinet?target=teachers",
  acquisitions: "/librarian/telegram/cabinet?target=acquisitions",
  management: "/librarian/telegram/cabinet?target=home&tool=locations",
};

/** Full-page destinations used by both the website and Telegram Mini App shells. */
export function librarianSectionHref(
  section: LibrarianSection,
  telegramMiniApp = false,
): string {
  return telegramMiniApp
    ? TELEGRAM_SECTION_ROUTES[section]
    : WEB_SECTION_ROUTES[section];
}

/** Utility destinations. Excel actions are deliberately unavailable inside Telegram Mini App. */
export function librarianUtilityHref(
  utility: LibrarianUtility,
  telegramMiniApp = false,
): string | null {
  if (utility === "publicCatalog") return PUBLIC_CATALOG_URL;
  if (utility === "excelExport") return telegramMiniApp ? null : "/librarian/export";
  if (utility === "excelImport") return telegramMiniApp ? null : "/librarian/import";
  return telegramMiniApp
    ? "/librarian/telegram/cabinet?target=teachers&tab=telegram"
    : "/librarian/teachers?tab=telegram";
}
