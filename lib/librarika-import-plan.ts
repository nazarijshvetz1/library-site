import type { LibrarikaDataset } from "./librarika-csv.ts";

type Row = Record<string, string>;
type PlannedRow = Record<string, string | number | null>;
type CapturedLink = {name:string;source_id:string};
type CapturedBook = { source_id: string; identity_verified: boolean; page_count?: number | null; language?: string | null; annotation?: string | null; description?: string | null; series?: string | null; cover_kind?: string; cover?: { sha256?: string; path?: string; final_url?: string; content_type?: string }; review_details?: unknown[];authors?:CapturedLink[];coauthors?:CapturedLink[];editors?:CapturedLink[];illustrators?:CapturedLink[];publishers?:CapturedLink[] };
type CapturedEntity = {id:string;name:string;nickname?:string;country?:string;yearBorn?:string;yearDied?:string;biography?:string;biographyLanguage?:string;website?:string;sourceBiographyHtml?:string;[key:string]:unknown};
type CapturedTaxonomy = {authors:CapturedEntity[];publishers:CapturedEntity[]};
export type LibrarikaEnrichment={
  translations:{id:string;name:string;sourceBiographySha256:string;biographyUk:string;translationMethod:string}[];
  reviews:{capturedAt:string;records:{id:string;sourceMediaId:string;body:string;rating:number;ratingScale:number;createdAt:string|null;sourceRelativeDate:string}[]};
  authorDetails:{complete:boolean;expectedCount:number;verified:number;pending:number;records:{id:string;name:string;sourceFile:string;sourceFileSha256:string;biography:{listTextMatches:boolean;referenceSourceId:string};publications:{text:string};awards:{text:string};detailDateOfBirth:{text:string};detailYearDied:{text:string};[key:string]:unknown}[]};
};
export type LibrarikaImportPlan = {
  format: "library-librarika-append"; version: 1; runId: string; sourceSha256: string; recoverySha256: string; capturedAt: string;
  tables: Record<string, PlannedRow[]>; counts: Record<string, number>; warnings: {code:string;sourceId:string}[];
  historicalReviews: {editionId:string;details:unknown[]}[];
  safeguards: { authenticationActivated: false; notificationsCreated: false; stockChanged: false; catalogPublished: false };
  sourceCompleteness?:{authorDetailsComplete:boolean;authorsVerified:number;authorsPending:string[]};
};

export async function sha256Text(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2,"0")).join("");
}
const norm = (text:string) => text.normalize("NFKC").trim().replace(/\s+/g," ");
const copyKey = (row:Row) => JSON.stringify(["Title","Authors","Year","Volume","ISBN","ISBN13","Edition","Type"].map(key=>norm(row[key]||"")));
const numericSourceId = (value:string) => { if (!/^\d+$/.test(value)) throw new Error("Invalid source ID"); return value; };
const groups = <T>(values:T[], key:(value:T)=>string) => {const result=new Map<string,T[]>();for(const value of values){const k=key(value);result.set(k,[...(result.get(k)||[]),value]);}return result;};

