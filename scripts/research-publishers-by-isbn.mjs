import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const mergedPath = path.resolve(process.argv[2] || ".migration-private/catalog-metadata-merged-20260829.json");
const outputPath = path.resolve(process.argv[3] || ".migration-private/catalog-publishers-by-isbn-20260829.json");
const progressPath = `${outputPath}.progress`;
const merged = JSON.parse(await readFile(mergedPath, "utf8"));
const targets = merged.records.flatMap((record) => {
  if (record.expected.publisher) return [];
  const isbnDecision = record.decisions.isbn;
  const isbn = isbnDecision.action === "set" || isbnDecision.action === "preserve_existing"
    ? compactIsbn(isbnDecision.selectedValue)
    : "";
  return validIsbn13(isbn) ? [{ materialId: record.materialId, title: record.expected.title, isbn }] : [];
});
const previous = existsSync(progressPath)
  ? JSON.parse(await readFile(progressPath, "utf8"))
  : { records: [] };
const records = new Map((previous.records ?? []).map((record) => [record.materialId, record]));
let requestGate = Promise.resolve();
let nextRequestAt = 0;
let saveChain = Promise.resolve();
let completedSinceSave = 0;
let nextLog = Math.ceil((records.size + 1) / 25) * 25;

await mapConcurrent(targets.filter((target) => !records.has(target.materialId)), 5, async (target) => {
  const candidates = [
    ...await googlePublishers(target.isbn),
    ...await openLibraryPublishers(target.isbn),
  ];
  records.set(target.materialId, {
    ...target,
    candidates: deduplicate(candidates),
  });
  completedSinceSave += 1;
  if (completedSinceSave >= 5) {
    completedSinceSave = 0;
    saveChain = saveChain.then(() => save(false));
  }
  if (records.size >= nextLog || records.size === targets.length) {
    nextLog += 25;
    console.log(JSON.stringify({
      completed: records.size,
      total: targets.length,
      withPublisher: [...records.values()].filter((record) => record.candidates.length).length,
    }));
  }
});
await saveChain;
await save(true);

async function googlePublishers(isbn) {
  const url = new URL("https://www.googleapis.com/books/v1/volumes");
  url.searchParams.set("q", `isbn:${isbn}`);
  url.searchParams.set("maxResults", "10");
  url.searchParams.set("projection", "full");
  const body = await fetchJson(url);
  return (body?.items ?? []).flatMap((item) => {
    const info = item?.volumeInfo;
    const identifiers = (info?.industryIdentifiers ?? []).map((entry) => compactIsbn(entry?.identifier));
    if (!identifiers.includes(isbn) || !text(info?.publisher)) return [];
    return [{
      value: text(info.publisher),
      provider: "google_books_isbn",
      sourceUrl: safeHttps(info.infoLink || info.canonicalVolumeLink || info.previewLink),
      sourceTitle: text(info.title),
      confidence: "probable",
    }];
  });
}

async function openLibraryPublishers(isbn) {
  const url = new URL("https://openlibrary.org/search.json");
  url.searchParams.set("isbn", isbn);
  url.searchParams.set("fields", "key,title,publisher,isbn");
  url.searchParams.set("limit", "10");
  const body = await fetchJson(url);
  return (body?.docs ?? []).flatMap((entry) => {
    const identifiers = stringArray(entry?.isbn).map(compactIsbn);
    if (!identifiers.includes(isbn)) return [];
    const key = text(entry.key);
    return stringArray(entry.publisher).flatMap((publisher) => text(publisher) ? [{
      value: text(publisher),
      provider: "open_library_isbn",
      sourceUrl: key.startsWith("/") ? `https://openlibrary.org${key}` : "",
      sourceTitle: text(entry.title),
      confidence: "probable",
    }] : []);
  });
}

async function fetchJson(url) {
  await serializeRequestStart();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "LyceumLibraryMetadataResearch/1.0" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function serializeRequestStart() {
  let release;
  const previous = requestGate;
  requestGate = new Promise((resolve) => { release = resolve; });
  await previous;
  const wait = Math.max(0, nextRequestAt - Date.now());
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  nextRequestAt = Date.now() + 320;
  release();
}

function deduplicate(values) {
  const output = new Map();
  for (const value of values) {
    const key = `${value.provider}|${value.value}|${value.sourceUrl}`;
    if (!output.has(key)) output.set(key, value);
  }
  return [...output.values()];
}

async function save(complete) {
  const ordered = targets.map((target) => records.get(target.materialId)).filter(Boolean);
  const document = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    complete,
    sourceMerge: path.basename(mergedPath),
    summary: {
      total: targets.length,
      researched: ordered.length,
      withPublisher: ordered.filter((record) => record.candidates.length).length,
      candidateCount: ordered.reduce((total, record) => total + record.candidates.length, 0),
    },
    records: ordered,
  };
  await writeFile(complete ? outputPath : progressPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

async function mapConcurrent(values, limit, mapper) {
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next++;
      await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
}

function compactIsbn(value) {
  return text(value).replace(/[^\d]/gu, "");
}

function validIsbn13(value) {
  if (!/^(?:978|979)\d{10}$/u.test(value)) return false;
  const sum = [...value.slice(0, 12)].reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return (10 - sum % 10) % 10 === Number(value[12]);
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function safeHttps(value) {
  try {
    const url = new URL(text(value));
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : "";
  } catch {
    return "";
  }
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
