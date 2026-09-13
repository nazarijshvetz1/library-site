import test from 'node:test';
import assert from 'node:assert/strict';
import {readerDatabase,actor,readerRequest,telegramIdentity} from './helpers/reader-database.mjs';
const messages=await import('../lib/reader-messages.ts'),auth=await import('../lib/reader-auth.ts'),pin=await import('../lib/reader-pin-auth.ts'),copies=await import('../lib/library-copy-store.ts'),editor=await import('../lib/library-editor.ts'),cabinet=await import('../lib/reader-cabinet.ts'),feed=await import('../lib/reader-feed.ts'),catalog=await import('../lib/reader-cabinet-catalog.ts'),bot=await import('../lib/reader-telegram.ts'),selector=await import('../lib/telegram-cabinets.ts'),telegram=await import('../lib/telegram-notifications.ts');
const input=v=>({requestId:crypto.randomUUID(),...v}),at=(date='2026-09-13',time='07:00:00')=>new Date(date+'T'+time+'Z');
async function fixture(count=1){
 const db=readerDatabase(),book=await editor.saveLibraryEdition(db,actor,input({title:'Наша книга',metadata:{author:'Автор',annotation:'Опис книги',isbn13:'9780000000001'},entityIds:[],published:true}));
 db.sqlite.exec("INSERT INTO locations(id,name,type,status,created_at,updated_at) VALUES('LOC','Бібліотека','library','active','2026-09-01','2026-09-01')");
 const invite=await auth.issueReaderInvite(db,actor,{readerId:'reader-a',purpose:'telegram',expectedVersion:1}),session=await auth.redeemReaderInvite(db,invite.token,telegramIdentity()),who=await auth.requireReaderSession(db,readerRequest(session.token,true));
 db.sqlite.exec("UPDATE reader_profiles SET notify_loans=1 WHERE reader_id='reader-a'");
 const loans=[];
 for(let i=0;i<count;i++){
  const version=db.sqlite.prepare('SELECT version FROM library_editions WHERE id=?').get(book.id).version,copy=await copies.registerLibraryCopy(db,actor,input({editionId:book.id,expectedEditionVersion:version,accessionNo:'COPY-'+i,copyNo:String(i+1),locationId:'LOC',condition:'good'}));
  const r=db.sqlite.prepare("SELECT version FROM library_readers WHERE id='reader-a'").get();
  loans.push(await copies.issueReaderCopy(db,actor,input({copyId:copy.id,expectedCopyVersion:1,readerId:'reader-a',expectedReaderVersion:r.version,issuedAt:'2026-09-06',dueAt:'2026-09-13',confirmation:'ISSUE_THIS_COPY'})));
 }
 return {db,who,book,loans};
}
const row=db=>db.sqlite.prepare("SELECT * FROM reader_messages WHERE kind='loan_digest' ORDER BY day DESC LIMIT 1").get();
async function returnLoan(db,id){const l=db.sqlite.prepare('SELECT l.version loan_version,c.version copy_version FROM reader_circulations l JOIN library_copies c ON c.id=l.copy_id WHERE l.id=?').get(id);return copies.returnReaderCopy(db,actor,input({circulationId:id,expectedCirculationVersion:l.loan_version,expectedCopyVersion:l.copy_version,returnLocationId:'LOC',condition:'good',returnedAt:'2026-09-13',confirmation:'RETURN_THIS_COPY'}));}
test('10:00 Kyiv, due day and daily overdue digest are unique; site inbox is independent and own-scoped',async()=>{
 const {db,who}=await fixture();try{
  await messages.generateReaderMessages(db,at('2026-09-13','06:59:00'));assert.equal(row(db),undefined);
  await messages.generateReaderMessages(db,at());await messages.generateReaderMessages(db,at());
  assert.equal(db.sqlite.prepare('SELECT count(*) n FROM reader_messages WHERE kind=\'loan_digest\'').get().n,1);
  assert.equal((await messages.readerInbox(db,who)).items.filter(x=>x.kind==='loan_digest').length,1);assert.equal((await messages.readerInbox(db,{...who,readerId:'reader-b'})).items.length,0);
  await messages.markReaderMessage(db,{...who,readerId:'reader-b'},row(db).id);assert.equal(row(db).read_at,null);
  let sends=0;await messages.deliverReaderMessages(db,{now:at(),send:async()=>sends++});await messages.deliverReaderMessages(db,{now:at(),send:async()=>sends++});assert.equal(sends,1);
  await messages.generateReaderMessages(db,at('2026-09-14'));await messages.deliverReaderMessages(db,{now:at('2026-09-14'),send:async()=>sends++});assert.equal(sends,2);
 }finally{db.sqlite.close();}
});
test('winter Kyiv schedule remains 10:00 and not fixed UTC',async()=>{const {db}=await fixture();try{await messages.generateReaderMessages(db,at('2026-12-01','07:59:00'));assert.equal(row(db),undefined);await messages.generateReaderMessages(db,at('2026-12-01','08:00:00'));assert.equal(row(db).day,'2026-12-01');}finally{db.sqlite.close();}});
test('Telegram outage recovers automatically, while site notice and explicit mute are preserved',async()=>{const {db,who}=await fixture();try{
 await messages.generateReaderMessages(db,at());await messages.deliverReaderMessages(db,{now:at()});assert.equal(row(db).delivery_status,'unavailable');assert.equal((await messages.readerInbox(db,who)).items.filter(x=>x.kind==='loan_digest').length,1);
 let sent=0;await messages.deliverReaderMessages(db,{now:at('2026-09-13','07:06:00'),send:async()=>sent++});assert.equal(sent,1);
 db.sqlite.exec("UPDATE reader_profiles SET notify_loans=0,telegram_disconnected_at='2026-09-13T07:06:00Z'");await messages.generateReaderMessages(db,at('2026-09-14'));await messages.deliverReaderMessages(db,{now:at('2026-09-14'),send:async()=>sent++});assert.equal(sent,1);assert.equal(row(db).delivery_status,'disabled');
 }finally{db.sqlite.close();}});
