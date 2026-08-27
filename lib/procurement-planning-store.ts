import type { ChatGPTUser } from "@/app/chatgpt-auth";

type D1Value = string | number | null;
type D1Result<T = Record<string, unknown>> = { results?: T[]; meta?: { changes?: number }; success?: boolean };
type D1Statement = {
  bind(...values: D1Value[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
};

export type ProcurementPlanningDatabase = {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<D1Result[]>;
};

export const PROCUREMENT_CATEGORIES = ["textbook", "workbook", "assessment", "exercises", "atlas", "other"] as const;
export const PROCUREMENT_STOCK_MODES = ["reusable", "consumable"] as const;
export const PROCUREMENT_DEMAND_MODES = ["per_student", "per_class", "fixed"] as const;
export type ProcurementCategory = (typeof PROCUREMENT_CATEGORIES)[number];
export type ProcurementStockMode = (typeof PROCUREMENT_STOCK_MODES)[number];
export type ProcurementDemandMode = (typeof PROCUREMENT_DEMAND_MODES)[number];

export type ProcurementPlanSummary = {
  id: string;
  academicYearLabel: string;
  title: string;
  status: "draft" | "finalized" | "archived";
  defaultReserve: number;
  notes: string;
  classCount: number;
  classCountsMissing: number;
  resourceCount: number;
  version: number;
  updatedAt: string;
};

export type ProcurementPlanClass = {
  id: string;
  className: string;
  grade: number;
  studentCount: number | null;
  notes: string;
  sortOrder: number;
  version: number;
};

export type ProcurementAllocation = {
  id: string;
  classId: string;
  className: string;
  studentCount: number | null;
  demandMode: ProcurementDemandMode;
  copiesPerUnit: number;
  fixedQuantity: number;
  reserveQuantity: number;
  notes: string;
  version: number;
  demandQuantity: number | null;
};

export type ProcurementPlanResource = {
  id: string;
  materialId: string | null;
  category: ProcurementCategory;
  stockMode: ProcurementStockMode;
  subject: string;
  title: string;
  author: string;
  publisher: string;
  publicationYear: number | null;
  sourceUrl: string;
  notes: string;
  usableQuantityOverride: number | null;
  additionalIncomingQuantity: number;
  automaticUsableQuantity: number;
  automaticIncomingQuantity: number;
  usableQuantity: number;
  confirmedIncomingQuantity: number;
  sortOrder: number;
  version: number;
  allocations: ProcurementAllocation[];
  knownDemandQuantity: number;
  demandQuantity: number | null;
  missingStudentCounts: number;
  toOrderQuantity: number | null;
  surplusQuantity: number | null;
};

export type ProcurementCategorySummary = {
  category: ProcurementCategory;
  resourceCount: number;
  demandQuantity: number;
  usableQuantity: number;
  incomingQuantity: number;
  toOrderQuantity: number;
  incompleteResources: number;
};

export type ProcurementPlanDetail = ProcurementPlanSummary & {
  finalizedAt: string | null;
  revisionConfirmedAt: string | null;
  snapshotCount: number;
  classes: ProcurementPlanClass[];
  resources: ProcurementPlanResource[];
  categorySummary: ProcurementCategorySummary[];
  totals: Omit<ProcurementCategorySummary, "category">;
};

export type CatalogPlanningResult = {
  id: string;
  title: string;
  author: string;
  publisher: string;
  publicationYear: number | null;
  subject: string;
  classLabel: string;
  publicationType: string;
  rubric: string;
  sourceUrl: string;
  totalQuantity: number;
  damagedQuantity: number;
  usableQuantity: number;
};

export class ProcurementPlanningError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "ProcurementPlanningError";
    this.code = code;
    this.status = status;
  }
}

export async function listProcurementPlans(db: ProcurementPlanningDatabase): Promise<ProcurementPlanSummary[]> {
  const result = await db.prepare(`
    SELECT p.id, p.academic_year_label, p.title, p.status, p.default_reserve, p.notes,
      p.version, p.updated_at,
      COUNT(DISTINCT pc.id) AS class_count,
      COUNT(DISTINCT CASE WHEN pc.student_count IS NULL THEN pc.id END) AS class_counts_missing,
      COUNT(DISTINCT pr.id) AS resource_count
    FROM procurement_plans p
    LEFT JOIN procurement_plan_classes pc ON pc.plan_id=p.id
    LEFT JOIN procurement_plan_resources pr ON pr.plan_id=p.id
    WHERE p.status != 'archived'
    GROUP BY p.id
    ORDER BY p.updated_at DESC, p.id DESC
    LIMIT 50
  `).all();
  return (result.results ?? []).map(planSummaryRow);
}

