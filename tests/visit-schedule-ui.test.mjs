import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  busyPeriodParts,
  clearVisitPendingIntent,
  readVisitPendingIntent,
  visitPendingKey,
  teacherVisitsUrl,
  isUncertainVisitFailure,
  VisitApiError,
  validVisitDuration,
  writeVisitPendingIntent,
} from "../app/visits/visit-client.ts";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("protected teacher and librarian pages use SIWC server guards", async () => {
  const [teacher, librarian] = await Promise.all([
    read("app/visits/page.tsx"),
    read("app/librarian/visits/page.tsx"),
  ]);
  assert.match(teacher, /const user = await requireChatGPTUser\(returnTo\)/u);
  assert.match(teacher, /`\/visits\?\$\{query\.toString\(\)\}`/u);
  assert.match(teacher, /async function AuthenticatedVisits/u);
  assert.match(teacher, /dynamic = "force-dynamic"/u);
  assert.match(librarian, /requireChatGPTUser\("\/librarian\/visits"\)/u);
  assert.match(librarian, /getLibrarianAccess\(user\)/u);
  assert.match(librarian, /if \(!access\.allowed\)/u);
});

test("teacher booking UI collects bounded identity and uses only active class options", async () => {
  const source = await read("app/visits/visit-booking-workspace.tsx");
  assert.match(source, /autoComplete="family-name"/u);
  assert.match(source, /required maxLength=\{80\}/u);
  assert.match(source, /data\?\.classYears/u);
  assert.doesNotMatch(source, /name="classLabel"/u);
  assert.match(source, /maxLength=\{160\}/u);
  assert.match(source, /startTime,/u);
  assert.match(source, /endTime,/u);
  assert.match(source, /\/api\/visits\/teacher/u);
  assert.match(source, /method: "DELETE"/u);
  assert.match(source, /step=\{300\}/u);
  assert.match(source, /max=\{visitHorizonEnd\(today\)\}/u);
  assert.match(source, /aria-invalid=\{Boolean\(fieldErrors\.surname\)\}/u);
  assert.match(source, /setFieldErrors\(error\.fieldErrors\)/u);
  assert.match(source, /disabled=\{!bookingEnabled \|\| submitting \|\| Boolean\(pending\)\}/u);
  assert.match(source, /додати вашу робочу email-адресу/u);
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
      surname: "Шевченко",
      date: "2026-09-10",
      startTime: "09:00",
      endTime: "09:30",
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
});

test("admin visit UI shows private fields only behind librarian authorization", async () => {
  const source = await read("app/librarian/visits/visit-admin-workspace.tsx");
  assert.match(source, /booking\.surname/u);
  assert.match(source, /booking\.classLabel/u);
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
  assert.match(home, /href="\/visits"/u);
  assert.match(workspace, /href="\/librarian\/visits"/u);
});

test("SIWC return path accepts only bounded date and time query values", async () => {
  const source = await read("app/visits/page.tsx");
  assert.match(source, /function boundedDate/u);
  assert.match(source, /function boundedTime/u);
  assert.doesNotMatch(source, /ownerId=\{user\.userId\}/u);
  assert.doesNotMatch(await read("app/visits/visit-booking-workspace.tsx"), /ownerId/u);
  assert.match(source, /pendingScope=\{await visitPendingScope\(user\.userId\)\}/u);
  assert.match(source, /crypto\.subtle\.digest\("SHA-256"/u);
  assert.doesNotMatch(source, /pendingScope=\{user\.userId\}/u);
});
