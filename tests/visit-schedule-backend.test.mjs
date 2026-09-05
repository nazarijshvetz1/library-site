import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const validation = await import("../lib/visit-schedule-validation.ts");
const portalValidation = await import("../lib/visit-portal-validation.ts");
const store = await import("../lib/visit-schedule-store.ts");
const assistantStore = await import("../lib/assistant-store.ts");
const assistantConsent = await import("../lib/assistant-consent.ts");
// Existing session tests begin with an explicitly consenting fixture user.
const assistant = { ...assistantStore, async createAssistantSession(db, actor, ...args) {
  const consent = await assistantConsent.readAssistantConsent(db, actor);
  if (!consent.accepted) await assistantConsent.acceptAssistantConsent(db, actor, consent.version, consent.revision);
  return assistantStore.createAssistantSession(db, actor, ...args);
} };
const assistantLibrary = await import("../lib/assistant-library.ts");
const assistantContract = await import("../lib/assistant-contract.ts");

test("assistant consent is durable, owner-scoped, versioned and costs no session quota", async () => {
  const { db, sqlite } = await visitDatabase();
  const actor = "librarian:consent-test";
  const initial = await assistantConsent.readAssistantConsent(db, actor);
  assert.equal(initial.accepted, false);
  await assert.rejects(assistantStore.createAssistantSession(db, actor, null), { code: "ai_consent_required" });
  const saved = await assistantConsent.acceptAssistantConsent(db, actor, initial.version, initial.revision);
  assert.deepEqual(await assistantConsent.readAssistantConsent(new TestD1(sqlite), actor), saved);
  assert.equal((await assistantConsent.readAssistantConsent(db, "teacher:other")).accepted, false);
  assert.equal((await assistantStore.readAssistantUsage(db, actor, null)).usedToday, 0);
  sqlite.prepare("UPDATE assistant_consents SET version='old' WHERE actor_key=?").run(actor);
  await assert.rejects(assistantConsent.requireAssistantConsent(db, actor), { code: "ai_consent_required" });
  await assert.rejects(assistantStore.createAssistantSession(db, actor, null), { code: "ai_consent_required" });
  await assert.rejects(assistantConsent.acceptAssistantConsent(db, actor, "old", saved.revision), { code: "ai_consent_changed" });
});

test("revocation closes only own sessions and a stale accept or delayed call cannot revive them", async () => {
  const { db, sqlite } = await visitDatabase();
  const actor = "librarian:consent-owner";
  const own = await assistant.createAssistantSession(db, actor, null);
  const other = await assistant.createAssistantSession(db, "teacher:consent-other", 12);
  const before = await assistantConsent.readAssistantConsent(db, actor);
  const revoked = await assistantConsent.revokeAssistantConsent(db, actor);
  assert.equal(revoked.accepted, false);
  await assert.rejects(assistantConsent.acceptAssistantConsent(db, actor, before.version, before.revision), { code: "ai_consent_changed" });
  await assert.rejects(assistantStore.createAssistantSession(db, actor, null), { code: "ai_consent_required" });
  await assert.rejects(assistant.requireAssistantSession(db, own.id, actor), { code: "assistant_session_ended" });
  await assistant.requireAssistantSession(db, other.id, "teacher:consent-other");
  const calls = [];
  await assert.rejects(assistant.registerAssistantCall(db, own.id, actor,
    new Response("v=0", { headers: { Location: "/v1/realtime/calls/rtc_revoked" } }), "test-key",
    async (url) => { calls.push(url); return new Response(null, { status: 200 }); }));
  assert.equal(calls.length, 1);
  const accepted = await assistantConsent.acceptAssistantConsent(db, actor, revoked.version, revoked.revision);
  assert.equal(accepted.accepted, true);
  await assert.rejects(assistant.requireAssistantSession(db, own.id, actor), { code: "assistant_session_ended" });
  await assistantStore.createAssistantSession(db, actor, null);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM assistant_sessions WHERE actor_key=?").get(actor).n, 2);
});

