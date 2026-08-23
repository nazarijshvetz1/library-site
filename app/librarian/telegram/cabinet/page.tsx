import { env } from "cloudflare:workers";
import type { Metadata } from "next";

import D1LibrarianWorkspace from "@/app/librarian/d1-workspace";
import TeacherManagementWorkspace from "@/app/librarian/teachers/teacher-management-workspace";
import LibrarianVisitWorkspace from "@/app/librarian/visits/visit-admin-workspace";
import AcquisitionWorkspace from "@/app/librarian/acquisitions/acquisition-workspace";
import { getLibrarianAccess } from "@/lib/librarian-access";
import { readLibrarianTelegramUser } from "@/lib/librarian-telegram-auth";
import type { VisitD1Database } from "@/lib/visit-schedule-store";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Кабінет бібліотекаря в Telegram",
  robots: { index: false, follow: false },
};

type PageProps = { searchParams?: Promise<Record<string, string | string[] | undefined>> };

export default async function TelegramLibrarianCabinetPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const session = await readLibrarianTelegramUser(env.DB as unknown as VisitD1Database);
  if (!session) {
    return (
      <main className="access-shell">
        <section className="access-card">
          <p className="eyebrow centered"><span aria-hidden="true" /> Telegram Mini App</p>
          <h1>Сеанс бібліотекаря завершився</h1>
          <p>Поверніться до приватного чату з ботом і відкрийте кабінет ще раз.</p>
          <div className="access-actions"><a className="button button-primary" href="/librarian/telegram">Відкрити повторно</a></div>
        </section>
      </main>
    );
  }
  const target = boundedTarget(params?.target);
  const access = getLibrarianAccess(session.user);
  const pendingScope = await sessionPendingScope(session.user.d1UserId ?? session.user.userId);
  const botHref = "https://t.me/MAUP_Library_Bot";
  if (target === "teachers") {
    return (
      <TeacherManagementWorkspace
        pendingScope={pendingScope}
        displayName={session.user.displayName}
        role={session.role}
        writesEnabled={access.writesEnabled}
        signOutHref={botHref}
        telegramMiniApp
        initialTab={boundedTeacherTab(params?.tab)}
      />
    );
  }
  if (target === "visits") {
    return (
      <LibrarianVisitWorkspace
        pendingScope={pendingScope}
        displayName={session.user.displayName}
        role={session.role}
        writesEnabled={access.writesEnabled}
        signOutHref={botHref}
        telegramMiniApp
      />
    );
  }
  if (target === "acquisitions") {
    return (
      <AcquisitionWorkspace
        displayName={session.user.displayName}
        role={session.role}
        writesEnabled={access.writesEnabled}
        signOutHref={botHref}
        telegramMiniApp
      />
    );
  }
  return (
    <D1LibrarianWorkspace
      displayName={session.user.displayName}
      role={session.role}
      writesEnabled={access.writesEnabled}
      signOutHref={botHref}
      telegramMiniApp
    />
  );
}

function boundedTarget(value: string | string[] | undefined): "home" | "visits" | "teachers" | "acquisitions" {
  return value === "visits" || value === "teachers" || value === "acquisitions" ? value : "home";
}

function boundedTeacherTab(value: string | string[] | undefined): "overview" | "teachers" | "orders" | "visits" | "telegram" {
  return value === "teachers" || value === "orders" || value === "visits" || value === "telegram" ? value : "overview";
}

async function sessionPendingScope(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`telegram-librarian:${value}`));
  return Array.from(new Uint8Array(digest).slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
