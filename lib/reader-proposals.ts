import {readerBatch,readerFail,requireChanged,type ReaderDatabase,type LibraryActor} from './reader-core.ts';
import {libraryCommand,beginLibraryCommand,finishLibraryCommand} from './library-copy-store.ts';
import {proposalMessage} from './reader-messages.ts';
export const proposalStages=['submitted','approved','ordered','available'] as const;
export async function moderateReaderProposal(db:ReaderDatabase,actor:LibraryActor,input:any){
 if(!proposalStages.includes(input.status)||!Number.isInteger(input.expectedVersion)||typeof input.reply!=='string'||input.reply.length>2000)readerFail('proposal_status','Перевірте статус і відповідь читачеві.');
 const command=await libraryCommand(db,actor,input.requestId,'reader.cabinet.moderate',input);if(command.replayed)return command.replayed;
 const row=await db.prepare('SELECT * FROM reader_literature_proposals WHERE id=? AND version=?').bind(input.id,input.expectedVersion).first();
 if(!row)readerFail('proposal_changed','Пропозицію вже оновлено. Оновіть список.',409);
 const current=String(row.workflow_status||({in_review:'submitted',received:'ordered',rejected:'submitted'} as Record<string,string>)[String(row.status)]||row.status);
 const previous=proposalStages.indexOf(current as any),next=proposalStages.indexOf(input.status);
 if(next<previous||next>previous+1)readerFail('proposal_step','Переходьте до наступного етапу послідовно.');
 const editionId=input.status==='available'?String(input.editionId||row.edition_id||''):null;
 if(input.status==='available'&&!editionId)readerFail('proposal_edition','Оберіть книгу, яка вже доступна у каталозі.');
 const now=new Date().toISOString(),result={id:input.id,status:input.status},legacy=({submitted:'submitted',approved:'approved',ordered:'approved',available:'received'} as Record<string,string>)[input.status];
 const statements=[beginLibraryCommand(db,actor,input.requestId,'reader.cabinet.moderate',command.hash,input.id,now)];
 if(editionId)statements.push(db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM library_editions e LEFT JOIN materials m ON m.id=e.material_id WHERE e.id=? AND e.fund='literature' AND e.publication_state='published' AND (m.id IS NULL OR m.status='active') AND EXISTS(SELECT 1 FROM library_copies c WHERE c.edition_id=e.id AND c.registration='registered' AND c.physical_state!='withdrawn')) THEN 1 ELSE json('proposal_edition_unavailable') END`).bind(editionId));
 statements.push(db.prepare("UPDATE reader_literature_proposals SET status=?,workflow_status=?,edition_id=?,reply=?,version=version+1,updated_at=? WHERE id=? AND version=?").bind(legacy,input.status,editionId,input.reply.trim(),now,input.id,input.expectedVersion),requireChanged(db,1));
 if(current!==input.status||String(row.reply)!==input.reply.trim())statements.push(proposalMessage(db,{readerId:String(row.reader_id),proposalId:input.id,version:input.expectedVersion+1,title:String(row.title),stage:input.status,reply:input.reply.trim()},now));
 statements.push(...finishLibraryCommand(db,actor,input.requestId,'reader.cabinet.moderate',input.id,result,now));
 await readerBatch(db,statements);return result;
}
