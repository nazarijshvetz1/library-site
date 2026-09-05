import type { VisitTeacherIdentity } from "./visit-teacher-auth.ts";
import { VisitScheduleError, type VisitD1Database, updateOwnVisitBooking, cancelOwnVisitBooking } from "./visit-schedule-store.ts";
import { validateVisitBookingUpdateInput } from "./visit-portal-validation.ts";
import { createTeacherMaterialRequest, cancelTeacherMaterialRequest } from "./teacher-material-request-store.ts";
import { validateMaterialRequestCreateInput, validateMaterialRequestCancelInput } from "./teacher-material-request-validation.ts";
import { createTeacherAcquisitionRequest } from "./acquisition-store.ts";
import { validateAcquisitionCreateInput } from "./acquisition-validation.ts";
import { getTeacherOwnProfile, updateTeacherOwnProfile, type TeacherProfileUpdateInput } from "./teacher-profile-store.ts";
import { queueTelegramForLibrariansStatement } from "./telegram-outbox.ts";
import { getCatalogMaterialDetail, type CatalogD1Database } from "./catalog-d1.ts";
import { requireAssistantConsent } from "./assistant-consent.ts";
import { requireAssistantSession } from "./assistant-store.ts";
import { ASSISTANT_CONSENT_VERSION, type AssistantActionPreview } from "./assistant-contract.ts";
import { cartSignature, type AssistantCartSnapshot } from "./teacher-cart.ts";
import { telephoneHref } from "./telephone.ts";

