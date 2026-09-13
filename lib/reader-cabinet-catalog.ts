import {normalizeCatalogSearchText} from './catalog-d1.ts';
import {literatureEntityMetadata} from './literature-entity-metadata.ts';
import {countryLabel} from './literature-labels.ts';
import {readerFail,readerResource,type ReaderDatabase} from './reader-core.ts';

export const cabinetCover="'/api/reader/cover?id='||e.id||'&v='||e.version";
const fold=(column:string)=>[...'АБВГҐДЕЄЖЗИІЇЙКЛМНОПРСТУФХЦЧШЩЬЮЯЫЭЪЁ'].reduce((sql,c)=>`replace(${sql},'${c}','${c.toLowerCase()}')`,`lower(${column})`);
const searchFold=(column:string)=>`replace(replace(replace(replace(replace(replace(${fold(column)},'’',''''),char(96),''''),'-',' '),'–',' '),'—',' '),'‑',' ')`;
const visible="e.fund='literature' AND e.publication_state='published' AND (m.id IS NULL OR m.status='active')";
const from='library_editions e LEFT JOIN materials m ON m.id=e.material_id';
const relationMatch="((n.kind='author' AND x.role IN ('author','coauthor')) OR (n.kind!='author' AND x.role=n.kind))";
const relatedRelationMatch="((n.kind='author' AND rx.role IN ('author','coauthor')) OR (n.kind!='author' AND rx.role=n.kind))";
const kinds=['genre','author','publisher','tag','series'] as const;
type EntityKind=(typeof kinds)[number];
const relations=`(SELECT json_group_array(json_object('id',n.id,'kind',n.kind,'name',n.name,'role',x.role,'count',(SELECT count(DISTINCT related.id) FROM library_edition_entities rx JOIN library_editions related ON related.id=rx.edition_id LEFT JOIN materials rm ON rm.id=related.material_id WHERE rx.entity_id=n.id AND ${relatedRelationMatch} AND related.fund='literature' AND related.publication_state='published' AND (rm.id IS NULL OR rm.status='active')))) FROM library_edition_entities x JOIN library_catalog_entities n ON n.id=x.entity_id WHERE x.edition_id=e.id AND ${relationMatch})`;
const projection=`e.id,e.title,${cabinetCover} cover_url,json_extract(e.public_metadata_json,'$.author') author,json_extract(e.public_metadata_json,'$.publisher') publisher,json_extract(e.public_metadata_json,'$.year') year,coalesce(json_extract(e.public_metadata_json,'$.type'),'Книга') type,${relations} relations_json,
 (SELECT count(*) FROM library_copies c WHERE c.edition_id=e.id AND c.registration='registered' AND c.physical_state!='withdrawn') total,
 (SELECT count(*) FROM library_copies c WHERE c.edition_id=e.id AND c.registration='registered' AND c.physical_state='on_shelf' AND NOT EXISTS(SELECT 1 FROM reader_circulations l WHERE l.copy_id=c.id AND l.status IN ('pending','reserved','issued','overdue'))) available`;

function parseRelations(value:unknown){try{const rows=JSON.parse(String(value||'[]'));return Array.isArray(rows)?rows:[];}catch{return [];}}
function isReaderRelation(entity:any){return (kinds as readonly string[]).includes(entity?.kind)&&((entity.kind==='author'&&['author','coauthor'].includes(entity.role))||(entity.kind!=='author'&&entity.role===entity.kind));}
function kind(value:string):EntityKind{if(!(kinds as readonly string[]).includes(value))readerFail('filter','Невідомий довідник.');return value as EntityKind;}
function page(value:string|null){const result=Number(value||1);if(!Number.isInteger(result)||result<1||result>10000)readerFail('page','Некоректна сторінка.');return result;}
function like(value:string){return '%'+value.replace(/[!%_]/g,v=>'!'+v)+'%';}

export function cabinetCard(row:Record<string,unknown>){
 const {relations_json,...rest}=row,unique=new Map<string,any>();
 for(const entity of parseRelations(relations_json).filter(isReaderRelation)){
  const previous=unique.get(entity.id);
  if(!previous||entity.role==='author')unique.set(entity.id,entity);
 }
 const entities=[...unique.values()];
 return {...rest,entities,author:entities.filter(x=>x.kind==='author').map(x=>x.name).join(', ')||row.author||'',publisher:entities.filter(x=>x.kind==='publisher').map(x=>x.name).join(', ')||row.publisher||''};
}

export async function assertReaderEdition(db:ReaderDatabase,id:unknown){if(typeof id!=='string'||!readerResource(id)||!await db.prepare(`SELECT e.id FROM ${from} WHERE e.id=? AND ${visible}`).bind(id).first())readerFail('book_missing','Книга недоступна в художній бібліотеці.',404);return id;}

