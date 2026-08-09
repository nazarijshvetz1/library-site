/**
 * Durable bridge between the private librarian site and library-covers.
 * Secrets are read only from Script Properties; this file contains none.
 */

const LIBRARIAN_SITE_COVERS = Object.freeze({
  journalSheet: 'Журнал обкладинок сайту',
  materialSheet: 'Матеріали',
  coverSheet: 'Обкладинки',
  maxBytes: 900 * 1024,
  maxPendingPerRun: 20,
  pendingTimeoutMs: 24 * 60 * 60 * 1000,
  headers: Object.freeze([
    'request_id',
    'fingerprint',
    'cat_id',
    'material_row',
    'source_kind',
    'state',
    'source_reference',
    'final_url',
    'message',
    'created_at',
    'updated_at',
    'attempt_count',
    'last_checked_at',
    'deadline_at',
  ]),
});


/**
 * Queues a confirmed URL or private site photo after the material row exists.
 * In copy_test the request is fully validated but never sent to GitHub.
 */
function queueLibrarianCover_(spreadsheet, request) {
  const normalized = normalizeLibrarianCoverRequest_(request);
  if (!normalized) return null;

  const journal = ensureLibrarianCoverJournal_(spreadsheet);
  const existing = findLibrarianCoverJournalRow_(journal, normalized.requestId);
  let existingValues = null;
  if (existing) {
    existingValues = journal.getRange(existing, 1, 1, LIBRARIAN_SITE_COVERS.headers.length).getDisplayValues()[0];
    if (existingValues[1] !== normalized.fingerprint) {
      throw librarianCoverError_('cover_request_conflict', 'Цей request_id уже використано для іншої обкладинки.');
    }
    if (existingValues[5] === 'queued') {
      installLibrarianCoverBridgeTrigger_();
      return librarianCoverJournalResult_(existingValues, true);
    }
    if (['copy_test_validated', 'completed'].indexOf(existingValues[5]) >= 0) {
      return librarianCoverJournalResult_(existingValues, true);
    }
  }

  const now = new Date().toISOString();
  const row = existing || nextLibrarianCoverJournalRow_(journal);
  if (!existing) {
    journal.getRange(row, 1, 1, LIBRARIAN_SITE_COVERS.headers.length).setValues([[
      normalized.requestId,
      normalized.fingerprint,
      normalized.catId,
      normalized.materialRow,
      normalized.sourceKind,
      'prepared',
      safeLibrarianSheetLiteral_(normalized.sourceReference, 2048),
      '',
      '',
      now,
      now,
      0,
      '',
      librarianCoverDeadline_(now),
    ]]);
  } else {
    journal.getRange(row, 4).setValue(normalized.materialRow);
    journal.getRange(row, 6, 1, 9).setValues([[
      'prepared',
      safeLibrarianSheetLiteral_(normalized.sourceReference, 2048),
      '',
      '',
      valuesOrNow_(existingValues && existingValues[9], now),
      now,
      0,
      '',
      librarianCoverDeadline_(now),
    ]]);
  }
  SpreadsheetApp.flush();

  if (normalized.writeMode === 'copy_test') {
    updateLibrarianCoverJournal_(journal, row, 'copy_test_validated', '', 'Фото перевірено на копії; запит до GitHub не надсилався.');
    return librarianCoverJournalResult_(
      journal.getRange(row, 1, 1, LIBRARIAN_SITE_COVERS.headers.length).getDisplayValues()[0],
      false
    );
  }

  try {
    if (normalized.sourceKind === 'site_photo') {
      const stored = putLibrarianSitePhotoCover_(normalized);
      const applied = applyLibrarianCoverToSheets_(
        spreadsheet,
        normalized.catId,
        normalized.materialRow,
        stored.finalUrl
      );
      journal.getRange(row, 4).setValue(applied.materialRow);
      updateLibrarianCoverJournal_(
        journal,
        row,
        'completed',
        stored.finalUrl,
        stored.alreadyApplied ? 'Обкладинка вже була збережена; постійне посилання підтверджено.' : 'Обкладинку додано.'
      );
    } else {
      // Persist the in-flight state before the irreversible dispatch. A hard
      // stop after GitHub accepts the request can therefore never cause an
      // automatic retry to dispatch the same request a second time.
      updateLibrarianCoverJournal_(journal, row, 'queued', '', 'Запит підготовлено; очікуємо результат обробки.');
      SpreadsheetApp.flush();
      installLibrarianCoverBridgeTrigger_();
      try {
        dispatchLibrarianCoverUrl_(normalized);
        updateLibrarianCoverJournal_(journal, row, 'queued', '', 'Обкладинку надіслано на безпечну обробку.');
      } catch (dispatchError) {
        if (!dispatchError || !dispatchError.code) {
          updateLibrarianCoverJournal_(
            journal,
            row,
            'queued',
            '',
            'GitHub міг прийняти запит, але відповідь не підтверджена. Повторне надсилання заблоковано; результат буде перевірено автоматично.'
          );
          return librarianCoverJournalResult_(
            journal.getRange(row, 1, 1, LIBRARIAN_SITE_COVERS.headers.length).getDisplayValues()[0],
            false
          );
        }
        throw dispatchError;
      }
    }
  } catch (error) {
    updateLibrarianCoverJournal_(
      journal,
      row,
      'enqueue_failed',
      '',
      String(error && error.message ? error.message : error).slice(0, 500)
    );
    throw error;
  }
  return librarianCoverJournalResult_(
    journal.getRange(row, 1, 1, LIBRARIAN_SITE_COVERS.headers.length).getDisplayValues()[0],
    false
  );
}


