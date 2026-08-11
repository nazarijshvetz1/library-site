import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { requireChatGPTUser } from "@/app/chatgpt-auth";
import { getLibrarianAccess } from "@/lib/librarian-access";
import { getRuntimeBoolean, getRuntimeString } from "@/lib/runtime-env";
import ImportConsole from "./staging-import-console";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Staging D1 import",
  robots: { index: false, follow: false },
};

export default async function StagingImportPage() {
  const user = await requireChatGPTUser("/librarian/import");
  const access = getLibrarianAccess(user);
  if (!access.allowed
    || getRuntimeString("APP_ENV") !== "staging"
    || !getRuntimeBoolean("LIBRARY_IMPORT_ENABLED")) {
    notFound();
  }

  return <ImportConsole displayName={user.displayName} />;
}
