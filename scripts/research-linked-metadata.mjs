import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const snapshotPath = path.resolve(
  process.argv[2] || ".migration-private/catalog-metadata-live-20260829.json",
);
const outputPath = path.resolve(
  process.argv[3] || ".migration-private/catalog-linked-metadata-20260829.json",
);
const progressPath = `${outputPath}.progress`;
const STOP_WORDS = new Set([
  "та", "і", "й", "у", "в", "на", "для", "до", "з", "із", "за",
  "the", "and", "for", "with", "book", "книга", "клас", "класи",
]);
const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
const materials = Array.isArray(snapshot.materials) ? snapshot.materials : [];
const previous = existsSync(progressPath)
  ? JSON.parse(await readFile(progressPath, "utf8"))
  : { records: [] };
const records = new Map(
  (previous.records ?? []).map((record) => [record.materialId, record]),
);
const targets = materials.filter((material) =>
  (!material.isbn || !material.publisher)
  && Array.isArray(material.links)
  && material.links.some((link) => safeHttps(link.url)),
);

let saveChain = Promise.resolve();
let sinceWrite = 0;
let nextLog = Math.ceil((records.size + 1) / 25) * 25;
await mapConcurrent(
  targets.filter((material) => !records.has(material.materialId)),
  4,
  async (material) => {
    const record = await researchLinks(material);
    records.set(material.materialId, record);
    sinceWrite += 1;
    if (sinceWrite >= 5) {
      sinceWrite = 0;
      saveChain = saveChain.then(() => save(false));
    }
    if (records.size >= nextLog || records.size === targets.length) {
      nextLog += 25;
      console.log(JSON.stringify({
        completed: records.size,
        total: targets.length,
        isbnProposals: [...records.values()].filter((item) => item.proposedIsbn).length,
        publisherProposals: [...records.values()].filter((item) => item.proposedPublisher).length,
      }));
    }
  },
);
await saveChain;
await save(true);

async function researchLinks(material) {
  const links = material.links
    .map((link) => ({ ...link, url: safeHttps(link.url) }))
    .filter((link) => link.url)
    .sort((left, right) => linkPriority(left.url) - linkPriority(right.url))
    .slice(0, 3);
  let best = null;
  for (const link of links) {
    const html = await fetchPage(link.url);
    if (!html) continue;
    const candidate = extractPageCandidate(html, link.url);
    const comparison = compareTitles(material.title, candidate.title);
    if (comparison.numericConflict || comparison.coverage < 0.42) continue;
    const scored = {
      ...candidate,
      score: comparison.coverage,
      confidence: candidate.structured && comparison.coverage >= 0.7
        ? "probable"
        : "doubtful",
    };
    if (!best
      || Number(Boolean(scored.isbn)) + Number(Boolean(scored.publisher))
        > Number(Boolean(best.isbn)) + Number(Boolean(best.publisher))
      || scored.score > best.score + 0.12) {
      best = scored;
    }
    if (best.isbn && best.publisher && best.confidence === "probable") break;
  }
  return {
    materialId: material.materialId,
    title: material.title,
    author: material.author,
    year: material.year,
    proposedIsbn: material.isbn ? "" : best?.isbn || "",
    proposedPublisher: material.publisher ? "" : best?.publisher || "",
    confidence: best?.confidence || "no_match",
    sourceUrl: best?.sourceUrl || "",
    sourceHost: best?.sourceHost || "",
    sourceTitle: best?.title || "",
    score: best ? Number(best.score.toFixed(4)) : null,
    reason: best
      ? "metadata extracted from the catalog-linked edition page"
      : "no non-conflicting ISBN or publisher metadata found on linked pages",
  };
}

function extractPageCandidate(html, sourceUrl) {
  const structured = structuredCandidates(html);
  const visible = visibleText(html);
  const title = structured.map((item) => item.title).find(Boolean)
    || metaContent(html, "og:title")
    || tagText(html, "title");
  const structuredIsbns = structured.flatMap((item) => item.isbns);
  const visibleIsbns = isbnCandidates(visible);
  const isbn = [...new Set([...structuredIsbns, ...visibleIsbns])].find(validIsbn13) || "";
  const publisher = structured.map((item) => item.publisher).find(validPublisher)
    || labeledPublisher(visible)
    || publisherFromFirstPartyDomain(sourceUrl)
    || "";
  return {
    title: clean(title),
    isbn,
    publisher: cleanPublisher(publisher),
    structured: Boolean(
      structuredIsbns.includes(isbn)
      || structured.some((item) => item.publisher === publisher),
    ),
    sourceUrl,
    sourceHost: new URL(sourceUrl).hostname.replace(/^www\./u, ""),
  };
}

