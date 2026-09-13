"use client";
import {useEffect,useRef,useState,type ComponentType,type FormEvent} from 'react';
import {Building2,Camera,ChevronRight,FolderTree,LibraryBig,Search,Tags,UserRound,UsersRound,Plus} from 'lucide-react';
import {telephoneHref} from '@/lib/telephone';
import {readerDate,readerFetch,type ReaderProfile} from './reader-types';
import ReaderScanner from './reader-scanner';
import {BookPublicMeta,BookRow,Feedback,Modal,Pager,PublicationLine,Suggest,useCabinetData,type Row,type Page} from './cabinet-controls';
import {DraftScope,useDraftState,useLiteratureNavigation} from '../librarian/literature/literature-navigation';
import LiteraturePhotoEditor,{type PreparedPhoto} from '../librarian/literature/photo-editor';
import s from './cabinet.module.css';

const API='/api/reader/cabinet';
export type Act=(action:string,input:Row)=>Promise<Row|null>;
export const statusLabels:Record<string,string>={issued:'Видано',overdue:'Прострочено',returned:'Повернуто',reserved:'Зарезервовано',pending:'Очікує',requested:'Очікує підтвердження',ready:'Підтверджено бібліотекарем',fulfilled:'Видано',cancelled:'Скасовано',rejected:'Відхилено',submitted:'Надіслано',in_review:'На розгляді',approved:'Схвалено',received:'Додано до бібліотеки',hidden:'Приховано',published:'Опубліковано'};
export function Badge({status}:{status:string}){return <span className={s.badge} data-status={status}>{statusLabels[status]||status}</span>;}

export function HomePanel({profile,epoch,onBook,onCatalog,onEntity}:{profile:ReaderProfile;epoch:number;onBook:(id:string)=>void;onCatalog:(code?:string)=>void;onEntity:(entity:Row)=>void}){
 const state=useCabinetData<Row>(API+'?view=home',epoch),firstName=profile.fullName.split(' ')[1]||profile.fullName;
 return <>
  <section className={`${s.greeting} ${s.homeGreeting}`}>{profile.photoUrl?<img src={profile.photoUrl} alt="Моє фото"/>:<UserRound size={46}/>}<div><p>Твоя читацька історія</p><h1>Вітаємо, {firstName}!</h1></div></section>
  <Feedback state={state}/>
  <section className={`${s.metrics} ${s.homeMetrics}`}><article><strong>{state.data?.counts?.active??'—'}</strong><span>Активні видачі</span></article><article><strong className={state.data?.counts?.overdue?s.red:undefined}>{state.data?.counts?.overdue??'—'}</strong><span>Прострочені</span></article></section>
  <div className={s.homeActions}><button className={s.primary} onClick={()=>onCatalog()}><Search size={18}/>Знайти книжку</button><ReaderScanner className={s.secondary} label="Сканувати штрих-код" onDetected={onCatalog}/></div>
  <h2>Нове для твого читання</h2><p className={s.muted}>{firstName}, поглянь, що нещодавно з’явилося в нашій бібліотеці.</p>
  <div className={s.stack}>{state.data?.newBooks?.map((book:Row)=><BookRow key={book.id} book={book} onBook={onBook} onEntity={onEntity}><PublicationLine book={book} onEntity={onEntity}/><span className={s.badge}>Нове надходження</span></BookRow>)}</div>
  {state.data&&!state.data.newBooks.length&&<p className={s.empty}>Нові надходження з’являться тут.</p>}
  <h2>Остання активність</h2><div className={s.stack}>{state.data?.history?.map((book:Row)=><BookRow key={book.id} book={book} onBook={onBook}><Badge status={book.status}/><p className={s.muted}>До {readerDate(book.due_at)}</p></BookRow>)}</div>
  {state.data&&!state.data.history.length&&<p className={s.empty}>Твоя читацька історія ще попереду. Знайди першу книжку в каталозі.</p>}
 </>;
}