/** Completes queued site-cover jobs without requiring the write window to remain open. */
function checkLibrarianSiteCoverJobs() {
  const properties = PropertiesService.getScriptProperties();
  const spreadsheetId = String(properties.getProperty('SPREADSHEET_ID') || '').trim();
  if (!/^[A-Za-z0-9_-]{20,}$/.test(spreadsheetId)) return;
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  const journal = spreadsheet.getSheetByName(LIBRARIAN_SITE_COVERS.journalSheet);
  if (!journal || journal.getLastRow() < 2) return;

  const values = journal
    .getRange(2, 1, journal.getLastRow() - 1, LIBRARIAN_SITE_COVERS.headers.length)
    .getDisplayValues();
  let checked = 0;
  values.forEach(function (rowValues, offset) {
    if (rowValues[5] !== 'queued' || checked >= LIBRARIAN_SITE_COVERS.maxPendingPerRun) return;
    checked += 1;
    const row = offset + 2;
    const checkedAt = new Date().toISOString();
    const attemptCount = Math.max(0, Number(rowValues[11]) || 0) + 1;
    const deadlineAt = validLibrarianCoverDeadline_(rowValues[13])
      ? String(rowValues[13])
      : librarianCoverDeadline_(valuesOrNow_(rowValues[9], checkedAt));
    try {
      updateLibrarianCoverPolling_(journal, row, attemptCount, checkedAt, deadlineAt);
      if (Date.now() >= Date.parse(deadlineAt)) {
        updateLibrarianCoverJournal_(
          journal,
          row,
          'timed_out',
          '',
          'Час очікування обробки обкладинки минув. Запит можна безпечно повторити.'
        );
        return;
      }
      const result = fetchLibrarianCoverRequestResult_(rowValues[0]);
      if (!result) return;
      if (
        String(result.request_id || '') !== rowValues[0] ||
        String(result.cat_id || '') !== rowValues[2]
      ) {
        updateLibrarianCoverJournal_(journal, row, 'result_conflict', '', 'GitHub повернув результат для іншого запиту.');
        return;
      }
      if (result.success === true && ['completed', 'already_applied', 'already_exists'].indexOf(String(result.status || '')) >= 0) {
        const finalUrl = String(result.final_url || '').trim();
        const expectedUrl = librarianCoverFinalUrl_(rowValues[2]);
        if (finalUrl !== expectedUrl) {
          updateLibrarianCoverJournal_(journal, row, 'result_conflict', '', 'GitHub повернув неочікуване постійне посилання.');
          return;
        }
        const applied = applyLibrarianCoverToSheets_(spreadsheet, rowValues[2], Number(rowValues[3]), finalUrl);
        journal.getRange(row, 4).setValue(applied.materialRow);
        updateLibrarianCoverJournal_(journal, row, 'completed', finalUrl, String(result.message || 'Обкладинку додано.'));
        return;
      }
      updateLibrarianCoverJournal_(
        journal,
        row,
        'failed',
        '',
        String(result.message || result.status || 'Помилка обробки обкладинки.')
      );
    } catch (error) {
      try {
        updateLibrarianCoverJournal_(
          journal,
          row,
          'queued',
          '',
          'Тимчасова помилка перевірки: ' + String(error && error.message ? error.message : error)
        );
      } catch (ignored) {
        // One damaged journal row must not prevent the next queued row from being checked.
      }
    }
  });
}


