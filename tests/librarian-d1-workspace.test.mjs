import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildCatalogSearchUrl,
  editDraftToChanges,
  gradeLabel,
  holdingKey,
  materialToEditDraft,
  resolveLiveFormTextForSubmission,
  resolveLoanDueAtForSubmission,
  suggestNextAcademicYearStart,
  todayInKyiv,
} from "../lib/librarian-d1-client.ts";
import {
  clearPendingInventoryIntent,
  readPendingInventoryIntent,
  writePendingInventoryIntent,
} from "../lib/librarian-pending-intent.ts";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("catalog search URL uses bounded D1 query filters and cursor", () => {
  const url = new URL(buildCatalogSearchUrl({
    q: "  математика  ",
    rubric: "Підручники",
    grade: "5",
    subject: "Алгебра",
    publicationType: "Підручник",
    available: true,
  }, "next-page"), "https://library.test");

  assert.equal(url.pathname, "/api/librarian/materials/search");
  assert.equal(url.searchParams.get("q"), "математика");
  assert.equal(url.searchParams.get("rubric"), "Підручники");
  assert.equal(url.searchParams.get("grade"), "5");
  assert.equal(url.searchParams.get("subject"), "Алгебра");
  assert.equal(url.searchParams.get("type"), "Підручник");
  assert.equal(url.searchParams.get("available"), "true");
  assert.equal(url.searchParams.get("sort"), "title");
  assert.equal(url.searchParams.get("limit"), "20");
  assert.equal(url.searchParams.get("cursor"), "next-page");
});

test("material edit conversion preserves nullable fields for PATCH", () => {
  const draft = materialToEditDraft({
    title: "Математика",
    rubric: "Підручники",
    publicationType: "",
    subject: "Математика",
    classFrom: 5,
    classTo: 6,
    author: "Автор",
    year: 2024,
    isbn: "",
    publisher: "Видавництво",
    notes: undefined,
  });
  draft.classTo = "";
  draft.author = "  Авторка  ";

  assert.deepEqual(editDraftToChanges(draft), {
    title: "Математика",
    rubric: "Підручники",
    publicationType: null,
    subject: "Математика",
    classFrom: 5,
    classTo: null,
    author: "Авторка",
    publicationYear: 2024,
    isbn: null,
    publisher: "Видавництво",
    notes: null,
  });
});

test("workspace helpers keep holding identity and Ukrainian labels stable", () => {
  assert.equal(holdingKey({ locationId: "LOC-001", condition: "good" }), "LOC-001\u001fgood");
  assert.equal(gradeLabel(5, 5), "5 клас");
  assert.equal(gradeLabel(5, 7), "5–7 класи");
  assert.equal(gradeLabel(null, null), "Клас не вказано");
  assert.equal(todayInKyiv(new Date("2026-08-10T22:30:00.000Z")), "2026-08-11");
});

test("loan due date submission prefers the value visible in the date input", () => {
  assert.equal(
    resolveLoanDueAtForSubmission(" 2026-09-01 ", "", ""),
    "2026-09-01",
  );
  assert.equal(
    resolveLoanDueAtForSubmission(undefined, "2026-09-02", ""),
    "2026-09-02",
  );
  assert.equal(
    resolveLoanDueAtForSubmission(undefined, null, "2026-09-03"),
    "2026-09-03",
  );
  assert.equal(resolveLoanDueAtForSubmission(undefined, null, "  "), null);
});

test("live form submission prefers the current native input value over stale React state", () => {
  assert.equal(
    resolveLiveFormTextForSubmission(" 2028-09-01 ", "2026-09-01", "2026-09-01"),
    "2028-09-01",
  );
  assert.equal(
    resolveLiveFormTextForSubmission(undefined, "2029-08-31", "2027-08-31"),
    "2029-08-31",
  );
  assert.equal(
    resolveLiveFormTextForSubmission(undefined, null, "2027-09-01"),
    "2027-09-01",
  );
  assert.equal(resolveLiveFormTextForSubmission("", null, "  "), null);
});

test("new academic year defaults continue after the latest stored period", () => {
  assert.equal(
    suggestNextAcademicYearStart([
      { label: "2026/2027", endDate: "2027-08-31" },
      { label: "2027/2028", endDate: "" },
    ], 2026),
    2028,
  );
  assert.equal(
    suggestNextAcademicYearStart([
      { label: "невизначений", endDate: "2029-08-31" },
      { label: "2028/2029", endDate: null },
    ], 2026),
    2029,
  );
  assert.equal(suggestNextAcademicYearStart([], 2026), 2026);
  assert.equal(
    suggestNextAcademicYearStart([{ label: "архів", endDate: "" }], 2026),
    2026,
  );
});

