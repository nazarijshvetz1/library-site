import type { ChatGPTUser } from "../app/chatgpt-auth.ts";
import { getRuntimeBoolean, getRuntimeString } from "./runtime-env.ts";

type D1Value = string | number | null;
type D1Result<T = Record<string, unknown>> = {
  results?: T[];
  success?: boolean;
  meta?: { changes?: number };
};
export type TelegramD1Statement = {
  bind(...values: D1Value[]): TelegramD1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
};
export type TelegramDatabase = {
  prepare(sql: string): TelegramD1Statement;
  batch(statements: TelegramD1Statement[]): Promise<D1Result[]>;
};

export type TelegramNotificationCategory = "orders" | "visits" | "system";
export type TelegramFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const TELEGRAM_LINK_TOKEN_SECONDS = 10 * 60;
const TELEGRAM_DELIVERY_LEASE_SECONDS = 45;
const TELEGRAM_MAX_ATTEMPTS = 8;
const TELEGRAM_DRAIN_LIMIT = 10;
const TELEGRAM_API_TIMEOUT_MS = 6_000;
const TELEGRAM_BOT_API = "https://api.telegram.org";

export class TelegramIntegrationError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  readonly permanent: boolean;

  constructor(
    code: string,
    status: number,
    message: string,
    options: { retryAfterSeconds?: number | null; permanent?: boolean } = {},
  ) {
    super(message);
    this.name = "TelegramIntegrationError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.permanent = options.permanent === true;
  }
}

type TelegramConfiguration = {
  linkingEnabled: boolean;
  notificationsEnabled: boolean;
  miniAppEnabled: boolean;
  botUsername: string | null;
  botToken: string | null;
  webhookSecret: string | null;
};

export type TelegramConnectionStatus = {
  configured: boolean;
  linkingEnabled: boolean;
  notificationsEnabled: boolean;
  miniAppEnabled: boolean;
  botUsername: string | null;
  connected: boolean;
  status: "active" | "disabled" | "blocked" | null;
  notifyOrders: boolean;
  notifyVisits: boolean;
  version: number | null;
  linkedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastErrorCode: string | null;
};

type ConnectionRow = {
  status: "active" | "disabled" | "blocked";
  notify_orders: number;
  notify_visits: number;
  version: number;
  linked_at: string;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error_code: string | null;
};

type OutboxRow = {
  id: string;
  recipient_user_id: string;
  chat_id: string;
  title: string;
  message: string;
  target_path: string;
  attempts: number;
  created_at: string;
};

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

export function telegramConfigurationStatus(): Omit<TelegramConnectionStatus,
  "connected" | "status" | "notifyOrders" | "notifyVisits" | "version" | "linkedAt" |
  "lastSuccessAt" | "lastFailureAt" | "lastErrorCode"> {
  const configuration = telegramConfiguration();
  return {
    configured: Boolean(configuration.botUsername && configuration.botToken && configuration.webhookSecret),
    linkingEnabled: configuration.linkingEnabled,
    notificationsEnabled: configuration.notificationsEnabled,
    miniAppEnabled: configuration.miniAppEnabled,
    botUsername: configuration.botUsername,
  };
}

export async function resolveLibrarianTelegramUserId(
  db: TelegramDatabase,
  user: ChatGPTUser,
): Promise<string> {
  const rows = await db.prepare(`
    SELECT id FROM users
    WHERE status='active' AND role IN ('admin','librarian')
      AND (auth_user_id=? OR lower(email)=lower(?))
    ORDER BY CASE WHEN auth_user_id=? THEN 0 ELSE 1 END,id
    LIMIT 2
  `).bind(user.userId, user.email, user.userId).all<{ id: string }>();
  if ((rows.results ?? []).length !== 1) {
    throw new TelegramIntegrationError(
      "actor_not_mapped",
      403,
      "Обліковий запис не прив’язано до одного активного бібліотекаря.",
      { permanent: true },
    );
  }
  return rows.results![0].id;
}

export async function readTelegramConnectionStatus(
  db: TelegramDatabase,
  userId: string,
): Promise<TelegramConnectionStatus> {
  const configuration = telegramConfigurationStatus();
  const row = await db.prepare(`
    SELECT c.status,c.notify_orders,c.notify_visits,c.version,c.linked_at,
           c.last_success_at,c.last_failure_at,c.last_error_code
    FROM users u LEFT JOIN telegram_connections c ON c.user_id=u.id
    WHERE u.id=? AND u.status='active' AND u.role IN ('admin','librarian','teacher')
    LIMIT 1
  `).bind(userId).first<ConnectionRow>();
  if (!row) {
    throw new TelegramIntegrationError("user_not_active", 403, "Профіль користувача неактивний.", {
      permanent: true,
    });
  }
  return {
    ...configuration,
    connected: row.status === "active",
    status: row.status ?? null,
    notifyOrders: row.status ? Boolean(row.notify_orders) : true,
    notifyVisits: row.status ? Boolean(row.notify_visits) : true,
    version: row.status ? Number(row.version) : null,
    linkedAt: row.linked_at ?? null,
    lastSuccessAt: row.last_success_at ?? null,
    lastFailureAt: row.last_failure_at ?? null,
    lastErrorCode: row.last_error_code ?? null,
  };
}

