import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { teacherDirectoryUrl, teacherProfileDraft } from "../app/librarian/teachers/teacher-management-client.ts";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("protected librarian teacher management has five focused work areas", async () => {
  const [page, workspace, css] = await Promise.all([
    read("app/librarian/teachers/page.tsx"),
    read("app/librarian/teachers/teacher-management-workspace.tsx"),
    read("app/librarian/teachers/teacher-management.module.css"),
  ]);
  assert.match(page, /boundedTab\(params\?\.tab\)/u);
  assert.match(page, /initialTab=\{initialTab\}/u);
  assert.match(page, /getLibrarianAccess/u);
  assert.match(workspace, />Огляд</u);
  assert.match(workspace, />Вчителі</u);
  assert.match(workspace, />Замовлення і видачі</u);
  assert.match(workspace, />Відвідування</u);
  assert.match(workspace, /telegram>Telegram<\/TabButton>/u);
  assert.match(workspace, /Потребує уваги/u);
  assert.match(workspace, /const notificationsOn = Boolean\(telegram\?\.notifyOrders \|\| telegram\?\.notifyVisits\)/u);
  assert.match(workspace, /name=\{notificationsOn \? "bell-off" : "notifications"\}/u);
  assert.match(workspace, /notificationsOn \? "Вимкнути сповіщення" : "Увімкнути сповіщення"/u);
  assert.match(workspace, /confirmation: "disconnect_telegram"/u);
  assert.match(workspace, /Так, від’єднати/u);
  assert.doesNotMatch(workspace, /librarian-telegram-orders|librarian-telegram-visits/u);
  assert.match(css, /@media \(max-width: 700px\)/u);
  assert.match(css, /tabs button\[data-telegram="true"\]/u);
});

test("librarian cabinet separates Telegram connection from notification controls", async () => {
  const [workspace, shell, routes, launchPage, launch, cabinet] = await Promise.all([
    read("app/librarian/teachers/teacher-management-workspace.tsx"),
    read("app/librarian/_components/librarian-shell.tsx"),
    read("app/librarian/_components/librarian-routes.ts"),
    read("app/librarian/telegram/page.tsx"),
    read("app/librarian/telegram/telegram-librarian-launch.tsx"),
    read("app/librarian/telegram/cabinet/page.tsx"),
  ]);
  assert.match(workspace, /librarian-telegram-connection-title/u);
  assert.match(workspace, /librarian-telegram-notifications-title/u);
  assert.match(workspace, /Підключити Telegram/u);
  assert.match(workspace, /Сповіщення Telegram/u);
  assert.match(workspace, /role="status" aria-live="polite"/u);
  assert.match(workspace, /initialTab\?: MainTab/u);
  assert.match(shell, /telegramHref/u);
  assert.match(routes, /"\/librarian\/teachers\?tab=telegram"/u);
  assert.match(launchPage, /teacherTab=\{boundedTeacherTab\(params\?\.tab\)\}/u);
  assert.match(launch, /target === "teachers" && teacherTab !== "overview"/u);
  assert.match(launch, /&tab=\$\{encodeURIComponent\(teacherTab\)\}/u);
  assert.match(cabinet, /initialTab=\{boundedTeacherTab\(params\?\.tab\)\}/u);
});