test('return immediately before claim never sends stale notice',async()=>{const {db,loans}=await fixture();try{
 await messages.generateReaderMessages(db,at());const prepare=db.prepare.bind(db);let done=false,sends=0;
 db.prepare=sql=>{const statement=prepare(sql);if(!done&&sql.startsWith('UPDATE reader_messages SET delivery_status=')&&sql.includes("RETURNING id")){done=true;db.beforeBatch=()=>returnLoan(db,loans[0].id);}return statement;};
 await messages.deliverReaderMessages(db,{now:at(),send:async()=>sends++});assert.equal(done,true);assert.equal(sends,0);
 }finally{db.sqlite.close();}});
test('return during transport does not duplicate the daily digest',async()=>{const {db,loans}=await fixture(2);try{
 await messages.generateReaderMessages(db,at());let sends=0;await messages.deliverReaderMessages(db,{now:at(),send:async()=>{sends++;await returnLoan(db,loans[0].id);}});
 await messages.deliverReaderMessages(db,{now:at(),send:async()=>sends++});assert.equal(sends,1);assert.equal(row(db).delivery_status,'uncertain');
 }finally{db.sqlite.close();}});
test('extension cancels pending reminder and uses actual due date',async()=>{const {db,loans}=await fixture();try{
 await messages.generateReaderMessages(db,at());const l=db.sqlite.prepare('SELECT version FROM reader_circulations WHERE id=?').get(loans[0].id);
 await copies.changeReaderDueDate(db,actor,input({circulationId:loans[0].id,expectedVersion:l.version,dueAt:'2026-09-20'}));
 let sends=0;await messages.deliverReaderMessages(db,{now:at(),send:async()=>sends++});assert.equal(sends,0);await messages.generateReaderMessages(db,at('2026-09-14'));assert.equal(db.sqlite.prepare('SELECT count(*) n FROM reader_messages WHERE kind=\'loan_digest\'').get().n,1);
 }finally{db.sqlite.close();}});
test('429 honors retry_after and ambiguous network is not resent',async()=>{const {db}=await fixture();try{
 await messages.generateReaderMessages(db,at());let sends=0;
 await messages.deliverReaderMessages(db,{now:at(),send:async()=>{sends++;throw new telegram.TelegramIntegrationError('telegram_rate_limited',429,'rate',{retryAfterSeconds:3600});}});
 assert.equal(row(db).delivery_status,'retry');assert.equal(row(db).next_attempt_at,at('2026-09-13','08:00:00').toISOString());
 await messages.deliverReaderMessages(db,{now:at('2026-09-13','08:00:00'),send:async()=>{sends++;throw new Error('network');}});
 await messages.deliverReaderMessages(db,{now:at('2026-09-13','09:00:00'),send:async()=>sends++});assert.equal(row(db).delivery_status,'uncertain');assert.equal(sends,2);
 }finally{db.sqlite.close();}});
