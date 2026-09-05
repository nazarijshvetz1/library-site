import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const [canonicalPath, snapshotPath, outputPath] = process.argv.slice(2).map(value => path.resolve(value));
if (!canonicalPath || !snapshotPath || !outputPath || !outputPath.split(path.sep).includes(".migration-private") || fs.existsSync(outputPath)) throw new Error("Usage: audit-librarika-target CANONICAL SNAPSHOT NEW_PRIVATE_OUTPUT");
const sourceBytes = fs.readFileSync(canonicalPath), targetBytes = fs.readFileSync(snapshotPath);
const source = JSON.parse(sourceBytes.toString("utf8")).data;
const target = JSON.parse(targetBytes.toString("utf8"));
if (target.format !== "library-d1-recovery") throw new Error("Expected verified recovery snapshot");
const rows = name => target.tables.find(table => table.name === name)?.rows ?? [];
const norm = value => String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("uk");
const isbn = value => String(value ?? "").replace(/[^0-9X]/gi, "").toUpperCase();
const titles = source.titles.map(title => {
  const candidates = rows("materials").filter(material => (isbn(title.ISBN13 || title.ISBN) && isbn(material.isbn) === isbn(title.ISBN13 || title.ISBN)) || norm(material.title) === norm(title.Title));
  const exact = candidates.filter(material => norm(material.title) === norm(title.Title) && norm(material.author) === norm(title.Authors) && String(material.publication_year ?? "") === title.Year && isbn(material.isbn) === isbn(title.ISBN13 || title.ISBN));
  return {sourceId:title.Id, title:title.Title, candidates:candidates.map(item => ({id:item.id,title:item.title,author:item.author,year:item.publication_year,isbn:item.isbn})), exactIds:exact.map(item => item.id), resolution:exact.length === 1 ? "exact_bibliography_candidate_not_stock_proof" : candidates.length ? "review" : "new_bibliography"};
});
const readers = source.members.map(member => {
  const exact = rows("users").filter(user => user.full_name.trim() === member.Name.trim() && rows("teacher_profiles").some(profile => profile.teacher_user_id === user.id));
  return {sourceId:member.Id, memberNo:member["Member No"], name:member.Name, sourceGroup:member["Member Group"], teacherCandidates:exact.map(user => ({id:user.id,status:user.status,role:user.role})), resolution:exact.length === 1 ? "exact_name_candidate_requires_secondary_check" : exact.length ? "ambiguous" : "unlinked_reader"};
});
const compound = row => JSON.stringify(["Title","Authors","Year","Volume","ISBN","ISBN13","Edition","Type"].map(field => row[field]?.trim() ?? ""));
const copies = source.copies.map(copy => {
  const candidates = source.titles.filter(title => compound(title) === compound(copy));
  return {sourceCopyId:copy.Id, accessionNo:copy["Accession No"], copyNo:copy["Copy No"], sourceTitleIds:candidates.map(title => title.Id)};
});
const summary = {titleResolutions:count(titles.map(item => item.resolution)),readerResolutions:count(readers.map(item => item.resolution)),copyTitleMatches:count(copies.map(item => String(item.sourceTitleIds.length))),targetMaterials:rows("materials").length,targetUsers:rows("users").length,targetTeacherProfiles:rows("teacher_profiles").length,sourceGroups:[...new Set(source.members.map(row => row["Member Group"]))].sort(), targetClassColumns:Object.keys(rows("class_years")[0] ?? {}), safeForImport:false};
fs.mkdirSync(outputPath,{recursive:true});
const report = {sourceSha256:hash(sourceBytes),targetSha256:hash(targetBytes),summary,titles,readers,copies, note:"Candidates only. No identity activation, material merge, stock addition or network request."};
fs.writeFileSync(path.join(outputPath,"audit-private.json"),JSON.stringify(report,null,2),{flag:"wx"});
console.log(JSON.stringify(summary));
function count(values) { return values.reduce((out,value) => (out[value]=(out[value]||0)+1,out),{}); }
function hash(bytes) {return crypto.createHash("sha256").update(bytes).digest("hex");}
