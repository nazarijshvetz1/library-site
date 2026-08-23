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
const TELEGRAM_TEACHER_ACTIVATION_SECONDS = 30 * 60;
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
  connection_version: number;
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
      AND ((? IS NOT NULL AND id=?)
        OR (? IS NULL AND (auth_user_id=? OR lower(email)=lower(?))))
    ORDER BY id
    LIMIT 2
  `).bind(user.d1UserId ?? null, user.d1UserId ?? null, user.d1UserId ?? null, user.userId, user.email).all<{ id: string }>();
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
    WHERE u.id=? AND u.status='active'
      AND (u.role IN ('admin','librarian') OR EXISTS (
        SELECT 1 FROM teacher_profiles p WHERE p.teacher_user_id=u.id AND p.closed_at IS NULL
      ))
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
        AND (u.role IN ('admin','librarian') OR EXISTS (
          SELECT 1 FROM teacher_profiles p WHERE p.teacher_user_id=u.id AND p.closed_at IS NULL
        ))
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

export async function createTelegramTeacherActivationInvite(
  db: TelegramDatabase,
  actor: { id: string; email: string },
  teacherUserId: string,
  input: { requestId: string; expectedCredentialVersion: number },
  options: { now?: Date; randomBytes?: Uint8Array } = {},
): Promise<{ inviteId: string; teacher: { id: string; fullName: string }; linkUrl: string; expiresAt: string }> {
  const configuration = requireLinkingConfiguration();
  const nowDate = options.now ?? new Date();
  const now = nowDate.toISOString();
  const teacher = await db.prepare(`
    SELECT u.id,u.full_name,c.version,c.status,c.locked_until
    FROM users u
    JOIN teacher_profiles p ON p.teacher_user_id=u.id AND p.closed_at IS NULL
    JOIN visit_teacher_credentials c ON c.teacher_user_id=u.id
    WHERE u.id=? AND u.status='active' LIMIT 1
  `).bind(teacherUserId).first<{
    id: string; full_name: string; version: number; status: string; locked_until: string | null;
  }>();
  if (!teacher) {
    throw new TelegramIntegrationError(
      "teacher_credential_required",
      409,
      "Спочатку створіть учителю тимчасовий код доступу.",
      { permanent: true },
    );
  }
  if (teacher.status !== "active") {
    throw new TelegramIntegrationError("teacher_access_disabled", 409, "Доступ учителя вимкнено.", {
      permanent: true,
    });
  }
  if (teacher.locked_until && teacher.locked_until > now) {
    throw new TelegramIntegrationError("teacher_access_locked", 409, "Спочатку розблокуйте доступ учителя.", {
      permanent: true,
    });
  }
  if (Number(teacher.version) !== input.expectedCredentialVersion) {
    throw new TelegramIntegrationError(
      "credential_version_conflict",
      409,
      "Доступ учителя вже змінився. Оновіть список.",
      { permanent: true },
    );
  }
  const bytes = options.randomBytes ?? crypto.getRandomValues(new Uint8Array(32));
  if (bytes.byteLength < 32) {
    throw new TelegramIntegrationError("randomness_unavailable", 503, "Не вдалося створити безпечне запрошення.");
  }
  const inviteId = `TGA-${crypto.randomUUID()}`;
  const token = `ta_${base64Url(bytes)}`;
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(nowDate.getTime() + TELEGRAM_TEACHER_ACTIVATION_SECONDS * 1000).toISOString();
  try {
    await db.batch([
      db.prepare(`UPDATE telegram_teacher_activation_invites SET revoked_at=?,updated_at=?
        WHERE teacher_user_id=? AND kind='personal' AND consumed_at IS NULL
          AND revoked_at IS NULL`).bind(now, now, teacherUserId),
      db.prepare(`
        INSERT INTO telegram_teacher_activation_invites (
          id,kind,teacher_user_id,credential_version,token_hash,issued_by_user_id,request_id,
          bound_telegram_user_id,bound_chat_id,bound_username,bound_update_id,presented_at,
          expires_at,consumed_init_data_hash,consumed_at,revoked_at,created_at,updated_at
        )
        SELECT ?,'personal',u.id,c.version,?,?,?,NULL,NULL,NULL,NULL,NULL,?,NULL,NULL,NULL,?,?
        FROM users u
        JOIN teacher_profiles p ON p.teacher_user_id=u.id AND p.closed_at IS NULL
        JOIN visit_teacher_credentials c ON c.teacher_user_id=u.id
        WHERE u.id=? AND u.status='active' AND c.status='active' AND c.version=?
          AND (c.locked_until IS NULL OR c.locked_until<=?)
          AND EXISTS (SELECT 1 FROM users actor WHERE actor.id=? AND actor.status='active'
            AND actor.role IN ('admin','librarian'))
      `).bind(
        inviteId, tokenHash, actor.id, input.requestId, expiresAt, now, now,
        teacherUserId, input.expectedCredentialVersion, now, actor.id,
      ),
      db.prepare(`INSERT INTO audit_events (
        id,actor_user_id,actor_email,action,entity_type,entity_id,request_id,
        before_json,after_json,metadata_json,created_at
      ) VALUES (?,?,?,'telegram.teacher_activation_invite.create',
        'telegram_teacher_activation_invite',
        CASE WHEN EXISTS (SELECT 1 FROM telegram_teacher_activation_invites i
          WHERE i.id=? AND i.teacher_user_id=? AND i.request_id=?
            AND i.revoked_at IS NULL AND i.consumed_at IS NULL) THEN ? ELSE NULL END,
        ?,NULL,NULL,
        json_object('teacherUserId',?,'credentialVersion',?,'expiresAt',?),?)`)
        .bind(
          `AUD-${crypto.randomUUID()}`,
          actor.id,
          actor.email.toLowerCase(),
          inviteId,
          teacherUserId,
          input.requestId,
          inviteId,
          input.requestId,
          teacherUserId,
          input.expectedCredentialVersion,
          expiresAt,
          now,
        ),
    ]);
  } catch {
    throw new TelegramIntegrationError(
      "activation_invite_conflict",
      409,
      "Запрошення не створено: доступ учителя вже змінився. Оновіть список.",
      { permanent: true },
    );
  }
  const inserted = await db.prepare(`SELECT id FROM telegram_teacher_activation_invites
    WHERE id=? AND teacher_user_id=? AND token_hash=?
      AND consumed_at IS NULL AND revoked_at IS NULL LIMIT 1`)
    .bind(inviteId, teacherUserId, tokenHash).first<{ id: string }>();
  if (!inserted) {
    throw new TelegramIntegrationError(
      "activation_invite_conflict",
      409,
      "Запрошення не створено: доступ учителя вже змінився. Оновіть список.",
      { permanent: true },
    );
  }
  return {
    inviteId,
    teacher: { id: teacher.id, fullName: teacher.full_name },
    linkUrl: `https://t.me/${configuration.botUsername}?start=${token}`,
    expiresAt,
  };
}

