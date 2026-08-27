export const LIBRARIAN_SECTIONS = [
  "home",
  "fund",
  "circulation",
  "orders",
  "visits",
  "teachers",
  "acquisitions",
  "reports",
  "management",
] as const;

export type LibrarianSection = (typeof LIBRARIAN_SECTIONS)[number];

export type LibrarianUtility = "publicCatalog" | "excelExport" | "excelImport" | "telegram";

export const PUBLIC_CATALOG_URL = "https://nazarijshvetz1.github.io/library-site/";
export const LIBRARY_EMBLEM_URL = `${PUBLIC_CATALOG_URL}library-logo.png`;

const WEB_SECTION_ROUTES: Record<LibrarianSection, string> = {
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

const TELEGRAM_SECTION_ROUTES: Record<LibrarianSection, string> = {
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

/** Stable deep links for the nested D1 workspace navigation. */
export function librarianToolHref(tool: string, telegramMiniApp = false): string {
  const params = new URLSearchParams();
  if (telegramMiniApp) params.set("target", "home");
  params.set("tool", tool);
  return telegramMiniApp
    ? `/librarian/telegram/cabinet?${params.toString()}`
    : `/librarian?${params.toString()}`;
}

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
  if (utility === "excelExport") return telegramMiniApp ? null : "/librarian/reports";
  if (utility === "excelImport") return telegramMiniApp ? null : "/librarian/import";
  return telegramMiniApp
    ? "/librarian/telegram/cabinet?target=teachers&tab=telegram"
    : "/librarian/teachers?tab=telegram";
}
