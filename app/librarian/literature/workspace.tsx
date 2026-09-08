"use client";
/* eslint-disable @next/next/no-img-element */
import {useEffect,useRef,useState,type FormEvent} from "react";
import {BarcodeFormat,QRCodeWriter} from "@zxing/library";
import {BookOpen,LayoutDashboard,Plus,Users,X} from "lucide-react";
import {READER_LOGO,readerFetch} from "@/app/reader/reader-types";
import {LIBRARIKA_CATALOG_URL,LIBRARIKA_DASHBOARD_URL,LIBRARIKA_MEMBERS_URL} from "@/lib/librarika";
import {librarianSectionHref,librarianToolHref} from "../_components/librarian-routes";
import s from "@/app/reader/reader.module.css";

type Row=Record<string,string|number|null>;
type Options={classes:Row[];teachers:Row[];telegram?:{enabled:boolean;botUsername:string|null}};
type Invite={readerId:string;token:string;purpose:string;expiresAt:string;readerVersion?:number};
const statusLabel:Record<string,string>={active:"Активний",inactive:"Не приєднано",blocked:"Доступ вимкнено",linked:"Зв’язано за номером",manual_required:"Очікує Librarika",processing:"Синхронізація",conflict:"Конфлікт",failed:"Помилка",disabled:"Вимкнено",not_queued:"Не поставлено в чергу"};

