import {beginLibraryCommand,finishLibraryCommand,libraryCommand} from './library-copy-store.ts';
import {readerBatch,readerFail,type ReaderDatabase,type LibraryActor} from './reader-core.ts';

// Explicit source aliases, audited against class-update. Never transliterate every class.
const aliases:Record<string,string>={'1-B':'1-В','1-C':'1-С','5-IT1':'5-IT(1)','6-IT1':'6-IT(1)','6-IT2':'6-IT(2)','8-IT1':'8-IT(1)','8-IT2':'8-IT(2)','10-U1':'10-U(1)','10-U2':'10-U(2)','10-U3':'10-U(3)','11-U1':'11-U(1)','11-U2':'11-U(2)'};
export const sourceClassName=(value:string)=>Object.hasOwn(aliases,value)?aliases[value]:value;
type Assignment={readerId:string;sourceMemberId:string;memberNo:string;fullName:string;sourceGroup:string;expectedVersion:number;readerStatus:string;classYearId:string;className:string;academicYearId:string;expectedClassVersion:number};
export async function literatureClassPlan(db:ReaderDatabase){
 const years=(await db.prepare("SELECT id,label FROM academic_years WHERE status='active'").all()).results||[];
 if(years.length!==1)readerFail('academic_year','Потрібен один чинний навчальний рік.',409);
 const year=years[0],classes=(await db.prepare("SELECT id,class_name,version FROM class_years WHERE academic_year_id=? AND status='active'").bind(String(year.id)).all()).results||[];
 const readers=(await db.prepare("SELECT r.id,r.source_member_id,r.member_no,r.full_name,r.source_group_label,r.version,r.status,(SELECT class_year_id FROM reader_class_enrollments ce WHERE ce.reader_id=r.id AND ce.ended_at IS NULL) class_year_id FROM library_readers r WHERE r.kind='student' ORDER BY r.id LIMIT 10000").all()).results||[];
 const assignments:Assignment[]=[],excluded:{id:string;memberNo:string;fullName:string;reason:string}[]=[],summary=new Map<string,{sourceGroup:string;className:string;count:number}>();let alreadyAssigned=0;
 for(const r of readers){const source=String(r.source_group_label||''),name=sourceClassName(source),matches=classes.filter(c=>c.class_name===name);let reason='';
  if(!r.source_member_id||!source)reason='У джерелі немає класу';else if(matches.length!==1)reason='Немає однозначного чинного класу';else if(r.class_year_id&&r.class_year_id!==matches[0].id)reason='Уже призначено інший клас';
  if(reason){excluded.push({id:String(r.id),memberNo:String(r.member_no),fullName:String(r.full_name),reason});continue;}
  if(r.class_year_id){alreadyAssigned++;continue;}
  const c=matches[0];assignments.push({readerId:String(r.id),sourceMemberId:String(r.source_member_id),memberNo:String(r.member_no),fullName:String(r.full_name),sourceGroup:source,expectedVersion:Number(r.version),readerStatus:String(r.status),classYearId:String(c.id),className:name,academicYearId:String(year.id),expectedClassVersion:Number(c.version)});
  const count=summary.get(source)||{sourceGroup:source,className:name,count:0};count.count++;summary.set(source,count);
 }
 return {academicYear:year.label,assignments,alreadyAssigned,excluded,summary:[...summary.values()].sort((a,b)=>a.sourceGroup.localeCompare(b.sourceGroup,'uk',{numeric:true}))};
}
export async function applyLiteratureClasses(db:ReaderDatabase,actor:LibraryActor,input:{requestId:string;assignments:Assignment[]}){
 if(!Array.isArray(input.assignments)||!input.assignments.length||input.assignments.length>20||new Set(input.assignments.map(x=>x?.readerId)).size!==input.assignments.length)readerFail('class_batch','Перевірте пакет класів.');
 for(const a of input.assignments){if(!a||!['readerId','sourceMemberId','memberNo','fullName','sourceGroup','classYearId','className','academicYearId','readerStatus'].every(key=>typeof a[key as keyof Assignment]==='string'&&String(a[key as keyof Assignment]).length<=300)||!Number.isInteger(a.expectedVersion)||!Number.isInteger(a.expectedClassVersion)||!a.sourceMemberId||sourceClassName(a.sourceGroup)!==a.className)readerFail('class_mapping','Клас не відповідає джерелу.');}
 const command=await libraryCommand(db,actor,input.requestId,'literature.classes.assign',input);if(command.replayed)return command.replayed;
 const now=new Date().toISOString(),statements=[beginLibraryCommand(db,actor,input.requestId,'literature.classes.assign',command.hash,'reader_classes',now)];
 for(const a of input.assignments){
  statements.push(db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM library_readers WHERE id=? AND source_member_id=? AND member_no=? AND full_name=? AND source_group_label=? AND kind='student' AND status=? AND version=?) AND EXISTS(SELECT 1 FROM class_years c JOIN academic_years y ON y.id=c.academic_year_id WHERE c.id=? AND c.class_name=? AND c.version=? AND c.status='active' AND y.id=? AND y.status='active') AND NOT EXISTS(SELECT 1 FROM reader_class_enrollments WHERE reader_id=? AND ended_at IS NULL AND class_year_id!=?) THEN 1 ELSE json('class_alignment_changed') END`).bind(a.readerId,a.sourceMemberId,a.memberNo,a.fullName,a.sourceGroup,a.readerStatus,a.expectedVersion,a.classYearId,a.className,a.expectedClassVersion,a.academicYearId,a.readerId,a.classYearId));
  statements.push(db.prepare("INSERT INTO reader_class_enrollments(id,reader_id,class_year_id,observed_at) SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM reader_class_enrollments WHERE reader_id=? AND ended_at IS NULL)").bind('RCE-'+input.requestId+'-'+a.readerId,a.readerId,a.classYearId,now,a.readerId));
 }
 const result={assigned:input.assignments.length};statements.push(...finishLibraryCommand(db,actor,input.requestId,'literature.classes.assign','reader_classes',result,now));await readerBatch(db,statements);return result;
}
