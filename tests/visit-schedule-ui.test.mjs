import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  busyPeriodParts,
  clearVisitPendingIntent,
  readVisitPendingIntent,
  visitPendingKey,
  teacherSearchUrl,
  teacherSessionUrl,
  teacherVisitsUrl,
  isUncertainVisitFailure,
  VisitApiError,
  validVisitDuration,
  writeVisitPendingIntent,
} from "../app/visits/visit-client.ts";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("teacher booking is public-entry with app session while librarian keeps SIWC guard", async () => {
  const [teacher, librarian] = await Promise.all([
    read("app/visits/page.tsx"),
    read("app/librarian/visits/page.tsx"),
  ]);
  assert.doesNotMatch(teacher, /requireChatGPTUser|chatGPTSignOutPath/u);
  assert.match(teacher, /<VisitBookingWorkspace/u);
  assert.match(teacher, /dynamic = "force-dynamic"/u);
  assert.match(librarian, /requireChatGPTUser\("\/librarian\/visits"\)/u);
  assert.match(librarian, /getLibrarianAccess\(user\)/u);
  assert.match(librarian, /if \(!access\.allowed\)/u);
});

test("teacher booking UI selects canonical identity, authenticates with a personal code, and uses active classes", async () => {
  const source = await read("app/visits/visit-booking-workspace.tsx");
  assert.match(source, /teacherSearchUrl\(normalizedQuery\)/u);
  assert.match(source, /normalizedQuery\.length < 3/u);
  assert.match(source, /role="combobox"/u);
  assert.match(source, /role="listbox"/u);
  assert.match(source, /aria-activedescendant/u);
  assert.match(source, /chosen\.loginId, normalizedTeacherAccessCode\(code\)/u);
  assert.match(source, /results\.length === 1 \? results\[0\]/u);
  assert.match(source, /JSON\.stringify\(\{ loginId, code \}\)/u);
  assert.match(source, /error\.status === 429/u);
  assert.match(source, /error\.status >= 500/u);
  assert.match(source, /Не вдалося увійти\. Перевірте обране ім’я та особистий код/u);
  assert.match(source, /autoComplete="one-time-code"/u);
  assert.match(source, /placeholder="4 цифри або XXXXX-XXXXX"/u);
  const client = await read("app/visits/visit-client.ts");
  assert.match(client, /teacherAccessCodeComplete/u);
  assert.match(client, /\^\\d\{4\}\$/u);
  assert.match(source, /!teacherAccessCodeComplete\(code\)/u);
  assert.match(source, /mustChangePin/u);
  assert.match(source, /teacher\.fullName/u);
  assert.match(source, /data\?\.classYears/u);
  assert.doesNotMatch(source, /name="classLabel"/u);
  assert.match(source, /maxLength=\{160\}/u);
  assert.match(source, /startTime,/u);
  assert.match(source, /endTime,/u);
  assert.match(source, /\/api\/visits\/teacher/u);
  assert.match(source, /method: "DELETE"/u);
  assert.match(source, /step=\{300\}/u);
  assert.match(source, /max=\{visitHorizonEnd\(today\)\}/u);
  assert.match(source, /setFieldErrors\(error\.fieldErrors\)/u);
  assert.match(source, /disabled=\{!bookingEnabled \|\| submitting \|\| Boolean\(pending\)\}/u);
  assert.doesNotMatch(source, /робочу email-адресу|surname:\s*[^,]+,/u);
  assert.match(source, /window\.sessionStorage/u);
  assert.doesNotMatch(source, /window\.localStorage/u);
  assert.match(source, /clearVisitPendingIntent\([\s\S]*session\.pendingScope/u);
  assert.match(source, /href=\{PUBLIC_CATALOG_URL\}/u);
});

test("uncertain teacher requests retain the exact request and payload", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const key = visitPendingKey("teacher", "0123456789abcdef");
  const intent = {
    kind: "create",
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    payload: {
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      date: "2026-09-10",
      startTime: "09:00",
      endTime: "09:30",
      publicDisplayConsent: true,
      purpose: null,
      classYearId: "CY-2026-7A",
    },
  };
  assert.equal(writeVisitPendingIntent(storage, key, intent), true);
  assert.deepEqual(readVisitPendingIntent(storage, key), intent);
  clearVisitPendingIntent(storage, key);
  assert.equal(readVisitPendingIntent(storage, key), null);
});