export async function readProcurementPlan(db: ProcurementPlanningDatabase, planId: string): Promise<ProcurementPlanDetail> {
  const plan = await db.prepare(`
    SELECT p.id, p.academic_year_label, p.title, p.status, p.default_reserve, p.notes,
      p.version, p.updated_at, p.finalized_at, p.revision_confirmed_at,
      (SELECT COUNT(*) FROM procurement_plan_snapshots ps WHERE ps.plan_id=p.id) AS snapshot_count,
      (SELECT COUNT(*) FROM procurement_plan_classes pc WHERE pc.plan_id=p.id) AS class_count,
      (SELECT COUNT(*) FROM procurement_plan_classes pc WHERE pc.plan_id=p.id AND pc.student_count IS NULL) AS class_counts_missing,
      (SELECT COUNT(*) FROM procurement_plan_resources pr WHERE pr.plan_id=p.id) AS resource_count
    FROM procurement_plans p WHERE p.id=? AND p.status != 'archived' LIMIT 1
  `).bind(planId).first<Record<string, unknown>>();
  if (!plan) throw new ProcurementPlanningError("plan_not_found", 404, "План комплектування не знайдено.");

  const [classResult, resourceResult, allocationResult] = await Promise.all([
    db.prepare(`SELECT id, class_name, grade, student_count, notes, sort_order, version
      FROM procurement_plan_classes WHERE plan_id=? ORDER BY grade, sort_order, class_name, id`).bind(planId).all(),
    db.prepare(`
      SELECT pr.id, pr.material_id, pr.category, pr.stock_mode, pr.title, pr.author,
        pr.subject, pr.publisher, pr.publication_year, pr.source_url, pr.notes,
        pr.usable_quantity_override, pr.additional_incoming_quantity, pr.sort_order, pr.version,
        CASE WHEN pr.material_id IS NULL THEN 0 ELSE MAX(0,
          COALESCE(usable.quantity, 0) - COALESCE(mst.reserved_quantity, 0)
        ) END AS automatic_usable_quantity,
        CASE WHEN pr.material_id IS NULL THEN 0 ELSE COALESCE(incoming.quantity, 0) END AS automatic_incoming_quantity
      FROM procurement_plan_resources pr
      LEFT JOIN material_stock_totals mst ON mst.material_id=pr.material_id
      LEFT JOIN (
        SELECT h.material_id, SUM(h.quantity) AS quantity
        FROM holdings h JOIN locations l ON l.id=h.location_id
        WHERE h.condition != 'damaged' AND l.status='active' AND l.type != 'service'
        GROUP BY h.material_id
      ) usable ON usable.material_id=pr.material_id
      LEFT JOIN (
        SELECT material_id,
          SUM(CASE WHEN ordered_quantity > received_quantity THEN ordered_quantity-received_quantity ELSE 0 END) AS quantity
        FROM acquisition_requests
        WHERE status IN ('ordered','partially_received') AND material_id IS NOT NULL
        GROUP BY material_id
      ) incoming ON incoming.material_id=pr.material_id
      WHERE pr.plan_id=?
      ORDER BY pr.category, pr.sort_order, pr.title, pr.id
    `).bind(planId).all(),
    db.prepare(`
      SELECT pa.id, pa.resource_id, pa.class_id, pc.class_name, pc.student_count,
        pa.demand_mode, pa.copies_per_unit, pa.fixed_quantity, pa.reserve_quantity,
        pa.notes, pa.version
      FROM procurement_plan_allocations pa
      JOIN procurement_plan_resources pr ON pr.id=pa.resource_id AND pr.plan_id=?
      JOIN procurement_plan_classes pc ON pc.id=pa.class_id AND pc.plan_id=pr.plan_id
      ORDER BY pc.grade, pc.sort_order, pc.class_name, pa.id
    `).bind(planId).all(),
  ]);
  const classes = (classResult.results ?? []).map(classRow);
  const allocationRows = allocationResult.results ?? [];
  const resources = (resourceResult.results ?? []).map((raw) => resourceRow(raw, allocationRows));
  const categorySummary = PROCUREMENT_CATEGORIES.map((category) => summarizeCategory(category, resources));
  const totals = categorySummary.reduce<Omit<ProcurementCategorySummary, "category">>((sum, row) => ({
    resourceCount: sum.resourceCount + row.resourceCount,
    demandQuantity: sum.demandQuantity + row.demandQuantity,
    usableQuantity: sum.usableQuantity + row.usableQuantity,
    incomingQuantity: sum.incomingQuantity + row.incomingQuantity,
    toOrderQuantity: sum.toOrderQuantity + row.toOrderQuantity,
    incompleteResources: sum.incompleteResources + row.incompleteResources,
  }), { resourceCount: 0, demandQuantity: 0, usableQuantity: 0, incomingQuantity: 0, toOrderQuantity: 0, incompleteResources: 0 });
  return {
    ...planSummaryRow(plan),
    finalizedAt: nullableText(plan.finalized_at),
    revisionConfirmedAt: nullableText(plan.revision_confirmed_at),
    snapshotCount: nonNegative(plan.snapshot_count),
    classes,
    resources,
    categorySummary,
    totals,
  };
}

export async function readLatestProcurementPlanSnapshot(
  db: ProcurementPlanningDatabase,
  planId: string,
): Promise<ProcurementPlanDetail> {
  const row = await db.prepare(`SELECT payload_json, payload_sha256
    FROM procurement_plan_snapshots WHERE plan_id=? ORDER BY sequence DESC LIMIT 1`)
    .bind(planId).first<{ payload_json: string; payload_sha256: string }>();
  if (!row) throw new ProcurementPlanningError("snapshot_not_found", 404, "Зафіксованої версії цього плану ще немає.");
  if (await sha256(row.payload_json) !== row.payload_sha256) {
    throw new ProcurementPlanningError("snapshot_integrity_failed", 503, "Не вдалося підтвердити цілісність зафіксованого плану.");
  }
  try {
    const payload = JSON.parse(row.payload_json) as { schemaVersion?: unknown; plan?: ProcurementPlanDetail };
    if (payload.schemaVersion !== 1 || !payload.plan || payload.plan.id !== planId) throw new Error("invalid snapshot");
    return payload.plan;
  } catch (error) {
    if (error instanceof ProcurementPlanningError) throw error;
    throw new ProcurementPlanningError("snapshot_invalid", 503, "Зафіксована версія плану пошкоджена.");
  }
}

