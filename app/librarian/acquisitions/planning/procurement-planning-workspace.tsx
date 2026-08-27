"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

import SiteIcon from "@/app/_components/site-icon";
import LibrarianShell from "../../_components/librarian-shell";
import { acquisitionSubsections } from "../acquisition-navigation";
import type {
  CatalogPlanningResult,
  ProcurementAllocation,
  ProcurementCategory,
  ProcurementDemandMode,
  ProcurementPlanClass,
  ProcurementPlanDetail,
  ProcurementPlanResource,
  ProcurementPlanSummary,
  ProcurementStockMode,
} from "@/lib/procurement-planning-store";
import styles from "./procurement-planning-workspace.module.css";

const CATEGORY_LABELS: Record<ProcurementCategory, string> = {
  textbook: "Підручники",
  workbook: "Робочі зошити",
  assessment: "Контрольні роботи",
  exercises: "Збірники вправ",
  atlas: "Атласи й контурні карти",
  other: "Інше",
};
const CATEGORIES = Object.keys(CATEGORY_LABELS) as ProcurementCategory[];

type Props = { displayName: string; role?: string; writesEnabled: boolean; signOutHref: string; telegramMiniApp?: boolean };
type ListEnvelope = { success: true; plans: ProcurementPlanSummary[]; writesEnabled: boolean; error?: string };
type DetailEnvelope = { success: true; plan: ProcurementPlanDetail; writesEnabled: boolean; error?: string };

