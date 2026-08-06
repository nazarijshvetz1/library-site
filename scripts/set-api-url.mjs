import { readFile, writeFile } from "node:fs/promises";

const apiUrl = String(process.argv[2] || "").trim();
if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(apiUrl)) {
  console.error("Вкажіть повний URL розгортання Apps Script, що закінчується на /exec.");
  process.exitCode = 1;
} else {
  const configUrl = new URL("../source/config.js", import.meta.url);
  const current = await readFile(configUrl, "utf8");
  const next = current.replace(/apiUrl:\s*"[^"]*"/, `apiUrl: ${JSON.stringify(apiUrl)}`);
  if (next === current) throw new Error("У source/config.js не знайдено поле apiUrl.");
  await writeFile(configUrl, next, "utf8");
  console.log("URL Google Sheets API записано у source/config.js.");
}
