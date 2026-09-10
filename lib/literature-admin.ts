import { countryAliases, countryCode, countryLabel, LITERATURE_TITLE } from "./literature-labels.ts";
import { normalizeCatalogSearchText } from "./catalog-d1.ts";
const libraryCoverSql = "'/api/librarian/literature/image?kind=edition&id='||e.id||'&v='||e.version";
import { beginLibraryCommand, finishLibraryCommand, libraryCommand } from "./library-copy-store.ts";
import { readerBatch, readerFail, requireChanged, type ReaderDatabase, type LibraryActor } from "./reader-core.ts";
import { createExcelWorkbookBytes } from "./library-excel-export.ts";

type Row = Record<string, unknown>;
type Input = Record<string, unknown> & { requestId: string };
const activeLoans = "('issued','overdue')";
export const literatureToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date());
const metadata = (row: Row) => { try { return JSON.parse(String(row.public_metadata_json || "{}")) as Row; } catch { return {}; } };
const like = (value: string) => "%" + value.replace(/[!%_]/g, x => "!" + x) + "%";
const text = (value: unknown, max = 500) => { if (typeof value !== "string" || value.length > max) readerFail("field", "Перевірте заповнені поля."); return value.trim(); };
const version = (value: unknown) => { if (!Number.isInteger(value) || Number(value) < 1) readerFail("version", "Оновіть картку перед зміною."); return Number(value); };
export function literatureDate(value: unknown) { const date = text(value, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) readerFail("date", "Перевірте дату."); return date; }
function pageInfo(url: URL) { const page = Number(url.searchParams.get("page") || 1); if (!Number.isInteger(page) || page < 1 || page > 10000) readerFail("page", "Невідома сторінка."); return { page, limit: 30, offset: (page - 1) * 30 }; }
export async function assertLiterature(db: ReaderDatabase, id: unknown, kind: "edition" | "copy" | "loan" = "edition") {
  const query = kind === "edition" ? "SELECT e.id FROM library_editions e WHERE e.id=? AND e.fund='literature'" : kind === "copy" ? "SELECT e.id FROM library_copies c JOIN library_editions e ON e.id=c.edition_id WHERE c.id=? AND e.fund='literature'" : "SELECT e.id FROM reader_circulations l JOIN library_copies c ON c.id=l.copy_id JOIN library_editions e ON e.id=c.edition_id WHERE l.id=? AND e.fund='literature'";
  if (!await db.prepare(query).bind(String(id || "")).first()) readerFail("literature_only", "Запис не належить до каталогу художньої та наукової літератури.", 404);
}
// Relations are authoritative for linked authors/publishers; edits to a dictionary
// immediately affect cards and ordering without changing educational materials.
const linkedField = (kind:string,field=kind) => `COALESCE((SELECT group_concat(n.name,', ') FROM library_edition_entities x JOIN library_catalog_entities n ON n.id=x.entity_id WHERE x.edition_id=e.id AND x.role='${kind}'),json_extract(e.public_metadata_json,'$.${field}'),'')`;
const linkedMetadata = `json_set(e.public_metadata_json,'$.author',${linkedField("author")},'$.publisher',${linkedField("publisher")},'$.genre',${linkedField("genre")},'$.tags',${linkedField("tag","tags")},'$.series',${linkedField("series")})`;
const foldedEntityName = Array.from("АБВГҐДЕЄЖЗИІЇЙКЛМНОПРСТУФХЦЧШЩЬЮЯ").reduce((sql,ch)=>`replace(${sql},'${ch}','${ch.toLowerCase()}')`,"lower(n.name)");
const bookProjection = `e.id,e.title,e.version,e.material_id,e.publication_state,e.created_at,${linkedMetadata} AS public_metadata_json,${libraryCoverSql} AS cover_url,
 (SELECT count(*) FROM library_copies c WHERE c.edition_id=e.id AND c.physical_state!='withdrawn') AS copies,
 (SELECT count(*) FROM library_copies c WHERE c.edition_id=e.id AND c.registration='registered' AND c.physical_state='on_shelf' AND NOT EXISTS(SELECT 1 FROM reader_circulations l WHERE l.copy_id=c.id AND l.status IN ('pending','reserved','issued','overdue'))) AS available`;