export default function ProcurementPlanningWorkspace({ displayName, role = "librarian", writesEnabled, signOutHref, telegramMiniApp = false }: Props) {
  const [plans, setPlans] = useState<ProcurementPlanSummary[]>([]);
  const [plan, setPlan] = useState<ProcurementPlanDetail | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadPlan = useCallback(async (planId: string) => {
    if (!planId) { setPlan(null); return; }
    const response = await fetch(`/api/librarian/procurement-plans/${encodeURIComponent(planId)}`, { cache: "no-store" });
    const body = await response.json() as DetailEnvelope;
    if (!response.ok) throw new Error(body.error || "Не вдалося завантажити план.");
    setPlan(body.plan);
  }, []);

  const load = useCallback(async (preferredId = "") => {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/librarian/procurement-plans", { cache: "no-store" });
      const body = await response.json() as ListEnvelope;
      if (!response.ok) throw new Error(body.error || "Не вдалося завантажити плани.");
      setPlans(body.plans);
      const nextId = preferredId || selectedId || body.plans[0]?.id || "";
      await loadPlan(nextId);
      setSelectedId(nextId);
    } catch (loadError) { setError(message(loadError)); } finally { setLoading(false); }
  }, [loadPlan, selectedId]);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function mutate(fields: Record<string, unknown>, successMessage = "Зміни збережено."): Promise<boolean> {
    if (!plan) return false;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/librarian/procurement-plans/${encodeURIComponent(plan.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields),
      });
      const body = await response.json() as DetailEnvelope;
      if (!response.ok) throw new Error(body.error || "Не вдалося зберегти зміни.");
      setPlan(body.plan);
      setPlans((current) => current.map((item) => item.id === body.plan.id ? body.plan : item));
      setNotice(successMessage);
      return true;
    } catch (mutationError) { setError(message(mutationError)); return false; } finally { setBusy(false); }
  }

  async function selectPlan(planId: string) {
    setLoading(true); setError(""); setNotice("");
    try { await loadPlan(planId); setSelectedId(planId); }
    catch (loadError) { setError(message(loadError)); }
    finally { setLoading(false); }
  }

  async function createPlan(input: { academicYearLabel: string; title: string; defaultReserve: number }) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/librarian/procurement-plans", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, notes: "" }),
      });
      const body = await response.json() as DetailEnvelope;
      if (!response.ok) throw new Error(body.error || "Не вдалося створити план.");
      setSelectedId(body.plan.id); setPlan(body.plan); setPlans((current) => [body.plan, ...current]);
      setNotice("План створено. Кількість учнів можна внести пізніше.");
    } catch (createError) { setError(message(createError)); } finally { setBusy(false); }
  }

  const incomplete = Boolean(plan && (plan.classCountsMissing > 0 || plan.totals.incompleteResources > 0));
  return <LibrarianShell
    activeSection="acquisitions"
    displayName={displayName}
    roleLabel={role === "admin" ? "Адміністратор" : "Бібліотекар"}
    signOutHref={signOutHref}
    telegramMiniApp={telegramMiniApp}
    writesEnabled={writesEnabled}
    subsections={acquisitionSubsections(telegramMiniApp)}
    activeSubsection="planning"
  >
    <main className={`${styles.page} ${telegramMiniApp ? styles.telegram : ""}`}>
      <header className={styles.hero}>
        <div><p>Комплектування · новий навчальний рік</p><h1>Планування потреби фонду</h1><span>Класи, майбутня кількість учнів, фактичний залишок і готове замовлення — в одному розрахунку.</span></div>
        <button type="button" onClick={() => void load(plan?.id)} disabled={loading || busy}><SiteIcon name={loading ? "loading" : "refresh"} size={17} /> Оновити</button>
      </header>
      {!writesEnabled ? <p className={styles.warning}>Дані доступні лише для перегляду.</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {notice ? <p className={styles.notice} role="status">{notice}</p> : null}

      <section className={styles.planBar} aria-label="Вибір плану">
        <label><span>План</span><select value={selectedId} disabled={loading || busy} onChange={(event) => void selectPlan(event.target.value)}><option value="">Новий план</option>{plans.map((item) => <option value={item.id} key={item.id}>{item.academicYearLabel} · {item.title}</option>)}</select></label>
        {plan ? <span className={`${styles.status} ${plan.status === "finalized" ? styles.finalized : ""}`}>{plan.status === "finalized" ? "Завершено" : "Чернетка"}</span> : null}
      </section>

      {!plan && !loading ? <CreatePlanForm busy={busy || !writesEnabled} onCreate={createPlan} /> : null}
      {plan ? <>
        <section className={styles.metrics} aria-label="Підсумок плану">
          <article><strong>{plan.classes.length}</strong><span>майбутніх класів</span><small>{plan.classCountsMissing ? `без кількості: ${plan.classCountsMissing}` : "кількість внесено"}</small></article>
          <article><strong>{plan.resources.length}</strong><span>найменувань</span><small>{plan.totals.incompleteResources ? `неповних: ${plan.totals.incompleteResources}` : "розраховано"}</small></article>
          <article><strong>{plan.totals.demandQuantity}</strong><span>загальна потреба</span><small>за внесеними даними</small></article>
          <article><strong>{plan.totals.usableQuantity}</strong><span>придатно у фонді</span><small>після ревізії</small></article>
          <article className={styles.orderMetric}><strong>{plan.totals.toOrderQuantity}</strong><span>треба замовити</span><small>{incomplete ? "попередньо" : "готовий підсумок"}</small></article>
        </section>

        <PlanSettings key={`${plan.id}:${plan.title}:${plan.defaultReserve}:${plan.notes}:${plan.revisionConfirmedAt ?? ""}`} plan={plan} busy={busy || !writesEnabled} onMutate={mutate} />
        <ClassSection key={plan.id} plan={plan} busy={busy || !writesEnabled || plan.status !== "draft"} onMutate={mutate} />
        <ResourceSection key={plan.id} plan={plan} busy={busy || !writesEnabled || plan.status !== "draft"} onMutate={mutate} />
        <DocumentsSection plan={plan} telegramMiniApp={telegramMiniApp} incomplete={incomplete} busy={busy || !writesEnabled} onMutate={mutate} />
      </> : loading ? <p className={styles.loading}>Завантажуємо планування…</p> : null}
    </main>
  </LibrarianShell>;
}

function CreatePlanForm({ busy, onCreate }: { busy: boolean; onCreate: (value: { academicYearLabel: string; title: string; defaultReserve: number }) => Promise<void> }) {
  const defaultYear = nextAcademicYear();
  const [year, setYear] = useState(defaultYear);
  const [title, setTitle] = useState(`Потреба фонду на ${defaultYear}`);
  const [reserve, setReserve] = useState("0");
  return <form className={styles.createCard} onSubmit={(event) => { event.preventDefault(); void onCreate({ academicYearLabel: year, title, defaultReserve: Number(reserve) }); }}>
    <div><p>Почніть із періоду</p><h2>Новий план</h2><span>Кількість учнів зараз не потрібна: її можна заповнити наприкінці року.</span></div>
    <label><span>Навчальний рік</span><input value={year} onChange={(event) => setYear(event.target.value)} placeholder="2027/2028" required /></label>
    <label className={styles.wide}><span>Назва</span><input value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
    <label><span>Резерв за замовчуванням</span><input type="number" min="0" max="1000" value={reserve} onChange={(event) => setReserve(event.target.value)} /></label>
    <button type="submit" disabled={busy}><SiteIcon name="add" size={17} /> Створити план</button>
  </form>;
}