type BrowseKind='genre'|'author'|'publisher'|'tag'|'series';
type BrowseItem={kind:BrowseKind;label:string;singular:string;bookHeading:string;Icon:ComponentType<{size?:number|string}>};
const browseItems:BrowseItem[]=[
 {kind:'genre',label:'Категорії',singular:'Категорія',bookHeading:'Книжки цієї категорії',Icon:FolderTree},
 {kind:'author',label:'Автори',singular:'Автор',bookHeading:'Книжки автора',Icon:UsersRound},
 {kind:'publisher',label:'Видавництва',singular:'Видавництво',bookHeading:'Видання цього видавництва',Icon:Building2},
 {kind:'tag',label:'Теги',singular:'Тег',bookHeading:'Книжки з цим тегом',Icon:Tags},
 {kind:'series',label:'Серії',singular:'Серія',bookHeading:'Книжки цієї серії',Icon:LibraryBig},
];
const browseItem=(kind:string)=>browseItems.find(item=>item.kind===kind)||browseItems[0];

type CatalogProps={state:Row;setState:(value:Row)=>void;epoch:number;onBook:(id:string)=>void;onPropose:()=>void;scanCode:string;onScanDone:()=>void;onBrowse:(kind:BrowseKind)=>void;onEntity:(entity:Row)=>void;onBack:()=>void;onCatalogRoot:()=>void};
export function CatalogPanel(props:CatalogProps){
 if(props.state.entity?.id)return <EntityPanel {...props}/>;
 if(props.state.browseKind)return <EntityDirectory {...props}/>;
 return <CatalogContents {...props}/>;
}

function BrowseButtons({onBrowse}:{onBrowse:(kind:BrowseKind)=>void}){return <section className={s.browseSection} aria-labelledby="browse-reader-catalog"><p id="browse-reader-catalog" className={s.browseLabel}>Переглянути за</p><div className={s.browseGrid}>{browseItems.map(({kind,label,Icon})=><button type="button" key={kind} onClick={()=>onBrowse(kind)}><Icon size={18}/><span>{label}</span></button>)}</div></section>;}

