/**
 * Fail-closed domain mutations for the librarian gateway.
 *
 * Every function receives the verified spreadsheet instance.  Nothing in this
 * file calls the legacy cover helpers because those helpers are bound to the
 * production spreadsheet.  Cover ingestion is returned as a post-commit
 * instruction for the signed site-side bridge.
 */

var LIBRARIAN_OPERATION_MAX_ROW = 1000;
var LIBRARIAN_OPERATION_REQUEST_COLUMN = 16;
var LIBRARIAN_OPERATION_REQUEST_HEADER = "Request ID застосування (службове)";
var LIBRARIAN_DATA_MAX_ROW = 25000;
var LIBRARIAN_SERVICE_WRITTEN_OFF_ID = "LOC-007";
var LIBRARIAN_SERVICE_LOST_ID = "LOC-008";
var LIBRARIAN_REVISION_JOURNAL_SHEET = "Журнал ревізій";

function prepareGatewayOperationPlan_(spreadsheet, input, actor) {
  if (input.kind === "academic-year.create") {
    return { kind: input.kind, completed_steps: [] };
  }
  if (input.kind === "material.create") {
    return prepareMaterialCreatePlan_(spreadsheet, input.payload, actor);
  }
  if (input.kind === "material.update") {
    return prepareMaterialUpdatePlan_(spreadsheet, input.payload);
  }
  if (input.kind === "receipt.create") {
    return prepareReceiptPlan_(spreadsheet, input.payload, actor);
  }
  if (input.kind === "transfer.create") {
    return prepareTransferPlan_(spreadsheet, input.payload, actor);
  }
  if (input.kind === "writeoff.create") {
    return prepareWriteoffPlan_(spreadsheet, input.payload, actor);
  }
  if (input.kind === "revision.count") {
    return prepareRevisionPlan_(spreadsheet, input.payload, actor);
  }
  if (input.kind === "class-year.create") {
    return prepareClassYearCreatePlan_(spreadsheet, input.payload);
  }
  if (input.kind === "class-year.update") {
    return prepareClassYearUpdatePlan_(spreadsheet, input.payload);
  }
  if (input.kind === "class-year.close") {
    return prepareClassYearClosePlan_(spreadsheet, input.payload);
  }
  if (input.kind === "academic-year.rollover") {
    return prepareAcademicYearRolloverPlan_(spreadsheet, input.payload);
  }
  throw gatewayApplyError_("unsupported_kind", "Цей тип чернетки не дозволено застосовувати.");
}

function executeGatewayOperationPlan_(spreadsheet, input, actor, journal) {
  if (input.kind === "academic-year.create") {
    var academic = applyAcademicYearCreate_(spreadsheet, input.payload, journal);
    checkpointApplyJournal_(journal, "academic_year");
    return genericApplyResult_(
      academic.already_applied ? "already_applied" : "applied",
      [{ sheet: academic.sheet, row: academic.row, action: "upsert" }],
      { academicYearId: academic.academic_year_id },
      academic.message,
      noCoverInstruction_(),
    );
  }
  if (input.kind === "material.create") return executeMaterialCreate_(spreadsheet, journal, actor);
  if (input.kind === "material.update") return executeMaterialUpdate_(spreadsheet, journal);
  if (input.kind === "receipt.create") return executeReceipt_(spreadsheet, journal);
  if (input.kind === "transfer.create") return executeTransfer_(spreadsheet, journal);
  if (input.kind === "writeoff.create") return executeWriteoff_(spreadsheet, journal);
  if (input.kind === "revision.count") return executeRevision_(spreadsheet, journal);
  if (input.kind === "class-year.create") return executeClassYearCreate_(spreadsheet, journal);
  if (input.kind === "class-year.update") return executeClassYearUpdate_(spreadsheet, journal);
  if (input.kind === "class-year.close") return executeClassYearClose_(spreadsheet, journal);
  if (input.kind === "academic-year.rollover") return executeAcademicYearRollover_(spreadsheet, journal);
  throw gatewayApplyError_("unsupported_kind", "Цей тип чернетки не дозволено застосовувати.");
}

function genericApplyResult_(status, mutations, entityIds, summary, cover) {
  var message = summary || "Операцію застосовано.";
  return {
    status: status,
    mutations: mutations || [],
    entity_ids: entityIds || {},
    summary: {
      message: message,
      mutation_count: (mutations || []).length,
    },
    message: message,
    cover: cover || noCoverInstruction_(),
  };
}

function noCoverInstruction_() {
  return { status: "not_requested", permanent_url_written: false };
}

function coverInstructionFromPayload_(payload, materialId) {
  var sourceUrl = payload && payload.coverSourceUrl
    ? gatewayHttpUrl_(payload.coverSourceUrl, "Некоректне посилання на обкладинку.")
    : "";
  var photoKey = payload && payload.coverPhotoKey
    ? gatewaySafeText_(payload.coverPhotoKey, 240, "Некоректний ключ фотографії.")
    : "";
  var photoName = payload && payload.coverPhotoName
    ? gatewaySafeText_(payload.coverPhotoName, 255, "Некоректна назва фотографії.")
    : "";
  if (sourceUrl && photoKey) {
    throw gatewayApplyError_("invalid_cover_source", "Оберіть посилання або фотографію, але не обидва джерела.");
  }
  if ((sourceUrl || photoKey) && payload.coverConfirmed !== true) {
    throw gatewayApplyError_("cover_not_confirmed", "Підтвердьте обкладинку перед застосуванням матеріалу.");
  }
  if (!sourceUrl && !photoKey && payload.coverConfirmed === true) {
    throw gatewayApplyError_("cover_source_missing", "Підтверджено обкладинку без джерела.");
  }
  if (sourceUrl) {
    return {
      status: "dispatch_required",
      handler: "cover_ingest",
      mode: "source_url",
      material_id: materialId,
      source_url: sourceUrl,
      dispatch_after: "material_commit",
      permanent_url_written: false,
    };
  }
  if (photoKey) {
    return {
      status: "attachment_required",
      handler: "signed_cover_attachment",
      mode: "private_photo",
      material_id: materialId,
      attachment_key: photoKey,
      attachment_name: photoName,
      dispatch_after: "material_commit",
      permanent_url_written: false,
    };
  }
  return noCoverInstruction_();
}

function resolveGatewayActor_(spreadsheet, rawActor) {
  if (!rawActor || typeof rawActor !== "object" || Array.isArray(rawActor)) {
    throw gatewayApplyError_("actor_required", "Не вдалося визначити відповідального користувача.");
  }
  validateExactKeys_(rawActor, ["id", "email"]);
  var actorId = gatewaySafeText_(rawActor.id, 160, "Некоректний ID відповідального користувача.");
  var email = gatewaySafeText_(rawActor.email, 320, "Некоректна адреса відповідального користувача.")
    .toLocaleLowerCase("uk-UA");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw gatewayApplyError_("invalid_actor", "Некоректна адреса відповідального користувача.");
  }
  var sheet = gatewayRequiredSheet_(spreadsheet, "Користувачі");
  var rows = gatewayReadRows_(sheet, 6, 5000);
  var matches = [];
  rows.forEach(function (item) {
    var row = item.values;
    var rowId = String(row[0] || "").trim();
    var rowEmail = String(row[4] || "").trim().toLocaleLowerCase("uk-UA");
    var status = String(row[5] || "").trim();
    if ((rowId === actorId || rowEmail === email) && /^актив/i.test(status)) {
      matches.push({ row: item.row, id: rowId, name: String(row[1] || "").trim(), email: rowEmail });
    }
  });
  if (matches.length !== 1 || !matches[0].id || !matches[0].name) {
    throw gatewayApplyError_(
      matches.length > 1 ? "ambiguous_actor" : "actor_not_found",
      "Відповідального користувача не знайдено серед активних користувачів таблиці.",
    );
  }
  return matches[0];
}

/* -------------------------------------------------------------------------- */
/* Materials                                                                  */
/* -------------------------------------------------------------------------- */

function prepareMaterialCreatePlan_(spreadsheet, payload, actor) {
  validateExactKeys_(payload, [
    "title", "rubric", "isbn", "author", "year", "grade", "classFrom", "classTo",
    "subject", "publicationType", "publisher", "electronicUrl", "coverSourceUrl",
    "coverPhotoKey", "coverPhotoName", "coverConfirmed", "notes", "initialQuantity",
    "location", "locationId", "locationName", "date", "condition", "documentNumber",
    "initialReceipt",
  ]);
  var materialSheet = gatewayRequiredSheet_(spreadsheet, "Матеріали");
  assertMaterialSchema_(materialSheet);
  var title = gatewaySafeText_(payload.title, 300, "Назва матеріалу відсутня.");
  var rubric = gatewaySafeText_(payload.rubric, 160, "Рубрика матеріалу відсутня.");
  var isbn = payload.isbn ? normalizeGatewayIsbn_(payload.isbn) : "";
  var reservations = collectApplyJournalReservations_(spreadsheet);
  var rows = gatewayReadRows_(materialSheet, 25, 5000);
  var maximumId = 0;
  var lastDataRow = 1;
  var materialCount = 0;
  var existingMaterialIds = {};
  rows.forEach(function (item) {
    var id = String(item.values[0] || "").trim();
    var match = id.match(/^CAT-(\d{4,})$/);
    if (match) {
      maximumId = Math.max(maximumId, Number(match[1]));
      materialCount += 1;
      existingMaterialIds[id] = true;
    }
    if (item.values.some(function (value) { return String(value || "").trim() !== ""; })) {
      lastDataRow = item.row;
    }
    var existingIsbn = normalizeGatewayIsbnLoose_(item.values[24] || item.values[9]);
    if (isbn && existingIsbn && isbn === existingIsbn) {
      throw gatewayApplyError_("duplicate_isbn", "Матеріал із цим ISBN уже існує.");
    }
  });
  var reservedMaterialCount = 0;
  Object.keys(reservations.material_ids).forEach(function (id) {
    var match = id.match(/^CAT-(\d{4,})$/);
    if (match) maximumId = Math.max(maximumId, Number(match[1]));
    if (!existingMaterialIds[id]) reservedMaterialCount += 1;
  });
  var materialId = "CAT-" + String(maximumId + 1).padStart(4, "0");
  var targetRow = lastDataRow + 1;
  if (targetRow > Number(materialSheet.getMaxRows())) {
    throw gatewayApplyError_("materials_sheet_full", "На аркуші «Матеріали» немає вільного рядка.");
  }
  assertMaterialTargetRowEmpty_(materialSheet, targetRow);
  var activeLocationIds = preflightMaterialBalanceCapacity_(
    spreadsheet,
    materialCount + reservedMaterialCount + 1,
  );

  var classFrom = payload.classFrom !== undefined ? gatewayInteger_(payload.classFrom, 1, 11, "Некоректний початковий клас.") : "";
  var classTo = payload.classTo !== undefined ? gatewayInteger_(payload.classTo, 1, 11, "Некоректний кінцевий клас.") : "";
  if (payload.grade && classFrom === "" && classTo === "") {
    var legacyGrade = String(payload.grade).match(/\d{1,2}/);
    if (legacyGrade) {
      classFrom = gatewayInteger_(Number(legacyGrade[0]), 1, 11, "Некоректний клас.");
      classTo = classFrom;
    }
  }
  if (classFrom !== "" && classTo === "") classTo = classFrom;
  if (classFrom === "" && classTo !== "") {
    throw gatewayApplyError_("invalid_class_range", "Вкажіть початковий клас.");
  }
  if (classFrom !== "" && classFrom > classTo) {
    throw gatewayApplyError_("invalid_class_range", "Початковий клас більший за кінцевий.");
  }

  var materialValues = {
    "1": materialId,
    "2": rubric,
    "3": gatewayOptionalText_(payload.publicationType, 160),
    "4": gatewayOptionalText_(payload.subject, 160),
    "5": classFrom,
    "6": classTo,
    "7": title,
    "8": gatewayOptionalText_(payload.author, 240),
    "9": payload.year === undefined ? "" : gatewayInteger_(payload.year, 1500, 3000, "Некоректний рік."),
    "10": isbn,
    "11": "",
    "12": payload.electronicUrl ? gatewayHttpUrl_(payload.electronicUrl, "Некоректне електронне посилання.") : "",
    "13": "",
    "14": "",
    "15": "",
    "16": "",
    "17": "",
    "18": gatewayOptionalText_(payload.notes, 2000),
    "24": gatewayOptionalText_(payload.publisher, 240),
  };
  var coverSheet = gatewayRequiredSheet_(spreadsheet, "Обкладинки");
  if (targetRow <= Number(coverSheet.getMaxRows())) {
    preflightCoverRow_(coverSheet, targetRow, materialId);
  }

  var plan = {
    kind: "material.create",
    material_id: materialId,
    material_row: targetRow,
    material_values: materialValues,
    active_location_ids: activeLocationIds,
    cover_row: targetRow,
    cover_request: coverInstructionFromPayload_(payload, materialId),
    completed_steps: [],
  };
  var initialReceiptPayload = payload.initialReceipt;
  if (initialReceiptPayload !== undefined) {
    if (!initialReceiptPayload || typeof initialReceiptPayload !== "object" || Array.isArray(initialReceiptPayload)) {
      throw gatewayApplyError_("invalid_initial_receipt", "Некоректні дані початкового надходження.");
    }
    validateExactKeys_(initialReceiptPayload, [
      "date", "locationId", "locationName", "condition", "quantity", "documentNumber", "notes",
    ]);
    if (["initialQuantity", "location", "locationId", "locationName", "date", "condition", "documentNumber"]
      .some(function (key) { return Object.prototype.hasOwnProperty.call(payload, key); })) {
      throw gatewayApplyError_("initial_receipt_conflict", "Не поєднуйте вкладене й застаріле початкове надходження.");
    }
  }
  var receiptSource = initialReceiptPayload || payload;
  var rawInitialQuantity = initialReceiptPayload ? initialReceiptPayload.quantity : payload.initialQuantity;
  var initialQuantity = rawInitialQuantity === undefined
    ? 0
    : gatewayInteger_(rawInitialQuantity, 1, 100000, "Некоректна початкова кількість.");
  if (initialQuantity) {
    var location = resolveGatewayLocation_(
      spreadsheet,
      receiptSource.locationId,
      receiptSource.locationName || receiptSource.location,
      false,
    );
    var receiptPayload = {
      materialId: materialId,
      quantity: initialQuantity,
      date: requiredIsoDate_(receiptSource.date, "Для початкового надходження потрібна дата."),
      condition: normalizeGatewayCondition_(receiptSource.condition),
      documentNumber: gatewayOptionalText_(receiptSource.documentNumber, 100),
      notes: gatewayOptionalText_(receiptSource.notes || payload.notes, 2000),
    };
    plan.initial_receipt = prepareOperationRowPlan_(spreadsheet, {
      material_id: materialId,
      material_label: materialId + " — " + title,
      date: receiptPayload.date,
      type: "Надходження",
      from: null,
      to: location,
      condition: receiptPayload.condition,
      quantity: initialQuantity,
      actor: actor,
      notes: structuredOperationNotes_(receiptPayload, "Початкове надходження"),
      balance_checks: [{ material_id: materialId, location_id: location.id, before: 0, after: initialQuantity, allow_missing_before: true }],
    });
  }
  return plan;
}

function executeMaterialCreate_(spreadsheet, journal) {
  var plan = journal.plan;
  var materialSheet = gatewayRequiredSheet_(spreadsheet, "Матеріали");
  var coverSheet = gatewayRequiredSheet_(spreadsheet, "Обкладинки");
  var mutations = [];
  ensureMaterialCreateTarget_(materialSheet, plan, journal);
  if (!hasApplyJournalCheckpoint_(journal, "material")) {
    if (plan.material_values["10"]) {
      assertUniqueMaterialIsbn_(materialSheet, plan.material_values["10"], plan.material_row);
    }
    preflightReconciledCells_(materialSheet, plan.material_row, plan.material_values, "material_conflict", false);
    markApplyJournalWriteIntent_(journal, "material");
    writeReconciledCells_(materialSheet, plan.material_row, plan.material_values, "material_conflict");
    SpreadsheetApp.flush();
    verifyReconciledCells_(materialSheet, plan.material_row, plan.material_values);
    verifyNewMaterialBalanceCoverage_(spreadsheet, plan.material_id, plan.active_location_ids);
    checkpointApplyJournal_(journal, "material");
  } else {
    verifyReconciledCells_(materialSheet, plan.material_row, plan.material_values);
  }
  mutations.push({ sheet: "Матеріали", row: plan.material_row, action: "create", entity_id: plan.material_id });

  ensureCoverIndexTarget_(coverSheet, plan, journal);
  if (!hasApplyJournalCheckpoint_(journal, "cover_index")) {
    ensureSheetRowExists_(coverSheet, plan.cover_row);
    writeCoverIndexRow_(coverSheet, plan.cover_row, plan.material_id);
    SpreadsheetApp.flush();
    verifyCoverIndexRow_(coverSheet, plan.cover_row, plan.material_id);
    checkpointApplyJournal_(journal, "cover_index");
  } else {
    verifyCoverIndexRow_(coverSheet, plan.cover_row, plan.material_id);
  }
  mutations.push({ sheet: "Обкладинки", row: plan.cover_row, action: "index", entity_id: plan.material_id });

  var entityIds = { materialId: plan.material_id };
  if (plan.initial_receipt) {
    var operation = executeOperationRowPlan_(spreadsheet, plan.initial_receipt, journal, "initial_receipt");
    mutations.push(operation.mutation);
    entityIds.operationId = operation.operation_id;
  }
  return genericApplyResult_(
    "applied",
    mutations,
    entityIds,
    "Матеріал додано" + (plan.initial_receipt ? " разом із початковим надходженням." : "."),
    plan.cover_request,
  );
}

