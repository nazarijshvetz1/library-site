import { getCatalogMaterialDetail, type CatalogD1Database } from "./catalog-d1.ts";
import { VisitScheduleError, type VisitD1Database } from "./visit-schedule-store.ts";
import { getTeacherOwnProfile } from "./teacher-profile-store.ts";
import { listTeacherNotifications } from "./teacher-material-request-store.ts";
import { listTeacherAcquisitionRequests } from "./acquisition-store.ts";
import { TEACHER_ASSISTANT_ACTIONS, prepareTeacherAssistantAction } from "./assistant-teacher-actions.ts";
import { cartSignature, type AssistantCartSnapshot, type TeacherCartMaterial } from "./teacher-cart.ts";
import type { AssistantToolResult } from "./assistant-contract.ts";
import { kyivLocalNow } from "./visit-schedule-validation.ts";

type Database = VisitD1Database & CatalogD1Database;
export async function runTeacherAssistantTool(db: Database, context: { actorKey: string; teacherUserId: string; sessionId: string; cart: AssistantCartSnapshot; writesEnabled: boolean; bookingEnabled: boolean }, name: string, args: Record<string, unknown>): Promise<AssistantToolResult | null> {
  const { teacherUserId, cart } = context;
  if (context.actorKey !== `teacher:${teacherUserId}`) throw new VisitScheduleError("assistant_tool_denied", 403, "Потрібен вхід учителя.");
  if (name === "teacher_action_schema") {
    const action = String(args.action);
    if (!Object.hasOwn(TEACHER_ASSISTANT_ACTIONS, action)) throw new VisitScheduleError("invalid_action", 400, "Оберіть підтримувану дію вчителя.");
    return { success: true, data: { action, ...TEACHER_ASSISTANT_ACTIONS[action as keyof typeof TEACHER_ASSISTANT_ACTIONS], requiresButtonConfirmation: true } };
  }
  if (name === "prepare_teacher_action") {
    if (!context.writesEnabled || (String(args.action).startsWith("visit.") && !context.bookingEnabled)) throw new VisitScheduleError("assistant_writes_disabled", 403, "Ця дія через помічника зараз вимкнена.");
    return { success: true, actionPreview: await prepareTeacherAssistantAction(db, context.actorKey, context.sessionId, teacherUserId, args.action, args.details, cart), message: "Лише підготовлено. Перегляньте картку й підтвердьте кнопкою; зміни ще не збережено." };
  }
  if (name === "order_cart" || name === "update_order_cart" || name === "update_order_note") {
    const snapshot: AssistantCartSnapshot = { items: cart.items.map((i) => ({ ...i })), notes: cart.notes };
    if (name === "update_order_note") {
      const details = args.details as Record<string, unknown>;
      if (Object.keys(details).length !== 1 || typeof details.note !== "string" || details.note.length > 2000) throw new VisitScheduleError("invalid_action", 400, "Примітка має містити до 2000 символів.");
      snapshot.notes = details.note.trim();
    }
    if (name === "update_order_cart") {
      const materialId = String(args.materialId), quantity = Number(args.quantity);
      snapshot.items = snapshot.items.filter((i) => i.materialId !== materialId);
      if (quantity > 0) snapshot.items.push({ materialId, quantity });
      if (snapshot.items.length > 10 || snapshot.items.reduce((n, i) => n + i.quantity, 0) > 1000) throw new VisitScheduleError("cart_limit", 400, "В одному кошику до 10 видань і 1000 примірників.");
    }
    const materials: TeacherCartMaterial[] = [];
    for (const row of snapshot.items) {
      const item = await getCatalogMaterialDetail(db, row.materialId, "public");
      if (!item) throw new VisitScheduleError("material_not_found", 409, "Одна з позицій кошика більше не доступна. Перевірте кошик у «Замовити».");
      if (name === "update_order_cart" && row.materialId === args.materialId && row.quantity > item.availableQuantity) throw new VisitScheduleError("cart_stock_changed", 409, `Доступно ${item.availableQuantity} примірників. Уточніть кількість.`);
      materials.push({ id: item.id, title: item.title, author: item.author, year: item.year, isbn: item.isbn, rubric: item.rubric, subject: item.subject, publicationType: item.publicationType, classFrom: item.classFrom, classTo: item.classTo, publisher: item.publisher, thumbnailUrl: item.thumbnailUrl, totalQuantity: item.totalQuantity, availableQuantity: item.availableQuantity, loanedQuantity: item.loanedQuantity, reservedQuantity: item.reservedQuantity });
    }
    return { success: true, message: name === "update_order_cart" ? "Кошик оновлено. Замовлення ще не надіслано бібліотекарю." : "Це спільний кошик, ще не надіслане замовлення.",
      data: { ...snapshot, materials }, ...(name !== "order_cart" ? { cartUpdate: { before: cartSignature(cart), snapshot, materials } } : {}),
      cards: materials.map((item) => ({ kind: "material", id: item.id, title: item.title, description: item.author, image: item.thumbnailUrl, details: [`У кошику ${snapshot.items.find((i) => i.materialId === item.id)!.quantity} прим.`, `Зараз доступно ${item.availableQuantity}`] })) };
  }
  if (name === "my_profile") {
    const { readTelegramConnectionStatus } = await import("./telegram-notifications.ts");
    const [profile, telegram] = await Promise.all([getTeacherOwnProfile(db, teacherUserId), readTelegramConnectionStatus(db, teacherUserId)]);
    return { success: true, data: { fullName: profile.fullName, subjectPosition: profile.subjectPosition, mobileNumber: profile.serviceContact, primaryLocation: profile.primaryLocation, classes: profile.curatedClasses, telegram: { connected: telegram.connected, status: telegram.status, notifyOrders: telegram.notifyOrders, notifyVisits: telegram.notifyVisits } } };
  }
  if (name === "my_visits") {
    const now = kyivLocalNow();
    const rows = await db.prepare("SELECT id,visit_date AS date,start_time AS startTime,end_time AS endTime,class_year_id AS classYearId,class_label AS classLabel,purpose,version FROM visit_bookings WHERE owner_kind='teacher' AND owner_user_id=? AND status='active' AND (visit_date>? OR (visit_date=? AND end_time>?)) ORDER BY visit_date,start_time,id LIMIT 101").bind(teacherUserId, now.date, now.date, now.time).all<{ id: string; date: string; startTime: string; endTime: string; classLabel: string | null; purpose: string | null }>();
    return { success: true, data: { visits: rows.results?.slice(0, 100), truncated: (rows.results?.length ?? 0) > 100 }, cards: (rows.results ?? []).slice(0, 100).map((v) => ({ kind: "visit", id: v.id, title: v.date, description: `${v.startTime}–${v.endTime}`, details: [v.classLabel || "Особистий візит", v.purpose || "Мету не вказано"] })) };
  }
  if (name === "my_acquisitions") {
    const result = await listTeacherAcquisitionRequests(db, teacherUserId, { limit: 50, query: String(args.query ?? ""), visibility: "all" });
    const records = result.map((r) => ({ id: r.id, title: r.title, author: r.author, year: r.publicationYear, quantity: r.requestedQuantity, status: r.status, clarification: r.clarificationMessage, teacherReply: r.teacherReply, note: r.requesterNote, rejectionReason: r.rejectionReason }));
    return { success: true, data: { records, possiblyTruncated: records.length === 50 } };
  }
  if (name === "my_notifications") {
    const result = await listTeacherNotifications(db, teacherUserId, { limit: 10, cursor: typeof args.cursor === "string" ? args.cursor : undefined });
    return { success: true, data: result, cards: result.notifications.map((n) => ({ kind: "order", id: n.id, title: n.title, description: n.message, details: [n.createdAt, n.read ? "Прочитано" : "Нове"] })) };
  }
  return null;
}