function CatalogContents({state,setState,epoch,onBook,onPropose,scanCode,onScanDone,onBrowse,onEntity}:CatalogProps){
 const update=(value:Row)=>{setScan(null);setScanError('');setState({...state,...value});};
 const params=new URLSearchParams({view:'catalog',q:state.q||'',sort:state.sort||'title',page:String(state.page||1),...Object.fromEntries(Object.entries(state.filters||{}).map(([key,value])=>[key,(value as Row)?.id||'']))});
 const remote=useCabinetData<Page>(API+'?'+params,epoch),[scan,setScan]=useState<Row[]|null>(null),[scanError,setScanError]=useState(''),[manual,setManual]=useState('');
 async function findCode(code:string){setScan(null);setScanError('');try{const data=await readerFetch<{result:{items:Row[]}}>(API+'?view=scan&code='+encodeURIComponent(code));if(data.result.items.length===1)onBook(data.result.items[0].id);else setScan(data.result.items);}catch(error){setScanError((error as Error).message);}}
 useEffect(()=>{if(!scanCode)return;let alive=true;readerFetch<{result:{items:Row[]}}>(API+'?view=scan&code='+encodeURIComponent(scanCode)).then(data=>{if(alive){if(data.result.items.length===1)onBook(data.result.items[0].id);else setScan(data.result.items);}}).catch(error=>{if(alive)setScanError(error.message);}).finally(onScanDone);return()=>{alive=false;};},[scanCode,onBook,onScanDone]);
 const activeFilters=(Object.entries(state.filters||{}) as [string,Row][]).filter(([,value])=>Boolean(value?.id));
 return <>
  <h1>Каталог</h1>
  <Suggest label="Знайти книжку" kind="book" value={state.q||''} onText={q=>{setScan(null);update({q,page:1});}} onSelect={book=>onBook(book.id)}/>
  <BrowseButtons onBrowse={onBrowse}/>
  <div className={`${s.filterBar} ${s.catalogSort}`}><label className={s.sortLabel}>Сортування<select value={state.sort||'title'} onChange={event=>update({sort:event.target.value,page:1})}><option value="title">За назвою</option><option value="newest">Нові надходження</option></select></label></div>
  {!!activeFilters.length&&<div className={s.chips}>{activeFilters.map(([key,value])=><button key={key} onClick={()=>update({filters:{...state.filters,[key]:null},page:1})}>{value.name} · {value.count} ×</button>)}<button onClick={()=>update({filters:{},page:1})}>Скинути фільтри</button></div>}
  <details className={s.details}><summary>Знайти за штрих-кодом</summary><ReaderScanner className={s.secondary} label="Сканувати код" onDetected={code=>void findCode(code)}/><form className={s.actions} onSubmit={event=>{event.preventDefault();void findCode(manual);}}><label className={s.field}>Код з етикетки<input value={manual} onChange={event=>setManual(event.target.value)} maxLength={500}/></label><button className={s.secondary} disabled={!manual.trim()}>Знайти за кодом</button></form></details>
  <Feedback state={remote}/>{scan&&<button className={s.textButton} onClick={()=>setScan(null)}>Повернутися до всього каталогу</button>}{scanError&&<p role="alert" className={s.error}>{scanError}</p>}
  <p className={s.muted}>{scan?`Знайдено за кодом: ${scan.length}`:`Знайдено ${remote.data?.total??'…'} видань`}</p>
  <div className={`${s.stack} ${s.catalogCards}`}>{(scan||remote.data?.items||[]).map(book=><BookRow key={book.id} book={book} onBook={onBook} onEntity={onEntity}><PublicationLine book={book} onEntity={onEntity}/><BookPublicMeta book={book}/><span className={s.badge}>{book.available?`Доступно: ${book.available}`:'Можна подати заявку'}</span><details className={s.details}><summary>Докладніше</summary><div className={s.chips}>{book.entities.filter((entity:Row)=>browseItems.some(item=>item.kind===entity.kind)).map((entity:Row)=><button key={entity.id+entity.role} onClick={()=>onEntity(entity)}>{entity.name}</button>)}</div></details></BookRow>)}</div>
  {remote.data&&!remote.loading&&!(scan||remote.data.items).length&&<p className={s.empty}>Книжок за цим запитом немає. Спробуй іншу назву або скинь фільтри.</p>}
  {!scan&&<Pager data={remote.data} onPage={page=>update({page})}/>}<button className={s.secondary} style={{marginTop:20,width:'100%'}} onClick={onPropose}><Plus size={18}/>Запропонувати книгу бібліотеці</button>
 </>;
}

function EntityDirectory({state,setState,epoch,onEntity,onBack}:CatalogProps){
 const config=browseItem(state.browseKind),query=state.browseQuery||'',currentPage=state.browsePage||1;
 const remote=useCabinetData<Page>(API+'?'+new URLSearchParams({view:'entities',kind:config.kind,q:query,page:String(currentPage)}),epoch);
 return <>
  <button type="button" className={s.sectionBack} onClick={onBack}>← Каталог</button>
  <h1>{config.label}</h1>
  <label className={`${s.field} ${s.directorySearch}`}>Знайти у довіднику<div><Search size={18}/><input type="search" value={query} onChange={event=>setState({...state,browseQuery:event.target.value,browsePage:1})} placeholder={`Пошук: ${config.label.toLocaleLowerCase('uk-UA')}`} maxLength={100}/></div></label>
  <Feedback state={remote}/><p className={s.muted}>Знайдено {remote.data?.total??'…'}</p>
  <div className={s.directoryList}>{remote.data?.items.map(entity=><button type="button" key={entity.id} onClick={()=>onEntity(entity)}><span><strong>{entity.name}</strong><small>{entity.count} {bookCountLabel(Number(entity.count))}</small></span><ChevronRight size={18}/></button>)}</div>
  {remote.data&&!remote.data.items.length&&<p className={s.empty}>У цьому довіднику записів поки немає.</p>}
  <Pager data={remote.data} onPage={browsePage=>setState({...state,browsePage})}/>
 </>;
}