test("class creation only offers active academic years", async () => {
  const academic = await read("app/librarian/academic-workspace.tsx");
  const classCreate = academic.match(
    /function ClassCreate[\s\S]*?(?=function ClassUpdate)/u,
  )?.[0] ?? "";

  assert.match(
    classCreate,
    /reference\.academicYears\.filter\(\(year\) => year\.status === "active"\)/u,
  );
  assert.doesNotMatch(
    classCreate,
    /year\.status !== "closed"/u,
    "draft years must not be submitted to the active-year-only API",
  );
  assert.match(
    classCreate,
    /writesEnabled=\{writesEnabled && Boolean\(years\.length\)\}/u,
  );
  assert.match(classCreate, /потрібен активний навчальний рік/u);
});

test("an uncertain inventory request survives remount with its exact request ID and payload", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const intent = {
    kind: "transfer",
    materialId: "CAT-0001",
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    payload: {
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      materialId: "CAT-0001",
      sourceLocationId: "LOC-001",
      destinationLocationId: "LOC-002",
      condition: "good",
      quantity: 2,
      expectedSourceQuantity: 5,
      expectedDestinationQuantity: 1,
    },
  };

  writePendingInventoryIntent(storage, intent);
  assert.deepEqual(readPendingInventoryIntent(storage, "transfer", "CAT-0001"), intent);
  assert.equal(readPendingInventoryIntent(storage, "writeoff", "CAT-0001"), null);
  clearPendingInventoryIntent(storage, "transfer", "CAT-0001");
  assert.equal(readPendingInventoryIntent(storage, "transfer", "CAT-0001"), null);
});

