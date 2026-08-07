import { readdir, readFile, stat } from "node:fs/promises";

const root = new URL("../dist/", import.meta.url);

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) files.push(...await filesBelow(url));
    else files.push(url);
  }
  return files;
}

let files;
try {
  files = await filesBelow(root);
} catch {
  throw new Error("Private Sites build is missing; deployment is blocked.");
}

const javascriptFiles = files.filter((file) => /\.(?:js|mjs)$/u.test(file.pathname));
if (javascriptFiles.length === 0) {
  throw new Error("Private Sites build contains no server JavaScript; deployment is blocked.");
}

const entry = new URL("server/index.js", root);
if ((await stat(entry)).size <= 1_000) {
  throw new Error("Private Sites server entry is unexpectedly small; deployment is blocked.");
}

const sources = await Promise.all(javascriptFiles.map((file) => readFile(file, "utf8")));
const javascript = sources.join("\n");
if (sources.some((source) => /^const files = new Map/u.test(source))) {
  throw new Error("Public catalog bundle detected in private dist/; deployment is blocked.");
}
if (!javascript.includes("LIBRARIAN_ALLOWED_EMAILS")) {
  throw new Error("Librarian access guard is absent from the private bundle; deployment is blocked.");
}

console.log("Private Sites build verification passed.");
