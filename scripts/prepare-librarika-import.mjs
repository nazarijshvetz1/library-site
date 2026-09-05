import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseLibrarikaCsv, LIBRARIKA_EXPORTS, validateLibrarikaDataset } from "../lib/librarika-csv.ts";

// This is an offline preparation tool. It has no network, database, or messaging capability.
const args = process.argv.slice(2);
const input = args[args.indexOf("--input") + 1];
const output = args[args.indexOf("--output") + 1];
if (!args.includes("--input") || !args.includes("--output") || !input || !output) throw new Error("Usage: node scripts/prepare-librarika-import.mjs --input <export-directory> --output <new-private-directory>");
const target = path.resolve(output);
if (!target.split(path.sep).includes(".migration-private")) throw new Error("Output must be inside .migration-private (never public assets or Git).");
await mkdir(path.dirname(target), { recursive: true });
await mkdir(target); // Refuse to replace an earlier immutable capture.
await mkdir(path.join(target, "raw"));
const data = {};
const files = [];
for (const [kind, spec] of Object.entries(LIBRARIKA_EXPORTS)) {
  const source = path.join(path.resolve(input), spec.filename);
  const bytes = await readFile(source);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await copyFile(source, path.join(target, "raw", spec.filename), constants.COPYFILE_EXCL);
  const copied = await readFile(path.join(target, "raw", spec.filename));
  if (createHash("sha256").update(copied).digest("hex") !== sha256) throw new Error(`Backup checksum mismatch: ${spec.filename}`);
  data[kind] = parseLibrarikaCsv(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  files.push({ kind, filename: spec.filename, sha256, bytes: bytes.length, rows: data[kind].length });
}
const report = validateLibrarikaDataset(data);
const manifest = { format: "librarika-source-capture", version: 1, capturedAt: new Date().toISOString(), source: "https://librarylyceummaup.librarika.com", files };
await writeFile(path.join(target, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
await writeFile(path.join(target, "canonical-private.json"), JSON.stringify({ manifest, data }, null, 2) + "\n", { flag: "wx" });
await writeFile(path.join(target, "validation-private.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ directory: target, counts: report.counts, circulationStatuses: report.circulationStatuses, openLoans: report.openLoans, issueCount: report.issues.length, issueCodes: [...new Set(report.issues.map((x) => x.code))], safeForProductionImport: false }, null, 2));