const factLabels:Record<string,string>={nickname:'Псевдонім',country:'Країна',dateOfBirth:'Дата народження',yearDied:'Дата смерті',city:'Місто',address:'Адреса',website:'Вебсайт',email:'Email',phone:'Телефон'};
const sectionLabels:Record<string,string>={biography:'Біографія',description:'Про запис',publications:'Публікації',awards:'Відзнаки'};
function safeWeb(value:string){try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)?url.href:'';}catch{return '';}}
function EntityFacts({metadata}:{metadata:Row}){const facts=Object.keys(factLabels).filter(key=>metadata[key]),sections=Object.keys(sectionLabels).filter(key=>metadata[key]);return <>{!!facts.length&&<dl className={s.entityFacts}>{facts.map(key=><div key={key}><dt>{factLabels[key]}</dt><dd>{key==='website'&&safeWeb(metadata[key])?<a href={safeWeb(metadata[key])} target="_blank" rel="noreferrer">{metadata[key]}</a>:key==='email'?<a href={'mailto:'+metadata[key]}>{metadata[key]}</a>:key==='phone'&&telephoneHref(metadata[key])?<a href={telephoneHref(metadata[key])!}>{metadata[key]}</a>:metadata[key]}</dd></div>)}</dl>}{sections.map(key=><section className={s.entityText} key={key}><h2>{sectionLabels[key]}</h2><p className={s.body}>{metadata[key]}</p></section>)}</>;}
function EntityPanel({state,setState,epoch,onBook,onEntity,onBack,onCatalogRoot}:CatalogProps){
 const config=browseItem(state.entity.kind),remote=useCabinetData<Row>(API+'?'+new URLSearchParams({view:'entity',id:state.entity.id,page:String(state.entityPage||1),sort:state.entitySort||'title'}),epoch),entity=remote.data?.entity,books=remote.data?.books;
 return <>
  <button type="button" className={s.sectionBack} onClick={onBack}>← {config.label}</button>
  <p className={s.entityEyebrow}>{config.singular}</p><h1>{entity?.name||state.entity.name}</h1><Feedback state={remote}/>
  {entity&&<EntityFacts metadata={entity.metadata||{}}/>}
  <section className={s.relatedBooks}><div className={s.relatedHeading}><div><h2>{config.bookHeading}</h2><p className={s.muted}>{books?.total??0} {bookCountLabel(Number(books?.total||0))}</p></div><button type="button" className={s.secondary} onClick={onCatalogRoot}>Весь каталог</button></div>
   <div className={s.stack}>{books?.items?.map((book:Row)=><BookRow key={book.id} book={book} onBook={onBook} onEntity={onEntity}><PublicationLine book={book} onEntity={onEntity}/><span className={s.badge}>{book.available?`Доступно: ${book.available}`:'Можна подати заявку'}</span></BookRow>)}</div>
   {books&&!books.items.length&&<p className={s.empty}>Пов’язаних книжок у каталозі поки немає.</p>}<Pager data={books||null} onPage={entityPage=>setState({...state,entityPage})}/>
  </section>
 </>;
}
function bookCountLabel(count:number){const lastTwo=count%100,last=count%10;return lastTwo>=11&&lastTwo<=14?'книжок':last===1?'книжка':last>=2&&last<=4?'книжки':'книжок';}