function PlanSettings({ plan, busy, onMutate }: { plan: ProcurementPlanDetail; busy: boolean; onMutate: Mutate }) {
  const [title, setTitle] = useState(plan.title); const [reserve, setReserve] = useState(String(plan.defaultReserve)); const [notes, setNotes] = useState(plan.notes); const [revision, setRevision] = useState(Boolean(plan.revisionConfirmedAt));
  return <details className={styles.section} open>
    <summary><span><small>01 · параметри</small><strong>План і ревізія</strong></span><span>{plan.revisionConfirmedAt ? "Ревізію підтверджено" : "Робоча чернетка"}<SiteIcon name="expand" size={18} /></span></summary>
    <form className={styles.settings} onSubmit={(event) => { event.preventDefault(); void onMutate({ action: "update_plan", expectedVersion: plan.version, title, defaultReserve: Number(reserve), notes, revisionConfirmed: revision }, "Параметри плану збережено."); }}>
      <label className={styles.wide}><span>Назва плану</span><input value={title} onChange={(event) => setTitle(event.target.value)} disabled={plan.status !== "draft"} /></label>
      <label><span>Загальний резерв</span><input type="number" min="0" max="1000" value={reserve} onChange={(event) => setReserve(event.target.value)} disabled={plan.status !== "draft"} /></label>
      <label className={styles.wide}><span>Примітки</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} disabled={plan.status !== "draft"} /></label>
      <div className={styles.check}><input id="revision-confirmed" type="checkbox" checked={revision} onChange={(event) => setRevision(event.target.checked)} disabled={plan.status !== "draft"} /><label htmlFor="revision-confirmed"><strong>Ревізію завершено</strong><small>Підтверджуйте лише після перевірки залишків і оформлення всіх повернень.</small></label></div>
      {plan.status === "draft" ? <button type="submit" disabled={busy}>Зберегти параметри</button> : <p className={styles.locked}><SiteIcon name="security" size={16} /> План захищений від випадкових змін.</p>}
    </form>
  </details>;
}

function ClassSection({ plan, busy, onMutate }: { plan: ProcurementPlanDetail; busy: boolean; onMutate: Mutate }) {
  const [name, setName] = useState(""); const [grade, setGrade] = useState("1"); const [count, setCount] = useState("");
  return <details className={styles.section}>
    <summary><span><small>02 · основа розрахунку</small><strong>Майбутні класи</strong></span><span>{plan.classes.length} класів · {plan.classCountsMissing} без кількості<SiteIcon name="expand" size={18} /></span></summary>
    <div className={styles.sectionBody}>
      <div className={styles.sectionIntro}><p>Класи живуть лише в цьому плані й не змінюють чинний навчальний рік.</p><button type="button" disabled={busy} onClick={() => void onMutate({ action: "prefill_classes" }, "Наступні класи додано. Кількість учнів залишена порожньою.")}><SiteIcon name="rollover" size={16} /> Підготувати з чинних класів</button></div>
      <form className={styles.inlineForm} onSubmit={(event) => { event.preventDefault(); void onMutate({ action: "upsert_class", className: name, grade: Number(grade), studentCount: count === "" ? null : Number(count), notes: "", sortOrder: Number(grade) * 100 }, "Клас додано.").then((saved) => { if (saved) { setName(""); setCount(""); } }); }}>
        <label><span>Клас</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Наприклад, 5-А" required /></label>
        <label><span>Паралель</span><input type="number" min="1" max="11" value={grade} onChange={(event) => setGrade(event.target.value)} required /></label>
        <label><span>Кількість учнів</span><input type="number" min="0" max="500" value={count} onChange={(event) => setCount(event.target.value)} placeholder="Внести пізніше" /></label>
        <button type="submit" disabled={busy}><SiteIcon name="add" size={16} /> Додати</button>
      </form>
      {plan.classes.length ? <div className={styles.classGrid}>{plan.classes.map((item) => <ClassEditor key={`${item.id}-${item.version}`} item={item} busy={busy} onMutate={onMutate} />)}</div> : <p className={styles.empty}>Додайте майбутні класи вручну або підготуйте їх із чинного року.</p>}
    </div>
  </details>;
}

