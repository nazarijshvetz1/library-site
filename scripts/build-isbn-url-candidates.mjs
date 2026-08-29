import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeIsbn } from "../lib/isbn.ts";

const input = path.resolve(process.argv[2] || ".migration-private/isbn-live-snapshot.json");
const output = path.resolve(process.argv[3] || ".migration-private/isbn-url-candidates.json");
const snapshot = JSON.parse(await readFile(input, "utf8"));
const existing = new Map((snapshot.existingIsbns ?? []).map((item) => [isbn13(item.isbn), item.materialId]));
const discovered = [];

for (const material of snapshot.items ?? []) {
  const evidence = [];
  for (const link of material.links ?? []) {
    const candidates = isbnCandidatesFromUrl(link.url);
    for (const candidate of candidates) {
      evidence.push({ url: link.url, sourceKind: link.kind, extracted: candidate });
    }
  }
  const unique = [...new Set(evidence.map((item) => item.extracted))];
  if (unique.length === 0) continue;
  const existingOwners = unique.map((isbn) => existing.get(isbn)).filter(Boolean);
  discovered.push({
    materialId: material.materialId,
    title: material.title,
    author: material.author,
    year: material.year,
    publicationType: material.publicationType,
    classFrom: material.classFrom,
    classTo: material.classTo,
    totalQuantity: material.totalQuantity,
    proposedIsbn13: unique.length === 1 ? unique[0] : "",
    evidence,
    status: unique.length > 1
      ? "ambiguous_multiple_isbns"
      : existingOwners.length > 0
        ? "conflict_existing_material"
        : "exact_url_evidence",
    conflictMaterialIds: existingOwners,
  });
}

const byIsbn = new Map();
for (const item of discovered.filter((item) => item.proposedIsbn13)) {
  const ids = byIsbn.get(item.proposedIsbn13) ?? [];
  ids.push(item.materialId);
  byIsbn.set(item.proposedIsbn13, ids);
}
for (const item of discovered) {
  const ids = byIsbn.get(item.proposedIsbn13) ?? [];
  if (item.status === "exact_url_evidence" && ids.length > 1) {
    item.status = "ambiguous_duplicate_materials";
    item.conflictMaterialIds = ids.filter((id) => id !== item.materialId);
  }
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  input,
  summary: Object.fromEntries([...new Set(discovered.map((item) => item.status))]
    .sort()
    .map((status) => [status, discovered.filter((item) => item.status === status).length])),
  items: discovered,
};
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, total: discovered.length, ...report.summary }));

function isbnCandidatesFromUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return [];
  }
  const decoded = decodeURIComponent(`${url.pathname} ${url.search}`);
  const raw = [];
  for (const key of ["isbn", "ISBN", "ean", "EAN", "productID"]) {
    const value = url.searchParams.get(key);
    if (value) raw.push(value);
  }
  for (const match of decoded.matchAll(/(?:isbn[-_:/= ]*|\/dp\/)(\d(?:[\d\s-]{8,18})[\dXx])/gu)) {
    raw.push(match[1]);
  }
  for (const match of decoded.matchAll(/(97[89](?:[\d\s-]{9,18})\d)/gu)) {
    raw.push(match[1]);
  }
  return [...new Set(raw.map((candidate) => isbn13(candidate)).filter(Boolean))];
}

function isbn13(value) {
  const normalized = normalizeIsbn(String(value ?? ""));
  if (!normalized) return "";
  if (normalized.length === 13) return normalized;
  const body = `978${normalized.slice(0, 9)}`;
  const sum = [...body].reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return `${body}${(10 - (sum % 10)) % 10}`;
}
