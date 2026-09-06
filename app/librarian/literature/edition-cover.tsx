"use client";
import {useEffect,useRef,useState} from "react";
import {normalizeCoverPhotoForUpload} from "@/lib/cover-client";
import s from "@/app/reader/reader.module.css";
export default function EditionCover({materialId,initialVersion,onBusy,disabled}:{materialId:string;initialVersion:number;onBusy:(value:boolean)=>void;disabled:boolean}){
 const [photo,setPhoto]=useState<File|null>(null),[preview,setPreview]=useState(""),[version,setVersion]=useState(initialVersion),[message,setMessage]=useState(""),[busy,setBusy]=useState(false);
 const pending=useRef<{key:string;requestId:string;version:number}|null>(null);
 useEffect(()=>()=>{if(preview)URL.revokeObjectURL(preview);},[preview]);
 async function save(){if(!photo||busy||disabled)return;setBusy(true);onBusy(true);setMessage("");
  try{
   if(!pending.current){const normalized=await normalizeCoverPhotoForUpload(photo),form=new FormData();form.set("photo",normalized,normalized.name);const response=await fetch("/api/librarian/cover-photo",{method:"POST",body:form}),data=await response.json();if(!response.ok||!data.success)throw Error(data.error||"Не вдалося завантажити фото.");pending.current={key:data.photo.key,requestId:crypto.randomUUID(),version};}
   const active=pending.current,response=await fetch("/api/librarian/materials/"+encodeURIComponent(materialId)+"/cover",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({requestId:active.requestId,coverPhotoKey:active.key,expectedVersion:active.version})}),data=await response.json();
   if(!response.ok||!data.success){if(response.status>=400&&response.status<500)pending.current=null;throw Error(data.error||"Не вдалося підтвердити обкладинку.");}
   pending.current=null;setVersion(data.result.coverVersion);setPhoto(null);setPreview("");setMessage("Обкладинку збережено. Опис книги не змінено.");
  }catch(e){setMessage((e as Error).message+" Повторіть збереження з тим самим фото. Якщо картку змінили в іншій вкладці — відкрийте її знову.");}
  finally{setBusy(false);onBusy(false);}
 }
 return <section className={s.notice}><h3>Обкладинка</h3><p className={s.muted}>Окрема дія: можна сфотографувати обкладинку або обрати зображення. Зміни опису зберігаються кнопкою картки книги.</p><img src={preview||"/api/librarian/materials/"+encodeURIComponent(materialId)+"/cover?v="+version} alt="Поточна або обрана обкладинка" style={{width:110,maxHeight:170,objectFit:"contain"}} onError={e=>{e.currentTarget.style.visibility="hidden";}} onLoad={e=>{e.currentTarget.style.visibility="visible";}}/><label className={s.field}>Нове фото<input type="file" accept="image/*" disabled={busy||disabled||!!pending.current} onChange={e=>{const file=e.target.files?.[0]||null;setPhoto(file);setPreview(file?URL.createObjectURL(file):"");}}/></label><button type="button" className={s.secondary} disabled={busy||disabled||!photo} onClick={()=>void save()}>Зберегти обкладинку</button>{message&&<p role="status">{message}</p>}</section>;
}