export async function searchProcurementCatalog(db: ProcurementPlanningDatabase, query: string): Promise<CatalogPlanningResult[]> {
  const normalized = text(query).slice(0, 100);
  if (normalized.length < 2) return [];
  const like = `%${normalized.toLocaleLowerCase("uk-UA")}%`;
  const result = await db.prepare(`
    SELECT m.id, m.title, m.author, m.publisher, m.publication_year, m.subject,
      m.class_from, m.class_to, m.publication_type, m.rubric,
      COALESCE((SELECT ml.url FROM material_links ml WHERE ml.material_id=m.id AND ml.status='active'
        ORDER BY CASE ml.kind WHEN 'ebook' THEN 0 WHEN 'details' THEN 1 WHEN 'publisher' THEN 2 ELSE 3 END, ml.sort_order, ml.id LIMIT 1), '') AS source_url,
      COALESCE(mst.total_quantity, 0) AS total_quantity,
      COALESCE((SELECT SUM(h.quantity) FROM holdings h WHERE h.material_id=m.id AND h.condition='damaged'), 0) AS damaged_quantity
    FROM materials m
    LEFT JOIN material_stock_totals mst ON mst.material_id=m.id
    WHERE m.status='active' AND (
      lower(m.title) LIKE ? OR lower(m.author) LIKE ? OR lower(m.subject) LIKE ? OR lower(m.rubric) LIKE ?
    )
    ORDER BY CASE WHEN lower(m.title) LIKE ? THEN 0 ELSE 1 END, m.sort_title, m.publication_year DESC, m.id
    LIMIT 30
  `).bind(like, like, like, like, `${normalized.toLocaleLowerCase("uk-UA")}%`).all();
  return (result.results ?? []).map((raw) => {
    const row = raw as Record<string, unknown>;
    const totalQuantity = nonNegative(row.total_quantity);
    const damagedQuantity = nonNegative(row.damaged_quantity);
    const classFrom = nullableInteger(row.class_from);
    const classTo = nullableInteger(row.class_to);
    return {
      id: text(row.id), title: text(row.title), author: text(row.author), publisher: text(row.publisher),
      publicationYear: nullableInteger(row.publication_year), subject: text(row.subject),
      classLabel: classFrom == null ? "" : classFrom === classTo ? `${classFrom} клас` : `${classFrom}–${classTo} класи`,
      publicationType: text(row.publication_type), rubric: text(row.rubric), sourceUrl: text(row.source_url),
      totalQuantity, damagedQuantity, usableQuantity: Math.max(0, totalQuantity - damagedQuantity),
    };
  });
}

