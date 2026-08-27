import type { Metadata } from "next";

import { chatGPTSignOutPath, requireChatGPTUser } from "@/app/chatgpt-auth";
import { getLibrarianAccess } from "@/lib/librarian-access";
import LibrarianAccessDenied from "../../librarian-access-denied";
import ProcurementPlanningWorkspace from "./procurement-planning-workspace";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Планування потреби фонду", robots: { index: false, follow: false } };

export default async function ProcurementPlanningPage() {
  const user = await requireChatGPTUser("/librarian/acquisitions/planning");
  const access = getLibrarianAccess(user);
  if (!access.allowed) return <LibrarianAccessDenied title="Доступ до планування не надано" signOutHref={chatGPTSignOutPath("/")} />;
  return <ProcurementPlanningWorkspace displayName={user.displayName} role={access.role ?? "librarian"} writesEnabled={access.writesEnabled} signOutHref={chatGPTSignOutPath("/")} />;
}
