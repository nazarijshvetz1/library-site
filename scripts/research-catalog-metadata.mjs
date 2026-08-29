import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const privateRoot = path.resolve(".migration-private");
const snapshotPath = path.resolve(
  process.argv[2] || path.join(privateRoot, "catalog-metadata-live-20260829.json"),
);
const outputPath = path.resolve(
  process.argv[3] || path.join(privateRoot, "catalog-metadata-research.json"),
);
const progressPath = `${outputPath}.progress`;
const candidatePaths = [
  path.join(privateRoot, "isbn-url-candidates.json"),
  path.join(privateRoot, "isbn-yakaboo-candidates.json"),
  path.join(privateRoot, "isbn-official-candidates.json"),
  path.join(privateRoot, "isbn-url-candidates-auto.json"),
];
const REQUEST_INTERVAL_MS = 360;
const STOP_WORDS = new Set([
  "та", "і", "й", "у", "в", "на", "для", "до", "з", "із", "за",
  "the", "and", "for", "with", "book", "клас", "класи",
]);

const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
const materials = Array.isArray(snapshot.materials) ? snapshot.materials : [];
const isbnSeeds = await loadIsbnSeeds(materials);
const previous = existsSync(progressPath)
  ? JSON.parse(await readFile(progressPath, "utf8"))
  : { records: [] };
const records = new Map(
  (previous.records ?? []).map((record) => [record.materialId, record]),
);

let nextRequestAt = 0;
let requestGate = Promise.resolve();
let completedSinceWrite = 0;
let saveChain = Promise.resolve();
let nextProgressLog = Math.ceil((records.size + 1) / 25) * 25;
const pendingMaterials = materials
  .filter((material) => !records.has(material.materialId));
await mapConcurrent(pendingMaterials, 6, async (material) => {
  const record = await researchMaterial(material, isbnSeeds.get(material.materialId));
  records.set(material.materialId, record);
  completedSinceWrite += 1;
  if (completedSinceWrite >= 5) {
    completedSinceWrite = 0;
    saveChain = saveChain.then(() => save(progressPath, materials, records, false));
  }
  if (records.size >= nextProgressLog || records.size === materials.length) {
    nextProgressLog += 25;
    console.log(JSON.stringify({
      completed: records.size,
      total: materials.length,
      materialId: material.materialId,
      isbnProposals: [...records.values()].filter((item) => !item.currentIsbn && item.proposedIsbn).length,
      publisherProposals: [...records.values()].filter((item) => !item.currentPublisher && item.proposedPublisher).length,
    }));
  }
});

await saveChain;
await save(outputPath, materials, records, true);
await save(progressPath, materials, records, true);