export default function LiteratureWorkspace({writesEnabled,admin,telegramMiniApp=false}:{writesEnabled:boolean;admin:boolean;telegramMiniApp?:boolean}){
  const [tab,setTab]=useState<"dashboard"|"readers">("dashboard");
  const [stats,setStats]=useState<Row>({}),[readers,setReaders]=useState<Row[]>([]),[options,setOptions]=useState<Options>({classes:[],teachers:[]});
  const [query,setQuery]=useState(""),[error,setError]=useState(""),[notice,setNotice]=useState(""),[busy,setBusy]=useState(false),[modal,setModal]=useState<Row|null>(null),[invite,setInvite]=useState<Invite|null>(null);
  const intent=useRef<{key:string;id:string}|null>(null);

  useEffect(()=>{
    let active=true;
    void readerFetch<{result:{counts:Row}}>("/api/librarian/readers?view=dashboard").then(data=>{if(active)setStats(data.result.counts);}).catch(value=>{if(active)setError((value as Error).message);});
    void readerFetch<{result:Row[]}>("/api/librarian/readers?view=readers").then(data=>{if(active)setReaders(data.result);}).catch(value=>{if(active)setError((value as Error).message);});
    void readerFetch<{result:Options}>("/api/librarian/readers?view=options").then(data=>{if(active)setOptions(data.result);}).catch(value=>{if(active)setError((value as Error).message);});
    return()=>{active=false;};
  },[]);

  async function refresh(){
    setError("");
    try{const [dashboard,directory,configuration]=await Promise.all([
      readerFetch<{result:{counts:Row}}>("/api/librarian/readers?view=dashboard"),
      readerFetch<{result:Row[]}>("/api/librarian/readers?view=readers"),
      readerFetch<{result:Options}>("/api/librarian/readers?view=options"),
    ]);setStats(dashboard.result.counts);setReaders(directory.result);setOptions(configuration.result);}catch(value){setError((value as Error).message);}
  }

  async function act(action:string,input:Record<string,unknown>){
    if(busy||!writesEnabled)return null;
    const key=JSON.stringify({action,input});if(intent.current?.key!==key)intent.current={key,id:crypto.randomUUID()};
    setBusy(true);setError("");setNotice("");
    try{const data=await readerFetch<{result:Row}>("/api/librarian/readers",{action,input:{...input,...(action==="invite"?{}:{requestId:intent.current.id})}});intent.current=null;await refresh();return data.result;}
    catch(value){setError((value as Error).message);return null;}finally{setBusy(false);}
  }

  const normalized=query.trim().toLocaleLowerCase("uk");
  const baselineReady=Number(stats.baseline_ready)>0;
  const visibleReaders=readers.filter(row=>!normalized||String(row.full_name||"").toLocaleLowerCase("uk").includes(normalized)||String(row.member_no||"").toLocaleLowerCase("uk").includes(normalized));
  return <div className={s.shell}>
    <header className={s.header}><a className={s.brand} href={librarianSectionHref("home",telegramMiniApp)}><img src={READER_LOGO} alt="Лейбл бібліотеки"/><span><strong>Єдина бібліотека</strong><small>Міжнародний ліцей МАУП</small></span></a><a className={s.secondary} href={librarianSectionHref("home",telegramMiniApp)}>Усі інструменти</a></header>
    <div className={s.layout}><nav className={s.sidebar} aria-label="Librarika та читачі">
      <button className={tab==="dashboard"?s.active:""} onClick={()=>setTab("dashboard")}><LayoutDashboard size={20}/>Огляд і синхронізація</button>
      <button className={tab==="readers"?s.active:""} onClick={()=>setTab("readers")}><Users size={20}/>Читачі й QR</button>
      <div className={s.sideNote}><strong>Дві системи</strong><br/><a href={LIBRARIKA_CATALOG_URL} target="_blank" rel="noopener noreferrer">Художня література · Librarika ↗</a><br/><a href={librarianToolHref("catalog",telegramMiniApp)}>Підручники · наш сайт ↗</a></div>
    </nav><main className={s.main}>
      <div className={s.sectionHead}><div><p className={s.eyebrow}>Кабінет бібліотекаря · інтеграційний центр</p><h1>Librarika та читачі</h1></div><button className={s.quiet} disabled={busy} onClick={()=>void refresh()}>Оновити</button></div>
      {error&&<p className={s.error} role="alert">{error}</p>}{notice&&<p className={s.notice} role="status">{notice}</p>}{!writesEnabled&&<p className={s.notice}>Запис тимчасово вимкнено; доступний перегляд.</p>}
      {tab==="dashboard"&&<Dashboard stats={stats} admin={admin} telegramMiniApp={telegramMiniApp} writesEnabled={writesEnabled} onReaders={()=>setTab("readers")} onNew={()=>{setInvite(null);setModal({});}}/>}
      {tab==="readers"&&<><div className={s.toolbar}><label className={s.search}><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="Ім’я або читацький номер…" aria-label="Пошук читача"/></label><button className={s.button} disabled={!writesEnabled||!baselineReady} onClick={()=>{setInvite(null);setModal({});}}><Plus size={18}/>Новий учень</button></div>{!baselineReady&&<p className={s.notice}>Перед створенням першого нового учня синхронізуйте повний CSV Members із Librarika — тоді автоматичний номер не повторить уже зайнятий.</p>}<div className={s.loanList}>{visibleReaders.map(row=><article className={s.loan} key={String(row.id)}><div className={s.loanContent}><button onClick={()=>{setInvite(null);setModal(row);}}>{row.full_name}</button><p>Читацький № {row.member_no} · {row.class_name||row.source_group_label||"Клас не зазначено"}</p></div><span className={s.badge}>{row.linked_teacher_user_id&&row.access_status==="active"?"Кабінет учителя":statusLabel[String(row.access_status)]||row.access_status}</span><span className={s.badge}>Librarika: {statusLabel[String(row.librarika_status)]||row.librarika_status}</span><button className={s.secondary} onClick={()=>{setInvite(null);setModal(row);}}>Картка читача</button></article>)}</div>{visibleReaders.length===0&&<p className={s.empty}>Читачів за цим пошуком немає.</p>}</>}
      {modal&&<ReaderModal
        row={modal} options={options} invite={invite} busy={busy} writesEnabled={writesEnabled}
        onClose={()=>{if(!busy){setModal(null);setInvite(null);}}}
        onSave={async event=>{const form=formData(event),result=await act("save",{...(modal.id?{id:modal.id,expectedVersion:modal.version}:{}),fullName:form.get("name"),memberNo:form.get("member"),kind:form.get("kind"),classYearId:form.get("class")||null});if(result){setNotice(`Картку збережено${result.memberNo?` · читацький № ${result.memberNo}`:""}.`);setModal(null);}}}
        onInvite={async purpose=>{if(!window.confirm(`Створити персональне запрошення для ${modal.full_name}? Передайте його тільки цьому читачу.`))return;const result=await act("invite",{readerId:modal.id,purpose,expectedVersion:modal.version});if(result){const next={...result,readerId:String(modal.id)} as unknown as Invite;setInvite(next);setModal(current=>current?{...current,version:result.readerVersion}:current);}}}
        onAccess={async()=>{const action=modal.access_status==="blocked"?"unblock":"disable";if(window.confirm(action==="disable"?"Вимкнути читацький доступ, усі сеанси та нагадування? Книги й історія залишаться.":"Зняти блокування? Для входу може знадобитися нове персональне запрошення.")){if(await act("access",{readerId:modal.id,expectedVersion:modal.version,action,confirmation:"CONFIRM_READER_ACCESS"}))setModal(null);}}}
        onTeacherLink={async event=>{const form=formData(event);if(await act("teacher_link",{readerId:modal.id,expectedVersion:modal.version,teacherUserId:form.get("teacher"),confirmation:form.get("confirmation")}))setModal(null);}}
      />}
    </main></div>
  </div>;
}

