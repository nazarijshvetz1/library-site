"use client";

import { useEffect, useMemo, useState } from "react";

import SiteIcon, { type SiteIconName } from "@/app/_components/site-icon";
import LibrarianShell, { type LibrarianSubsection } from "../_components/librarian-shell";
import styles from "./reports-workspace.module.css";

type ClassOption = {
  id: string;
  academicYear: string;
  className: string;
  remainingQuantity: number;
};

type StatementSummary = {
  classLoanId: string;
  classYearId: string;
  className: string;
  academicYearLabel: string;
  issuedAt: string;
  dueAt: string | null;
  currentStatus: "open" | "closed" | "cancelled";
  origin: "issued" | "legacy_backfill";
  positionCount: number;
  copyCount: number;
};

const SUBSECTIONS: LibrarianSubsection[] = [
  { id: "overview", section: "reports", label: "Огляд", hint: "Готові звіти", icon: "reports", href: "#overview" },
  { id: "classes", section: "reports", label: "Класи", hint: "Відомості й залишки", icon: "issue-class", href: "#classes" },
  { id: "fund", section: "reports", label: "Фонд", hint: "Рух та інвентаризація", icon: "fund", href: "#fund" },
  { id: "activity", section: "reports", label: "Робота бібліотеки", hint: "Заявки й відвідування", icon: "visits", href: "#activity" },
];

const REPORTS: Array<{ kind: string; group: "overview" | "fund" | "activity"; title: string; description: string; icon: SiteIconName; note?: string }> = [
  { kind: "annual", group: "overview", title: "Річне зведення", description: "Фонд, рух, видачі, записи на відвідування та комплектування за період.", icon: "reports", note: "Відвідування рахуються за записами у графіку." },
  { kind: "returns", group: "overview", title: "Неповернуті матеріали", description: "Окремі аркуші для вчителів і класів із кількістю та строками повернення.", icon: "return" },
  { kind: "provision", group: "overview", title: "Розподіл по класах", description: "Що видано кожному класу, що повернуто і скільки залишається.", icon: "issue-class" },
  { kind: "movement", group: "fund", title: "Рух фонду", description: "Надходження, переміщення, списання, видачі та повернення за період.", icon: "swap" },
  { kind: "inventory", group: "fund", title: "Інвентаризаційна відомість", description: "Поточні залишки по місцях і останній зафіксований підрахунок.", icon: "count" },
  { kind: "acquisitions", group: "activity", title: "Комплектування фонду", description: "Пропозиції, погодження, замовлена й отримана кількість без внутрішніх кодів.", icon: "acquisitions" },
  { kind: "visits", group: "activity", title: "Записи на відвідування", description: "Графік за вчителями, класами, часом, метою і статусом.", icon: "visits", note: "Це записи, а не підтвердження фактичної присутності." },
];

