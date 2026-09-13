"use client";
import {UserRound} from 'lucide-react';
import {useRetainedState} from '../librarian/literature/literature-navigation';
import {useState} from 'react';
import {Cover,Feedback,Modal,Pager,useCabinetData,type Row,type Page} from './cabinet-controls';
import {readerDate} from './reader-types';
import type {Act} from './cabinet-panels';
import s from './cabinet.module.css';

export function NotificationPanel({epoch,act,onClose,onNotice}:{epoch:number;act:Act;onClose:()=>void;onNotice:(notice:Row)=>void}){
 const [category,setCategory]=useRetainedState('notifications-category','all'),[page,setPage]=useRetainedState('notifications-page',1),remote=useCabinetData<Page&{unread:number}>('/api/reader/cabinet?view=messages&category='+category+'&page='+page,epoch);
 return <Modal title="Сповіщення" routed onClose={onClose}><div className={s.notificationFilters}>{[['all','Усі'],['library','Бібліотека'],['community','Спільнота'],['account','Обліковий запис']].map(([id,label])=><button className={s.choice} type="button" key={id} aria-pressed={id===category} onClick={()=>{setCategory(id);setPage(1);}}>{label}</button>)}</div><Feedback state={remote}/><div className={s.notificationList}>{remote.data?.items.map(notice=><article key={notice.id} className={s.notification} data-unread={!notice.read_at&&!notice.resolved}><button type="button" onClick={()=>{void act('read_message',{id:notice.id});onNotice(notice);}}>{notice.cover_url&&<Cover book={{title:notice.book_title||notice.title,cover_url:notice.cover_url}}/>}<span><strong>{notice.title}</strong><span>{notice.body}</span><small>{readerDate(notice.created_at)}{!notice.read_at&&!notice.resolved?' · Непрочитане':''}</small></span></button>{!notice.read_at&&<button type="button" className={s.textButton} onClick={()=>void act('read_message',{id:notice.id})}>Позначити прочитаним</button>}</article>)}</div>{remote.data&&!remote.data.items.length&&<p className={s.empty}>У цьому розділі сповіщень поки немає.</p>}<Pager data={remote.data} onPage={setPage}/></Modal>;
}
export function CommunityAuthor({author,onOpen}:{author:Row;onOpen:(id:string)=>void}){
 const [failed,setFailed]=useState(false),name=author.display_name||author.fullName||'Читач бібліотеки';
 const content=<><span className={s.communityAvatar}>{author.photo_url&&!failed?<img src={author.photo_url} alt="" onError={()=>setFailed(true)}/>:<UserRound size={24}/>}</span><strong>{name}</strong></>;
 return author.author_id?<button type="button" className={s.communityAuthor} onClick={()=>onOpen(author.author_id)}>{content}</button>:<div className={s.communityAuthor}>{content}</div>;
}
export function CommunityProfile({id,onClose}:{id:string;onClose:()=>void}){
 const remote=useCabinetData<Row>('/api/reader/community-profile?id='+encodeURIComponent(id)),p=remote.data;
 return <Modal title="Читацька сторінка" routed onClose={onClose}><Feedback state={remote}/>{p&&<><section className={s.greeting}>{p.photoUrl?<img src={p.photoUrl} alt={p.fullName}/>:<UserRound size={64}/>}<div><h2>{p.fullName}</h2><p>{p.kind==='student'?'Учень / учениця · '+(p.classLabel||'Клас не вказано'):p.kind==='teacher'?'Учитель / учителька':'Читач бібліотеки'}</p>{p.kind==='teacher'&&p.subjectPosition&&<p>{p.subjectPosition}</p>}</div></section>{p.kind==='student'&&p.about&&<section><h2>Про себе</h2><p className={s.body}>{p.about}</p></section>}</>}</Modal>;
}
