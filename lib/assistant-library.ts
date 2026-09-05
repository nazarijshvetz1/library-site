import { assistantTools, type AssistantRole, type AssistantToolResult, type AssistantCard } from "./assistant-contract.ts";
import { getCatalogMaterialDetail, normalizeCatalogId, type CatalogD1Database } from "./catalog-d1.ts";
import { searchAssistantCatalog } from "./assistant-search.ts";
import { listOpenClassLoans, listOpenLoans, readLibraryReferenceData } from "./library-directory-store.ts";
import { ASSISTANT_ACTIONS, isAssistantAction, prepareAssistantAction, readAssistantLoans } from "./assistant-actions.ts";
import { isLibrarianReportKind, readLibrarianReport } from "./librarian-report-store.ts";
import { listCatalogMaterialFacets, normalizeCatalogSearchText } from "./catalog-d1.ts";
import { listTeacherMaterialRequestPage, type TeacherMaterialRequestDatabase } from "./teacher-material-request-store.ts";
import { readVisitSchedule, VisitScheduleError, type VisitD1Database } from "./visit-schedule-store.ts";
import { addDays, kyivLocalNow, parseVisitRange } from "./visit-schedule-validation.ts";
import { freeVisitIntervals, prepareAssistantVisit, validateAssistantVisit } from "./assistant-store.ts";
import { runTeacherAssistantTool } from "./assistant-teacher-tools.ts";
import type { AssistantCartSnapshot } from "./teacher-cart.ts";

export function validatedToolArguments(role: AssistantRole, name: string, input: unknown): Record<string, unknown> {
  const definition = assistantTools(role).find((item) => item.name === name);
  if (!definition) throw new VisitScheduleError("assistant_tool_denied", 403, "Ця дія недоступна для вашого режиму.");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new VisitScheduleError("invalid_tool_arguments", 400, "Некоректні параметри запиту.");
  const args = input as Record<string, unknown>;
  for (const key of definition.parameters.required ?? []) if (!(key in args)) throw new VisitScheduleError("invalid_tool_arguments", 400, "Потрібно уточнити параметри запиту.");
  for (const [key, value] of Object.entries(args)) {
    const rule = definition.parameters.properties[key] as { type: string | string[]; minimum?: number; maximum?: number } | undefined;
    if (!rule) throw new VisitScheduleError("invalid_tool_arguments", 400, "Невідоме поле запиту.");
    const kinds = Array.isArray(rule.type) ? rule.type : [rule.type];
    const kind = value === null ? "null" : typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
    if (!kinds.includes(kind) || (typeof value === "string" && (value.length > (key === "cursor" ? 1500 : 180) || [...value].some((character) => character.charCodeAt(0) < 32)))
      || (value !== null && typeof value === "object" && (Array.isArray(value) || JSON.stringify(value).length > 6000))
      || (typeof value === "number" && (value < (rule.minimum ?? -Infinity) || value > (rule.maximum ?? Infinity)))) {
      throw new VisitScheduleError("invalid_tool_arguments", 400, "Перевірте формат параметрів запиту.");
    }
  }
  return args;
}

function displayDate(value: string | null): string {
  if (!value) return "строк не встановлено";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", dateStyle: "medium" }).format(parsed);
}