function installLibrarianCoverBridgeTrigger_() {
  const handler = 'checkLibrarianSiteCoverJobs';
  const exists = ScriptApp.getProjectTriggers().some(function (trigger) {
    return trigger.getHandlerFunction() === handler;
  });
  if (!exists) ScriptApp.newTrigger(handler).timeBased().everyMinutes(5).create();
}


function normalizeLibrarianCoverRequest_(request) {
  if (!request || typeof request !== 'object') return null;
  const sourceUrl = String(request.sourceUrl || '').trim();
  const attachment = request.attachment && typeof request.attachment === 'object'
    ? request.attachment
    : null;
  if (!sourceUrl && !attachment) return null;
  if (sourceUrl && attachment) {
    throw librarianCoverError_('cover_source_conflict', 'Оберіть посилання або фотографію, але не обидва джерела.');
  }

  const catId = String(request.catId || '').trim().toUpperCase();
  const requestId = String(request.requestId || '').trim().toLowerCase();
  const materialRow = Number(request.materialRow);
  const writeMode = String(request.writeMode || '').trim();
  const overwrite = request.overwrite === true;
  if (!/^CAT-\d{4,}$/.test(catId)) throw librarianCoverError_('invalid_cat_id', 'Некоректний CAT-ID обкладинки.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) {
    throw librarianCoverError_('invalid_request_id', 'Некоректний request_id обкладинки.');
  }
  if (!Number.isInteger(materialRow) || materialRow < 2) {
    throw librarianCoverError_('invalid_material_row', 'Некоректний рядок матеріалу.');
  }
  if (writeMode !== 'copy_test' && writeMode !== 'production') {
    throw librarianCoverError_('write_mode_disabled', 'Режим запису обкладинки вимкнено.');
  }

  let sourceKind;
  let sourceReference;
  let photoBase64 = '';
  let photoSha256 = '';
  if (attachment) {
    photoBase64 = String(attachment.base64 || '').replace(/\s/g, '');
    photoSha256 = String(attachment.sha256 || '').trim().toLowerCase();
    validateLibrarianCoverAttachment_(attachment, photoBase64, photoSha256);
    sourceKind = 'site_photo';
    sourceReference = 'sha256:' + photoSha256;
  } else {
    if (!/^https?:\/\/[^\s]+$/i.test(sourceUrl) || sourceUrl.length > 2048 || /[\u0000-\u001f\u007f]/.test(sourceUrl)) {
      throw librarianCoverError_('invalid_cover_url', 'Некоректне HTTP(S)-посилання на обкладинку.');
    }
    sourceKind = 'url';
    sourceReference = sourceUrl;
  }

  const fingerprint = librarianCoverDigest_(JSON.stringify({
    catId: catId,
    requestId: requestId,
    writeMode: writeMode,
    overwrite: overwrite,
    sourceKind: sourceKind,
    sourceReference: sourceReference,
  }));
  return {
    catId: catId,
    requestId: requestId,
    materialRow: materialRow,
    writeMode: writeMode,
    overwrite: overwrite,
    sourceKind: sourceKind,
    sourceReference: sourceReference,
    sourceUrl: sourceUrl,
    photoBase64: photoBase64,
    photoSha256: photoSha256,
    fingerprint: fingerprint,
  };
}


