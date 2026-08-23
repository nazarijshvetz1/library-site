import type { Metadata } from "next";

import { chatGPTSignOutPath, requireChatGPTUser } from "@/app/chatgpt-auth";
import { getLibrarianAccess } from "@/lib/librarian-access";
import LibrarianAccessDenied from "../librarian-access-denied";
import AcquisitionWorkspace from "./acquisition-workspace";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Комплектування фонду", robots: { index: false, follow: false } };
export default async function LibrarianAcquisitionsPage() {
  const user = await requireChatGPTUser("/librarian/acquisitions"); const access = getLibrarianAccess(user);
  if (!access.allowed) return <LibrarianAccessDenied title="Доступ до комплектування не надано" signOutHref={chatGPTSignOutPath("/")} />;
  return <AcquisitionWorkspace displayName={user.displayName} role={access.role ?? "librarian"} writesEnabled={access.writesEnabled} signOutHref={chatGPTSignOutPath("/")} />;
}