test("consent acceptance is explicit and cannot be smuggled on start or visit confirmation", async () => {
  const route = await readFile(new URL("../app/api/assistant/route.ts", import.meta.url), "utf8");
  const ui = await readFile(new URL("../app/_components/library-assistant.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(route, /body\.value\.aiConsent/);
  assert.match(route, /operation === "accept_consent"/);
  assert.match(route, /await requireAssistantConsent\(db, principal.actorKey\)/);
  assert.match(ui, /consentToken === consentRequest.current/);
  assert.doesNotMatch(ui, /aiConsent: true/);
  assert.match(ui, /consentChange.current = change/);
  assert.match(ui, /publicDisplayConsent: true/);
  assert.match(ui, /Не диктуйте PIN або паролі/);
});

test("assistant original male voices and speaking styles stay isolated by role", async () => {
  assert.deepEqual(assistantContract.ASSISTANT_VOICES, { teacher: "ash", librarian: "cedar" });
  assert.equal(Object.isFrozen(assistantContract.ASSISTANT_VOICES), true);
  const teacher = assistantContract.assistantInstructions("teacher", "2026-09-05 12:00");
  const librarian = assistantContract.assistantInstructions("librarian", "2026-09-05 12:00");
  assert.doesNotMatch(teacher, /Манера Джарвіса|іронія/);
  assert.match(teacher, /оригінальний теплий чоловічий голос/);
  assert.match(teacher, /Не наслідуй голос чи акцент/);
  assert.match(teacher, /потрібно підтвердити кнопкою на екрані/);
  assert.doesNotMatch(librarian, /Манера Містера Букінгема/);
  assert.match(librarian, /оригінальний спокійний чоловічий голос/);
  assert.match(librarian, /Не наслідуй голос, акцент/);
  assert.match(librarian, /не змінює правил перевірки фактів, доступу та підтвердження дій/);
  assert.equal(librarian.split("\nМанера Джарвіса:")[0], teacher.split("\nМанера Містера Букінгема:")[0]
    .replace("Містер Букінгем · ШІ-помічник", "Джарвіс")
    .replace("Роль користувача: teacher.", "Роль користувача: librarian."));
  assert.deepEqual(assistantContract.assistantTools("librarian").map((t) => t.name), ["search_catalog", "material_details", "visit_schedule", "librarian_reference", "librarian_loans", "material_history", "library_action_schema", "prepare_library_action", "librarian_report"]);
  assert.deepEqual(assistantContract.assistantTools("teacher").map((t) => t.name), ["search_catalog", "material_details", "visit_schedule", "my_loans", "my_orders", "prepare_visit"]);
  const route = await readFile(new URL("../app/api/assistant/route.ts", import.meta.url), "utf8");
  assert.match(route, /output: \{ voice: ASSISTANT_VOICES\[role\] \}/);
});

test("assistant registers voice calls before returning SDP and compensates storage failure", async () => {
  const { db, sqlite } = await visitDatabase();
  const session = await assistant.createAssistantSession(db, "librarian:test", 12);
  const response = () => new Response("v=0\r\n", { headers: { Location: "/v1/realtime/calls/rtc_test" } });
  const calls = [];
  const fetcher = async (url) => { calls.push(url); return new Response(null, { status: 200 }); };
  assert.equal(await assistant.registerAssistantCall(db, session.id, "librarian:test", response(), "test-key", fetcher), "v=0\r\n");
  assert.equal(sqlite.prepare("SELECT provider_call_id FROM assistant_sessions WHERE id=?").get(session.id).provider_call_id, "rtc_test");
  const failedDb = { prepare() { throw new Error("database unavailable"); } };
  await assert.rejects(assistant.registerAssistantCall(failedDb, session.id, "librarian:test", response(), "test-key", fetcher), /database unavailable/);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/rtc_test\/hangup$/);
  await assert.rejects(assistant.registerAssistantCall(db, session.id, "librarian:test", new Response("v=0"), "test-key", fetcher), (error) => error.code === "invalid_provider_call");
  await assert.rejects(assistant.registerAssistantCall(db, session.id, "librarian:test", new Response("not SDP", { headers: { Location: "/v1/realtime/calls/rtc_test" } }), "test-key", fetcher), /invalid_provider_sdp/);
  assert.equal(calls.length, 2);
  assert.equal(sqlite.prepare("SELECT provider_call_id FROM assistant_sessions WHERE id=?").get(session.id).provider_call_id, null);
});

test("assistant conversation is remounted for a different role or signed-in identity", async () => {
  const source = await readFile(new URL("../app/_components/library-assistant.tsx", import.meta.url), "utf8");
  assert.match(source, /<AssistantPanel key=\{`\$\{props.assistantRole\}:\$\{props.identityKey\}`\}/);
});

class PreparedStatement {
  constructor(database, sql, bindings = []) { this.database = database; this.sql = sql; this.bindings = bindings; }
  bind(...values) { return new PreparedStatement(this.database, this.sql, values); }
  async first() { return this.database.sqlite.prepare(this.sql).get(...this.bindings) ?? null; }
  async all() { return { success: true, results: this.database.sqlite.prepare(this.sql).all(...this.bindings) }; }
  execute() { return { success: true, results: this.database.sqlite.prepare(this.sql).all(...this.bindings) }; }
}

class TestD1 {
  constructor(sqlite) { this.sqlite = sqlite; this.beforeBatch = null; }
  prepare(sql) { return new PreparedStatement(this, sql); }
  async batch(statements) {
    if (this.beforeBatch) { const hook = this.beforeBatch; this.beforeBatch = null; await hook(); }
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

async function visitDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const file of [
    "0000_librarian_drafts.sql", "0001_draft_workflow.sql", "0002_remove_legacy_audit_triggers.sql",
    "0003_odd_the_order.sql", "0004_staging_import_runs.sql", "0005_young_night_nurse.sql",
    "0006_pale_sauron.sql", "0007_cold_whiplash.sql", "0008_sudden_thunderbird.sql",
    "0009_happy_silver_samurai.sql", "0010_shocking_cobalt_man.sql",
    "0011_normalize_holding_conditions.sql",
    "0012_elite_victor_mancha.sql",
    "0013_strange_dark_beast.sql",
    "0014_rich_lionheart.sql",
    "0015_glamorous_namora.sql",
    "0016_busy_jane_foster.sql",
    "0017_fresh_robbie_robertson.sql",
    "0018_yielding_skaar.sql",
    "0019_kindly_wolfsbane.sql",
    "0023_guest_public_teacher_name_consent.sql",
    "0036_eager_champions.sql",
    "0037_keen_carlie_cooper.sql",
    "0038_legal_morph.sql",
    "0039_watery_black_crow.sql",
    "0040_empty_piledriver.sql",
    "0041_concerned_overlord.sql",
  ]) sqlite.exec(await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  const now = new Date().toISOString();
  sqlite.prepare(`INSERT INTO users
    (id, full_name, sort_name, email, auth_user_id, role, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
    .run("USR-TEACHER", "Учитель", "Учитель", "teacher@example.test", "auth-teacher", "teacher", now, now);
  sqlite.prepare(`INSERT INTO users
    (id, full_name, sort_name, email, auth_user_id, role, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
    .run("USR-LIB", "Бібліотекар", "Бібліотекар", "library@example.test", "auth-library", "librarian", now, now);
  sqlite.prepare(`INSERT INTO teacher_profiles(
    teacher_user_id,subject_position,primary_location_id,service_contact,librarian_note,version,
    last_mutation_request_id,closed_at,closed_by_user_id,created_by_user_id,updated_by_user_id,created_at,updated_at
  ) VALUES(?, '', NULL, '', '', 1, NULL, NULL, NULL, 'USR-LIB', 'USR-LIB', ?, ?)`)
    .run("USR-TEACHER", now, now);
  sqlite.prepare(`INSERT INTO visit_teacher_credentials (
    teacher_user_id, login_id, code_hmac, status, version, failed_attempts,
    locked_until, last_login_at, code_rotated_at, created_by_user_id,
    updated_by_user_id, created_at, updated_at
  ) VALUES ('USR-TEACHER','opaque-teacher-login-001',?,'active',1,0,NULL,NULL,?,
    'USR-LIB','USR-LIB',?,?)`).run("a".repeat(64), now, now, now);
  sqlite.prepare(`INSERT INTO visit_teacher_sessions (
    token_hash, teacher_user_id, credential_version, pending_scope, ip_scope_hash,
    expires_at, last_seen_at, revoked_at, created_at
  ) VALUES (?, 'USR-TEACHER', 1, 'pending-scope-teacher-001', ?,
    '2999-01-01T00:00:00.000Z', ?, NULL, ?)`)
    .run("b".repeat(64), "c".repeat(64), now, now);
  return { sqlite, db: new TestD1(sqlite) };
}

function teacherIdentity(overrides = {}) {
  return {
    teacherUserId: "USR-TEACHER",
    fullName: "Учитель",
    credentialVersion: 1,
    tokenHash: "b".repeat(64),
    pendingScope: "pending-scope-teacher-001",
    expiresAt: "2999-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function futureWeekday() {
  const today = validation.kyivToday();
  for (let offset = 1; offset <= 7; offset += 1) {
    const date = validation.addDays(today, offset);
    if (validation.isoWeekday(date) <= 5) return date;
  }
  throw new Error("weekday missing");
}

function bookingInput(requestId, date = futureWeekday()) {
  return { requestId, date, startTime: "09:00", endTime: "09:20", surname: "Шевченко", publicDisplayConsent: true, classYearId: null, purpose: null };
}

test("assistant uses allowlisted role tools without identity injection or model confirmation", () => {
  assert.equal(assistantContract.ASSISTANT_NAMES.teacher, "Містер Букінгем · ШІ-помічник");
  assert.equal(assistantContract.ASSISTANT_NAMES.librarian, "Джарвіс");
  assert.equal(assistantContract.assistantTools("teacher").some((t) => t.name === "prepare_visit"), true);
  for (const role of ["teacher", "librarian"]) {
    assert.equal(assistantContract.assistantTools(role).some((t) => /confirm|sql|delete|issue|return/.test(t.name)), false);
    assert.throws(() => assistantLibrary.validatedToolArguments(role, "search_catalog", { teacherUserId: "OTHER" }), /Невідоме/);
    assert.throws(() => assistantLibrary.validatedToolArguments(role, "search_catalog", { query: "bad\ninput" }), /формат/);
    assert.throws(() => assistantLibrary.validatedToolArguments(role, "search_catalog", { grade: 12 }), /формат/);
  }
  assert.throws(() => assistantLibrary.validatedToolArguments("librarian", "my_loans", {}), /недоступна/);
  assert.throws(() => assistantLibrary.validatedToolArguments("librarian", "prepare_visit", {}), /недоступна/);
  assert.deepEqual(assistantLibrary.validatedToolArguments("teacher", "my_orders", { cursor: "opaque-cursor" }), { cursor: "opaque-cursor" });
  assert.throws(() => assistant.validateAssistantVisit({ date: "2026-99-99", startTime: "09:00", endTime: "09:20", classYearId: null, purpose: null }, crypto.randomUUID()), /Уточніть/);
});

test("assistant free intervals respect busy slots, closures, weekends and current Kyiv time", () => {
  const schedule = { hours: { "1": [{ startTime: "09:00", endTime: "11:00" }] }, busy: [{ date: "2026-09-07", startTime: "09:30", endTime: "10:00" }], closures: [{ date: "2026-09-07", startTime: "10:20", endTime: "10:40" }] };
  assert.deepEqual(assistant.freeVisitIntervals(schedule, "2026-09-07", 7, 20, { date: "2026-09-07", time: "09:00" }), [
    { date: "2026-09-07", startTime: "09:05", endTime: "09:30" },
    { date: "2026-09-07", startTime: "10:00", endTime: "10:20" },
    { date: "2026-09-07", startTime: "10:40", endTime: "11:00" },
  ]);
  assert.deepEqual(assistant.freeVisitIntervals(schedule, "2026-09-07", 7, 30, { date: "2026-09-07", time: "09:00" }), []);
  assert.throws(() => assistant.freeVisitIntervals(schedule, "2026-09-07", 1, 21), /кратну/);
});

test("assistant sessions enforce owner, expiry, concurrency, daily and tool limits", async () => {
  const { db, sqlite } = await visitDatabase();
  const now = new Date(); const actor = "teacher:USR-TEACHER";
  const first = await assistant.createAssistantSession(db, actor, 3, now);
  const second = await assistant.createAssistantSession(db, actor, 3, now);
  await assert.rejects(assistant.createAssistantSession(db, actor, 3, now), { code: "assistant_concurrent_limit" });
  await assert.rejects(assistant.requireAssistantSession(db, first.id, "teacher:OTHER"), { code: "assistant_session_ended" });
  sqlite.prepare("UPDATE assistant_sessions SET closed_at=? WHERE id=?").run(now.toISOString(), second.id);
  await assistant.createAssistantSession(db, actor, 3, now);
  sqlite.prepare("UPDATE assistant_sessions SET closed_at=? WHERE actor_key=?").run(now.toISOString(), actor);
  await assert.rejects(assistant.createAssistantSession(db, actor, 3, now), { code: "assistant_daily_limit" });
  const independent = await assistant.createAssistantSession(db, "teacher:OTHER", 3, now);
  sqlite.prepare("UPDATE assistant_sessions SET tool_calls=99 WHERE id=?").run(independent.id);
  await assistant.requireAssistantSession(db, independent.id, "teacher:OTHER", "tool_calls", now);
  await assert.rejects(assistant.requireAssistantSession(db, independent.id, "teacher:OTHER", "tool_calls", now), { code: "assistant_session_ended" });
  await assert.rejects(assistant.requireAssistantSession(db, independent.id, "teacher:OTHER", undefined, new Date(now.getTime() + 600001)), { code: "assistant_session_ended" });
});

test("assistant role settings allow unlimited librarian starts but exactly 12 daily teacher conversations", async () => {
  assert.equal(assistantContract.assistantDailyLimit("librarian", "unlimited"), null);
  assert.equal(assistantContract.assistantDailyLimit("librarian"), null);
  for (const input of [undefined, "12", "unlimited", "0", "-1", "NaN", "Infinity", "12.5", "999"]) {
    assert.equal(assistantContract.assistantDailyLimit("teacher", input), 12);
  }
  const { db } = await visitDatabase();
  const begin = Date.parse("2026-09-05T08:00:00Z");
  for (let i = 0; i < 35; i++) {
    const now = new Date(begin + i * 61_000);
    await assistant.createAssistantSession(db, "librarian:unlimited", null, now);
    await assistant.closeAssistantSessions(db, "librarian:unlimited", undefined, undefined, now);
    if (i < 12) {
      await assistant.createAssistantSession(db, "teacher:twelve", 12, now);
      await assistant.closeAssistantSessions(db, "teacher:twelve", undefined, undefined, now);
    } else await assert.rejects(assistant.createAssistantSession(db, "teacher:twelve", 12, now), { code: "assistant_daily_limit" });
  }
  const usage = await assistant.readAssistantUsage(db, "librarian:unlimited", null, new Date(begin + 36 * 61_000));
  assert.equal(usage.usedToday, 35); assert.equal(usage.remainingToday, null); assert.equal(usage.activeSessions, 0);
  const teacherUsage = await assistant.readAssistantUsage(db, "teacher:twelve", 12, new Date(begin));
  assert.equal(teacherUsage.usedToday, 12); assert.equal(teacherUsage.remainingToday, 0);
  const route = await readFile(new URL("../app/api/assistant/route.ts", import.meta.url), "utf8");
  assert.match(route, /ASSISTANT_LIBRARIAN_DAILY_SESSIONS/);
  assert.match(route, /ASSISTANT_TEACHER_DAILY_SESSIONS/);
  assert.doesNotMatch(route, /getRuntimeString\("ASSISTANT_DAILY_SESSIONS"\)/);
});

test("assistant known failed voice starts release daily reservation without bypassing short retry guard", async () => {
  const { db, sqlite } = await visitDatabase();
  const now = new Date("2026-09-05T08:00:00Z"); const actor = "teacher:failed";
  for (let i = 0; i < 6; i++) {
    const session = await assistant.createAssistantSession(db, actor, 1, now);
    await assistant.failAssistantStartup(db, session.id, "teacher:someone-else", now);
    assert.equal((await assistant.readAssistantUsage(db, actor, 1, now)).usedToday, 1);
    await assistant.failAssistantStartup(db, session.id, actor, now);
    await assistant.failAssistantStartup(db, session.id, actor, now);
    const usage = await assistant.readAssistantUsage(db, actor, 1, now);
    assert.equal(usage.usedToday, 0); assert.equal(usage.activeSessions, 0);
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM assistant_sessions").get().n, 6);
  await assert.rejects(assistant.createAssistantSession(db, actor, 1, now), { code: "assistant_start_rate_limit" });
  const later = new Date(now.getTime() + 60_000);
  const valid = await assistant.createAssistantSession(db, actor, 1, later);
  await assistant.requireAssistantSession(db, valid.id, actor, "tool_calls", later);
  await assistant.failAssistantStartup(db, valid.id, actor, later);
  assert.equal((await assistant.readAssistantUsage(db, actor, 1, later)).usedToday, 1);
  await assistant.closeAssistantSessions(db, actor, undefined, undefined, later);
  await assert.rejects(assistant.createAssistantSession(db, actor, 1, later), { code: "assistant_daily_limit" });
});

test("assistant daily reset is Kyiv calendar midnight across summer, winter and DST dates", async () => {
  for (const [before, after, nextDay] of [
    ["2026-09-05T20:59:59Z", "2026-09-05T21:00:00Z", "2026-09-06"],
    ["2026-01-05T21:59:59Z", "2026-01-05T22:00:00Z", "2026-01-06"],
    ["2026-03-29T20:59:59Z", "2026-03-29T21:00:00Z", "2026-03-30"],
    ["2026-10-25T21:59:59Z", "2026-10-25T22:00:00Z", "2026-10-26"],
  ]) {
    const { db } = await visitDatabase(); const actor = "teacher:midnight";
    const session = await assistant.createAssistantSession(db, actor, 1, new Date(before));
    await assistant.closeAssistantSessions(db, actor, undefined, session.id, new Date(before));
    const usage = await assistant.readAssistantUsage(db, actor, 1, new Date(before));
    assert.equal(usage.resetsOn, nextDay); assert.equal(usage.remainingToday, 0);
    await assert.rejects(assistant.createAssistantSession(db, actor, 1, new Date(before)), (error) => {
      assert.equal(error.code, "assistant_daily_limit"); assert.match(error.message, /00:00 за Києвом/);
      assert.deepEqual(error.usage, usage); return true;
    });
    assert.equal((await assistant.readAssistantUsage(db, actor, 1, new Date(after))).usedToday, 0);
    await assistant.createAssistantSession(db, actor, 1, new Date(after));
  }
});

test("assistant close-all is owner scoped, idempotent and retains failed hangups for cron", async () => {
  const { db, sqlite } = await visitDatabase(); const now = new Date();
  const own = await assistant.createAssistantSession(db, "librarian:owner", null, now);
  const other = await assistant.createAssistantSession(db, "librarian:other", null, now);
  sqlite.prepare("UPDATE assistant_sessions SET provider_call_id=? WHERE id=?").run("rtc_own", own.id);
  sqlite.prepare("UPDATE assistant_sessions SET provider_call_id=? WHERE id=?").run("rtc_other", other.id);
  const urls = [];
  await assistant.closeAssistantSessions(db, "librarian:owner", "test", undefined, now, async (url) => { urls.push(url); return new Response(null, { status: 503 }); });
  assert.equal(urls.length, 1); assert.match(urls[0], /rtc_own\/hangup$/);
  assert.equal(sqlite.prepare("SELECT provider_call_id FROM assistant_sessions WHERE id=?").get(own.id).provider_call_id, "rtc_own");
  await assistant.requireAssistantSession(db, other.id, "librarian:other", undefined, now);
  await assert.rejects(assistant.requireAssistantSession(db, own.id, "librarian:owner", undefined, now), { code: "assistant_session_ended" });
  await assistant.closeAssistantSessions(db, "librarian:owner", "test", undefined, now, async () => new Response(null, { status: 404 }));
  assert.equal(await assistant.closeAssistantSessions(db, "librarian:owner", "test", undefined, now), 0);
  assert.equal((await assistant.readAssistantUsage(db, "librarian:owner", null, now)).usedToday, 1);
  await assistant.closeAssistantSessions(db, "librarian:owner", undefined, other.id, now);
  await assistant.requireAssistantSession(db, other.id, "librarian:other", undefined, now);
});

test("assistant close-all racing voice registration compensates the remote call and never resurrects the session", async () => {
  const { db, sqlite } = await visitDatabase(); const actor = "librarian:race";
  const session = await assistant.createAssistantSession(db, actor, null);
  await assistant.closeAssistantSessions(db, actor, undefined);
  const urls = [];
  await assert.rejects(assistant.registerAssistantCall(db, session.id, actor,
    new Response("v=0\r\n", { headers: { Location: "/v1/realtime/calls/rtc_race" } }), "test",
    async (url) => { urls.push(url); return new Response(null, { status: 200 }); }), /assistant_call_not_registered/);
  assert.equal(urls.length, 1); assert.match(urls[0], /rtc_race\/hangup$/);
  assert.notEqual(sqlite.prepare("SELECT closed_at FROM assistant_sessions WHERE id=?").get(session.id).closed_at, null);
  await assistant.failAssistantStartup(db, session.id, actor);
  assert.equal((await assistant.readAssistantUsage(db, actor, null)).usedToday, 0);
});

test("assistant expiry releases concurrency but not daily quota; usage reads never consume conversations", async () => {
  const { db } = await visitDatabase(); const actor = "teacher:expiry"; const now = new Date();
  await assistant.createAssistantSession(db, actor, 2, now);
  await assistant.createAssistantSession(db, actor, 2, now);
  const later = new Date(now.getTime() + 600_001);
  for (let i = 0; i < 5; i++) {
    const usage = await assistant.readAssistantUsage(db, actor, 2, later);
    assert.equal(usage.usedToday, 2); assert.equal(usage.activeSessions, 0);
  }
  await assert.rejects(assistant.createAssistantSession(db, actor, 2, later), { code: "assistant_daily_limit" });
});

test("assistant UI exposes recovery and quota without clearing pending visit receipts", async () => {
  const source = await readFile(new URL("../app/_components/library-assistant.tsx", import.meta.url), "utf8");
  assert.match(source, /Завершити мої активні розмови/);
  assert.match(source, /Без денного ліміту розмов/);
  assert.match(source, /await closing.current/);
  assert.match(source, /if \(!pendingRef.current\) setPreview\(null\)/);
  assert.match(source, /reply.usage && token === generation.current/);
  assert.match(source, /error.code === "assistant_session_ended"\) stop\(\)/);
});

test("assistant delayed close-all cannot be dispatched from a closed panel or overtake a new start", async () => {
  const source = await readFile(new URL("../app/_components/library-assistant.tsx", import.meta.url), "utf8");
  const implementation = source.slice(source.indexOf("async function finishOwnSessions()"), source.indexOf("async function refreshUsage()"));
  const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
  const createHarness = (priorClose, api) => {
    const state = { operationLock: { current: false }, generation: { current: 0 }, closing: { current: priorClose }, pendingRef: { current: true }, notices: [] };
    state.stop = () => { state.generation.current++; state.operationLock.current = false; };
    state.api = api; state.setBusy = () => {}; state.setPreview = () => { throw new Error("pending receipt cleared"); };
    state.setNotice = (message) => state.notices.push(message);
    // Exercise the actual plain-JS component handler, not a duplicate implementation.
    state.finish = new Function("state", `const { operationLock, generation, closing, pendingRef, stop, api, setBusy, setPreview, setNotice } = state; return (${implementation});`)(state);
    return state;
  };
  const previous = deferred(); let calls = 0;
  const abandoned = createHarness(previous.promise, async () => { calls++; return { success: true }; });
  const abandonedRequest = abandoned.finish();
  abandoned.stop(); previous.resolve(); await abandonedRequest;
  assert.equal(calls, 0);
  const remoteClose = deferred();
  const running = createHarness(Promise.resolve(), () => { calls++; return remoteClose.promise; });
  const request = running.finish(); await Promise.resolve();
  assert.equal(calls, 1);
  running.stop(); let newStart = false;
  const next = running.closing.current.then(() => { newStart = true; });
  await Promise.resolve(); assert.equal(newStart, false);
  remoteClose.resolve({ success: true, usage: { remainingToday: null } });
  await Promise.all([request, next]); assert.equal(newStart, true); assert.equal(running.notices.length, 0);
});

test("assistant informational usage-read failure still returns a usable text session ID", async () => {
  const source = await readFile(new URL("../app/api/assistant/route.ts", import.meta.url), "utf8");
  const begin = source.indexOf("const session = await createAssistantSession");
  const implementation = source.slice(begin, source.indexOf("const now = kyivLocalNow();", begin));
  const run = new Function("deps", `const { createAssistantSession, readAssistantUsage, visitJson } = deps;
    const db = {}, principal = { actorKey: 'teacher:test' }, dailyLimit = 12, mode = 'text';
    return (async () => { ${implementation} })();`);
  const response = await run({ createAssistantSession: async () => ({ id: "known-id", expires_at: "known-expiry" }),
    readAssistantUsage: async () => { throw new Error("temporary read failure"); }, visitJson: (body) => body });
  assert.equal(response.success, true); assert.equal(response.sessionId, "known-id"); assert.equal(response.usage, undefined);
});

async function assistantDraft(db, overrides = {}) {
  const actor = "teacher:USR-TEACHER";
  const session = await assistant.createAssistantSession(db, actor, 12);
  const input = bookingInput(crypto.randomUUID()); delete input.surname;
  Object.assign(input, overrides);
  const preview = await assistant.prepareAssistantVisit(db, actor, session.id, input, "Особистий візит");
  return { actor, session, input, preview };
}

test("assistant proposal has no booking side effects; consent creates one core booking and receipt", async () => {
  const { db, sqlite } = await visitDatabase();
  const { actor, preview } = await assistantDraft(db);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM visit_bookings").get().n, 0);
  await assert.rejects(assistant.confirmAssistantVisit(db, actor, teacherIdentity(), preview.id, false), { code: "consent_required" });
  await assert.rejects(assistant.confirmAssistantVisit(db, "teacher:OTHER", teacherIdentity(), preview.id, true), { code: "assistant_tool_denied" });
  const created = await assistant.confirmAssistantVisit(db, actor, teacherIdentity(), preview.id, true);
  const repeated = await assistant.confirmAssistantVisit(db, actor, teacherIdentity(), preview.id, true);
  assert.equal(created.id, repeated.id);
  assert.equal(created.surname, "Учитель");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM visit_bookings").get().n, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM visit_slot_claims").get().n, 4);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM visit_mutation_commands WHERE kind='visit_booking_create'").get().n, 1);
});

test("assistant recovers authoritative core receipt after lost draft cache and expired session", async () => {
  const { db, sqlite } = await visitDatabase();
  const { actor, input, session, preview } = await assistantDraft(db);
  const created = await store.createVisitBooking(db, teacherIdentity(), input);
  sqlite.prepare("UPDATE assistant_sessions SET closed_at=?,expires_at=? WHERE id=?").run("2000-01-01", "2000-01-01", session.id);
  sqlite.prepare("UPDATE assistant_visit_drafts SET expires_at=?,result_json=NULL WHERE id=?").run("2000-01-01", preview.id);
  const receipt = await assistant.readAssistantVisitReceipt(db, actor, preview.id);
  assert.equal(receipt.id, created.id);
  assert.equal(await assistant.readAssistantVisitReceipt(db, "teacher:OTHER", preview.id), null);
  assert.equal((await assistant.confirmAssistantVisit(db, actor, teacherIdentity(), preview.id, true)).id, created.id);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM visit_bookings").get().n, 1);
});

test("assistant cannot create from an expired or closed session even after an earlier confirmation attempt", async () => {
  const { db, sqlite } = await visitDatabase();
  const { actor, session, preview } = await assistantDraft(db);
  sqlite.prepare("UPDATE assistant_visit_drafts SET confirmed_at=?,expires_at=? WHERE id=?").run("2000-01-01", "2000-01-01", preview.id);
  await assert.rejects(assistant.confirmAssistantVisit(db, actor, teacherIdentity(), preview.id, true), { code: "assistant_draft_expired" });
  sqlite.prepare("UPDATE assistant_visit_drafts SET expires_at=? WHERE id=?").run("2999-01-01", preview.id);
  sqlite.prepare("UPDATE assistant_sessions SET closed_at=? WHERE id=?").run(new Date().toISOString(), session.id);
  await assert.rejects(assistant.confirmAssistantVisit(db, actor, teacherIdentity(), preview.id, true), { code: "assistant_session_ended" });
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM visit_bookings").get().n, 0);
});

test("assistant invalidates a conflicted proposal instead of booking it silently on a later retry", async () => {
  const { db, sqlite } = await visitDatabase();
  const { actor, preview } = await assistantDraft(db);
  await store.createVisitBooking(db, teacherIdentity(), bookingInput(crypto.randomUUID()));
  await assert.rejects(assistant.confirmAssistantVisit(db, actor, teacherIdentity(), preview.id, true), { code: "slot_unavailable" });
  await assert.rejects(assistant.confirmAssistantVisit(db, actor, teacherIdentity(), preview.id, true), { code: "assistant_draft_expired" });
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM visit_bookings").get().n, 1);
});

test("assistant minute cleanup hangs up expired/closed calls, retries failures, and skips live calls", async () => {
  const { db, sqlite } = await visitDatabase();
  const now = new Date();
  const expired = await assistant.createAssistantSession(db, "teacher:A", 12, new Date(now.getTime() - 700000));
  const closed = await assistant.createAssistantSession(db, "teacher:B", 12, now);
  const live = await assistant.createAssistantSession(db, "teacher:C", 12, now);
  for (const [id, call] of [[expired.id, "rtc_expired"], [closed.id, "rtc_closed"], [live.id, "rtc_live"]]) sqlite.prepare("UPDATE assistant_sessions SET provider_call_id=? WHERE id=?").run(call, id);
  sqlite.prepare("UPDATE assistant_sessions SET closed_at=? WHERE id=?").run(now.toISOString(), closed.id);
  const calls = [];
  const mockFetch = async (url) => { calls.push(url); return new Response(null, { status: url.includes("rtc_closed") ? 503 : 200 }); };
  await assistant.expireAssistantCalls(db, undefined, now, mockFetch);
  assert.equal(calls.length, 0);
  await assistant.expireAssistantCalls(db, "test-secret", now, mockFetch);
  assert.equal(calls.length, 2);
  assert.equal(calls.some((url) => url.includes("rtc_live")), false);
  assert.equal(sqlite.prepare("SELECT provider_call_id FROM assistant_sessions WHERE id=?").get(expired.id).provider_call_id, null);
  assert.equal(sqlite.prepare("SELECT provider_call_id FROM assistant_sessions WHERE id=?").get(closed.id).provider_call_id, "rtc_closed");
  await assistant.expireAssistantCalls(db, "test-secret", now, async () => new Response(null, { status: 404 }));
  assert.equal(sqlite.prepare("SELECT provider_call_id FROM assistant_sessions WHERE id=?").get(closed.id).provider_call_id, null);
});

test("visit validators enforce 5-minute grid, duration, control characters and exact fields", () => {
  const valid = validation.validateVisitBookingCreateInput({
    requestId: "11111111-1111-4111-8111-111111111111",
    date: "2026-09-01", startTime: "09:00", endTime: "09:20",
    surname: "Шевченко", publicDisplayConsent: true, classYearId: null, purpose: null,
  });
  assert.equal(valid.ok, true);
  const missingConsent = validation.validateVisitBookingCreateInput({
    requestId: "11111111-1111-4111-8111-111111111111",
    date: "2026-09-01", startTime: "09:00", endTime: "09:20",
    classYearId: null, purpose: null,
  });
  assert.equal(missingConsent.ok, false);
  assert.ok(missingConsent.fieldErrors.publicDisplayConsent);
  assert.equal(validation.validateVisitBookingCreateInput({
    requestId: "11111111-1111-4111-8111-111111111111",
    date: "2026-09-01", startTime: "09:00", endTime: "09:20",
    publicDisplayConsent: false, classYearId: null, purpose: null,
  }).ok, false);

  const misalignedClosure = validation.validateVisitClosureCreateInput({
    requestId: "22222222-2222-4222-8222-222222222222",
    date: "2026-09-01", startTime: "09:03", endTime: "09:23", reason: "Нарада",
  });
  assert.equal(misalignedClosure.ok, false);
  assert.match(misalignedClosure.fieldErrors.startTime, /5/);
  assert.match(misalignedClosure.fieldErrors.endTime, /5/);

  const controls = validation.validateVisitBookingCreateInput({
    requestId: "33333333-3333-4333-8333-333333333333",
    date: "2026-09-01", startTime: "09:00", endTime: "09:20",
    surname: "Шев\nченко", publicDisplayConsent: true, classYearId: null, purpose: null,
  });
  assert.equal(controls.ok, false);
  assert.ok(controls.fieldErrors.surname);
});

test("guest and portal validators require exact versioned mutation bodies", () => {
  const guest = {
    requestId: "16161616-1616-4616-8616-161616161616",
    teacherRef: "a".repeat(64), date: "2026-09-01", startTime: "09:00", endTime: "09:20",
    publicDisplayConsent: true, publicTeacherNameConsent: true, classYearId: null, purpose: null,
  };
  assert.equal(portalValidation.validateGuestVisitCreateInput(guest).ok, true);
  assert.equal(portalValidation.validateGuestVisitCreateInput({ ...guest, surname: "Injected" }).ok, false);
  assert.equal(portalValidation.validateGuestVisitCreateInput(
    Object.fromEntries(Object.entries(guest).filter(([key]) => key !== "purpose")),
  ).ok, false);
  const oldGuest = { ...guest };
  delete oldGuest.publicTeacherNameConsent;
  assert.deepEqual(portalValidation.validateGuestVisitCreateInput(oldGuest), {
    ok: true,
    value: {
      requestId: guest.requestId,
      teacherRef: guest.teacherRef,
      date: guest.date,
      startTime: guest.startTime,
      endTime: guest.endTime,
      publicDisplayConsent: true,
      publicTeacherNameConsent: false,
      classYearId: null,
      purpose: null,
    },
  });
  const update = {
    requestId: "17171717-1717-4717-8717-171717171717", expectedVersion: 3,
    date: "2026-09-01", startTime: "10:00", endTime: "10:20",
    publicDisplayConsent: true, classYearId: null, purpose: null,
  };
  assert.equal(portalValidation.validateVisitBookingUpdateInput(update).ok, true);
  assert.equal(portalValidation.validateVisitBookingUpdateInput({ ...update, expectedVersion: 0 }).ok, false);
  assert.equal(portalValidation.validateVisitBookingUpdateInput({ ...update, ownerId: "USR-X" }).ok, false);
  assert.equal(portalValidation.validateGuestVisitUpdateInput({
    ...update, publicTeacherNameConsent: true,
  }).ok, true);
  assert.equal(portalValidation.validateGuestVisitUpdateInput(update).ok, true);
  assert.equal(portalValidation.validateGuestVisitUpdateInput(update).value.publicTeacherNameConsent, false);
  assert.equal(portalValidation.validateGuestVisitUpdateInput({
    ...update, publicTeacherNameConsent: "yes",
  }).ok, false);
  assert.equal(portalValidation.validateGuestVisitCancelInput({
    requestId: "18181818-1818-4818-8818-181818181818", expectedVersion: 1, reason: null,
  }).ok, true);
});

test("public and teacher visit ranges stay inside the booking horizon", () => {
  assert.deepEqual(
    validation.parseVisitRange(new URL("https://example.test/api?from=2026-08-12&to=2026-11-10"), "2026-08-12"),
    { from: "2026-08-12", to: "2026-11-10" },
  );
  assert.throws(
    () => validation.parseVisitRange(new URL("https://example.test/api?from=2026-08-11&to=2026-08-20"), "2026-08-12"),
    /90/,
  );
  assert.throws(
    () => validation.parseVisitRange(new URL("https://example.test/api?from=2030-01-01&to=2030-01-07"), "2026-08-12"),
    /90/,
  );
});

test("shared segment-claim schema is the atomic booking-versus-closure race guard", async () => {
  const sql = await readFile(new URL("../drizzle/0006_pale_sauron.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE `visit_slot_claims`/);
  assert.match(sql, /`segment_key` text PRIMARY KEY NOT NULL/);
  assert.match(sql, /`booking_id` text/);
  assert.match(sql, /`closure_id` text/);
  assert.match(sql, /visit_slot_claims_exactly_one_owner/);
  assert.match(sql, /between 0 and 23/);
  assert.match(sql, /% 5 = 0/);
  assert.match(sql, /substr\("visit_slot_claims"\."segment_key", 1, 10\) glob/);
  assert.doesNotMatch(sql, /T\[0-9\]\[0-9\]:\[0-5\]\[0-9\]/);
});

test("visit slot-claim migration preserves rows with foreign keys enabled", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const file of [
    "0000_librarian_drafts.sql", "0001_draft_workflow.sql", "0002_remove_legacy_audit_triggers.sql",
    "0003_odd_the_order.sql", "0004_staging_import_runs.sql", "0005_young_night_nurse.sql",
    "0006_pale_sauron.sql",
  ]) sqlite.exec(await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  const now = new Date().toISOString();
  sqlite.prepare(`INSERT INTO visit_bookings (
    id, owner_auth_user_id, owner_email, surname, visit_date, start_time, end_time,
    purpose, status, cancel_reason, version, created_at, updated_at
  ) VALUES ('VIS-UPGRADE', 'auth-upgrade', 'upgrade@example.test', 'Тестовий',
    '2026-09-01', '09:00', '09:20', '', 'active', '', 1, ?, ?)`)
    .run(now, now);
  sqlite.prepare(`INSERT INTO visit_slot_claims
    (segment_key, booking_id, closure_id, created_at)
    VALUES ('2026-09-01T09:00', 'VIS-UPGRADE', NULL, ?)`)
    .run(now);
  const migration = await readFile(new URL("../drizzle/0007_cold_whiplash.sql", import.meta.url), "utf8");
  assert.doesNotMatch(migration, /PRAGMA foreign_keys\s*=\s*OFF/i);
  sqlite.exec(migration);
  assert.equal(sqlite.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(sqlite.prepare("SELECT booking_id FROM visit_slot_claims WHERE segment_key='2026-09-01T09:00'").get().booking_id, "VIS-UPGRADE");
  assert.throws(() => sqlite.prepare(`INSERT INTO visit_slot_claims
    (segment_key, booking_id, closure_id, created_at)
    VALUES ('2026-09-01X09:05', 'VIS-UPGRADE', NULL, ?)`)
    .run(now), /visit_slot_claims_key_valid/);
});

test("teacher-code migration preserves bookings and claims with foreign keys enabled", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const file of [
    "0000_librarian_drafts.sql", "0001_draft_workflow.sql", "0002_remove_legacy_audit_triggers.sql",
    "0003_odd_the_order.sql", "0004_staging_import_runs.sql", "0005_young_night_nurse.sql",
    "0006_pale_sauron.sql", "0007_cold_whiplash.sql",
  ]) sqlite.exec(await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  const now = new Date().toISOString();
  for (const user of [
    ["USR-MIG", "Migration Teacher", "auth-owner@example.test", "auth-migration"],
    ["USR-CONFLICT", "Email Conflict", "email-conflict@example.test", "auth-conflict"],
    ["USR-FALLBACK", "Email Fallback", "fallback@example.test", "auth-fallback"],
  ]) sqlite.prepare(`INSERT INTO users
    (id, full_name, sort_name, email, auth_user_id, role, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'teacher', 'active', ?, ?)`)
    .run(user[0], user[1], user[1].toLowerCase(), user[2], user[3], now, now);
  sqlite.prepare(`INSERT INTO visit_bookings (
    id, owner_auth_user_id, owner_email, surname, visit_date, start_time, end_time,
    purpose, status, cancel_reason, version, created_at, updated_at
  ) VALUES ('VIS-MIG', 'auth-migration', 'email-conflict@example.test', 'Migration Teacher',
    '2026-09-01', '09:00', '09:20', '', 'active', '', 1, ?, ?)` ).run(now, now);
  sqlite.prepare(`INSERT INTO visit_bookings (
    id, owner_auth_user_id, owner_email, surname, visit_date, start_time, end_time,
    purpose, status, cancel_reason, cancelled_by_auth_user_id, version, created_at, updated_at, cancelled_at
  ) VALUES ('VIS-FALLBACK', 'missing-auth', 'fallback@example.test', 'Email Fallback',
    '2026-09-02', '10:00', '10:20', '', 'cancelled', 'legacy', 'legacy-canceller', 2, ?, ?, ?)`)
    .run(now, now, now);
  sqlite.prepare(`INSERT INTO visit_bookings (
    id, owner_auth_user_id, owner_email, surname, visit_date, start_time, end_time,
    purpose, status, cancel_reason, version, created_at, updated_at
  ) VALUES ('VIS-UNMATCHED', 'missing-auth-2', 'missing@example.test', 'Unmatched Teacher',
    '2026-09-03', '11:00', '11:20', '', 'active', '', 1, ?, ?)` ).run(now, now);
  sqlite.prepare(`INSERT INTO visit_slot_claims(segment_key, booking_id, closure_id, created_at)
    VALUES ('2026-09-01T09:00','VIS-MIG',NULL,?)`).run(now);
  sqlite.prepare(`INSERT INTO visit_slot_claims(segment_key, booking_id, closure_id, created_at)
    VALUES ('2026-09-03T11:00','VIS-UNMATCHED',NULL,?)`).run(now);
  const migration = await readFile(new URL("../drizzle/0008_sudden_thunderbird.sql", import.meta.url), "utf8");
  assert.doesNotMatch(migration, /PRAGMA foreign_keys\s*=\s*OFF/iu);
  sqlite.exec(migration);
  assert.equal(sqlite.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM visit_bookings").get().n, 3);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM visit_slot_claims").get().n, 2);
  const authPreferred = sqlite.prepare(`SELECT owner_user_id,owner_auth_user_id,owner_email
    FROM visit_bookings WHERE id='VIS-MIG'`).get();
  assert.deepEqual({ ...authPreferred }, { owner_user_id: "USR-MIG", owner_auth_user_id: null, owner_email: null });
  const emailFallback = sqlite.prepare(`SELECT owner_user_id,owner_auth_user_id,owner_email,status
    FROM visit_bookings WHERE id='VIS-FALLBACK'`).get();
  assert.deepEqual({ ...emailFallback }, {
    owner_user_id: "USR-FALLBACK", owner_auth_user_id: null, owner_email: null, status: "cancelled",
  });
  const unmatched = sqlite.prepare(`SELECT owner_user_id,owner_auth_user_id,owner_email
    FROM visit_bookings WHERE id='VIS-UNMATCHED'`).get();
  assert.deepEqual({ ...unmatched }, {
    owner_user_id: null, owner_auth_user_id: "missing-auth-2", owner_email: "missing@example.test",
  });
  assert.deepEqual(
    sqlite.prepare("SELECT segment_key,booking_id FROM visit_slot_claims ORDER BY segment_key").all().map((row) => ({ ...row })),
    [
      { segment_key: "2026-09-01T09:00", booking_id: "VIS-MIG" },
      { segment_key: "2026-09-03T11:00", booking_id: "VIS-UNMATCHED" },
    ],
  );
});

test("portal migration preserves teacher and legacy bookings plus claims with foreign keys enabled", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const file of [
    "0000_librarian_drafts.sql", "0001_draft_workflow.sql", "0002_remove_legacy_audit_triggers.sql",
    "0003_odd_the_order.sql", "0004_staging_import_runs.sql", "0005_young_night_nurse.sql",
    "0006_pale_sauron.sql", "0007_cold_whiplash.sql", "0008_sudden_thunderbird.sql",
  ]) sqlite.exec(await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  const now = "2026-08-13T10:00:00.000Z";
  sqlite.prepare(`INSERT INTO users
    (id,full_name,sort_name,email,auth_user_id,role,status,created_at,updated_at)
    VALUES ('USR-PORTAL-MIG','Portal Teacher','portal teacher','portal@example.test',
      'auth-portal','teacher','active',?,?)`).run(now, now);
  sqlite.prepare(`INSERT INTO visit_bookings (
    id,owner_user_id,owner_auth_user_id,owner_email,surname,visit_date,start_time,end_time,
    purpose,status,cancel_reason,version,created_at,updated_at
  ) VALUES ('VIS-PORTAL-TEACHER','USR-PORTAL-MIG',NULL,NULL,'Portal Teacher',
      '2026-09-08','09:00','09:20','','active','',2,?,?)`).run(now, now);
  sqlite.prepare(`INSERT INTO visit_bookings (
    id,owner_user_id,owner_auth_user_id,owner_email,surname,visit_date,start_time,end_time,
    purpose,status,cancel_reason,version,created_at,updated_at
  ) VALUES ('VIS-PORTAL-LEGACY',NULL,'legacy-auth','legacy@example.test','Legacy Teacher',
      '2026-09-08','10:00','10:20','','active','',1,?,?)`).run(now, now);
  sqlite.prepare(`INSERT INTO visit_slot_claims(segment_key,booking_id,closure_id,created_at)
    VALUES ('2026-09-08T09:00','VIS-PORTAL-TEACHER',NULL,?),
      ('2026-09-08T10:00','VIS-PORTAL-LEGACY',NULL,?)`).run(now, now);

  const migration = await readFile(new URL("../drizzle/0009_happy_silver_samurai.sql", import.meta.url), "utf8");
  assert.doesNotMatch(migration, /PRAGMA foreign_keys\s*=\s*OFF/iu);
  sqlite.exec(migration);

  assert.equal(sqlite.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM visit_bookings").get().n, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM visit_slot_claims").get().n, 2);
  assert.deepEqual(
    sqlite.prepare(`SELECT id,owner_kind,owner_user_id,guest_owner_id,
      selected_teacher_user_id,last_mutation_request_id,version
      FROM visit_bookings ORDER BY id`).all().map((row) => ({ ...row })),
    [
      {
        id: "VIS-PORTAL-LEGACY", owner_kind: "legacy", owner_user_id: null,
        guest_owner_id: null, selected_teacher_user_id: null,
        last_mutation_request_id: null, version: 1,
      },
      {
        id: "VIS-PORTAL-TEACHER", owner_kind: "teacher", owner_user_id: "USR-PORTAL-MIG",
        guest_owner_id: null, selected_teacher_user_id: null,
        last_mutation_request_id: null, version: 2,
      },
    ],
  );
  assert.deepEqual(
    sqlite.prepare("SELECT segment_key,booking_id FROM visit_slot_claims ORDER BY segment_key").all()
      .map((row) => ({ ...row })),
    [
      { segment_key: "2026-09-08T09:00", booking_id: "VIS-PORTAL-TEACHER" },
      { segment_key: "2026-09-08T10:00", booking_id: "VIS-PORTAL-LEGACY" },
    ],
  );
});

test("visit audits verify persisted final state without relying on changes()", async () => {
  const source = await readFile(new URL("../lib/visit-schedule-store.ts", import.meta.url), "utf8");
  assert.match(source, /claimOwner:\s*"booking", expectedClaimCount: segments\.length/);
  assert.match(source, /claimOwner:\s*"closure", expectedClaimCount: segments\.length/);
  assert.match(source, /SELECT COUNT\(\*\) FROM visit_slot_claims WHERE \$\{ownerColumn\} = \?/);
  assert.match(source, /status = 'cancelled' AND version = \? AND cancelled_at = \?/);
  assert.match(source, /NOT EXISTS \(\s*SELECT 1 FROM visit_slot_claims WHERE \$\{ownerColumn\} = \?/);
  assert.doesNotMatch(source, /changes\(\)/);
});

test("visit migration rejects impossible local dates", async () => {
  const { sqlite } = await visitDatabase();
  const now = new Date().toISOString();
  assert.throws(() => sqlite.prepare(`
    INSERT INTO visit_bookings (
      id, owner_kind, owner_auth_user_id, owner_email, surname, visit_date, start_time, end_time,
      purpose, status, cancel_reason, version, created_at, updated_at
    ) VALUES (?, 'legacy', ?, ?, ?, ?, ?, ?, '', 'active', '', 1, ?, ?)
  `).run("VIS-BAD", "auth-teacher", "teacher@example.test", "Шевченко", "2026-02-30", "09:00", "09:20", now, now), /visit_bookings_date_valid/);
});

test("public-display consent migration keeps legacy bookings private with foreign keys enabled", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const file of [
    "0000_librarian_drafts.sql", "0001_draft_workflow.sql", "0002_remove_legacy_audit_triggers.sql",
    "0003_odd_the_order.sql", "0004_staging_import_runs.sql", "0005_young_night_nurse.sql",
    "0006_pale_sauron.sql", "0007_cold_whiplash.sql", "0008_sudden_thunderbird.sql",
    "0009_happy_silver_samurai.sql", "0010_shocking_cobalt_man.sql",
    "0011_normalize_holding_conditions.sql",
  ]) sqlite.exec(await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  const now = new Date().toISOString();
  sqlite.prepare(`INSERT INTO users
    (id,full_name,sort_name,email,auth_user_id,role,status,created_at,updated_at)
    VALUES ('USR-CONSENT-MIG','Legacy Teacher','legacy teacher','legacy@example.test','auth-legacy',
      'teacher','active',?,?)`).run(now, now);
  sqlite.prepare(`INSERT INTO visit_bookings (
    id,owner_kind,owner_user_id,surname,visit_date,start_time,end_time,purpose,status,cancel_reason,
    version,created_at,updated_at
  ) VALUES ('VIS-CONSENT-MIG','teacher','USR-CONSENT-MIG','Legacy Teacher','2026-09-01',
    '09:00','09:20','','active','',1,?,?)`).run(now, now);
  sqlite.prepare(`INSERT INTO visit_slot_claims(segment_key,booking_id,closure_id,created_at)
    VALUES ('2026-09-01T09:00','VIS-CONSENT-MIG',NULL,?)`).run(now);

  const migration = await readFile(new URL("../drizzle/0012_elite_victor_mancha.sql", import.meta.url), "utf8");
  assert.doesNotMatch(migration, /PRAGMA foreign_keys\s*=\s*OFF/iu);
  sqlite.exec(migration);

  assert.equal(sqlite.prepare("SELECT public_display_consent FROM visit_bookings WHERE id='VIS-CONSENT-MIG'").get().public_display_consent, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_slot_claims WHERE booking_id='VIS-CONSENT-MIG'").get().total, 1);
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  assert.throws(
    () => sqlite.prepare("UPDATE visit_bookings SET public_display_consent=2 WHERE id='VIS-CONSENT-MIG'").run(),
    /visit_bookings\.public_display_consent|CHECK constraint failed/iu,
  );
});

test("visit routes keep public payload PII-free and protect teacher writes", async () => {
  const [publicRoute, teacherRoute, cancelRoute, store, api] = await Promise.all([
    readFile(new URL("../app/api/visits/public/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/visits/teacher/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/visits/teacher/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/visit-schedule-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/visit-schedule-api.ts", import.meta.url), "utf8"),
  ]);
  assert.match(publicRoute, /Access-Control-Allow-Origin.*\*/s);
  assert.doesNotMatch(publicRoute, /surname|ownerEmail|classLabel|purpose/);
  assert.match(teacherRoute, /requireVisitTeacherSession/);
  assert.match(teacherRoute, /isSameOriginRequest\(request\)/);
  assert.match(teacherRoute, /readVisitJson/);
  assert.match(cancelRoute, /cancelOwnVisitBooking/);
  assert.match(cancelRoute, /isSameOriginRequest\(request\)/);
  assert.doesNotMatch(api, /VISIT_TEACHER_ALLOWED_EMAILS/);
  assert.match(store, /PRIMARY KEY|visit_slot_claims/);
  assert.match(store, /owner_user_id = \?/);
  assert.match(store, /request_id_conflict/);
  assert.match(store, /visit_time_elapsed/);
  assert.match(store, /LIMIT 3001/);
});

test("visit tables are reset in FK-safe order before users and class years", async () => {
  const runtime = await readFile(new URL("../lib/d1-import-runtime.ts", import.meta.url), "utf8");
  const slot = runtime.indexOf('"visit_slot_claims"');
  const bookings = runtime.indexOf('"visit_bookings"');
  const closures = runtime.indexOf('"visit_schedule_closures"');
  const hours = runtime.indexOf('"visit_schedule_hours"');
  const classes = runtime.indexOf('"class_years"');
  const users = runtime.indexOf('"users"');
  assert.ok(slot >= 0 && bookings > slot && closures > bookings && hours > closures);
  assert.ok(classes > hours && users > classes);
});

test("atomic segment claims reject overlapping booking and closure without partial writes", async () => {
  const { sqlite, db } = await visitDatabase();
  const teacher = teacherIdentity();
  const librarian = { userId: "auth-library", email: "library@example.test", displayName: "Library", fullName: null };
  const date = futureWeekday();
  const first = await store.createVisitBooking(db, teacher, bookingInput("44444444-4444-4444-8444-444444444444", date));
  await assert.rejects(
    store.createVisitClosure(db, librarian, {
      requestId: "55555555-5555-4555-8555-555555555555", date,
      startTime: "09:00", endTime: "09:20", reason: "Нарада",
    }),
    (error) => error instanceof store.VisitScheduleError && error.code === "slot_unavailable",
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_bookings WHERE status='active'").get().total, 1);
  assert.deepEqual({ ...sqlite.prepare(
    "SELECT owner_kind,owner_user_id,guest_owner_id FROM visit_bookings WHERE id=?",
  ).get(first.id) }, { owner_kind: "teacher", owner_user_id: teacher.teacherUserId, guest_owner_id: null });
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_schedule_closures").get().total, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_slot_claims WHERE booking_id=?").get(first.id).total, 4);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_mutation_commands").get().total, 1);
});

test("directory teacher deactivation between authorization and batch rolls back completely", async () => {
  const { sqlite, db } = await visitDatabase();
  const teacher = teacherIdentity();
  db.beforeBatch = () => sqlite.prepare("UPDATE users SET status='inactive' WHERE id='USR-TEACHER'").run();
  await assert.rejects(
    store.createVisitBooking(db, teacher, bookingInput("66666666-6666-4666-8666-666666666666")),
    (error) => error instanceof store.VisitScheduleError && error.code === "teacher_access_revoked",
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_bookings").get().total, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_slot_claims").get().total, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_mutation_commands").get().total, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM audit_events WHERE entity_type='visit_booking'").get().total, 0);
});

