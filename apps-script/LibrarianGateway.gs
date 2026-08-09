/**
 * Захищений шлюз для приватного кабінету бібліотекаря.
 *
 * Script Property SHEETS_GATEWAY_SECRET встановлюється вручну й ніколи не
 * зберігається у клітинках або коді. Публічний doGet з PublicCatalogApi.gs
 * залишається без змін. Запис доступний лише через HMAC, явний серверний прапорець
 * LIBRARIAN_WRITES_ENABLED і перевірений список безпечних операцій.
 */

var LIBRARIAN_GATEWAY_MAX_AGE_SECONDS = 300;
var LIBRARIAN_GATEWAY_NONCE_TTL_SECONDS = 600;
var LIBRARIAN_GATEWAY_PRODUCTION_SPREADSHEET_ID = "18SEyo-tAJ8uHoAFMrYbiaGMtmXjhiscQGcYTpJrNtEI";
var LIBRARIAN_GATEWAY_APPLY_LEDGER_LIMIT = 75;
var LIBRARIAN_GATEWAY_APPLY_LEDGER_TTL_MS = 90 * 24 * 60 * 60 * 1000;
var LIBRARIAN_GATEWAY_APPLY_INDEX_KEY = "GATEWAY_APPLY_INDEX_V1";
var LIBRARIAN_GATEWAY_APPLY_CACHE_MAX_BYTES = 7000;
var LIBRARIAN_GATEWAY_MAX_REQUEST_BYTES = 13 * 1024 * 1024;
var LIBRARIAN_GATEWAY_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

function doPost(e) {
  try {
    var request = parseGatewayRequest_(e);
    verifyGatewayRequest_(request);

    if (request.action === "referenceData") {
      return gatewayJson_({
        success: true,
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        referenceData: buildLibrarianReferenceData_(),
      });
    }
    if (request.action === "applyDraft") {
      return gatewayJson_(applyGatewayDraft_(request.payload));
    }

    return gatewayJson_({ success: false, error: "Непідтримувана дія." });
  } catch (error) {
    return gatewayJson_({
      success: false,
      error: error && error.message ? error.message : "Помилка захищеного шлюзу.",
    });
  }
}

function parseGatewayRequest_(e) {
  var raw = e && e.postData && e.postData.contents;
  if (!raw || raw.length > LIBRARIAN_GATEWAY_MAX_REQUEST_BYTES) throw new Error("Некоректний запит.");
  var request = JSON.parse(raw);
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Некоректний запит.");
  }
  return request;
}

function verifyGatewayRequest_(request) {
  var secret = PropertiesService.getScriptProperties().getProperty("SHEETS_GATEWAY_SECRET");
  if (!secret || secret.length < 32) throw new Error("Шлюз ще не налаштовано.");

  var action = String(request.action || "");
  var timestamp = Number(request.timestamp);
  var nonce = String(request.nonce || "");
  var signature = String(request.signature || "");
  var payload = request.payload && typeof request.payload === "object"
    ? request.payload
    : {};

  if (!/^[a-z][A-Za-z0-9]{1,63}$/.test(action)) throw new Error("Некоректна дія.");
  if (!/^[-A-Za-z0-9_]{20,120}$/.test(nonce)) throw new Error("Некоректний nonce.");
  if (!/^[-A-Za-z0-9_]{40,120}$/.test(signature)) throw new Error("Некоректний підпис.");
  if (!isFinite(timestamp)) throw new Error("Некоректний час запиту.");

  var now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > LIBRARIAN_GATEWAY_MAX_AGE_SECONDS) {
    throw new Error("Термін дії запиту минув.");
  }

  var payloadHash = digestWebSafe_(JSON.stringify(payload));
  var canonical = [action, String(timestamp), nonce, payloadHash].join("\n");
  var expected = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(canonical, secret, Utilities.Charset.UTF_8),
  ).replace(/=+$/, "");
  if (!constantTimeEqual_(signature, expected)) throw new Error("Невірний підпис.");

  var nonceKey = "gateway-nonce-" + digestWebSafe_(nonce).slice(0, 36);
  var cache = CacheService.getScriptCache();
  var nonceLock = LockService.getScriptLock();
  if (!nonceLock.tryLock(10000)) throw new Error("Шлюз зайнятий. Повторіть запит.");
  try {
    if (cache.get(nonceKey)) throw new Error("Повторний запит відхилено.");
    cache.put(nonceKey, "1", LIBRARIAN_GATEWAY_NONCE_TTL_SECONDS);
  } finally {
    nonceLock.releaseLock();
  }
}

