"use client";
import { useState } from "react";
import { sha256Text } from "@/lib/librarika-import-plan";
import { splitLibrarikaImportTables } from "@/lib/librarika-import-store";

type Plan = {sourceCompleteness:{authorDetailsComplete:boolean;authorsVerified:number;authorsPending:string[]};format:string;version:number;runId:string;sourceSha256:string;recoverySha256:string;capturedAt:string;tables:Record<string,Record<string,string|number|null>[]>;counts:Record<string,number>};

export default function ImportUpload() {
  const [file,setFile]=useState<File|null>(null);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(""),[progress,setProgress]=useState({done:0,total:0});
  async function send(body: unknown) {
    const response=await fetch("/api/librarian/librarika-import",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const result=await response.json();
    if(!response.ok||!result.success)throw new Error(result.error||"Запис не підтверджено.");
    return result.result;
  }
  async function upload() {
    if(!file||busy)return;
    setBusy(true);setMessage("Перевіряємо файл і контрольні суми…");
    try {
      if(file.size>32*1024*1024)throw new Error("План перевищує 32 МБ.");
      const content=await file.text(),plan=JSON.parse(content) as Plan;
      if(plan.format!=="library-librarika-append"||plan.version!==1||!plan.tables||!plan.counts)throw new Error("Потрібен перевірений план перенесення версії 1.");
      if(plan.sourceCompleteness?.authorDetailsComplete!==true||!Number.isInteger(plan.sourceCompleteness.authorsVerified)||plan.sourceCompleteness.authorsVerified<1||!Array.isArray(plan.sourceCompleteness.authorsPending)||plan.sourceCompleteness.authorsPending.length)throw new Error("Це неповний пробний план. Спочатку потрібно завершити перевірку джерела.");
      const chunks=await splitLibrarikaImportTables(plan.tables);
      const input={sourceCompleteness:plan.sourceCompleteness,runId:plan.runId,sourceSha256:plan.sourceSha256,recoverySha256:plan.recoverySha256,capturedAt:plan.capturedAt,planSha256:await sha256Text(content),counts:plan.counts,parts:chunks.map(chunk=>chunk.part)};
      await send({action:"start",input});
      const response=await fetch("/api/librarian/librarika-import?runId="+encodeURIComponent(plan.runId),{cache:"no-store"});
      const state=await response.json();
      if(!response.ok||!state.success)throw new Error("Не вдалося перевірити попередній поступ.");
      const completed=new Set<number>(state.result?.completedParts||[]);
      setProgress({done:completed.size,total:chunks.length});
      for(const chunk of chunks){
        if(completed.has(chunk.part.index))continue;
        setMessage(`Переносимо частину ${chunk.part.index+1} з ${chunks.length}… Не закривайте сторінку.`);
        await send({action:"part",input:{runId:plan.runId,index:chunk.part.index,table:chunk.part.table,rows:chunk.rows}});
        completed.add(chunk.part.index);setProgress({done:completed.size,total:chunks.length});
      }
      const verified=await send({action:"verify",runId:plan.runId});
      setMessage(verified.state==="verified"?"Усі частини перенесено й перевірено. Дані залишаються прихованими до окремого введення в роботу.":"Перенесення вже перевірене.");
    }catch(error){setMessage((error instanceof Error?error.message:"Не вдалося завершити перенесення.")+" Для продовження оберіть цей самий файл і натисніть кнопку ще раз.");}
    finally{setBusy(false);}
  }
  return <section>
    <label htmlFor="migration-plan">Перевірений файл плану (.json)</label><br />
    <input id="migration-plan" type="file" accept=".json,application/json" disabled={busy} onChange={event=>setFile(event.target.files?.[0]||null)} />
    <p><button type="button" disabled={!file||busy} onClick={upload} style={{padding:".8rem 1.2rem",borderRadius:12,background:"#173522",color:"white",border:0}}>Завантажити / продовжити перенесення</button></p>
    {progress.total>0&&<><progress value={progress.done} max={progress.total} style={{width:"100%"}} /><p>{progress.done} / {progress.total} частин</p></>}
    <p role="status" aria-live="polite">{message}</p>
  </section>;
}
