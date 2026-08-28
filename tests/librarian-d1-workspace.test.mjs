import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildCatalogSearchUrl,
  clearPendingClassCirculationIntent,
  editDraftToChanges,
  gradeLabel,
  holdingKey,
  materialToEditDraft,
  readPendingClassCirculationIntent,
  resolveLiveFormTextForSubmission,
  resolveLoanDueAtForSubmission,
  suggestNextAcademicYearStart,
  todayInKyiv,
  writePendingClassCirculationIntent,
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

  for (const q of ["Автор Петренко", "9786170000001", "CAT-0001"]) {
    const preserved = new URL(buildCatalogSearchUrl({
      q,
      rubric: "",
      grade: "",
      subject: "",
      publicationType: "",
      available: false,
    }), "https://library.test");
    assert.equal(preserved.searchParams.get("q"), q);
    assert.equal(preserved.searchParams.has("rubric"), false);
  }
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

test("an uncertain class circulation request survives remount with its exact payload", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const intent = {
    kind: "class-issue",
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    payload: {
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      classYearId: "CY-2026-7A",
      expectedClassYearVersion: 3,
      responsibleTeacherUserId: "USR-TEACHER",
      issuedAt: "2026-09-01",
      dueAt: "2027-05-31",
      notes: null,
      items: [{
        materialId: "CAT-0001",
        sourceLocationId: "LOC-001",
        condition: "good",
        quantity: 20,
        expectedAvailableQuantity: 25,
      }],
    },
  };

  writePendingClassCirculationIntent(storage, intent);
  assert.deepEqual(readPendingClassCirculationIntent(storage, "class-issue"), intent);
  assert.equal(readPendingClassCirculationIntent(storage, "class-return"), null);
  clearPendingClassCirculationIntent(storage, "class-issue");
  assert.equal(readPendingClassCirculationIntent(storage, "class-issue"), null);

  assert.equal(readPendingClassCirculationIntent({
    getItem() { throw new Error("storage denied"); },
    setItem() {},
    removeItem() {},
  }, "class-issue"), null);
});

