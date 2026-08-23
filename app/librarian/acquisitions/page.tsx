import type { Metadata } from "next";

/* eslint-disable @next/next/no-html-link-for-pages -- full-page anchors are intentional in Vinext production. */
import { chatGPTSignOutPath, requireChatGPTUser } from "@/app/chatgpt-auth";
import { getLibrarianAccess } from "@/lib/librarian-access";
import AcquisitionWorkspace from "./acquisition-workspace";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Комплектування фонду", robots: { index: false, follow: false } };
export default async function LibrarianAcquisitionsPage() {
  const user = await requireChatGPTUser("/librarian/acquisitions"); const access = getLibrarianAccess(user);
  if (!access.allowed) return <main className="access-shell"><section className="access-card"><p className="eyebrow centered"><span aria-hidden="true" /> Захищений кабінет</p><h1>Доступ не надано</h1><p>Цей обліковий запис не входить до списку працівників бібліотеки.</p><div className="access-actions"><a className="button button-primary" href="/">На головну</a></div></section></main>;
  return <AcquisitionWorkspace displayName={user.displayName} writesEnabled={access.writesEnabled} signOutHref={chatGPTSignOutPath("/")} />;
}
