import {normalizeCatalogSearchText} from "./catalog-d1.ts";
import {sha256Text} from "./librarika-import-plan.ts";

export type LibrarikaMemberRow=Record<string,string>;
const MEMBER_FIELDS=["Id","Member No","Name","Member Group","Status"] as const;
export type NormalizedLibrarikaMember={
  sourceMemberId:string;
  memberNo:string;
  fullName:string;
  sortName:string;
  memberGroup:string;
  status:"active"|"inactive";
  sourceJson:string;
  rowSha256:string;
};

/** Removes export-only PII before any Members rows leave the browser. */
export function projectLibrarikaMemberRows(rows:LibrarikaMemberRow[]):LibrarikaMemberRow[]{
  return rows.map(row=>Object.fromEntries(MEMBER_FIELDS.map(field=>[field,String(row?.[field]??"")])));
}

export async function normalizeLibrarikaMember(row:LibrarikaMemberRow):Promise<NormalizedLibrarikaMember>{
  if(!row||typeof row!=="object"||Array.isArray(row))throw new Error("Некоректний рядок експорту.");
  const sourceMemberId=String(row.Id||"").trim();
  const memberNo=String(row["Member No"]||"").normalize("NFKC").trim();
  const fullName=String(row.Name||"").normalize("NFKC").trim().replace(/\s+/g," ");
  const memberGroup=String(row["Member Group"]||"").normalize("NFKC").trim();
  const sourceStatus=String(row.Status||"").trim();
  const unsafeText=[...fullName,...memberGroup].some(character=>character==="<"||character===">"||character==="\uFFFD"||character.charCodeAt(0)<32);
  if(!/^[0-9]{1,20}$/.test(sourceMemberId)||!/^[\p{L}\p{N}][\p{L}\p{N}-]{0,49}$/u.test(memberNo)||fullName.length<3||fullName.length>180||memberGroup.length>120||!["Active","Inactive"].includes(sourceStatus)||unsafeText)throw new Error(`Некоректний запис читача ${sourceMemberId||"без ID"}.`);
  const sourceJson=JSON.stringify({Id:sourceMemberId,"Member No":memberNo,Name:fullName,"Member Group":memberGroup,Status:sourceStatus});
  return {sourceMemberId,memberNo,fullName,sortName:normalizeCatalogSearchText(fullName),memberGroup,status:sourceStatus.toLowerCase() as "active"|"inactive",sourceJson,rowSha256:await sha256Text(sourceJson)};
}

export async function canonicalLibrarikaMemberDataset(rows:LibrarikaMemberRow[]){
  const normalized=await Promise.all(rows.map(normalizeLibrarikaMember));
  normalized.sort((left,right)=>left.sourceMemberId.localeCompare(right.sourceMemberId,"en"));
  const ids=new Set<string>(),numbers=new Set<string>();
  for(const row of normalized){
    if(ids.has(row.sourceMemberId)||numbers.has(row.memberNo))throw new Error("У файлі повторюється ID або читацький номер.");
    ids.add(row.sourceMemberId);numbers.add(row.memberNo);
  }
  return {rows:normalized,sourceSha256:await sha256Text(JSON.stringify(normalized.map(row=>row.sourceJson)))};
}
