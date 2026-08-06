import { normalizeIsbn } from "./isbn.ts";

export type BookLookupCandidate = {
  isbn: string;
  title: string;
  authors: string[];
  publisher: string;
  publishedYear: number | null;
  coverUrl: string;
  sourceUrl: string;
  provider: "google_books" | "open_library";
};

const LOOKUP_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export async function lookupBookByIsbn(
  rawIsbn: string,
  fetcher: typeof fetch = fetch,
): Promise<BookLookupCandidate[]> {
  const isbn = normalizeIsbn(rawIsbn);
  if (!isbn) return [];

  const results = await Promise.allSettled([
    lookupGoogleBooks(isbn, fetcher),
    lookupOpenLibrary(isbn, fetcher),
  ]);

  const candidates = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  const unique = new Map<string, BookLookupCandidate>();
  for (const candidate of candidates) {
    const key = [candidate.title.toLocaleLowerCase("uk-UA"), candidate.authors.join("|")].join("|");
    const existing = unique.get(key);
    if (!existing || (!existing.coverUrl && candidate.coverUrl)) {
      unique.set(key, candidate);
    }
  }
  return [...unique.values()].slice(0, 5);
}

async function lookupGoogleBooks(
  isbn: string,
  fetcher: typeof fetch,
): Promise<BookLookupCandidate[]> {
  const url = new URL("https://www.googleapis.com/books/v1/volumes");
  url.searchParams.set("q", `isbn:${isbn}`);
  url.searchParams.set("maxResults", "5");
  url.searchParams.set("projection", "lite");

  const body = await fetchJson(url, fetcher);
  if (!isRecord(body) || !Array.isArray(body.items)) return [];

  return body.items.flatMap((item) => {
    if (!isRecord(item) || !isRecord(item.volumeInfo)) return [];
    const info = item.volumeInfo;
    const title = readString(info.title, 300);
    if (!title) return [];

    const authors = readStringArray(info.authors, 12, 160);
    const imageLinks = isRecord(info.imageLinks) ? info.imageLinks : {};
    return [{
      isbn,
      title,
      authors,
      publisher: readString(info.publisher, 200),
      publishedYear: readYear(info.publishedDate),
      coverUrl: safeExternalUrl(
        imageLinks.extraLarge
          ?? imageLinks.large
          ?? imageLinks.medium
          ?? imageLinks.thumbnail
          ?? imageLinks.smallThumbnail,
        true,
      ),
      sourceUrl: safeExternalUrl(info.infoLink ?? info.previewLink, false),
      provider: "google_books" as const,
    }];
  });
}

async function lookupOpenLibrary(
  isbn: string,
  fetcher: typeof fetch,
): Promise<BookLookupCandidate[]> {
  const url = new URL("https://openlibrary.org/search.json");
  url.searchParams.set("isbn", isbn);
  url.searchParams.set(
    "fields",
    "key,title,author_name,publisher,first_publish_year,isbn,cover_i",
  );
  url.searchParams.set("limit", "5");

  const body = await fetchJson(url, fetcher);
  if (!isRecord(body) || !Array.isArray(body.docs)) return [];

  return body.docs.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const title = readString(entry.title, 300);
    if (!title) return [];
    const key = readString(entry.key, 120);
    const coverId = readInteger(entry.cover_i);

    return [{
      isbn,
      title,
      authors: readStringArray(entry.author_name, 12, 160),
      publisher: readStringArray(entry.publisher, 1, 200)[0] ?? "",
      publishedYear: readYear(entry.first_publish_year),
      coverUrl: coverId
        ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`
        : "",
      sourceUrl: key ? `https://openlibrary.org${key}` : "",
      provider: "open_library" as const,
    }];
  });
}

async function fetchJson(
  url: URL,
  fetcher: typeof fetch,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      headers: { Accept: "application/json" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Lookup failed with HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_RESPONSE_BYTES) throw new Error("Lookup response is too large");
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      throw new Error("Lookup response is too large");
    }
    return JSON.parse(text) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function safeExternalUrl(value: unknown, upgradeToHttps: boolean): string {
  if (typeof value !== "string" || value.length > 2_048) return "";
  try {
    const url = new URL(value);
    if (upgradeToHttps && url.protocol === "http:") url.protocol = "https:";
    if (url.protocol !== "https:" || url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function readString(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function readStringArray(value: unknown, limit: number, maximum: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => readString(entry, maximum))
    .filter(Boolean)
    .slice(0, limit);
}

function readInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function readYear(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1000 && value <= 2200 ? value : null;
  }
  if (typeof value !== "string") return null;
  const match = value.match(/\b(1\d{3}|20\d{2}|21\d{2})\b/);
  return match ? Number(match[1]) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
