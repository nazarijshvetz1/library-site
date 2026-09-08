import {authorizeLibrarianApi} from "@/lib/librarian-api";
import {LIBRARIKA_DASHBOARD_URL} from "@/lib/librarika";
import MemberSyncPanel from "./member-sync-panel";

export const dynamic="force-dynamic";
export const metadata={title:"Синхронізація Librarika · Єдина бібліотека",robots:{index:false,follow:false}};

export default async function LibrarikaSyncPage({searchParams}:{searchParams:Promise<{from?:string}>}){
  const params=await searchParams;
  const returnHref=params.from==="telegram"?"/librarian/telegram/cabinet?target=literature":"/librarian/literature";
  const auth=await authorizeLibrarianApi();
  if(!auth.ok||auth.value.access.role!=="admin")return <main><h1>Службова сторінка</h1><p>Увійдіть як адміністратор бібліотеки.</p><a href={returnHref}>До кабінету</a></main>;
  return <main style={{maxWidth:920,margin:"2rem auto",padding:"1.5rem",fontFamily:"Inter, Segoe UI, sans-serif",lineHeight:1.55,color:"#173522"}}>
    <a href={returnHref}>← Librarika та читачі</a>
    <h1 style={{fontFamily:"Georgia, serif",fontSize:"clamp(2rem,5vw,3.4rem)",marginBottom:".4rem"}}>Синхронізація Librarika</h1>
    <p>На Basic-плані використовуємо лише офіційні експорти. Паролі, cookies і приховані запити не передаються та не зберігаються.</p>
    <p><a href={LIBRARIKA_DASHBOARD_URL} target="_blank" rel="noopener noreferrer">Відкрити Librarika ↗</a></p>
    {auth.value.access.writesEnabled?<MemberSyncPanel/>:<p>Запис тимчасово вимкнено; доступний лише перегляд.</p>}
    <section style={{background:"#f4f1e6",borderRadius:18,padding:"1.25rem",marginTop:"1.25rem"}}>
      <h2>Що буде далі</h2>
      <p><strong>Видачі та строки.</strong> Наступний незалежний модуль прийматиме офіційні експорти Titles, Copies і Circulations, звірятиме конкретний примірник та лише після цього оновлюватиме «Мої книги» й Telegram-нагадування.</p>
      <p><strong>Повністю автоматичний режим.</strong> Увімкнемо тільки після офіційного API або письмово дозволеного feed від Librarika.</p>
    </section>
  </main>;
}
