"use client";
import {useEffect,useState} from "react";
import {LIBRARIKA_EXPORTS,parseLibrarikaCsv} from "@/lib/librarika-csv";
import {canonicalLibrarikaMemberDataset,projectLibrarikaMemberRows} from "@/lib/librarika-member-format";

type ChangeRow={source_member_id:string;member_no:string;decision:"add"|"update"|"conflict";conflict_reason:string|null;candidate_reader_id:string|null;old_full_name:string|null;new_full_name:string;old_group:string|null;new_group:string;old_status:string|null;new_status:string};
type Preview={total:number;added:number;matched:number;changed:number;unchanged:number;conflicts:number;missingFromExport:number;nameChanges:number;groupChanges:number;sourceStatusChanges:number;changeRows:ChangeRow[]};
type Run={runId:string;sourceSha256:string;preview:Preview};

export default function MemberSyncPanel(){
  const [file,setFile]=useState<File|null>(null),[run,setRun]=useState<Run|null>(null),[busy,setBusy]=useState(false),[progress,setProgress]=useState(""),[error,setError]=useState(""),[confirmed,setConfirmed]=useState(false),[last,setLast]=useState<Record<string,unknown>|null>(null),[worker,setWorker]=useState<Record<string,string>|null>(null);
  useEffect(()=>{void fetch("/api/librarian/librarika-sync",{cache:"no-store"}).then(r=>r.json()).then(data=>{if(data.success){setLast(data.result.latest||null);setWorker(data.result.worker||null);}}).catch(()=>{});},[]);
  async function send(action:string,input:Record<string,unknown>){const response=await fetch("/api/librarian/librarika-sync",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,input})}),data=await response.json();if(!response.ok||!data.success)throw new Error(data.error||"Синхронізацію не підтверджено.");return data.result;}
  async function inspect(){
    if(!file||busy)return;setBusy(true);setError("");setRun(null);setConfirmed(false);
    try{
      if(file.size>5*1024*1024)throw new Error("Файл читачів перевищує 5 МБ.");
      const text=await file.text();if(text.includes("\uFFFD"))throw new Error("CSV прочитано з пошкодженим кодуванням. Експортуйте Members у UTF-8 і повторіть перевірку.");
      const parsed=parseLibrarikaCsv(text),required=LIBRARIKA_EXPORTS.members.required;
      if(!parsed.length||required.some(field=>!Object.hasOwn(parsed[0],field)))throw new Error("Оберіть незмінений CSV-експорт Members із Librarika.");
      const rows=projectLibrarikaMemberRows(parsed);
      if(rows.length>5000)throw new Error("У файлі понад 5 000 читачів.");
      const {sourceSha256}=await canonicalLibrarikaMemberDataset(rows),requestId=crypto.randomUUID();
      setProgress("Створюємо безпечний сеанс…");
      const started=await send("start",{requestId,sourceSha256,expectedRows:rows.length});
      if(started.state==="applied"){setProgress("Цей самий експорт уже синхронізовано. Повторних записів не створено.");setLast({state:"applied",preview:started.preview});return;}
      const chunks=[];for(let index=0;index<rows.length;index+=40)chunks.push(rows.slice(index,index+40));
      if(started.state==="uploading")for(let index=0;index<chunks.length;index+=1){setProgress(`Перевіряємо частину ${index+1} з ${chunks.length}…`);await send("stage",{runId:started.runId,sourceSha256,partIndex:index,rows:chunks[index]});}
      setProgress("Порівнюємо з чинною базою…");
      const result=await send("preview",{runId:started.runId,sourceSha256});
      setRun({runId:started.runId,sourceSha256,preview:result.preview});setProgress("Попередній перегляд готовий.");
    }catch(value){setError(value instanceof Error?value.message:"Не вдалося прочитати файл.");setProgress("");}
    finally{setBusy(false);}
  }
  async function apply(){
    if(!run||!confirmed||busy)return;setBusy(true);setError("");setProgress("Застосовуємо лише безпечні додавання й оновлення…");
    try{const result=await send("apply",{runId:run.runId,sourceSha256:run.sourceSha256,confirmation:"APPLY_MEMBERS_WITHOUT_DELETIONS",fullBaselineConfirmation:"THIS_IS_FULL_MEMBERS_EXPORT"});setProgress(`Готово: додано ${result.added}, зіставлено ${result.matched}, конфліктів ${result.conflicts}. Жодного читача не видалено.`);setLast({state:"applied",applied_at:new Date().toISOString(),preview:run.preview});}
    catch(value){setError(value instanceof Error?value.message:"Не вдалося застосувати зміни.");}
    finally{setBusy(false);}
  }
  const preview=run?.preview;
  return <section style={{background:"#fff",border:"1px solid #d8dfd5",borderRadius:18,padding:"1.25rem",marginTop:"1.25rem"}}>
    <h2>Читачі та нові учні</h2>
    <p>У Librarika відкрийте <strong>Reports → Members</strong> і завантажте незмінений CSV. Система зіставить записи за точним читацьким номером та ID Librarika.</p>
    <label style={{display:"grid",gap:8,maxWidth:560}}><strong>CSV-експорт Members</strong><input type="file" accept=".csv,text/csv" disabled={busy} onChange={event=>{setFile(event.target.files?.[0]||null);setRun(null);setConfirmed(false);setError("");setProgress("");}}/></label>
    <p><button type="button" disabled={!file||busy} onClick={()=>void inspect()} style={{padding:".8rem 1.1rem",borderRadius:12,border:0,background:"#173522",color:"#fff",fontWeight:700}}>Перевірити зміни</button></p>
    {progress&&<p role="status" aria-live="polite">{progress}</p>}{error&&<p role="alert" style={{color:"#9a2f2f"}}>{error}</p>}
    {preview&&<div style={{marginTop:"1rem"}}><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:10}}>{[["У файлі",preview.total],["Нові",preview.added],["Буде оновлено",preview.changed],["Без змін",preview.unchanged],["Конфлікти",preview.conflicts]].map(([label,value])=><div key={String(label)} style={{padding:12,border:"1px solid #d8dfd5",borderRadius:12}}><strong style={{fontSize:24,display:"block"}}>{value}</strong>{label}</div>)}</div>
      <p>Локальних записів, яких немає у цьому експорті: <strong>{preview.missingFromExport}</strong>. Вони залишаться без змін.</p>
      <p>Змін імен: <strong>{preview.nameChanges}</strong>; груп/класів: <strong>{preview.groupChanges}</strong>; змін джерельного статусу Librarika: <strong>{preview.sourceStatusChanges}</strong>. Статус входу на наш сайт автоматично не вимикається.</p>
      {preview.changeRows.length>0&&<details open><summary>Поіменна звірка всіх додавань, змін і конфліктів ({preview.changeRows.length})</summary><div style={{maxHeight:420,overflow:"auto",marginTop:10}}><ol>{preview.changeRows.map(row=><li key={`${row.decision}:${row.source_member_id}`} style={{marginBottom:10}}><strong>ID Librarika {row.source_member_id} · № {row.member_no}</strong><br/>{row.decision==="add"?<>Додати: {row.new_full_name} · група {row.new_group||"не зазначена"} · статус {row.new_status}</>:row.decision==="conflict"?<><strong>Конфлікт:</strong> {row.new_full_name} · жодних змін не буде.<br/>Причина: {row.conflict_reason||"Потрібна ручна звірка."}<br/>Безпечна дія: звірте ID, номер і ПІБ у двох системах; виправляйте лише підтверджену помилку, а потім перевірте той самий CSV ще раз.</>:<>Ім’я: {row.old_full_name||"—"} → {row.new_full_name}; група: {row.old_group||"—"} → {row.new_group||"—"}; статус джерела: {row.old_status||"—"} → {row.new_status}</>}</li>)}</ol></div></details>}
      <label style={{display:"flex",gap:10,alignItems:"flex-start",margin:"1rem 0"}}><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/><span>Підтверджую: це повний експорт Reports → Members, а не вибірка. Я переглянув / переглянула поіменний список усіх додавань і змін. Додати нових і оновити безпечні збіги, нічого не видаляючи; конфлікти пропустити.</span></label>
      <button type="button" disabled={!confirmed||busy} onClick={()=>void apply()} style={{padding:".8rem 1.1rem",borderRadius:12,border:0,background:"#173522",color:"#fff",fontWeight:700}}>Синхронізувати читачів</button>
    </div>}
    {last&&<p style={{marginTop:"1rem",color:"#526359"}}>Останній зафіксований запуск: {String(last.state||"—")}{last.applied_at?` · ${new Date(String(last.applied_at)).toLocaleString("uk-UA")}`:""}.</p>}
    <p style={{marginTop:"1rem",color:"#526359"}}>Фактичний scheduled trigger: {worker?.observed_at?`останнє виконання ${new Date(worker.observed_at).toLocaleString("uk-UA")} (подія ${new Date(worker.scheduled_at).toLocaleString("uk-UA")})`:"ще не зафіксований після цього оновлення"}.</p>
  </section>;
}
