import type { Metadata } from "next";

/* eslint-disable @next/next/no-html-link-for-pages -- Vinext Link navigation fails in production; full-page anchors are intentional. */

import { chatGPTSignOutPath, requireChatGPTUser } from "@/app/chatgpt-auth";
import { getLibrarianAccess } from "@/lib/librarian-access";
import TeacherManagementWorkspace from "./teacher-management-workspace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Керування вчителями",
  robots: { index: false, follow: false },
};

type PageProps = { searchParams?: Promise<Record<string, string | string[] | undefined>> };

export default async function LibrarianTeachersPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const initialTab = boundedTab(params?.tab);
  const returnTo = initialTab === "telegram" ? "/librarian/teachers?tab=telegram" : "/librarian/teachers";
  const user = await requireChatGPTUser(returnTo);
  const access = getLibrarianAccess(user);

  if (!access.allowed) {
    return (
      <main className="access-shell">
        <section className="access-card" aria-labelledby="teachers-access-title">
          <p className="eyebrow centered"><span aria-hidden="true" /> Захищений кабінет</p>
          <h1 id="teachers-access-title">Доступ до карток учителів не надано</h1>
          <p>Цей обліковий запис не входить до списку працівників бібліотеки.</p>
          <div className="access-actions">
            <a className="button button-primary" href="/">На головну</a>
          </div>
        </section>
      </main>
    );
  }

  return (
    <TeacherManagementWorkspace
      pendingScope={await managementPendingScope(user.userId)}
      displayName={user.displayName}
      role={access.role ?? "librarian"}
      writesEnabled={access.writesEnabled}
      signOutHref={chatGPTSignOutPath("/")}
      initialTab={initialTab}
    />
  );
}

function boundedTab(value: string | string[] | undefined): "overview" | "teachers" | "orders" | "visits" | "telegram" {
  return value === "teachers" || value === "orders" || value === "visits" || value === "telegram" ? value : "overview";
}

async function managementPendingScope(userId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userId));
  return Array.from(new Uint8Array(digest).slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