function validateLibrarianCoverAttachment_(attachment, compactBase64, expectedSha256) {
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw librarianCoverError_('invalid_cover_hash', 'Некоректний SHA-256 фотографії.');
  }
  if (!compactBase64 || compactBase64.length > 4 * Math.ceil(LIBRARIAN_SITE_COVERS.maxBytes / 3)) {
    throw librarianCoverError_('cover_too_large', 'Підготовлена фотографія перевищує дозволений безпечний розмір.');
  }
  if (
    compactBase64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compactBase64)
  ) {
    throw librarianCoverError_('invalid_cover_base64', 'Некоректні дані фотографії.');
  }
  let bytes;
  try {
    bytes = Utilities.base64Decode(compactBase64);
  } catch (error) {
    throw librarianCoverError_('invalid_cover_base64', 'Некоректні дані фотографії.');
  }
  if (!bytes.length || bytes.length > LIBRARIAN_SITE_COVERS.maxBytes) {
    throw librarianCoverError_('cover_too_large', 'Підготовлена фотографія перевищує дозволений безпечний розмір.');
  }
  const declaredLength = Number(attachment.byteLength);
  if (!Number.isInteger(declaredLength) || declaredLength !== bytes.length) {
    throw librarianCoverError_('cover_length_mismatch', 'Розмір фотографії не збігається з підписаними даними.');
  }
  const header = bytes.slice(0, 16).map(function (value) { return value < 0 ? value + 256 : value; });
  const isJpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  if (!isJpeg) {
    throw librarianCoverError_('cover_not_normalized', 'Фото має бути підготовлене браузером як фінальний JPEG.');
  }
  if (String(attachment.contentType || '').trim().toLowerCase() !== 'image/jpeg') {
    throw librarianCoverError_('cover_content_type_mismatch', 'Тип фотографії не збігається з її вмістом.');
  }
  const actualSha256 = librarianCoverHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes));
  if (actualSha256 !== expectedSha256) {
    throw librarianCoverError_('cover_hash_mismatch', 'Контрольна сума фотографії не збігається.');
  }
}


