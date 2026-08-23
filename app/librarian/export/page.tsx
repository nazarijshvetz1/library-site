import type { Metadata } from "next";

import { chatGPTSignOutPath, requireChatGPTUser } from "@/app/chatgpt-auth";
import { getLibrarianAccess } from "@/lib/librarian-access";
import LibrarianAccessDenied from "../librarian-access-denied";
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
    return <LibrarianAccessDenied title="Доступ до експорту не надано" signOutHref={chatGPTSignOutPath("/")} />;
  }

  return (
    <ExcelExportWorkspace
      displayName={user.displayName}
      role={access.role ?? "librarian"}
      signOutHref={chatGPTSignOutPath("/")}
    />
  );
}