export function LoansPanel({state,setState,epoch,act,onBook,busy}:{state:Row;setState:(v:Row)=>void;epoch:number;act:Act;onBook:(id:string)=>void;busy:boolean}){const remote=useCabinetData<Page>(API+'?'+new URLSearchParams({view:'loans',tab:state.tab||'issued',status:state.status||'active',page:String(state.page||1)}),epoch);return <><h1>Мої видачі</h1><div className={s.tabs}>{[['issued','Видані'],['requests','Бронювання']].map(([id,label])=><button key={id} aria-pressed={(state.tab||'issued')===id} onClick={()=>setState({...state,tab:id,page:1})}>{label}</button>)}</div>{state.tab!=='requests'&&<div className={s.loanFilters}>{[['active','Активні'],['overdue','Прострочені'],['returned','Повернені'],['all','Усі']].map(([id,label])=><button key={id} aria-pressed={(state.status||'active')===id} onClick={()=>setState({...state,status:id,page:1})}>{label}</button>)}</div>}<Feedback state={remote}/><div className={s.stack}>{remote.data?.items.map(book=><BookRow key={book.id} book={book} onBook={onBook}><Badge status={book.status}/>{state.tab==='requests'?<><p className={s.small}>Заявка: {readerDate(book.created_at)}<br/>Оновлено: {readerDate(book.updated_at)}</p>{['requested','ready'].includes(book.status)&&<button className={s.secondary} disabled={busy} onClick={()=>{if(window.confirm('Скасувати бронювання цієї книги?'))void act('cancel',{id:book.id,expectedVersion:book.version});}}>Скасувати бронювання</button>}</>:<p className={s.small}>Видано: {readerDate(book.issued_at)}<br/>Повернути до: {readerDate(book.due_at)}{book.received_at&&<><br/>Повернуто: {readerDate(book.received_at)}</>}</p>}</BookRow>)}</div>{remote.data&&!remote.data.items.length&&<p className={s.empty}>{state.tab==='requests'?'Бронювань поки немає. Обери книжку в каталозі.':'У цьому списку видач поки немає.'}</p>}<Pager data={remote.data} onPage={page=>setState({...state,page})}/></>;}

export function ActivityPanel({state,setState,epoch,onBook}:{state:Row;setState:(v:Row)=>void;epoch:number;onBook:(id:string)=>void}){const data=useCabinetData<Page>(API+'?'+new URLSearchParams({view:'activity',kind:state.kind||'reviews',page:String(state.page||1)}),epoch),proposals=useCabinetData<Page>(API+'?view=activity&kind=proposals&page='+(state.proposalPage||1),epoch);return <><h1>Активність</h1><div className={s.tabs}>{[['reviews','Відгуки'],['recent','Нещодавно переглянуті']].map(([id,label])=><button key={id} aria-pressed={(state.kind||'reviews')===id} onClick={()=>setState({...state,kind:id,page:1})}>{label}</button>)}</div><Feedback state={data}/><div className={s.stack}>{data.data?.items.map(book=><BookRow key={book.edition_id} book={book} onBook={onBook}>{book.rating&&<p className={s.rating}>{'★'.repeat(book.rating)} · {statusLabels[book.status]||book.status}</p>}{book.body&&<p className={s.body}>{book.body}</p>}<p className={s.small}>{readerDate(book.viewed_at||book.updated_at)}</p></BookRow>)}</div>{data.data&&!data.data.items.length&&<p className={s.empty}>{state.kind==='recent'?'Відкрий картку книжки — вона з’явиться тут.':'Твої оцінки й відгуки з’являться тут.'}</p>}<Pager data={data.data} onPage={page=>setState({...state,page})}/><h2>Мої пропозиції</h2><Feedback state={proposals}/><div className={s.stack}>{proposals.data?.items.map(proposal=><article key={proposal.id} className={s.panel}><strong>{proposal.title}</strong><p className={s.muted}>{proposal.author}</p><Badge status={proposal.status}/>{proposal.reply&&<p className={s.body}>Бібліотекар: {proposal.reply}</p>}<p className={s.small}>{readerDate(proposal.created_at)}</p></article>)}</div>{proposals.data&&!proposals.data.items.length&&<p className={s.empty}>Маєш книжкову мрію? Запропонуй книгу кнопкою в каталозі.</p>}<Pager data={proposals.data} onPage={proposalPage=>setState({...state,proposalPage})}/></>;}

