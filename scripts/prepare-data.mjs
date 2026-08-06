import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const input = resolve(process.argv[2] || "../work/current_foreign_cover_state.json");
const output = resolve("source/catalog-data.js");
const snapshot = JSON.parse(await readFile(input, "utf8"));

const coverUrls = new Map(
  (snapshot.covers?.values || [])
    .slice(1)
    .filter((row) => /^CAT-\d{4,}$/.test(String(row?.[0] || "")))
    .map((row) => [String(row[0]), row[2] || null]),
);

const materials = (snapshot.materials?.values || [])
  .slice(1)
  .filter((row) => /^CAT-\d{4,}$/.test(String(row?.[0] || "")))
  .map((row) => ({
    id: String(row[0]),
    rubric: String(row[20] || row[1] || "Інше"),
    type: String(row[2] || "Не зазначено"),
    subject: String(row[3] || "Не зазначено"),
    classFrom: Number(row[4]) || null,
    classTo: Number(row[5]) || Number(row[4]) || null,
    title: String(row[6] || "Без назви"),
    author: row[7] ? String(row[7]) : "Автор не зазначений",
    year: Number(row[8]) || null,
    quantity: Number(row[12]) || 0,
    availability: String(row[13] || (Number(row[12]) > 0 ? "Є в наявності" : "Немає в наявності")),
    cover: coverUrls.get(String(row[0])) || null,
  }));

const payload = `window.CATALOG_DATA = ${JSON.stringify(materials)};\n`;
await writeFile(output, payload, "utf8");
console.log(`Prepared ${materials.length} public catalog records.`);