function buildLibrarianReferenceData_() {
  var spreadsheet = openGatewaySpreadsheet_();
  return {
    materialVersions: buildLibrarianMaterialVersions_(spreadsheet),
    classYearVersions: buildLibrarianClassYearVersions_(spreadsheet),
    teachers: readReferenceRows_(spreadsheet, "Користувачі", 6, function (row) {
      if (!/^USR-\d{3,}$/.test(row[0]) || !row[1]) return null;
      if (!/(Учитель|Адміністрац|Бібліотекар)/i.test(row[2])) return null;
      return { id: row[0], name: row[1], role: row[2], status: row[5] };
    }),
    locations: readReferenceRows_(spreadsheet, "Місця", 4, function (row) {
      if (!/^LOC-\d{3,}$/.test(row[0]) || !row[1] || /^(LOC-007|LOC-008)$/.test(row[0])) return null;
      return { id: row[0], name: row[1], type: row[2], status: row[3] };
    }),
    academicYears: readReferenceRows_(spreadsheet, "Навчальні роки", 6, function (row, rawRow) {
      if (!/^YR-20\d{2}-20\d{2}$/.test(row[0]) || !/^20\d{2}\/20\d{2}$/.test(row[1])) return null;
      return {
        id: row[0], label: row[1],
        startDate: referenceIsoDate_(spreadsheet, rawRow[2], row[2]),
        endDate: referenceIsoDate_(spreadsheet, rawRow[3], row[3]),
        status: row[4], notes: row[5],
      };
    }),
    classYears: readReferenceRows_(spreadsheet, "Класи за роками", 16, function (row, rawRow) {
      if (!/^CY-20\d{2}-\d{3,}$/.test(row[0]) || !/^YR-20\d{2}-20\d{2}$/.test(row[1])) return null;
      return {
        id: row[0], academicYearId: row[1], academicYearLabel: row[2], cohortId: row[3],
        className: row[4], grade: Number(row[5]) || null, code: row[6],
        teacherName: row[7], teacherUserId: row[8], locationName: row[9], locationId: row[10],
        startDate: referenceIsoDate_(spreadsheet, rawRow[11], row[11]),
        endDate: referenceIsoDate_(spreadsheet, rawRow[12], row[12]),
        status: row[13],
        actualClosedDate: referenceIsoDate_(spreadsheet, rawRow[14], row[14]),
        notes: row[15],
      };
    }),
  };
}

function openGatewaySpreadsheet_(verifiedSpreadsheetId) {
  var configured = verifiedSpreadsheetId ||
    PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  var spreadsheetId = String(configured || "").trim();
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(spreadsheetId)) {
    throw new Error("Некоректний SPREADSHEET_ID у властивостях скрипту.");
  }
  var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  if (!spreadsheet) throw new Error("Не вдалося відкрити службову Google-таблицю.");
  return spreadsheet;
}

function applyGatewayDraft_(rawPayload) {
  var input = validateApplyEnvelope_(rawPayload);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error("Шлюз зайнятий. Повторіть запит із тим самим request_id.");
  }
  try {
    var properties = PropertiesService.getScriptProperties();
    var writeTarget;
    try {
      writeTarget = assertGatewayWriteTarget_(properties);
    } catch (error) {
      if (!error || !error.gatewayCode) throw error;
      return applyFailure_(input, error.gatewayCode, error.message, true, true);
    }
    var ledgerKey = "GATEWAY_APPLY_" + digestWebSafe_(input.requestId).slice(0, 40);
    var fingerprint = digestWebSafe_(JSON.stringify({
      draft_id: input.draftId,
      revision: input.revision,
      kind: input.kind,
      payload: input.payload,
      actor: input.actor,
      attachment: attachmentFingerprint_(input.attachment),
      write_mode: writeTarget.mode,
      spreadsheet_id: writeTarget.spreadsheetId,
    }));
    var remembered = readApplyResult_(properties.getProperty(ledgerKey));
    if (remembered) {
      if (remembered.fingerprint !== fingerprint) {
        return applyFailure_(
          input,
          "request_id_conflict",
          "Цей request_id уже використано для іншого вмісту.",
          false,
          true,
        );
      }
      return remembered.response;
    }
    var writesEnabled = String(
      properties.getProperty("LIBRARIAN_WRITES_ENABLED") || "",
    ).toLowerCase() === "true";
    if (!writesEnabled) {
      return applyFailure_(
        input,
        "writes_disabled",
        "Запис до Google Sheets вимкнено. Дані не змінено.",
        true,
        true,
      );
    }

    var spreadsheet = openGatewaySpreadsheet_(writeTarget.spreadsheetId);
    var journalSheet = ensureApplyJournalSheet_(spreadsheet);
    var journal = findApplyJournalEntry_(journalSheet, input.requestId);
    if (journal) {
      if (journal.fingerprint !== fingerprint || !journal.target ||
          journal.target.write_mode !== writeTarget.mode ||
          journal.target.spreadsheet_id !== writeTarget.spreadsheetId) {
        return applyFailure_(
          input,
          "request_id_conflict",
          "Цей request_id уже використано для іншого вмісту або цільової таблиці.",
          false,
          true,
        );
      }
      if ((journal.state === "applied" || journal.state === "failed") && journal.result) {
        rememberApplyResult_(properties, ledgerKey, fingerprint, journal.result);
        return journal.result;
      }
      if (journal.state !== "prepared" && journal.state !== "applying") {
        return applyFailure_(input, "journal_corrupt", "Некоректний стан журналу застосувань.", false, true);
      }
    } else {
      var actor;
      var plan;
      try {
        actor = resolveGatewayActor_(spreadsheet, input.actor);
        plan = prepareGatewayOperationPlan_(spreadsheet, input, actor);
      } catch (error) {
        if (!error || !error.gatewayCode) throw error;
        return applyFailure_(
          input,
          error.gatewayCode,
          error.message,
          error.gatewayRetryable === true,
          true,
        );
      }
      journal = prepareApplyJournalEntry_(spreadsheet, input, fingerprint, writeTarget, plan);
    }

    var response;
    try {
      updateApplyJournalEntry_(journal, "applying", journal.plan, null, "");
      var result = dispatchSafeApply_(input, spreadsheet, journal);
      SpreadsheetApp.flush();
      invalidateGatewayPublicCatalogCache_();
      maybeInjectGatewayTestCrash_(properties, writeTarget);
      result = finalizeGatewayResult_(input, result);
      result.cover = applyGatewayCoverPostCommit_(spreadsheet, input, result, journal, writeTarget);
      response = {
        success: true,
        schemaVersion: 1,
        request_id: input.requestId,
        draft_id: input.draftId,
        kind: input.kind,
        applied_at: new Date().toISOString(),
        result: result,
      };
      updateApplyJournalEntry_(journal, "applied", journal.plan, response, "");
    } catch (error) {
      if (!error || !error.gatewayCode) {
        updateApplyJournalEntry_(journal, "applying", journal.plan, null, error && error.message ? error.message : "Невідома помилка.");
        throw error;
      }
      // Every domain writer persists a write_started marker immediately before
      // its first possible mutation.  Without such a marker this request is a
      // known no-op and may be returned for correction.  With a marker (or a
      // later checkpoint), a cell may already be durable, so the same request
      // must remain resumable and reconcile rather than duplicate the write.
      if (hasAnyApplyJournalCheckpoint_(journal)) {
        response = applyFailure_(input, error.gatewayCode, error.message, true, false);
        updateApplyJournalEntry_(journal, "applying", journal.plan, null, error.message);
        return response;
      }
      response = applyFailure_(input, error.gatewayCode, error.message, false, true);
      updateApplyJournalEntry_(journal, "failed", journal.plan, response, error.message);
      return response;
    }

    rememberApplyResult_(properties, ledgerKey, fingerprint, response);
    return response;
  } finally {
    lock.releaseLock();
  }
}

