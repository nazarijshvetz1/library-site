import { readFile, writeFile } from "node:fs/promises";

const apiUrl = String(process.argv[2] || "").trim();
if (!/^https:\/\/[A-Za-z0-9.-]+\/api\/catalog-v2\/?$/.test(apiUrl)) {
  console.error("Вкажіть повний HTTPS URL публічного Sites API, що закінчується на /api/catalog-v2.");
  process.exitCode = 1;
} else {
  const configUrl = new URL("../source/config.js", import.meta.url);
  const current = await readFile(configUrl, "utf8");
  const normalized = apiUrl.replace(/\/$/, "");
  const next = current.replace(/catalogApiUrl:\s*"[^"]*"/, `catalogApiUrl: ${JSON.stringify(normalized)}`);
  if (next === current) throw new Error("У source/config.js не знайдено поле catalogApiUrl.");
  await writeFile(configUrl, next, "utf8");
  console.log("URL D1 catalog API записано у source/config.js.");
}
