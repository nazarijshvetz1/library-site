import type { ChatGPTUser } from "@/app/chatgpt-auth";
import type { CatalogD1Database } from "./catalog-d1.ts";
import { getCatalogMaterialDetail, normalizeCatalogId } from "./catalog-d1.ts";
import { readLibraryReferenceData, listOpenLoans, listOpenClassLoans } from "./library-directory-store.ts";
import { VisitScheduleError, type VisitD1Database } from "./visit-schedule-store.ts";
import { requireAssistantSession } from "./assistant-store.ts";
import { requireAssistantConsent } from "./assistant-consent.ts";
import { ASSISTANT_CONSENT_VERSION, type AssistantActionPreview } from "./assistant-contract.ts";
import * as validation from "./library-write-validation.ts";
import * as mutations from "./library-mutation-store.ts";

export const ASSISTANT_ACTIONS = {
  "material.create": { label: "Додати матеріал", fields: "title, rubric; необов'язково author, publicationYear, subject, publicationType, classFrom, classTo, isbn, publisher, notes. Початковий залишок додай окремим надходженням." },
  "material.update": { label: "Редагувати картку", fields: "materialId, changes:{лише змінені title, rubric, author, publicationYear, subject, publicationType, classFrom, classTo, isbn, publisher, notes}. null очищує поле лише за явним проханням." },
  "material.archive": { label: "Архівувати матеріал", fields: "materialId. Не фізичне видалення. Залишки та незавершені видачі перевіряє ядро." },
  "ebook.add": { label: "Додати е-підручник", fields: "materialId, url (надане користувачем перевірене HTTPS посилання)." },
  "stock.count": { label: "Встановити фактичну кількість", fields: "materialId, locationId, condition, countedQuantity, reason (inventory_count/error_correction/other), occurredAt, notes (необов'язково)." },
  "stock.receive": { label: "Прийняти надходження", fields: "materialId, locationId, condition, quantity, occurredAt; необов'язково documentNumber, notes." },
  "stock.transfer": { label: "Перемістити примірники", fields: "materialId, sourceLocationId, destinationLocationId, condition, quantity, occurredAt; необов'язково documentNumber, notes." },
  "stock.writeoff": { label: "Списати примірники", fields: "materialId, locationId, condition, quantity, reason (worn/damaged/lost/obsolete/inventory_shortage/other), occurredAt; необов'язково documentNumber, notes." },
  "loan.issue": { label: "Видати вчителю", fields: "teacherUserId, issuedAt, dueAt (дата або null), items:[{materialId,sourceLocationId,condition,quantity}]; необов'язково notes. До 10 позицій." },
  "loan.return": { label: "Прийняти повернення вчителя", fields: "loanId, returnedAt, items:[{loanItemId,quantity,returnLocationId,condition}]; необов'язково notes. ID видачі з librarian_loans. До 10 позицій." },
  "class.issue": { label: "Видати класу", fields: "classYearId, responsibleTeacherUserId, issuedAt, dueAt (дата або null), items:[{materialId,sourceLocationId,condition,quantity}]; необов'язково notes. До 10 позицій." },
  "class.return": { label: "Прийняти повернення класу", fields: "classLoanId, returnedAt, items:[{classLoanItemId,quantity,returnLocationId,condition}]; необов'язково notes. ID з librarian_loans. До 10 позицій." },
} as const;
export type AssistantActionKind = keyof typeof ASSISTANT_ACTIONS;
type Database = VisitD1Database & CatalogD1Database;
type ActionRow = { id: string; actor_key: string; session_id: string; kind: AssistantActionKind; payload_json: string; preview_json: string; expires_at: string; cancelled_at: string | null };