function ClassEditor({ item, busy, onMutate }: { item: ProcurementPlanClass; busy: boolean; onMutate: Mutate }) {
  const [name, setName] = useState(item.className); const [grade, setGrade] = useState(String(item.grade)); const [count, setCount] = useState(item.studentCount == null ? "" : String(item.studentCount));
  return <form className={styles.classCard} onSubmit={(event) => { event.preventDefault(); void onMutate({ action: "upsert_class", id: item.id, expectedVersion: item.version, className: name, grade: Number(grade), studentCount: count === "" ? null : Number(count), notes: item.notes, sortOrder: item.sortOrder }, `Клас ${name} оновлено.`); }}>
    <label><span>Клас</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label><span>Паралель</span><input type="number" min="1" max="11" value={grade} onChange={(event) => setGrade(event.target.value)} /></label>
    <label className={styles.studentCount}><span>Учнів</span><input type="number" min="0" max="500" value={count} onChange={(event) => setCount(event.target.value)} placeholder="Ще не внесено" /></label>
    <div className={styles.rowActions}><button type="submit" disabled={busy}>Зберегти</button><button type="button" className={styles.dangerLink} disabled={busy} onClick={() => { if (window.confirm(`Вилучити ${item.className} з плану?`)) void onMutate({ action: "remove_class", id: item.id }, "Клас вилучено з плану."); }}><SiteIcon name="delete" size={15} /> Вилучити</button></div>
  </form>;
}

function ResourceSection({ plan, busy, onMutate }: { plan: ProcurementPlanDetail; busy: boolean; onMutate: Mutate }) {
  const [query, setQuery] = useState(""); const [results, setResults] = useState<CatalogPlanningResult[]>([]); const [searching, setSearching] = useState(false); const [searchError, setSearchError] = useState("");
  async function search(event: FormEvent) { event.preventDefault(); setSearching(true); setSearchError(""); try { const response = await fetch(`/api/librarian/procurement-plans/catalog?q=${encodeURIComponent(query)}`, { cache: "no-store" }); const body = await response.json() as { materials?: CatalogPlanningResult[]; error?: string }; if (!response.ok) throw new Error(body.error || "Пошук не виконано."); setResults(body.materials ?? []); } catch (error) { setSearchError(message(error)); } finally { setSearching(false); } }
  return <details className={styles.section}>
    <summary><span><small>03 · матеріали й формула</small><strong>Позиції плану</strong></span><span>{plan.resources.length} найменувань · замовити {plan.totals.toOrderQuantity}<SiteIcon name="expand" size={18} /></span></summary>
    <div className={styles.sectionBody}>
      <form className={styles.catalogSearch} onSubmit={search}><label><span>Знайти у фонді</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Назва, автор або предмет" minLength={2} required /></label><button type="submit" disabled={searching}>{searching ? <SiteIcon name="loading" size={16} /> : <SiteIcon name="search" size={16} />} Знайти</button></form>
      {searchError ? <p className={styles.error}>{searchError}</p> : null}
      {results.length ? <div className={styles.searchResults}>{results.map((material) => <article key={material.id}><div><strong>{material.title}</strong><span>{[material.author, material.publicationYear, material.subject, material.classLabel].filter(Boolean).join(" · ")}</span><small>Придатно попередньо: {material.usableQuantity}</small></div><button type="button" disabled={busy || plan.resources.some((item) => item.materialId === material.id)} onClick={() => void onMutate({ action: "upsert_resource", materialId: material.id, category: categoryFromMaterial(material), stockMode: stockModeFromCategory(categoryFromMaterial(material)), title: material.title, subject: material.subject, author: material.author, publisher: material.publisher, publicationYear: material.publicationYear, sourceUrl: material.sourceUrl, notes: "", usableQuantityOverride: null, additionalIncomingQuantity: 0, sortOrder: plan.resources.length }, "Видання додано до плану.")}>{plan.resources.some((item) => item.materialId === material.id) ? "У плані" : "Додати"}</button></article>)}</div> : null}
      <ManualResourceForm plan={plan} busy={busy} onMutate={onMutate} />
      {plan.resources.length ? <div className={styles.resourceList}>{plan.resources.map((resource) => <ResourceCard key={resource.id} plan={plan} resource={resource} busy={busy} onMutate={onMutate} />)}</div> : <p className={styles.empty}>Знайдіть видання у фонді або додайте нове вручну.</p>}
    </div>
  </details>;
}