function structuredCandidates(html) {
  const output = [];
  for (const match of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu,
  )) {
    try {
      const parsed = JSON.parse(decodeHtml(match[1]).trim());
      walkStructured(parsed, output);
    } catch {
      // Invalid third-party JSON-LD is ignored.
    }
  }
  return output;
}

function walkStructured(value, output) {
  if (Array.isArray(value)) {
    value.forEach((item) => walkStructured(item, output));
    return;
  }
  if (!value || typeof value !== "object") return;
  const type = clean(value["@type"]).toLocaleLowerCase("uk-UA");
  if (["book", "product", "creativework"].includes(type)) {
    // A shop's Product.brand/manufacturer often names the seller or another
    // commercial taxonomy. Only the explicit bibliographic publisher is safe.
    const publisher = entityName(value.publisher);
    output.push({
      title: clean(value.name || value.headline),
      publisher,
      isbns: [
        value.isbn,
        value.gtin13,
        value.gtin,
        value.productID,
        value.sku,
      ].flatMap((item) => isbnCandidates(clean(item))),
    });
  }
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object") walkStructured(nested, output);
  }
}

function entityName(value) {
  if (typeof value === "string") return cleanPublisher(decodeHtml(value));
  if (!value || typeof value !== "object") return "";
  return cleanPublisher(decodeHtml(value.name));
}

function visibleText(html) {
  return decodeHtml(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
      .replace(/<[^>]+>/gu, "\n"),
  ).replace(/[ \t]+/gu, " ").replace(/\n{2,}/gu, "\n");
}

function labeledPublisher(value) {
  const patterns = [
    /(?:Видавництво|Видавець)\s*:?\s*\n?\s*([^\n|]{2,100})/iu,
    /(?:Publisher|Publishing house)\s*:?\s*\n?\s*([^\n|]{2,100})/iu,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    const candidate = cleanPublisher(match?.[1]);
    if (validPublisher(candidate)) return candidate;
  }
  return "";
}

function publisherFromFirstPartyDomain(value) {
  const host = new URL(value).hostname.replace(/^www\./u, "");
  const mappings = {
    "ranok.com.ua": "Ранок",
    "aston.te.ua": "Астон",
    "geneza.ua": "Генеза",
    "gramota.kiev.ua": "Грамота",
    "osvita-dim.com.ua": "Освіта",
    "bohdan-books.com": "Навчальна книга — Богдан",
  };
  return mappings[host] || "";
}

function isbnCandidates(value) {
  const output = [];
  for (const match of clean(value).matchAll(/(?:97[89])(?:[\s-]*\d){10}/gu)) {
    const isbn = match[0].replace(/[^\d]/gu, "");
    if (validIsbn13(isbn)) output.push(isbn);
  }
  return [...new Set(output)];
}

function compareTitles(catalogTitle, sourceTitle) {
  const catalogTokens = tokens(catalogTitle);
  const sourceTokens = tokens(sourceTitle);
  const sourceSet = new Set(sourceTokens);
  const coverage = catalogTokens.length
    ? catalogTokens.filter((token) => sourceSet.has(token)).length / catalogTokens.length
    : 0;
  const catalogNumbers = numbers(catalogTitle);
  const sourceNumbers = numbers(sourceTitle);
  const numericConflict = catalogNumbers.length > 0
    && sourceNumbers.length > 0
    && catalogNumbers.some((number) => !sourceNumbers.includes(number));
  return { coverage, numericConflict };
}

function linkPriority(value) {
  const host = new URL(value).hostname.replace(/^www\./u, "");
  const order = [
    "yakaboo.ua", "balka-book.com", "knigoland.com.ua", "ranok.com.ua",
    "aston.te.ua", "book-ye.com.ua", "mybook.biz.ua", "megakniga.com.ua",
    "shkola.in.ua", "rozetka.com.ua",
  ];
  const index = order.indexOf(host);
  return index >= 0 ? index : order.length;
}