function assertGatewayWriteTarget_(properties) {
  var mode = String(properties.getProperty("LIBRARIAN_WRITE_MODE") || "").trim();
  var spreadsheetId = String(properties.getProperty("SPREADSHEET_ID") || "").trim();
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(spreadsheetId)) {
    throw gatewayApplyError_(
      "invalid_spreadsheet_id",
      "Некоректний SPREADSHEET_ID у властивостях скрипту.",
    );
  }
  if (mode === "copy_test") {
    if (spreadsheetId === LIBRARIAN_GATEWAY_PRODUCTION_SPREADSHEET_ID) {
      throw gatewayApplyError_(
        "unsafe_write_target",
        "Тестовий режим не може записувати до продуктивної таблиці.",
      );
    }
    return { mode: mode, spreadsheetId: spreadsheetId };
  }
  if (mode === "production") {
    if (spreadsheetId !== LIBRARIAN_GATEWAY_PRODUCTION_SPREADSHEET_ID) {
      throw gatewayApplyError_(
        "unsafe_write_target",
        "Продуктивний режим дозволяє лише основну службову таблицю.",
      );
    }
    return { mode: mode, spreadsheetId: spreadsheetId };
  }
  throw gatewayApplyError_(
    "write_mode_disabled",
    "Режим запису не налаштовано. Дані не змінено.",
  );
}

function validateApplyEnvelope_(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw gatewayApplyError_("invalid_apply_request", "Некоректний запит на застосування.");
  }
  validateExactKeys_(raw, [
    "request_id", "draft_id", "revision", "kind", "payload", "actor", "attachment",
  ]);
  var requestId = String(raw.request_id || "").trim();
  var draftId = String(raw.draft_id || "").trim();
  var revision = Number(raw.revision);
  var kind = String(raw.kind || "").trim();
  var payload = raw.payload;
  var actor = raw.actor;
  var uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(requestId)) {
    throw gatewayApplyError_("invalid_request_id", "Некоректний request_id.");
  }
  if (!uuidPattern.test(draftId)) {
    throw gatewayApplyError_("invalid_draft_id", "Некоректний draft_id.");
  }
  if (!isFinite(revision) || Math.floor(revision) !== revision || revision < 1) {
    throw gatewayApplyError_("invalid_revision", "Некоректна ревізія чернетки.");
  }
  if (!/^[a-z]+(?:[.-][a-z]+){1,4}$/.test(kind)) {
    throw gatewayApplyError_("invalid_kind", "Некоректний тип чернетки.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw gatewayApplyError_("invalid_payload", "Некоректні дані чернетки.");
  }
  if (JSON.stringify(payload).length > 50000) {
    throw gatewayApplyError_("payload_too_large", "Дані чернетки завеликі.");
  }
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) {
    throw gatewayApplyError_("actor_required", "Не вказано відповідального користувача.");
  }
  validateExactKeys_(actor, ["id", "email"]);
  var actorId = requiredText_(actor.id, 160, "Некоректний ID відповідального користувача.");
  var actorEmail = requiredText_(actor.email, 320, "Некоректна адреса відповідального користувача.")
    .toLocaleLowerCase("uk-UA");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(actorEmail)) {
    throw gatewayApplyError_("invalid_actor", "Некоректна адреса відповідального користувача.");
  }
  var attachment = validateGatewayAttachment_(raw.attachment, payload, kind);
  var normalizedActor = { id: actorId };
  normalizedActor["email"] = actorEmail;
  return {
    requestId: requestId,
    draftId: draftId,
    revision: revision,
    kind: kind,
    payload: payload,
    actor: normalizedActor,
    attachment: attachment,
  };
}