function ManualResourceForm({ plan, busy, onMutate }: { plan: ProcurementPlanDetail; busy: boolean; onMutate: Mutate }) {
  const [open, setOpen] = useState(false); const [category, setCategory] = useState<ProcurementCategory>("textbook"); const [stockMode, setStockMode] = useState<ProcurementStockMode>("reusable"); const [title, setTitle] = useState(""); const [author, setAuthor] = useState(""); const [publisher, setPublisher] = useState(""); const [year, setYear] = useState(""); const [subject, setSubject] = useState(""); const [url, setUrl] = useState("");
  return <details className={styles.manual} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary><SiteIcon name="add" size={16} /> Додати видання, якого ще немає у фонді</summary><form onSubmit={(event) => { event.preventDefault(); void onMutate({ action: "upsert_resource", materialId: null, category, stockMode, title, author, publisher, publicationYear: year === "" ? null : Number(year), subject, sourceUrl: url, notes: "", usableQuantityOverride: stockMode === "consumable" ? 0 : null, additionalIncomingQuantity: 0, sortOrder: plan.resources.length }, "Нове видання додано до плану.").then((saved) => { if (saved) { setTitle(""); setAuthor(""); setPublisher(""); setYear(""); setSubject(""); setUrl(""); setOpen(false); } }); }}>
    <label><span>Категорія</span><select value={category} onChange={(event) => { const value = event.target.value as ProcurementCategory; setCategory(value); setStockMode(stockModeFromCategory(value)); }}>{CATEGORIES.map((value) => <option value={value} key={value}>{CATEGORY_LABELS[value]}</option>)}</select></label>
    <label><span>Облік</span><select value={stockMode} onChange={(event) => setStockMode(event.target.value as ProcurementStockMode)}><option value="reusable">Багаторазове</option><option value="consumable">Витратний матеріал</option></select></label>
    <label className={styles.wide}><span>Назва</span><input value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
    <label><span>Автор</span><input value={author} onChange={(event) => setAuthor(event.target.value)} /></label>
    <label><span>Видавництво</span><input value={publisher} onChange={(event) => setPublisher(event.target.value)} /></label>
    <label><span>Рік</span><input type="number" min="1000" max="2100" value={year} onChange={(event) => setYear(event.target.value)} /></label>
    <label><span>Предмет</span><input value={subject} onChange={(event) => setSubject(event.target.value)} /></label>
    <label className={styles.wide}><span>Електронна версія / інформація</span><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" /></label>
    <button type="submit" disabled={busy}>Додати до плану</button>
  </form></details>;
}

function ResourceCard({ plan, resource, busy, onMutate }: { plan: ProcurementPlanDetail; resource: ProcurementPlanResource; busy: boolean; onMutate: Mutate }) {
  const unassigned = plan.classes.filter((planClass) => !resource.allocations.some((item) => item.classId === planClass.id));
  return <article className={styles.resourceCard}>
    <header><div><span>{CATEGORY_LABELS[resource.category]} · {resource.stockMode === "consumable" ? "витратний" : "багаторазовий"}</span><h3>{resource.title}</h3><p>{[resource.author, resource.publisher, resource.publicationYear, resource.subject].filter(Boolean).join(" · ") || "Метадані ще не заповнені"}</p></div>{resource.demandQuantity == null ? <em>Неповний розрахунок</em> : <em className={styles.ready}>Розраховано</em>}</header>
    <div className={styles.resourceMetrics}><span><strong>{resource.demandQuantity ?? "—"}</strong>потреба</span><span><strong>{resource.usableQuantity}</strong>придатно</span><span><strong>{resource.confirmedIncomingQuantity}</strong>очікується</span><span className={styles.need}><strong>{resource.toOrderQuantity ?? "—"}</strong>замовити</span><span><strong>{resource.surplusQuantity ?? "—"}</strong>надлишок</span></div>
    <details className={styles.resourceDetails}><summary>Налаштування видання</summary><ResourceEditor key={`${resource.id}-${resource.version}`} resource={resource} busy={busy} onMutate={onMutate} /></details>
    <div className={styles.allocations}><div className={styles.subheading}><strong>Розрахунок за класами</strong><span>{resource.allocations.length} класів</span></div>{resource.allocations.map((allocation) => <AllocationEditor key={`${allocation.id}-${allocation.version}`} resource={resource} allocation={allocation} busy={busy} onMutate={onMutate} />)}{unassigned.length ? <NewAllocation resource={resource} classes={unassigned} defaultReserve={plan.defaultReserve} busy={busy} onMutate={onMutate} /> : plan.classes.length ? <p className={styles.complete}>Усі класи додані до розрахунку.</p> : <p className={styles.emptyInline}>Спочатку додайте майбутні класи.</p>}</div>
  </article>;
}

