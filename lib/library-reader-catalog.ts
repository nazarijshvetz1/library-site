import {normalizeCatalogSearchText,getCatalogMaterialDetail,type CatalogD1Database} from "./catalog-d1.ts";
import {readerFail,readerResource,type ReaderDatabase} from "./reader-core.ts";

export const libraryCoverSql="CASE WHEN EXISTS(SELECT 1 FROM material_cover_assets ca WHERE ca.material_id=m.id AND ca.status='ready') THEN CASE WHEN e.fund='literature' THEN '/api/library/material-covers/'||m.id ELSE '/api/catalog-v2/covers/'||m.id END WHEN coalesce(json_extract(e.public_metadata_json,'$.coverKind'),'')!='placeholder' AND length(json_extract(e.public_metadata_json,'$.coverSha256'))=64 THEN '/api/library/covers/'||json_extract(e.public_metadata_json,'$.coverSha256') ELSE json_extract(e.public_metadata_json,'$.coverUrl') END";

export async function listReaderCatalog(db:ReaderDatabase,url:URL){
  const fund=url.searchParams.get("fund")||"literature",q=normalizeCatalogSearchText(url.searchParams.get("q")||"");
  const sort=url.searchParams.get("sort")||"title",page=Number(url.searchParams.get("page")||1),limit=24;
  if(!["literature","education"].includes(fund)||q.length>100||!["title","newest","rating"].includes(sort)||!Number.isInteger(page)||page<1||page>500)readerFail("catalog_query","Перевірте параметри пошуку.");
  const bindings:(string|number)[]=[],conditions=[fund==="literature"?"e.publication_state='published' AND e.fund='literature' AND m.status='active'":"m.status='active' AND NOT EXISTS(SELECT 1 FROM library_editions le WHERE le.material_id=m.id AND le.fund='literature')"];
  if(q){conditions.push("m.search_text LIKE ? ESCAPE '!'");bindings.push("%"+q.replace(/[!%_]/g,value=>"!"+value)+"%");}
  if(fund==="literature")for(const kind of ["genre","author","publisher"]){const id=url.searchParams.get(kind);if(id){if(!readerResource(id))readerFail("catalog_filter","Некоректний фільтр.");conditions.push("EXISTS(SELECT 1 FROM library_edition_entities x WHERE x.edition_id=e.id AND x.entity_id=?)");bindings.push(id);}}
  if(fund==="education"){const grade=url.searchParams.get("grade");if(grade){const number=Number(grade);if(!Number.isInteger(number)||number<1||number>11)readerFail("catalog_grade","Оберіть клас від 1 до 11.");conditions.push("m.class_from<=? AND m.class_to>=?");bindings.push(number,number);}}
  const from=fund==="literature"?"library_editions e JOIN materials m ON m.id=e.material_id":"materials m";
  const where=conditions.join(" AND ");
  const rating=fund==="literature"?"(SELECT AVG(rating) FROM (SELECT rating FROM library_ratings WHERE edition_id=e.id AND review_state='published' UNION ALL SELECT rating FROM library_historical_reviews WHERE edition_id=e.id AND publication_state='published'))":"NULL";
  const extra=fund==="literature"?"e.id AS edition_id,e.title AS title,"+libraryCoverSql+" AS cover_url,json_extract(e.public_metadata_json,'$.genre') AS genre":"NULL AS edition_id,m.title AS title,('/api/catalog-v2/covers/'||m.id) AS cover_url,m.rubric AS genre";
  const order=sort==="newest"?"m.catalog_number DESC":sort==="rating"?"rating DESC,m.sort_title,m.id":"m.sort_title,m.id";
  const rows=await db.prepare(`SELECT m.id AS material_id,${extra},m.author,m.publisher,m.publication_year AS year,m.class_from,m.class_to,${rating} AS rating,
    max(0,coalesce(t.library_quantity,0)-coalesce(t.reserved_quantity,0)) AS available,coalesce(t.total_quantity,0) AS total
    FROM ${from} LEFT JOIN material_stock_totals t ON t.material_id=m.id WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...bindings,limit,(page-1)*limit).all();
  const count=await db.prepare(`SELECT count(*) AS n FROM ${from} WHERE ${where}`).bind(...bindings).first<{n:number}>();
  return {items:rows.results||[],total:count?.n||0,page,pages:Math.ceil(Number(count?.n||0)/limit),fund};
}
export async function readerCatalogFacets(db:ReaderDatabase){
  const rows=await db.prepare(`SELECT n.id,n.kind,n.name,count(DISTINCT e.id) AS count FROM library_catalog_entities n
    JOIN library_edition_entities x ON x.entity_id=n.id JOIN library_editions e ON e.id=x.edition_id
    JOIN materials m ON m.id=e.material_id WHERE e.publication_state='published' AND m.status='active' AND n.kind IN ('author','publisher','genre')
    GROUP BY n.id,n.kind,n.name ORDER BY n.kind,n.name LIMIT 2000`).all();
  return (rows.results||[]).sort((a,b)=>String(a.name).localeCompare(String(b.name),"uk"));
}
export async function getReaderCatalogBook(db:ReaderDatabase,id:string){
  if(!readerResource(id))readerFail("book_id","Некоректна книга.");
  if(/^CAT-\d+$/.test(id)){
    const linked=await db.prepare("SELECT id,publication_state FROM library_editions WHERE material_id=?").bind(id).first();
    if(linked){if(linked.publication_state!=="published")readerFail("book_missing","Книга ще не опублікована.",404);return getReaderCatalogBook(db,String(linked.id));}
    const material=await getCatalogMaterialDetail(db as CatalogD1Database,id,"public");
    if(!material)readerFail("book_missing","Книгу не знайдено.",404);
    return {id:material.id,fund:"education",title:material.title,materialId:material.id,metadata:{author:material.author,publisher:material.publisher,year:material.year,isbn:material.isbn,genre:material.rubric,subject:material.subject,coverUrl:material.thumbnailUrl,description:material.notes||""},available:material.availableQuantity,total:material.totalQuantity,entities:[],copies:[],reviews:[],links:material.links};
  }
  const row=await db.prepare(`SELECT e.id,e.title,e.material_id,e.fund,e.public_metadata_json,${libraryCoverSql} AS resolved_cover,coalesce(t.total_quantity,0) AS total,max(0,coalesce(t.library_quantity,0)-coalesce(t.reserved_quantity,0)) AS available
    FROM library_editions e JOIN materials m ON m.id=e.material_id LEFT JOIN material_stock_totals t ON t.material_id=m.id WHERE e.id=? AND e.publication_state='published' AND m.status='active'`).bind(id).first();
  if(!row)readerFail("book_missing","Книгу не знайдено або вона ще не опублікована.",404);
  const entities=await db.prepare("SELECT n.id,n.kind,n.name,x.role FROM library_edition_entities x JOIN library_catalog_entities n ON n.id=x.entity_id WHERE x.edition_id=? ORDER BY n.kind,n.name").bind(id).all();
  const copies=await db.prepare("SELECT id,accession_no,copy_no,physical_state,condition FROM library_copies WHERE edition_id=? AND registration='registered' AND physical_state!='withdrawn' ORDER BY accession_no,copy_no,id LIMIT 200").bind(id).all();
  const reviews=await db.prepare(`SELECT rating,body,CASE WHEN p.community_enabled=1 THEN p.display_name ELSE 'Читач бібліотеки' END AS display_name,x.updated_at AS date FROM library_ratings x JOIN reader_profiles p ON p.reader_id=x.reader_id WHERE x.edition_id=? AND x.review_state='published'
    UNION ALL SELECT rating,body,'Відгук із Librarika',source_date_display FROM library_historical_reviews WHERE edition_id=? AND publication_state='published' LIMIT 100`).bind(id,id).all();
  return {id:row.id,title:row.title,materialId:row.material_id,fund:row.fund,metadata:{...JSON.parse(String(row.public_metadata_json)),coverUrl:row.resolved_cover},available:row.available,total:row.total,entities:entities.results||[],copies:copies.results||[],reviews:reviews.results||[],links:[]};
}
export async function getReaderCatalogEntity(db:ReaderDatabase,id:string){
  if(!readerResource(id))readerFail("entity_id","Некоректний довідник.");
  const row=await db.prepare(`SELECT n.id,n.kind,n.name,n.public_metadata_json FROM library_catalog_entities n WHERE n.id=? AND EXISTS(
    SELECT 1 FROM library_edition_entities x JOIN library_editions e ON e.id=x.edition_id JOIN materials m ON m.id=e.material_id
    WHERE x.entity_id=n.id AND e.publication_state='published' AND m.status='active')`).bind(id).first();
  if(!row)readerFail("entity_missing","Запис не знайдено.",404);
  return {id:row.id,kind:row.kind,name:row.name,metadata:JSON.parse(String(row.public_metadata_json))};
}
export async function scanReaderCatalog(db:ReaderDatabase,code:string){
  code=code.trim();if(!code||code.length>120)readerFail("scan_code","Введіть код примірника або ISBN.");
  if(/^https:\/\//.test(code)){try{const url=new URL(code);if(url.hostname!=="yedyna-biblioteka-liceiu.nazarijshvetz1.chatgpt.site")readerFail("scan_external","Це код іншого сайту. Введіть бібліотечний номер вручну.");code=url.searchParams.get("copy")||url.searchParams.get("book")||"";}catch{readerFail("scan_code","Некоректний код.");}}
  const normalized=code.replace(/[^0-9X]/gi,"").toUpperCase(),isbn=/^(?:\d{13}|\d{9}[\dX])$/.test(normalized)?normalized:"";
  const rows=await db.prepare(`SELECT c.id AS copy_id,c.accession_no AS accession_no,c.copy_no AS copy_no,c.physical_state AS physical_state,e.id AS edition_id,e.title AS title,${libraryCoverSql} AS cover_url,'copy' AS result_kind
    FROM library_copies c JOIN library_editions e ON e.id=c.edition_id JOIN materials m ON m.id=e.material_id WHERE e.publication_state='published' AND m.status='active' AND c.registration='registered' AND c.physical_state!='withdrawn'
      AND (c.id=? OR c.accession_no=? OR e.id=? OR m.id=? OR (?<>'' AND m.isbn_normalized=?))
    UNION ALL
    SELECT 'edition:'||coalesce(e.id,m.id) AS copy_id,'' AS accession_no,'' AS copy_no,'' AS physical_state,coalesce(e.id,m.id) AS edition_id,m.title AS title,coalesce(${libraryCoverSql},'/api/catalog-v2/covers/'||m.id) AS cover_url,'edition' AS result_kind
    FROM materials m LEFT JOIN library_editions e ON e.material_id=m.id
    WHERE m.status='active' AND (e.id IS NULL OR e.publication_state='published')
      AND NOT EXISTS(SELECT 1 FROM library_copies c WHERE c.edition_id=e.id AND c.registration='registered' AND c.physical_state!='withdrawn')
      AND (m.id=? OR e.id=? OR (?<>'' AND m.isbn_normalized=?))
    ORDER BY title,copy_no,copy_id LIMIT 100`).bind(code,code,code,code,isbn,isbn,code,code,isbn,isbn).all();
  return {matches:rows.results||[],ambiguous:(rows.results||[]).length>1};
}