export function isAssistantAction(value: unknown): value is AssistantActionKind {
  return typeof value === "string" && Object.hasOwn(ASSISTANT_ACTIONS, value);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VisitScheduleError("invalid_action", 400, "Потрібно уточнити дані дії.");
  return value as Record<string, unknown>;
}
function checked<T>(result: validation.ValidationResult<T>): T {
  if (!result.ok) throw new VisitScheduleError("invalid_action", 400, Object.entries(result.fieldErrors).map(([key, value]) => `${key}: ${value}`).join("; "));
  return result.value;
}
function validateAction(kind: AssistantActionKind, input: unknown): Record<string, unknown> {
  const p = record(input);
  const withoutMaterial = { ...p }; delete withoutMaterial.materialId;
  switch (kind) {
    case "material.create": return { ...checked(validation.validateMaterialCreateInput(p)) };
    case "material.update": return { materialId: p.materialId, ...checked(validation.validateMaterialUpdateInput(withoutMaterial)) };
    case "material.archive": return { materialId: p.materialId, ...checked(validation.validateMaterialArchiveInput(withoutMaterial)) };
    case "ebook.add": return { materialId: p.materialId, ...checked(validation.validateMaterialEbookLinkCreateInput(withoutMaterial)) };
    case "stock.count": return { ...checked(validation.validateStockAdjustmentInput(p)) };
    case "stock.receive": return { ...checked(validation.validateReceiptCreateInput(p)) };
    case "stock.transfer": return { ...checked(validation.validateStockTransferInput(p)) };
    case "stock.writeoff": return { ...checked(validation.validateStockWriteoffInput(p)) };
    case "loan.issue": return { ...checked(validation.validateLoanCreateInput(p)) };
    case "loan.return": return { ...checked(validation.validateLoanReturnInput(p)) };
    case "class.issue": return { ...checked(validation.validateClassLoanCreateInput(p)) };
    case "class.return": return { ...checked(validation.validateClassLoanReturnInput(p)) };
  }
}