type Database = VisitD1Database & CatalogD1Database;
export const TEACHER_ASSISTANT_ACTIONS = {
  "order.submit": { title: "Надіслати замовлення бібліотекарю", fields: "Порожній details: список і примітка беруться лише зі спільного кошика. Спочатку узгодь увесь кошик." },
  "order.cancel": { title: "Скасувати моє замовлення", fields: "id замовлення з my_orders; reason необов'язково." },
  "visit.update": { title: "Перенести моє відвідування", fields: "id з my_visits, date YYYY-MM-DD, startTime HH:MM, endTime HH:MM, classYearId (чинний ID або null), purpose (до 160 символів або null). Уточни час, клас та мету." },
  "visit.cancel": { title: "Скасувати моє відвідування", fields: "id запису з my_visits." },
  "acquisition.create": { title: "Запропонувати придбання", fields: "category educational/literature, sourceKind catalog/manual, literatureKind none/fiction/science/popular_science/other, materialId або null, title, author, publicationYear, requestedQuantity, sourceUrl (або порожньо), subject, targetClass, note (або порожньо). Не вигадуй автора, рік чи посилання. Це не замовлення з наявного фонду." },
  "acquisition.reply": { title: "Відповісти на уточнення бібліотекаря", fields: "id пропозиції зі статусом clarification у my_acquisitions, message — відповідь учителя до 1000 символів." },
  "profile.phone": { title: "Змінити мій мобільний номер", fields: "phone — лише номер учителя; порожній рядок очищує номер тільки за явним проханням." },
  "notifications.set": { title: "Змінити Telegram-сповіщення", fields: "enabled boolean. Єдиний перемикач для всіх сповіщень. Вимкнення скасовує також ще не надіслані нагадування." },
} as const;
type Kind = keyof typeof TEACHER_ASSISTANT_ACTIONS;
type Row = { id: string; actor_key: string; session_id: string; kind: string; payload_json: string; preview_json: string; expires_at: string; cancelled_at: string | null; result_json: string | null };
function kindOf(value: unknown): Kind {
  if (typeof value !== "string" || !Object.hasOwn(TEACHER_ASSISTANT_ACTIONS, value)) throw new VisitScheduleError("assistant_tool_denied", 403, "Ця дія не належить до можливостей учителя.");
  return value as Kind;
}
function checked<T>(result: { ok: true; value: T } | { ok: false; fieldErrors: Record<string, string> }): T {
  if (!result.ok) throw new VisitScheduleError("invalid_action", 400, Object.values(result.fieldErrors).join(" "));
  return result.value;
}
function detailsOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 6000) throw new VisitScheduleError("invalid_action", 400, "Уточніть дані однієї дії.");
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) if (/^(?:expected|requestId|mutationId|actor|teacher|confirmed|publicDisplayConsent)/u.test(key)) throw new VisitScheduleError("invalid_action", 400, "Особу, версію й підтвердження визначає сервер.");
  return obj;
}
export async function teacherActionRow(db: Database, actorKey: string, id: string): Promise<Row> {
  const row = await db.prepare("SELECT * FROM assistant_action_drafts WHERE id=? AND actor_key=? AND kind LIKE 'teacher.%'").bind(id, actorKey).first<Row>();
  if (!row) throw new VisitScheduleError("assistant_action_not_found", 404, "Підготовлену дію не знайдено.");
  return row;
}
export async function prepareTeacherAssistantAction(db: Database, actorKey: string, sessionId: string, teacherId: string, action: unknown, input: unknown, cart: AssistantCartSnapshot): Promise<AssistantActionPreview> {
  if (actorKey !== `teacher:${teacherId}`) throw new VisitScheduleError("assistant_tool_denied", 403, "Потрібен вхід учителя.");
  await requireAssistantConsent(db, actorKey); await requireAssistantSession(db, sessionId, actorKey);
  const kind = kindOf(action), details = detailsOf(input), id = crypto.randomUUID();
  const fields: Record<Kind, string[]> = {
    "order.submit": [], "order.cancel": ["id", "reason"], "visit.update": ["id", "date", "startTime", "endTime", "classYearId", "purpose"], "visit.cancel": ["id"],
    "profile.phone": ["phone"], "notifications.set": ["enabled"], "acquisition.reply": ["id", "message"],
    "acquisition.create": ["category", "sourceKind", "literatureKind", "materialId", "title", "author", "publicationYear", "requestedQuantity", "sourceUrl", "subject", "targetClass", "note"],
  };
  if (Object.keys(details).some((key) => !fields[kind].includes(key)) || Object.values(details).some((value) => typeof value === "string" && /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))) throw new VisitScheduleError("invalid_action", 400, "Перевірте поля дії.");
  let payload: Record<string, unknown> = {};
  const lines: string[] = [];
  let signature: string | undefined;
  if (kind === "order.submit") {
    if (Object.keys(details).length) throw new VisitScheduleError("invalid_action", 400, "Список береться зі спільного кошика, а не з details.");
    payload = { ...checked(validateMaterialRequestCreateInput({ requestId: id, items: cart.items, notes: cart.notes.trim() || null })) };
    for (const row of cart.items) {
      const book = await getCatalogMaterialDetail(db, row.materialId, "public");
      if (!book || book.availableQuantity < row.quantity) throw new VisitScheduleError("cart_stock_changed", 409, "Наявність змінилася. Перевірте кошик і кількості.");
      lines.push(`${book.title} · ${book.author || "Автор не зазначений"} · ${book.year ?? "без року"}: ${row.quantity} прим.`);
    }
    signature = cartSignature(cart);
    if (cart.notes.trim()) lines.push(`Примітка: ${cart.notes.trim()}`);
    lines.push("Це заявка бібліотекарю, не фактична видача й не резервування.");
  } else if (kind === "order.cancel") {
    const row = await db.prepare("SELECT id,version,status FROM material_requests WHERE id=? AND teacher_user_id=?").bind(String(details.id ?? ""), teacherId).first<{ id: string; version: number; status: string }>();
    if (!row) throw new VisitScheduleError("request_not_found", 404, "Ваше замовлення не знайдено.");
    if (!["submitted", "in_review"].includes(row.status)) throw new VisitScheduleError("invalid_status_transition", 409, "Це замовлення вже опрацьоване. Зверніться до бібліотекаря.");
    payload = { id: row.id, ...checked(validateMaterialRequestCancelInput({ requestId: id, expectedVersion: row.version, reason: details.reason ?? null })) };
    lines.push(`Замовлення ${row.id}`, "Бібліотекар отримає повідомлення про скасування.");
    const items = await db.prepare("SELECT m.title,i.requested_quantity FROM material_request_items i JOIN materials m ON m.id=i.material_id WHERE i.request_id=? ORDER BY i.id").bind(row.id).all<{ title: string; requested_quantity: number }>();
    lines.push(...(items.results ?? []).map((item) => `${item.title}: ${item.requested_quantity} прим.`), `Причина: ${String(payload.reason || "не вказана")}`);
  } else if (kind === "visit.update" || kind === "visit.cancel") {
    const row = await db.prepare("SELECT id,version,visit_date,start_time,end_time,class_label FROM visit_bookings WHERE id=? AND owner_kind='teacher' AND owner_user_id=? AND status='active'").bind(String(details.id ?? ""), teacherId).first<{ id: string; version: number; visit_date: string; start_time: string; end_time: string; class_label: string | null }>();
    if (!row) throw new VisitScheduleError("booking_not_found", 404, "Ваш активний запис не знайдено.");
    lines.push(`Було: ${row.visit_date}, ${row.start_time}–${row.end_time} · ${row.class_label || "без класу"}`);
    if (kind === "visit.cancel") payload = { id: row.id, requestId: id, expectedVersion: row.version, reason: null };
    else {
      const { id: _id, ...changes } = details;
      payload = { id: row.id, ...checked(validateVisitBookingUpdateInput({ ...changes, requestId: id, expectedVersion: row.version, publicDisplayConsent: true })) };
      const schoolClass = payload.classYearId ? await db.prepare("SELECT class_name FROM class_years WHERE id=? AND status='active'").bind(String(payload.classYearId)).first<{ class_name: string }>() : null;
      if (payload.classYearId && !schoolClass) throw new VisitScheduleError("invalid_class", 400, "Оберіть чинний клас із графіка.");
      lines.push(`Стане: ${String(payload.date)}, ${String(payload.startTime)}–${String(payload.endTime)} · ${schoolClass?.class_name || "без класу"}`, `Мета: ${String(payload.purpose || "не вказана")}`, "Ваші ПІБ і точний час будуть видимі у відкритому графіку. Клас і мета залишаться приватними.");
    }
  } else if (kind === "profile.phone") {
    const phone = typeof details.phone === "string" ? details.phone.normalize("NFKC").trim().replace(/\s+/gu, " ") : "\0";
    if (phone.length > 40 || (phone && !telephoneHref(phone))) throw new VisitScheduleError("invalid_action", 400, "Укажіть коректний мобільний номер.");
    const own = await getTeacherOwnProfile(db, teacherId);
    payload = { requestId: id, expectedVersion: own.profileVersion, subjectPosition: own.subjectPosition, primaryLocationId: own.primaryLocation?.id ?? null, serviceContact: phone };
    lines.push(`Було: ${own.serviceContact || "не вказано"}`, `Стане: ${phone || "номер буде прибрано"}`);
  } else if (kind === "notifications.set") {
    const { readTelegramConnectionStatus } = await import("./telegram-notifications.ts");
    if (typeof details.enabled !== "boolean") throw new VisitScheduleError("invalid_action", 400, "Уточніть: увімкнути чи вимкнути сповіщення.");
    const status = await readTelegramConnectionStatus(db, teacherId);
    if (!status.connected || !status.version) throw new VisitScheduleError("telegram_not_connected", 409, "Спочатку підключіть Telegram у своєму кабінеті.");
    payload = { notifyOrders: details.enabled, notifyVisits: details.enabled, expectedVersion: status.version };
    lines.push(details.enabled ? "Увімкнути всі Telegram-сповіщення." : "Вимкнути всі Telegram-сповіщення та скасувати ще не надіслані нагадування.");
  } else if (kind === "acquisition.create") {
    payload = { ...checked(validateAcquisitionCreateInput({ ...details, requestId: id })) };
    if (payload.materialId) {
      const book = await getCatalogMaterialDetail(db, String(payload.materialId), "public");
      if (!book) throw new VisitScheduleError("material_not_found", 404, "Матеріал не знайдено.");
      payload.title = book.title; payload.author = book.author || payload.author; payload.publicationYear = book.year ?? payload.publicationYear;
    }
    lines.push(`${String(payload.title)} · ${String(payload.author)} · ${String(payload.publicationYear)}`, `${String(payload.requestedQuantity)} прим. · ${String(payload.targetClass || "клас не зазначено")}`, `Примітка: ${String(payload.note || "немає")}`, "Це пропозиція придбати матеріали, не замовлення з наявного фонду.");
    lines.push(`Категорія: ${payload.category === "educational" ? "Навчальні матеріали" : "Література"}`, `Предмет: ${String(payload.subject || "не зазначено")}`, `Джерело: ${String(payload.sourceUrl || "не зазначено")}`);
  } else {
    const row = await db.prepare("SELECT id,version,title,clarification_message FROM acquisition_requests WHERE id=? AND teacher_user_id=? AND status='clarification'").bind(String(details.id ?? ""), teacherId).first<{ id: string; version: number; title: string; clarification_message: string }>();
    if (!row) throw new VisitScheduleError("request_not_found", 404, "Вашу пропозицію, що потребує уточнення, не знайдено.");
    if (typeof details.message !== "string" || !details.message.trim() || details.message.length > 1000) throw new VisitScheduleError("invalid_action", 400, "Відповідь має містити 1–1000 символів.");
    payload = { id: row.id, expectedVersion: row.version, message: details.message.trim() };
    lines.push(row.title, `Запитання: ${row.clarification_message}`, `Ваша відповідь: ${payload.message}`, "Пропозиція повернеться на розгляд бібліотекарю.");
  }
  const preview: AssistantActionPreview = { id, title: TEACHER_ASSISTANT_ACTIONS[kind].title, lines, expiresAt: new Date(Date.now() + 600000).toISOString(), ...(signature ? { cartSignature: signature } : {}), ...(kind === "visit.update" ? { publicDisplayConsent: true } : {}) };
  await db.prepare("INSERT INTO assistant_action_drafts(id,actor_key,session_id,kind,payload_json,preview_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)")
    .bind(id, actorKey, sessionId, `teacher.${kind}`, JSON.stringify(payload), JSON.stringify(preview), new Date().toISOString(), preview.expiresAt).all();
  return preview;
}