export async function revokeTelegramTeacherActivationInvite(
  db: TelegramDatabase,
  actor: { id: string; email: string },
  teacherUserId: string,
  input: { requestId: string; inviteId: string },
): Promise<{ inviteId: string; revoked: true }> {
  const now = new Date().toISOString();
  const existing = await db.prepare(`SELECT id FROM telegram_teacher_activation_invites
    WHERE id=? AND teacher_user_id=? AND kind='personal' AND consumed_at IS NULL
      AND revoked_at IS NULL LIMIT 1`).bind(input.inviteId, teacherUserId).first<{ id: string }>();
  if (!existing) {
    throw new TelegramIntegrationError("activation_invite_not_found", 404, "Активне запрошення не знайдено.", {
      permanent: true,
    });
  }
  await db.batch([
    db.prepare(`UPDATE telegram_teacher_activation_invites SET revoked_at=?,updated_at=?
      WHERE id=? AND teacher_user_id=? AND consumed_at IS NULL AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM users actor WHERE actor.id=? AND actor.status='active'
          AND actor.role IN ('admin','librarian'))`)
      .bind(now, now, input.inviteId, teacherUserId, actor.id),
    db.prepare(`INSERT INTO audit_events (
      id,actor_user_id,actor_email,action,entity_type,entity_id,request_id,
      before_json,after_json,metadata_json,created_at
    ) SELECT ?,?,?,'telegram.teacher_activation_invite.revoke',
      'telegram_teacher_activation_invite',i.id,?,NULL,NULL,
      json_object('teacherUserId',i.teacher_user_id),?
      FROM telegram_teacher_activation_invites i
      WHERE i.id=? AND i.teacher_user_id=? AND i.revoked_at=?`)
      .bind(
        `AUD-${crypto.randomUUID()}`, actor.id, actor.email.toLowerCase(), input.requestId,
        now, input.inviteId, teacherUserId, now,
      ),
  ]);
  const revoked = await db.prepare(`SELECT id FROM telegram_teacher_activation_invites
    WHERE id=? AND teacher_user_id=? AND revoked_at=? LIMIT 1`)
    .bind(input.inviteId, teacherUserId, now).first<{ id: string }>();
  if (!revoked) {
    throw new TelegramIntegrationError("activation_invite_conflict", 409, "Запрошення вже змінилося.", {
      permanent: true,
    });
  }
  return { inviteId: input.inviteId, revoked: true };
}

