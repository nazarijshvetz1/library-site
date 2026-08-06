import { getRuntimeString } from "@/lib/runtime-env";

const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_MATERIALS = 10_000;
const CATALOG_TIMEOUT_MS = 15_000;

export type CatalogPayload = {
  stats: Record<string, unknown>;
  materials: unknown[];
  generatedAt: string | null;
};

export class CatalogUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CatalogUnavailableError";
  }
}

async function readLimitedResponse(response: Response): Promise<string> {
  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength && Number(declaredLength) > MAX_CATALOG_BYTES) {
    throw new CatalogUnavailableError("Catalog response exceeds the size limit");
  }

  if (!response.body) {
    throw new CatalogUnavailableError("Catalog response has no body");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CATALOG_BYTES) {
      await reader.cancel();
      throw new CatalogUnavailableError("Catalog response exceeds the size limit");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function fetchPublicCatalog(): Promise<CatalogPayload> {
  const configuredUrl = getRuntimeString("PUBLIC_CATALOG_API_URL");
  if (!configuredUrl) {
    throw new CatalogUnavailableError("PUBLIC_CATALOG_API_URL is not configured");
  }

  let url: URL;
  try {
    url = new URL(configuredUrl);
  } catch (cause) {
    throw new CatalogUnavailableError("PUBLIC_CATALOG_API_URL is invalid", {
      cause,
    });
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new CatalogUnavailableError(
      "PUBLIC_CATALOG_API_URL must be an HTTPS URL without credentials",
    );
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new CatalogUnavailableError("Catalog request failed", { cause });
  }

  if (!response.ok) {
    throw new CatalogUnavailableError(
      `Catalog request returned HTTP ${response.status}`,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await readLimitedResponse(response));
  } catch (cause) {
    if (cause instanceof CatalogUnavailableError) throw cause;
    throw new CatalogUnavailableError("Catalog response is not valid JSON", {
      cause,
    });
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new CatalogUnavailableError("Catalog response must be an object");
  }
  const source = payload as Record<string, unknown>;
  if (source.success === false || !Array.isArray(source.materials)) {
    throw new CatalogUnavailableError("Catalog response has an invalid shape");
  }
  if (source.materials.length > MAX_MATERIALS) {
    throw new CatalogUnavailableError("Catalog contains too many materials");
  }

  return {
    stats:
      typeof source.stats === "object" &&
      source.stats !== null &&
      !Array.isArray(source.stats)
        ? (source.stats as Record<string, unknown>)
        : {},
    materials: source.materials,
    generatedAt:
      typeof source.generatedAt === "string" ? source.generatedAt : null,
  };
}