export async function prepareAssistantAction(db: Database, actorKey: string, sessionId: string, kind: unknown, details: unknown): Promise<AssistantActionPreview> {
  if (!actorKey.startsWith("librarian:") || !isAssistantAction(kind)) throw new VisitScheduleError("assistant_tool_denied", 403, "Ця дія доступна лише бібліотекарю.");
  await requireAssistantConsent(db, actorKey);
  await requireAssistantSession(db, sessionId, actorKey);
  const raw = record(details);
  if (JSON.stringify(raw).length > 6000) throw new VisitScheduleError("invalid_action", 400, "Забагато даних. Підготуйте одну дію, не більше 10 позицій.");
  const forbidReserved = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(forbidReserved); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      if (/^(?:expected|requestId$|catalogScope$|actor|confirmed|revision$|initialReceipt$|links$)/u.test(key)) throw new VisitScheduleError("invalid_action", 400, "Службові версії, залишки та підтвердження визначає сервер. Передайте лише зміни.");
      forbidReserved(nested);
    }
  };
  forbidReserved(raw);
  const id = crypto.randomUUID();
  const payload: Record<string, unknown> = { ...raw, requestId: id };
  if (kind === "material.create" || kind === "material.update") {
    payload.catalogScope = "education";
  }
  if (kind.startsWith("stock.") || kind.startsWith("loan.") || kind.startsWith("class.")) payload.notes = raw.notes ?? null;
  if (["stock.receive", "stock.transfer", "stock.writeoff"].includes(kind)) payload.documentNumber = raw.documentNumber ?? null;
  const references = await readLibraryReferenceData(db);
  const names = new Map<string, string>([...references.teachers.map((t) => [t.id, t.fullName] as const), ...references.locations.map((l) => [l.id, l.name] as const)]);
  const checkLocations = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(checkLocations); return; }
    if (!value || typeof value !== "object") return;
    for (const [field, nested] of Object.entries(value)) {
      if (["locationId", "sourceLocationId", "destinationLocationId", "returnLocationId"].includes(field) && !references.locations.some((l) => l.id === nested)) throw new VisitScheduleError("invalid_action", 404, "Оберіть чинне місце з довідника.");
      checkLocations(nested);
    }
  };
  checkLocations(raw);
  const before: string[] = [];
  const material = async (value: unknown) => {
    const materialId = normalizeCatalogId(value);
    const item = materialId ? await getCatalogMaterialDetail(db, materialId, "librarian", { fund: "education" }) : null;
    if (!item) throw new VisitScheduleError("invalid_action", 404, "Матеріал не знайдено. Спершу виберіть його в результатах пошуку.");
    names.set(item.id, `${item.title} · ${item.author || "без автора"} · ${item.year ?? "без року"} (${item.id})`);
    return item;
  };
  if (raw.materialId) {
    const item = await material(raw.materialId);
    payload.materialId = item.id;
    if (["material.update", "material.archive", "ebook.add"].includes(kind)) payload.expectedVersion = item.version;
    if (kind === "material.update") {
      const aliases: Record<string, unknown> = { ...item, publicationYear: item.year, classFrom: item.classFrom, classTo: item.classTo };
      for (const [field, value] of Object.entries(record(raw.changes))) before.push(`${fieldLabel(field)}: ${String(aliases[field] ?? "—")} → ${String(value ?? "очистити")}`);
    }
    if (kind.startsWith("stock.")) {
      const holding = (location: unknown) => item.holdings.find((h) => h.locationId === location && (h.condition ?? "unspecified") === raw.condition);
      if (kind === "stock.transfer") {
        payload.expectedSourceQuantity = holding(raw.sourceLocationId)?.physicalQuantity ?? 0;
        payload.expectedDestinationQuantity = holding(raw.destinationLocationId)?.physicalQuantity ?? 0;
      } else payload.expectedQuantity = holding(raw.locationId)?.physicalQuantity ?? 0;
    }
  }
  if (kind === "loan.issue" || kind === "class.issue") {
    if (!Array.isArray(raw.items) || !raw.items.length || raw.items.length > 10) throw new VisitScheduleError("invalid_action", 400, "Оберіть 1–10 позицій видачі.");
    payload.items = await Promise.all(raw.items.map(async (value) => {
      const item = record(value); const book = await material(item.materialId);
      const holding = book.holdings.find((h) => h.locationId === item.sourceLocationId && (h.condition ?? "unspecified") === item.condition);
      return { ...item, expectedAvailableQuantity: holding?.availableQuantity ?? 0 };
    }));
    if (kind === "class.issue") {
      const schoolClass = await db.prepare("SELECT id,class_name,version FROM class_years WHERE id=? AND status='active'").bind(String(raw.classYearId ?? "")).first<{ id: string; class_name: string; version: number }>();
      if (!schoolClass) throw new VisitScheduleError("invalid_action", 404, "Оберіть активний клас із довідника.");
      names.set(schoolClass.id, schoolClass.class_name);
      payload.expectedClassYearVersion = schoolClass.version;
      const openLoan = await db.prepare("SELECT id FROM class_loans WHERE class_year_id=? AND status='open'").bind(schoolClass.id).first<{ id: string }>();
      payload.expectedClassLoanId = openLoan?.id ?? null;
    }
  }
  if (kind === "loan.return" || kind === "class.return") {
    if (!Array.isArray(raw.items) || !raw.items.length || raw.items.length > 10) throw new VisitScheduleError("invalid_action", 400, "Оберіть 1–10 позицій повернення.");
    const classReturn = kind === "class.return";
    const loanId = String(classReturn ? raw.classLoanId ?? "" : raw.loanId ?? "");
    const table = classReturn ? "class_loans" : "loans";
    const loan = await db.prepare(`SELECT * FROM ${table} WHERE id=? AND status='open'`).bind(loanId).first<Record<string, unknown>>();
    if (!loan) throw new VisitScheduleError("invalid_action", 404, "Відкриту видачу не знайдено.");
    const teacherId = String(classReturn ? loan.responsible_teacher_user_id : loan.teacher_user_id);
    const classRow = classReturn ? await db.prepare("SELECT class_name FROM class_years WHERE id=?").bind(String(loan.class_year_id)).first<{ class_name: string }>() : null;
    names.set(loanId, `${classRow ? `${classRow.class_name} · ` : ""}${names.get(teacherId) ?? teacherId} · видача ${String(loan.issued_at).slice(0, 10)}`);
    if (classReturn) payload.expectedVersion = loan.version;
    for (const value of raw.items) {
      const item = record(value);
      const itemId = String(classReturn ? item.classLoanItemId ?? "" : item.loanItemId ?? "");
      const row = await db.prepare(`SELECT material_id,quantity_issued-quantity_returned AS outstanding FROM ${classReturn ? "class_loan_items" : "loan_items"} WHERE id=? AND ${classReturn ? "class_loan_id" : "loan_id"}=?`).bind(itemId, loanId).first<{ material_id: string; outstanding: number }>();
      if (!row) throw new VisitScheduleError("invalid_action", 404, "Позиція не належить вибраній видачі.");
      const book = await material(row.material_id);
      names.set(itemId, names.get(book.id)!);
      before.push(`${book.title}: залишилося повернути ${row.outstanding}, приймаємо ${String(item.quantity)}.`);
    }
  }
  for (const field of ["teacherUserId", "responsibleTeacherUserId"]) if (raw[field] && !references.teachers.some((t) => t.id === raw[field])) throw new VisitScheduleError("invalid_action", 404, "Оберіть чинного вчителя з довідника.");
  const value = validateAction(kind, payload);
  const lines = [...before, ...describe(value, names)];
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const preview: AssistantActionPreview = { id, title: ASSISTANT_ACTIONS[kind].label, lines, expiresAt };
  await db.prepare(`INSERT INTO assistant_action_drafts(id,actor_key,session_id,kind,payload_json,preview_json,created_at,expires_at)
    SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM assistant_sessions WHERE id=? AND actor_key=? AND closed_at IS NULL AND expires_at>?)
    RETURNING id`).bind(id, actorKey, sessionId, kind, JSON.stringify(value), JSON.stringify(preview), new Date().toISOString(), expiresAt, sessionId, actorKey, new Date().toISOString()).first().then((row) => {
      if (!row) throw new VisitScheduleError("assistant_session_ended", 403, "Розмову завершено. Підготуйте дію ще раз.");
    });
  return preview;
}

