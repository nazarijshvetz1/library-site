import type { ChatGPTUser } from "@/app/chatgpt-auth";
import type {
  ClassLoanCreateInput,
  ClassLoanReturnInput,
  LoanCreateInput,
  LoanReturnInput,
  MaterialArchiveInput,
  MaterialCreateInput,
  MaterialUpdateInput,
  ReceiptCreateDetails,
  ReceiptCreateInput,
  StockAdjustmentInput,
  StockTransferInput,
  StockWriteoffInput,
} from "@/lib/library-write-validation";

type D1Value = string | number | null;

type D1Result<T = Record<string, unknown>> = {
  results?: T[];
  success?: boolean;
  meta?: { changes?: number };
};

type D1Statement = {
  bind(...values: D1Value[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
};

type D1Binding = {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<D1Result[]>;
};

export type LibraryD1Database = D1Binding;

async function activeReservedQuantity(
  db: D1Binding,
  materialId: string,
  locationId: string,
  condition: string,
): Promise<number> {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(reserved_quantity-issued_quantity-released_quantity), 0) AS quantity
    FROM material_request_reservations
    WHERE material_id=? AND source_location_id=? AND condition=?
      AND reserved_quantity>issued_quantity+released_quantity
  `).bind(materialId, locationId, condition).first<{ quantity: number }>();
  return Math.max(0, Number(row?.quantity) || 0);
}

async function activeMaterialReservationQuantity(
  db: D1Binding,
  materialId: string,
): Promise<number> {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(reserved_quantity-issued_quantity-released_quantity), 0) AS quantity
    FROM material_request_reservations
    WHERE material_id=?
      AND reserved_quantity>issued_quantity+released_quantity
  `).bind(materialId).first<{ quantity: number }>();
  return Math.max(0, Number(row?.quantity) || 0);
}

type MutationActor = {
  id: string;
  email: string;
};

type StoredCommand = {
  status: string;
  request_hash: string;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
};

type MaterialRow = {
  id: string;
  catalog_number: number;
  title: string;
  sort_title: string;
  search_text: string;
  rubric: string;
  publication_type: string;
  subject: string;
  class_from: number | null;
  class_to: number | null;
  author: string;
  publication_year: number | null;
  isbn: string;
  isbn_normalized: string;
  publisher: string;
  notes: string;
  status: string;
  version: number;
  updated_at: string;
  archived_at: string | null;
};

export type MaterialMutationResult = {
  materialId: string;
  version: number;
  updatedAt: string;
};

export type MaterialArchiveResult = {
  materialId: string;
  version: number;
  archivedAt: string;
};

export type ReceiptMutationResult = {
  materialId: string;
  locationId: string;
  condition: string;
  quantityBefore: number;
  quantityReceived: number;
  quantityAfter: number;
  holdingVersion: number;
  transactionId: string;
  occurredAt: string;
};

export type MaterialCreateResult = {
  materialId: string;
  catalogNumber: number;
  version: number;
  createdAt: string;
  receipt: ReceiptMutationResult | null;
};

export type StockAdjustmentResult = {
  materialId: string;
  locationId: string;
  condition: string;
  quantityBefore: number;
  countedQuantity: number;
  quantityDelta: number;
  holdingVersion: number | null;
  transactionId: string;
  occurredAt: string;
};

export type StockTransferResult = {
  materialId: string;
  sourceLocationId: string;
  destinationLocationId: string;
  condition: string;
  quantityMoved: number;
  sourceQuantityBefore: number;
  sourceQuantityAfter: number;
  sourceHoldingVersion: number | null;
  destinationQuantityBefore: number;
  destinationQuantityAfter: number;
  destinationHoldingVersion: number;
  transactionId: string;
  occurredAt: string;
};

export type StockWriteoffResult = {
  materialId: string;
  locationId: string;
  condition: string;
  quantityBefore: number;
  quantityWrittenOff: number;
  quantityAfter: number;
  holdingVersion: number | null;
  transactionId: string;
  occurredAt: string;
};

export type LoanMutationResult = {
  loanId: string;
  status: "open" | "closed";
  teacherUserId: string;
  issuedAt: string;
  dueAt: string | null;
  closedAt: string | null;
  transactionId: string;
  items: Array<{
    loanItemId: string;
    materialId: string;
    quantityIssued: number;
    quantityReturned: number;
  }>;
};

export type ClassLoanMutationResult = {
  classLoanId: string;
  status: "open" | "closed";
  classYearId: string;
  responsibleTeacherUserId: string;
  responsibleTeacherName: string;
  issuedAt: string;
  dueAt: string | null;
  closedAt: string | null;
  version: number;
  transactionId: string;
  items: Array<{
    classLoanItemId: string;
    materialId: string;
    quantityIssued: number;
    quantityReturned: number;
  }>;
};

export class LibraryMutationError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    status: number,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "LibraryMutationError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export async function createMaterialDirect(
  user: ChatGPTUser,
  input: MaterialCreateInput,
  providedDb?: LibraryD1Database,
): Promise<MaterialCreateResult> {
  const db = database(providedDb);
  const actor = await resolveMutationActor(db, user);
  const requestHash = await mutationHash({
    kind: "material.create",
    actorUserId: actor.id,
    input,
  });
  const replay = await replayCompletedCommand<MaterialCreateResult>(
    db,
    input.requestId,
    requestHash,
  );
  if (replay) return replay;

  const isbnNormalized = normalizeIsbn(input.isbn ?? "");
  if (isbnNormalized) {
    const duplicate = await db.prepare(`
      SELECT id FROM materials
      WHERE isbn_normalized = ? AND status = 'active' AND archived_at IS NULL
      LIMIT 1
    `).bind(isbnNormalized).first<{ id: string }>();
    if (duplicate) {
      throw new LibraryMutationError(
        "duplicate_isbn",
        409,
        "Матеріал із цим ISBN уже є в каталозі.",
        { materialId: duplicate.id },
      );
    }
  }
  if (input.initialReceipt && input.initialReceipt.expectedQuantity !== 0) {
    throw new LibraryMutationError(
      "stock_quantity_conflict",
      409,
      "Для нового матеріалу початковий залишок має дорівнювати нулю.",
    );
  }
  if (input.initialReceipt) {
    await assertReceiptLocation(db, input.initialReceipt.locationId);
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const maximum = await db.prepare(`
      SELECT COALESCE(MAX(catalog_number), 0) AS maximum FROM materials
    `).first<{ maximum: number }>();
    const catalogNumber = Number(maximum?.maximum ?? 0) + 1;
    const materialId = `CAT-${String(catalogNumber).padStart(4, "0")}`;
    const createdAt = new Date().toISOString();
    const transactionId = input.initialReceipt ? `TX-${crypto.randomUUID()}` : null;
    const persistedLinks = input.links.map((link) => ({
      id: `LINK-${crypto.randomUUID()}`,
      kind: link.kind,
      label: link.label,
      url: link.url,
      isPublic: link.isPublic,
      sortOrder: link.sortOrder,
      status: "active",
    }));
    const receipt = input.initialReceipt && transactionId
      ? receiptResult(materialId, input.initialReceipt, 0, 1, transactionId)
      : null;
    const result: MaterialCreateResult = {
      materialId,
      catalogNumber,
      version: 1,
      createdAt,
      receipt,
    };
    const materialAfter = {
      id: materialId,
      catalogNumber,
      title: input.title,
      rubric: input.rubric,
      publicationType: input.publicationType ?? "",
      subject: input.subject ?? "",
      classFrom: input.classFrom,
      classTo: input.classTo,
      author: input.author ?? "",
      publicationYear: input.publicationYear,
      isbn: input.isbn ?? "",
      publisher: input.publisher ?? "",
      notes: input.notes ?? "",
      version: 1,
      links: persistedLinks,
    };
    const statements: D1Statement[] = [
      insertCommandStatement(
        db,
        input.requestId,
        requestHash,
        actor.id,
        "material.create",
        "material",
        materialId,
        createdAt,
      ),
      db.prepare(`
        INSERT INTO materials (
          id, catalog_number, title, sort_title, search_text, rubric,
          publication_type, subject, class_from, class_to, author,
          publication_year, isbn, isbn_normalized, publisher, notes,
          status, version, created_at, updated_at, archived_at
        )
        SELECT
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'active', 1, ?, ?, NULL
        WHERE ? = '' OR NOT EXISTS (
          SELECT 1 FROM materials
          WHERE isbn_normalized = ? AND status = 'active' AND archived_at IS NULL
        )
      `).bind(
        materialId,
        catalogNumber,
        input.title,
        normalizeSearchText(input.title),
        materialSearchText(materialAfter),
        input.rubric,
        input.publicationType ?? "",
        input.subject ?? "",
        input.classFrom,
        input.classTo,
        input.author ?? "",
        input.publicationYear,
        input.isbn ?? "",
        isbnNormalized,
        input.publisher ?? "",
        input.notes ?? "",
        createdAt,
        createdAt,
        isbnNormalized,
        isbnNormalized,
      ),
      db.prepare(`
        INSERT INTO audit_events (
          id, actor_user_id, actor_email, action, entity_type, entity_id,
          request_id, before_json, after_json, metadata_json, created_at
        ) VALUES (
          ?, ?, ?, 'material.created', 'material',
          (SELECT id FROM materials WHERE id = ? AND version = 1 AND changes() = 1),
          ?, NULL, ?, NULL, ?
        )
      `).bind(
        crypto.randomUUID(),
        actor.id,
        actor.email,
        materialId,
        input.requestId,
        JSON.stringify(materialAfter),
        createdAt,
      ),
      // Keep FTS after the audit: its guard must observe the material INSERT's changes().
      insertMaterialSearchStatement(db, materialId, 1),
    ];
    for (const link of persistedLinks) {
      statements.push(
        insertMaterialLinkStatement(db, materialId, link, createdAt),
      );
    }
    if (input.initialReceipt && transactionId) {
      statements.push(
        insertReceiptTransactionStatement(
          db,
          transactionId,
          input.requestId,
          input.initialReceipt,
          actor.id,
          createdAt,
        ),
        db.prepare(`
          INSERT INTO holdings (
            material_id, location_id, condition, quantity, version, updated_at
          ) VALUES (
            ?,
            (SELECT id FROM locations WHERE id = ? AND status = 'active' AND type != 'service'),
            ?, ?, 1, ?
          )
        `).bind(
          materialId,
          input.initialReceipt.locationId,
          input.initialReceipt.condition,
          input.initialReceipt.quantity,
          createdAt,
        ),
        guardedInventoryLineStatement(db, {
          lineId: `LINE-${crypto.randomUUID()}`,
          transactionId,
          materialId,
          locationId: input.initialReceipt.locationId,
          condition: input.initialReceipt.condition,
          quantityDelta: input.initialReceipt.quantity,
          quantityBefore: 0,
          quantityAfter: input.initialReceipt.quantity,
          countedQuantity: null,
          createdAt,
          guardSql: `
            SELECT material_id FROM holdings
            WHERE material_id = ? AND location_id = ? AND condition = ?
              AND quantity = ? AND version = 1 AND changes() = 1
          `,
          guardBindings: [
            materialId,
            input.initialReceipt.locationId,
            input.initialReceipt.condition,
            input.initialReceipt.quantity,
          ],
        }),
      );
    }
    statements.push(rebuildStockTotalsStatement(db, materialId, createdAt));
    if (receipt) {
      statements.push(
        receiptAuditStatement(
          db,
          actor,
          input.requestId,
          receipt,
          createdAt,
        ),
      );
    }
    statements.push(completeCommandStatement(db, input.requestId, result, createdAt));
    try {
      const replayed = await executeIdempotentBatch<MaterialCreateResult>(
        db,
        statements,
        input.requestId,
        requestHash,
        {
          code: "material_create_conflict",
          message: "Каталог змінився під час додавання. Спробуйте ще раз.",
        },
      );
      return replayed ?? result;
    } catch (error) {
      if (attempt < 2 && isCatalogAllocationConflict(error)) continue;
      throw error;
    }
  }
  throw new LibraryMutationError(
    "material_create_conflict",
    409,
    "Не вдалося безпечно призначити CAT-ID. Спробуйте ще раз.",
  );
}

export async function receiveStockDirect(
  user: ChatGPTUser,
  input: ReceiptCreateInput,
  providedDb?: LibraryD1Database,
): Promise<ReceiptMutationResult> {
  const db = database(providedDb);
  const actor = await resolveMutationActor(db, user);
  const requestHash = await mutationHash({
    kind: "stock.receive",
    actorUserId: actor.id,
    input,
  });
  const replay = await replayCompletedCommand<ReceiptMutationResult>(
    db,
    input.requestId,
    requestHash,
  );
  if (replay) return replay;
  const material = await db.prepare(`
    SELECT id FROM materials
    WHERE id = ? AND status = 'active' AND archived_at IS NULL
    LIMIT 1
  `).bind(input.materialId).first<{ id: string }>();
  if (!material) {
    throw new LibraryMutationError("material_not_found", 404, "Матеріал не знайдено.");
  }
  await assertReceiptLocation(db, input.locationId);
  const holding = await db.prepare(`
    SELECT quantity, version FROM holdings
    WHERE material_id = ? AND location_id = ? AND condition = ?
    LIMIT 1
  `).bind(
    input.materialId,
    input.locationId,
    input.condition,
  ).first<{ quantity: number; version: number }>();
  const quantityBefore = holding ? Number(holding.quantity) : 0;
  const versionBefore = holding ? Number(holding.version) : 0;
  if (quantityBefore !== input.expectedQuantity) {
    throw new LibraryMutationError(
      "stock_quantity_conflict",
      409,
      "Залишок уже змінився. Оновіть картку матеріалу.",
      { currentQuantity: quantityBefore },
    );
  }
  const createdAt = new Date().toISOString();
  const transactionId = `TX-${crypto.randomUUID()}`;
  const result = receiptResult(
    input.materialId,
    input,
    quantityBefore,
    versionBefore + 1,
    transactionId,
  );
  const statements: D1Statement[] = [
    insertCommandStatement(
      db,
      input.requestId,
      requestHash,
      actor.id,
      "stock.receive",
      "material",
      input.materialId,
      createdAt,
    ),
    insertReceiptTransactionStatement(
      db,
      transactionId,
      input.requestId,
      input,
      actor.id,
      createdAt,
    ),
  ];
  if (quantityBefore === 0) {
    statements.push(
      db.prepare(`
        INSERT INTO holdings (
          material_id, location_id, condition, quantity, version, updated_at
        ) VALUES (
          (SELECT id FROM materials WHERE id = ? AND status = 'active' AND archived_at IS NULL),
          (SELECT id FROM locations WHERE id = ? AND status = 'active' AND type != 'service'),
          ?, ?, 1, ?
        )
      `).bind(
        input.materialId,
        input.locationId,
        input.condition,
        input.quantity,
        createdAt,
      ),
    );
  } else {
    statements.push(
      db.prepare(`
        UPDATE holdings
        SET quantity = ?, version = ?, updated_at = ?
        WHERE material_id = ? AND location_id = ? AND condition = ?
          AND quantity = ? AND version = ?
          AND EXISTS (
            SELECT 1 FROM materials
            WHERE id = ? AND status = 'active' AND archived_at IS NULL
          )
          AND EXISTS (
            SELECT 1 FROM locations
            WHERE id = ? AND status = 'active' AND type != 'service'
          )
      `).bind(
        result.quantityAfter,
        result.holdingVersion,
        createdAt,
        input.materialId,
        input.locationId,
        input.condition,
        quantityBefore,
        versionBefore,
        input.materialId,
        input.locationId,
      ),
    );
  }
  statements.push(
    guardedInventoryLineStatement(db, {
      lineId: `LINE-${crypto.randomUUID()}`,
      transactionId,
      materialId: input.materialId,
      locationId: input.locationId,
      condition: input.condition,
      quantityDelta: input.quantity,
      quantityBefore,
      quantityAfter: result.quantityAfter,
      countedQuantity: null,
      createdAt,
      guardSql: `
        SELECT h.material_id FROM holdings h
        JOIN materials m ON m.id = h.material_id
        JOIN locations l ON l.id = h.location_id
        WHERE h.material_id = ? AND h.location_id = ? AND h.condition = ?
          AND h.quantity = ? AND h.version = ? AND changes() = 1
          AND m.status = 'active' AND m.archived_at IS NULL
          AND l.status = 'active' AND l.type != 'service'
      `,
      guardBindings: [
        input.materialId,
        input.locationId,
        input.condition,
        result.quantityAfter,
        result.holdingVersion,
      ],
    }),
    rebuildStockTotalsStatement(db, input.materialId, createdAt),
    receiptAuditStatement(db, actor, input.requestId, result, createdAt),
    completeCommandStatement(db, input.requestId, result, createdAt),
  );
  const replayed = await executeIdempotentBatch<ReceiptMutationResult>(
    db,
    statements,
    input.requestId,
    requestHash,
    {
      code: "stock_quantity_conflict",
      message: "Залишок змінився під час надходження. Оновіть картку.",
    },
  );
  return replayed ?? result;
}

