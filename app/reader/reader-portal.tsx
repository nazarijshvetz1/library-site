"use client";
/* eslint-disable @next/next/no-html-link-for-pages, @next/next/no-img-element */
import {useCallback,useEffect,useRef,useState} from "react";
import {BookMarked,ExternalLink,Heart,LibraryBig,LogIn,MessageCircle,UserRound} from "lucide-react";
import {LIBRARIKA_CATALOG_URL} from "@/lib/librarika";
import ProfilePanel from "./profile-panel";
import BooksPanel from "./books-panel";
import CommunityPanel from "./community-panel";
import {READER_LOGO,readerFetch,type ReaderProfile} from "./reader-types";
import s from "./reader.module.css";

const TELEGRAM_SCRIPT_URL="https://telegram.org/js/telegram-web-app.js";
const wait=(milliseconds:number)=>new Promise<void>(resolve=>window.setTimeout(resolve,milliseconds));

async function telegramApp(){
  let script=document.querySelector<HTMLScriptElement>('script[data-reader-telegram="true"]');
  if(!window.Telegram?.WebApp&&!script){
    script=document.createElement("script");script.src=TELEGRAM_SCRIPT_URL;script.dataset.readerTelegram="true";script.onerror=()=>{script!.dataset.readerTelegramError="true";};document.head.append(script);
  }
  for(let attempt=0;attempt<80;attempt+=1){
    const app=window.Telegram?.WebApp;
    if(app?.initData){app.ready();app.expand();app.setHeaderColor?.("#173522");app.setBackgroundColor?.("#faf8f1");return app;}
    if(script?.dataset.readerTelegramError==="true")throw new Error("Не вдалося завантажити Telegram. Перевір з’єднання та відкрий запрошення ще раз.");
    await wait(50);
  }
  throw new Error("Telegram не передав дані входу. Закрий це вікно та знову відкрий персональне запрошення в чаті з бібліотечним ботом.");
}