const labels: Record<string, string> = { materialId: "Матеріал", title: "Назва", author: "Автор", publicationYear: "Рік", rubric: "Рубрика", subject: "Предмет", publicationType: "Тип видання", classFrom: "Від класу", classTo: "До класу", isbn: "ISBN", publisher: "Видавець", notes: "Примітка", changes: "Зміни", locationId: "Розміщення", sourceLocationId: "Звідки", destinationLocationId: "Куди", returnLocationId: "Куди повертаємо", condition: "Стан", quantity: "Кількість", countedQuantity: "Фактично", expectedQuantity: "Зараз у базі", expectedSourceQuantity: "Зараз у джерелі", expectedDestinationQuantity: "Зараз у місці призначення", expectedAvailableQuantity: "Зараз доступно", reason: "Причина", occurredAt: "Дата", issuedAt: "Дата видачі", returnedAt: "Дата повернення", dueAt: "Повернути до", teacherUserId: "Учитель", responsibleTeacherUserId: "Відповідальний учитель", classYearId: "Клас", loanId: "Видача", classLoanId: "Видача класу", loanItemId: "Примірник", classLoanItemId: "Примірник", documentNumber: "Документ", url: "Посилання" };
const enumLabels: Record<string, string> = { good: "Добрий стан", worn: "Зношений", damaged: "Пошкоджений", unspecified: "Не зазначено", inventory_count: "Фактичний підрахунок", error_correction: "Виправлення помилки", other: "Інше", lost: "Втрачено", obsolete: "Застарілий", inventory_shortage: "Нестача за ревізією" };
const fieldLabel = (key: string) => labels[key] ?? key;
function describe(value: Record<string, unknown>, names: Map<string, string>, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, item]) => {
    if (["requestId", "catalogScope", "expectedVersion", "expectedClassYearVersion", "expectedClassLoanId", "links", "initialReceipt"].includes(key)) return [];
    if (item === null || item === "") return key === "dueAt" ? [`${prefix}${fieldLabel(key)}: строк не встановлено`] : [];
    if (Array.isArray(item)) return item.flatMap((row, i) => describe(record(row), names, `${i + 1}. `));
    if (typeof item === "object") return describe(record(item), names, prefix);
    const shown = key.endsWith("Id") ? names.get(String(item)) : ["condition", "reason"].includes(key) ? enumLabels[String(item)] : undefined;
    return [`${prefix}${fieldLabel(key)}: ${shown ?? String(item)}`];
  });
}

