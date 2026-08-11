#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { stableStringify } from "./import-library-core.mjs";

const PLAN_FORMAT = "library-d1-load-plan";
const PLAN_VERSION = 1;
const STAGING_FORMAT = "library-d1-staging";
const STAGING_VERSION = 1;
const TARGET_SCHEMA = "0003";
const MAX_INSERT_SQL_BYTES = 72_000;

const REQUIRED_STAGING_TABLES = Object.freeze([
  "materials",
  "material_links",
  "cover_assets",
  "locations",
  "users",
  "opening_stock",
  "operations",
  "revision_checks",
  "stock_balances",
]);

const TABLE_SPECS = Object.freeze([
  tableSpec("locations", [
    "id", "name", "type", "status", "is_public", "sort_order", "created_at", "updated_at",
  ], ["id"], [["name"]]),
  tableSpec("users", [
    "id", "full_name", "sort_name", "email", "auth_user_id", "role", "status", "created_at", "updated_at",
  ], ["id"], [["email"], ["auth_user_id"]]),
  tableSpec("materials", [
    "id", "catalog_number", "title", "sort_title", "search_text", "rubric", "publication_type", "subject",
    "class_from", "class_to", "author", "publication_year", "isbn", "isbn_normalized", "publisher", "notes",
    "status", "version", "created_at", "updated_at", "archived_at",
  ], ["id"], [["catalog_number"]]),
  tableSpec("material_links", [
    "id", "material_id", "kind", "label", "url", "is_public", "sort_order", "status", "created_at", "updated_at",
  ], ["id"], [["material_id", "url"]]),
  tableSpec("material_cover_assets", [
    "id", "material_id", "storage_provider", "storage_key", "external_url", "mime_type", "byte_length", "width",
    "height", "sha256", "status", "version", "created_at", "updated_at",
  ], ["id"], [["material_id"], ["storage_key"]]),
  tableSpec("inventory_transactions", [
    "id", "request_id", "kind", "occurred_at", "document_number", "reason", "notes", "loan_id", "actor_user_id",
    "reversal_of_id", "status", "created_at",
  ], ["id"], [["request_id"], ["reversal_of_id"]]),
  tableSpec("inventory_transaction_lines", [
    "id", "transaction_id", "material_id", "location_id", "condition", "quantity_delta", "quantity_before",
    "quantity_after", "counted_quantity", "loan_item_id", "created_at",
  ], ["id"]),
  tableSpec("holdings", [
    "material_id", "location_id", "condition", "quantity", "version", "updated_at",
  ], ["material_id", "location_id", "condition"]),
  tableSpec("material_stock_totals", [
    "material_id", "total_quantity", "library_quantity", "other_location_quantity", "loaned_quantity", "updated_at",
  ], ["material_id"]),
  tableSpec("audit_events", [
    "id", "actor_user_id", "actor_email", "action", "entity_type", "entity_id", "request_id", "before_json",
    "after_json", "metadata_json", "created_at",
  ], ["id"]),
]);

class LoadDiagnostics {
  constructor() {
    this.errors = [];
    this.warnings = [];
  }

  error(code, location, message, details = undefined) {
    this.errors.push(diagnostic(code, location, message, details));
  }

  warning(code, location, message, details = undefined) {
    this.warnings.push(diagnostic(code, location, message, details));
  }

  finish() {
    const compare = (left, right) => stableStringify(left).localeCompare(stableStringify(right), "uk");
    this.errors.sort(compare);
    this.warnings.sort(compare);
    return { errors: this.errors, warnings: this.warnings };
  }
}

function diagnostic(code, location, message, details) {
  const value = { code, location, message };
  if (details !== undefined) value.details = details;
  return value;
}

function tableSpec(name, columns, primaryKey, uniqueKeys = []) {
  return Object.freeze({ name, columns: Object.freeze(columns), primaryKey: Object.freeze(primaryKey), uniqueKeys: Object.freeze(uniqueKeys) });
}

