import type { Metadata } from "next";
import Link from "next/link";
import { chatGPTSignOutPath, requireChatGPTUser } from "@/app/chatgpt-auth";
import { getLibrarianAccess } from "@/lib/librarian-access";
import { isSheetsGatewayConfigured } from "@/lib/sheets-gateway";
import LibrarianWorkspace from "./workspace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Кабінет бібліотекаря",
  robots: { index: false, follow: false },
};

const LOGO_URL =
  "https://nazarijshvetz1.github.io/library-site/library-logo.png";

export default async function LibrarianPage() {
  const user = await requireChatGPTUser("/librarian");
  const access = await getLibrarianAccess(user);

  if (!access.allowed) {
    return (
      <main className="access-shell">
        <section className="access-card" aria-labelledby="access-title">
          <img src={LOGO_URL} alt="" width="80" height="80" />
          <p className="eyebrow centered"><span aria-hidden="true" /> Захищений кабінет</p>
          <h1 id="access-title">Для цього облікового запису доступ не надано</h1>
          <p>
            Ви успішно ввійшли через ChatGPT, але ваш обліковий запис відсутній
            у списку працівників бібліотеки. Дані Google Sheets залишилися без змін.
          </p>

          <dl className="identity-card">
            <div>
              <dt>Email</dt>
              <dd>{user.email}</dd>
            </div>
            <div>
              <dt>ID користувача</dt>
              <dd>{user.userId}</dd>
            </div>
            <div>
              <dt>Причина</dt>
              <dd>
                {access.reason === "not_configured"
                  ? "Список дозволених користувачів ще не налаштовано"
                  : "Обліковий запис не входить до списку доступу"}
              </dd>
            </div>
          </dl>

          <div className="access-actions">
            <Link className="button button-primary" href="/">Повернутися на головну</Link>
            <a className="button button-secondary" href={chatGPTSignOutPath("/")}>Вийти з облікового запису</a>
          </div>
        </section>
      </main>
    );
  }

  return (
    <LibrarianWorkspace
      displayName={user.displayName}
      role={access.role ?? "librarian"}
      writesEnabled={access.writesEnabled}
      gatewayConfigured={isSheetsGatewayConfigured()}
      signOutHref={chatGPTSignOutPath("/")}
    />
  );
}
