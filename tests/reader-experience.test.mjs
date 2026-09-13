import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {readerDatabase,actor,readerRequest,telegramIdentity} from './helpers/reader-database.mjs';
const auth=await import('../lib/reader-auth.ts'),editor=await import('../lib/library-editor.ts'),copies=await import('../lib/library-copy-store.ts'),catalog=await import('../lib/reader-cabinet-catalog.ts'),cabinet=await import('../lib/reader-cabinet.ts'),profile=await import('../lib/reader-profile-store.ts'),messages=await import('../lib/reader-messages.ts'),events=await import('../lib/reader-events.ts'),feed=await import('../lib/reader-feed.ts'),community=await import('../lib/reader-community-profile.ts'),channel=await import('../lib/reader-telegram-channel.ts'),admin=await import('../lib/literature-admin.ts'),requests=await import('../lib/library-reader-admin.ts');
const input=v=>({requestId:crypto.randomUUID(),...v}),url=q=>new URL('https://local/?'+q);
async function fixture(){
 const db=readerDatabase();
 const book=await editor.saveLibraryEdition(db,actor,input({title:'Дослідження природи',metadata:{year:'2026',pages:'256',url:'https://example.test/book',annotation:'Опис'},entityIds:[],entityNames:{author:['Автор Ім’я'],publisher:['Наше видавництво'],genre:['Науково-популярна']},published:true}));
 db.sqlite.exec("INSERT INTO locations(id,name,type,status,created_at,updated_at) VALUES('loc','Бібліотека','library','active','2026-09-01','2026-09-01')");
 const copy=await copies.registerLibraryCopy(db,actor,input({editionId:book.id,expectedEditionVersion:1,accessionNo:'TEST',copyNo:'1',locationId:'loc',condition:'good'}));
 const identities=[];
 for(const [i,id] of ['reader-a','reader-b'].entries()){
  const invite=await auth.issueReaderInvite(db,actor,{readerId:id,purpose:'telegram',expectedVersion:1});
  const session=await auth.redeemReaderInvite(db,invite.token,telegramIdentity(String(100+i),String(i+1)));
  identities.push(await auth.requireReaderSession(db,readerRequest(session.token,true)));
 }
 db.sqlite.exec("UPDATE reader_profiles SET community_enabled=1,email='private@example.test',phone='+380000000000'");
 return {db,book,copy,a:identities[0],b:identities[1]};
}
async function issue(f,requestId){const version=f.db.sqlite.prepare('SELECT version FROM library_readers WHERE id=?').get(f.a.readerId).version;return copies.issueReaderCopy(f.db,actor,input({copyId:f.copy.id,expectedCopyVersion:1,readerId:f.a.readerId,expectedReaderVersion:version,issuedAt:'2026-09-06',dueAt:'2026-09-13',bookRequestId:requestId,confirmation:'ISSUE_THIS_COPY'}));}

test('all relation lists and history hydrate the same safe compact book metadata',async()=>{const f=await fixture(),{db,book,a}=f;try{
 for(const q of ['Науково-популярна','науково популярна','автор'])assert.equal((await catalog.cabinetCatalog(db,url('q='+encodeURIComponent(q)))).total,1);
 const detail=await catalog.cabinetBook(db,book.id);assert.equal(detail.pages,256);assert.equal(detail.websiteUrl,'https://example.test/book');
 for(const kind of ['author','publisher','genre']){const entity=detail.entities.find(x=>x.kind===kind);const item=(await catalog.cabinetEntity(db,url('id='+entity.id))).books.items[0];assert.equal(item.pages,256);assert.equal(item.publisher,'Наше видавництво');}
 await issue(f);const loan=(await cabinet.cabinetLoans(db,a,url('status=all'))).items[0];assert.equal(loan.pages,256);assert.equal(loan.author,'Автор Ім’я');assert.notEqual(loan.id,book.id);
 await cabinet.recordCabinetView(db,a,input({editionId:book.id}));assert.equal((await cabinet.cabinetActivity(db,a,url('kind=recent'))).items[0].pages,256);
 const post=await feed.saveFeedContent(db,a,input({kind:'post',body:'Враження',editionId:book.id}));const p=(await feed.readerFeed(db,a,url('focus='+post.id))).items[0];assert.equal(p.id,post.id);assert.equal(p.body,'Враження');assert.equal(p.pages,256);
}finally{db.sqlite.close();}});