test('proposal four stages, edition link, private history, replay and version guards',async()=>{const {db,who,book}=await fixture(0);try{
 const proposal=await cabinet.proposeCabinetBook(db,who,input({title:'Нова книга',author:'Автор',note:'Прошу',confirmation:'SEND_BOOK_PROPOSAL'}));
 await assert.rejects(feed.moderateCabinet(db,actor,input({kind:'proposal',id:proposal.id,expectedVersion:1,status:'ordered',reply:''})));
 const approved=input({kind:'proposal',id:proposal.id,expectedVersion:1,status:'approved',reply:'Так'});
 await feed.moderateCabinet(db,actor,approved);await feed.moderateCabinet(db,actor,approved);
 await assert.rejects(feed.moderateCabinet(db,actor,input({...approved,requestId:crypto.randomUUID(),reply:'Конфлікт'})));
 await feed.moderateCabinet(db,actor,input({kind:'proposal',id:proposal.id,expectedVersion:2,status:'ordered',reply:'Замовили'}));
 await assert.rejects(feed.moderateCabinet(db,actor,input({kind:'proposal',id:proposal.id,expectedVersion:3,status:'available',reply:'',editionId:book.id})));
 await copies.registerLibraryCopy(db,actor,input({editionId:book.id,expectedEditionVersion:1,accessionNo:'NEW',copyNo:'1',locationId:'LOC',condition:'good'}));
 await feed.moderateCabinet(db,actor,input({kind:'proposal',id:proposal.id,expectedVersion:3,status:'available',reply:'Приходь',editionId:book.id}));
 const activity=await cabinet.cabinetActivity(db,who,new URL('https://local/?kind=proposals'));assert.equal(activity.items[0].status,'available');assert.equal(activity.items[0].edition_id,book.id);assert.equal(JSON.parse(activity.items[0].history_json).length,4);
 assert.equal((await cabinet.cabinetActivity(db,{...who,readerId:'reader-b'},new URL('https://local/?kind=proposals'))).total,0);assert.equal((await feed.cabinetModeration(db,new URL('https://local/?section=notifications'))).total,5);
 }finally{db.sqlite.close();}});
test('public book excludes reviews, readers and service metadata',async()=>{const {db,book}=await fixture(0);try{const detail=await catalog.cabinetPublicBook(db,book.id);assert.equal(detail.annotation,'Опис книги');for(const key of ['reviews','source_json','isbn13','reader_id','phone','email'])assert.equal(Object.hasOwn(detail,key),false);db.sqlite.prepare("UPDATE library_editions SET fund='education' WHERE id=?").run(book.id);await assert.rejects(catalog.cabinetPublicBook(db,book.id));}finally{db.sqlite.close();}});
test('student Telegram activation and repeat PIN linking are atomic and replay protected',async()=>{const db=readerDatabase();try{
 const access=await pin.issueReaderWebAccess(db,actor,{readerId:'reader-a',expectedVersion:1,confirmation:'CREATE_READER_WEB_ACCESS'}),cred=db.sqlite.prepare("SELECT login_id FROM reader_credentials WHERE reader_id='reader-a'").get(),request=new Request('https://library.example.test/api/reader/session',{headers:{'CF-Connecting-IP':'203.0.113.8'}});
 const payload={mode:'activate',loginId:cred.login_id,code:access.code,pin:'1357',pinConfirm:'1357',notifyLoans:true},identity=telegramIdentity();
 const result=await pin.authenticateReaderTelegramWithPin(db,request,payload,identity);assert.equal((await auth.requireReaderSession(db,readerRequest(result.token,true))).readerId,'reader-a');
 await assert.rejects(pin.authenticateReaderTelegramWithPin(db,request,{...payload,mode:'login',code:'1357'},identity));
 const repeat=await pin.authenticateReaderTelegramWithPin(db,request,{...payload,mode:'login',code:'1357',notifyLoans:false},telegramIdentity('100','b'));assert.equal((await auth.requireReaderSession(db,readerRequest(repeat.token,true))).readerId,'reader-a');
 db.sqlite.exec("UPDATE reader_telegram_connections SET status='blocked'");await assert.rejects(pin.authenticateReaderTelegramWithPin(db,request,{...payload,mode:'login',code:'1357'},telegramIdentity('100','c')));
 }finally{db.sqlite.close();}});
test('three cabinet choices; reader activation and seven links without schedule',async()=>{const db=readerDatabase();try{
 let menu;await selector.processCabinetSelection(db,{message:{text:'/start',chatId:'100',telegramUserId:'100'},updateId:'500',payloadHash:'a'.repeat(64),origin:'https://library.example.test',botUsername:'test_bot',send:async body=>menu=body.reply_markup.inline_keyboard});assert.equal(menu.length,3);assert.match(menu[0][0].url,/start=teacher/);
 const full=bot.readerTelegramKeyboard('https://library.example.test').flat();assert.equal(full.length,7);assert.equal(full.filter(b=>b.web_app.url.includes('tab=activity&action=propose')).length,1);assert.ok(!JSON.stringify(full).includes('schedule'));
 let guest;await bot.processReaderTelegramMessage(db,{message:{text:'/start reader',chatId:'200',telegramUserId:'200',chatType:'private'},updateId:'501',payloadHash:'b'.repeat(64),siteOrigin:'https://library.example.test',send:async body=>guest=body.reply_markup.inline_keyboard});assert.ok(guest.flat().some(b=>b.web_app?.url.endsWith('/reader/catalog?telegram=1')));
 }finally{db.sqlite.close();}});