export async function updateTelegramPreferences(
  db: TelegramDatabase,
  userId: string,
  input: { notifyOrders: boolean; notifyVisits: boolean; expectedVersion: number },
): Promise<TelegramConnectionStatus> {
  if (input.notifyOrders !== input.notifyVisits) {
    throw new TelegramIntegrationError(
      "validation_failed",
      400,
      "Кнопка керує всіма Telegram-сповіщеннями одночасно.",
      { permanent: true },
    );
  }
  const now = new Date().toISOString();
  const desired = input.notifyOrders ? 1 : 0;
  const results = await db.batch([
    db.prepare(`
      UPDATE telegram_connections
      SET notify_orders=?,notify_visits=?,version=version+1,updated_at=?
      WHERE user_id=? AND status='active' AND version=?
        AND EXISTS (SELECT 1 FROM users WHERE id=? AND status='active')
    `).bind(
      desired,
      desired,
      now,
      userId,
      input.expectedVersion,
      userId,
    ),
    db.prepare(`UPDATE telegram_delivery_outbox
      SET status='dead',lease_token=NULL,lease_expires_at=NULL,
        last_error_code='notifications_disabled',
        last_error_message='Одержувач вимкнув Telegram-сповіщення.',updated_at=?
      WHERE recipient_user_id=? AND status IN ('pending','processing','retry')
        AND category IN ('orders','visits','system') AND ?=0
        AND EXISTS (SELECT 1 FROM telegram_connections
          WHERE user_id=? AND status='active' AND version=?
            AND notify_orders=? AND notify_visits=?)`)
      .bind(
        now,
        userId,
        desired,
        userId,
        input.expectedVersion + 1,
        desired,
        desired,
      ),
  ]);
  const status = await readTelegramConnectionStatus(db, userId);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1
    || !status.connected || status.version !== input.expectedVersion + 1
    || status.notifyOrders !== input.notifyOrders || status.notifyVisits !== input.notifyVisits) {
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
    db.prepare(`UPDATE telegram_librarian_sessions SET revoked_at=?,last_seen_at=?
      WHERE user_id=? AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM telegram_connections
          WHERE user_id=? AND status='active' AND version=?)`)
      .bind(now, now, userId, userId, expectedVersion),
    db.prepare(`UPDATE visit_teacher_sessions SET revoked_at=?,last_seen_at=?
      WHERE teacher_user_id=? AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM telegram_connections
          WHERE user_id=? AND status='active' AND version=?)`)
      .bind(now, now, userId, userId, expectedVersion),
    db.prepare(`UPDATE telegram_teacher_activation_invites SET revoked_at=?,updated_at=?
      WHERE consumed_at IS NULL AND revoked_at IS NULL
        AND (teacher_user_id=? OR bound_telegram_user_id=(SELECT telegram_user_id
          FROM telegram_connections WHERE user_id=? AND status='active' AND version=? LIMIT 1))
        AND EXISTS (SELECT 1 FROM telegram_connections
          WHERE user_id=? AND status='active' AND version=?)`)
      .bind(now, now, userId, userId, expectedVersion, userId, expectedVersion),
    db.prepare(`UPDATE telegram_link_tokens SET revoked_at=?
      WHERE user_id=? AND consumed_at IS NULL AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM telegram_connections
          WHERE user_id=? AND status='active' AND version=?)`)
      .bind(now, userId, userId, expectedVersion),
    db.prepare(`UPDATE telegram_delivery_outbox
      SET status='dead',lease_token=NULL,lease_expires_at=NULL,
        last_error_code='telegram_disconnected',
        last_error_message='Telegram повністю від’єднано від профілю.',updated_at=?
      WHERE recipient_user_id=? AND status IN ('pending','processing','retry')
        AND EXISTS (SELECT 1 FROM telegram_connections
          WHERE user_id=? AND status='active' AND version=?)`)
      .bind(now, userId, userId, expectedVersion),
    db.prepare(`
      UPDATE telegram_connections
      SET status='disabled',disabled_at=?,version=version+1,updated_at=?
      WHERE user_id=? AND status='active' AND version=?
        AND EXISTS (SELECT 1 FROM users WHERE id=? AND status='active')
    `).bind(now, now, userId, expectedVersion, userId),
    db.prepare(`INSERT INTO audit_events (
      id,actor_user_id,actor_email,action,entity_type,entity_id,request_id,
      before_json,after_json,metadata_json,created_at
    ) VALUES (?,?,'telegram-user@local.invalid','telegram.connection.disconnect',
      'telegram_connection',CASE WHEN EXISTS (SELECT 1 FROM telegram_connections
        WHERE user_id=? AND status='disabled' AND version=?) THEN ? ELSE NULL END,
      NULL,NULL,NULL,json_object('previousVersion',?,'version',?),?)`)
      .bind(
        `AUD-${crypto.randomUUID()}`,
        userId,
        userId,
        expectedVersion + 1,
        userId,
        expectedVersion,
        expectedVersion + 1,
        now,
      ),
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
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  }, fetcher);
  const commands = [
    { command: "start", description: "Підключити бота або відкрити меню" },
    { command: "menu", description: "Показати меню бібліотеки" },
    { command: "notifications", description: "Керувати сповіщеннями" },
    { command: "stop", description: "Вимкнути Telegram-сповіщення" },
    { command: "disconnect", description: "Від’єднати Telegram від профілю" },
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
      AND (c.notify_orders=1 OR c.notify_visits=1)
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
      AND (c.notify_orders=1 OR c.notify_visits=1)
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
    JOIN teacher_profiles p ON p.teacher_user_id=u.id AND p.closed_at IS NULL
    JOIN telegram_connections c ON c.user_id=pn.teacher_user_id AND c.status='active'
    WHERE pn.id=?
      AND (c.notify_orders=1 OR c.notify_visits=1)
    ON CONFLICT(dedupe_key) DO NOTHING
  `).bind(category, path, createdAt, createdAt, createdAt, notificationId);
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
    SELECT o.id,o.recipient_user_id,c.chat_id,c.version AS connection_version,
      o.title,o.message,o.target_path,o.attempts,o.created_at
    FROM telegram_delivery_outbox o
    JOIN telegram_connections c ON c.user_id=o.recipient_user_id AND c.status='active'
    JOIN users u ON u.id=o.recipient_user_id AND u.status='active'
    WHERE o.status IN ('pending','retry') AND o.next_attempt_at<=?
      AND (c.notify_orders=1 OR c.notify_visits=1)
      AND ((o.target_path GLOB '/librarian*' AND u.role IN ('admin','librarian'))
        OR (o.target_path NOT GLOB '/librarian*' AND EXISTS (
          SELECT 1 FROM teacher_profiles p WHERE p.teacher_user_id=u.id AND p.closed_at IS NULL
        )))
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
          AND EXISTS (SELECT 1 FROM telegram_connections c
            WHERE c.user_id=telegram_delivery_outbox.recipient_user_id AND c.status='active'
              AND c.chat_id=? AND c.version=?
              AND (c.notify_orders=1 OR c.notify_visits=1))
      `).bind(leaseToken, leaseExpiresAt, now, row.id, now, row.chat_id, row.connection_version),
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
    if (update.callback) {
      await bestEffortAnswerCallback(
        configuration.botToken,
        update.callback.callbackId,
        "Стан уже оновлено.",
        fetcher,
      );
    }
    return { outcome: existing.outcome, duplicate: true };
  }
  if (update.callback) {
    return processTelegramNotificationCallback(
      db,
      configuration,
      update.updateId,
      payloadHash,
      update.callback,
      siteOrigin,
      fetcher,
    );
  }
  if (!update.message || update.message.chatType !== "private") {
    const inserted = await insertWebhookReceipt(db, update.updateId, payloadHash, "ignored_non_private");
    return { outcome: "ignored_non_private", duplicate: !inserted };
  }
  const privateMessage = update.message;
  const command = telegramCommand(privateMessage.text);
  if (siteOrigin && command.kind !== "other") {
    await bestEffortRefreshWebhookSubscriptions(configuration, siteOrigin, fetcher);
  }
  if (command.kind === "start") {
    if (command.token.startsWith("ta_")) {
      return processTeacherActivationInviteStart(
        db,
        configuration,
        { ...update, message: privateMessage },
        payloadHash,
        command.token,
        siteOrigin,
        fetcher,
      );
    }
    const tokenHash = await sha256Hex(command.token);
    const now = new Date().toISOString();
    const token = await db.prepare(`
      SELECT t.user_id,u.full_name,u.role,
        EXISTS (SELECT 1 FROM teacher_profiles p
          WHERE p.teacher_user_id=u.id AND p.closed_at IS NULL) AS teacher_capability
      FROM telegram_link_tokens t JOIN users u ON u.id=t.user_id
      WHERE t.token_hash=? AND t.consumed_at IS NULL AND t.revoked_at IS NULL
        AND t.expires_at>? AND u.status='active'
        AND (u.role IN ('admin','librarian') OR EXISTS (
          SELECT 1 FROM teacher_profiles p WHERE p.teacher_user_id=u.id AND p.closed_at IS NULL
        ))
      LIMIT 1
    `).bind(tokenHash, now).first<{
      user_id: string; full_name: string; role: "admin" | "librarian" | "teacher"; teacher_capability: number;
    }>();
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
            AND (u.role IN ('admin','librarian') OR EXISTS (
              SELECT 1 FROM teacher_profiles p WHERE p.teacher_user_id=u.id AND p.closed_at IS NULL
            ))
        ),?,?,?,'active',1,1,1,?,NULL,NULL,NULL,NULL,?,?)
        ON CONFLICT(user_id) DO UPDATE SET
          telegram_user_id=excluded.telegram_user_id,chat_id=excluded.chat_id,username=excluded.username,
          status='active',notify_orders=1,notify_visits=1,disabled_at=NULL,
          linked_at=excluded.linked_at,last_error_code=NULL,
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
      Boolean(token.teacher_capability),
      token.full_name,
      true,
      siteOrigin,
      true,
      fetcher,
    );
    return { outcome: "linked", duplicate: false };
  }
  if (command.kind === "stop") {
    const now = new Date().toISOString();
    const toggled = await setTelegramNotificationsFromWebhook(
      db,
      update.updateId,
      payloadHash,
      update.message.chatId,
      update.message.telegramUserId,
      false,
      now,
    );
    const inserted = toggled.inserted;
    if (inserted) {
      await bestEffortBotReply(
        configuration.botToken,
        update.message.chatId,
        toggled.profile
          ? "🔕 Сповіщення вимкнено. Бот і кабінет залишаються підключеними. Увімкнути сповіщення можна кнопкою в меню."
          : "Telegram не прив’язаний до профілю. Натисніть Start, щоб увійти або активувати кабінет.",
        fetcher,
      );
      if (toggled.profile) {
        await bestEffortConnectedMenu(
          configuration.botToken,
          update.message.chatId,
          toggled.profile.role,
          Boolean(toggled.profile.teacher_capability),
          toggled.profile.full_name,
          false,
          siteOrigin,
          false,
          fetcher,
        );
      }
    }
    return { outcome: "notifications_disabled", duplicate: !inserted };
  }
  if (command.kind === "disconnect") {
    const profile = await connectedTelegramProfile(
      db,
      update.message.chatId,
      update.message.telegramUserId,
    );
    const inserted = await insertWebhookReceipt(db, update.updateId, payloadHash, "disconnect_help");
    if (inserted) {
      await bestEffortDisconnectHelp(
        configuration.botToken,
        update.message.chatId,
        profile,
        siteOrigin,
        fetcher,
      );
    }
    return { outcome: "disconnect_help", duplicate: !inserted };
  }
  if (command.kind === "menu") {
    let profile = await connectedTelegramProfile(
      db,
      update.message.chatId,
      update.message.telegramUserId,
    );
    if (!profile && command.resumeConnection) {
      const resumed = await resumeRecoverableTelegramConnection(
        db,
        update.updateId,
        payloadHash,
        update.message.chatId,
        update.message.telegramUserId,
      );
      if (resumed) {
        profile = resumed.profile;
        if (resumed.inserted && profile) {
          await bestEffortConnectedMenu(
            configuration.botToken,
            update.message.chatId,
            profile.role,
            Boolean(profile.teacher_capability),
            profile.full_name,
            notificationsMasterEnabled(profile),
            siteOrigin,
            false,
            fetcher,
          );
        } else if (resumed.inserted) {
          await bestEffortBotReply(
            configuration.botToken,
            update.message.chatId,
            "Підключення знайдено, але профіль зараз недоступний. Зверніться до бібліотекаря.",
            fetcher,
          );
        }
        return { outcome: "menu", duplicate: !resumed.inserted };
      }
    }
    if (profile) {
      const inserted = await insertWebhookReceipt(db, update.updateId, payloadHash, "menu");
      if (inserted) {
        await bestEffortConnectedMenu(
          configuration.botToken,
          update.message.chatId,
          profile.role,
          Boolean(profile.teacher_capability),
          profile.full_name,
          notificationsMasterEnabled(profile),
          siteOrigin,
          false,
          fetcher,
        );
      }
      return { outcome: "menu", duplicate: !inserted };
    }
    const grant = await createGenericTeacherActivationGrant(
      db,
      update.updateId,
      payloadHash,
      update.message,
    );
    if (grant.inserted) {
      await bestEffortTeacherOnboardingMenu(
        configuration.botToken,
        update.message.chatId,
        siteOrigin,
        grant.invitedTeacherName,
        grant.invitedRequiresNewPin,
        fetcher,
      );
    }
    return { outcome: grant.outcome, duplicate: !grant.inserted };
  }
  const inserted = await insertWebhookReceipt(db, update.updateId, payloadHash, "ignored_command");
  if (inserted) await bestEffortBotReply(configuration.botToken, update.message.chatId,
    "Керуйте Telegram-сповіщеннями у своєму кабінеті на сайті «Єдина бібліотека».", fetcher);
  return { outcome: "ignored_command", duplicate: !inserted };
}