export function buildD1LoadPlan(bundle, options = {}) {
  const diagnostics = new LoadDiagnostics();
  const staging = validateStagingBundle(bundle, diagnostics);
  const importedAt = normalizeImportedAt(bundle?.source?.exported_at, diagnostics);
  const sourceHash = sha256(stableStringify(bundle));

  const locations = staging.locations.map((row, index) => mapLocation(row, index, importedAt, diagnostics));
  const users = staging.users.map((row, index) => mapUser(row, index, importedAt, diagnostics));
  const materials = staging.materials.map((row, index) => mapMaterial(row, index, importedAt, diagnostics));

  const locationById = uniqueMap(locations, "id", "target_location_duplicate", "locations", diagnostics);
  const userById = uniqueMap(users, "id", "target_user_duplicate", "users", diagnostics);
  const materialById = uniqueMap(materials, "id", "target_material_duplicate", "materials", diagnostics);

  const links = staging.material_links.map((row, index) => mapLink(row, index, importedAt, materialById, diagnostics));
  const covers = staging.cover_assets.map((row, index) => mapCover(row, index, importedAt, materialById, diagnostics));
  const migrationActor = chooseMigrationActor(users, staging.users, diagnostics);

  const ledger = new Map();
  const inventoryTransactions = [];
  const inventoryLines = [];
  const revisionByOperation = new Map();
  for (const revision of staging.revision_checks) {
    if (revision?.operation_id) revisionByOperation.set(String(revision.operation_id), revision);
  }

  for (const [index, row] of sortedBy(staging.opening_stock, "opening_stock_id").entries()) {
    addOpeningStock({
      row,
      index,
      importedAt,
      migrationActor,
      materialById,
      locationById,
      ledger,
      transactions: inventoryTransactions,
      lines: inventoryLines,
      diagnostics,
    });
  }

  const skippedOperations = [];
  const legacyOperationAudits = [];
  for (const [index, row] of sortedBy(staging.operations, "operation_id").entries()) {
    if (row?.status !== "confirmed") {
      skippedOperations.push({ operation_id: stringOrNull(row?.operation_id), status: stringOrNull(row?.status) });
      legacyOperationAudits.push(mapSkippedOperationAudit(row, index, importedAt, migrationActor, userById, diagnostics));
      continue;
    }
    addConfirmedOperation({
      row,
      index,
      importedAt,
      materialById,
      locationById,
      userById,
      revision: revisionByOperation.get(String(row?.operation_id)),
      ledger,
      transactions: inventoryTransactions,
      lines: inventoryLines,
      diagnostics,
    });
  }

  validateLedgerAgainstStaging(ledger, staging.stock_balances, diagnostics);
  const { holdings, serviceExcluded } = buildHoldings(ledger, locationById, importedAt, diagnostics);
  const stockTotals = buildStockTotals(materials, holdings, locationById, importedAt);
  const revisionAudits = staging.revision_checks.map((row, index) => mapRevisionAudit(
    row,
    index,
    importedAt,
    migrationActor,
    userById,
    new Map(inventoryTransactions.map((transaction) => [transaction.id, transaction])),
    diagnostics,
  ));

  const tables = {
    locations: sortTargetRows(locations, ["id"]),
    users: sortTargetRows(users, ["id"]),
    materials: sortTargetRows(materials, ["id"]),
    material_links: sortTargetRows(links, ["id"]),
    material_cover_assets: sortTargetRows(covers, ["id"]),
    inventory_transactions: sortTargetRows(inventoryTransactions, ["id"]),
    inventory_transaction_lines: sortTargetRows(inventoryLines, ["id"]),
    holdings: sortTargetRows(holdings, ["material_id", "location_id", "condition"]),
    material_stock_totals: sortTargetRows(stockTotals, ["material_id"]),
    audit_events: sortTargetRows([...legacyOperationAudits, ...revisionAudits], ["id"]),
  };

  validateTargetRows(tables, diagnostics);
  const finished = diagnostics.finish();
  const report = {
    ok: finished.errors.length === 0,
    target_schema: TARGET_SCHEMA,
    source_bundle_sha256: sourceHash,
    source: bundle?.source ?? null,
    migration_actor_id: migrationActor?.id ?? null,
    staging_counts: Object.fromEntries(REQUIRED_STAGING_TABLES.map((name) => [name, staging[name].length])),
    target_counts: Object.fromEntries(TABLE_SPECS.map((spec) => [spec.name, tables[spec.name].length])),
    stock: {
      staging_total: sum(staging.stock_balances, (row) => integer(row?.quantity) ?? 0),
      countable_total: sum(holdings, (row) => row.quantity),
      service_excluded_rows: serviceExcluded.rows,
      service_excluded_quantity: serviceExcluded.quantity,
      total_rows: stockTotals.length,
    },
    operations: {
      confirmed_imported: inventoryTransactions.filter((row) => row.document_number?.startsWith("OP-")).length,
      opening_imported: inventoryTransactions.filter((row) => row.document_number?.startsWith("OPEN-")).length,
      unconfirmed_preserved_as_audit: skippedOperations.length,
      skipped: skippedOperations,
    },
    revisions: {
      source_rows: staging.revision_checks.length,
      audit_rows: revisionAudits.length,
    },
    diagnostics: {
      error_count: finished.errors.length,
      warning_count: finished.warnings.length,
      errors: finished.errors,
      warnings: finished.warnings,
    },
  };

  const plan = {
    format: PLAN_FORMAT,
    format_version: PLAN_VERSION,
    target_schema: TARGET_SCHEMA,
    source_bundle_sha256: sourceHash,
    imported_at: importedAt,
    tables,
    reconciliation: report,
  };

  if (options.throwOnError && !report.ok) throw validationError(report);
  return { plan, report };
}

function validateStagingBundle(bundle, diagnostics) {
  if (!isObject(bundle)) diagnostics.error("bundle_missing", "bundle", "Staging bundle має бути JSON-об'єктом.");
  if (bundle?.format !== STAGING_FORMAT) {
    diagnostics.error("bundle_format_invalid", "bundle.format", `Очікувався формат ${STAGING_FORMAT}.`, bundle?.format ?? null);
  }
  if (bundle?.format_version !== STAGING_VERSION) {
    diagnostics.error("bundle_version_invalid", "bundle.format_version", `Очікувалася версія ${STAGING_VERSION}.`, bundle?.format_version ?? null);
  }
  if (bundle?.reconciliation?.ok !== true) {
    diagnostics.error("staging_reconciliation_failed", "bundle.reconciliation.ok", "Loader відмовляється завантажувати staging bundle із помилками валідації.");
  }
  const sourceTables = isObject(bundle?.tables) ? bundle.tables : {};
  if (!isObject(bundle?.tables)) diagnostics.error("staging_tables_missing", "bundle.tables", "У staging bundle немає tables.");
  return Object.fromEntries(REQUIRED_STAGING_TABLES.map((name) => {
    const value = sourceTables[name];
    if (!Array.isArray(value)) {
      diagnostics.error("staging_table_missing", `bundle.tables.${name}`, "Обов'язкова staging-таблиця відсутня.");
      return [name, []];
    }
    return [name, value];
  }));
}

function normalizeImportedAt(value, diagnostics) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    diagnostics.error("source_timestamp_invalid", "bundle.source.exported_at", "Для детермінованого імпорту потрібен коректний exported_at у форматі ISO-8601.", value ?? null);
    return "1970-01-01T00:00:00.000Z";
  }
  return new Date(value).toISOString();
}

function mapMaterial(row, index, importedAt, diagnostics) {
  const location = `bundle.tables.materials[${index}]`;
  const id = uppercase(row?.material_id);
  const match = id.match(/^CAT-(\d{4,})$/u);
  const catalogNumber = match ? Number(match[1]) : null;
  if (!match || !Number.isSafeInteger(catalogNumber) || catalogNumber <= 0) {
    diagnostics.error("material_id_invalid", `${location}.material_id`, "CAT-ID не можна перенести до D1.", id);
  }
  const title = cleanText(row?.title);
  if (!title) diagnostics.error("material_title_missing", `${location}.title`, "Матеріал не має назви.", id);
  rejectNulStrings(row, location, diagnostics);
  return {
    id,
    catalog_number: catalogNumber ?? 0,
    title,
    sort_title: normalizeSortText(title) || id,
    search_text: cleanText(row?.search_text),
    rubric: cleanText(row?.rubric),
    publication_type: cleanText(row?.publication_type),
    subject: cleanText(row?.subject),
    class_from: nullableInteger(row?.class_from),
    class_to: nullableInteger(row?.class_to),
    author: cleanText(row?.author),
    publication_year: nullableInteger(row?.published_year),
    isbn: cleanText(row?.isbn_raw),
    isbn_normalized: cleanText(row?.isbn_normalized),
    publisher: cleanText(row?.publisher),
    notes: cleanText(row?.notes),
    status: "active",
    version: 1,
    created_at: importedAt,
    updated_at: importedAt,
    archived_at: null,
  };
}

