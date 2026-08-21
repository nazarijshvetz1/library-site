import { authorizeLibrarianApi, librarianError } from "@/lib/librarian-api";

export const dynamic = "force-dynamic";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_HOSTS = new Set([
  "books.google.com",
  "books.googleusercontent.com",
  "covers.openlibrary.org",
]);
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function GET(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  const rawUrl = new URL(request.url).searchParams.get("url") ?? "";
  const source = safeImageUrl(rawUrl);
  if (!source) {
    return librarianError(400, "remote_cover_not_allowed", "Дозволені лише обкладинки Google Books та Open Library.", authorization.value.access.writesEnabled);
  }
  try {
    const { bytes, contentType } = await readAllowedImage(source);
    return new Response(bytes, {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": contentType,
        "Content-Length": String(bytes.byteLength),
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return librarianError(502, "remote_cover_unavailable", "Не вдалося завантажити цю обкладинку. Можна обрати фото з пристрою.", authorization.value.access.writesEnabled);
  }
}

async function readAllowedImage(initial: URL): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  let current = initial;
  for (let redirect = 0; redirect < 4; redirect += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(current, {
        headers: { Accept: "image/jpeg,image/png,image/webp" },
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("invalid_redirect");
        const next = safeImageUrl(new URL(location, current).toString());
        if (!next) throw new Error("unsafe_redirect");
        current = next;
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = String(response.headers.get("content-type") ?? "").split(";", 1)[0].toLowerCase();
      if (!ALLOWED_TYPES.has(contentType)) throw new Error("unsupported_type");
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > MAX_IMAGE_BYTES) throw new Error("too_large");
      if (!response.body) throw new Error("empty_body");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_IMAGE_BYTES) {
          await reader.cancel("too_large");
          throw new Error("too_large");
        }
        chunks.push(chunk.value);
      }
      if (!size) throw new Error("empty_body");
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { bytes: bytes.buffer as ArrayBuffer, contentType };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("too_many_redirects");
}

function safeImageUrl(value: string): URL | null {
  if (!value || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return null;
    return url;
  } catch {
    return null;
  }
}
