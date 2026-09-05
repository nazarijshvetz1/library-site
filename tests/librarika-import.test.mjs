import test from "node:test";
import assert from "node:assert/strict";
import { parseLibrarikaCsv, LIBRARIKA_EXPORTS, validateLibrarikaDataset } from "../lib/librarika-csv.ts";

test("CSV preserves multiline descriptions, quotes, BOM and leading zero codes", () => {
  assert.deepEqual(parseLibrarikaCsv('\uFEFFId,Title,Description\r\n0007,"Книга, том 1","Рядок 1\nЦитата ""так"""\r\n'), [{ Id: "0007", Title: "Книга, том 1", Description: 'Рядок 1\nЦитата "так"' }]);
});
test("CSV rejects ambiguous headers, malformed quoting and uneven rows", () => {
  for (const text of ['Id,Id\n1,2', 'Id,__proto__\n1,2', 'Id,Title\n1,"abc', 'Id,Title\n1,"a"x', 'Id,Title\n1,a,b', 'Id,Title\n1,a"b']) assert.throws(() => parseLibrarikaCsv(text));
});
function fixture() {
  const data = Object.fromEntries(Object.entries(LIBRARIKA_EXPORTS).map(([kind]) => [kind, []]));
  data.titles = [{Id:"t1",Title:"Книга",Authors:"Автор",ISBN13:"",Category:""}];
  data.copies = [{Id:"c1","Accession No":"0001","Copy No":"1",Title:"Книга"}];
  data.members = [{Id:"r1","Member No":"У-1",Name:"Тестовий читач","Member Group":"7-А",Status:"Active"}];
  data.circulations = [{ID:"l1","Member No":"У-1","Media ID":"t1","ASN No":"0001",Status:"Issued","Booking Date":"2026-09-01","Return Date":"2026-09-14"}];
  return data;
}
test("source reconciliation checks joins without enabling production or logins", () => {
  const result = validateLibrarikaDataset(fixture());
  assert.equal(result.issues.length, 0); assert.equal(result.openLoans, 1); assert.equal(result.safeForProductionImport, false);
});
test("source reconciliation detects duplicate loans and missing members", () => {
  const data = fixture(); data.circulations.push({...data.circulations[0], ID:"l2", "Member No":"absent"});
  const codes = validateLibrarikaDataset(data).issues.map(x => x.code);
  assert.ok(codes.includes("multiple_open_loans")); assert.ok(codes.includes("unknown_member"));
});
test("source reconciliation rejects duplicate accession numbers and title mismatch", () => {
  const data = fixture(); data.copies.push({...data.copies[0],Id:"c2"}); data.titles[0].Title="Інша книга";
  const codes = validateLibrarikaDataset(data).issues.map(x => x.code);
  assert.ok(codes.includes("duplicate_key")); assert.ok(codes.includes("copy_title_mismatch"));
});
