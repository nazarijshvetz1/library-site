import test from 'node:test';
import assert from 'node:assert/strict';
import {readerDatabase} from './helpers/reader-database.mjs';
import {readLibraryBookActivity} from '../lib/library-activity.ts';
test('14-day activity counts book movements on registered dates, never cancellations or migration time',async()=>{
 const db=readerDatabase();try{
  const examples=[['returned','2026-08-24','2026-09-06'],['cancelled','2026-09-06','2026-09-06'],['overdue','2026-09-05',null],['returned','2026-09-04',null],['issued','2026-09-07',null],['returned','2026-08-23','2026-08-24']];
  for(const [index,[status,issued,received]] of examples.entries()){
   db.sqlite.prepare("INSERT INTO library_copies(id,edition_id,accession_no,copy_no,created_at,updated_at) VALUES(?,'edition',?,'1','2026-09-06','2026-09-06')").run('activity-copy-'+index,String(index));
   db.sqlite.prepare("INSERT INTO reader_circulations(id,copy_id,reader_id,status,issued_at,received_at,created_at,updated_at) VALUES(?,?,'reader-a',?,?,?,'2026-09-06','2026-09-06')").run('activity-loan-'+index,'activity-copy-'+index,status,issued,received);
  }
  const activity=await readLibraryBookActivity(db,new Date('2026-09-05T22:30:00Z'));
  assert.equal(activity.days.length,14);assert.equal(activity.days[0].day,'2026-08-24');assert.equal(activity.days[13].day,'2026-09-06');
  assert.deepEqual(activity.days[0],{day:'2026-08-24',issued:1,returned:1});assert.deepEqual(activity.days[13],{day:'2026-09-06',issued:0,returned:1});
  assert.equal(activity.days.reduce((n,d)=>n+d.issued,0),3);assert.equal(activity.days.reduce((n,d)=>n+d.returned,0),2);assert.equal(activity.undatedReturns,1);
 }finally{db.sqlite.close();}
});