function Dashboard({stats,admin,telegramMiniApp,writesEnabled,onReaders,onNew}:{stats:Row;admin:boolean;telegramMiniApp:boolean;writesEnabled:boolean;onReaders:()=>void;onNew:()=>void}){
  const baselineReady=Number(stats.baseline_ready)>0;
  return <><div className={s.stats}>{[["readers","Читачів у нашій базі"],["linked","Зв’язано з Librarika"],["pending","Потрібно звірити"],["conflicts","Конфліктів або помилок"]].map(([key,name])=><div className={s.stat} key={key}><strong>{stats[key]||0}</strong><span>{name}</span></div>)}</div>
    <section className={s.panel} style={{marginTop:18}}><h2 className={s.heading}>Чітке розділення систем</h2><div className={s.fields}><div><BookOpen size={22}/><strong>Librarika</strong><p className={s.muted}>Художня й наукова література: каталог, картки, видача, повернення, резервування, оцінки та відгуки.</p></div><div><Users size={22}/><strong>Єдина бібліотека</strong><p className={s.muted}>Підручники, кабінети, QR-вхід, Telegram і читацька спільнота. Проєкцію строків додамо лише після під’єднання перевіреного джерела видач Librarika.</p></div></div><div className={s.actions}><a className={s.button} href={LIBRARIKA_DASHBOARD_URL} target="_blank" rel="noopener noreferrer">Відкрити Librarika</a><a className={s.secondary} href={LIBRARIKA_CATALOG_URL} target="_blank" rel="noopener noreferrer">Каталог художньої літератури</a><a className={s.secondary} href={LIBRARIKA_MEMBERS_URL} target="_blank" rel="noopener noreferrer">Читачі в Librarika</a></div></section>
    <section className={s.panel} style={{marginTop:18}}><h2 className={s.heading}>Центр синхронізації</h2><p className={s.bodyText}>На Basic-плані синхронізація працює з офіційним CSV-експортом Members: спочатку перевірка змін, потім безпечне додавання й оновлення без автоматичних видалень.</p><div className={s.actions}>{admin&&<a className={s.button} href={telegramMiniApp?"/librarian/sync?from=telegram":"/librarian/sync"}>Синхронізувати Librarika</a>}<button className={s.secondary} onClick={onReaders}>Перевірити читачів</button><button className={s.secondary} disabled={!writesEnabled||!baselineReady} onClick={onNew}><Plus size={18}/>Новий учень</button></div><p className={s.notice}>{baselineReady?"Повну базову звірку Members підтверджено. Автоматичний номер врахує вже зайняті числові номери.":"Спочатку виконайте повну базову звірку Members; до неї створення нових номерів заблоковано."} Пароль і cookies Librarika не використовуються.</p></section>
  </>;
}