export async function readAssistantActionReceipt(db: Database, actorKey: string, id: string): Promise<unknown | null> {
  const row = await db.prepare(`SELECT c.result_json FROM assistant_action_drafts d JOIN mutation_commands c ON c.id=d.id
    WHERE d.id=? AND d.actor_key=? AND c.status='completed'`).bind(id, actorKey).first<{ result_json: string | null }>();
  return row?.result_json ? JSON.parse(row.result_json) : null;
}
export async function readAssistantActionPreview(db: Database, actorKey: string, id: string): Promise<AssistantActionPreview> {
  const row = await db.prepare("SELECT preview_json FROM assistant_action_drafts WHERE id=? AND actor_key=?").bind(id, actorKey).first<{ preview_json: string }>();
  if (!row) throw new VisitScheduleError("assistant_action_not_found", 404, "Картку дії не знайдено.");
  return JSON.parse(row.preview_json) as AssistantActionPreview;
}
export async function cancelAssistantAction(db: Database, actorKey: string, id: string): Promise<unknown | null> {
  const row = await db.prepare("UPDATE assistant_action_drafts SET cancelled_at=COALESCE(cancelled_at,?) WHERE id=? AND actor_key=? RETURNING id")
    .bind(new Date().toISOString(), id, actorKey).first();
  if (!row) throw new VisitScheduleError("assistant_action_not_found", 404, "Картку дії не знайдено.");
  // Confirmation's atomic guard and this update serialize. A winning confirmation
  // must be reported as completed, never as an untouched cancellation.
  return readAssistantActionReceipt(db, actorKey, id);
}