export function ProposalForm({act,busy,onClose,error}:{act:Act;busy:boolean;onClose:()=>void;error:string}){const [title,setTitle]=useDraftState('title',''),[author,setAuthor]=useDraftState('author',''),[note,setNote]=useDraftState('note',''),nav=useLiteratureNavigation();return <Modal title="Запропонувати книгу" onClose={onClose} busy={busy}>{error&&<p className={s.error} role="alert">{error}</p>}<form onSubmit={async event=>{event.preventDefault();if(await act('proposal',{title,author,note,confirmation:'SEND_BOOK_PROPOSAL'})){nav.complete();onClose();}}}><label className={s.field}>Назва книги<input disabled={busy} required minLength={2} maxLength={300} value={title} onChange={event=>setTitle(event.target.value)}/></label><label className={s.field}>Автор, якщо відомий<input disabled={busy} maxLength={200} value={author} onChange={event=>setAuthor(event.target.value)}/></label><label className={s.field}>Чому варто додати цю книгу?<textarea disabled={busy} maxLength={2000} value={note} onChange={event=>setNote(event.target.value)}/></label><p className={s.muted}>Пропозицію побачить бібліотекар. Відповідь буде в «Активність → Мої пропозиції».</p><button className={s.primary} disabled={busy}>Надіслати пропозицію</button></form></Modal>;}

