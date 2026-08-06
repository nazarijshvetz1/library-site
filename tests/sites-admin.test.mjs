import assert from "node:assert/strict";
import { access, readFile, readdir, stat } from "node:fs/promises";
import test from "node:test";

import {
  DRAFT_STATUSES,
  DRAFT_KINDS,
  isDraftId,
  validateDraftActionInput,
  validateDraftInput,
} from "../lib/draft-validation.ts";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

async function filesBelow(path) {
  const directory = new URL(path.endsWith("/") ? path : `${path}/`, root);
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${path.replace(/\/$/, "")}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await filesBelow(relative));
    else result.push(relative);
  }
  return result;
}

test("tooling keeps the public catalog and private Sites builds separate", async () => {
  const [packageJson, packageLock] = await Promise.all([
    read("package.json").then(JSON.parse),
    read("package-lock.json").then(JSON.parse),
  ]);

  assert.equal(packageJson.scripts.build, "vinext build");
  assert.equal(packageJson.scripts["build:catalog"], "node scripts/build.mjs");
  assert.equal(packageJson.scripts.prebuild, "node scripts/clean-private-build.mjs");
  assert.equal(packageJson.scripts.postbuild, "node scripts/verify-private-build.mjs");
  assert.equal(packageJson.scripts["build:pages"], "node scripts/build-pages.mjs");
  assert.match(packageJson.scripts.test, /test:catalog/);
  assert.match(packageJson.scripts.test, /test:sites/);
  assert.equal(packageJson.dependencies["react-loading-skeleton"], undefined);
  assert.equal(packageLock.packages["node_modules/react-loading-skeleton"], undefined);
  await assert.rejects(access(new URL("tests/rendered-html.test.mjs", root)));
});

test("GitHub Pages artifact contains only the public catalog", async () => {
  const files = (await filesBelow("dist-pages")).sort();
  assert.deepEqual(files, [
    "dist-pages/.nojekyll",
    "dist-pages/app.js",
    "dist-pages/balance-data.js",
    "dist-pages/brand.css",
    "dist-pages/catalog-data.js",
    "dist-pages/config.js",
    "dist-pages/index.html",
    "dist-pages/library-logo.png",
    "dist-pages/og.png",
    "dist-pages/styles.css",
  ]);

  const pagesBuilder = await read("scripts/build-pages.mjs");
  assert.doesNotMatch(pagesBuilder, /\.\.\/app|\.\.\/lib|\.\.\/db/);

  const publicText = await Promise.all(
    files
      .filter((path) => /\.(?:html|css|js)$/.test(path))
      .map((path) => read(path)),
  );
  const artifact = publicText.join("\n");
  assert.doesNotMatch(artifact, /\/api\/librarian|\/librarian\b/);
  assert.doesNotMatch(artifact, /LIBRARIAN_ALLOWED_EMAILS|oai-authenticated-user/i);
});

