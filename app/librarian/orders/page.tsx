import type { Metadata } from "next";

import { chatGPTSignOutPath, requireChatGPTUser } from "@/app/chatgpt-auth";
import { getLibrarianAccess } from "@/lib/librarian-access";
import LibrarianAccessDenied from "../librarian-access-denied";
import TeacherManagementWorkspace from "../teachers/teacher-management-workspace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Замовлення вчителів",
  robots: { index: false, follow: false },
};

export default async function LibrarianOrdersPage() {
  const user = await requireChatGPTUser("/librarian/orders");
  const access = getLibrarianAccess(user);

  if (!access.allowed) {
    return <LibrarianAccessDenied title="Доступ до замовлень не надано" signOutHref={chatGPTSignOutPath("/")} />;
  }

  return (
    <TeacherManagementWorkspace
      pendingScope={await ordersPendingScope(user.userId)}
      displayName={user.displayName}
      role={access.role ?? "librarian"}
      writesEnabled={access.writesEnabled}
      signOutHref={chatGPTSignOutPath("/")}
      initialTab="orders"
    />
  );
}

async function ordersPendingScope(userId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userId));
  return Array.from(new Uint8Array(digest).slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