async function researchMaterial(material, seed) {
  const currentIsbn = validIsbn13(material.isbn) ? compactIsbn(material.isbn) : "";
  const currentPublisher = text(material.publisher);
  const seededIsbn = currentIsbn || seed?.isbn || "";
  let chosen = null;

  if (seededIsbn && (!currentPublisher || !currentIsbn)) {
    const isbnCandidates = await lookupGoogleByIsbn(seededIsbn);
    chosen = bestCandidate(material, isbnCandidates);
    if (!chosen || (!chosen.publisher && !chosen.isbn)) {
      const openCandidates = await lookupOpenLibraryByIsbn(seededIsbn);
      chosen = betterChoice(chosen, bestCandidate(material, openCandidates));
    }
  }

  if ((!seededIsbn || !currentPublisher) && (!chosen?.isbn || !chosen?.publisher)) {
    const googleCandidates = await lookupGoogleByTitle(material);
    chosen = betterChoice(chosen, bestCandidate(material, googleCandidates));
    if (!chosen || (!chosen.publisher && !chosen.isbn) || chosen.score < 0.72) {
      const openCandidates = await lookupOpenLibraryByTitle(material);
      chosen = betterChoice(chosen, bestCandidate(material, openCandidates));
    }
  }

  const proposedIsbn = currentIsbn
    || seededIsbn
    || (chosen && chosen.score >= 0.45 && !chosen.numericConflict ? chosen.isbn : "")
    || "";
  const proposedPublisher = currentPublisher
    || (chosen && chosen.score >= 0.45 && !chosen.numericConflict ? chosen.publisher : "")
    || "";
  const sourceUrl = seed?.sourceUrl || chosen?.sourceUrl || "";
  const sourceProvider = seed?.sourceProvider || chosen?.provider || "";
  const confidence = currentIsbn && currentPublisher
    ? "existing"
    : seed?.confidence === "exact" && (!chosen || chosen.score >= 0.72)
      ? "exact"
      : chosen?.score >= 0.72
        ? "probable"
        : proposedIsbn || proposedPublisher
          ? "doubtful"
          : "no_match";

  return {
    materialId: material.materialId,
    title: material.title,
    author: material.author,
    year: material.year,
    currentIsbn,
    currentPublisher,
    proposedIsbn,
    proposedPublisher,
    confidence,
    sourceUrl,
    sourceProvider,
    score: chosen ? Number(chosen.score.toFixed(4)) : null,
    isbnSeed: seed?.kind || (currentIsbn ? "existing" : ""),
    matchTitle: chosen?.title || "",
    matchAuthors: chosen?.authors || [],
    matchYear: chosen?.year ?? null,
    reason: proposedIsbn || proposedPublisher
      ? "best non-conflicting bibliographic match"
      : "no checksum-valid ISBN or publisher found without a contradictory edition match",
  };
}

async function lookupGoogleByIsbn(isbn) {
  const url = new URL("https://www.googleapis.com/books/v1/volumes");
  url.searchParams.set("q", `isbn:${isbn}`);
  url.searchParams.set("maxResults", "10");
  url.searchParams.set("projection", "full");
  const body = await fetchJson(url);
  return googleCandidates(body);
}

async function lookupGoogleByTitle(material) {
  const url = new URL("https://www.googleapis.com/books/v1/volumes");
  const author = text(material.author);
  url.searchParams.set(
    "q",
    `intitle:"${text(material.title)}"${author ? ` inauthor:"${author}"` : ""}`,
  );
  url.searchParams.set("maxResults", "10");
  url.searchParams.set("projection", "full");
  const body = await fetchJson(url);
  return googleCandidates(body);
}

async function lookupOpenLibraryByIsbn(isbn) {
  const url = new URL("https://openlibrary.org/search.json");
  url.searchParams.set("isbn", isbn);
  openLibraryFields(url);
  const body = await fetchJson(url);
  return openLibraryCandidates(body);
}

async function lookupOpenLibraryByTitle(material) {
  const url = new URL("https://openlibrary.org/search.json");
  url.searchParams.set("title", text(material.title));
  if (material.author) url.searchParams.set("author", text(material.author));
  openLibraryFields(url);
  const body = await fetchJson(url);
  return openLibraryCandidates(body);
}

function openLibraryFields(url) {
  url.searchParams.set(
    "fields",
    "key,title,author_name,publisher,first_publish_year,publish_year,isbn",
  );
  url.searchParams.set("limit", "10");
}

function googleCandidates(body) {
  if (!body || !Array.isArray(body.items)) return [];
  return body.items.flatMap((item) => {
    const info = item?.volumeInfo;
    if (!info || !text(info.title)) return [];
    return [{
      title: text(info.title),
      authors: stringArray(info.authors),
      year: readYear(info.publishedDate),
      isbn: preferredIsbn(info.industryIdentifiers),
      publisher: text(info.publisher),
      sourceUrl: safeHttps(info.infoLink || info.canonicalVolumeLink || info.previewLink),
      provider: "google_books",
    }];
  });
}

function openLibraryCandidates(body) {
  if (!body || !Array.isArray(body.docs)) return [];
  return body.docs.flatMap((entry) => {
    if (!text(entry?.title)) return [];
    const key = text(entry.key);
    return [{
      title: text(entry.title),
      authors: stringArray(entry.author_name),
      year: readYear(entry.first_publish_year)
        || stringArray(entry.publish_year).map(Number).find((year) => validYear(year))
        || null,
      isbn: stringArray(entry.isbn).map(compactIsbn).find(validIsbn13) || "",
      publisher: stringArray(entry.publisher)[0] || "",
      sourceUrl: key.startsWith("/") ? `https://openlibrary.org${key}` : "",
      provider: "open_library",
    }];
  });
}

