import type { Metadata } from "next";

import { chatGPTSignOutPath, requireChatGPTUser } from "@/app/chatgpt-auth";
import { getLibrarianAccess } from "@/lib/librarian-access";
import LibrarianAccessDenied from "../librarian-access-denied";
import TextbookManagementWorkspace from "./textbook-management-workspace";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Каталог е-підручників", robots: { index: false, follow: false } };

export default async function LibrarianTextbooksPage() {
  const user = await requireChatGPTUser("/librarian/textbooks");
  const access = await getLibrarianAccess(user);
  if (!access.allowed) {
    return <LibrarianAccessDenied title="Доступ до е-підручників не надано" signOutHref={chatGPTSignOutPath("/")} />;
  }
  return (
    <TextbookManagementWorkspace
      displayName={user.displayName}
      role={access.role ?? "librarian"}
      writesEnabled={access.writesEnabled}
      signOutHref={chatGPTSignOutPath("/")}
    />
  );
}