test("booking request id replays once and rejects a changed payload", async () => {
  const { sqlite, db } = await visitDatabase();
  const teacher = teacherIdentity();
  const input = bookingInput("77777777-7777-4777-8777-777777777777");
  const first = await store.createVisitBooking(db, teacher, input);
  const replay = await store.createVisitBooking(db, teacher, input);
  assert.deepEqual(replay, first);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_bookings").get().total, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM audit_events WHERE entity_type='visit_booking'").get().total, 1);
  await assert.rejects(
    store.createVisitBooking(db, teacher, { ...input, purpose: "Інше" }),
    (error) => error instanceof store.VisitScheduleError && error.code === "request_id_conflict",
  );
});

test("authenticated teacher reschedule moves claims atomically and rejects a concurrent overlap", async () => {
  const { sqlite, db } = await visitDatabase();
  const teacher = teacherIdentity();
  const date = futureWeekday();
  const created = await store.createVisitBooking(
    db, teacher, bookingInput("13131313-1313-4313-8313-131313131313", date),
  );
  const moved = await store.updateOwnVisitBooking(db, teacher, created.id, {
    requestId: "14141414-1414-4414-8414-141414141414", expectedVersion: 1,
    date, startTime: "10:00", endTime: "10:20", publicDisplayConsent: true, classYearId: null, purpose: "Moved",
  });
  assert.equal(moved.version, 2);
  assert.deepEqual(sqlite.prepare(
    "SELECT segment_key FROM visit_slot_claims WHERE booking_id=? ORDER BY segment_key",
  ).all(created.id).map((row) => row.segment_key), [
    `${date}T10:00`, `${date}T10:05`, `${date}T10:10`, `${date}T10:15`,
  ]);
  assert.deepEqual(await store.updateOwnVisitBooking(db, teacher, created.id, {
    requestId: "14141414-1414-4414-8414-141414141414", expectedVersion: 1,
    date, startTime: "10:00", endTime: "10:20", publicDisplayConsent: true, classYearId: null, purpose: "Moved",
  }), moved);

  const oldClaims = sqlite.prepare(
    "SELECT segment_key FROM visit_slot_claims WHERE booking_id=? ORDER BY segment_key",
  ).all(created.id).map((row) => row.segment_key);
  db.beforeBatch = () => {
    const now = new Date().toISOString();
    sqlite.prepare(`INSERT INTO visit_schedule_closures (
      id,visit_date,start_time,end_time,status,reason,created_by_user_id,cancelled_by_user_id,
      version,created_at,updated_at,cancelled_at
    ) VALUES ('CLO-TEACHER-RACE',?,'11:00','11:20','active','','USR-LIB',NULL,1,?,?,NULL)`)
      .run(date, now, now);
    sqlite.prepare(`INSERT INTO visit_slot_claims(segment_key,booking_id,closure_id,created_at)
      VALUES (?,NULL,'CLO-TEACHER-RACE',?)`).run(`${date}T11:00`, now);
  };
  await assert.rejects(
    () => store.updateOwnVisitBooking(db, teacher, created.id, {
      requestId: "15151515-1515-4515-8515-151515151515", expectedVersion: 2,
      date, startTime: "11:00", endTime: "11:20", publicDisplayConsent: true, classYearId: null, purpose: null,
    }),
    (error) => error.code === "slot_unavailable",
  );
  assert.deepEqual(sqlite.prepare(
    "SELECT segment_key FROM visit_slot_claims WHERE booking_id=? ORDER BY segment_key",
  ).all(created.id).map((row) => row.segment_key), oldClaims);
  assert.deepEqual({ ...sqlite.prepare(
    "SELECT start_time,end_time,version,last_mutation_request_id FROM visit_bookings WHERE id=?",
  ).get(created.id) }, {
    start_time: "10:00", end_time: "10:20", version: 2,
    last_mutation_request_id: "14141414-1414-4414-8414-141414141414",
  });
});

