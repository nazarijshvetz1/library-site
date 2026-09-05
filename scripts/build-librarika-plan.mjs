import fs from "node:fs";
import path from "node:path";
import { buildLibrarikaImportPlan, sha256Text } from "../lib/librarika-import-plan.ts";
import { parseLibrarikaCsv } from "../lib/librarika-csv.ts";

const args=process.argv.slice(2);
if(args.length!==5)throw new Error("Usage: build-librarika-plan CANONICAL_JSON PUBLIC_METADATA_MANIFEST VERIFIED_RECOVERY_DIRECTORY TAXONOMY_DIRECTORY NEW_PRIVATE_OUTPUT_DIRECTORY");
const [sourcePath,metadataPath,recoveryPath,taxonomyPath,output]=args.map(value=>path.resolve(value));
if(!output.split(path.sep).includes(".migration-private")||fs.existsSync(output))throw new Error("A new private output directory is required");
const sourceText=fs.readFileSync(sourcePath,"utf8"),source=JSON.parse(sourceText),metadataText=fs.readFileSync(metadataPath,"utf8"),metadata=JSON.parse(metadataText);
for(const file of source.manifest.files){
  if(path.basename(file.filename)!==file.filename)throw new Error("Invalid source archive filename");
  const raw=fs.readFileSync(path.join(path.dirname(sourcePath),"raw",file.filename),"utf8");
  if(await sha256Text(raw)!==file.sha256||JSON.stringify(parseLibrarikaCsv(raw))!==JSON.stringify(source.data[file.kind]))throw new Error("Original CSV capture or canonical rows changed");
}
const recovery=JSON.parse(fs.readFileSync(path.join(recoveryPath,"verification.json"),"utf8"));
if(!recovery.verified||!metadata.complete||!metadata.collection_finished)throw new Error("Verified recovery and complete metadata are required");
if(await sha256Text(fs.readFileSync(path.join(recoveryPath,"snapshot.json"),"utf8"))!==recovery.sha256)throw new Error("Recovery checksum changed");
const taxonomyVerification=JSON.parse(fs.readFileSync(path.join(taxonomyPath,"verification.json"),"utf8"));
if(taxonomyVerification.result!=="passed")throw new Error("Verified taxonomy capture required");
for(const artifact of taxonomyVerification.artifacts){
  if(path.basename(artifact.file)!==artifact.file||await sha256Text(fs.readFileSync(path.join(taxonomyPath,artifact.file),"utf8"))!==artifact.sha256)throw new Error("Taxonomy artifact checksum changed");
}
const taxonomyManifest=JSON.parse(fs.readFileSync(path.join(taxonomyPath,"manifest.json"),"utf8"));
for(const artifact of taxonomyManifest.sourceFiles){
  if(!/^raw\/[a-z]+-page-\d{3}\.json$/.test(artifact.file)||await sha256Text(fs.readFileSync(path.join(taxonomyPath,artifact.file),"utf8"))!==artifact.sha256)throw new Error("Taxonomy source checksum changed");
}
const authorsText=fs.readFileSync(path.join(taxonomyPath,"authors.normalized.json"),"utf8"),publishersText=fs.readFileSync(path.join(taxonomyPath,"publishers.normalized.json"),"utf8");
const authors=JSON.parse(authorsText),publishers=JSON.parse(publishersText);
if(!authors.complete||!publishers.complete)throw new Error("Incomplete taxonomy capture");
const inputHashes={mapperVersion:3,canonicalCsvSha256:await sha256Text(sourceText),publicBookMetadataSha256:await sha256Text(metadataText),authorsSha256:await sha256Text(authorsText),publishersSha256:await sha256Text(publishersText),taxonomyManifestSha256:await sha256Text(JSON.stringify(taxonomyManifest))};
const plan=await buildLibrarikaImportPlan(source.data,metadata.records,{sourceSha256:await sha256Text(JSON.stringify(inputHashes)),recoverySha256:recovery.sha256,capturedAt:source.manifest.capturedAt},{authors:authors.records,publishers:publishers.records});
plan.inputHashes=inputHashes;
fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,"plan-private.json"),JSON.stringify(plan),{flag:"wx"});
const report={format:plan.format,runId:plan.runId,counts:plan.counts,warnings:plan.warnings,historicalReviewTitles:plan.historicalReviews.length,safeguards:plan.safeguards,sha256:await sha256Text(JSON.stringify(plan))};
fs.writeFileSync(path.join(output,"report.json"),JSON.stringify(report,null,2),{flag:"wx"});
console.log(JSON.stringify(report));
