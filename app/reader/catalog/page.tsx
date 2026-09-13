"use client";
import {useEffect,useRef,useState} from 'react';
import {BookRow,BookPublicMeta,Cover,Feedback,InfinitePager,PublicationLine,useCabinetData,useInfiniteCabinetData,type InfinitePageCache,type Row} from '../cabinet-controls';
import {READER_LOGO} from '../reader-types';
import s from '../cabinet.module.css';
const API='/api/public/literature';
const kinds=[['genre','Категорії'],['author','Автори'],['publisher','Видавництва'],['tag','Теги'],['series','Серії']];
export default function PublicLiteratureCatalog(){
 const [query,setQuery]=useState(''),[search,setSearch]=useState(''),[kind,setKind]=useState(''),[entity,setEntity]=useState(''),[book,setBook]=useState(''),[page,setPage]=useState(1),[telegram,setTelegram]=useState(false),cache=useRef<InfinitePageCache>(new Map());
 useEffect(()=>{setTelegram(new URL(location.href).searchParams.has('telegram'));},[]);
 useEffect(()=>{const timer=setTimeout(()=>{setSearch(query.trim());setPage(1);},220);return()=>clearTimeout(timer);},[query]);
 const params=new URLSearchParams({view:entity?'entity':kind?'entities':'catalog',q:search,kind,id:entity});
 const list=useInfiniteCabinetData(API+'?'+params,page,0,cache.current,entity?'books':'');
 const detail=useCabinetData<Row>(book?API+'?view=book&id='+encodeURIComponent(book):null),record=detail.data?.book;
 const login=telegram?'/reader/telegram':'/reader';
 const openEntity=(value:Row)=>{setEntity(value.id);setKind(value.kind);setBook('');setPage(1);setQuery('');window.scrollTo({top:0});};
 const back=()=>{if(book)setBook('');else if(entity){setEntity('');setPage(1);}else{setKind('');setPage(1);}setQuery('');};
 return <div className={s.shell}><header className={s.header}><img src={READER_LOGO} alt="Емблема бібліотеки"/><div><strong>Єдина бібліотека</strong><span>Художня та наукова література</span></div></header><main className={s.main} style={{paddingBottom:24}}><div className={s.actions}>{(book||kind||entity)&&<button className={s.secondary} onClick={back}>← Назад</button>}<a className={s.primary} href={login}>Увійти в кабінет</a></div>
 {book?<><Feedback state={detail}/>{record&&<><h1>{record.title}</h1><div className={s.bookHero}><Cover book={record}/><div><p>{record.author}</p><PublicationLine book={record} onEntity={openEntity}/><BookPublicMeta book={record}/><p>{record.type} · {record.total} прим.</p></div></div><div className={s.chips}>{record.entities.map((item:Row)=><button key={item.id} onClick={()=>openEntity(item)}>{item.name} · {item.count}</button>)}</div><p className={s.body}>{record.annotation}</p><a className={s.primary} href={login+'?tab=catalog&book='+encodeURIComponent(book)}>Увійти, щоб забронювати</a></>}</>:<><h1>{entity?list.raw?.entity?.name||'Каталог':kind?kinds.find(x=>x[0]===kind)?.[1]:'Каталог'}</h1>{!entity&&<label className={s.field}>Пошук<input value={query} onChange={e=>setQuery(e.target.value)} placeholder={kind?'Введи назву або ім’я':'Назва чи автор книги'}/></label>}{!kind&&<div className={s.chips}>{kinds.map(([id,label])=><button key={id} onClick={()=>{setKind(id);setPage(1);setQuery('');}}>{label}</button>)}</div>}{entity&&list.raw?.entity?.metadata&&<div className={s.panel}>{Object.entries(list.raw.entity.metadata).map(([key,value])=><p className={s.body} key={key}>{String(value)}</p>)}</div>}
 <Feedback state={list}/><p className={s.small}>Знайдено: {list.data?.total??'…'}</p><div className={s.stack}>{list.data?.items.map(row=>kind&&!entity?<button className={s.secondary} style={{justifyContent:'space-between'}} key={row.id} onClick={()=>openEntity(row)}><strong>{row.name}</strong><span>{row.count} книг ›</span></button>:<BookRow key={row.id} book={row} onBook={setBook} onEntity={openEntity}><PublicationLine book={row} onEntity={openEntity}/><BookPublicMeta book={row}/><span className={s.badge}>Доступно: {row.available}</span></BookRow>)}</div>{list.data&&!list.data.total&&<p className={s.empty}>За цим запитом нічого не знайдено.</p>}<InfinitePager data={list.data} loading={list.loading} error={list.error} onNext={setPage} onRetry={list.retry}/></>}
 </main></div>;
}