async function processTeacherActivationInviteStart(
  db: TelegramDatabase,
  configuration: TelegramConfiguration & { botToken: string; botUsername: string; webhookSecret: string },
  update: {
    updateId: string;
    message: { chatId: string; telegramUserId: string; username: string | null; chatType: string; text: string };
  },
  payloadHash: string,
  rawToken: string,
  siteOrigin: string | undefined,
  fetcher: TelegramFetcher,
): Promise<{ outcome: string; duplicate: boolean }> {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const tokenHash = await sha256Hex(rawToken);
  const invite = await db.prepare(`
    SELECT i.id,i.teacher_user_id,u.full_name,i.credential_version,c.must_change_pin,
           i.bound_telegram_user_id,i.bound_chat_id
    FROM telegram_teacher_activation_invites i
    JOIN users u ON u.id=i.teacher_user_id AND u.status='active'
    JOIN teacher_profiles p ON p.teacher_user_id=u.id AND p.closed_at IS NULL
    JOIN visit_teacher_credentials c ON c.teacher_user_id=u.id
    WHERE i.kind='personal' AND i.token_hash=? AND i.consumed_at IS NULL
      AND i.revoked_at IS NULL AND i.expires_at>? AND c.status='active'
      AND c.version=i.credential_version
      AND (i.bound_telegram_user_id IS NULL OR i.bound_telegram_user_id=?)
    LIMIT 1
  `).bind(tokenHash, now, update.message.telegramUserId).first<{
    id: string; teacher_user_id: string; full_name: string; credential_version: number;
    must_change_pin: number;
    bound_telegram_user_id: string | null; bound_chat_id: string | null;
  }>();
  if (!invite) {
    const inserted = await insertWebhookReceipt(db, update.updateId, payloadHash, "activation_invite_invalid");
    if (inserted) {
      await bestEffortBotReply(
        configuration.botToken,
        update.message.chatId,
        "Персональне запрошення недійсне, прострочене або вже використане. Попросіть бібліотекаря створити нове.",
        fetcher,
      );
    }
    return { outcome: "activation_invite_invalid", duplicate: !inserted };
  }
  const conflict = await db.prepare(`
    SELECT user_id FROM telegram_connections
    WHERE status='active' AND (
      ((chat_id=? OR telegram_user_id=?) AND user_id!=?)
      OR (user_id=? AND (chat_id!=? OR telegram_user_id!=?))
    ) LIMIT 1
  `).bind(
    update.message.chatId,
    update.message.telegramUserId,
    invite.teacher_user_id,
    invite.teacher_user_id,
    update.message.chatId,
    update.message.telegramUserId,
  ).first<{ user_id: string }>();
  if (conflict) {
    const inserted = await insertWebhookReceipt(db, update.updateId, payloadHash, "activation_invite_conflict");
    if (inserted) {
      await bestEffortBotReply(
        configuration.botToken,
        update.message.chatId,
        "Цей Telegram або картка вчителя вже мають інше активне підключення. Бібліотекар має спочатку захистити доступ зі старого телефона.",
        fetcher,
      );
    }
    return { outcome: "activation_invite_conflict", duplicate: !inserted };
  }
  let results;
  try {
    results = await db.batch([
    db.prepare(`INSERT INTO telegram_webhook_updates(update_id,payload_hash,outcome,processed_at)
      VALUES (?,?,'activation_invite_claimed',?) ON CONFLICT(update_id) DO NOTHING`)
      .bind(update.updateId, payloadHash, now),
    db.prepare(`UPDATE telegram_teacher_activation_invites SET revoked_at=?,updated_at=?
      WHERE id!=? AND consumed_at IS NULL AND revoked_at IS NULL
        AND bound_telegram_user_id=?
        AND EXISTS (SELECT 1 FROM telegram_webhook_updates
          WHERE update_id=? AND payload_hash=? AND outcome='activation_invite_claimed')`)
      .bind(now, now, invite.id, update.message.telegramUserId, update.updateId, payloadHash),
    db.prepare(`UPDATE telegram_teacher_activation_invites SET
        bound_telegram_user_id=?,bound_chat_id=?,bound_username=?,bound_update_id=?,
        presented_at=COALESCE(presented_at,?),updated_at=?
      WHERE id=? AND token_hash=? AND consumed_at IS NULL AND revoked_at IS NULL
        AND expires_at>? AND (bound_telegram_user_id IS NULL OR bound_telegram_user_id=?)
        AND (bound_chat_id IS NULL OR bound_chat_id=?)
        AND EXISTS (SELECT 1 FROM telegram_webhook_updates
          WHERE update_id=? AND payload_hash=? AND outcome='activation_invite_claimed')`)
      .bind(
        update.message.telegramUserId,
        update.message.chatId,
        update.message.username,
        update.updateId,
        now,
        now,
        invite.id,
        tokenHash,
        now,
        update.message.telegramUserId,
        update.message.chatId,
        update.updateId,
        payloadHash,
      ),
      db.prepare(`INSERT INTO audit_events (
        id,actor_user_id,actor_email,action,entity_type,entity_id,request_id,
        before_json,after_json,metadata_json,created_at
      ) VALUES (?,NULL,'telegram-bot@local.invalid','telegram.teacher_activation_invite.claim',
        'telegram_teacher_activation_invite',
        CASE WHEN EXISTS (SELECT 1 FROM telegram_teacher_activation_invites
          WHERE id=? AND bound_telegram_user_id=? AND bound_chat_id=?
            AND bound_update_id=? AND consumed_at IS NULL AND revoked_at IS NULL
            AND expires_at>?) THEN ? ELSE NULL END,
        ?,NULL,NULL,json_object('telegramUserId',?),?)`)
        .bind(
          `AUD-${crypto.randomUUID()}`,
          invite.id,
          update.message.telegramUserId,
          update.message.chatId,
          update.updateId,
          now,
          invite.id,
          update.updateId,
          update.message.telegramUserId,
          now,
        ),
    ]);
  } catch {
    await bestEffortBotReply(
      configuration.botToken,
      update.message.chatId,
      "Запрошення вже змінилося. Попросіть бібліотекаря створити нове.",
      fetcher,
    );
    return { outcome: "activation_invite_conflict", duplicate: false };
  }
  const inserted = Number(results[0]?.meta?.changes ?? 0) === 1;
  if (!inserted) return { outcome: "activation_invite_claimed", duplicate: true };
  const claimed = await db.prepare(`SELECT id FROM telegram_teacher_activation_invites
    WHERE id=? AND bound_telegram_user_id=? AND bound_chat_id=? AND consumed_at IS NULL
      AND revoked_at IS NULL AND expires_at>? LIMIT 1`)
    .bind(invite.id, update.message.telegramUserId, update.message.chatId, now)
    .first<{ id: string }>();
  if (!claimed) {
    await bestEffortBotReply(
      configuration.botToken,
      update.message.chatId,
      "Запрошення вже змінилося. Попросіть бібліотекаря створити нове.",
      fetcher,
    );
    return { outcome: "activation_invite_conflict", duplicate: false };
  }
  await bestEffortTeacherOnboardingMenu(
    configuration.botToken,
    update.message.chatId,
    siteOrigin,
    invite.full_name,
    Boolean(invite.must_change_pin),
    fetcher,
  );
  return { outcome: "activation_invite_claimed", duplicate: false };
}