function mapLink(row, index, importedAt, materialById, diagnostics) {
  const location = `bundle.tables.material_links[${index}]`;
  const materialId = uppercase(row?.material_id);
  validateReference(materialId, materialById, "link_material_missing", `${location}.material_id`, diagnostics);
  const classification = cleanText(row?.classification);
  const kind = {
    direct_document: "ebook",
    cloud_document: "preview",
    commercial_page: "store",
    information_page: "details",
  }[classification];
  if (!kind) diagnostics.error("link_classification_invalid", `${location}.classification`, "Невідома класифікація посилання.", classification);
  const url = cleanText(row?.url);
  if (!isHttpUrl(url)) diagnostics.error("link_url_invalid", `${location}.url`, "Посилання має бути HTTP або HTTPS URL.", url);
  rejectNulStrings(row, location, diagnostics);
  return {
    id: cleanText(row?.link_id) || `LINK-${sha256(`${materialId}\0${url}`).slice(0, 24)}`,
    material_id: materialId,
    kind: kind ?? "other",
    label: cleanText(row?.label) || defaultLinkLabel(kind),
    url,
    is_public: 1,
    sort_order: 0,
    status: "active",
    created_at: importedAt,
    updated_at: importedAt,
  };
}

function mapCover(row, index, importedAt, materialById, diagnostics) {
  const location = `bundle.tables.cover_assets[${index}]`;
  const materialId = uppercase(row?.material_id);
  validateReference(materialId, materialById, "cover_material_missing", `${location}.material_id`, diagnostics);
  const url = cleanText(row?.cover_url);
  if (!isHttpUrl(url)) diagnostics.error("cover_url_invalid", `${location}.cover_url`, "URL обкладинки має бути HTTP або HTTPS.", url);
  rejectNulStrings(row, location, diagnostics);
  return {
    id: `COVER-${materialId}`,
    material_id: materialId,
    storage_provider: "external",
    storage_key: null,
    external_url: url,
    mime_type: imageMimeType(url),
    byte_length: null,
    width: null,
    height: null,
    sha256: null,
    status: "ready",
    version: 1,
    created_at: importedAt,
    updated_at: importedAt,
  };
}

function mapLocation(row, index, importedAt, diagnostics) {
  const location = `bundle.tables.locations[${index}]`;
  const id = uppercase(row?.location_id);
  if (!/^LOC-\d{3,}$/u.test(id)) diagnostics.error("location_id_invalid", `${location}.location_id`, "Некоректний LOC-ID.", id);
  const name = cleanText(row?.name);
  if (!name) diagnostics.error("location_name_missing", `${location}.name`, "Місце не має назви.", id);
  const folded = normalizeSortText(`${row?.location_type ?? ""} ${name}`);
  let type = "other";
  if (numberBoolean(row?.is_service)) type = "service";
  else if (folded.includes("бібліотек") || folded.includes("основне місце")) type = "library";
  else if (folded.includes("кабінет")) type = "classroom";
  else if (folded.includes("офіс") || folded.includes("адміністра")) type = "office";
  rejectNulStrings(row, location, diagnostics);
  return {
    id,
    name,
    type,
    status: numberBoolean(row?.is_active) ? "active" : "inactive",
    is_public: type === "service" ? 0 : 1,
    sort_order: numericSuffix(id),
    created_at: importedAt,
    updated_at: importedAt,
  };
}

function mapUser(row, index, importedAt, diagnostics) {
  const location = `bundle.tables.users[${index}]`;
  const id = uppercase(row?.user_id);
  if (!/^USR-\d{3,}$/u.test(id)) diagnostics.error("user_id_invalid", `${location}.user_id`, "Некоректний USR-ID.", id);
  const fullName = cleanText(row?.name);
  if (!fullName) diagnostics.error("user_name_missing", `${location}.name`, "Користувач не має ПІБ.", id);
  const role = mapUserRole(row?.role);
  if (!role) diagnostics.error("user_role_invalid", `${location}.role`, "Роль користувача не вдалося надійно зіставити.", row?.role ?? null);
  const email = cleanText(row?.email).toLocaleLowerCase("uk-UA") || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    diagnostics.error("user_email_invalid", `${location}.email`, "Некоректний email користувача.", email);
  }
  rejectNulStrings(row, location, diagnostics);
  return {
    id,
    full_name: fullName,
    sort_name: normalizeSortText(fullName) || id,
    email,
    auth_user_id: null,
    role: role ?? "teacher",
    status: numberBoolean(row?.is_active) ? "active" : "inactive",
    created_at: importedAt,
    updated_at: importedAt,
  };
}

function chooseMigrationActor(users, stagingUsers, diagnostics) {
  const sourceById = new Map(stagingUsers.map((row) => [uppercase(row?.user_id), row]));
  const candidates = users
    .filter((user) => user.role === "admin" || user.role === "librarian")
    .sort((left, right) => {
      const active = Number(right.status === "active") - Number(left.status === "active");
      if (active) return active;
      const librarian = Number(normalizeSortText(sourceById.get(right.id)?.role).includes("бібліотек"))
        - Number(normalizeSortText(sourceById.get(left.id)?.role).includes("бібліотек"));
      return librarian || left.id.localeCompare(right.id, "en", { numeric: true });
    });
  const actor = candidates[0] ?? null;
  if (!actor) diagnostics.error("migration_actor_missing", "bundle.tables.users", "Потрібен хоча б один бібліотекар або адміністратор для авторства імпортованого журналу.");
  return actor;
}