function putLibrarianSitePhotoCover_(request) {
  const config = librarianCoverGitHubConfig_();
  const path = 'covers/' + request.catId + '.jpg';
  const url = 'https://api.github.com/repos/' + encodeURIComponent(config.owner) + '/' +
    encodeURIComponent(config.repo) + '/contents/' + path.split('/').map(encodeURIComponent).join('/');
  const expectedBlobSha = librarianCoverGitBlobSha_(request.photoBase64);
  const existing = UrlFetchApp.fetch(url + '?ref=main', {
    method: 'get',
    muteHttpExceptions: true,
    headers: librarianCoverGitHubHeaders_(config.token),
  });
  let existingSha = '';
  if (existing.getResponseCode() === 200) {
    const envelope = parseLibrarianGitHubEnvelope_(existing);
    existingSha = String(envelope.sha || '').trim().toLowerCase();
    if (
      String(envelope.path || '') !== path ||
      String(envelope.type || '') !== 'file' ||
      !/^[0-9a-f]{40}$/.test(existingSha)
    ) {
      throw librarianCoverError_('github_verify_failed', 'GitHub повернув неочікуваний запис для постійної обкладинки.');
    }
    if (existingSha === expectedBlobSha) {
      return { finalUrl: librarianCoverFinalUrl_(request.catId), alreadyApplied: true };
    }
    if (!request.overwrite) {
      throw librarianCoverError_('cover_already_exists', 'Файл обкладинки вже існує. Для заміни потрібне явне підтвердження перезапису.');
    }
  } else if (existing.getResponseCode() !== 404) {
    throw librarianCoverError_('github_unavailable', 'GitHub не підтвердив стан постійної обкладинки. HTTP ' + existing.getResponseCode());
  }

  const payload = {
    message: (existingSha ? 'Replace cover ' : 'Add cover ') + request.catId,
    content: request.photoBase64,
    branch: 'main',
  };
  if (existingSha) payload.sha = existingSha;
  const response = UrlFetchApp.fetch(url, {
    method: 'put',
    muteHttpExceptions: true,
    contentType: 'application/json',
    headers: librarianCoverGitHubHeaders_(config.token),
    payload: JSON.stringify(payload),
  });
  if ([200, 201].indexOf(response.getResponseCode()) < 0) {
    throw librarianCoverError_('github_cover_write_failed', 'GitHub не зберіг фінальну обкладинку. HTTP ' + response.getResponseCode());
  }
  const written = parseLibrarianGitHubEnvelope_(response);
  if (
    !written.content ||
    String(written.content.path || '') !== path ||
    String(written.content.sha || '').trim().toLowerCase() !== expectedBlobSha
  ) {
    throw librarianCoverError_('github_verify_failed', 'GitHub не підтвердив вміст збереженої обкладинки.');
  }

  const verification = UrlFetchApp.fetch(url + '?ref=main', {
    method: 'get',
    muteHttpExceptions: true,
    headers: librarianCoverGitHubHeaders_(config.token),
  });
  if (verification.getResponseCode() !== 200) {
    throw librarianCoverError_('github_verify_failed', 'Не вдалося повторно перевірити постійну обкладинку. HTTP ' + verification.getResponseCode());
  }
  const verified = parseLibrarianGitHubEnvelope_(verification);
  if (
    String(verified.path || '') !== path ||
    String(verified.type || '') !== 'file' ||
    String(verified.sha || '').trim().toLowerCase() !== expectedBlobSha
  ) {
    throw librarianCoverError_('github_verify_failed', 'Повторна перевірка постійної обкладинки не збіглася із завантаженим JPEG.');
  }
  return { finalUrl: librarianCoverFinalUrl_(request.catId), alreadyApplied: false };
}


function dispatchLibrarianCoverUrl_(request) {
  const config = librarianCoverGitHubConfig_();
  const url = 'https://api.github.com/repos/' + encodeURIComponent(config.owner) + '/' +
    encodeURIComponent(config.repo) + '/dispatches';
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    muteHttpExceptions: true,
    contentType: 'application/json',
    headers: librarianCoverGitHubHeaders_(config.token),
    payload: JSON.stringify({
      event_type: 'cover_ingest',
      client_payload: {
        cat_id: request.catId,
        source_url: request.sourceUrl,
        request_id: request.requestId,
        overwrite: request.overwrite,
        mode: 'commit',
        dry_run: false,
      },
    }),
  });
  if (response.getResponseCode() !== 204) {
    throw librarianCoverError_('github_enqueue_failed', 'GitHub не прийняв посилання. HTTP ' + response.getResponseCode());
  }
}


function fetchLibrarianCoverRequestResult_(requestId) {
  const config = librarianCoverGitHubConfig_();
  const path = 'cover-status/requests/' + encodeURIComponent(requestId) + '.json';
  const url = 'https://api.github.com/repos/' + encodeURIComponent(config.owner) + '/' +
    encodeURIComponent(config.repo) + '/contents/' + path + '?ref=main';
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    headers: librarianCoverGitHubHeaders_(config.token),
  });
  if (response.getResponseCode() === 404) return null;
  if (response.getResponseCode() !== 200) return null;
  try {
    const envelope = JSON.parse(response.getContentText());
    const decoded = Utilities.newBlob(
      Utilities.base64Decode(String(envelope.content || '').replace(/\s/g, ''))
    ).getDataAsString('UTF-8');
    return JSON.parse(decoded);
  } catch (error) {
    return null;
  }
}