export default function ReportsWorkspace({
  displayName,
  role,
  signOutHref,
  telegramMiniApp = false,
}: {
  displayName: string;
  role: "librarian" | "admin";
  signOutHref: string;
  telegramMiniApp?: boolean;
}) {
  const defaultDates = useMemo(() => todayPeriod(), []);
  const [from, setFrom] = useState(defaultDates.from);
  const [to, setTo] = useState(defaultDates.to);
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [selectedClassId, setSelectedClassId] = useState("");
  const [statements, setStatements] = useState<StatementSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeSubsection, setActiveSubsection] = useState("overview");

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch("/api/librarian/class-excel-export", { cache: "no-store", signal: controller.signal }).then((response) => response.json()),
      fetch("/api/librarian/class-issue-statements", { cache: "no-store", signal: controller.signal }).then((response) => response.json()),
    ]).then(([classBody, statementBody]) => {
      if (!Array.isArray(classBody?.classes) || !Array.isArray(statementBody?.statements)) {
        throw new Error(classBody?.error || statementBody?.error || "Не вдалося завантажити документи класів.");
      }
      setClasses(classBody.classes);
      setSelectedClassId(classBody.classes[0]?.id || "");
      setStatements(statementBody.statements);
    }).catch((requestError) => {
      if (!controller.signal.aborted) setError(requestError instanceof Error ? requestError.message : "Не вдалося завантажити звіти.");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const known = new Set(SUBSECTIONS.map((item) => item.id));
    const syncHash = () => {
      const next = window.location.hash.replace(/^#/u, "");
      setActiveSubsection(known.has(next) ? next : "overview");
    };
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

  const validPeriod = /^\d{4}-\d{2}-\d{2}$/u.test(from) && /^\d{4}-\d{2}-\d{2}$/u.test(to) && from <= to;
  const query = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const filteredStatements = statements.filter((item) => !selectedClassId || item.classYearId === selectedClassId);
  const visibleStatements = filteredStatements.slice(0, 100);

  return (
    <LibrarianShell
      activeSection="reports"
      displayName={displayName}
      roleLabel={role === "admin" ? "Адміністратор" : "Бібліотекар"}
      signOutHref={signOutHref}
      telegramMiniApp={telegramMiniApp}
      subsections={SUBSECTIONS}
      activeSubsection={activeSubsection}
    >
      <main className={styles.page}>
        <header className={styles.intro} id="overview">
          <div><p>Аналітика · друк · Excel</p><h1>Звіти й документи</h1><span>Усі потрібні відомості в одному місці — компактно й без службових кодів.</span></div>
          <a href="/librarian/import"><SiteIcon name="import" size={17} /> Імпорт даних</a>
        </header>

        <section className={styles.period} aria-label="Період звіту">
          <label><span>Від</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
          <label><span>До</span><input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
          <small>{validPeriod ? "Період застосовується до звітів про операції. Інвентаризація показує поточний стан." : "Перевірте дати: початок має бути не пізніше завершення."}</small>
        </section>

        <nav className={styles.quickReports} aria-label="Найчастіші документи">
          <a href="#classes">
            <span aria-hidden="true"><SiteIcon name="issue-class" size={19} /></span>
            <span><strong>Видані матеріали по класах</strong><small>Поточні списки й акти для друку</small></span>
            <SiteIcon name="next" size={17} />
          </a>
          <a href={telegramMiniApp ? "/librarian/telegram/cabinet?target=acquisitions&view=planning" : "/librarian/acquisitions/planning"}>
            <span aria-hidden="true"><SiteIcon name="reports" size={19} /></span>
            <span><strong>Потреба на новий навчальний рік</strong><small>Кількість учнів, наявність і дозамовлення</small></span>
            <SiteIcon name="next" size={17} />
          </a>
        </nav>

        <section className={styles.reportGrid} aria-label="Основні звіти">
          {REPORTS.filter((item) => item.group === "overview").map((item) => (
            <ReportCard key={item.kind} item={item} query={query} validPeriod={validPeriod} />
          ))}
        </section>

        <section className={styles.section} id="classes" aria-labelledby="classes-title">
          <div className={styles.sectionHeading}><div><p>Документи для друку</p><h2 id="classes-title">Видані матеріали по класах</h2></div><span>{classes.length} активних класів</span></div>
          {loading ? <p className={styles.info}>Завантажуємо класи й відомості…</p> : null}
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          {!loading && !error ? (
            <>
              <div className={styles.classToolbar}>
                <label><span>Клас</span><select value={selectedClassId} onChange={(event) => setSelectedClassId(event.target.value)}>{classes.map((item) => <option value={item.id} key={item.id}>{item.className} · {item.academicYear} · на руках {item.remainingQuantity}</option>)}</select></label>
                {selectedClassId ? (
                  <a className={styles.primaryAction} href={`/api/librarian/class-excel-export?classYearId=${encodeURIComponent(selectedClassId)}`}>Поточний список класу</a>
                ) : (
                  <span className={styles.primaryAction} aria-disabled="true">Поточний список класу</span>
                )}
                <a className={styles.secondaryAction} href="/api/librarian/class-excel-export?all=true">Усі класи (.zip)</a>
              </div>
              <details className={styles.statementList}>
                <summary className={styles.listHeader}>
                  <span><strong>Акт-відомості окремих видач</strong><small>Зберігаються після повернення</small></span>
                  <span className={styles.statementSummary}>
                    {filteredStatements.length > visibleStatements.length
                      ? `Показано ${visibleStatements.length} із ${filteredStatements.length}`
                      : `${visibleStatements.length} документів`} <SiteIcon name="expand" size={16} />
                  </span>
                </summary>
                <div className={styles.statementRows}>
                  {visibleStatements.length ? visibleStatements.map((item) => (
                    <article key={item.classLoanId}>
                      <div><strong>{item.className} · {displayDate(item.issuedAt)}</strong><span>{item.positionCount} найм. · {item.copyCount} прим. · {statusLabel(item.currentStatus)}</span>{item.origin === "legacy_backfill" ? <small>Відновлено з давньої видачі</small> : null}</div>
                      <div><a href={`/librarian/class-loans/${encodeURIComponent(item.classLoanId)}/statement`} target="_blank" rel="noopener noreferrer">Відкрити / друкувати</a><a href={`/api/librarian/class-issue-statements/${encodeURIComponent(item.classLoanId)}/excel`}>Excel</a></div>
                    </article>
                  )) : <p className={styles.info}>Для вибраного класу ще немає оформлених видач.</p>}
                </div>
              </details>
            </>
          ) : null}
        </section>

        <section className={styles.section} id="fund" aria-labelledby="fund-title">
          <div className={styles.sectionHeading}><div><p>Фонд</p><h2 id="fund-title">Рух та інвентаризація</h2></div></div>
          <div className={styles.reportGrid}>{REPORTS.filter((item) => item.group === "fund").map((item) => <ReportCard key={item.kind} item={item} query={query} validPeriod={validPeriod} />)}</div>
        </section>

        <section className={styles.section} id="activity" aria-labelledby="activity-title">
          <div className={styles.sectionHeading}><div><p>Робота бібліотеки</p><h2 id="activity-title">Комплектування та відвідування</h2></div></div>
          <div className={styles.reportGrid}>{REPORTS.filter((item) => item.group === "activity").map((item) => <ReportCard key={item.kind} item={item} query={query} validPeriod={validPeriod} />)}</div>
        </section>

        <section className={styles.backup} aria-label="Повний резервний експорт">
          <div><strong>Повний Excel-знімок бібліотеки</strong><span>Для резервної копії та поглибленої роботи з даними. PIN-коди й ключі доступу не експортуються.</span></div>
          <a href="/api/librarian/excel-export"><SiteIcon name="export" size={17} /> Завантажити</a>
        </section>
      </main>
    </LibrarianShell>
  );
}

function ReportCard({ item, query, validPeriod }: { item: (typeof REPORTS)[number]; query: string; validPeriod: boolean }) {
  const currentSnapshot = item.kind === "inventory";
  const disabled = !currentSnapshot && !validPeriod;
  const href = currentSnapshot
    ? `/api/librarian/reports/${item.kind}`
    : `/api/librarian/reports/${item.kind}?${query}`;
  return <article className={styles.reportCard}><span aria-hidden="true"><SiteIcon name={item.icon} size={19} /></span><div><h3>{item.title}</h3><p>{item.description}</p>{currentSnapshot ? <small>Стан на момент формування.</small> : item.note ? <small>{item.note}</small> : null}</div>{disabled ? <span aria-disabled="true">Excel <SiteIcon name="export" size={15} /></span> : <a href={href}>Excel <SiteIcon name="export" size={15} /></a>}</article>;
}

function todayPeriod() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return { from: month >= 8 ? `${year}-08-01` : `${year - 1}-08-01`, to: today };
}

function displayDate(value: string) { return value.slice(0, 10).split("-").reverse().join("."); }
function statusLabel(value: StatementSummary["currentStatus"]) { return value === "closed" ? "повернено" : value === "cancelled" ? "скасовано" : "відкрито"; }
