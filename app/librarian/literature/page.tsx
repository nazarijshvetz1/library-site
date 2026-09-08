import {authorizeLibrarianApi} from "@/lib/librarian-api";
import LiteratureWorkspace from "./workspace";
export const dynamic="force-dynamic";
export const metadata={title:"Художня та наукова література · Кабінет бібліотекаря",robots:{index:false,follow:false}};
export default async function LiteraturePage(){const auth=await authorizeLibrarianApi();if(!auth.ok)return <main className="access-shell"><section className="access-card"><h1>Кабінет бібліотекаря</h1><p>Увійдіть до захищеного кабінету, щоб керувати літературою та читачами.</p><a href="/librarian">Увійти до кабінету</a></section></main>;return <LiteratureWorkspace writesEnabled={auth.value.access.writesEnabled} admin={auth.value.access.role==="admin"}/>;}