export default function ReaderPortal({telegram=false}:{telegram?:boolean}){
  const [profile,setProfile]=useState<ReaderProfile|null>(null),[section,setSection]=useState("books"),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(""),[invite,setInvite]=useState(""),[inviteName,setInviteName]=useState(""),[consent,setConsent]=useState(false),[bot,setBot]=useState<string|null>(null),[telegramReady,setTelegramReady]=useState(false);
  const started=useRef(false),telegramInitData=useRef(""),loginSection=()=>setSection("login");
  const updateProfile=(next:ReaderProfile)=>setProfile(current=>current?.id===next.id?next:current);
  const openBook=(id:string)=>window.location.assign("/library?book="+encodeURIComponent(id));
  const refresh=useCallback(async()=>{const data=await readerFetch<{profile:ReaderProfile;telegram:{botUsername:string|null}}>("/api/reader/session");setProfile(data.profile);setBot(data.telegram.botUsername);return data.profile;},[]);
  useEffect(()=>{readerFetch<{telegram:{botUsername:string|null}}>("/api/reader/config").then(data=>setBot(data.telegram.botUsername)).catch(()=>{});},[]);
  useEffect(()=>{if(started.current)return;started.current=true;const url=new URL(window.location.href),fragment=new URLSearchParams(url.hash.slice(1)),token=fragment.get("invite")||"";
    const initialBook=url.searchParams.get("book");if(initialBook&&/^[A-Za-z0-9_-]{1,100}$/.test(initialBook)){window.location.replace("/library?book="+encodeURIComponent(initialBook));return;}
    const initialTab=url.searchParams.get("tab");if(initialTab==="catalog"){window.location.replace(LIBRARIKA_CATALOG_URL);return;}if(initialTab&&["books","profile","community"].includes(initialTab))queueMicrotask(()=>setSection(initialTab));
    if(token){queueMicrotask(()=>{setInvite(token);setSection("login");});void (async()=>{let launchError="";
      if(telegram){try{const app=await telegramApp();telegramInitData.current=app.initData;setTelegramReady(true);}catch(e){telegramInitData.current="";setTelegramReady(false);launchError=(e as Error).message;}}
      window.history.replaceState(null,"",url.pathname+url.search);
      try{const data=await readerFetch<{preview:{fullName:string}}>("/api/reader/session",{action:"preview",token,purpose:telegram?"telegram":"web"});setInviteName(data.preview.fullName);if(launchError)setError(launchError);}catch(e){setError((e as Error).message);}finally{setLoading(false);}
    })();return;}
    (async()=>{if(telegram){try{const app=await telegramApp();telegramInitData.current=app.initData;setTelegramReady(true);await readerFetch("/api/reader/session",{action:"telegram",initData:app.initData});await refresh();}catch(e){telegramInitData.current="";setTelegramReady(false);setProfile(null);setError((e as Error).message);setSection("login");}}else await refresh().catch(()=>{});})().finally(()=>setLoading(false));
  },[refresh,telegram]);
  async function login(){if((!telegram&&!consent)||!inviteName||busy||(telegram&&!telegramReady))return;setBusy(true);setError("");try{let initData=telegramInitData.current;if(telegram&&!initData){const app=await telegramApp();initData=app.initData;telegramInitData.current=initData;setTelegramReady(true);}await readerFetch("/api/reader/session",{action:telegram?"telegram":"invite",token:invite,confirmation:"CONNECT_MY_READER_PROFILE",...(telegram?{initData}:{})});setInvite("");setInviteName("");await refresh();setSection("profile");}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function logout(){const readerId=profile?.id;setBusy(true);setError("");try{await readerFetch("/api/reader/session",{},"DELETE",readerId);setProfile(null);setSection("login");}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  function navigate(tab:string){setSection(tab);setError("");}
  const protectedSection=["books","profile","community"].includes(section),needsLogin=section==="login"||(protectedSection&&!profile);
  return <div className={s.shell}><header className={s.header}><a className={s.brand} href="/"><img src={READER_LOGO} alt="Лейбл бібліотеки"/><span><strong>Єдина бібліотека</strong><small>Міжнародний ліцей МАУП</small></span></a><div className={s.headerLinks}><a href={LIBRARIKA_CATALOG_URL} target="_blank" rel="noopener noreferrer">Каталог Librarika <ExternalLink size={15}/></a>{profile?<button className={s.quiet} onClick={()=>navigate("profile")}><UserRound size={16}/>Мій профіль</button>:!telegram&&<button className={s.secondary} onClick={loginSection}><LogIn size={15}/>Увійти</button>}</div></header>
  <div className={s.layout}><nav className={s.sidebar} aria-label="Кабінет читача"><a href={LIBRARIKA_CATALOG_URL} target="_blank" rel="noopener noreferrer"><LibraryBig size={21}/>Каталог художньої літератури</a>{[["books","Мої книги",BookMarked],["community","Спільнота",MessageCircle],["profile","Профіль",UserRound]].map(([id,label,Icon])=>{const Symbol=Icon as typeof BookMarked;return <button key={String(id)} className={section===id?s.active:""} aria-current={section===id?"page":undefined} onClick={()=>navigate(String(id))}><Symbol size={21}/>{String(label)}</button>;})}<a href="/suggest-book"><Heart size={21}/>Запропонувати книгу</a><div className={s.sideNote}><strong>Чітке розділення</strong><br/>Художня й наукова література — у Librarika.<br/>Профіль, Telegram і спільнота — тут.<br/><br/><a href="/">На головну бібліотеки ↗</a></div></nav>
  <main className={s.main}>
    {error&&!needsLogin&&<p className={s.error} role="alert">{error}</p>}
    {needsLogin&&<section className={s.panel}><span className={s.eyebrow}>Особистий кабінет</span><h1 className={s.heading}>Твої книги завжди поруч</h1>{loading?<p className={s.muted}>Перевіряємо безпечний вхід…</p>:invite?<><p className={s.notice}>Персональне запрошення для: <strong>{inviteName||"перевіряємо…"}</strong></p>{!telegram&&<label className={s.check}><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)} disabled={!inviteName}/><span>Це мій читацький профіль. Хочу приєднати його на цьому пристрої.</span></label>}{telegram&&telegramReady&&<p className={s.bodyText}>Перевір ім’я та підтвердь підключення цього профілю до свого Telegram.</p>}{telegram&&!telegramReady?<div className={s.actions}>{bot?<a className={s.button} href={"https://t.me/"+bot+"?start=ra_"+encodeURIComponent(invite)}>Відкрити запрошення через бота</a>:<p className={s.muted}>Закрий це вікно та знову відкрий персональне запрошення у приватному чаті з ботом.</p>}</div>:<button className={s.button} disabled={!inviteName||busy||(!telegram&&!consent)} onClick={()=>void login()}>{busy?"Приєднуємо…":telegram?"Так, це мій профіль — підключити":"Приєднати мій профіль"}</button>}<p className={s.muted}>Не підтверджуй, якщо бачиш чуже ім’я. Звернися до бібліотекаря.</p></>:<><p className={s.bodyText}>Для першого входу отримай персональне QR-запрошення у бібліотекаря. Воно під’єднає саме твій читацький квиток — придумувати пароль для нашого сайту не потрібно.</p><p className={s.muted}>Художні й наукові книги, оцінки, відгуки та резервування залишаються у Librarika.</p><div className={s.actions}>{bot&&<a className={s.button} href={"https://t.me/"+bot+"?start=reader"}>Відкрити бібліотечного бота</a>}<a className={s.secondary} href={LIBRARIKA_CATALOG_URL} target="_blank" rel="noopener noreferrer">Каталог художньої літератури</a><a className={s.quiet} href={telegram?"/teacher/telegram":"/teacher"}>Вхід для вчителя</a></div></>}{error&&<p className={s.error} role="alert">{error}</p>}</section>}
    {profile&&section==="profile"&&<><ProfilePanel key={profile.id} profile={profile} onProfile={updateProfile} telegram={telegram}/>{!profile.teacherLinked&&<button className={s.quiet} style={{marginTop:22}} disabled={busy} onClick={()=>void logout()}>Вийти на цьому пристрої</button>}</>}
    {profile&&section==="books"&&<BooksPanel key={profile.id}/>}
    {profile&&section==="community"&&<CommunityPanel key={profile.id} profile={profile} sharedBook={null} onShared={()=>undefined} onBook={openBook} onProfile={()=>navigate("profile")}/>}
    <footer className={s.footer}><span>Єдина бібліотека · Міжнародний ліцей МАУП</span><span>Читай. Досліджуй. Ділися відкриттями.</span></footer>
  </main></div></div>;
}