async function createGenericTeacherActivationGrant(
  db: TelegramDatabase,
  updateId: string,
  payloadHash: string,
  message: { chatId: string; telegramUserId: string; username: string | null },
): Promise<{
  inserted: boolean;
  outcome: string;
  invitedTeacherName: string | null;
  invitedRequiresNewPin: boolean | null;
}> {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const existingPersonal = await db.prepare(`
    SELECT u.full_name,c.must_change_pin
    FROM telegram_teacher_activation_invites i
    JOIN users u ON u.id=i.teacher_user_id AND u.status='active'
    JOIN teacher_profiles p ON p.teacher_user_id=u.id AND p.closed_at IS NULL
    JOIN visit_teacher_credentials c ON c.teacher_user_id=u.id
    WHERE i.kind='personal' AND i.bound_telegram_user_id=? AND i.bound_chat_id=?
      AND i.consumed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>?
      AND c.status='active' AND c.version=i.credential_version
    ORDER BY i.presented_at DESC,i.created_at DESC LIMIT 1
  `).bind(message.telegramUserId, message.chatId, now).first<{ full_name: string; must_change_pin: number }>();
  if (existingPersonal) {
    const inserted = await insertWebhookReceipt(db, updateId, payloadHash, "activation_invite_resume");
    return {
      inserted,
      outcome: "activation_invite_resume",
      invitedTeacherName: existingPersonal.full_name,
      invitedRequiresNewPin: Boolean(existingPersonal.must_change_pin),
    };
  }
  const grantId = `TGA-${crypto.randomUUID()}`;
  const expiresAt = new Date(nowDate.getTime() + TELEGRAM_TEACHER_ACTIVATION_SECONDS * 1000).toISOString();
  const results = await db.batch([
    db.prepare(`INSERT INTO telegram_webhook_updates(update_id,payload_hash,outcome,processed_at)
      VALUES (?,?,'activation_started',?) ON CONFLICT(update_id) DO NOTHING`)
      .bind(updateId, payloadHash, now),
    db.prepare(`UPDATE telegram_teacher_activation_invites SET revoked_at=?,updated_at=?
      WHERE kind='generic' AND bound_telegram_user_id=? AND consumed_at IS NULL
        AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM telegram_webhook_updates
          WHERE update_id=? AND payload_hash=? AND outcome='activation_started')
        AND NOT EXISTS (SELECT 1 FROM telegram_teacher_activation_invites claimed
          WHERE claimed.bound_update_id=?)`)
      .bind(now, now, message.telegramUserId, updateId, payloadHash, updateId),
    db.prepare(`INSERT INTO telegram_teacher_activation_invites (
      id,kind,teacher_user_id,credential_version,token_hash,issued_by_user_id,request_id,
      bound_telegram_user_id,bound_chat_id,bound_username,bound_update_id,presented_at,
      expires_at,consumed_init_data_hash,consumed_at,revoked_at,created_at,updated_at
    ) SELECT ?,'generic',NULL,NULL,NULL,NULL,NULL,?,?,?,?,?,?,NULL,NULL,NULL,?,?
      WHERE EXISTS (SELECT 1 FROM telegram_webhook_updates
        WHERE update_id=? AND payload_hash=? AND outcome='activation_started')
        AND NOT EXISTS (SELECT 1 FROM telegram_teacher_activation_invites claimed
          WHERE claimed.bound_update_id=?)`)
      .bind(
        grantId,
        message.telegramUserId,
        message.chatId,
        message.username,
        updateId,
        now,
        expiresAt,
        now,
        now,
        updateId,
        payloadHash,
        updateId,
      ),
  ]);
  return {
    inserted: Number(results[0]?.meta?.changes ?? 0) === 1,
    outcome: "activation_started",
    invitedTeacherName: null,
    invitedRequiresNewPin: null,
  };
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

type TelegramWebhookMessage = {
  chatId: string;
  telegramUserId: string;
  username: string | null;
  chatType: string;
  text: string;
};

type TelegramWebhookCallback = {
  callbackId: string;
  chatId: string;
  messageId: string;
  telegramUserId: string;
  chatType: string;
  data: string;
};

function telegramUpdate(value: unknown): {
  updateId: string;
  message: TelegramWebhookMessage | null;
  callback: TelegramWebhookCallback | null;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TelegramIntegrationError("webhook_payload_invalid", 400, "Некоректний Telegram update.", {
      permanent: true,
    });
  }
  const record = value as Record<string, unknown>;
  const updateId = integerText(record.update_id);
  if (!updateId) {
    throw new TelegramIntegrationError("webhook_payload_invalid", 400, "Некоректний номер Telegram update.", {
      permanent: true,
    });
  }
  const callbackQuery = record.callback_query;
  if (callbackQuery && typeof callbackQuery === "object" && !Array.isArray(callbackQuery)) {
    const callbackRecord = callbackQuery as Record<string, unknown>;
    const callbackId = typeof callbackRecord.id === "string" && callbackRecord.id.length <= 128
      ? callbackRecord.id
      : "";
    const from = callbackRecord.from;
    const callbackMessage = callbackRecord.message;
    const data = typeof callbackRecord.data === "string" && callbackRecord.data.length <= 64
      ? callbackRecord.data
      : "";
    if (callbackId && data && from && typeof from === "object" && !Array.isArray(from)
      && callbackMessage && typeof callbackMessage === "object" && !Array.isArray(callbackMessage)) {
      const fromRecord = from as Record<string, unknown>;
      const callbackMessageRecord = callbackMessage as Record<string, unknown>;
      const chat = callbackMessageRecord.chat;
      if (chat && typeof chat === "object" && !Array.isArray(chat)) {
        const chatRecord = chat as Record<string, unknown>;
        const chatId = integerText(chatRecord.id);
        const telegramUserId = integerText(fromRecord.id);
        const messageId = integerText(callbackMessageRecord.message_id);
        const chatType = typeof chatRecord.type === "string" ? chatRecord.type : "";
        if (chatId && telegramUserId && messageId) {
          return {
            updateId,
            message: null,
            callback: { callbackId, chatId, messageId, telegramUserId, chatType, data },
          };
        }
      }
    }
  }
  const message = record.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { updateId, message: null, callback: null };
  }
  const messageRecord = message as Record<string, unknown>;
  const chat = messageRecord.chat;
  const from = messageRecord.from;
  if (!chat || typeof chat !== "object" || Array.isArray(chat)
    || !from || typeof from !== "object" || Array.isArray(from)) {
    return { updateId, message: null, callback: null };
  }
  const chatRecord = chat as Record<string, unknown>;
  const fromRecord = from as Record<string, unknown>;
  const chatId = integerText(chatRecord.id);
  const telegramUserId = integerText(fromRecord.id);
  const chatType = typeof chatRecord.type === "string" ? chatRecord.type : "";
  const text = typeof messageRecord.text === "string" ? messageRecord.text.normalize("NFKC").slice(0, 512) : "";
  const username = typeof fromRecord.username === "string" && /^[A-Za-z0-9_]{1,32}$/u.test(fromRecord.username)
    ? fromRecord.username
    : null;
  if (!chatId || !telegramUserId) return { updateId, message: null, callback: null };
  return { updateId, message: { chatId, telegramUserId, username, chatType, text }, callback: null };
}