function addOpeningStock(context) {
  const { row, index, importedAt, migrationActor, materialById, locationById, ledger, transactions, lines, diagnostics } = context;
  const location = `bundle.tables.opening_stock[${index}]`;
  const id = cleanText(row?.opening_stock_id);
  const materialId = uppercase(row?.material_id);
  const locationId = uppercase(row?.location_id);
  const quantity = integer(row?.quantity);
  validateReference(materialId, materialById, "opening_material_missing", `${location}.material_id`, diagnostics);
  validateReference(locationId, locationById, "opening_location_missing", `${location}.location_id`, diagnostics);
  if (!id) diagnostics.error("opening_id_missing", `${location}.opening_stock_id`, "Початковий залишок не має стабільного ID.");
  if (quantity === null || quantity <= 0) diagnostics.error("opening_quantity_invalid", `${location}.quantity`, "Початковий залишок має бути додатним цілим числом.", row?.quantity ?? null);
  const occurredAt = dayStart(row?.occurred_on, `${location}.occurred_on`, diagnostics);
  const condition = mapCondition(row?.condition, `${location}.condition`, diagnostics);
  const before = ledgerQuantity(ledger, materialId, locationId, condition);
  const after = before + (quantity ?? 0);
  setLedgerQuantity(ledger, materialId, locationId, condition, after);
  const transactionId = `TX-${id}`;
  transactions.push({
    id: transactionId,
    request_id: `migration:opening:${id}`,
    kind: "import",
    occurred_at: occurredAt,
    document_number: id,
    reason: "Початкове перенесення з Google Sheets",
    notes: joinNotes(row?.source, row?.notes),
    loan_id: null,
    actor_user_id: migrationActor?.id ?? "",
    reversal_of_id: null,
    status: "posted",
    created_at: importedAt,
  });
  lines.push({
    id: `LINE-${id}`,
    transaction_id: transactionId,
    material_id: materialId,
    location_id: locationId,
    condition,
    quantity_delta: quantity ?? 0,
    quantity_before: before,
    quantity_after: after,
    counted_quantity: null,
    loan_item_id: null,
    created_at: importedAt,
  });
}

function addConfirmedOperation(context) {
  const { row, index, importedAt, materialById, locationById, userById, revision, ledger, transactions, lines, diagnostics } = context;
  const location = `bundle.tables.operations[${index}]`;
  const operationId = uppercase(row?.operation_id);
  const materialId = uppercase(row?.material_id);
  const sourceLocationId = uppercase(row?.source_location_id) || null;
  const destinationLocationId = uppercase(row?.destination_location_id) || null;
  const actorUserId = uppercase(row?.actor_user_id);
  const quantity = integer(row?.quantity);
  validateReference(materialId, materialById, "operation_material_missing", `${location}.material_id`, diagnostics);
  if (sourceLocationId) validateReference(sourceLocationId, locationById, "operation_source_missing", `${location}.source_location_id`, diagnostics);
  if (destinationLocationId) validateReference(destinationLocationId, locationById, "operation_destination_missing", `${location}.destination_location_id`, diagnostics);
  validateReference(actorUserId, userById, "operation_actor_missing", `${location}.actor_user_id`, diagnostics);
  if (!/^OP-\d{6,}$/u.test(operationId)) diagnostics.error("operation_id_invalid", `${location}.operation_id`, "Некоректний OP-ID.", operationId);
  if (quantity === null || quantity <= 0) diagnostics.error("operation_quantity_invalid", `${location}.quantity`, "Кількість операції має бути додатним цілим числом.", row?.quantity ?? null);
  if (!sourceLocationId && !destinationLocationId) diagnostics.error("operation_locations_missing", location, "Підтверджена операція не має фізичного місця.");
  const occurredAt = dayStart(row?.occurred_on, `${location}.occurred_on`, diagnostics);
  const condition = mapCondition(row?.condition, `${location}.condition`, diagnostics);
  const kind = mapInventoryKind(row?.operation_type, `${location}.operation_type`, diagnostics);
  const transactionId = `TX-${operationId}`;
  const requestId = cleanText(row?.request_id) || `migration:operation:${operationId}`;
  transactions.push({
    id: transactionId,
    request_id: requestId,
    kind,
    occurred_at: occurredAt,
    document_number: operationId,
    reason: `Імпортовано з операції «${cleanText(row?.operation_type_source) || cleanText(row?.operation_type)}»`,
    notes: cleanText(row?.notes),
    loan_id: null,
    actor_user_id: actorUserId,
    reversal_of_id: null,
    status: "posted",
    created_at: importedAt,
  });

  const delta = quantity ?? 0;
  const operationLines = [];
  if (sourceLocationId) {
    operationLines.push(buildLedgerLine({
      id: `LINE-${operationId}-${kind === "stock_count" ? "C" : "S"}`,
      transactionId,
      materialId,
      locationId: sourceLocationId,
      condition,
      delta: -delta,
      countedQuantity: kind === "stock_count" ? integer(revision?.counted_quantity) : null,
      importedAt,
      ledger,
      diagnostics,
      diagnosticLocation: location,
    }));
  }
  if (destinationLocationId) {
    operationLines.push(buildLedgerLine({
      id: `LINE-${operationId}-${kind === "stock_count" ? "C" : "D"}`,
      transactionId,
      materialId,
      locationId: destinationLocationId,
      condition,
      delta,
      countedQuantity: kind === "stock_count" ? integer(revision?.counted_quantity) : null,
      importedAt,
      ledger,
      diagnostics,
      diagnosticLocation: location,
    }));
  }
  if (kind === "stock_count" && operationLines.length !== 1) {
    diagnostics.error("stock_count_line_count_invalid", location, "Коригування ревізії має змінювати рівно одне місце.", operationId);
  }
  lines.push(...operationLines);
}

function buildLedgerLine(input) {
  const before = ledgerQuantity(input.ledger, input.materialId, input.locationId, input.condition);
  const after = before + input.delta;
  if (after < 0) {
    input.diagnostics.error("ledger_negative", input.diagnosticLocation, "Операція створює від'ємний залишок під час відтворення журналу.", {
      material_id: input.materialId,
      location_id: input.locationId,
      condition: input.condition,
      before,
      delta: input.delta,
      after,
    });
  }
  const countedQuantity = input.countedQuantity ?? (input.id.endsWith("-C") ? after : null);
  if (countedQuantity !== null && countedQuantity !== after) {
    input.diagnostics.error("revision_count_mismatch", input.diagnosticLocation, "Підсумок журналу не збігається з порахованою кількістю ревізії.", {
      counted_quantity: countedQuantity,
      calculated_after: after,
    });
  }
  setLedgerQuantity(input.ledger, input.materialId, input.locationId, input.condition, after);
  return {
    id: input.id,
    transaction_id: input.transactionId,
    material_id: input.materialId,
    location_id: input.locationId,
    condition: input.condition,
    quantity_delta: input.delta,
    quantity_before: before,
    quantity_after: after,
    counted_quantity: countedQuantity,
    loan_item_id: null,
    created_at: input.importedAt,
  };
}