test("private Sites routes enforce server authentication and an email allowlist", async () => {
  const [page, accessSource, apiSource, draftsRoute, catalogRoute] = await Promise.all([
    read("app/librarian/page.tsx"),
    read("lib/librarian-access.ts"),
    read("lib/librarian-api.ts"),
    read("app/api/librarian/drafts/route.ts"),
    read("app/api/librarian/catalog/route.ts"),
  ]);

  assert.match(page, /export const dynamic = ["']force-dynamic["']/);
  assert.match(page, /await requireChatGPTUser\(["']\/librarian["']\)/);
  assert.match(page, /getLibrarianAccess\(user\)/);
  assert.match(page, /if \(!access\.allowed\)/);

  assert.match(accessSource, /LIBRARIAN_ALLOWED_EMAILS/);
  assert.match(accessSource, /toLowerCase\(\)/);
  assert.match(accessSource, /emails\.has\(user\.email\.trim\(\)\.toLowerCase\(\)\)/);
  assert.match(accessSource, /LIBRARIAN_WRITES_ENABLED/);

  assert.match(apiSource, /getChatGPTUser\(\)/);
  assert.match(apiSource, /getLibrarianAccess\(user\)/);
  assert.match(apiSource, /librarianError\(\s*401/);
  assert.match(apiSource, /librarianError\(\s*403/);
  assert.match(apiSource, /private, no-store/);
  assert.match(draftsRoute, /authorizeLibrarianApi\(\)/);
  assert.match(draftsRoute, /isSameOriginRequest\(request\)/);
  assert.match(catalogRoute, /authorizeLibrarianApi\(\)/);
});

test("draft validation accepts supported formats and normalizes ISBN", () => {
  assert.deepEqual([...DRAFT_KINDS], [
    "material.create",
    "material.update",
    "receipt.create",
    "transfer.create",
    "writeoff.create",
    "revision.count",
    "academic-year.create",
    "class-year.create",
    "class-year.update",
    "class-year.close",
    "academic-year.rollover",
  ]);
  assert.deepEqual([...DRAFT_STATUSES], [
    "draft",
    "ready_for_review",
    "cancelled",
    "approved_pending_apply",
    "applied",
    "failed",
  ]);

  const material = validateDraftInput({
    kind: "material.create",
    payload: {
      title: "Математика, 5 клас",
      rubric: "Підручники і хрестоматії",
      isbn: "978-0-306-40615-7",
    },
  });
  assert.equal(material.ok, true);
  if (material.ok) assert.equal(material.value.payload.isbn, "9780306406157");

  const isbn10 = validateDraftInput({
    kind: "material.create",
    payload: { title: "Книга", rubric: "Рубрика", isbn: "0-306-40615-2" },
  });
  assert.equal(isbn10.ok, true);
  if (isbn10.ok) assert.equal(isbn10.value.payload.isbn, "0306406152");

  for (const input of [
    { kind: "receipt.create", payload: { materialId: "CAT-0112", quantity: 2, location: "Бібліотека", date: "2026-08-07" } },
    { kind: "transfer.create", payload: { materialId: "CAT-0112", quantity: 1, fromLocation: "Бібліотека", toLocation: "Кабінет 205", date: "2026-08-07" } },
    { kind: "revision.count", payload: { materialId: "CAT-0112", location: "Бібліотека", countedQuantity: 0, date: "2026-08-07" } },
  ]) {
    assert.equal(validateDraftInput(input).ok, true);
  }

  const action = validateDraftActionInput({
    id: "8092f8cf-6e7b-4f4b-9e29-56dd684268f2",
    revision: 2,
    action: "submit",
  });
  assert.equal(action.ok, true);
});

test("draft validation rejects unsafe or malformed input", async () => {
  const invalidIsbn = validateDraftInput({
    kind: "material.create",
    payload: { title: "Книга", rubric: "Рубрика", isbn: "9780306406158" },
  });
  assert.equal(invalidIsbn.ok, false);
  if (!invalidIsbn.ok) assert.ok(invalidIsbn.fieldErrors["payload.isbn"]);

  const formula = validateDraftInput({
    kind: "material.create",
    payload: { title: "Книга", rubric: "Рубрика", notes: "  =IMPORTXML(...)" },
  });
  assert.equal(formula.ok, false);
  if (!formula.ok) assert.ok(formula.fieldErrors["payload.notes"]);

  const manualId = validateDraftInput({
    kind: "material.create",
    payload: { title: "Книга", rubric: "Рубрика", catId: "CAT-9999" },
  });
  assert.equal(manualId.ok, false);

  assert.equal(isDraftId("8092f8cf-6e7b-4f4b-9e29-56dd684268f2"), true);
  assert.equal(isDraftId("../draft"), false);

  const store = await read("lib/draft-store.ts");
  assert.match(store, /crypto\.randomUUID\(\)/);
  assert.match(store, /ownerUserId/);
});

test("protected operation drafts validate exact stable identifiers and class history", () => {
  const validInputs = [
    {
      kind: "material.update",
      payload: {
        materialId: "CAT-0112",
        changes: { classFrom: 5, classTo: 6, publisher: "Освіта" },
        reason: "Уточнено картку",
      },
    },
    {
      kind: "writeoff.create",
      payload: {
        materialId: "CAT-0112",
        fromLocationId: "LOC-001",
        fromLocationName: "Бібліотека",
        quantity: 1,
        destination: "written_off",
        reason: "worn",
        date: "2026-08-07",
      },
    },
    {
      kind: "academic-year.create",
      payload: {
        label: "2027/2028",
        startDate: "2027-09-01",
        endDate: "2028-08-31",
      },
    },
    {
      kind: "class-year.create",
      payload: {
        academicYearId: "YR-2027-2028",
        cohortMode: "existing",
        cohortId: "COH-001",
        grade: 2,
        code: "А",
        teacherUserId: "USR-013",
        teacherName: "Висовень Галина Миколаївна",
        locationId: "LOC-003",
        locationName: "Кабінет № 206",
      },
    },
    {
      kind: "class-year.update",
      payload: {
        classYearId: "CY-2026-001",
        academicYearId: "YR-2026-2027",
        changes: { teacherUserId: null, teacherName: null, code: "А" },
      },
    },
    {
      kind: "class-year.close",
      payload: {
        classYearId: "CY-2026-001",
        actualClosedDate: "2027-06-30",
        reason: "closed",
        closeCohort: false,
      },
    },
    {
      kind: "academic-year.rollover",
      payload: {
        sourceYearId: "YR-2026-2027",
        targetYearId: "YR-2027-2028",
        effectiveDate: "2027-09-01",
        classes: [{
          sourceClassYearId: "CY-2026-001",
          cohortId: "COH-001",
          sourceGrade: 1,
          action: "promote",
          targetGrade: 2,
          targetCode: "А",
        }],
      },
    },
  ];
  validInputs.forEach((input) => assert.equal(validateDraftInput(input).ok, true));

  const cover = validateDraftInput({
    kind: "material.create",
    payload: {
      title: "Книга",
      rubric: "Підручники",
      classFrom: 1,
      classTo: 4,
      coverPhotoKey:
        "cover-drafts/0123456789abcdef01234567/8092f8cf-6e7b-4f4b-9e29-56dd684268f2.jpg",
      coverPhotoName: "Фото обкладинки.jpg",
      coverConfirmed: "true",
    },
  });
  assert.equal(cover.ok, true);
  if (cover.ok) assert.equal(cover.value.payload.coverConfirmed, true);

  const singleGrade = validateDraftInput({
    kind: "material.create",
    payload: { title: "Книга", rubric: "Підручники", classFrom: 5 },
  });
  assert.equal(singleGrade.ok, true);
  if (singleGrade.ok) assert.equal(singleGrade.value.payload.classTo, 5);
});

test("protected operation drafts reject ambiguous cover, service rooms, and unsafe rollover", () => {
  const ambiguousCover = validateDraftInput({
    kind: "material.create",
    payload: {
      title: "Книга",
      rubric: "Підручники",
      coverSourceUrl: "https://example.com/cover.jpg",
      coverPhotoKey:
        "cover-drafts/0123456789abcdef01234567/8092f8cf-6e7b-4f4b-9e29-56dd684268f2.jpg",
      coverConfirmed: true,
    },
  });
  assert.equal(ambiguousCover.ok, false);

  const serviceRoom = validateDraftInput({
    kind: "class-year.create",
    payload: {
      academicYearId: "YR-2027-2028",
      cohortMode: "new",
      grade: 1,
      code: "А",
      locationId: "LOC-007",
      locationName: "Списано",
    },
  });
  assert.equal(serviceRoom.ok, false);

  const invalidRollover = validateDraftInput({
    kind: "academic-year.rollover",
    payload: {
      sourceYearId: "YR-2026-2027",
      targetYearId: "YR-2027-2028",
      effectiveDate: "2027-09-01",
      classes: [{
        sourceClassYearId: "CY-2026-025",
        cohortId: "COH-025",
        sourceGrade: 11,
        action: "promote",
        targetGrade: 11,
        targetCode: "U1",
      }],
    },
  });
  assert.equal(invalidRollover.ok, false);
});

test("draft workflow schema includes optimistic revisions, transitions, and audit triggers", async () => {
  const [schema, store, route, migration] = await Promise.all([
    read("db/schema.ts"),
    read("lib/draft-store.ts"),
    read("app/api/librarian/drafts/route.ts"),
    read("drizzle/0001_draft_workflow.sql"),
  ]);
  assert.match(schema, /schemaVersion: integer\("schema_version"\)/);
  assert.match(schema, /revision: integer\("revision"\)/);
  assert.match(schema, /librarianDraftEvents/);
  assert.match(store, /eq\(librarianDrafts\.revision, expectedRevision\)/);
  assert.match(store, /inArray\(librarianDrafts\.status, allowedStatuses\)/);
  assert.match(store, /identicalFirstRequest/);
  assert.match(store, /DraftRevisionRequiredError/);
  assert.match(store, /eq\(librarianDrafts\.revision, input\.revision!\)/);
  assert.match(route, /export async function PATCH/);
  assert.match(route, /validateDraftActionInput/);
  assert.match(route, /draft_revision_required/);
  assert.match(migration, /CREATE TRIGGER `trg_librarian_drafts_audit_insert`/);
  assert.match(migration, /CREATE TRIGGER `trg_librarian_drafts_audit_update`/);
  assert.doesNotMatch(route, /SpreadsheetApp|google\.script\.run|doPost/);
});

test("private workspace supports ISBN lookup, safe scanner lifecycle, and draft updates", async () => {
  const [workspace, publicApi, migration, worker] = await Promise.all([
    read("app/librarian/workspace.tsx"),
    read("apps-script/PublicCatalogApi.gs"),
    read("drizzle/0000_librarian_drafts.sql"),
    read("worker/index.ts"),
  ]);

  assert.match(publicApi, /isbn:\s*isbn_\(row\[24\] \|\| row\[9\]\)/);
  assert.match(workspace, /readText\(material, \["isbn"\]\)/);
  assert.match(workspace, /classFrom/);
  assert.match(workspace, /typeof revision === "number" \? \{ revision \} : \{\}/);
  assert.match(workspace, /body:\s*JSON\.stringify\(\{ id, revision, action \}\)/);
  assert.match(workspace, /startingRef\.current \|\| scanningRef\.current/);
  assert.match(workspace, /if \(!scanningRef\.current\) return;/);
  assert.match(workspace, /data-material-picker-input/);
  assert.match(migration, /CREATE TABLE `librarian_drafts`/);
  assert.match(migration, /idx_librarian_drafts_owner_updated/);
  assert.match(worker, /camera=\(self\)/);
  assert.match(worker, /frame-ancestors 'none'/);
  assert.match(worker, /X-Frame-Options", "DENY"/);
});

test("Sites build emits a private server bundle", async () => {
  const entry = new URL("dist/server/index.js", root);
  assert.ok((await stat(entry)).size > 1_000);
  const outputFiles = await filesBelow("dist");
  const javascript = await Promise.all(
    outputFiles.filter((path) => /\.(?:js|mjs)$/.test(path)).map((path) => read(path)),
  );
  const bundle = javascript.join("\n");
  assert.doesNotMatch(bundle, /^const files = new Map/);
  assert.match(bundle, /LIBRARIAN_ALLOWED_EMAILS/);
});

test("production sources contain no high-confidence secrets", async () => {
  const roots = ["app", "apps-script", "db", "lib", "scripts", "source"];
  const files = (await Promise.all(roots.map(filesBelow))).flat()
    .filter((path) => /\.(?:css|html|js|mjs|ts|tsx|json|md)$/.test(path));
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    new RegExp(`\\bgh[${"pousr"}]_[A-Za-z0-9]{30,}\\b`),
    new RegExp(`\\bgithub_${"pat"}_[A-Za-z0-9_]{30,}\\b`),
    new RegExp(`\\bAI${"za"}[0-9A-Za-z_-]{35}\\b`),
  ];

  for (const path of files) {
    const content = await read(path);
    for (const pattern of patterns) {
      assert.doesNotMatch(content, pattern, `Potential secret in ${path}`);
    }
  }
});