function prepareMaterialUpdatePlan_(spreadsheet, payload) {
  validateExactKeys_(payload, ["materialId", "expectedVersion", "sourceGeneratedAt", "changes", "reason"]);
  var materialId = gatewayMaterialId_(payload.materialId);
  var sheet = gatewayRequiredSheet_(spreadsheet, "Матеріали");
  assertMaterialSchema_(sheet);
  var row = findUniqueMaterialRow_(sheet, materialId);
  var expectedVersion = gatewayMaterialVersion_(payload.expectedVersion);
  assertMaterialVersion_(sheet, row, expectedVersion);
  var changes = payload.changes;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw gatewayApplyError_("invalid_payload", "Зміни матеріалу відсутні.");
  }
  validateExactKeys_(changes, [
    "title", "rubric", "publicationType", "subject", "classFrom", "classTo", "author",
    "year", "isbn", "publisher", "electronicUrl", "coverSourceUrl", "coverPhotoKey",
    "coverPhotoName", "coverConfirmed", "notes",
  ]);
  var mapping = {
    title: 7, rubric: 2, publicationType: 3, subject: 4, classFrom: 5, classTo: 6,
    author: 8, year: 9, isbn: 10, electronicUrl: 12, notes: 18, publisher: 24,
  };
  var values = {};
  Object.keys(mapping).forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(changes, key)) return;
    var value = changes[key];
    if (key === "isbn") value = value ? normalizeGatewayIsbn_(value) : "";
    else if (key === "year") value = value === "" || value === null ? "" : gatewayInteger_(value, 1500, 3000, "Некоректний рік.");
    else if (key === "classFrom" || key === "classTo") value = value === "" || value === null ? "" : gatewayInteger_(value, 1, 11, "Некоректний клас.");
    else if (key === "electronicUrl") value = value ? gatewayHttpUrl_(value, "Некоректне електронне посилання.") : "";
    else value = value === null ? "" : gatewayOptionalText_(value, key === "notes" ? 2000 : 300);
    values[String(mapping[key])] = value;
  });
  if (Object.prototype.hasOwnProperty.call(values, "5") !== Object.prototype.hasOwnProperty.call(values, "6")) {
    throw gatewayApplyError_("invalid_class_range", "Обидві межі класів потрібно змінювати разом.");
  }
  if (values["5"] !== undefined && values["5"] !== "" && values["5"] > values["6"]) {
    throw gatewayApplyError_("invalid_class_range", "Початковий клас більший за кінцевий.");
  }
  if (values["10"]) assertUniqueMaterialIsbn_(sheet, values["10"], row);
  if (!Object.keys(values).length && !changes.coverSourceUrl && !changes.coverPhotoKey) {
    throw gatewayApplyError_("empty_changes", "Не вказано жодної зміни матеріалу.");
  }
  var finalIsbn = Object.prototype.hasOwnProperty.call(values, "10")
    ? values["10"]
    : normalizeGatewayIsbnLoose_(sheet.getRange(row, 10).getDisplayValues()[0][0]);
  // Bind every replay to the CAT identity itself.  The ID is not changed, but
  // including it in before/after reconciliation prevents a concurrent sort
  // from redirecting an update to whichever record happens to occupy the old
  // row number.
  values["1"] = materialId;
  preflightReconciledCells_(sheet, row, values, "material_conflict", true);
  var before = captureCellValues_(sheet, row, values);
  return {
    kind: "material.update",
    material_id: materialId,
    material_row: row,
    expected_version: expectedVersion,
    material_isbn: finalIsbn,
    material_before: before,
    material_values: values,
    cover_request: coverInstructionFromPayload_(changes, materialId),
    completed_steps: [],
  };
}

function executeMaterialUpdate_(spreadsheet, journal) {
  var plan = journal.plan;
  var sheet = gatewayRequiredSheet_(spreadsheet, "Матеріали");
  ensureMaterialUpdateTarget_(sheet, plan, journal);
  if (!hasApplyJournalCheckpoint_(journal, "material_update")) {
    if (plan.material_isbn) {
      assertUniqueMaterialIsbn_(sheet, plan.material_isbn, plan.material_row);
    }
    if (!hasApplyJournalCheckpoint_(journal, "write_started:material_update")) {
      assertMaterialVersion_(sheet, plan.material_row, plan.expected_version);
    }
    preflightTransitionCells_(
      sheet,
      plan.material_row,
      plan.material_before,
      plan.material_values,
      "material_update_conflict",
    );
    markApplyJournalWriteIntent_(journal, "material_update");
    writeTransitionCells_(
      sheet,
      plan.material_row,
      plan.material_before,
      plan.material_values,
      "material_update_conflict",
    );
    SpreadsheetApp.flush();
    verifyReconciledCells_(sheet, plan.material_row, plan.material_values);
    checkpointApplyJournal_(journal, "material_update");
  } else {
    verifyReconciledCells_(sheet, plan.material_row, plan.material_values);
  }
  return genericApplyResult_(
    "applied",
    [{ sheet: "Матеріали", row: plan.material_row, action: "update", entity_id: plan.material_id }],
    { materialId: plan.material_id },
    "Дані матеріалу оновлено.",
    plan.cover_request,
  );
}

function buildLibrarianMaterialVersions_(spreadsheet) {
  var sheet = gatewayRequiredSheet_(spreadsheet, "Матеріали");
  assertMaterialSchema_(sheet);
  var lastRow = Math.min(Number(sheet.getLastRow()) || 1, 5000);
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, 24).getDisplayValues()
    .map(function (values) {
      var id = String(values[0] || "").trim().toUpperCase();
      if (!/^CAT-\d{4,}$/.test(id)) return null;
      return { id: id, version: materialVersionFromDisplayValues_(values) };
    })
    .filter(function (item) { return Boolean(item); });
}

function materialVersionFromDisplayValues_(values) {
  var columns = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 18, 24];
  var snapshot = columns.map(function (column) {
    return String(values[column - 1] === null || values[column - 1] === undefined
      ? ""
      : values[column - 1]).trim();
  });
  return digestWebSafe_(JSON.stringify(snapshot));
}

function currentMaterialVersion_(sheet, row) {
  return materialVersionFromDisplayValues_(sheet.getRange(row, 1, 1, 24).getDisplayValues()[0]);
}

function gatewayMaterialVersion_(value) {
  var version = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(version)) {
    throw gatewayApplyError_("invalid_material_version", "Відсутня або некоректна версія перевіреної картки матеріалу.");
  }
  return version;
}

function assertMaterialVersion_(sheet, row, expectedVersion) {
  if (currentMaterialVersion_(sheet, row) !== expectedVersion) {
    throw gatewayApplyError_(
      "stale_material",
      "Картка матеріалу змінилася після відкриття форми. Оновіть дані й перевірте зміни повторно.",
    );
  }
}

function assertMaterialSchema_(sheet) {
  var headers = sheet.getRange(1, 1, 1, 25).getDisplayValues()[0];
  var required = { 1: "ID матеріалу", 7: "Назва", 10: "ISBN", 24: "Видавництво" };
  Object.keys(required).forEach(function (column) {
    if (normalizeHeader_(headers[Number(column) - 1]).indexOf(normalizeHeader_(required[column])) !== 0) {
      throw gatewayApplyError_("schema_mismatch", "Структура аркуша «Матеріали» змінилася.");
    }
  });
}

function findUniqueMaterialRow_(sheet, materialId) {
  var rows = gatewayReadRows_(sheet, 25, 5000);
  var matches = rows.filter(function (item) { return String(item.values[0] || "").trim() === materialId; });
  if (matches.length !== 1) {
    throw gatewayApplyError_(matches.length ? "duplicate_material" : "material_not_found", "Матеріал не знайдено однозначно.");
  }
  return matches[0].row;
}

function materialIdentityRows_(sheet, materialId) {
  return gatewayReadRows_(sheet, 25, 5000).filter(function (item) {
    return String(item.values[0] || "").trim() === materialId;
  }).map(function (item) { return item.row; });
}

function ensureMaterialCreateTarget_(sheet, plan, journal) {
  var identityRows = materialIdentityRows_(sheet, plan.material_id);
  if (identityRows.length > 1) {
    throw gatewayApplyError_("duplicate_material", "CAT-ID нового матеріалу повторюється.");
  }
  if (identityRows.length === 1) {
    var identityState = reconciledRowState_(sheet, identityRows[0], plan.material_values);
    if (!identityState.compatible) {
      throw gatewayApplyError_("material_identity_conflict", "CAT-ID нового матеріалу вже належить іншому запису.");
    }
    if (plan.material_row !== identityRows[0]) {
      plan.material_row = identityRows[0];
      plan.cover_row = identityRows[0];
      updateApplyJournalEntry_(journal, "applying", journal.plan, null, "");
    }
    return;
  }
  var state = reconciledRowState_(sheet, plan.material_row, plan.material_values);
  if (state.compatible) return;
  if (hasApplyJournalCheckpoint_(journal, "write_started:material") ||
      hasApplyJournalCheckpoint_(journal, "material")) {
    throw gatewayApplyError_("material_identity_missing", "Не знайдено рядок частково записаного CAT-ID.");
  }
  plan.material_row = nextMaterialCreateTargetRow_(sheet);
  plan.cover_row = plan.material_row;
  updateApplyJournalEntry_(journal, "applying", journal.plan, null, "");
}

function ensureMaterialUpdateTarget_(sheet, plan, journal) {
  var rows = materialIdentityRows_(sheet, plan.material_id);
  if (rows.length !== 1) {
    throw gatewayApplyError_(rows.length ? "duplicate_material" : "material_not_found", "Матеріал не знайдено однозначно.");
  }
  if (plan.material_row !== rows[0]) {
    plan.material_row = rows[0];
    updateApplyJournalEntry_(journal, "applying", journal.plan, null, "");
  }
}

function nextMaterialCreateTargetRow_(sheet) {
  var maximum = Math.min(5000, Number(sheet.getMaxRows()) || 0);
  var lastRow = Math.min(maximum, Number(sheet.getLastRow()) || 1);
  for (var row = Math.max(2, lastRow + 1); row <= maximum; row += 1) {
    var writable = sheet.getRange(row, 1, 1, 18);
    var extra = sheet.getRange(row, 24);
    var values = writable.getDisplayValues()[0].concat(extra.getDisplayValues()[0]);
    var formulas = writable.getFormulas()[0].concat(extra.getFormulas()[0]);
    if (!values.some(nonEmptyGatewayValue_) && !formulas.some(nonEmptyGatewayValue_)) return row;
  }
  throw gatewayApplyError_("materials_sheet_full", "На аркуші «Матеріали» немає вільного рядка.");
}

function ensureCoverIndexTarget_(sheet, plan, journal) {
  var maximum = Math.min(5000, Number(sheet.getLastRow()) || 1);
  var matches = maximum < 2 ? [] : sheet.getRange(2, 1, maximum - 1, 1).getDisplayValues()
    .map(function (row, index) { return String(row[0] || "").trim() === plan.material_id ? index + 2 : 0; })
    .filter(function (row) { return Boolean(row); });
  if (matches.length > 1) {
    throw gatewayApplyError_("duplicate_cover_row", "CAT-ID повторюється в індексі обкладинок.");
  }
  var wantedRow = matches.length ? matches[0] : plan.material_row;
  if (plan.cover_row !== wantedRow) {
    plan.cover_row = wantedRow;
    updateApplyJournalEntry_(journal, "applying", journal.plan, null, "");
  }
  preflightCoverRow_(sheet, plan.cover_row, plan.material_id);
}

function assertUniqueMaterialIsbn_(sheet, isbn, excludedRow) {
  var matches = gatewayReadRows_(sheet, 25, 5000).filter(function (item) {
    return item.row !== excludedRow && normalizeGatewayIsbnLoose_(item.values[24] || item.values[9]) === isbn;
  });
  if (matches.length) throw gatewayApplyError_("duplicate_isbn", "Матеріал із цим ISBN уже існує.");
}

function assertMaterialTargetRowEmpty_(sheet, row) {
  var writable = sheet.getRange(row, 1, 1, 18);
  var extra = sheet.getRange(row, 24, 1, 1);
  var values = writable.getDisplayValues()[0].concat(extra.getDisplayValues()[0]);
  var formulas = writable.getFormulas()[0].concat(extra.getFormulas()[0]);
  if (values.some(nonEmptyGatewayValue_) || formulas.some(nonEmptyGatewayValue_)) {
    throw gatewayApplyError_("target_row_not_empty", "Цільовий рядок матеріалу вже зайнятий.");
  }
}

function preflightMaterialBalanceCapacity_(spreadsheet, nextMaterialCount) {
  var locations = gatewayReadRows_(gatewayRequiredSheet_(spreadsheet, "Місця"), 4, 1000)
    .filter(function (item) { return /^LOC-\d{3,}$/.test(String(item.values[0] || "").trim()); });
  var activeLocationIds = locations.filter(function (item) {
    return /^актив/i.test(String(item.values[3] || "").trim());
  }).map(function (item) { return String(item.values[0] || "").trim(); });
  if (!activeLocationIds.length) {
    throw gatewayApplyError_("balance_locations_missing", "У довіднику немає активних місць для формування балансу.");
  }
  var balance = gatewayRequiredSheet_(spreadsheet, "Баланс");
  var requiredRows = Number(nextMaterialCount) * locations.length + 1;
  if (requiredRows > Number(balance.getMaxRows())) {
    throw gatewayApplyError_("balance_capacity", "Аркуш «Баланс» не має місткості для нового матеріалу.");
  }
  return activeLocationIds;
}

function verifyNewMaterialBalanceCoverage_(spreadsheet, materialId, activeLocationIds) {
  (activeLocationIds || []).forEach(function (locationId) {
    var quantity = readBalanceQuantity_(spreadsheet, materialId, locationId, false);
    if (quantity !== 0) {
      throw gatewayApplyError_(
        "balance_formula_coverage",
        "Новий матеріал не отримав однозначний нульовий рядок балансу для кожного активного місця.",
      );
    }
  });
}

function preflightCoverRow_(sheet, row, materialId) {
  var values = sheet.getRange(row, 1, 1, 3).getDisplayValues()[0];
  var formulas = sheet.getRange(row, 1, 1, 3).getFormulas()[0];
  if ((values[0] && String(values[0]).trim() !== materialId) || values[2]) {
    throw gatewayApplyError_("cover_row_conflict", "Рядок обкладинки вже належить іншому матеріалу.");
  }
  if (formulas[2]) throw gatewayApplyError_("cover_row_conflict", "URL обкладинки не може бути формулою.");
}

function writeCoverIndexRow_(sheet, row, materialId) {
  preflightCoverRow_(sheet, row, materialId);
  var a = sheet.getRange(row, 1);
  var b = sheet.getRange(row, 2);
  if (!String(a.getDisplayValues()[0][0] || "").trim() && !a.getFormula()) {
    if (typeof a.setFormula === "function") {
      a.setFormula("=IF('Матеріали'!A" + row + "=\"\",\"\",'Матеріали'!A" + row + ")");
    } else {
      a.setValue(materialId);
    }
  }
  if (!String(b.getDisplayValues()[0][0] || "").trim() && !b.getFormula() && typeof b.setFormula === "function") {
    b.setFormula("=IF(C" + row + "=\"\",\"\",IMAGE(C" + row + "))");
  }
}

function verifyCoverIndexRow_(sheet, row, materialId) {
  var a = sheet.getRange(row, 1);
  var actual = String(a.getDisplayValues()[0][0] || "").trim();
  if (actual !== materialId && !a.getFormula()) {
    throw new Error("Google Sheets не підтвердив індекс обкладинки.");
  }
  if (String(sheet.getRange(row, 3).getDisplayValues()[0][0] || "").trim()) {
    throw gatewayApplyError_("cover_row_conflict", "До завершення cover workflow постійний URL має бути порожнім.");
  }
}

/* -------------------------------------------------------------------------- */
/* Stock operations                                                           */
/* -------------------------------------------------------------------------- */

function prepareReceiptPlan_(spreadsheet, payload, actor) {
  validateExactKeys_(payload, [
    "materialId", "quantity", "location", "locationId", "locationName", "condition",
    "documentNumber", "date", "notes", "sourceGeneratedAt",
  ]);
  var material = readMaterialDescriptor_(spreadsheet, payload.materialId);
  var location = resolveGatewayLocation_(spreadsheet, payload.locationId, payload.locationName || payload.location, false);
  var quantity = gatewayInteger_(payload.quantity, 1, 100000, "Некоректна кількість.");
  var before = readBalanceQuantity_(spreadsheet, material.id, location.id, false);
  return {
    kind: "receipt.create",
    operation: prepareOperationRowPlan_(spreadsheet, {
      material_id: material.id,
      material_label: material.label,
      date: requiredIsoDate_(payload.date, "Некоректна дата надходження."),
      type: "Надходження",
      from: null,
      to: location,
      condition: normalizeGatewayCondition_(payload.condition),
      quantity: quantity,
      actor: actor,
      notes: structuredOperationNotes_(payload, "Надходження"),
      balance_checks: [{ material_id: material.id, location_id: location.id, before: before, after: before + quantity }],
    }),
    completed_steps: [],
  };
}

function prepareTransferPlan_(spreadsheet, payload, actor) {
  validateExactKeys_(payload, [
    "materialId", "quantity", "fromLocation", "toLocation", "fromLocationId",
    "fromLocationName", "toLocationId", "toLocationName", "condition", "date", "notes",
    "sourceGeneratedAt", "observedAvailableQuantity",
  ]);
  var material = readMaterialDescriptor_(spreadsheet, payload.materialId);
  var from = resolveGatewayLocation_(spreadsheet, payload.fromLocationId, payload.fromLocationName || payload.fromLocation, false);
  var to = resolveGatewayLocation_(spreadsheet, payload.toLocationId, payload.toLocationName || payload.toLocation, false);
  if (from.id === to.id) throw gatewayApplyError_("same_location", "Початкове і нове розміщення збігаються.");
  var quantity = gatewayInteger_(payload.quantity, 1, 100000, "Некоректна кількість.");
  var fromBefore = readBalanceQuantity_(spreadsheet, material.id, from.id, false);
  var toBefore = readBalanceQuantity_(spreadsheet, material.id, to.id, false);
  assertObservedStock_(payload.observedAvailableQuantity, fromBefore);
  if (fromBefore < quantity) throw gatewayApplyError_("insufficient_stock", "Недостатньо примірників у початковому місці.");
  return {
    kind: "transfer.create",
    operation: prepareOperationRowPlan_(spreadsheet, {
      material_id: material.id,
      material_label: material.label,
      date: requiredIsoDate_(payload.date, "Некоректна дата переміщення."),
      type: "Переміщення",
      from: from,
      to: to,
      condition: normalizeGatewayCondition_(payload.condition),
      quantity: quantity,
      actor: actor,
      notes: structuredOperationNotes_(payload, "Переміщення"),
      balance_checks: [
        { material_id: material.id, location_id: from.id, before: fromBefore, after: fromBefore - quantity },
        { material_id: material.id, location_id: to.id, before: toBefore, after: toBefore + quantity },
      ],
    }),
    completed_steps: [],
  };
}