test('real request events, reserved queue, fulfilment and popular rank never duplicate a loan',async()=>{const f=await fixture(),{db,book,a}=f;try{
 const request=await profile.requestReaderBook(db,a,input({editionId:book.id,note:'',confirmation:'CONFIRM_BOOK_REQUEST'}));
 assert.equal((await admin.literatureLoans(db,url('status=reserved'))).items[0].record_kind,'request');
 assert.equal((await catalog.cabinetCatalog(db,url('sort=popular'))).total,0);
 const ready=input({id:request.id,expectedVersion:1,status:'ready'});await requests.setReaderRequestStatus(db,actor,ready);await requests.setReaderRequestStatus(db,actor,ready);
 await assert.rejects(requests.setReaderRequestStatus(db,actor,input({id:request.id,expectedVersion:2,status:'ready'})));
 await issue(f,request.id);
 const list=await admin.literatureLoans(db,url('status=all'));assert.equal(list.total,1);assert.equal(list.items[0].record_kind,'circulation');assert.equal((await admin.literatureLoans(db,url('status=reserved'))).total,0);
 const inbox=await messages.readerInbox(db,a,url('category=library'));assert.equal(inbox.items.filter(x=>x.title==='Книжку видано').length,1);assert.equal(inbox.items.filter(x=>x.title==='Книжка готова до видачі').length,1);
 const popular=await catalog.cabinetCatalog(db,url('sort=popular'));assert.equal(popular.items[0].id,book.id);assert.equal(popular.items[0].issue_count,1);
 db.sqlite.prepare("UPDATE library_editions SET fund='education' WHERE id=?").run(book.id);assert.equal((await catalog.cabinetCatalog(db,url('sort=popular'))).total,0);
}finally{db.sqlite.close();}});

test('notification count spans pages, filters isolate types, mark-read cannot affect another reader',async()=>{const {db,a,b}=await fixture();try{
 for(let i=0;i<25;i++)await db.batch([events.readerEvent(db,{readerId:a.readerId,key:'event-'+i,kind:'account',title:'Подія '+i,body:'Зміна',tab:'profile'},new Date(Date.UTC(2026,8,13,7,i)).toISOString())]);
 const inbox=await messages.readerInbox(db,a,url('category=account'));assert.equal(inbox.total,26);assert.equal(inbox.items.length,20);assert.equal(inbox.unread,26);
 await messages.markReaderMessage(db,b,inbox.items[0].id);assert.equal((await messages.readerInbox(db,a)).unread,26);
 await messages.markReaderMessage(db,a,inbox.items[0].id);assert.equal((await messages.readerInbox(db,a)).unread,25);assert.equal((await messages.readerInbox(db,a,url('category=account&page=2'))).items.length,6);
 assert.equal((await messages.readerInbox(db,a,url('category=library'))).total,0);
}finally{db.sqlite.close();}});

test('community replies notify real owners once and disappear when content is hidden',async()=>{const {db,a,b}=await fixture();try{
 const p=await feed.saveFeedContent(db,a,input({kind:'post',body:'Допоможіть обрати',editionId:null}));
 const comment=await feed.saveFeedContent(db,b,input({kind:'comment',postId:p.id,body:'Раджу цю книгу'}));await db.batch([events.commentEvents(db,comment.id,new Date().toISOString())]);
 assert.equal((await messages.readerInbox(db,a,url('category=community'))).total,1);assert.equal((await messages.readerInbox(db,b,url('category=community'))).total,0);
 const reply=await feed.saveFeedContent(db,a,input({kind:'comment',postId:p.id,parentCommentId:comment.id,body:'Дякую!'}));assert.equal((await messages.readerInbox(db,b,url('category=community'))).items[0].payload.commentId,reply.id);
 db.sqlite.prepare("UPDATE reader_feed_posts SET status='hidden' WHERE id=?").run(p.id);assert.equal((await messages.readerInbox(db,a,url('category=community'))).total,0);
}finally{db.sqlite.close();}});

test('about is optional, bounded, editable and community profile is a private allowlist',async()=>{const {db,a,b}=await fixture();try{
 const p=await profile.getReaderProfile(db,a),data=input({expectedVersion:p.version,displayName:p.displayName,phone:p.phone,email:p.email,communityEnabled:true,about:'Люблю пригоди'});
 await profile.updateReaderProfile(db,a,data);await profile.updateReaderProfile(db,a,data);
 const updated=await profile.getReaderProfile(db,a);assert.equal(updated.about,'Люблю пригоди');
 await assert.rejects(profile.updateReaderProfile(db,a,input({...data,expectedVersion:updated.version,about:'а'.repeat(301)})));
 await assert.rejects(profile.updateReaderProfile(db,a,input({...data,expectedVersion:updated.version,email:{bad:true}})));
 const c=await community.communityReaderProfile(db,b,a.readerId);assert.equal(c.about,'Люблю пригоди');assert.equal(c.fullName,'Читач reader-a');for(const key of ['phone','email','memberNo','loans','access_version'])assert.equal(Object.hasOwn(c,key),false);
 db.sqlite.prepare('INSERT INTO reader_blocks(reader_id,blocked_reader_id,created_at) VALUES(?,?,?)').run(b.readerId,a.readerId,new Date().toISOString());await assert.rejects(community.communityReaderProfile(db,b,a.readerId));
}finally{db.sqlite.close();}});