function mapSkippedOperationAudit(row, index, importedAt, migrationActor, userById, diagnostics) {
  const location = `bundle.tables.operations[${index}]`;
  const operationId = uppercase(row?.operation_id);
  const actorUserId = uppercase(row?.actor_user_id) || migrationActor?.id || null;
  if (actorUserId) validateReference(actorUserId, userById, "operation_actor_missing", `${location}.actor_user_id`, diagnostics);
  return {
    id: `AUD-LEGACY-OP-${sha256(operationId).slice(0, 20)}`,
    actor_user_id: actorUserId,
    actor_email: auditEmail(userById.get(actorUserId), actorUserId),
    action: `legacy.operation.${cleanText(row?.status) || "skipped"}`,
    entity_type: "legacy_operation",
    entity_id: operationId,
    request_id: cleanText(row?.request_id) || null,
    before_json: null,
    after_json: compactJson(row),
    metadata_json: compactJson({ source: "google_sheets", imported_at: importedAt }),
    created_at: dayStart(row?.occurred_on, `${location}.occurred_on`, diagnostics),
  };
}

function mapRevisionAudit(row, index, importedAt, migrationActor, userById, transactionById, diagnostics) {
  const location = `bundle.tables.revision_checks[${index}]`;
  const requestId = cleanText(row?.request_id);
  const operationId = uppercase(row?.operation_id) || null;
  const transaction = operationId ? transactionById.get(`TX-${operationId}`) : null;
  if (operationId && !transaction) diagnostics.error("revision_transaction_missing", `${location}.operation_id`, "Ревізія посилається на операцію, якої немає у цільовому журналі.", operationId);
  const actorUserId = transaction?.actor_user_id || migrationActor?.id || null;
  return {
    id: `AUD-REV-${sha256(requestId).slice(0, 24)}`,
    actor_user_id: actorUserId,
    actor_email: auditEmail(userById.get(actorUserId), actorUserId),
    action: "inventory.revision.imported",
    entity_type: transaction ? "inventory_transaction" : "material",
    entity_id: transaction?.id || uppercase(row?.material_id),
    request_id: requestId || null,
    before_json: compactJson({ expected_quantity: integer(row?.expected_quantity) ?? 0 }),
    after_json: compactJson({ counted_quantity: integer(row?.counted_quantity) ?? 0 }),
    metadata_json: compactJson({
      difference: integer(row?.difference) ?? 0,
      location_id: uppercase(row?.location_id),
      location_name_snapshot: stringOrNull(row?.location_name_snapshot),
      session_id: stringOrNull(row?.session_id),
      actor_name_snapshot: stringOrNull(row?.actor_name_snapshot),
      notes: stringOrNull(row?.notes),
      operation_id: operationId,
      source: "google_sheets",
      imported_at: importedAt,
    }),
    created_at: dayStart(row?.occurred_on, `${location}.occurred_on`, diagnostics),
  };
}

function validateLedgerAgainstStaging(ledger, stagingBalances, diagnostics) {
  const actual = aggregateLedger(ledger);
  const expected = new Map();
  for (const [index, row] of stagingBalances.entries()) {
    const materialId = uppercase(row?.material_id);
    const locationId = uppercase(row?.location_id);
    const quantity = integer(row?.quantity);
    if (quantity === null || quantity < 0) diagnostics.error("staging_balance_invalid", `bundle.tables.stock_balances[${index}].quantity`, "Staging balance має бути невід'ємним цілим числом.", row?.quantity ?? null);
    const key = `${materialId}\0${locationId}`;
    if (expected.has(key)) diagnostics.error("staging_balance_duplicate", `bundle.tables.stock_balances[${index}]`, "Баланс матеріалу й місця повторюється.", { material_id: materialId, location_id: locationId });
    expected.set(key, quantity ?? 0);
  }
  const keys = new Set([...actual.keys(), ...expected.keys()]);
  for (const key of [...keys].sort()) {
    const actualQuantity = actual.get(key) ?? 0;
    const expectedQuantity = expected.get(key) ?? 0;
    if (actualQuantity !== expectedQuantity) {
      const [materialId, locationId] = key.split("\0");
      diagnostics.error("ledger_balance_mismatch", "bundle.tables.stock_balances", "Відтворений журнал не збігається зі staging balance.", {
        material_id: materialId,
        location_id: locationId,
        expected: expectedQuantity,
        actual: actualQuantity,
      });
    }
  }
}

function buildHoldings(ledger, locationById, importedAt, diagnostics) {
  const holdings = [];
  const serviceExcluded = { rows: 0, quantity: 0 };
  for (const [key, quantity] of [...ledger.entries()].sort()) {
    if (quantity < 0) diagnostics.error("holding_negative", "ledger", "Від'ємний залишок не можна завантажити в holdings.", { key, quantity });
    if (quantity <= 0) continue;
    const [materialId, locationId, condition] = key.split("\0");
    const location = locationById.get(locationId);
    if (location?.type === "service") {
      serviceExcluded.rows += 1;
      serviceExcluded.quantity += quantity;
      continue;
    }
    holdings.push({
      material_id: materialId,
      location_id: locationId,
      condition,
      quantity,
      version: 1,
      updated_at: importedAt,
    });
  }
  return { holdings, serviceExcluded };
}

function buildStockTotals(materials, holdings, locationById, importedAt) {
  const totals = new Map(materials.map((material) => [material.id, { library: 0, other: 0 }]));
  for (const holding of holdings) {
    const bucket = totals.get(holding.material_id);
    if (!bucket) continue;
    if (locationById.get(holding.location_id)?.type === "library") bucket.library += holding.quantity;
    else bucket.other += holding.quantity;
  }
  return materials.map((material) => {
    const value = totals.get(material.id);
    return {
      material_id: material.id,
      total_quantity: value.library + value.other,
      library_quantity: value.library,
      other_location_quantity: value.other,
      loaned_quantity: 0,
      updated_at: importedAt,
    };
  });
}