test("owner isolation, cancellation claim release and rebooking are atomic", async () => {
  const { sqlite, db } = await visitDatabase();
  const teacher = teacherIdentity();
  const stranger = teacherIdentity({ teacherUserId: "USR-STRANGER", tokenHash: "d".repeat(64) });
  const date = futureWeekday();
  const first = await store.createVisitBooking(db, teacher, bookingInput("88888888-8888-4888-8888-888888888888", date));
  await assert.rejects(
    store.cancelOwnVisitBooking(db, stranger, first.id, {
      requestId: "99999999-9999-4999-8999-999999999999", expectedVersion: 1, reason: null,
    }),
    (error) => error instanceof store.VisitScheduleError && error.code === "booking_not_found",
  );
  const cancelled = await store.cancelOwnVisitBooking(db, teacher, first.id, {
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", expectedVersion: 1, reason: null,
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_slot_claims").get().total, 0);
  const second = await store.createVisitBooking(db, teacher, bookingInput("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", date));
  assert.notEqual(second.id, first.id);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_slot_claims WHERE booking_id=?").get(second.id).total, 4);
});

test("teacher and librarian revocation during cancellation roll back every write", async () => {
  const { sqlite, db } = await visitDatabase();
  const teacher = teacherIdentity();
  const librarian = { userId: "auth-library", email: "library@example.test", displayName: "Library", fullName: null };
  const first = await store.createVisitBooking(db, teacher, bookingInput("dddddddd-dddd-4ddd-8ddd-dddddddddddd"));
  db.beforeBatch = () => sqlite.prepare("UPDATE users SET status='inactive' WHERE id='USR-TEACHER'").run();
  await assert.rejects(
    store.cancelOwnVisitBooking(db, teacher, first.id, {
      requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", expectedVersion: 1, reason: null,
    }),
    (error) => error instanceof store.VisitScheduleError && error.code === "teacher_access_revoked",
  );
  let row = sqlite.prepare("SELECT status, version FROM visit_bookings WHERE id=?").get(first.id);
  assert.equal(row.status, "active");
  assert.equal(row.version, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_slot_claims WHERE booking_id=?").get(first.id).total, 4);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_mutation_commands").get().total, 1);

  sqlite.prepare("UPDATE users SET status='active' WHERE id='USR-TEACHER'").run();
  db.beforeBatch = () => sqlite.prepare("UPDATE users SET status='inactive' WHERE id='USR-LIB'").run();
  await assert.rejects(
    store.cancelAdminVisitBooking(db, librarian, first.id, {
      requestId: "ffffffff-ffff-4fff-8fff-ffffffffffff", expectedVersion: 1, reason: "Скасовано",
    }),
    (error) => error instanceof store.VisitScheduleError && error.code === "actor_not_mapped",
  );
  row = sqlite.prepare("SELECT status, version FROM visit_bookings WHERE id=?").get(first.id);
  assert.equal(row.status, "active");
  assert.equal(row.version, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_slot_claims WHERE booking_id=?").get(first.id).total, 4);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_mutation_commands").get().total, 1);
});