export async function createProcurementPlan(db: ProcurementPlanningDatabase, user: ChatGPTUser, input: {
  academicYearLabel: string; title: string; defaultReserve: number; notes: string;
}): Promise<ProcurementPlanDetail> {
  const actor = await mutationActor(db, user);
  const academicYearLabel = requiredText(input.academicYearLabel, 30, "Вкажіть навчальний рік.");
  if (!/^20\d{2}[/-]20\d{2}$/u.test(academicYearLabel)) throw new ProcurementPlanningError("validation_failed", 400, "Навчальний рік має формат 2027/2028.");
  const id = `PPLAN-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  try {
    await db.prepare(`INSERT INTO procurement_plans (
      id, academic_year_id, academic_year_label, title, status, default_reserve, notes,
      revision_confirmed_at, revision_confirmed_by_user_id,
      finalized_at, finalized_by_user_id, created_by_user_id, version, created_at, updated_at
    ) VALUES (?, (SELECT id FROM academic_years WHERE label=? LIMIT 1), ?, ?, 'draft', ?, ?, NULL, NULL, NULL, NULL, ?, 1, ?, ?)`)
      .bind(id, academicYearLabel, academicYearLabel, requiredText(input.title, 160, "Вкажіть назву плану."), boundedInteger(input.defaultReserve, 0, 1000), boundedText(input.notes, 2000), actor.id, now, now).run();
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed")) throw new ProcurementPlanningError("plan_exists", 409, "План для цього навчального року вже існує.");
    throw error;
  }
  await audit(db, actor, "procurement_plan.created", "procurement_plan", id, null, { academicYearLabel }, now);
  return readProcurementPlan(db, id);
}

export async function mutateProcurementPlan(db: ProcurementPlanningDatabase, user: ChatGPTUser, planId: string, input: Record<string, unknown>): Promise<ProcurementPlanDetail> {
  const actor = await mutationActor(db, user);
  const action = text(input.action);
  await requireEditablePlan(db, planId, action === "set_status");
  const now = new Date().toISOString();
  try {
  if (action === "update_plan") {
    const expectedVersion = positiveInteger(input.expectedVersion);
    const revisionConfirmed = input.revisionConfirmed === true;
    const result = await db.prepare(`UPDATE procurement_plans SET title=?, default_reserve=?, notes=?,
      revision_confirmed_at=?, revision_confirmed_by_user_id=?, version=version+1, updated_at=?
      WHERE id=? AND version=? AND status='draft'`).bind(requiredText(input.title, 160, "Вкажіть назву плану."), boundedInteger(input.defaultReserve, 0, 1000), boundedText(input.notes, 2000), revisionConfirmed ? now : null, revisionConfirmed ? actor.id : null, now, planId, expectedVersion).run();
    requireChange(result, "План уже змінився. Оновіть сторінку.");
    await audit(db, actor, "procurement_plan.updated", "procurement_plan", planId, null, { expectedVersion }, now);
  } else if (action === "set_status") {
    const nextStatus = input.status === "finalized" ? "finalized" : input.status === "draft" ? "draft" : "";
    if (!nextStatus) throw new ProcurementPlanningError("validation_failed", 400, "Некоректний статус плану.");
    const expectedVersion = positiveInteger(input.expectedVersion);
    if (nextStatus === "finalized") {
      const detail = await readProcurementPlan(db, planId);
      if (detail.version !== expectedVersion || detail.status !== "draft") {
        throw new ProcurementPlanningError("version_conflict", 409, "Статус плану вже змінився. Оновіть сторінку.");
      }
      if (detail.classCountsMissing || detail.totals.incompleteResources) throw new ProcurementPlanningError("plan_incomplete", 409, "Внесіть кількість учнів у всіх класах перед завершенням плану.");
      if (!detail.revisionConfirmedAt) throw new ProcurementPlanningError("revision_not_confirmed", 409, "Підтвердьте завершення ревізії перед фіналізацією плану.");
      const outstanding = await db.prepare(`SELECT
        COALESCE((SELECT SUM(li.quantity_issued-li.quantity_returned) FROM loan_items li JOIN loans l ON l.id=li.loan_id WHERE l.status='open' AND li.quantity_issued>li.quantity_returned),0)
        + COALESCE((SELECT SUM(cli.quantity_issued-cli.quantity_returned) FROM class_loan_items cli JOIN class_loans cl ON cl.id=cli.class_loan_id WHERE cl.status='open' AND cli.quantity_issued>cli.quantity_returned),0) AS quantity`).first<{ quantity: number }>();
      if (nonNegative(outstanding?.quantity) > 0) throw new ProcurementPlanningError("open_loans", 409, "Перед завершенням плану потрібно оформити всі повернення.");
      const payload = JSON.stringify({
        schemaVersion: 1,
        generatedAt: now,
        inventoryCutoffAt: now,
        plan: { ...detail, status: "finalized", finalizedAt: now, version: expectedVersion + 1, snapshotCount: detail.snapshotCount + 1 },
      });
      if (new TextEncoder().encode(payload).byteLength > 2_000_000) throw new ProcurementPlanningError("snapshot_too_large", 413, "План завеликий для безпечної фіналізації.");
      const sequence = await nextSnapshotSequence(db, planId);
      const results = await db.batch([
        db.prepare(`UPDATE procurement_plans SET status='finalized', finalized_at=?, finalized_by_user_id=?, version=version+1, updated_at=?
          WHERE id=? AND version=? AND status='draft'`).bind(now, actor.id, now, planId, expectedVersion),
        db.prepare(`INSERT INTO procurement_plan_snapshots (id, plan_id, sequence, schema_version, payload_json, payload_sha256, inventory_cutoff_at, created_by_user_id, created_at)
          VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`)
          .bind(`PSNAP-${crypto.randomUUID()}`, planId, sequence, payload, await sha256(payload), now, actor.id, now),
      ]);
      requireChange(results[0] ?? {}, "Статус плану вже змінився. Оновіть сторінку.");
      await audit(db, actor, "procurement_plan.finalized", "procurement_plan", planId, null, { expectedVersion, snapshotSequence: sequence }, now);
      return readProcurementPlan(db, planId);
    }
    const result = await db.prepare(`UPDATE procurement_plans SET status='draft', finalized_at=NULL, finalized_by_user_id=NULL, version=version+1, updated_at=?
      WHERE id=? AND version=? AND status='finalized'`).bind(now, planId, expectedVersion).run();
    requireChange(result, "Статус плану вже змінився. Оновіть сторінку.");
    await audit(db, actor, `procurement_plan.${nextStatus}`, "procurement_plan", planId, null, { expectedVersion }, now);
  } else if (action === "upsert_class") {
    await upsertClass(db, actor, planId, input, now);
  } else if (action === "prefill_classes") {
    await prefillClasses(db, actor, planId, now);
  } else if (action === "remove_class") {
    await removeClass(db, actor, planId, input, now);
  } else if (action === "upsert_resource") {
    await upsertResource(db, actor, planId, input, now);
  } else if (action === "remove_resource") {
    await removeResource(db, actor, planId, input, now);
  } else if (action === "upsert_allocation") {
    await upsertAllocation(db, actor, planId, input, now);
  } else if (action === "remove_allocation") {
    await removeAllocation(db, actor, planId, input, now);
  } else {
    throw new ProcurementPlanningError("invalid_action", 400, "Така дія не підтримується.");
  }
  } catch (error) {
    if (String(error).includes("procurement_plan_locked")) {
      throw new ProcurementPlanningError("plan_locked", 409, "План уже завершено. Оновіть сторінку.");
    }
    if (String(error).includes("procurement_plan_snapshot_parent_not_finalized")) {
      throw new ProcurementPlanningError("version_conflict", 409, "План змінився під час завершення. Оновіть сторінку й перевірте розрахунок.");
    }
    throw error;
  }
  return readProcurementPlan(db, planId);
}

async function prefillClasses(db: ProcurementPlanningDatabase, actor: Actor, planId: string, now: string) {
  const result = await db.prepare(`
    SELECT cy.id, cy.class_name, cy.grade, cy.code
    FROM class_years cy
    JOIN academic_years ay ON ay.id=cy.academic_year_id
    WHERE cy.status='active' AND ay.status='active' AND cy.grade < 11
    ORDER BY cy.grade, cy.class_name, cy.id
    LIMIT 200
  `).all<Record<string, unknown>>();
  let inserted = 0;
  for (const raw of result.results ?? []) {
    const grade = positiveInteger(raw.grade) + 1;
    const code = text(raw.code);
    const sourceName = text(raw.class_name);
    const className = promotedClassName(sourceName, grade, code);
    const change = await db.prepare(`INSERT OR IGNORE INTO procurement_plan_classes
      (id, plan_id, source_class_year_id, class_name, grade, student_count, notes, sort_order, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, '', ?, 1, ?, ?)`)
      .bind(`PCLASS-${crypto.randomUUID()}`, planId, text(raw.id), className, grade, grade * 100, now, now).run();
    inserted += Number(change.meta?.changes ?? 0);
  }
  await audit(db, actor, "procurement_classes.prefilled", "procurement_plan", planId, null, { inserted }, now);
}

function promotedClassName(sourceName: string, grade: number, code: string): string {
  const suffix = sourceName.replace(/^\s*\d{1,2}\s*[-–—]?\s*/u, "").trim();
  const normalizedCode = suffix || code.replace(/^\s*\d{1,2}\s*[-–—]?\s*/u, "").trim();
  return normalizedCode ? `${grade}-${normalizedCode}` : String(grade);
}

async function upsertClass(db: ProcurementPlanningDatabase, actor: Actor, planId: string, input: Record<string, unknown>, now: string) {
  const id = nullableText(input.id);
  const className = requiredText(input.className, 50, "Вкажіть назву класу.");
  const grade = boundedInteger(input.grade, 1, 11);
  const studentCount = optionalBoundedInteger(input.studentCount, 0, 500);
  const notes = boundedText(input.notes, 500);
  const sortOrder = boundedInteger(input.sortOrder, 0, 10000);
  if (!id) {
    const newId = `PCLASS-${crypto.randomUUID()}`;
    try {
      await db.prepare(`INSERT INTO procurement_plan_classes (id, plan_id, class_name, grade, student_count, notes, sort_order, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .bind(newId, planId, className, grade, studentCount, notes, sortOrder, now, now).run();
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) throw new ProcurementPlanningError("class_exists", 409, "Такий клас уже є в плані.");
      throw error;
    }
    await audit(db, actor, "procurement_class.created", "procurement_plan_class", newId, null, { planId, className }, now);
    return;
  }
  const expectedVersion = positiveInteger(input.expectedVersion);
  const result = await db.prepare(`UPDATE procurement_plan_classes SET class_name=?, grade=?, student_count=?, notes=?, sort_order=?, version=version+1, updated_at=?
    WHERE id=? AND plan_id=? AND version=?`).bind(className, grade, studentCount, notes, sortOrder, now, id, planId, expectedVersion).run();
  requireChange(result, "Клас уже змінився. Оновіть сторінку.");
  await audit(db, actor, "procurement_class.updated", "procurement_plan_class", id, null, { planId, className }, now);
}

