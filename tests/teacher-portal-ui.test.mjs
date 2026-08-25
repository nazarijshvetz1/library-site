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
  teacherOrderQuantityEdit,
  teacherPinStrength,
  visitHorizonEnd,
  writePortalPendingIntent,
} from "../app/visits/visit-client.ts";
import { finishTelegramLogin } from "../app/teacher/telegram/telegram-login-finish.ts";

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
  const [workspace, acquisitionPanel, css] = await Promise.all([
    read("app/visits/visit-booking-workspace.tsx"),
    read("app/teacher/acquisition/teacher-acquisition-panel.tsx"),
    read("app/visits/visits.module.css"),
  ]);
  assert.match(workspace, /method: "PATCH"/u);
  assert.match(workspace, /expectedVersion: editingBooking\.version/u);
  assert.match(workspace, /\/api\/teacher\/material-requests/u);
  assert.match(workspace, /materialId: item\.id, quantity/u);
  assert.match(workspace, /cartRows\.length >= 10/u);
  assert.match(workspace, /\/api\/teacher\/notifications/u);
  assert.match(workspace, /expectedVersion: notification\.version, read: true/u);
  assert.match(workspace, /kind: "notification-delete"/u);
  assert.match(workspace, /method: intent\.kind === "notification-read" \? "PATCH" : "DELETE"/u);
  assert.match(workspace, /expectedVersion: notification\.version/u);
  assert.match(workspace, /\/api\/teacher\/security\/code/u);
  assert.match(workspace, /currentCode: normalizedCurrentCode,[\s\S]*newPin: normalizedNewPin/u);
  assert.match(workspace, /teacherPinStrength\(newPin\)/u);
  assert.match(workspace, /setNewPin\(normalizedTeacherPin\(event\.currentTarget\.value\)\)/u);
  assert.match(workspace, /setConfirmPin\(normalizedTeacherPin\(event\.currentTarget\.value\)\)/u);
  assert.match(workspace, /!currentCodeComplete \|\| !strength\.strong \|\| !pinDiffersFromCurrent \|\| !pinsMatch/u);
  assert.match(workspace, /pinDiffersFromCurrent = strength\.complete && normalizedNewPin !== normalizedCurrentCode/u);
  assert.match(workspace, /Можна використати будь-які 4 цифри, але новий PIN має відрізнятися/u);
  assert.match(workspace, /aria-describedby="current-code-help"/u);
  assert.match(workspace, /id="current-code-help" aria-live="polite" aria-atomic="true"/u);
  assert.match(workspace, /Потрібно рівно 4 цифри або повний старий 10-символьний код/u);
  assert.doesNotMatch(workspace, /Не чотири однакові цифри|Не проста послідовність/u);
  assert.doesNotMatch(workspace, /localStorage/u);
  assert.match(workspace, /mustChangePin/u);
  assert.match(workspace, /firstLoginCode/u);
  assert.match(workspace, /results\.length === 1/u);
  assert.match(workspace, /Оберіть своє ім’я у списку під полем/u);
  assert.match(workspace, /clearTeacherPortalPendingStorage\(window\.sessionStorage, pendingScope\)/u);
  assert.equal((workspace.match(/return "Запропонувати придбання"/gu) ?? []).length, 1);
  assert.doesNotMatch(acquisitionPanel, /acquisition-teacher-title|<h2[^>]*>Запропонувати придбання<\/h2>/u);
  assert.match(acquisitionPanel, /aria-label="Комплектування фонду"/u);
  assert.match(css, /\.teacherPortalContent \.card\.overviewActionCard \{ min-height: 220px; padding-top: 72px; \}/u);
  assert.match(css, /\.securityDialog \.generatedCode \{ display: grid; grid-template-columns: minmax\(0,1fr\) auto;/u);
  assert.match(css, /\.securityDialog \.generatedCode input \{ min-height: 50px; height: 50px; flex: none; \}/u);
});