export function AccountPanel({profile,onProfile,telegram,onLogout,logoutBusy=false,logoutError=''}:{profile:ReaderProfile;onProfile:(profile:ReaderProfile)=>void;telegram:boolean;onLogout:()=>void;logoutBusy?:boolean;logoutError?:string}){
 const suggestedName=profile.displayName.trim()===''||profile.displayName.trim()==='Читач'?profile.fullName:profile.displayName;
 const [phone,setPhone]=useState(profile.phone),[email,setEmail]=useState(profile.email||''),[name,setName]=useState(suggestedName),[community,setCommunity]=useState(profile.communityEnabled),[photo,setPhoto]=useState(false),[zoom,setZoom]=useState(false),[prepared,setPrepared]=useState<PreparedPhoto|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const intent=useRef<{key:string;id:string}|null>(null),photoIntent=useRef<{photo:PreparedPhoto;version:number}|null>(null);
 const refresh=async()=>onProfile((await readerFetch<{profile:ReaderProfile}>('/api/reader/profile',undefined,'GET',profile.id)).profile);
 async function upload(preparedPhoto:PreparedPhoto){setPrepared(preparedPhoto);photoIntent.current||={photo:preparedPhoto,version:profile.version};setBusy(true);setMessage('');try{await readerFetch('/api/reader/photo',{base64:preparedPhoto.base64,requestId:preparedPhoto.requestId,expectedVersion:photoIntent.current.version},'POST',profile.id);await refresh();photoIntent.current=null;setPrepared(null);setMessage('Фото оновлено.');}catch(error){setMessage((error as Error).message+' Можна повторити завантаження.');}finally{setBusy(false);}}
 async function save(event:FormEvent){event.preventDefault();setBusy(true);setMessage('');const input={expectedVersion:profile.version,displayName:name,phone:profile.teacherLinked?profile.phone:phone,email,communityEnabled:community,notifyLoans:profile.notifyLoans,notifyBooks:profile.notifyBooks},key=JSON.stringify(input);if(intent.current?.key!==key)intent.current={key,id:crypto.randomUUID()};try{onProfile((await readerFetch<{profile:ReaderProfile}>('/api/reader/profile',{...input,requestId:intent.current.id},'PATCH',profile.id)).profile);intent.current=null;setMessage('Обліковий запис збережено.');}catch(error){setMessage((error as Error).message);}finally{setBusy(false);}}
 return <><h1>Обліковий запис</h1><section className={s.greeting}><button className={s.avatarButton} onClick={()=>profile.photoUrl?setZoom(true):!profile.teacherLinked&&setPhoto(true)} aria-label="Моє фото">{profile.photoUrl?<img src={profile.photoUrl} alt="Моє фото"/>:<UserRound size={50}/>}</button><div><strong>{profile.fullName}</strong><p>{profile.kind==='teacher'?'Учитель':profile.classLabel||'Клас уточнює бібліотекар'}</p><p>Читацький № {profile.memberNo}</p></div></section>
  {profile.teacherLinked?<section className={s.panel}><p><strong>Предмет / посада:</strong> {profile.subjectPosition||'не вказано'}</p><p><strong>Основний кабінет:</strong> {profile.primaryLocation?.name||'не вказано'}</p><p><strong>Мобільний номер:</strong> {telephoneHref(profile.phone)?<a href={telephoneHref(profile.phone)}>{profile.phone}</a>:profile.phone||'не вказано'}</p><p className={s.muted}>Фото й ці дані автоматично оновлюються з основного довідника вчителів.</p><a className={s.secondary} href={telegram?'/teacher/telegram/cabinet?tab=overview':'/teacher?tab=overview'}>Змінити фото й дані вчителя</a></section>:<button className={s.secondary} disabled={busy} onClick={()=>setPhoto(true)}><Camera size={18}/>Змінити фото</button>}
  {prepared&&<button className={s.secondary} disabled={busy} onClick={()=>void upload(prepared)}>Повторити завантаження фото</button>}{message&&<p className={s.notice} role="status">{message}</p>}
  <form onSubmit={save} className={s.panel}><fieldset disabled={busy}>{!profile.teacherLinked&&<label className={s.field}>Мобільний телефон<input type="tel" autoComplete="tel" value={phone} onChange={event=>setPhone(event.target.value)} maxLength={30}/></label>}<label className={s.field}>Електронна пошта<input type="email" autoComplete="email" value={email} onChange={event=>setEmail(event.target.value)} maxLength={254}/><small>Необов’язковий контакт для бібліотеки. Це не новий логін і не підтверджена адреса.</small></label><label className={s.field}>Ім’я у спільноті<input value={name} minLength={2} maxLength={180} required onChange={event=>setName(event.target.value)}/><small>Спочатку пропонуємо повне ПІБ із читацької картки. За бажанням його можна змінити.</small></label><label className={s.check}><input type="checkbox" checked={community} onChange={event=>setCommunity(event.target.checked)}/><span>Долучитися до читацької спільноти</span></label><p className={s.muted}>Телефон і email доступні лише тобі та уповноваженому бібліотекарю. У спільноті видно обране ім’я.</p><button className={s.primary}>Зберегти зміни</button></fieldset></form>
  <p className={s.notice}>{profile.telegramConnected?'Telegram під’єднано.':profile.teacherLinked?'Підключення Telegram доступне у твоєму чинному кабінеті вчителя.':'Для підключення Telegram отримай персональний QR-код у бібліотекаря.'}</p>{logoutError&&<p className={s.error} role="alert">{logoutError}</p>}
  {profile.teacherLinked?<a className={s.secondary} href={telegram?'/teacher/telegram/cabinet':'/teacher'}>До кабінету вчителя — підручники</a>:<button className={`${s.textButton} ${s.logoutButton}`} disabled={logoutBusy} onClick={onLogout}>{logoutBusy?'Виходимо…':'Вийти на цьому пристрої'}</button>}
  {photo&&<DraftScope draftKey={'reader-photo:'+profile.id}><LiteraturePhotoEditor kind="reader" onClose={()=>setPhoto(false)} onPrepared={preparedPhoto=>void upload(preparedPhoto)}/></DraftScope>}{zoom&&<Modal title="Моє фото" onClose={()=>setZoom(false)}><img className={s.photoLarge} src={profile.photoUrl!} alt="Моє фото"/></Modal>}
 </>;
}