async function removeClass(db: ProcurementPlanningDatabase, actor: Actor, planId: string, input: Record<string, unknown>, now: string) {
  const id = requiredId(input.id);
  const result = await db.prepare(`DELETE FROM procurement_plan_classes WHERE id=? AND plan_id=?`).bind(id, planId).run();
  requireChange(result, "Клас уже вилучено або його не знайдено.");
  await audit(db, actor, "procurement_class.removed", "procurement_plan_class", id, null, { planId }, now);
}

async function upsertResource(db: ProcurementPlanningDatabase, actor: Actor, planId: string, input: Record<string, unknown>, now: string) {
  const id = nullableText(input.id);
  const category = enumValue(input.category, PROCUREMENT_CATEGORIES, "Оберіть категорію.");
  const stockMode = enumValue(input.stockMode, PROCUREMENT_STOCK_MODES, "Оберіть спосіб обліку.");
  const materialId = optionalId(input.materialId);
  let title = requiredText(input.title, 300, "Вкажіть назву видання.");
  let subject = boundedText(input.subject, 200);
  let author = boundedText(input.author, 300);
  let publisher = boundedText(input.publisher, 200);
  let publicationYear = optionalBoundedInteger(input.publicationYear, 1000, 2100);
  let sourceUrl = safeUrl(input.sourceUrl);
  if (!id && materialId) {
    const material = await db.prepare(`SELECT m.title, m.subject, m.author, m.publisher, m.publication_year,
      COALESCE((SELECT ml.url FROM material_links ml WHERE ml.material_id=m.id AND ml.status='active'
        ORDER BY CASE ml.kind WHEN 'ebook' THEN 0 WHEN 'details' THEN 1 WHEN 'publisher' THEN 2 ELSE 3 END, ml.sort_order, ml.id LIMIT 1), '') AS source_url
      FROM materials m WHERE m.id=? AND m.status='active' LIMIT 1`).bind(materialId).first<Record<string, unknown>>();
    if (!material) throw new ProcurementPlanningError("material_not_found", 404, "Видання з каталогу не знайдено.");
    title = text(material.title); subject = text(material.subject); author = text(material.author); publisher = text(material.publisher);
    publicationYear = nullableInteger(material.publication_year); sourceUrl = text(material.source_url);
  }
  const values = [category, stockMode, subject, title, author, publisher, publicationYear, sourceUrl,
    boundedText(input.notes, 1000), optionalBoundedInteger(input.usableQuantityOverride, 0, 100000),
    boundedInteger(input.additionalIncomingQuantity, 0, 100000), boundedInteger(input.sortOrder, 0, 10000)] as const;
  if (!id) {
    const newId = `PRES-${crypto.randomUUID()}`;
    try {
      await db.prepare(`INSERT INTO procurement_plan_resources (id, plan_id, material_id, category, stock_mode, subject, title, author, publisher, publication_year, source_url, notes, usable_quantity_override, additional_incoming_quantity, sort_order, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .bind(newId, planId, materialId, ...values, now, now).run();
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) throw new ProcurementPlanningError("resource_exists", 409, "Це видання вже додано до плану.");
      throw error;
    }
    await audit(db, actor, "procurement_resource.created", "procurement_plan_resource", newId, null, { planId, materialId, title }, now);
    return;
  }
  const expectedVersion = positiveInteger(input.expectedVersion);
  const result = await db.prepare(`UPDATE procurement_plan_resources SET category=?, stock_mode=?, subject=?, title=?, author=?, publisher=?, publication_year=?, source_url=?, notes=?, usable_quantity_override=?, additional_incoming_quantity=?, sort_order=?, version=version+1, updated_at=?
    WHERE id=? AND plan_id=? AND version=?`).bind(...values, now, id, planId, expectedVersion).run();
  requireChange(result, "Видання вже змінилося. Оновіть сторінку.");
  await audit(db, actor, "procurement_resource.updated", "procurement_plan_resource", id, null, { planId, title }, now);
}

async function removeResource(db: ProcurementPlanningDatabase, actor: Actor, planId: string, input: Record<string, unknown>, now: string) {
  const id = requiredId(input.id);
  const result = await db.prepare(`DELETE FROM procurement_plan_resources WHERE id=? AND plan_id=?`).bind(id, planId).run();
  requireChange(result, "Видання вже вилучено або його не знайдено.");
  await audit(db, actor, "procurement_resource.removed", "procurement_plan_resource", id, null, { planId }, now);
}

async function upsertAllocation(db: ProcurementPlanningDatabase, actor: Actor, planId: string, input: Record<string, unknown>, now: string) {
  const id = nullableText(input.id);
  const resourceId = requiredId(input.resourceId);
  const classId = requiredId(input.classId);
  const validPair = await db.prepare(`SELECT pr.id FROM procurement_plan_resources pr JOIN procurement_plan_classes pc ON pc.plan_id=pr.plan_id
    WHERE pr.id=? AND pc.id=? AND pr.plan_id=? LIMIT 1`).bind(resourceId, classId, planId).first();
  if (!validPair) throw new ProcurementPlanningError("allocation_scope_invalid", 409, "Клас і видання належать до різних планів.");
  const demandMode = enumValue(input.demandMode, PROCUREMENT_DEMAND_MODES, "Оберіть спосіб розрахунку.");
  const copiesPerUnit = boundedInteger(input.copiesPerUnit, 1, 100);
  const fixedQuantity = boundedInteger(input.fixedQuantity, 0, 100000);
  const reserveQuantity = boundedInteger(input.reserveQuantity, 0, 1000);
  const notes = boundedText(input.notes, 500);
  if (!id) {
    const newId = `PALLOC-${crypto.randomUUID()}`;
    try {
      await db.prepare(`INSERT INTO procurement_plan_allocations (id, resource_id, class_id, demand_mode, copies_per_unit, fixed_quantity, reserve_quantity, notes, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .bind(newId, resourceId, classId, demandMode, copiesPerUnit, fixedQuantity, reserveQuantity, notes, now, now).run();
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) throw new ProcurementPlanningError("allocation_exists", 409, "Для цього класу розрахунок уже додано.");
      throw error;
    }
    await audit(db, actor, "procurement_allocation.created", "procurement_plan_allocation", newId, null, { planId, resourceId, classId }, now);
    return;
  }
  const expectedVersion = positiveInteger(input.expectedVersion);
  const result = await db.prepare(`UPDATE procurement_plan_allocations SET class_id=?, demand_mode=?, copies_per_unit=?, fixed_quantity=?, reserve_quantity=?, notes=?, version=version+1, updated_at=?
    WHERE id=? AND resource_id=? AND version=?`).bind(classId, demandMode, copiesPerUnit, fixedQuantity, reserveQuantity, notes, now, id, resourceId, expectedVersion).run();
  requireChange(result, "Розрахунок уже змінився. Оновіть сторінку.");
  await audit(db, actor, "procurement_allocation.updated", "procurement_plan_allocation", id, null, { planId, resourceId, classId }, now);
}

async function removeAllocation(db: ProcurementPlanningDatabase, actor: Actor, planId: string, input: Record<string, unknown>, now: string) {
  const id = requiredId(input.id);
  const result = await db.prepare(`DELETE FROM procurement_plan_allocations WHERE id=? AND resource_id IN (SELECT id FROM procurement_plan_resources WHERE plan_id=?)`).bind(id, planId).run();
  requireChange(result, "Розрахунок уже вилучено або його не знайдено.");
  await audit(db, actor, "procurement_allocation.removed", "procurement_plan_allocation", id, null, { planId }, now);
}

function resourceRow(raw: Record<string, unknown>, allocationRows: Record<string, unknown>[]): ProcurementPlanResource {
  const row = raw as Record<string, unknown>;
  const stockMode = enumValue(row.stock_mode, PROCUREMENT_STOCK_MODES, "Некоректний спосіб обліку.");
  const automaticUsableQuantity = nonNegative(row.automatic_usable_quantity);
  const override = nullableInteger(row.usable_quantity_override);
  const usableQuantity = override ?? (stockMode === "consumable" ? 0 : automaticUsableQuantity);
  const automaticIncomingQuantity = nonNegative(row.automatic_incoming_quantity);
  const additionalIncomingQuantity = nonNegative(row.additional_incoming_quantity);
  const allocations = allocationRows.filter((value) => text(value.resource_id) === text(row.id)).map(allocationRow);
  const missingStudentCounts = allocations.filter((item) => item.demandQuantity == null).length;
  const knownDemandQuantity = allocations.reduce((sum, item) => sum + (item.demandQuantity ?? 0), 0);
  const demandQuantity = missingStudentCounts ? null : knownDemandQuantity;
  const confirmedIncomingQuantity = automaticIncomingQuantity + additionalIncomingQuantity;
  const balance = demandQuantity == null ? null : usableQuantity + confirmedIncomingQuantity - demandQuantity;
  return {
    id: text(row.id), materialId: nullableText(row.material_id),
    category: enumValue(row.category, PROCUREMENT_CATEGORIES, "Некоректна категорія."), stockMode,
    subject: text(row.subject), title: text(row.title), author: text(row.author), publisher: text(row.publisher), publicationYear: nullableInteger(row.publication_year),
    sourceUrl: text(row.source_url), notes: text(row.notes), usableQuantityOverride: override,
    additionalIncomingQuantity, automaticUsableQuantity, automaticIncomingQuantity, usableQuantity,
    confirmedIncomingQuantity, sortOrder: nonNegative(row.sort_order), version: positiveInteger(row.version), allocations,
    knownDemandQuantity, demandQuantity, missingStudentCounts,
    toOrderQuantity: balance == null ? null : Math.max(0, -balance),
    surplusQuantity: balance == null ? null : Math.max(0, balance),
  };
}

function allocationRow(raw: Record<string, unknown>): ProcurementAllocation {
  const mode = enumValue(raw.demand_mode, PROCUREMENT_DEMAND_MODES, "Некоректний спосіб розрахунку.");
  const studentCount = nullableInteger(raw.student_count);
  const copiesPerUnit = positiveInteger(raw.copies_per_unit);
  const fixedQuantity = nonNegative(raw.fixed_quantity);
  const reserveQuantity = nonNegative(raw.reserve_quantity);
  const base = mode === "per_student" ? (studentCount == null ? null : studentCount * copiesPerUnit) : mode === "per_class" ? copiesPerUnit : fixedQuantity;
  return {
    id: text(raw.id), classId: text(raw.class_id), className: text(raw.class_name), studentCount,
    demandMode: mode, copiesPerUnit, fixedQuantity, reserveQuantity, notes: text(raw.notes), version: positiveInteger(raw.version),
    demandQuantity: base == null ? null : base + reserveQuantity,
  };
}

function summarizeCategory(category: ProcurementCategory, resources: ProcurementPlanResource[]): ProcurementCategorySummary {
  const rows = resources.filter((item) => item.category === category);
  return rows.reduce<ProcurementCategorySummary>((sum, item) => ({
    ...sum,
    resourceCount: sum.resourceCount + 1,
    demandQuantity: sum.demandQuantity + item.knownDemandQuantity,
    usableQuantity: sum.usableQuantity + item.usableQuantity,
    incomingQuantity: sum.incomingQuantity + item.confirmedIncomingQuantity,
    toOrderQuantity: sum.toOrderQuantity + (item.toOrderQuantity ?? 0),
    incompleteResources: sum.incompleteResources + (item.demandQuantity == null ? 1 : 0),
  }), { category, resourceCount: 0, demandQuantity: 0, usableQuantity: 0, incomingQuantity: 0, toOrderQuantity: 0, incompleteResources: 0 });
}

function planSummaryRow(raw: Record<string, unknown>): ProcurementPlanSummary {
  return {
    id: text(raw.id), academicYearLabel: text(raw.academic_year_label), title: text(raw.title),
    status: text(raw.status) as ProcurementPlanSummary["status"], defaultReserve: nonNegative(raw.default_reserve), notes: text(raw.notes),
    classCount: nonNegative(raw.class_count), classCountsMissing: nonNegative(raw.class_counts_missing), resourceCount: nonNegative(raw.resource_count),
    version: positiveInteger(raw.version), updatedAt: text(raw.updated_at),
  };
}

function classRow(raw: Record<string, unknown>): ProcurementPlanClass {
  return { id: text(raw.id), className: text(raw.class_name), grade: positiveInteger(raw.grade), studentCount: nullableInteger(raw.student_count), notes: text(raw.notes), sortOrder: nonNegative(raw.sort_order), version: positiveInteger(raw.version) };
}

type Actor = { id: string; email: string };
async function mutationActor(db: ProcurementPlanningDatabase, user: ChatGPTUser): Promise<Actor> {
  const row = await db.prepare(`SELECT id, COALESCE(email, ?) AS email FROM users
    WHERE status='active' AND role IN ('admin','librarian') AND (id=? OR auth_user_id=? OR lower(COALESCE(email,''))=lower(?))
    ORDER BY CASE WHEN id=? THEN 0 WHEN auth_user_id=? THEN 1 ELSE 2 END LIMIT 1`)
    .bind(user.email, user.d1UserId ?? "", user.userId, user.email, user.d1UserId ?? "", user.userId).first<{ id: string; email: string }>();
  if (!row) throw new ProcurementPlanningError("actor_not_found", 403, "Не вдалося підтвердити обліковий запис бібліотекаря.");
  return { id: row.id, email: row.email || user.email };
}

async function requireEditablePlan(db: ProcurementPlanningDatabase, planId: string, allowFinalized: boolean) {
  const row = await db.prepare(`SELECT id, status FROM procurement_plans WHERE id=? AND status != 'archived' LIMIT 1`).bind(planId).first<{ id: string; status: string }>();
  if (!row) throw new ProcurementPlanningError("plan_not_found", 404, "План комплектування не знайдено.");
  if (!allowFinalized && row.status !== "draft") throw new ProcurementPlanningError("plan_locked", 409, "Завершений план спочатку потрібно повернути до редагування.");
  return row;
}

async function audit(db: ProcurementPlanningDatabase, actor: Actor, action: string, entityType: string, entityId: string, before: unknown, after: unknown, now: string) {
  await db.prepare(`INSERT INTO audit_events (id, actor_user_id, actor_email, action, entity_type, entity_id, request_id, before_json, after_json, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?)`)
    .bind(`AUD-${crypto.randomUUID()}`, actor.id, actor.email, action, entityType, entityId, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), now).run();
}