test("teacher can use a temporary code and choose any four-digit PIN", () => {
  assert.equal(formatTeacherAccessCode("2a3b4c5d6e"), "2A3B4-C5D6E");
  assert.equal(normalizedTeacherAccessCode("2A3B4-C5D6E"), "2A3B4C5D6E");
  assert.equal(teacherAccessCodeComplete("2A3B4-C5D6E"), true);
  assert.equal(teacherAccessCodeComplete("4826"), true);
  assert.equal(normalizedTeacherAccessCode("10 29"), "1029");
  assert.equal(normalizedTeacherPin("48-26"), "4826");
  assert.equal(teacherPinStrength("4826").strong, true);
  assert.equal(teacherPinStrength("1111").strong, true);
  assert.equal(teacherPinStrength("1212").strong, true);
  assert.equal(teacherPinStrength("1122").strong, true);
  assert.equal(teacherPinStrength("1234").strong, true);
  assert.equal(teacherPinStrength("123").strong, false);
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
  assert.doesNotMatch(orders, /Number\(event\.currentTarget\.value\)/u);
  assert.match(orders, /quantityDrafts\[item\.id\] \?\? String\(quantity\)/u);
  assert.match(orders, /onBlur=\{\(\) => finishQuantityEdit\(item\.id\)\}/u);
  assert.match(orders, /onClick=\{\(\) => removeFromCart\(item\.id\)\}/u);
  assert.match(orders, /Завантажити ще/u);
  assert.match(notifications, /params\.set\("cursor", cursor\)/u);
  assert.match(notifications, /mergePortalPageById\(current\.notifications, response\.notifications\)/u);
  assert.match(notifications, /data\.page\.nextCursor/u);
  assert.match(notifications, /Завантажити ще/u);
});

test("teacher cart keeps its quantity field mounted through the empty mobile edit state", () => {
  assert.deepEqual(teacherOrderQuantityEdit(1, "", 54), { draft: "", quantity: 1 });
  assert.deepEqual(teacherOrderQuantityEdit(1, "2", 54), { draft: "2", quantity: 2 });
  assert.deepEqual(teacherOrderQuantityEdit(2, "0", 54), { draft: "0", quantity: 2 });
  assert.deepEqual(teacherOrderQuantityEdit(2, "2.5", 54), { draft: "2.5", quantity: 2 });
  assert.deepEqual(teacherOrderQuantityEdit(2, "99", 54), { draft: "54", quantity: 54 });
});

test("teacher cabinet exposes Telegram as a separate highlighted connection area", async () => {
  const [page, miniPage, routes, launch, workspace, css] = await Promise.all([
    read("app/teacher/page.tsx"),
    read("app/teacher/telegram/cabinet/page.tsx"),
    read("app/teacher/_components/teacher-routes.ts"),
    read("app/teacher/telegram/telegram-teacher-launch.tsx"),
    read("app/visits/visit-booking-workspace.tsx"),
    read("app/visits/visits.module.css"),
  ]);
  assert.match(page, /boundedTeacherTab\(value\)/u);
  assert.match(miniPage, /boundedTeacherTab\(value\)/u);
  assert.match(routes, /"telegram"/u);
  assert.match(launch, /type TeacherTab = [^;]*"telegram"/u);
  assert.match(workspace, /id: "telegram", label: "Telegram", shortLabel: "Telegram", icon: "telegram"/u);
  assert.match(workspace, /activeTab === "telegram" \? <TeacherTelegramSettings \/>/u);
  assert.match(workspace, /data-telegram=\{tab\.id === "telegram" \|\| undefined\}/u);
  assert.match(workspace, /teacher-telegram-connection-title/u);
  assert.match(workspace, /teacher-telegram-notifications-title/u);
  assert.match(workspace, /Підключити Telegram/u);
  assert.match(workspace, /Сповіщення Telegram/u);
  assert.match(workspace, /role="status" aria-live="polite"/u);
  assert.match(css, /teacherTabs button\[data-telegram="true"\]/u);
  assert.match(css, /telegramSettingsStack/u);
});