function applyLibrarianCoverToSheets_(spreadsheet, catId, expectedMaterialRow, finalUrl) {
  if (finalUrl !== librarianCoverFinalUrl_(catId)) {
    throw librarianCoverError_('invalid_final_cover_url', 'Некоректне постійне посилання обкладинки.');
  }
  const materials = spreadsheet.getSheetByName(LIBRARIAN_SITE_COVERS.materialSheet);
  const covers = spreadsheet.getSheetByName(LIBRARIAN_SITE_COVERS.coverSheet);
  if (!materials || !covers) throw librarianCoverError_('sheet_missing', 'Не знайдено аркуш матеріалів або обкладинок.');

  const materialMatches = materials.getRange(2, 1, Math.max(1, materials.getMaxRows() - 1), 1)
    .createTextFinder(catId).matchEntireCell(true).matchCase(true).findAll();
  if (!materialMatches.length) {
    throw librarianCoverError_('material_not_found', 'Матеріал для обкладинки не знайдено.');
  }
  if (materialMatches.length !== 1) {
    throw librarianCoverError_('material_id_ambiguous', 'CAT-ID матеріалу дублюється; обкладинку не записано.');
  }
  // CAT-ID is authoritative. A user may sort the sheet while a URL workflow is
  // running, so the row stored in the journal is only a hint.
  const authoritativeMaterialRow = materialMatches[0].getRow();
  const headers = materials.getRange(1, 1, 1, materials.getLastColumn()).getDisplayValues()[0];
  const coverFlagColumns = [];
  headers.forEach(function (header, index) {
    if (String(header || '').trim() === 'Обкладинка') coverFlagColumns.push(index + 1);
  });
  if (coverFlagColumns.length !== 1) {
    throw librarianCoverError_('schema_mismatch', 'Колонка «Обкладинка» відсутня або дублюється.');
  }
  const coverFlagColumn = coverFlagColumns[0];
  const coverFlagCell = materials.getRange(authoritativeMaterialRow, coverFlagColumn);
  if (coverFlagCell.getFormula()) {
    throw librarianCoverError_('cover_flag_formula_conflict', 'Колонка «Обкладинка» містить службову формулу; запис зупинено.');
  }

  const coverSearchRange = covers.getRange(2, 1, Math.max(1, covers.getMaxRows() - 1), 1);
  const coverMatches = coverSearchRange
    .createTextFinder(catId).matchEntireCell(true).matchCase(true).findAll();
  if (coverMatches.length > 1) {
    throw librarianCoverError_('cover_id_ambiguous', 'CAT-ID дублюється в аркуші «Обкладинки»; запис зупинено.');
  }

  let coverRow = coverMatches.length ? coverMatches[0].getRow() : 0;
  let insertCoverRow = false;
  let writeCoverId = false;
  if (!coverRow) {
    const candidateRange = covers.getRange(2, 1, Math.max(1, covers.getMaxRows() - 1), 3);
    const candidateValues = candidateRange.getDisplayValues();
    const candidateFormulas = candidateRange.getFormulas();
    const emptyOffset = candidateValues.findIndex(function (row, index) {
      return row.every(function (value) { return !String(value || '').trim(); }) &&
        candidateFormulas[index].every(function (formula) { return !String(formula || '').trim(); });
    });
    if (emptyOffset < 0) {
      coverRow = covers.getMaxRows() + 1;
      insertCoverRow = true;
    } else {
      coverRow = emptyOffset + 2;
    }
    writeCoverId = true;
  }

  if (!insertCoverRow) {
    const coverCells = covers.getRange(coverRow, 1, 1, 3);
    const coverValues = coverCells.getDisplayValues()[0];
    const coverFormulas = coverCells.getFormulas()[0];
    if (writeCoverId) {
      if (coverValues.some(function (value) { return String(value || '').trim(); }) ||
          coverFormulas.some(function (formula) { return String(formula || '').trim(); })) {
        throw librarianCoverError_('cover_row_conflict', 'Вільний рядок обкладинки містить дані або формули.');
      }
    } else {
      if (String(coverValues[0] || '').trim() !== catId) {
        throw librarianCoverError_('cover_row_conflict', 'Рядок обкладинки належить іншому матеріалу.');
      }
      if (coverFormulas[2]) {
        throw librarianCoverError_('cover_url_formula_conflict', 'URL обкладинки не може бути формулою.');
      }
    }
  }

  const expectedFormula = '=IF(A' + coverRow + '="";"";IFERROR(IMAGE("' + finalUrl + '");"Фото відсутнє"))';
  if (insertCoverRow) covers.insertRowAfter(covers.getMaxRows());
  if (writeCoverId) covers.getRange(coverRow, 1).setValue(catId);
  covers.getRange(coverRow, 2).setFormula(expectedFormula);
  covers.getRange(coverRow, 3).setValue(finalUrl);
  SpreadsheetApp.flush();
  const writtenCoverValues = covers.getRange(coverRow, 1, 1, 3).getDisplayValues()[0];
  const writtenCoverFormulas = covers.getRange(coverRow, 1, 1, 3).getFormulas()[0];
  if (
    String(writtenCoverValues[0] || '').trim() !== catId ||
    String(writtenCoverValues[2] || '').trim() !== finalUrl ||
    writtenCoverFormulas[1] !== expectedFormula
  ) {
    throw librarianCoverError_('cover_verify_failed', 'Не вдалося підтвердити рядок у аркуші «Обкладинки».');
  }

  coverFlagCell.setValue('Так');
  SpreadsheetApp.flush();
  if (String(coverFlagCell.getDisplayValue()).trim() !== 'Так') {
    throw librarianCoverError_('cover_flag_verify_failed', 'Не вдалося підтвердити ознаку обкладинки в аркуші «Матеріали».');
  }
  return { materialRow: authoritativeMaterialRow, coverRow: coverRow };
}


