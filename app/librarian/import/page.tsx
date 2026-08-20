import type { Metadata } from "next";

/* eslint-disable @next/next/no-html-link-for-pages -- Vinext full-page navigation is intentional. */

import { requireChatGPTUser } from "@/app/chatgpt-auth";
import { getLibrarianAccess } from "@/lib/librarian-access";
import { getRuntimeBoolean, getRuntimeString } from "@/lib/runtime-env";
import { resolveLibraryImportTarget } from "@/lib/staging-import-gate";
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
    return (
      <main className="access-shell">
        <section className="access-card" aria-labelledby="excel-import-access-title">
          <p className="eyebrow centered"><span aria-hidden="true" /> Захищений кабінет</p>
          <h1 id="excel-import-access-title">Доступ до імпорту не надано</h1>
          <p>Цей обліковий запис не входить до списку працівників бібліотеки.</p>
          <div className="access-actions"><a className="button button-primary" href="/">На головну</a></div>
        </section>
      </main>
    );
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
  if (cutoverEnabled && target) {
    return <ImportConsole displayName={user.displayName} target={target} />;
  }

  return <ExcelImportWorkspace displayName={user.displayName} writesEnabled={access.writesEnabled} />;
}