export async function createTelegramLinkToken(
  db: TelegramDatabase,
  userId: string,
  options: { now?: Date; randomBytes?: Uint8Array } = {},
): Promise<{ linkUrl: string; expiresAt: string }> {
  const configuration = requireLinkingConfiguration();
  const nowDate = options.now ?? new Date();
  const now = nowDate.toISOString();
  const expiresAt = new Date(nowDate.getTime() + TELEGRAM_LINK_TOKEN_SECONDS * 1000).toISOString();
  const bytes = options.randomBytes ?? crypto.getRandomValues(new Uint8Array(32));
  if (bytes.byteLength < 32) {
    throw new TelegramIntegrationError("randomness_unavailable", 503, "Не вдалося створити безпечне посилання.");
  }
  const token = base64Url(bytes);
  const tokenHash = await sha256Hex(token);
  const tokenId = `TGL-${crypto.randomUUID()}`;
  await db.batch([
    db.prepare(`UPDATE telegram_link_tokens SET revoked_at=?
      WHERE user_id=? AND consumed_at IS NULL AND revoked_at IS NULL`).bind(now, userId),
    db.prepare(`
      INSERT INTO telegram_link_tokens (
        id,user_id,token_hash,expires_at,consumed_at,consumed_update_id,revoked_at,created_at
      )
      SELECT ?,u.id,?,?,NULL,NULL,NULL,?
      FROM users u WHERE u.id=? AND u.status='active'
        AND u.role IN ('admin','librarian','teacher')
    `).bind(tokenId, tokenHash, expiresAt, now, userId),
  ]);
  const inserted = await db.prepare(`SELECT id FROM telegram_link_tokens WHERE id=? AND user_id=? LIMIT 1`)
    .bind(tokenId, userId).first<{ id: string }>();
  if (!inserted) {
    throw new TelegramIntegrationError("user_not_active", 403, "Профіль користувача неактивний.", {
      permanent: true,
    });
  }
  return {
    linkUrl: `https://t.me/${configuration.botUsername}?start=${token}`,
    expiresAt,
  };
}

export async function updateTelegramPreferences(
  db: TelegramDatabase,
  userId: string,
  input: { notifyOrders: boolean; notifyVisits: boolean; expectedVersion: number },
): Promise<TelegramConnectionStatus> {
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`
      UPDATE telegram_connections
      SET notify_orders=?,notify_visits=?,version=version+1,updated_at=?
      WHERE user_id=? AND status='active' AND version=?
        AND EXISTS (SELECT 1 FROM users WHERE id=? AND status='active')
    `).bind(
      input.notifyOrders ? 1 : 0,
      input.notifyVisits ? 1 : 0,
      now,
      userId,
      input.expectedVersion,
      userId,
    ),
  ]);
  const status = await readTelegramConnectionStatus(db, userId);
  if (!status.connected || status.version !== input.expectedVersion + 1) {
    throw new TelegramIntegrationError(
      "connection_version_conflict",
      409,
      "Налаштування Telegram уже змінилися. Оновіть сторінку.",
      { permanent: true },
    );
  }
  return status;
}

export async function disconnectTelegram(
  db: TelegramDatabase,
  userId: string,
  expectedVersion: number,
  fetcher?: TelegramFetcher,
): Promise<TelegramConnectionStatus> {
  const now = new Date().toISOString();
  const connection = fetcher ? await db.prepare(`
    SELECT chat_id FROM telegram_connections
    WHERE user_id=? AND status='active' AND version=? LIMIT 1
  `).bind(userId, expectedVersion).first<{ chat_id: string }>() : null;
  await db.batch([
    db.prepare(`
      UPDATE telegram_connections
      SET status='disabled',disabled_at=?,version=version+1,updated_at=?
      WHERE user_id=? AND status='active' AND version=?
        AND EXISTS (SELECT 1 FROM users WHERE id=? AND status='active')
    `).bind(now, now, userId, expectedVersion, userId),
    db.prepare(`UPDATE telegram_link_tokens SET revoked_at=?
      WHERE user_id=? AND consumed_at IS NULL AND revoked_at IS NULL`).bind(now, userId),
  ]);
  const status = await readTelegramConnectionStatus(db, userId);
  if (status.status !== "disabled" || status.version !== expectedVersion + 1) {
    throw new TelegramIntegrationError(
      "connection_version_conflict",
      409,
      "Підключення Telegram уже змінилося. Оновіть сторінку.",
      { permanent: true },
    );
  }
  const botToken = telegramConfiguration().botToken;
  if (fetcher && botToken && connection) {
    await bestEffortChatMenuButton(botToken, connection.chat_id, null, fetcher);
  }
  return status;
}

export async function sendTelegramTestMessage(
  db: TelegramDatabase,
  userId: string,
  siteOrigin: string,
  targetPath = "/teacher?tab=notifications",
  fetcher: TelegramFetcher = fetch,
): Promise<void> {
  const configuration = requireNotificationConfiguration();
  const connection = await db.prepare(`
    SELECT c.chat_id FROM telegram_connections c
    JOIN users u ON u.id=c.user_id AND u.status='active'
    WHERE c.user_id=? AND c.status='active' LIMIT 1
  `).bind(userId).first<{ chat_id: string }>();
  if (!connection) {
    throw new TelegramIntegrationError("connection_not_active", 409, "Спочатку підключіть Telegram.", {
      permanent: true,
    });
  }
  try {
    await telegramSendMessage(configuration.botToken, connection.chat_id, {
      title: "Тестове повідомлення",
      message: "Telegram успішно підключено до «Єдиної бібліотеки».",
      targetUrl: new URL(safeTargetPath(targetPath), trustedSiteOrigin(siteOrigin)).toString(),
    }, fetcher);
    await recordConnectionSuccess(db, userId, new Date().toISOString());
  } catch (error) {
    const failure = telegramFailure(error);
    await recordConnectionFailure(db, userId, failure, new Date().toISOString());
    throw failure;
  }
}

