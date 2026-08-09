import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  academicYearApplyConfirmation,
  classifyDraftApplyResponse,
  draftApplyDisabledReason,
  draftApplyUiAction,
  refreshedDraftApplyOutcome,
  UNKNOWN_APPLY_MESSAGE,
} from "../lib/draft-apply-ui.ts";

const DRAFT_KINDS = [
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
];

const workspace = await readFile(
  new URL("../app/librarian/workspace.tsx", import.meta.url),
  "utf8",
);
const styles = await readFile(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);

test("workspace exposes every supported draft workflow without direct Sheets writes", () => {
  for (const kind of DRAFT_KINDS) {
    assert.match(workspace, new RegExp(`kind: \\"${kind.replaceAll(".", "\\.")}\\"`));
  }
  assert.match(workspace, /Google Sheets не змінено/);
  assert.doesNotMatch(workspace, /spreadsheets\/d\//);
});

test("apply controls are limited to reviewed academic-year drafts", () => {
  for (const kind of DRAFT_KINDS) {
    for (const status of [
      "draft",
      "ready_for_review",
      "approved_pending_apply",
      "applied",
      "failed",
      "cancelled",
    ]) {
      const expected = kind === "academic-year.create" && status === "ready_for_review"
        ? "apply"
        : kind === "academic-year.create" && status === "approved_pending_apply"
          ? "resume"
          : null;
      assert.equal(draftApplyUiAction(kind, status), expected, `${kind} / ${status}`);
    }
  }

  assert.equal(
    draftApplyDisabledReason(false, true, 1),
    "Запис у Google Sheets вимкнено адміністратором",
  );
  assert.equal(
    draftApplyDisabledReason(true, false, 1),
    "Захищений шлюз Google Sheets не налаштовано",
  );
  assert.equal(draftApplyDisabledReason(true, true, 0), "Оновіть дані чернетки");
  assert.equal(draftApplyDisabledReason(true, true, 3), null);
});

test("academic-year apply requires an exact confirmation and resumable request", () => {
  const payload = {
    label: "2028/2029",
    startDate: "2028-09-01",
    endDate: "2029-08-31",
  };
  const confirmation = academicYearApplyConfirmation(payload, "apply");
  assert.match(confirmation, /реальний запис у Google Sheets/);
  assert.match(confirmation, /2028\/2029/);
  assert.match(confirmation, /2028-09-01/);
  assert.match(confirmation, /2029-08-31/);
  assert.match(confirmation, /Статус нового рядка: Чернетка/);
  assert.match(confirmation, /дубль не створюється/);
  assert.match(confirmation, /Скасування цього запису через сайт поки немає/);

  const resume = academicYearApplyConfirmation(payload, "resume");
  assert.match(resume, /Новий запит не створюється/);
  assert.match(resume, /не допустити дубля/);
});

test("apply result messages distinguish confirmed, stale, rejected, and unknown outcomes", () => {
  const appliedDraft = {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "academic-year.create",
    status: "applied",
    revision: 3,
    payload: { label: "2028/2029" },
  };
  const success = classifyDraftApplyResponse(200, {
    success: true,
    draft: appliedDraft,
    result: {
      academicYearId: "YR-2028-2029",
      sheet: "Навчальні роки",
      row: 4,
    },
  });
  assert.equal(success.phase, "success");
  assert.match(success.message, /YR-2028-2029/);
  assert.match(success.message, /рядок 4/);

  const idempotent = classifyDraftApplyResponse(200, {
    success: true,
    idempotent: true,
    draft: appliedDraft,
  });
  assert.match(idempotent.message, /дубль не створено/);

  const rejected = classifyDraftApplyResponse(422, {
    success: false,
    code: "invalid_year",
    error: "Навчальний рік має некоректні дати.",
  });
  assert.equal(rejected.phase, "error");
  assert.equal(rejected.stale, false);
  assert.equal(rejected.message, "Навчальний рік має некоректні дати.");

  const stale = classifyDraftApplyResponse(409, {
    success: false,
    code: "draft_revision_conflict",
  });
  assert.equal(stale.phase, "error");
  assert.equal(stale.stale, true);

  for (const [status, code] of [
    [502, "apply_outcome_unknown"],
    [503, "draft_apply_unavailable"],
    [502, ""],
    [500, ""],
    [0, ""],
  ]) {
    const unknown = classifyDraftApplyResponse(status, { success: false, code });
    assert.equal(unknown.phase, "unknown");
    assert.equal(unknown.message, UNKNOWN_APPLY_MESSAGE);
    assert.doesNotMatch(unknown.message, /не змінено|не було внесено/i);
  }

  const safelyDisabled = classifyDraftApplyResponse(503, {
    success: false,
    code: "librarian_writes_disabled",
    error: "Застосування чернеток вимкнено.",
  });
  assert.equal(safelyDisabled.phase, "error");
  assert.equal(safelyDisabled.message, "Застосування чернеток вимкнено.");

  for (const body of [
    { success: true },
    { success: true, draft: {} },
    null,
    "<html>unexpected response</html>",
  ]) {
    const malformedSuccess = classifyDraftApplyResponse(200, body);
    assert.equal(malformedSuccess.phase, "unknown");
  }

  assert.equal(refreshedDraftApplyOutcome("applied")?.phase, "success");
  assert.match(refreshedDraftApplyOutcome("applied")?.message ?? "", /підтверджено/);
  assert.equal(refreshedDraftApplyOutcome("failed")?.phase, "error");
  assert.equal(refreshedDraftApplyOutcome("approved_pending_apply")?.phase, "unknown");
  assert.equal(refreshedDraftApplyOutcome("ready_for_review"), null);
});

test("workspace sends only draft identity and revision and blocks duplicate apply clicks", () => {
  const applyFetchStart = workspace.indexOf('fetch("/api/librarian/drafts/apply"');
  assert.ok(applyFetchStart >= 0);
  const applyFetchBlock = workspace.slice(applyFetchStart, applyFetchStart + 500);
  assert.match(applyFetchBlock, /JSON\.stringify\(\{ id: draft\.id, revision: draft\.revision \}\)/);
  assert.doesNotMatch(applyFetchBlock, /requestId|payload|kind|spreadsheet/i);
  assert.match(workspace, /if \(applyInFlightRef\.current\) return;/);
  assert.match(workspace, /applyInFlightRef\.current = draft\.id/);
  assert.match(workspace, /applyInFlightRef\.current = null/);
  assert.match(workspace, /aria-busy=\{applyingThisDraft\}/);
  assert.match(workspace, /Перевірити результат/);
  assert.match(workspace, /await loadWorkspace\(\)/);
  assert.match(workspace, /refreshedDraftApplyOutcome\(refreshed\?\.status \?\? ""\)/);
  assert.match(workspace, /const recoverable = drafts\.filter\(\(draft\) => draftApplyUiAction/);
  assert.match(workspace, /disabled=\{loadState === "loading" \|\| applyState\.phase === "applying"\}/);
});

test("existing drafts use optimistic revisions and PATCH transitions", () => {
  assert.match(workspace, /revision: number;/);
  assert.match(workspace, /typeof revision === "number" \? \{ revision \} : \{\}/);
  assert.match(workspace, /method: "PATCH"/);
  assert.match(workspace, /JSON\.stringify\(\{ id, revision, action \}\)/);
  assert.match(workspace, /response\.status === 409 \|\| response\.status === 428/);
  assert.match(workspace, /Дані не перезаписано/);
  assert.match(workspace, /setStale\(true\)/);
});

test("protected references show names while preserving paired IDs and snapshots", () => {
  assert.match(workspace, /fetch\("\/api\/librarian\/reference-data"/);
  assert.match(workspace, /appendDirectorySnapshot/);
  assert.match(workspace, /teacherUserId", "teacherName"/);
  assert.match(workspace, /locationId", "locationName"/);
  assert.match(workspace, /location\.id !== "LOC-007"/);
  assert.match(workspace, /location\.id !== "LOC-008"/);
  assert.doesNotMatch(workspace, /teacher\.email|item\.email|\.email\}/);
});

test("academic rollover serializes reviewed class rows as a nested draft payload", () => {
  assert.match(workspace, /name="rolloverClassesJson"/);
  assert.match(workspace, /flat\.classes = Array\.isArray\(parsed\) \? parsed : \[\]/);
  assert.match(workspace, /sourceClassYearId/);
  assert.match(workspace, /cohortId/);
  assert.match(workspace, /targetGrade/);
  assert.match(workspace, /overrideReason/);
});

test("unsaved work is guarded and reopening the same draft refreshes local revision state", () => {
  assert.match(workspace, /formHasUnsavedChanges/);
  assert.match(workspace, /Є незбережені зміни\. Відкинути їх/);
  assert.match(workspace, /beforeunload/);
  assert.match(workspace, /formOpenVersion/);
  assert.match(workspace, /setFormOpenVersion\(\(current\) => current \+ 1\)/);
  assert.match(workspace, /loadedDrafts\.find\(\(draft\) => draft\.id === currentEditingDraft\.id\)/);
  assert.match(workspace, /refreshedDraft[\s\S]*?!formStateRef\.current\.dirty[\s\S]*?!formStateRef\.current\.stale/);
  assert.match(workspace, /setEditingDraft\(refreshedDraft\);\s*setFormOpenVersion\(\(current\) => current \+ 1\)/);
  assert.match(workspace, /onStaleChange=\{handleFormStaleChange\}/);
  assert.doesNotMatch(workspace, /setDraftRevision\(initialDraft\.revision\)/);
});

test("programmatic material selection and scanning mark an existing draft dirty", () => {
  assert.match(workspace, /function MaterialPicker\([\s\S]*?onDirty: \(\) => void/);
  assert.match(workspace, /const selectMaterial[\s\S]*?onDirty\(\);/);
  assert.match(workspace, /const handleScan[\s\S]*?setShowResults\(true\);\s*onDirty\(\);/);
  assert.match(workspace, /onClick=\{\(\) => \{ setSelectedId\(""\);[\s\S]*?onDirty\(\); \}\}/);
});

test("cover links never become browser image requests and saved photos use two-phase cleanup", () => {
  assert.match(workspace, /const uploadedPreviewUrl = coverPhotoKey\s*\? `\/api\/librarian\/cover-photo/);
  assert.match(workspace, /<img src=\{uploadedPreviewUrl\}/);
  assert.doesNotMatch(workspace, /<img src=\{coverSourceUrl/);
  assert.doesNotMatch(workspace, /const previewUrl =[\s\S]*?: coverSourceUrl\.trim\(\)/);
  assert.match(workspace, /Фото від’єднано у формі\. Збережіть чернетку/);
  assert.match(workspace, /previousCoverPhotoKey !== savedCoverPhotoKey/);
  assert.match(workspace, /deleteOwnedCoverPhoto\(previousCoverPhotoKey\)/);
  assert.match(workspace, /unsavedPhotoKey !== savedCoverPhotoKeyRef\.current/);
  assert.match(workspace, /uploadRequestGenerationRef\.current \+= 1/);
  assert.match(workspace, /!mountedRef\.current \|\| uploadGeneration !== uploadRequestGenerationRef\.current\) \{\s*await deleteOwnedCoverPhoto\(key\);/);
  assert.match(workspace, /data-cover-upload-pending=\{uploadState\.phase === "saving"/);
  assert.match(workspace, /querySelector\('\[data-cover-upload-pending="true"\]'\)/);
  assert.match(workspace, /const uploadPhoto = async \(file: File\)[\s\S]*?onDirty\(\);[\s\S]*?setUploadState\(\{ phase: "saving"/);
});

test("required operation dates and rollover constraints match server validation", () => {
  assert.equal(
    workspace.match(/name="date" type="date" required/g)?.length,
    4,
  );
  assert.match(workspace, /option value="graduate" disabled=\{row\.sourceGrade !== 11\}/);
  assert.match(workspace, /Новий код <b aria-hidden="true">\*<\/b>[\s\S]*?<input type="text" maxLength=\{16\} required/);
  assert.match(workspace, /rolloverRowsFromPayload\(initialPayload, referenceData\)/);
  assert.match(workspace, /sourceClass\?\.className/);
});

test("ISBN lookup ignores stale responses and preserves manually reviewed values", () => {
  assert.match(workspace, /lookupAbortRef\.current\?\.abort\(\)/);
  assert.match(workspace, /signal: controller\.signal/);
  assert.match(workspace, /sequence !== lookupSequenceRef\.current/);
  assert.match(workspace, /manualFieldsRef\.current\.title/);
  assert.match(workspace, /manualFieldsRef\.current\.coverSourceUrl/);
});

test("mobile and upload controls expose focus and safe-area protections", () => {
  assert.match(workspace, /event\.key === "Tab"/);
  assert.match(workspace, /capture="environment"/);
  assert.match(workspace, /fallbackRequestedRef\.current = true;\s*stop\(\)/);
  assert.match(workspace, /if \(fallbackRequestedRef\.current\)[\s\S]*?onFallbackRef\.current\(\)/);
  assert.doesNotMatch(workspace, /stop\(\);\s*onFallback\(\)/);
  assert.match(styles, /\.cover-upload-button:focus-within/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
});