test("new librarian route renders D1 workspace and keeps legacy workspace intact", async () => {
  const [page, workspace, client, styles] = await Promise.all([
    read("app/librarian/page.tsx"),
    read("app/librarian/d1-workspace.tsx"),
    read("lib/librarian-d1-client.ts"),
    read("app/librarian/d1-workspace.module.css"),
  ]);

  assert.match(page, /import D1LibrarianWorkspace from "\.\/d1-workspace"/u);
  assert.match(page, /<D1LibrarianWorkspace/u);
  assert.match(
    workspace,
    /const PUBLIC_CATALOG_URL = "https:\/\/nazarijshvetz1\.github\.io\/library-site\/";/u,
  );
  assert.match(workspace, /href=\{PUBLIC_CATALOG_URL\}/u);
  assert.match(workspace, /target="_blank"/u);
  assert.match(workspace, /rel="noopener noreferrer"/u);
  assert.match(workspace, /aria-label="Відкрити публічний каталог у новій вкладці"/u);
  assert.doesNotMatch(
    workspace,
    /<Link href="\/" className=\{styles\.catalogLink\}>/u,
  );
  assert.match(client, /\/api\/librarian\/materials\/search/u);
  assert.match(workspace, /method: "PATCH"/u);
  assert.match(workspace, /method: "DELETE"/u);
  assert.match(workspace, /Видалити матеріал/u);
  assert.match(workspace, /className=\{styles\.dangerZone\}/u);
  assert.match(
    workspace,
    /<fieldset className=\{styles\.editFields\} disabled=\{saving \|\| archiving\}>/u,
  );
  assert.match(workspace, /aria-label="Закрити редагування"/u);
  assert.match(workspace, /type="button"[\s\S]*?onClick=\{\(\) => void archiveMaterial\(\)\}/u);
  assert.match(workspace, /window\.confirm/u);
  assert.match(workspace, /archiveRequestId\.current \?\? crypto\.randomUUID\(\)/u);
  assert.match(workspace, /archiveUncertain[\s\S]*?Перевірити видалення/u);
  assert.match(workspace, /coverUpload\.clear\(\);[\s\S]*?onArchived\(detail\.id\)/u);
  assert.match(workspace, /onArchived\(detail\.id\)/u);
  assert.match(workspace, /setItems\(\(current\) => current\.filter\(\(item\) => item\.id !== materialId\)\)/u);
  assert.match(workspace, /setWorkspaceNoticeTone\("success"\)/u);
  assert.match(workspace, /detail\.totalQuantity > 0 \|\| detail\.loanedQuantity > 0/u);
  assert.match(workspace, /\|\| detail\.totalQuantity > 0[\s\S]*?\|\| detail\.loanedQuantity > 0/u);
  assert.match(styles, /\.dangerButton/u);
  assert.match(styles, /\.editFields \{[\s\S]*?border: 0/u);
  assert.match(styles, /\.dangerButton \{[\s\S]*?min-height: 44px/u);
  assert.match(styles, /\.dangerZone \.dangerButton \{ width: 100%; \}/u);
  assert.match(workspace, /\/api\/librarian\/stock-adjustments/u);
  assert.match(workspace, /\/api\/librarian\/library-reference/u);
  assert.match(workspace, /"\/api\/librarian\/loans"/u);
  assert.match(workspace, /\/api\/librarian\/loans\/returns/u);
  assert.match(workspace, /"\/api\/librarian\/materials"/u);
  assert.match(workspace, /\/api\/librarian\/receipts/u);
  assert.match(workspace, /\/api\/librarian\/transfers/u);
  assert.match(workspace, /expectedSourceQuantity: source\?\.quantity/u);
  assert.match(workspace, /expectedDestinationQuantity: destinationHolding\?\.quantity \?\? 0/u);
  assert.match(workspace, /\/api\/librarian\/writeoffs/u);
  assert.match(workspace, /expectedQuantity: source\?\.quantity/u);
  assert.match(workspace, /requestError\.code === "stock_quantity_conflict"/u);
  assert.match(workspace, /window\.confirm/u);
  assert.match(workspace, /selectedIdRef\.current !== materialId/u);
  assert.match(workspace, /detailRequestRef\.current/u);
  assert.match(workspace, /writePendingInventoryIntent\(intent\)/u);
  assert.match(workspace, /retryPending \? "Перевірити результат"/u);
  assert.match(workspace, /role=\{tone === "error" \? "alert" : "status"\}/u);
  assert.match(workspace, /\/api\/librarian\/isbn-lookup\?isbn=/u);
  assert.match(workspace, /mergeBookLookupDraft/u);
  assert.match(workspace, /mergeBookLookupLink/u);
  assert.match(workspace, /current\.title\.trim\(\) \|\| candidate\.title/u);
  assert.match(workspace, /initialReceipt/u);
  assert.match(workspace, /expectedQuantity: 0/u);
  assert.match(workspace, /links: linkPayload\(links\)/u);
  assert.match(workspace, /Новий матеріал/u);
  assert.match(workspace, /Надходження/u);
  assert.match(workspace, /teacher\.fullName/u);
  assert.match(workspace, /source\.quantity/u);
  assert.match(workspace, /quantityOutstanding/u);
  assert.match(workspace, /name="dueAt"/u);
  assert.match(workspace, /ref=\{dueAtInputRef\}/u);
  assert.match(workspace, /dueAtInputRef\.current\?\.value/u);
  assert.match(workspace, /new FormData\(event\.currentTarget\)\.get\("dueAt"\)/u);
  assert.match(workspace, /dueAt: submittedDueAt/u);
  const dueAtInput = workspace.match(
    /<input\s+ref=\{dueAtInputRef\}[\s\S]*?name="dueAt"[\s\S]*?\/>/u,
  )?.[0] ?? "";
  assert.match(
    dueAtInput,
    /onInput=\{\(event\) => setDueAt\(event\.currentTarget\.value\)\}/u,
    "the controlled due-date field must consume native input events",
  );
  assert.doesNotMatch(
    dueAtInput,
    /onChange=/u,
    "the due-date field must not duplicate state synchronization in onChange",
  );
  assert.match(workspace, /thumbnailUrl/u);
  assert.match(workspace, /item\.year/u);
  assert.doesNotMatch(workspace, /Ревізія/u);

  const academic = await read("app/librarian/academic-workspace.tsx");
  assert.match(academic, /\/api\/librarian\/academic-reference/u);
  assert.match(academic, /\/api\/librarian\/academic-years"/u);
  assert.match(academic, /\/api\/librarian\/class-years"/u);
  assert.match(academic, /\/close/u);
  assert.match(academic, /\/academic-years\/rollover/u);
  assert.match(academic, /expectedVersion: selected\.version/u);
  assert.match(academic, /sourceYearVersion: sourceYear\.version/u);
  assert.match(academic, /targetYearVersion: targetYear\.version/u);
  assert.match(academic, /suggestNextAcademicYearStart\(\s*reference\.academicYears/u);
  assert.match(academic, /ref=\{startDateInputRef\} name="startDate"/u);
  assert.match(academic, /ref=\{endDateInputRef\} name="endDate"/u);
  assert.match(academic, /ref=\{actualClosedDateInputRef\} name="actualClosedDate"/u);
  assert.match(academic, /ref=\{effectiveDateInputRef\} name="effectiveDate"/u);
  assert.match(academic, /startDate: submittedStartDate/u);
  assert.match(academic, /endDate: submittedEndDate/u);
  assert.match(academic, /actualClosedDate: submittedActualClosedDate/u);
  assert.match(academic, /effectiveDate: submittedEffectiveDate/u);
  assert.match(academic, /name="startDate" type="date" value=\{startDate\} onInput=\{updateStartDate\}/u);
  assert.match(academic, /name="endDate" type="date" value=\{endDate\} min=\{startDate\} onInput=\{updateEndDate\}/u);
  assert.match(academic, /name="actualClosedDate" type="date" value=\{actualClosedDate\} onInput=\{updateActualClosedDate\}/u);
  assert.match(academic, /name="effectiveDate" type="date" value=\{effectiveDate\} onInput=\{updateEffectiveDate\}/u);

  const legacy = await read("app/librarian/workspace.tsx");
  assert.match(legacy, /revision\.count/u);
});
