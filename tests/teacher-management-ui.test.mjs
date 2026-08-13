import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { teacherDirectoryUrl, teacherProfileDraft } from "../app/librarian/teachers/teacher-management-client.ts";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("protected librarian teacher management has four focused work areas", async () => {
  const [page, workspace, css] = await Promise.all([
    read("app/librarian/teachers/page.tsx"),
    read("app/librarian/teachers/teacher-management-workspace.tsx"),
    read("app/librarian/teachers/teacher-management.module.css"),
  ]);
  assert.match(page, /requireChatGPTUser\("\/librarian\/teachers"\)/u);
  assert.match(page, /getLibrarianAccess/u);
  assert.match(workspace, />Огляд</u);
  assert.match(workspace, />Вчителі</u);
  assert.match(workspace, />Замовлення і видачі</u);
  assert.match(workspace, />Відвідування</u);
  assert.match(workspace, /Потребує уваги/u);
  assert.match(css, /@media \(max-width: 700px\)/u);
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
  assert.match(client, /nextCursor: string \| null/u);
  assert.match(workspace, /load\(data\.page\.nextCursor\)/u);
  assert.match(workspace, /Прізвище або ім’я/u);
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
  assert.match(workspace, /<TeacherAccessAdmin writesEnabled=\{writesEnabled\} \/>/u);
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
  assert.doesNotMatch(inbox, /Позначити готовим і створити видачу/u);
});

test("librarian navigation exposes teacher management from both workspaces", async () => {
  const [main, visits] = await Promise.all([
    read("app/librarian/d1-workspace.tsx"),
    read("app/librarian/visits/visit-admin-workspace.tsx"),
  ]);
  assert.match(main, /href="\/librarian\/teachers"/u);
  assert.match(visits, /href="\/librarian\/teachers"/u);
});