function ReaderModal({row,options,invite,busy,writesEnabled,onClose,onSave,onInvite,onAccess,onTeacherLink}:{row:Row;options:Options;invite:Invite|null;busy:boolean;writesEnabled:boolean;onClose:()=>void;onSave:(event:FormEvent<HTMLFormElement>)=>Promise<void>;onInvite:(purpose:string)=>Promise<void>;onAccess:()=>Promise<void>;onTeacherLink:(event:FormEvent<HTMLFormElement>)=>Promise<void>}){
  return <AdminModal title={row.id?String(row.full_name):"Новий учень"} onClose={onClose}><form key={String(row.id||"new")} onSubmit={event=>void onSave(event)}><div className={s.fields}><label className={s.field}>Повне ім’я<input name="name" defaultValue={String(row.full_name||"")} required minLength={3} maxLength={180}/></label><label className={s.field}>Єдиний читацький номер<input name="member" inputMode="numeric" defaultValue={String(row.member_no||"")} required={Boolean(row.id)} readOnly={row.librarika_status==="linked"} maxLength={50} placeholder="Створиться автоматично"/><small>{row.id?row.librarika_status==="linked"?"Номер підтверджено в Librarika й захищено від випадкової зміни.":"Зміну потрібно буде звірити з Librarika.":"Залиште порожнім: система створить унікальний числовий номер."}</small></label><label className={s.field}>Категорія<select name="kind" defaultValue={String(row.kind||"student")}>{[["student","Учень / учениця"],["teacher","Учитель"],["staff","Працівник"],["other","Інший читач"],["unclassified","Потребує звірки"]].map(([id,name])=><option value={id} key={id}>{name}</option>)}</select></label><label className={s.field}>Поточний клас<select name="class" defaultValue={String(row.class_year_id||"")}><option value="">Без призначеного класу</option>{options.classes.map(item=><option value={String(item.id)} key={String(item.id)}>{item.class_name} · {item.year_label}</option>)}</select><small>У джерелі: {row.source_group_label||"не зазначено"}. Клас не вгадується автоматично.</small></label></div><div className={s.actions}><button className={s.button} disabled={busy||!writesEnabled}>Зберегти картку</button></div></form>
    {row.id&&<>{!!row.has_photo&&<img className={s.avatar} src={`/api/librarian/readers/${encodeURIComponent(String(row.id))}/photo`} alt="Фото читача"/>}<p className={s.muted}>Телефон: {row.phone||"не вказано"} · ім’я у спільноті: {row.display_name||"не обрано"}</p><div className={s.actions}>{!row.linked_teacher_user_id&&["web","telegram"].map(purpose=><button type="button" key={purpose} className={s.secondary} disabled={busy||!writesEnabled||row.access_status==="blocked"||(purpose==="telegram"&&!options.telegram?.botUsername)} onClick={()=>void onInvite(purpose)}>QR-вхід: {purpose==="web"?"сайт":"Telegram"}</button>)}<button type="button" className={s.danger} disabled={busy||!writesEnabled} onClick={()=>void onAccess()}>{row.access_status==="blocked"?"Зняти блокування":"Вимкнути доступ"}</button></div>{invite&&invite.readerId===row.id&&<ReaderInviteQr invite={invite} fullName={String(row.full_name||"читача")} botUsername={options.telegram?.botUsername||null}/>} {!row.linked_teacher_user_id&&row.kind!=="student"&&<details className={s.notice}><summary>Звірити з кабінетом учителя</summary><form onSubmit={event=>void onTeacherLink(event)}><label className={s.field}>Існуючий учитель<select name="teacher" required><option value="">Оберіть точний профіль</option>{options.teachers.map(item=><option key={String(item.id)} value={String(item.id)}>{item.full_name}</option>)}</select></label><label className={s.field}>Введіть його повне ім’я для підтвердження<input name="confirmation" required/></label><p className={s.muted}>Звірте особу, а не лише схожість імен.</p><button className={s.button} disabled={busy||!writesEnabled}>Приєднати до кабінету вчителя</button></form></details>}</>}
  </AdminModal>;
}

function AdminModal({title,onClose,children}:{title:string;onClose:()=>void;children:React.ReactNode}){const ref=useRef<HTMLDialogElement>(null);useEffect(()=>{ref.current?.showModal();},[]);return <dialog ref={ref} className={s.dialog} onCancel={event=>{event.preventDefault();onClose();}}><div className={s.dialogInner}><div className={s.dialogTop}><h2>{title}</h2><button className={s.iconButton} onClick={onClose} aria-label="Закрити"><X/></button></div><div style={{marginTop:22}}>{children}</div></div></dialog>;}

