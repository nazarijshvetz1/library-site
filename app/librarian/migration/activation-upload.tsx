"use client";
import {useState} from "react";
import {sha256Text} from "@/lib/librarika-import-plan";
type Edition={id:string;title:string;version:number;material_id:string|null;copies:number;loaned:number;matches:string[]};
type State={runId:string;planSha256:string;editions:Edition[];total:number;activated:number};
export default function ActivationUpload(){
 const [state,setState]=useState<State|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(""),[confirmed,setConfirmed]=useState(false);
 async function read(runId:string,planSha256:string){const response=await fetch("/api/librarian/readers?view=activation&runId="+encodeURIComponent(runId)+"&planSha256="+planSha256,{cache:"no-store"}),body=await response.json();if(!response.ok||!body.success)throw Error(body.error||"Не вдалося перевірити активацію.");return body.result as State;}
 async function prepare(file:File|undefined){setState(null);setConfirmed(false);if(!file)return;setBusy(true);try{if(file.size>32*1024*1024)throw Error("Файл завеликий.");const text=await file.text(),plan=JSON.parse(text);if(plan.format!=="library-librarika-append"||plan.sourceCompleteness?.authorDetailsComplete!==true||plan.sourceCompleteness?.authorsPending?.length!==0)throw Error("Неповний план не можна вводити в облік.");setState(await read(plan.runId,await sha256Text(text)));setMessage("План звірено із сервером. Активація переносить залишки й відкриті видачі, але не вмикає доступ або сповіщення читачів.");}catch(e){setMessage((e as Error).message);}finally{setBusy(false);}}
 async function activate(){if(!state||busy||!confirmed)return;setBusy(true);try{
  const current=await read(state.runId,state.planSha256);let done=current.activated;
  for(const edition of current.editions){if(edition.material_id)continue;if(edition.matches.length>1)throw Error("Для видання "+edition.title+" знайдено кілька ISBN-відповідників. Потрібна окрема звірка.");
   const digest=await sha256Text(state.runId+":activate:"+edition.id),requestId=digest.slice(0,8)+"-"+digest.slice(8,12)+"-4"+digest.slice(13,16)+"-a"+digest.slice(17,20)+"-"+digest.slice(20,32);
   setMessage("Вводимо в облік: "+(done+1)+" / "+current.total+". "+edition.title);
   const response=await fetch("/api/librarian/readers",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"activate",input:{requestId,editionId:edition.id,expectedVersion:edition.version,existingMaterialId:edition.matches[0]||null,confirmation:"ACTIVATE_SOURCE_EDITION",runId:state.runId,planSha256:state.planSha256}})}),body=await response.json();
   if(!response.ok||!body.success)throw Error(body.error||"Видання не підтверджено.");done++;setState({...current,activated:done});
  }
  const verified=await read(state.runId,state.planSha256);setState(verified);setMessage("Введено в облік "+verified.activated+" / "+verified.total+" видань. Потрібна завершальна звірка кількостей і перевірка сайту.");
 }catch(e){setMessage((e as Error).message+" Повторіть цей самий план: уже введені видання не дублюються.");}finally{setBusy(false);}}
 return <section><h2>Введення перевіреного фонду в роботу</h2><p>Після фінальної звірки Librarika та завантаження обкладинок. Залишки відображають джерельний реєстр, а не проведену фізичну інвентаризацію.</p><input aria-label="План активації фонду" type="file" accept=".json" disabled={busy} onChange={e=>void prepare(e.target.files?.[0])}/>{state&&<><p>Видання: {state.total}. Уже введено: {state.activated}. Примірники: {state.editions.reduce((n,e)=>n+e.copies,0)}. Відкриті видачі: {state.editions.reduce((n,e)=>n+e.loaned,0)}.</p><label><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/>Фінальні зміни джерела звірені; підтверджую введення цього фонду й видач у роботу.</label><p><button disabled={busy||!confirmed||state.activated===state.total} onClick={()=>void activate()}>Ввести / продовжити введення в облік</button></p></>}<p role="status">{message}</p></section>;
}