function validateTargetRows(tables, diagnostics) {
  for (const spec of TABLE_SPECS) {
    const rows = tables[spec.name];
    const primary = new Map();
    const uniqueMaps = spec.uniqueKeys.map(() => new Map());
    for (const [index, row] of rows.entries()) {
      const location = `plan.tables.${spec.name}[${index}]`;
      for (const column of spec.columns) {
        if (!Object.hasOwn(row, column)) diagnostics.error("target_column_missing", `${location}.${column}`, "У цільовому рядку відсутня колонка.");
        if (typeof row[column] === "string" && row[column].includes("\0")) diagnostics.error("target_nul_forbidden", `${location}.${column}`, "NUL-символ не дозволений у D1 тексті.");
      }
      const primaryValue = compoundKey(row, spec.primaryKey);
      if (primary.has(primaryValue)) diagnostics.error("target_primary_key_duplicate", location, "Повторний первинний ключ у плані.", { table: spec.name, key: primaryValue });
      else primary.set(primaryValue, index);
      spec.uniqueKeys.forEach((columns, uniqueIndex) => {
        if (columns.some((column) => row[column] === null || row[column] === undefined)) return;
        const value = compoundKey(row, columns);
        const seen = uniqueMaps[uniqueIndex];
        if (seen.has(value)) diagnostics.error("target_unique_key_duplicate", location, "Повторне унікальне значення у плані.", { table: spec.name, columns, key: value });
        else seen.set(value, index);
      });
    }
  }
}

export async function inspectD1LoadPlan(db, plan) {
  validatePlanShape(plan);
  const requiredTables = [...TABLE_SPECS.map((spec) => spec.name), "materials_fts"];
  const schemaRows = await queryRows(db, `SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (${requiredTables.map(sqlLiteral).join(", ")})`);
  const present = new Set(schemaRows.map((row) => String(row.name)));
  const missing = requiredTables.filter((name) => !present.has(name));
  if (missing.length) {
    const error = new Error(`У локальній D1/SQLite немає таблиць schema ${TARGET_SCHEMA}: ${missing.join(", ")}.`);
    error.code = "D1_SCHEMA_MISSING";
    error.missingTables = missing;
    throw error;
  }

  const tables = {};
  const conflicts = [];
  for (const spec of TABLE_SPECS) {
    const existingRows = await queryRows(db, `SELECT ${spec.columns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(spec.name)}`);
    const targetRows = plan.tables[spec.name];
    const existingByPrimary = new Map(existingRows.map((row) => [compoundKey(row, spec.primaryKey), row]));
    const uniqueMaps = spec.uniqueKeys.map((columns) => new Map(existingRows
      .filter((row) => columns.every((column) => row[column] !== null && row[column] !== undefined))
      .map((row) => [compoundKey(row, columns), row])));
    const newRows = [];
    let unchanged = 0;
    for (const row of targetRows) {
      const primaryValue = compoundKey(row, spec.primaryKey);
      const existing = existingByPrimary.get(primaryValue);
      if (existing) {
        if (rowsEqual(row, existing, spec.columns)) unchanged += 1;
        else conflicts.push({ table: spec.name, kind: "primary_key_drift", key: primaryValue, columns: differentColumns(row, existing, spec.columns) });
        continue;
      }
      let uniqueConflict = null;
      spec.uniqueKeys.forEach((columns, index) => {
        if (uniqueConflict || columns.some((column) => row[column] === null || row[column] === undefined)) return;
        const value = compoundKey(row, columns);
        const collision = uniqueMaps[index].get(value);
        if (collision) uniqueConflict = { columns, key: value, existing_primary_key: compoundKey(collision, spec.primaryKey) };
      });
      if (uniqueConflict) conflicts.push({ table: spec.name, kind: "unique_key_collision", key: primaryValue, ...uniqueConflict });
      else newRows.push(row);
    }
    const targetKeys = new Set(targetRows.map((row) => compoundKey(row, spec.primaryKey)));
    tables[spec.name] = {
      target: targetRows.length,
      existing: existingRows.length,
      new: newRows.length,
      unchanged,
      conflicts: conflicts.filter((conflict) => conflict.table === spec.name).length,
      extra_existing: existingRows.filter((row) => !targetKeys.has(compoundKey(row, spec.primaryKey))).length,
      newRows,
    };
  }
  const reportTables = Object.fromEntries(Object.entries(tables).map(([name, value]) => [name, {
    target: value.target,
    existing: value.existing,
    new: value.new,
    unchanged: value.unchanged,
    conflicts: value.conflicts,
    extra_existing: value.extra_existing,
  }]));
  return {
    ok: conflicts.length === 0,
    target_schema: TARGET_SCHEMA,
    source_bundle_sha256: plan.source_bundle_sha256,
    tables: reportTables,
    total_new: sum(Object.values(tables), (value) => value.new),
    total_unchanged: sum(Object.values(tables), (value) => value.unchanged),
    total_conflicts: conflicts.length,
    conflicts,
    _newRowsByTable: Object.fromEntries(Object.entries(tables).map(([name, value]) => [name, value.newRows])),
  };
}

export async function loadD1Plan(db, plan, options = {}) {
  validatePlanShape(plan);
  if (plan.reconciliation?.ok !== true) throw validationError(plan.reconciliation);
  const before = await inspectD1LoadPlan(db, plan);
  const publicBefore = withoutPrivateRows(before);
  if (!before.ok) throw targetConflictError(publicBefore);
  if (options.dryRun !== false || before.total_new === 0) {
    return { ok: true, dry_run: options.dryRun !== false, applied: false, before: publicBefore, after: publicBefore };
  }

  const sqlStatements = [];
  for (const spec of TABLE_SPECS) {
    sqlStatements.push(...buildInsertStatements(spec, before._newRowsByTable[spec.name]));
  }
  // Rebuild in the same batch so imported materials and their search index commit together.
  sqlStatements.push("INSERT INTO materials_fts(materials_fts) VALUES('rebuild')");
  try {
    await db.batch(sqlStatements.map((sql) => db.prepare(sql)));
  } catch (cause) {
    const error = new Error(`Атомарне завантаження D1 не виконано: ${cause instanceof Error ? cause.message : String(cause)}`);
    error.code = "D1_ATOMIC_BATCH_FAILED";
    error.cause = cause;
    throw error;
  }

  const after = await inspectD1LoadPlan(db, plan);
  const publicAfter = withoutPrivateRows(after);
  if (!after.ok || after.total_new !== 0 || after.total_unchanged !== totalTargetRows(plan)) {
    const error = new Error("Після атомарного batch цільова база не пройшла reconciliation.");
    error.code = "D1_POST_LOAD_RECONCILIATION_FAILED";
    error.report = publicAfter;
    throw error;
  }
  return {
    ok: true,
    dry_run: false,
    applied: true,
    applied_statements: sqlStatements.length,
    applied_rows: before.total_new,
    before: publicBefore,
    after: publicAfter,
  };
}

