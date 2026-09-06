import type {ReaderDatabase} from './reader-core.ts';

/** Book movements by their registered dates, never inferred physical attendance. */
export async function readLibraryBookActivity(db:ReaderDatabase,now=new Date()){
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv'}).format(now);
 const start=new Date(today+'T12:00:00Z');start.setUTCDate(start.getUTCDate()-13);
 const first=start.toISOString().slice(0,10);
 const rows=await db.prepare(`SELECT day,SUM(issued) AS issued,SUM(returned) AS returned FROM (
  SELECT substr(issued_at,1,10) AS day,1 AS issued,0 AS returned FROM reader_circulations WHERE status IN ('issued','overdue','returned') AND substr(issued_at,1,10) BETWEEN ? AND ?
  UNION ALL
  SELECT substr(received_at,1,10) AS day,0 AS issued,1 AS returned FROM reader_circulations WHERE status='returned' AND substr(received_at,1,10) BETWEEN ? AND ?
 ) GROUP BY day ORDER BY day`).bind(first,today,first,today).all<{day:string;issued:number;returned:number}>();
 const counts=new Map((rows.results||[]).map(row=>[row.day,row]));
 const days=Array.from({length:14},(_,index)=>{const date=new Date(start);date.setUTCDate(date.getUTCDate()+index);const day=date.toISOString().slice(0,10),row=counts.get(day);return {day,issued:Number(row?.issued||0),returned:Number(row?.returned||0)};});
 const unknown=await db.prepare("SELECT COUNT(*) AS n FROM reader_circulations WHERE status='returned' AND received_at IS NULL").first<{n:number}>();
 return {days,undatedReturns:Number(unknown?.n||0)};
}
