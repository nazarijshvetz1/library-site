import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

globalThis.__TELEGRAM_TEST_ENV = {
  TELEGRAM_LINKING_ENABLED: "true",
  TELEGRAM_NOTIFICATIONS_ENABLED: "true",
  TELEGRAM_MINI_APP_ENABLED: "true",
  TELEGRAM_BOT_USERNAME: "LibraryTestBot",
  TELEGRAM_BOT_TOKEN: "123456789:test-token-never-used-outside-tests",
  TELEGRAM_WEBHOOK_SECRET: "test_webhook_secret_123456789",
  TELEGRAM_SITE_ORIGIN: "https://library.example.test",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return {
        url: "data:text/javascript,export const env=globalThis.__TELEGRAM_TEST_ENV",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const telegram = await import("../lib/telegram-notifications.ts");
const outbox = await import("../lib/telegram-outbox.ts");
const telegramApi = await import("../lib/telegram-api.ts");
const visitStore = await import("../lib/visit-schedule-store.ts");

test("Telegram API preserves teacher authentication errors", async () => {
  for (const [code, status, error] of [
    ["authentication_required", 401, "Сеанс завершився."],
    ["pin_change_required", 403, "Створіть власний PIN."],
  ]) {
    const response = telegramApi.telegramStoreError(new visitStore.VisitScheduleError(code, status, error));
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { schemaVersion: 1, success: false, code, error });
  }
  const fallback = telegramApi.telegramStoreError(new Error("private detail"));
  assert.equal(fallback.status, 503);
  assert.equal((await fallback.json()).code, "telegram_unavailable");
});

class PreparedStatement {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }
  bind(...values) { return new PreparedStatement(this.database, this.sql, values); }
  async first() { return this.database.sqlite.prepare(this.sql).get(...this.bindings) ?? null; }
  async all() { return { success: true, results: this.database.sqlite.prepare(this.sql).all(...this.bindings) }; }
  execute() {
    const result = this.database.sqlite.prepare(this.sql).run(...this.bindings);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class TestD1 {
  constructor(sqlite) { this.sqlite = sqlite; }
  prepare(sql) { return new PreparedStatement(this, sql); }
  async batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.execute());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

const migrations = [
  "0000_librarian_drafts.sql", "0001_draft_workflow.sql", "0002_remove_legacy_audit_triggers.sql",
  "0003_odd_the_order.sql", "0004_staging_import_runs.sql", "0005_young_night_nurse.sql",
  "0006_pale_sauron.sql", "0007_cold_whiplash.sql", "0008_sudden_thunderbird.sql",
  "0009_happy_silver_samurai.sql", "0010_shocking_cobalt_man.sql",
  "0011_normalize_holding_conditions.sql", "0012_elite_victor_mancha.sql",
  "0013_strange_dark_beast.sql", "0014_rich_lionheart.sql", "0015_glamorous_namora.sql",
  "0016_busy_jane_foster.sql",
  "0017_fresh_robbie_robertson.sql",
  "0018_yielding_skaar.sql",
  "0019_kindly_wolfsbane.sql",
];

async function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const file of migrations) sqlite.exec(await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  const now = "2026-08-22T10:00:00.000Z";
  sqlite.prepare(`INSERT INTO users
    (id,full_name,sort_name,email,auth_user_id,role,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'active',?,?)`)
    .run("USR-LIB", "Бібліотекар", "Бібліотекар", "library@example.test", "auth-lib", "librarian", now, now);
  sqlite.prepare(`INSERT INTO users
    (id,full_name,sort_name,email,auth_user_id,role,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'active',?,?)`)
    .run("USR-TEACHER", "Шевченко Олена", "Шевченко Олена", null, null, "teacher", now, now);
  sqlite.prepare(`INSERT INTO teacher_profiles (teacher_user_id,created_at,updated_at) VALUES (?,?,?)`)
    .run("USR-TEACHER", now, now);
  return { sqlite, db: new TestD1(sqlite), now };
}

function addTeacherCredential(context, version = 1) {
  context.sqlite.prepare(`INSERT INTO visit_teacher_credentials (
    teacher_user_id,login_id,code_hmac,must_change_pin,status,version,failed_attempts,
    failure_window_started_at,locked_until,last_login_at,code_rotated_at,last_access_command_id,
    created_by_user_id,updated_by_user_id,created_at,updated_at
  ) VALUES ('USR-TEACHER','teacher-login-id-0001',?,1,'active',?,0,
    NULL,NULL,NULL,?,NULL,'USR-LIB','USR-LIB',?,?)`)
    .run("a".repeat(64), version, context.now, context.now, context.now);
}

function telegramOk(messageId = 1) {
  return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("one-time deep link stores only a SHA-256 digest and links a private chat once", async () => {
  const context = await database();
  const randomBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const linkNow = new Date();
  const link = await telegram.createTelegramLinkToken(context.db, "USR-TEACHER", {
    now: linkNow, randomBytes,
  });
  const rawToken = new URL(link.linkUrl).searchParams.get("start");
  assert.match(rawToken, /^[A-Za-z0-9_-]{43}$/u);
  const stored = context.sqlite.prepare("SELECT token_hash,expires_at FROM telegram_link_tokens").get();
  assert.match(stored.token_hash, /^[0-9a-f]{64}$/u);
  assert.notEqual(stored.token_hash, rawToken);
  assert.equal(context.sqlite.prepare("SELECT count(*) AS count FROM telegram_link_tokens WHERE token_hash=?").get(rawToken).count, 0);

  const payload = {
    update_id: 91,
    message: {
      text: `/start ${rawToken}`,
      chat: { id: 7001, type: "private" },
      from: { id: 7001, username: "teacher_one" },
    },
  };
  const raw = JSON.stringify(payload);
  let fetches = 0;
  const fetcher = async () => { fetches += 1; return telegramOk(17); };
  const first = await telegram.processTelegramWebhookUpdate(context.db, raw, payload, fetcher);
  assert.deepEqual(first, { outcome: "linked", duplicate: false });
  assert.equal(fetches, 1);
  assert.deepEqual(
    { ...context.sqlite.prepare("SELECT user_id,telegram_user_id,chat_id,status FROM telegram_connections").get() },
    { user_id: "USR-TEACHER", telegram_user_id: "7001", chat_id: "7001", status: "active" },
  );
  assert.equal(context.sqlite.prepare("SELECT consumed_update_id FROM telegram_link_tokens").get().consumed_update_id, "91");

  const replay = await telegram.processTelegramWebhookUpdate(context.db, raw, payload, fetcher);
  assert.deepEqual(replay, { outcome: "linked", duplicate: true });
  assert.equal(fetches, 1);
  context.sqlite.close();
});

test("group start never consumes the token", async () => {
  const context = await database();
  const link = await telegram.createTelegramLinkToken(context.db, "USR-TEACHER", {
    now: new Date(context.now), randomBytes: new Uint8Array(32).fill(7),
  });
  const rawToken = new URL(link.linkUrl).searchParams.get("start");
  const payload = { update_id: 92, message: { text: `/start ${rawToken}`, chat: { id: -7, type: "group" }, from: { id: 7002 } } };
  const result = await telegram.processTelegramWebhookUpdate(context.db, JSON.stringify(payload), payload, async () => telegramOk());
  assert.deepEqual(result, { outcome: "ignored_non_private", duplicate: false });
  assert.equal(context.sqlite.prepare("SELECT consumed_at FROM telegram_link_tokens").get().consumed_at, null);
  assert.equal(context.sqlite.prepare("SELECT count(*) AS count FROM telegram_connections").get().count, 0);
  context.sqlite.close();
});

test("personal QR creates an atomic QR-only pending credential for an unregistered teacher", async () => {
  const context = await database();
  const requestId = crypto.randomUUID();
  const linkNow = new Date();
  const created = await telegram.createTelegramTeacherActivationInvite(
    context.db,
    { id: "USR-LIB", email: "library@example.test" },
    "USR-TEACHER",
    { requestId, expectedCredentialVersion: 0 },
    { now: linkNow, randomBytes: new Uint8Array(32).fill(8) },
  );

  assert.equal(created.purpose, "registration");
  assert.equal(new Date(created.expiresAt).getTime() - linkNow.getTime(), 10 * 60 * 1000);
  const rawToken = new URL(created.linkUrl).searchParams.get("start");
  const credential = context.sqlite.prepare(`SELECT login_id,code_hmac,must_change_pin,status,version,
    code_expires_at,last_access_command_id FROM visit_teacher_credentials WHERE teacher_user_id='USR-TEACHER'`).get();
  assert.match(credential.login_id, /^qr_[0-9a-f]{64}$/u);
  assert.match(credential.code_hmac, /^[0-9a-f]{64}$/u);
  assert.notEqual(credential.code_hmac, rawToken);
  assert.deepEqual(
    {
      must_change_pin: credential.must_change_pin,
      status: credential.status,
      version: credential.version,
      code_expires_at: credential.code_expires_at,
      last_access_command_id: credential.last_access_command_id,
    },
    {
      must_change_pin: 1,
      status: "active",
      version: 1,
      code_expires_at: created.expiresAt,
      last_access_command_id: requestId,
    },
  );
  const invite = context.sqlite.prepare(`SELECT credential_version,token_hash FROM telegram_teacher_activation_invites
    WHERE id=?`).get(created.inviteId);
  assert.equal(invite.credential_version, 1);
  assert.match(invite.token_hash, /^[0-9a-f]{64}$/u);
  assert.notEqual(invite.token_hash, rawToken);

  await assert.rejects(
    telegram.createTelegramTeacherActivationInvite(
      context.db,
      { id: "USR-LIB", email: "library@example.test" },
      "USR-TEACHER",
      { requestId: crypto.randomUUID(), expectedCredentialVersion: 0 },
      { now: linkNow, randomBytes: new Uint8Array(32).fill(7) },
    ),
    (error) => error instanceof telegram.TelegramIntegrationError
      && error.code === "credential_version_conflict",
  );
  assert.equal(context.sqlite.prepare(`SELECT COUNT(*) AS n FROM visit_teacher_credentials
    WHERE teacher_user_id='USR-TEACHER'`).get().n, 1);
  assert.equal(context.sqlite.prepare(`SELECT COUNT(*) AS n FROM telegram_teacher_activation_invites
    WHERE teacher_user_id='USR-TEACHER'`).get().n, 1);
  context.sqlite.close();
});

test("personal teacher activation invite stores only a digest and binds to one private Telegram", async () => {
  const context = await database();
  addTeacherCredential(context);
  const requestId = crypto.randomUUID();
  const linkNow = new Date();
  const created = await telegram.createTelegramTeacherActivationInvite(
    context.db,
    { id: "USR-LIB", email: "library@example.test" },
    "USR-TEACHER",
    { requestId, expectedCredentialVersion: 1 },
    { now: linkNow, randomBytes: new Uint8Array(32).fill(9) },
  );
  const rawToken = new URL(created.linkUrl).searchParams.get("start");
  assert.match(rawToken, /^ta_[A-Za-z0-9_-]{43}$/u);
  assert.equal(created.teacher.fullName, "Шевченко Олена");
  assert.equal(created.purpose, "registration");
  assert.equal(new Date(created.expiresAt).getTime() - linkNow.getTime(), 10 * 60 * 1000);
  const stored = context.sqlite.prepare(`SELECT token_hash,request_id,bound_telegram_user_id
    FROM telegram_teacher_activation_invites WHERE id=?`).get(created.inviteId);
  assert.match(stored.token_hash, /^[0-9a-f]{64}$/u);
  assert.notEqual(stored.token_hash, rawToken);
  assert.equal(stored.request_id, requestId);
  assert.equal(stored.bound_telegram_user_id, null);

  const payload = {
    update_id: 109,
    message: { text: `/start ${rawToken}`, chat: { id: 7101, type: "private" }, from: { id: 7101, username: "olena" } },
  };
  const bodies = [];
  const claimed = await telegram.processTelegramWebhookUpdate(
    context.db,
    JSON.stringify(payload),
    payload,
    async (_url, init) => { bodies.push(JSON.parse(init.body)); return telegramOk(71); },
    "https://library.example.test",
  );
  assert.deepEqual(claimed, { outcome: "activation_invite_claimed", duplicate: false });
  assert.deepEqual(
    { ...context.sqlite.prepare(`SELECT bound_telegram_user_id,bound_chat_id,bound_username,bound_update_id
      FROM telegram_teacher_activation_invites WHERE id=?`).get(created.inviteId) },
    { bound_telegram_user_id: "7101", bound_chat_id: "7101", bound_username: "olena", bound_update_id: "109" },
  );
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_connections").get().n, 0);
  const message = bodies.find((body) => body.text);
  assert.match(message.text, /Шевченко Олена/u);
  assert.match(message.text, /QR підтверджено/u);
  assert.match(message.text, /Тимчасовий код не потрібен/u);
  assert.doesNotMatch(message.text, /введіть тимчасовий код/u);
  assert.equal(message.reply_markup.inline_keyboard[0][0].text, "✨ Створити PIN");
  assert.equal(message.reply_markup.inline_keyboard[0][0].web_app.url,
    "https://library.example.test/teacher/telegram?mode=activate");
  assert.deepEqual(await telegram.processTelegramWebhookUpdate(
    context.db,
    JSON.stringify(payload),
    payload,
    async () => telegramOk(72),
    "https://library.example.test",
  ), { outcome: "activation_invite_claimed", duplicate: true });

  const second = await telegram.createTelegramTeacherActivationInvite(
    context.db,
    { id: "USR-LIB", email: "library@example.test" },
    "USR-TEACHER",
    { requestId: crypto.randomUUID(), expectedCredentialVersion: 1 },
    { now: linkNow, randomBytes: new Uint8Array(32).fill(10) },
  );
  assert.ok(context.sqlite.prepare("SELECT revoked_at FROM telegram_teacher_activation_invites WHERE id=?")
    .get(created.inviteId).revoked_at);
  assert.deepEqual(await telegram.revokeTelegramTeacherActivationInvite(
    context.db,
    { id: "USR-LIB", email: "library@example.test" },
    "USR-TEACHER",
    { requestId: crypto.randomUUID(), inviteId: second.inviteId },
  ), { inviteId: second.inviteId, revoked: true });
  assert.ok(context.sqlite.prepare("SELECT revoked_at FROM telegram_teacher_activation_invites WHERE id=?")
    .get(second.inviteId).revoked_at);
  context.sqlite.close();
});

test("personal PIN-reset QR permits same-teacher Telegram rebind but rejects a Telegram bound to another teacher", async () => {
  const context = await database();
  addTeacherCredential(context, 4);
  context.sqlite.prepare(`UPDATE visit_teacher_credentials SET must_change_pin=0,code_expires_at=NULL
    WHERE teacher_user_id='USR-TEACHER'`).run();
  context.sqlite.prepare(`INSERT INTO telegram_connections (
    user_id,telegram_user_id,chat_id,username,status,notify_orders,notify_visits,version,
    linked_at,disabled_at,created_at,updated_at
  ) VALUES ('USR-TEACHER','7001','7001','old_teacher','active',1,1,1,?,NULL,?,?)`)
    .run(context.now, context.now, context.now);

  const created = await telegram.createTelegramTeacherActivationInvite(
    context.db,
    { id: "USR-LIB", email: "library@example.test" },
    "USR-TEACHER",
    { requestId: crypto.randomUUID(), expectedCredentialVersion: 4 },
    { now: new Date(), randomBytes: new Uint8Array(32).fill(11) },
  );
  assert.equal(created.purpose, "pin_reset");
  const rawToken = new URL(created.linkUrl).searchParams.get("start");
  const payload = {
    update_id: 110,
    message: { text: `/start ${rawToken}`, chat: { id: 7102, type: "private" }, from: { id: 7102, username: "new_phone" } },
  };
  const bodies = [];
  assert.deepEqual(await telegram.processTelegramWebhookUpdate(
    context.db,
    JSON.stringify(payload),
    payload,
    async (_url, init) => { bodies.push(JSON.parse(init.body)); return telegramOk(73); },
    "https://library.example.test",
  ), { outcome: "activation_invite_claimed", duplicate: false });
  assert.equal(context.sqlite.prepare(`SELECT bound_telegram_user_id FROM telegram_teacher_activation_invites
    WHERE id=?`).get(created.inviteId).bound_telegram_user_id, "7102");
  assert.equal(context.sqlite.prepare(`SELECT COUNT(*) AS n FROM telegram_connections
    WHERE user_id='USR-TEACHER' AND telegram_user_id='7001' AND status='active'`).get().n, 1);
  const message = bodies.find((body) => body.text);
  assert.match(message.text, /QR підтверджено/u);
  assert.match(message.text, /Чинний PIN не потрібен/u);
  assert.equal(message.reply_markup.inline_keyboard[0][0].text, "🔐 Замінити PIN");
  assert.equal(message.reply_markup.inline_keyboard[0][0].web_app.url,
    "https://library.example.test/teacher/telegram?mode=activate");

  context.sqlite.prepare(`INSERT INTO users
    (id,full_name,sort_name,email,auth_user_id,role,status,created_at,updated_at)
    VALUES ('USR-OTHER','Інший Учитель','Інший Учитель',NULL,NULL,'teacher','active',?,?)`)
    .run(context.now, context.now);
  context.sqlite.prepare(`INSERT INTO teacher_profiles (teacher_user_id,created_at,updated_at)
    VALUES ('USR-OTHER',?,?)`).run(context.now, context.now);
  context.sqlite.prepare(`INSERT INTO telegram_connections (
    user_id,telegram_user_id,chat_id,username,status,notify_orders,notify_visits,version,
    linked_at,disabled_at,created_at,updated_at
  ) VALUES ('USR-OTHER','7200','7200','other_teacher','active',1,1,1,?,NULL,?,?)`)
    .run(context.now, context.now, context.now);
  const conflicting = await telegram.createTelegramTeacherActivationInvite(
    context.db,
    { id: "USR-LIB", email: "library@example.test" },
    "USR-TEACHER",
    { requestId: crypto.randomUUID(), expectedCredentialVersion: 4 },
    { now: new Date(), randomBytes: new Uint8Array(32).fill(12) },
  );
  const conflictToken = new URL(conflicting.linkUrl).searchParams.get("start");
  const conflictPayload = {
    update_id: 111,
    message: { text: `/start ${conflictToken}`, chat: { id: 7200, type: "private" }, from: { id: 7200, username: "other_teacher" } },
  };
  assert.deepEqual(await telegram.processTelegramWebhookUpdate(
    context.db,
    JSON.stringify(conflictPayload),
    conflictPayload,
    async () => telegramOk(74),
    "https://library.example.test",
  ), { outcome: "activation_invite_conflict", duplicate: false });
  assert.equal(context.sqlite.prepare(`SELECT bound_telegram_user_id FROM telegram_teacher_activation_invites
    WHERE id=?`).get(conflicting.inviteId).bound_telegram_user_id, null);
  context.sqlite.close();
});

test("connected private chats receive role-aware menus and teacher Mini App buttons", async () => {
  const teacher = await database();
  addTeacherCredential(teacher);
  teacher.sqlite.prepare(`INSERT INTO telegram_connections (
    user_id,telegram_user_id,chat_id,username,status,notify_orders,notify_visits,version,
    linked_at,disabled_at,created_at,updated_at
  ) VALUES ('USR-TEACHER','7001','7001',NULL,'active',1,1,1,?,NULL,?,?)`)
    .run(teacher.now, teacher.now, teacher.now);
  teacher.sqlite.prepare(`INSERT INTO visit_teacher_sessions (
    token_hash,teacher_user_id,credential_version,pending_scope,ip_scope_hash,
    expires_at,last_seen_at,revoked_at,created_at
  ) VALUES (?,'USR-TEACHER',1,'pending-stop-session',?,
    '2026-08-23T10:00:00.000Z',?,NULL,?)`)
    .run("1".repeat(64), "2".repeat(64), teacher.now, teacher.now);
  teacher.sqlite.prepare(`INSERT INTO telegram_link_tokens (
    id,user_id,token_hash,expires_at,consumed_at,consumed_update_id,revoked_at,created_at
  ) VALUES ('TGL-stop','USR-TEACHER',?,'2026-08-23T10:00:00.000Z',NULL,NULL,NULL,?)`)
    .run("3".repeat(64), teacher.now);
  teacher.sqlite.prepare(`INSERT INTO telegram_teacher_activation_invites (
    id,kind,teacher_user_id,credential_version,token_hash,issued_by_user_id,request_id,
    bound_telegram_user_id,bound_chat_id,bound_username,bound_update_id,presented_at,
    expires_at,consumed_init_data_hash,consumed_at,revoked_at,created_at,updated_at
  ) VALUES ('TGA-stop-personal','personal','USR-TEACHER',1,?,'USR-LIB',?,
    NULL,NULL,NULL,NULL,NULL,'2026-08-23T10:00:00.000Z',NULL,NULL,NULL,?,?)`)
    .run("4".repeat(64), crypto.randomUUID(), teacher.now, teacher.now);
  teacher.sqlite.prepare(`INSERT INTO telegram_teacher_activation_invites (
    id,kind,teacher_user_id,credential_version,token_hash,issued_by_user_id,request_id,
    bound_telegram_user_id,bound_chat_id,bound_username,bound_update_id,presented_at,
    expires_at,consumed_init_data_hash,consumed_at,revoked_at,created_at,updated_at
  ) VALUES ('TGA-stop-generic','generic',NULL,NULL,NULL,NULL,NULL,
    '7001','7001',NULL,'stop-generic-update',?,'2026-08-23T10:00:00.000Z',
    NULL,NULL,NULL,?,?)`).run(teacher.now, teacher.now, teacher.now);
  const teacherPayload = {
    update_id: 93,
    message: { text: "/start", chat: { id: 7001, type: "private" }, from: { id: 7001 } },
  };
  const teacherBodies = [];
  const teacherResult = await telegram.processTelegramWebhookUpdate(
    teacher.db,
    JSON.stringify(teacherPayload),
    teacherPayload,
    async (_url, init) => { teacherBodies.push(JSON.parse(init.body)); return telegramOk(51); },
    "https://preview.example.test",
  );
  assert.deepEqual(teacherResult, { outcome: "menu", duplicate: false });
  const teacherMessage = teacherBodies.find((body) => body.text);
  const menuButton = teacherBodies.find((body) => body.menu_button);
  assert.equal(teacherMessage.reply_markup.inline_keyboard.length, 8);
  assert.deepEqual(
    teacherMessage.reply_markup.inline_keyboard.slice(0, 7).map((row) => row[0].text),
    [
      "👤 Кабінет учителя",
      "📚 Каталог",
      "🛒 Замовлення",
      "➕ Запропонувати придбання",
      "📅 Записатися / мої відвідування",
      "📖 Мої посібники",
      "🔔 Мої повідомлення",
    ],
  );
  assert.deepEqual(
    teacherMessage.reply_markup.inline_keyboard.slice(0, 7).map((row) => row[0].web_app.url),
    [
      "https://library.example.test/teacher/telegram?tab=overview",
      "https://nazarijshvetz1.github.io/library-site/",
      "https://library.example.test/teacher/telegram?tab=orders",
      "https://library.example.test/teacher/telegram?tab=acquisition",
      "https://library.example.test/teacher/telegram?tab=visits",
      "https://library.example.test/teacher/telegram?tab=loans",
      "https://library.example.test/teacher/telegram?tab=notifications",
    ],
  );
  assert.equal(teacherMessage.reply_markup.inline_keyboard[1][0].url, undefined);
  assert.equal(teacherMessage.reply_markup.inline_keyboard[7][0].callback_data, "telegram-notifications:off");
  assert.equal(menuButton.menu_button.type, "web_app");
  assert.equal(menuButton.chat_id, 7001);
  assert.equal(menuButton.menu_button.web_app.url, "https://library.example.test/teacher/telegram?tab=overview");
  const beforeReplay = teacherBodies.length;
  assert.deepEqual(await telegram.processTelegramWebhookUpdate(
    teacher.db,
    JSON.stringify(teacherPayload),
    teacherPayload,
    async (_url, init) => { teacherBodies.push(JSON.parse(init.body)); return telegramOk(53); },
    "https://library.example.test",
  ), { outcome: "menu", duplicate: true });
  assert.equal(teacherBodies.length, beforeReplay);

  const stopPayload = {
    update_id: 95,
    message: { text: "/stop", chat: { id: 7001, type: "private" }, from: { id: 7001 } },
  };
  assert.deepEqual(await telegram.processTelegramWebhookUpdate(
    teacher.db,
    JSON.stringify(stopPayload),
    stopPayload,
    async (_url, init) => { teacherBodies.push(JSON.parse(init.body)); return telegramOk(54); },
    "https://library.example.test",
  ), { outcome: "notifications_disabled", duplicate: false });
  assert.equal(teacher.sqlite.prepare(`SELECT revoked_at FROM visit_teacher_sessions
    WHERE token_hash=?`).get("1".repeat(64)).revoked_at, null);
  assert.equal(teacher.sqlite.prepare("SELECT revoked_at FROM telegram_link_tokens WHERE id='TGL-stop'").get().revoked_at, null);
  assert.equal(teacher.sqlite.prepare(`SELECT revoked_at FROM telegram_teacher_activation_invites
    WHERE id='TGA-stop-personal'`).get().revoked_at, null);
  assert.equal(teacher.sqlite.prepare(`SELECT revoked_at FROM telegram_teacher_activation_invites
    WHERE id='TGA-stop-generic'`).get().revoked_at, null);
  assert.deepEqual(
    { ...teacher.sqlite.prepare(`SELECT status,notify_orders,notify_visits FROM telegram_connections
      WHERE user_id='USR-TEACHER'`).get() },
    { status: "active", notify_orders: 0, notify_visits: 0 },
  );
  const unlinkedPayload = {
    update_id: 96,
    message: { text: "/menu", chat: { id: 7001, type: "private" }, from: { id: 7001 } },
  };
  const unlinkedBodies = [];
  assert.deepEqual(await telegram.processTelegramWebhookUpdate(
    teacher.db,
    JSON.stringify(unlinkedPayload),
    unlinkedPayload,
    async (_url, init) => { unlinkedBodies.push(JSON.parse(init.body)); return telegramOk(55); },
    "https://library.example.test",
  ), { outcome: "menu", duplicate: false });
  const mutedMenu = unlinkedBodies.find((body) => body.text);
  assert.match(mutedMenu.text, /вимкнено/u);
  assert.equal(mutedMenu.reply_markup.inline_keyboard[7][0].callback_data, "telegram-notifications:on");

  const newTeacherPayload = {
    update_id: 98,
    message: { text: "/start", chat: { id: 7002, type: "private" }, from: { id: 7002 } },
  };
  const onboardingBodies = [];
  assert.deepEqual(await telegram.processTelegramWebhookUpdate(
    teacher.db,
    JSON.stringify(newTeacherPayload),
    newTeacherPayload,
    async (_url, init) => { onboardingBodies.push(JSON.parse(init.body)); return telegramOk(58); },
    "https://library.example.test",
  ), { outcome: "activation_started", duplicate: false });
  const onboardingMessage = onboardingBodies.find((body) => body.text);
  const onboardingMenu = onboardingBodies.find((body) => body.menu_button);
  assert.equal(onboardingMessage.reply_markup.inline_keyboard[0][0].text, "🔑 Увійти");
  assert.equal(onboardingMessage.reply_markup.inline_keyboard[0][0].web_app.url,
    "https://library.example.test/teacher/telegram?mode=login");
  assert.equal(onboardingMessage.reply_markup.inline_keyboard[1][0].text, "✨ Активувати вперше");
  assert.equal(onboardingMessage.reply_markup.inline_keyboard[1][0].web_app.url,
    "https://library.example.test/teacher/telegram?mode=activate");
  assert.equal(onboardingMessage.reply_markup.inline_keyboard[2][0].text, "📚 Переглянути каталог");
  assert.equal(onboardingMessage.reply_markup.inline_keyboard[2][0].web_app.url,
    "https://nazarijshvetz1.github.io/library-site/");
  assert.equal(onboardingMessage.reply_markup.inline_keyboard[2][0].url, undefined);
  assert.equal(onboardingMenu.menu_button.web_app.url, "https://library.example.test/teacher/telegram?tab=overview");
  assert.deepEqual(
    { ...teacher.sqlite.prepare(`SELECT kind,teacher_user_id,bound_telegram_user_id,bound_chat_id
      FROM telegram_teacher_activation_invites WHERE consumed_at IS NULL AND revoked_at IS NULL
        AND bound_telegram_user_id='7002'`).get() },
    { kind: "generic", teacher_user_id: null, bound_telegram_user_id: "7002", bound_chat_id: "7002" },
  );

  const librarian = await database();
  librarian.sqlite.prepare(`INSERT INTO telegram_connections (
    user_id,telegram_user_id,chat_id,username,status,notify_orders,notify_visits,version,
    linked_at,disabled_at,created_at,updated_at
  ) VALUES ('USR-LIB','8001','8001',NULL,'active',1,1,1,?,NULL,?,?)`)
    .run(librarian.now, librarian.now, librarian.now);
  const librarianPayload = {
    update_id: 94,
    message: { text: "/start", chat: { id: 8001, type: "private" }, from: { id: 8001 } },
  };
  const librarianBodies = [];
  const librarianResult = await telegram.processTelegramWebhookUpdate(
    librarian.db,
    JSON.stringify(librarianPayload),
    librarianPayload,
    async (_url, init) => { librarianBodies.push(JSON.parse(init.body)); return telegramOk(52); },
    "https://library.example.test",
  );
  assert.deepEqual(librarianResult, { outcome: "menu", duplicate: false });
  const librarianMessage = librarianBodies.find((body) => body.text);
  assert.equal(librarianMessage.reply_markup.inline_keyboard[0][0].text, "🆕 Замовлення вчителів");
  assert.equal(librarianMessage.reply_markup.inline_keyboard[0][0].web_app.url,
    "https://library.example.test/librarian/telegram?target=teachers&tab=orders");
  assert.equal(librarianMessage.reply_markup.inline_keyboard.some((row) => row[0].web_app), true);

  const dualRole = await database();
  dualRole.sqlite.prepare(`INSERT INTO users
    (id,full_name,sort_name,email,auth_user_id,role,status,created_at,updated_at)
    VALUES ('USR-006','Орел Галина Миколаївна','орел галина миколаївна',NULL,NULL,'admin','active',?,?)`)
    .run(dualRole.now, dualRole.now);
  dualRole.sqlite.prepare(`INSERT INTO teacher_profiles (teacher_user_id,created_at,updated_at) VALUES ('USR-006',?,?)`)
    .run(dualRole.now, dualRole.now);
  dualRole.sqlite.prepare(`INSERT INTO visit_teacher_credentials (
    teacher_user_id,login_id,code_hmac,must_change_pin,status,version,failed_attempts,
    failure_window_started_at,locked_until,last_login_at,code_rotated_at,last_access_command_id,
    created_by_user_id,updated_by_user_id,created_at,updated_at
  ) VALUES ('USR-006','dual-role-login-0001',?,0,'active',1,0,
    NULL,NULL,NULL,?,NULL,'USR-LIB','USR-LIB',?,?)`)
    .run("b".repeat(64), dualRole.now, dualRole.now, dualRole.now);
  dualRole.sqlite.prepare(`INSERT INTO telegram_connections (
    user_id,telegram_user_id,chat_id,username,status,notify_orders,notify_visits,version,
    linked_at,disabled_at,created_at,updated_at
  ) VALUES ('USR-006','9001','9001',NULL,'active',1,1,1,?,NULL,?,?)`)
    .run(dualRole.now, dualRole.now, dualRole.now);
  const dualPayload = {
    update_id: 97,
    message: { text: "/menu", chat: { id: 9001, type: "private" }, from: { id: 9001 } },
  };
  const dualBodies = [];
  assert.deepEqual(await telegram.processTelegramWebhookUpdate(
    dualRole.db,
    JSON.stringify(dualPayload),
    dualPayload,
    async (_url, init) => { dualBodies.push(JSON.parse(init.body)); return telegramOk(56); },
    "https://library.example.test",
  ), { outcome: "menu", duplicate: false });
  const dualMessage = dualBodies.find((body) => body.text);
  const dualMenuButton = dualBodies.find((body) => body.menu_button);
  assert.equal(dualMessage.reply_markup.inline_keyboard.length, 13);
  assert.equal(dualMessage.reply_markup.inline_keyboard[0][0].web_app.url,
    "https://library.example.test/teacher/telegram?tab=overview");
  assert.equal(dualMessage.reply_markup.inline_keyboard[7][0].web_app.url,
    "https://library.example.test/librarian/telegram?target=teachers&tab=orders");
  assert.equal(dualMessage.reply_markup.inline_keyboard[11][0].web_app.url,
    "https://library.example.test/librarian/telegram?target=home");
  assert.equal(dualMessage.reply_markup.inline_keyboard[12][0].callback_data, "telegram-notifications:off");
  assert.equal(dualMenuButton.menu_button.type, "web_app");
  teacher.sqlite.close();
  librarian.sqlite.close();
  dualRole.sqlite.close();
});

test("connected menus preserve ordinary-link fallbacks when Telegram Mini App is disabled", async () => {
  const previousMiniAppFlag = globalThis.__TELEGRAM_TEST_ENV.TELEGRAM_MINI_APP_ENABLED;
  let teacher = null;
  let librarian = null;
  globalThis.__TELEGRAM_TEST_ENV.TELEGRAM_MINI_APP_ENABLED = "false";
  try {
    teacher = await database();
    addTeacherCredential(teacher);
    teacher.sqlite.prepare(`INSERT INTO telegram_connections (
      user_id,telegram_user_id,chat_id,username,status,notify_orders,notify_visits,version,
      linked_at,disabled_at,created_at,updated_at
    ) VALUES ('USR-TEACHER','7051','7051',NULL,'active',1,1,1,?,NULL,?,?)`)
      .run(teacher.now, teacher.now, teacher.now);
    const teacherBodies = [];
    const teacherPayload = {
      update_id: 7051,
      message: { text: "/menu", chat: { id: 7051, type: "private" }, from: { id: 7051 } },
    };
    assert.deepEqual(await telegram.processTelegramWebhookUpdate(
      teacher.db,
      JSON.stringify(teacherPayload),
      teacherPayload,
      async (_url, init) => { teacherBodies.push(JSON.parse(init.body)); return telegramOk(57); },
      "https://library.example.test",
    ), { outcome: "menu", duplicate: false });
    const teacherMenu = teacherBodies.find((body) => body.text).reply_markup.inline_keyboard;
    assert.equal(teacherMenu[1][0].text, "📚 Каталог");
    assert.equal(teacherMenu[1][0].url, "https://nazarijshvetz1.github.io/library-site/");
    assert.equal(teacherMenu[1][0].web_app, undefined);
    assert.equal(teacherMenu[2][0].text, "🛒 Замовлення");
    assert.equal(teacherMenu[2][0].url, "https://library.example.test/teacher?tab=orders");

    librarian = await database();
    librarian.sqlite.prepare(`INSERT INTO telegram_connections (
      user_id,telegram_user_id,chat_id,username,status,notify_orders,notify_visits,version,
      linked_at,disabled_at,created_at,updated_at
    ) VALUES ('USR-LIB','8051','8051',NULL,'active',1,1,1,?,NULL,?,?)`)
      .run(librarian.now, librarian.now, librarian.now);
    const librarianBodies = [];
    const librarianPayload = {
      update_id: 8051,
      message: { text: "/menu", chat: { id: 8051, type: "private" }, from: { id: 8051 } },
    };
    assert.deepEqual(await telegram.processTelegramWebhookUpdate(
      librarian.db,
      JSON.stringify(librarianPayload),
      librarianPayload,
      async (_url, init) => { librarianBodies.push(JSON.parse(init.body)); return telegramOk(59); },
      "https://library.example.test",
    ), { outcome: "menu", duplicate: false });
    const librarianMenu = librarianBodies.find((body) => body.text).reply_markup.inline_keyboard;
    assert.equal(librarianMenu[0][0].text, "🆕 Замовлення вчителів");
    assert.equal(librarianMenu[0][0].url, "https://library.example.test/librarian/orders");
    assert.equal(librarianMenu[0][0].web_app, undefined);
  } finally {
    globalThis.__TELEGRAM_TEST_ENV.TELEGRAM_MINI_APP_ENABLED = previousMiniAppFlag;
    teacher?.sqlite.close();
    librarian?.sqlite.close();
  }
});

test("bare start restores recoverable Telegram connections but respects explicit disconnects", async () => {
  for (const scenario of [
    { id: "7101", status: "blocked", explicitDisconnect: false },
    { id: "7102", status: "disabled", explicitDisconnect: false },
  ]) {
    const context = await database();
    addTeacherCredential(context);
    context.sqlite.prepare(`INSERT INTO telegram_connections (
      user_id,telegram_user_id,chat_id,username,status,notify_orders,notify_visits,version,
      linked_at,disabled_at,last_error_code,created_at,updated_at
    ) VALUES ('USR-TEACHER',?,?,NULL,?,1,1,2,?,?,?, ?,?)`)
      .run(scenario.id, scenario.id, scenario.status, context.now, context.now,
        scenario.status === "blocked" ? "telegram_blocked" : null, context.now, context.now);
    const payload = {
      update_id: Number(scenario.id),
      message: { text: "/start", chat: { id: Number(scenario.id), type: "private" }, from: { id: Number(scenario.id) } },
    };
    const bodies = [];
    assert.deepEqual(await telegram.processTelegramWebhookUpdate(
      context.db,
      JSON.stringify(payload),
      payload,
      async (_url, init) => { bodies.push(JSON.parse(init.body)); return telegramOk(71); },
      "https://library.example.test",
    ), { outcome: "menu", duplicate: false });
    assert.equal(context.sqlite.prepare("SELECT status FROM telegram_connections WHERE user_id='USR-TEACHER'").get().status, "active");
    assert.equal(context.sqlite.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='telegram.connection.resume'").get().n, 1);
    assert.equal(bodies.find((body) => body.text).reply_markup.inline_keyboard.length, 8);
    context.sqlite.close();
  }

  const disconnected = await database();
  addTeacherCredential(disconnected);
  disconnected.sqlite.prepare(`INSERT INTO telegram_connections (
    user_id,telegram_user_id,chat_id,username,status,notify_orders,notify_visits,version,
    linked_at,disabled_at,created_at,updated_at
  ) VALUES ('USR-TEACHER','7103','7103',NULL,'disabled',1,1,2,?,?,?,?)`)
    .run(disconnected.now, disconnected.now, disconnected.now, disconnected.now);
  disconnected.sqlite.prepare(`INSERT INTO audit_events (
    id,actor_user_id,actor_email,action,entity_type,entity_id,request_id,created_at
  ) VALUES ('AUD-explicit-disconnect','USR-TEACHER','telegram-user@local.invalid',
    'telegram.connection.disconnect','telegram_connection','USR-TEACHER',NULL,?)`)
    .run(disconnected.now);
  const payload = {
    update_id: 7103,
    message: { text: "/start", chat: { id: 7103, type: "private" }, from: { id: 7103 } },
  };
  const bodies = [];
  assert.deepEqual(await telegram.processTelegramWebhookUpdate(
    disconnected.db,
    JSON.stringify(payload),
    payload,
    async (_url, init) => { bodies.push(JSON.parse(init.body)); return telegramOk(72); },
    "https://library.example.test",
  ), { outcome: "activation_started", duplicate: false });
  assert.equal(disconnected.sqlite.prepare("SELECT status FROM telegram_connections WHERE user_id='USR-TEACHER'").get().status, "disabled");
  assert.equal(bodies.find((body) => body.text).reply_markup.inline_keyboard[0][0].text, "🔑 Увійти");
  disconnected.sqlite.close();
});

test("verified Mini App login refreshes only the exact connected teacher menu", async () => {
  const context = await database();
  addTeacherCredential(context);
  context.sqlite.prepare(`INSERT INTO telegram_connections (
    user_id,telegram_user_id,chat_id,username,status,notify_orders,notify_visits,version,
    linked_at,disabled_at,created_at,updated_at
  ) VALUES ('USR-TEACHER','7201','7201',NULL,'active',1,1,3,?,NULL,?,?)`)
    .run(context.now, context.now, context.now);

  const requests = [];
  const refreshed = await telegram.refreshConnectedTeacherTelegramMenu(
    context.db,
    {
      teacherUserId: "USR-TEACHER",
      telegramUserId: "7201",
      siteOrigin: "https://library.example.test",
    },
    async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return telegramOk(73);
    },
  );
  assert.equal(refreshed, true);
  const message = requests.find(({ url }) => url.endsWith("/sendMessage")).body;
  const menuButton = requests.find(({ url }) => url.endsWith("/setChatMenuButton")).body;
  assert.match(message.text, /Telegram підключено до профілю/u);
  assert.equal(message.reply_markup.inline_keyboard.length, 8);
  assert.equal(message.reply_markup.inline_keyboard[0][0].web_app.url,
    "https://library.example.test/teacher/telegram?tab=overview");
  assert.equal(message.reply_markup.inline_keyboard[1][0].web_app.url,
    "https://nazarijshvetz1.github.io/library-site/");
  assert.equal(message.reply_markup.inline_keyboard[2][0].web_app.url,
    "https://library.example.test/teacher/telegram?tab=orders");
  assert.equal(message.reply_markup.inline_keyboard[7][0].callback_data, "telegram-notifications:off");
  assert.equal(menuButton.chat_id, 7201);
  assert.equal(menuButton.menu_button.web_app.url,
    "https://library.example.test/teacher/telegram?tab=overview");

  const beforeMismatch = requests.length;
  assert.equal(await telegram.refreshConnectedTeacherTelegramMenu(
    context.db,
    {
      teacherUserId: "USR-TEACHER",
      telegramUserId: "7202",
      siteOrigin: "https://library.example.test",
    },
    async () => { throw new Error("must not send"); },
  ), false);
  assert.equal(requests.length, beforeMismatch);

  const sessionRefreshRequests = [];
  assert.equal(await telegram.refreshConnectedTeacherTelegramMenu(
    context.db,
    {
      teacherUserId: "USR-TEACHER",
      siteOrigin: "https://library.example.test",
    },
    async (url, init) => {
      sessionRefreshRequests.push({ url: String(url), body: JSON.parse(init.body) });
      if (String(url).endsWith("/setChatMenuButton")) {
        return new Response(JSON.stringify({ ok: false, description: "button unavailable" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return telegramOk(74);
    },
  ), true, "the rich inline menu controls chat return even if the persistent button fails");
  assert.equal(sessionRefreshRequests.some(({ url }) => url.endsWith("/sendMessage")), true);
  assert.equal(sessionRefreshRequests.some(({ url }) => url.endsWith("/setChatMenuButton")), true);

  assert.equal(await telegram.refreshConnectedTeacherTelegramMenu(
    context.db,
    {
      teacherUserId: "USR-TEACHER",
      telegramUserId: "7201",
      siteOrigin: "https://library.example.test",
    },
    async () => new Response(JSON.stringify({ ok: false, description: "temporary failure" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    }),
  ), false);
  assert.equal(context.sqlite.prepare("SELECT status FROM telegram_connections WHERE user_id='USR-TEACHER'").get().status,
    "active");
  context.sqlite.close();
});

test("one Telegram button toggles all notifications without disconnecting the profile", async () => {
  const context = await database();
  addTeacherCredential(context);
  context.sqlite.prepare(`INSERT INTO telegram_connections (
    user_id,telegram_user_id,chat_id,username,status,notify_orders,notify_visits,version,
    linked_at,disabled_at,created_at,updated_at
  ) VALUES ('USR-TEACHER','7301','7301',NULL,'active',1,0,4,?,NULL,?,?)`)
    .run(context.now, context.now, context.now);
  const requests = [];
  const callbackOff = {
    update_id: 198,
    callback_query: {
      id: "callback-off-198",
      from: { id: 7301 },
      data: "telegram-notifications:off",
      message: { message_id: 81, chat: { id: 7301, type: "private" } },
    },
  };
  assert.deepEqual(await telegram.processTelegramWebhookUpdate(
    context.db,
    JSON.stringify(callbackOff),
    callbackOff,
    async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return telegramOk(81);
    },
    "https://library.example.test",
  ), { outcome: "notifications_disabled", duplicate: false });
  assert.deepEqual(
    { ...context.sqlite.prepare(`SELECT status,notify_orders,notify_visits,version
      FROM telegram_connections WHERE user_id='USR-TEACHER'`).get() },
    { status: "active", notify_orders: 0, notify_visits: 0, version: 5 },
  );
  assert.match(requests[0].url, /\/answerCallbackQuery$/u);
  assert.match(requests[1].url, /\/editMessageText$/u);
  assert.match(requests[1].body.text, /вимкнено/u);
  assert.equal(requests[1].body.reply_markup.inline_keyboard.at(-1)[0].callback_data,
    "telegram-notifications:on");
  const beforeReplay = requests.length;
  assert.deepEqual(await telegram.processTelegramWebhookUpdate(
    context.db,
    JSON.stringify(callbackOff),
    callbackOff,
    async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return telegramOk(82);
    },
    "https://library.example.test",
  ), { outcome: "notifications_disabled", duplicate: true });
  assert.equal(requests.length, beforeReplay + 1);
  assert.match(requests.at(-1).url, /\/answerCallbackQuery$/u);
  assert.equal(requests.at(-1).body.callback_query_id, "callback-off-198");

  const callbackOn = {
    update_id: 199,
    callback_query: {
      id: "callback-on-199",
      from: { id: 7301 },
      data: "telegram-notifications:on",
      message: { message_id: 81, chat: { id: 7301, type: "private" } },
    },
  };
  assert.deepEqual(await telegram.processTelegramWebhookUpdate(
    context.db,
    JSON.stringify(callbackOn),
    callbackOn,
    async () => telegramOk(83),
    "https://library.example.test",
  ), { outcome: "notifications_enabled", duplicate: false });
  assert.deepEqual(
    { ...context.sqlite.prepare(`SELECT status,notify_orders,notify_visits,version
      FROM telegram_connections WHERE user_id='USR-TEACHER'`).get() },
    { status: "active", notify_orders: 1, notify_visits: 1, version: 6 },
  );
  context.sqlite.close();
});

test("disconnect command only opens confirmed cabinet settings", async () => {
  const context = await database();
  addTeacherCredential(context);
  context.sqlite.prepare(`INSERT INTO telegram_connections (
    user_id,telegram_user_id,chat_id,username,status,notify_orders,notify_visits,version,
    linked_at,disabled_at,created_at,updated_at
  ) VALUES ('USR-TEACHER','7401','7401',NULL,'active',1,1,1,?,NULL,?,?)`)
    .run(context.now, context.now, context.now);
  const payload = {
    update_id: 201,
    message: { text: "/disconnect", chat: { id: 7401, type: "private" }, from: { id: 7401 } },
  };
  const bodies = [];
  assert.deepEqual(await telegram.processTelegramWebhookUpdate(
    context.db,
    JSON.stringify(payload),
    payload,
    async (_url, init) => { bodies.push(JSON.parse(init.body)); return telegramOk(84); },
    "https://library.example.test",
  ), { outcome: "disconnect_help", duplicate: false });
  assert.equal(context.sqlite.prepare(`SELECT status FROM telegram_connections
    WHERE user_id='USR-TEACHER'`).get().status, "active");
  const refresh = bodies.find((body) => Array.isArray(body.allowed_updates));
  const guidance = bodies.find((body) => typeof body.text === "string");
  assert.deepEqual(refresh.allowed_updates, ["message", "callback_query"]);
  assert.match(guidance.text, /потребує підтвердження/u);
  assert.equal(guidance.reply_markup.inline_keyboard[0][0].web_app.url,
    "https://library.example.test/teacher/telegram?tab=notifications");
  context.sqlite.close();
});

test("webhook registration pins the canonical origin and publishes fallback plus Ukrainian commands", async () => {
  const requests = [];
  await telegram.registerTelegramWebhook(
    "https://preview.example.test",
    async (url, init) => { requests.push({ url: String(url), body: JSON.parse(init.body) }); return telegramOk(60); },
  );
  assert.equal(requests.length, 3);
  assert.match(requests[0].url, /\/setWebhook$/u);
  assert.equal(requests[0].body.url, "https://library.example.test/api/telegram/webhook");
  assert.equal(requests[0].body.secret_token, "test_webhook_secret_123456789");
  assert.deepEqual(requests[0].body.allowed_updates, ["message", "callback_query"]);
  assert.match(requests[1].url, /\/setMyCommands$/u);
  assert.equal(requests[1].body.language_code, undefined);
  assert.deepEqual(requests[1].body.commands.map(({ command }) => command),
    ["start", "menu", "notifications", "stop", "disconnect"]);
  assert.equal(requests[2].body.language_code, "uk");
});

test("ordinary webhook registration keeps command hints best-effort", async () => {
  const requests = [];
  await telegram.registerTelegramWebhook(
    "https://preview.example.test",
    async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      if (String(url).endsWith("/setMyCommands")) {
        return new Response(JSON.stringify({ ok: false, error_code: 429, description: "Retry later" }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      }
      return telegramOk(63);
    },
  );
  assert.equal(requests.length, 3);
  assert.match(requests[0].url, /\/setWebhook$/u);
  assert.match(requests[1].url, /\/setMyCommands$/u);
  assert.match(requests[2].url, /\/setMyCommands$/u);
});

test("test message refreshes webhook and commands before outbound delivery", async () => {
  const context = await database();
  context.sqlite.prepare(`INSERT INTO telegram_connections (
    user_id,telegram_user_id,chat_id,username,status,notify_orders,notify_visits,version,
    linked_at,disabled_at,created_at,updated_at
  ) VALUES ('USR-LIB','8001','8001',NULL,'active',1,1,1,?,NULL,?,?)`)
    .run(context.now, context.now, context.now);
  const requests = [];
  await telegram.repairTelegramWebhookAndSendTestMessage(
    context.db,
    "USR-LIB",
    "https://preview.example.test",
    "/librarian/teachers",
    async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return telegramOk(62);
    },
  );
  assert.equal(requests.length, 4);
  assert.match(requests[0].url, /\/setWebhook$/u);
  assert.equal(requests[0].body.url, "https://library.example.test/api/telegram/webhook");
  assert.match(requests[1].url, /\/setMyCommands$/u);
  assert.equal(requests[1].body.language_code, undefined);
  assert.equal(requests[2].body.language_code, "uk");
  assert.match(requests[3].url, /\/sendMessage$/u);
  assert.equal(requests[3].body.chat_id, "8001");
  assert.equal(
    requests[3].body.reply_markup.inline_keyboard[0][0].url,
    "https://library.example.test/librarian/teachers",
  );
  context.sqlite.close();
});

test("test message is not sent when webhook refresh fails", async () => {
  const context = await database();
  context.sqlite.prepare(`INSERT INTO telegram_connections (
    user_id,telegram_user_id,chat_id,username,status,notify_orders,notify_visits,version,
    linked_at,disabled_at,created_at,updated_at
  ) VALUES ('USR-LIB','8001','8001',NULL,'active',1,1,1,?,NULL,?,?)`)
    .run(context.now, context.now, context.now);
  const requests = [];
  await assert.rejects(() => telegram.repairTelegramWebhookAndSendTestMessage(
    context.db,
    "USR-LIB",
    "https://preview.example.test",
    "/librarian/teachers",
    async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    },
  ));
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/setWebhook$/u);
  context.sqlite.close();
});

test("repair fails closed when either command menu cannot be refreshed", async () => {
  for (const failedRequestIndex of [1, 2]) {
    const context = await database();
    context.sqlite.prepare(`INSERT INTO telegram_connections (
      user_id,telegram_user_id,chat_id,username,status,notify_orders,notify_visits,version,
      linked_at,disabled_at,created_at,updated_at
    ) VALUES ('USR-LIB','8001','8001',NULL,'active',1,1,1,?,NULL,?,?)`)
      .run(context.now, context.now, context.now);
    const requests = [];
    await assert.rejects(() => telegram.repairTelegramWebhookAndSendTestMessage(
      context.db,
      "USR-LIB",
      "https://preview.example.test",
      "/librarian/teachers",
      async (url, init) => {
        const requestIndex = requests.length;
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        if (requestIndex === failedRequestIndex) {
          return new Response(JSON.stringify({ ok: false, error_code: 429, description: "Retry later" }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          });
        }
        return telegramOk(64);
      },
    ));
    assert.equal(requests.some(({ url }) => url.endsWith("/sendMessage")), false);
    assert.equal(requests.length, failedRequestIndex + 1);
    context.sqlite.close();
  }
});

test("site disconnect disables the connection and resets the private chat menu", async () => {
  const context = await database();
  addTeacherCredential(context);
  context.sqlite.prepare(`INSERT INTO telegram_connections (
    user_id,telegram_user_id,chat_id,username,status,notify_orders,notify_visits,version,
    linked_at,disabled_at,created_at,updated_at
  ) VALUES ('USR-TEACHER','7001','7001',NULL,'active',1,1,4,?,NULL,?,?)`)
    .run(context.now, context.now, context.now);
  context.sqlite.prepare(`INSERT INTO visit_teacher_sessions (
    token_hash,teacher_user_id,credential_version,pending_scope,ip_scope_hash,
    expires_at,last_seen_at,revoked_at,created_at
  ) VALUES (?,'USR-TEACHER',1,'pending-site-disconnect',?,
    '2026-08-23T10:00:00.000Z',?,NULL,?)`)
    .run("5".repeat(64), "6".repeat(64), context.now, context.now);
  context.sqlite.prepare(`INSERT INTO telegram_link_tokens (
    id,user_id,token_hash,expires_at,consumed_at,consumed_update_id,revoked_at,created_at
  ) VALUES ('TGL-site-disconnect','USR-TEACHER',?,'2026-08-23T10:00:00.000Z',NULL,NULL,NULL,?)`)
    .run("7".repeat(64), context.now);
  context.sqlite.prepare(`INSERT INTO telegram_teacher_activation_invites (
    id,kind,teacher_user_id,credential_version,token_hash,issued_by_user_id,request_id,
    bound_telegram_user_id,bound_chat_id,bound_username,bound_update_id,presented_at,
    expires_at,consumed_init_data_hash,consumed_at,revoked_at,created_at,updated_at
  ) VALUES ('TGA-site-personal','personal','USR-TEACHER',1,?,'USR-LIB',?,
    NULL,NULL,NULL,NULL,NULL,'2026-08-23T10:00:00.000Z',NULL,NULL,NULL,?,?)`)
    .run("8".repeat(64), crypto.randomUUID(), context.now, context.now);
  context.sqlite.prepare(`INSERT INTO telegram_teacher_activation_invites (
    id,kind,teacher_user_id,credential_version,token_hash,issued_by_user_id,request_id,
    bound_telegram_user_id,bound_chat_id,bound_username,bound_update_id,presented_at,
    expires_at,consumed_init_data_hash,consumed_at,revoked_at,created_at,updated_at
  ) VALUES ('TGA-site-generic','generic',NULL,NULL,NULL,NULL,NULL,
    '7001','7001',NULL,'site-disconnect-update',?,'2026-08-23T10:00:00.000Z',
    NULL,NULL,NULL,?,?)`).run(context.now, context.now, context.now);
  context.sqlite.prepare(`INSERT INTO telegram_delivery_outbox (
    id,recipient_user_id,dedupe_key,category,type,title,message,target_path,
    entity_type,entity_id,status,attempts,next_attempt_at,lease_token,lease_expires_at,
    created_at,updated_at
  ) VALUES ('TGO-site-disconnect','USR-TEACHER','site-disconnect:pending','system',
    'system_notice','Старе повідомлення','Не доставляти після повторного входу',
    '/teacher?tab=notifications','user','USR-TEACHER','processing',1,?,
    'lease-before-disconnect','2026-08-23T10:00:00.000Z',?,?)`)
    .run(context.now, context.now, context.now);
  const requests = [];
  const status = await telegram.disconnectTelegram(
    context.db,
    "USR-TEACHER",
    4,
    async (url, init) => { requests.push({ url: String(url), body: JSON.parse(init.body) }); return telegramOk(61); },
  );
  assert.equal(status.status, "disabled");
  assert.equal(status.version, 5);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/setChatMenuButton$/u);
  assert.equal(requests[0].body.chat_id, 7001);
  assert.deepEqual(requests[0].body.menu_button, { type: "commands" });
  assert.ok(context.sqlite.prepare(`SELECT revoked_at FROM visit_teacher_sessions
    WHERE token_hash=?`).get("5".repeat(64)).revoked_at);
  assert.ok(context.sqlite.prepare(`SELECT revoked_at FROM telegram_link_tokens
    WHERE id='TGL-site-disconnect'`).get().revoked_at);
  assert.ok(context.sqlite.prepare(`SELECT revoked_at FROM telegram_teacher_activation_invites
    WHERE id='TGA-site-personal'`).get().revoked_at);
  assert.ok(context.sqlite.prepare(`SELECT revoked_at FROM telegram_teacher_activation_invites
    WHERE id='TGA-site-generic'`).get().revoked_at);
  assert.deepEqual(
    { ...context.sqlite.prepare(`SELECT status,last_error_code FROM telegram_delivery_outbox
      WHERE id='TGO-site-disconnect'`).get() },
    { status: "dead", last_error_code: "telegram_disconnected" },
  );
  context.sqlite.prepare(`UPDATE telegram_connections SET
    telegram_user_id='7002',chat_id='7002',status='active',notify_orders=1,notify_visits=1,
    disabled_at=NULL,version=6,updated_at=? WHERE user_id='USR-TEACHER'`).run(context.now);
  let deliveryFetches = 0;
  assert.deepEqual(await telegram.drainTelegramOutbox(context.db, {
    siteOrigin: "https://library.example.test",
    now: new Date(context.now),
    fetcher: async () => { deliveryFetches += 1; return telegramOk(62); },
  }), { attempted: 0, sent: 0, failed: 0 });
  assert.equal(deliveryFetches, 0);
  context.sqlite.close();
});

async function queuedLibrarianContext() {
  const context = await database();
  context.sqlite.prepare(`INSERT INTO telegram_connections (
    user_id,telegram_user_id,chat_id,username,status,notify_orders,notify_visits,version,
    linked_at,disabled_at,created_at,updated_at
  ) VALUES ('USR-LIB','8001','8001',NULL,'active',1,1,1,?,NULL,?,?)`)
    .run(context.now, context.now, context.now);
  context.sqlite.prepare(`INSERT INTO audit_events (
    id,actor_user_id,actor_email,action,entity_type,entity_id,request_id,after_json,created_at
  ) VALUES ('AUD-TG','USR-LIB','library@example.test','visit.booking.create',
    'visit_booking','VIS-1','REQ-1','{}',?)`).run(context.now);
  await context.db.batch([outbox.queueTelegramForLibrariansStatement(context.db, {
    dedupeKey: "visit:VIS-1:created:REQ-1",
    auditRequestId: "REQ-1",
    category: "visits",
    type: "visit_booking_created",
    title: "Новий запис",
    message: "Шевченко Олена: 2026-08-25, 10:00–11:00.",
    targetPath: "/librarian/visits",
    entityType: "visit_booking",
    entityId: "VIS-1",
    createdAt: context.now,
  })]);
  return context;
}

test("audited outbox event is deduplicated and delivered with a safe site link", async () => {
  const context = await queuedLibrarianContext();
  assert.equal(context.sqlite.prepare("SELECT count(*) AS count FROM telegram_delivery_outbox").get().count, 1);
  let requestBody = null;
  const result = await telegram.drainTelegramOutbox(context.db, {
    siteOrigin: "https://library.example.test",
    now: new Date(context.now),
    fetcher: async (_url, init) => { requestBody = JSON.parse(init.body); return telegramOk(44); },
  });
  assert.deepEqual(result, { attempted: 1, sent: 1, failed: 0 });
  assert.equal(context.sqlite.prepare("SELECT status FROM telegram_delivery_outbox").get().status, "sent");
  assert.equal(requestBody.chat_id, "8001");
  assert.equal(requestBody.reply_markup.inline_keyboard[0][0].url, "https://library.example.test/librarian/visits");
  context.sqlite.close();
});

test("master mute cancels queued delivery and blocks new system events until enabled", async () => {
  const context = await queuedLibrarianContext();
  context.sqlite.prepare(`UPDATE telegram_delivery_outbox SET status='processing',attempts=1,
    lease_token='lease-before-mute',lease_expires_at='2026-08-23T10:00:00.000Z'
    WHERE recipient_user_id='USR-LIB'`).run();
  const muted = await telegram.updateTelegramPreferences(context.db, "USR-LIB", {
    notifyOrders: false,
    notifyVisits: false,
    expectedVersion: 1,
  });
  assert.equal(muted.connected, true);
  assert.equal(muted.version, 2);
  assert.equal(muted.notifyOrders, false);
  assert.equal(muted.notifyVisits, false);
  assert.deepEqual(
    { ...context.sqlite.prepare(`SELECT status,last_error_code FROM telegram_delivery_outbox`).get() },
    { status: "dead", last_error_code: "notifications_disabled" },
  );
  let fetches = 0;
  assert.deepEqual(await telegram.drainTelegramOutbox(context.db, {
    siteOrigin: "https://library.example.test",
    now: new Date(context.now),
    fetcher: async () => { fetches += 1; return telegramOk(45); },
  }), { attempted: 0, sent: 0, failed: 0 });
  assert.equal(fetches, 0);
  await context.db.batch([outbox.queueTelegramForLibrariansStatement(context.db, {
    dedupeKey: "system:VIS-1:muted",
    auditRequestId: "REQ-1",
    category: "system",
    type: "system_notice",
    title: "Системне повідомлення",
    message: "Це повідомлення не має бути поставлене в чергу.",
    targetPath: "/librarian",
    entityType: "visit_booking",
    entityId: "VIS-1",
    createdAt: context.now,
  })]);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_delivery_outbox").get().n, 1);

  const enabled = await telegram.updateTelegramPreferences(context.db, "USR-LIB", {
    notifyOrders: true,
    notifyVisits: true,
    expectedVersion: 2,
  });
  assert.equal(enabled.version, 3);
  await context.db.batch([outbox.queueTelegramForLibrariansStatement(context.db, {
    dedupeKey: "system:VIS-1:enabled",
    auditRequestId: "REQ-1",
    category: "system",
    type: "system_notice",
    title: "Системне повідомлення",
    message: "Нове повідомлення після ввімкнення.",
    targetPath: "/librarian",
    entityType: "visit_booking",
    entityId: "VIS-1",
    createdAt: context.now,
  })]);
  assert.equal(context.sqlite.prepare(`SELECT COUNT(*) AS n FROM telegram_delivery_outbox
    WHERE status='pending'`).get().n, 1);
  assert.deepEqual(await telegram.drainTelegramOutbox(context.db, {
    siteOrigin: "https://library.example.test",
    now: new Date(context.now),
    fetcher: async () => { fetches += 1; return telegramOk(46); },
  }), { attempted: 1, sent: 1, failed: 0 });
  assert.equal(fetches, 1);
  context.sqlite.close();
});

test("stale opposite master toggle is rejected instead of reporting a false success", async () => {
  const context = await queuedLibrarianContext();
  await telegram.updateTelegramPreferences(context.db, "USR-LIB", {
    notifyOrders: false,
    notifyVisits: false,
    expectedVersion: 1,
  });
  await assert.rejects(
    () => telegram.updateTelegramPreferences(context.db, "USR-LIB", {
      notifyOrders: true,
      notifyVisits: true,
      expectedVersion: 1,
    }),
    (error) => error.code === "connection_version_conflict" && error.status === 409,
  );
  assert.deepEqual(
    { ...context.sqlite.prepare(`SELECT notify_orders,notify_visits,version
      FROM telegram_connections WHERE user_id='USR-LIB'`).get() },
    { notify_orders: 0, notify_visits: 0, version: 2 },
  );
  context.sqlite.close();
});

test("delivery claim refuses a stale chat snapshot after Telegram is rebound", async () => {
  const context = await queuedLibrarianContext();
  const originalBatch = context.db.batch.bind(context.db);
  let rebound = false;
  context.db.batch = async (statements) => {
    if (!rebound && statements.some((statement) => statement.sql.includes("SET status='processing'"))) {
      rebound = true;
      context.sqlite.prepare(`UPDATE telegram_connections SET
        telegram_user_id='8002',chat_id='8002',version=version+1,updated_at=?
        WHERE user_id='USR-LIB'`).run(context.now);
    }
    return originalBatch(statements);
  };
  let fetches = 0;
  assert.deepEqual(await telegram.drainTelegramOutbox(context.db, {
    siteOrigin: "https://library.example.test",
    now: new Date(context.now),
    fetcher: async () => { fetches += 1; return telegramOk(47); },
  }), { attempted: 0, sent: 0, failed: 0 });
  assert.equal(rebound, true);
  assert.equal(fetches, 0);
  assert.equal(context.sqlite.prepare("SELECT status FROM telegram_delivery_outbox").get().status, "pending");
  context.sqlite.close();
});

test("429 is retried and 403 blocks the connection without losing the event", async () => {
  const rateLimited = await queuedLibrarianContext();
  const retry = await telegram.drainTelegramOutbox(rateLimited.db, {
    siteOrigin: "https://library.example.test",
    now: new Date(rateLimited.now),
    fetcher: async () => new Response(JSON.stringify({ ok: false, description: "Too Many Requests", parameters: { retry_after: 30 } }), {
      status: 429, headers: { "Content-Type": "application/json" },
    }),
  });
  assert.deepEqual(retry, { attempted: 1, sent: 0, failed: 1 });
  const retryRow = rateLimited.sqlite.prepare("SELECT status,attempts,next_attempt_at FROM telegram_delivery_outbox").get();
  assert.equal(retryRow.status, "retry");
  assert.equal(retryRow.attempts, 1);
  assert.equal(retryRow.next_attempt_at, "2026-08-22T10:00:30.000Z");
  rateLimited.sqlite.close();

  const blocked = await queuedLibrarianContext();
  const dead = await telegram.drainTelegramOutbox(blocked.db, {
    siteOrigin: "https://library.example.test",
    now: new Date(blocked.now),
    fetcher: async () => new Response(JSON.stringify({ ok: false, description: "bot was blocked" }), {
      status: 403, headers: { "Content-Type": "application/json" },
    }),
  });
  assert.deepEqual(dead, { attempted: 1, sent: 0, failed: 1 });
  assert.equal(blocked.sqlite.prepare("SELECT status FROM telegram_delivery_outbox").get().status, "dead");
  assert.equal(blocked.sqlite.prepare("SELECT status FROM telegram_connections").get().status, "blocked");
  blocked.sqlite.close();
});

test("disabled delivery fails closed without a Telegram request", async () => {
  const context = await queuedLibrarianContext();
  globalThis.__TELEGRAM_TEST_ENV.TELEGRAM_NOTIFICATIONS_ENABLED = "false";
  let fetches = 0;
  const result = await telegram.drainTelegramOutbox(context.db, {
    siteOrigin: "https://library.example.test",
    now: new Date(context.now),
    fetcher: async () => { fetches += 1; return telegramOk(); },
  });
  assert.deepEqual(result, { attempted: 0, sent: 0, failed: 0 });
  assert.equal(fetches, 0);
  assert.equal(context.sqlite.prepare("SELECT status FROM telegram_delivery_outbox").get().status, "pending");
  globalThis.__TELEGRAM_TEST_ENV.TELEGRAM_NOTIFICATIONS_ENABLED = "true";
  context.sqlite.close();
});