export async function registerTelegramWebhook(
  siteOrigin: string,
  fetcher: TelegramFetcher = fetch,
  strictCommands = false,
): Promise<void> {
  const configuration = requireLinkingConfiguration();
  const webhookUrl = new URL("/api/telegram/webhook", trustedSiteOrigin(siteOrigin)).toString();
  await telegramApiRequest(configuration.botToken, "setWebhook", {
    url: webhookUrl,
    secret_token: configuration.webhookSecret,
    allowed_updates: ["message"],
    drop_pending_updates: false,
  }, fetcher);
  const commands = [
    { command: "start", description: "Підключити бота або відкрити меню" },
    { command: "menu", description: "Показати меню бібліотеки" },
    { command: "stop", description: "Вимкнути Telegram-сповіщення" },
  ];
  for (const languageCode of [null, "uk"] as const) {
    try {
      await telegramApiRequest(configuration.botToken, "setMyCommands", {
        commands,
        scope: { type: "all_private_chats" },
        ...(languageCode ? { language_code: languageCode } : {}),
      }, fetcher);
    } catch (error) {
      if (strictCommands) throw error;
      // The webhook is authoritative; command hints can be retried on the next link request.
    }
  }
}

export async function repairTelegramWebhookAndSendTestMessage(
  db: TelegramDatabase,
  userId: string,
  siteOrigin: string,
  targetPath = "/librarian/teachers",
  fetcher: TelegramFetcher = fetch,
): Promise<void> {
  // A BotFather token rotation preserves the saved chat connection but can
  // leave inbound updates pointed at stale webhook credentials. A librarian's
  // explicit test refreshes the pinned webhook and command hints first, then
  // verifies outbound delivery without disconnecting the existing profile.
  await registerTelegramWebhook(siteOrigin, fetcher, true);
  await sendTelegramTestMessage(db, userId, siteOrigin, targetPath, fetcher);
}

