import {readerFullNameSql,readerSubjectSql,readerHasPhotoSql,readerPhotoVersionSql} from './reader-teacher-directory.ts';
import {readerFail,type ReaderDatabase,type ReaderIdentity} from './reader-core.ts';
// This projection is for authenticated, participating readers only. Never expose contacts or borrowing history.
export const communityAuthorSql=`CASE WHEN p.community_enabled=1 AND r.status='active' AND r.access_status='active' THEN ${readerFullNameSql} ELSE 'Читач бібліотеки' END display_name,
 CASE WHEN p.community_enabled=1 AND r.status='active' AND r.access_status='active' THEN r.id END author_id,
 CASE WHEN p.community_enabled=1 AND r.status='active' AND r.access_status='active' AND ${readerHasPhotoSql} THEN '/api/reader/community-profile?id='||r.id||'&photo=1&v='||${readerPhotoVersionSql} END photo_url`;
export async function communityReaderProfile(db:ReaderDatabase,who:ReaderIdentity,id:string){
 const row=await db.prepare(`SELECT r.id,${readerFullNameSql} full_name,r.kind,${readerSubjectSql} subject_position,p.about,
 coalesce((SELECT cy.class_name FROM reader_class_enrollments ce JOIN class_years cy ON cy.id=ce.class_year_id WHERE ce.reader_id=r.id AND ce.ended_at IS NULL),r.source_group_label,'') class_label,
 CASE WHEN ${readerHasPhotoSql} THEN '/api/reader/community-profile?id='||r.id||'&photo=1&v='||${readerPhotoVersionSql} END photo_url
 FROM library_readers r JOIN reader_profiles p ON p.reader_id=r.id
 WHERE r.id=? AND r.status='active' AND r.access_status='active' AND p.community_enabled=1
 AND EXISTS(SELECT 1 FROM reader_profiles viewer WHERE viewer.reader_id=? AND viewer.community_enabled=1)
 AND NOT EXISTS(SELECT 1 FROM reader_blocks b WHERE (b.reader_id=? AND b.blocked_reader_id=r.id) OR (b.blocked_reader_id=? AND b.reader_id=r.id))`).bind(id,who.readerId,who.readerId,who.readerId).first();
 if(!row)readerFail('community_profile','Читацька сторінка недоступна.',404);
 return {id:row.id,fullName:row.full_name,kind:row.kind,photoUrl:row.photo_url||null,...(row.kind==='student'?{classLabel:row.class_label,about:row.about||''}:{subjectPosition:row.subject_position||''})};
}
