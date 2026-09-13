"use client";
import {useEffect,useState} from 'react';
import {READER_LOGO} from '../../reader/reader-types';
import s from '../../reader/reader.module.css';
export default function CabinetChooser(){
 const [bot,setBot]=useState<string|null>(null);
 useEffect(()=>{fetch('/api/reader/config').then(r=>r.json()).then(d=>setBot(d.telegram?.botUsername||null)).catch(()=>{});},[]);
 useEffect(()=>{if(!window.Telegram?.WebApp){const script=document.createElement('script');script.src='https://telegram.org/js/telegram-web-app.js';document.head.append(script);}else{window.Telegram.WebApp.ready();window.Telegram.WebApp.expand();}},[]);
 return <div className={s.shell}><header className={s.header}><img src={READER_LOGO} width="44" height="44" alt="Емблема бібліотеки"/><strong>Єдина бібліотека</strong></header><main className={s.main}><section className={s.panel}><h1 className={s.heading}>Оберіть кабінет</h1><div className={s.loginForm}><a className={s.button} href={bot?"https://t.me/"+bot+"?start=teacher":"/teacher"} onClick={e=>{if(bot&&(window.Telegram?.WebApp as any)?.openTelegramLink){e.preventDefault();(window.Telegram!.WebApp as any).openTelegramLink("https://t.me/"+bot+"?start=teacher");}}}>🎓 Кабінет учителя</a><p className={s.muted}>Підручники, замовлення та навчальні матеріали.</p><a className={s.button} href="/reader/telegram">📚 Кабінет читача</a><p className={s.muted}>Художня та наукова література, видачі й спільнота.</p><a className={s.secondary} href="/librarian/telegram?target=home">🏛 Кабінет бібліотекаря</a><p className={s.muted}>Керування бібліотекою. Потрібен доступ бібліотекаря.</p></div></section></main></div>;
}
