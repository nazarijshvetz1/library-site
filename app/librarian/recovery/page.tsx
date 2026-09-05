import { chatGPTSignOutPath, requireChatGPTUser } from "@/app/chatgpt-auth";
import { getLibrarianAccess } from "@/lib/librarian-access";
import LibrarianAccessDenied from "../librarian-access-denied";
import RecoveryDownload from "./recovery-download";

export const dynamic = "force-dynamic";
export const metadata = { title: "Резервна копія · Єдина бібліотека", robots: { index: false, follow: false } };

export default async function RecoveryPage() {
  const user = await requireChatGPTUser("/librarian/recovery");
  if (!getLibrarianAccess(user).allowed) return <LibrarianAccessDenied title="Доступ не надано" signOutHref={chatGPTSignOutPath("/")} />;
  return <main style={{maxWidth:720, margin:"3rem auto", padding:"1.5rem", fontFamily:"Inter, Segoe UI, sans-serif"}}>
    <a href="/librarian">← Кабінет бібліотекаря</a>
    <h1>Резервна копія бази</h1>
    <p>Службовий інструмент адміністратора. Не змінює каталог, видачі або облікові записи.</p>
    <p>Файл містить приватні відомості. Зберігайте його в захищеному місці; не публікуйте й не надсилайте читачам.</p>
    <RecoveryDownload />
    <p>Це логічний знімок D1. Файли обкладинок і фото в R2 та налаштування середовища потребують окремого збереження.</p>
  </main>;
}