export async function confirmAssistantAction(db: Database, actorKey: string, user: ChatGPTUser, id: string, confirmed: unknown): Promise<unknown> {
  if (actorKey !== `librarian:${user.userId}`) throw new VisitScheduleError("assistant_tool_denied", 403, "Потрібен вхід бібліотекаря.");
  const receipt = await readAssistantActionReceipt(db, actorKey, id); if (receipt) return receipt;
  if (confirmed !== true) throw new VisitScheduleError("action_confirmation_required", 400, "Перегляньте картку й підтвердьте дію кнопкою.");
  const row = await db.prepare("SELECT * FROM assistant_action_drafts WHERE id=? AND actor_key=?").bind(id, actorKey).first<ActionRow>();
  if (!row || row.cancelled_at || row.expires_at <= new Date().toISOString() || !isAssistantAction(row.kind)) throw new VisitScheduleError("assistant_action_expired", 409, "Дія застаріла або скасована. Підготуйте нову картку.");
  await requireAssistantConsent(db, actorKey);
  await requireAssistantSession(db, row.session_id, actorKey);
  const payload = validateAction(row.kind, JSON.parse(row.payload_json));
  // Core mutation batches also enforce consent/session/draft state at COMMIT time.
  const guardedDb: mutations.LibraryD1Database = { prepare: (sql) => db.prepare(sql), async batch(statements) {
    const guard = db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_action_drafts d
      JOIN assistant_sessions s ON s.id=d.session_id JOIN assistant_consents c ON c.actor_key=d.actor_key
      WHERE d.id=? AND d.actor_key=? AND d.cancelled_at IS NULL AND d.expires_at>? AND s.closed_at IS NULL AND s.expires_at>?
        AND c.version=? AND c.accepted_at IS NOT NULL AND c.revoked_at IS NULL) THEN 1 ELSE json('assistant_authorization_changed') END`)
      .bind(id, actorKey, new Date().toISOString(), new Date().toISOString(), ASSISTANT_CONSENT_VERSION);
    return (await db.batch([guard, ...statements])).slice(1);
  } };
  const withoutMaterial = { ...payload }; delete withoutMaterial.materialId;
  switch (row.kind) {
    case "material.create": return mutations.createMaterialDirect(user, checked(validation.validateMaterialCreateInput(payload)), guardedDb);
    case "material.update": return mutations.updateMaterialDirect(user, String(payload.materialId), checked(validation.validateMaterialUpdateInput(withoutMaterial)), guardedDb);
    case "material.archive": return mutations.archiveMaterialDirect(user, String(payload.materialId), checked(validation.validateMaterialArchiveInput(withoutMaterial)), guardedDb);
    case "ebook.add": return mutations.appendMaterialEbookLinkDirect(user, String(payload.materialId), checked(validation.validateMaterialEbookLinkCreateInput(withoutMaterial)), guardedDb);
    case "stock.count": return mutations.adjustHoldingToActualCount(user, checked(validation.validateStockAdjustmentInput(payload)), guardedDb);
    case "stock.receive": return mutations.receiveStockDirect(user, checked(validation.validateReceiptCreateInput(payload)), guardedDb);
    case "stock.transfer": return mutations.transferStockDirect(user, checked(validation.validateStockTransferInput(payload)), guardedDb);
    case "stock.writeoff": return mutations.writeOffStockDirect(user, checked(validation.validateStockWriteoffInput(payload)), guardedDb);
    case "loan.issue": return mutations.issueLoanToTeacher(user, checked(validation.validateLoanCreateInput(payload)), guardedDb);
    case "loan.return": return mutations.returnLoanItems(user, checked(validation.validateLoanReturnInput(payload)), guardedDb);
    case "class.issue": return mutations.issueLoanToClass(user, checked(validation.validateClassLoanCreateInput(payload)), guardedDb);
    case "class.return": return mutations.returnClassLoanItems(user, checked(validation.validateClassLoanReturnInput(payload)), guardedDb);
  }
}

export async function readAssistantLoans(db: Database, teacherUserId: string, overdueOnly: boolean) {
  const [personal, classes] = await Promise.all([listOpenLoans(db, { teacherUserId, limit: 200 }), listOpenClassLoans(db, { teacherUserId, limit: 200 })]);
  const overdue = (loan: { dueAt: string | null }) => !overdueOnly || Boolean(loan.dueAt && loan.dueAt.slice(0, 10) < new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date()));
  return { personal: personal.filter(overdue).slice(0, 30).map((loan) => ({ ...loan, items: loan.items.slice(0, 50), itemsTruncated: loan.items.length > 50 })), classes: classes.filter(overdue).slice(0, 30).map((loan) => ({ ...loan, items: loan.items.slice(0, 50), itemsTruncated: loan.items.length > 50 })), truncated: personal.length > 30 || classes.length > 30,
    message: "Список обмежено 30 видачами кожного виду. Для повної картки уточніть учителя. Видачі без строку не вважаються простроченими." };
}
