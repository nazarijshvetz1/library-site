/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { drainTelegramOutboxUntilIdle } from "../lib/telegram-delivery-runtime";
import { expireAssistantCalls } from "../lib/assistant-store";

interface AssetFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface Env {
  ASSETS: AssetFetcher;
  DB: (typeof import("cloudflare:workers").env)["DB"];
  OPENAI_API_KEY?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    const response = await handler.fetch(request, env, ctx);
    const headers = new Headers(response.headers);
    const isTelegramMiniApp = url.pathname === "/teacher/telegram"
      || url.pathname.startsWith("/teacher/telegram/")
      || url.pathname === "/librarian/telegram"
      || url.pathname.startsWith("/librarian/telegram/");
    headers.set(
      "Content-Security-Policy",
      isTelegramMiniApp
        ? "frame-ancestors https://web.telegram.org; base-uri 'self'; form-action 'self'"
        : "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (isTelegramMiniApp) headers.delete("X-Frame-Options");
    else headers.set("X-Frame-Options", "DENY");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    headers.set(
      "Permissions-Policy",
      url.pathname.startsWith("/librarian") || url.pathname.startsWith("/teacher")
        ? "camera=(self), microphone=(self), geolocation=()"
        : "camera=(), microphone=(), geolocation=()",
    );
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
  async scheduled(_controller: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(expireAssistantCalls(env.DB, env.OPENAI_API_KEY));
    ctx.waitUntil(drainTelegramOutboxUntilIdle(env.DB, {
      siteOrigin: "https://yedyna-biblioteka-liceiu.nazarijshvetz1.chatgpt.site",
      maxBatches: 6,
    }));
  },
};

export default worker;