function prepareWriteoffPlan_(spreadsheet, payload, actor) {
  validateExactKeys_(payload, [
    "materialId", "fromLocationId", "fromLocationName", "quantity", "destination",
    "reason", "condition", "actNumber", "date", "notes", "sourceGeneratedAt",
    "observedAvailableQuantity",
  ]);
  var material = readMaterialDescriptor_(spreadsheet, payload.materialId);
  var from = resolveGatewayLocation_(spreadsheet, payload.fromLocationId, payload.fromLocationName, false);
  if (from.id === LIBRARIAN_SERVICE_WRITTEN_OFF_ID || from.id === LIBRARIAN_SERVICE_LOST_ID) {
    throw gatewayApplyError_("invalid_source_location", "Службове місце не може бути джерелом списання.");
  }
  var serviceId = payload.destination === "lost" ? LIBRARIAN_SERVICE_LOST_ID : LIBRARIAN_SERVICE_WRITTEN_OFF_ID;
  var to = resolveGatewayLocation_(spreadsheet, serviceId, "", true);
  var quantity = gatewayInteger_(payload.quantity, 1, 100000, "Некоректна кількість.");
  var fromBefore = readBalanceQuantity_(spreadsheet, material.id, from.id, false);
  var toBefore = readBalanceQuantity_(spreadsheet, material.id, to.id, false);
  assertObservedStock_(payload.observedAvailableQuantity, fromBefore);
  if (fromBefore < quantity) throw gatewayApplyError_("insufficient_stock", "Недостатньо примірників для списання.");
  return {
    kind: "writeoff.create",
    operation: prepareOperationRowPlan_(spreadsheet, {
      material_id: material.id,
      material_label: material.label,
      date: requiredIsoDate_(payload.date, "Некоректна дата списання."),
      type: payload.destination === "lost" ? "Втрата" : "Списання",
      from: from,
      to: to,
      condition: normalizeGatewayCondition_(payload.condition),
      quantity: quantity,
      actor: actor,
      notes: structuredOperationNotes_(payload, payload.destination === "lost" ? "Втрата" : "Списання"),
      balance_checks: [
        { material_id: material.id, location_id: from.id, before: fromBefore, after: fromBefore - quantity },
        { material_id: material.id, location_id: to.id, before: toBefore, after: toBefore + quantity },
      ],
    }),
    completed_steps: [],
  };
}

function prepareRevisionPlan_(spreadsheet, payload, actor) {
  validateExactKeys_(payload, [
    "materialId", "location", "locationId", "locationName", "countedQuantity",
    "expectedQuantity", "sessionId", "date", "notes", "sourceGeneratedAt",
  ]);
  var material = readMaterialDescriptor_(spreadsheet, payload.materialId);
  var location = resolveGatewayLocation_(spreadsheet, payload.locationId, payload.locationName || payload.location, false);
  var counted = gatewayInteger_(payload.countedQuantity, 0, 100000, "Некоректний результат ревізії.");
  var current = readBalanceQuantity_(spreadsheet, material.id, location.id, false);
  if (payload.expectedQuantity === undefined || payload.expectedQuantity === null || payload.expectedQuantity === "") {
    throw gatewayApplyError_("stock_snapshot_missing", "Відсутній перевірений залишок для ревізії. Оновіть дані перед підтвердженням.");
  }
  var expectedQuantity = gatewayInteger_(
    payload.expectedQuantity,
    0,
    100000,
    "Некоректний перевірений залишок для ревізії.",
  );
  if (expectedQuantity !== current) {
    throw gatewayApplyError_("stale_stock", "Очікуваний залишок змінився; оновіть дані ревізії.");
  }
  var diff = counted - current;
  var revisionSheet = spreadsheet.getSheetByName(LIBRARIAN_REVISION_JOURNAL_SHEET);
  var revisionRow = revisionSheet ? nextSimpleJournalRow_(revisionSheet, 10000) : 2;
  var plan = {
    kind: "revision.count",
    material_id: material.id,
    location: location,
    counted: counted,
    expected: current,
    difference: diff,
    session_id: gatewayOptionalText_(payload.sessionId, 80),
    date: requiredIsoDate_(payload.date, "Некоректна дата ревізії."),
    notes: gatewayOptionalText_(payload.notes, 2000),
    actor: actor,
    revision_row: revisionRow,
    completed_steps: [],
  };
  if (revisionSheet) preflightSimpleJournalRow_(revisionSheet, revisionRow, 12);
  if (diff !== 0) {
    var service = diff < 0
      ? resolveGatewayLocation_(spreadsheet, LIBRARIAN_SERVICE_WRITTEN_OFF_ID, "", true)
      : null;
    var serviceBefore = service ? readBalanceQuantity_(spreadsheet, material.id, service.id, false) : 0;
    plan.operation = prepareOperationRowPlan_(spreadsheet, {
      material_id: material.id,
      material_label: material.label,
      date: plan.date,
      type: "Коригування",
      from: diff < 0 ? location : null,
      to: diff > 0 ? location : service,
      condition: "Не перевірено",
      quantity: Math.abs(diff),
      actor: actor,
      notes: structuredOperationNotes_(payload, "Ревізія; очікувалось " + current + ", пораховано " + counted),
      balance_checks: diff > 0
        ? [{ material_id: material.id, location_id: location.id, before: current, after: counted }]
        : [
          { material_id: material.id, location_id: location.id, before: current, after: counted },
          { material_id: material.id, location_id: service.id, before: serviceBefore, after: serviceBefore + Math.abs(diff) },
        ],
    });
  }
  return plan;
}

function executeReceipt_(spreadsheet, journal) {
  return executeStandaloneOperation_(spreadsheet, journal, "Надходження додано.");
}

function executeTransfer_(spreadsheet, journal) {
  return executeStandaloneOperation_(spreadsheet, journal, "Переміщення додано.");
}

function executeWriteoff_(spreadsheet, journal) {
  return executeStandaloneOperation_(spreadsheet, journal, "Списання додано.");
}

function executeStandaloneOperation_(spreadsheet, journal, message) {
  var result = executeOperationRowPlan_(spreadsheet, journal.plan.operation, journal, "operation");
  return genericApplyResult_(
    "applied",
    [result.mutation],
    { materialId: journal.plan.operation.material_id, operationId: result.operation_id },
    message,
    noCoverInstruction_(),
  );
}

function executeRevision_(spreadsheet, journal) {
  var plan = journal.plan;
  var mutations = [];
  var operationId = "";
  if (plan.operation) {
    var operation = executeOperationRowPlan_(spreadsheet, plan.operation, journal, "revision_operation");
    operationId = operation.operation_id;
    mutations.push(operation.mutation);
  }
  var revisionSheet = ensureRevisionJournalSheet_(spreadsheet);
  var expected = {
    "1": journal.requestId,
    "2": plan.session_id,
    "3": plan.material_id,
    "4": plan.location.id,
    "5": plan.location.name,
    "6": plan.expected,
    "7": plan.counted,
    "8": plan.difference,
    "9": plan.date,
    "10": plan.actor.name,
    "11": plan.notes,
    "12": operationId,
  };
  ensureRevisionJournalTarget_(revisionSheet, plan, expected, journal);
  var revisionNeedsWrite = preflightRevisionJournalRow_(revisionSheet, plan.revision_row, expected);
  if (!hasApplyJournalCheckpoint_(journal, "revision_journal") || revisionNeedsWrite) {
    markApplyJournalWriteIntent_(journal, "revision_journal");
    // Column A is the durable request identity.  Persist it before the rest of
    // the audit row so a crash followed by sorting can still be reconciled.
    if (normalizedGatewayCell_(revisionSheet.getRange(plan.revision_row, 1).getValue()) === "") {
      revisionSheet.getRange(plan.revision_row, 1).setValue(journal.requestId);
      SpreadsheetApp.flush();
      verifyReconciledCells_(revisionSheet, plan.revision_row, { "1": journal.requestId });
      checkpointApplyJournal_(journal, "revision_journal:identity_written");
    }
    writeRevisionJournalRow_(revisionSheet, plan.revision_row, expected);
    SpreadsheetApp.flush();
    verifyReconciledCells_(revisionSheet, plan.revision_row, expected);
    checkpointApplyJournal_(journal, "revision_journal");
  } else {
    verifyReconciledCells_(revisionSheet, plan.revision_row, expected);
  }
  mutations.push({ sheet: LIBRARIAN_REVISION_JOURNAL_SHEET, row: plan.revision_row, action: "audit", entity_id: journal.requestId });
  var revisionEntityIds = {
    materialId: plan.material_id,
    revisionRequestId: journal.requestId,
  };
  if (operationId) revisionEntityIds.operationId = operationId;
  return genericApplyResult_(
    "applied",
    mutations,
    revisionEntityIds,
    plan.difference === 0 ? "Ревізію зафіксовано без коригування." : "Ревізію зафіксовано і залишок скориговано.",
    noCoverInstruction_(),
  );
}

function ensureRevisionJournalTarget_(revisionSheet, plan, expected, journal) {
  var identityRows = findRevisionRequestRows_(revisionSheet, expected["1"]);
  if (identityRows.length > 1) {
    throw gatewayApplyError_("duplicate_revision_request", "request_id ревізії повторюється у журналі.");
  }
  if (identityRows.length === 1) {
    var identityRow = identityRows[0];
    preflightRevisionJournalRow_(revisionSheet, identityRow, expected);
    if (plan.revision_row !== identityRow) {
      plan.revision_row = identityRow;
      updateApplyJournalEntry_(journal, "applying", journal.plan, null, "");
    }
    return;
  }
  ensureSheetRowExists_(revisionSheet, plan.revision_row);
  var state = reconciledRowState_(revisionSheet, plan.revision_row, revisionExpectedWithoutOperation_(expected));
  if (state.compatible && revisionOperationValueCompatible_(revisionSheet, plan.revision_row, expected["12"])) return;
  if (hasApplyJournalCheckpoint_(journal, "write_started:revision_journal") ||
      hasApplyJournalCheckpoint_(journal, "revision_journal:identity_written") ||
      hasApplyJournalCheckpoint_(journal, "revision_journal")) {
    throw gatewayApplyError_("revision_identity_missing", "Не знайдено рядок частково записаного журналу ревізії.");
  }
  plan.revision_row = nextSimpleJournalRow_(revisionSheet, 10000);
  ensureSheetRowExists_(revisionSheet, plan.revision_row);
  preflightSimpleJournalRow_(revisionSheet, plan.revision_row, 12);
  updateApplyJournalEntry_(journal, "applying", journal.plan, null, "");
}

function findRevisionRequestRows_(sheet, requestId) {
  var lastRow = Math.min(Number(sheet.getLastRow()) || 1, 10000);
  if (lastRow < 2) return [];
  var matches = [];
  sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues().forEach(function (values, index) {
    if (String(values[0] || "").trim() === requestId) matches.push(index + 2);
  });
  return matches;
}

function revisionExpectedWithoutOperation_(expected) {
  var result = {};
  Object.keys(expected).forEach(function (columnText) {
    if (columnText !== "12") result[columnText] = expected[columnText];
  });
  return result;
}

function revisionOperationValueCompatible_(sheet, row, expectedOperationId) {
  var actual = normalizedGatewayCell_(sheet.getRange(row, 12).getValue());
  var wanted = normalizedGatewayCell_(expectedOperationId);
  return actual === "" || actual === wanted || (/^OP-\d{6}$/.test(actual) && /^OP-\d{6}$/.test(wanted));
}

function preflightRevisionJournalRow_(sheet, row, expected) {
  var stableExpected = revisionExpectedWithoutOperation_(expected);
  assertWritableColumnsWithoutFormulas_(sheet, row, expected);
  Object.keys(stableExpected).forEach(function (columnText) {
    var actual = normalizedGatewayCell_(sheet.getRange(row, Number(columnText)).getValue());
    var wanted = normalizedGatewayCell_(stableExpected[columnText]);
    if (actual !== "" && actual !== wanted) {
      throw gatewayApplyError_("revision_conflict", "Рядок журналу ревізії містить інші дані.");
    }
  });
  if (!revisionOperationValueCompatible_(sheet, row, expected["12"])) {
    throw gatewayApplyError_("revision_conflict", "Рядок журналу ревізії посилається на іншу операцію.");
  }
  return Object.keys(expected).some(function (columnText) {
    return normalizedGatewayCell_(sheet.getRange(row, Number(columnText)).getValue()) !==
      normalizedGatewayCell_(expected[columnText]);
  });
}

function writeRevisionJournalRow_(sheet, row, expected) {
  preflightRevisionJournalRow_(sheet, row, expected);
  Object.keys(expected).forEach(function (columnText) {
    var range = sheet.getRange(row, Number(columnText));
    if (normalizedGatewayCell_(range.getValue()) !== normalizedGatewayCell_(expected[columnText])) {
      range.setValue(gatewaySheetValue_(expected[columnText]));
    }
  });
}

function prepareOperationRowPlan_(spreadsheet, data) {
  var sheet = gatewayRequiredSheet_(spreadsheet, "Операції");
  assertOperationRequestColumn_(sheet);
  var row = findFirstWritableOperationRow_(sheet);
  var values = {
    "2": data.date,
    "3": data.material_label,
    "4": data.type,
    "5": data.from ? data.from.name : "",
    "6": data.to ? data.to.name : "",
    "7": data.condition,
    "8": data.quantity,
    "9": "Підтверджено",
    "10": data.actor.name,
    "11": data.notes,
  };
  preflightReconciledCells_(sheet, row, values, "operation_row_conflict", false);
  assertOperationFormulaColumns_(sheet, row);
  return {
    row: row,
    material_id: data.material_id,
    values: values,
    formula_values: {
      "12": data.material_id,
      "13": data.from ? data.from.id : "",
      "14": data.to ? data.to.id : "",
      "15": data.actor.id,
    },
    balance_checks: data.balance_checks || [],
  };
}

function executeOperationRowPlan_(spreadsheet, operationPlan, journal, checkpoint) {
  var sheet = gatewayRequiredSheet_(spreadsheet, "Операції");
  bindOperationRequestIdentity_(operationPlan, journal);
  var rowState = ensureOperationPlanTarget_(sheet, operationPlan, journal, checkpoint);
  if (!hasApplyJournalCheckpoint_(journal, checkpoint)) {
    var balanceState = operationBalanceState_(spreadsheet, operationPlan.balance_checks);
    if (!rowState.has_values && balanceState !== "before") {
      throw gatewayApplyError_(
        "stale_stock",
        "Залишок змінився після перевірки операції. Оновіть дані й підтвердьте її повторно.",
      );
    }
    if (!rowState.complete && rowState.has_values && balanceState !== "before" && balanceState !== "after") {
      throw gatewayRetryableError_(
        "operation_reconcile_required",
        "Частково записану операцію не вдалося однозначно звірити із залишком.",
      );
    }
    preflightReconciledCells_(sheet, operationPlan.row, operationPlan.values, "operation_row_conflict", false);
    markApplyJournalWriteIntent_(journal, checkpoint);
    var marker = sheet.getRange(operationPlan.row, LIBRARIAN_OPERATION_REQUEST_COLUMN);
    if (normalizedGatewayCell_(marker.getValue()) === "") {
      marker.setValue(operationPlan.request_id);
      SpreadsheetApp.flush();
      verifyReconciledCells_(sheet, operationPlan.row, {
        "16": operationPlan.request_id,
      });
      checkpointApplyJournal_(journal, checkpoint + ":identity_written");
    }
    if (!rowState.complete) {
      writeReconciledCells_(
        sheet,
        operationPlan.row,
        operationWritableValues_(operationPlan.values),
        "operation_row_conflict",
      );
      SpreadsheetApp.flush();
      checkpointApplyJournal_(journal, checkpoint + ":row_written");
    }
    verifyReconciledCells_(sheet, operationPlan.row, operationPlan.values);
    assertOperationFormulaColumns_(sheet, operationPlan.row);
    verifyOperationFormulaValues_(sheet, operationPlan.row, operationPlan.formula_values);
    // An exact, uniquely marked row is authoritative on retry.  A later valid
    // operation may already have changed the aggregate balance, so only a row
    // completed by this invocation is expected to equal the original "after"
    // snapshot.
    if (!rowState.complete) verifyBalanceChecks_(spreadsheet, operationPlan.balance_checks);
    checkpointApplyJournal_(journal, checkpoint);
  } else {
    verifyReconciledCells_(sheet, operationPlan.row, operationPlan.values);
    assertOperationFormulaColumns_(sheet, operationPlan.row);
    verifyOperationFormulaValues_(sheet, operationPlan.row, operationPlan.formula_values);
  }
  var operationId = String(sheet.getRange(operationPlan.row, 1).getDisplayValues()[0][0] || "").trim();
  var expectedOperationId = "OP-" + String(operationPlan.row - 1).padStart(6, "0");
  var idMatches = sheet.getRange(2, 1, Math.min(999, Number(sheet.getMaxRows()) - 1), 1)
    .getDisplayValues().filter(function (row) { return String(row[0] || "").trim() === expectedOperationId; });
  if (operationId !== expectedOperationId || idMatches.length !== 1) {
    throw new Error("Google Sheets не сформував ID операції.");
  }
  return {
    operation_id: operationId,
    mutation: { sheet: "Операції", row: operationPlan.row, action: "create", entity_id: operationId },
  };
}