function telegramCommand(text: string):
  | { kind: "start"; token: string }
  | { kind: "menu"; resumeConnection: boolean }
  | { kind: "stop" }
  | { kind: "disconnect" }
  | { kind: "other" } {
  const trimmed = text.trim();
  const start = trimmed.match(/^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{40,64})$/u);
  if (start) return { kind: "start", token: start[1] };
  if (/^\/start(?:@[A-Za-z0-9_]+)?$/u.test(trimmed)) return { kind: "menu", resumeConnection: true };
  if (/^\/(?:menu|cabinet|help|notifications)(?:@[A-Za-z0-9_]+)?$/u.test(trimmed)) return { kind: "menu", resumeConnection: false };
  if (/^\/stop(?:@[A-Za-z0-9_]+)?$/u.test(trimmed)) return { kind: "stop" };
  if (/^\/disconnect(?:@[A-Za-z0-9_]+)?$/u.test(trimmed)) return { kind: "disconnect" };
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

async function setTelegramNotificationsFromWebhook(
  db: TelegramDatabase,
  updateId: string,
  payloadHash: string,
  chatId: string,
  telegramUserId: string,
  enabled: boolean,
  now: string,
): Promise<{ inserted: boolean; profile: ConnectedTelegramProfile | null }> {
  const outcome = enabled ? "notifications_enabled" : "notifications_disabled";
  const desired = enabled ? 1 : 0;
  const results = await db.batch([
    db.prepare(`INSERT INTO telegram_webhook_updates(update_id,payload_hash,outcome,processed_at)
      VALUES (?,?,?,?) ON CONFLICT(update_id) DO NOTHING`)
      .bind(updateId, payloadHash, outcome, now),
    db.prepare(`UPDATE telegram_connections
      SET notify_orders=?,notify_visits=?,version=version+1,updated_at=?
      WHERE chat_id=? AND telegram_user_id=? AND status='active'
        AND EXISTS (SELECT 1 FROM telegram_webhook_updates
          WHERE update_id=? AND payload_hash=? AND outcome=? AND processed_at=?)
        AND (notify_orders!=? OR notify_visits!=?)`)
      .bind(
        desired,
        desired,
        now,
        chatId,
        telegramUserId,
        updateId,
        payloadHash,
        outcome,
        now,
        desired,
        desired,
      ),
    db.prepare(`UPDATE telegram_delivery_outbox
      SET status='dead',lease_token=NULL,lease_expires_at=NULL,
        last_error_code='notifications_disabled',
        last_error_message='Одержувач вимкнув Telegram-сповіщення.',updated_at=?
      WHERE recipient_user_id=(SELECT user_id FROM telegram_connections
          WHERE chat_id=? AND telegram_user_id=? AND status='active' LIMIT 1)
        AND status IN ('pending','processing','retry') AND category IN ('orders','visits','system')
        AND ?=0 AND EXISTS (SELECT 1 FROM telegram_webhook_updates
          WHERE update_id=? AND payload_hash=? AND outcome=? AND processed_at=?)`)
      .bind(now, chatId, telegramUserId, desired, updateId, payloadHash, outcome, now),
  ]);
  return {
    inserted: Number(results[0]?.meta?.changes ?? 0) === 1,
    profile: await connectedTelegramProfile(db, chatId, telegramUserId),
  };
}

async function processTelegramNotificationCallback(
  db: TelegramDatabase,
  configuration: TelegramConfiguration & { botToken: string },
  updateId: string,
  payloadHash: string,
  callback: TelegramWebhookCallback,
  siteOrigin: string | undefined,
  fetcher: TelegramFetcher,
): Promise<{ outcome: string; duplicate: boolean }> {
  if (callback.chatType !== "private") {
    const inserted = await insertWebhookReceipt(db, updateId, payloadHash, "ignored_non_private");
    return { outcome: "ignored_non_private", duplicate: !inserted };
  }
  const enabled = callback.data === "telegram-notifications:on"
    ? true
    : callback.data === "telegram-notifications:off"
      ? false
      : null;
  if (enabled === null) {
    const inserted = await insertWebhookReceipt(db, updateId, payloadHash, "ignored_callback");
    if (inserted) {
      await bestEffortAnswerCallback(configuration.botToken, callback.callbackId, "Кнопка вже неактуальна.", fetcher);
    }
    return { outcome: "ignored_callback", duplicate: !inserted };
  }
  const now = new Date().toISOString();
  const toggled = await setTelegramNotificationsFromWebhook(
    db,
    updateId,
    payloadHash,
    callback.chatId,
    callback.telegramUserId,
    enabled,
    now,
  );
  if (toggled.inserted) {
    await bestEffortAnswerCallback(
      configuration.botToken,
      callback.callbackId,
      toggled.profile
        ? enabled ? "Сповіщення увімкнено 🔔" : "Сповіщення вимкнено 🔕"
        : "Профіль не підключено.",
      fetcher,
    );
    if (toggled.profile && siteOrigin) {
      const origin = trustedSiteOrigin(siteOrigin);
      await bestEffortEditMenuKeyboard(
        configuration.botToken,
        callback.chatId,
        callback.messageId,
        toggled.profile.full_name,
        notificationsMasterEnabled(toggled.profile),
        telegramRoleKeyboard(
          toggled.profile.role,
          Boolean(toggled.profile.teacher_capability),
          origin,
          configuration.miniAppEnabled,
          notificationsMasterEnabled(toggled.profile),
        ),
        fetcher,
      );
    }
  }
  return { outcome: enabled ? "notifications_enabled" : "notifications_disabled", duplicate: !toggled.inserted };
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

async function bestEffortAnswerCallback(
  botToken: string,
  callbackId: string,
  message: string,
  fetcher: TelegramFetcher,
): Promise<void> {
  try {
    await telegramApiRequest(botToken, "answerCallbackQuery", {
      callback_query_id: callbackId,
      text: safePlainText(message, 180),
      show_alert: false,
      cache_time: 0,
    }, fetcher);
  } catch {
    // Preference state in D1 remains authoritative if Telegram cannot close the button spinner.
  }
}

async function bestEffortRefreshWebhookSubscriptions(
  configuration: TelegramConfiguration & { botToken: string; webhookSecret: string },
  siteOrigin: string,
  fetcher: TelegramFetcher,
): Promise<void> {
  try {
    const webhookUrl = new URL("/api/telegram/webhook", trustedSiteOrigin(siteOrigin)).toString();
    await telegramApiRequest(configuration.botToken, "setWebhook", {
      url: webhookUrl,
      secret_token: configuration.webhookSecret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    }, fetcher);
  } catch {
    // The current update remains usable; another command or link request retries the subscription refresh.
  }
}

async function bestEffortEditMenuKeyboard(
  botToken: string,
  chatId: string,
  messageId: string,
  fullName: string,
  notificationsOn: boolean,
  keyboard: Array<Array<Record<string, unknown>>>,
  fetcher: TelegramFetcher,
): Promise<void> {
  try {
    const greeting = `Профіль: «${safePlainText(fullName, 120)}».`;
    await telegramApiRequest(botToken, "editMessageText", {
      chat_id: chatId,
      message_id: Number(messageId),
      text: `<b>${escapeHtml(greeting)}</b>\nСповіщення: ${notificationsOn ? "увімкнено 🔔" : "вимкнено 🔕"}.\nОберіть потрібний розділ:`,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: keyboard },
    }, fetcher);
  } catch {
    // A fresh /menu always renders the authoritative state when an old message cannot be edited.
  }
}