test("teacher availability query covers the complete server booking horizon", () => {
  assert.equal(teacherVisitsUrl("2026-09-10"), "/api/visits/teacher?from=2026-09-10&to=2026-12-09");
  assert.equal(teacherSearchUrl("  Шев  "), "/api/teacher/directory?q=%D0%A8%D0%B5%D0%B2");
  assert.equal(teacherSessionUrl, "/api/teacher/session");
  assert.deepEqual(
    busyPeriodParts({ startAt: "2026-09-10T10:00:00", endAt: "2026-09-10T10:30:00" }),
    { date: "2026-09-10", startTime: "10:00", endTime: "10:30" },
  );
  assert.equal(validVisitDuration("09:00", "09:20"), true);
  assert.equal(validVisitDuration("09:00", "09:15"), false);
  assert.equal(validVisitDuration("09:00", "13:05"), false);
  assert.equal(validVisitDuration("not-a-time", "10:00"), false);
});

test("ambiguous HTTP responses keep their durable visit intent", () => {
  assert.equal(isUncertainVisitFailure(new VisitApiError("timeout", 408, "")), true);
  assert.equal(isUncertainVisitFailure(new VisitApiError("too early", 425, "")), true);
  assert.equal(isUncertainVisitFailure(new VisitApiError("limited", 429, "booking_limit_reached")), false);
  assert.equal(isUncertainVisitFailure(new VisitApiError("limited", 429, "")), true);
  assert.equal(isUncertainVisitFailure(new VisitApiError("busy", 409, "slot_unavailable")), false);
  assert.equal(isUncertainVisitFailure(new VisitApiError("bad", 400, "validation_failed")), false);
  assert.equal(isUncertainVisitFailure(new VisitApiError("elapsed", 409, "visit_time_elapsed")), false);
  assert.equal(isUncertainVisitFailure(new VisitApiError("started", 409, "booking_not_cancellable")), false);
  assert.equal(isUncertainVisitFailure(new VisitApiError("revoked", 401, "teacher_access_revoked")), false);
  assert.equal(isUncertainVisitFailure(new VisitApiError("changed", 409, "request_version_conflict")), false);
  assert.equal(isUncertainVisitFailure(new VisitApiError("already read", 409, "notification_already_read")), false);
  assert.equal(isUncertainVisitFailure(new VisitApiError("running", 409, "mutation_in_progress")), true);
});

test("admin visit UI shows private fields only behind librarian authorization", async () => {
  const source = await read("app/librarian/visits/visit-admin-workspace.tsx");
  assert.match(source, /booking\.surname/u);
  assert.match(source, /booking\.classLabel/u);
  assert.match(source, /Непідтверджений гостьовий запис/u);
  assert.match(source, /Підтверджений учитель/u);
  assert.match(source, /booking\.ownerKind === "guest" \|\| booking\.identityVerified === false/u);
  assert.match(source, /\/api\/librarian\/visits/u);
  assert.match(source, /disabled=\{!writesEnabled \|\| data\?\.bookingEnabled !== true/u);
  const publicSource = await read("source/app.js");
  assert.doesNotMatch(publicSource, /booking\.surname/u);
});

test("site entry points link to protected booking and librarian schedule", async () => {
  const [home, workspace] = await Promise.all([
    read("app/page.tsx"),
    read("app/librarian/d1-workspace.tsx"),
  ]);
  assert.match(home, /href="\/teacher"/u);
  assert.match(workspace, /href="\/librarian\/visits"/u);
});

test("public app preserves only bounded date and time deep-link values", async () => {
  const source = await read("app/visits/page.tsx");
  const workspace = await read("app/visits/visit-booking-workspace.tsx");
  assert.match(source, /function boundedDate/u);
  assert.match(source, /function boundedTime/u);
  assert.match(source, /initialDate=\{boundedDate\(params\?\.date\)\}/u);
  assert.match(source, /initialStartTime=\{boundedTime\(params\?\.start\)\}/u);
  assert.match(source, /initialEndTime=\{boundedTime\(params\?\.end\)\}/u);
  assert.doesNotMatch(`${source}\n${workspace}`, /ownerId|user\.userId|ownerEmail/u);
  assert.match(workspace, /pendingScope=\{session\.pendingScope\}/u);
  assert.match(workspace, /visitPendingKey\("teacher", pendingScope\)/u);
});
