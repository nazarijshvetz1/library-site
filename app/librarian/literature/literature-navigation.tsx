"use client";
import {createContext,useContext,useEffect,useRef,useState,type Dispatch,type ReactNode,type SetStateAction} from 'react';
import s from './literature.module.css';
type Snapshot=Record<string,any>;
type Layer={id:string;close:()=>void;dirty:()=>boolean;busy:()=>boolean;routed?:boolean;back?:()=>boolean};
type Entry={index:number;route:Snapshot;layers:string[];scroll:number;positions:Record<string,number>;expanded:Record<string,boolean>};
type Nav={bind:(get:()=>Snapshot,restore:(v:Snapshot)=>void)=>()=>void;push:(url:string)=>void;back:()=>void;complete:()=>void;hasBack:()=>boolean;layer:(layer:Layer)=>()=>void;update:()=>void;fallback:(fn:()=>void)=>()=>void};
const Navigation=createContext<Nav|null>(null);
const viewState=new Map<string,any>();
export function useRetainedState<T>(key:string,initial:T):[T,Dispatch<SetStateAction<T>>]{const [value,setValue]=useState<T>(()=>viewState.has(key)?viewState.get(key):initial);return [value,next=>setValue(old=>{const result=typeof next==='function'?(next as (v:T)=>T)(old):next;viewState.set(key,result);return result;})];}
export const ModalBackContext=createContext<((callback:()=>boolean)=>()=>void)|null>(null);
export function useModalStepBack(callback:()=>boolean){const register=useContext(ModalBackContext),current=useRef(callback);current.current=callback;useEffect(()=>register?.(()=>current.current()),[register]);}
const drafts=new Map<string,Map<string,any>>();
type Draft={key:string;values:Map<string,any>;dirty:boolean;parent:Draft|null};
const DraftContext=createContext<Draft|null>(null);
export function DraftScope({draftKey,children}:{draftKey:string;children:ReactNode}){const parent=useContext(DraftContext),ref=useRef<Draft|null>(null);if(!ref.current||ref.current.key!==draftKey){const values=drafts.get(draftKey)||new Map();drafts.set(draftKey,values);ref.current={key:draftKey,values,dirty:values.size>0,parent};if(ref.current.dirty){let owner=parent;while(owner){owner.dirty=true;owner=owner.parent;}}}return <DraftContext.Provider value={ref.current}>{children}</DraftContext.Provider>;}
export function useDraftState<T>(key:string,initial:T|(()=>T)):[T,Dispatch<SetStateAction<T>>]{const draft=useContext(DraftContext);const [value,setValue]=useState<T>(()=>draft?.values.has(key)?draft.values.get(key):typeof initial==='function'?(initial as ()=>T)():initial);return [value,next=>setValue(old=>{const result=typeof next==='function'?(next as (v:T)=>T)(old):next;if(draft&&!Object.is(old,result)){draft.values.set(key,result);let owner:Draft|null=draft;while(owner){owner.dirty=true;owner=owner.parent;}}return result;})];}
export function clearLiteratureDraft(key:string){drafts.delete(key);}
export function useDraftStatus(){return useContext(DraftContext);}
function scrollState(){const positions:Record<string,number>={},expanded:Record<string,boolean>={};document.querySelectorAll<HTMLElement>('[data-scroll-key]').forEach(e=>positions[e.dataset.scrollKey!]=e.scrollTop);document.querySelectorAll<HTMLDetailsElement>('details[data-context-key]').forEach(e=>expanded[e.dataset.contextKey!]=e.open);return {scroll:window.scrollY,positions,expanded};}
function restoreScroll(e:Entry){const apply=()=>{window.scrollTo({top:e.scroll,behavior:'instant'});document.querySelectorAll<HTMLElement>('[data-scroll-key]').forEach(n=>{if(n.dataset.scrollKey! in e.positions)n.scrollTop=e.positions[n.dataset.scrollKey!];});document.querySelectorAll<HTMLDetailsElement>('details[data-context-key]').forEach(n=>{if(n.dataset.contextKey! in e.expanded)n.open=e.expanded[n.dataset.contextKey!];});};requestAnimationFrame(apply);const observer=new MutationObserver(apply);observer.observe(document.body,{childList:true,subtree:true});setTimeout(()=>{observer.disconnect();apply();},900);}
export function LiteratureNavigation({children}:{children:ReactNode}){
 const state=useRef({get:()=>({} as Snapshot),restore:(_:Snapshot)=>{},fallback:()=>{},layers:[] as Layer[],entries:new Map<number,Entry>(),current:0,session:'',moving:false,allow:false,undo:false});
 const [confirm,setConfirm]=useState<null|(()=>void)>(null),confirmRef=useRef<HTMLDialogElement>(null);
 const nav=useRef<Nav|null>(null);
 if(!nav.current){
  const save=()=>{const n=state.current,e:Entry={index:n.current,route:n.get(),layers:n.layers.map(l=>l.id),...scrollState()};n.entries.set(n.current,e);window.history.replaceState({...window.history.state,literature:{session:n.session,index:n.current}},'');return e;};
  const push=(url:string)=>{const n=state.current;save();n.current++;window.history.pushState({...window.history.state,literature:{session:n.session,index:n.current}},'',url);save();};
  nav.current={bind(get,restore){state.current.get=get;state.current.restore=restore;return()=>{};},update(){if(state.current.session&&!state.current.moving)save();},push,back(){const n=state.current,top=n.layers.at(-1);if(top?.busy())return;if(top?.back?.())return;if(n.current>0)window.history.back();else if(top){top.close();if(top.routed)n.fallback();}else n.fallback();},complete(){const n=state.current;if(n.current>0){n.allow=true;history.back();}else n.layers.at(-1)?.close();},hasBack(){return state.current.current>0;},fallback(fn){state.current.fallback=fn;return()=>{};},layer(layer){const n=state.current;if(!layer.routed)push(window.location.href);n.layers.push(layer);save();return()=>{n.layers=n.layers.filter(x=>x.id!==layer.id);if(!n.moving)save();};}};
 }
 useEffect(()=>{const n=state.current;n.session=crypto.randomUUID();n.current=0;const oldRestoration=history.scrollRestoration;history.scrollRestoration='manual';nav.current!.update();
  const pop=(event:PopStateEvent)=>{const marker=event.state?.literature,target=marker?.session===n.session?n.entries.get(marker.index):undefined; if(n.undo){n.undo=false;n.moving=false;return;}if(!target)return;
   const closing=n.layers.filter(l=>!target.layers.includes(l.id)),delta=target.index-n.current;
   if(!n.allow&&delta<0&&closing.at(-1)?.back?.()){n.undo=true;n.moving=true;history.go(-delta);return;}
   if(!n.allow&&closing.some(l=>l.busy()||l.dirty())){n.undo=true;n.moving=true;history.go(-delta);if(!closing.some(l=>l.busy()))setConfirm(()=>()=>{n.allow=true;history.go(delta);});return;}
   n.allow=false;n.moving=true;n.current=target.index;for(const l of [...closing].reverse())l.close();n.layers=n.layers.filter(l=>target.layers.includes(l.id));n.restore(target.route);restoreScroll(target);setTimeout(()=>{n.moving=false;nav.current!.update();},1000);
  };
  const unload=(e:BeforeUnloadEvent)=>{if(n.layers.some(l=>l.dirty())){e.preventDefault();e.returnValue='';}};
  window.addEventListener('popstate',pop);window.addEventListener('beforeunload',unload);return()=>{window.removeEventListener('popstate',pop);window.removeEventListener('beforeunload',unload);history.scrollRestoration=oldRestoration;};
 },[]);
 useEffect(()=>{if(confirm)confirmRef.current?.showModal();},[confirm]);
 return <Navigation.Provider value={nav.current}>{children}{confirm&&<dialog ref={confirmRef} className={s.dialog} aria-label="Незбережені зміни" onCancel={e=>{e.preventDefault();setConfirm(null);}}><header><h2>Зберегти введені дані?</h2></header><div className={s.dialogBody}><p>Зміни ще не збережені в бібліотеці. Чернетка залишиться доступною в цій вкладці, коли знову відкриєте форму.</p><div className={s.actions}><button type="button" className={s.primary} onClick={()=>setConfirm(null)}>Продовжити редагування</button><button type="button" className={s.secondary} onClick={()=>{const go=confirm;setConfirm(null);go();}}>Назад зі збереженням чернетки</button></div></div></dialog>}</Navigation.Provider>;
}
export function useLiteratureNavigation(){const n=useContext(Navigation);if(!n)throw Error('Literature navigation missing');return n;}
export function useRouteState(snapshot:Snapshot,restore:(s:Snapshot)=>void){const nav=useLiteratureNavigation(),get=useRef(snapshot),put=useRef(restore);get.current=snapshot;put.current=restore;nav.bind(()=>get.current,s=>put.current(s));useEffect(()=>nav.update(),[snapshot]);return nav;}
export function useModalNavigation(onClose:()=>void,busy=false,extraDirty=false,back?:()=>boolean,routed=false){const nav=useLiteratureNavigation(),draft=useDraftStatus(),ref=useRef({onClose,busy,extraDirty,back,draft}),id=useRef('');ref.current={onClose,busy,extraDirty,back,draft};useEffect(()=>{id.current=crypto.randomUUID();return nav.layer({id:id.current,routed,close:()=>ref.current.onClose(),dirty:()=>!!ref.current.draft?.dirty||ref.current.extraDirty,busy:()=>ref.current.busy,back:()=>ref.current.back?.()||false});},[]);return nav.back;}