async function nextSnapshotSequence(db: ProcurementPlanningDatabase, planId: string): Promise<number> {
  const row = await db.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM procurement_plan_snapshots WHERE plan_id=?`).bind(planId).first<{ sequence: number }>();
  return positiveInteger(row?.sequence);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requireChange(result: D1Result, message: string) {
  if (Number(result.meta?.changes ?? 0) !== 1) throw new ProcurementPlanningError("version_conflict", 409, message);
}
function text(value: unknown) { return String(value ?? "").trim(); }
function nullableText(value: unknown) { const valueText = text(value); return valueText || null; }
function boundedText(value: unknown, max: number) { return text(value).slice(0, max); }
function requiredText(value: unknown, max: number, message: string) { const result = boundedText(value, max); if (!result) throw new ProcurementPlanningError("validation_failed", 400, message); return result; }
function requiredId(value: unknown) { const result = text(value); if (!/^[A-Za-z0-9_-]{8,100}$/u.test(result)) throw new ProcurementPlanningError("validation_failed", 400, "Некоректний ідентифікатор."); return result; }
function optionalId(value: unknown) { const result = nullableText(value); return result ? requiredId(result) : null; }
function positiveInteger(value: unknown) { const number = Number(value); return Number.isSafeInteger(number) && number > 0 ? number : 1; }
function nonNegative(value: unknown) { const number = Number(value); return Number.isSafeInteger(number) && number >= 0 ? number : 0; }
function nullableInteger(value: unknown) { if (value == null || value === "") return null; const number = Number(value); return Number.isSafeInteger(number) ? number : null; }
function boundedInteger(value: unknown, min: number, max: number) { const number = Number(value); if (!Number.isSafeInteger(number) || number < min || number > max) throw new ProcurementPlanningError("validation_failed", 400, "Перевірте числові значення."); return number; }
function optionalBoundedInteger(value: unknown, min: number, max: number) { if (value == null || value === "") return null; return boundedInteger(value, min, max); }
function enumValue<T extends readonly string[]>(value: unknown, values: T, message: string): T[number] { const result = text(value); if (!(values as readonly string[]).includes(result)) throw new ProcurementPlanningError("validation_failed", 400, message); return result as T[number]; }
function safeUrl(value: unknown) { const result = boundedText(value, 1000); if (!result) return ""; try { const url = new URL(result); if (!['https:', 'http:'].includes(url.protocol)) throw new Error(); return url.toString(); } catch { throw new ProcurementPlanningError("validation_failed", 400, "Покликання має починатися з http:// або https://."); } }
