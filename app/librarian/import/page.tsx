import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { requireChatGPTUser } from "@/app/chatgpt-auth";
import { getLibrarianAccess } from "@/lib/librarian-access";
import { getRuntimeBoolean, getRuntimeString } from "@/lib/runtime-env";
import { resolveLibraryImportTarget } from "@/lib/staging-import-gate";
import ImportConsole from "./staging-import-console";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Одноразовий D1 import",
  robots: { index: false, follow: false },
};

export default async function LibraryImportPage() {
  const user = await requireChatGPTUser("/librarian/import");
  const access = getLibrarianAccess(user);
  const target = resolveLibraryImportTarget(
    getRuntimeString("APP_ENV"),
    getRuntimeString("LIBRARY_IMPORT_MODE"),
  );
  if (!access.allowed
    || !target
    || (target === "production" && access.writesEnabled)
    || !getRuntimeBoolean("LIBRARY_IMPORT_ENABLED")) {
    notFound();
  }

  return <ImportConsole displayName={user.displayName} target={target} />;
}
