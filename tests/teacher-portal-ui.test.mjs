import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  clearPortalPendingIntent,
  formatTeacherAccessCode,
  mergePortalPageById,
  normalizedTeacherAccessCode,
  normalizedTeacherPin,
  publicVisitsUrl,
  readPortalPendingIntent,
  teacherAccessCodeComplete,
  teacherPinStrength,
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
  assert.match(teacherPage, /initialOrderMaterialId=\{boundedMaterialId\(params\?\.material\)\}/u);
  assert.match(teacherPage, /\^CAT-\\d\{4,\}\$/u);
  assert.match(visitsPage, /initialTab="visits"/u);
  assert.match(workspace, /initialDate=\{initialDate\}/u);
  assert.match(workspace, /initialStartTime=\{initialStartTime\}/u);
  assert.match(workspace, /initialEndTime=\{initialEndTime\}/u);
  assert.match(workspace, /initialOrderMaterialId=\{initialOrderMaterialId\}/u);
});

test("public teacher entry renders a privacy-limited schedule through the full 90 day horizon", async () => {
  const [workspace, client] = await Promise.all([
    read("app/visits/visit-booking-workspace.tsx"),
    read("app/visits/visit-client.ts"),
  ]);
  assert.match(workspace, /<PublicVisitSchedule/u);
  assert.match(workspace, /publicVisitsUrl\(range\[0\], range\.at\(-1\)/u);
  assert.match(workspace, /weekStart >= lastPublicWeekStart\(today\)/u);
  assert.match(workspace, /return visitDatesFromOffset\(visitHorizonEnd\(today\), -6\)/u);
  assert.match(workspace, /function bookableSlotStart/u);
  assert.match(workspace, /timeMinutes\(slot\.endTime\) - start >= 20/u);
  assert.match(workspace, /Графік відкритий для всіх без входу/u);
  assert.match(workspace, /Для підтверджених записів видно ім’я вчителя й точний час/u);
  assert.match(workspace, /Клас, мета візиту та контактні дані не публікуються/u);
  assert.match(workspace, /slot\.displayName \|\| "Заброньовано"/u);
  assert.match(workspace, /item\.identityVerified === false \? "Непідтверджений гостьовий запис" : item\.displayName/u);
  assert.match(workspace, /previous\.sourceKey === sourceKey/u);
  const publicBookingType = client.slice(client.indexOf("export type VisitPublicBooking"), client.indexOf("export type PublicVisitsEnvelope"));
  assert.match(publicBookingType, /date: string;[\s\S]*startTime: string;[\s\S]*endTime: string;[\s\S]*displayName: string;[\s\S]*identityVerified: boolean;/u);
  assert.doesNotMatch(publicBookingType, /\bid\b|class|purpose|email|owner/u);
  assert.doesNotMatch(workspace, /data\.bookings.*surname|data\.bookings.*purpose/u);
  assert.equal(publicVisitsUrl("2026-09-01", "2026-09-07"), "/api/visits/public?from=2026-09-01&to=2026-09-07");
  assert.equal(visitHorizonEnd("2026-09-01"), "2026-11-30");
  assert.doesNotMatch(workspace, /if \(checkingSession\) \{\s*return/u);
  assert.ok(workspace.indexOf("<PublicVisitSchedule") < workspace.indexOf("{checkingSession"), "public schedule must render before private session controls settle");
});

test("every guest and authenticated booking explicitly consents to the limited public display", async () => {
  const [workspace, client] = await Promise.all([
    read("app/visits/visit-booking-workspace.tsx"),
    read("app/visits/visit-client.ts"),
  ]);
  assert.match(client, /publicDisplayConsent: true;/u);
  assert.match(client, /publicDisplayConsent: boolean;/u);
  assert.match(workspace, /publicDisplayConsent: true/u);
  assert.match(workspace, /booking\.publicDisplayConsent === true/u);
  assert.match(workspace, /Я погоджуюся, що моє ім’я та точний час цього запису будуть видимі всім/u);
  assert.match(workspace, /Ім’я обраного вчителя, клас і мета візиту не публікуватимуться/u);
  assert.match(workspace, /checked=\{publicDisplayConsent\}/u);
  assert.match(workspace, /disabled=\{submitting \|\| !bookingEnabled \|\| !publicDisplayConsent/u);
  assert.match(workspace, /disabled=\{!selectedTeacher \|\| !publicDisplayConsent/u);
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
  assert.match(workspace, /currentCode: normalizedTeacherAccessCode\(currentCode\),[\s\S]*newPin: normalizedTeacherPin\(newPin\)/u);
  assert.match(workspace, /teacherPinStrength\(newPin\)/u);
  assert.match(workspace, /setNewPin\(normalizedTeacherPin\(event\.currentTarget\.value\)\)/u);
  assert.match(workspace, /setConfirmPin\(normalizedTeacherPin\(event\.currentTarget\.value\)\)/u);
  assert.match(workspace, /!teacherAccessCodeComplete\(currentCode\) \|\| !strength\.strong \|\| !pinsMatch/u);
  assert.doesNotMatch(workspace, /localStorage/u);
  assert.match(workspace, /mustChangePin/u);
  assert.match(workspace, /firstLoginCode/u);
  assert.match(workspace, /results\.length === 1/u);
  assert.match(workspace, /Оберіть своє ім’я у списку під полем/u);
  assert.match(workspace, /clearTeacherPortalPendingStorage\(window\.sessionStorage, pendingScope\)/u);
});

test("teacher can use a temporary code and choose a non-obvious four-digit PIN", () => {
  assert.equal(formatTeacherAccessCode("2a3b4c5d6e"), "2A3B4-C5D6E");
  assert.equal(normalizedTeacherAccessCode("2A3B4-C5D6E"), "2A3B4C5D6E");
  assert.equal(teacherAccessCodeComplete("2A3B4-C5D6E"), true);
  assert.equal(teacherAccessCodeComplete("4826"), true);
  assert.equal(normalizedTeacherAccessCode("10 29"), "1029");
  assert.equal(normalizedTeacherPin("48-26"), "4826");
  assert.equal(teacherPinStrength("4826").strong, true);
  assert.equal(teacherPinStrength("1111").strong, false);
  assert.equal(teacherPinStrength("1234").strong, false);
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
  assert.match(orders, /useState\(initialMaterialId\)/u);
  assert.match(orders, /response\.items\.find\(\(item\) => item\.id === initialMaterialId\)/u);
  assert.match(orders, /\[selected\.id\]: \{ item: selected, quantity: 1 \}/u);
  assert.match(orders, /currentQuantity >= item\.availableQuantity/u);
  assert.match(orders, /maximumInCart \? "У кошику" : cartQuantity > 0 \? "Додати ще" : "Додати"/u);
  assert.match(orders, /Кількість «\$\{item\.title\}» у кошику збільшено до \$\{nextQuantity\}/u);
  assert.match(orders, /Завантажити ще/u);
  assert.match(notifications, /params\.set\("cursor", cursor\)/u);
  assert.match(notifications, /mergePortalPageById\(current\.notifications, response\.notifications\)/u);
  assert.match(notifications, /data\.page\.nextCursor/u);
  assert.match(notifications, /Завантажити ще/u);
});

test("teacher cabinet shows personal and responsible-class loans from the signed-in identity", async () => {
  const [page, workspace, route] = await Promise.all([
    read("app/teacher/page.tsx"),
    read("app/visits/visit-booking-workspace.tsx"),
    read("app/api/teacher/loans/route.ts"),
  ]);
  assert.match(page, /value === "loans"/u);
  assert.match(workspace, /id: "loans", label: "Мої посібники"/u);
  assert.match(workspace, /function TeacherLoansPanel/u);
  assert.match(workspace, /"\/api\/teacher\/loans"/u);
  assert.match(workspace, /Особисто на вас/u);
  assert.match(workspace, /На класах/u);
  assert.match(route, /requireVisitTeacherSession\(db, request\)/u);
  assert.match(route, /teacherUserId: teacher\.teacherUserId/u);
  assert.match(route, /listOpenClassLoans/u);
  assert.doesNotMatch(route, /searchParams|get\("teacherUserId"\)/u);
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
  assert.match(inbox, /expectedAvailableQuantity: holdingAvailable\(holding\)/u);
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
  assert.match(html, /class="teacher-nav-link"[\s\S]*data-primary-section="teacher"/u);
  assert.match(html, /href="#visit-schedule"[^>]*>Графік<\/a>/u);
  assert.match(config, /\/teacher"/u);
  assert.match(css, /a:not\(\.teacher-nav-link\)\{display:none\}/u);
});

test("Telegram Mini App launch is bounded, signed server-side and stays on its framed cabinet route", async () => {
  const [page, cabinet, launch, route, activationRoute, validator, teacherAuth, workspace, telegramApi] = await Promise.all([
    read("app/teacher/telegram/page.tsx"),
    read("app/teacher/telegram/cabinet/page.tsx"),
    read("app/teacher/telegram/telegram-teacher-launch.tsx"),
    read("app/api/teacher/session/telegram/route.ts"),
    read("app/api/teacher/session/telegram/activate/route.ts"),
    read("lib/telegram-mini-app-auth.ts"),
    read("lib/visit-teacher-auth.ts"),
    read("app/visits/visit-booking-workspace.tsx"),
    read("lib/telegram-api.ts"),
  ]);
  assert.match(page, /boundedTab\(params\?\.tab\)/u);
  assert.match(page, /boundedMode\(params\?\.mode\)/u);
  assert.match(page, /robots: \{ index: false, follow: false \}/u);
  assert.match(launch, /window\.Telegram\?\.WebApp/u);
  assert.match(launch, /webApp\.initData/u);
  assert.doesNotMatch(launch, /initDataUnsafe/u);
  assert.doesNotMatch(launch, /fetch\("\/api\/teacher\/session"/u);
  assert.match(launch, /credentials: "same-origin"/u);
  assert.match(launch, /window\.location\.replace\(targetUrl\)/u);
  assert.match(launch, /payload\.onboardingRequired/u);
  assert.match(launch, /TelegramTeacherActivationForm/u);
  assert.match(launch, /teacherSearchUrl\(normalizedQuery\)/u);
  assert.match(launch, /\/api\/teacher\/session\/telegram\/activate/u);
  assert.match(launch, /requestId: crypto\.randomUUID\(\)/u);
  assert.match(launch, /intent: input\.intent/u);
  assert.match(launch, /🔑 Увійти/u);
  assert.match(launch, /✨ Активувати вперше/u);
  assert.match(launch, /Створіть власний 4-значний PIN/u);
  assert.match(launch, /Код і PIN вводьте лише/u);
  assert.match(launch, /activation\.mode === "connected" \? "Telegram підтверджено"/u);
  assert.doesNotMatch(launch, /role="option"[\s\S]{0,120}<button/u);
  assert.doesNotMatch(launch, /localStorage|sessionStorage|URLSearchParams\([^)]*(?:code|pin)|console\./iu);
  assert.match(launch, /\/teacher\/telegram\/cabinet\?tab=/u);
  assert.match(cabinet, /telegramMiniApp/u);
  assert.match(route, /readVisitJson\(request\)/u);
  assert.match(route, /validateTelegramMiniAppInitData/u);
  assert.match(route, /createVisitTeacherTelegramSession/u);
  assert.match(route, /onboardingRequired: true/u);
  assert.match(route, /onboardingRequired: false/u);
  assert.match(route, /isSameOriginRequest\(request\)/u);
  assert.match(route, /telegramTeacherSessionCookie\(result\.token\)/u);
  assert.match(teacherAuth, /SameSite=None; Partitioned/u);
  assert.match(teacherAuth, /VISIT_TEACHER_TELEGRAM_COOKIE/u);
  assert.match(activationRoute, /isSameOriginRequest\(request\)/u);
  assert.match(activationRoute, /expectedKeys = \["initData", "requestId", "intent", "loginId", "code", "newPin"\]/u);
  assert.match(activationRoute, /body\.value\.intent !== "login"/u);
  assert.match(activationRoute, /validateTelegramMiniAppInitData/u);
  assert.match(activationRoute, /activateVisitTeacherTelegramSession/u);
  assert.match(activationRoute, /telegramTeacherSessionCookie\(result\.token\)/u);
  assert.match(validator, /crypto\.subtle\.verify/u);
  assert.match(validator, /authTimeMs > nowMs/u);
  assert.match(validator, /nowMs - authTimeMs/u);
  assert.match(workspace, /visibilitychange/u);
  assert.match(workspace, /Я вже підключив\(ла\) — перевірити/u);
  assert.match(workspace, /const notificationsOn = Boolean\(telegram\?\.notifyOrders \|\| telegram\?\.notifyVisits\)/u);
  assert.match(workspace, /🔕 Вимкнути сповіщення/u);
  assert.match(workspace, /🔔 Увімкнути сповіщення/u);
  assert.match(workspace, /confirmation: "disconnect_telegram"/u);
  assert.match(workspace, /Так, від’єднати/u);
  assert.doesNotMatch(workspace, /teacher-telegram-orders|teacher-telegram-visits/u);
  assert.match(workspace, /teacherEntryPath/u);
  assert.match(telegramApi, /exactKeys\(value, \["confirmation", "expectedVersion"\]\)/u);
  assert.match(telegramApi, /value\.confirmation !== "disconnect_telegram"/u);
  assert.match(telegramApi, /confirmation: "disconnect_telegram"/u);
});

test("teacher profile shows assigned information and keeps photo access private and same-origin", async () => {
  const [workspace, profileRoute, photoRoute, store, librarianRoute, librarianWorkspace] = await Promise.all([
    read("app/visits/visit-booking-workspace.tsx"),
    read("app/api/teacher/profile/route.ts"),
    read("app/api/teacher/profile/photo/route.ts"),
    read("lib/teacher-profile-store.ts"),
    read("app/api/librarian/teachers/[id]/photo/route.ts"),
    read("app/librarian/teachers/teacher-management-workspace.tsx"),
  ]);
  assert.match(workspace, /Підтверджений профіль/u);
  assert.match(workspace, /Предмет \/ посада/u);
  assert.match(workspace, /Куратор класу/u);
  assert.match(workspace, /Зробити фото/u);
  assert.match(workspace, /Обрати з галереї/u);
  assert.match(workspace, /normalizeCoverPhotoForUpload/u);
  assert.match(profileRoute, /requireVisitTeacherSession\(db, request\)/u);
  assert.match(photoRoute, /requireVisitTeacherSession\(db, request\)/u);
  assert.equal((photoRoute.match(/isSameOriginRequest\(request\)/gu) ?? []).length, 2);
  assert.match(photoRoute, /"Cache-Control": "private/u);
  assert.match(store, /WHERE u\.id=\? AND u\.status='active' AND p\.closed_at IS NULL/u);
  assert.match(store, /teacher-photos\/\$\{safeTeacherKey/u);
  assert.match(librarianRoute, /authorizeTeacherRegistryRead/u);
  assert.match(librarianWorkspace, /teacher\.photoUrl/u);
});

test("librarian Telegram Mini App revalidates D1 role and keeps cabinet navigation in Mini App", async () => {
  const [page, cabinet, launch, route, auth, api, visits, teachers, worker] = await Promise.all([
    read("app/librarian/telegram/page.tsx"),
    read("app/librarian/telegram/cabinet/page.tsx"),
    read("app/librarian/telegram/telegram-librarian-launch.tsx"),
    read("app/api/librarian/session/telegram/route.ts"),
    read("lib/librarian-telegram-auth.ts"),
    read("lib/librarian-api.ts"),
    read("app/librarian/visits/visit-admin-workspace.tsx"),
    read("app/librarian/teachers/teacher-management-workspace.tsx"),
    read("worker/index.ts"),
  ]);
  assert.match(page, /boundedTarget\(params\?\.target\)/u);
  assert.match(page, /robots: \{ index: false, follow: false \}/u);
  assert.match(launch, /window\.Telegram\?\.WebApp/u);
  assert.match(launch, /webApp\.initData/u);
  assert.doesNotMatch(launch, /initDataUnsafe|localStorage|sessionStorage|console\./u);
  assert.match(route, /validateTelegramMiniAppInitData/u);
  assert.match(route, /isSameOriginRequest\(request\)/u);
  assert.match(auth, /u\.role IN \('admin','librarian'\)/u);
  assert.match(auth, /isLibrarianEmailAllowed/u);
  assert.match(auth, /telegram_mini_app_auth_receipts/u);
  assert.match(auth, /SameSite=None; Partitioned/u);
  assert.match(api, /readLibrarianTelegramUser/u);
  assert.equal((cabinet.match(/telegramMiniApp/gu) ?? []).length >= 3, true);
  assert.match(visits, /target=teachers/u);
  assert.match(teachers, /target=visits/u);
  assert.match(worker, /url\.pathname\.startsWith\("\/librarian\/telegram\/"\)/u);
});
