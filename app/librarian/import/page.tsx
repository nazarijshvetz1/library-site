import type { Metadata } from "next";

import { chatGPTSignOutPath, requireChatGPTUser } from "@/app/chatgpt-auth";
import { getLibrarianAccess } from "@/lib/librarian-access";
import { getRuntimeBoolean, getRuntimeString } from "@/lib/runtime-env";
import { resolveLibraryImportTarget } from "@/lib/staging-import-gate";
import LibrarianAccessDenied from "../librarian-access-denied";
import ExcelImportWorkspace from "./excel-import-workspace";
import ImportConsole from "./staging-import-console";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Імпорт з Excel",
  robots: { index: false, follow: false },
};

export default async function LibraryImportPage() {
  const user = await requireChatGPTUser("/librarian/import");
  const access = getLibrarianAccess(user);
  if (!access.allowed) {
    return <LibrarianAccessDenied title="Доступ до імпорту не надано" signOutHref={chatGPTSignOutPath("/")} />;
  }

  const target = resolveLibraryImportTarget(
    getRuntimeString("APP_ENV"),
    getRuntimeString("LIBRARY_IMPORT_MODE"),
  );
  const cutoverEnabled = Boolean(
    target
    && getRuntimeBoolean("LIBRARY_IMPORT_ENABLED")
    && !(target === "production" && access.writesEnabled),
  );
  const roleLabel = access.role === "admin" ? "Адміністратор" : "Бібліотекар";
  const signOutHref = chatGPTSignOutPath("/");
  if (cutoverEnabled && target) {
    return <ImportConsole displayName={user.displayName} roleLabel={roleLabel} signOutHref={signOutHref} target={target} />;
  }

  return <ExcelImportWorkspace displayName={user.displayName} roleLabel={roleLabel} signOutHref={signOutHref} writesEnabled={access.writesEnabled} />;
}
