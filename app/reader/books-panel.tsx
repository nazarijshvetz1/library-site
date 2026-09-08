"use client";
import {ExternalLink,LibraryBig} from "lucide-react";
import {LIBRARIKA_CATALOG_URL,LIBRARIKA_DASHBOARD_URL} from "@/lib/librarika";
import s from "./reader.module.css";

export default function BooksPanel(){
  return <section><div className={s.sectionHead}><div><span className={s.eyebrow}>Мої видачі й строки</span><h1>Мої книги</h1></div><LibraryBig size={26}/></div>
    <div className={s.panel}><h2 className={s.heading}>Актуальні дані — у Librarika</h2><p className={s.bodyText}>Відкрий свій обліковий запис Librarika, щоб побачити книги на руках, строки повернення, історію та резервування.</p><div className={s.actions}><a className={s.button} href={LIBRARIKA_DASHBOARD_URL} target="_blank" rel="noopener noreferrer">Мій кабінет Librarika <ExternalLink size={16}/></a><a className={s.secondary} href={LIBRARIKA_CATALOG_URL} target="_blank" rel="noopener noreferrer">Каталог художньої літератури</a></div></div>
    <p className={s.notice}>Автоматичне відображення строків і Telegram-нагадування на нашому сайті ще не активовані: для них потрібне перевірене офіційне джерело видач Librarika. Старі локальні записи не показуються як актуальні.</p>
  </section>;
}