export async function literatureBooks(db: ReaderDatabase, url: URL) {
  const { page, limit, offset } = pageInfo(url), q = text(url.searchParams.get("q") || "", 100), entity = url.searchParams.get("entity") || "";
  const sort = url.searchParams.get("sort") || "title", order: Record<string, string> = { title: "e.title,e.id", author: `${linkedField("author")},e.title,e.id`, category: `${linkedField("genre")},e.title,e.id`, publisher: `${linkedField("publisher")},e.title,e.id`, newest: "e.created_at DESC,e.id DESC" };
  if (!Object.hasOwn(order,sort)) readerFail("sort", "Невідоме сортування.");
  let where = `e.fund='literature' AND e.publication_state${url.searchParams.get("archived") === "1" ? "=" : "!="}'archived' AND (?='' OR m.search_text LIKE ? ESCAPE '!' OR e.title LIKE ? ESCAPE '!' OR e.public_metadata_json LIKE ? ESCAPE '!' OR EXISTS(SELECT 1 FROM library_edition_entities x JOIN library_catalog_entities n ON n.id=x.entity_id WHERE x.edition_id=e.id AND ${foldedEntityName} LIKE ? ESCAPE '!')) AND (?='' OR EXISTS(SELECT 1 FROM library_edition_entities x WHERE x.edition_id=e.id AND x.entity_id=?))`;
  const bindings = [q, like(normalizeCatalogSearchText(q)), like(q), like(q), like(normalizeCatalogSearchText(q)), entity, entity];
  for(const [param,kind,field] of [["author","author","author"],["category","genre","genre"],["publisher","publisher","publisher"],["tag","tag","tags"]]){
    const value=text(url.searchParams.get(param)||"",300).toLocaleLowerCase("uk-UA");
    if(value){const sql=Array.from("АБВГҐДЕЄЖЗИІЇЙКЛМНОПРСТУФХЦЧШЩЬЮЯ").reduce((q,ch)=>`replace(${q},'${ch}','${ch.toLowerCase()}')`,`lower(${linkedField(kind,field)})`);where+=` AND ${sql} LIKE ? ESCAPE '!'`;bindings.push(like(value));}
  }
  const country=text(url.searchParams.get("country")||"",100);if(country){where+=" AND EXISTS(SELECT 1 FROM library_edition_entities ce JOIN library_catalog_entities a ON a.id=ce.entity_id WHERE ce.edition_id=e.id AND a.kind='author' AND json_extract(a.public_metadata_json,'$.country') IN (SELECT value FROM json_each(?)))";bindings.push(JSON.stringify(countryAliases(country)));}
  const count = await db.prepare(`SELECT count(*) n FROM library_editions e LEFT JOIN materials m ON m.id=e.material_id WHERE ${where}`).bind(...bindings).first();
  const rows = await db.prepare(`SELECT ${bookProjection} FROM library_editions e LEFT JOIN materials m ON m.id=e.material_id WHERE ${where} ORDER BY ${order[sort]} LIMIT ? OFFSET ?`).bind(...bindings, limit, offset).all();
  return { items: (rows.results || []).map(row => ({ ...row, metadata: metadata(row) })), total: Number(count?.n || 0), page, pages: Math.ceil(Number(count?.n || 0) / limit) };
}
export async function literatureBook(db: ReaderDatabase, id: string) {
  await assertLiterature(db, id);
  const row = await db.prepare(`SELECT ${bookProjection},m.version material_version,COALESCE((SELECT version FROM material_cover_assets a WHERE a.material_id=m.id),0) cover_version FROM library_editions e LEFT JOIN materials m ON m.id=e.material_id WHERE e.id=?`).bind(id).first();
  if (!row) readerFail("missing", "Книгу не знайдено.", 404);
  const entities = await db.prepare("SELECT n.id,n.name,n.kind,x.role FROM library_edition_entities x JOIN library_catalog_entities n ON n.id=x.entity_id WHERE x.edition_id=? ORDER BY n.kind,n.name").bind(id).all();
  const copies = await db.prepare(`SELECT c.*,loc.name location_name,(SELECT l.status FROM reader_circulations l WHERE l.copy_id=c.id AND l.status IN ('pending','reserved','issued','overdue') LIMIT 1) loan_status FROM library_copies c LEFT JOIN locations loc ON loc.id=c.location_id WHERE c.edition_id=? ORDER BY c.created_at,c.id LIMIT 2000`).bind(id).all();
  return { ...row, metadata: metadata(row), entities: entities.results || [], copies: copies.results || [], entityIds: (entities.results || []).map(x => x.id) };
}
export async function literatureEntities(db: ReaderDatabase, url: URL) {
  const kind = url.searchParams.get("kind") || "author", q = text(url.searchParams.get("q") || "", 100), { page, limit, offset } = pageInfo(url);
  if (!["author", "publisher", "genre", "tag", "series"].includes(kind)) readerFail("entity_kind", "Невідомий довідник.");
  const entityId=url.searchParams.get("id")||""; const where = `n.kind=? AND (?='' OR n.id=?) AND COALESCE(json_extract(n.public_metadata_json,'$.archived'),0)=0 AND (?='' OR ${foldedEntityName} LIKE ? ESCAPE '!')`;
  const count = await db.prepare(`SELECT COUNT(*) n FROM library_catalog_entities n WHERE ${where}`).bind(kind,entityId,entityId, q, like(normalizeCatalogSearchText(q))).first();
  const result = await db.prepare(`SELECT n.*,(SELECT count(DISTINCT e.id) FROM library_edition_entities x JOIN library_editions e ON e.id=x.edition_id WHERE x.entity_id=n.id AND e.fund='literature' AND e.publication_state!='archived') books FROM library_catalog_entities n WHERE ${where} ORDER BY n.name,n.id LIMIT ? OFFSET ?`).bind(kind,entityId,entityId, q, like(normalizeCatalogSearchText(q)), limit, offset).all();
  return { items: (result.results || []).map(row => ({ ...row, metadata: metadata(row) })), total: Number(count?.n || 0), page, pages: Math.ceil(Number(count?.n || 0) / limit) };
}
export async function literatureOptions(db: ReaderDatabase) {
  const [entities, locations, classes, years] = await Promise.all([
    db.prepare("SELECT id,kind,name,json_extract(public_metadata_json,'$.country') country FROM library_catalog_entities WHERE COALESCE(json_extract(public_metadata_json,'$.archived'),0)=0 ORDER BY kind,name LIMIT 5000").all(),
    db.prepare("SELECT id,name FROM locations WHERE status='active' AND type='library' ORDER BY sort_order,name").all(),
    db.prepare("SELECT c.id,c.class_name,a.label FROM class_years c JOIN academic_years a ON a.id=c.academic_year_id WHERE c.status IN ('active','planned') ORDER BY a.start_date DESC,c.grade,c.class_name").all(),
    db.prepare("SELECT DISTINCT json_extract(public_metadata_json,'$.year') year FROM library_editions WHERE fund='literature' AND publication_state!='archived' AND json_extract(public_metadata_json,'$.year') IS NOT NULL ORDER BY year DESC LIMIT 400").all(),
  ]); return { entities: (entities.results || []).map(r=>({...r,countryCode:countryCode(r.country),countryLabel:countryLabel(r.country)})), locations: locations.results || [], classes: classes.results || [], years:(years.results||[]).map(r=>String(r.year)).filter(Boolean) };
}
const loanFrom = "reader_circulations l JOIN library_copies c ON c.id=l.copy_id JOIN library_editions e ON e.id=c.edition_id LEFT JOIN materials m ON m.id=e.material_id JOIN library_readers r ON r.id=l.reader_id";
const loanProjection = `l.*,c.version copy_version,c.accession_no,c.copy_no,c.condition,c.location_id,e.id edition_id,e.title,${libraryCoverSql} cover_url,r.full_name,r.member_no,r.kind,r.version reader_version`;
export async function literatureLoans(db: ReaderDatabase, url: URL, exportAll = false) {
  const { page, limit, offset } = pageInfo(url), q = normalizeCatalogSearchText(text(url.searchParams.get("q") || "", 100)), reader = url.searchParams.get("reader") || "", status = url.searchParams.get("status") || "all", today = literatureToday();
  const sort = url.searchParams.get("sort") || "due", direction = url.searchParams.get("direction") === "desc" ? "DESC" : "ASC";
  const sorting: Record<string,string> = { reader: "r.sort_name", issued: "l.issued_at", due: "l.due_at", returned: "l.received_at", created: "l.created_at" };
  if (!Object.hasOwn(sorting,sort) || !["all", "issued", "overdue", "returned", "pending", "reserved", "cancelled"].includes(status)) readerFail("loan_filter", "Перевірте фільтри видач.");
  const conditions = ["e.fund='literature'", "(?='' OR l.reader_id=?)", "(?='' OR r.sort_name LIKE ? ESCAPE '!' OR m.search_text LIKE ? ESCAPE '!')"], values: (string|number)[] = [reader, reader, q, like(q), like(q)];
  if (status === "overdue") { conditions.push(`l.status IN ${activeLoans} AND substr(l.due_at,1,10)<?`); values.push(today); }
  else if (status === "issued") conditions.push(`l.status IN ${activeLoans}`);
  else if (status !== "all") { conditions.push("l.status=?"); values.push(status); }
  for (const [param, op] of [["from", ">="], ["to", "<="]]) { const date = url.searchParams.get(param); if (date) { conditions.push(`substr(COALESCE(l.issued_at,l.created_at),1,10)${op}?`); values.push(literatureDate(date)); } }
  const where = conditions.join(" AND "), count = await db.prepare(`SELECT count(*) n FROM ${loanFrom} WHERE ${where}`).bind(...values).first();
  if (exportAll && Number(count?.n) > 10000) readerFail("export_limit", "Звузьте період експорту до 10 000 видач.");
  const rows = await db.prepare(`SELECT ${loanProjection} FROM ${loanFrom} WHERE ${where} ORDER BY ${sorting[sort]} ${direction},l.id LIMIT ? OFFSET ?`).bind(...values, exportAll ? 10000 : limit, exportAll ? 0 : offset).all();
  return { items: (rows.results || []).map((row):Row => ({ ...row, display_status: ["issued","overdue"].includes(String(row.status)) ? row.due_at && String(row.due_at).slice(0,10) < today ? "overdue" : "issued" : row.status })), total: Number(count?.n || 0), page, pages: Math.ceil(Number(count?.n || 0) / limit) };
}
export async function literatureReaders(db: ReaderDatabase, url: URL) {
  const { page, limit, offset } = pageInfo(url), q = normalizeCatalogSearchText(text(url.searchParams.get("q") || "", 100)), classId = url.searchParams.get("class") || "", kind = url.searchParams.get("kind") || "", inactive = url.searchParams.get("archived") === "1";
  const where = `r.status=? AND (?='' OR r.sort_name LIKE ? ESCAPE '!' OR r.member_no LIKE ? ESCAPE '!') AND (?='' OR ce.class_year_id=?) AND (?='' OR r.kind=?)`;
  const from = "library_readers r LEFT JOIN reader_profiles p ON p.reader_id=r.id LEFT JOIN reader_class_enrollments ce ON ce.reader_id=r.id AND ce.ended_at IS NULL LEFT JOIN class_years cy ON cy.id=ce.class_year_id";
  const bindings = [inactive ? "inactive" : "active", q, like(q), like(q), classId, classId, kind, kind];
  const count = await db.prepare(`SELECT count(*) n FROM ${from} WHERE ${where}`).bind(...bindings).first();
  const rows = await db.prepare(`SELECT r.id,r.full_name,r.member_no,r.kind,r.status,r.version,r.access_status,r.source_group_label,r.linked_teacher_user_id,p.phone,p.display_name,p.photo_key IS NOT NULL has_photo,cy.class_name,ce.class_year_id,
(SELECT json_group_array(json_object('id',e.id,'title',e.title,'overdue',CASE WHEN substr(l.due_at,1,10)<? THEN 1 ELSE 0 END)) FROM reader_circulations l JOIN library_copies c ON c.id=l.copy_id JOIN library_editions e ON e.id=c.edition_id WHERE l.reader_id=r.id AND l.status IN ('issued','overdue') AND e.fund='literature') active_books,
    CASE WHEN r.linked_teacher_user_id IS NOT NULL THEN (SELECT status FROM telegram_connections WHERE user_id=r.linked_teacher_user_id) ELSE (SELECT status FROM reader_telegram_connections WHERE reader_id=r.id) END telegram_status,
    (SELECT COUNT(*) FROM reader_circulations l JOIN library_copies c ON c.id=l.copy_id JOIN library_editions e ON e.id=c.edition_id WHERE l.reader_id=r.id AND l.status IN ${activeLoans} AND e.fund='literature') loan_count,
    (SELECT COUNT(*) FROM reader_circulations l JOIN library_copies c ON c.id=l.copy_id JOIN library_editions e ON e.id=c.edition_id WHERE l.reader_id=r.id AND l.status IN ${activeLoans} AND e.fund='literature' AND substr(l.due_at,1,10)<?) overdue_count
    FROM ${from} WHERE ${where} ORDER BY r.sort_name,r.id LIMIT ? OFFSET ?`).bind(literatureToday(),literatureToday(), ...bindings, limit, offset).all();
  return { items: rows.results || [], total: Number(count?.n || 0), page, pages: Math.ceil(Number(count?.n || 0) / limit) };
}
export async function literatureReader(db: ReaderDatabase, id: string) {
  const row = await db.prepare(`SELECT r.id,r.member_no,r.full_name,r.kind,r.status,r.version,r.access_status,r.linked_teacher_user_id,r.source_group_label,p.phone,p.photo_key IS NOT NULL has_photo,p.display_name,ce.class_year_id,cy.class_name,
    CASE WHEN r.linked_teacher_user_id IS NOT NULL THEN (SELECT status FROM telegram_connections WHERE user_id=r.linked_teacher_user_id) ELSE (SELECT status FROM reader_telegram_connections WHERE reader_id=r.id) END telegram_status
    FROM library_readers r LEFT JOIN reader_profiles p ON p.reader_id=r.id LEFT JOIN reader_class_enrollments ce ON ce.reader_id=r.id AND ce.ended_at IS NULL LEFT JOIN class_years cy ON cy.id=ce.class_year_id WHERE r.id=?`).bind(id).first();
  if (!row) readerFail("reader_missing", "Читача не знайдено.", 404); return row;
}
export async function literatureDashboard(db: ReaderDatabase, url: URL) {
  const today = literatureToday(), from = literatureDate(url.searchParams.get("from") || new Date(Date.parse(today) - 29*86400000).toISOString().slice(0,10)), to = literatureDate(url.searchParams.get("to") || today);
  if (from > to || Date.parse(to) - Date.parse(from) > 366*86400000) readerFail("period", "Оберіть період до одного року.");
  const stats = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM library_copies c JOIN library_editions e ON e.id=c.edition_id WHERE e.fund='literature' AND e.publication_state!='archived' AND c.physical_state!='withdrawn') copies,
    (SELECT COUNT(*) FROM library_readers WHERE status='active') readers,
    (SELECT COUNT(*) FROM ${loanFrom} WHERE e.fund='literature' AND l.status IN ${activeLoans} AND (l.due_at IS NULL OR substr(l.due_at,1,10)>=?)) current,
    (SELECT COUNT(*) FROM ${loanFrom} WHERE e.fund='literature' AND l.status IN ${activeLoans} AND substr(l.due_at,1,10)<?) overdue`).bind(today,today).first();
  const activity = await db.prepare(`SELECT substr(l.issued_at,1,10) day,SUM(CASE WHEN r.kind='student' THEN 1 ELSE 0 END) students,SUM(CASE WHEN r.kind='teacher' THEN 1 ELSE 0 END) teachers,COUNT(*) total FROM ${loanFrom} WHERE e.fund='literature' AND l.status IN ('issued','overdue','returned') AND substr(l.issued_at,1,10) BETWEEN ? AND ? GROUP BY substr(l.issued_at,1,10) ORDER BY day`).bind(from,to).all();
  const booksUrl = new URL("https://local.test/?sort=newest"), overdueUrl = new URL("https://local.test/?status=overdue");
  const [books, overdue] = await Promise.all([literatureBooks(db,booksUrl),literatureLoans(db,overdueUrl)]);
  return { stats, from, to, activity: activity.results || [], newBooks: books.items.slice(0,5), overdue: overdue.items.slice(0,5) };
}
export async function saveLiteratureReader(db: ReaderDatabase, actor: LibraryActor, input: Input) {
  const name = text(input.fullName,180).replace(/\s+/g," "), kind = text(input.kind,20), phone = text(input.phone || "",30), classId = text(input.classYearId || "",100), id = input.id ? text(input.id,100) : "READER-"+crypto.randomUUID();
  if (name.length < 3 || !["student","teacher","staff","other","unclassified"].includes(kind) || kind !== "student" && classId || phone && !/^\+?[0-9() .-]{7,30}$/.test(phone)) readerFail("reader_fields", "Перевірте ПІБ, категорію, клас і телефон.");
  const command = await libraryCommand(db,actor,input.requestId,"literature.reader.save",input); if(command.replayed) return command.replayed;
  const now = new Date().toISOString(), result = { id, version: input.id ? version(input.expectedVersion)+1 : 1 };
  const statements = [beginLibraryCommand(db,actor,input.requestId,"literature.reader.save",command.hash,id,now,"library_reader")];
  if (input.id) statements.push(db.prepare("UPDATE library_readers SET full_name=?,sort_name=?,kind=?,source_group_label=?,version=version+1,updated_at=? WHERE id=? AND version=? AND (linked_teacher_user_id IS NULL OR kind=?)").bind(name,normalizeCatalogSearchText(name),kind,text(input.groupLabel || "",120),now,id,version(input.expectedVersion),kind),requireChanged(db,1));
  else statements.push(db.prepare("INSERT INTO reader_number_allocations(request_id,reader_id,created_at) VALUES(?,?,?)").bind(input.requestId,id,now),db.prepare("INSERT INTO library_readers(id,member_no,full_name,sort_name,kind,source_group_label,status,access_status,created_at,updated_at) SELECT ?,CAST(26000000+ordinal AS TEXT),?,?,?,?,'active','inactive',?,? FROM reader_number_allocations WHERE request_id=?").bind(id,name,normalizeCatalogSearchText(name),kind,text(input.groupLabel || "",120),now,now,input.requestId));
  statements.push(db.prepare("INSERT INTO reader_profiles(reader_id,display_name,phone,updated_at) VALUES(?,'Читач',?,?) ON CONFLICT(reader_id) DO UPDATE SET phone=excluded.phone,version=reader_profiles.version+1,updated_at=excluded.updated_at").bind(id,phone,now));
  if(classId) statements.push(db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM class_years WHERE id=? AND status IN ('active','planned')) THEN 1 ELSE json('class_changed') END").bind(classId));
  statements.push(db.prepare("UPDATE reader_class_enrollments SET ended_at=? WHERE reader_id=? AND ended_at IS NULL AND class_year_id IS NOT ?").bind(now,id,classId||null));
  if(classId) statements.push(db.prepare("INSERT INTO reader_class_enrollments(id,reader_id,class_year_id,observed_at) SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM reader_class_enrollments WHERE reader_id=? AND ended_at IS NULL)").bind(crypto.randomUUID(),id,classId,now,id));
  statements.push(...finishLibraryCommand(db,actor,input.requestId,"literature.reader.save",id,result,now,"library_reader")); await readerBatch(db,statements); return result;
}
export async function saveLiteratureEntity(db: ReaderDatabase, actor: LibraryActor, input: Input) {
  const kind = text(input.kind,30), name = text(input.name,300), id = input.id ? text(input.id,100) : "ENTITY-"+crypto.randomUUID();
  if(!["author","publisher","genre","tag","series"].includes(kind) || !name) readerFail("entity_fields","Вкажіть назву довідника.");
  if(!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata)) readerFail("metadata","Перевірте поля довідника.");
  const allowed = ["firstName","lastName","nickname","biography","country","dateOfBirth","dateOfDeath","yearBorn","yearDied","website","address","email","phone","description"];
  const patch: Row = {}; for(const [key,value] of Object.entries(input.metadata)) { if(!allowed.includes(key)) readerFail("metadata","Невідоме поле."); patch[key]=text(value,key==="biography"||key==="description"?20000:1000); }
  if(patch.website && !safeLiteratureUrl(String(patch.website))) readerFail("url","Вкажіть повну адресу вебсторінки https:// або http://.");
  const command = await libraryCommand(db,actor,input.requestId,"literature.entity.save",input); if(command.replayed)return command.replayed;
  const now = new Date().toISOString(), result = { id, version: input.id ? version(input.expectedVersion)+1 : 1 };
  await readerBatch(db,[beginLibraryCommand(db,actor,input.requestId,"literature.entity.save",command.hash,id,now),input.id ? db.prepare("UPDATE library_catalog_entities SET name=?,public_metadata_json=json_patch(public_metadata_json,?),version=version+1 WHERE id=? AND kind=? AND version=? AND COALESCE(json_extract(public_metadata_json,'$.archived'),0)=0").bind(name,JSON.stringify(patch),id,kind,version(input.expectedVersion)) : db.prepare("INSERT INTO library_catalog_entities(id,kind,name,slug,public_metadata_json) VALUES(?,?,?,?,?)").bind(id,kind,name,id,JSON.stringify(patch)),requireChanged(db,1),...finishLibraryCommand(db,actor,input.requestId,"literature.entity.save",id,result,now)]); return result;
}
export function safeLiteratureUrl(value: string) { try { const u=new URL(value); return ["https:","http:"].includes(u.protocol)&&!u.username&&!u.password; } catch { return false; } }
export async function reserveLiteratureCopy(db: ReaderDatabase, actor: LibraryActor, input: Input) {
  const copyId=text(input.copyId,100),readerId=text(input.readerId,100),due=literatureDate(input.dueAt),date=literatureDate(input.issuedAt);
  if(due<date)readerFail("due","Строк повернення не може бути раніше дати резервування."); await assertLiterature(db,copyId,"copy");
  const command=await libraryCommand(db,actor,input.requestId,"literature.reserve",input);if(command.replayed)return command.replayed;
  const now=new Date().toISOString(),id="RLOAN-"+crypto.randomUUID(),result={id};
  await readerBatch(db,[beginLibraryCommand(db,actor,input.requestId,"literature.reserve",command.hash,id,now),db.prepare(`INSERT INTO reader_circulations(id,copy_id,reader_id,status,due_at,accounting_mode,created_at,updated_at) VALUES(?,
   (SELECT c.id FROM library_copies c JOIN library_editions e ON e.id=c.edition_id WHERE c.id=? AND c.version=? AND c.registration='registered' AND c.physical_state='on_shelf' AND e.fund='literature' AND e.publication_state!='archived' AND NOT EXISTS(SELECT 1 FROM reader_circulations l WHERE l.copy_id=c.id AND l.status IN ('pending','reserved','issued','overdue'))),
   (SELECT id FROM library_readers WHERE id=? AND version=? AND status='active'),'reserved',?,'native',?,?)`).bind(id,copyId,version(input.expectedCopyVersion),readerId,version(input.expectedReaderVersion),due,date,now),...finishLibraryCommand(db,actor,input.requestId,"literature.reserve",id,result,now)]);return result;
}
export async function cancelLiteratureReservation(db: ReaderDatabase, actor: LibraryActor, input: Input) {
  const id=text(input.id,100);await assertLiterature(db,id,"loan");const command=await libraryCommand(db,actor,input.requestId,"literature.cancel",input);if(command.replayed)return command.replayed;const now=new Date().toISOString(),result={id};
  await readerBatch(db,[beginLibraryCommand(db,actor,input.requestId,"literature.cancel",command.hash,id,now),db.prepare("UPDATE reader_circulations SET status='cancelled',version=version+1,updated_at=? WHERE id=? AND version=? AND status IN ('pending','reserved')").bind(now,id,version(input.expectedVersion)),requireChanged(db,1),...finishLibraryCommand(db,actor,input.requestId,"literature.cancel",id,result,now)]);return result;
}
export async function archiveLiteratureRecord(db: ReaderDatabase, actor: LibraryActor, input: Input) {
  const id=text(input.id,100),kind=text(input.kind,20),restore=input.restore===true,now=new Date().toISOString();
  const command=await libraryCommand(db,actor,input.requestId,"literature.archive",input);if(command.replayed)return command.replayed;
  const result={id,kind,restored:restore},statements=[beginLibraryCommand(db,actor,input.requestId,"literature.archive",command.hash,id,now)];
  if(kind==="edition") { await assertLiterature(db,id);statements.push(db.prepare(`UPDATE library_editions SET publication_state=?,version=version+1,updated_at=? WHERE id=? AND version=? AND fund='literature' AND NOT EXISTS(SELECT 1 FROM reader_circulations l JOIN library_copies c ON c.id=l.copy_id WHERE c.edition_id=? AND l.status IN ('pending','reserved','issued','overdue'))`).bind(restore?"published":"archived",now,id,version(input.expectedVersion),id)); }
  else if(kind==="reader") { statements.push(db.prepare(`UPDATE library_readers SET status=?,version=version+1,access_version=access_version+1,updated_at=? WHERE id=? AND version=? AND NOT EXISTS(SELECT 1 FROM reader_circulations WHERE reader_id=? AND status IN ('pending','reserved','issued','overdue'))`).bind(restore?"active":"inactive",now,id,version(input.expectedVersion),id)); }
  else if(kind==="entity") statements.push(db.prepare("UPDATE library_catalog_entities SET public_metadata_json=json_set(public_metadata_json,'$.archived',?),version=version+1 WHERE id=? AND version=? AND NOT EXISTS(SELECT 1 FROM library_edition_entities WHERE entity_id=?)").bind(restore?0:1,id,version(input.expectedVersion),id));
  else readerFail("archive_kind","Невідома картка.");
  statements.push(requireChanged(db,1));
  if(kind==="reader"&&!restore)statements.push(db.prepare("UPDATE reader_sessions SET revoked_at=? WHERE reader_id=? AND revoked_at IS NULL").bind(now,id),db.prepare("UPDATE reader_invites SET revoked_at=? WHERE reader_id=? AND revoked_at IS NULL").bind(now,id),db.prepare("UPDATE reader_notification_outbox SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE reader_id=? AND status IN ('pending','processing')").bind(id));
  statements.push(...finishLibraryCommand(db,actor,input.requestId,"literature.archive",id,result,now));await readerBatch(db,statements);return result;
}
export async function literatureReviews(db: ReaderDatabase, url: URL) {
  const {page,limit,offset}=pageInfo(url);
  const query=`SELECT 'reader' origin,x.edition_id||':'||x.reader_id id,x.edition_id,x.reader_id,x.rating,x.body,x.review_state status,x.version,x.updated_at date,e.title,${libraryCoverSql} cover_url,r.full_name author_name,p.photo_key IS NOT NULL has_photo FROM library_ratings x JOIN library_editions e ON e.id=x.edition_id LEFT JOIN materials m ON m.id=e.material_id JOIN library_readers r ON r.id=x.reader_id LEFT JOIN reader_profiles p ON p.reader_id=r.id WHERE e.fund='literature' AND x.body!='' AND x.review_state!='hidden'
  UNION ALL SELECT 'source',x.id,x.edition_id,NULL,x.rating,x.body,x.publication_state,1,x.source_date_display,e.title,${libraryCoverSql},COALESCE(json_extract(x.source_json,'$.name'),json_extract(x.source_json,'$.author'),'Читач Librarika'),0 FROM library_historical_reviews x JOIN library_editions e ON e.id=x.edition_id LEFT JOIN materials m ON m.id=e.material_id WHERE e.fund='literature' AND x.publication_state!='hidden'`;
  const count=await db.prepare(`SELECT COUNT(*) n FROM (${query})`).first(),rows=await db.prepare(`SELECT * FROM (${query}) ORDER BY date DESC,id LIMIT ? OFFSET ?`).bind(limit,offset).all();return {items:rows.results||[],total:Number(count?.n||0),page,pages:Math.ceil(Number(count?.n||0)/limit)};
}
export async function hideLiteratureReview(db: ReaderDatabase,actor: LibraryActor,input:Input) {
  const id=text(input.id,220);await assertLiterature(db,input.editionId);const command=await libraryCommand(db,actor,input.requestId,"literature.review.hide",input);if(command.replayed)return command.replayed;const now=new Date().toISOString(),result={id};
  await readerBatch(db,[beginLibraryCommand(db,actor,input.requestId,"literature.review.hide",command.hash,id,now),input.origin==="source"?db.prepare("UPDATE library_historical_reviews SET publication_state='hidden' WHERE id=? AND edition_id=? AND publication_state!='hidden'").bind(id,String(input.editionId)):db.prepare("UPDATE library_ratings SET review_state='hidden',version=version+1,updated_at=? WHERE edition_id=? AND reader_id=? AND version=? AND review_state!='hidden'").bind(now,String(input.editionId),String(input.readerId),version(input.expectedVersion)),requireChanged(db,1),...finishLibraryCommand(db,actor,input.requestId,"literature.review.hide",id,result,now)]);return result;
}
export async function literatureReaderExcel(db: ReaderDatabase,url:URL) {
  const id=text(url.searchParams.get("reader")||"",100),reader=await literatureReader(db,id),loans=await literatureLoans(db,url,true);
  const labels:Record<string,string>={issued:"Видано",overdue:"Прострочено",returned:"Повернуто",cancelled:"Скасовано",reserved:"Зарезервовано",pending:"Очікує"};
  return createExcelWorkbookBytes([{name:"Книги читача",reportTitle:LITERATURE_TITLE+" · книги читача",metadata:[["Читач",String(reader.full_name)],["Читацький номер",String(reader.member_no)],["Клас / категорія",String(reader.class_name||reader.source_group_label||reader.kind)]],columns:[{header:"Назва",width:48},{header:"Номер примірника",width:22},{header:"Видано",width:15},{header:"До",width:15},{header:"Повернуто",width:15},{header:"Статус",width:20}],rows:loans.items.map(row=>[String(row.title),String(row.accession_no),String(row.issued_at||""),String(row.due_at||""),String(row.received_at||""),labels[String(row.display_status)]||String(row.display_status)])}],new Date().toISOString(),LITERATURE_TITLE+" · книги читача");
}
