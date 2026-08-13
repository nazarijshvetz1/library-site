import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  clearPortalPendingIntent,
  formatPersonalCode,
  mergePortalPageById,
  normalizedPersonalCode,
  personalCodeStrength,
  publicVisitsUrl,
  readPortalPendingIntent,
  visitHorizonEnd,
  writePortalPendingIntent,
} from "../app/visits/visit-client.ts";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("teacher cabinet is the primary route and legacy visits keeps bounded deep links", async () => {
  const [teacherPage, visitsPage, workspace] = await Promise.all([
    read("app/teacher/page.tsx"),
    read("app/visits/page.tsx"),
    read("app/visits/visit-booking-workspace.tsx"),
  ]);
  assert.match(teacherPage, /title: "Кабінет учителя"/u);
  assert.match(teacherPage, /initialTab=\{boundedTab\(params\?\.tab\)\}/u);
  assert.match(visitsPage, /initialTab="visits"/u);
  assert.match(workspace, /initialDate=\{initialDate\}/u);
  assert.match(workspace, /initialStartTime=\{initialStartTime\}/u);
  assert.match(workspace, /initialEndTime=\{initialEndTime\}/u);
});

test("public teacher entry renders PII-free schedule through the full 90 day horizon", async () => {
  const workspace = await read("app/visits/visit-booking-workspace.tsx");
  assert.match(workspace, /<PublicVisitSchedule/u);
  assert.match(workspace, /publicVisitsUrl\(range\[0\], range\.at\(-1\)/u);
  assert.match(workspace, /weekStart >= lastPublicWeekStart\(today\)/u);
  assert.match(workspace, /return visitDatesFromOffset\(visitHorizonEnd\(today\), -6\)/u);
  assert.match(workspace, /function bookableSlotStart/u);
  assert.match(workspace, /timeMinutes\(slot\.endTime\) - start >= 20/u);
  assert.match(workspace, /Імена, класи й мета відвідувань тут не публікуються/u);
  assert.doesNotMatch(workspace, /data\.bookings.*surname|data\.bookings.*purpose/u);
  assert.equal(publicVisitsUrl("2026-09-01", "2026-09-07"), "/api/visits/public?from=2026-09-01&to=2026-09-07");
  assert.equal(visitHorizonEnd("2026-09-01"), "2026-11-30");
  assert.doesNotMatch(workspace, /if \(checkingSession\) \{\s*return/u);
  assert.ok(workspace.indexOf("<PublicVisitSchedule") < workspace.indexOf("{checkingSession"), "public schedule must render before private session controls settle");
});

test("guest booking is explicitly unverified, canonical, controlled, and retry-safe", async () => {
  const workspace = await read("app/visits/visit-booking-workspace.tsx");
  assert.match(workspace, /Особу не підтверджено/u);
  assert.match(workspace, /\/api\/visits\/guest\/directory/u);
  assert.match(workspace, /guestTeacherKeyDown/u);
  assert.match(workspace, /aria-activedescendant=\{activeTeacherIndex/u);
  assert.match(workspace, /teacherRef: selectedTeacher\.teacherRef/u);
  assert.doesNotMatch(workspace, /surname:/u);
  assert.match(workspace, /VISIT_PURPOSES\.map/u);
  assert.match(workspace, /const method = intent\.kind === "guest-create" \? "POST" : intent\.kind === "guest-patch" \? "PATCH" : "DELETE"/u);
  assert.match(workspace, /library\.guest\.pending\.v1:\$\{active\.guest\.pendingScope\}/u);
  assert.doesNotMatch(workspace, /library\.guest.*localStorage/u);
  const guestPanel = workspace.slice(workspace.indexOf("function GuestBookingPanel"), workspace.indexOf("function TeacherSignIn"));
  const activation = guestPanel.indexOf("async function activateGuestBooking");
  assert.ok(activation > 0);
  assert.doesNotMatch(guestPanel.slice(0, activation), /\/api\/visits\/guest\/session/u);
  assert.match(guestPanel, /Записатися без коду/u);
  assert.match(guestPanel, /onClick=\{\(\) => void activateGuestBooking\(\)\}/u);
  assert.match(guestPanel, /window\.setTimeout\(\(\) => teacherSearchRef\.current\?\.focus\(\), 0\)/u);
  const endSession = guestPanel.slice(guestPanel.indexOf("async function endGuestSession"), guestPanel.indexOf("function resetGuestForm"));
  assert.match(endSession, /\/api\/visits\/guest\/session", \{ method: "DELETE" \}/u);
  assert.match(endSession, /clearPortalPendingIntent\(window\.sessionStorage, storageKey\)/u);
  assert.match(endSession, /setSession\(null\)/u);
  assert.match(endSession, /setData\(null\)/u);
  assert.match(endSession, /setActivated\(false\)/u);
  assert.doesNotMatch(endSession, /activateGuestBooking\(/u);
  assert.match(guestPanel, /Завершити гостьовий сеанс/u);
  assert.match(guestPanel, /Працюєте на спільному пристрої/u);
});

test("authenticated teacher workflows use frozen routes and exact request fields", async () => {
  const workspace = await read("app/visits/visit-booking-workspace.tsx");
  assert.match(workspace, /method: "PATCH"/u);
  assert.match(workspace, /expectedVersion: editingBooking\.version/u);
  assert.match(workspace, /\/api\/teacher\/material-requests/u);
  assert.match(workspace, /materialId: item\.id, quantity/u);
  assert.match(workspace, /cartRows\.length >= 10/u);
  assert.match(workspace, /\/api\/teacher\/notifications/u);
  assert.match(workspace, /expectedVersion: notification\.version, read: true/u);
  assert.match(workspace, /\/api\/teacher\/security\/code/u);
  assert.match(workspace, /currentCode: normalizedPersonalCode\(currentCode\), newCode: normalizedPersonalCode\(newCode\)/u);
  assert.match(workspace, /strongPersonalCode/u);
  assert.match(workspace, /setNewCode\(formatPersonalCode\(event\.currentTarget\.value\)\)/u);
  assert.match(workspace, /setConfirmNewCode\(formatPersonalCode\(event\.currentTarget\.value\)\)/u);
  assert.match(workspace, /!strength\.strong \|\| !codesMatch/u);
  assert.doesNotMatch(workspace, /<input required readOnly type="text" value=\{newCode\}/u);
  assert.match(workspace, /clearTeacherPortalPendingStorage\(window\.sessionStorage, pendingScope\)/u);
  assert.doesNotMatch(workspace, /localStorage/u);
});

test("teacher can enter and submit a custom strong personal code", () => {
  const custom = "2A3B4-C5D6E";
  assert.equal(formatPersonalCode("2a3b4c5d6e"), custom);
  assert.equal(normalizedPersonalCode(custom), "2A3B4C5D6E");
  assert.equal(personalCodeStrength(custom).strong, true);
  assert.equal(personalCodeStrength("AAAAA-AAAAA").strong, false);
  assert.equal(personalCodeStrength("23456-789AB").strong, false);
});

test("authoritative Sites suite includes teacher portal UI coverage", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  assert.match(packageJson.scripts["test:sites"], /tests\/teacher-portal-ui\.test\.mjs/u);
  assert.match(packageJson.scripts.test, /test:catalog.*test:sites/u);
});

test("portal mutation recovery preserves exact requestId and payload in session storage", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const intent = {
    kind: "order-create",
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    payload: {
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      notes: null,
      items: [{ materialId: "CAT-1", quantity: 2 }],
    },
  };
  assert.equal(writePortalPendingIntent(storage, "teacher-scope", intent), true);
  assert.deepEqual(readPortalPendingIntent(storage, "teacher-scope", ["order-create"]), intent);
  clearPortalPendingIntent(storage, "teacher-scope");
  assert.equal(readPortalPendingIntent(storage, "teacher-scope", ["order-create"]), null);
});

test("opaque cursor pages append without duplicate portal records", () => {
  const first = [
    { id: "MR-1", version: 1 },
    { id: "MR-2", version: 1 },
  ];
  const merged = mergePortalPageById(first, [
    { id: "MR-2", version: 2 },
    { id: "MR-3", version: 1 },
  ]);
  assert.deepEqual(merged, [
    { id: "MR-1", version: 1 },
    { id: "MR-2", version: 2 },
    { id: "MR-3", version: 1 },
  ]);
});

test("teacher orders and notifications page with the frozen opaque cursor", async () => {
  const workspace = await read("app/visits/visit-booking-workspace.tsx");
  const orders = workspace.slice(workspace.indexOf("function TeacherOrdersPanel"), workspace.indexOf("function TeacherCover"));
  const notifications = workspace.slice(workspace.indexOf("function TeacherNotificationsPanel"), workspace.indexOf("type CodeRotationEnvelope"));
  assert.match(orders, /params\.set\("cursor", cursor\)/u);
  assert.match(orders, /mergePortalPageById\(current, response\.requests\)/u);
  assert.match(orders, /requestPage\.nextCursor/u);
  assert.match(orders, /Завантажити ще/u);
  assert.match(notifications, /params\.set\("cursor", cursor\)/u);
  assert.match(notifications, /mergePortalPageById\(current\.notifications, response\.notifications\)/u);
  assert.match(notifications, /data\.page\.nextCursor/u);
  assert.match(notifications, /Завантажити ще/u);
});

test("librarian request inbox uses frozen ready fields and public active pickup locations", async () => {
  const [workspace, inbox] = await Promise.all([
    read("app/librarian/visits/visit-admin-workspace.tsx"),
    read("app/librarian/visits/material-request-inbox.tsx"),
  ]);
  assert.match(workspace, /<MaterialRequestInbox pendingScope=\{pendingScope\} writesEnabled=\{writesEnabled\} \/>/u);
  assert.match(inbox, /\/api\/librarian\/material-requests\/locations/u);
  assert.match(inbox, /action: "ready", pickupLocationId, dueAt: dueAt \|\| null, items/u);
  assert.match(inbox, /itemId: item\.id/u);
  assert.match(inbox, /sourceLocationId: holding\.locationId/u);
  assert.match(inbox, /expectedAvailableQuantity: holding\.quantity/u);
  assert.match(inbox, /window\.sessionStorage/u);
  assert.doesNotMatch(inbox, /window\.localStorage/u);
  assert.match(inbox, /params\.set\("cursor", cursor\)/u);
  assert.match(inbox, /mergePortalPageById\(current\.requests, requestResponse\.requests\)/u);
  assert.match(inbox, /data\.page\.nextCursor/u);
  assert.match(inbox, /Завантажити ще/u);
});

test("public catalog navigation names the cabinet while preserving explicit schedule discovery", async () => {
  const [html, config, css] = await Promise.all([
    read("source/index.html"),
    read("source/config.js"),
    read("source/styles.css"),
  ]);
  assert.match(html, />Кабінет учителя<\/a>/u);
  assert.match(html, /href="#visit-schedule"[^>]*>Графік<\/a>/u);
  assert.match(config, /\/teacher"/u);
  assert.match(css, /a:not\(\.teacher-nav-link\)\{display:none\}/u);
});