export function queueTelegramForLibrariansStatement(
  db: TelegramDatabase,
  event: TelegramQueueEvent,
): TelegramD1Statement {
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

export function queueTelegramForUserStatement(
  db: TelegramDatabase,
  recipientUserId: string,
  event: TelegramQueueEvent,
): TelegramD1Statement {
  const value = normalizedQueueEvent(event);
  return db.prepare(`
    INSERT INTO telegram_delivery_outbox (
      id,recipient_user_id,dedupe_key,category,type,title,message,target_path,
      entity_type,entity_id,status,attempts,next_attempt_at,lease_token,lease_expires_at,
      telegram_message_id,last_error_code,last_error_message,sent_at,created_at,updated_at
    )
    SELECT 'TGO-' || lower(hex(randomblob(16))),u.id,?,?,?,?,?,?,?,?,
           'pending',0,?,NULL,NULL,NULL,NULL,NULL,NULL,?,?
    FROM users u JOIN telegram_connections c ON c.user_id=u.id
    WHERE u.id=? AND u.status='active' AND c.status='active'
      AND CASE ? WHEN 'orders' THEN c.notify_orders=1 WHEN 'visits' THEN c.notify_visits=1 ELSE 1 END
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
    recipientUserId,
    value.category,
  );
}

export function queueTelegramFromPortalNotificationStatement(
  db: TelegramDatabase,
  notificationId: string,
  category: TelegramNotificationCategory,
  targetPath: string,
  createdAt: string,
): TelegramD1Statement {
  const path = safeTargetPath(targetPath);
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

export async function drainTelegramOutbox(
  db: TelegramDatabase,
  options: {
    siteOrigin: string;
    fetcher?: TelegramFetcher;
    now?: Date;
    limit?: number;
  },
): Promise<{ attempted: number; sent: number; failed: number }> {
  const configuration = telegramConfiguration();
  if (!configuration.notificationsEnabled || !configuration.botToken) {
    return { attempted: 0, sent: 0, failed: 0 };
  }
  const fetcher = options.fetcher ?? fetch;
  const nowDate = options.now ?? new Date();
  const now = nowDate.toISOString();
  const origin = trustedSiteOrigin(options.siteOrigin);
  const limit = Math.max(1, Math.min(TELEGRAM_DRAIN_LIMIT, Math.trunc(options.limit ?? TELEGRAM_DRAIN_LIMIT)));
  await db.batch([
    db.prepare(`
      UPDATE telegram_delivery_outbox
      SET status='retry',lease_token=NULL,lease_expires_at=NULL,next_attempt_at=?,updated_at=?
      WHERE status='processing' AND lease_expires_at<=?
    `).bind(now, now, now),
  ]);
  const due = await db.prepare(`
    SELECT o.id,o.recipient_user_id,c.chat_id,o.title,o.message,o.target_path,o.attempts,o.created_at
    FROM telegram_delivery_outbox o
    JOIN telegram_connections c ON c.user_id=o.recipient_user_id AND c.status='active'
    JOIN users u ON u.id=o.recipient_user_id AND u.status='active'
    WHERE o.status IN ('pending','retry') AND o.next_attempt_at<=?
      AND NOT EXISTS (
        SELECT 1 FROM telegram_delivery_outbox earlier
        WHERE earlier.recipient_user_id=o.recipient_user_id
          AND earlier.status IN ('pending','processing','retry')
          AND (earlier.created_at<o.created_at OR (earlier.created_at=o.created_at AND earlier.id<o.id))
      )
    ORDER BY o.created_at,o.id LIMIT ?
  `).bind(now, limit).all<OutboxRow>();
  let attempted = 0;
  let sent = 0;
  let failed = 0;
  for (const row of due.results ?? []) {
    const leaseToken = `lease-${crypto.randomUUID()}`;
    const leaseExpiresAt = new Date(nowDate.getTime() + TELEGRAM_DELIVERY_LEASE_SECONDS * 1000).toISOString();
    const claim = await db.batch([
      db.prepare(`
        UPDATE telegram_delivery_outbox
        SET status='processing',attempts=attempts+1,lease_token=?,lease_expires_at=?,updated_at=?
        WHERE id=? AND status IN ('pending','retry') AND next_attempt_at<=?
      `).bind(leaseToken, leaseExpiresAt, now, row.id, now),
    ]);
    if (Number(claim[0]?.meta?.changes ?? 0) !== 1) continue;
    attempted += 1;
    try {
      const result = await telegramSendMessage(configuration.botToken, row.chat_id, {
        title: row.title,
        message: row.message,
        targetUrl: row.target_path ? new URL(row.target_path, origin).toString() : null,
      }, fetcher);
      await db.batch([
        db.prepare(`
          UPDATE telegram_delivery_outbox
          SET status='sent',telegram_message_id=?,sent_at=?,lease_token=NULL,lease_expires_at=NULL,
              last_error_code=NULL,last_error_message=NULL,updated_at=?
          WHERE id=? AND status='processing' AND lease_token=?
        `).bind(result.messageId, now, now, row.id, leaseToken),
        connectionSuccessStatement(db, row.recipient_user_id, now),
      ]);
      sent += 1;
    } catch (error) {
      const failure = telegramFailure(error);
      const attempts = Number(row.attempts) + 1;
      const dead = failure.permanent || attempts >= TELEGRAM_MAX_ATTEMPTS;
      const retryAfter = failure.retryAfterSeconds ?? exponentialRetrySeconds(attempts);
      const nextAttemptAt = new Date(nowDate.getTime() + retryAfter * 1000).toISOString();
      const statements = [
        db.prepare(`
          UPDATE telegram_delivery_outbox
          SET status=?,next_attempt_at=?,lease_token=NULL,lease_expires_at=NULL,
              last_error_code=?,last_error_message=?,updated_at=?
          WHERE id=? AND status='processing' AND lease_token=?
        `).bind(
          dead ? "dead" : "retry",
          dead ? now : nextAttemptAt,
          failure.code,
          sanitizedError(failure.message),
          now,
          row.id,
          leaseToken,
        ),
        connectionFailureStatement(db, row.recipient_user_id, failure, now),
      ];
      await db.batch(statements);
      failed += 1;
    }
  }
  return { attempted, sent, failed };
}

export async function processTelegramWebhookUpdate(
  db: TelegramDatabase,
  rawPayload: string,
  payload: unknown,
  fetcher: TelegramFetcher = fetch,
  siteOrigin?: string,
): Promise<{ outcome: string; duplicate: boolean }> {
  const configuration = requireLinkingConfiguration();
  const update = telegramUpdate(payload);
  const payloadHash = await sha256Hex(rawPayload);
  const existing = await db.prepare(`SELECT payload_hash,outcome FROM telegram_webhook_updates WHERE update_id=? LIMIT 1`)
    .bind(update.updateId).first<{ payload_hash: string; outcome: string }>();
  if (existing) {
    if (existing.payload_hash !== payloadHash) {
      throw new TelegramIntegrationError("webhook_update_conflict", 409, "Повторний Telegram update не збігається.", {
        permanent: true,
      });
    }
    return { outcome: existing.outcome, duplicate: true };
  }
  if (!update.message || update.message.chatType !== "private") {
    const inserted = await insertWebhookReceipt(db, update.updateId, payloadHash, "ignored_non_private");
    return { outcome: "ignored_non_private", duplicate: !inserted };
  }
  const command = telegramCommand(update.message.text);
  if (command.kind === "start") {
    const tokenHash = await sha256Hex(command.token);
    const now = new Date().toISOString();
    const token = await db.prepare(`
      SELECT t.user_id,u.full_name,u.role
      FROM telegram_link_tokens t JOIN users u ON u.id=t.user_id
      WHERE t.token_hash=? AND t.consumed_at IS NULL AND t.revoked_at IS NULL
        AND t.expires_at>? AND u.status='active' AND u.role IN ('admin','librarian','teacher')
      LIMIT 1
    `).bind(tokenHash, now).first<{ user_id: string; full_name: string; role: "admin" | "librarian" | "teacher" }>();
    if (!token) {
      const inserted = await insertWebhookReceipt(db, update.updateId, payloadHash, "link_invalid");
      if (inserted) await bestEffortBotReply(configuration.botToken, update.message.chatId,
        "Посилання недійсне або вже використане. Створіть нове посилання у своєму кабінеті.", fetcher);
      return { outcome: "link_invalid", duplicate: !inserted };
    }
    const conflict = await db.prepare(`
      SELECT user_id FROM telegram_connections
      WHERE (chat_id=? OR telegram_user_id=?) AND user_id!=? AND status='active' LIMIT 1
    `).bind(update.message.chatId, update.message.telegramUserId, token.user_id).first<{ user_id: string }>();
    if (conflict) {
      const inserted = await insertWebhookReceipt(db, update.updateId, payloadHash, "link_conflict");
      if (inserted) await bestEffortBotReply(configuration.botToken, update.message.chatId,
        "Цей Telegram уже підключено до іншого профілю. Спочатку від’єднайте його на сайті.", fetcher);
      return { outcome: "link_conflict", duplicate: !inserted };
    }
    const results = await db.batch([
      db.prepare(`INSERT INTO telegram_webhook_updates(update_id,payload_hash,outcome,processed_at)
        VALUES (?,?, 'linked',?) ON CONFLICT(update_id) DO NOTHING`)
        .bind(update.updateId, payloadHash, now),
      db.prepare(`
        UPDATE telegram_link_tokens SET consumed_at=?,consumed_update_id=?
        WHERE token_hash=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?
          AND user_id=? AND EXISTS (
            SELECT 1 FROM telegram_webhook_updates
            WHERE update_id=? AND payload_hash=? AND outcome='linked'
          )
      `).bind(now, update.updateId, tokenHash, now, token.user_id, update.updateId, payloadHash),
      db.prepare(`
        DELETE FROM telegram_connections
        WHERE user_id!=? AND status!='active' AND (chat_id=? OR telegram_user_id=?)
          AND EXISTS (
            SELECT 1 FROM telegram_link_tokens
            WHERE token_hash=? AND consumed_update_id=? AND user_id=?
          )
      `).bind(
        token.user_id,
        update.message.chatId,
        update.message.telegramUserId,
        tokenHash,
        update.updateId,
        token.user_id,
      ),
      db.prepare(`
        INSERT INTO telegram_connections (
          user_id,telegram_user_id,chat_id,username,status,notify_orders,notify_visits,version,
          linked_at,disabled_at,last_success_at,last_failure_at,last_error_code,created_at,updated_at
        )
        VALUES ((
          SELECT t.user_id
          FROM telegram_link_tokens t JOIN users u ON u.id=t.user_id AND u.status='active'
          WHERE t.token_hash=? AND t.consumed_update_id=? AND t.user_id=?
            AND u.role IN ('admin','librarian','teacher')
        ),?,?,?,'active',1,1,1,?,NULL,NULL,NULL,NULL,?,?)
        ON CONFLICT(user_id) DO UPDATE SET
          telegram_user_id=excluded.telegram_user_id,chat_id=excluded.chat_id,username=excluded.username,
          status='active',disabled_at=NULL,linked_at=excluded.linked_at,last_error_code=NULL,
          version=telegram_connections.version+1,updated_at=excluded.updated_at
      `).bind(
        tokenHash,
        update.updateId,
        token.user_id,
        update.message.telegramUserId,
        update.message.chatId,
        update.message.username,
        now,
        now,
        now,
      ),
    ]);
    if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
      return { outcome: "linked", duplicate: true };
    }
    await bestEffortConnectedMenu(
      configuration.botToken,
      update.message.chatId,
      token.role,
      token.full_name,
      siteOrigin,
      true,
      fetcher,
    );
    return { outcome: "linked", duplicate: false };
  }
  if (command.kind === "stop") {
    const now = new Date().toISOString();
    const results = await db.batch([
      db.prepare(`INSERT INTO telegram_webhook_updates(update_id,payload_hash,outcome,processed_at)
        VALUES (?,?,'disconnected',?) ON CONFLICT(update_id) DO NOTHING`)
        .bind(update.updateId, payloadHash, now),
      db.prepare(`
        UPDATE telegram_connections SET status='disabled',disabled_at=?,version=version+1,updated_at=?
        WHERE chat_id=? AND telegram_user_id=? AND status='active'
          AND EXISTS (SELECT 1 FROM telegram_webhook_updates
            WHERE update_id=? AND payload_hash=? AND outcome='disconnected')
      `).bind(now, now, update.message.chatId, update.message.telegramUserId, update.updateId, payloadHash),
    ]);
    const inserted = Number(results[0]?.meta?.changes ?? 0) === 1;
    if (inserted) {
      await bestEffortBotReply(configuration.botToken, update.message.chatId,
        "Telegram-сповіщення вимкнено. Підключити їх знову можна у своєму кабінеті.", fetcher);
      await bestEffortChatMenuButton(configuration.botToken, update.message.chatId, null, fetcher);
    }
    return { outcome: "disconnected", duplicate: !inserted };
  }
  if (command.kind === "menu") {
    const profile = await connectedTelegramProfile(
      db,
      update.message.chatId,
      update.message.telegramUserId,
    );
    const inserted = await insertWebhookReceipt(db, update.updateId, payloadHash, profile ? "menu" : "menu_unlinked");
    if (inserted) {
      if (profile) {
        await bestEffortConnectedMenu(
          configuration.botToken,
          update.message.chatId,
          profile.role,
          profile.full_name,
          siteOrigin,
          false,
          fetcher,
        );
      } else {
        await bestEffortBotReply(
          configuration.botToken,
          update.message.chatId,
          "Спочатку підключіть Telegram у кабінеті вчителя або бібліотекаря на сайті.",
          fetcher,
        );
      }
    }
    return { outcome: profile ? "menu" : "menu_unlinked", duplicate: !inserted };
  }
  const inserted = await insertWebhookReceipt(db, update.updateId, payloadHash, "ignored_command");
  if (inserted) await bestEffortBotReply(configuration.botToken, update.message.chatId,
    "Керуйте Telegram-сповіщеннями у своєму кабінеті на сайті «Єдина бібліотека».", fetcher);
  return { outcome: "ignored_command", duplicate: !inserted };
}

export async function telegramWebhookSecretMatches(value: string | null): Promise<boolean> {
  const expected = telegramConfiguration().webhookSecret;
  if (!expected || !value || value.length > 256) return false;
  const [left, right] = await Promise.all([sha256Bytes(expected), sha256Bytes(value)]);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function telegramConfiguration(): TelegramConfiguration {
  const username = getRuntimeString("TELEGRAM_BOT_USERNAME")?.replace(/^@/u, "") ?? null;
  return {
    linkingEnabled: getRuntimeBoolean("TELEGRAM_LINKING_ENABLED"),
    notificationsEnabled: getRuntimeBoolean("TELEGRAM_NOTIFICATIONS_ENABLED"),
    miniAppEnabled: getRuntimeBoolean("TELEGRAM_MINI_APP_ENABLED"),
    botUsername: username && /^[A-Za-z0-9_]{5,32}$/u.test(username) ? username : null,
    botToken: getRuntimeString("TELEGRAM_BOT_TOKEN"),
    webhookSecret: validWebhookSecret(getRuntimeString("TELEGRAM_WEBHOOK_SECRET")),
  };
}

function requireLinkingConfiguration(): TelegramConfiguration & {
  botUsername: string;
  botToken: string;
  webhookSecret: string;
} {
  const configuration = telegramConfiguration();
  if (!configuration.linkingEnabled || !configuration.botUsername
    || !configuration.botToken || !configuration.webhookSecret) {
    throw new TelegramIntegrationError(
      "telegram_linking_unavailable",
      503,
      "Підключення Telegram ще не налаштовано бібліотекарем.",
    );
  }
  return configuration as TelegramConfiguration & { botUsername: string; botToken: string; webhookSecret: string };
}

function requireNotificationConfiguration(): TelegramConfiguration & { botToken: string } {
  const configuration = telegramConfiguration();
  if (!configuration.notificationsEnabled || !configuration.botToken) {
    throw new TelegramIntegrationError(
      "telegram_notifications_unavailable",
      503,
      "Telegram-сповіщення ще не ввімкнено бібліотекарем.",
    );
  }
  return configuration as TelegramConfiguration & { botToken: string };
}

function validWebhookSecret(value: string | null): string | null {
  return value && /^[A-Za-z0-9_-]{16,256}$/u.test(value) ? value : null;
}

function normalizedQueueEvent(event: TelegramQueueEvent): TelegramQueueEvent {
  const dedupeKey = safePlainText(event.dedupeKey, 300);
  const auditRequestId = safePlainText(event.auditRequestId, 160);
  const type = safePlainText(event.type, 100);
  const title = safePlainText(event.title, 160);
  const message = safePlainText(event.message, 1200);
  const entityType = safePlainText(event.entityType, 100);
  const entityId = safePlainText(event.entityId, 160);
  if (!dedupeKey || !auditRequestId || !type || !title || !entityType || !entityId || !validIso(event.createdAt)) {
    throw new TelegramIntegrationError("notification_invalid", 500, "Некоректна внутрішня подія Telegram.");
  }
  return {
    ...event,
    dedupeKey,
    auditRequestId,
    type,
    title,
    message,
    targetPath: safeTargetPath(event.targetPath),
    entityType,
    entityId,
  };
}

function safeTargetPath(value: string): string {
  const path = value.trim();
  if (!path) return "";
  if (!/^\/(?!\/)[^\r\n]{0,500}$/u.test(path)) {
    throw new TelegramIntegrationError("target_path_invalid", 500, "Некоректне внутрішнє посилання Telegram.");
  }
  return path;
}

function trustedSiteOrigin(value: string): string {
  const configured = getRuntimeString("TELEGRAM_SITE_ORIGIN");
  if (telegramConfiguration().miniAppEnabled && !configured) {
    throw new TelegramIntegrationError(
      "site_origin_unconfigured",
      503,
      "Не налаштовано канонічну адресу Telegram Mini App.",
    );
  }
  const url = new URL(configured ?? value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/"
    || url.search || url.hash) {
    throw new TelegramIntegrationError("site_origin_invalid", 500, "Некоректна адреса сайту.");
  }
  return url.origin;
}

function telegramUpdate(value: unknown): {
  updateId: string;
  message: { chatId: string; telegramUserId: string; username: string | null; chatType: string; text: string } | null;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TelegramIntegrationError("webhook_payload_invalid", 400, "Некоректний Telegram update.", {
      permanent: true,
    });
  }
  const record = value as Record<string, unknown>;
  const updateId = integerText(record.update_id);
  const message = record.message;
  if (!updateId) {
    throw new TelegramIntegrationError("webhook_payload_invalid", 400, "Некоректний номер Telegram update.", {
      permanent: true,
    });
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) return { updateId, message: null };
  const messageRecord = message as Record<string, unknown>;
  const chat = messageRecord.chat;
  const from = messageRecord.from;
  if (!chat || typeof chat !== "object" || Array.isArray(chat)
    || !from || typeof from !== "object" || Array.isArray(from)) return { updateId, message: null };
  const chatRecord = chat as Record<string, unknown>;
  const fromRecord = from as Record<string, unknown>;
  const chatId = integerText(chatRecord.id);
  const telegramUserId = integerText(fromRecord.id);
  const chatType = typeof chatRecord.type === "string" ? chatRecord.type : "";
  const text = typeof messageRecord.text === "string" ? messageRecord.text.normalize("NFKC").slice(0, 512) : "";
  const username = typeof fromRecord.username === "string" && /^[A-Za-z0-9_]{1,32}$/u.test(fromRecord.username)
    ? fromRecord.username
    : null;
  if (!chatId || !telegramUserId) return { updateId, message: null };
  return { updateId, message: { chatId, telegramUserId, username, chatType, text } };
}

function telegramCommand(text: string):
  | { kind: "start"; token: string }
  | { kind: "menu" }
  | { kind: "stop" }
  | { kind: "other" } {
  const trimmed = text.trim();
  const start = trimmed.match(/^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{40,64})$/u);
  if (start) return { kind: "start", token: start[1] };
  if (/^\/(?:start|menu|cabinet|help)(?:@[A-Za-z0-9_]+)?$/u.test(trimmed)) return { kind: "menu" };
  if (/^\/(?:stop|disconnect)(?:@[A-Za-z0-9_]+)?$/u.test(trimmed)) return { kind: "stop" };
  return { kind: "other" };
}

async function insertWebhookReceipt(
  db: TelegramDatabase,
  updateId: string,
  payloadHash: string,
  outcome: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db.batch([
    db.prepare(`INSERT INTO telegram_webhook_updates(update_id,payload_hash,outcome,processed_at)
      VALUES (?,?,?,?) ON CONFLICT(update_id) DO NOTHING`).bind(updateId, payloadHash, outcome, now),
  ]);
  return Number(result[0]?.meta?.changes ?? 0) === 1;
}

async function telegramSendMessage(
  botToken: string,
  chatId: string,
  value: { title: string; message: string; targetUrl: string | null },
  fetcher: TelegramFetcher,
): Promise<{ messageId: string }> {
  const text = `<b>${escapeHtml(value.title)}</b>${value.message ? `\n${escapeHtml(value.message)}` : ""}`;
  const result = await telegramApiRequest(botToken, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(value.targetUrl ? {
      reply_markup: { inline_keyboard: [[{ text: "Відкрити на сайті", url: value.targetUrl }]] },
    } : {}),
  }, fetcher) as Record<string, unknown>;
  const messageId = integerText(result.message_id);
  if (!messageId) {
    throw new TelegramIntegrationError("telegram_response_invalid", 503, "Telegram не підтвердив надсилання.");
  }
  return { messageId };
}

async function telegramApiRequest(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
  fetcher: TelegramFetcher,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_API_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetcher(`${TELEGRAM_BOT_API}/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw new TelegramIntegrationError(
      error instanceof DOMException && error.name === "AbortError" ? "telegram_timeout" : "telegram_network_error",
      503,
      error instanceof DOMException && error.name === "AbortError"
        ? "Telegram не відповів вчасно."
        : "Не вдалося з’єднатися з Telegram.",
    );
  } finally {
    clearTimeout(timer);
  }
  let payload: Record<string, unknown> | null = null;
  try {
    const parsed = await response.json() as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch {
    payload = null;
  }
  if (!response.ok || payload?.ok !== true) {
    const description = safePlainText(typeof payload?.description === "string" ? payload.description : "Помилка Telegram.", 240);
    const parameters = payload?.parameters && typeof payload.parameters === "object" && !Array.isArray(payload.parameters)
      ? payload.parameters as Record<string, unknown>
      : null;
    const retryAfter = boundedRetryAfter(parameters?.retry_after);
    const code = response.status === 429 ? "telegram_rate_limited"
      : response.status === 403 ? "telegram_blocked"
        : response.status >= 500 ? "telegram_server_error"
          : "telegram_rejected";
    throw new TelegramIntegrationError(code, response.status || 503, description || "Помилка Telegram.", {
      retryAfterSeconds: retryAfter,
      permanent: response.status === 400 || response.status === 403,
    });
  }
  return payload.result;
}

async function bestEffortBotReply(
  botToken: string,
  chatId: string,
  message: string,
  fetcher: TelegramFetcher,
): Promise<void> {
  try {
    await telegramApiRequest(botToken, "sendMessage", {
      chat_id: chatId,
      text: safePlainText(message, 1200),
      link_preview_options: { is_disabled: true },
    }, fetcher);
  } catch {
    // Linking state is authoritative in D1 even when Telegram cannot display the confirmation.
  }
}

type ConnectedTelegramRole = "admin" | "librarian" | "teacher";

async function connectedTelegramProfile(
  db: TelegramDatabase,
  chatId: string,
  telegramUserId: string,
): Promise<{ full_name: string; role: ConnectedTelegramRole } | null> {
  return db.prepare(`
    SELECT u.full_name,u.role
    FROM telegram_connections c JOIN users u ON u.id=c.user_id
    WHERE c.chat_id=? AND c.telegram_user_id=? AND c.status='active'
      AND u.status='active' AND u.role IN ('admin','librarian','teacher')
    LIMIT 1
  `).bind(chatId, telegramUserId).first<{ full_name: string; role: ConnectedTelegramRole }>();
}

async function bestEffortConnectedMenu(
  botToken: string,
  chatId: string,
  role: ConnectedTelegramRole,
  fullName: string,
  siteOrigin: string | undefined,
  linked: boolean,
  fetcher: TelegramFetcher,
): Promise<void> {
  try {
    const origin = siteOrigin ? trustedSiteOrigin(siteOrigin) : null;
    const configuration = telegramConfiguration();
    const keyboard = origin ? telegramRoleKeyboard(role, origin, configuration.miniAppEnabled) : null;
    const greeting = linked
      ? `Telegram підключено до профілю «${safePlainText(fullName, 120)}».`
      : `Профіль: «${safePlainText(fullName, 120)}».`;
    await telegramApiRequest(botToken, "sendMessage", {
      chat_id: chatId,
      text: `<b>${escapeHtml(greeting)}</b>\nОберіть потрібний розділ:`,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    }, fetcher);
    if (role === "teacher" && origin && configuration.miniAppEnabled) {
      await bestEffortChatMenuButton(
        botToken,
        chatId,
        new URL("/teacher/telegram?tab=overview", origin).toString(),
        fetcher,
      );
    } else if (origin) {
      await bestEffortChatMenuButton(botToken, chatId, null, fetcher);
    }
  } catch {
    // D1 remains authoritative even if Telegram cannot render the optional menu.
  }
}

function telegramRoleKeyboard(
  role: ConnectedTelegramRole,
  siteOrigin: string,
  miniAppEnabled: boolean,
): Array<Array<Record<string, unknown>>> {
  if (role === "teacher") {
    const buttons = [
      ["📚 Каталог і замовлення", "/teacher/telegram?tab=orders"],
      ["📅 Записатися / мої відвідування", "/teacher/telegram?tab=visits"],
      ["📖 Мої посібники", "/teacher/telegram?tab=loans"],
      ["🔔 Мої повідомлення", "/teacher/telegram?tab=notifications"],
    ] as const;
    return buttons.map(([text, miniPath]) => {
      const path = miniAppEnabled ? miniPath : miniPath.replace("/teacher/telegram", "/teacher");
      const url = new URL(path, siteOrigin).toString();
      return [{ text, ...(miniAppEnabled ? { web_app: { url } } : { url }) }];
    });
  }
  return [
    [{ text: "🆕 Замовлення вчителів", url: new URL("/librarian/visits#request-inbox-title", siteOrigin).toString() }],
    [{ text: "📅 Відвідування", url: new URL("/librarian/visits", siteOrigin).toString() }],
    [{ text: "👩‍🏫 Вчителі", url: new URL("/librarian/teachers", siteOrigin).toString() }],
    [{ text: "🏠 Кабінет бібліотекаря", url: new URL("/librarian", siteOrigin).toString() }],
  ];
}

async function bestEffortChatMenuButton(
  botToken: string,
  chatId: string,
  miniAppUrl: string | null,
  fetcher: TelegramFetcher,
): Promise<void> {
  const numericChatId = Number(chatId);
  if (!Number.isSafeInteger(numericChatId)) return;
  try {
    await telegramApiRequest(botToken, "setChatMenuButton", {
      chat_id: numericChatId,
      menu_button: miniAppUrl
        ? { type: "web_app", text: "Кабінет учителя", web_app: { url: miniAppUrl } }
        : { type: "commands" },
    }, fetcher);
  } catch {
    // Inline buttons remain available even when Telegram rejects a menu-button update.
  }
}

function telegramFailure(error: unknown): TelegramIntegrationError {
  if (error instanceof TelegramIntegrationError) return error;
  return new TelegramIntegrationError("telegram_delivery_failed", 503, "Telegram-повідомлення не надіслано.");
}

function connectionSuccessStatement(db: TelegramDatabase, userId: string, now: string): TelegramD1Statement {
  return db.prepare(`UPDATE telegram_connections
    SET last_success_at=?,last_failure_at=NULL,last_error_code=NULL,updated_at=?
    WHERE user_id=? AND status='active'`).bind(now, now, userId);
}

function connectionFailureStatement(
  db: TelegramDatabase,
  userId: string,
  error: TelegramIntegrationError,
  now: string,
): TelegramD1Statement {
  return db.prepare(`UPDATE telegram_connections
    SET status=CASE WHEN ?='telegram_blocked' THEN 'blocked' ELSE status END,
        disabled_at=CASE WHEN ?='telegram_blocked' THEN ? ELSE disabled_at END,
        last_failure_at=?,last_error_code=?,updated_at=?
    WHERE user_id=?`).bind(error.code, error.code, now, now, error.code, now, userId);
}

async function recordConnectionSuccess(db: TelegramDatabase, userId: string, now: string): Promise<void> {
  await db.batch([connectionSuccessStatement(db, userId, now)]);
}

async function recordConnectionFailure(
  db: TelegramDatabase,
  userId: string,
  error: TelegramIntegrationError,
  now: string,
): Promise<void> {
  await db.batch([connectionFailureStatement(db, userId, error, now)]);
}

function exponentialRetrySeconds(attempt: number): number {
  return Math.min(60 * 60, 5 * (2 ** Math.max(0, Math.min(10, attempt - 1))));
}

function boundedRetryAfter(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 1 && numeric <= 60 * 60 ? numeric : null;
}

function integerText(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^-?\d{1,20}$/u.test(value)) return value;
  return null;
}

function safePlainText(value: string, maximum: number): string {
  return [...value.normalize("NFKC")]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && code !== 127 || code === 9 || code === 10 || code === 13;
    })
    .join("").trim().slice(0, maximum);
}

function sanitizedError(value: string): string {
  return safePlainText(value.replace(/https:\/\/api\.telegram\.org\/bot[^\s/]+/giu, "Telegram API"), 240);
}

function escapeHtml(value: string): string {
  return safePlainText(value, 1200).replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function validIso(value: string): boolean {
  return /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

async function sha256Hex(value: string): Promise<string> {
  return [...await sha256Bytes(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