function bestCandidate(material, candidates) {
  return candidates
    .map((candidate) => ({ ...candidate, ...scoreCandidate(material, candidate) }))
    .filter((candidate) => !candidate.numericConflict && candidate.score >= 0.45)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (Boolean(right.isbn) !== Boolean(left.isbn)) return Number(Boolean(right.isbn)) - Number(Boolean(left.isbn));
      return Number(Boolean(right.publisher)) - Number(Boolean(left.publisher));
    })[0] || null;
}

function betterChoice(current, next) {
  if (!current) return next;
  if (!next) return current;
  if (next.score > current.score + 0.04) return next;
  if (Math.abs(next.score - current.score) <= 0.04) {
    if (!current.publisher && next.publisher) return next;
    if (!current.isbn && next.isbn) return next;
  }
  return current;
}

function scoreCandidate(material, candidate) {
  const catalogTokens = tokens(material.title);
  const candidateTokens = tokens(candidate.title);
  const titleCoverage = coverage(catalogTokens, candidateTokens);
  const reverseCoverage = coverage(candidateTokens, catalogTokens);
  const catalogNumbers = numbers(material.title);
  const candidateNumbers = numbers(candidate.title);
  const numericConflict = catalogNumbers.length > 0
    && candidateNumbers.length > 0
    && catalogNumbers.some((value) => !candidateNumbers.includes(value));
  const authorTokens = tokens(material.author);
  const candidateAuthorTokens = tokens(candidate.authors.join(" "));
  const authorCoverage = authorTokens.length
    ? coverage(authorTokens, candidateAuthorTokens)
    : 0.5;
  const year = Number(material.year);
  const yearAgreement = validYear(year) && validYear(candidate.year)
    ? Math.abs(year - candidate.year) <= 1 ? 1 : Math.abs(year - candidate.year) <= 3 ? 0.45 : 0
    : 0.5;
  const score = Math.max(0, Math.min(1,
    titleCoverage * 0.52
      + reverseCoverage * 0.16
      + authorCoverage * 0.2
      + yearAgreement * 0.12
      - (numericConflict ? 0.75 : 0),
  ));
  return { score, numericConflict };
}

async function loadIsbnSeeds(catalogMaterials) {
  const missing = new Set(
    catalogMaterials.filter((item) => !validIsbn13(compactIsbn(item.isbn)))
      .map((item) => item.materialId),
  );
  const byMaterial = new Map();
  for (const candidatePath of candidatePaths) {
    if (!existsSync(candidatePath)) continue;
    const document = JSON.parse(await readFile(candidatePath, "utf8"));
    const rows = document.records ?? document.items ?? document.candidates ?? [];
    for (const item of rows) {
      const materialId = text(item.materialId ?? item.material_id);
      if (!missing.has(materialId)) continue;
      const candidates = [];
      addCandidate(candidates, item.isbn13 ?? item.proposedIsbn13 ?? item.isbn, item.sourceUrl ?? item.evidenceUrl ?? item.url);
      for (const nested of item.candidates ?? []) {
        addCandidate(candidates, nested.isbn13 ?? nested.isbn, nested.sourceUrl ?? nested.evidenceUrl ?? nested.url);
      }
      for (const candidate of candidates) {
        const list = byMaterial.get(materialId) ?? [];
        if (!list.some((entry) => entry.isbn === candidate.isbn)) {
          list.push({
            ...candidate,
            status: text(item.status),
            sourceProvider: path.basename(candidatePath),
          });
        }
        byMaterial.set(materialId, list);
      }
    }
  }
  const selected = new Map();
  for (const [materialId, candidates] of byMaterial) {
    const distinct = [...new Map(candidates.map((item) => [item.isbn, item])).values()];
    if (distinct.length !== 1) continue;
    const candidate = distinct[0];
    selected.set(materialId, {
      isbn: candidate.isbn,
      sourceUrl: candidate.sourceUrl,
      sourceProvider: candidate.sourceProvider,
      confidence: /^(?:exact|exact_candidate|exact_url_evidence|verified)$/u.test(candidate.status)
        ? "exact"
        : "doubtful",
      kind: "evidence_candidate",
    });
  }
  return selected;
}

