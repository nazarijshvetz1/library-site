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

test("connected private chats receive role-aware menus and teacher Mini App buttons", async () => {
  const teacher = await database();
  teacher.sqlite.prepare(`INSERT INTO telegram_connections (
    user_id,telegram_user_id,chat_id,username,status,notify_orders,notify_visits,version,
    linked_at,disabled_at,created_at,updated_at
  ) VALUES ('USR-TEACHER','7001','7001',NULL,'active',1,1,1,?,NULL,?,?)`)
    .run(teacher.now, teacher.now, teacher.now);
  const teacherPayload = {
    update_id: 93,
    message: { text: "/menu", chat: { id: 7001, type: "private" }, from: { id: 7001 } },
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
  assert.equal(teacherMessage.reply_markup.inline_keyboard.length, 4);
  assert.deepEqual(
    teacherMessage.reply_markup.inline_keyboard.map((row) => row[0].web_app.url),
    [
      "https://library.example.test/teacher/telegram?tab=orders",
      "https://library.example.test/teacher/telegram?tab=visits",
      "https://library.example.test/teacher/telegram?tab=loans",
      "https://library.example.test/teacher/telegram?tab=notifications",
    ],
  );
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
  await telegram.processTelegramWebhookUpdate(
    teacher.db,
    JSON.stringify(stopPayload),
    stopPayload,
    async (_url, init) => { teacherBodies.push(JSON.parse(init.body)); return telegramOk(54); },
    "https://library.example.test",
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
  ), { outcome: "menu_unlinked", duplicate: false });
  assert.equal(unlinkedBodies[0].reply_markup, undefined);

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
  assert.equal(librarianMessage.reply_markup.inline_keyboard[0][0].url,
    "https://library.example.test/librarian/visits#request-inbox-title");
  assert.equal(librarianMessage.reply_markup.inline_keyboard.some((row) => row[0].web_app), false);

  const dualRole = await database();
  dualRole.sqlite.prepare(`INSERT INTO users
    (id,full_name,sort_name,email,auth_user_id,role,status,created_at,updated_at)
    VALUES ('USR-006','Галака Наталія Григорівна','галака наталія григорівна',NULL,NULL,'admin','active',?,?)`)
    .run(dualRole.now, dualRole.now);
  dualRole.sqlite.prepare(`INSERT INTO teacher_profiles (teacher_user_id,created_at,updated_at) VALUES ('USR-006',?,?)`)
    .run(dualRole.now, dualRole.now);
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
  assert.equal(dualMessage.reply_markup.inline_keyboard.length, 8);
  assert.equal(dualMessage.reply_markup.inline_keyboard[0][0].web_app.url,
    "https://library.example.test/teacher/telegram?tab=orders");
  assert.equal(dualMessage.reply_markup.inline_keyboard[7][0].url,
    "https://library.example.test/librarian");
  assert.equal(dualMenuButton.menu_button.type, "web_app");
  teacher.sqlite.close();
  librarian.sqlite.close();
  dualRole.sqlite.close();
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
  assert.deepEqual(requests[0].body.allowed_updates, ["message"]);
  assert.match(requests[1].url, /\/setMyCommands$/u);
  assert.equal(requests[1].body.language_code, undefined);
  assert.deepEqual(requests[1].body.commands.map(({ command }) => command), ["start", "menu", "stop"]);
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
  context.sqlite.prepare(`INSERT INTO telegram_connections (
    user_id,telegram_user_id,chat_id,username,status,notify_orders,notify_visits,version,
    linked_at,disabled_at,created_at,updated_at
  ) VALUES ('USR-TEACHER','7001','7001',NULL,'active',1,1,4,?,NULL,?,?)`)
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