export async function loadD1Bundle(db, bundle, options = {}) {
  const { plan, report } = buildD1LoadPlan(bundle);
  if (!report.ok) throw validationError(report);
  return loadD1Plan(db, plan, options);
}

export function createNodeSqliteD1Adapter(database) {
  database.exec("PRAGMA foreign_keys = ON");
  return {
    prepare(sql) {
      return {
        _sql: sql,
        async all() {
          return { success: true, results: database.prepare(sql).all() };
        },
      };
    },
    async batch(statements) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => {
          if (!statement || typeof statement._sql !== "string") throw new Error("Local adapter отримав невідому prepared statement.");
          const prepared = database.prepare(statement._sql);
          if (/^\s*(?:SELECT|PRAGMA|WITH)\b/iu.test(statement._sql)) return { success: true, results: prepared.all() };
          const result = prepared.run();
          return { success: true, results: [], meta: { changes: Number(result.changes) } };
        });
        database.exec("COMMIT");
        return results;
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // Preserve the original failure; rollback can only fail after SQLite already ended the transaction.
        }
        throw error;
      }
    },
  };
}

function buildInsertStatements(spec, rows) {
  if (!rows.length) return [];
  const prefix = `INSERT INTO ${quoteIdentifier(spec.name)} (${spec.columns.map(quoteIdentifier).join(", ")}) VALUES\n`;
  const statements = [];
  let values = [];
  for (const row of rows) {
    const tuple = `(${spec.columns.map((column) => sqlLiteral(row[column])).join(", ")})`;
    const candidate = `${prefix}${[...values, tuple].join(",\n")}`;
    if (values.length && Buffer.byteLength(candidate, "utf8") > MAX_INSERT_SQL_BYTES) {
      statements.push(`${prefix}${values.join(",\n")}`);
      values = [tuple];
    } else values.push(tuple);
  }
  if (values.length) statements.push(`${prefix}${values.join(",\n")}`);
  return statements;
}

function validatePlanShape(plan) {
  if (!isObject(plan) || plan.format !== PLAN_FORMAT || plan.format_version !== PLAN_VERSION || plan.target_schema !== TARGET_SCHEMA) {
    const error = new Error(`Некоректний D1 load plan; очікується ${PLAN_FORMAT} v${PLAN_VERSION} для schema ${TARGET_SCHEMA}.`);
    error.code = "D1_PLAN_INVALID";
    throw error;
  }
  for (const spec of TABLE_SPECS) {
    if (!Array.isArray(plan.tables?.[spec.name])) {
      const error = new Error(`У D1 load plan відсутня таблиця ${spec.name}.`);
      error.code = "D1_PLAN_INVALID";
      throw error;
    }
  }
}

function validationError(report) {
  const count = report?.diagnostics?.error_count ?? "невідома кількість";
  const error = new Error(`Loader відмовився від завантаження: ${count} помилок валідації.`);
  error.code = "D1_LOAD_VALIDATION_FAILED";
  error.report = report;
  return error;
}

function targetConflictError(report) {
  const error = new Error(`Loader виявив ${report.total_conflicts} конфліктів із наявними даними та нічого не записав.`);
  error.code = "D1_LOAD_TARGET_CONFLICT";
  error.report = report;
  return error;
}

async function queryRows(db, sql) {
  const result = await db.prepare(sql).all();
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.results)) return result.results;
  return [];
}

function withoutPrivateRows(report) {
  const { _newRowsByTable: ignored, ...publicReport } = report;
  void ignored;
  return publicReport;
}

function rowsEqual(expected, actual, columns) {
  return columns.every((column) => normalizeSqlValue(expected[column]) === normalizeSqlValue(actual[column]));
}

function differentColumns(expected, actual, columns) {
  return columns.filter((column) => normalizeSqlValue(expected[column]) !== normalizeSqlValue(actual[column]));
}

function normalizeSqlValue(value) {
  if (value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  return value;
}

function compoundKey(row, columns) {
  return columns.map((column) => stableStringify(normalizeSqlValue(row[column]), 0)).join("\0");
}

function uniqueMap(rows, key, code, location, diagnostics) {
  const map = new Map();
  for (const [index, row] of rows.entries()) {
    if (map.has(row[key])) diagnostics.error(code, `${location}[${index}].${key}`, "Цільовий ID повторюється.", row[key]);
    else map.set(row[key], row);
  }
  return map;
}

function validateReference(value, map, code, location, diagnostics) {
  if (!map.has(value)) diagnostics.error(code, location, "Посилання на відсутній цільовий запис.", value || null);
}

function mapUserRole(value) {
  const normalized = normalizeSortText(value);
  if (normalized.includes("адмін") || normalized.includes("administr")) return "admin";
  if (normalized.includes("бібліотек") || normalized.includes("librar")) return "librarian";
  if (normalized.includes("учител") || normalized.includes("teacher")) return "teacher";
  return null;
}

function mapInventoryKind(value, location, diagnostics) {
  const kind = cleanText(value);
  if (kind === "receipt") return "receipt";
  if (kind === "transfer" || kind === "issued_for_use") return "transfer";
  if (kind === "writeoff" || kind === "loss") return "writeoff";
  if (kind === "adjustment") return "stock_count";
  if (kind === "loan_issue" || kind === "loan_return") {
    diagnostics.warning("legacy_loan_mapped_to_transfer", location, "Стара операція видачі/повернення не має позичальника й loan_id, тому збережена як рух між місцями, а не як вигадана позика.", kind);
    return "transfer";
  }
  diagnostics.error("operation_kind_unmappable", location, "Тип операції не можна безпечно перенести до D1.", kind);
  return "import";
}

function mapCondition(value, location, diagnostics) {
  const normalized = normalizeSortText(value);
  if (!normalized || normalized.includes("не перевір")) return "unspecified";
  if (normalized.includes("придат") || normalized.includes("доб") || normalized === "good") return "good";
  if (normalized.includes("знош") || normalized === "worn") return "worn";
  if (normalized.includes("пошкод") || normalized === "damaged") return "damaged";
  diagnostics.warning("condition_unmapped", location, "Невідомий стан перенесено як unspecified.", cleanText(value));
  return "unspecified";
}

function defaultLinkLabel(kind) {
  return {
    ebook: "Електронна книга",
    preview: "Попередній перегляд",
    store: "Сторінка видання",
    details: "Інформація про видання",
  }[kind] || "Посилання";
}

function imageMimeType(value) {
  try {
    const extension = new URL(value).pathname.toLocaleLowerCase("en-US").match(/\.([a-z0-9]+)$/u)?.[1];
    if (extension === "png") return "image/png";
    if (extension === "webp") return "image/webp";
    if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  } catch {
    return null;
  }
  return null;
}

function auditEmail(user, userId) {
  return user?.email || `migration+${cleanText(userId || "system").toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu, "-")}@local.invalid`;
}

function dayStart(value, location, diagnostics) {
  const text = cleanText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text) || !Number.isFinite(Date.parse(`${text}T00:00:00.000Z`))) {
    diagnostics.error("date_invalid", location, "Очікується календарна дата YYYY-MM-DD.", text || null);
    return "1970-01-01T00:00:00.000Z";
  }
  return `${text}T00:00:00.000Z`;
}