function operationWritableValues_(values) {
  var result = {};
  Object.keys(values || {}).forEach(function (columnText) {
    var column = Number(columnText);
    if (column >= 2 && column <= 11) result[columnText] = values[columnText];
  });
  return result;
}

function bindOperationRequestIdentity_(operationPlan, journal) {
  var requestId = String(journal.requestId || "").trim();
  if (operationPlan.request_id && operationPlan.request_id !== requestId) {
    throw gatewayApplyError_("operation_request_conflict", "Операція прив’язана до іншого request_id.");
  }
  if (operationPlan.request_id === requestId && operationPlan.values["16"] === requestId) return;
  operationPlan.request_id = requestId;
  operationPlan.values["16"] = requestId;
  updateApplyJournalEntry_(journal, "applying", journal.plan, null, "");
}

function ensureOperationPlanTarget_(sheet, operationPlan, journal, checkpoint) {
  assertOperationRequestColumn_(sheet);
  var identityRows = findOperationRequestRows_(sheet, operationPlan.request_id);
  if (identityRows.length > 1) {
    throw gatewayApplyError_("duplicate_operation_request", "request_id операції повторюється.");
  }
  if (identityRows.length === 1) {
    var identityState = reconciledRowState_(sheet, identityRows[0], operationPlan.values);
    if (!identityState.compatible) {
      throw gatewayApplyError_("operation_identity_conflict", "request_id операції знайдено в іншому записі.");
    }
    if (operationPlan.row !== identityRows[0]) {
      operationPlan.row = identityRows[0];
      updateApplyJournalEntry_(journal, "applying", journal.plan, null, "");
    }
    assertOperationFormulaColumns_(sheet, operationPlan.row);
    return identityState;
  }
  var state = reconciledRowState_(sheet, operationPlan.row, operationPlan.values);
  if (state.compatible) return state;
  if (hasApplyJournalCheckpoint_(journal, "write_started:" + checkpoint) ||
      hasApplyJournalCheckpoint_(journal, checkpoint + ":row_written") ||
      hasApplyJournalCheckpoint_(journal, checkpoint)) {
    throw gatewayApplyError_("operation_identity_missing", "Не знайдено рядок частково записаної операції.");
  }
  operationPlan.row = findFirstWritableOperationRow_(sheet);
  updateApplyJournalEntry_(journal, "applying", journal.plan, null, "");
  return reconciledRowState_(sheet, operationPlan.row, operationPlan.values);
}

function findOperationRequestRows_(sheet, requestId) {
  var maximum = Math.min(LIBRARIAN_OPERATION_MAX_ROW, Number(sheet.getMaxRows()) || 0);
  if (maximum < 2) return [];
  var values = sheet.getRange(2, LIBRARIAN_OPERATION_REQUEST_COLUMN, maximum - 1, 1).getDisplayValues();
  var rows = [];
  values.forEach(function (item, index) {
    if (String(item[0] || "").trim() === requestId) rows.push(index + 2);
  });
  return rows;
}

function reconciledRowState_(sheet, row, expected) {
  assertWritableColumnsWithoutFormulas_(sheet, row, expected);
  var compatible = true;
  var complete = true;
  var hasValues = false;
  Object.keys(expected).forEach(function (columnText) {
    var actual = normalizedGatewayCell_(sheet.getRange(row, Number(columnText)).getValue());
    var wanted = normalizedGatewayCell_(expected[columnText]);
    if (actual !== "") hasValues = true;
    if (actual !== wanted) complete = false;
    if (actual !== "" && actual !== wanted) compatible = false;
  });
  return { compatible: compatible, complete: complete, has_values: hasValues };
}

function operationBalanceState_(spreadsheet, checks) {
  var allBefore = true;
  var allAfter = true;
  (checks || []).forEach(function (check) {
    var actual = readBalanceQuantity_(
      spreadsheet,
      check.material_id,
      check.location_id,
      check.allow_missing_before === true,
    );
    if (actual !== Number(check.before)) allBefore = false;
    if (actual !== Number(check.after)) allAfter = false;
  });
  if (allBefore) return "before";
  if (allAfter) return "after";
  return "conflict";
}

function findFirstWritableOperationRow_(sheet) {
  assertOperationRequestColumn_(sheet);
  var maximum = Math.min(LIBRARIAN_OPERATION_MAX_ROW, Number(sheet.getMaxRows()) || 0);
  if (maximum < 2) throw gatewayApplyError_("operations_sheet_full", "Аркуш «Операції» не має робочих рядків.");
  var rows = sheet.getRange(2, 2, maximum - 1, 10).getDisplayValues();
  var requestIds = sheet.getRange(2, LIBRARIAN_OPERATION_REQUEST_COLUMN, maximum - 1, 1).getDisplayValues();
  for (var index = 0; index < rows.length; index += 1) {
    if (rows[index].every(function (value) { return String(value || "").trim() === ""; }) &&
        String(requestIds[index][0] || "").trim() === "") {
      var row = index + 2;
      assertOperationFormulaColumns_(sheet, row);
      return row;
    }
  }
  throw gatewayApplyError_("operations_sheet_full", "На аркуші «Операції» немає вільного рядка B:K.");
}

function assertOperationRequestColumn_(sheet) {
  var header = String(sheet.getRange(1, LIBRARIAN_OPERATION_REQUEST_COLUMN).getDisplayValues()[0][0] || "").trim();
  if (header !== LIBRARIAN_OPERATION_REQUEST_HEADER ||
      sheet.getRange(1, LIBRARIAN_OPERATION_REQUEST_COLUMN).getFormula()) {
    throw gatewayApplyError_(
      "operation_request_column_missing",
      "Службову колонку request_id на аркуші «Операції» не підготовлено.",
    );
  }
}

function assertOperationFormulaColumns_(sheet, row) {
  [1, 12, 13, 14, 15].forEach(function (column) {
    if (!sheet.getRange(row, column).getFormula()) {
      throw gatewayApplyError_("formula_missing", "У рядку операції відсутня службова формула.");
    }
  });
  var template = sheet.getRange(2, 1, 1, 15).getFormulas()[0];
  assertGenericOperationFormulaSource_(template);
  var formulas = sheet.getRange(row, 1, 1, 15).getFormulas()[0];
  if (formulas.slice(1, 11).some(nonEmptyGatewayValue_) ||
      [1, 12, 13, 14, 15].some(function (column) {
        return formulas[column - 1] !== translatedOperationFormula_(template[column - 1], row - 2);
      })) {
    throw gatewayApplyError_("operation_formula_mismatch", "Службові формули рядка операції не відповідають перевіреному шаблону.");
  }
}

function assertGenericOperationFormulaSource_(formulas) {
  if (normalizeOperationRepairFormula_(formulas[0]) !== "=IF(B2=\"\",\"\",\"OP-\"&TEXT(ROW()-1,\"000000\"))" ||
      formulaReferences_(formulas[11]).indexOf("C2") === -1 ||
      normalizeOperationRepairFormula_(formulas[11]).indexOf("CAT-") === -1 ||
      formulaReferences_(formulas[12]).indexOf("E2") === -1 ||
      formulaReferences_(formulas[13]).indexOf("F2") === -1 ||
      formulaReferences_(formulas[14]).indexOf("J2") === -1) {
    throw gatewayApplyError_("operation_formula_template_invalid", "Еталонні службові формули Операції!2 пошкоджено.");
  }
}

function formulaReferences_(formula) {
  var matches = String(formula || "").replace(/\$/g, "").toLocaleUpperCase("en-US")
    .match(/(?:^|[^A-Z])([A-Z]{1,3}\d+)/g) || [];
  return matches.map(function (match) {
    var value = match.match(/([A-Z]{1,3}\d+)$/);
    return value ? value[1] : "";
  }).filter(function (value) { return Boolean(value); });
}

function formulaOnlyReferences_(formula, expected) {
  var references = formulaReferences_(formula);
  return references.length > 0 && references.every(function (reference) { return reference === expected; });
}

function verifyOperationFormulaValues_(sheet, row, expected) {
  Object.keys(expected || {}).forEach(function (columnText) {
    var actual = String(sheet.getRange(row, Number(columnText)).getDisplayValues()[0][0] || "").trim();
    if (actual !== String(expected[columnText] || "")) {
      throw new Error("Google Sheets не підтвердив службові ID операції.");
    }
  });
}

function verifyBalanceChecks_(spreadsheet, checks) {
  (checks || []).forEach(function (check) {
    var actual = readBalanceQuantity_(spreadsheet, check.material_id, check.location_id, false);
    if (actual !== Number(check.after)) {
      throw new Error("Google Sheets не підтвердив очікувану зміну балансу.");
    }
  });
}

function readBalanceQuantity_(spreadsheet, materialId, locationId, allowMissing) {
  var sheet = gatewayRequiredSheet_(spreadsheet, "Баланс");
  var rows = gatewayReadRows_(sheet, 6, LIBRARIAN_DATA_MAX_ROW);
  var matches = rows.filter(function (item) {
    return String(item.values[1] || "").trim() === materialId &&
      String(item.values[3] || "").trim() === locationId;
  });
  if (matches.length > 1) throw gatewayApplyError_("duplicate_balance", "У балансі знайдено дубль матеріалу й місця.");
  if (!matches.length) {
    if (allowMissing) return 0;
    throw gatewayApplyError_("balance_missing", "У балансі відсутня пара матеріал/місце.");
  }
  var text = String(matches[0].values[5] || "0").replace(/\s/g, "").replace(",", ".");
  var value = Number(text);
  if (!isFinite(value) || Math.floor(value) !== value || value < 0) {
    throw gatewayApplyError_("invalid_balance", "Баланс містить некоректну кількість.");
  }
  return value;
}

function assertObservedStock_(observed, actual) {
  if (observed === undefined || observed === null || observed === "") {
    throw gatewayApplyError_("stock_snapshot_missing", "Відсутній перевірений залишок. Оновіть дані перед підтвердженням.");
  }
  var reviewed = gatewayInteger_(
    observed,
    0,
    100000,
    "Некоректний перевірений залишок.",
  );
  if (reviewed !== actual) {
    throw gatewayApplyError_("stale_stock", "Залишок змінився після відкриття форми.");
  }
}

function readMaterialDescriptor_(spreadsheet, rawMaterialId) {
  var id = gatewayMaterialId_(rawMaterialId);
  var sheet = gatewayRequiredSheet_(spreadsheet, "Матеріали");
  var row = findUniqueMaterialRow_(sheet, id);
  var title = String(sheet.getRange(row, 7).getDisplayValues()[0][0] || "").trim();
  return { id: id, row: row, label: id + (title ? " — " + title : "") };
}

function resolveGatewayLocation_(spreadsheet, rawId, rawName, allowService) {
  var id = rawId ? String(rawId).trim().toUpperCase() : "";
  var name = rawName ? String(rawName).trim() : "";
  if (id && !/^LOC-\d{3,}$/.test(id)) throw gatewayApplyError_("invalid_location", "Некоректний ID місця.");
  var rows = gatewayReadRows_(gatewayRequiredSheet_(spreadsheet, "Місця"), 4, 1000);
  var matches = rows.filter(function (item) {
    var rowId = String(item.values[0] || "").trim();
    var rowName = String(item.values[1] || "").trim();
    var status = String(item.values[3] || "").trim();
    if (!/^актив/i.test(status)) return false;
    if (!allowService && (rowId === LIBRARIAN_SERVICE_WRITTEN_OFF_ID || rowId === LIBRARIAN_SERVICE_LOST_ID)) return false;
    return id ? rowId === id && (!name || rowName === name) : Boolean(name && rowName === name);
  });
  if (matches.length !== 1) {
    throw gatewayApplyError_(matches.length ? "ambiguous_location" : "location_not_found", "Місце не знайдено однозначно в активному довіднику.");
  }
  return { id: String(matches[0].values[0]).trim(), name: String(matches[0].values[1]).trim(), row: matches[0].row };
}

function normalizeGatewayCondition_(value) {
  var condition = value ? gatewaySafeText_(value, 80, "Некоректний стан примірника.") : "Не перевірено";
  if (["Придатний", "Пошкоджений", "Не перевірено"].indexOf(condition) === -1) {
    throw gatewayApplyError_("invalid_condition", "Стан має бути: Придатний, Пошкоджений або Не перевірено.");
  }
  return condition;
}

function structuredOperationNotes_(payload, label) {
  var parts = [label];
  if (payload.documentNumber) parts.push("Документ: " + gatewayOptionalText_(payload.documentNumber, 100));
  if (payload.actNumber) parts.push("Акт: " + gatewayOptionalText_(payload.actNumber, 100));
  if (payload.reason) parts.push("Причина: " + gatewayOptionalText_(payload.reason, 100));
  if (payload.sessionId) parts.push("Сесія: " + gatewayOptionalText_(payload.sessionId, 80));
  if (payload.notes) parts.push(gatewayOptionalText_(payload.notes, 2000));
  return parts.join("; ").slice(0, 2000);
}

function ensureRevisionJournalSheet_(spreadsheet) {
  var sheet = spreadsheet.getSheetByName(LIBRARIAN_REVISION_JOURNAL_SHEET);
  var headers = [
    "request_id", "session_id", "material_id", "location_id", "location_name",
    "expected", "counted", "difference", "date", "actor", "notes", "operation_id",
  ];
  if (!sheet) {
    sheet = spreadsheet.insertSheet(LIBRARIAN_REVISION_JOURNAL_SHEET);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    if (typeof sheet.hideSheet === "function") sheet.hideSheet();
  } else {
    var actual = sheet.getRange(1, 1, 1, headers.length).getDisplayValues()[0];
    headers.forEach(function (header, index) {
      if (String(actual[index] || "").trim() !== header) {
        throw gatewayApplyError_("revision_journal_schema", "Структура журналу ревізій змінилася.");
      }
    });
  }
  return sheet;
}

function nextSimpleJournalRow_(sheet, maximum) {
  var last = Number(sheet.getLastRow()) || 1;
  if (last >= maximum) throw gatewayApplyError_("journal_full", "Журнал заповнений.");
  return Math.max(2, last + 1);
}

function preflightSimpleJournalRow_(sheet, row, width) {
  ensureSheetRowExists_(sheet, row);
  var range = sheet.getRange(row, 1, 1, width);
  if (range.getDisplayValues()[0].some(nonEmptyGatewayValue_) || range.getFormulas()[0].some(nonEmptyGatewayValue_)) {
    throw gatewayApplyError_("journal_row_conflict", "Цільовий рядок журналу вже зайнятий.");
  }
}

/* -------------------------------------------------------------------------- */
/* Classes and rollover                                                       */
/* -------------------------------------------------------------------------- */

// Class-year functions are below the shared helpers so the entire operation
// module can be loaded as a single Apps Script source file.

function prepareClassYearCreatePlan_(spreadsheet, payload) {
  validateExactKeys_(payload, [
    "academicYearId", "cohortMode", "cohortId", "grade", "code", "teacherUserId",
    "teacherName", "locationId", "locationName", "notes",
  ]);
  var academicYear = findAcademicYearById_(spreadsheet, payload.academicYearId);
  if (["Чернетка", "Активний"].indexOf(academicYear.status) === -1) {
    throw gatewayApplyError_("academic_year_closed", "До завершеного навчального року не можна додавати клас.");
  }
  var grade = gatewayInteger_(payload.grade, 1, 11, "Некоректна паралель класу.");
  var code = gatewayClassCode_(payload.code);
  var teacher = resolveGatewayTeacherPair_(spreadsheet, payload.teacherUserId, payload.teacherName, true);
  var location = resolveGatewayOptionalLocationPair_(spreadsheet, payload.locationId, payload.locationName, true);
  var groupSheet = gatewayRequiredSheet_(spreadsheet, "Класні групи");
  var classSheet = gatewayRequiredSheet_(spreadsheet, "Класи за роками");
  var reservations = collectApplyJournalReservations_(spreadsheet);
  assertClassYearSchema_(classSheet);
  var cohortMode = String(payload.cohortMode || "");
  var cohort;
  var newCohort = null;
  if (cohortMode === "existing") {
    cohort = findCohortById_(groupSheet, payload.cohortId);
    if (cohort.status !== "Активна") {
      throw gatewayApplyError_("cohort_closed", "Завершену класну групу не можна використати.");
    }
  } else if (cohortMode === "new") {
    var cohortId = nextCohortId_(groupSheet, reservations.cohort_ids);
    var cohortRow = firstWritableClassGroupRow_(groupSheet);
    cohort = { id: cohortId, row: cohortRow, status: "Активна" };
    newCohort = {
      row: cohortRow,
      values: {
        "1": cohortId,
        "2": grade + "-" + code,
        "3": code,
        "4": "Активна",
        "5": gatewayOptionalText_(payload.notes, 2000),
      },
    };
    preflightReconciledCells_(groupSheet, cohortRow, newCohort.values, "cohort_row_conflict", false);
  } else {
    throw gatewayApplyError_("invalid_cohort_mode", "Некоректний режим класної групи.");
  }

  assertUniqueClassTarget_(classSheet, academicYear.id, cohort.id, grade, code, 0);
  var classRow = firstWritableClassYearRow_(classSheet, []);
  var classYearId = nextClassYearId_(classSheet, academicYear.id, 0, reservations.class_year_ids);
  var classValues = classYearWritableValues_(
    classYearId,
    academicYear.id,
    cohort.id,
    grade,
    code,
    teacher,
    location,
    "Активний",
    "",
    gatewayOptionalText_(payload.notes, 2000),
  );
  preflightReconciledCells_(classSheet, classRow, classValues, "class_row_conflict", false);
  assertClassFormulaColumns_(classSheet, classRow);
  return {
    kind: "class-year.create",
    academic_year_id: academicYear.id,
    cohort_id: cohort.id,
    class_year_id: classYearId,
    grade: grade,
    code: code,
    cohort_create: newCohort,
    class_row: classRow,
    class_values: classValues,
    teacher_id: teacher ? teacher.id : "",
    location_id: location ? location.id : "",
    completed_steps: [],
  };
}

