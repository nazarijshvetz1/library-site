import {getTeacherPhotoAsset} from './teacher-profile-store.ts';
import {readerFail,type ReaderDatabase} from './reader-core.ts';

// Internal SQL fragments for reader alias r and optional profile alias p.
// Linked teachers use the canonical directory even when a field was cleared.
const teacherField=(field:string)=>`(SELECT tp.${field} FROM teacher_profiles tp WHERE tp.teacher_user_id=r.linked_teacher_user_id)`;
export const readerFullNameSql="COALESCE((SELECT u.full_name FROM users u WHERE u.id=r.linked_teacher_user_id),r.full_name)";
export const readerSortNameSql="COALESCE((SELECT u.sort_name FROM users u WHERE u.id=r.linked_teacher_user_id),r.sort_name)";
// Main teacher names retain punctuation; catalog search normalizes it.
export const readerSearchNameSql = [45,8208,8209,8211,8212,46,44,40,41].reduce((sql,code)=>`replace(${sql},char(${code}),' ')`,`replace(replace(${readerSortNameSql},char(8217),char(39)),char(96),char(39))`);
export const readerPhoneSql=`CASE WHEN r.linked_teacher_user_id IS NOT NULL THEN COALESCE(${teacherField('service_contact')},'') ELSE COALESCE(p.phone,'') END`;
export const readerSubjectSql=`CASE WHEN r.linked_teacher_user_id IS NOT NULL THEN COALESCE(${teacherField('subject_position')},'') ELSE COALESCE(p.subject_position,'') END`;
export const readerHasPhotoSql="CASE WHEN r.linked_teacher_user_id IS NOT NULL THEN EXISTS(SELECT 1 FROM teacher_profiles tp JOIN users tu ON tu.id=tp.teacher_user_id WHERE tp.teacher_user_id=r.linked_teacher_user_id AND tp.photo_storage_key IS NOT NULL AND tp.closed_at IS NULL AND tu.status='active') ELSE p.photo_key IS NOT NULL END";
export const readerPhotoVersionSql=`CASE WHEN r.linked_teacher_user_id IS NOT NULL THEN COALESCE(${teacherField('photo_version')},0) ELSE COALESCE(p.version,0) END`;
export const readerPhotoUpdatedSql=`CASE WHEN r.linked_teacher_user_id IS NOT NULL THEN ${teacherField('photo_updated_at')} ELSE p.updated_at END`;
export const readerDirectoryFieldsSql=`${readerPhoneSql} phone,${readerSubjectSql} subject_position,${readerHasPhotoSql} has_photo,${readerPhotoVersionSql} profile_version,${readerPhotoUpdatedSql} photo_updated_at,${teacherField('primary_location_id')} primary_location_id,(SELECT l.name FROM teacher_profiles tp JOIN locations l ON l.id=tp.primary_location_id WHERE tp.teacher_user_id=r.linked_teacher_user_id) primary_location_name,${teacherField('version')} teacher_profile_version,${teacherField('updated_at')} teacher_profile_updated_at`;

export async function readerPhotoAsset(db:ReaderDatabase,readerId:string){
 const row=await db.prepare('SELECT r.linked_teacher_user_id,p.photo_key,p.photo_mime FROM library_readers r LEFT JOIN reader_profiles p ON p.reader_id=r.id WHERE r.id=?').bind(readerId).first();
 if(!row)return null;
 if(row.linked_teacher_user_id)return getTeacherPhotoAsset(db,String(row.linked_teacher_user_id));
 const key=String(row.photo_key||'');
 return key.startsWith('reader-photos/'+readerId+'/')?{storageKey:key,mimeType:String(row.photo_mime||'image/jpeg')}:null;
}

export async function requireIndependentReaderProfile(db:ReaderDatabase,readerId:string){
 const row=await db.prepare('SELECT linked_teacher_user_id FROM library_readers WHERE id=?').bind(readerId).first();
 if(row?.linked_teacher_user_id)readerFail('canonical_teacher_profile','Фото й особисті дані цього вчителя змінюються в основному кабінеті та автоматично відображаються тут.',409);
}