test("catalog facet filters keep free-text search and add native subject and publication type suggestions", async () => {
  const [workspace, styles] = await Promise.all([
    read("app/librarian/d1-workspace.tsx"),
    read("app/librarian/d1-workspace.module.css"),
  ]);
  const catalogSearch = workspace.match(
    /function CatalogSearch[\s\S]*?(?=function MaterialCard)/u,
  )?.[0] ?? "";
  const subjectField = catalogSearch.match(
    /<span>Предмет<\/span>[\s\S]*?<\/label>/u,
  )?.[0] ?? "";
  const publicationTypeField = catalogSearch.match(
    /<span>Тип видання<\/span>[\s\S]*?<\/label>/u,
  )?.[0] ?? "";

  assert.match(workspace, /subjects: string\[\]/u);
  assert.match(workspace, /publicationTypes: string\[\]/u);
  assert.match(workspace, /setSubjects\(response\.subjects \?\? \[\]\)/u);
  assert.match(workspace, /setPublicationTypes\(response\.publicationTypes \?\? \[\]\)/u);

  assert.match(subjectField, /list="catalog-subject-options"/u);
  assert.match(subjectField, /aria-autocomplete="list"/u);
  assert.match(subjectField, /onChange=\{\(event\) => update\("subject", event\.target\.value\)\}/u);
  assert.doesNotMatch(subjectField, /<select/u, "subject search must still accept a new text value");
  assert.match(catalogSearch, /<datalist id="catalog-subject-options">/u);
  assert.match(catalogSearch, /subjects\.map\(\(subject\) =>/u);

  assert.match(publicationTypeField, /list="catalog-publication-type-options"/u);
  assert.match(publicationTypeField, /aria-autocomplete="list"/u);
  assert.match(publicationTypeField, /onChange=\{\(event\) => update\("publicationType", event\.target\.value\)\}/u);
  assert.doesNotMatch(publicationTypeField, /<select/u, "publication type search must still accept a new text value");
  assert.match(catalogSearch, /<datalist id="catalog-publication-type-options">/u);
  assert.match(catalogSearch, /publicationTypes\.map\(\(publicationType\) =>/u);

  assert.match(catalogSearch, /<span>Рубрика<\/span>[\s\S]*?<select/u);
  assert.match(catalogSearch, /Підказки недоступні\. Введіть повну назву предмета вручну\./u);
  assert.match(catalogSearch, /Підказки недоступні\. Введіть повну назву типу видання вручну\./u);
  assert.match(styles, /\.autocompleteFilter/u);
});

test("new material form suggests catalog facets and similar titles without submitting", async () => {
  const [workspace, styles] = await Promise.all([
    read("app/librarian/d1-workspace.tsx"),
    read("app/librarian/d1-workspace.module.css"),
  ]);
  const createPanel = workspace.match(
    /function MaterialCreatePanel[\s\S]*?(?=function ReceiptPanel)/u,
  )?.[0] ?? "";

  assert.match(createPanel, /rubrics: string\[\]/u);
  assert.match(createPanel, /subjects: string\[\]/u);
  assert.match(createPanel, /publicationTypes: string\[\]/u);
  assert.match(createPanel, /facetsState: LoadState/u);

  assert.match(createPanel, /list="create-material-rubric-options"/u);
  assert.match(createPanel, /<datalist id="create-material-rubric-options">[\s\S]*?rubrics\.map/u);
  assert.match(createPanel, /list="create-material-subject-options"/u);
  assert.match(createPanel, /<datalist id="create-material-subject-options">[\s\S]*?subjects\.map/u);
  assert.match(createPanel, /list="create-material-publication-type-options"/u);
  assert.match(createPanel, /<datalist id="create-material-publication-type-options">[\s\S]*?publicationTypes\.map/u);
  assert.match(createPanel, /aria-autocomplete="list"/u);

  assert.match(createPanel, /query\.length < 2/u);
  assert.match(createPanel, /window\.setTimeout\(async \(\) =>/u);
  assert.match(createPanel, /apiJson<SearchEnvelope>\([\s\S]*?buildMaterialTitleSuggestionUrl\(query\)/u);
  assert.match(workspace, /function buildMaterialTitleSuggestionUrl[\s\S]*?params\.set\("title", title\.trim\(\)\)[\s\S]*?params\.set\("sort", "title"\)[\s\S]*?params\.set\("limit", "20"\)/u);
  assert.match(createPanel, /\.slice\(0, 6\)/u);
  assert.match(createPanel, /role="combobox"/u);
  assert.match(createPanel, /role="listbox"/u);
  assert.match(createPanel, /role="option"/u);
  assert.match(createPanel, /event\.key === "ArrowDown"/u);
  assert.match(createPanel, /event\.key === "ArrowUp"/u);
  assert.match(createPanel, /event\.key === "Enter" && titleSuggestionsVisible/u);
  assert.match(createPanel, /event\.key === "Escape"/u);

  const selectTitleSuggestion = createPanel.match(
    /function selectTitleSuggestion[\s\S]*?(?=function handleTitleKeyDown)/u,
  )?.[0] ?? "";
  assert.match(selectTitleSuggestion, /title: item\.title/u);
  assert.match(selectTitleSuggestion, /setTitleSuggestionsOpen\(false\)/u);
  assert.doesNotMatch(selectTitleSuggestion, /submit|requestId|method:/u);
  assert.match(createPanel, /className=\{`\$\{styles\.fieldWide\} \$\{styles\.duplicateWarning\}`\}/u);
  assert.match(createPanel, /Такий матеріал уже є в каталозі/u);
  assert.match(createPanel, /onOpenExisting\(duplicateCandidate\.id\)/u);
  assert.match(createPanel, /<button type="button" onClick=\{\(\) => onOpenExisting/u);

  assert.match(styles, /\.createTitleInputWrap/u);
  assert.match(styles, /\.createTitleSuggestions/u);
  assert.match(styles, /\.duplicateWarning/u);
});

test("shared cover field offers separate accessible camera and gallery controls on mobile", async () => {
  const [workspace, styles] = await Promise.all([
    read("app/librarian/d1-workspace.tsx"),
    read("app/librarian/d1-workspace.module.css"),
  ]);
  const coverField = workspace.match(
    /function CoverPhotoField[\s\S]*?(?=async function deleteTemporaryCover)/u,
  )?.[0] ?? "";

  assert.match(coverField, /Зробити фото[\s\S]*?accept="image\/\*"[\s\S]*?capture="environment"/u);
  assert.match(coverField, /aria-label="Зробити фото обкладинки камерою"/u);
  assert.match(coverField, /Обрати з галереї[\s\S]*?accept="image\/jpeg,image\/png,image\/webp"/u);
  assert.match(coverField, /aria-label="Обрати фото обкладинки з галереї"/u);
  assert.equal(coverField.match(/type="file"/gu)?.length, 2);
  assert.equal(coverField.match(/capture="environment"/gu)?.length, 1);
  assert.equal(coverField.match(/onChange=\{\(event\) => choosePhoto\(event\.currentTarget\)\}/gu)?.length, 2);
  assert.match(coverField, /function choosePhoto\(input: HTMLInputElement\)[\s\S]*?upload\.choose\(file\)/u);
  assert.equal(workspace.match(/<CoverPhotoField/gu)?.length, 2);

  assert.match(styles, /\.directCoverActions label \{[\s\S]*?min-height: 44px/u);
  assert.match(styles, /@media \(max-width: 500px\)[\s\S]*?\.directCoverField \{ grid-template-columns: 1fr;/u);
  assert.match(styles, /@media \(max-width: 500px\)[\s\S]*?\.directCoverActions \{ display: grid; grid-template-columns: 1fr; \}/u);
  assert.match(styles, /\.directCoverActions label:focus-within/u);
});

test("active D1 ISBN scanner keeps mobile camera access independent from native detection", async () => {
  const workspace = await read("app/librarian/d1-workspace.tsx");
  const scanner = workspace.match(
    /function isbnCameraErrorMessage[\s\S]*?(?=function pidruchnykSearchUrl)/u,
  )?.[0] ?? "";

  assert.ok(scanner, "active D1 ISBN scanner source should be present");

  const mediaRequest = scanner.indexOf("navigator.mediaDevices.getUserMedia");
  const nativeDetectorProbe = scanner.indexOf("const detectorConstructor");
  assert.ok(mediaRequest >= 0, "scanner should request the camera");
  assert.ok(nativeDetectorProbe > mediaRequest, "camera request must precede the native BarcodeDetector probe");
  assert.doesNotMatch(scanner, /!detectorConstructor\s*\|\|\s*!navigator\.mediaDevices\?\.getUserMedia/u);

  assert.match(scanner, /detectorConstructor\.getSupportedFormats/u);
  assert.match(scanner, /supportedFormats\.includes\("ean_13"\)/u);
  assert.match(scanner, /new detectorConstructor\(\{ formats: \["ean_13"\] \}\)/u);

  assert.match(scanner, /import\("@zxing\/browser"\)[\s\S]*?import\("@zxing\/library"\)/u);
  assert.match(scanner, /DecodeHintType\.POSSIBLE_FORMATS, \[BarcodeFormat\.EAN_13\]/u);
  assert.match(scanner, /new BrowserMultiFormatOneDReader\(hints\)/u);
  assert.match(scanner, /reader\.decodeFromStream\(stream, video,/u);

  assert.match(scanner, /const startingRef = useRef\(false\)/u);
  assert.match(scanner, /if \(startingRef\.current \|\| scanningRef\.current\) return/u);
  assert.match(scanner, /startingRef\.current = true/u);
  assert.match(scanner, /finally \{[\s\S]*?startingRef\.current = false/u);

  assert.match(scanner, /<video ref=\{videoRef\} autoPlay muted playsInline \/>/u);
  assert.match(scanner, /window\.addEventListener\("pagehide", handlePageHide\)/u);
  assert.match(scanner, /window\.removeEventListener\("pagehide", handlePageHide\)/u);
  assert.match(scanner, /controlsRef\.current\?\.stop\(\)/u);
  assert.match(scanner, /streamRef\.current\?\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/u);
  assert.match(scanner, /videoRef\.current\.srcObject = null/u);
  assert.match(scanner, /return \(\) => \{[\s\S]*?releaseCamera\(\)/u);

  assert.match(scanner, /name === "NotAllowedError" \|\| name === "SecurityError"[\s\S]*?Доступ до камери заборонено/u);
  assert.match(scanner, /name === "NotFoundError" \|\| name === "DevicesNotFoundError"[\s\S]*?Камеру не знайдено/u);
  assert.match(scanner, /name === "NotReadableError" \|\| name === "TrackStartError"[\s\S]*?її використовує інша програма/u);
  assert.match(scanner, /Цей браузер не надає доступу до камери/u);
  assert.match(scanner, /Не вдалося запустити сканування/u);
});

test("new librarian route renders D1 workspace inside the shared branded shell", async () => {
  const [page, workspace, shell, routes, client, styles] = await Promise.all([
    read("app/librarian/page.tsx"),
    read("app/librarian/d1-workspace.tsx"),
    read("app/librarian/_components/librarian-shell.tsx"),
    read("app/librarian/_components/librarian-routes.ts"),
    read("lib/librarian-d1-client.ts"),
    read("app/librarian/d1-workspace.module.css"),
  ]);

  assert.match(page, /import D1LibrarianWorkspace from "\.\/d1-workspace"/u);
  assert.match(page, /<D1LibrarianWorkspace/u);
  assert.match(workspace, /<LibrarianShell/u);
  assert.match(shell, /LIBRARY_EMBLEM_URL/u);
  assert.match(shell, /target="_blank"/u);
  assert.match(shell, /rel="noopener noreferrer"/u);
  assert.match(routes, /PUBLIC_CATALOG_URL = "https:\/\/nazarijshvetz1\.github\.io\/library-site\/"/u);
  assert.doesNotMatch(
    workspace,
    /<Link href="\/" className=\{styles\.catalogLink\}>/u,
  );
  assert.match(client, /\/api\/librarian\/materials\/search/u);
  assert.match(workspace, /\/api\/librarian\/materials\/facets/u);
  assert.match(workspace, /<option value="">Усі<\/option>/u);
  assert.doesNotMatch(workspace, /Усі рубрики/u);
  assert.match(workspace, /role="combobox"/u);
  assert.match(workspace, /aria-autocomplete="list"/u);
  assert.match(workspace, /role="listbox"/u);
  assert.match(workspace, /role="option"/u);
  assert.match(workspace, /resolvedSearchScope === catalogFiltersKey\(filters\)/u);
  assert.match(workspace, /normalizedQuery\.length >= 2 && suggestionsReady/u);
  assert.match(workspace, /titleQueryTokens\.every\(\(token\) => normalizedTitle\.includes\(token\)\)/u);
  assert.match(workspace, /\}\)\.slice\(0, 6\)/u);
  assert.match(workspace, /event\.key === "ArrowDown"/u);
  assert.match(workspace, /event\.key === "ArrowUp"/u);
  assert.match(workspace, /event\.key === "Enter"/u);
  assert.match(workspace, /selectSuggestion\(activeSuggestionItem\)/u);
  assert.match(styles, /\.suggestions/u);
  assert.match(styles, /max-height: min\(390px, 58vh\)/u);
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
  assert.match(workspace, /expectedSourceQuantity: source\?\.physicalQuantity/u);
  assert.match(workspace, /expectedDestinationQuantity: destinationHolding\?\.physicalQuantity \?\? 0/u);
  assert.match(workspace, /\/api\/librarian\/writeoffs/u);
  assert.match(workspace, /expectedQuantity: source\?\.physicalQuantity/u);
  assert.match(workspace, /const expectedQuantity = holding\?\.physicalQuantity \?\? 0/u);
  assert.match(workspace, /const expectedQuantity = selected\?\.physicalQuantity \?\? 0/u);
  assert.match(workspace, /Де знаходяться примірники/u);
  assert.match(workspace, /physicalAtLocations/u);
  assert.match(workspace, /holding\.physicalQuantity/u);
  assert.match(workspace, /holding\.reservedQuantity/u);
  assert.match(workspace, /holding\.availableQuantity/u);
  assert.match(workspace, /onClick=\{\(\) => chooseHolding\(holding\)\}/u);
  assert.match(workspace, /max=\{source\?\.quantity \?\? 1\}/u);
  assert.match(workspace, /Фізично \{holding\.physicalQuantity\} · у резерві \{holding\.reservedQuantity\}/u);
  assert.match(workspace, /requestError\.code === "stock_quantity_conflict"/u);
  assert.match(workspace, /window\.confirm/u);
  assert.match(workspace, /selectedIdRef\.current !== materialId/u);
  assert.match(workspace, /detailRequestRef\.current/u);
  assert.match(workspace, /catalogRevisionRef\.current !== requestRevision/u);
  assert.match(workspace, /loadMoreRequestRef = useRef\(0\)/u);
  assert.match(workspace, /requestSequence === loadMoreRequestRef\.current && catalogRevisionRef\.current === requestRevision/u);
  assert.match(workspace, /writePendingInventoryIntent\(intent\)/u);
  assert.match(workspace, /retryPending \? "Перевірити результат"/u);
  assert.match(workspace, /role=\{tone === "error" \? "alert" : "status"\}/u);
  assert.match(workspace, /\/api\/librarian\/isbn-lookup\?isbn=/u);
  assert.match(workspace, /<LoanReturnPanel[\s\S]*?locations=\{locations\}/u);
  assert.match(workspace, /\/api\/librarian\/locations/u);
  assert.match(workspace, /function LocationManagementPanel/u);
  assert.match(workspace, /function IsbnCameraScanner/u);
  assert.match(workspace, /\/api\/librarian\/cover-photo\/remote\?url=/u);
  assert.match(workspace, /candidate\.coverUrl\) onCover\(candidate\)/u);
  assert.match(workspace, /Шукати на Pidruchnyk\.com\.ua/u);
  assert.match(workspace, /Шукати на Yakaboo/u);
  assert.match(workspace, /tool === "create" \? styles\.workGridCreate/u);
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
  assert.match(workspace, /item\.author/u);
  assert.match(workspace, /item\.year \? String\(item\.year\)/u);
  assert.doesNotMatch(workspace, /Ревізія/u);

  const classIssue = workspace.match(
    /function ClassIssueWorkspace[\s\S]*?(?=function LoanReturnPanel)/u,
  )?.[0] ?? "";
  assert.match(classIssue, /classYear\.status === "active"/u);
  assert.match(classIssue, /year\.status === "active"/u);
  assert.match(classIssue, /cohort\.status === "active"/u);
  assert.match(classIssue, /assignedTeacherUserId/u);
  assert.match(classIssue, /expectedClassYearVersion: selectedClassYear\.version/u);
  assert.match(classIssue, /expectedAvailableQuantity: item\.expectedAvailableQuantity/u);
  assert.match(classIssue, /cart\.length >= 100/u);
  assert.match(classIssue, /window\.confirm/u);
  assert.match(classIssue, /"\/api\/librarian\/class-loans"/u);
  assert.match(classIssue, /writePendingClassCirculationIntent\(intent\)/u);
  assert.match(classIssue, /sendIssueIntent\(pendingIntent, true\)/u);
  assert.match(classIssue, /max=\{selectedClassYear\?\.endDate\}/u);
  assert.match(classIssue, /ref=\{issuedAtInputRef\}/u);
  assert.match(classIssue, /ref=\{classDueAtInputRef\}/u);
  assert.match(classIssue, /materialPickerRef/u);
  assert.match(classIssue, /lastFocusedMaterialIdRef/u);
  assert.match(classIssue, /referenceState !== "ready"/u);
  assert.match(classIssue, /academicState !== "ready"/u);
  assert.match(classIssue, /scrollIntoView\(\{ block: "start", behavior: "auto" \}\)/u);
  assert.match(classIssue, /picker\.focus\(\{ preventScroll: true \}\);\s*lastFocusedMaterialIdRef\.current = detail\.id;/u);
  assert.match(classIssue, /tabIndex=\{-1\}/u);
  assert.doesNotMatch(
    classIssue.match(/ref=\{issuedAtInputRef\}[\s\S]*?\/>/u)?.[0] ?? "",
    /onChange=/u,
  );

  const classReturn = workspace.match(
    /function ClassReturnWorkspace[\s\S]*?(?=function Cover\()/u,
  )?.[0] ?? "";
  assert.match(classReturn, /\/api\/librarian\/class-loans\?limit=200/u);
  assert.match(classReturn, /"\/api\/librarian\/class-loans\/returns"/u);
  assert.match(classReturn, /expectedVersion: loan\.version/u);
  assert.match(classReturn, /quantityOutstanding/u);
  assert.match(classReturn, /returnLocationId/u);
  assert.match(classReturn, /window\.confirm/u);
  assert.match(classReturn, /sendReturnIntent\(pendingIntent, true\)/u);
  assert.match(classReturn, /ref=\{classReturnedAtInputRef\}/u);
  assert.match(classReturn, /aria-busy=\{locked\}/u);
  assert.match(styles, /\.classCirculationCard[\s\S]*?min-height: 44px/u);

  const academic = await read("app/librarian/academic-workspace.tsx");
  assert.match(academic, /\/api\/librarian\/academic-reference/u);
  assert.match(academic, /\/api\/librarian\/academic-years"/u);
  assert.match(academic, /\/api\/librarian\/class-years"/u);
  assert.match(academic, /\/close/u);
  assert.match(academic, /\/academic-years\/rollover/u);
  assert.match(academic, /reference\.curators/u);
  assert.match(academic, /curatorRoleLabel/u);
  assert.match(academic, /expectedVersion: selected\.version/u);
  assert.match(academic, /sourceYearVersion: sourceYear\.version/u);
  assert.match(academic, /targetYearVersion: targetYear\.version/u);
  assert.match(academic, /suggestNextAcademicYearStart\(\s*reference\.academicYears/u);
  assert.match(academic, /suggestedStart \+ 1\}-05-31/u);
  assert.match(academic, /Завершення \(31 травня\)/u);
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

test("D1 workspace opens on a grouped accessible dashboard and keeps every tool in URL history", async () => {
  const [workspace, styles] = await Promise.all([
    read("app/librarian/d1-workspace.tsx"),
    read("app/librarian/d1-workspace.module.css"),
  ]);

  assert.match(workspace, /\| "dashboard"/u);
  assert.match(workspace, /useState<Tool>\("dashboard"\)/u);
  assert.match(workspace, /const TOOL_GROUPS: ToolGroup\[\]/u);
  for (const label of ["Фонд", "Видача й повернення", "Класи й навчальний рік", "Налаштування"]) {
    assert.match(workspace, new RegExp(label, "u"));
  }
  assert.match(workspace, /function DashboardPanel/u);
  assert.match(workspace, /Знайдіть матеріал або відскануйте ISBN/u);
  const dashboardPanel = workspace.match(
    /function DashboardPanel[\s\S]*?(?=function CatalogSearch)/u,
  )?.[0] ?? "";
  assert.match(
    dashboardPanel,
    /const nextQuery = event\.currentTarget\.value;[\s\S]*?onFilters\(\(current\) => \(\{ \.\.\.current, q: nextQuery \}\)\)/u,
  );
  assert.doesNotMatch(dashboardPanel, /q: event\.currentTarget\.value/u);
  assert.match(workspace, /"return",[\s\S]*?"issue",[\s\S]*?"class-issue",[\s\S]*?"receipt",[\s\S]*?"create",[\s\S]*?"count"/u);
  assert.match(workspace, /<IsbnCameraScanner disabled=\{false\} onDetected=\{searchScannedIsbn\}/u);
  assert.match(workspace, /const MATERIAL_ACTION_ITEMS: ToolItem\[\]/u);
  assert.match(workspace, /\["issue", "return", "class-issue", "class-return"\]\.includes\(tool\)/u);
  assert.match(workspace, /tool === "issue" \? "issue" : "catalog"/u);
  assert.match(workspace, /tool === "catalog" \|\| tool === "class-issue"/u);
  assert.match(workspace, /subsections=\{shellSubsections\}/u);
  assert.match(workspace, /activeSubsection=\{librarianSubsectionForTool\(tool\)\}/u);
  assert.match(workspace, /onSubsectionNavigate=\{\(id\) => chooseTool\(id as Tool\)\}/u);
  assert.doesNotMatch(workspace, /<aside className=\{styles\.sidebar\}/u);
  assert.doesNotMatch(workspace, /<optgroup label=\{group\.label\}/u);
  for (const action of ["issue", "receipt", "transfer", "count", "writeoff"]) {
    assert.match(workspace, new RegExp(`onClick=\\{\\(\\) => onChooseTool\\("${action}"\\)\\}`, "u"));
  }
  assert.match(workspace, /onClick=\{\(\) => onEditing\(true\)\}/u);

  assert.match(workspace, /function parseTool\(value: string \| null\): Tool \| null/u);
  assert.match(workspace, /new URL\(window\.location\.href\)/u);
  assert.match(workspace, /url\.searchParams\.set\("tool", requestedTool\)/u);
  assert.match(workspace, /if \(!parseTool\(url\.searchParams\.get\("tool"\)\) && !telegramMiniApp\)/u);
  assert.match(workspace, /window\.history\.replaceState/u);
  assert.match(workspace, /window\.history\[method\]/u);
  assert.match(workspace, /window\.dispatchEvent\(new Event\("librarian:navigation-change"\)\)/u);
  assert.match(workspace, /currentTool === nextTool \? "replaceState" : "pushState"/u);
  assert.match(workspace, /if \(!telegramMiniApp\) \{[\s\S]*?window\.history\[method\]/u);
  assert.match(workspace, /function openCatalog\(event: FormEvent<HTMLFormElement>\) \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?onChooseTool\("catalog"\);/u);
  assert.match(workspace, /window\.addEventListener\("popstate", applyToolFromLocation\)/u);
  assert.match(workspace, /librarianSectionHref\("visits", telegramMiniApp\)/u);
  assert.match(workspace, /librarianSectionHref\("orders", telegramMiniApp\)/u);
  assert.match(workspace, /librarianSectionHref\("acquisitions", telegramMiniApp\)/u);
  assert.match(workspace, /setAcquisitionReturnId\(\(url\.searchParams\.get\("acquisition"\)/u);
  assert.match(workspace, /url\.searchParams\.get\("material"\)/u);

  assert.match(styles, /\.dashboardHero/u);
  assert.match(styles, /\.dashboardQuickGrid/u);
  assert.match(styles, /\.toolGroup h2 \{[\s\S]*?font-size: 12px/u);
  assert.match(styles, /\.tool small,[\s\S]*?font-size: 12px/u);
  assert.match(styles, /\.sidebar,[\s\S]*?\.mobileTools \{ display: none!important; \}/u);
  assert.match(styles, /\.workGridSelected \.searchPane \{ display: none; \}/u);
  assert.match(styles, /\.workGridSelected \.backToResults \{[\s\S]*?display: inline-flex;/u);
});

test("protected navigation uses full-page anchors so Vinext cannot swallow clicks", async () => {
  const [catalog, visits, teachers, shell, routes] = await Promise.all([
    read("app/librarian/d1-workspace.tsx"),
    read("app/librarian/visits/visit-admin-workspace.tsx"),
    read("app/librarian/teachers/teacher-management-workspace.tsx"),
    read("app/librarian/_components/librarian-shell.tsx"),
    read("app/librarian/_components/librarian-routes.ts"),
  ]);

  for (const source of [catalog, visits, teachers, shell]) {
    assert.doesNotMatch(source, /from "next\/link"/u);
  }
  for (const source of [catalog, visits, teachers]) assert.match(source, /<LibrarianShell/u);
  assert.match(shell, /href=\{librarianSectionHref\(item\.id, telegramMiniApp\)\}/u);
  assert.match(routes, /visits: "\/librarian\/visits"/u);
  assert.match(routes, /teachers: "\/librarian\/teachers"/u);
  assert.match(routes, /visits: "\/librarian\/telegram\/cabinet\?target=visits"/u);
  assert.match(routes, /teachers: "\/librarian\/telegram\/cabinet\?target=teachers"/u);
});
