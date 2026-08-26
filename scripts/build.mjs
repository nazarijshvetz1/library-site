import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

const read = (name) => readFile(new URL(`../source/${name}`, import.meta.url), "utf8");
const [html, css, brandCss, config, app, data, balances, og, logo] = await Promise.all([
  read("index.html"),
  read("styles.css"),
  read("brand.css"),
  read("config.js"),
  read("app.js"),
  read("catalog-data.js"),
  read("balance-data.js"),
  readFile(new URL("../source/og.png", import.meta.url)),
  readFile(new URL("../source/library-logo.png", import.meta.url)),
]);

const worker = `const files = new Map(${JSON.stringify([
  ["/", [html, "text/html; charset=utf-8"]],
  ["/index.html", [html, "text/html; charset=utf-8"]],
  ["/styles.css", [css, "text/css; charset=utf-8"]],
  ["/brand.css", [brandCss, "text/css; charset=utf-8"]],
  ["/config.js", [config, "text/javascript; charset=utf-8"]],
  ["/app.js", [app, "text/javascript; charset=utf-8"]],
  ["/catalog-data.js", [data, "text/javascript; charset=utf-8"]],
  ["/balance-data.js", [balances, "text/javascript; charset=utf-8"]],
])});
const images = new Map([
  ["/og.png", ${JSON.stringify(og.toString("base64"))}],
  ["/library-logo.png", ${JSON.stringify(logo.toString("base64"))}],
]);

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const securityHeaders = {
  "content-security-policy": "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self' https://telegram.org; connect-src 'self' https://yedyna-biblioteka-liceiu.nazarijshvetz1.chatgpt.site; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const image = images.get(url.pathname);
    if (image) return new Response(decodeBase64(image), { headers: { ...securityHeaders, "content-type": "image/png", "cache-control": "public, max-age=86400" } });
    const file = files.get(url.pathname);
    if (!file) return new Response("Not found", { status: 404, headers: securityHeaders });
    const body = file[1].startsWith("text/html") ? file[0].replaceAll("{{SITE_ORIGIN}}", url.origin) : file[0];
    return new Response(body, {
      headers: {
        ...securityHeaders,
        "content-type": file[1],
        "cache-control": url.pathname === "/" ? "no-cache" : "public, max-age=3600",
      },
    });
  },
};
`;

await rm(new URL("../dist-catalog/", import.meta.url), { recursive: true, force: true });
await mkdir(new URL("../dist-catalog/server/", import.meta.url), { recursive: true });
await writeFile(new URL("../dist-catalog/server/index.js", import.meta.url), worker, "utf8");
console.log("Static catalog build created in dist-catalog/.");
