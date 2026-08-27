import type { Metadata } from "next";

import { chatGPTSignOutPath, requireChatGPTUser } from "@/app/chatgpt-auth";
import { getLibrarianAccess } from "@/lib/librarian-access";
import LibrarianAccessDenied from "../librarian-access-denied";
import ReportsWorkspace from "./reports-workspace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Звіти й документи",
  robots: { index: false, follow: false },
};

export default async function LibrarianReportsPage() {
  const user = await requireChatGPTUser("/librarian/reports");
  const access = getLibrarianAccess(user);
  if (!access.allowed) {
    return <LibrarianAccessDenied title="Доступ до звітів не надано" signOutHref={chatGPTSignOutPath("/")} />;
  }
  return (
    <ReportsWorkspace
      displayName={user.displayName}
      role={access.role ?? "librarian"}
      signOutHref={chatGPTSignOutPath("/")}
    />
  );
}