function ResourceEditor({ resource, busy, onMutate }: { resource: ProcurementPlanResource; busy: boolean; onMutate: Mutate }) {
  const [values, setValues] = useState(() => resourceValues(resource));
  const set = (key: keyof typeof values, value: string) => setValues((current) => ({ ...current, [key]: value }));
  return <form className={styles.resourceForm} onSubmit={(event) => { event.preventDefault(); void onMutate({ action: "upsert_resource", id: resource.id, expectedVersion: resource.version, materialId: resource.materialId, category: values.category, stockMode: values.stockMode, title: values.title, subject: values.subject, author: values.author, publisher: values.publisher, publicationYear: values.year === "" ? null : Number(values.year), sourceUrl: values.url, notes: values.notes, usableQuantityOverride: values.usable === "" ? null : Number(values.usable), additionalIncomingQuantity: Number(values.incoming), sortOrder: resource.sortOrder }, "Параметри видання збережено."); }}>
    <label><span>Категорія</span><select value={values.category} onChange={(event) => set("category", event.target.value)}>{CATEGORIES.map((value) => <option value={value} key={value}>{CATEGORY_LABELS[value]}</option>)}</select></label><label><span>Облік</span><select value={values.stockMode} onChange={(event) => set("stockMode", event.target.value)}><option value="reusable">Багаторазове</option><option value="consumable">Витратний матеріал</option></select></label>
    <label className={styles.wide}><span>Назва</span><input value={values.title} onChange={(event) => set("title", event.target.value)} /></label><label><span>Автор</span><input value={values.author} onChange={(event) => set("author", event.target.value)} /></label><label><span>Видавництво</span><input value={values.publisher} onChange={(event) => set("publisher", event.target.value)} /></label><label><span>Рік</span><input type="number" value={values.year} onChange={(event) => set("year", event.target.value)} /></label><label><span>Предмет</span><input value={values.subject} onChange={(event) => set("subject", event.target.value)} /></label>
    <label><span>Придатний залишок</span><input type="number" min="0" value={values.usable} onChange={(event) => set("usable", event.target.value)} placeholder={`Автоматично: ${resource.automaticUsableQuantity}`} /><small>Порожньо — автоматичний залишок; для витратних матеріалів за замовчуванням 0.</small></label><label><span>Додатково очікується</span><input type="number" min="0" value={values.incoming} onChange={(event) => set("incoming", event.target.value)} /></label><label className={styles.wide}><span>Покликання</span><input type="url" value={values.url} onChange={(event) => set("url", event.target.value)} /></label><label className={styles.wide}><span>Примітки</span><textarea rows={2} value={values.notes} onChange={(event) => set("notes", event.target.value)} /></label>
    <div className={styles.formActions}><button type="submit" disabled={busy}>Зберегти видання</button><button type="button" className={styles.dangerLink} disabled={busy} onClick={() => { if (window.confirm(`Вилучити «${resource.title}» і всі його розрахунки з плану?`)) void onMutate({ action: "remove_resource", id: resource.id }, "Видання вилучено з плану."); }}><SiteIcon name="delete" size={15} /> Вилучити</button></div>
  </form>;
}