function dispatchSafeApply_(input, spreadsheet, journal) {
  if (input.kind === "material.create") return executeGatewayOperationPlan_(spreadsheet, input, null, journal);
  if (input.kind === "material.update") return executeGatewayOperationPlan_(spreadsheet, input, null, journal);
  if (input.kind === "receipt.create") return executeGatewayOperationPlan_(spreadsheet, input, null, journal);
  if (input.kind === "transfer.create") return executeGatewayOperationPlan_(spreadsheet, input, null, journal);
  if (input.kind === "writeoff.create") return executeGatewayOperationPlan_(spreadsheet, input, null, journal);
  if (input.kind === "revision.count") return executeGatewayOperationPlan_(spreadsheet, input, null, journal);
  if (input.kind === "academic-year.create") return executeGatewayOperationPlan_(spreadsheet, input, null, journal);
  if (input.kind === "class-year.create") return executeGatewayOperationPlan_(spreadsheet, input, null, journal);
  if (input.kind === "class-year.update") return executeGatewayOperationPlan_(spreadsheet, input, null, journal);
  if (input.kind === "class-year.close") return executeGatewayOperationPlan_(spreadsheet, input, null, journal);
  if (input.kind === "academic-year.rollover") return executeGatewayOperationPlan_(spreadsheet, input, null, journal);
  throw gatewayApplyError_(
    "unsupported_kind",
    "Цей тип чернетки ще не має перевіреного безпечного запису.",
  );
}

function validateGatewayAttachment_(raw, payload, kind) {
  var coverPayload = kind === "material.update" && payload && payload.changes &&
    typeof payload.changes === "object" ? payload.changes : payload;
  var photoKey = coverPayload && coverPayload.coverPhotoKey ? String(coverPayload.coverPhotoKey).trim() : "";
  if (raw === undefined || raw === null) {
    if (photoKey && (kind === "material.create" || kind === "material.update")) {
      throw gatewayApplyError_("attachment_required", "Для приватної фотографії потрібне підписане вкладення.");
    }
    return null;
  }
  if (kind !== "material.create" && kind !== "material.update") {
    throw gatewayApplyError_("unexpected_attachment", "Вкладення дозволене лише для обкладинки матеріалу.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw gatewayApplyError_("invalid_attachment", "Некоректне вкладення обкладинки.");
  }
  validateExactKeys_(raw, ["key", "contentType", "originalName", "byteLength", "sha256", "base64"]);
  var key = requiredText_(raw.key, 240, "Некоректний ключ вкладення.");
  var name = requiredText_(raw.originalName, 255, "Некоректна назва вкладення.");
  var mimeType = requiredText_(raw.contentType, 32, "Некоректний MIME-тип вкладення.").toLocaleLowerCase("en-US");
  var encoded = typeof raw.base64 === "string" ? raw.base64.trim() : "";
  if (!encoded || encoded.length > 12 * 1024 * 1024) {
    throw gatewayApplyError_("invalid_attachment", "Некоректні дані вкладення.");
  }
  var sha256 = requiredText_(raw.sha256, 64, "Некоректна контрольна сума вкладення.").toLocaleLowerCase("en-US");
  var size = Number(raw.byteLength);
  if (key !== photoKey || (coverPayload.coverPhotoName && String(coverPayload.coverPhotoName).trim() !== name)) {
    throw gatewayApplyError_("attachment_binding_mismatch", "Вкладення не відповідає джерелу обкладинки у чернетці.");
  }
  if (["image/jpeg", "image/png", "image/webp"].indexOf(mimeType) === -1) {
    throw gatewayApplyError_("unsupported_attachment_type", "Підтримуються JPEG, PNG і WEBP.");
  }
  if (!/^[A-Fa-f0-9]{64}$/.test(sha256) || !isFinite(size) || Math.floor(size) !== size ||
      size < 1 || size > LIBRARIAN_GATEWAY_MAX_ATTACHMENT_BYTES ||
      encoded.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw gatewayApplyError_("invalid_attachment", "Некоректний розмір або контрольна сума вкладення.");
  }
  var bytes;
  try {
    bytes = Utilities.base64Decode(encoded);
  } catch (error) {
    throw gatewayApplyError_("invalid_attachment", "Не вдалося декодувати вкладення.");
  }
  if (bytes.length !== size || bytesToHex_(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes),
  ) !== sha256) {
    throw gatewayApplyError_("attachment_digest_mismatch", "Контрольна сума вкладення не збігається.");
  }
  var header = bytes.slice(0, 16).map(function (value) { return value < 0 ? value + 256 : value; });
  var detected = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
    ? "image/jpeg"
    : header.slice(0, 8).join(",") === "137,80,78,71,13,10,26,10"
      ? "image/png"
      : String.fromCharCode.apply(null, header.slice(0, 4)) === "RIFF" &&
          String.fromCharCode.apply(null, header.slice(8, 12)) === "WEBP"
        ? "image/webp"
        : "";
  if (!detected || detected !== mimeType) {
    throw gatewayApplyError_("attachment_type_mismatch", "Формат фотографії не відповідає її MIME-типу.");
  }
  return {
    key: key,
    name: name,
    mime_type: mimeType,
    bytes_base64: encoded,
    sha256: sha256,
    size: size,
  };
}

