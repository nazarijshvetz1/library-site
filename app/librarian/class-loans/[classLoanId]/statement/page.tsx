import { env } from "cloudflare:workers";
import type { Metadata } from "next";

import { getChatGPTUser, requireChatGPTUser } from "@/app/chatgpt-auth";
import { LIBRARY_EMBLEM_URL } from "@/app/librarian/_components/librarian-routes";
import { getLibrarianAccess } from "@/lib/librarian-access";
import { readLibrarianTelegramUser } from "@/lib/librarian-telegram-auth";
import type { VisitD1Database } from "@/lib/visit-schedule-store";
import {
  readClassIssueStatement,
  type ClassIssueStatementDatabase,
} from "@/lib/class-issue-statement-store";
import LibrarianAccessDenied from "../../../librarian-access-denied";
import StatementActions from "./statement-actions";
import styles from "./statement.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Акт-відомість видачі матеріалів класу",
  robots: { index: false, follow: false },
};

type Props = { params: Promise<{ classLoanId: string }> };

export default async function ClassIssueStatementPage({ params }: Props) {
  const { classLoanId } = await params;
  const returnTo = `/librarian/class-loans/${encodeURIComponent(classLoanId)}/statement`;
  const chatGPTUser = await getChatGPTUser();
  const telegramSession = chatGPTUser
    ? null
    : await readLibrarianTelegramUser(env.DB as unknown as VisitD1Database);
  const user = chatGPTUser ?? telegramSession?.user ?? await requireChatGPTUser(returnTo);
  const access = getLibrarianAccess(user);
  if (!access.allowed) {
    return <LibrarianAccessDenied title="Доступ до відомості не надано" signOutHref="/" />;
  }

  const statement = await readClassIssueStatement(
    env.DB as unknown as ClassIssueStatementDatabase,
    classLoanId,
  );
  const copies = statement.lines.reduce((total, line) => total + line.quantityIssued, 0);
  return (
    <main className={styles.page}>
      <StatementActions
        excelHref={`/api/librarian/class-issue-statements/${encodeURIComponent(classLoanId)}/excel`}
      />
      <article className={styles.document}>
        <header className={styles.header}>
          {/* eslint-disable-next-line @next/next/no-img-element -- shared official emblem */}
          <img src={LIBRARY_EMBLEM_URL} alt="" width="64" height="64" />
          <div>
            <strong>Єдина бібліотека</strong>
            <span>Міжнародний ліцей МАУП</span>
          </div>
        </header>
        <h1>Акт-відомість видачі матеріалів класу</h1>
        <dl className={styles.meta}>
          <div><dt>Клас</dt><dd>{statement.className}</dd></div>
          <div><dt>Навчальний рік</dt><dd>{statement.academicYearLabel}</dd></div>
          {statement.classroomName ? <div><dt>Кабінет класу</dt><dd>{statement.classroomName}</dd></div> : null}
          {statement.curatorName ? <div><dt>Класний керівник</dt><dd>{statement.curatorName}</dd></div> : null}
          <div><dt>Дата видачі</dt><dd>{displayDate(statement.issuedAt)}</dd></div>
          <div><dt>Повернути до</dt><dd>{statement.dueAt ? displayDate(statement.dueAt) : "Не визначено"}</dd></div>
        </dl>
        {statement.origin === "legacy_backfill" ? (
          <p className={styles.legacyNote}>Відомість відновлено з наявних даних давньої видачі.</p>
        ) : null}
        <div className={styles.tableWrap}>
          <table>
            <thead><tr><th>№</th><th>Предмет</th><th>Назва</th><th>Автор</th><th>Рік</th><th>Кількість</th></tr></thead>
            <tbody>
              {statement.lines.map((line) => (
                <tr key={line.position}>
                  <td>{line.position}</td><td>{line.subject || "—"}</td><td>{line.title}</td>
                  <td>{line.author || "—"}</td><td>{line.publicationYear ?? "—"}</td><td>{line.quantityIssued}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className={styles.totals}>
          <span>Найменувань: <strong>{statement.lines.length}</strong></span>
          <span>Примірників: <strong>{copies}</strong></span>
        </div>
        <footer className={styles.signatures}>
          <span>Видав(ла) ____________________</span>
          <span>Прийняв(ла) ____________________</span>
        </footer>
      </article>
    </main>
  );
}

function displayDate(value: string): string {
  const date = new Date(value.length === 10 ? `${value}T12:00:00+03:00` : value);
  return new Intl.DateTimeFormat("uk-UA", {
    timeZone: "Europe/Kyiv", year: "numeric", month: "long", day: "numeric",
  }).format(Number.isNaN(date.getTime()) ? new Date(0) : date);
}