function ledgerQuantity(ledger, materialId, locationId, condition) {
  return ledger.get(`${materialId}\0${locationId}\0${condition}`) ?? 0;
}

function setLedgerQuantity(ledger, materialId, locationId, condition, quantity) {
  ledger.set(`${materialId}\0${locationId}\0${condition}`, quantity);
}

function aggregateLedger(ledger) {
  const result = new Map();
  for (const [key, quantity] of ledger) {
    const [materialId, locationId] = key.split("\0");
    const aggregateKey = `${materialId}\0${locationId}`;
    result.set(aggregateKey, (result.get(aggregateKey) ?? 0) + quantity);
  }
  for (const [key, quantity] of [...result]) if (quantity === 0) result.delete(key);
  return result;
}

function normalizeSortText(value) {
  return cleanText(value)
    .normalize("NFKC")
    .toLocaleLowerCase("uk-UA")
    .replace(/[’`´]/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}

function sortedBy(rows, key) {
  return [...rows].sort((left, right) => cleanText(left?.[key]).localeCompare(cleanText(right?.[key]), "en", { numeric: true }));
}

function sortTargetRows(rows, keys) {
  return [...rows].sort((left, right) => compoundKey(left, keys).localeCompare(compoundKey(right, keys), "en", { numeric: true }));
}

function rejectNulStrings(row, location, diagnostics) {
  if (!isObject(row)) return;
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "string" && value.includes("\0")) diagnostics.error("staging_nul_forbidden", `${location}.${key}`, "NUL-символ не дозволений у staging тексті.");
  }
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function joinNotes(...values) {
  return values.map(cleanText).filter(Boolean).join(" — ");
}

function compactJson(value) {
  return stableStringify(value, 0);
}

function cleanText(value) {
  if (value === null || value === undefined) return "";
  return String(value).normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
}

function stringOrNull(value) {
  return cleanText(value) || null;
}

function uppercase(value) {
  return cleanText(value).toLocaleUpperCase("en-US");
}

function integer(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/u.test(value.trim())) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function nullableInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  return integer(value);
}

function numberBoolean(value) {
  return value === true || value === 1 || value === "1";
}

function numericSuffix(value) {
  const match = cleanText(value).match(/(\d+)$/u);
  return match ? Number(match[1]) : 0;
}

function sum(values, selector) {
  return values.reduce((total, value) => total + selector(value), 0);
}

function totalTargetRows(plan) {
  return TABLE_SPECS.reduce((total, spec) => total + plan.tables[spec.name].length, 0);
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`Небезпечне числове значення SQL: ${value}`);
    return String(value);
  }
  if (typeof value !== "string") throw new Error(`Непідтримуваний SQL тип: ${typeof value}`);
  if (value.includes("\0")) throw new Error("NUL-символ не можна екранувати як SQLite text literal.");
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.input) throw new Error("Вкажіть --input <staging-bundle.json>.");
  assertLocalPath(args.input, "--input");
  if (args.database) assertLocalPath(args.database, "--database");
  if (args.applyLocal && !args.database) throw new Error("--apply-local вимагає --database <local.sqlite>.");

  const inputPath = path.resolve(args.input);
  const bundle = JSON.parse(await readFile(inputPath, "utf8"));
  const { plan, report: planReport } = buildD1LoadPlan(bundle);
  let result = {
    ok: planReport.ok,
    dry_run: true,
    applied: false,
    plan: planReport,
    target: null,
  };
  if (!planReport.ok) {
    result = { ...result, ok: false };
  } else if (args.database) {
    const databasePath = path.resolve(args.database);
    const file = await stat(databasePath);
    if (!file.isFile()) throw new Error("--database має вказувати на наявний локальний SQLite-файл.");
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(databasePath);
    try {
      const adapter = createNodeSqliteD1Adapter(database);
      const target = await loadD1Plan(adapter, plan, { dryRun: !args.applyLocal });
      result = { ok: true, dry_run: !args.applyLocal, applied: target.applied, plan: planReport, target };
    } finally {
      database.close();
    }
  }

  const output = `${stableStringify(result)}\n`;
  if (args.report) {
    const reportPath = path.resolve(args.report);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, output, "utf8");
  } else process.stdout.write(output);
  if (!result.ok) process.exitCode = 2;
  return result;
}

function parseArgs(argv) {
  const result = { applyLocal: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--apply-local") {
      result.applyLocal = true;
      continue;
    }
    if (!["--input", "--database", "--report"].includes(key)) throw new Error(`Невідомий аргумент: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Відсутнє значення для ${key}.`);
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

function assertLocalPath(value, option) {
  const text = String(value);
  if (/^(?:https?|file):\/\//iu.test(text) || /^\\\\/u.test(text)) {
    throw new Error(`${option} приймає лише локальний шлях, не URL або мережевий UNC-шлях.`);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  runCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.code === "D1_LOAD_VALIDATION_FAILED" || error.code === "D1_LOAD_TARGET_CONFLICT" ? 2 : 1;
  });
}