function attachmentFingerprint_(attachment) {
  if (!attachment) return null;
  return {
    key: attachment.key,
    name: attachment.name,
    mime_type: attachment.mime_type,
    sha256: attachment.sha256,
    size: attachment.size,
  };
}

function applyGatewayCoverPostCommit_(spreadsheet, input, result, journal, writeTarget) {
  var cover = result && result.cover ? result.cover : noCoverInstruction_();
  if (cover.status !== "dispatch_required" && cover.status !== "attachment_required") return cover;
  if (hasApplyJournalCheckpoint_(journal, "cover_queue")) {
    return journal.plan.cover_queue_result || cover;
  }
  var materialRow = 0;
  (result.mutations || []).some(function (mutation) {
    if (mutation.sheet === "Матеріали") {
      materialRow = Number(mutation.row) || 0;
      return true;
    }
    return false;
  });
  if (!materialRow) throw gatewayApplyError_("cover_material_row_missing", "Не вдалося визначити рядок матеріалу для обкладинки.");
  var attachment = input.attachment ? {
    key: input.attachment.key,
    contentType: input.attachment.mime_type,
    originalName: input.attachment.name,
    byteLength: input.attachment.size,
    sha256: input.attachment.sha256,
    base64: input.attachment.bytes_base64,
  } : null;
  var queued;
  try {
    queued = queueLibrarianCover_(spreadsheet, {
      catId: cover.material_id,
      materialRow: materialRow,
      requestId: input.requestId,
      writeMode: writeTarget.mode,
      overwrite: input.kind === "material.update",
      sourceUrl: cover.source_url || "",
      attachment: attachment,
    });
  } catch (error) {
    throw gatewayRetryableError_(
      error && error.code ? error.code : "cover_queue_failed",
      error && error.message ? error.message : "Не вдалося поставити обкладинку в чергу.",
    );
  }
  var queueResult = {
    status: queued && queued.status ? queued.status : "queued",
    handler: "librarian_cover_bridge",
    mode: queued && queued.sourceKind === "site_photo" ? "private_photo" : "source_url",
    material_id: cover.material_id,
    request_id: input.requestId,
    message: queued && queued.message ? queued.message : "Обкладинку передано на обробку.",
    final_url: queued && queued.finalUrl ? queued.finalUrl : "",
    permanent_url_written: Boolean(queued && queued.status === "completed" && queued.finalUrl),
  };
  journal.plan.cover_queue_result = queueResult;
  checkpointApplyJournal_(journal, "cover_queue");
  return queueResult;
}

function finalizeGatewayResult_(input, result) {
  result = result || {};
  result.kind = input.kind;
  if (!result.summary || typeof result.summary !== "object" || Array.isArray(result.summary)) {
    result.summary = { message: String(result.summary || result.message || "Операцію застосовано.") };
  }
  result.message = String(result.message || result.summary.message || "Операцію застосовано.");
  result.already_applied = result.status === "already_applied";
  result.mutations = Array.isArray(result.mutations) ? result.mutations.map(function (mutation) {
    if (!mutation.key) mutation.key = mutation.entity_id || (mutation.sheet + ":" + mutation.row);
    return mutation;
  }) : [];
  result.entity_ids = result.entity_ids || {};
  result.cover = result.cover || noCoverInstruction_();
  return result;
}

function maybeInjectGatewayTestCrash_(properties, target) {
  if (target.mode !== "copy_test") return;
  if (properties.getProperty("GATEWAY_TEST_FAIL_AFTER_MUTATIONS") !== "once") return;
  properties.deleteProperty("GATEWAY_TEST_FAIL_AFTER_MUTATIONS");
  throw new Error("Injected copy-test crash after domain mutations.");
}

function bytesToHex_(bytes) {
  return bytes.map(function (value) {
    var unsigned = value < 0 ? value + 256 : value;
    return ("0" + unsigned.toString(16)).slice(-2);
  }).join("");
}

function invalidateGatewayPublicCatalogCache_() {
  var cache = CacheService.getScriptCache();
  if (!cache || typeof cache.removeAll !== "function") return;
  var prefix = typeof PUBLIC_CATALOG_CONFIG === "object" && PUBLIC_CATALOG_CONFIG.cachePrefix
    ? PUBLIC_CATALOG_CONFIG.cachePrefix
    : "public-catalog-v2";
  if (
    typeof publicCatalogSpreadsheetId_ === "function" &&
    typeof publicCatalogCachePrefix_ === "function"
  ) {
    try {
      prefix = publicCatalogCachePrefix_(publicCatalogSpreadsheetId_());
    } catch (error) {
      // An invalid public-read target must not make a completed domain write
      // look failed, and we must not guess another sheet's cache namespace.
      return;
    }
  }
  var keys = [prefix + ":meta"];
  try {
    var meta = JSON.parse(cache.get(prefix + ":meta") || "{}");
    var chunks = Math.max(0, Math.min(100, Number(meta.chunks) || 0));
    for (var index = 0; index < chunks; index += 1) keys.push(prefix + ":" + index);
  } catch (error) {
    // Removing metadata alone is enough to make stale chunks unreachable.
  }
  cache.removeAll(keys);
}