function executeClassYearCreate_(spreadsheet, journal) {
  var plan = journal.plan;
  var mutations = [];
  var groupSheet = gatewayRequiredSheet_(spreadsheet, "Класні групи");
  var classSheet = gatewayRequiredSheet_(spreadsheet, "Класи за роками");
  if (plan.cohort_create) {
    ensureClassCohortCreateTarget_(groupSheet, plan, journal);
  }
  ensureClassYearCreateTarget_(classSheet, plan, journal);
  // Preflight the complete compound mutation before creating a cohort.  This
  // avoids an orphan group if another request claimed the semantic class name
  // or a class formula was damaged after this request was prepared.
  preflightClassYearCreateExecution_(spreadsheet, groupSheet, classSheet, plan);
  if (plan.cohort_create) {
    if (!hasApplyJournalCheckpoint_(journal, "cohort")) {
      markApplyJournalWriteIntent_(journal, "cohort");
      writeReconciledCells_(groupSheet, plan.cohort_create.row, plan.cohort_create.values, "cohort_row_conflict");
      SpreadsheetApp.flush();
      verifyReconciledCells_(groupSheet, plan.cohort_create.row, plan.cohort_create.values);
      checkpointApplyJournal_(journal, "cohort");
    } else {
      verifyReconciledCells_(groupSheet, plan.cohort_create.row, plan.cohort_create.values);
    }
    mutations.push({ sheet: "Класні групи", row: plan.cohort_create.row, action: "create", entity_id: plan.cohort_id });
  }
  if (!hasApplyJournalCheckpoint_(journal, "class_year")) {
    preflightClassYearCreateExecution_(spreadsheet, groupSheet, classSheet, plan);
    markApplyJournalWriteIntent_(journal, "class_year");
    writeReconciledCells_(classSheet, plan.class_row, plan.class_values, "class_row_conflict");
    SpreadsheetApp.flush();
    verifyReconciledCells_(classSheet, plan.class_row, plan.class_values);
    verifyClassFormulaReferences_(spreadsheet, classSheet, plan.class_row, plan.teacher_id, plan.location_id);
    checkpointApplyJournal_(journal, "class_year");
  } else {
    verifyReconciledCells_(classSheet, plan.class_row, plan.class_values);
    verifyClassFormulaReferences_(spreadsheet, classSheet, plan.class_row, plan.teacher_id, plan.location_id);
  }
  mutations.push({ sheet: "Класи за роками", row: plan.class_row, action: "create", entity_id: plan.class_year_id });
  return genericApplyResult_(
    "applied",
    mutations,
    { academicYearId: plan.academic_year_id, cohortId: plan.cohort_id, classYearId: plan.class_year_id },
    "Клас додано до навчального року.",
    noCoverInstruction_(),
  );
}

function preflightClassYearCreateExecution_(spreadsheet, groupSheet, classSheet, plan) {
  var currentYear = findAcademicYearById_(spreadsheet, plan.academic_year_id);
  if (["Чернетка", "Активний"].indexOf(currentYear.status) === -1) {
    throw gatewayApplyError_("academic_year_closed", "До завершеного навчального року не можна додавати клас.");
  }
  if (plan.cohort_create) {
    preflightReconciledCells_(
      groupSheet,
      plan.cohort_create.row,
      plan.cohort_create.values,
      "cohort_row_conflict",
      false,
    );
  } else {
    var currentCohort = findCohortById_(groupSheet, plan.cohort_id);
    if (currentCohort.status !== "Активна") {
      throw gatewayApplyError_("cohort_closed", "Завершену класну групу не можна використати.");
    }
  }
  assertUniqueClassTarget_(
    classSheet,
    plan.academic_year_id,
    plan.cohort_id,
    plan.grade,
    plan.code,
    plan.class_row,
  );
  preflightReconciledCells_(classSheet, plan.class_row, plan.class_values, "class_row_conflict", false);
  assertClassFormulaColumns_(classSheet, plan.class_row);
}

function ensureClassYearCreateTarget_(classSheet, plan, journal) {
  var identityRows = classYearIdentityRows_(classSheet, plan.class_year_id);
  if (identityRows.length > 1) {
    throw gatewayApplyError_("duplicate_class_year", "ID нового класу вже повторюється у таблиці.");
  }
  if (identityRows.length === 1) {
    var identityState = reconciledRowState_(classSheet, identityRows[0], plan.class_values);
    if (!identityState.compatible) {
      throw gatewayApplyError_("class_identity_conflict", "ID нового класу вже належить іншому запису.");
    }
    if (plan.class_row !== identityRows[0]) {
      plan.class_row = identityRows[0];
      updateApplyJournalEntry_(journal, "applying", journal.plan, null, "");
    }
    return;
  }
  var state = reconciledRowState_(classSheet, plan.class_row, plan.class_values);
  if (state.compatible) return;
  if (hasApplyJournalCheckpoint_(journal, "write_started:class_year") ||
      hasApplyJournalCheckpoint_(journal, "class_year")) {
    throw gatewayApplyError_("class_identity_missing", "Не знайдено рядок частково записаного класу.");
  }
  plan.class_row = firstWritableClassYearRow_(classSheet, []);
  updateApplyJournalEntry_(journal, "applying", journal.plan, null, "");
}

function ensureClassCohortCreateTarget_(groupSheet, plan, journal) {
  var rows = cohortIdentityRows_(groupSheet, plan.cohort_id);
  if (rows.length > 1) {
    throw gatewayApplyError_("duplicate_cohort", "ID нової класної групи повторюється.");
  }
  if (rows.length === 1) {
    var state = reconciledRowState_(groupSheet, rows[0], plan.cohort_create.values);
    if (!state.compatible) {
      throw gatewayApplyError_("cohort_identity_conflict", "ID нової класної групи вже належить іншому запису.");
    }
    if (plan.cohort_create.row !== rows[0]) {
      plan.cohort_create.row = rows[0];
      updateApplyJournalEntry_(journal, "applying", journal.plan, null, "");
    }
    return;
  }
  var state = reconciledRowState_(groupSheet, plan.cohort_create.row, plan.cohort_create.values);
  if (state.compatible) return;
  if (hasApplyJournalCheckpoint_(journal, "write_started:cohort") ||
      hasApplyJournalCheckpoint_(journal, "cohort")) {
    throw gatewayApplyError_("cohort_identity_missing", "Не знайдено рядок частково записаної класної групи.");
  }
  plan.cohort_create.row = firstWritableClassGroupRow_(groupSheet);
  updateApplyJournalEntry_(journal, "applying", journal.plan, null, "");
}

function prepareClassYearUpdatePlan_(spreadsheet, payload) {
  validateExactKeys_(payload, ["classYearId", "academicYearId", "expectedVersion", "changes", "reason"]);
  var sheet = gatewayRequiredSheet_(spreadsheet, "Класи за роками");
  assertClassYearSchema_(sheet);
  var existing = findClassYearById_(sheet, payload.classYearId);
  var expectedVersion = gatewayClassYearVersion_(payload.expectedVersion);
  assertClassYearVersion_(sheet, existing.row, expectedVersion);
  var academicYearId = gatewayAcademicYearId_(payload.academicYearId);
  if (existing.academicYearId !== academicYearId) {
    throw gatewayApplyError_("academic_year_conflict", "Клас належить іншому навчальному року.");
  }
  if (existing.status !== "Активний") {
    throw gatewayApplyError_("class_year_closed", "Завершений або закритий клас не можна редагувати.");
  }
  var changes = payload.changes;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw gatewayApplyError_("invalid_payload", "Зміни класу відсутні.");
  }
  validateExactKeys_(changes, [
    "grade", "code", "teacherUserId", "teacherName", "locationId", "locationName", "notes",
  ]);
  var grade = Object.prototype.hasOwnProperty.call(changes, "grade")
    ? gatewayInteger_(changes.grade, 1, 11, "Некоректна паралель класу.")
    : existing.grade;
  var code = Object.prototype.hasOwnProperty.call(changes, "code")
    ? gatewayClassCode_(changes.code)
    : existing.code;
  assertUniqueClassTarget_(sheet, existing.academicYearId, existing.cohortId, grade, code, existing.row);
  var values = {};
  if (grade !== existing.grade) values["6"] = grade;
  if (code !== existing.code) values["7"] = code;
  var teacherId = existing.teacherId;
  if (Object.prototype.hasOwnProperty.call(changes, "teacherUserId") ||
      Object.prototype.hasOwnProperty.call(changes, "teacherName")) {
    if (changes.teacherUserId === null && changes.teacherName === null) {
      values["8"] = "";
      teacherId = "";
    } else {
      var teacher = resolveGatewayTeacherPair_(spreadsheet, changes.teacherUserId, changes.teacherName, false);
      values["8"] = teacher.name;
      teacherId = teacher.id;
    }
  }
  var locationId = existing.locationId;
  if (Object.prototype.hasOwnProperty.call(changes, "locationId") ||
      Object.prototype.hasOwnProperty.call(changes, "locationName")) {
    if (changes.locationId === null && changes.locationName === null) {
      values["10"] = "";
      locationId = "";
    } else {
      var location = resolveGatewayOptionalLocationPair_(spreadsheet, changes.locationId, changes.locationName, false);
      values["10"] = location.name;
      locationId = location.id;
    }
  }
  if (Object.prototype.hasOwnProperty.call(changes, "notes")) {
    values["16"] = changes.notes === null ? "" : gatewayOptionalText_(changes.notes, 2000);
  }
  if (!Object.keys(values).length) throw gatewayApplyError_("empty_changes", "Не вказано жодної зміни класу.");
  // Keep the immutable class-year ID inside the reconciled transition.  This
  // makes a row move/sort detectable between identity resolution and write.
  values["1"] = existing.id;
  assertWritableColumnsWithoutFormulas_(sheet, existing.row, values);
  var before = captureCellValues_(sheet, existing.row, values);
  return {
    kind: "class-year.update",
    class_year_id: existing.id,
    academic_year_id: existing.academicYearId,
    cohort_id: existing.cohortId,
    target_grade: grade,
    target_code: code,
    class_row: existing.row,
    expected_version: expectedVersion,
    before: before,
    after: values,
    teacher_id: teacherId,
    location_id: locationId,
    completed_steps: [],
  };
}

function executeClassYearUpdate_(spreadsheet, journal) {
  var plan = journal.plan;
  var sheet = gatewayRequiredSheet_(spreadsheet, "Класи за роками");
  ensureClassYearSourceTarget_(sheet, plan, "class_year_id", "class_row", journal);
  if (!hasApplyJournalCheckpoint_(journal, "class_year_update")) {
    if (!hasApplyJournalCheckpoint_(journal, "write_started:class_year_update")) {
      assertClassYearVersion_(sheet, plan.class_row, plan.expected_version);
    }
    assertUniqueClassTarget_(
      sheet,
      plan.academic_year_id,
      plan.cohort_id,
      plan.target_grade,
      plan.target_code,
      plan.class_row,
    );
    preflightTransitionCells_(sheet, plan.class_row, plan.before, plan.after, "class_update_conflict");
    assertClassFormulaColumns_(sheet, plan.class_row);
    markApplyJournalWriteIntent_(journal, "class_year_update");
    writeTransitionCells_(sheet, plan.class_row, plan.before, plan.after, "class_update_conflict");
    SpreadsheetApp.flush();
    verifyReconciledCells_(sheet, plan.class_row, plan.after);
    checkpointApplyJournal_(journal, "class_year_update");
  } else {
    verifyReconciledCells_(sheet, plan.class_row, plan.after);
  }
  verifyClassFormulaReferences_(spreadsheet, sheet, plan.class_row, plan.teacher_id, plan.location_id);
  return genericApplyResult_(
    "applied",
    [{ sheet: "Класи за роками", row: plan.class_row, action: "update", entity_id: plan.class_year_id }],
    { classYearId: plan.class_year_id },
    "Дані класу оновлено.",
    noCoverInstruction_(),
  );
}

function prepareClassYearClosePlan_(spreadsheet, payload) {
  validateExactKeys_(payload, ["classYearId", "expectedVersion", "actualClosedDate", "reason", "closeCohort", "notes"]);
  var sheet = gatewayRequiredSheet_(spreadsheet, "Класи за роками");
  var existing = findClassYearById_(sheet, payload.classYearId);
  var expectedVersion = gatewayClassYearVersion_(payload.expectedVersion);
  assertClassYearVersion_(sheet, existing.row, expectedVersion);
  if (existing.status === "Закритий") {
    throw gatewayApplyError_("class_year_closed", "Клас уже закрито.");
  }
  if (existing.status !== "Активний") {
    throw gatewayApplyError_("class_year_completed", "Завершений клас не можна закрити повторно.");
  }
  var closedDate = requiredIsoDate_(payload.actualClosedDate, "Некоректна дата закриття класу.");
  var classAfter = {
    "1": existing.id,
    "14": "Закритий",
    "15": closedDate,
    "16": appendGatewayNotes_(existing.notes, structuredClassNotes_(payload.reason, payload.notes)),
  };
  var classBefore = captureCellValues_(sheet, existing.row, classAfter);
  var cohortTransition = null;
  if (payload.closeCohort === true) {
    var otherOpen = gatewayReadRows_(sheet, 16, 5000).filter(function (item) {
      return item.row !== existing.row && String(item.values[3] || "").trim() === existing.cohortId &&
        String(item.values[13] || "").trim() === "Активний";
    });
    if (otherOpen.length) {
      throw gatewayApplyError_("cohort_still_open", "Класна група має інший активний запис за роками.");
    }
    var groupSheet = gatewayRequiredSheet_(spreadsheet, "Класні групи");
    var cohort = findCohortById_(groupSheet, existing.cohortId);
    cohortTransition = {
      row: cohort.row,
      before: captureCellValues_(groupSheet, cohort.row, { "1": existing.cohortId, "4": "Завершена" }),
      after: { "1": existing.cohortId, "4": "Завершена" },
    };
  }
  return {
    kind: "class-year.close",
    class_year_id: existing.id,
    cohort_id: existing.cohortId,
    class_row: existing.row,
    expected_version: expectedVersion,
    class_before: classBefore,
    class_after: classAfter,
    cohort_transition: cohortTransition,
    completed_steps: [],
  };
}

function executeClassYearClose_(spreadsheet, journal) {
  var plan = journal.plan;
  var classSheet = gatewayRequiredSheet_(spreadsheet, "Класи за роками");
  ensureClassYearSourceTarget_(classSheet, plan, "class_year_id", "class_row", journal);
  var mutations = [];
  if (!hasApplyJournalCheckpoint_(journal, "class_close")) {
    if (!hasApplyJournalCheckpoint_(journal, "write_started:class_close")) {
      assertClassYearVersion_(classSheet, plan.class_row, plan.expected_version);
    }
    preflightTransitionCells_(classSheet, plan.class_row, plan.class_before, plan.class_after, "class_close_conflict");
    assertClassFormulaColumns_(classSheet, plan.class_row);
    markApplyJournalWriteIntent_(journal, "class_close");
    writeTransitionCells_(classSheet, plan.class_row, plan.class_before, plan.class_after, "class_close_conflict");
    SpreadsheetApp.flush();
    verifyReconciledCells_(classSheet, plan.class_row, plan.class_after);
    checkpointApplyJournal_(journal, "class_close");
  } else {
    verifyReconciledCells_(classSheet, plan.class_row, plan.class_after);
  }
  mutations.push({ sheet: "Класи за роками", row: plan.class_row, action: "close", entity_id: plan.class_year_id });
  if (plan.cohort_transition) {
    var groupSheet = gatewayRequiredSheet_(spreadsheet, "Класні групи");
    ensureCohortTransitionTarget_(groupSheet, plan.cohort_id, plan.cohort_transition, journal);
    if (!hasApplyJournalCheckpoint_(journal, "cohort_close")) {
      assertNoOtherActiveClassForCohort_(classSheet, plan.cohort_id, plan.class_year_id);
      preflightTransitionCells_(
        groupSheet,
        plan.cohort_transition.row,
        plan.cohort_transition.before,
        plan.cohort_transition.after,
        "cohort_close_conflict",
      );
      markApplyJournalWriteIntent_(journal, "cohort_close");
      writeTransitionCells_(
        groupSheet,
        plan.cohort_transition.row,
        plan.cohort_transition.before,
        plan.cohort_transition.after,
        "cohort_close_conflict",
      );
      SpreadsheetApp.flush();
      verifyReconciledCells_(groupSheet, plan.cohort_transition.row, plan.cohort_transition.after);
      checkpointApplyJournal_(journal, "cohort_close");
    }
    verifyReconciledCells_(groupSheet, plan.cohort_transition.row, plan.cohort_transition.after);
    mutations.push({ sheet: "Класні групи", row: plan.cohort_transition.row, action: "close", entity_id: plan.cohort_id });
  }
  return genericApplyResult_(
    "applied",
    mutations,
    { classYearId: plan.class_year_id, cohortId: plan.cohort_id },
    "Клас закрито.",
    noCoverInstruction_(),
  );
}