export async function runAssistantLibraryTool(db: VisitD1Database & CatalogD1Database, context: { role: AssistantRole; actorKey: string; teacherUserId?: string; sessionId: string; bookingEnabled: boolean; scheduleEnabled: boolean; librarianWritesEnabled?: boolean; teacherWritesEnabled?: boolean; cart?: AssistantCartSnapshot }, name: string, input: unknown): Promise<AssistantToolResult> {
  const args = validatedToolArguments(context.role, name, input);
  if (context.role === "teacher" && context.teacherUserId) {
    const result = await runTeacherAssistantTool(db, { actorKey: context.actorKey, teacherUserId: context.teacherUserId, sessionId: context.sessionId, cart: context.cart ?? { items: [], notes: "" }, writesEnabled: Boolean(context.teacherWritesEnabled), bookingEnabled: context.bookingEnabled }, name, args);
    if (result) return result;
  }
  const now = kyivLocalNow();
  if (name === "librarian_reference") {
    const [reference, facets, classes] = await Promise.all([readLibraryReferenceData(db), listCatalogMaterialFacets(db),
      db.prepare("SELECT id,class_name AS name,grade,academic_year_id AS academicYearId,version FROM class_years WHERE status='active' ORDER BY grade,code LIMIT 200").all<Record<string, unknown>>()]);
    const words = normalizeCatalogSearchText(args.query).split(" ").filter(Boolean);
    const matches = (row: unknown) => words.every((word) => normalizeCatalogSearchText(JSON.stringify(row)).includes(word));
    const teachers = reference.teachers.filter(matches); const locations = reference.locations.filter(matches); const schoolClasses = (classes.results ?? []).filter(matches);
    return { success: true, data: { teachers: teachers.slice(0, 30), locations: locations.slice(0, 30), classes: schoolClasses.slice(0, 30), facets,
      truncated: teachers.length > 30 || locations.length > 30 || schoolClasses.length > 30 },
      cards: teachers.slice(0, 30).map((t) => ({ kind: "loan", id: t.id, title: t.fullName, description: t.subjectPosition, image: t.photoUrl ?? undefined, details: [t.id, t.primaryLocation?.name ?? "Кабінет не зазначено"] })) };
  }
  if (name === "librarian_loans") {
    const result = await readAssistantLoans(db, String(args.teacherUserId ?? ""), args.overdueOnly === true);
    return { success: true, data: result, cards: [...result.personal.map((loan) => ({ kind: "loan" as const, id: loan.loanId, title: loan.teacherName,
      description: `Видано ${displayDate(loan.issuedAt)} · повернути ${displayDate(loan.dueAt)}`, details: loan.items.map((i) => `${i.materialTitle}: ${i.quantityOutstanding} прим. (${i.loanItemId})`) })),
      ...result.classes.map((loan) => ({ kind: "loan" as const, id: loan.classLoanId, title: `${loan.className} · ${loan.responsibleTeacherName}`, description: `Повернути ${displayDate(loan.dueAt)}`,
        details: loan.items.map((i) => `${i.materialTitle}: ${i.quantityOutstanding} прим. (${i.classLoanItemId})`) }))] };
  }
  if (name === "material_history") {
    const id = normalizeCatalogId(args.materialId); if (!id) throw new VisitScheduleError("invalid_material", 400, "Оберіть матеріал із пошуку.");
    const history = await db.prepare(`SELECT * FROM (
      SELECT t.id,t.kind,t.occurred_at AS date,t.document_number AS document,l.name AS location,NULL AS className,
      i.quantity_delta AS quantityDelta,i.condition FROM inventory_transaction_lines i JOIN inventory_transactions t ON t.id=i.transaction_id
      LEFT JOIN locations l ON l.id=i.location_id WHERE i.material_id=?
      UNION ALL
      SELECT t.id,CASE WHEN a.id IS NULL THEN t.kind ELSE 'adjustment_'||a.action END AS kind,t.occurred_at AS date,NULL AS document,l.name AS location,cy.class_name AS className,
      i.quantity_delta AS quantityDelta,i.condition FROM class_loan_transaction_lines i JOIN class_loan_transactions t ON t.id=i.transaction_id
      JOIN class_loans cl ON cl.id=t.class_loan_id JOIN class_years cy ON cy.id=cl.class_year_id
      LEFT JOIN class_loan_item_adjustments a ON a.transaction_id=t.id
      LEFT JOIN locations l ON l.id=i.location_id WHERE i.material_id=?
      ) ORDER BY date DESC,id DESC LIMIT 31`).bind(id, id).all();
    return { success: true, data: { materialId: id, rows: history.results?.slice(0, 30), truncated: (history.results?.length ?? 0) > 30 } };
  }
  if (name === "library_action_schema") {
    if (!isAssistantAction(args.action)) throw new VisitScheduleError("invalid_action", 400, "Невідома дія. Використайте підтримуваний тип.");
    return { success: true, data: { action: args.action, ...ASSISTANT_ACTIONS[args.action], conditions: { unspecified: "Стан не зазначений", good: "Добрий стан", worn: "Зношений", damaged: "Пошкоджений" }, requiresButtonConfirmation: true } };
  }
  if (name === "prepare_library_action") {
    if (!context.librarianWritesEnabled) throw new VisitScheduleError("assistant_writes_disabled", 403, "Зміни через Джарвіса зараз вимкнені.");
    const actionPreview = await prepareAssistantAction(db, context.actorKey, context.sessionId, args.action, args.details);
    return { success: true, actionPreview, message: "Лише підготовлено. Дані фонду НЕ змінено. Перегляньте картку й натисніть «Підтвердити дію»." };
  }
  if (name === "librarian_report") {
    if (!isLibrarianReportKind(String(args.report))) throw new VisitScheduleError("invalid_report", 400, "Невідомий звіт.");
    const kind = args.report as Parameters<typeof readLibrarianReport>[1];
    const report = await readLibrarianReport(db, kind, String(args.from), String(args.to));
    return { success: true, data: { ...report, sections: report.sections.map((s) => ({ key: s.key, totalRows: s.rows.length, rows: s.rows.slice(0, 20), truncated: s.rows.length > 20 })) },
      cards: [{ kind: "order", id: `report-${kind}`, title: "Звіт бібліотеки", description: `${report.from} — ${report.to}`, details: report.sections.map((s) => `${s.key}: ${s.rows.length} записів`), href: `/api/librarian/reports/${kind}?from=${report.from}&to=${report.to}` }] };
  }
  if (name === "search_catalog") {
    const result = await searchAssistantCatalog(db, args, context.role === "librarian");
    return { success: true, message: result.message, data: result, cards: result.items.map((item) => ({
      kind: "material", id: item.id, title: item.title, description: `${item.author || "Автор не зазначений"} · ${item.year ?? "Рік не зазначений"}`,
      image: item.archived ? undefined : item.thumbnailUrl, details: [...(item.archived ? ["Архівна картка · лише перегляд"] : []), `Доступно ${item.availableQuantity} з ${item.totalQuantity}`, item.id],
    })) };
  }
  if (name === "material_details") {
    const id = normalizeCatalogId(args.materialId);
    if (!id) throw new VisitScheduleError("invalid_material", 400, "Оберіть матеріал із результатів пошуку.");
    const item = await getCatalogMaterialDetail(db, id, context.role === "librarian" ? "librarian" : "public", { includeArchived: context.role === "librarian" });
    if (!item) return { success: true, message: "Матеріал не знайдено серед доступних вам записів.", cards: [] };
    return { success: true, data: { ...item, checkedAt: new Date().toISOString() }, cards: [{ kind: "material", id: item.id, title: item.title,
      description: `${item.author || "Автор не зазначений"} · ${item.year ?? "Рік не зазначений"}`, image: item.archived ? undefined : item.thumbnailUrl,
      details: [...(item.archived ? ["Архівна картка · лише перегляд"] : []), `Доступно ${item.availableQuantity} з ${item.totalQuantity}`, ...(item.isbn ? [`ISBN ${item.isbn}`] : []),
        ...(context.role === "librarian" ? item.holdings.map((h) => `${h.locationName}: доступно ${h.availableQuantity}, у фонді ${h.physicalQuantity}${h.condition ? ` · ${h.condition}` : ""}`) : [])],
    }] };
  }
  if (name === "my_loans") {
    if (!context.teacherUserId) throw new VisitScheduleError("assistant_tool_denied", 403, "Потрібен вхід учителя.");
    const [personal, classes] = await Promise.all([
      listOpenLoans(db, { teacherUserId: context.teacherUserId, limit: 200 }),
      listOpenClassLoans(db, { teacherUserId: context.teacherUserId, limit: 200 }),
    ]);
    const cards: AssistantCard[] = [
      ...personal.flatMap((loan) => loan.items.map((item) => ({ kind: "loan" as const, id: item.loanItemId, title: item.materialTitle,
        image: item.thumbnailUrl, description: item.materialAuthor, details: [`У вас ${item.quantityOutstanding} прим.`, `Видано ${displayDate(loan.issuedAt)}`, `Повернення: ${displayDate(loan.dueAt)}`] }))),
      ...classes.flatMap((loan) => loan.items.map((item) => ({ kind: "loan" as const, id: item.classLoanItemId, title: item.materialTitle,
        image: item.thumbnailUrl, description: `${loan.className} · ${item.materialAuthor}`, details: [`У класу ${item.quantityOutstanding} прим.`, `Повернення: ${displayDate(loan.dueAt)}`] }))),
    ];
    return { success: true, data: { records: cards.slice(0, 60), shown: Math.min(cards.length, 60), totalItemsInLoadedLoans: cards.length, truncated: cards.length > 60 || personal.length === 200 || classes.length === 200 }, cards: cards.slice(0, 60) };
  }
  if (name === "my_orders") {
    if (!context.teacherUserId) throw new VisitScheduleError("assistant_tool_denied", 403, "Потрібен вхід учителя.");
    const result = await listTeacherMaterialRequestPage(db as TeacherMaterialRequestDatabase, context.teacherUserId, { limit: 10, ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}) });
    const labels: Record<string, string> = { submitted: "Надіслано", in_review: "На розгляді", ready: "Готове", partially_ready: "Частково готове", completed: "Виконано", rejected: "Відхилено", cancelled: "Скасовано" };
    const cards: AssistantCard[] = result.requests.map((order) => ({ kind: "order", id: order.id, title: `Замовлення від ${displayDate(order.submittedAt)}`,
      description: labels[order.status] ?? order.status, details: [...order.items.map((item) => `${item.title}: замовлено ${item.requestedQuantity}, видано ${item.fulfilledQuantity}`),
        ...(order.pickupLocationName ? [`Отримання: ${order.pickupLocationName}`] : []),
        ...(order.scheduledIssueAt ? [`Час: ${new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", dateStyle: "medium", timeStyle: "short" }).format(new Date(order.scheduledIssueAt))}`] : [])] }));
    return { success: true, data: { orders: cards, hasMore: result.page.hasMore, nextCursor: result.page.nextCursor }, cards };
  }
  if (name === "visit_schedule" || name === "prepare_visit") {
    if (!context.scheduleEnabled) throw new VisitScheduleError("schedule_disabled", 503, "Графік тимчасово вимкнено.");
    const date = String(args.date);
    const days = name === "prepare_visit" ? 1 : Number(args.days ?? 1);
    let range: { from: string; to: string };
    try { range = parseVisitRange(new URL(`https://library.invalid/?from=${encodeURIComponent(date)}&to=${encodeURIComponent(addDays(date, days - 1))}`), now.date); }
    catch { throw new VisitScheduleError("invalid_visit_date", 400, "Уточніть справжню дату в межах наступних 90 днів."); }
    const schedule = await readVisitSchedule(db, range, { ...(context.teacherUserId ? { ownerUserId: context.teacherUserId } : {}), includeClasses: true, status: "active", futureOnly: now });
    if (name === "visit_schedule") {
      const duration = Number(args.durationMinutes ?? 30);
      const intervals = freeVisitIntervals(schedule, date, days, duration);
      return { success: true, data: { timeZone: schedule.timeZone, proposedDurationMinutes: duration, freeIntervals: intervals, classes: schedule.classYears,
        myVisits: schedule.bookings?.map((b) => ({ date: b.date, startTime: b.startTime, endTime: b.endTime, classLabel: b.classLabel })), bookingEnabled: context.bookingEnabled },
        cards: intervals.map((slot, i) => ({ kind: "visit", id: `free-${i}`, title: displayDate(slot.date), description: `Вільно ${slot.startTime}–${slot.endTime}`, details: [`Оберіть початок і тривалість від ${duration} хв`] })) };
    }
    if (!context.bookingEnabled || !context.teacherUserId) throw new VisitScheduleError("booking_disabled", 403, "Запис через помічника зараз недоступний. Скористайтеся розділом «Графік».");
    const proposed = validateAssistantVisit(args, crypto.randomUUID());
    const classRecord = schedule.classYears?.find((c) => c.id === proposed.classYearId);
    if (proposed.classYearId && !classRecord) throw new VisitScheduleError("invalid_class", 400, "Оберіть активний клас із графіка.");
    const intervals = freeVisitIntervals(schedule, date, 1, 20);
    if (!intervals.some((slot) => proposed.startTime >= slot.startTime && proposed.endTime <= slot.endTime)) throw new VisitScheduleError("slot_unavailable", 409, "Обраний час уже зайнятий або бібліотека зачинена. Перевірте графік.");
    const preview = await prepareAssistantVisit(db, context.actorKey, context.sessionId, proposed, classRecord?.label ?? "Особистий візит");
    return { success: true, message: "Запис лише підготовлено. Ще НЕ заброньовано. Потрібне підтвердження на картці згоди.", preview };
  }
  throw new VisitScheduleError("assistant_tool_denied", 403, "Ця дія ще не доступна.");
}