function ensureLibrarianCoverJournal_(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(LIBRARIAN_SITE_COVERS.journalSheet);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(LIBRARIAN_SITE_COVERS.journalSheet);
    sheet.setFrozenRows(1);
    sheet.hideSheet();
  }
  if (
    typeof sheet.getMaxColumns === 'function' &&
    sheet.getMaxColumns() < LIBRARIAN_SITE_COVERS.headers.length
  ) {
    sheet.insertColumnsAfter(
      sheet.getMaxColumns(),
      LIBRARIAN_SITE_COVERS.headers.length - sheet.getMaxColumns()
    );
  }
  const headers = sheet.getRange(1, 1, 1, LIBRARIAN_SITE_COVERS.headers.length).getDisplayValues()[0];
  LIBRARIAN_SITE_COVERS.headers.forEach(function (expected, index) {
    const actual = String(headers[index] || '').trim();
    if (actual && actual !== expected) {
      throw librarianCoverError_('cover_journal_schema_mismatch', 'Структура журналу обкладинок не збігається.');
    }
    if (!actual) sheet.getRange(1, index + 1).setValue(expected).setFontWeight('bold');
  });
  migrateLibrarianCoverJournalRows_(sheet);
  return sheet;
}


function migrateLibrarianCoverJournalRows_(sheet) {
  if (sheet.getLastRow() < 2) return;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, LIBRARIAN_SITE_COVERS.headers.length)
    .getDisplayValues();
  rows.forEach(function (values, offset) {
    const row = offset + 2;
    if (!String(values[11] || '').trim()) sheet.getRange(row, 12).setValue(0);
    if (values[5] === 'queued' && !validLibrarianCoverDeadline_(values[13])) {
      sheet.getRange(row, 14).setValue(librarianCoverDeadline_(valuesOrNow_(values[9], new Date().toISOString())));
    }
  });
}