function prepareAcademicYearRolloverPlan_(spreadsheet, payload) {
  validateExactKeys_(payload, ["sourceYearId", "targetYearId", "effectiveDate", "classes", "notes"]);
  var sourceYear = findAcademicYearById_(spreadsheet, payload.sourceYearId);
  var targetYear = findAcademicYearById_(spreadsheet, payload.targetYearId);
  var sourceFirst = Number(sourceYear.id.slice(3, 7));
  var targetFirst = Number(targetYear.id.slice(3, 7));
  if (targetFirst !== sourceFirst + 1) {
    throw gatewayApplyError_("invalid_rollover_year", "Цільовий навчальний рік має бути наступним.");
  }
  if (sourceYear.status !== "Активний" || targetYear.status !== "Чернетка") {
    throw gatewayApplyError_("invalid_rollover_status", "Перехід потребує активного вихідного й чернеткового цільового року.");
  }
  var effectiveDate = requiredIsoDate_(payload.effectiveDate, "Некоректна дата переходу.");
  if (!Array.isArray(payload.classes) || !payload.classes.length || payload.classes.length > 100) {
    throw gatewayApplyError_("invalid_rollover_classes", "Додайте від 1 до 100 класів.");
  }
  var classSheet = gatewayRequiredSheet_(spreadsheet, "Класи за роками");
  var groupSheet = gatewayRequiredSheet_(spreadsheet, "Класні групи");
  var reservations = collectApplyJournalReservations_(spreadsheet);
  var allRows = gatewayReadRows_(classSheet, 16, 5000);
  var openSource = allRows.filter(function (item) {
    return String(item.values[1] || "").trim() === sourceYear.id &&
      String(item.values[13] || "").trim() === "Активний";
  }).map(classYearFromRow_);
  var inputById = {};
  var inputCohorts = {};
  payload.classes.forEach(function (item) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw gatewayApplyError_("invalid_rollover_class", "Некоректний запис класу для переходу.");
    }
    validateExactKeys_(item, [
      "sourceClassYearId", "cohortId", "sourceGrade", "expectedVersion", "action", "targetGrade", "targetCode",
      "teacherUserId", "teacherName", "locationId", "locationName", "overrideReason", "notes",
    ]);
    var sourceId = gatewayClassYearId_(item.sourceClassYearId);
    if (inputById[sourceId]) throw gatewayApplyError_("duplicate_rollover_class", "Клас повторюється у переході.");
    var inputCohortId = String(item.cohortId || "").trim().toUpperCase();
    if (inputCohorts[inputCohortId]) {
      throw gatewayApplyError_("duplicate_rollover_cohort", "Класна група повторюється у переході.");
    }
    inputCohorts[inputCohortId] = true;
    inputById[sourceId] = item;
  });
  if (openSource.length !== Object.keys(inputById).length || openSource.some(function (item) { return !inputById[item.id]; })) {
    throw gatewayApplyError_("incomplete_rollover", "План переходу має містити кожен активний клас вихідного року рівно один раз.");
  }

  var usedRows = [];
  var sequence = nextClassYearSequence_(classSheet, targetYear.id, reservations.class_year_ids);
  var targetNames = {};
  var targetCohorts = {};
  allRows.forEach(function (item) {
    if (String(item.values[1] || "").trim() === targetYear.id) {
      targetNames[normalizedClassName_(item.values[5], item.values[6])] = true;
      targetCohorts[String(item.values[3] || "").trim()] = true;
    }
  });
  var items = [];
  openSource.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
  openSource.forEach(function (source) {
    var raw = inputById[source.id];
    if (String(raw.cohortId || "").trim() !== source.cohortId || Number(raw.sourceGrade) !== source.grade) {
      throw gatewayApplyError_("stale_rollover_class", "Дані вихідного класу змінилися.");
    }
    var action = String(raw.action || "");
    if (["promote", "graduate", "close"].indexOf(action) === -1) {
      throw gatewayApplyError_("invalid_rollover_action", "Некоректна дія переходу класу.");
    }
    if (action === "graduate" && source.grade !== 11) {
      throw gatewayApplyError_("invalid_graduation", "Випуск застосовується лише до 11 класу.");
    }
    var expectedVersion = gatewayClassYearVersion_(raw.expectedVersion);
    assertClassYearVersion_(classSheet, source.row, expectedVersion);
    var itemPlan = {
      source_id: source.id,
      source_row: source.row,
      cohort_id: source.cohortId,
      action: action,
      expected_version: expectedVersion,
      source_before: captureCellValues_(classSheet, source.row, { "1": source.id, "14": "", "15": "", "16": "" }),
      source_after: {
        "1": source.id,
        "14": action === "close" ? "Закритий" : "Завершений",
        "15": action === "close" ? effectiveDate : "",
        "16": appendGatewayNotes_(source.notes, structuredClassNotes_(action, raw.notes || payload.notes)),
      },
    };
    if (action === "promote") {
      if (source.grade === 11) {
        throw gatewayApplyError_("invalid_promotion", "11 клас не можна переводити до 12 класу.");
      }
      var targetGrade = gatewayInteger_(raw.targetGrade, 1, 11, "Некоректна цільова паралель.");
      var targetCode = gatewayClassCode_(raw.targetCode);
      if (targetGrade !== source.grade + 1 && !gatewayOptionalText_(raw.overrideReason, 1000)) {
        throw gatewayApplyError_("rollover_override_required", "Поясніть перехід не до наступної паралелі.");
      }
      var targetName = normalizedClassName_(targetGrade, targetCode);
      if (targetNames[targetName]) throw gatewayApplyError_("duplicate_target_class", "Цільова назва класу повторюється.");
      if (targetCohorts[source.cohortId]) throw gatewayApplyError_("duplicate_target_cohort", "Класна група вже має запис у цільовому році.");
      targetNames[targetName] = true;
      targetCohorts[source.cohortId] = true;
      var teacher = raw.teacherUserId || raw.teacherName
        ? resolveGatewayTeacherPair_(spreadsheet, raw.teacherUserId, raw.teacherName, false)
        : (source.teacherId ? { id: source.teacherId, name: source.teacherName } : null);
      var location = raw.locationId || raw.locationName
        ? resolveGatewayOptionalLocationPair_(spreadsheet, raw.locationId, raw.locationName, false)
        : (source.locationId ? { id: source.locationId, name: source.locationName } : null);
      var targetRow = firstWritableClassYearRow_(classSheet, usedRows);
      usedRows.push(targetRow);
      var targetId = "CY-" + targetFirst + "-" + String(sequence).padStart(3, "0");
      sequence += 1;
      reservations.class_year_ids[targetId] = true;
      itemPlan.target_id = targetId;
      itemPlan.target_row = targetRow;
      itemPlan.target_teacher_id = teacher ? teacher.id : "";
      itemPlan.target_location_id = location ? location.id : "";
      itemPlan.target_values = classYearWritableValues_(
        targetId,
        targetYear.id,
        source.cohortId,
        targetGrade,
        targetCode,
        teacher,
        location,
        "Активний",
        "",
        gatewayOptionalText_(raw.notes || payload.notes, 2000),
      );
      preflightReconciledCells_(classSheet, targetRow, itemPlan.target_values, "rollover_target_conflict", false);
      assertClassFormulaColumns_(classSheet, targetRow);
    }
    if (action === "graduate" || action === "close") {
      var otherOpenForCohort = allRows.filter(function (item) {
        return item.row !== source.row &&
          String(item.values[3] || "").trim() === source.cohortId &&
          String(item.values[13] || "").trim() === "Активний";
      });
      if (otherOpenForCohort.length) {
        throw gatewayApplyError_(
          "cohort_still_open",
          "Класну групу не можна завершити, доки вона має інший активний запис за роками.",
        );
      }
      var cohort = findCohortById_(groupSheet, source.cohortId);
      itemPlan.cohort_row = cohort.row;
      itemPlan.cohort_before = captureCellValues_(groupSheet, cohort.row, { "1": source.cohortId, "4": "Завершена" });
      itemPlan.cohort_after = { "1": source.cohortId, "4": "Завершена" };
    }
    items.push(itemPlan);
  });

  var sourceYearAfter = { "1": sourceYear.id, "5": "Завершений" };
  var targetYearAfter = { "1": targetYear.id, "5": "Активний" };
  return {
    kind: "academic-year.rollover",
    source_year_id: sourceYear.id,
    target_year_id: targetYear.id,
    source_year_row: sourceYear.row,
    target_year_row: targetYear.row,
    source_year_before: captureCellValues_(sourceYear.sheet, sourceYear.row, sourceYearAfter),
    source_year_after: sourceYearAfter,
    target_year_before: captureCellValues_(targetYear.sheet, targetYear.row, targetYearAfter),
    target_year_after: targetYearAfter,
    items: items,
    completed_steps: [],
  };
}

function executeAcademicYearRollover_(spreadsheet, journal) {
  var plan = journal.plan;
  var classSheet = gatewayRequiredSheet_(spreadsheet, "Класи за роками");
  var groupSheet = gatewayRequiredSheet_(spreadsheet, "Класні групи");
  var mutations = [];
  preflightAcademicYearRolloverExecution_(spreadsheet, classSheet, groupSheet, plan, journal);
  (plan.items || []).forEach(function (item) {
    ensureRolloverSourceTarget_(classSheet, item, journal);
    if (item.target_values) ensureRolloverTarget_(classSheet, plan, item, journal);
    if (item.cohort_after) ensureRolloverCohortTarget_(groupSheet, item, journal);
    var checkpoint = "rollover:" + item.source_id;
    if (!hasApplyJournalCheckpoint_(journal, checkpoint)) {
      var targetCheckpoint = checkpoint + ":target_written";
      var sourceCheckpoint = checkpoint + ":source_written";
      var cohortCheckpoint = checkpoint + ":cohort_written";
      if (!hasApplyJournalCheckpoint_(journal, sourceCheckpoint)) {
        if (!hasApplyJournalCheckpoint_(journal, "write_started:" + sourceCheckpoint)) {
          assertClassYearVersion_(classSheet, item.source_row, item.expected_version);
        }
      }
      if (item.target_values) {
        if (!hasApplyJournalCheckpoint_(journal, targetCheckpoint)) {
          var liveTargetYear = findAcademicYearById_(spreadsheet, plan.target_year_id);
          if (liveTargetYear.status !== "Чернетка") {
            throw gatewayApplyError_("invalid_rollover_status", "Цільовий навчальний рік більше не є чернеткою.");
          }
          var liveTargetCohort = findCohortById_(groupSheet, item.cohort_id);
          if (liveTargetCohort.status !== "Активна") {
            throw gatewayApplyError_("cohort_closed", "Завершену класну групу не можна переводити.");
          }
          assertUniqueClassTarget_(
            classSheet,
            plan.target_year_id,
            item.cohort_id,
            item.target_values["6"],
            item.target_values["7"],
            item.target_row,
          );
          preflightReconciledCells_(classSheet, item.target_row, item.target_values, "rollover_target_conflict", false);
          assertClassFormulaColumns_(classSheet, item.target_row);
          markApplyJournalWriteIntent_(journal, targetCheckpoint);
          writeReconciledCells_(classSheet, item.target_row, item.target_values, "rollover_target_conflict");
          SpreadsheetApp.flush();
          checkpointApplyJournal_(journal, targetCheckpoint);
        }
        verifyReconciledCells_(classSheet, item.target_row, item.target_values);
        verifyClassFormulaReferences_(spreadsheet, classSheet, item.target_row, item.target_teacher_id, item.target_location_id);
      }
      if (!hasApplyJournalCheckpoint_(journal, sourceCheckpoint)) {
        if (!hasApplyJournalCheckpoint_(journal, "write_started:" + sourceCheckpoint)) {
          assertClassYearVersion_(classSheet, item.source_row, item.expected_version);
        }
        preflightTransitionCells_(classSheet, item.source_row, item.source_before, item.source_after, "rollover_source_conflict");
        assertClassFormulaColumns_(classSheet, item.source_row);
        markApplyJournalWriteIntent_(journal, sourceCheckpoint);
        writeTransitionCells_(classSheet, item.source_row, item.source_before, item.source_after, "rollover_source_conflict");
        SpreadsheetApp.flush();
        checkpointApplyJournal_(journal, sourceCheckpoint);
      }
      verifyReconciledCells_(classSheet, item.source_row, item.source_after);
      if (item.cohort_after) {
        if (!hasApplyJournalCheckpoint_(journal, cohortCheckpoint)) {
          assertNoOtherActiveClassForCohort_(classSheet, item.cohort_id, item.source_id);
          preflightTransitionCells_(groupSheet, item.cohort_row, item.cohort_before, item.cohort_after, "rollover_cohort_conflict");
          markApplyJournalWriteIntent_(journal, cohortCheckpoint);
          writeTransitionCells_(groupSheet, item.cohort_row, item.cohort_before, item.cohort_after, "rollover_cohort_conflict");
          SpreadsheetApp.flush();
          checkpointApplyJournal_(journal, cohortCheckpoint);
        }
        verifyReconciledCells_(groupSheet, item.cohort_row, item.cohort_after);
      }
      checkpointApplyJournal_(journal, checkpoint);
    } else {
      if (item.target_values) verifyReconciledCells_(classSheet, item.target_row, item.target_values);
      verifyReconciledCells_(classSheet, item.source_row, item.source_after);
      if (item.cohort_after) verifyReconciledCells_(groupSheet, item.cohort_row, item.cohort_after);
    }
    mutations.push({ sheet: "Класи за роками", row: item.source_row, action: item.action, entity_id: item.source_id });
    if (item.target_values) {
      mutations.push({ sheet: "Класи за роками", row: item.target_row, action: "create", entity_id: item.target_id });
    }
    if (item.cohort_after) {
      mutations.push({ sheet: "Класні групи", row: item.cohort_row, action: "close", entity_id: item.cohort_id });
    }
  });
  var yearSheet = gatewayRequiredSheet_(spreadsheet, "Навчальні роки");
  ensureRolloverYearTargets_(spreadsheet, plan, journal);
  if (!hasApplyJournalCheckpoint_(journal, "rollover_years")) {
    assertNoActiveClassesForYear_(classSheet, plan.source_year_id);
    preflightTransitionCells_(yearSheet, plan.source_year_row, plan.source_year_before, plan.source_year_after, "rollover_year_conflict");
    preflightTransitionCells_(yearSheet, plan.target_year_row, plan.target_year_before, plan.target_year_after, "rollover_year_conflict");
    markApplyJournalWriteIntent_(journal, "rollover_years");
    writeTransitionCells_(yearSheet, plan.source_year_row, plan.source_year_before, plan.source_year_after, "rollover_year_conflict");
    writeTransitionCells_(yearSheet, plan.target_year_row, plan.target_year_before, plan.target_year_after, "rollover_year_conflict");
    SpreadsheetApp.flush();
    verifyReconciledCells_(yearSheet, plan.source_year_row, plan.source_year_after);
    verifyReconciledCells_(yearSheet, plan.target_year_row, plan.target_year_after);
    checkpointApplyJournal_(journal, "rollover_years");
  }
  verifyReconciledCells_(yearSheet, plan.source_year_row, plan.source_year_after);
  verifyReconciledCells_(yearSheet, plan.target_year_row, plan.target_year_after);
  mutations.push({ sheet: "Навчальні роки", row: plan.source_year_row, action: "complete", entity_id: plan.source_year_id });
  mutations.push({ sheet: "Навчальні роки", row: plan.target_year_row, action: "activate", entity_id: plan.target_year_id });
  var targetIds = (plan.items || []).filter(function (item) { return Boolean(item.target_id); })
    .map(function (item) { return item.target_id; });
  return genericApplyResult_(
    "applied",
    mutations,
    { sourceAcademicYearId: plan.source_year_id, targetAcademicYearId: plan.target_year_id, classYearIds: targetIds },
    "Перехід між навчальними роками завершено.",
    noCoverInstruction_(),
  );
}

function preflightAcademicYearRolloverExecution_(spreadsheet, classSheet, groupSheet, plan, journal) {
  ensureRolloverYearTargets_(spreadsheet, plan, journal);
  var yearSheet = gatewayRequiredSheet_(spreadsheet, "Навчальні роки");
  preflightTransitionCells_(
    yearSheet,
    plan.source_year_row,
    plan.source_year_before,
    plan.source_year_after,
    "rollover_year_conflict",
  );
  preflightTransitionCells_(
    yearSheet,
    plan.target_year_row,
    plan.target_year_before,
    plan.target_year_after,
    "rollover_year_conflict",
  );
  var targetYear = findAcademicYearById_(spreadsheet, plan.target_year_id);
  var targetYearReady = targetYear.status === "Чернетка" ||
    ((hasApplyJournalCheckpoint_(journal, "write_started:rollover_years") ||
      hasApplyJournalCheckpoint_(journal, "rollover_years")) && targetYear.status === "Активний");
  if (!targetYearReady) {
    throw gatewayApplyError_("invalid_rollover_status", "Цільовий навчальний рік має неочікуваний статус.");
  }
  (plan.items || []).forEach(function (item) {
    ensureRolloverSourceTarget_(classSheet, item, journal);
    if (item.target_values) ensureRolloverTarget_(classSheet, plan, item, journal);
    if (item.cohort_after) ensureRolloverCohortTarget_(groupSheet, item, journal);
    var checkpoint = "rollover:" + item.source_id;
    var sourceCheckpoint = checkpoint + ":source_written";
    if (item.target_values) {
      var cohort = findCohortById_(groupSheet, item.cohort_id);
      if (cohort.status !== "Активна") {
        throw gatewayApplyError_("cohort_closed", "Завершену класну групу не можна переводити.");
      }
      assertUniqueClassTarget_(
        classSheet,
        plan.target_year_id,
        item.cohort_id,
        item.target_values["6"],
        item.target_values["7"],
        item.target_row,
      );
      preflightReconciledCells_(classSheet, item.target_row, item.target_values, "rollover_target_conflict", false);
      assertClassFormulaColumns_(classSheet, item.target_row);
    }
    if (!hasApplyJournalCheckpoint_(journal, sourceCheckpoint) &&
        !hasApplyJournalCheckpoint_(journal, "write_started:" + sourceCheckpoint)) {
      assertClassYearVersion_(classSheet, item.source_row, item.expected_version);
    }
    preflightTransitionCells_(classSheet, item.source_row, item.source_before, item.source_after, "rollover_source_conflict");
    assertClassFormulaColumns_(classSheet, item.source_row);
    if (item.cohort_after) {
      assertNoOtherActiveClassForCohort_(classSheet, item.cohort_id, item.source_id);
      preflightTransitionCells_(groupSheet, item.cohort_row, item.cohort_before, item.cohort_after, "rollover_cohort_conflict");
    }
    if (hasApplyJournalCheckpoint_(journal, checkpoint)) {
      if (item.target_values) verifyReconciledCells_(classSheet, item.target_row, item.target_values);
      verifyReconciledCells_(classSheet, item.source_row, item.source_after);
      if (item.cohort_after) verifyReconciledCells_(groupSheet, item.cohort_row, item.cohort_after);
    }
  });
}