test("public schedule exposes only consented verified names alongside generic busy intervals", async () => {
  const { db } = await visitDatabase();
  const teacher = teacherIdentity();
  const date = futureWeekday();
  await store.createVisitBooking(db, teacher, {
    ...bookingInput("cccccccc-cccc-4ccc-8ccc-cccccccccccc", date), purpose: "Приватна мета",
  });
  const schedule = await store.readVisitSchedule(db, { from: date, to: date });
  assert.deepEqual(schedule.busy, [{ date, startTime: "09:00", endTime: "09:20", status: "busy" }]);
  assert.deepEqual(schedule.publicBookings, [{
    date, startTime: "09:00", endTime: "09:20", displayName: "Учитель", identityVerified: true, directoryMatched: true,
  }]);
  assert.equal("bookings" in schedule, false);
  assert.doesNotMatch(JSON.stringify(schedule), /Шевченко|Приватна мета|teacher@example|VIS-|classLabel|purpose/);
});

test("public schedule shows the canonical directory teacher for a labelled guest booking", async () => {
  const { sqlite, db } = await visitDatabase();
  const date = futureWeekday();
  const now = new Date().toISOString();
  sqlite.prepare(`INSERT INTO visit_guest_sessions (
    id,token_hash,pending_scope,ip_scope_hash,expires_at,last_seen_at,revoked_at,created_at
  ) VALUES ('GUEST-PUBLIC',?,?,?,'2999-01-01T00:00:00.000Z',?,NULL,?)`)
    .run("d".repeat(64), "guest-public-scope", "e".repeat(64), now, now);
  sqlite.prepare(`INSERT INTO visit_bookings (
    id,owner_kind,guest_owner_id,selected_teacher_user_id,surname,visit_date,start_time,end_time,
    public_display_consent,public_teacher_name_consent,purpose,status,cancel_reason,version,created_at,updated_at
  ) VALUES ('VIS-GUEST-PUBLIC','guest','GUEST-PUBLIC','USR-TEACHER','Старе ім’я',?,'09:00','09:20',
    1,1,'Приватна мета','active','',1,?,?)`).run(date, now, now);
  sqlite.prepare(`INSERT INTO visit_bookings (
    id,owner_kind,guest_owner_id,selected_teacher_user_id,surname,visit_date,start_time,end_time,
    public_display_consent,purpose,status,cancel_reason,version,created_at,updated_at
  ) VALUES ('VIS-GUEST-HISTORICAL','guest','GUEST-PUBLIC','USR-TEACHER','Учитель',?,'09:20','09:40',
    1,'Стара приватна мета','active','',1,?,?)`).run(date, now, now);
  assert.throws(
    () => sqlite.prepare("UPDATE visit_bookings SET public_teacher_name_consent=2 WHERE id='VIS-GUEST-PUBLIC'").run(),
    /public_teacher_name_consent|CHECK constraint failed/iu,
  );

  const schedule = await store.readVisitSchedule(db, { from: date, to: date });
  assert.deepEqual(schedule.publicBookings, [
    {
      date,
      startTime: "09:00",
      endTime: "09:20",
      displayName: "Учитель",
      identityVerified: false,
      directoryMatched: true,
    },
    {
      date,
      startTime: "09:20",
      endTime: "09:40",
      displayName: "Непідтверджений гостьовий запис",
      identityVerified: false,
      directoryMatched: false,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(schedule.publicBookings), /Старе ім’я|Приватна мета|GUEST|VIS-|USR-TEACHER/u);
});

test("teacher list omits elapsed visits and teacher cannot cancel visit history", async () => {
  const { sqlite, db } = await visitDatabase();
  const teacher = teacherIdentity();
  const localNow = validation.kyivLocalNow();
  const createdAt = new Date().toISOString();
  sqlite.prepare(`INSERT INTO visit_bookings (
    id, owner_user_id, surname, visit_date, start_time, end_time,
    purpose, status, cancel_reason, version, created_at, updated_at
  ) VALUES ('VIS-PAST', ?, 'Учитель', ?, '00:00', '00:20', '', 'active', '', 1, ?, ?)`)
    .run(teacher.teacherUserId, localNow.date, createdAt, createdAt);
  for (const time of ["00:00", "00:05", "00:10", "00:15"]) {
    sqlite.prepare("INSERT INTO visit_slot_claims(segment_key, booking_id, closure_id, created_at) VALUES (?, 'VIS-PAST', NULL, ?)")
      .run(`${localNow.date}T${time}`, createdAt);
  }
  const own = await store.readVisitSchedule(db, { from: localNow.date, to: localNow.date }, {
    ownerUserId: teacher.teacherUserId, status: "active", futureOnly: localNow,
  });
  assert.deepEqual(own.bookings, []);
  await assert.rejects(
    store.cancelOwnVisitBooking(db, teacher, "VIS-PAST", {
      requestId: "12121212-1212-4212-8212-121212121212", expectedVersion: 1, reason: null,
    }),
    (error) => error instanceof store.VisitScheduleError && error.code === "booking_not_cancellable",
  );
  assert.equal(sqlite.prepare("SELECT status FROM visit_bookings WHERE id='VIS-PAST'").get().status, "active");
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_slot_claims WHERE booking_id='VIS-PAST'").get().total, 4);
  assert.equal(sqlite.prepare("SELECT COUNT(*) total FROM visit_mutation_commands WHERE id='12121212-1212-4212-8212-121212121212'").get().total, 0);
});