test("teacher directory uses frozen server paging, search and status contract", async () => {
  const [client, workspace] = await Promise.all([
    read("app/librarian/teachers/teacher-management-client.ts"),
    read("app/librarian/teachers/teacher-management-workspace.tsx"),
  ]);
  assert.equal(
    teacherDirectoryUrl({ query: "Коваль", status: "inactive", limit: 30, cursor: "opaque" }),
    "/api/librarian/teachers?q=%D0%9A%D0%BE%D0%B2%D0%B0%D0%BB%D1%8C&status=inactive&cursor=opaque&limit=30",
  );
  assert.match(client, /counters: TeacherDirectoryCounters/u);
  assert.match(client, /accountRole: "teacher" \| "admin" \| "librarian"/u);
  assert.match(client, /nextCursor: string \| null/u);
  assert.match(workspace, /load\(data\.page\.nextCursor\)/u);
  assert.match(workspace, /Прізвище або ім’я/u);
  assert.match(workspace, /const handleDirectoryNotice = useCallback/u);
  assert.match(workspace, /onNotice=\{handleDirectoryNotice\}/u);
  assert.doesNotMatch(workspace, /onNotice=\{\(message, tone/u);
  assert.doesNotMatch(workspace, /DirectoryAttention/u);
});

test("profile fields keep personnel and imported personal email out of the card", async () => {
  const [client, workspace] = await Promise.all([
    read("app/librarian/teachers/teacher-management-client.ts"),
    read("app/librarian/teachers/teacher-management-workspace.tsx"),
  ]);
  assert.deepEqual(teacherProfileDraft(), {
    fullName: "",
    subjectPosition: "",
    primaryLocationId: "",
    serviceContact: "",
    librarianNote: "",
  });
  assert.match(workspace, /Службовий контакт/u);
  assert.match(workspace, /Особиста пошта автоматично не підтягується/u);
  assert.doesNotMatch(client, /personnel|employeeNumber|email:/iu);
  assert.doesNotMatch(workspace, /табельн/iu);
});

test("teacher mutations match the exact backend contract and protect history", async () => {
  const [client, workspace] = await Promise.all([
    read("app/librarian/teachers/teacher-management-client.ts"),
    read("app/librarian/teachers/teacher-management-workspace.tsx"),
  ]);
  assert.match(client, /forceDuplicate,/u);
  assert.match(client, /action: "update"/u);
  assert.match(client, /changes: \{/u);
  assert.match(client, /reason: ""/u);
  assert.match(client, /confirmation: "DELETE_EMPTY_TEACHER"/u);
  assert.match(workspace, /TeacherDuplicateWarning/u);
  assert.match(workspace, /Усе одно створити або зберегти окрему картку/u);
  assert.match(workspace, /teacherCloseBlockers/u);
  assert.match(workspace, /dependencySummary\.totalDependencies === 0/u);
  assert.match(workspace, /teacher\.accountRole === "teacher"/u);
  assert.match(workspace, /Обліковий рівень/u);
  assert.match(workspace, />Видалити картку<\/button>/u);
  assert.match(workspace, /disabled=\{!writesEnabled \|\| busy \|\| !deletionAllowed\}/u);
  assert.match(workspace, /confirmation !== teacher\.fullName/u);
  assert.match(workspace, /Картку закрито без втрати історії/u);
});

test("selected teacher exposes profile, material history, visits and access anchor", async () => {
  const workspace = await read("app/librarian/teachers/teacher-management-workspace.tsx");
  assert.match(workspace, /detail\.requests/u);
  assert.match(workspace, /detail\.loans/u);
  assert.match(workspace, /detail\.futureVisits/u);
  assert.match(workspace, /item\.title_snapshot/u);
  assert.match(workspace, /item\.outstanding_quantity/u);
  assert.match(workspace, /href="#teacher-access-title"/u);
  assert.match(workspace, /<TeacherCodeImport/u);
  assert.match(workspace, /setAccessRefreshKey/u);
  assert.match(workspace, /<TeacherAccessAdmin writesEnabled=\{writesEnabled\} refreshKey=\{accessRefreshKey\} \/>/u);
  assert.match(workspace, /listRequestRef = useRef\(0\)/u);
  assert.match(workspace, /detailRequestRef = useRef\(0\)/u);
  assert.match(workspace, /selectedIdRef = useRef<string \| null>\(null\)/u);
  assert.match(workspace, /requestSequence !== listRequestRef\.current/u);
  assert.match(workspace, /requestSequence !== detailRequestRef\.current/u);
  assert.match(workspace, /selectedIdRef\.current === next\.teacher\.id/u);
  assert.match(workspace, /error instanceof Error \? error\.message/u);
});

test("material request inbox separates reservation, physical issue and uncollected release", async () => {
  const inbox = await read("app/librarian/visits/material-request-inbox.tsx");
  assert.match(inbox, /useState<"issue" \| "release" \| null>/u);
  assert.match(inbox, /action === "release"/u);
  assert.match(inbox, /reservationId: reservation\.id/u);
  assert.match(inbox, /Підготувати резерв/u);
  assert.match(inbox, /Позика та рух залишків будуть створені лише після цієї дії/u);
  assert.match(inbox, /Фізичного руху примірників не буде/u);
  assert.match(inbox, /approvedQuantity: row\.approvedQuantity/u);
  assert.match(inbox, /expectedAvailableQuantity: holdingAvailable\(holding\)/u);
  assert.match(inbox, /Підтвердити фактичну видачу для \$\{request\.teacher\.fullName\}: \$\{totalQuantity\} прим\.\? Залишок зменшиться, буде створено позику\./u);
  assert.match(inbox, /onClick=\{\(\) => void sendAction\(pending\)\}/u);
  assert.match(inbox, /completeLegacyRequest/u);
  assert.match(inbox, /request\.resultingLoanId/u);
  assert.match(inbox, /action: "complete"/u);
  assert.match(inbox, /key=\{`\$\{request\.id\}:\$\{request\.version\}`\}/u);
  assert.match(inbox, /loadRequestRef = useRef\(0\)/u);
  assert.doesNotMatch(inbox, /Позначити готовим і створити видачу/u);
});

test("shared librarian navigation exposes teacher management from both workspaces", async () => {
  const [main, visits, shell, routes] = await Promise.all([
    read("app/librarian/d1-workspace.tsx"),
    read("app/librarian/visits/visit-admin-workspace.tsx"),
    read("app/librarian/_components/librarian-shell.tsx"),
    read("app/librarian/_components/librarian-routes.ts"),
  ]);
  assert.match(main, /<LibrarianShell/u);
  assert.match(visits, /<LibrarianShell/u);
  assert.match(visits, /activeSection="visits"/u);
  assert.match(shell, /SECONDARY_ITEMS/u);
  assert.match(routes, /teachers: "\/librarian\/teachers"/u);
  assert.match(routes, /teachers: "\/librarian\/telegram\/cabinet\?target=teachers"/u);
  assert.match(routes, /"\/librarian\/teachers\?tab=telegram"/u);
});
