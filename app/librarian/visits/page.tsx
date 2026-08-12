import type { Metadata } from "next";
import Link from "next/link";

import { chatGPTSignOutPath, requireChatGPTUser } from "@/app/chatgpt-auth";
import { getLibrarianAccess } from "@/lib/librarian-access";
import LibrarianVisitWorkspace from "./visit-admin-workspace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Розклад відвідувань",
  robots: { index: false, follow: false },
};

export default async function LibrarianVisitsPage() {
  const user = await requireChatGPTUser("/librarian/visits");
  const access = getLibrarianAccess(user);

  if (!access.allowed) {
    return (
      <main className="access-shell">
        <section className="access-card">
          <p className="eyebrow centered"><span aria-hidden="true" /> Захищений кабінет</p>
          <h1>Доступ до розкладу не надано</h1>
          <p>Цей обліковий запис не входить до списку працівників бібліотеки.</p>
          <div className="access-actions"><Link className="button button-primary" href="/">На головну</Link></div>
        </section>
      </main>
    );
  }

  return (
    <LibrarianVisitWorkspace
      pendingScope={await visitPendingScope(user.userId)}
      displayName={user.displayName}
      writesEnabled={access.writesEnabled}
      signOutHref={chatGPTSignOutPath("/")}
    />
  );
}

async function visitPendingScope(userId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userId));
  return Array.from(new Uint8Array(digest).slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
