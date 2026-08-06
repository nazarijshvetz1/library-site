import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workspace = await readFile(
  new URL("../app/librarian/workspace.tsx", import.meta.url),
  "utf8",
);
const styles = await readFile(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);

test("workspace exposes every supported draft workflow without direct Sheets writes", () => {
  for (const kind of [
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
  ]) {
    assert.match(workspace, new RegExp(`kind: \\"${kind.replaceAll(".", "\\.")}\\"`));
  }
  assert.match(workspace, /Google Sheets не змінено/);
  assert.doesNotMatch(workspace, /spreadsheets\/d\//);
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
