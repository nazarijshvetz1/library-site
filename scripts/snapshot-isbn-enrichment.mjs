import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const apiBase = normalizeBase(process.argv[2] || "https://yedyna-biblioteka-liceiu.nazarijshvetz1.chatgpt.site/api/catalog-v2");
const output = path.resolve(process.argv[3] || ".migration-private/isbn-live-snapshot.json");
const fetchedAt = new Date().toISOString();

const summaries = await fetchCatalog();
const missing = summaries.filter((item) => !cleanIsbn(item.isbn));
const details = await mapConcurrent(missing, 10, async (item) => {
  const response = await fetch(`${apiBase}/${encodeURIComponent(item.id)}`, {
    headers: { Accept: "application/json", "User-Agent": "LibraryISBNEnrichment/1.0" },
  });
  if (!response.ok) throw new Error(`${item.id}: detail HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.success !== true || payload?.material?.id !== item.id) {
    throw new Error(`${item.id}: invalid detail response`);
  }
  const material = payload.material;
  return {
    materialId: material.id,
    title: text(material.title),
    author: text(material.author),
    year: integerOrNull(material.year),
    publicationType: text(material.publicationType),
    subject: text(material.subject),
    rubric: text(material.rubric),
    classFrom: integerOrNull(material.classFrom),
    classTo: integerOrNull(material.classTo),
    publisher: text(material.publisher),
    totalQuantity: nonNegative(material.totalQuantity),
    links: Array.isArray(material.links)
      ? material.links.map((link) => ({
          kind: text(link.kind),
          label: text(link.label),
          url: safeHttpsUrl(link.url),
        })).filter((link) => link.url)
      : [],
  };
});

const snapshot = {
  schemaVersion: 1,
  fetchedAt,
  source: apiBase,
  summary: {
    activeMaterials: summaries.length,
    materialsWithIsbn: summaries.length - missing.length,
    materialsMissingIsbn: details.length,
    physicalCopiesMissingIsbn: details.reduce((sum, item) => sum + item.totalQuantity, 0),
    textbooksMissingIsbn: details.filter((item) => item.publicationType === "Підручник").length,
    linkedMissingIsbn: details.filter((item) => item.links.length > 0).length,
  },
  existingIsbns: summaries.filter((item) => cleanIsbn(item.isbn)).map((item) => ({
    materialId: text(item.id),
    isbn: cleanIsbn(item.isbn),
  })),
  items: details,
};

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, ...snapshot.summary }));

async function fetchCatalog() {
  const items = [];
  let cursor = "";
  do {
    const url = new URL(apiBase);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "LibraryISBNEnrichment/1.0" },
    });
    if (!response.ok) throw new Error(`catalog HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.success !== true || !Array.isArray(payload.items)) {
      throw new Error("invalid catalog response");
    }
    items.push(...payload.items);
    cursor = payload.page?.hasMore ? text(payload.page.nextCursor) : "";
    if (payload.page?.hasMore && !cursor) throw new Error("catalog cursor missing");
  } while (cursor);
  return items;
}

async function mapConcurrent(values, limit, mapper) {
  const output = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next++;
      output[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return output;
}

function normalizeBase(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("API base must be public HTTPS");
  return url.toString().replace(/\/$/u, "");
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(text(value));
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : "";
  } catch {
    return "";
  }
}

function cleanIsbn(value) {
  return text(value).toUpperCase().replace(/[\s-]+/gu, "");
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function integerOrNull(value) {
  return Number.isInteger(Number(value)) ? Number(value) : null;
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}