function findLibrarianCoverJournalRow_(sheet, requestId) {
  if (sheet.getLastRow() < 2) return 0;
  const match = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1)
    .createTextFinder(requestId).matchEntireCell(true).matchCase(true).findNext();
  return match ? match.getRow() : 0;
}


function nextLibrarianCoverJournalRow_(sheet) {
  return Math.max(2, sheet.getLastRow() + 1);
}


function updateLibrarianCoverJournal_(sheet, row, state, finalUrl, message) {
  sheet.getRange(row, 6, 1, 6).setValues([[
    state,
    sheet.getRange(row, 7).getDisplayValue(),
    finalUrl || '',
    safeLibrarianSheetLiteral_(message, 500),
    sheet.getRange(row, 10).getDisplayValue() || new Date().toISOString(),
    new Date().toISOString(),
  ]]);
}


function updateLibrarianCoverPolling_(sheet, row, attemptCount, checkedAt, deadlineAt) {
  sheet.getRange(row, 12, 1, 3).setValues([[
    Math.max(0, Math.floor(Number(attemptCount) || 0)),
    checkedAt,
    deadlineAt,
  ]]);
}


function librarianCoverDeadline_(fromValue) {
  const parsed = Date.parse(String(fromValue || ''));
  const base = Number.isFinite(parsed) ? parsed : Date.now();
  return new Date(base + LIBRARIAN_SITE_COVERS.pendingTimeoutMs).toISOString();
}


function validLibrarianCoverDeadline_(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}T/.test(text) && Number.isFinite(Date.parse(text));
}


function safeLibrarianSheetLiteral_(value, maximumLength) {
  const limit = Math.max(1, Number(maximumLength) || 500);
  let text = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, limit);
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  return text;
}


function librarianCoverJournalResult_(values, idempotent) {
  return {
    requestId: values[0],
    catId: values[2],
    materialRow: Number(values[3]) || null,
    sourceKind: values[4],
    status: values[5],
    finalUrl: values[7] || '',
    message: values[8] || '',
    idempotent: idempotent === true,
  };
}


function librarianCoverGitHubConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const owner = String(properties.getProperty('GITHUB_OWNER') || 'nazarijshvetz1').trim();
  const repo = String(properties.getProperty('GITHUB_REPO') || 'library-covers').trim();
  const token = String(properties.getProperty('GITHUB_TOKEN') || '').trim();
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) || token.length < 20) {
    throw librarianCoverError_('github_not_configured', 'GitHub для обкладинок не налаштований.');
  }
  return { owner: owner, repo: repo, token: token };
}


function librarianCoverGitHubHeaders_(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: 'Bearer ' + token,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}


function parseLibrarianGitHubEnvelope_(response) {
  try {
    const parsed = JSON.parse(response.getContentText());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid envelope');
    return parsed;
  } catch (error) {
    throw librarianCoverError_('github_invalid_response', 'GitHub повернув некоректну відповідь.');
  }
}


function librarianCoverGitBlobSha_(base64Value) {
  const bytes = Utilities.base64Decode(String(base64Value || '').replace(/\s/g, ''));
  const prefix = Utilities.newBlob('blob ' + bytes.length + '\u0000', 'text/plain').getBytes();
  return librarianCoverHex_(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_1,
    prefix.concat(bytes)
  ));
}


function librarianCoverFinalUrl_(catId) {
  const config = librarianCoverGitHubConfig_();
  return 'https://raw.githubusercontent.com/' + encodeURIComponent(config.owner) + '/' +
    encodeURIComponent(config.repo) + '/main/covers/' + catId + '.jpg';
}


function librarianCoverDigest_(value) {
  return librarianCoverHex_(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    Utilities.newBlob(String(value), 'text/plain').getBytes()
  ));
}


function librarianCoverHex_(bytes) {
  return bytes.map(function (value) {
    const unsigned = value < 0 ? value + 256 : value;
    return ('0' + unsigned.toString(16)).slice(-2);
  }).join('');
}


function valuesOrNow_(value, fallback) {
  return String(value || '').trim() || fallback;
}


function librarianCoverError_(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