function addCandidate(output, value, sourceUrl) {
  const isbn = compactIsbn(value);
  if (!validIsbn13(isbn)) return;
  output.push({ isbn, sourceUrl: safeHttps(sourceUrl) });
}

function preferredIsbn(identifiers) {
  if (!Array.isArray(identifiers)) return "";
  const values = identifiers
    .map((identifier) => compactIsbn(identifier?.identifier))
    .filter(validIsbn13);
  return values.find((value) => value.startsWith("978") || value.startsWith("979"))
    || values[0]
    || "";
}

async function fetchJson(url) {
  await requestSlot();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "LyceumLibraryMetadataResearch/1.0 (school library catalog)",
        },
        signal: controller.signal,
      });
      if (response.ok) return await response.json();
      if (![429, 500, 502, 503, 504].includes(response.status)) return null;
    } catch {
      // Retry bounded transient network failures.
    } finally {
      clearTimeout(timer);
    }
    await delay(750 * (attempt + 1));
  }
  return null;
}

async function requestSlot() {
  let release;
  const previous = requestGate;
  requestGate = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  const waitMs = Math.max(0, nextRequestAt - Date.now());
  if (waitMs) await delay(waitMs);
  nextRequestAt = Date.now() + REQUEST_INTERVAL_MS;
  release();
}

async function mapConcurrent(values, limit, mapper) {
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next++;
      await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(limit, values.length) },
    worker,
  ));
}

async function save(target, sourceMaterials, recordMap, complete) {
  const ordered = sourceMaterials
    .map((material) => recordMap.get(material.materialId))
    .filter(Boolean);
  const document = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    complete,
    sourceSnapshot: path.basename(snapshotPath),
    summary: {
      total: sourceMaterials.length,
      researched: ordered.length,
      isbnProposals: ordered.filter((item) => !item.currentIsbn && item.proposedIsbn).length,
      publisherProposals: ordered.filter((item) => !item.currentPublisher && item.proposedPublisher).length,
      exact: ordered.filter((item) => item.confidence === "exact").length,
      probable: ordered.filter((item) => item.confidence === "probable").length,
      doubtful: ordered.filter((item) => item.confidence === "doubtful").length,
      noMatch: ordered.filter((item) => item.confidence === "no_match").length,
    },
    records: ordered,
  };
  await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

function tokens(value) {
  return text(value).normalize("NFKC").toLocaleLowerCase("uk-UA")
    .replace(/[’']/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim().split(/\s+/u)
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function numbers(value) {
  return [...new Set(text(value).match(/\d+/gu) ?? [])];
}

function coverage(left, right) {
  if (!left.length) return 0;
  const rightSet = new Set(right);
  return left.filter((token) => rightSet.has(token)).length / left.length;
}

function compactIsbn(value) {
  return text(value).toUpperCase().replace(/[^0-9X]/gu, "");
}

function validIsbn13(value) {
  if (!/^(?:978|979)\d{10}$/u.test(value)) return false;
  const sum = [...value.slice(0, 12)].reduce(
    (total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return (10 - (sum % 10)) % 10 === Number(value[12]);
}

function safeHttps(value) {
  try {
    const url = new URL(text(value));
    return url.protocol === "https:" && !url.username && !url.password
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.map(text).filter(Boolean)
    : [];
}

function readYear(value) {
  const match = text(value).match(/\b(1\d{3}|20\d{2}|21\d{2})\b/u);
  return match ? Number(match[1]) : null;
}

function validYear(value) {
  return Number.isInteger(Number(value)) && Number(value) >= 1000 && Number(value) <= 2200;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