async function bestEffortDisconnectHelp(
  botToken: string,
  chatId: string,
  profile: ConnectedTelegramProfile | null,
  siteOrigin: string | undefined,
  fetcher: TelegramFetcher,
): Promise<void> {
  if (!profile) {
    await bestEffortBotReply(
      botToken,
      chatId,
      "Telegram уже не прив’язаний до профілю. Для нового підключення натисніть Start.",
      fetcher,
    );
    return;
  }
  try {
    const origin = siteOrigin ? trustedSiteOrigin(siteOrigin) : null;
    const configuration = telegramConfiguration();
    const teacherPath = configuration.miniAppEnabled
      ? "/teacher/telegram?tab=notifications"
      : "/teacher?tab=notifications";
    const librarianPath = configuration.miniAppEnabled
      ? "/librarian/telegram?target=teachers"
      : "/librarian/teachers#telegram-settings";
    const targetPath = profile.role === "teacher" ? teacherPath : librarianPath;
    const url = origin ? new URL(targetPath, origin).toString() : null;
    await telegramApiRequest(botToken, "sendMessage", {
      chat_id: chatId,
      text: "Повне від’єднання вимикає автовхід і потребує підтвердження в налаштуваннях кабінету. Якщо потрібно лише припинити повідомлення, скористайтеся кнопкою «Вимкнути сповіщення».",
      link_preview_options: { is_disabled: true },
      ...(url ? {
        reply_markup: {
          inline_keyboard: [[{
            text: "⚙️ Відкрити налаштування",
            ...(configuration.miniAppEnabled ? { web_app: { url } } : { url }),
          }]],
        },
      } : {}),
    }, fetcher);
  } catch {
    // Full disconnect remains available from the cabinet even when Telegram cannot render guidance.
  }
}

async function bestEffortTeacherOnboardingMenu(
  botToken: string,
  chatId: string,
  siteOrigin: string | undefined,
  invitedTeacherName: string | null,
  invitedRequiresNewPin: boolean | null,
  fetcher: TelegramFetcher,
): Promise<void> {
  try {
    const origin = siteOrigin ? trustedSiteOrigin(siteOrigin) : null;
    const heading = invitedTeacherName
      ? `Персональне запрошення для «${safePlainText(invitedTeacherName, 120)}» підтверджено.`
      : "Вітаємо в «Єдиній бібліотеці»!";
    const instructions = invitedTeacherName
      ? invitedRequiresNewPin
        ? "Відкрийте захищене вікно нижче, введіть тимчасовий код бібліотекаря та створіть PIN."
        : "Відкрийте захищене вікно нижче та увійдіть зі своїм чинним PIN."
      : "Якщо кабінет уже активовано — увійдіть зі своїм PIN. Для першого входу виберіть активацію та введіть тимчасовий код бібліотекаря.";
    const warning = "Код і PIN вводьте лише в захищеному вікні — не надсилайте їх у чат.";
    const keyboard = origin ? {
      inline_keyboard: [
        ...(invitedTeacherName
          ? [[invitedRequiresNewPin
              ? { text: "✨ Активувати вперше", web_app: { url: new URL("/teacher/telegram?mode=activate", origin).toString() } }
              : { text: "🔑 Увійти", web_app: { url: new URL("/teacher/telegram?mode=login", origin).toString() } }]]
          : [
              [{ text: "🔑 Увійти", web_app: { url: new URL("/teacher/telegram?mode=login", origin).toString() } }],
              [{ text: "✨ Активувати вперше", web_app: { url: new URL("/teacher/telegram?mode=activate", origin).toString() } }],
            ]),
        [{ text: "📚 Переглянути каталог", url: "https://nazarijshvetz1.github.io/library-site/" }],
        [{ text: "📅 Переглянути графік", url: new URL("/visits", origin).toString() }],
      ],
    } : undefined;
    await telegramApiRequest(botToken, "sendMessage", {
      chat_id: chatId,
      text: `<b>${escapeHtml(heading)}</b>\n${escapeHtml(instructions)}\n\n${escapeHtml(warning)}`,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: keyboard } : {}),
    }, fetcher);
    if (origin) {
      await bestEffortChatMenuButton(
        botToken,
        chatId,
        { text: "Кабінет учителя", url: new URL("/teacher/telegram?tab=overview", origin).toString() },
        fetcher,
      );
    }
  } catch {
    // The short-lived D1 activation grant remains authoritative if Telegram cannot render the menu.
  }
}

type ConnectedTelegramRole = "admin" | "librarian" | "teacher";
type ConnectedTelegramProfile = {
  user_id: string;
  full_name: string;
  role: ConnectedTelegramRole;
  teacher_capability: number;
  notify_orders: number;
  notify_visits: number;
};

async function resumeRecoverableTelegramConnection(
  db: TelegramDatabase,
  updateId: string,
  payloadHash: string,
  chatId: string,
  telegramUserId: string,
): Promise<{ inserted: boolean; profile: ConnectedTelegramProfile | null } | null> {
  const candidate = await db.prepare(`
    SELECT c.user_id,c.status
    FROM telegram_connections c JOIN users u ON u.id=c.user_id
    WHERE c.chat_id=? AND c.telegram_user_id=?
      AND u.status='active'
      AND (
        c.status='blocked'
        OR (c.status='disabled' AND NOT EXISTS (
          SELECT 1 FROM audit_events a
          WHERE a.entity_type='telegram_connection' AND a.entity_id=c.user_id
            AND a.action IN ('telegram.connection.disconnect','telegram.connection.lost_phone_protect')
            AND a.created_at>=c.linked_at
        ))
      )
      AND (u.role IN ('admin','librarian') OR EXISTS (
        SELECT 1 FROM teacher_profiles p
        JOIN visit_teacher_credentials v ON v.teacher_user_id=p.teacher_user_id AND v.status='active'
        WHERE p.teacher_user_id=u.id AND p.closed_at IS NULL
      ))
    LIMIT 1
  `).bind(chatId, telegramUserId).first<{ user_id: string; status: "blocked" | "disabled" }>();
  if (!candidate) return null;

  const now = new Date().toISOString();
  const auditId = `AUD-${crypto.randomUUID()}`;
  const results = await db.batch([
    db.prepare(`INSERT INTO telegram_webhook_updates(update_id,payload_hash,outcome,processed_at)
      VALUES (?,?, 'menu',?) ON CONFLICT(update_id) DO NOTHING`)
      .bind(updateId, payloadHash, now),
    db.prepare(`UPDATE telegram_connections
      SET status='active',disabled_at=NULL,last_failure_at=NULL,last_error_code=NULL,
          version=version+1,updated_at=?
      WHERE user_id=? AND chat_id=? AND telegram_user_id=? AND status=?
        AND EXISTS (
          SELECT 1 FROM users u WHERE u.id=telegram_connections.user_id AND u.status='active'
            AND (u.role IN ('admin','librarian') OR EXISTS (
              SELECT 1 FROM teacher_profiles p
              JOIN visit_teacher_credentials v ON v.teacher_user_id=p.teacher_user_id AND v.status='active'
              WHERE p.teacher_user_id=u.id AND p.closed_at IS NULL
            ))
        )
        AND (
          status='blocked'
          OR (status='disabled' AND NOT EXISTS (
            SELECT 1 FROM audit_events a
            WHERE a.entity_type='telegram_connection' AND a.entity_id=telegram_connections.user_id
              AND a.action IN ('telegram.connection.disconnect','telegram.connection.lost_phone_protect')
              AND a.created_at>=telegram_connections.linked_at
          ))
        )
        AND EXISTS (SELECT 1 FROM telegram_webhook_updates
          WHERE update_id=? AND payload_hash=? AND outcome='menu' AND processed_at=?)`)
      .bind(now, candidate.user_id, chatId, telegramUserId, candidate.status, updateId, payloadHash, now),
    db.prepare(`INSERT INTO audit_events (
        id,actor_user_id,actor_email,action,entity_type,entity_id,request_id,
        before_json,after_json,metadata_json,created_at
      ) SELECT ?,c.user_id,'telegram-bot@local.invalid','telegram.connection.resume',
        'telegram_connection',c.user_id,NULL,json_object('status',?),json_object('status','active'),
        json_object('source','start','telegramUserId',?),?
      FROM telegram_connections c
      WHERE c.user_id=? AND c.chat_id=? AND c.telegram_user_id=? AND c.status='active'
        AND EXISTS (SELECT 1 FROM telegram_webhook_updates
          WHERE update_id=? AND payload_hash=? AND outcome='menu' AND processed_at=?)`)
      .bind(
        auditId,
        candidate.status,
        telegramUserId,
        now,
        candidate.user_id,
        chatId,
        telegramUserId,
        updateId,
        payloadHash,
        now,
      ),
  ]);
  const inserted = Number(results[0]?.meta?.changes ?? 0) === 1;
  return {
    inserted,
    profile: inserted
      ? await connectedTelegramProfile(db, chatId, telegramUserId)
      : null,
  };
}