function NewAllocation({ resource, classes, defaultReserve, busy, onMutate }: { resource: ProcurementPlanResource; classes: ProcurementPlanClass[]; defaultReserve: number; busy: boolean; onMutate: Mutate }) {
  const [classId, setClassId] = useState(classes[0]?.id ?? ""); const [mode, setMode] = useState<ProcurementDemandMode>("per_student"); const [copies, setCopies] = useState("1"); const [fixed, setFixed] = useState("0"); const [reserve, setReserve] = useState(String(defaultReserve));
  const selectedClassId = classes.some((item) => item.id === classId) ? classId : classes[0]?.id ?? "";
  return <form className={styles.allocationForm} onSubmit={(event) => { event.preventDefault(); void onMutate({ action: "upsert_allocation", resourceId: resource.id, classId: selectedClassId, demandMode: mode, copiesPerUnit: Number(copies), fixedQuantity: Number(fixed), reserveQuantity: Number(reserve), notes: "" }, "Клас додано до розрахунку."); }}><label><span>Клас</span><select value={selectedClassId} onChange={(event) => setClassId(event.target.value)}>{classes.map((item) => <option value={item.id} key={item.id}>{item.className}{item.studentCount == null ? " · кількість не внесено" : ` · ${item.studentCount} уч.`}</option>)}</select></label><label><span>Розрахунок</span><select value={mode} onChange={(event) => setMode(event.target.value as ProcurementDemandMode)}><option value="per_student">На кожного учня</option><option value="per_class">На клас</option><option value="fixed">Фіксована кількість</option></select></label>{mode === "fixed" ? <label><span>Фіксовано</span><input type="number" min="0" value={fixed} onChange={(event) => setFixed(event.target.value)} /></label> : <label><span>{mode === "per_student" ? "На одного учня" : "На клас"}</span><input type="number" min="1" value={copies} onChange={(event) => setCopies(event.target.value)} /></label>}<label><span>Резерв</span><input type="number" min="0" value={reserve} onChange={(event) => setReserve(event.target.value)} /></label><button type="submit" disabled={busy || !selectedClassId}><SiteIcon name="add" size={15} /> Додати клас</button></form>;
}

function AllocationEditor({ resource, allocation, busy, onMutate }: { resource: ProcurementPlanResource; allocation: ProcurementAllocation; busy: boolean; onMutate: Mutate }) {
  const [mode, setMode] = useState(allocation.demandMode); const [copies, setCopies] = useState(String(allocation.copiesPerUnit)); const [fixed, setFixed] = useState(String(allocation.fixedQuantity)); const [reserve, setReserve] = useState(String(allocation.reserveQuantity));
  return <form className={styles.allocationRow} onSubmit={(event) => { event.preventDefault(); void onMutate({ action: "upsert_allocation", id: allocation.id, expectedVersion: allocation.version, resourceId: resource.id, classId: allocation.classId, demandMode: mode, copiesPerUnit: Number(copies), fixedQuantity: Number(fixed), reserveQuantity: Number(reserve), notes: allocation.notes }, `Розрахунок для ${allocation.className} збережено.`); }}><strong>{allocation.className}<small>{allocation.studentCount == null ? "Кількість учнів не внесено" : `${allocation.studentCount} учнів`}</small></strong><select aria-label={`Спосіб розрахунку для ${allocation.className}`} value={mode} onChange={(event) => setMode(event.target.value as ProcurementDemandMode)}><option value="per_student">На учня</option><option value="per_class">На клас</option><option value="fixed">Фіксовано</option></select>{mode === "fixed" ? <input aria-label="Фіксована кількість" type="number" min="0" value={fixed} onChange={(event) => setFixed(event.target.value)} /> : <input aria-label="Норма" type="number" min="1" value={copies} onChange={(event) => setCopies(event.target.value)} />}<input aria-label="Резерв" type="number" min="0" value={reserve} onChange={(event) => setReserve(event.target.value)} /><span className={styles.calculated}>{allocation.demandQuantity ?? "—"}<small>потреба</small></span><button type="submit" disabled={busy} aria-label={`Зберегти ${allocation.className}`}><SiteIcon name="success" size={16} /></button><button type="button" disabled={busy} aria-label={`Вилучити ${allocation.className}`} onClick={() => void onMutate({ action: "remove_allocation", id: allocation.id }, "Клас вилучено з розрахунку.")}><SiteIcon name="close" size={16} /></button></form>;
}

