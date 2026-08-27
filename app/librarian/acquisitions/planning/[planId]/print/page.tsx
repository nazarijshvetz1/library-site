import { env } from "cloudflare:workers";
import type { Metadata } from "next";

import { chatGPTSignOutPath, requireChatGPTUser } from "@/app/chatgpt-auth";
import { getLibrarianAccess } from "@/lib/librarian-access";
import { resolveD1LibrarianUser } from "@/lib/librarian-telegram-auth";
import {
  readLatestProcurementPlanSnapshot,
  readProcurementPlan,
  type ProcurementCategory,
  type ProcurementPlanningDatabase,
} from "@/lib/procurement-planning-store";
import type { VisitD1Database } from "@/lib/visit-schedule-store";
import LibrarianAccessDenied from "../../../../librarian-access-denied";
import PrintActions from "../print-actions";
import styles from "../print.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Потреба фонду — друк", robots: { index: false, follow: false } };
type PageProps = { params: Promise<{ planId: string }>; searchParams: Promise<{ snapshot?: string }> };
const LABELS: Record<ProcurementCategory, string> = { textbook: "Підручники", workbook: "Робочі зошити", assessment: "Контрольні роботи", exercises: "Збірники вправ", atlas: "Атласи й контурні карти", other: "Інше" };

export default async function ProcurementPlanPrintPage({ params, searchParams }: PageProps) {
  const { planId } = await params;
  const snapshot = (await searchParams).snapshot;
  const frozen = snapshot === "latest";
  const returnTo = `/librarian/acquisitions/planning/${encodeURIComponent(planId)}/print${frozen ? "?snapshot=latest" : ""}`;
  const user = await requireChatGPTUser(returnTo);
  const access = getLibrarianAccess(user);
  if (!access.allowed) return <LibrarianAccessDenied title="Доступ до документа не надано" signOutHref={chatGPTSignOutPath("/")} />;
  const db = env.DB as unknown as ProcurementPlanningDatabase;
  let resolved = null;
  try { resolved = await resolveD1LibrarianUser(db as unknown as VisitD1Database, user); } catch { /* fail closed below */ }
  if (!resolved || (snapshot && !frozen)) return <LibrarianAccessDenied title="Доступ до документа не надано" signOutHref={chatGPTSignOutPath("/")} />;
  const plan = frozen ? await readLatestProcurementPlanSnapshot(db, planId) : await readProcurementPlan(db, planId);
  return <main className={styles.page}>
    <header className={styles.header}><div><p>Єдина бібліотека · Міжнародний ліцей МАУП</p><h1>Потреба фонду на {plan.academicYearLabel}</h1><span>{plan.title}</span></div><aside><strong>{frozen || plan.status === "finalized" ? "ЗАФІКСОВАНИЙ ПЛАН" : "РОБОЧА ЧЕРНЕТКА"}</strong><span>Оновлено: {formatDate(plan.updatedAt)}</span><span>Ревізія: {plan.revisionConfirmedAt ? `підтверджена ${formatDate(plan.revisionConfirmedAt)}` : "не підтверджена"}</span></aside></header>
    <PrintActions />
    {plan.classCountsMissing || plan.totals.incompleteResources ? <p className={styles.notice}>Документ неповний: кількість учнів ще не внесено для {plan.classCountsMissing} класів; незавершених позицій — {plan.totals.incompleteResources}.</p> : null}
    <section className={styles.summary}><div><strong>{plan.classes.length}</strong><span>майбутніх класів</span></div><div><strong>{plan.resources.length}</strong><span>найменувань</span></div><div><strong>{plan.totals.demandQuantity}</strong><span>потреба</span></div><div><strong>{plan.totals.usableQuantity}</strong><span>придатно у фонді</span></div><div><strong>{plan.totals.toOrderQuantity}</strong><span>замовити</span></div></section>
    <section className={styles.section}><h2>Зведений список для замовлення</h2><table className={styles.table}><thead><tr><th>Назва видання/підручника</th><th>Автор</th><th>Видавництво</th><th>Рік</th><th>Категорія</th><th>Класи</th><th className={styles.number}>Потреба</th><th className={styles.number}>Придатно</th><th className={styles.number}>Очікується</th><th className={styles.number}>Замовити</th><th>Електронна версія</th><th>Примітки</th></tr></thead><tbody>{plan.resources.map((item) => <tr key={item.id}><td>{item.title}</td><td>{item.author}</td><td>{item.publisher}</td><td>{item.publicationYear ?? ""}</td><td>{LABELS[item.category]}</td><td>{item.allocations.map((allocation) => allocation.className).join(", ")}</td><td className={`${styles.number} ${item.demandQuantity == null ? styles.incomplete : ""}`}>{item.demandQuantity ?? "неповно"}</td><td className={styles.number}>{item.usableQuantity}</td><td className={styles.number}>{item.confirmedIncomingQuantity}</td><td className={`${styles.number} ${item.toOrderQuantity == null ? styles.incomplete : ""}`}>{item.toOrderQuantity ?? "—"}</td><td>{item.sourceUrl}</td><td>{item.notes}</td></tr>)}</tbody></table></section>
    <section className={styles.section}><h2>Розрахунок по класах</h2>{plan.classes.map((planClass) => <article className={styles.classBlock} key={planClass.id}><h3><span>{planClass.className}</span><span className={planClass.studentCount == null ? styles.incomplete : styles.muted}>{planClass.studentCount == null ? "Кількість учнів ще не внесено" : `${planClass.studentCount} учнів`}</span></h3><table className={styles.table}><thead><tr><th>Назва</th><th>Автор</th><th>Категорія</th><th>Предмет</th><th>Правило</th><th className={styles.number}>Резерв</th><th className={styles.number}>Потреба</th></tr></thead><tbody>{plan.resources.flatMap((resource) => { const allocation = resource.allocations.find((item) => item.classId === planClass.id); return allocation ? [<tr key={allocation.id}><td>{resource.title}</td><td>{resource.author}</td><td>{LABELS[resource.category]}</td><td>{resource.subject}</td><td>{allocation.demandMode === "per_student" ? `${allocation.copiesPerUnit} на учня` : allocation.demandMode === "per_class" ? `${allocation.copiesPerUnit} на клас` : `фіксовано ${allocation.fixedQuantity}`}</td><td className={styles.number}>{allocation.reserveQuantity}</td><td className={`${styles.number} ${allocation.demandQuantity == null ? styles.incomplete : ""}`}>{allocation.demandQuantity ?? "—"}</td></tr>] : []; })}</tbody></table></article>)}</section>
    <footer className={styles.footer}>Документ не містить внутрішніх ідентифікаторів каталогу. Для остаточного замовлення використовуйте завершений план після ревізії.</footer>
  </main>;
}

function formatDate(value: string) { return new Intl.DateTimeFormat("uk-UA", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Kyiv" }).format(new Date(value)); }
