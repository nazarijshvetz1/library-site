import type { Metadata } from "next";

/* eslint-disable @next/next/no-html-link-for-pages -- Vinext full-page navigation is intentional. */

import { chatGPTSignOutPath, requireChatGPTUser } from "@/app/chatgpt-auth";
import { getLibrarianAccess } from "@/lib/librarian-access";
import ExcelExportWorkspace from "./excel-export-workspace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Експорт в Excel",
  robots: { index: false, follow: false },
};

export default async function LibraryExportPage() {
  const user = await requireChatGPTUser("/librarian/export");
  const access = getLibrarianAccess(user);
  if (!access.allowed) {
    return (
      <main className="access-shell">
        <section className="access-card" aria-labelledby="excel-export-access-title">
          <p className="eyebrow centered"><span aria-hidden="true" /> Захищений кабінет</p>
          <h1 id="excel-export-access-title">Доступ до експорту не надано</h1>
          <p>Цей обліковий запис не входить до списку працівників бібліотеки.</p>
          <div className="access-actions"><a className="button button-primary" href="/">На головну</a></div>
        </section>
      </main>
    );
  }

  return (
    <ExcelExportWorkspace
      displayName={user.displayName}
      role={access.role ?? "librarian"}
      signOutHref={chatGPTSignOutPath("/")}
    />
  );
}
