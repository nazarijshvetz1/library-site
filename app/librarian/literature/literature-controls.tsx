"use client";
import {useEffect,useId,useRef,useState} from 'react';
import {X,Plus} from 'lucide-react';
import s from './literature.module.css';
export type Choice={id:string;label:string;detail?:string};
export function SuggestInput({label,value,onChange,options,onPick,name,placeholder,required=false,disabled=false,validationMessage=''}:{label:string;value:string;onChange:(value:string)=>void;options:Choice[];onPick?:(choice:Choice)=>void;name?:string;placeholder?:string;required?:boolean;disabled?:boolean;validationMessage?:string}){
 const field=useRef<HTMLInputElement>(null),list=useRef<HTMLDivElement>(null);
 const id=useId(),[open,setOpen]=useState(false),[active,setActive]=useState(-1);
 const tokens=value.trim().toLocaleLowerCase('uk-UA').split(/\s+/).filter(Boolean);
 const matches=options.filter(x=>tokens.every(t=>(x.label+' '+(x.detail||'')).toLocaleLowerCase('uk-UA').includes(t))).slice(0,12);
 const visible=open&&matches.length>0;
 useEffect(()=>{field.current?.setCustomValidity(validationMessage);},[validationMessage]);
 useEffect(()=>{if(visible&&active>=0)list.current?.querySelectorAll<HTMLElement>('[role="option"]')[active]?.scrollIntoView({block:'nearest'});},[active,visible]);
 const pick=(c:Choice)=>{onChange(c.label);onPick?.(c);setOpen(false);setActive(-1);};
 return <div className={s.suggest} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget)){setOpen(false);setActive(-1);}}}>
  <label htmlFor={id}>{label}</label><div className={s.suggestInput}><input ref={field} id={id} name={name} value={value} onChange={e=>{onChange(e.target.value);setOpen(true);setActive(-1);}} onFocus={()=>setOpen(true)} placeholder={placeholder||'Почніть вводити…'} required={required} disabled={disabled} autoComplete="off" role="combobox" aria-autocomplete="list" aria-expanded={visible} aria-controls={id+'-list'} aria-activedescendant={visible&&active>=0?id+'-'+active:undefined} onKeyDown={e=>{
   if(e.key==='Escape'){if(open){e.preventDefault();e.stopPropagation();}setOpen(false);setActive(-1);}
   if(e.key==='Tab')setOpen(false);
   if((e.key==='ArrowDown'||e.key==='ArrowUp')&&matches.length){e.preventDefault();setOpen(true);setActive(i=>e.key==='ArrowDown'?(i+1)%matches.length:i<=0?matches.length-1:i-1);}
   if(e.key==='Enter'&&open){e.preventDefault();e.stopPropagation();if(visible&&active>=0)pick(matches[active]);}
  }}/>{value&&<button type="button" disabled={disabled} aria-label={`Очистити: ${label}`} onClick={()=>{onChange('');setOpen(false);}}><X size={15}/></button>}</div>
  {visible&&<div ref={list} id={id+'-list'} role="listbox" aria-label={label} className={s.suggestions}>{matches.map((c,i)=><button type="button" role="option" aria-selected={i===active} id={id+'-'+i} key={c.id} onPointerDown={e=>e.preventDefault()} onClick={()=>pick(c)}><span>{c.label}</span>{c.detail&&<small>{c.detail}</small>}</button>)}</div>}
 </div>;
}
export function EntityPicker({kind,label,initial,options}:{kind:string;label:string;initial:Choice[];options:Choice[]}){
 const [selected,setSelected]=useState(initial),[query,setQuery]=useState('');
 const add=(choice:Choice)=>{setSelected(list=>list.some(x=>x.id?x.id===choice.id:x.label===choice.label)?list:[...list,choice]);setQuery('');};
 const exact=options.filter(x=>x.label.trim().toLocaleLowerCase('uk-UA')===query.trim().toLocaleLowerCase('uk-UA'));
 return <div className={s.entityPicker}><input type="hidden" name={'entities:'+kind} value={JSON.stringify(selected)}/>
  <SuggestInput label={label} value={query} onChange={setQuery} options={options.filter(o=>!selected.some(x=>x.id===o.id))} onPick={add} validationMessage={query.trim()?'Оберіть підказку або натисніть «Додати», щоб підтвердити назву.':''} placeholder={selected.length?'Додати ще…':'Назва або пошук у довіднику…'}/>
  {selected.length>0&&<div className={s.chips}>{selected.map((c,i)=><span key={c.id||c.label}>{c.label}<button type="button" aria-label={`Прибрати: ${c.label}`} onClick={()=>setSelected(list=>list.filter((_,n)=>n!==i))}><X size={14}/></button></span>)}</div>}
  {query.trim()&&<button type="button" className={s.addValue} disabled={exact.length>1} onClick={()=>add(exact[0]||{id:'',label:query.trim()})}><Plus size={14}/>Додати «{query.trim()}»</button>}
 </div>;
}