async function connectedTelegramProfile(
  db: TelegramDatabase,
  chatId: string,
  telegramUserId: string,
): Promise<ConnectedTelegramProfile | null> {
  return db.prepare(`
    SELECT u.id AS user_id,u.full_name,u.role,c.notify_orders,c.notify_visits,
      EXISTS (SELECT 1 FROM teacher_profiles p
        JOIN visit_teacher_credentials v ON v.teacher_user_id=p.teacher_user_id AND v.status='active'
        WHERE p.teacher_user_id=u.id AND p.closed_at IS NULL) AS teacher_capability
    FROM telegram_connections c JOIN users u ON u.id=c.user_id
    WHERE c.chat_id=? AND c.telegram_user_id=? AND c.status='active'
      AND u.status='active'
      AND (u.role IN ('admin','librarian') OR EXISTS (
        SELECT 1 FROM teacher_profiles p
        JOIN visit_teacher_credentials v ON v.teacher_user_id=p.teacher_user_id AND v.status='active'
        WHERE p.teacher_user_id=u.id AND p.closed_at IS NULL
      ))
    LIMIT 1
  `).bind(chatId, telegramUserId).first<ConnectedTelegramProfile>();
}

function notificationsMasterEnabled(profile: ConnectedTelegramProfile): boolean {
  return Boolean(profile.notify_orders) || Boolean(profile.notify_visits);
}

async function bestEffortConnectedMenu(
  botToken: string,
  chatId: string,
  role: ConnectedTelegramRole,
  teacherCapability: boolean,
  fullName: string,
  notificationsOn: boolean,
  siteOrigin: string | undefined,
  linked: boolean,
  fetcher: TelegramFetcher,
): Promise<void> {
  try {
    const origin = siteOrigin ? trustedSiteOrigin(siteOrigin) : null;
    const configuration = telegramConfiguration();
    const keyboard = origin
      ? telegramRoleKeyboard(role, teacherCapability, origin, configuration.miniAppEnabled, notificationsOn)
      : null;
    const greeting = linked
      ? `Telegram підключено до профілю «${safePlainText(fullName, 120)}».`
      : `Профіль: «${safePlainText(fullName, 120)}».`;
    await telegramApiRequest(botToken, "sendMessage", {
      chat_id: chatId,
      text: `<b>${escapeHtml(greeting)}</b>\nСповіщення: ${notificationsOn ? "увімкнено 🔔" : "вимкнено 🔕"}.\nОберіть потрібний розділ:`,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    }, fetcher);
    if ((role === "admin" || role === "librarian") && origin && configuration.miniAppEnabled) {
      await bestEffortChatMenuButton(
        botToken,
        chatId,
        { text: "Кабінет бібліотекаря", url: new URL("/librarian/telegram?target=home", origin).toString() },
        fetcher,
      );
    } else if (teacherCapability && origin && configuration.miniAppEnabled) {
      await bestEffortChatMenuButton(
        botToken,
        chatId,
        { text: "Кабінет учителя", url: new URL("/teacher/telegram?tab=overview", origin).toString() },
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
  teacherCapability: boolean,
  siteOrigin: string,
  miniAppEnabled: boolean,
  notificationsOn: boolean,
): Array<Array<Record<string, unknown>>> {
  const keyboard: Array<Array<Record<string, unknown>>> = [];
  if (teacherCapability) {
    const buttons = [
      ["👤 Кабінет учителя", "/teacher/telegram?tab=overview"],
      ["📚 Каталог і замовлення", "/teacher/telegram?tab=orders"],
      ["➕ Запропонувати придбання", "/teacher/telegram?tab=acquisition"],
      ["📅 Записатися / мої відвідування", "/teacher/telegram?tab=visits"],
      ["📖 Мої посібники", "/teacher/telegram?tab=loans"],
      ["🔔 Мої повідомлення", "/teacher/telegram?tab=notifications"],
    ] as const;
    keyboard.push(...buttons.map(([text, miniPath]) => {
      const path = miniAppEnabled ? miniPath : miniPath.replace("/teacher/telegram", "/teacher");
      const url = new URL(path, siteOrigin).toString();
      return [{ text, ...(miniAppEnabled ? { web_app: { url } } : { url }) }];
    }));
  }
  if (role === "admin" || role === "librarian") {
    const buttons = [
      ["🆕 Замовлення вчителів", "/librarian/telegram?target=visits", "/librarian/visits#request-inbox-title"],
      ["➕ Комплектування фонду", "/librarian/telegram?target=acquisitions", "/librarian/acquisitions"],
      ["📅 Відвідування", "/librarian/telegram?target=visits", "/librarian/visits"],
      ["👩‍🏫 Вчителі", "/librarian/telegram?target=teachers", "/librarian/teachers"],
      ["🏠 Кабінет бібліотекаря", "/librarian/telegram?target=home", "/librarian"],
    ] as const;
    keyboard.push(...buttons.map(([text, miniPath, webPath]) => {
      const url = new URL(miniAppEnabled ? miniPath : webPath, siteOrigin).toString();
      return [{ text, ...(miniAppEnabled ? { web_app: { url } } : { url }) }];
    }));
  }
  keyboard.push([{
    text: notificationsOn ? "🔕 Вимкнути сповіщення" : "🔔 Увімкнути сповіщення",
    callback_data: notificationsOn ? "telegram-notifications:off" : "telegram-notifications:on",
  }]);
  return keyboard;
}

async function bestEffortChatMenuButton(
  botToken: string,
  chatId: string,
  miniApp: { text: string; url: string } | null,
  fetcher: TelegramFetcher,
): Promise<void> {
  const numericChatId = Number(chatId);
  if (!Number.isSafeInteger(numericChatId)) return;
  try {
    await telegramApiRequest(botToken, "setChatMenuButton", {
      chat_id: numericChatId,
      menu_button: miniApp
        ? { type: "web_app", text: miniApp.text, web_app: { url: miniApp.url } }
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
  await db.batch([
    ...(error.code === "telegram_blocked" ? [
      db.prepare(`UPDATE telegram_librarian_sessions SET revoked_at=?,last_seen_at=?
        WHERE user_id=? AND revoked_at IS NULL`).bind(now, now, userId),
      db.prepare(`UPDATE visit_teacher_sessions SET revoked_at=?,last_seen_at=?
        WHERE teacher_user_id=? AND revoked_at IS NULL`).bind(now, now, userId),
    ] : []),
    connectionFailureStatement(db, userId, error, now),
  ]);
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
