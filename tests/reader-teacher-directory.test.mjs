import test from 'node:test';
import assert from 'node:assert/strict';
import {readerDatabase,actor} from './helpers/reader-database.mjs';
const directory=await import('../lib/reader-teacher-directory.ts');
const profile=await import('../lib/reader-profile-store.ts');
const admin=await import('../lib/literature-admin.ts');
const teachers=await import('../lib/reader-teacher-link.ts');
const url=q=>new URL('https://local/?'+q);
async function fixture(){
 const db=readerDatabase();
 db.sqlite.exec("INSERT INTO locations(id,name,type,status,created_at,updated_at) VALUES('room','Кабінет 25','classroom','active','2026-09-13','2026-09-13'); INSERT INTO users(id,full_name,sort_name,email,role,status,created_at,updated_at) VALUES('teacher','Тестова Олена Іванівна','тестова олена іванівна','login@example.test','teacher','active','2026-09-13','2026-09-13'); INSERT INTO teacher_profiles(teacher_user_id,subject_position,primary_location_id,service_contact,librarian_note,photo_storage_key,photo_mime_type,photo_version,photo_updated_at,version,created_at,updated_at) VALUES('teacher','Історія / учителька','room','+380501234567','INTERNAL-NOTE','teacher-photos/teacher/current.jpg','image/jpeg',1,'2026-09-13T01:00:00Z',3,'2026-09-13','2026-09-13'); UPDATE library_readers SET full_name='Тестова Олена Іванівна',kind='unclassified' WHERE id='reader-a'");
 const row=await teachers.ensureTeacherReader(db,'teacher');
 db.sqlite.exec("UPDATE reader_profiles SET phone='+380009999999',subject_position='Старий предмет',photo_key='reader-photos/reader-a/old.jpg',photo_mime='image/jpeg',email='contact@example.test' WHERE reader_id='reader-a'");
 const identity={readerId:row.id,sessionKind:'teacher',accessVersion:row.access_version,tokenHash:'test'};
 return {db,identity};
}
test('linked teacher profile and admin card derive canonical photo, subject, room and phone without copying',async()=>{
 const {db,identity}=await fixture();try{
 const before=db.sqlite.prepare("SELECT * FROM reader_profiles WHERE reader_id='reader-a'").get();
 const own=await profile.getReaderProfile(db,identity),card=await admin.literatureReader(db,identity.readerId),list=await admin.literatureReaders(db,url('kind=teacher'));
 assert.equal(own.subjectPosition,'Історія / учителька');assert.equal(own.phone,'+380501234567');assert.equal(own.primaryLocation.name,'Кабінет 25');assert.equal(own.email,'contact@example.test');assert.match(own.photoUrl,/v=1&at=/);
 assert.equal(card.phone,own.phone);assert.equal(card.subject_position,own.subjectPosition);assert.equal(card.primary_location_name,own.primaryLocation.name);assert.equal(card.has_photo,1);assert.equal(list.total,1);assert.equal(list.items[0].has_photo,1);
 const asset=await directory.readerPhotoAsset(db,identity.readerId);assert.equal(asset.storageKey,'teacher-photos/teacher/current.jpg');assert.equal(asset.mimeType,'image/jpeg');
 for(const secret of ['INTERNAL-NOTE','login@example.test','teacher-photos/','old.jpg'])assert.ok(!JSON.stringify(own).includes(secret));
 assert.deepEqual(db.sqlite.prepare("SELECT * FROM reader_profiles WHERE reader_id='reader-a'").get(),before);
 }finally{db.sqlite.close();}
});
test('canonical edits and photo recreation update immediately; cleared fields never revive stale reader values',async()=>{
 const {db,identity}=await fixture();try{
 const first=await profile.getReaderProfile(db,identity);
 db.sqlite.exec("UPDATE teacher_profiles SET photo_storage_key='teacher-photos/teacher/new.jpg',photo_updated_at='2026-09-13T02:00:00Z',subject_position='Математика',service_contact='+380671234567',version=version+1; UPDATE users SET full_name='Оновлена Олена Іванівна',sort_name='оновлена олена іванівна' WHERE id='teacher'; UPDATE locations SET name='Кабінет 26' WHERE id='room'");
 const current=await profile.getReaderProfile(db,identity);assert.notEqual(current.photoUrl,first.photoUrl);assert.equal(current.fullName,'Оновлена Олена Іванівна');assert.equal(current.primaryLocation.name,'Кабінет 26');
 assert.equal((await admin.literatureReaders(db,url('q=оновлена'))).total,1);assert.equal((await admin.literatureReaders(db,url('q=тестова'))).total,0);assert.equal((await admin.literatureLoans(db,url('q=оновлена&sort=reader'))).total,0);
 db.sqlite.exec("UPDATE teacher_profiles SET photo_storage_key=NULL,photo_mime_type=NULL,photo_version=0,photo_updated_at=NULL,subject_position='',service_contact='',primary_location_id=NULL");
 const cleared=await profile.getReaderProfile(db,identity);assert.equal(cleared.photoUrl,null);assert.equal(cleared.phone,'');assert.equal(cleared.subjectPosition,'');assert.equal(cleared.primaryLocation,null);assert.equal(await directory.readerPhotoAsset(db,identity.readerId),null);
 assert.equal(db.sqlite.prepare("SELECT phone FROM reader_profiles WHERE reader_id='reader-a'").get().phone,'+380009999999');
 }finally{db.sqlite.close();}
});
test('teacher source photo respects closed/disabled accounts and independent pupils keep own assets',async()=>{
 const {db,identity}=await fixture();try{
 db.sqlite.exec("UPDATE users SET status='inactive' WHERE id='teacher'");assert.equal(await directory.readerPhotoAsset(db,identity.readerId),null);assert.equal((await admin.literatureReader(db,identity.readerId)).has_photo,0);
 db.sqlite.exec("UPDATE users SET status='active' WHERE id='teacher'; UPDATE teacher_profiles SET closed_at='2026-09-13',closed_by_user_id='admin'");assert.equal(await directory.readerPhotoAsset(db,identity.readerId),null);
 db.sqlite.exec("INSERT INTO reader_profiles(reader_id,display_name,phone,photo_key,photo_mime,updated_at) VALUES('reader-b','Учень','+380661234567','reader-photos/reader-b/pupil.png','image/png','2026-09-13')");
 const pupil=await profile.getReaderProfile(db,{...identity,readerId:'reader-b',sessionKind:'reader'});assert.equal(pupil.phone,'+380661234567');assert.equal(pupil.teacherLinked,false);assert.equal(pupil.primaryLocation,null);assert.equal((await directory.readerPhotoAsset(db,'reader-b')).mimeType,'image/png');await directory.requireIndependentReaderProfile(db,'reader-b');
 db.sqlite.exec("UPDATE reader_profiles SET photo_key='reader-photos/reader-a/old.jpg' WHERE reader_id='reader-b'");assert.equal(await directory.readerPhotoAsset(db,'reader-b'),null);
 }finally{db.sqlite.close();}
});
test('independent editors reject linked teacher field/photo divergence',async()=>{
 const {db,identity}=await fixture();try{
 await assert.rejects(directory.requireIndependentReaderProfile(db,identity.readerId),e=>e.code==='canonical_teacher_profile'&&e.status===409);
 await assert.rejects(admin.saveLiteratureReader(db,actor,{requestId:crypto.randomUUID(),id:identity.readerId,expectedVersion:2,fullName:'Змінене ім’я',kind:'teacher',phone:'+380661234567'}),e=>e.code==='canonical_teacher_profile');
 await assert.rejects(profile.updateReaderProfile(db,identity,{requestId:crypto.randomUUID(),expectedVersion:1,displayName:'Олена',phone:'+380661234567',communityEnabled:false,notifyLoans:false,notifyBooks:false}),e=>e.code==='canonical_teacher_profile');
 assert.equal(db.sqlite.prepare("SELECT service_contact FROM teacher_profiles WHERE teacher_user_id='teacher'").get().service_contact,'+380501234567');
 }finally{db.sqlite.close();}
});
test('librarian reviews resolve canonical teacher name, subject and current photo',async()=>{
 const {db}=await fixture();try{
 db.sqlite.exec("INSERT INTO library_ratings(edition_id,reader_id,rating,body,review_state,version,created_at,updated_at) VALUES('edition','reader-a',5,'Цікава книжка','published',1,'2026-09-13','2026-09-13')");
 const rows=await admin.literatureReviews(db,url(''));assert.equal(rows.total,1);assert.equal(rows.items[0].author_name,'Тестова Олена Іванівна');assert.equal(rows.items[0].subject_position,'Історія / учителька');assert.equal(rows.items[0].has_photo,1);assert.equal(rows.items[0].photo_updated_at,'2026-09-13T01:00:00Z');
 }finally{db.sqlite.close();}
});
test('teacher lookup retains apostrophe and compound-name matches in reader and issue pickers',async()=>{
 const {db}=await fixture();try{
 for(const [name,q] of [["Тестова Мар’яна Іванівна","Тестова Мар'яна Іванівна"],["Тестова Анна-Марія Іванівна","Тестова Анна-Марія Іванівна"]]){
 db.sqlite.prepare("UPDATE users SET full_name=?,sort_name=? WHERE id='teacher'").run(name,name.toLocaleLowerCase('uk-UA'));
 assert.equal((await admin.literatureReaders(db,url('q='+encodeURIComponent(q)))).total,1);
 assert.equal((await admin.literatureChoices(db,url('kind=reader&q='+encodeURIComponent(name)))).total,1);
 }
 }finally{db.sqlite.close();}
});
test('legacy reachable librarian reader endpoint also uses canonical data and locks duplicate editing',async()=>{
 const legacy=await import('../lib/library-reader-admin.ts'),{db,identity}=await fixture();try{
 const rows=await legacy.listLibraryReaders(db,url('q=тестова'));assert.equal(rows.length,1);assert.equal(rows[0].phone,'+380501234567');assert.equal(rows[0].has_photo,1);assert.equal(rows[0].primary_location_name,'Кабінет 25');
 await assert.rejects(legacy.saveLibraryReader(db,actor,{requestId:crypto.randomUUID(),id:identity.readerId,expectedVersion:2,fullName:'Інше Ім’я',memberNo:'reader-a',kind:'teacher',classYearId:null}),e=>e.code==='canonical_teacher_profile');
 }finally{db.sqlite.close();}
});

