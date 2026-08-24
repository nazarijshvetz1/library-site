/**
 * Minimal declarations for bindings injected by the Sites/Cloudflare runtime.
 *
 * The production bundler provides `cloudflare:workers` at runtime, while the
 * standalone TypeScript compiler does not resolve that virtual module. Keep
 * this shim deliberately small so browser DOM types are not replaced by the
 * full Workers global type set.
 */
declare module "cloudflare:workers" {
  export const env: {
    DB: import("drizzle-orm/d1").AnyD1Database;
    COVER_UPLOADS: {
      get(key: string): Promise<{
        body: ReadableStream<Uint8Array<ArrayBuffer>>;
        httpEtag: string;
        size: number;
      } | null>;
    };
    [binding: string]: unknown;
  };
}