test("teacher cabinet shows personal and responsible-class loans from the signed-in identity", async () => {
  const [page, routes, workspace, route] = await Promise.all([
    read("app/teacher/page.tsx"),
    read("app/teacher/_components/teacher-routes.ts"),
    read("app/visits/visit-booking-workspace.tsx"),
    read("app/api/teacher/loans/route.ts"),
  ]);
  assert.match(page, /boundedTeacherTab\(value\)/u);
  assert.match(routes, /"loans"/u);
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
    read("app/librarian/teachers/teacher-management-workspace.tsx"),
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

test("Telegram Mini App launch is bounded, signed server-side and returns to chat after login", async () => {
  const [page, cabinet, launch, route, activationRoute, menuRoute, validator, teacherAuth, workspace, telegramApi] = await Promise.all([
    read("app/teacher/telegram/page.tsx"),
    read("app/teacher/telegram/cabinet/page.tsx"),
    read("app/teacher/telegram/telegram-teacher-launch.tsx"),
    read("app/api/teacher/session/telegram/route.ts"),
    read("app/api/teacher/session/telegram/activate/route.ts"),
    read("app/api/teacher/session/telegram/menu/route.ts"),
    read("lib/telegram-mini-app-auth.ts"),
    read("lib/visit-teacher-auth.ts"),
    read("app/visits/visit-booking-workspace.tsx"),
    read("lib/telegram-api.ts"),
  ]);
  assert.match(page, /boundedTab\(params\?\.tab\)/u);
  assert.match(page, /initialOrderMaterialId=\{boundedMaterialId\(params\?\.material\)\}/u);
  assert.match(page, /boundedMode\(params\?\.mode\)/u);
  assert.match(page, /returnToChat=\{launchMode !== null\}/u);
  assert.match(page, /robots: \{ index: false, follow: false \}/u);
  assert.match(launch, /window\.Telegram\?\.WebApp/u);
  assert.match(launch, /pinDiffersFromCode = !requiresCode \|\| \(pinStatus\.complete && normalizedPin !== normalizedCode\)/u);
  assert.match(launch, /webApp\.initData/u);
  assert.doesNotMatch(launch, /initDataUnsafe/u);
  assert.doesNotMatch(launch, /fetch\("\/api\/teacher\/session"/u);
  assert.match(launch, /credentials: "same-origin"/u);
  assert.match(launch, /close\?\(\): void/u);
  assert.match(launch, /refreshTelegramMenu\(\)/u);
  assert.match(launch, /\/api\/teacher\/session\/telegram\/menu/u);
  assert.match(launch, /finishTelegramLoginInBrowser/u);
  assert.match(launch, /window\.location\.replace\(url\)/u);
  assert.match(launch, /payload\.onboardingRequired/u);
  assert.match(launch, /TelegramTeacherActivationForm/u);
  assert.match(launch, /teacherSearchUrl\(normalizedQuery\)/u);
  assert.match(launch, /\/api\/teacher\/session\/telegram\/activate/u);
  assert.match(launch, /requestId: crypto\.randomUUID\(\)/u);
  assert.match(launch, /intent: input\.intent/u);
  assert.match(launch, /🔑 Увійти/u);
  assert.match(launch, /✨ Активувати вперше/u);
  assert.match(launch, /Створіть власний 4-значний PIN/u);
  assert.match(launch, /const requiresCode = activation\.requiresCode/u);
  assert.match(launch, /requiresCode \? <div className=\{styles\.fieldGroup\}/u);
  assert.match(launch, /code: requiresCode \? normalizedCode : ""/u);
  assert.match(launch, /QR підтвердив особу/u);
  assert.match(launch, /Тимчасовий код не потрібен/u);
  assert.match(launch, /activation\.purpose === "pin_reset" \? "Замінити PIN" : "Створити PIN"/u);
  assert.match(launch, /Завершити реєстрацію/u);
  assert.match(launch, /Можна використати будь-які 4 цифри, але новий PIN має відрізнятися/u);
  assert.match(launch, /aria-describedby=\{`\$\{listId\}-code-help`\}/u);
  assert.match(launch, /Введіть рівно 4 цифри чинного PIN/u);
  assert.doesNotMatch(launch, /Не використовуйте 1111|без повторів і простих послідовностей/u);
  assert.match(launch, /Код і PIN вводьте лише/u);
  assert.match(launch, /activation\.mode === "connected" \? "Telegram підтверджено"/u);
  assert.doesNotMatch(launch, /role="option"[\s\S]{0,120}<button/u);
  assert.doesNotMatch(launch, /localStorage|sessionStorage|URLSearchParams\([^)]*(?:code|pin)|console\./iu);
  assert.match(launch, /teacherTelegramCabinetHref\(targetTab, initialOrderMaterialId\)/u);
  assert.match(cabinet, /telegramMiniApp/u);
  assert.match(route, /readVisitJson\(request\)/u);
  assert.match(route, /validateTelegramMiniAppInitData/u);
  assert.match(route, /createVisitTeacherTelegramSession/u);
  assert.doesNotMatch(route, /returnToChat|refreshConnectedTeacherTelegramMenu|menuRefreshed/u);
  assert.match(route, /onboardingRequired: true/u);
  assert.match(route, /purpose: result\.purpose/u);
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
  assert.doesNotMatch(activationRoute, /refreshConnectedTeacherTelegramMenu|menuRefreshed/u);
  assert.match(activationRoute, /telegramTeacherSessionCookie\(result\.token\)/u);
  assert.match(menuRoute, /requireVisitTeacherSession\(db, request\)/u);
  assert.match(menuRoute, /refreshConnectedTeacherTelegramMenu/u);
  assert.match(menuRoute, /menuMessageDelivered/u);
  assert.match(menuRoute, /isSameOriginRequest\(request\)/u);
  assert.match(validator, /crypto\.subtle\.verify/u);
  assert.match(validator, /authTimeMs > nowMs/u);
  assert.match(validator, /nowMs - authTimeMs/u);
  assert.match(workspace, /visibilitychange/u);
  assert.match(workspace, /Я вже підключив\(ла\) — перевірити/u);
  assert.match(workspace, /const notificationsOn = Boolean\(telegram\?\.notifyOrders \|\| telegram\?\.notifyVisits\)/u);
  assert.match(workspace, /name=\{notificationsOn \? "bell-off" : "notifications"\}/u);
  assert.match(workspace, /notificationsOn \? "Вимкнути сповіщення" : "Увімкнути сповіщення"/u);
  assert.match(workspace, /confirmation: "disconnect_telegram"/u);
  assert.match(workspace, /Так, від’єднати/u);
  assert.doesNotMatch(workspace, /teacher-telegram-orders|teacher-telegram-visits/u);
  assert.match(workspace, /teacherEntryPath/u);
  assert.match(telegramApi, /exactKeys\(value, \["confirmation", "expectedVersion"\]\)/u);
  assert.match(telegramApi, /value\.confirmation !== "disconnect_telegram"/u);
  assert.match(telegramApi, /confirmation: "disconnect_telegram"/u);
});

test("Telegram login close failures always fall back to an authenticated cabinet", () => {
  const calls = [];
  const scheduled = [];
  const schedule = (callback, delayMs) => {
    scheduled.push({ callback, delayMs });
    return 41;
  };
  const cancel = (timerId) => calls.push(["cancel", timerId]);
  const navigate = (url) => calls.push(["navigate", url]);

  assert.equal(finishTelegramLogin(
    { close: () => calls.push(["close"]) }, true, true, "/cabinet", navigate, schedule, cancel,
  ), "closed");
  assert.deepEqual(calls, [["close"]]);
  assert.equal(scheduled[0].delayMs, 1_200);

  calls.length = 0;
  scheduled.length = 0;
  assert.equal(finishTelegramLogin(
    { close: () => { throw new Error("bridge unavailable"); } },
    true, true, "/cabinet", navigate, schedule, cancel,
  ), "navigated");
  assert.deepEqual(calls, [["cancel", 41], ["navigate", "/cabinet"]]);

  calls.length = 0;
  assert.equal(finishTelegramLogin(
    undefined, true, true, "/cabinet", navigate, schedule, cancel,
  ), "navigated");
  assert.deepEqual(calls, [["navigate", "/cabinet"]]);

  calls.length = 0;
  assert.equal(finishTelegramLogin(
    { close: () => calls.push(["close"]) }, true, false, "/cabinet", navigate, schedule, cancel,
  ), "navigated");
  assert.deepEqual(calls, [["navigate", "/cabinet"]]);
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
  assert.match(profileRoute, /export async function PATCH\(request: Request\)/u);
  assert.match(profileRoute, /expectedKeys = \["requestId", "expectedVersion", "subjectPosition", "primaryLocationId"\]/u);
  assert.match(profileRoute, /updateTeacherOwnProfile\(db, teacher/u);
  assert.match(workspace, /expectedVersion: profile\.profileVersion,[\s\S]*subjectPosition: normalizedSubject,[\s\S]*primaryLocationId: nextLocation/u);
  assert.match(photoRoute, /requireVisitTeacherSession\(db, request\)/u);
  assert.equal((photoRoute.match(/isSameOriginRequest\(request\)/gu) ?? []).length, 2);
  assert.match(photoRoute, /"Cache-Control": "private/u);
  assert.match(store, /WHERE u\.id=\? AND u\.status='active' AND p\.closed_at IS NULL/u);
  assert.match(store, /teacher-photos\/\$\{safeTeacherKey/u);
  assert.match(librarianRoute, /authorizeTeacherRegistryRead/u);
  assert.match(librarianWorkspace, /teacher\.photoUrl/u);
});

test("teacher profile edits subject and room directly while curator changes stay librarian-approved", async () => {
  const [workspace, curatorRoute, profileStore] = await Promise.all([
    read("app/visits/visit-booking-workspace.tsx"),
    read("app/api/teacher/profile/curator-request/route.ts"),
    read("lib/teacher-profile-store.ts"),
  ]);
  assert.match(workspace, /Редагувати інформацію/u);
  assert.match(workspace, /Зберегти профіль/u);
  assert.match(workspace, /Змінити клас куратора/u);
  assert.match(workspace, /зміну підтверджує бібліотекар/u);
  assert.match(workspace, /expectedVersion: profile\.pendingCuratorRequest\?\.version \?\? null/u);
  assert.match(workspace, /requestedClassYearId: curatorClassYearId/u);
  assert.match(workspace, /method: "DELETE"[\s\S]*expectedVersion: pendingRequest\.version/u);
  assert.match(curatorRoute, /expected = \["requestId", "expectedVersion", "requestedClassYearId", "teacherNote"\]/u);
  assert.match(curatorRoute, /requireVisitTeacherSession\(db, request\)/u);
  assert.match(profileStore, /teacher_curator_change_requests/u);
  assert.match(profileStore, /options:[\s\S]*curatorClasses/u);
});

test("librarian Telegram Mini App revalidates D1 role and keeps cabinet navigation in Mini App", async () => {
  const [page, cabinet, launch, route, auth, api, visits, teachers, shell, routes, worker] = await Promise.all([
    read("app/librarian/telegram/page.tsx"),
    read("app/librarian/telegram/cabinet/page.tsx"),
    read("app/librarian/telegram/telegram-librarian-launch.tsx"),
    read("app/api/librarian/session/telegram/route.ts"),
    read("lib/librarian-telegram-auth.ts"),
    read("lib/librarian-api.ts"),
    read("app/librarian/visits/visit-admin-workspace.tsx"),
    read("app/librarian/teachers/teacher-management-workspace.tsx"),
    read("app/librarian/_components/librarian-shell.tsx"),
    read("app/librarian/_components/librarian-routes.ts"),
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
  assert.match(visits, /telegramMiniApp=\{telegramMiniApp\}/u);
  assert.match(teachers, /telegramMiniApp=\{telegramMiniApp\}/u);
  assert.match(shell, /librarianSectionHref\(item\.id, telegramMiniApp\)/u);
  assert.match(routes, /teachers: "\/librarian\/telegram\/cabinet\?target=teachers"/u);
  assert.match(routes, /visits: "\/librarian\/telegram\/cabinet\?target=visits"/u);
  assert.match(worker, /url\.pathname\.startsWith\("\/librarian\/telegram\/"\)/u);
});
