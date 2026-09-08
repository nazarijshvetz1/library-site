import { listCatalogMaterials, listCatalogMaterialFacets, normalizeCatalogId, normalizeCatalogIsbn, normalizeCatalogSearchText, parseCatalogListQuery, type CatalogD1Database } from "./catalog-d1.ts";

const noise = new Set(["знайди", "знайдіть", "покажи", "покажіть", "будь", "ласка", "мені", "всі", "усі", "книги", "книжки", "підручники", "автора", "автором", "наявність", "бібліотеці", "бібліотеки", "є", "чи", "у", "в", "про", "від"]);
export function simplifyAssistantQuery(value: string, stems = false): string {
  return normalizeCatalogSearchText(value).split(" ").filter((word) => !noise.has(word)).map((word) =>
    stems && word.length > 5 ? word.replace(/(?:ого|ому|ами|ями|ові|еві|ів|ий|ій|ою|ею|ом|а|я|у|ю|і|и)$/u, "") : word).join(" ");
}

export async function searchAssistantCatalog(db: CatalogD1Database, args: Record<string, unknown>, librarian: boolean) {
  const url = new URL("https://library.invalid/");
  const mapping: Record<string, string> = { query: "q", title: "title", grade: "grade", subject: "subject", available: "available", cursor: "cursor" };
  for (const [key, value] of Object.entries(args)) if (mapping[key] && value !== null) url.searchParams.set(mapping[key], String(value));
  url.searchParams.set("limit", "12");
  if (url.searchParams.get("subject")) {
    const facets = await listCatalogMaterialFacets(db, undefined, librarian ? "librarian" : "public", "education");
    const canonical = facets.subjects.find((s) => normalizeCatalogSearchText(s) === normalizeCatalogSearchText(args.subject));
    if (canonical) url.searchParams.set("subject", canonical);
  }
  const options = { useFts: false, scope: librarian ? "librarian" as const : "public" as const, includeArchived: librarian && args.includeArchived === true };
  let query = parseCatalogListQuery(url, {
    defaultFund: "education",
    allowedFunds: ["education"],
  });
  let result = await listCatalogMaterials(db, query, options);
  let approximate = args.approximate === true;
  // Do not relax ID/ISBN, class, stock availability or an explicitly selected subject.
  if (!result.items.length && !query.cursor && !normalizeCatalogId(query.q) && !normalizeCatalogIsbn(query.q)) {
    for (const stems of [false, true]) {
      const next = { ...query, q: simplifyAssistantQuery(query.q, stems), title: simplifyAssistantQuery(query.title, stems) };
      if ((!next.q && query.q) || (!next.title && query.title) || (next.q === query.q && next.title === query.title)) continue;
      const candidate = await listCatalogMaterials(db, next, options);
      if (candidate.items.length) { query = next; result = candidate; approximate = stems; break; }
    }
  }
  return { ...result, approximate, checkedAt: new Date().toISOString(),
    effectiveQuery: { ...args, query: query.q, title: query.title, subject: query.subject, approximate, cursor: result.nextCursor ?? undefined },
    message: approximate ? "Знайдено можливі збіги за схожими словами. Уточніть автора й видання перед дією." : result.items.length ? "Дані перевірено безпосередньо в базі бібліотеки." : "За цими умовами збігів немає. Це не означає, що книги немає: уточніть назву, автора або фільтри." };
}