function ensureRolloverTarget_(classSheet, plan, item, journal) {
  var identityRows = classYearIdentityRows_(classSheet, item.target_id);
  if (identityRows.length > 1) {
    throw gatewayApplyError_("duplicate_class_year", "ID нового класу вже повторюється у таблиці.");
  }
  if (identityRows.length === 1) {
    var identityState = reconciledRowState_(classSheet, identityRows[0], item.target_values);
    if (!identityState.compatible) {
      throw gatewayApplyError_("class_identity_conflict", "ID нового класу вже належить іншому запису.");
    }
    if (item.target_row !== identityRows[0]) {
      item.target_row = identityRows[0];
      updateApplyJournalEntry_(journal, "applying", journal.plan, null, "");
    }
    return;
  }
  var state = reconciledRowState_(classSheet, item.target_row, item.target_values);
  if (state.compatible) return;
  var targetCheckpoint = "rollover:" + item.source_id + ":target_written";
  if (hasApplyJournalCheckpoint_(journal, "write_started:" + targetCheckpoint) ||
      hasApplyJournalCheckpoint_(journal, targetCheckpoint)) {
    throw gatewayApplyError_("class_identity_missing", "Не знайдено рядок частково записаного цільового класу.");
  }
  var reservedRows = (plan.items || []).filter(function (candidate) {
    return candidate !== item && Boolean(candidate.target_values);
  }).map(function (candidate) { return Number(candidate.target_row); });
  item.target_row = firstWritableClassYearRow_(classSheet, reservedRows);
  updateApplyJournalEntry_(journal, "applying", journal.plan, null, "");
}

function classYearIdentityRows_(sheet, classYearId) {
  var lastRow = Math.min(Number(sheet.getLastRow()) || 1, 5000);
  if (lastRow < 2) return [];
  var rows = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
  var matches = [];
  rows.forEach(function (values, index) {
    if (String(values[0] || "").trim() === classYearId) matches.push(index + 2);
  });
  return matches;
}

function ensureClassYearSourceTarget_(sheet, plan, idKey, rowKey, journal) {
  var classYearId = String(plan[idKey] || "").trim();
  var rows = classYearIdentityRows_(sheet, classYearId);
  if (rows.length !== 1) {
    throw gatewayApplyError_(
      rows.length ? "duplicate_class_year" : "class_year_not_found",
      "Запис класу не знайдено однозначно.",
    );
  }
  if (plan[rowKey] !== rows[0]) {
    plan[rowKey] = rows[0];
    updateApplyJournalEntry_(journal, "applying", journal.plan, null, "");
  }
}

function ensureRolloverSourceTarget_(sheet, item, journal) {
  var rows = classYearIdentityRows_(sheet, item.source_id);
  if (rows.length !== 1) {
    throw gatewayApplyError_(
      rows.length ? "duplicate_class_year" : "class_year_not_found",
      "Вихідний клас переходу не знайдено однозначно.",
    );
  }
  item.source_before["1"] = item.source_id;
  item.source_after["1"] = item.source_id;
  if (item.source_row !== rows[0]) {
    item.source_row = rows[0];
    updateApplyJournalEntry_(journal, "applying", journal.plan, null, "");
  }
}

function cohortIdentityRows_(sheet, cohortId) {
  return gatewayReadRows_(sheet, 5, 5000).filter(function (item) {
    return String(item.values[0] || "").trim() === cohortId;
  }).map(function (item) { return item.row; });
}

function ensureCohortTransitionTarget_(sheet, cohortId, transition, journal) {
  var rows = cohortIdentityRows_(sheet, cohortId);
  if (rows.length !== 1) {
    throw gatewayApplyError_(
      rows.length ? "duplicate_cohort" : "cohort_not_found",
      "Класну групу не знайдено однозначно.",
    );
  }
  transition.before["1"] = cohortId;
  transition.after["1"] = cohortId;
  if (transition.row !== rows[0]) {
    transition.row = rows[0];
    updateApplyJournalEntry_(journal, "applying", journal.plan, null, "");
  }
}

function ensureRolloverCohortTarget_(sheet, item, journal) {
  var transition = {
    row: item.cohort_row,
    before: item.cohort_before,
    after: item.cohort_after,
  };
  ensureCohortTransitionTarget_(sheet, item.cohort_id, transition, journal);
  if (item.cohort_row !== transition.row) {
    item.cohort_row = transition.row;
    updateApplyJournalEntry_(journal, "applying", journal.plan, null, "");
  }
  item.cohort_before = transition.before;
  item.cohort_after = transition.after;
}

function ensureRolloverYearTargets_(spreadsheet, plan, journal) {
  var source = findAcademicYearById_(spreadsheet, plan.source_year_id);
  var target = findAcademicYearById_(spreadsheet, plan.target_year_id);
  plan.source_year_before["1"] = plan.source_year_id;
  plan.source_year_after["1"] = plan.source_year_id;
  plan.target_year_before["1"] = plan.target_year_id;
  plan.target_year_after["1"] = plan.target_year_id;
  var changed = false;
  if (plan.source_year_row !== source.row) {
    plan.source_year_row = source.row;
    changed = true;
  }
  if (plan.target_year_row !== target.row) {
    plan.target_year_row = target.row;
    changed = true;
  }
  if (changed) updateApplyJournalEntry_(journal, "applying", journal.plan, null, "");
}

function assertNoOtherActiveClassForCohort_(sheet, cohortId, excludedClassYearId) {
  var other = gatewayReadRows_(sheet, 16, 5000).some(function (item) {
    return String(item.values[0] || "").trim() !== excludedClassYearId &&
      String(item.values[3] || "").trim() === cohortId &&
      String(item.values[13] || "").trim() === "Активний";
  });
  if (other) {
    throw gatewayApplyError_(
      "cohort_still_open",
      "Класну групу не можна завершити, доки вона має інший активний запис за роками.",
    );
  }
}

function assertNoActiveClassesForYear_(sheet, academicYearId) {
  var active = gatewayReadRows_(sheet, 16, 5000).some(function (item) {
    return String(item.values[1] || "").trim() === academicYearId &&
      String(item.values[13] || "").trim() === "Активний";
  });
  if (active) {
    throw gatewayApplyError_(
      "source_year_still_open",
      "Вихідний навчальний рік ще має активні класи.",
    );
  }
}

function findAcademicYearById_(spreadsheet, rawId) {
  var id = gatewayAcademicYearId_(rawId);
  var sheet = gatewayRequiredSheet_(spreadsheet, "Навчальні роки");
  var matches = gatewayReadRows_(sheet, 6, 1000).filter(function (item) {
    return String(item.values[0] || "").trim() === id;
  });
  if (matches.length !== 1) {
    throw gatewayApplyError_(matches.length ? "duplicate_academic_year" : "academic_year_not_found", "Навчальний рік не знайдено однозначно.");
  }
  return {
    sheet: sheet,
    row: matches[0].row,
    id: id,
    label: String(matches[0].values[1] || "").trim(),
    startDate: String(matches[0].values[2] || "").trim(),
    endDate: String(matches[0].values[3] || "").trim(),
    status: String(matches[0].values[4] || "").trim(),
  };
}

function findCohortById_(sheet, rawId) {
  var id = String(rawId || "").trim().toUpperCase();
  if (!/^COH-\d{3,}$/.test(id)) throw gatewayApplyError_("invalid_cohort_id", "Некоректний ID класної групи.");
  var matches = gatewayReadRows_(sheet, 5, 5000).filter(function (item) {
    return String(item.values[0] || "").trim() === id;
  });
  if (matches.length !== 1) {
    throw gatewayApplyError_(matches.length ? "duplicate_cohort" : "cohort_not_found", "Класну групу не знайдено однозначно.");
  }
  return { id: id, row: matches[0].row, status: String(matches[0].values[3] || "").trim() };
}

function nextCohortId_(sheet, reservedIds) {
  var maximum = 0;
  gatewayReadRows_(sheet, 5, 5000).forEach(function (item) {
    var match = String(item.values[0] || "").trim().match(/^COH-(\d{3,})$/);
    if (match) maximum = Math.max(maximum, Number(match[1]));
  });
  Object.keys(reservedIds || {}).forEach(function (id) {
    var match = String(id || "").match(/^COH-(\d{3,})$/);
    if (match) maximum = Math.max(maximum, Number(match[1]));
  });
  return "COH-" + String(maximum + 1).padStart(3, "0");
}

function firstWritableClassGroupRow_(sheet) {
  var maximum = Math.min(5000, Number(sheet.getMaxRows()) || 0);
  var rows = sheet.getRange(2, 1, maximum - 1, 5).getDisplayValues();
  for (var index = 0; index < rows.length; index += 1) {
    if (rows[index].every(function (value) { return String(value || "").trim() === ""; })) return index + 2;
  }
  throw gatewayApplyError_("cohort_sheet_full", "На аркуші «Класні групи» немає вільного рядка.");
}

function assertClassYearSchema_(sheet) {
  var headers = sheet.getRange(1, 1, 1, 16).getDisplayValues()[0];
  if (normalizeHeader_(headers[0]).indexOf("id") !== 0 ||
      normalizeHeader_(headers[1]).indexOf("id навчального") !== 0 ||
      normalizeHeader_(headers[13]) !== "статус") {
    throw gatewayApplyError_("schema_mismatch", "Структура аркуша «Класи за роками» змінилася.");
  }
}

function buildLibrarianClassYearVersions_(spreadsheet) {
  var sheet = gatewayRequiredSheet_(spreadsheet, "Класи за роками");
  assertClassYearSchema_(sheet);
  var lastRow = Math.min(Number(sheet.getLastRow()) || 1, 5000);
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, 16).getDisplayValues()
    .map(function (values) {
      var id = String(values[0] || "").trim().toUpperCase();
      if (!/^CY-20\d{2}-\d{3,}$/.test(id)) return null;
      return { id: id, version: classYearVersionFromDisplayValues_(values) };
    })
    .filter(function (item) { return Boolean(item); });
}

function classYearVersionFromDisplayValues_(values) {
  var columns = [1, 2, 4, 6, 7, 8, 9, 10, 11, 14, 15, 16];
  var snapshot = columns.map(function (column) {
    return String(values[column - 1] === null || values[column - 1] === undefined
      ? ""
      : values[column - 1]).trim();
  });
  return digestWebSafe_(JSON.stringify(snapshot));
}

function currentClassYearVersion_(sheet, row) {
  return classYearVersionFromDisplayValues_(sheet.getRange(row, 1, 1, 16).getDisplayValues()[0]);
}

function gatewayClassYearVersion_(value) {
  var version = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(version)) {
    throw gatewayApplyError_("invalid_class_year_version", "Відсутня або некоректна версія перевіреного класу.");
  }
  return version;
}

function assertClassYearVersion_(sheet, row, expectedVersion) {
  if (currentClassYearVersion_(sheet, row) !== expectedVersion) {
    throw gatewayApplyError_(
      "stale_class_year",
      "Дані класу змінилися після відкриття форми. Оновіть дані й перевірте зміни повторно.",
    );
  }
}

function findClassYearById_(sheet, rawId) {
  var id = gatewayClassYearId_(rawId);
  var matches = gatewayReadRows_(sheet, 16, 5000).filter(function (item) {
    return String(item.values[0] || "").trim() === id;
  });
  if (matches.length !== 1) {
    throw gatewayApplyError_(matches.length ? "duplicate_class_year" : "class_year_not_found", "Запис класу не знайдено однозначно.");
  }
  return classYearFromRow_(matches[0]);
}

function classYearFromRow_(item) {
  return {
    row: item.row,
    id: String(item.values[0] || "").trim(),
    academicYearId: String(item.values[1] || "").trim(),
    cohortId: String(item.values[3] || "").trim(),
    grade: Number(item.values[5]) || 0,
    code: String(item.values[6] || "").trim(),
    teacherName: String(item.values[7] || "").trim(),
    teacherId: String(item.values[8] || "").trim(),
    locationName: String(item.values[9] || "").trim(),
    locationId: String(item.values[10] || "").trim(),
    status: String(item.values[13] || "").trim(),
    notes: String(item.values[15] || "").trim(),
  };
}

function assertUniqueClassTarget_(sheet, academicYearId, cohortId, grade, code, excludedRow) {
  var name = normalizedClassName_(grade, code);
  gatewayReadRows_(sheet, 16, 5000).forEach(function (item) {
    if (item.row === excludedRow) return;
    var rowYear = String(item.values[1] || "").trim();
    var rowCohort = String(item.values[3] || "").trim();
    var rowName = normalizedClassName_(item.values[5], item.values[6]);
    if (rowYear === academicYearId && (rowCohort === cohortId || rowName === name)) {
      throw gatewayApplyError_("duplicate_class_year", "У навчальному році вже є цей клас або класна група.");
    }
  });
}

function firstWritableClassYearRow_(sheet, excludedRows) {
  var maximum = Math.min(5000, Number(sheet.getMaxRows()) || 0);
  var writableColumns = [1, 2, 4, 6, 7, 8, 10, 14, 15, 16];
  var values = sheet.getRange(2, 1, maximum - 1, 16).getDisplayValues();
  var formulas = sheet.getRange(2, 1, maximum - 1, 16).getFormulas();
  for (var row = 2; row <= maximum; row += 1) {
    if (excludedRows.indexOf(row) !== -1) continue;
    var empty = writableColumns.every(function (column) {
      return String(values[row - 2][column - 1] || "").trim() === "" &&
        !formulas[row - 2][column - 1];
    });
    var formulaSafe = [3, 5, 9, 11, 12, 13].every(function (column) {
      return Boolean(formulas[row - 2][column - 1]);
    });
    if (empty && formulaSafe) return row;
  }
  throw gatewayApplyError_("class_year_sheet_full", "На аркуші «Класи за роками» немає вільного рядка.");
}

function nextClassYearId_(sheet, academicYearId, offset, reservedIds) {
  var year = Number(String(academicYearId).slice(3, 7));
  var sequence = nextClassYearSequence_(sheet, academicYearId, reservedIds) + Number(offset || 0);
  return "CY-" + year + "-" + String(sequence).padStart(3, "0");
}

function nextClassYearSequence_(sheet, academicYearId, reservedIds) {
  var year = Number(String(academicYearId).slice(3, 7));
  var prefix = "CY-" + year + "-";
  var maximum = 0;
  gatewayReadRows_(sheet, 16, 5000).forEach(function (item) {
    var id = String(item.values[0] || "").trim();
    if (id.indexOf(prefix) !== 0) return;
    var sequence = Number(id.slice(prefix.length));
    if (isFinite(sequence)) maximum = Math.max(maximum, sequence);
  });
  Object.keys(reservedIds || {}).forEach(function (id) {
    if (String(id).indexOf(prefix) !== 0) return;
    var sequence = Number(String(id).slice(prefix.length));
    if (isFinite(sequence)) maximum = Math.max(maximum, sequence);
  });
  return maximum + 1;
}

function classYearWritableValues_(id, yearId, cohortId, grade, code, teacher, location, status, closedDate, notes) {
  return {
    "1": id,
    "2": yearId,
    "4": cohortId,
    "6": grade,
    "7": code,
    "8": teacher ? teacher.name : "",
    "10": location ? location.name : "",
    "14": status,
    "15": closedDate || "",
    "16": notes || "",
  };
}

function assertClassFormulaColumns_(sheet, row) {
  var formulas = sheet.getRange(row, 1, 1, 16).getFormulas()[0];
  [3, 5, 9, 11, 12, 13].forEach(function (column) {
    if (!formulas[column - 1]) {
      throw gatewayApplyError_("formula_missing", "У рядку класу відсутня службова формула.");
    }
  });
  var template = sheet.getRange(2, 1, 1, 16).getFormulas()[0];
  assertClassFormulaSource_(template);
  if ([3, 5, 9, 11, 12, 13].some(function (column) {
    return formulas[column - 1] !== translatedOperationFormula_(template[column - 1], row - 2);
  })) {
    throw gatewayApplyError_("class_formula_mismatch", "Службові формули рядка класу не відповідають перевіреному шаблону.");
  }
}

function assertClassFormulaSource_(formulas) {
  if (formulaReferences_(formulas[2]).indexOf("B2") === -1 ||
      !formulaContainsReferences_(formulas[4], ["F2", "G2"]) ||
      formulaReferences_(formulas[8]).indexOf("H2") === -1 ||
      formulaReferences_(formulas[10]).indexOf("J2") === -1 ||
      formulaReferences_(formulas[11]).indexOf("B2") === -1 ||
      formulaReferences_(formulas[12]).indexOf("B2") === -1) {
    throw gatewayApplyError_("class_formula_template_invalid", "Еталонні службові формули Класи за роками!2 пошкоджено.");
  }
}

function formulaContainsReferences_(formula, expectedReferences) {
  var references = formulaReferences_(formula);
  return expectedReferences.every(function (reference) { return references.indexOf(reference) !== -1; });
}

function verifyClassFormulaReferences_(spreadsheet, sheet, row, teacherId, locationId) {
  assertClassFormulaColumns_(sheet, row);
  var values = sheet.getRange(row, 1, 1, 16).getDisplayValues()[0]
    .map(function (value) { return String(value || "").trim(); });
  var year = findAcademicYearById_(spreadsheet, values[1]);
  var expected = {
    "3": year.label,
    "5": String(Number(values[5])) + "-" + values[6],
    "9": String(teacherId || ""),
    "11": String(locationId || ""),
    "12": year.startDate,
    "13": year.endDate,
  };
  Object.keys(expected).forEach(function (columnText) {
    if (values[Number(columnText) - 1] !== String(expected[columnText] || "")) {
      throw new Error("Google Sheets не підтвердив службові значення класу.");
    }
  });
  if (!values[5] || !values[6]) {
    throw new Error("Google Sheets не підтвердив назву класу.");
  }
}