function applyAcademicYearCreate_(spreadsheet, payload, journal) {
  validateExactKeys_(payload, ["label", "startDate", "endDate", "notes"]);
  var label = requiredText_(payload.label, 9, "Назва навчального року відсутня.");
  var labelMatch = label.match(/^(20\d{2})\/(20\d{2})$/);
  if (!labelMatch || Number(labelMatch[2]) !== Number(labelMatch[1]) + 1) {
    throw gatewayApplyError_("invalid_academic_year", "Навчальний рік має формат 2026/2027.");
  }
  var startDate = requiredIsoDate_(payload.startDate, "Некоректна дата початку.");
  var endDate = requiredIsoDate_(payload.endDate, "Некоректна дата завершення.");
  if (startDate >= endDate || startDate.slice(0, 4) !== labelMatch[1] ||
      endDate.slice(0, 4) !== labelMatch[2]) {
    throw gatewayApplyError_("invalid_academic_year_dates", "Дати не відповідають навчальному року.");
  }
  var notes = optionalSafeText_(payload.notes, 2000);
  var academicYearId = "YR-" + label.replace("/", "-");
  var sheet = spreadsheet.getSheetByName("Навчальні роки");
  if (!sheet) throw gatewayApplyError_("sheet_not_found", "Не знайдено аркуш «Навчальні роки».");

  var columns = resolveAcademicYearColumns_(sheet);
  var expected = {
    id: academicYearId,
    label: label,
    startDate: startDate,
    endDate: endDate,
    status: "Чернетка",
    notes: notes,
  };
  var existingRow = findAcademicYearRow_(sheet, columns, academicYearId, label);
  if (existingRow) {
    reconcileAcademicYearRow_(spreadsheet, sheet, existingRow, columns, expected, journal);
    SpreadsheetApp.flush();
    verifyAcademicYearRow_(spreadsheet, sheet, existingRow, columns, expected);
    return {
      status: "already_applied",
      message: "Навчальний рік уже був доданий цим запитом.",
      sheet: "Навчальні роки",
      row: existingRow,
      academic_year_id: academicYearId,
      already_applied: true,
    };
  }

  var targetRow = nextAcademicYearRow_(sheet, columns);
  if (targetRow <= (Number(sheet.getMaxRows()) || 0)) {
    preflightAcademicYearTargetRow_(sheet, targetRow, columns);
  }
  markApplyJournalWriteIntent_(journal, "academic_year");
  ensureSheetRowExists_(sheet, targetRow);
  writeAcademicYearRow_(sheet, targetRow, columns, expected);
  SpreadsheetApp.flush();
  verifyAcademicYearRow_(spreadsheet, sheet, targetRow, columns, expected);
  return {
    status: "applied",
    message: "Навчальний рік додано.",
    sheet: "Навчальні роки",
    row: targetRow,
    academic_year_id: academicYearId,
    already_applied: false,
  };
}

function resolveAcademicYearColumns_(sheet) {
  var lastColumn = Math.max(6, Number(sheet.getLastColumn()) || 0);
  if (lastColumn > 100) throw gatewayApplyError_("schema_mismatch", "Забагато колонок у службовому аркуші.");
  var headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  var definitions = {
    id: ["ID навчального року", "ID року"],
    label: ["Навчальний рік"],
    startDate: ["Дата початку"],
    endDate: ["Дата завершення", "Дата закінчення"],
    status: ["Статус"],
    notes: ["Примітка", "Примітки"],
  };
  var result = {};
  Object.keys(definitions).forEach(function (key) {
    var accepted = definitions[key].map(normalizeHeader_);
    headers.forEach(function (header, index) {
      if (accepted.indexOf(normalizeHeader_(header)) !== -1) {
        if (result[key]) {
          throw gatewayApplyError_("schema_mismatch", "Заголовок службового аркуша повторюється.");
        }
        result[key] = index + 1;
      }
    });
    if (!result[key]) {
      throw gatewayApplyError_("schema_mismatch", "Не знайдено обов’язковий заголовок: " + definitions[key][0]);
    }
  });
  var orderedColumns = academicYearFieldKeys_()
    .map(function (key) { return result[key]; })
    .sort(function (left, right) { return left - right; });
  if (orderedColumns.join(",") !== "1,2,3,4,5,6") {
    throw gatewayApplyError_(
      "schema_mismatch",
      "Колонки аркуша «Навчальні роки» мають бути єдиним блоком A:F.",
    );
  }
  return result;
}

function findAcademicYearRow_(sheet, columns, id, label) {
  var lastRow = Number(sheet.getLastRow()) || 0;
  if (lastRow < 2) return 0;
  if (lastRow > 20000) throw gatewayApplyError_("sheet_too_large", "Службовий аркуш перевищує безпечний ліміт.");
  var width = 6;
  var rows = sheet.getRange(2, 1, lastRow - 1, width).getDisplayValues();
  var matches = [];
  rows.forEach(function (row, index) {
    var rowId = String(row[columns.id - 1] || "").trim();
    var rowLabel = String(row[columns.label - 1] || "").trim();
    if (rowId === id || rowLabel === label) matches.push(index + 2);
  });
  if (matches.length > 1) {
    throw gatewayApplyError_("duplicate_academic_year", "У таблиці знайдено дублікати цього навчального року.");
  }
  return matches[0] || 0;
}

