import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const sourceRoot = new URL("../source/", import.meta.url);
const outputRoot = new URL("../dist-pages/", import.meta.url);
const siteOrigin = "https://nazarijshvetz1.github.io/library-site";
const textAssets = ["styles.css", "brand.css", "system.css", "config.js", "app.js", "catalog-data.js", "balance-data.js"];
const binaryAssets = ["library-logo.png", "og.png"];

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

let html = await readFile(new URL("index.html", sourceRoot), "utf8");
html = html
  .replaceAll("{{SITE_ORIGIN}}", siteOrigin)
  .replaceAll('href="/', 'href="./')
  .replaceAll('src="/', 'src="./');

await writeFile(new URL("index.html", outputRoot), html, "utf8");
await writeFile(new URL(".nojekyll", outputRoot), "", "utf8");
await Promise.all(textAssets.map(async (name) => {
  const content = await readFile(new URL(name, sourceRoot), "utf8");
  await writeFile(new URL(name, outputRoot), content, "utf8");
}));
await Promise.all(binaryAssets.map((name) => copyFile(new URL(name, sourceRoot), new URL(name, outputRoot))));

console.log("GitHub Pages build created in dist-pages/.");