export async function updateMaterialDirect(
  user: ChatGPTUser,
  materialId: string,
  input: MaterialUpdateInput,
  providedDb?: LibraryD1Database,
): Promise<MaterialMutationResult> {
  const db = database(providedDb);
  const actor = await resolveMutationActor(db, user);
  const requestHash = await mutationHash({
    kind: "material.update",
    actorUserId: actor.id,
    materialId,
    input,
  });
  const replay = await replayCompletedCommand<MaterialMutationResult>(
    db,
    input.requestId,
    requestHash,
  );
  if (replay) return replay;

  const material = await db.prepare(`
    SELECT
      id, catalog_number, title, sort_title, search_text, rubric,
      publication_type, subject, class_from, class_to, author,
      publication_year, isbn, isbn_normalized, publisher, notes,
      status, version, updated_at, archived_at
    FROM materials
    WHERE id = ? AND status = 'active' AND archived_at IS NULL
    LIMIT 1
  `).bind(materialId).first<MaterialRow>();
  if (!material) {
    throw new LibraryMutationError(
      "material_not_found",
      404,
      "Матеріал не знайдено або він заархівований.",
    );
  }
  if (Number(material.version) !== input.expectedVersion) {
    throw new LibraryMutationError(
      "material_version_conflict",
      409,
      "Матеріал уже змінено в іншій вкладці. Оновіть картку.",
      { currentVersion: Number(material.version) },
    );
  }

  const currentLinks = await readMaterialLinks(db, materialId);
  const persistedLinks = input.changes.links?.map((link) => ({
    id: `LINK-${crypto.randomUUID()}`,
    kind: link.kind,
    label: link.label,
    url: link.url,
    isPublic: link.isPublic,
    sortOrder: link.sortOrder,
    status: "active",
  }));
  const before = materialSnapshot(material, currentLinks);
  const after = applyMaterialChanges(before, input.changes, persistedLinks);
  const nextIsbnNormalized = normalizeIsbn(after.isbn);
  if ("isbn" in input.changes && nextIsbnNormalized) {
    const duplicate = await db.prepare(`
      SELECT id FROM materials
      WHERE isbn_normalized = ? AND id != ?
        AND status = 'active' AND archived_at IS NULL
      LIMIT 1
    `).bind(nextIsbnNormalized, materialId).first<{ id: string }>();
    if (duplicate) {
      throw new LibraryMutationError(
        "duplicate_isbn",
        409,
        "Матеріал із цим ISBN уже є в каталозі.",
        { materialId: duplicate.id },
      );
    }
  }
  const updatedAt = new Date().toISOString();
  const nextVersion = input.expectedVersion + 1;
  const result: MaterialMutationResult = {
    materialId,
    version: nextVersion,
    updatedAt,
  };

  const assignments: string[] = [];
  const bindings: D1Value[] = [];
  const scalarColumns: Array<[keyof MaterialUpdateInput["changes"], string]> = [
    ["title", "title"],
    ["rubric", "rubric"],
    ["publicationType", "publication_type"],
    ["subject", "subject"],
    ["classFrom", "class_from"],
    ["classTo", "class_to"],
    ["author", "author"],
    ["publicationYear", "publication_year"],
    ["isbn", "isbn"],
    ["publisher", "publisher"],
    ["notes", "notes"],
  ];
  for (const [key, column] of scalarColumns) {
    if (!(key in input.changes)) continue;
    assignments.push(`${column} = ?`);
    const value = input.changes[key];
    bindings.push(
      value === null && !["classFrom", "classTo", "publicationYear"].includes(key)
        ? ""
        : (value as D1Value),
    );
  }
  assignments.push(
    "sort_title = ?",
    "search_text = ?",
    "isbn_normalized = ?",
    "version = ?",
    "updated_at = ?",
  );
  bindings.push(
    normalizeSearchText(after.title),
    materialSearchText(after),
    nextIsbnNormalized,
    nextVersion,
    updatedAt,
    materialId,
    input.expectedVersion,
    nextIsbnNormalized,
    nextIsbnNormalized,
    materialId,
  );

  const statements: D1Statement[] = [
    insertCommandStatement(
      db,
      input.requestId,
      requestHash,
      actor.id,
      "material.update",
      "material",
      materialId,
      updatedAt,
    ),
    db.prepare(`
      UPDATE materials
      SET ${assignments.join(", ")}
      WHERE id = ? AND version = ? AND status = 'active' AND archived_at IS NULL
        AND (? = '' OR NOT EXISTS (
          SELECT 1 FROM materials other
          WHERE other.isbn_normalized = ? AND other.id != ?
            AND other.status = 'active' AND other.archived_at IS NULL
        ))
    `).bind(...bindings),
    db.prepare(`
      INSERT INTO audit_events (
        id, actor_user_id, actor_email, action, entity_type, entity_id,
        request_id, before_json, after_json, metadata_json, created_at
      ) VALUES (
        ?, ?, ?, 'material.updated', 'material',
        (
          SELECT id FROM materials
          WHERE id = ? AND version = ? AND updated_at = ? AND changes() = 1
        ),
        ?, ?, ?, NULL, ?
      )
    `).bind(
      crypto.randomUUID(),
      actor.id,
      actor.email,
      materialId,
      nextVersion,
      updatedAt,
      input.requestId,
      JSON.stringify(before),
      JSON.stringify(after),
      updatedAt,
    ),
    // Keep FTS after the audit: its guard must observe the material UPDATE's changes().
    deleteMaterialSearchStatement(db, material, nextVersion),
    insertMaterialSearchStatement(db, materialId, nextVersion),
  ];

  if (input.changes.links) {
    statements.push(
      db.prepare("DELETE FROM material_links WHERE material_id = ?").bind(materialId),
    );
    for (const link of persistedLinks ?? []) {
      statements.push(
        db.prepare(`
          INSERT INTO material_links (
            id, material_id, kind, label, url, is_public, sort_order,
            status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
        `).bind(
          link.id,
          materialId,
          link.kind,
          link.label,
          link.url,
          link.isPublic ? 1 : 0,
          link.sortOrder,
          updatedAt,
          updatedAt,
        ),
      );
    }
  }
  statements.push(
    completeCommandStatement(db, input.requestId, result, updatedAt),
  );

  const replayed = await executeIdempotentBatch<MaterialMutationResult>(
    db,
    statements,
    input.requestId,
    requestHash,
    {
      code: "material_version_conflict",
      message: "Матеріал уже змінено в іншій вкладці. Оновіть картку.",
    },
  );
  return replayed ?? result;
}

export async function archiveMaterialDirect(
  user: ChatGPTUser,
  materialId: string,
  input: MaterialArchiveInput,
  providedDb?: LibraryD1Database,
): Promise<MaterialArchiveResult> {
  const db = database(providedDb);
  const actor = await resolveMutationActor(db, user);
  const requestHash = await mutationHash({
    kind: "material.archive",
    actorUserId: actor.id,
    materialId,
    input,
  });
  const replay = await replayCompletedCommand<MaterialArchiveResult>(
    db,
    input.requestId,
    requestHash,
  );
  if (replay) return replay;

  const material = await db.prepare(`
    SELECT
      id, catalog_number, title, sort_title, search_text, rubric,
      publication_type, subject, class_from, class_to, author,
      publication_year, isbn, isbn_normalized, publisher, notes,
      status, version, updated_at, archived_at
    FROM materials
    WHERE id = ? AND status = 'active' AND archived_at IS NULL
    LIMIT 1
  `).bind(materialId).first<MaterialRow>();
  if (!material) {
    throw new LibraryMutationError(
      "material_not_found",
      404,
      "Матеріал не знайдено або його вже видалено з каталогу.",
    );
  }
  if (Number(material.version) !== input.expectedVersion) {
    throw new LibraryMutationError(
      "material_version_conflict",
      409,
      "Матеріал уже змінено в іншій вкладці. Оновіть картку перед видаленням.",
      { currentVersion: Number(material.version) },
    );
  }

  const stock = await db.prepare(`
    SELECT
      COALESCE((
        SELECT SUM(h.quantity) FROM holdings h
        WHERE h.material_id = ? AND h.quantity > 0
      ), 0) + COALESCE((
        SELECT SUM(li.quantity_issued - li.quantity_returned)
        FROM loan_items li
        JOIN loans lo ON lo.id = li.loan_id
        WHERE li.material_id = ? AND lo.status != 'cancelled'
          AND li.quantity_issued > li.quantity_returned
      ), 0) + COALESCE((
        SELECT SUM(cli.quantity_issued - cli.quantity_returned)
        FROM class_loan_items cli
        JOIN class_loans clo ON clo.id = cli.class_loan_id
        WHERE cli.material_id = ? AND clo.status != 'cancelled'
          AND cli.quantity_issued > cli.quantity_returned
      ), 0) AS total_quantity,
      COALESCE((
        SELECT SUM(li.quantity_issued - li.quantity_returned)
        FROM loan_items li
        JOIN loans lo ON lo.id = li.loan_id
        WHERE li.material_id = ? AND lo.status != 'cancelled'
          AND li.quantity_issued > li.quantity_returned
      ), 0) + COALESCE((
        SELECT SUM(cli.quantity_issued - cli.quantity_returned)
        FROM class_loan_items cli
        JOIN class_loans clo ON clo.id = cli.class_loan_id
        WHERE cli.material_id = ? AND clo.status != 'cancelled'
          AND cli.quantity_issued > cli.quantity_returned
      ), 0) AS loaned_quantity,
      COALESCE((
        SELECT SUM(reservation.reserved_quantity-reservation.issued_quantity-reservation.released_quantity)
        FROM material_request_reservations reservation
        WHERE reservation.material_id=?
          AND reservation.reserved_quantity>reservation.issued_quantity+reservation.released_quantity
      ), 0) AS reserved_quantity
  `).bind(materialId, materialId, materialId, materialId, materialId, materialId)
    .first<{ total_quantity: number; loaned_quantity: number; reserved_quantity: number }>();
  const totalQuantity = Number(stock?.total_quantity ?? 0);
  const loanedQuantity = Number(stock?.loaned_quantity ?? 0);
  const reservedQuantity = Number(stock?.reserved_quantity ?? 0);
  if (reservedQuantity > 0) {
    throw new LibraryMutationError(
      "material_reserved_conflict",
      409,
      "Матеріал зарезервовано для замовлення вчителя. Спочатку видайте або звільніть резерв.",
      { reservedQuantity },
    );
  }
  if (totalQuantity > 0 || loanedQuantity > 0) {
    throw new LibraryMutationError(
      "material_has_stock",
      409,
      "Матеріал має примірники або незавершені видачі. Спочатку поверніть видане та обнуліть залишок через списання.",
      { totalQuantity, loanedQuantity },
    );
  }

  const links = await readMaterialLinks(db, materialId);
  const before = {
    ...materialSnapshot(material, links),
    status: "active",
    archivedAt: null,
  };
  const archivedAt = new Date().toISOString();
  const nextVersion = input.expectedVersion + 1;
  const after = {
    ...before,
    status: "archived",
    version: nextVersion,
    archivedAt,
  };
  const result: MaterialArchiveResult = {
    materialId,
    version: nextVersion,
    archivedAt,
  };

  const statements: D1Statement[] = [
    insertCommandStatement(
      db,
      input.requestId,
      requestHash,
      actor.id,
      "material.archive",
      "material",
      materialId,
      archivedAt,
    ),
    db.prepare(`
      UPDATE materials
      SET status = 'archived', version = ?, updated_at = ?, archived_at = ?
      WHERE id = ? AND version = ? AND status = 'active' AND archived_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM holdings h
          WHERE h.material_id = ? AND h.quantity > 0
        )
        AND NOT EXISTS (
          SELECT 1
          FROM loan_items li
          JOIN loans lo ON lo.id = li.loan_id
          WHERE li.material_id = ? AND lo.status != 'cancelled'
            AND li.quantity_issued > li.quantity_returned
        )
        AND NOT EXISTS (
          SELECT 1
          FROM class_loan_items cli
          JOIN class_loans clo ON clo.id = cli.class_loan_id
          WHERE cli.material_id = ? AND clo.status != 'cancelled'
            AND cli.quantity_issued > cli.quantity_returned
        )
    `).bind(
      nextVersion,
      archivedAt,
      archivedAt,
      materialId,
      input.expectedVersion,
      materialId,
      materialId,
      materialId,
    ),
    db.prepare(`
      INSERT INTO audit_events (
        id, actor_user_id, actor_email, action, entity_type, entity_id,
        request_id, before_json, after_json, metadata_json, created_at
      ) VALUES (
        ?, ?, ?, 'material.archived', 'material',
        (
          SELECT id FROM materials
          WHERE id = ? AND version = ? AND status = 'archived'
            AND archived_at = ? AND changes() = 1
        ),
        ?, ?, ?, ?, ?
      )
    `).bind(
      crypto.randomUUID(),
      actor.id,
      actor.email,
      materialId,
      nextVersion,
      archivedAt,
      input.requestId,
      JSON.stringify(before),
      JSON.stringify(after),
      JSON.stringify({ mode: "archive", historyPreserved: true }),
      archivedAt,
    ),
    completeCommandStatement(db, input.requestId, result, archivedAt),
  ];

  try {
    const replayed = await executeIdempotentBatch<MaterialArchiveResult>(
      db,
      statements,
      input.requestId,
      requestHash,
      {
        code: "material_archive_conflict",
        message: "Матеріал або його залишок змінилися під час видалення. Оновіть картку й перевірте залишок.",
      },
    );
    return replayed ?? result;
  } catch (error) {
    if (
      error instanceof LibraryMutationError
      && error.code === "material_archive_conflict"
      && await activeMaterialReservationQuantity(db, materialId) > 0
    ) {
      throw new LibraryMutationError(
        "material_reserved_conflict",
        409,
        "Матеріал зарезервовано для замовлення вчителя.",
      );
    }
    throw error;
  }
}