export async function cabinetCatalog(db:ReaderDatabase,url:URL){
 const raw=(url.searchParams.get('q')||'').trim(),q=normalizeCatalogSearchText(raw),currentPage=page(url.searchParams.get('page')),sort=url.searchParams.get('sort')||'title';
 if(q.length>100||!['title','newest'].includes(sort))readerFail('catalog_query','Перевірте параметри пошуку.');
 const where=[visible],bind:(string|number)[]=[];
 if(q){where.push(`(m.search_text LIKE ? ESCAPE '!' OR ${searchFold('e.title')} LIKE ? ESCAPE '!' OR EXISTS(SELECT 1 FROM library_edition_entities sx JOIN library_catalog_entities sn ON sn.id=sx.entity_id WHERE sx.edition_id=e.id AND sn.kind='author' AND sx.role IN ('author','coauthor') AND ${searchFold('sn.name')} LIKE ? ESCAPE '!'))`);bind.push(like(q),like(q),like(q));}
 for(const entityKind of kinds){const id=url.searchParams.get(entityKind);if(id){if(!readerResource(id))readerFail('filter','Некоректний фільтр.');where.push(`EXISTS(SELECT 1 FROM library_edition_entities x JOIN library_catalog_entities n ON n.id=x.entity_id WHERE x.edition_id=e.id AND x.entity_id=? AND n.kind=? AND ${relationMatch})`);bind.push(id,entityKind);}}
 const w=where.join(' AND '),total=Number((await db.prepare(`SELECT count(*) n FROM ${from} WHERE ${w}`).bind(...bind).first())?.n||0);
 const rows=await db.prepare(`SELECT ${projection} FROM ${from} WHERE ${w} ORDER BY ${sort==='newest'?'e.created_at DESC,e.id DESC':'coalesce(m.sort_title,e.title),e.id'} LIMIT 20 OFFSET ?`).bind(...bind,(currentPage-1)*20).all();
 return {items:(rows.results||[]).map(cabinetCard),total,page:currentPage,pages:Math.ceil(total/20)};
}

export async function cabinetFacets(db:ReaderDatabase,url:URL){
 const entityKind=kind(url.searchParams.get('kind')||'genre'),q=normalizeCatalogSearchText(url.searchParams.get('q')||''),currentPage=page(url.searchParams.get('page'));
 if(q.length>100)readerFail('filter','Перевірте пошук.');
 // Suggestions stay quiet on an empty focus. Explicit directory browsing has its own endpoint.
 if(!q)return {items:[],more:false};
 const rows=await db.prepare(`SELECT n.id,n.kind,n.name,count(DISTINCT e.id) count FROM library_catalog_entities n JOIN library_edition_entities x ON x.entity_id=n.id JOIN library_editions e ON e.id=x.edition_id LEFT JOIN materials m ON m.id=e.material_id WHERE ${visible} AND n.kind=? AND ${relationMatch} AND COALESCE(json_extract(n.public_metadata_json,'$.archived'),0)=0 AND ${searchFold('n.name')} LIKE ? ESCAPE '!' GROUP BY n.id ORDER BY ${fold('n.name')},n.id LIMIT 21 OFFSET ?`).bind(entityKind,like(q),(currentPage-1)*20).all();
 return {items:(rows.results||[]).slice(0,20),more:(rows.results||[]).length>20};
}

export async function cabinetEntities(db:ReaderDatabase,url:URL){
 const entityKind=kind(url.searchParams.get('kind')||'genre'),raw=(url.searchParams.get('q')||'').trim(),q=normalizeCatalogSearchText(raw),currentPage=page(url.searchParams.get('page'));
 if(q.length>100)readerFail('filter','Перевірте пошук.');
 const linked=`EXISTS(SELECT 1 FROM library_edition_entities x JOIN library_editions e ON e.id=x.edition_id LEFT JOIN materials m ON m.id=e.material_id WHERE x.entity_id=n.id AND ${relationMatch} AND ${visible})`;
 const where=`n.kind=? AND COALESCE(json_extract(n.public_metadata_json,'$.archived'),0)=0 AND ${linked}${q?` AND ${searchFold('n.name')} LIKE ? ESCAPE '!'`:''}`;
 const bindings=q?[entityKind,like(q)]:[entityKind];
 const total=Number((await db.prepare(`SELECT count(*) n FROM library_catalog_entities n WHERE ${where}`).bind(...bindings).first())?.n||0);
 const rows=await db.prepare(`SELECT n.id,n.kind,n.name,(SELECT count(DISTINCT e.id) FROM library_edition_entities x JOIN library_editions e ON e.id=x.edition_id LEFT JOIN materials m ON m.id=e.material_id WHERE x.entity_id=n.id AND ${relationMatch} AND ${visible}) count FROM library_catalog_entities n WHERE ${where} ORDER BY ${fold('n.name')},n.id LIMIT 30 OFFSET ?`).bind(...bindings,(currentPage-1)*30).all();
 return {items:rows.results||[],total,page:currentPage,pages:Math.ceil(total/30)};
}