function nextAcademicYearRow_(sheet, columns) {
  var lastRow = Number(sheet.getLastRow()) || 1;
  if (lastRow < 2) return 2;
  if (lastRow > 20000) throw gatewayApplyError_("sheet_too_large", "Службовий аркуш перевищує безпечний ліміт.");
  var width = 6;
  var rows = sheet.getRange(2, 1, lastRow - 1, width).getDisplayValues();
  var lastDataRow = 1;
  rows.forEach(function (row, index) {
    var hasData = academicYearFieldKeys_().some(function (key) {
      return String(row[columns[key] - 1] || "").trim() !== "";
    });
    if (hasData) lastDataRow = index + 2;
  });
  return lastDataRow + 1;
}

function ensureSheetRowExists_(sheet, row) {
  var maximum = Number(sheet.getMaxRows()) || 0;
  if (row > maximum) sheet.insertRowsAfter(maximum, row - maximum);
}

function writeAcademicYearRow_(sheet, row, columns, expected) {
  preflightAcademicYearTargetRow_(sheet, row, columns);
  var range = sheet.getRange(row, 1, 1, 6);
  var current = range.getValues()[0];
  var output = current.slice();
  academicYearFieldKeys_().forEach(function (key) {
    output[columns[key] - 1] = key === "startDate" || key === "endDate"
      ? isoDateValue_(expected[key])
      : expected[key];
  });
  range.setValues([output]);
}

function preflightAcademicYearTargetRow_(sheet, row, columns) {
  var range = sheet.getRange(row, 1, 1, 6);
  var current = range.getValues()[0];
  var formulas = range.getFormulas()[0];
  academicYearFieldKeys_().forEach(function (key) {
    var index = columns[key] - 1;
    if (formulas[index]) {
      throw gatewayApplyError_("formula_protected", "Цільова клітинка містить формулу; запис зупинено.");
    }
    if (String(current[index] === null || current[index] === undefined ? "" : current[index]).trim()) {
      throw gatewayApplyError_("target_row_not_empty", "Цільовий рядок уже містить дані; запис зупинено.");
    }
  });
}

function reconcileAcademicYearRow_(spreadsheet, sheet, row, columns, expected, journal) {
  var range = sheet.getRange(row, 1, 1, 6);
  var current = range.getValues()[0];
  var formulas = range.getFormulas()[0];
  var output = current.slice();
  var needsWrite = false;
  academicYearFieldKeys_().forEach(function (key) {
    var index = columns[key] - 1;
    var actual = normalizedAcademicYearCell_(spreadsheet, current[index], key);
    var wanted = String(expected[key]);
    if (actual === wanted) return;
    if (actual !== "") {
      throw gatewayApplyError_("academic_year_conflict", "Навчальний рік уже існує з іншими даними.");
    }
    if (formulas[index]) {
      throw gatewayApplyError_("formula_protected", "Клітинка з формулою не може бути змінена.");
    }
    output[index] = key === "startDate" || key === "endDate"
      ? isoDateValue_(wanted)
      : wanted;
    needsWrite = true;
  });
  if (needsWrite) {
    academicYearFieldKeys_().forEach(function (key) {
      if (formulas[columns[key] - 1]) {
        throw gatewayApplyError_(
          "formula_protected",
          "Рядок містить формулу; часткове доповнення зупинено.",
        );
      }
    });
    markApplyJournalWriteIntent_(journal, "academic_year");
    range.setValues([output]);
  }
}

function verifyAcademicYearRow_(spreadsheet, sheet, row, columns, expected) {
  academicYearFieldKeys_().forEach(function (key) {
    var actual = normalizedAcademicYearCell_(
      spreadsheet,
      sheet.getRange(row, columns[key]).getValue(),
      key,
    );
    if (actual !== String(expected[key])) {
      throw new Error("Google Sheets не підтвердив запис навчального року.");
    }
  });
}

function academicYearFieldKeys_() {
  return ["id", "label", "startDate", "endDate", "status", "notes"];
}

function normalizedAcademicYearCell_(spreadsheet, value, key) {
  if (key === "startDate" || key === "endDate") {
    if (Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value.getTime())) {
      return Utilities.formatDate(value, spreadsheet.getSpreadsheetTimeZone(), "yyyy-MM-dd");
    }
  }
  return String(value === null || value === undefined ? "" : value).trim();
}

function isoDateValue_(value) {
  var parts = String(value).split("-").map(Number);
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12, 0, 0));
}

function requiredIsoDate_(value, message) {
  var text = requiredText_(value, 10, message);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw gatewayApplyError_("invalid_date", message);
  var date = isoDateValue_(text);
  if (isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw gatewayApplyError_("invalid_date", message);
  }
  return text;
}

function requiredText_(value, maximum, message) {
  if (typeof value !== "string") throw gatewayApplyError_("invalid_payload", message);
  var text = value.trim();
  if (!text || text.length > maximum || /^[=+\-@]/.test(text)) {
    throw gatewayApplyError_("invalid_payload", message);
  }
  return text;
}

function optionalSafeText_(value, maximum) {
  if (value === undefined || value === null || value === "") return "";
  return requiredText_(value, maximum, "Некоректна примітка.");
}

function validateExactKeys_(value, allowed) {
  Object.keys(value).forEach(function (key) {
    if (allowed.indexOf(key) === -1) {
      throw gatewayApplyError_("unsupported_payload_field", "Чернетка містить непідтримуване поле.");
    }
  });
}