export async function adjustHoldingToActualCount(
  user: ChatGPTUser,
  input: StockAdjustmentInput,
  providedDb?: LibraryD1Database,
): Promise<StockAdjustmentResult> {
  const db = database(providedDb);
  const actor = await resolveMutationActor(db, user);
  const requestHash = await mutationHash({
    kind: "stock.adjust",
    actorUserId: actor.id,
    input,
  });
  const replay = await replayCompletedCommand<StockAdjustmentResult>(
    db,
    input.requestId,
    requestHash,
  );
  if (replay) return replay;

  const [material, location, holding] = await Promise.all([
    db.prepare(`
      SELECT id FROM materials
      WHERE id = ? AND status = 'active' AND archived_at IS NULL
      LIMIT 1
    `).bind(input.materialId).first<{ id: string }>(),
    db.prepare(`
      SELECT id, type FROM locations
      WHERE id = ? AND status = 'active'
      LIMIT 1
    `).bind(input.locationId).first<{ id: string; type: string }>(),
    db.prepare(`
      SELECT quantity, version FROM holdings
      WHERE material_id = ? AND location_id = ? AND condition = ?
      LIMIT 1
    `).bind(
      input.materialId,
      input.locationId,
      input.condition,
    ).first<{ quantity: number; version: number }>(),
  ]);
  if (!material) {
    throw new LibraryMutationError("material_not_found", 404, "Матеріал не знайдено.");
  }
  if (!location) {
    throw new LibraryMutationError("location_not_found", 404, "Місце не знайдено.");
  }
  if (location.type === "service") {
    throw new LibraryMutationError(
      "service_location_not_countable",
      400,
      "Службове місце не можна коригувати вручну.",
    );
  }

  const quantityBefore = holding ? Number(holding.quantity) : 0;
  const previousVersion = holding ? Number(holding.version) : 0;
  if (quantityBefore !== input.expectedQuantity) {
    throw new LibraryMutationError(
      "stock_quantity_conflict",
      409,
      "Залишок уже змінився. Оновіть картку матеріалу.",
      { currentQuantity: quantityBefore },
    );
  }
  const reservedQuantity = await activeReservedQuantity(
    db,
    input.materialId,
    input.locationId,
    input.condition,
  );
  if (input.countedQuantity < reservedQuantity) {
    throw new LibraryMutationError(
      "reserved_stock_conflict",
      409,
      "Фактичний залишок не може бути меншим за підготовлений резерв.",
      { reservedQuantity, minimumQuantity: reservedQuantity },
    );
  }

  const quantityDelta = input.countedQuantity - quantityBefore;
  const createdAt = new Date().toISOString();
  const transactionId = `TX-${crypto.randomUUID()}`;
  const holdingVersion = input.countedQuantity > 0 ? previousVersion + 1 : null;
  const result: StockAdjustmentResult = {
    materialId: input.materialId,
    locationId: input.locationId,
    condition: input.condition,
    quantityBefore,
    countedQuantity: input.countedQuantity,
    quantityDelta,
    holdingVersion,
    transactionId,
    occurredAt: input.occurredAt,
  };
  const statements: D1Statement[] = [
    insertCommandStatement(
      db,
      input.requestId,
      requestHash,
      actor.id,
      "stock.adjust",
      "material",
      input.materialId,
      createdAt,
    ),
    db.prepare(`
      INSERT INTO inventory_transactions (
        id, request_id, kind, occurred_at, document_number, reason, notes,
        loan_id, actor_user_id, reversal_of_id, status, created_at
      ) VALUES (?, ?, 'stock_count', ?, NULL, ?, ?, NULL, ?, NULL, 'posted', ?)
    `).bind(
      transactionId,
      input.requestId,
      input.occurredAt,
      input.reason,
      input.notes ?? "",
      actor.id,
      createdAt,
    ),
  ];

  const lineId = `LINE-${crypto.randomUUID()}`;
  if (quantityBefore === 0 && input.countedQuantity === 0) {
    statements.push(
      db.prepare(`
        INSERT INTO inventory_transaction_lines (
          id, transaction_id, material_id, location_id, condition,
          quantity_delta, quantity_before, quantity_after, counted_quantity,
          loan_item_id, created_at
        )
        VALUES (
          ?, ?, (
            SELECT m.id FROM materials m JOIN locations l ON l.id = ?
            WHERE m.id = ?
              AND m.status = 'active' AND m.archived_at IS NULL
              AND l.status = 'active' AND l.type != 'service'
              AND NOT EXISTS (
              SELECT 1 FROM holdings h
              WHERE h.material_id = m.id AND h.location_id = l.id AND h.condition = ?
            )
          ), ?, ?, 0, 0, 0, 0, NULL, ?
        )
      `).bind(
        lineId,
        transactionId,
        input.locationId,
        input.materialId,
        input.condition,
        input.locationId,
        input.condition,
        createdAt,
      ),
    );
  } else if (quantityBefore === 0) {
    statements.push(
      db.prepare(`
        INSERT INTO holdings (
          material_id, location_id, condition, quantity, version, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?)
      `).bind(
        input.materialId,
        input.locationId,
        input.condition,
        input.countedQuantity,
        createdAt,
      ),
      guardedInventoryLineStatement(db, {
        lineId,
        transactionId,
        materialId: input.materialId,
        locationId: input.locationId,
        condition: input.condition,
        quantityDelta,
        quantityBefore,
        quantityAfter: input.countedQuantity,
        countedQuantity: input.countedQuantity,
        createdAt,
        guardSql: `
          SELECT h.material_id
          FROM holdings h
          JOIN materials m ON m.id = h.material_id
          JOIN locations l ON l.id = h.location_id
          WHERE h.material_id = ? AND h.location_id = ? AND h.condition = ?
            AND h.quantity = ? AND h.version = 1 AND changes() = 1
            AND m.status = 'active' AND m.archived_at IS NULL
            AND l.status = 'active' AND l.type != 'service'
        `,
        guardBindings: [
          input.materialId,
          input.locationId,
          input.condition,
          input.countedQuantity,
        ],
      }),
    );
  } else if (input.countedQuantity === 0) {
    statements.push(
      db.prepare(`
        DELETE FROM holdings
        WHERE material_id = ? AND location_id = ? AND condition = ?
          AND quantity = ? AND version = ?
      `).bind(
        input.materialId,
        input.locationId,
        input.condition,
        quantityBefore,
        previousVersion,
      ),
      guardedInventoryLineStatement(db, {
        lineId,
        transactionId,
        materialId: input.materialId,
        locationId: input.locationId,
        condition: input.condition,
        quantityDelta,
        quantityBefore,
        quantityAfter: 0,
        countedQuantity: 0,
        createdAt,
        guardSql: `
          SELECT id FROM materials
          WHERE id = ? AND status = 'active' AND archived_at IS NULL
            AND changes() = 1
        `,
        guardBindings: [input.materialId],
      }),
    );
  } else {
    statements.push(
      db.prepare(`
        UPDATE holdings
        SET quantity = ?, version = ?, updated_at = ?
        WHERE material_id = ? AND location_id = ? AND condition = ?
          AND quantity = ? AND version = ?
      `).bind(
        input.countedQuantity,
        previousVersion + 1,
        createdAt,
        input.materialId,
        input.locationId,
        input.condition,
        quantityBefore,
        previousVersion,
      ),
      guardedInventoryLineStatement(db, {
        lineId,
        transactionId,
        materialId: input.materialId,
        locationId: input.locationId,
        condition: input.condition,
        quantityDelta,
        quantityBefore,
        quantityAfter: input.countedQuantity,
        countedQuantity: input.countedQuantity,
        createdAt,
        guardSql: `
          SELECT h.material_id
          FROM holdings h
          JOIN materials m ON m.id = h.material_id
          JOIN locations l ON l.id = h.location_id
          WHERE h.material_id = ? AND h.location_id = ? AND h.condition = ?
            AND h.quantity = ? AND h.version = ? AND changes() = 1
            AND m.status = 'active' AND m.archived_at IS NULL
            AND l.status = 'active' AND l.type != 'service'
        `,
        guardBindings: [
          input.materialId,
          input.locationId,
          input.condition,
          input.countedQuantity,
          previousVersion + 1,
        ],
      }),
    );
  }

  statements.push(
    rebuildStockTotalsStatement(db, input.materialId, createdAt),
    db.prepare(`
      INSERT INTO audit_events (
        id, actor_user_id, actor_email, action, entity_type, entity_id,
        request_id, before_json, after_json, metadata_json, created_at
      ) VALUES (?, ?, ?, 'stock.counted', 'material', ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      actor.id,
      actor.email,
      input.materialId,
      input.requestId,
      JSON.stringify({
        locationId: input.locationId,
        condition: input.condition,
        quantity: quantityBefore,
      }),
      JSON.stringify({
        locationId: input.locationId,
        condition: input.condition,
        quantity: input.countedQuantity,
      }),
      JSON.stringify({
        transactionId,
        delta: quantityDelta,
        reason: input.reason,
        notes: input.notes,
      }),
      createdAt,
    ),
    completeCommandStatement(db, input.requestId, result, createdAt),
  );

  const replayed = await executeIdempotentBatch<StockAdjustmentResult>(
    db,
    statements,
    input.requestId,
    requestHash,
    {
      code: "stock_quantity_conflict",
      message: "Залишок уже змінився. Оновіть картку матеріалу.",
    },
  );
  return replayed ?? result;
}

export async function transferStockDirect(
  user: ChatGPTUser,
  input: StockTransferInput,
  providedDb?: LibraryD1Database,
): Promise<StockTransferResult> {
  const db = database(providedDb);
  const actor = await resolveMutationActor(db, user);
  const requestHash = await mutationHash({
    kind: "stock.transfer",
    actorUserId: actor.id,
    input,
  });
  const replay = await replayCompletedCommand<StockTransferResult>(
    db,
    input.requestId,
    requestHash,
  );
  if (replay) return replay;

  const [material, sourceLocation, destinationLocation, sourceHolding, destinationHolding] =
    await Promise.all([
      db.prepare(`
        SELECT id FROM materials
        WHERE id = ? AND status = 'active' AND archived_at IS NULL
        LIMIT 1
      `).bind(input.materialId).first<{ id: string }>(),
      db.prepare(`
        SELECT id, type FROM locations
        WHERE id = ? AND status = 'active'
        LIMIT 1
      `).bind(input.sourceLocationId).first<{ id: string; type: string }>(),
      db.prepare(`
        SELECT id, type FROM locations
        WHERE id = ? AND status = 'active'
        LIMIT 1
      `).bind(input.destinationLocationId).first<{ id: string; type: string }>(),
      db.prepare(`
        SELECT quantity, version FROM holdings
        WHERE material_id = ? AND location_id = ? AND condition = ?
        LIMIT 1
      `).bind(
        input.materialId,
        input.sourceLocationId,
        input.condition,
      ).first<{ quantity: number; version: number }>(),
      db.prepare(`
        SELECT quantity, version FROM holdings
        WHERE material_id = ? AND location_id = ? AND condition = ?
        LIMIT 1
      `).bind(
        input.materialId,
        input.destinationLocationId,
        input.condition,
      ).first<{ quantity: number; version: number }>(),
    ]);
  if (!material) {
    throw new LibraryMutationError("material_not_found", 404, "Матеріал не знайдено.");
  }
  if (!sourceLocation || sourceLocation.type === "service") {
    throw new LibraryMutationError(
      "source_location_not_found",
      404,
      "Початкове місце переміщення не знайдено або воно недоступне.",
    );
  }
  if (!destinationLocation || destinationLocation.type === "service") {
    throw new LibraryMutationError(
      "destination_location_not_found",
      404,
      "Кінцеве місце переміщення не знайдено або воно недоступне.",
    );
  }

  const sourceQuantityBefore = sourceHolding ? Number(sourceHolding.quantity) : 0;
  const sourceVersionBefore = sourceHolding ? Number(sourceHolding.version) : 0;
  const destinationQuantityBefore = destinationHolding
    ? Number(destinationHolding.quantity)
    : 0;
  const destinationVersionBefore = destinationHolding
    ? Number(destinationHolding.version)
    : 0;
  if (
    sourceQuantityBefore !== input.expectedSourceQuantity ||
    destinationQuantityBefore !== input.expectedDestinationQuantity
  ) {
    throw new LibraryMutationError(
      "stock_quantity_conflict",
      409,
      "Залишок у початковому або кінцевому місці вже змінився. Оновіть картку матеріалу.",
      {
        currentSourceQuantity: sourceQuantityBefore,
        currentDestinationQuantity: destinationQuantityBefore,
      },
    );
  }
  if (sourceQuantityBefore < input.quantity) {
    throw new LibraryMutationError(
      "insufficient_stock",
      409,
      "У початковому місці недостатньо примірників.",
      { availableQuantity: sourceQuantityBefore },
    );
  }
  const sourceReservedQuantity = await activeReservedQuantity(
    db,
    input.materialId,
    input.sourceLocationId,
    input.condition,
  );
  if (sourceQuantityBefore - input.quantity < sourceReservedQuantity) {
    throw new LibraryMutationError(
      "reserved_stock_conflict",
      409,
      "Ці примірники зарезервовано для замовлення вчителя.",
      { reservedQuantity: sourceReservedQuantity, availableQuantity: sourceQuantityBefore - sourceReservedQuantity },
    );
  }

  const sourceQuantityAfter = sourceQuantityBefore - input.quantity;
  const destinationQuantityAfter = destinationQuantityBefore + input.quantity;
  const createdAt = new Date().toISOString();
  const transactionId = `TX-${crypto.randomUUID()}`;
  const result: StockTransferResult = {
    materialId: input.materialId,
    sourceLocationId: input.sourceLocationId,
    destinationLocationId: input.destinationLocationId,
    condition: input.condition,
    quantityMoved: input.quantity,
    sourceQuantityBefore,
    sourceQuantityAfter,
    sourceHoldingVersion: sourceQuantityAfter > 0 ? sourceVersionBefore + 1 : null,
    destinationQuantityBefore,
    destinationQuantityAfter,
    destinationHoldingVersion: destinationVersionBefore + 1,
    transactionId,
    occurredAt: input.occurredAt,
  };
  const statements: D1Statement[] = [
    insertCommandStatement(
      db,
      input.requestId,
      requestHash,
      actor.id,
      "stock.transfer",
      "material",
      input.materialId,
      createdAt,
    ),
    db.prepare(`
      INSERT INTO inventory_transactions (
        id, request_id, kind, occurred_at, document_number, reason, notes,
        loan_id, actor_user_id, reversal_of_id, status, created_at
      ) VALUES (?, ?, 'transfer', ?, ?, NULL, ?, NULL, ?, NULL, 'posted', ?)
    `).bind(
      transactionId,
      input.requestId,
      input.occurredAt,
      input.documentNumber,
      input.notes ?? "",
      actor.id,
      createdAt,
    ),
  ];

  if (sourceQuantityAfter === 0) {
    statements.push(
      db.prepare(`
        DELETE FROM holdings
        WHERE material_id = ? AND location_id = ? AND condition = ?
          AND quantity = ? AND version = ?
          AND EXISTS (
            SELECT 1 FROM materials
            WHERE id = ? AND status = 'active' AND archived_at IS NULL
          )
          AND EXISTS (
            SELECT 1 FROM locations
            WHERE id = ? AND status = 'active' AND type != 'service'
          )
      `).bind(
        input.materialId,
        input.sourceLocationId,
        input.condition,
        sourceQuantityBefore,
        sourceVersionBefore,
        input.materialId,
        input.sourceLocationId,
      ),
    );
  } else {
    statements.push(
      db.prepare(`
        UPDATE holdings
        SET quantity = ?, version = ?, updated_at = ?
        WHERE material_id = ? AND location_id = ? AND condition = ?
          AND quantity = ? AND version = ?
          AND EXISTS (
            SELECT 1 FROM materials
            WHERE id = ? AND status = 'active' AND archived_at IS NULL
          )
          AND EXISTS (
            SELECT 1 FROM locations
            WHERE id = ? AND status = 'active' AND type != 'service'
          )
      `).bind(
        sourceQuantityAfter,
        sourceVersionBefore + 1,
        createdAt,
        input.materialId,
        input.sourceLocationId,
        input.condition,
        sourceQuantityBefore,
        sourceVersionBefore,
        input.materialId,
        input.sourceLocationId,
      ),
    );
  }
  statements.push(
    guardedInventoryLineStatement(db, {
      lineId: `LINE-${crypto.randomUUID()}`,
      transactionId,
      materialId: input.materialId,
      locationId: input.sourceLocationId,
      condition: input.condition,
      quantityDelta: -input.quantity,
      quantityBefore: sourceQuantityBefore,
      quantityAfter: sourceQuantityAfter,
      countedQuantity: null,
      createdAt,
      guardSql: `
        SELECT id FROM materials
        WHERE id = ? AND status = 'active' AND archived_at IS NULL
          AND changes() = 1
      `,
      guardBindings: [input.materialId],
    }),
  );

  if (destinationQuantityBefore === 0) {
    statements.push(
      db.prepare(`
        INSERT INTO holdings (
          material_id, location_id, condition, quantity, version, updated_at
        ) VALUES (
          (SELECT id FROM materials
           WHERE id = ? AND status = 'active' AND archived_at IS NULL),
          (SELECT id FROM locations
           WHERE id = ? AND status = 'active' AND type != 'service'),
          ?, ?, 1, ?
        )
      `).bind(
        input.materialId,
        input.destinationLocationId,
        input.condition,
        destinationQuantityAfter,
        createdAt,
      ),
    );
  } else {
    statements.push(
      db.prepare(`
        UPDATE holdings
        SET quantity = ?, version = ?, updated_at = ?
        WHERE material_id = ? AND location_id = ? AND condition = ?
          AND quantity = ? AND version = ?
          AND EXISTS (
            SELECT 1 FROM materials
            WHERE id = ? AND status = 'active' AND archived_at IS NULL
          )
          AND EXISTS (
            SELECT 1 FROM locations
            WHERE id = ? AND status = 'active' AND type != 'service'
          )
      `).bind(
        destinationQuantityAfter,
        destinationVersionBefore + 1,
        createdAt,
        input.materialId,
        input.destinationLocationId,
        input.condition,
        destinationQuantityBefore,
        destinationVersionBefore,
        input.materialId,
        input.destinationLocationId,
      ),
    );
  }
  statements.push(
    guardedInventoryLineStatement(db, {
      lineId: `LINE-${crypto.randomUUID()}`,
      transactionId,
      materialId: input.materialId,
      locationId: input.destinationLocationId,
      condition: input.condition,
      quantityDelta: input.quantity,
      quantityBefore: destinationQuantityBefore,
      quantityAfter: destinationQuantityAfter,
      countedQuantity: null,
      createdAt,
      guardSql: `
        SELECT h.material_id FROM holdings h
        JOIN materials m ON m.id = h.material_id
        JOIN locations l ON l.id = h.location_id
        WHERE h.material_id = ? AND h.location_id = ? AND h.condition = ?
          AND h.quantity = ? AND h.version = ? AND changes() = 1
          AND m.status = 'active' AND m.archived_at IS NULL
          AND l.status = 'active' AND l.type != 'service'
      `,
      guardBindings: [
        input.materialId,
        input.destinationLocationId,
        input.condition,
        destinationQuantityAfter,
        destinationVersionBefore + 1,
      ],
    }),
    rebuildStockTotalsStatement(db, input.materialId, createdAt),
    db.prepare(`
      INSERT INTO audit_events (
        id, actor_user_id, actor_email, action, entity_type, entity_id,
        request_id, before_json, after_json, metadata_json, created_at
      ) VALUES (?, ?, ?, 'stock.transferred', 'material', ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      actor.id,
      actor.email,
      input.materialId,
      input.requestId,
      JSON.stringify({
        sourceLocationId: input.sourceLocationId,
        sourceQuantity: sourceQuantityBefore,
        destinationLocationId: input.destinationLocationId,
        destinationQuantity: destinationQuantityBefore,
        condition: input.condition,
      }),
      JSON.stringify({
        sourceLocationId: input.sourceLocationId,
        sourceQuantity: sourceQuantityAfter,
        destinationLocationId: input.destinationLocationId,
        destinationQuantity: destinationQuantityAfter,
        condition: input.condition,
      }),
      JSON.stringify({
        transactionId,
        quantityMoved: input.quantity,
        documentNumber: input.documentNumber,
        notes: input.notes,
      }),
      createdAt,
    ),
    completeCommandStatement(db, input.requestId, result, createdAt),
  );

  const replayed = await executeIdempotentBatch<StockTransferResult>(
    db,
    statements,
    input.requestId,
    requestHash,
    {
      code: "stock_quantity_conflict",
      message: "Залишок змінився під час переміщення. Оновіть картку матеріалу.",
    },
  );
  return replayed ?? result;
}

export async function writeOffStockDirect(
  user: ChatGPTUser,
  input: StockWriteoffInput,
  providedDb?: LibraryD1Database,
): Promise<StockWriteoffResult> {
  const db = database(providedDb);
  const actor = await resolveMutationActor(db, user);
  const requestHash = await mutationHash({
    kind: "stock.writeoff",
    actorUserId: actor.id,
    input,
  });
  const replay = await replayCompletedCommand<StockWriteoffResult>(
    db,
    input.requestId,
    requestHash,
  );
  if (replay) return replay;

  const [material, location, holding] = await Promise.all([
    db.prepare(`
      SELECT id FROM materials
      WHERE id = ? AND status = 'active' AND archived_at IS NULL
      LIMIT 1
    `).bind(input.materialId).first<{ id: string }>(),
    db.prepare(`
      SELECT id, type FROM locations
      WHERE id = ? AND status = 'active'
      LIMIT 1
    `).bind(input.locationId).first<{ id: string; type: string }>(),
    db.prepare(`
      SELECT quantity, version FROM holdings
      WHERE material_id = ? AND location_id = ? AND condition = ?
      LIMIT 1
    `).bind(
      input.materialId,
      input.locationId,
      input.condition,
    ).first<{ quantity: number; version: number }>(),
  ]);
  if (!material) {
    throw new LibraryMutationError("material_not_found", 404, "Матеріал не знайдено.");
  }
  if (!location || location.type === "service") {
    throw new LibraryMutationError(
      "location_not_found",
      404,
      "Місце списання не знайдено або воно недоступне.",
    );
  }

  const quantityBefore = holding ? Number(holding.quantity) : 0;
  const versionBefore = holding ? Number(holding.version) : 0;
  if (quantityBefore !== input.expectedQuantity) {
    throw new LibraryMutationError(
      "stock_quantity_conflict",
      409,
      "Залишок уже змінився. Оновіть картку матеріалу.",
      { currentQuantity: quantityBefore },
    );
  }
  if (quantityBefore < input.quantity) {
    throw new LibraryMutationError(
      "insufficient_stock",
      409,
      "Недостатньо примірників для списання.",
      { availableQuantity: quantityBefore },
    );
  }
  const reservedQuantity = await activeReservedQuantity(
    db,
    input.materialId,
    input.locationId,
    input.condition,
  );
  if (quantityBefore - input.quantity < reservedQuantity) {
    throw new LibraryMutationError(
      "reserved_stock_conflict",
      409,
      "Ці примірники зарезервовано для замовлення вчителя.",
      { reservedQuantity, availableQuantity: quantityBefore - reservedQuantity },
    );
  }

  const quantityAfter = quantityBefore - input.quantity;
  const createdAt = new Date().toISOString();
  const transactionId = `TX-${crypto.randomUUID()}`;
  const result: StockWriteoffResult = {
    materialId: input.materialId,
    locationId: input.locationId,
    condition: input.condition,
    quantityBefore,
    quantityWrittenOff: input.quantity,
    quantityAfter,
    holdingVersion: quantityAfter > 0 ? versionBefore + 1 : null,
    transactionId,
    occurredAt: input.occurredAt,
  };
  const statements: D1Statement[] = [
    insertCommandStatement(
      db,
      input.requestId,
      requestHash,
      actor.id,
      "stock.writeoff",
      "material",
      input.materialId,
      createdAt,
    ),
    db.prepare(`
      INSERT INTO inventory_transactions (
        id, request_id, kind, occurred_at, document_number, reason, notes,
        loan_id, actor_user_id, reversal_of_id, status, created_at
      ) VALUES (?, ?, 'writeoff', ?, ?, ?, ?, NULL, ?, NULL, 'posted', ?)
    `).bind(
      transactionId,
      input.requestId,
      input.occurredAt,
      input.documentNumber,
      input.reason,
      input.notes ?? "",
      actor.id,
      createdAt,
    ),
  ];

  if (quantityAfter === 0) {
    statements.push(
      db.prepare(`
        DELETE FROM holdings
        WHERE material_id = ? AND location_id = ? AND condition = ?
          AND quantity = ? AND version = ?
          AND EXISTS (
            SELECT 1 FROM materials
            WHERE id = ? AND status = 'active' AND archived_at IS NULL
          )
          AND EXISTS (
            SELECT 1 FROM locations
            WHERE id = ? AND status = 'active' AND type != 'service'
          )
      `).bind(
        input.materialId,
        input.locationId,
        input.condition,
        quantityBefore,
        versionBefore,
        input.materialId,
        input.locationId,
      ),
    );
  } else {
    statements.push(
      db.prepare(`
        UPDATE holdings
        SET quantity = ?, version = ?, updated_at = ?
        WHERE material_id = ? AND location_id = ? AND condition = ?
          AND quantity = ? AND version = ?
          AND EXISTS (
            SELECT 1 FROM materials
            WHERE id = ? AND status = 'active' AND archived_at IS NULL
          )
          AND EXISTS (
            SELECT 1 FROM locations
            WHERE id = ? AND status = 'active' AND type != 'service'
          )
      `).bind(
        quantityAfter,
        versionBefore + 1,
        createdAt,
        input.materialId,
        input.locationId,
        input.condition,
        quantityBefore,
        versionBefore,
        input.materialId,
        input.locationId,
      ),
    );
  }
  statements.push(
    guardedInventoryLineStatement(db, {
      lineId: `LINE-${crypto.randomUUID()}`,
      transactionId,
      materialId: input.materialId,
      locationId: input.locationId,
      condition: input.condition,
      quantityDelta: -input.quantity,
      quantityBefore,
      quantityAfter,
      countedQuantity: null,
      createdAt,
      guardSql: `
        SELECT id FROM materials
        WHERE id = ? AND status = 'active' AND archived_at IS NULL
          AND changes() = 1
      `,
      guardBindings: [input.materialId],
    }),
    rebuildStockTotalsStatement(db, input.materialId, createdAt),
    db.prepare(`
      INSERT INTO audit_events (
        id, actor_user_id, actor_email, action, entity_type, entity_id,
        request_id, before_json, after_json, metadata_json, created_at
      ) VALUES (?, ?, ?, 'stock.written_off', 'material', ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      actor.id,
      actor.email,
      input.materialId,
      input.requestId,
      JSON.stringify({
        locationId: input.locationId,
        condition: input.condition,
        quantity: quantityBefore,
      }),
      JSON.stringify({
        locationId: input.locationId,
        condition: input.condition,
        quantity: quantityAfter,
      }),
      JSON.stringify({
        transactionId,
        quantityWrittenOff: input.quantity,
        reason: input.reason,
        documentNumber: input.documentNumber,
        notes: input.notes,
      }),
      createdAt,
    ),
    completeCommandStatement(db, input.requestId, result, createdAt),
  );

  const replayed = await executeIdempotentBatch<StockWriteoffResult>(
    db,
    statements,
    input.requestId,
    requestHash,
    {
      code: "stock_quantity_conflict",
      message: "Залишок змінився під час списання. Оновіть картку матеріалу.",
    },
  );
  return replayed ?? result;
}

export async function issueLoanToTeacher(
  user: ChatGPTUser,
  input: LoanCreateInput,
  providedDb?: LibraryD1Database,
): Promise<LoanMutationResult> {
  const db = database(providedDb);
  const actor = await resolveMutationActor(db, user);
  const requestHash = await mutationHash({
    kind: "loan.issue",
    actorUserId: actor.id,
    input,
  });
  const replay = await replayCompletedCommand<LoanMutationResult>(
    db,
    input.requestId,
    requestHash,
  );
  if (replay) return replay;

  const teacher = await db.prepare(`
    SELECT id FROM users
    WHERE id = ? AND role = 'teacher' AND status = 'active'
    LIMIT 1
  `).bind(input.teacherUserId).first<{ id: string }>();
  if (!teacher) {
    throw new LibraryMutationError(
      "teacher_not_found",
      404,
      "Учителя не знайдено або його профіль неактивний.",
    );
  }

  const itemStates: Array<{
    quantity: number;
    version: number;
    locationType: string;
  }> = [];
  for (const item of input.items) {
    const state = await db.prepare(`
      SELECT h.quantity, h.version, l.type AS location_type
      FROM holdings h
      JOIN materials m ON m.id = h.material_id
      JOIN locations l ON l.id = h.location_id
      WHERE h.material_id = ? AND h.location_id = ? AND h.condition = ?
        AND m.status = 'active' AND m.archived_at IS NULL
        AND l.status = 'active' AND l.type != 'service'
      LIMIT 1
    `).bind(
      item.materialId,
      item.sourceLocationId,
      item.condition,
    ).first<{ quantity: number; version: number; location_type: string }>();
    const physicalQuantity = state ? Number(state.quantity) : 0;
    const reservedQuantity = await activeReservedQuantity(
      db,
      item.materialId,
      item.sourceLocationId,
      item.condition,
    );
    const currentQuantity = Math.max(0, physicalQuantity - reservedQuantity);
    if (currentQuantity !== item.expectedAvailableQuantity) {
      throw new LibraryMutationError(
        "stock_quantity_conflict",
        409,
        "Залишок одного з матеріалів уже змінився. Оновіть видачу.",
        { materialId: item.materialId, currentQuantity },
      );
    }
    if (!state || currentQuantity < item.quantity) {
      throw new LibraryMutationError(
        "insufficient_stock",
        409,
        "У вибраному місці недостатньо примірників.",
        { materialId: item.materialId, currentQuantity },
      );
    }
    itemStates.push({
      quantity: physicalQuantity,
      version: Number(state.version),
      locationType: state.location_type,
    });
  }

  const createdAt = new Date().toISOString();
  const loanId = `LOAN-${crypto.randomUUID()}`;
  const transactionId = `TX-${crypto.randomUUID()}`;
  const loanItemIds = input.items.map(() => `LI-${crypto.randomUUID()}`);
  const result: LoanMutationResult = {
    loanId,
    status: "open",
    teacherUserId: input.teacherUserId,
    issuedAt: input.issuedAt,
    dueAt: input.dueAt,
    closedAt: null,
    transactionId,
    items: input.items.map((item, index) => ({
      loanItemId: loanItemIds[index],
      materialId: item.materialId,
      quantityIssued: item.quantity,
      quantityReturned: 0,
    })),
  };
  const statements: D1Statement[] = [
    insertCommandStatement(
      db,
      input.requestId,
      requestHash,
      actor.id,
      "loan.issue",
      "loan",
      loanId,
      createdAt,
    ),
    db.prepare(`
      INSERT INTO loans (
        id, teacher_user_id, status, issued_at, due_at, closed_at, notes,
        issued_by_user_id, closed_by_user_id, version, created_at, updated_at
      ) VALUES (
        ?, (
          SELECT id FROM users
          WHERE id = ? AND role = 'teacher' AND status = 'active'
        ), 'open', ?, ?, NULL, ?, ?, NULL, 1, ?, ?
      )
    `).bind(
      loanId,
      input.teacherUserId,
      input.issuedAt,
      input.dueAt,
      input.notes ?? "",
      actor.id,
      createdAt,
      createdAt,
    ),
    db.prepare(`
      INSERT INTO inventory_transactions (
        id, request_id, kind, occurred_at, document_number, reason, notes,
        loan_id, actor_user_id, reversal_of_id, status, created_at
      ) VALUES (?, ?, 'loan_issue', ?, NULL, NULL, ?, ?, ?, NULL, 'posted', ?)
    `).bind(
      transactionId,
      input.requestId,
      input.issuedAt,
      input.notes ?? "",
      loanId,
      actor.id,
      createdAt,
    ),
  ];

  input.items.forEach((item, index) => {
    const state = itemStates[index];
    const afterQuantity = state.quantity - item.quantity;
    const loanItemId = loanItemIds[index];
    statements.push(
      db.prepare(`
        INSERT INTO loan_items (
          id, loan_id, material_id, source_location_id, condition,
          quantity_issued, quantity_returned, notes, created_at, updated_at
        ) VALUES (
          ?, ?,
          (SELECT id FROM materials WHERE id = ? AND status = 'active' AND archived_at IS NULL),
          (SELECT id FROM locations WHERE id = ? AND status = 'active' AND type != 'service'),
          ?, ?, 0, '', ?, ?
        )
      `).bind(
        loanItemId,
        loanId,
        item.materialId,
        item.sourceLocationId,
        item.condition,
        item.quantity,
        createdAt,
        createdAt,
      ),
    );
    if (afterQuantity === 0) {
      statements.push(
        db.prepare(`
          DELETE FROM holdings
          WHERE material_id = ? AND location_id = ? AND condition = ?
            AND quantity = ? AND version = ?
        `).bind(
          item.materialId,
          item.sourceLocationId,
          item.condition,
          state.quantity,
          state.version,
        ),
      );
    } else {
      statements.push(
        db.prepare(`
          UPDATE holdings
          SET quantity = ?, version = ?, updated_at = ?
          WHERE material_id = ? AND location_id = ? AND condition = ?
            AND quantity = ? AND version = ?
        `).bind(
          afterQuantity,
          state.version + 1,
          createdAt,
          item.materialId,
          item.sourceLocationId,
          item.condition,
          state.quantity,
          state.version,
        ),
      );
    }
    statements.push(
      guardedInventoryLineStatement(db, {
        lineId: `LINE-${crypto.randomUUID()}`,
        transactionId,
        materialId: item.materialId,
        locationId: item.sourceLocationId,
        condition: item.condition,
        quantityDelta: -item.quantity,
        quantityBefore: state.quantity,
        quantityAfter: afterQuantity,
        countedQuantity: null,
        loanItemId,
        createdAt,
        guardSql: afterQuantity === 0
          ? "SELECT id FROM materials WHERE id = ? AND changes() = 1"
          : `
              SELECT material_id FROM holdings
              WHERE material_id = ? AND location_id = ? AND condition = ?
                AND quantity = ? AND version = ? AND changes() = 1
            `,
        guardBindings: afterQuantity === 0
          ? [item.materialId]
          : [
              item.materialId,
              item.sourceLocationId,
              item.condition,
              afterQuantity,
              state.version + 1,
            ],
      }),
    );
  });

  for (const materialId of new Set(input.items.map((item) => item.materialId))) {
    statements.push(rebuildStockTotalsStatement(db, materialId, createdAt));
  }
  statements.push(
    db.prepare(`
      INSERT INTO audit_events (
        id, actor_user_id, actor_email, action, entity_type, entity_id,
        request_id, before_json, after_json, metadata_json, created_at
      ) VALUES (?, ?, ?, 'loan.issued', 'loan', ?, ?, NULL, ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      actor.id,
      actor.email,
      loanId,
      input.requestId,
      JSON.stringify(result),
      JSON.stringify({ transactionId }),
      createdAt,
    ),
    completeCommandStatement(db, input.requestId, result, createdAt),
  );

  const replayed = await executeIdempotentBatch<LoanMutationResult>(
    db,
    statements,
    input.requestId,
    requestHash,
    {
      code: "stock_quantity_conflict",
      message: "Залишок змінився під час видачі. Оновіть форму.",
    },
  );
  return replayed ?? result;
}

export async function returnLoanItems(
  user: ChatGPTUser,
  input: LoanReturnInput,
  providedDb?: LibraryD1Database,
): Promise<LoanMutationResult> {
  const db = database(providedDb);
  const actor = await resolveMutationActor(db, user);
  const requestHash = await mutationHash({
    kind: "loan.return",
    actorUserId: actor.id,
    input,
  });
  const replay = await replayCompletedCommand<LoanMutationResult>(
    db,
    input.requestId,
    requestHash,
  );
  if (replay) return replay;

  const loan = await db.prepare(`
    SELECT id, teacher_user_id, status, issued_at, due_at, version
    FROM loans WHERE id = ? LIMIT 1
  `).bind(input.loanId).first<{
    id: string;
    teacher_user_id: string;
    status: string;
    issued_at: string;
    due_at: string | null;
    version: number;
  }>();
  if (!loan) {
    throw new LibraryMutationError("loan_not_found", 404, "Видачу не знайдено.");
  }
  if (loan.status !== "open") {
    throw new LibraryMutationError(
      "loan_already_closed",
      409,
      "Цю видачу вже закрито або скасовано.",
    );
  }
  if (input.returnedAt < loan.issued_at) {
    throw new LibraryMutationError(
      "return_date_invalid",
      400,
      "Дата повернення не може передувати даті видачі.",
    );
  }

  const states: Array<{
    loanItemId: string;
    materialId: string;
    quantityIssued: number;
    quantityReturned: number;
    holdingQuantity: number;
    holdingVersion: number;
  }> = [];
  for (const item of input.items) {
    const loanItem = await db.prepare(`
      SELECT id, material_id, quantity_issued, quantity_returned
      FROM loan_items
      WHERE id = ? AND loan_id = ?
      LIMIT 1
    `).bind(item.loanItemId, input.loanId).first<{
      id: string;
      material_id: string;
      quantity_issued: number;
      quantity_returned: number;
    }>();
    if (!loanItem) {
      throw new LibraryMutationError(
        "loan_item_not_found",
        404,
        "Позицію видачі не знайдено.",
      );
    }
    const remaining = Number(loanItem.quantity_issued) - Number(loanItem.quantity_returned);
    if (item.quantity > remaining) {
      throw new LibraryMutationError(
        "return_quantity_exceeds_outstanding",
        409,
        "Кількість повернення перевищує неповернений залишок.",
        { loanItemId: item.loanItemId, remaining },
      );
    }
    const location = await db.prepare(`
      SELECT id FROM locations
      WHERE id = ? AND status = 'active' AND type != 'service'
      LIMIT 1
    `).bind(item.returnLocationId).first<{ id: string }>();
    if (!location) {
      throw new LibraryMutationError(
        "location_not_found",
        404,
        "Місце повернення не знайдено.",
      );
    }
    const holding = await db.prepare(`
      SELECT quantity, version FROM holdings
      WHERE material_id = ? AND location_id = ? AND condition = ?
      LIMIT 1
    `).bind(
      loanItem.material_id,
      item.returnLocationId,
      item.condition,
    ).first<{ quantity: number; version: number }>();
    states.push({
      loanItemId: loanItem.id,
      materialId: loanItem.material_id,
      quantityIssued: Number(loanItem.quantity_issued),
      quantityReturned: Number(loanItem.quantity_returned),
      holdingQuantity: holding ? Number(holding.quantity) : 0,
      holdingVersion: holding ? Number(holding.version) : 0,
    });
  }

  const allItems = await db.prepare(`
    SELECT id, material_id, quantity_issued, quantity_returned
    FROM loan_items WHERE loan_id = ?
  `).bind(input.loanId).all<{
    id: string;
    material_id: string;
    quantity_issued: number;
    quantity_returned: number;
  }>();
  const returningById = new Map(
    input.items.map((item) => [item.loanItemId, item.quantity]),
  );
  const willClose = (allItems.results ?? []).every((item) =>
    Number(item.quantity_returned) + (returningById.get(item.id) ?? 0)
      === Number(item.quantity_issued)
  );
  const createdAt = new Date().toISOString();
  const transactionId = `TX-${crypto.randomUUID()}`;
  const result: LoanMutationResult = {
    loanId: input.loanId,
    status: willClose ? "closed" : "open",
    teacherUserId: loan.teacher_user_id,
    issuedAt: loan.issued_at,
    dueAt: loan.due_at,
    closedAt: willClose ? input.returnedAt : null,
    transactionId,
    items: (allItems.results ?? []).map((item) => ({
      loanItemId: item.id,
      materialId: item.material_id,
      quantityIssued: Number(item.quantity_issued),
      quantityReturned:
        Number(item.quantity_returned) + (returningById.get(item.id) ?? 0),
    })),
  };
  const holdingGroups = new Map<string, {
    materialId: string;
    locationId: string;
    condition: string;
    quantityBefore: number;
    versionBefore: number;
    returnedQuantity: number;
  }>();
  input.items.forEach((item, index) => {
    const state = states[index];
    const key = `${state.materialId}\u0000${item.returnLocationId}\u0000${item.condition}`;
    const existing = holdingGroups.get(key);
    if (existing) {
      existing.returnedQuantity += item.quantity;
      return;
    }
    holdingGroups.set(key, {
      materialId: state.materialId,
      locationId: item.returnLocationId,
      condition: item.condition,
      quantityBefore: state.holdingQuantity,
      versionBefore: state.holdingVersion,
      returnedQuantity: item.quantity,
    });
  });
  const statements: D1Statement[] = [
    insertCommandStatement(
      db,
      input.requestId,
      requestHash,
      actor.id,
      "loan.return",
      "loan",
      input.loanId,
      createdAt,
    ),
    db.prepare(`
      INSERT INTO inventory_transactions (
        id, request_id, kind, occurred_at, document_number, reason, notes,
        loan_id, actor_user_id, reversal_of_id, status, created_at
      ) VALUES (?, ?, 'loan_return', ?, NULL, NULL, ?, ?, ?, NULL, 'posted', ?)
    `).bind(
      transactionId,
      input.requestId,
      input.returnedAt,
      input.notes ?? "",
      input.loanId,
      actor.id,
      createdAt,
    ),
  ];

  input.items.forEach((item, index) => {
    const state = states[index];
    const nextReturned = state.quantityReturned + item.quantity;
    statements.push(
      db.prepare(`
        UPDATE loan_items
        SET quantity_returned = ?, updated_at = ?
        WHERE id = ? AND loan_id = ? AND quantity_returned = ?
          AND quantity_issued >= ?
      `).bind(
        nextReturned,
        createdAt,
        item.loanItemId,
        input.loanId,
        state.quantityReturned,
        nextReturned,
      ),
      db.prepare(`
        INSERT INTO audit_events (
          id, actor_user_id, actor_email, action, entity_type, entity_id,
          request_id, before_json, after_json, metadata_json, created_at
        ) VALUES (
          ?, ?, ?, 'loan_item.returned', 'loan_item',
          (
            SELECT id FROM loan_items
            WHERE id = ? AND loan_id = ? AND quantity_returned = ? AND changes() = 1
          ),
          ?, ?, ?, ?, ?
        )
      `).bind(
        crypto.randomUUID(),
        actor.id,
        actor.email,
        item.loanItemId,
        input.loanId,
        nextReturned,
        input.requestId,
        JSON.stringify({ quantityReturned: state.quantityReturned }),
        JSON.stringify({ quantityReturned: nextReturned }),
        JSON.stringify({ quantity: item.quantity }),
        createdAt,
      ),
    );
  });

  for (const group of holdingGroups.values()) {
    const quantityAfter = group.quantityBefore + group.returnedQuantity;
    if (group.quantityBefore === 0) {
      statements.push(
        db.prepare(`
          INSERT INTO holdings (
            material_id, location_id, condition, quantity, version, updated_at
          ) VALUES (?, ?, ?, ?, 1, ?)
        `).bind(
          group.materialId,
          group.locationId,
          group.condition,
          group.returnedQuantity,
          createdAt,
        ),
      );
    } else {
      statements.push(
        db.prepare(`
          UPDATE holdings
          SET quantity = ?, version = ?, updated_at = ?
          WHERE material_id = ? AND location_id = ? AND condition = ?
            AND quantity = ? AND version = ?
        `).bind(
          quantityAfter,
          group.versionBefore + 1,
          createdAt,
          group.materialId,
          group.locationId,
          group.condition,
          group.quantityBefore,
          group.versionBefore,
        ),
      );
    }
    statements.push(
      guardedInventoryLineStatement(db, {
        lineId: `LINE-${crypto.randomUUID()}`,
        transactionId,
        materialId: group.materialId,
        locationId: group.locationId,
        condition: group.condition,
        quantityDelta: group.returnedQuantity,
        quantityBefore: group.quantityBefore,
        quantityAfter,
        countedQuantity: null,
        loanItemId: null,
        createdAt,
        guardSql: `
          SELECT material_id FROM holdings
          WHERE material_id = ? AND location_id = ? AND condition = ?
            AND quantity = ? AND version = ? AND changes() = 1
        `,
        guardBindings: [
          group.materialId,
          group.locationId,
          group.condition,
          quantityAfter,
          group.versionBefore + 1,
        ],
      }),
    );
  }

  statements.push(
    db.prepare(`
      UPDATE loans
      SET status = ?, closed_at = ?, closed_by_user_id = ?,
        version = ?, updated_at = ?
      WHERE id = ? AND status = 'open' AND version = ?
    `).bind(
      willClose ? "closed" : "open",
      willClose ? input.returnedAt : null,
      willClose ? actor.id : null,
      Number(loan.version) + 1,
      createdAt,
      input.loanId,
      Number(loan.version),
    ),
    db.prepare(`
      INSERT INTO audit_events (
        id, actor_user_id, actor_email, action, entity_type, entity_id,
        request_id, before_json, after_json, metadata_json, created_at
      ) VALUES (
        ?, ?, ?, 'loan.returned', 'loan',
        (
          SELECT id FROM loans
          WHERE id = ? AND version = ? AND status = ? AND changes() = 1
        ),
        ?, ?, ?, ?, ?
      )
    `).bind(
      crypto.randomUUID(),
      actor.id,
      actor.email,
      input.loanId,
      Number(loan.version) + 1,
      willClose ? "closed" : "open",
      input.requestId,
      JSON.stringify({ status: "open", version: Number(loan.version) }),
      JSON.stringify({ status: result.status, version: Number(loan.version) + 1 }),
      JSON.stringify({ transactionId }),
      createdAt,
    ),
  );
  for (const materialId of new Set(states.map((state) => state.materialId))) {
    statements.push(rebuildStockTotalsStatement(db, materialId, createdAt));
  }
  statements.push(
    completeCommandStatement(db, input.requestId, result, createdAt),
  );

  const replayed = await executeIdempotentBatch<LoanMutationResult>(
    db,
    statements,
    input.requestId,
    requestHash,
    {
      code: "loan_return_conflict",
      message: "Дані видачі або залишку вже змінилися. Оновіть повернення.",
    },
  );
  return replayed ?? result;
}

export async function issueLoanToClass(
  user: ChatGPTUser,
  input: ClassLoanCreateInput,
  providedDb?: LibraryD1Database,
): Promise<ClassLoanMutationResult> {
  const db = database(providedDb);
  const actor = await resolveMutationActor(db, user);
  const requestHash = await mutationHash({
    kind: "class-loan.issue",
    actorUserId: actor.id,
    input,
  });
  const replay = await replayCompletedCommand<ClassLoanMutationResult>(
    db,
    input.requestId,
    requestHash,
  );
  if (replay) return replay;

  const classYear = await db.prepare(`
    SELECT
      cy.id, cy.class_name, cy.cohort_id, cy.version, cy.status,
      cy.start_date, cy.end_date,
      ay.id AS academic_year_id, ay.label AS academic_year_label,
      ay.status AS academic_year_status, c.status AS cohort_status
    FROM class_years cy
    JOIN academic_years ay ON ay.id = cy.academic_year_id
    JOIN cohorts c ON c.id = cy.cohort_id
    WHERE cy.id = ?
    LIMIT 1
  `).bind(input.classYearId).first<{
    id: string;
    class_name: string;
    cohort_id: string;
    version: number;
    status: string;
    academic_year_id: string;
    academic_year_label: string;
    academic_year_status: string;
    cohort_status: string;
    start_date: string;
    end_date: string;
  }>();
  if (!classYear) {
    throw new LibraryMutationError(
      "class_year_not_found",
      404,
      "Клас цього навчального року не знайдено.",
    );
  }
  if (Number(classYear.version) !== input.expectedClassYearVersion) {
    throw new LibraryMutationError(
      "class_year_version_conflict",
      409,
      "Дані класу вже змінено. Оновіть список класів і повторіть видачу.",
      { currentVersion: Number(classYear.version) },
    );
  }
  if (
    classYear.status !== "active"
    || classYear.academic_year_status !== "active"
    || classYear.cohort_status !== "active"
  ) {
    throw new LibraryMutationError(
      "class_year_not_active",
      409,
      "Видачу можна оформити лише на активний клас активного навчального року.",
    );
  }
  if (input.issuedAt < classYear.start_date || input.issuedAt > classYear.end_date) {
    throw new LibraryMutationError(
      "issue_date_outside_class_year",
      400,
      "Дата видачі має належати обраному навчальному року класу.",
      { startDate: classYear.start_date, endDate: classYear.end_date },
    );
  }
  if (input.dueAt !== null && input.dueAt > classYear.end_date) {
    throw new LibraryMutationError(
      "due_date_outside_class_year",
      400,
      "Строк повернення не може бути пізнішим за завершення навчального року класу.",
      { endDate: classYear.end_date },
    );
  }

  const responsibleTeacher = await db.prepare(`
    SELECT id, full_name
    FROM users
    WHERE id = ? AND role = 'teacher' AND status = 'active'
    LIMIT 1
  `).bind(input.responsibleTeacherUserId).first<{ id: string; full_name: string }>();
  if (!responsibleTeacher) {
    throw new LibraryMutationError(
      "responsible_teacher_not_found",
      404,
      "Відповідального вчителя не знайдено або його профіль неактивний. Оберіть іншого вчителя.",
    );
  }

  const requestedItemsJson = JSON.stringify(input.items);
  const itemStateResult = await db.prepare(`
    WITH requested AS (
      SELECT
        CAST(key AS INTEGER) AS item_index,
        json_extract(value, '$.materialId') AS material_id,
        json_extract(value, '$.sourceLocationId') AS location_id,
        json_extract(value, '$.condition') AS condition
      FROM json_each(?)
    ), active_reservations AS (
      SELECT material_id, source_location_id, condition,
             SUM(reserved_quantity-issued_quantity-released_quantity) AS quantity
      FROM material_request_reservations
      WHERE reserved_quantity>issued_quantity+released_quantity
      GROUP BY material_id, source_location_id, condition
    )
    SELECT
      requested.item_index,
      requested.material_id,
      CASE WHEN m.status = 'active' AND m.archived_at IS NULL THEN m.id END
        AS active_material_id,
      CASE WHEN l.status = 'active' AND l.type != 'service' THEN l.id END
        AS active_location_id,
      h.quantity,
      h.version,
      COALESCE(active_reservations.quantity, 0) AS reserved_quantity
    FROM requested
    LEFT JOIN materials m ON m.id = requested.material_id
    LEFT JOIN locations l ON l.id = requested.location_id
    LEFT JOIN holdings h
      ON h.material_id = requested.material_id
      AND h.location_id = requested.location_id
      AND h.condition = requested.condition
    LEFT JOIN active_reservations
      ON active_reservations.material_id=requested.material_id
      AND active_reservations.source_location_id=requested.location_id
      AND active_reservations.condition=requested.condition
    ORDER BY requested.item_index
  `).bind(requestedItemsJson).all<{
    item_index: number;
    material_id: string;
    active_material_id: string | null;
    active_location_id: string | null;
    quantity: number | null;
    version: number | null;
    reserved_quantity: number;
  }>();
  const itemStates = (itemStateResult.results ?? []).map((state) => ({
    quantity: state.active_material_id && state.active_location_id
      ? Number(state.quantity ?? 0)
      : 0,
    version: state.active_material_id && state.active_location_id
      ? Number(state.version ?? 0)
      : 0,
    reservedQuantity: Number(state.reserved_quantity ?? 0),
  }));
  if (itemStates.length !== input.items.length) {
    throw new LibraryMutationError(
      "class_loan_items_invalid",
      400,
      "Не вдалося прочитати всі позиції видачі.",
    );
  }
  for (let index = 0; index < input.items.length; index += 1) {
    const item = input.items[index];
    const state = itemStates[index];
    const currentQuantity = Math.max(0, state.quantity - state.reservedQuantity);
    if (currentQuantity !== item.expectedAvailableQuantity) {
      throw new LibraryMutationError(
        "stock_quantity_conflict",
        409,
        "Залишок одного з матеріалів уже змінився. Оновіть видачу.",
        { materialId: item.materialId, currentQuantity },
      );
    }
    if (state.version < 1 || currentQuantity < item.quantity) {
      throw new LibraryMutationError(
        "insufficient_stock",
        409,
        "У вибраному місці недостатньо примірників.",
        { materialId: item.materialId, currentQuantity },
      );
    }
  }

  const createdAt = new Date().toISOString();
  const classLoanId = `CLOAN-${crypto.randomUUID()}`;
  const transactionId = `CLTX-${crypto.randomUUID()}`;
  const classLoanItemIds = input.items.map(() => `CLI-${crypto.randomUUID()}`);
  const issueRows = input.items.map((item, index) => ({
    ...item,
    classLoanItemId: classLoanItemIds[index],
    lineId: `CLINE-${crypto.randomUUID()}`,
    quantityBefore: itemStates[index].quantity,
    versionBefore: itemStates[index].version,
    quantityAfter: itemStates[index].quantity - item.quantity,
  }));
  const issueRowsJson = JSON.stringify(issueRows);
  const nonzeroHoldingCount = issueRows.filter((row) => row.quantityAfter > 0).length;
  const deletedHoldingCount = issueRows.length - nonzeroHoldingCount;
  const result: ClassLoanMutationResult = {
    classLoanId,
    status: "open",
    classYearId: input.classYearId,
    responsibleTeacherUserId: responsibleTeacher.id,
    responsibleTeacherName: responsibleTeacher.full_name,
    issuedAt: input.issuedAt,
    dueAt: input.dueAt,
    closedAt: null,
    version: 1,
    transactionId,
    items: input.items.map((item, index) => ({
      classLoanItemId: classLoanItemIds[index],
      materialId: item.materialId,
      quantityIssued: item.quantity,
      quantityReturned: 0,
    })),
  };
  const statements: D1Statement[] = [
    insertCommandStatement(
      db,
      input.requestId,
      requestHash,
      actor.id,
      "class-loan.issue",
      "class_loan",
      classLoanId,
      createdAt,
    ),
    db.prepare(`
      INSERT INTO class_loans (
        id, class_year_id, responsible_teacher_user_id, status,
        issued_at, due_at, closed_at, notes, issued_by_user_id,
        closed_by_user_id, version, created_at, updated_at
      ) VALUES (
        ?, (
          SELECT cy.id
          FROM class_years cy
          JOIN academic_years ay ON ay.id = cy.academic_year_id AND ay.status = 'active'
          JOIN cohorts c ON c.id = cy.cohort_id AND c.status = 'active'
          WHERE cy.id = ? AND cy.version = ? AND cy.status = 'active'
            AND ? BETWEEN cy.start_date AND cy.end_date
            AND (? IS NULL OR ? <= cy.end_date)
        ), (
          SELECT id FROM users
          WHERE id = ? AND role = 'teacher' AND status = 'active'
        ), 'open', ?, ?, NULL, ?, ?, NULL, 1, ?, ?
      )
    `).bind(
      classLoanId,
      input.classYearId,
      input.expectedClassYearVersion,
      input.issuedAt,
      input.dueAt,
      input.dueAt,
      input.responsibleTeacherUserId,
      input.issuedAt,
      input.dueAt,
      input.notes ?? "",
      actor.id,
      createdAt,
      createdAt,
    ),
    db.prepare(`
      INSERT INTO class_loan_transactions (
        id, request_id, class_loan_id, kind, occurred_at, notes,
        actor_user_id, created_at
      ) VALUES (?, ?, ?, 'issue', ?, ?, ?, ?)
    `).bind(
      transactionId,
      input.requestId,
      classLoanId,
      input.issuedAt,
      input.notes ?? "",
      actor.id,
      createdAt,
    ),
  ];

  statements.push(
    db.prepare(`
      WITH requested AS (
        SELECT value FROM json_each(?)
      )
      INSERT INTO class_loan_items (
        id, class_loan_id, material_id, source_location_id, condition,
        quantity_issued, quantity_returned, notes, created_at, updated_at
      )
      SELECT
        json_extract(value, '$.classLoanItemId'),
        ?,
        (
          SELECT id FROM materials
          WHERE id = json_extract(value, '$.materialId')
            AND status = 'active' AND archived_at IS NULL
        ),
        (
          SELECT id FROM locations
          WHERE id = json_extract(value, '$.sourceLocationId')
            AND status = 'active' AND type != 'service'
        ),
        json_extract(value, '$.condition'),
        CAST(json_extract(value, '$.quantity') AS INTEGER),
        0,
        '',
        ?,
        ?
      FROM requested
    `).bind(issueRowsJson, classLoanId, createdAt, createdAt),
  );
  if (nonzeroHoldingCount > 0) {
    statements.push(
      db.prepare(`
        WITH requested AS (
          SELECT
            json_extract(value, '$.materialId') AS material_id,
            json_extract(value, '$.sourceLocationId') AS location_id,
            json_extract(value, '$.condition') AS condition,
            CAST(json_extract(value, '$.quantityBefore') AS INTEGER) AS quantity_before,
            CAST(json_extract(value, '$.quantityAfter') AS INTEGER) AS quantity_after,
            CAST(json_extract(value, '$.versionBefore') AS INTEGER) AS version_before
          FROM json_each(?)
          WHERE CAST(json_extract(value, '$.quantityAfter') AS INTEGER) > 0
        )
        UPDATE holdings AS holding
        SET
          quantity = (
            SELECT quantity_after FROM requested
            WHERE material_id = holding.material_id
              AND location_id = holding.location_id
              AND condition = holding.condition
          ),
          version = (
            SELECT version_before + 1 FROM requested
            WHERE material_id = holding.material_id
              AND location_id = holding.location_id
              AND condition = holding.condition
          ),
          updated_at = ?
        WHERE EXISTS (
          SELECT 1 FROM requested
          WHERE material_id = holding.material_id
            AND location_id = holding.location_id
            AND condition = holding.condition
            AND quantity_before = holding.quantity
            AND version_before = holding.version
        )
          AND EXISTS (
            SELECT 1 FROM materials
            WHERE id = holding.material_id
              AND status = 'active' AND archived_at IS NULL
          )
          AND EXISTS (
            SELECT 1 FROM locations
            WHERE id = holding.location_id
              AND status = 'active' AND type != 'service'
          )
      `).bind(issueRowsJson, createdAt),
      db.prepare(`
        WITH requested AS (
          SELECT value FROM json_each(?)
          WHERE CAST(json_extract(value, '$.quantityAfter') AS INTEGER) > 0
        )
        INSERT INTO class_loan_transaction_lines (
          id, transaction_id, class_loan_item_id, material_id, location_id,
          condition, quantity_delta, quantity_before, quantity_after, created_at
        )
        SELECT
          json_extract(value, '$.lineId'),
          ?,
          json_extract(value, '$.classLoanItemId'),
          CASE WHEN changes() = ? THEN json_extract(value, '$.materialId') END,
          json_extract(value, '$.sourceLocationId'),
          json_extract(value, '$.condition'),
          -CAST(json_extract(value, '$.quantity') AS INTEGER),
          CAST(json_extract(value, '$.quantityBefore') AS INTEGER),
          CAST(json_extract(value, '$.quantityAfter') AS INTEGER),
          ?
        FROM requested
      `).bind(issueRowsJson, transactionId, nonzeroHoldingCount, createdAt),
    );
  }
  if (deletedHoldingCount > 0) {
    statements.push(
      db.prepare(`
        WITH requested AS (
          SELECT
            json_extract(value, '$.materialId') AS material_id,
            json_extract(value, '$.sourceLocationId') AS location_id,
            json_extract(value, '$.condition') AS condition,
            CAST(json_extract(value, '$.quantityBefore') AS INTEGER) AS quantity_before,
            CAST(json_extract(value, '$.versionBefore') AS INTEGER) AS version_before
          FROM json_each(?)
          WHERE CAST(json_extract(value, '$.quantityAfter') AS INTEGER) = 0
        )
        DELETE FROM holdings
        WHERE EXISTS (
          SELECT 1 FROM requested
          WHERE material_id = holdings.material_id
            AND location_id = holdings.location_id
            AND condition = holdings.condition
            AND quantity_before = holdings.quantity
            AND version_before = holdings.version
        )
      `).bind(issueRowsJson),
      db.prepare(`
        WITH requested AS (
          SELECT value FROM json_each(?)
          WHERE CAST(json_extract(value, '$.quantityAfter') AS INTEGER) = 0
        )
        INSERT INTO class_loan_transaction_lines (
          id, transaction_id, class_loan_item_id, material_id, location_id,
          condition, quantity_delta, quantity_before, quantity_after, created_at
        )
        SELECT
          json_extract(value, '$.lineId'),
          ?,
          json_extract(value, '$.classLoanItemId'),
          CASE WHEN changes() = ? THEN json_extract(value, '$.materialId') END,
          json_extract(value, '$.sourceLocationId'),
          json_extract(value, '$.condition'),
          -CAST(json_extract(value, '$.quantity') AS INTEGER),
          CAST(json_extract(value, '$.quantityBefore') AS INTEGER),
          0,
          ?
        FROM requested
      `).bind(issueRowsJson, transactionId, deletedHoldingCount, createdAt),
    );
  }
  statements.push(
    rebuildStockTotalsBulkStatement(
      db,
      [...new Set(input.items.map((item) => item.materialId))],
      createdAt,
    ),
  );
  statements.push(
    db.prepare(`
      INSERT INTO audit_events (
        id, actor_user_id, actor_email, action, entity_type, entity_id,
        request_id, before_json, after_json, metadata_json, created_at
      ) VALUES (?, ?, ?, 'class_loan.issued', 'class_loan', ?, ?, NULL, ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      actor.id,
      actor.email,
      classLoanId,
      input.requestId,
      JSON.stringify({
        ...result,
        className: classYear.class_name,
        academicYearId: classYear.academic_year_id,
        academicYearLabel: classYear.academic_year_label,
        cohortId: classYear.cohort_id,
      }),
      JSON.stringify({
        transactionId,
        responsibleTeacherName: responsibleTeacher.full_name,
      }),
      createdAt,
    ),
    completeCommandStatement(db, input.requestId, result, createdAt),
  );

  const replayed = await executeIdempotentBatch<ClassLoanMutationResult>(
    db,
    statements,
    input.requestId,
    requestHash,
    {
      code: "stock_quantity_conflict",
      message: "Залишок або дані класу змінилися під час видачі. Оновіть форму.",
      classify: classifyClassLoanIssueRace,
    },
  );
  return replayed ?? result;
}

export async function returnClassLoanItems(
  user: ChatGPTUser,
  input: ClassLoanReturnInput,
  providedDb?: LibraryD1Database,
): Promise<ClassLoanMutationResult> {
  const db = database(providedDb);
  const actor = await resolveMutationActor(db, user);
  const requestHash = await mutationHash({
    kind: "class-loan.return",
    actorUserId: actor.id,
    input,
  });
  const replay = await replayCompletedCommand<ClassLoanMutationResult>(
    db,
    input.requestId,
    requestHash,
  );
  if (replay) return replay;

  const loan = await db.prepare(`
    SELECT
      cl.id, cl.class_year_id, cl.responsible_teacher_user_id,
      teacher.full_name AS responsible_teacher_name, cl.status,
      cl.issued_at, cl.due_at, cl.version,
      (
        SELECT MAX(tx.occurred_at)
        FROM class_loan_transactions tx
        WHERE tx.class_loan_id = cl.id AND tx.kind = 'return'
      ) AS last_returned_at
    FROM class_loans cl
    JOIN users teacher ON teacher.id = cl.responsible_teacher_user_id
    WHERE cl.id = ?
    LIMIT 1
  `).bind(input.classLoanId).first<{
    id: string;
    class_year_id: string;
    responsible_teacher_user_id: string;
    responsible_teacher_name: string;
    status: string;
    issued_at: string;
    due_at: string | null;
    version: number;
    last_returned_at: string | null;
  }>();
  if (!loan) {
    throw new LibraryMutationError(
      "class_loan_not_found",
      404,
      "Видачу на клас не знайдено.",
    );
  }
  if (loan.status !== "open") {
    throw new LibraryMutationError(
      "class_loan_already_closed",
      409,
      "Цю видачу на клас уже закрито або скасовано.",
    );
  }
  if (Number(loan.version) !== input.expectedVersion) {
    throw new LibraryMutationError(
      "class_loan_version_conflict",
      409,
      "Видачу вже змінено в іншій вкладці. Оновіть відкриті видачі.",
      { currentVersion: Number(loan.version) },
    );
  }
  if (input.returnedAt < loan.issued_at) {
    throw new LibraryMutationError(
      "return_date_invalid",
      400,
      "Дата повернення не може передувати даті видачі.",
    );
  }
  if (loan.last_returned_at && input.returnedAt < loan.last_returned_at) {
    throw new LibraryMutationError(
      "return_date_before_previous_return",
      409,
      "Дата повернення не може бути ранішою за вже збережене повернення цієї видачі.",
      { lastReturnAt: loan.last_returned_at },
    );
  }

  const requestedReturnsJson = JSON.stringify(input.items);
  const stateResult = await db.prepare(`
    WITH requested AS (
      SELECT
        CAST(key AS INTEGER) AS item_index,
        json_extract(value, '$.classLoanItemId') AS class_loan_item_id,
        json_extract(value, '$.returnLocationId') AS return_location_id,
        json_extract(value, '$.condition') AS return_condition
      FROM json_each(?)
    )
    SELECT
      requested.item_index,
      cli.id AS class_loan_item_id,
      cli.material_id,
      cli.quantity_issued,
      cli.quantity_returned,
      CASE WHEN loc.status = 'active' AND loc.type != 'service' THEN loc.id END
        AS active_location_id,
      h.quantity AS holding_quantity,
      h.version AS holding_version
    FROM requested
    LEFT JOIN class_loan_items cli
      ON cli.id = requested.class_loan_item_id AND cli.class_loan_id = ?
    LEFT JOIN locations loc ON loc.id = requested.return_location_id
    LEFT JOIN holdings h
      ON h.material_id = cli.material_id
      AND h.location_id = requested.return_location_id
      AND h.condition = requested.return_condition
    ORDER BY requested.item_index
  `).bind(requestedReturnsJson, input.classLoanId).all<{
    item_index: number;
    class_loan_item_id: string | null;
    material_id: string | null;
    quantity_issued: number | null;
    quantity_returned: number | null;
    active_location_id: string | null;
    holding_quantity: number | null;
    holding_version: number | null;
  }>();
  const stateRows = stateResult.results ?? [];
  if (stateRows.length !== input.items.length) {
    throw new LibraryMutationError(
      "class_loan_items_invalid",
      400,
      "Не вдалося прочитати всі позиції повернення.",
    );
  }
  const states: Array<{
    classLoanItemId: string;
    materialId: string;
    quantityIssued: number;
    quantityReturned: number;
    holdingQuantity: number;
    holdingVersion: number;
  }> = stateRows.map((row, index) => {
    const item = input.items[index];
    if (!row.class_loan_item_id || !row.material_id) {
      throw new LibraryMutationError(
        "class_loan_item_not_found",
        404,
        "Позицію видачі на клас не знайдено.",
      );
    }
    const quantityIssued = Number(row.quantity_issued ?? 0);
    const quantityReturned = Number(row.quantity_returned ?? 0);
    const remaining = quantityIssued - quantityReturned;
    if (item.quantity > remaining) {
      throw new LibraryMutationError(
        "return_quantity_exceeds_outstanding",
        409,
        "Кількість повернення перевищує неповернений залишок.",
        { classLoanItemId: item.classLoanItemId, remaining },
      );
    }
    if (!row.active_location_id) {
      throw new LibraryMutationError(
        "location_not_found",
        404,
        "Місце повернення не знайдено.",
      );
    }
    return {
      classLoanItemId: row.class_loan_item_id,
      materialId: row.material_id,
      quantityIssued,
      quantityReturned,
      holdingQuantity: Number(row.holding_quantity ?? 0),
      holdingVersion: Number(row.holding_version ?? 0),
    };
  });

  const allItems = await db.prepare(`
    SELECT id, material_id, quantity_issued, quantity_returned
    FROM class_loan_items WHERE class_loan_id = ?
  `).bind(input.classLoanId).all<{
    id: string;
    material_id: string;
    quantity_issued: number;
    quantity_returned: number;
  }>();
  const returningById = new Map(
    input.items.map((item) => [item.classLoanItemId, item.quantity]),
  );
  const willClose = (allItems.results ?? []).every((item) =>
    Number(item.quantity_returned) + (returningById.get(item.id) ?? 0)
      === Number(item.quantity_issued)
  );
  const createdAt = new Date().toISOString();
  const transactionId = `CLTX-${crypto.randomUUID()}`;
  const nextVersion = Number(loan.version) + 1;
  const returnRows = input.items.map((item, index) => ({
    ...item,
    materialId: states[index].materialId,
    quantityReturnedBefore: states[index].quantityReturned,
    quantityReturnedAfter: states[index].quantityReturned + item.quantity,
    auditId: crypto.randomUUID(),
  }));
  const returnRowsJson = JSON.stringify(returnRows);
  const result: ClassLoanMutationResult = {
    classLoanId: input.classLoanId,
    status: willClose ? "closed" : "open",
    classYearId: loan.class_year_id,
    responsibleTeacherUserId: loan.responsible_teacher_user_id,
    responsibleTeacherName: loan.responsible_teacher_name,
    issuedAt: loan.issued_at,
    dueAt: loan.due_at,
    closedAt: willClose ? input.returnedAt : null,
    version: nextVersion,
    transactionId,
    items: (allItems.results ?? []).map((item) => ({
      classLoanItemId: item.id,
      materialId: item.material_id,
      quantityIssued: Number(item.quantity_issued),
      quantityReturned:
        Number(item.quantity_returned) + (returningById.get(item.id) ?? 0),
    })),
  };
  const holdingGroups = new Map<string, {
    materialId: string;
    locationId: string;
    condition: string;
    quantityBefore: number;
    versionBefore: number;
    returnedQuantity: number;
    entries: Array<{
      classLoanItemId: string;
      quantity: number;
    }>;
  }>();
  input.items.forEach((item, index) => {
    const state = states[index];
    const key = `${state.materialId}\u0000${item.returnLocationId}\u0000${item.condition}`;
    const existing = holdingGroups.get(key);
    if (existing) {
      existing.returnedQuantity += item.quantity;
      existing.entries.push({ classLoanItemId: item.classLoanItemId, quantity: item.quantity });
      return;
    }
    holdingGroups.set(key, {
      materialId: state.materialId,
      locationId: item.returnLocationId,
      condition: item.condition,
      quantityBefore: state.holdingQuantity,
      versionBefore: state.holdingVersion,
      returnedQuantity: item.quantity,
      entries: [{ classLoanItemId: item.classLoanItemId, quantity: item.quantity }],
    });
  });
  const holdingGroupRows = [...holdingGroups.values()].map((group) => {
    let runningQuantity = group.quantityBefore;
    const entries = group.entries.map((entry) => {
      const quantityBefore = runningQuantity;
      const quantityAfter = quantityBefore + entry.quantity;
      runningQuantity = quantityAfter;
      return {
        ...entry,
        lineId: `CLINE-${crypto.randomUUID()}`,
        quantityBefore,
        quantityAfter,
      };
    });
    return {
      ...group,
      quantityAfter: group.quantityBefore + group.returnedQuantity,
      entries,
    };
  });
  const holdingGroupsJson = JSON.stringify(holdingGroupRows);
  const existingHoldingGroupCount = holdingGroupRows.filter(
    (group) => group.versionBefore > 0,
  ).length;
  const newHoldingGroupCount = holdingGroupRows.length - existingHoldingGroupCount;

  const statements: D1Statement[] = [
    insertCommandStatement(
      db,
      input.requestId,
      requestHash,
      actor.id,
      "class-loan.return",
      "class_loan",
      input.classLoanId,
      createdAt,
    ),
    db.prepare(`
      INSERT INTO class_loan_transactions (
        id, request_id, class_loan_id, kind, occurred_at, notes,
        actor_user_id, created_at
      ) VALUES (?, ?, ?, 'return', ?, ?, ?, ?)
    `).bind(
      transactionId,
      input.requestId,
      input.classLoanId,
      input.returnedAt,
      input.notes ?? "",
      actor.id,
      createdAt,
    ),
  ];

  statements.push(
    db.prepare(`
      WITH requested AS (
        SELECT
          json_extract(value, '$.classLoanItemId') AS class_loan_item_id,
          CAST(json_extract(value, '$.quantityReturnedBefore') AS INTEGER)
            AS quantity_returned_before,
          CAST(json_extract(value, '$.quantityReturnedAfter') AS INTEGER)
            AS quantity_returned_after
        FROM json_each(?)
      )
      UPDATE class_loan_items AS item
      SET
        quantity_returned = (
          SELECT quantity_returned_after FROM requested
          WHERE class_loan_item_id = item.id
        ),
        updated_at = ?
      WHERE item.class_loan_id = ?
        AND EXISTS (
          SELECT 1 FROM requested
          WHERE class_loan_item_id = item.id
            AND quantity_returned_before = item.quantity_returned
            AND quantity_returned_after <= item.quantity_issued
        )
    `).bind(returnRowsJson, createdAt, input.classLoanId),
    db.prepare(`
      WITH requested AS (
        SELECT value FROM json_each(?)
      )
      INSERT INTO audit_events (
        id, actor_user_id, actor_email, action, entity_type, entity_id,
        request_id, before_json, after_json, metadata_json, created_at
      )
      SELECT
        json_extract(value, '$.auditId'),
        ?,
        ?,
        'class_loan_item.returned',
        'class_loan_item',
        CASE WHEN changes() = ? THEN json_extract(value, '$.classLoanItemId') END,
        ?,
        json_object(
          'quantityReturned',
          CAST(json_extract(value, '$.quantityReturnedBefore') AS INTEGER)
        ),
        json_object(
          'quantityReturned',
          CAST(json_extract(value, '$.quantityReturnedAfter') AS INTEGER)
        ),
        json_object(
          'quantity', CAST(json_extract(value, '$.quantity') AS INTEGER),
          'transactionId', ?
        ),
        ?
      FROM requested
    `).bind(
      returnRowsJson,
      actor.id,
      actor.email,
      returnRows.length,
      input.requestId,
      transactionId,
      createdAt,
    ),
  );

  if (existingHoldingGroupCount > 0) {
    statements.push(
      db.prepare(`
        WITH requested AS (
          SELECT
            json_extract(value, '$.materialId') AS material_id,
            json_extract(value, '$.locationId') AS location_id,
            json_extract(value, '$.condition') AS condition,
            CAST(json_extract(value, '$.quantityBefore') AS INTEGER) AS quantity_before,
            CAST(json_extract(value, '$.quantityAfter') AS INTEGER) AS quantity_after,
            CAST(json_extract(value, '$.versionBefore') AS INTEGER) AS version_before
          FROM json_each(?)
          WHERE CAST(json_extract(value, '$.versionBefore') AS INTEGER) > 0
        )
        UPDATE holdings AS holding
        SET
          quantity = (
            SELECT quantity_after FROM requested
            WHERE material_id = holding.material_id
              AND location_id = holding.location_id
              AND condition = holding.condition
          ),
          version = (
            SELECT version_before + 1 FROM requested
            WHERE material_id = holding.material_id
              AND location_id = holding.location_id
              AND condition = holding.condition
          ),
          updated_at = ?
        WHERE EXISTS (
          SELECT 1 FROM requested
          WHERE material_id = holding.material_id
            AND location_id = holding.location_id
            AND condition = holding.condition
            AND quantity_before = holding.quantity
            AND version_before = holding.version
        )
          AND EXISTS (
            SELECT 1 FROM materials
            WHERE id = holding.material_id
              AND status = 'active' AND archived_at IS NULL
          )
          AND EXISTS (
            SELECT 1 FROM locations
            WHERE id = holding.location_id
              AND status = 'active' AND type != 'service'
          )
      `).bind(holdingGroupsJson, createdAt),
      db.prepare(`
        WITH groups AS (
          SELECT value
          FROM json_each(?)
          WHERE CAST(json_extract(value, '$.versionBefore') AS INTEGER) > 0
        ), lines AS (
          SELECT groups.value AS group_value, entry.value AS line_value
          FROM groups, json_each(json_extract(groups.value, '$.entries')) entry
        )
        INSERT INTO class_loan_transaction_lines (
          id, transaction_id, class_loan_item_id, material_id, location_id,
          condition, quantity_delta, quantity_before, quantity_after, created_at
        )
        SELECT
          json_extract(line_value, '$.lineId'),
          ?,
          json_extract(line_value, '$.classLoanItemId'),
          CASE WHEN changes() = ? THEN json_extract(group_value, '$.materialId') END,
          json_extract(group_value, '$.locationId'),
          json_extract(group_value, '$.condition'),
          CAST(json_extract(line_value, '$.quantity') AS INTEGER),
          CAST(json_extract(line_value, '$.quantityBefore') AS INTEGER),
          CAST(json_extract(line_value, '$.quantityAfter') AS INTEGER),
          ?
        FROM lines
      `).bind(
        holdingGroupsJson,
        transactionId,
        existingHoldingGroupCount,
        createdAt,
      ),
    );
  }
  if (newHoldingGroupCount > 0) {
    statements.push(
      db.prepare(`
        WITH requested AS (
          SELECT value
          FROM json_each(?)
          WHERE CAST(json_extract(value, '$.versionBefore') AS INTEGER) = 0
        )
        INSERT INTO holdings (
          material_id, location_id, condition, quantity, version, updated_at
        )
        SELECT
          (
            SELECT id FROM materials
            WHERE id = json_extract(value, '$.materialId')
              AND status = 'active' AND archived_at IS NULL
          ),
          (
            SELECT id FROM locations
            WHERE id = json_extract(value, '$.locationId')
              AND status = 'active' AND type != 'service'
          ),
          json_extract(value, '$.condition'),
          CAST(json_extract(value, '$.quantityAfter') AS INTEGER),
          1,
          ?
        FROM requested
      `).bind(holdingGroupsJson, createdAt),
      db.prepare(`
        WITH groups AS (
          SELECT value
          FROM json_each(?)
          WHERE CAST(json_extract(value, '$.versionBefore') AS INTEGER) = 0
        ), lines AS (
          SELECT groups.value AS group_value, entry.value AS line_value
          FROM groups, json_each(json_extract(groups.value, '$.entries')) entry
        )
        INSERT INTO class_loan_transaction_lines (
          id, transaction_id, class_loan_item_id, material_id, location_id,
          condition, quantity_delta, quantity_before, quantity_after, created_at
        )
        SELECT
          json_extract(line_value, '$.lineId'),
          ?,
          json_extract(line_value, '$.classLoanItemId'),
          CASE WHEN changes() = ? THEN json_extract(group_value, '$.materialId') END,
          json_extract(group_value, '$.locationId'),
          json_extract(group_value, '$.condition'),
          CAST(json_extract(line_value, '$.quantity') AS INTEGER),
          CAST(json_extract(line_value, '$.quantityBefore') AS INTEGER),
          CAST(json_extract(line_value, '$.quantityAfter') AS INTEGER),
          ?
        FROM lines
      `).bind(
        holdingGroupsJson,
        transactionId,
        newHoldingGroupCount,
        createdAt,
      ),
    );
  }

  statements.push(
    db.prepare(`
      UPDATE class_loans
      SET status = ?, closed_at = ?, closed_by_user_id = ?,
        version = ?, updated_at = ?
      WHERE id = ? AND status = 'open' AND version = ?
        AND NOT EXISTS (
          SELECT 1 FROM class_loan_transactions later
          WHERE later.class_loan_id = ? AND later.kind = 'return'
            AND later.occurred_at > ?
        )
    `).bind(
      willClose ? "closed" : "open",
      willClose ? input.returnedAt : null,
      willClose ? actor.id : null,
      nextVersion,
      createdAt,
      input.classLoanId,
      input.expectedVersion,
      input.classLoanId,
      input.returnedAt,
    ),
    db.prepare(`
      INSERT INTO audit_events (
        id, actor_user_id, actor_email, action, entity_type, entity_id,
        request_id, before_json, after_json, metadata_json, created_at
      ) VALUES (
        ?, ?, ?, 'class_loan.returned', 'class_loan',
        (
          SELECT id FROM class_loans
          WHERE id = ? AND version = ? AND status = ? AND changes() = 1
        ),
        ?, ?, ?, ?, ?
      )
    `).bind(
      crypto.randomUUID(),
      actor.id,
      actor.email,
      input.classLoanId,
      nextVersion,
      willClose ? "closed" : "open",
      input.requestId,
      JSON.stringify({ status: "open", version: input.expectedVersion }),
      JSON.stringify({ status: result.status, version: nextVersion }),
      JSON.stringify({
        transactionId,
        responsibleTeacherUserId: loan.responsible_teacher_user_id,
        responsibleTeacherName: loan.responsible_teacher_name,
      }),
      createdAt,
    ),
  );
  statements.push(
    rebuildStockTotalsBulkStatement(
      db,
      [...new Set(states.map((state) => state.materialId))],
      createdAt,
    ),
    completeCommandStatement(db, input.requestId, result, createdAt),
  );

  const replayed = await executeIdempotentBatch<ClassLoanMutationResult>(
    db,
    statements,
    input.requestId,
    requestHash,
    {
      code: "class_loan_return_conflict",
      message: "Дані видачі або залишку вже змінилися. Оновіть повернення.",
    },
  );
  return replayed ?? result;
}

function database(value?: D1Binding): D1Binding {
  if (!value) {
    throw new LibraryMutationError(
      "database_unavailable",
      503,
      "База даних тимчасово недоступна.",
    );
  }
  return value;
}

async function resolveMutationActor(
  db: D1Binding,
  user: ChatGPTUser,
): Promise<MutationActor> {
  const response = await db.prepare(`
    SELECT id, email
    FROM users
    WHERE status = 'active' AND role IN ('admin', 'librarian')
      AND (auth_user_id = ? OR lower(email) = lower(?))
    ORDER BY CASE WHEN auth_user_id = ? THEN 0 ELSE 1 END, id
    LIMIT 2
  `).bind(user.userId, user.email, user.userId).all<{
    id: string;
    email: string | null;
  }>();
  const rows = response.results ?? [];
  if (rows.length !== 1) {
    throw new LibraryMutationError(
      "actor_not_mapped",
      403,
      rows.length > 1
        ? "Обліковий запис бібліотекаря налаштовано неоднозначно."
        : "Обліковий запис не прив’язано до активного бібліотекаря.",
    );
  }
  return { id: rows[0].id, email: user.email.toLowerCase() };
}

async function readMaterialLinks(db: D1Binding, materialId: string) {
  const response = await db.prepare(`
    SELECT id, kind, label, url, is_public, sort_order, status
    FROM material_links
    WHERE material_id = ?
    ORDER BY sort_order, id
  `).bind(materialId).all();
  return (response.results ?? []).map((row) => ({
    id: String(row.id ?? ""),
    kind: String(row.kind ?? "other"),
    label: String(row.label ?? ""),
    url: String(row.url ?? ""),
    isPublic: Number(row.is_public) === 1,
    sortOrder: Number(row.sort_order) || 0,
    status: String(row.status ?? "active"),
  }));
}

function materialSnapshot(material: MaterialRow, links: unknown[]) {
  return {
    id: material.id,
    catalogNumber: Number(material.catalog_number),
    title: material.title,
    rubric: material.rubric,
    publicationType: material.publication_type,
    subject: material.subject,
    classFrom: nullableNumber(material.class_from),
    classTo: nullableNumber(material.class_to),
    author: material.author,
    publicationYear: nullableNumber(material.publication_year),
    isbn: material.isbn,
    publisher: material.publisher,
    notes: material.notes,
    version: Number(material.version),
    links,
  };
}

function applyMaterialChanges(
  before: ReturnType<typeof materialSnapshot>,
  changes: MaterialUpdateInput["changes"],
  persistedLinks?: Array<{
    id: string;
    kind: string;
    label: string;
    url: string;
    isPublic: boolean;
    sortOrder: number;
    status: string;
  }>,
) {
  const after = { ...before, links: before.links };
  for (const [key, value] of Object.entries(changes)) {
    if (key === "links") {
      after.links = persistedLinks ?? [];
      continue;
    }
    const nullableNumberField = key === "classFrom"
      || key === "classTo"
      || key === "publicationYear";
    (after as Record<string, unknown>)[key] = value === null && nullableNumberField
      ? null
      : value ?? "";
  }
  after.version = before.version + 1;
  return after;
}

function materialSearchText(material: ReturnType<typeof materialSnapshot>): string {
  return normalizeSearchText([
    material.id,
    material.title,
    material.author,
    material.isbn,
    material.publisher,
    material.rubric,
    material.publicationType,
    material.subject,
    material.publicationYear ?? "",
  ].join(" "));
}

function insertMaterialSearchStatement(
  db: D1Binding,
  materialId: string,
  version: number,
): D1Statement {
  return db.prepare(`
    INSERT INTO materials_fts (
      rowid, title, author, isbn_normalized, publisher,
      rubric, subject, publication_type, search_text
    )
    SELECT
      rowid, title, author, isbn_normalized, publisher,
      rubric, subject, publication_type, search_text
    FROM materials
    WHERE id = ? AND version = ?
  `).bind(materialId, version);
}

function deleteMaterialSearchStatement(
  db: D1Binding,
  material: MaterialRow,
  currentVersion: number,
): D1Statement {
  return db.prepare(`
    INSERT INTO materials_fts (
      materials_fts, rowid, title, author, isbn_normalized, publisher,
      rubric, subject, publication_type, search_text
    )
    SELECT
      'delete', rowid, ?, ?, ?, ?, ?, ?, ?, ?
    FROM materials
    WHERE id = ? AND version = ?
  `).bind(
    material.title,
    material.author,
    material.isbn_normalized,
    material.publisher,
    material.rubric,
    material.subject,
    material.publication_type,
    material.search_text,
    material.id,
    currentVersion,
  );
}

function normalizeSearchText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("uk-UA")
    .replace(/[’`]/gu, "'")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeIsbn(value: unknown): string {
  const normalized = String(value ?? "").toUpperCase().replace(/[\s-]+/gu, "");
  return /^(?:\d{13}|\d{9}[\dX])$/u.test(normalized) ? normalized : "";
}

function nullableNumber(value: number | null): number | null {
  return Number.isFinite(value) ? Number(value) : null;
}

async function assertReceiptLocation(
  db: D1Binding,
  locationId: string,
): Promise<void> {
  const location = await db.prepare(`
    SELECT id FROM locations
    WHERE id = ? AND status = 'active' AND type != 'service'
    LIMIT 1
  `).bind(locationId).first<{ id: string }>();
  if (!location) {
    throw new LibraryMutationError(
      "location_not_found",
      404,
      "Місце надходження не знайдено.",
    );
  }
}

function receiptResult(
  materialId: string,
  input: ReceiptCreateDetails,
  quantityBefore: number,
  holdingVersion: number,
  transactionId: string,
): ReceiptMutationResult {
  return {
    materialId,
    locationId: input.locationId,
    condition: input.condition,
    quantityBefore,
    quantityReceived: input.quantity,
    quantityAfter: quantityBefore + input.quantity,
    holdingVersion,
    transactionId,
    occurredAt: input.occurredAt,
  };
}

function insertMaterialLinkStatement(
  db: D1Binding,
  materialId: string,
  link: {
    id: string;
    kind: string;
    label: string;
    url: string;
    isPublic: boolean;
    sortOrder: number;
  },
  createdAt: string,
): D1Statement {
  return db.prepare(`
    INSERT INTO material_links (
      id, material_id, kind, label, url, is_public, sort_order,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).bind(
    link.id,
    materialId,
    link.kind,
    link.label,
    link.url,
    link.isPublic ? 1 : 0,
    link.sortOrder,
    createdAt,
    createdAt,
  );
}

function insertReceiptTransactionStatement(
  db: D1Binding,
  transactionId: string,
  requestId: string,
  input: ReceiptCreateDetails,
  actorUserId: string,
  createdAt: string,
): D1Statement {
  return db.prepare(`
    INSERT INTO inventory_transactions (
      id, request_id, kind, occurred_at, document_number, reason, notes,
      loan_id, actor_user_id, reversal_of_id, status, created_at
    ) VALUES (?, ?, 'receipt', ?, ?, NULL, ?, NULL, ?, NULL, 'posted', ?)
  `).bind(
    transactionId,
    requestId,
    input.occurredAt,
    input.documentNumber,
    input.notes ?? "",
    actorUserId,
    createdAt,
  );
}

function receiptAuditStatement(
  db: D1Binding,
  actor: MutationActor,
  requestId: string,
  result: ReceiptMutationResult,
  createdAt: string,
): D1Statement {
  return db.prepare(`
    INSERT INTO audit_events (
      id, actor_user_id, actor_email, action, entity_type, entity_id,
      request_id, before_json, after_json, metadata_json, created_at
    ) VALUES (?, ?, ?, 'stock.received', 'material', ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    actor.id,
    actor.email,
    result.materialId,
    requestId,
    JSON.stringify({
      locationId: result.locationId,
      condition: result.condition,
      quantity: result.quantityBefore,
    }),
    JSON.stringify({
      locationId: result.locationId,
      condition: result.condition,
      quantity: result.quantityAfter,
    }),
    JSON.stringify({
      quantityReceived: result.quantityReceived,
      transactionId: result.transactionId,
    }),
    createdAt,
  );
}

function isCatalogAllocationConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("UNIQUE constraint failed: materials.id")
    || message.includes("UNIQUE constraint failed: materials.catalog_number");
}

function insertCommandStatement(
  db: D1Binding,
  requestId: string,
  requestHash: string,
  actorUserId: string,
  kind: string,
  targetType: string,
  targetId: string,
  createdAt: string,
): D1Statement {
  return db.prepare(`
    INSERT INTO mutation_commands (
      id, draft_id, kind, actor_user_id, status, target_type, target_id,
      request_hash, result_json, error_code, error_message,
      created_at, updated_at, completed_at
    ) VALUES (?, NULL, ?, ?, 'processing', ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL)
  `).bind(
    requestId,
    kind,
    actorUserId,
    targetType,
    targetId,
    requestHash,
    createdAt,
    createdAt,
  );
}

function completeCommandStatement(
  db: D1Binding,
  requestId: string,
  result: unknown,
  completedAt: string,
): D1Statement {
  return db.prepare(`
    UPDATE mutation_commands
    SET status = 'completed', result_json = ?, updated_at = ?, completed_at = ?
    WHERE id = ? AND status = 'processing'
  `).bind(JSON.stringify(result), completedAt, completedAt, requestId);
}

function guardedInventoryLineStatement(
  db: D1Binding,
  input: {
    lineId: string;
    transactionId: string;
    materialId: string;
    locationId: string;
    condition: string;
    quantityDelta: number;
    quantityBefore: number;
    quantityAfter: number;
    countedQuantity: number | null;
    loanItemId?: string | null;
    createdAt: string;
    guardSql: string;
    guardBindings: D1Value[];
  },
): D1Statement {
  return db.prepare(`
    INSERT INTO inventory_transaction_lines (
      id, transaction_id, material_id, location_id, condition,
      quantity_delta, quantity_before, quantity_after, counted_quantity,
      loan_item_id, created_at
    ) VALUES (?, ?, (${input.guardSql}), ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    input.lineId,
    input.transactionId,
    ...input.guardBindings,
    input.locationId,
    input.condition,
    input.quantityDelta,
    input.quantityBefore,
    input.quantityAfter,
    input.countedQuantity,
    input.loanItemId ?? null,
    input.createdAt,
  );
}

function rebuildStockTotalsStatement(
  db: D1Binding,
  materialId: string,
  updatedAt: string,
): D1Statement {
  return db.prepare(`
    INSERT INTO material_stock_totals (
      material_id, total_quantity, library_quantity,
      other_location_quantity, loaned_quantity, reserved_quantity, updated_at
    )
    SELECT
      m.id,
      COALESCE(SUM(h.quantity), 0) + COALESCE(outstanding.quantity, 0),
      COALESCE(SUM(CASE WHEN l.type = 'library' THEN h.quantity ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN l.type != 'library' THEN h.quantity ELSE 0 END), 0),
      COALESCE(outstanding.quantity, 0),
      COALESCE(reservations.quantity, 0),
      ?
    FROM materials m
    LEFT JOIN holdings h ON h.material_id = m.id
    LEFT JOIN locations l ON l.id = h.location_id
    LEFT JOIN (
      SELECT material_id, SUM(quantity) AS quantity
      FROM (
        SELECT
          li.material_id,
          li.quantity_issued - li.quantity_returned AS quantity
        FROM loan_items li
        JOIN loans lo ON lo.id = li.loan_id
        WHERE lo.status != 'cancelled' AND li.quantity_issued > li.quantity_returned
        UNION ALL
        SELECT
          cli.material_id,
          cli.quantity_issued - cli.quantity_returned AS quantity
        FROM class_loan_items cli
        JOIN class_loans clo ON clo.id = cli.class_loan_id
        WHERE clo.status != 'cancelled' AND cli.quantity_issued > cli.quantity_returned
      ) outstanding_rows
      GROUP BY material_id
    ) outstanding ON outstanding.material_id = m.id
    LEFT JOIN (
      SELECT material_id,
             SUM(reserved_quantity-issued_quantity-released_quantity) AS quantity
      FROM material_request_reservations
      WHERE reserved_quantity>issued_quantity+released_quantity
      GROUP BY material_id
    ) reservations ON reservations.material_id=m.id
    WHERE m.id = ?
    GROUP BY m.id, outstanding.quantity, reservations.quantity
    ON CONFLICT(material_id) DO UPDATE SET
      total_quantity = excluded.total_quantity,
      library_quantity = excluded.library_quantity,
      other_location_quantity = excluded.other_location_quantity,
      loaned_quantity = excluded.loaned_quantity,
      reserved_quantity = excluded.reserved_quantity,
      updated_at = excluded.updated_at
  `).bind(updatedAt, materialId);
}

function rebuildStockTotalsBulkStatement(
  db: D1Binding,
  materialIds: string[],
  updatedAt: string,
): D1Statement {
  return db.prepare(`
    WITH requested AS (
      SELECT DISTINCT CAST(value AS TEXT) AS material_id
      FROM json_each(?)
    )
    INSERT INTO material_stock_totals (
      material_id, total_quantity, library_quantity,
      other_location_quantity, loaned_quantity, reserved_quantity, updated_at
    )
    SELECT
      m.id,
      COALESCE(SUM(h.quantity), 0) + COALESCE(outstanding.quantity, 0),
      COALESCE(SUM(CASE WHEN l.type = 'library' THEN h.quantity ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN l.type != 'library' THEN h.quantity ELSE 0 END), 0),
      COALESCE(outstanding.quantity, 0),
      COALESCE(reservations.quantity, 0),
      ?
    FROM requested
    JOIN materials m ON m.id = requested.material_id
    LEFT JOIN holdings h ON h.material_id = m.id
    LEFT JOIN locations l ON l.id = h.location_id
    LEFT JOIN (
      SELECT material_id, SUM(quantity) AS quantity
      FROM (
        SELECT
          li.material_id,
          li.quantity_issued - li.quantity_returned AS quantity
        FROM loan_items li
        JOIN loans lo ON lo.id = li.loan_id
        WHERE lo.status != 'cancelled' AND li.quantity_issued > li.quantity_returned
        UNION ALL
        SELECT
          cli.material_id,
          cli.quantity_issued - cli.quantity_returned AS quantity
        FROM class_loan_items cli
        JOIN class_loans clo ON clo.id = cli.class_loan_id
        WHERE clo.status != 'cancelled' AND cli.quantity_issued > cli.quantity_returned
      ) outstanding_rows
      GROUP BY material_id
    ) outstanding ON outstanding.material_id = m.id
    LEFT JOIN (
      SELECT material_id,
             SUM(reserved_quantity-issued_quantity-released_quantity) AS quantity
      FROM material_request_reservations
      WHERE reserved_quantity>issued_quantity+released_quantity
      GROUP BY material_id
    ) reservations ON reservations.material_id=m.id
    GROUP BY m.id, outstanding.quantity, reservations.quantity
    ON CONFLICT(material_id) DO UPDATE SET
      total_quantity = excluded.total_quantity,
      library_quantity = excluded.library_quantity,
      other_location_quantity = excluded.other_location_quantity,
      loaned_quantity = excluded.loaned_quantity,
      reserved_quantity = excluded.reserved_quantity,
      updated_at = excluded.updated_at
  `).bind(JSON.stringify(materialIds), updatedAt);
}

async function executeIdempotentBatch<T>(
  db: D1Binding,
  statements: D1Statement[],
  requestId: string,
  requestHash: string,
  conflict: {
    code: string;
    message: string;
    classify?: (error: unknown) => { code: string; message: string } | null;
  },
): Promise<T | null> {
  try {
    await db.batch(statements);
    return null;
  } catch (error) {
    const replay = await replayCompletedCommand<T>(db, requestId, requestHash);
    if (replay) return replay;
    const errorMessage = error instanceof Error ? error.message : String(error ?? "");
    if (errorMessage.includes("material_reserved_conflict")) {
      throw new LibraryMutationError(
        "material_reserved_conflict",
        409,
        "Матеріал зарезервовано для замовлення вчителя.",
      );
    }
    if (
      errorMessage.includes("reserved_stock_conflict")
      || errorMessage.includes("reservation_stock_conflict")
    ) {
      throw new LibraryMutationError(
        "reserved_stock_conflict",
        409,
        "Операція зачіпає примірники, зарезервовані для замовлення вчителя.",
      );
    }
    const classified = conflict.classify?.(error) ?? null;
    if (classified) {
      throw new LibraryMutationError(classified.code, 409, classified.message);
    }
    if (isOptimisticGuardFailure(error)) {
      throw new LibraryMutationError(
        conflict.code,
        409,
        conflict.message,
      );
    }
    throw error;
  }
}

function isOptimisticGuardFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("NOT NULL constraint failed: audit_events.entity_id")
    || message.includes("NOT NULL constraint failed: inventory_transaction_lines.material_id")
    || message.includes("NOT NULL constraint failed: class_loan_transaction_lines.material_id")
    || message.includes("NOT NULL constraint failed: class_loan_items.material_id")
    || message.includes("NOT NULL constraint failed: class_loan_items.source_location_id")
    || message.includes("NOT NULL constraint failed: class_loans.class_year_id")
    || message.includes("NOT NULL constraint failed: class_loans.responsible_teacher_user_id")
    || message.includes("NOT NULL constraint failed: holdings.material_id")
    || message.includes("NOT NULL constraint failed: holdings.location_id")
    || message.includes(
      "UNIQUE constraint failed: holdings.material_id, holdings.location_id, holdings.condition",
    )
    || message.includes("reserved_stock_conflict")
    || message.includes("reservation_stock_conflict")
    || message.includes("material_reserved_conflict");
}

function classifyClassLoanIssueRace(
  error: unknown,
): { code: string; message: string } | null {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message.includes("NOT NULL constraint failed: class_loans.class_year_id")) {
    return {
      code: "class_year_version_conflict",
      message: "Дані класу змінилися під час видачі. Оновіть список класів.",
    };
  }
  if (message.includes("NOT NULL constraint failed: class_loans.responsible_teacher_user_id")) {
    return {
      code: "responsible_teacher_not_found",
      message: "Профіль відповідального вчителя став неактивним. Оберіть іншого вчителя.",
    };
  }
  return null;
}

async function replayCompletedCommand<T>(
  db: D1Binding,
  requestId: string,
  requestHash: string,
): Promise<T | null> {
  const command = await db.prepare(`
    SELECT status, request_hash, result_json, error_code, error_message
    FROM mutation_commands
    WHERE id = ?
    LIMIT 1
  `).bind(requestId).first<StoredCommand>();
  if (!command) return null;
  if (command.request_hash !== requestHash) {
    throw new LibraryMutationError(
      "request_id_conflict",
      409,
      "Цей request ID вже використано для іншої зміни.",
    );
  }
  if (command.status === "processing") {
    throw new LibraryMutationError(
      "mutation_in_progress",
      409,
      "Зміна ще виконується. Оновіть результат через кілька секунд.",
    );
  }
  if (command.status === "failed") {
    throw new LibraryMutationError(
      command.error_code || "mutation_failed",
      409,
      command.error_message || "Зміну не виконано.",
    );
  }
  if (command.status !== "completed" || !command.result_json) {
    throw new LibraryMutationError(
      "mutation_result_invalid",
      503,
      "Збережений результат зміни пошкоджено.",
    );
  }
  try {
    return JSON.parse(command.result_json) as T;
  } catch {
    throw new LibraryMutationError(
      "mutation_result_invalid",
      503,
      "Збережений результат зміни пошкоджено.",
    );
  }
}

async function mutationHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(object[key])}`
  ).join(",")}}`;
}
