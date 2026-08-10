import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  classifyDraftApplyResponse,
  draftApplyConfirmation,
  draftApplyDisabledReason,
  draftApplyUiAction,
  refreshedDraftApplyOutcome,
  UNKNOWN_APPLY_MESSAGE,
} from "../lib/draft-apply-ui.ts";
import { validateDraftInput } from "../lib/draft-validation.ts";
import { validateDraftApplyInput } from "../lib/draft-apply-validation.ts";
import { draftGatewayFailureDisposition } from "../lib/draft-apply-disposition.ts";
import {
  draftApplyClaimDecision,
  draftApplyReturnDecision,
} from "../lib/draft-apply-state.ts";
import {
  fittedCoverDimensions,
  normalizedCoverFileName,
} from "../lib/cover-client.ts";
import {
  entityVersionIsCurrent,
  findEntityVersion,
  materialLocationQuantity,
} from "../lib/stale-snapshots.ts";

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
const applyRoute = await readFile(
  new URL("../app/api/librarian/drafts/apply/route.ts", import.meta.url),
  "utf8",
);
const sheetsGateway = await readFile(
  new URL("../lib/sheets-gateway.ts", import.meta.url),
  "utf8",
);

test("workspace exposes every supported draft workflow without direct Sheets writes", () => {
  for (const kind of DRAFT_KINDS) {
    assert.match(workspace, new RegExp(`kind: \\"${kind.replaceAll(".", "\\.")}\\"`));
  }
  assert.match(workspace, /Google Sheets не змінено/);
  assert.doesNotMatch(workspace, /spreadsheets\/d\//);
});

test("apply controls cover every reviewed draft kind and only resumable states", () => {
  for (const kind of DRAFT_KINDS) {
    for (const status of [
      "draft",
      "ready_for_review",
      "approved_pending_apply",
      "applied",
      "failed",
      "cancelled",
    ]) {
      const expected = status === "ready_for_review"
        ? "apply"
        : status === "approved_pending_apply"
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

test("every operation gets an exact Ukrainian confirmation and resumable request", () => {
  const payload = {
    label: "2028/2029",
    startDate: "2028-09-01",
    endDate: "2029-08-31",
  };
  const confirmation = draftApplyConfirmation("academic-year.create", payload, "apply");
  assert.match(confirmation, /реальний запис у Google Sheets/);
  assert.match(confirmation, /2028\/2029/);
  assert.match(confirmation, /2028-09-01/);
  assert.match(confirmation, /2029-08-31/);
  assert.match(confirmation, /Статус нового рядка: Чернетка/);
  assert.match(confirmation, /не створить дубль/);
  assert.match(confirmation, /унікальний номер/);

  const resume = draftApplyConfirmation("academic-year.create", payload, "resume");
  assert.match(resume, /Новий запит не створюється/);
  assert.match(resume, /не допустити дубля/);

  const samples = {
    "material.create": { title: "Математика", rubric: "Підручники" },
    "material.update": { materialId: "CAT-0001", changes: { title: "Нова назва" } },
    "receipt.create": { materialId: "CAT-0001", quantity: 2, locationName: "Бібліотека", date: "2026-08-10" },
    "transfer.create": { materialId: "CAT-0001", quantity: 1, fromLocationName: "Бібліотека", toLocationName: "Кабінет 1" },
    "writeoff.create": { materialId: "CAT-0001", quantity: 1, fromLocationName: "Бібліотека", destination: "written_off" },
    "revision.count": { materialId: "CAT-0001", countedQuantity: 3, locationName: "Бібліотека" },
    "academic-year.create": payload,
    "class-year.create": { academicYearId: "YR-2028-2029", grade: 1, code: "А" },
    "class-year.update": { classYearId: "CY-2028-001", changes: { code: "Б" } },
    "class-year.close": { classYearId: "CY-2028-001", actualClosedDate: "2029-06-30", reason: "closed" },
    "academic-year.rollover": { sourceYearId: "YR-2028-2029", targetYearId: "YR-2029-2030", effectiveDate: "2029-09-01", classes: [] },
  };
  for (const kind of DRAFT_KINDS) {
    const text = draftApplyConfirmation(kind, samples[kind], "apply");
    assert.match(text, /реальний запис у Google Sheets/);
    assert.match(text, /повторне натискання не створить дубль/);
    assert.ok(text.includes(kind === "material.create" ? "Математика" : "Операція:"));
  }
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
      requestId: "22222222-2222-4222-8222-222222222222",
      draftId: appliedDraft.id,
      kind: "academic-year.create",
      status: "applied",
      message: "Навчальний рік додано.",
      alreadyApplied: false,
      appliedAt: "2026-08-10T00:00:00.000Z",
      mutations: [{
        sheet: "Навчальні роки",
        row: 4,
        key: "YR-2028-2029",
        action: "create",
        entityId: "YR-2028-2029",
      }],
      entityIds: { academic_year_id: "YR-2028-2029" },
      summary: { label: "2028/2029" },
      cover: { status: "not_requested", permanent_url_written: false },
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

  const retryAfterConfiguration = classifyDraftApplyResponse(503, {
    success: false,
    code: "write_mode_disabled",
    error: "Налаштуйте режим запису й повторіть перевірку.",
    retryable: true,
    outcomeKnown: true,
  });
  assert.equal(retryAfterConfiguration.phase, "error");
  assert.equal(retryAfterConfiguration.stale, false);
  assert.match(retryAfterConfiguration.message, /повторіть перевірку/);

  const retryUnknown = classifyDraftApplyResponse(502, {
    success: false,
    code: "gateway_interrupted",
    retryable: true,
    outcomeKnown: false,
  });
  assert.equal(retryUnknown.phase, "unknown");

  const missingPrivatePhoto = classifyDraftApplyResponse(503, {
    success: false,
    code: "cover_attachment_storage_unavailable",
    error: "Сховище фотографій недоступне.",
  });
  assert.equal(missingPrivatePhoto.phase, "error");
  assert.equal(missingPrivatePhoto.message, "Сховище фотографій недоступне.");

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
  assert.match(refreshedDraftApplyOutcome("draft")?.message ?? "", /повернуто до редагування/);
  assert.equal(refreshedDraftApplyOutcome("ready_for_review"), null);
});

test("confirmed result copy names each supported operation", () => {
  const expected = {
    "material.create": /Матеріал додано/,
    "material.update": /Картку матеріалу оновлено/,
    "receipt.create": /Надходження внесено/,
    "transfer.create": /Переміщення внесено/,
    "writeoff.create": /Списання внесено/,
    "revision.count": /Результат ревізії внесено/,
    "academic-year.create": /Навчальний рік внесено/,
    "class-year.create": /Клас відкрито/,
    "class-year.update": /Дані класу оновлено/,
    "class-year.close": /Клас закрито/,
    "academic-year.rollover": /Перехід класів внесено/,
  };
  DRAFT_KINDS.forEach((kind, index) => {
    const outcome = classifyDraftApplyResponse(200, {
      success: true,
      draft: {
        id: "11111111-1111-4111-8111-111111111111",
        kind,
        status: "applied",
        revision: 2,
        payload: {},
      },
      result: {
        requestId: "22222222-2222-4222-8222-222222222222",
        draftId: "11111111-1111-4111-8111-111111111111",
        kind,
        status: "applied",
        message: "Готово",
        alreadyApplied: false,
        appliedAt: "2026-08-10T00:00:00.000Z",
        mutations: [{
          sheet: "Тест",
          row: index + 2,
          key: `KEY-${index}`,
          action: "create",
          entityId: `KEY-${index}`,
        }],
        entityIds: { entity_id: `KEY-${index}` },
        summary: {},
        cover: { status: "not_requested" },
      },
    });
    assert.equal(outcome.phase, "success", kind);
    assert.match(outcome.message, expected[kind], kind);
  });
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

test("the server signs the authenticated actor and private cover attachment, never browser values", () => {
  assert.match(applyRoute, /actor: \{\s*id: user\.userId,\s*email: user\.email/);
  assert.match(applyRoute, /readOwnedCoverAttachment\(user\.userId, coverPhotoKey\)/);
  assert.match(applyRoute, /\["ready_for_review", "approved_pending_apply"\]\.includes\(existing\.status\)/);
  assert.match(sheetsGateway, /actor: \{\s*id: input\.actor\.id,\s*email: input\.actor\.email/);
  assert.match(sheetsGateway, /attachment: \{\s*key: input\.attachment\.key,\s*contentType:/);
  assert.match(sheetsGateway, /input\.attachment\.key !== coverPhotoKey/);

  const applyFetchStart = workspace.indexOf('fetch("/api/librarian/drafts/apply"');
  const applyFetchBlock = workspace.slice(applyFetchStart, applyFetchStart + 500);
  assert.doesNotMatch(applyFetchBlock, /actor|email|attachment|coverPhotoKey/);
  assert.equal(
    validateDraftApplyInput({
      id: "11111111-1111-4111-8111-111111111111",
      revision: 1,
      requestId: "22222222-2222-4222-8222-222222222222",
    }).ok,
    false,
  );
});

test("new material can atomically include a reviewed initial receipt", () => {
  assert.match(workspace, /Початкове надходження/);
  assert.match(workspace, /name="initialReceipt\.quantity"/);
  assert.match(workspace, /name="initialReceipt\.locationId"/);
  assert.match(workspace, /name="initialReceipt\.condition"/);
  assert.match(workspace, /name="initialReceipt\.date"/);
  assert.match(workspace, /convertNumericField\(initialReceipt, "quantity"\)/);
  assert.match(workspace, /flat\.initialReceipt = initialReceipt/);
  assert.match(workspace, /preferredInitialReceiptLocation[\s\S]*?LOC-001/);

  const valid = validateDraftInput({
    kind: "material.create",
    payload: {
      title: "Математика",
      rubric: "Підручники",
      initialReceipt: {
        date: "2026-08-10",
        locationId: "LOC-001",
        locationName: "Бібліотека",
        condition: "Придатний",
        quantity: 1,
        documentNumber: "Накладна 7",
      },
    },
  });
  assert.equal(valid.ok, true);
  if (valid.ok) assert.deepEqual(valid.value.payload.initialReceipt, {
    date: "2026-08-10",
    locationId: "LOC-001",
    locationName: "Бібліотека",
    condition: "Придатний",
    quantity: 1,
    documentNumber: "Накладна 7",
  });

  const invalid = validateDraftInput({
    kind: "material.create",
    payload: {
      title: "Математика",
      rubric: "Підручники",
      initialReceipt: {
        date: "2026-08-10",
        locationId: "LOC-007",
        locationName: "Списано",
        condition: "Придатний",
        quantity: 0,
      },
    },
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.match(invalid.fieldErrors["payload.initialReceipt.quantity"], /ціле число/);
    assert.match(invalid.fieldErrors["payload.initialReceipt.locationId"], /не можна обрати/);
  }
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
  assert.match(workspace, /isActiveReferenceStatus\(teacher\.status\)/);
  assert.match(workspace, /isActiveReferenceStatus\(location\.status\)/);
  assert.match(sheetsGateway, /\^\(\?:active\|актив\)/);
  assert.doesNotMatch(workspace, /teacher\.email|item\.email|\.email\}/);
});

test("stale guards require opaque versions and frozen stock snapshots", () => {
  const materialVersion = "m".repeat(43);
  const classVersion = "c".repeat(43);
  const materialUpdate = validateDraftInput({
    kind: "material.update",
    payload: {
      materialId: "CAT-0112",
      expectedVersion: materialVersion,
      changes: { title: "Уточнена назва" },
    },
  });
  assert.equal(materialUpdate.ok, true);
  assert.equal(validateDraftInput({
    kind: "material.update",
    payload: { materialId: "CAT-0112", changes: { title: "Уточнена назва" } },
  }).ok, false);

  for (const input of [
    {
      kind: "transfer.create",
      payload: {
        materialId: "CAT-0112",
        quantity: 1,
        fromLocation: "Бібліотека",
        toLocation: "Кабінет 205",
        observedAvailableQuantity: 4,
        date: "2026-08-10",
      },
    },
    {
      kind: "writeoff.create",
      payload: {
        materialId: "CAT-0112",
        fromLocationId: "LOC-001",
        fromLocationName: "Бібліотека",
        quantity: 1,
        observedAvailableQuantity: 4,
        destination: "written_off",
        reason: "worn",
        date: "2026-08-10",
      },
    },
    {
      kind: "revision.count",
      payload: {
        materialId: "CAT-0112",
        location: "Бібліотека",
        countedQuantity: 4,
        expectedQuantity: 4,
        date: "2026-08-10",
      },
    },
  ]) {
    assert.equal(validateDraftInput(input).ok, true, input.kind);
    const withoutSnapshot = structuredClone(input);
    delete withoutSnapshot.payload.observedAvailableQuantity;
    delete withoutSnapshot.payload.expectedQuantity;
    assert.equal(validateDraftInput(withoutSnapshot).ok, false, `${input.kind} missing snapshot`);
  }

  for (const input of [
    {
      kind: "class-year.update",
      payload: {
        classYearId: "CY-2028-001",
        academicYearId: "YR-2028-2029",
        expectedVersion: classVersion,
        changes: { code: "Б" },
      },
    },
    {
      kind: "class-year.close",
      payload: {
        classYearId: "CY-2028-001",
        expectedVersion: classVersion,
        actualClosedDate: "2029-06-30",
        reason: "closed",
        closeCohort: true,
      },
    },
  ]) {
    assert.equal(validateDraftInput(input).ok, true, input.kind);
  }

  const rollover = validateDraftInput({
    kind: "academic-year.rollover",
    payload: {
      sourceYearId: "YR-2028-2029",
      targetYearId: "YR-2029-2030",
      effectiveDate: "2029-09-01",
      classes: [{
        sourceClassYearId: "CY-2028-001",
        expectedVersion: classVersion,
        cohortId: "COH-001",
        sourceGrade: 1,
        action: "promote",
        targetGrade: 2,
        targetCode: "А",
      }],
    },
  });
  assert.equal(rollover.ok, true);
  assert.equal(validateDraftInput({
    kind: "academic-year.rollover",
    payload: {
      sourceYearId: "YR-2028-2029",
      targetYearId: "YR-2029-2030",
      effectiveDate: "2029-09-01",
      classes: [{
        sourceClassYearId: "CY-2028-001",
        expectedVersion: classVersion,
        cohortId: "COH-001",
        sourceGrade: 1,
        action: "skip",
      }],
    },
  }).ok, false);

  assert.equal(findEntityVersion([{ id: "CAT-0112", version: materialVersion }], "CAT-0112"), materialVersion);
  assert.equal(findEntityVersion([
    { id: "CAT-0112", version: materialVersion },
    { id: "CAT-0112", version: "z".repeat(43) },
  ], "CAT-0112"), null);
  assert.equal(entityVersionIsCurrent(
    [{ id: "CY-2028-001", version: classVersion }],
    "CY-2028-001",
    classVersion,
  ), true);
  assert.equal(entityVersionIsCurrent(
    [{ id: "CY-2028-001", version: classVersion }],
    "CY-2028-001",
    materialVersion,
  ), false);
  assert.equal(materialLocationQuantity({
    stock: { locations: [{ name: "Бібліотека", quantity: 4 }] },
  }, "Бібліотека", ["Бібліотека", "Кабінет 205"]), 4);
  assert.equal(materialLocationQuantity({
    stock: { locations: [{ name: "Бібліотека", quantity: 4 }] },
  }, "Кабінет 205", ["Бібліотека", "Кабінет 205"]), 0);
  assert.equal(materialLocationQuantity({ stock: { locations: [] } }, "Невідоме", ["Бібліотека"]), null);

  assert.match(workspace, /name="expectedVersion"/);
  assert.match(workspace, /name="observedAvailableQuantity"/);
  assert.match(workspace, /name="expectedQuantity"/);
  assert.match(workspace, /data-required-snapshot=\{ready \? "ready" : "missing"\}/);
  assert.match(workspace, /entityVersionIsCurrent\([\s\S]*?referenceData\.classYearVersions[\s\S]*?row\.sourceClassYearId[\s\S]*?row\.expectedVersion/);
  assert.match(workspace, /Оновити версії та перебудувати план/);
  assert.match(workspace, /setRows\(buildRolloverRows\(sourceYearId, referenceData\)\)[\s\S]*?onDirty\(\)/);
  assert.match(
    workspace,
    /item\.academicYearId === sourceYearId[\s\S]*?isActiveReferenceStatus\(item\.status\)[\s\S]*?!item\.actualClosedDate/,
  );
  assert.match(workspace, /action === "submit"[\s\S]*?data-required-snapshot="missing"/);
  assert.doesNotMatch(workspace, /option value="skip"/);
  assert.match(sheetsGateway, /materialVersions:/);
  assert.match(sheetsGateway, /classYearVersions:/);
});

test("writeoff condition uses the exact Sheets vocabulary before review", () => {
  assert.match(
    workspace,
    /<select name="condition"[^>]*>.*Придатний.*Пошкоджений.*Не перевірено.*<\/select>/s,
  );

  const base = {
    kind: "writeoff.create",
    payload: {
      materialId: "CAT-0112",
      fromLocationId: "LOC-001",
      fromLocationName: "Бібліотека",
      quantity: 1,
      observedAvailableQuantity: 4,
      destination: "written_off",
      reason: "worn",
      date: "2026-08-10",
    },
  };
  assert.equal(validateDraftInput({
    ...base,
    payload: { ...base.payload, condition: "Не перевірено" },
  }).ok, true);
  assert.equal(validateDraftInput({
    ...base,
    payload: { ...base.payload, condition: "Непридатний" },
  }).ok, false);
});

test("known gateway outcomes have an editable, pending, or terminal disposition", () => {
  for (const code of [
    "stale_material",
    "stale_class_year",
    "stale_stock",
    "insufficient_stock",
    "duplicate_class_year",
    "academic_year_conflict",
    "academic_year_closed",
    "academic_year_not_found",
    "class_year_closed",
    "class_year_completed",
    "class_year_not_found",
    "cohort_closed",
    "cohort_not_found",
    "cohort_still_open",
    "location_not_found",
    "material_not_found",
    "teacher_not_found",
  ]) {
    assert.equal(draftGatewayFailureDisposition({
      code,
      retryable: false,
      outcomeKnown: true,
    }), "return_for_changes");
  }
  assert.equal(draftGatewayFailureDisposition({
    code: "gateway_interrupted",
    retryable: true,
    outcomeKnown: false,
  }), "keep_pending");
  assert.equal(draftGatewayFailureDisposition({
    code: "duplicate_class_year",
    retryable: false,
    outcomeKnown: false,
  }), "keep_pending");
  assert.equal(draftGatewayFailureDisposition({
    code: "write_mode_disabled",
    retryable: true,
    outcomeKnown: true,
  }), "keep_pending");
  assert.equal(draftGatewayFailureDisposition({
    code: "schema_mismatch",
    retryable: false,
    outcomeKnown: true,
  }), "fail");

  const pending = {
    status: "approved_pending_apply",
    currentRevision: 3,
    expectedRevision: 2,
    requestedId: "22222222-2222-4222-8222-222222222222",
    metadata: {
      requestId: "22222222-2222-4222-8222-222222222222",
      sourceRevision: 2,
    },
  };
  assert.equal(draftApplyClaimDecision(pending), "replay_pending");
  assert.equal(draftApplyClaimDecision({
    ...pending,
    requestedId: "33333333-3333-4333-8333-333333333333",
  }), "request_conflict");
  assert.equal(draftApplyClaimDecision({
    ...pending,
    expectedRevision: 1,
  }), "revision_conflict");
  assert.equal(draftApplyClaimDecision({
    ...pending,
    status: "applied",
    currentRevision: 4,
  }), "already_applied");

  const returnInput = {
    status: "approved_pending_apply",
    currentRevision: 3,
    expectedRevision: 3,
    requestId: "22222222-2222-4222-8222-222222222222",
    metadata: {
      requestId: "22222222-2222-4222-8222-222222222222",
    },
  };
  assert.equal(draftApplyReturnDecision(returnInput), "return_for_changes");
  assert.equal(draftApplyReturnDecision({
    ...returnInput,
    status: "draft",
    currentRevision: 4,
    metadata: { ...returnInput.metadata, outcome: "returned_for_changes" },
  }), "already_returned");
  assert.equal(draftApplyReturnDecision({
    ...returnInput,
    requestId: "33333333-3333-4333-8333-333333333333",
  }), "request_conflict");

  const needsChanges = classifyDraftApplyResponse(409, {
    success: false,
    code: "stale_material",
    error: "Картка змінилася. Чернетку повернуто до редагування.",
    needsChanges: true,
    outcomeKnown: true,
    draft: {
      id: "11111111-1111-4111-8111-111111111111",
      kind: "material.update",
      payload: {},
      revision: 4,
      status: "draft",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    },
  });
  assert.equal(needsChanges.phase, "error");
  assert.equal(needsChanges.stale, true);
  assert.match(needsChanges.message, /повернуто до редагування/);
  assert.match(applyRoute, /returnDraftApplyForChanges/);
  assert.match(applyRoute, /needsChanges: true/);
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
  assert.match(workspace, /const handleScan[\s\S]*?setShowResults\(true\);[\s\S]*?onDirty\(\);/);
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
  assert.match(workspace, /name="changes\.coverPhotoKey" value=\{retainedCoverPhotoKey\}/);
  assert.match(workspace, /const retainUploadedPhoto = Boolean\(retainedCoverPhotoKey && !coverSourceUrl\.trim\(\)\)/);
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

test("mobile cover photos are orientation-aware, bounded, and converted before upload", () => {
  assert.deepEqual(fittedCoverDimensions(4000, 3000), { width: 600, height: 450 });
  assert.deepEqual(fittedCoverDimensions(3000, 5000), { width: 540, height: 900 });
  assert.deepEqual(fittedCoverDimensions(600, 900), { width: 600, height: 900 });
  assert.equal(normalizedCoverFileName("Фото примірника.HEIC"), "Фото примірника.jpg");
  assert.throws(() => fittedCoverDimensions(0, 900), /Некоректний розмір/);
  assert.match(workspace, /normalizeCoverPhotoForUpload\(file\)/);
  assert.match(workspace, /data\.set\("photo", preparedFile\)/);
  assert.match(workspace, /Оптимізуємо й завантажуємо/);
});