function normalizeHeader_(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("uk-UA");
}

function gatewayApplyError_(code, message) {
  var error = new Error(message);
  error.gatewayCode = code;
  return error;
}

function gatewayRetryableError_(code, message) {
  var error = gatewayApplyError_(code, message);
  error.gatewayRetryable = true;
  return error;
}

function applyFailure_(input, code, message, retryable, outcomeKnown) {
  return {
    success: false,
    schemaVersion: 1,
    request_id: input.requestId,
    draft_id: input.draftId,
    kind: input.kind,
    code: code,
    error: message,
    retryable: retryable === true,
    outcome_known: outcomeKnown !== false,
  };
}

function readApplyResult_(value) {
  if (!value) return null;
  try {
    var parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || typeof parsed.fingerprint !== "string" ||
        !parsed.response || typeof parsed.response !== "object") return null;
    return parsed;
  } catch (error) {
    return null;
  }
}

function rememberApplyResult_(properties, key, fingerprint, response) {
  var now = Date.now();
  var serialized = JSON.stringify({
    fingerprint: fingerprint,
    response: response,
    storedAt: now,
  });
  var cacheable = gatewayUtf8ByteLength_(serialized) <= LIBRARIAN_GATEWAY_APPLY_CACHE_MAX_BYTES;
  if (cacheable) {
    try {
      properties.setProperty(key, serialized);
    } catch (error) {
      // The durable Sheets journal is authoritative. Script Properties is only
      // a best-effort hot cache and must never turn a committed write into an
      // apparent failure when either the per-value or total quota is full.
      cacheable = false;
      try { properties.deleteProperty(key); } catch (ignored) {}
    }
  } else {
    try { properties.deleteProperty(key); } catch (ignored) {}
  }

  var index;
  try {
    index = JSON.parse(properties.getProperty(LIBRARIAN_GATEWAY_APPLY_INDEX_KEY) || "[]");
  } catch (error) {
    index = [];
  }
  if (!Array.isArray(index)) index = [];
  var cutoff = now - LIBRARIAN_GATEWAY_APPLY_LEDGER_TTL_MS;
  var kept = [];
  index.forEach(function (item) {
    if (!item || typeof item.key !== "string" || !isFinite(Number(item.at))) return;
    if (item.key === key) return;
    if (Number(item.at) < cutoff) {
      properties.deleteProperty(item.key);
      return;
    }
    kept.push({ key: item.key, at: Number(item.at) });
  });
  if (cacheable) kept.push({ key: key, at: now });
  kept.sort(function (left, right) { return left.at - right.at; });
  while (kept.length > LIBRARIAN_GATEWAY_APPLY_LEDGER_LIMIT) {
    properties.deleteProperty(kept.shift().key);
  }
  var serializedIndex = JSON.stringify(kept);
  while (kept.length && gatewayUtf8ByteLength_(serializedIndex) > LIBRARIAN_GATEWAY_APPLY_CACHE_MAX_BYTES) {
    try { properties.deleteProperty(kept.shift().key); } catch (ignored) {}
    serializedIndex = JSON.stringify(kept);
  }
  try {
    properties.setProperty(LIBRARIAN_GATEWAY_APPLY_INDEX_KEY, serializedIndex);
  } catch (ignored) {
    // A missing cache index only reduces hit rate; replay still reads the
    // durable Журнал застосувань and returns the confirmed result.
  }
}

function gatewayUtf8ByteLength_(value) {
  return Utilities.newBlob(String(value || ""), "text/plain", "cache.txt").getBytes().length;
}

function readReferenceRows_(spreadsheet, sheetName, columnCount, mapper) {
  var sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) throw new Error("Не знайдено службовий аркуш: " + sheetName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var range = sheet.getRange(2, 1, Math.min(lastRow - 1, 5000), columnCount);
  var displayRows = range.getDisplayValues();
  var rawRows = range.getValues();
  return displayRows
    .map(function (row, index) {
      return mapper(
        row.map(function (value) { return String(value || "").trim(); }),
        rawRows[index],
      );
    })
    .filter(function (value) { return Boolean(value); });
}

function referenceIsoDate_(spreadsheet, rawValue, displayValue) {
  if (Object.prototype.toString.call(rawValue) === "[object Date]" && !isNaN(rawValue.getTime())) {
    var timezone = typeof spreadsheet.getSpreadsheetTimeZone === "function"
      ? spreadsheet.getSpreadsheetTimeZone()
      : "Europe/Kyiv";
    return Utilities.formatDate(rawValue, timezone || "Europe/Kyiv", "yyyy-MM-dd");
  }
  var text = String(displayValue || rawValue || "").trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  var match = text.match(/^(\d{1,2})[.\/]([01]?\d)[.\/](20\d{2})$/);
  if (match) {
    return match[3] + "-" + String(Number(match[2])).padStart(2, "0") + "-" +
      String(Number(match[1])).padStart(2, "0");
  }
  throw new Error("Некоректний формат дати у службовому довіднику: " + text);
}

function digestWebSafe_(value) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8),
  ).replace(/=+$/, "");
}

function constantTimeEqual_(left, right) {
  if (left.length !== right.length) return false;
  var difference = 0;
  for (var index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function gatewayJson_(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