function ReaderInviteQr({invite,fullName,botUsername}:{invite:{token:string;purpose:string;expiresAt:string};fullName:string;botUsername:string|null}){
  const canvas=useRef<HTMLCanvasElement>(null),[notice,setNotice]=useState(""),[remaining,setRemaining]=useState(()=>inviteRemainingSeconds(invite.expiresAt));
  const link=invite.purpose==="telegram"&&botUsername?`https://t.me/${botUsername}?start=ra_${invite.token}`:`https://yedyna-biblioteka-liceiu.nazarijshvetz1.chatgpt.site/reader#invite=${invite.token}`;
  useEffect(()=>{if(canvas.current)drawReaderQr(canvas.current,link);},[link]);
  useEffect(()=>{const timer=window.setInterval(()=>setRemaining(inviteRemainingSeconds(invite.expiresAt)),1000);return()=>window.clearInterval(timer);},[invite.expiresAt]);
  const expired=remaining<=0;
  async function copy(){const copied=await copyReaderInvite(link);setNotice(copied?"Покликання скопійовано.":"Браузер не дозволив копіювання. Скористайтеся QR або виділіть адресу вручну.");}
  function download(){if(!canvas.current)return;const anchor=document.createElement("a");anchor.href=canvas.current.toDataURL("image/png");anchor.download=`qr-вхід-${safeReaderFilePart(fullName)}.png`;anchor.click();}
  return <div className={s.notice}><strong>QR-вхід читача</strong><p className={s.muted}>Покажіть цей код саме учневі або вчителю. Після сканування відкриється його персональний кабінет без пароля.</p><canvas ref={canvas} width={280} height={280} aria-label="QR-код входу читача" style={{display:"block",width:280,maxWidth:"100%",height:"auto",margin:"14px auto",background:"#fff",borderRadius:10}}/><p className={s.muted} role="timer" aria-live="polite">{expired?"Строк дії QR завершився":`Залишилося ${formatReaderInviteCountdown(remaining)}`} · діє один раз до {new Date(invite.expiresAt).toLocaleString("uk-UA")}</p><input className={s.input} style={{width:"100%"}} readOnly value={link} aria-label="Персональне запрошення" onFocus={event=>event.target.select()}/><div className={s.actions}>{expired?<span className={s.muted}>Посилання більше не діє</span>:<a className={s.secondary} href={link} target="_blank" rel="noreferrer">Відкрити</a>}<button className={s.secondary} type="button" onClick={()=>void copy()} disabled={expired}>Копіювати</button><button className={s.secondary} type="button" onClick={download} disabled={expired}>Завантажити QR</button></div><p className={s.muted} role="status">{notice}</p></div>;
}

function formData(event:FormEvent<HTMLFormElement>){event.preventDefault();return new FormData(event.currentTarget);}
function drawReaderQr(canvas:HTMLCanvasElement,value:string){const size=280,matrix=new QRCodeWriter().encode(value,BarcodeFormat.QR_CODE,size,size,new Map()),context=canvas.getContext("2d");if(!context)return;context.fillStyle="#fff";context.fillRect(0,0,size,size);context.fillStyle="#173522";for(let y=0;y<matrix.getHeight();y+=1)for(let x=0;x<matrix.getWidth();x+=1)if(matrix.get(x,y))context.fillRect(x,y,1,1);}
function inviteRemainingSeconds(value:string){const time=Date.parse(value);return Number.isFinite(time)?Math.max(0,Math.ceil((time-Date.now())/1000)):0;}
function formatReaderInviteCountdown(seconds:number){const safe=Math.max(0,Math.floor(seconds));return `${String(Math.floor(safe/60)).padStart(2,"0")}:${String(safe%60).padStart(2,"0")}`;}
async function copyReaderInvite(value:string){if(navigator.clipboard?.writeText){try{await navigator.clipboard.writeText(value);return true;}catch{/* clipboard permissions may be unavailable in an embedded page */}}const textarea=document.createElement("textarea");textarea.value=value;textarea.readOnly=true;textarea.setAttribute("aria-hidden","true");textarea.style.position="fixed";textarea.style.inset="0 auto auto -9999px";document.body.appendChild(textarea);try{textarea.focus({preventScroll:true});textarea.select();textarea.setSelectionRange(0,value.length);return document.execCommand("copy");}catch{return false;}finally{textarea.remove();}}
function safeReaderFilePart(value:string){return value.normalize("NFKC").replace(/[\\/:*?"<>|]+/gu,"-").trim().slice(0,80)||"читач";}
