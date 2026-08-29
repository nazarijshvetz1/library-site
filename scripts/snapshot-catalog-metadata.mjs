import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const apiBase = normalizeBase(
  process.argv[2]
    || "https://yedyna-biblioteka-liceiu.nazarijshvetz1.chatgpt.site/api/catalog-v2",
);
const output = path.resolve(
  process.argv[3] || ".migration-private/catalog-metadata-live.json",
);

const summaries = await fetchCatalog();
const materials = await mapConcurrent(summaries, 10, async (summary) => {
  const response = await fetch(`${apiBase}/${encodeURIComponent(summary.id)}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "LyceumLibraryMetadataAudit/1.0",
    },
  });
  if (!response.ok) throw new Error(`${summary.id}: detail HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.success !== true || payload?.material?.id !== summary.id) {
    throw new Error(`${summary.id}: invalid detail response`);
  }
  const material = payload.material;
  return {
    materialId: text(material.id),
    title: text(material.title),
    author: text(material.author),
    year: integerOrNull(material.year),
    isbn: compactIsbn(material.isbn),
    publisher: text(material.publisher),
    publicationType: text(material.publicationType),
    subject: text(material.subject),
    rubric: text(material.rubric),
    classFrom: integerOrNull(material.classFrom),
    classTo: integerOrNull(material.classTo),
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
  fetchedAt: new Date().toISOString(),
  source: apiBase,
  summary: {
    activeMaterials: materials.length,
    materialsWithIsbn: materials.filter((item) => item.isbn).length,
    materialsMissingIsbn: materials.filter((item) => !item.isbn).length,
    materialsWithPublisher: materials.filter((item) => item.publisher).length,
    materialsMissingPublisher: materials.filter((item) => !item.publisher).length,
    physicalCopies: materials.reduce((sum, item) => sum + item.totalQuantity, 0),
  },
  materials,
};

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, ...snapshot.summary }));

async function fetchCatalog() {
  const items = [];
  let cursor = "";
  do {
    const url = new URL(apiBase);
    url.searchParams.set("limit", "48");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "LyceumLibraryMetadataAudit/1.0",
      },
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
  const outputRows = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next++;
      outputRows[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return outputRows;
}

function normalizeBase(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("API base must be public HTTPS");
  }
  return url.toString().replace(/\/$/u, "");
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(text(value));
    return url.protocol === "https:" && !url.username && !url.password
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

function compactIsbn(value) {
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