function resolveGatewayTeacherPair_(spreadsheet, rawId, rawName, optional) {
  if (!rawId && !rawName) {
    if (optional) return null;
    throw gatewayApplyError_("teacher_not_found", "Оберіть вчителя зі службового довідника.");
  }
  var id = String(rawId || "").trim().toUpperCase();
  var name = String(rawName || "").trim();
  if (!/^USR-\d{3,}$/.test(id) || !name) {
    throw gatewayApplyError_("invalid_teacher", "Збережіть ID і ПІБ вчителя разом.");
  }
  var matches = gatewayReadRows_(gatewayRequiredSheet_(spreadsheet, "Користувачі"), 6, 5000)
    .filter(function (item) {
      return String(item.values[0] || "").trim() === id &&
        String(item.values[1] || "").trim() === name &&
        /^актив/i.test(String(item.values[5] || "").trim());
    });
  if (matches.length !== 1) throw gatewayApplyError_("teacher_not_found", "Активного вчителя не знайдено однозначно.");
  return { id: id, name: name };
}

function resolveGatewayOptionalLocationPair_(spreadsheet, rawId, rawName, optional) {
  if (!rawId && !rawName) {
    if (optional) return null;
    throw gatewayApplyError_("location_not_found", "Оберіть кабінет зі службового довідника.");
  }
  return resolveGatewayLocation_(spreadsheet, rawId, rawName, false);
}

function normalizedClassName_(grade, code) {
  return (String(Number(grade) || grade).trim() + "-" + String(code || "").trim())
    .toLocaleUpperCase("uk-UA");
}

function structuredClassNotes_(reason, notes) {
  var parts = [];
  if (reason) parts.push("Причина: " + gatewayOptionalText_(reason, 1000));
  if (notes) parts.push(gatewayOptionalText_(notes, 2000));
  return parts.join("; ").slice(0, 2000);
}

function appendGatewayNotes_(existing, addition) {
  var parts = [];
  if (existing) parts.push(String(existing).trim());
  if (addition) parts.push(String(addition).trim());
  return parts.join("; ").slice(0, 2000);
}

/* -------------------------------------------------------------------------- */
/* Shared mutation and validation helpers                                     */
/* -------------------------------------------------------------------------- */

function gatewayRequiredSheet_(spreadsheet, name) {
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) throw gatewayApplyError_("sheet_not_found", "Не знайдено аркуш «" + name + "».");
  return sheet;
}

function gatewayReadRows_(sheet, width, maximumRows) {
  var lastRow = Number(sheet.getLastRow()) || 1;
  if (lastRow < 2) return [];
  if (lastRow > maximumRows) throw gatewayApplyError_("sheet_too_large", "Аркуш перевищує безпечний ліміт.");
  return sheet.getRange(2, 1, lastRow - 1, width).getDisplayValues()
    .map(function (values, index) { return { row: index + 2, values: values }; });
}

function preflightReconciledCells_(sheet, row, expected, conflictCode, allowExisting) {
  assertWritableColumnsWithoutFormulas_(sheet, row, expected);
  Object.keys(expected).forEach(function (columnText) {
    var column = Number(columnText);
    var actual = normalizedGatewayCell_(sheet.getRange(row, column).getValue());
    var wanted = normalizedGatewayCell_(expected[columnText]);
    if (!allowExisting && actual !== "" && actual !== wanted) {
      throw gatewayApplyError_(conflictCode, "Цільовий рядок уже містить інші дані.");
    }
  });
}

function writeReconciledCells_(sheet, row, expected, conflictCode) {
  preflightReconciledCells_(sheet, row, expected, conflictCode, false);
  Object.keys(expected).forEach(function (columnText) {
    var column = Number(columnText);
    var range = sheet.getRange(row, column);
    var actual = normalizedGatewayCell_(range.getValue());
    var wanted = normalizedGatewayCell_(expected[columnText]);
    if (actual === wanted) return;
    range.setValue(gatewaySheetValue_(expected[columnText]));
  });
}

function writeExactUpdateCells_(sheet, row, expected) {
  assertWritableColumnsWithoutFormulas_(sheet, row, expected);
  Object.keys(expected).forEach(function (columnText) {
    sheet.getRange(row, Number(columnText)).setValue(gatewaySheetValue_(expected[columnText]));
  });
}

function captureCellValues_(sheet, row, columnsLike) {
  var values = {};
  Object.keys(columnsLike).forEach(function (columnText) {
    values[columnText] = normalizedGatewayCell_(sheet.getRange(row, Number(columnText)).getValue());
  });
  return values;
}

function writeTransitionCells_(sheet, row, before, after, conflictCode) {
  preflightTransitionCells_(sheet, row, before, after, conflictCode);
  Object.keys(after).forEach(function (columnText) {
    var range = sheet.getRange(row, Number(columnText));
    if (normalizedGatewayCell_(range.getValue()) !== normalizedGatewayCell_(after[columnText])) {
      range.setValue(gatewaySheetValue_(after[columnText]));
    }
  });
}

function preflightTransitionCells_(sheet, row, before, after, conflictCode) {
  assertWritableColumnsWithoutFormulas_(sheet, row, after);
  Object.keys(after).forEach(function (columnText) {
    var actual = normalizedGatewayCell_(sheet.getRange(row, Number(columnText)).getValue());
    var previous = normalizedGatewayCell_(before[columnText]);
    var wanted = normalizedGatewayCell_(after[columnText]);
    if (actual !== previous && actual !== wanted) {
      throw gatewayApplyError_(conflictCode, "Дані змінилися після підготовки операції.");
    }
  });
}

function verifyReconciledCells_(sheet, row, expected) {
  Object.keys(expected).forEach(function (columnText) {
    var actual = normalizedGatewayCell_(sheet.getRange(row, Number(columnText)).getValue());
    var wanted = normalizedGatewayCell_(expected[columnText]);
    if (actual !== wanted) throw new Error("Google Sheets не підтвердив запис у рядку " + row + ".");
  });
}

function assertWritableColumnsWithoutFormulas_(sheet, row, expected) {
  Object.keys(expected).forEach(function (columnText) {
    if (sheet.getRange(row, Number(columnText)).getFormula()) {
      throw gatewayApplyError_("formula_protected", "Цільова клітинка містить службову формулу.");
    }
  });
}

function gatewaySheetValue_(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return isoDateValue_(value);
  return value === null || value === undefined ? "" : value;
}

function normalizedGatewayCell_(value) {
  if (Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, "Europe/Kyiv", "yyyy-MM-dd");
  }
  return String(value === null || value === undefined ? "" : value).trim();
}

function nonEmptyGatewayValue_(value) {
  return String(value || "").trim() !== "";
}

function gatewaySafeText_(value, maximum, message) {
  if (typeof value !== "string") throw gatewayApplyError_("invalid_payload", message);
  var text = value.trim();
  if (!text || text.length > maximum || /^[=+\-@]/.test(text)) {
    throw gatewayApplyError_("invalid_payload", message);
  }
  return text;
}

function gatewayOptionalText_(value, maximum) {
  if (value === undefined || value === null || value === "") return "";
  return gatewaySafeText_(String(value), maximum, "Некоректне текстове поле.");
}

function gatewayInteger_(value, minimum, maximum, message) {
  var number = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof number !== "number" || !isFinite(number) || Math.floor(number) !== number || number < minimum || number > maximum) {
    throw gatewayApplyError_("invalid_payload", message);
  }
  return number;
}

function gatewayHttpUrl_(value, message) {
  var text = gatewaySafeText_(value, 2048, message);
  if (!/^https?:\/\/[^\s/@]+(?:[/:?#][^\s]*)?$/i.test(text) || /https?:\/\/[^/]*@/i.test(text)) {
    throw gatewayApplyError_("invalid_url", message);
  }
  return text;
}

function normalizeGatewayIsbn_(value) {
  var normalized = normalizeGatewayIsbnLoose_(value);
  if (!/^(?:\d{13}|\d{9}[\dX])$/.test(normalized)) {
    throw gatewayApplyError_("invalid_isbn", "ISBN має містити 10 або 13 символів.");
  }
  return normalized;
}

function normalizeGatewayIsbnLoose_(value) {
  return String(value || "").toUpperCase().replace(/[^0-9X]/g, "");
}

function gatewayMaterialId_(value) {
  var id = String(value || "").trim().toUpperCase();
  if (!/^CAT-\d{4,}$/.test(id)) throw gatewayApplyError_("invalid_material_id", "Некоректний CAT-ID.");
  return id;
}

function gatewayAcademicYearId_(value) {
  var id = String(value || "").trim().toUpperCase();
  var match = id.match(/^YR-(20\d{2})-(20\d{2})$/);
  if (!match || Number(match[2]) !== Number(match[1]) + 1) {
    throw gatewayApplyError_("invalid_academic_year_id", "Некоректний ID навчального року.");
  }
  return id;
}

function gatewayClassYearId_(value) {
  var id = String(value || "").trim().toUpperCase();
  if (!/^CY-20\d{2}-\d{3,}$/.test(id)) throw gatewayApplyError_("invalid_class_year_id", "Некоректний ID класу за роком.");
  return id;
}

function gatewayClassCode_(value) {
  var code = gatewaySafeText_(value, 16, "Некоректний код класу.");
  if (!/^[A-Za-zА-Яа-яІіЇїЄєҐґ0-9()'’._-]{1,16}$/.test(code)) {
    throw gatewayApplyError_("invalid_class_code", "Некоректний код класу.");
  }
  return code;
}

/**
 * Idempotent migration for the exact safety repairs validated on a backup.
 * It refuses to overwrite values and only extends formulas/validation when
 * the current boundary and formulas match the expected production template.
 */
function setupLibrarianGatewayDataRepairs() {
  var properties = PropertiesService.getScriptProperties();
  var target = assertGatewayWriteTarget_(properties);
  if (String(properties.getProperty("LIBRARIAN_WRITES_ENABLED") || "").toLocaleLowerCase("en-US") !== "true") {
    throw new Error("Запис до Google Sheets вимкнено.");
  }
  if (target.mode !== "production" && target.mode !== "copy_test") {
    throw new Error("Режим міграції не дозволено.");
  }
  var spreadsheet = openGatewaySpreadsheet_(target.spreadsheetId);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error("Шлюз зайнятий.");
  try {
    return repairLibrarianGatewayData_(spreadsheet);
  } finally {
    lock.releaseLock();
  }
}

function repairLibrarianGatewayData_(spreadsheet) {
  var report = {
    materials: 0,
    operationRows: 0,
    operationRequestColumn: 0,
    validations: 0,
    initialBalanceValidation: 0,
  };
  var materials = gatewayRequiredSheet_(spreadsheet, "Матеріали");
  var materialUpdates = [];
  for (var row = 327; row <= 426; row += 1) {
    var range = materials.getRange(row, 1);
    var formula = range.getFormula();
    if (!formula) {
      throw gatewayApplyError_("repair_preflight_failed", "У Матеріали!A" + row + " відсутня очікувана формула.");
    }
    if (formula.indexOf("$A$427:$A$1600") !== -1) continue;
    if (formula.indexOf("$A$427:$A$1212") === -1) {
      throw gatewayApplyError_("repair_preflight_failed", "Невідома формула Матеріали!A" + row + ".");
    }
    materialUpdates.push({ row: row, formula: formula.replace(/\$A\$427:\$A\$1212/g, "$A$427:$A$1600") });
  }

  var operations = gatewayRequiredSheet_(spreadsheet, "Операції");
  var genericSourceFormulas = operations.getRange(2, 1, 1, 15).getFormulas()[0];
  assertGenericOperationFormulaSource_(genericSourceFormulas);
  if (genericSourceFormulas.slice(1, 11).some(nonEmptyGatewayValue_)) {
    throw gatewayApplyError_("repair_preflight_failed", "Еталонний рядок Операції!B2:K2 містить формулу.");
  }
  var operationMaximumRows = Number(operations.getMaxRows()) || 0;
  if (operationMaximumRows < LIBRARIAN_OPERATION_MAX_ROW) {
    throw gatewayApplyError_("repair_preflight_failed", "Аркуш «Операції» не має повного generic-діапазону 2:1000.");
  }
  var genericOperationMaximum = LIBRARIAN_OPERATION_MAX_ROW;
  var genericOperationFormulas = operations.getRange(
    2,
    1,
    genericOperationMaximum - 1,
    15,
  ).getFormulas();
  genericOperationFormulas.forEach(function (formulas, index) {
    var operationRow = index + 2;
    if (formulas.slice(1, 11).some(nonEmptyGatewayValue_) ||
        [1, 12, 13, 14, 15].some(function (column) {
          return formulas[column - 1] !== translatedOperationFormula_(
            genericSourceFormulas[column - 1],
            operationRow - 2,
          );
        })) {
      throw gatewayApplyError_(
        "repair_formula_mismatch",
        "Операції!" + operationRow + " не відповідає generic-шаблону рядка 2.",
      );
    }
  });
  var operationRequestRows = genericOperationMaximum;
  var operationRequestValues = operations.getRange(
    1,
    LIBRARIAN_OPERATION_REQUEST_COLUMN,
    operationRequestRows,
    1,
  ).getDisplayValues();
  var operationRequestFormulas = operations.getRange(
    1,
    LIBRARIAN_OPERATION_REQUEST_COLUMN,
    operationRequestRows,
    1,
  ).getFormulas();
  if (operationRequestFormulas.some(function (row) { return Boolean(row[0]); })) {
    throw gatewayApplyError_("repair_preflight_failed", "Операції!P містить формулу і не може бути службовим request_id.");
  }
  var operationRequestHeader = String(operationRequestValues[0][0] || "").trim();
  if (operationRequestHeader && operationRequestHeader !== LIBRARIAN_OPERATION_REQUEST_HEADER) {
    throw gatewayApplyError_("repair_preflight_failed", "Операції!P вже має інше призначення.");
  }
  var seenOperationRequests = {};
  operationRequestValues.slice(1).forEach(function (row, index) {
    var value = String(row[0] || "").trim();
    if (!value) return;
    if (!operationRequestHeader || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw gatewayApplyError_("repair_preflight_failed", "Операції!P" + (index + 2) + " містить невідомі дані.");
    }
    if (seenOperationRequests[value]) {
      throw gatewayApplyError_("repair_preflight_failed", "request_id в Операції!P повторюється.");
    }
    seenOperationRequests[value] = true;
  });
  var existingQuantities = operations.getRange(2, 8, genericOperationMaximum - 1, 1)
    .getDisplayValues();
  existingQuantities.forEach(function (value, index) {
    var text = String(value[0] || "").trim();
    if (text && (!/^\d+$/.test(text) || Number(text) < 1)) {
      throw gatewayApplyError_("repair_preflight_failed", "Операції!H" + (index + 2) + " не є додатним цілим числом.");
    }
  });

  var users = gatewayRequiredSheet_(spreadsheet, "Користувачі");
  var allowedRoles = ["Бібліотекар / адміністратор", "Адміністрація", "Учитель"];
  var allowedStatuses = ["Активний", "Доступ не активовано", "Неактивний"];
  gatewayReadRows_(users, 6, 5000).forEach(function (item) {
    var role = String(item.values[2] || "").trim();
    var status = String(item.values[5] || "").trim();
    if ((role && allowedRoles.indexOf(role) === -1) || (status && allowedStatuses.indexOf(status) === -1)) {
      throw gatewayApplyError_("repair_preflight_failed", "Користувачі містять значення поза новим довідником.");
    }
  });

  // No domain cell is touched before every formula/value preflight above has
  // succeeded.
  materialUpdates.forEach(function (update) {
    materials.getRange(update.row, 1).setFormula(update.formula);
    report.materials += 1;
  });
  if (!operationRequestHeader) {
    operations.getRange(1, LIBRARIAN_OPERATION_REQUEST_COLUMN).setValue(LIBRARIAN_OPERATION_REQUEST_HEADER);
    report.operationRequestColumn = 1;
  }
  if (typeof operations.hideColumns === "function") {
    operations.hideColumns(LIBRARIAN_OPERATION_REQUEST_COLUMN);
  }
  SpreadsheetApp.flush();

  if (typeof SpreadsheetApp.newDataValidation === "function") {
    var positiveIntegerRule = SpreadsheetApp.newDataValidation()
      .requireFormulaSatisfied("=OR(H2=\"\",AND(ISNUMBER(H2),H2=INT(H2),H2>0))")
      .setAllowInvalid(false)
      .build();
    operations.getRange(2, 8, genericOperationMaximum - 1, 1).setDataValidation(positiveIntegerRule);
    report.validations += 1;

    users.getRange(2, 3, Math.max(1, Number(users.getMaxRows()) - 1), 1).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInList(allowedRoles, true)
        .setAllowInvalid(false).build(),
    );
    users.getRange(2, 6, Math.max(1, Number(users.getMaxRows()) - 1), 1).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInList(allowedStatuses, true)
        .setAllowInvalid(false).build(),
    );
    report.validations += 2;

    var initial = gatewayRequiredSheet_(spreadsheet, "Початкові залишки");
    initial.getRange(2, 3, Math.max(1, Number(initial.getMaxRows()) - 1), 1).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInRange(gatewayRequiredSheet_(spreadsheet, "Місця").getRange("A2:A1000"), true)
        .setAllowInvalid(false).build(),
    );
    report.initialBalanceValidation = 1;
  }
  SpreadsheetApp.flush();
  return report;
}

function translatedOperationFormula_(formula, rowDelta) {
  return String(formula || "").replace(/(\$?[A-Z]{1,3})(\$?)(\d+)/g, function (match, column, absolute, row) {
    return absolute ? match : column + String(Number(row) + Number(rowDelta || 0));
  });
}

function normalizeOperationRepairFormula_(formula) {
  return String(formula || "")
    .replace(/\s+/g, "")
    .replace(/\$/g, "")
    .replace(/'/g, "")
    .replace(/;/g, ",")
    .toLocaleUpperCase("uk-UA");
}