const metadataKeys:Record<EntityKind,string[]>={
 author:['nickname','country','dateOfBirth','yearBorn','yearDied','dateOfDeath','biography','publications','awards','website'],
 publisher:['city','country','address','location','website','email','phone','description'],
 genre:['description'],tag:['description'],series:['description'],
};
function publicMetadata(entityKind:EntityKind,row:Record<string,unknown>){
 const raw=literatureEntityMetadata(row),result:Record<string,string>={};
 for(const key of metadataKeys[entityKind]){const value=raw[key];if((typeof value==='string'||typeof value==='number')&&String(value).trim())result[key]=String(value).trim().slice(0,20000);}
 if(!result.dateOfBirth&&result.yearBorn)result.dateOfBirth=result.yearBorn;
 if(!result.yearDied&&result.dateOfDeath)result.yearDied=result.dateOfDeath;
 if(!result.address&&result.location)result.address=result.location;
 if(result.country)result.country=countryLabel(result.country);
 delete result.yearBorn;delete result.dateOfDeath;delete result.location;
 return result;
}

export async function cabinetEntity(db:ReaderDatabase,url:URL){
 const id=url.searchParams.get('id')||'';if(!readerResource(id))readerFail('entity_missing','Запис довідника не знайдено.',404);
 const row=await db.prepare(`SELECT n.* FROM library_catalog_entities n WHERE n.id=? AND n.kind IN ('genre','author','publisher','tag','series') AND COALESCE(json_extract(n.public_metadata_json,'$.archived'),0)=0 AND EXISTS(SELECT 1 FROM library_edition_entities x JOIN library_editions e ON e.id=x.edition_id LEFT JOIN materials m ON m.id=e.material_id WHERE x.entity_id=n.id AND ${relationMatch} AND ${visible})`).bind(id).first();
 if(!row)readerFail('entity_missing','Запис довідника не знайдено.',404);
 const entityKind=kind(String(row.kind)),booksUrl=new URL('https://reader.local/');booksUrl.searchParams.set(entityKind,id);booksUrl.searchParams.set('page',String(page(url.searchParams.get('page'))));booksUrl.searchParams.set('sort',url.searchParams.get('sort')==='newest'?'newest':'title');
 const books=await cabinetCatalog(db,booksUrl);
 return {entity:{id:String(row.id),kind:entityKind,name:String(row.name),metadata:publicMetadata(entityKind,row)},books};
}

export async function cabinetBook(db:ReaderDatabase,id:string){await assertReaderEdition(db,id);const row=await db.prepare(`SELECT ${projection},e.public_metadata_json FROM ${from} WHERE e.id=?`).bind(id).first();const {public_metadata_json,...card}=row!;const meta=JSON.parse(String(public_metadata_json||'{}'));
 const reviews=await db.prepare(`SELECT x.rating,x.body,CASE WHEN p.community_enabled=1 THEN p.display_name ELSE 'Читач бібліотеки' END display_name,x.updated_at date FROM library_ratings x JOIN reader_profiles p ON p.reader_id=x.reader_id WHERE x.edition_id=? AND x.review_state='published'
 UNION ALL SELECT rating,body,'Відгук з архіву бібліотеки',source_date_display FROM library_historical_reviews WHERE edition_id=? AND publication_state='published' ORDER BY date DESC LIMIT 100`).bind(id,id).all();
 return {...cabinetCard(card),annotation:meta.annotation||meta.description||'',reviews:reviews.results||[]};
}

export async function cabinetScan(db:ReaderDatabase,raw:string){let code=raw.trim();if(!code||code.length>200)readerFail('scan','Введіть код книги.');if(code.startsWith('https://')){let u:URL;try{u=new URL(code);}catch{readerFail('scan','Некоректний код.');}if(u!.hostname!=='yedyna-biblioteka-liceiu.nazarijshvetz1.chatgpt.site')readerFail('scan','Цей код належить іншому сайту.');code=u!.searchParams.get('book')||u!.searchParams.get('copy')||'';}
 const isbn=code.replace(/[^0-9X]/gi,'').toUpperCase();const rows=await db.prepare(`SELECT ${projection} FROM ${from} WHERE ${visible} AND (e.id=? OR e.material_id=? OR m.isbn_normalized=? OR json_extract(e.public_metadata_json,'$.isbn13')=? OR json_extract(e.public_metadata_json,'$.isbn10')=? OR EXISTS(SELECT 1 FROM library_copies c WHERE c.edition_id=e.id AND c.registration='registered' AND c.physical_state!='withdrawn' AND (c.id=? OR c.accession_no=?))) ORDER BY e.title LIMIT 100`).bind(code,code,isbn||'no-isbn',isbn||'no-isbn',isbn||'no-isbn',code,code).all();return {items:(rows.results||[]).map(cabinetCard)};}