async function fetchPage(url) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "uk-UA,uk;q=0.9,en;q=0.6",
          "User-Agent": "LyceumLibraryMetadataResearch/1.0 (school library catalog)",
        },
        redirect: "follow",
        signal: controller.signal,
      });
      if (!response.ok) return "";
      const declared = Number(response.headers.get("content-length") || 0);
      if (declared > 3 * 1024 * 1024) return "";
      const text = await response.text();
      return text.length <= 3 * 1024 * 1024 ? text : "";
    } catch {
      if (attempt === 1) return "";
    } finally {
      clearTimeout(timer);
    }
  }
  return "";
}

async function save(complete) {
  const ordered = targets
    .map((material) => records.get(material.materialId))
    .filter(Boolean);
  const document = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    complete,
    sourceSnapshot: path.basename(snapshotPath),
    summary: {
      total: targets.length,
      researched: ordered.length,
      isbnProposals: ordered.filter((item) => item.proposedIsbn).length,
      publisherProposals: ordered.filter((item) => item.proposedPublisher).length,
      probable: ordered.filter((item) => item.confidence === "probable").length,
      doubtful: ordered.filter((item) => item.confidence === "doubtful").length,
      noMatch: ordered.filter((item) => item.confidence === "no_match").length,
    },
    records: ordered,
  };
  await writeFile(
    complete ? outputPath : progressPath,
    `${JSON.stringify(document, null, 2)}\n`,
    "utf8",
  );
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

function metaContent(html, property) {
  const escaped = property
    .replace(/[.*+?^()|[\]\\{}]/gu, "\\$&")
    .replaceAll("$", "\\$");
  const patterns = [
    new RegExp(`<meta\\b[^>]*(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']+)["'][^>]*>`, "iu"),
    new RegExp(`<meta\\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${escaped}["'][^>]*>`, "iu"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeHtml(match[1]);
  }
  return "";
}

function tagText(html, tag) {
  const match = html.match(new RegExp(
    `<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`,
    "iu",
  ));
  return match ? decodeHtml(match[1].replace(/<[^>]+>/gu, " ")) : "";
}

function decodeHtml(value) {
  return clean(value)
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&ndash;/giu, "–")
    .replace(/&mdash;/giu, "—")
    .replace(/&#(\d+);/gu, (_match, code) => String.fromCodePoint(Number(code)));
}

function cleanPublisher(value) {
  return clean(value)
    .replace(/&laquo;|&raquo;/giu, '"')
    .replace(/\s+/gu, " ")
    .replace(/^[-–—:;,\s]+|[-–—:;,\s]+$/gu, "")
    .slice(0, 160);
}

function validPublisher(value) {
  const normalized = cleanPublisher(value);
  const words = normalized.split(/\s+/u).filter(Boolean);
  return normalized.length >= 2
    && normalized.length <= 160
    && words.length <= 10
    && !/[{}<>]/u.test(normalized)
    && !/(?:including|cookies?|privacy|маркетинг|реклама|стартап|yen press)/iu.test(normalized)
    && !/^(?:book|product|книга|паперова книга|купити|немає|не вказано|рік видання|мова|автор|isbn|формат|обкладинка|кількість сторінок|вік|країна|pidruchnyk|підручник)$/iu.test(normalized)
    && !/\b(?:bookshop|marketplace|інтернет-магазин|книгарня)\b/iu.test(normalized);
}

function tokens(value) {
  return clean(value).normalize("NFKC").toLocaleLowerCase("uk-UA")
    .replace(/[’']/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim().split(/\s+/u)
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function numbers(value) {
  return [...new Set(clean(value).match(/\d+/gu) ?? [])];
}

function safeHttps(value) {
  try {
    const url = new URL(clean(value));
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : "";
  } catch {
    return "";
  }
}

function validIsbn13(value) {
  if (!/^(?:978|979)\d{10}$/u.test(value)) return false;
  const sum = [...value.slice(0, 12)].reduce(
    (total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return (10 - (sum % 10)) % 10 === Number(value[12]);
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}
