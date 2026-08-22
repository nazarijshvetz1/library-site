type D1Value = string | number | null;
export type TelegramOutboxStatement = {
  bind(...values: D1Value[]): TelegramOutboxStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[]; success?: boolean; meta?: { changes?: number } }>;
};
export type TelegramOutboxDatabase = { prepare(sql: string): TelegramOutboxStatement };

export type TelegramNotificationCategory = "orders" | "visits" | "system";
export type TelegramQueueEvent = {
  dedupeKey: string;
  auditRequestId: string;
  category: TelegramNotificationCategory;
  type: string;
  title: string;
  message: string;
  targetPath: string;
  entityType: string;
  entityId: string;
  createdAt: string;
};

export function queueTelegramForLibrariansStatement(
  db: TelegramOutboxDatabase,
  event: TelegramQueueEvent,
): TelegramOutboxStatement {
  const value = normalizedQueueEvent(event);
  return db.prepare(`
    INSERT INTO telegram_delivery_outbox (
      id,recipient_user_id,dedupe_key,category,type,title,message,target_path,
      entity_type,entity_id,status,attempts,next_attempt_at,lease_token,lease_expires_at,
      telegram_message_id,last_error_code,last_error_message,sent_at,created_at,updated_at
    )
    SELECT 'TGO-' || lower(hex(randomblob(16))),u.id,? || ':' || u.id,?,?,?,?,?,?,?,
           'pending',0,?,NULL,NULL,NULL,NULL,NULL,NULL,?,?
    FROM users u JOIN telegram_connections c ON c.user_id=u.id
    WHERE u.status='active' AND u.role IN ('admin','librarian') AND c.status='active'
      AND CASE ? WHEN 'orders' THEN c.notify_orders=1 WHEN 'visits' THEN c.notify_visits=1 ELSE 1 END
      AND EXISTS (
        SELECT 1 FROM audit_events audit
        WHERE audit.request_id=? AND audit.entity_type=? AND audit.entity_id=?
      )
    ON CONFLICT(dedupe_key) DO NOTHING
  `).bind(
    value.dedupeKey,
    value.category,
    value.type,
    value.title,
    value.message,
    value.targetPath,
    value.entityType,
    value.entityId,
    value.createdAt,
    value.createdAt,
    value.createdAt,
    value.category,
    value.auditRequestId,
    value.entityType,
    value.entityId,
  );
}

export function queueTelegramFromPortalNotificationStatement(
  db: TelegramOutboxDatabase,
  notificationId: string,
  category: TelegramNotificationCategory,
  targetPath: string,
  createdAt: string,
): TelegramOutboxStatement {
  const path = safeTargetPath(targetPath);
  if (!validIso(createdAt)) throw new Error("Invalid Telegram outbox timestamp.");
  return db.prepare(`
    INSERT INTO telegram_delivery_outbox (
      id,recipient_user_id,dedupe_key,category,type,title,message,target_path,
      entity_type,entity_id,status,attempts,next_attempt_at,lease_token,lease_expires_at,
      telegram_message_id,last_error_code,last_error_message,sent_at,created_at,updated_at
    )
    SELECT 'TGO-' || lower(hex(randomblob(16))),pn.teacher_user_id,pn.dedupe_key || ':telegram',
           ?,pn.type,pn.title,pn.message,?,pn.entity_type,pn.entity_id,
           'pending',0,?,NULL,NULL,NULL,NULL,NULL,NULL,?,?
    FROM portal_notifications pn
    JOIN users u ON u.id=pn.teacher_user_id AND u.status='active'
    JOIN telegram_connections c ON c.user_id=pn.teacher_user_id AND c.status='active'
    WHERE pn.id=?
      AND CASE ? WHEN 'orders' THEN c.notify_orders=1 WHEN 'visits' THEN c.notify_visits=1 ELSE 1 END
    ON CONFLICT(dedupe_key) DO NOTHING
  `).bind(category, path, createdAt, createdAt, createdAt, notificationId, category);
}

function normalizedQueueEvent(event: TelegramQueueEvent): TelegramQueueEvent {
  const value = {
    ...event,
    dedupeKey: safeText(event.dedupeKey, 300),
    auditRequestId: safeText(event.auditRequestId, 160),
    type: safeText(event.type, 100),
    title: safeText(event.title, 160),
    message: safeText(event.message, 1200),
    targetPath: safeTargetPath(event.targetPath),
    entityType: safeText(event.entityType, 100),
    entityId: safeText(event.entityId, 160),
  };
  if (!value.dedupeKey || !value.auditRequestId || !value.type || !value.title
    || !value.entityType || !value.entityId || !validIso(value.createdAt)) {
    throw new Error("Invalid Telegram outbox event.");
  }
  return value;
}

function safeTargetPath(value: string): string {
  const path = value.trim();
  if (!path) return "";
  if (!/^\/(?!\/)[^\r\n]{0,500}$/u.test(path)) throw new Error("Invalid Telegram target path.");
  return path;
}

function safeText(value: string, maximum: number): string {
  return [...value.normalize("NFKC")]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && code !== 127 || code === 9 || code === 10 || code === 13;
    })
    .join("").trim().slice(0, maximum);
}

function validIso(value: string): boolean {
  return /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value);
}