/** Pure mapping only. No network, SQL, credentials, stock writes or automatic identity links. */
export async function buildLibrarikaImportPlan(data:LibrarikaDataset, captured:CapturedBook[], provenance:{sourceSha256:string;recoverySha256:string;capturedAt:string}, taxonomy?:CapturedTaxonomy,enrichment?:LibrarikaEnrichment):Promise<LibrarikaImportPlan> {
  if (!/^[0-9a-f]{64}$/.test(provenance.sourceSha256) || !/^[0-9a-f]{64}$/.test(provenance.recoverySha256) || !Number.isFinite(Date.parse(provenance.capturedAt))) throw new Error("Invalid verified provenance");
  const runId="LRK-IMPORT-"+provenance.sourceSha256.slice(0,24), at=provenance.capturedAt;
  const tables:Record<string,PlannedRow[]>={library_catalog_entities:[],library_editions:[],library_edition_entities:[],library_readers:[],library_copies:[],reader_circulations:[],library_historical_reviews:[]};
  const warnings:{code:string;sourceId:string}[]=[];
  const historicalReviews:{editionId:string;details:unknown[]}[]=[];
  const translations=new Map(enrichment?.translations.map(row=>[row.id,row])||[]),details=new Map(enrichment?.authorDetails.records.map(row=>[row.id,row])||[]);
  if(enrichment){if(!taxonomy||translations.size!==enrichment.translations.length||details.size!==enrichment.authorDetails.records.length||enrichment.authorDetails.expectedCount!==taxonomy.authors.length||enrichment.authorDetails.verified!==details.size||enrichment.authorDetails.pending!==taxonomy.authors.length-details.size)throw new Error("Invalid enrichment identities or counts");
    const authorIds=new Set(taxonomy.authors.map(row=>row.id));if([...translations.keys(),...details.keys()].some(id=>!authorIds.has(id)))throw new Error("Unknown author enrichment identity");
    if(enrichment.authorDetails.complete&&enrichment.authorDetails.pending!==0)throw new Error("Incomplete author details cannot be marked complete");
  }
  for(const [kind,key] of [["titles","Id"],["copies","Id"],["members","Id"],["circulations","ID"]] as const){const ids=data[kind].map(row=>numericSourceId(row[key]));if(new Set(ids).size!==ids.length)throw new Error(`Duplicate ${kind} source identity`);}
  if(new Set(data.members.map(row=>row["Member No"])).size!==data.members.length)throw new Error("Ambiguous member numbers");
  const sourceTitles=groups(data.titles,copyKey);
  const books=new Map(captured.map(book=>[String(book.source_id),book]));
  if(books.size!==captured.length)throw new Error("Duplicate captured book identity");
  const entities=new Map<string,PlannedRow>();
  const entitySources=new Map<string,unknown[]>();
  const capturedByName=new Map<string,PlannedRow[]>(),capturedById=new Map<string,PlannedRow>();
  const entityFor=async(kind:string,name:string,source?:Row) => {
    name=norm(name);if(!name)throw new Error("Empty catalog entity");
    const key=kind+"\0"+name;
    if(!entities.has(key)){
      const hash=await sha256Text(key);
      entities.set(key,{id:`LRK-${kind.toUpperCase()}-${hash.slice(0,24)}`,kind,name,slug:hash.slice(0,24),public_metadata_json:"{}",source_json:"[]",import_run_id:runId,version:1});
      entitySources.set(key,[]);
    }
    if(source)entitySources.get(key)!.push(source);
    return entities.get(key)!;
  };
  if(taxonomy)for(const [sourceKind,kind]of [["authors","author"],["publishers","publisher"]] as const){
    for(const source of taxonomy[sourceKind]){
      const sourceId=numericSourceId(source.id),key=kind+"\0source:"+sourceId;
      if(entities.has(key))throw new Error("Duplicate captured entity identity");
      const csvRows=data[sourceKind].filter(row=>norm(row.Name)===norm(source.name));
      if(!csvRows.length)throw new Error("Captured entity is absent from native CSV");
      const translation=kind==="author"?translations.get(sourceId):undefined,detail=kind==="author"?details.get(sourceId):undefined;
      if(translation&&(translation.name!==source.name||translation.sourceBiographySha256!==await sha256Text(source.biography||"")||!translation.biographyUk.trim()))throw new Error("Biography translation source changed");
      if(detail&&(detail.name!==source.name||!detail.biography.listTextMatches||detail.biography.referenceSourceId!==sourceId))throw new Error("Author detail identity or biography changed");
      const metadata=kind==="author"?{nickname:source.nickname||"",country:source.country||"",dateOfBirth:detail?.detailDateOfBirth.text||source.yearBorn||"",yearDied:detail?.detailYearDied.text||source.yearDied||"",biography:translation?.biographyUk||source.biography||"",biographyLanguage:translation?"uk":source.biographyLanguage||"und",sourceAuthorIds:[sourceId],...(detail?{publications:detail.publications.text,awards:detail.awards.text}:{})}:{country:source.country||"",website:safeHttps(source.website),description:"",sourcePublisherIds:[sourceId]};
      const entity={id:`LRK-${kind.toUpperCase()}-SRC-${sourceId}`,kind,name:norm(source.name),slug:`source-${sourceId}`,public_metadata_json:JSON.stringify(metadata),source_json:"[]",import_run_id:runId,version:1};
      entities.set(key,entity);entitySources.set(key,[{csvRows,capture:source,...(translation?{translation}:{}),...(detail?{detail}:{})}]);capturedById.set(kind+":"+sourceId,entity);
      const nameKey=kind+"\0"+norm(source.name);capturedByName.set(nameKey,[...capturedByName.get(nameKey)||[],entity]);
    }
    if(data[sourceKind].some(row=>!capturedByName.has(kind+"\0"+norm(row.Name))))throw new Error("Taxonomy capture misses CSV records");
  }
  for(const [sourceKind,kind] of [["authors","author"],["publishers","publisher"],["categories","genre"],["tags","tag"]] as const){
    if(taxonomy&&(kind==="author"||kind==="publisher"))continue;
    for(const source of data[sourceKind]){
      const entity=await entityFor(kind,source.Name,source);
      const publicFields=kind==="author" ? {nickname:source.Nickname||"",country:source.Country||"",dateOfBirth:source["Date of Birth"]||"",yearDied:source["Year Died"]||"",biography:""} : kind==="publisher" ? {country:source.Country||"",website:safeHttps(source.Website),description:""} : {};
      entity.public_metadata_json=JSON.stringify(publicFields);
    }
  }
  const links=new Set<string>();
  for(const source of data.titles){
    const sourceId=numericSourceId(source.Id),id="LRK-ED-"+sourceId,book=books.get(sourceId);
    if(!book?.identity_verified)throw new Error(`Unverified public source ${sourceId}`);
    const sourceIsbn=source.ISBN13||source.ISBN||"";
    if(sourceIsbn.length===13&&!validIsbn13(sourceIsbn))warnings.push({code:"source_isbn_checksum",sourceId});
    const metadata={author:source.Authors||"",coauthors:source["Co-authors"]||"",editors:source.Editors||"",illustrators:source.Illustrators||"",publisher:source.Publisher||"",year:source.Year||"",edition:source.Edition||"",volume:source.Volume||"",isbn:sourceIsbn,isbn10:source.ISBN||"",isbn13:source.ISBN13||"",issn:source.ISSN||"",asin:source.ASIN||"",lccn:source.LCCN||"",ddc:source.DDC||"",oclc:source.OCLC||"",upc:source.UPC||"",callNumber:source["Call No"]||"",genre:source.Category||"",subject:source.Subject||"",type:source.Type||"",description:source.Description||book.description||"",annotation:book.annotation||"",pages:book.page_count??null,language:book.language??null,series:source.Series||book.series||"",sourceUrl:`https://librarylyceummaup.librarika.com/search/detail/${sourceId}`,referenceUrl:safeHttps(source.URL),coverSha256:book.cover?.sha256||null,coverKind:book.cover_kind||"source",coverUrl:null};
    tables.library_editions.push({id,source_media_id:sourceId,material_id:null,fund:"literature",title:source.Title,public_metadata_json:JSON.stringify(metadata),source_json:JSON.stringify(source),source_row_sha256:await sha256Text(JSON.stringify(source)),import_run_id:runId,publication_state:"draft",version:1,created_at:at,updated_at:at});
    for(const [field,kind,role] of [["Authors","author","author"],["Co-authors","author","coauthor"],["Editors","author","editor"],["Illustrators","author","illustrator"],["Publisher","publisher","publisher"],["Category","genre","genre"],["Tags","tag","tag"],["Series","series","series"]]){
      for(const name of (source[field]||"").split(";").map(norm).filter(Boolean)){
        const captureField=({Authors:"authors","Co-authors":"coauthors",Editors:"editors",Illustrators:"illustrators",Publisher:"publishers"} as const)[field as "Authors"];
        const sourceLinks=captureField?(book[captureField]||[]).filter(link=>norm(link.name)===name):[];
        let entity:PlannedRow;
        if(taxonomy&&(kind==="author"||kind==="publisher")){
          const identified=sourceLinks.map(link=>capturedById.get(kind+":"+link.source_id)).filter((row):row is PlannedRow=>!!row);
          if(sourceLinks.length&&identified.length!==sourceLinks.length)throw new Error("Book references an uncaptured entity ID");
          const candidates=identified.length?identified:capturedByName.get(kind+"\0"+name)||[];
          if(candidates.length>1){warnings.push({code:"ambiguous_entity_link_preserved_in_source",sourceId:sourceId+":"+field});continue;}
          entity=candidates[0]||await entityFor(kind,name);
        }else entity=await entityFor(kind,name);
        const link={edition_id:id,entity_id:String(entity.id),role};
        const key=JSON.stringify(link);if(!links.has(key)){links.add(key);tables.library_edition_entities.push(link);}
      }
    }
    if(!enrichment&&book.review_details?.length){
      historicalReviews.push({editionId:id,details:book.review_details});
      for(const unknownReview of book.review_details){
        const review=unknownReview as {text?:unknown;rating?:unknown;source_review_id?:unknown;date_display?:unknown;captured_at?:unknown};
        if(typeof review.text!=="string"||!review.text.trim()||!Number.isInteger(review.rating)||Number(review.rating)<1||Number(review.rating)>5)throw new Error("Invalid source review");
        const sourceReviewJson=JSON.stringify(review), reviewHash=await sha256Text(sourceReviewJson);
        tables.library_historical_reviews.push({id:`${id}-REVIEW-${reviewHash.slice(0,20)}`,edition_id:id,source_review_id:typeof review.source_review_id==="string"?review.source_review_id:null,rating:Number(review.rating),body:review.text,source_date_display:typeof review.date_display==="string"?review.date_display:"",source_json:sourceReviewJson,source_row_sha256:reviewHash,import_run_id:runId,publication_state:"draft",captured_at:typeof review.captured_at==="string"?review.captured_at:at});
      }
    }
  }
  if(enrichment){const reviewIds=new Set<string>();for(const review of enrichment.reviews.records){numericSourceId(review.id);numericSourceId(review.sourceMediaId);if(reviewIds.has(review.id)||!books.has(review.sourceMediaId)||!data.titles.some(row=>row.Id===review.sourceMediaId)||typeof review.body!=="string"||!review.body.trim()||!Number.isInteger(review.rating)||review.rating<1||review.rating>5||review.ratingScale!==5||!Number.isFinite(Date.parse(enrichment.reviews.capturedAt)))throw new Error("Invalid verified historical review");reviewIds.add(review.id);
      const publicReview=books.get(review.sourceMediaId)!.review_details as {text?:string;rating?:number}[]|undefined;if(!publicReview?.some(row=>norm(row.text||"")===norm(review.body)&&row.rating===review.rating))throw new Error("Review does not match verified public capture");
      const safeSource={id:review.id,sourceMediaId:review.sourceMediaId,body:review.body,rating:review.rating,ratingScale:5,createdAt:review.createdAt,sourceRelativeDate:review.sourceRelativeDate},json=JSON.stringify(safeSource),editionId="LRK-ED-"+review.sourceMediaId;
      tables.library_historical_reviews.push({id:"LRK-REVIEW-SRC-"+review.id,edition_id:editionId,source_review_id:review.id,rating:review.rating,body:review.body,source_date_display:review.sourceRelativeDate,source_json:json,source_row_sha256:await sha256Text(json),import_run_id:runId,publication_state:"draft",captured_at:enrichment.reviews.capturedAt});historicalReviews.push({editionId,details:[safeSource]});
    }
    if(enrichment.reviews.records.length!==captured.reduce((total,row)=>total+(row.review_details?.length||0),0))throw new Error("Historical review capture is incomplete");
  }
  for(const [key,entity] of entities){entity.source_json=JSON.stringify(entitySources.get(key));tables.library_catalog_entities.push(entity);}
  const members=new Map(data.members.map(row=>[row["Member No"],row]));
  const sourceGroupIds=new Map<string,Set<string>>();
  for(const loan of data.circulations)if(loan["Member Group"]&&loan["Member Group ID"]){const label=loan["Member Group"];if(!sourceGroupIds.has(label))sourceGroupIds.set(label,new Set());sourceGroupIds.get(label)!.add(loan["Member Group ID"]);}
  for(const source of data.members){
    if(!source.Name.trim()||!source["Member No"].trim()||!["Active","Inactive"].includes(source.Status))throw new Error("Invalid member record");
    const group=source["Member Group"]||"",kind=/^(?:[1-9]|1[01])-[A-ZА-ЯІЇЄҐ0-9]+$/u.test(group)?"student":"unclassified";
    const groupIds=sourceGroupIds.get(group);
    tables.library_readers.push({id:"LRK-RD-"+source.Id,source_member_id:source.Id,member_no:source["Member No"],full_name:source.Name,sort_name:norm(source.Name).toLocaleLowerCase("uk"),kind,status:source.Status.toLowerCase(),access_status:"inactive",access_version:1,linked_teacher_user_id:null,source_group_label:group,source_group_id:groupIds?.size===1?[...groupIds][0]:null,source_json:JSON.stringify(source),source_row_sha256:await sha256Text(JSON.stringify(source)),import_run_id:runId,version:1,created_at:at,updated_at:at});
  }
  const copyTitles=new Map<string,string>();
  for(const source of data.copies){
    const titles=sourceTitles.get(copyKey(source))||[];
    if(titles.length!==1)throw new Error(`Ambiguous copy edition ${source.Id}`);
    copyTitles.set(source.Id,titles[0].Id);
    tables.library_copies.push({id:"LRK-CP-"+source.Id,source_copy_id:source.Id,edition_id:"LRK-ED-"+titles[0].Id,accession_no:source["Accession No"],copy_no:source["Copy No"]||"",location_id:null,condition:"unspecified",physical_state:"unknown",registration:"unreconciled",source_json:JSON.stringify(source),source_row_sha256:await sha256Text(JSON.stringify(source)),import_run_id:runId,version:1,created_at:at,updated_at:at});
  }
  const accessions=groups(data.copies,row=>row["Accession No"]);
  for(const [number,copies] of accessions)if(copies.length>1)warnings.push({code:"duplicate_accession_preserved",sourceId:number});
  const activeCopies=new Set<string>();
  for(const source of data.circulations){
    const member=members.get(source["Member No"]);
    const candidates=(accessions.get(source["ASN No"])||[]).filter(copy=>copyTitles.get(copy.Id)===source["Media ID"]&&copy["Copy No"]===source["Copy No"]);
    if(!member||candidates.length!==1)throw new Error(`Unresolved circulation ${source.ID}`);
    const status=source.Status.toLowerCase();
    if(!["issued","overdue","returned","cancelled","pending","reserved"].includes(status))throw new Error("Unknown circulation status");
    const copyId="LRK-CP-"+candidates[0].Id;
    if(["issued","overdue"].includes(status)){
      if(activeCopies.has(copyId))throw new Error("A copy has two active loans");
      if(!source["Booking Date"]||!source["Return Date"])throw new Error("Missing open loan dates");
      activeCopies.add(copyId);
    }
    tables.reader_circulations.push({id:"LRK-LN-"+source.ID,source_circulation_id:source.ID,copy_id:copyId,reader_id:"LRK-RD-"+member.Id,status,issued_at:source["Issued At"]||null,due_at:source["Return Date"]||null,received_at:source["Received At"]||null,accounting_mode:"unreconciled",legacy_loan_item_id:null,legacy_class_loan_item_id:null,source_json:JSON.stringify(source),source_row_sha256:await sha256Text(JSON.stringify(source)),import_run_id:runId,version:1,created_at:at,updated_at:at});
    if(source["Member Group ID"]){const reader=tables.library_readers.find(row=>row.id==="LRK-RD-"+member.Id)!;if(reader.source_group_label===source["Member Group"]){if(reader.source_group_id&&reader.source_group_id!==source["Member Group ID"])throw new Error("Conflicting source group IDs");reader.source_group_id=source["Member Group ID"];}}
  }
  for(const copy of tables.library_copies)if(activeCopies.has(String(copy.id)))copy.physical_state="on_loan";
  return {format:"library-librarika-append",version:1,runId,...provenance,tables,counts:Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,rows.length])),warnings,historicalReviews,...(enrichment?{sourceCompleteness:{authorDetailsComplete:enrichment.authorDetails.complete,authorsVerified:details.size,authorsPending:taxonomy!.authors.filter(author=>!details.has(author.id)).map(author=>author.id)}}:{}),safeguards:{authenticationActivated:false,notificationsCreated:false,stockChanged:false,catalogPublished:false}};
}
function validIsbn13(value:string){return /^\d{13}$/.test(value)&&[...value].reduce((sum,digit,index)=>sum+Number(digit)*(index%2?3:1),0)%10===0;}
function safeHttps(value:string|undefined){try{const url=new URL(value||"");return url.protocol==="https:"&&!url.username&&!url.password?url.href:"";}catch{return "";}}