test('unchanged profile creates no event/version; disconnect stops reader delivery and preserves web session',async()=>{const f=await fixture(),{db,a}=f;try{
 const p=await profile.getReaderProfile(db,a),before=(await messages.readerInbox(db,a)).total;
 const result=await profile.updateReaderProfile(db,a,input({expectedVersion:p.version,displayName:p.displayName,phone:p.phone,email:p.email,about:p.about,communityEnabled:p.communityEnabled}));assert.equal(result.version,p.version);assert.equal((await messages.readerInbox(db,a)).total,before);
 db.sqlite.prepare('INSERT INTO reader_sessions(token_hash,reader_id,access_version,created_at,expires_at) VALUES(?,?,?,?,?)').run('dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',a.readerId,a.accessVersion,new Date().toISOString(),'2099-01-01');
 await issue(f);await messages.generateReaderMessages(db,new Date('2026-09-13T07:00:00Z'));
 await channel.changeReaderTelegram(db,a,input({expectedVersion:p.version,action:'disconnect',confirmation:'DISCONNECT_READER_TELEGRAM'}));
 assert.equal(db.sqlite.prepare("SELECT status FROM reader_telegram_connections WHERE reader_id=?").get(a.readerId).status,'disabled');assert.equal(db.sqlite.prepare("SELECT revoked_at FROM reader_sessions WHERE token_hash='dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'").get().revoked_at,null);
 let sent=0;await messages.deliverReaderMessages(db,{now:new Date('2026-09-13T07:10:00Z'),send:async()=>sent++});assert.equal(sent,0);assert.equal((await profile.getReaderProfile(db,a)).telegramConnected,false);assert.ok((await messages.readerInbox(db,a,url('category=library'))).items.length);
}finally{db.sqlite.close();}});

test('latest ten arrivals use the real creation date descending',async()=>{const {db,a}=await fixture();try{
 for(let i=1;i<=12;i++){const b=await editor.saveLibraryEdition(db,actor,input({title:'Надходження '+i,metadata:{},entityIds:[],published:true}));db.sqlite.prepare('UPDATE library_editions SET created_at=? WHERE id=?').run('2099-01-'+String(i).padStart(2,'0'),b.id);}
 const home=await cabinet.cabinetHome(db,a);assert.equal(home.newBooks.length,10);assert.equal(home.newBooks[0].title,'Надходження 12');assert.equal(home.newBooks.at(-1).title,'Надходження 3');
}finally{db.sqlite.close();}});

test('reader shared UI contracts: compact cards, exclusive selections, bell and honest draft exit',()=>{
 const read=path=>fs.readFileSync(path,'utf8'),controls=read('app/reader/cabinet-controls.tsx'),book=read('app/reader/cabinet-book.tsx'),nav=read('app/librarian/literature/literature-navigation.tsx'),workspace=read('app/reader/reader-workspace.tsx'),panels=read('app/reader/cabinet-panels.tsx');
 assert.match(controls,/book.pages.*сторінок/u);assert.match(controls,/Назва, автор або категорія/u);assert.match(workspace,/Історія читання/u);assert.match(workspace,/<Bell size=/u);
 assert.match(book,/aria-pressed=\{mode==='reserve'\}/u);assert.match(book,/aria-pressed=\{mode==='review'\}/u);assert.ok(book.indexOf('Відкрити сторінку книжки')>book.indexOf('book.annotation'));
 for(const label of ['Продовжити редагування','Зберегти чернетку й вийти','Вийти без збереження'])assert.ok(nav.includes(label));assert.match(nav,/same\(original,result\)/u);assert.match(nav,/n.allowUnload/u);assert.match(nav,/refreshParents/u);
 assert.match(panels,/maxLength=\{300\}/u);assert.match(panels,/proposalAction/u);assert.doesNotMatch(panels,/checked=\{notifyLoans\}/u);
});
