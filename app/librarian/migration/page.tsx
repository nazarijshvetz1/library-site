import ActivationUpload from "./activation-upload";
import { authorizeLibrarianApi } from "@/lib/librarian-api";
import ImportUpload from "./upload";
import CoverUpload from "./cover-upload";

export const dynamic = "force-dynamic";
export const metadata = { title: "Перенесення Librarika · Єдина бібліотека", robots: { index: false, follow: false } };

export default async function MigrationPage() {
  const auth = await authorizeLibrarianApi();
  if (!auth.ok || auth.value.access.role !== "admin") return <main><h1>Службова сторінка</h1><p>Увійдіть як адміністратор бібліотеки.</p><a href="/librarian">До кабінету</a></main>;
  return <main style={{maxWidth:800,margin:"2rem auto",padding:"1.5rem",fontFamily:"Inter, Segoe UI, sans-serif",lineHeight:1.6}}>
    <a href="/librarian">← Кабінет бібліотекаря</a>
    <h1>Перенесення з Librarika</h1>
    <p>Завантаження перевіреного плану в приховану область тієї самої бази. Чинний фонд, видачі, доступ читачів і розсилки не змінюються.</p>
    <p>План містить приватні дані. Він надсилається лише цьому сайту. Перед початком має бути перевірена <a href="/librarian/recovery">резервна копія</a>.</p>
    {auth.value.access.writesEnabled ? <ImportUpload /> : <p>Запис тимчасово вимкнено.</p>}
    {auth.value.access.writesEnabled && <CoverUpload />}
    {auth.value.access.writesEnabled && <ActivationUpload />}
  </main>;
}
