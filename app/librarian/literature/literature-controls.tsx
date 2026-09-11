"use client";
import {useEffect,useId,useRef,useState} from 'react';
import {X,Plus} from 'lucide-react';
import s from './literature.module.css';
export type Choice={id:string;label:string;detail?:string};
export function SuggestInput({label,value,onChange,options,onPick,name,placeholder,required=false,disabled=false,validationMessage=''}:{label:string;value:string;onChange:(value:string)=>void;options:Choice[];onPick?:(choice:Choice)=>void;name?:string;placeholder?:string;required?:boolean;disabled?:boolean;validationMessage?:string}){
 const field=useRef<HTMLInputElement>(null),list=useRef<HTMLDivElement>(null);
 const id=useId(),[open,setOpen]=useState(false),[active,setActive]=useState(-1),[position,setPosition]=useState({top:0,left:0,width:0,maxHeight:196});
 const tokens=value.trim().toLocaleLowerCase('uk-UA').split(/\s+/).filter(Boolean);
 const matches=options.filter(x=>tokens.every(t=>(x.label+' '+(x.detail||'')).toLocaleLowerCase('uk-UA').includes(t))).slice(0,12);
 const visible=open&&tokens.length>0&&matches.length>0;
 useEffect(()=>{field.current?.setCustomValidity(validationMessage);},[validationMessage]);
 useEffect(()=>{if(visible&&active>=0)list.current?.querySelectorAll<HTMLElement>('[role="option"]')[active]?.scrollIntoView({block:'nearest'});},[active,visible]);
 useEffect(()=>{if(!visible)return;const place=()=>{const input=field.current;if(!input)return;const r=input.getBoundingClientRect(),body=input.closest('dialog')?.getBoundingClientRect(),vp=window.visualViewport,top=Math.max(vp?.offsetTop||0,body?.top||0)+8,bottom=Math.min((vp?.offsetTop||0)+(vp?.height||window.innerHeight),body?.bottom||window.innerHeight)-8,below=bottom-r.bottom,above=r.top-top,flip=below<150&&above>below,maxHeight=Math.max(44,Math.min(196,flip?above-4:below-4));setPosition({top:flip?r.top-maxHeight-4:r.bottom+4,left:r.left,width:r.width,maxHeight});};place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true);window.visualViewport?.addEventListener('resize',place);return()=>{window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);window.visualViewport?.removeEventListener('resize',place);};},[visible,value]);
 const pick=(c:Choice)=>{onChange(c.label);onPick?.(c);setOpen(false);setActive(-1);};
 return <div className={s.suggest} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget)){setOpen(false);setActive(-1);}}}>
  <label htmlFor={id}>{label}</label><div className={s.suggestInput}><input ref={field} id={id} name={name} value={value} onChange={e=>{onChange(e.target.value);setOpen(true);setActive(-1);}} onFocus={()=>setOpen(false)} placeholder={placeholder||'Почніть вводити…'} required={required} disabled={disabled} autoComplete="off" role="combobox" aria-autocomplete="list" aria-expanded={visible} aria-controls={id+'-list'} aria-activedescendant={visible&&active>=0?id+'-'+active:undefined} onKeyDown={e=>{
   if(e.key==='Escape'){if(open){e.preventDefault();e.stopPropagation();}setOpen(false);setActive(-1);}
   if(e.key==='Tab')setOpen(false);
   if((e.key==='ArrowDown'||e.key==='ArrowUp')&&tokens.length&&matches.length){e.preventDefault();setOpen(true);setActive(i=>e.key==='ArrowDown'?(i+1)%matches.length:i<=0?matches.length-1:i-1);}
   if(e.key==='Enter'&&open){e.preventDefault();e.stopPropagation();if(visible&&active>=0)pick(matches[active]);}
  }}/>{value&&<button type="button" disabled={disabled} aria-label={`Очистити: ${label}`} onClick={()=>{onChange('');setOpen(false);}}><X size={15}/></button>}</div>
  {visible&&<div ref={list} id={id+'-list'} role="listbox" aria-label={label} className={s.suggestions} style={position}>{matches.map((c,i)=><button type="button" role="option" aria-selected={i===active} id={id+'-'+i} key={c.id} onPointerDown={e=>e.preventDefault()} onClick={()=>pick(c)}><span>{c.label}</span>{c.detail&&<small>{c.detail}</small>}</button>)}</div>}
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
