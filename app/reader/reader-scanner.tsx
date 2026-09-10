"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {Camera,X} from "lucide-react";
import {normalizeIsbn} from "@/lib/isbn";
import styles from "./reader.module.css";

export default function ReaderScanner({onDetected,label="Сканувати книгу",format="all",className,disabled=false}:{onDetected:(code:string)=>void;label?:string;format?:"all"|"isbn";className?:string;disabled?:boolean}){
  const [open,setOpen]=useState(false),[starting,setStarting]=useState(false),[message,setMessage]=useState("");
  const video=useRef<HTMLVideoElement>(null),dialog=useRef<HTMLDialogElement>(null),stream=useRef<MediaStream|null>(null),controls=useRef<{stop():void}|null>(null),generation=useRef(0);
  const stop=useCallback(()=>{generation.current++;controls.current?.stop();controls.current=null;stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;if(video.current)video.current.srcObject=null;setOpen(false);setStarting(false);},[]);
  useEffect(()=>{if(open)dialog.current?.showModal();},[open]);
  useEffect(()=>{const hide=()=>{if(document.hidden)stop();};window.addEventListener("pagehide",stop);document.addEventListener("visibilitychange",hide);return()=>{window.removeEventListener("pagehide",stop);document.removeEventListener("visibilitychange",hide);generation.current++;controls.current?.stop();stream.current?.getTracks().forEach(track=>track.stop());};},[stop]);
  async function start(){
    if(starting||open)return;setMessage("");
    if(!navigator.mediaDevices?.getUserMedia){setMessage("Камера недоступна в цьому браузері. Введіть номер або ISBN вручну.");return;}
    setStarting(true);setOpen(true);const run=++generation.current;
    try{
      const camera=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"},width:{ideal:1280}},audio:false});
      if(run!==generation.current){camera.getTracks().forEach(track=>track.stop());return;}stream.current=camera;
      if(!video.current)await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
      if(run!==generation.current){camera.getTracks().forEach(track=>track.stop());return;}
      if(!video.current)throw new Error("camera_not_ready");video.current.srcObject=camera;await video.current.play();
      const {BrowserMultiFormatReader}=await import("@zxing/browser");if(run!==generation.current)return;
      const reader=new BrowserMultiFormatReader();
      const active=await reader.decodeFromStream(camera,video.current,(result,_error,current)=>{if(run!==generation.current){current.stop();return;}if(result){const raw=result.getText(),code=format==="isbn"?normalizeIsbn(raw):raw;if(!code){setMessage("Це не ISBN книги. Наведіть на штрихкод ISBN або введіть його вручну.");return;}current.stop();stop();setMessage("");onDetected(code);}});
      if(run!==generation.current){active.stop();return;}controls.current=active;setStarting(false);
    }catch(error){if(run===generation.current){stop();setMessage(error instanceof DOMException&&error.name==="NotAllowedError"?"Доступ до камери не надано. Ви можете дозволити його в налаштуваннях браузера або ввести код вручну.":"Не вдалося запустити камеру. Введіть код вручну.");}}
  }
  return <><button type="button" className={className||styles.secondary} onClick={start} disabled={disabled||starting||open}><Camera size={17}/>{starting?"Відкриваємо…":label}</button>{message&&<p className={styles.error} role="status">{message}</p>}
    {open&&<dialog ref={dialog} className={styles.dialog} onCancel={e=>{e.preventDefault();e.stopPropagation();stop();}} onClose={stop}><div className={styles.dialogInner}><div className={styles.dialogTop}><div><p className={styles.eyebrow}>Камера лише для сканування</p><h2>Наведіть на код книги</h2></div><button type="button" className={styles.iconButton} onClick={stop} aria-label="Закрити сканер"><X size={20}/></button></div><p className={styles.muted}>{format==="isbn"?"Наведіть камеру на штрихкод ISBN книги.":"ISBN відкриє видання; бібліотечний штрихкод або QR — конкретний примірник."} Зображення камери не надсилається на сервер.</p>{message&&<p role="status">{message}</p>}<div className={styles.scannerVideo}><video ref={video} autoPlay muted playsInline/></div><div className={styles.actions}><button type="button" className={styles.secondary} onClick={stop}>Ввести код вручну</button></div></div></dialog>}
  </>;
}