function DocumentsSection({ plan, telegramMiniApp, incomplete, busy, onMutate }: { plan: ProcurementPlanDetail; telegramMiniApp: boolean; incomplete: boolean; busy: boolean; onMutate: Mutate }) {
  const snapshotQuery = plan.status === "finalized" && plan.snapshotCount ? "?snapshot=latest" : "";
  const frozenExcel = `/api/librarian/procurement-plans/${encodeURIComponent(plan.id)}/excel?snapshot=latest`;
  const frozenPrint = `/librarian/acquisitions/planning/${encodeURIComponent(plan.id)}/print?snapshot=latest`;
  return <details className={styles.section}><summary><span><small>04 · результат</small><strong>Документи й завершення</strong></span><span>{plan.snapshotCount} збережених версій<SiteIcon name="expand" size={18} /></span></summary><div className={styles.documents}><div className={styles.categoryTable}>{plan.categorySummary.map((row) => <div key={row.category}><strong>{CATEGORY_LABELS[row.category]}</strong><span>{row.resourceCount} найм.</span><span>потреба {row.demandQuantity}</span><span>у фонді {row.usableQuantity}</span><b>замовити {row.toOrderQuantity}{row.incompleteResources ? "*" : ""}</b></div>)}</div><div className={styles.documentActions}><a href={`/api/librarian/procurement-plans/${encodeURIComponent(plan.id)}/excel${snapshotQuery}`}><SiteIcon name="export" size={17} /> Excel {plan.status === "draft" ? "(чернетка)" : ""}</a>{!telegramMiniApp ? <a href={`/librarian/acquisitions/planning/${encodeURIComponent(plan.id)}/print${snapshotQuery}`} target="_blank" rel="noreferrer"><SiteIcon name="reports" size={17} /> Друкований список</a> : null}{plan.status === "draft" && plan.snapshotCount ? <><a href={frozenExcel}><SiteIcon name="count" size={17} /> Останній зафіксований Excel</a>{!telegramMiniApp ? <a href={frozenPrint} target="_blank" rel="noreferrer"><SiteIcon name="count" size={17} /> Останній зафіксований список</a> : null}</> : null}{plan.status === "draft" ? <button type="button" disabled={busy || incomplete || !plan.revisionConfirmedAt} onClick={() => { if (window.confirm("Завершити план і зафіксувати незмінний знімок розрахунку?")) void onMutate({ action: "set_status", status: "finalized", expectedVersion: plan.version }, "План завершено та зафіксовано."); }}><SiteIcon name="success" size={17} /> Завершити план</button> : <button type="button" disabled={busy} onClick={() => { if (window.confirm("Повернути план до редагування? Завершений знімок залишиться в історії.")) void onMutate({ action: "set_status", status: "draft", expectedVersion: plan.version }, "План повернуто до редагування."); }}><SiteIcon name="edit" size={17} /> Відкрити для змін</button>}</div>{plan.status === "draft" ? <p className={styles.finalizationHint}>{incomplete ? "Щоб завершити план, внесіть кількість учнів у всіх класах і завершіть усі розрахунки." : !plan.revisionConfirmedAt ? "Щоб завершити план, підтвердьте ревізію у першому блоці." : "План готовий до завершення. Буде створено незмінний контрольний знімок."}</p> : <p className={styles.finalizationHint}>Завершено {plan.finalizedAt ? new Date(plan.finalizedAt).toLocaleString("uk-UA") : ""}. Excel і друк формуються із зафіксованої версії.</p>}</div></details>;
}

type Mutate = (fields: Record<string, unknown>, successMessage?: string) => Promise<boolean>;
function resourceValues(resource: ProcurementPlanResource) { return { category: resource.category, stockMode: resource.stockMode, title: resource.title, subject: resource.subject, author: resource.author, publisher: resource.publisher, year: resource.publicationYear == null ? "" : String(resource.publicationYear), url: resource.sourceUrl, notes: resource.notes, usable: resource.usableQuantityOverride == null ? "" : String(resource.usableQuantityOverride), incoming: String(resource.additionalIncomingQuantity) }; }
function message(error: unknown) { return error instanceof Error ? error.message : "Сталася помилка."; }
function categoryFromMaterial(material: CatalogPlanningResult): ProcurementCategory { const value = `${material.publicationType} ${material.rubric} ${material.title}`.toLocaleLowerCase("uk-UA"); return /робоч(ий|ого) зошит/u.test(value) ? "workbook" : /контрольн/u.test(value) ? "assessment" : /атлас|контурн/u.test(value) ? "atlas" : /вправ|збірник/u.test(value) ? "exercises" : "textbook"; }
function stockModeFromCategory(category: ProcurementCategory): ProcurementStockMode { return category === "workbook" || category === "assessment" ? "consumable" : "reusable"; }
function nextAcademicYear() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const currentYear = Number(parts.find((part) => part.type === "year")?.value ?? new Date().getFullYear());
  const currentMonth = Number(parts.find((part) => part.type === "month")?.value ?? 1);
  const nextStartYear = currentMonth >= 8 ? currentYear + 1 : currentYear;
  return `${nextStartYear}/${nextStartYear + 1}`;
}