export async function confirmTeacherAssistantAction(db: Database, actorKey: string, teacher: VisitTeacherIdentity, id: string, confirmed: unknown, currentCart: AssistantCartSnapshot, publicConsent: unknown) {
  if (actorKey !== `teacher:${teacher.teacherUserId}`) throw new VisitScheduleError("assistant_tool_denied", 403, "Потрібен вхід власника дії.");
  const row = await teacherActionRow(db, actorKey, id);
  if (row.result_json) return JSON.parse(row.result_json) as { kind: Kind };
  if (confirmed !== true) throw new VisitScheduleError("action_confirmation_required", 400, "Підтвердьте дію кнопкою на картці.");
  if (row.cancelled_at || row.expires_at <= new Date().toISOString()) throw new VisitScheduleError("assistant_action_expired", 409, "Пропозиція застаріла. Підготуйте нову.");
  await requireAssistantConsent(db, actorKey); await requireAssistantSession(db, row.session_id, actorKey);
  const kind = kindOf(row.kind.slice("teacher.".length));
  const p = JSON.parse(row.payload_json) as Record<string, unknown>, preview = JSON.parse(row.preview_json) as AssistantActionPreview;
  if (preview.cartSignature && preview.cartSignature !== cartSignature(currentCart)) throw new VisitScheduleError("assistant_cart_changed", 409, "Кошик змінився. Перевірте й підготуйте оновлений список.");
  if (preview.publicDisplayConsent && publicConsent !== true) throw new VisitScheduleError("consent_required", 400, "Підтвердьте публічне відображення ПІБ і часу відвідування.");
  const result = { kind, ...(preview.cartSignature ? { cartSignature: preview.cartSignature } : {}) };
  // One core mutation + the assistant receipt commit in the SAME D1 transaction.
  const guarded: VisitD1Database = { prepare: (sql) => db.prepare(sql), async batch(statements) {
    const now = new Date().toISOString();
    const guard = db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM assistant_action_drafts d
      JOIN assistant_sessions a ON a.id=d.session_id JOIN assistant_consents c ON c.actor_key=d.actor_key
      JOIN users u ON u.id=? JOIN teacher_profiles p ON p.teacher_user_id=u.id AND p.closed_at IS NULL
      JOIN visit_teacher_credentials v ON v.teacher_user_id=u.id AND v.status='active' AND v.version=?
      JOIN visit_teacher_sessions s ON s.teacher_user_id=u.id AND s.credential_version=v.version AND s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>?
      WHERE d.id=? AND d.actor_key=? AND d.cancelled_at IS NULL AND d.result_json IS NULL AND d.expires_at>?
      AND a.closed_at IS NULL AND a.expires_at>? AND c.version=? AND c.accepted_at IS NOT NULL AND c.revoked_at IS NULL AND u.status='active') THEN 1 ELSE json('assistant_authorization_changed') END`)
      .bind(teacher.teacherUserId, teacher.credentialVersion, teacher.tokenHash, now, id, actorKey, now, now, ASSISTANT_CONSENT_VERSION);
    const extra = [];
    if (kind === "notifications.set") extra.push(db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM telegram_connections WHERE user_id=? AND status='active' AND version=?) THEN 1 ELSE json('connection_version_conflict') END").bind(teacher.teacherUserId, Number(p.expectedVersion)));
    if (kind === "acquisition.reply") extra.push(db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM acquisition_requests WHERE id=? AND teacher_user_id=? AND status='clarification' AND version=?) THEN 1 ELSE json('request_version_conflict') END").bind(String(p.id), teacher.teacherUserId, Number(p.expectedVersion)));
    if (kind === "acquisition.create") extra.push(db.prepare("SELECT CASE WHEN (SELECT COUNT(*) FROM acquisition_requests WHERE teacher_user_id=? AND status IN ('submitted','in_review','clarification','approved','planned','ordered','partially_received'))<50 THEN 1 ELSE json('request_limit_reached') END").bind(teacher.teacherUserId));
    if (kind === "acquisition.create" && p.materialId) extra.push(db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM materials WHERE id=? AND status='active' AND title=? AND COALESCE(NULLIF(author,''),?)=? AND COALESCE(publication_year,?) IS ?) THEN 1 ELSE json('material_version_conflict') END").bind(String(p.materialId), String(p.title), String(p.author), String(p.author), Number(p.publicationYear), Number(p.publicationYear)));
    let postcondition;
    if (kind.startsWith("order.") || kind === "profile.phone") postcondition = db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM mutation_commands WHERE id=? AND actor_user_id=? AND status='completed' AND result_json IS NOT NULL) THEN 1 ELSE json('assistant_mutation_not_committed') END").bind(id, teacher.teacherUserId);
    else if (kind.startsWith("visit.")) postcondition = db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM visit_mutation_commands WHERE id=? AND owner_auth_user_id=? AND status='completed' AND result_json IS NOT NULL) THEN 1 ELSE json('assistant_mutation_not_committed') END").bind(id, actorKey);
    else if (kind === "acquisition.create") postcondition = db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM acquisition_requests WHERE submission_key=? AND teacher_user_id=?) THEN 1 ELSE json('assistant_mutation_not_committed') END").bind(`teacher:${teacher.teacherUserId}:${id}`, teacher.teacherUserId);
    else if (kind === "notifications.set") postcondition = db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM telegram_connections WHERE user_id=? AND version=? AND notify_orders=? AND notify_visits=?) THEN 1 ELSE json('assistant_mutation_not_committed') END").bind(teacher.teacherUserId, Number(p.expectedVersion) + 1, p.notifyOrders ? 1 : 0, p.notifyVisits ? 1 : 0);
    else postcondition = db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM acquisition_request_events e JOIN acquisition_requests r ON r.id=e.request_id WHERE e.id=? AND e.actor_user_id=? AND r.version=? AND r.status='in_review') THEN 1 ELSE json('assistant_mutation_not_committed') END").bind(`AQE-${id}`, teacher.teacherUserId, Number(p.expectedVersion) + 1);
    const receipt = db.prepare("UPDATE assistant_action_drafts SET result_json=? WHERE id=? AND actor_key=? AND result_json IS NULL").bind(JSON.stringify(result), id, actorKey);
    const results = await db.batch([guard, ...extra, ...statements, postcondition, receipt]);
    return results.slice(1 + extra.length, -2);
  } };
  try {
    if (kind === "order.submit") {
      const input = checked(validateMaterialRequestCreateInput(p));
      for (const row of input.items) {
        const book = await getCatalogMaterialDetail(db, row.materialId, "public");
        if (!book || book.availableQuantity < row.quantity) throw new VisitScheduleError("cart_stock_changed", 409, "Наявність змінилася. Перевірте кошик знову.");
      }
      await createTeacherMaterialRequest(guarded, teacher, input);
    }
    else if (kind === "order.cancel") { const { id: resource, ...input } = p; await cancelTeacherMaterialRequest(guarded, teacher, String(resource), checked(validateMaterialRequestCancelInput(input))); }
    else if (kind === "visit.update") { const { id: resource, ...input } = p; await updateOwnVisitBooking(guarded, teacher, String(resource), checked(validateVisitBookingUpdateInput(input))); }
    else if (kind === "visit.cancel") await cancelOwnVisitBooking(guarded, teacher, String(p.id), { requestId: id, expectedVersion: Number(p.expectedVersion), reason: null });
    else if (kind === "profile.phone") await updateTeacherOwnProfile(guarded, teacher, p as TeacherProfileUpdateInput);
    else if (kind === "notifications.set") { const { updateTelegramPreferences } = await import("./telegram-notifications.ts"); await updateTelegramPreferences(guarded, teacher.teacherUserId, p as { expectedVersion: number; notifyOrders: boolean; notifyVisits: boolean }); }
    else if (kind === "acquisition.create") await createTeacherAcquisitionRequest(guarded, teacher, checked(validateAcquisitionCreateInput(p)));
    else {
      const now = new Date().toISOString();
      await guarded.batch([
        db.prepare("UPDATE acquisition_requests SET status='in_review',version=version+1,updated_at=? WHERE id=? AND teacher_user_id=? AND status='clarification' AND version=?").bind(now, String(p.id), teacher.teacherUserId, Number(p.expectedVersion)),
        db.prepare("INSERT INTO acquisition_request_events(id,request_id,actor_user_id,actor_kind,kind,from_status,to_status,metadata_json,created_at) VALUES(?,?,?,'teacher','clarification_reply','clarification','in_review',?,?)").bind(`AQE-${id}`, String(p.id), teacher.teacherUserId, JSON.stringify({ message: p.message }), now),
        db.prepare("INSERT INTO audit_events(id,actor_user_id,actor_email,action,entity_type,entity_id,request_id,before_json,after_json,metadata_json,created_at) VALUES(?,?,?,'acquisition_request.clarification_reply','acquisition_request',?,?,NULL,?,NULL,?)").bind(`AUD-${id}`, teacher.teacherUserId, `teacher:${teacher.teacherUserId}`, String(p.id), id, JSON.stringify({ message: p.message, status: "in_review" }), now),
        queueTelegramForLibrariansStatement(db, { dedupeKey: `acquisition:${id}:reply`, auditRequestId: id, category: "orders", type: "acquisition_request_submitted", title: "Відповідь на уточнення", message: `${teacher.fullName}: ${String(p.message)}`, targetPath: "/librarian/acquisitions", entityType: "acquisition_request", entityId: String(p.id), createdAt: now }),
      ]);
    }
  } catch (error) {
    const receipt = await teacherActionRow(db, actorKey, id);
    if (receipt.result_json) return JSON.parse(receipt.result_json) as typeof result;
    if (error instanceof Error && /assistant_authorization_changed|assistant_mutation_not_committed|version_conflict|malformed JSON/iu.test(error.message)) throw new VisitScheduleError("assistant_action_conflict", 409, "Дані або доступ змінилися. Оновіть відомості й підготуйте нову дію.");
    throw error;
  }
  return result;
}
