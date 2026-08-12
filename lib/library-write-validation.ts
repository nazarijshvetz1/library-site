export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; fieldErrors: Record<string, string> };

export const MATERIAL_LINK_KINDS = [
  "ebook",
  "details",
  "publisher",
  "store",
  "preview",
  "other",
] as const;

export type MaterialLinkInput = {
  id: string | null;
  kind: (typeof MATERIAL_LINK_KINDS)[number];
  label: string;
  url: string;
  isPublic: boolean;
  sortOrder: number;
};

export type MaterialUpdateInput = {
  requestId: string;
  expectedVersion: number;
  changes: {
    title?: string;
    rubric?: string;
    publicationType?: string | null;
    subject?: string | null;
    classFrom?: number | null;
    classTo?: number | null;
    author?: string | null;
    publicationYear?: number | null;
    isbn?: string | null;
    publisher?: string | null;
    notes?: string | null;
    links?: MaterialLinkInput[];
  };
};

export type MaterialArchiveInput = {
  requestId: string;
  expectedVersion: number;
};

export type MaterialCreateInput = {
  requestId: string;
  title: string;
  rubric: string;
  publicationType: string | null;
  subject: string | null;
  classFrom: number | null;
  classTo: number | null;
  author: string | null;
  publicationYear: number | null;
  isbn: string | null;
  publisher: string | null;
  notes: string | null;
  links: MaterialLinkInput[];
  initialReceipt: ReceiptCreateDetails | null;
};

export type ReceiptCreateDetails = {
  locationId: string;
  condition: "unspecified" | "good" | "worn" | "damaged";
  quantity: number;
  expectedQuantity: number;
  occurredAt: string;
  documentNumber: string | null;
  notes: string | null;
};

export type ReceiptCreateInput = ReceiptCreateDetails & {
  requestId: string;
  materialId: string;
};

export type StockAdjustmentInput = {
  requestId: string;
  materialId: string;
  locationId: string;
  condition: "unspecified" | "good" | "worn" | "damaged";
  expectedQuantity: number;
  countedQuantity: number;
  reason: "inventory_count" | "error_correction" | "other";
  occurredAt: string;
  notes: string | null;
};

export type StockTransferInput = {
  requestId: string;
  materialId: string;
  sourceLocationId: string;
  destinationLocationId: string;
  condition: "unspecified" | "good" | "worn" | "damaged";
  quantity: number;
  expectedSourceQuantity: number;
  expectedDestinationQuantity: number;
  occurredAt: string;
  documentNumber: string | null;
  notes: string | null;
};

export const WRITEOFF_REASONS = [
  "worn",
  "damaged",
  "lost",
  "obsolete",
  "inventory_shortage",
  "other",
] as const;

export type StockWriteoffInput = {
  requestId: string;
  materialId: string;
  locationId: string;
  condition: "unspecified" | "good" | "worn" | "damaged";
  quantity: number;
  expectedQuantity: number;
  reason: (typeof WRITEOFF_REASONS)[number];
  occurredAt: string;
  documentNumber: string | null;
  notes: string | null;
};

export type LoanCreateInput = {
  requestId: string;
  teacherUserId: string;
  issuedAt: string;
  dueAt: string | null;
  notes: string | null;
  items: Array<{
    materialId: string;
    sourceLocationId: string;
    condition: "unspecified" | "good" | "worn" | "damaged";
    quantity: number;
    expectedAvailableQuantity: number;
  }>;
};

export type LoanReturnInput = {
  requestId: string;
  loanId: string;
  returnedAt: string;
  notes: string | null;
  items: Array<{
    loanItemId: string;
    quantity: number;
    returnLocationId: string;
    condition: "unspecified" | "good" | "worn" | "damaged";
  }>;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CAT_ID_RE = /^CAT-\d{4,}$/u;
const LOCATION_ID_RE = /^LOC-\d{3,}$/u;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const CONDITIONS = new Set(["unspecified", "good", "worn", "damaged"]);

export function validateMaterialCreateInput(
  input: unknown,
): ValidationResult<MaterialCreateInput> {
  const errors: Record<string, string> = {};
  if (!isRecord(input)) return invalid("body", "Очікуються дані нового матеріалу.");
  const allowed = [
    "requestId", "title", "rubric", "publicationType", "subject",
    "classFrom", "classTo", "author", "publicationYear", "isbn",
    "publisher", "notes", "links", "initialReceipt",
  ];
  assertExactKeys(input, allowed, errors);
  const requestId = readUuid(input.requestId, "requestId", errors);
  const title = readRequiredText(input.title, "title", errors, 300);
  const rubric = readRequiredText(input.rubric, "rubric", errors, 160);
  const publicationType = readOptionalText(input.publicationType ?? null, "publicationType", errors, 160);
  const subject = readOptionalText(input.subject ?? null, "subject", errors, 160);
  const classFrom = readNullableInteger(input.classFrom ?? null, "classFrom", errors, 1, 12);
  const classTo = readNullableInteger(input.classTo ?? null, "classTo", errors, 1, 12);
  if (classFrom !== null && classTo !== null && classFrom > classTo) {
    errors.classTo = "Кінцевий клас не може бути меншим за початковий.";
  }
  const author = readOptionalText(input.author ?? null, "author", errors, 300);
  const publicationYear = readNullableInteger(
    input.publicationYear ?? null,
    "publicationYear",
    errors,
    1000,
    new Date().getUTCFullYear() + 1,
  );
  const isbn = readOptionalText(input.isbn ?? null, "isbn", errors, 32);
  const publisher = readOptionalText(input.publisher ?? null, "publisher", errors, 200);
  const notes = readOptionalText(input.notes ?? null, "notes", errors, 2000);
  const links = readLinks(input.links ?? [], errors, "links");
  let initialReceipt: ReceiptCreateDetails | null = null;
  if (input.initialReceipt !== null && input.initialReceipt !== undefined) {
    if (!isRecord(input.initialReceipt)) {
      errors.initialReceipt = "Некоректні дані початкового надходження.";
    } else {
      initialReceipt = readReceiptDetails(input.initialReceipt, errors, "initialReceipt.");
    }
  }
  return finish(errors, {
    requestId,
    title,
    rubric,
    publicationType,
    subject,
    classFrom,
    classTo,
    author,
    publicationYear,
    isbn,
    publisher,
    notes,
    links,
    initialReceipt,
  });
}

export function validateReceiptCreateInput(
  input: unknown,
): ValidationResult<ReceiptCreateInput> {
  const errors: Record<string, string> = {};
  if (!isRecord(input)) return invalid("body", "Очікуються дані надходження.");
  assertExactKeys(
    input,
    [
      "requestId", "materialId", "locationId", "condition", "quantity",
      "expectedQuantity", "occurredAt", "documentNumber", "notes",
    ],
    errors,
  );
  const requestId = readUuid(input.requestId, "requestId", errors);
  const materialId = readPatternText(
    input.materialId,
    CAT_ID_RE,
    "materialId",
    "Некоректний CAT-ID.",
    errors,
  );
  const details = readReceiptDetails({
    locationId: input.locationId,
    condition: input.condition,
    quantity: input.quantity,
    expectedQuantity: input.expectedQuantity,
    occurredAt: input.occurredAt,
    documentNumber: input.documentNumber,
    notes: input.notes,
  }, errors, "");
  return finish(errors, { requestId, materialId, ...details });
}

export function validateMaterialUpdateInput(
  input: unknown,
): ValidationResult<MaterialUpdateInput> {
  const errors: Record<string, string> = {};
  if (!isRecord(input)) {
    return invalid("body", "Очікується об’єкт із даними матеріалу.");
  }
  assertExactKeys(input, ["requestId", "expectedVersion", "changes"], errors);
  const requestId = readUuid(input.requestId, "requestId", errors);
  const expectedVersion = readPositiveInteger(
    input.expectedVersion,
    "expectedVersion",
    errors,
  );
  const changesValue = input.changes;
  if (!isRecord(changesValue)) {
    errors.changes = "Укажіть зміни матеріалу.";
  }
  const changes: MaterialUpdateInput["changes"] = {};
  if (isRecord(changesValue)) {
    const allowed = [
      "title",
      "rubric",
      "publicationType",
      "subject",
      "classFrom",
      "classTo",
      "author",
      "publicationYear",
      "isbn",
      "publisher",
      "notes",
      "links",
    ];
    assertExactKeys(changesValue, allowed, errors, "changes.");
    if ("title" in changesValue) {
      changes.title = readRequiredText(
        changesValue.title,
        "changes.title",
        errors,
        300,
      );
    }
    if ("rubric" in changesValue) {
      changes.rubric = readRequiredText(
        changesValue.rubric,
        "changes.rubric",
        errors,
        160,
      );
    }
    for (const [key, limit] of [
      ["publicationType", 160],
      ["subject", 160],
      ["author", 300],
      ["isbn", 32],
      ["publisher", 200],
      ["notes", 2000],
    ] as const) {
      if (key in changesValue) {
        changes[key] = readOptionalText(
          changesValue[key],
          `changes.${key}`,
          errors,
          limit,
        );
      }
    }
    if ("classFrom" in changesValue) {
      changes.classFrom = readNullableInteger(
        changesValue.classFrom,
        "changes.classFrom",
        errors,
        1,
        12,
      );
    }
    if ("classTo" in changesValue) {
      changes.classTo = readNullableInteger(
        changesValue.classTo,
        "changes.classTo",
        errors,
        1,
        12,
      );
    }
    if (
      changes.classFrom !== undefined &&
      changes.classTo !== undefined &&
      changes.classFrom !== null &&
      changes.classTo !== null &&
      changes.classFrom > changes.classTo
    ) {
      errors["changes.classTo"] =
        "Кінцевий клас не може бути меншим за початковий.";
    }
    if ("publicationYear" in changesValue) {
      changes.publicationYear = readNullableInteger(
        changesValue.publicationYear,
        "changes.publicationYear",
        errors,
        1000,
        new Date().getUTCFullYear() + 1,
      );
    }
    if ("links" in changesValue) {
      changes.links = readLinks(changesValue.links, errors);
    }
    if (Object.keys(changesValue).length === 0) {
      errors.changes = "Немає змін для збереження.";
    }
  }
  return finish(errors, {
    requestId,
    expectedVersion,
    changes,
  });
}

export function validateMaterialArchiveInput(
  input: unknown,
): ValidationResult<MaterialArchiveInput> {
  const errors: Record<string, string> = {};
  if (!isRecord(input)) {
    return invalid("body", "Очікується підтвердження видалення матеріалу.");
  }
  assertExactKeys(input, ["requestId", "expectedVersion"], errors);
  const requestId = readUuid(input.requestId, "requestId", errors);
  const expectedVersion = readPositiveInteger(
    input.expectedVersion,
    "expectedVersion",
    errors,
  );
  return finish(errors, { requestId, expectedVersion });
}

export function validateStockAdjustmentInput(
  input: unknown,
): ValidationResult<StockAdjustmentInput> {
  const errors: Record<string, string> = {};
  if (!isRecord(input)) return invalid("body", "Очікується об’єкт коригування.");
  assertExactKeys(
    input,
    [
      "requestId",
      "materialId",
      "locationId",
      "condition",
      "expectedQuantity",
      "countedQuantity",
      "reason",
      "occurredAt",
      "notes",
    ],
    errors,
  );
  const requestId = readUuid(input.requestId, "requestId", errors);
  const materialId = readPatternText(
    input.materialId,
    CAT_ID_RE,
    "materialId",
    "Некоректний CAT-ID.",
    errors,
  );
  const locationId = readPatternText(
    input.locationId,
    LOCATION_ID_RE,
    "locationId",
    "Некоректне місце зберігання.",
    errors,
  );
  const condition = readCondition(input.condition, "condition", errors);
  const expectedQuantity = readBoundedInteger(
    input.expectedQuantity,
    "expectedQuantity",
    errors,
    0,
    1_000_000,
  );
  const countedQuantity = readBoundedInteger(
    input.countedQuantity,
    "countedQuantity",
    errors,
    0,
    1_000_000,
  );
  const reason = readEnum(
    input.reason,
    ["inventory_count", "error_correction", "other"] as const,
    "reason",
    errors,
  );
  const occurredAt = readIsoDate(input.occurredAt, "occurredAt", errors);
  const notes = readOptionalText(input.notes, "notes", errors, 2000);
  if (reason === "other" && !notes) {
    errors.notes = "Опишіть причину коригування.";
  }
  return finish(errors, {
    requestId,
    materialId,
    locationId,
    condition,
    expectedQuantity,
    countedQuantity,
    reason,
    occurredAt,
    notes,
  });
}

export function validateStockTransferInput(
  input: unknown,
): ValidationResult<StockTransferInput> {
  const errors: Record<string, string> = {};
  if (!isRecord(input)) {
    return invalid("body", "Очікується об’єкт переміщення.");
  }
  assertExactKeys(
    input,
    [
      "requestId",
      "materialId",
      "sourceLocationId",
      "destinationLocationId",
      "condition",
      "quantity",
      "expectedSourceQuantity",
      "expectedDestinationQuantity",
      "occurredAt",
      "documentNumber",
      "notes",
    ],
    errors,
  );
  const requestId = readUuid(input.requestId, "requestId", errors);
  const materialId = readPatternText(
    input.materialId,
    CAT_ID_RE,
    "materialId",
    "Некоректний CAT-ID.",
    errors,
  );
  const sourceLocationId = readPatternText(
    input.sourceLocationId,
    LOCATION_ID_RE,
    "sourceLocationId",
    "Некоректне початкове місце.",
    errors,
  );
  const destinationLocationId = readPatternText(
    input.destinationLocationId,
    LOCATION_ID_RE,
    "destinationLocationId",
    "Некоректне кінцеве місце.",
    errors,
  );
  if (
    sourceLocationId &&
    destinationLocationId &&
    sourceLocationId === destinationLocationId
  ) {
    errors.destinationLocationId = "Початкове й кінцеве місце мають відрізнятися.";
  }
  const condition = readCondition(input.condition, "condition", errors);
  const quantity = readBoundedInteger(input.quantity, "quantity", errors, 1, 1_000_000);
  const expectedSourceQuantity = readBoundedInteger(
    input.expectedSourceQuantity,
    "expectedSourceQuantity",
    errors,
    0,
    1_000_000,
  );
  const expectedDestinationQuantity = readBoundedInteger(
    input.expectedDestinationQuantity,
    "expectedDestinationQuantity",
    errors,
    0,
    1_000_000,
  );
  if (quantity > expectedSourceQuantity) {
    errors.quantity = "Кількість переміщення перевищує очікуваний залишок.";
  }
  const occurredAt = readIsoDate(input.occurredAt, "occurredAt", errors);
  const documentNumber = readOptionalText(
    input.documentNumber,
    "documentNumber",
    errors,
    160,
  );
  const notes = readOptionalText(input.notes, "notes", errors, 2000);
  return finish(errors, {
    requestId,
    materialId,
    sourceLocationId,
    destinationLocationId,
    condition,
    quantity,
    expectedSourceQuantity,
    expectedDestinationQuantity,
    occurredAt,
    documentNumber,
    notes,
  });
}

export function validateStockWriteoffInput(
  input: unknown,
): ValidationResult<StockWriteoffInput> {
  const errors: Record<string, string> = {};
  if (!isRecord(input)) {
    return invalid("body", "Очікується об’єкт списання.");
  }
  assertExactKeys(
    input,
    [
      "requestId",
      "materialId",
      "locationId",
      "condition",
      "quantity",
      "expectedQuantity",
      "reason",
      "occurredAt",
      "documentNumber",
      "notes",
    ],
    errors,
  );
  const requestId = readUuid(input.requestId, "requestId", errors);
  const materialId = readPatternText(
    input.materialId,
    CAT_ID_RE,
    "materialId",
    "Некоректний CAT-ID.",
    errors,
  );
  const locationId = readPatternText(
    input.locationId,
    LOCATION_ID_RE,
    "locationId",
    "Некоректне місце списання.",
    errors,
  );
  const condition = readCondition(input.condition, "condition", errors);
  const quantity = readBoundedInteger(input.quantity, "quantity", errors, 1, 1_000_000);
  const expectedQuantity = readBoundedInteger(
    input.expectedQuantity,
    "expectedQuantity",
    errors,
    0,
    1_000_000,
  );
  if (quantity > expectedQuantity) {
    errors.quantity = "Кількість списання перевищує очікуваний залишок.";
  }
  const reason = readEnum(input.reason, WRITEOFF_REASONS, "reason", errors);
  const occurredAt = readIsoDate(input.occurredAt, "occurredAt", errors);
  const documentNumber = readOptionalText(
    input.documentNumber,
    "documentNumber",
    errors,
    160,
  );
  const notes = readOptionalText(input.notes, "notes", errors, 2000);
  if (reason === "other" && !notes) {
    errors.notes = "Опишіть причину списання.";
  }
  return finish(errors, {
    requestId,
    materialId,
    locationId,
    condition,
    quantity,
    expectedQuantity,
    reason,
    occurredAt,
    documentNumber,
    notes,
  });
}

export function validateLoanCreateInput(
  input: unknown,
): ValidationResult<LoanCreateInput> {
  const errors: Record<string, string> = {};
  if (!isRecord(input)) return invalid("body", "Очікуються дані видачі.");
  assertExactKeys(
    input,
    ["requestId", "teacherUserId", "issuedAt", "dueAt", "notes", "items"],
    errors,
  );
  const requestId = readUuid(input.requestId, "requestId", errors);
  const teacherUserId = readPatternText(
    input.teacherUserId,
    SAFE_ID_RE,
    "teacherUserId",
    "Оберіть учителя.",
    errors,
  );
  const issuedAt = readIsoDate(input.issuedAt, "issuedAt", errors);
  const dueAt = input.dueAt === null
    ? null
    : readIsoDate(input.dueAt, "dueAt", errors);
  if (issuedAt && dueAt && dueAt < issuedAt) {
    errors.dueAt = "Строк повернення не може передувати даті видачі.";
  }
  const notes = readOptionalText(input.notes, "notes", errors, 2000);
  const items = readLoanCreateItems(input.items, errors);
  return finish(errors, {
    requestId,
    teacherUserId,
    issuedAt,
    dueAt,
    notes,
    items,
  });
}

export function validateLoanReturnInput(
  input: unknown,
): ValidationResult<LoanReturnInput> {
  const errors: Record<string, string> = {};
  if (!isRecord(input)) return invalid("body", "Очікуються дані повернення.");
  assertExactKeys(
    input,
    ["requestId", "loanId", "returnedAt", "notes", "items"],
    errors,
  );
  const requestId = readUuid(input.requestId, "requestId", errors);
  const loanId = readPatternText(
    input.loanId,
    SAFE_ID_RE,
    "loanId",
    "Некоректний номер видачі.",
    errors,
  );
  const returnedAt = readIsoDate(input.returnedAt, "returnedAt", errors);
  const notes = readOptionalText(input.notes, "notes", errors, 2000);
  const items: LoanReturnInput["items"] = [];
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) {
    errors.items = "Додайте від 1 до 100 позицій повернення.";
  } else {
    const seen = new Set<string>();
    input.items.forEach((item, index) => {
      const prefix = `items.${index}.`;
      if (!isRecord(item)) {
        errors[`items.${index}`] = "Некоректна позиція повернення.";
        return;
      }
      assertExactKeys(
        item,
        ["loanItemId", "quantity", "returnLocationId", "condition"],
        errors,
        prefix,
      );
      const loanItemId = readPatternText(
        item.loanItemId,
        SAFE_ID_RE,
        `${prefix}loanItemId`,
        "Некоректний номер позиції.",
        errors,
      );
      if (seen.has(loanItemId)) {
        errors[`${prefix}loanItemId`] = "Позицію додано двічі.";
      }
      seen.add(loanItemId);
      items.push({
        loanItemId,
        quantity: readBoundedInteger(
          item.quantity,
          `${prefix}quantity`,
          errors,
          1,
          1_000_000,
        ),
        returnLocationId: readPatternText(
          item.returnLocationId,
          LOCATION_ID_RE,
          `${prefix}returnLocationId`,
          "Некоректне місце повернення.",
          errors,
        ),
        condition: readCondition(item.condition, `${prefix}condition`, errors),
      });
    });
  }
  return finish(errors, { requestId, loanId, returnedAt, notes, items });
}

function readLinks(
  value: unknown,
  errors: Record<string, string>,
  path = "changes.links",
): MaterialLinkInput[] {
  if (!Array.isArray(value) || value.length > 20) {
    errors[path] = "Дозволено не більше 20 посилань.";
    return [];
  }
  const links: MaterialLinkInput[] = [];
  value.forEach((link, index) => {
    const prefix = `${path}.${index}.`;
    if (!isRecord(link)) {
      errors[`${path}.${index}`] = "Некоректне посилання.";
      return;
    }
    assertExactKeys(
      link,
      ["id", "kind", "label", "url", "isPublic", "sortOrder"],
      errors,
      prefix,
    );
    const rawUrl = readRequiredText(link.url, `${prefix}url`, errors, 2000);
    let url = rawUrl;
    try {
      const parsed = new URL(rawUrl);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw new Error("unsupported URL");
      }
      url = parsed.toString();
    } catch {
      errors[`${prefix}url`] = "Укажіть коректне HTTP або HTTPS посилання.";
    }
    links.push({
      id: link.id === null
        ? null
        : readPatternText(
            link.id,
            SAFE_ID_RE,
            `${prefix}id`,
            "Некоректний номер посилання.",
            errors,
          ),
      kind: readEnum(
        link.kind,
        MATERIAL_LINK_KINDS,
        `${prefix}kind`,
        errors,
      ),
      label: readRequiredText(link.label, `${prefix}label`, errors, 120),
      url,
      isPublic: readBoolean(link.isPublic, `${prefix}isPublic`, errors),
      sortOrder: readBoundedInteger(
        link.sortOrder,
        `${prefix}sortOrder`,
        errors,
        0,
        1000,
      ),
    });
  });
  return links;
}

function readReceiptDetails(
  value: Record<string, unknown>,
  errors: Record<string, string>,
  prefix: string,
): ReceiptCreateDetails {
  assertExactKeys(
    value,
    [
      "locationId", "condition", "quantity", "expectedQuantity",
      "occurredAt", "documentNumber", "notes",
    ],
    errors,
    prefix,
  );
  return {
    locationId: readPatternText(
      value.locationId,
      LOCATION_ID_RE,
      `${prefix}locationId`,
      "Некоректне місце надходження.",
      errors,
    ),
    condition: readCondition(value.condition, `${prefix}condition`, errors),
    quantity: readBoundedInteger(
      value.quantity,
      `${prefix}quantity`,
      errors,
      1,
      1_000_000,
    ),
    expectedQuantity: readBoundedInteger(
      value.expectedQuantity,
      `${prefix}expectedQuantity`,
      errors,
      0,
      1_000_000,
    ),
    occurredAt: readIsoDate(value.occurredAt, `${prefix}occurredAt`, errors),
    documentNumber: readOptionalText(
      value.documentNumber ?? null,
      `${prefix}documentNumber`,
      errors,
      160,
    ),
    notes: readOptionalText(value.notes ?? null, `${prefix}notes`, errors, 2000),
  };
}

function readLoanCreateItems(
  value: unknown,
  errors: Record<string, string>,
): LoanCreateInput["items"] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    errors.items = "Додайте від 1 до 100 матеріалів.";
    return [];
  }
  const items: LoanCreateInput["items"] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const prefix = `items.${index}.`;
    if (!isRecord(item)) {
      errors[`items.${index}`] = "Некоректний матеріал видачі.";
      return;
    }
    assertExactKeys(
      item,
      [
        "materialId",
        "sourceLocationId",
        "condition",
        "quantity",
        "expectedAvailableQuantity",
      ],
      errors,
      prefix,
    );
    const materialId = readPatternText(
      item.materialId,
      CAT_ID_RE,
      `${prefix}materialId`,
      "Некоректний CAT-ID.",
      errors,
    );
    const sourceLocationId = readPatternText(
      item.sourceLocationId,
      LOCATION_ID_RE,
      `${prefix}sourceLocationId`,
      "Некоректне місце видачі.",
      errors,
    );
    const condition = readCondition(item.condition, `${prefix}condition`, errors);
    const dedupeKey = `${materialId}\u0000${sourceLocationId}\u0000${condition}`;
    if (seen.has(dedupeKey)) {
      errors[`items.${index}`] = "Однаковий матеріал і місце додано двічі.";
    }
    seen.add(dedupeKey);
    items.push({
      materialId,
      sourceLocationId,
      condition,
      quantity: readBoundedInteger(
        item.quantity,
        `${prefix}quantity`,
        errors,
        1,
        1_000_000,
      ),
      expectedAvailableQuantity: readBoundedInteger(
        item.expectedAvailableQuantity,
        `${prefix}expectedAvailableQuantity`,
        errors,
        0,
        1_000_000,
      ),
    });
  });
  return items;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  errors: Record<string, string>,
  prefix = "",
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) errors[`${prefix}${key}`] = "Невідоме поле.";
  }
}

function readUuid(value: unknown, key: string, errors: Record<string, string>): string {
  return readPatternText(value, UUID_RE, key, "Некоректний request ID.", errors).toLowerCase();
}

function readRequiredText(
  value: unknown,
  key: string,
  errors: Record<string, string>,
  maxLength: number,
): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    errors[key] = `Поле має містити від 1 до ${maxLength} символів.`;
    return "";
  }
  return value.trim();
}

function readOptionalText(
  value: unknown,
  key: string,
  errors: Record<string, string>,
  maxLength: number,
): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > maxLength) {
    errors[key] = `Поле має містити не більше ${maxLength} символів.`;
    return null;
  }
  return value.trim() || null;
}

function readPatternText(
  value: unknown,
  pattern: RegExp,
  key: string,
  message: string,
  errors: Record<string, string>,
): string {
  if (typeof value !== "string" || !pattern.test(value.trim())) {
    errors[key] = message;
    return "";
  }
  return value.trim();
}

function readPositiveInteger(
  value: unknown,
  key: string,
  errors: Record<string, string>,
): number {
  return readBoundedInteger(value, key, errors, 1, Number.MAX_SAFE_INTEGER);
}

function readNullableInteger(
  value: unknown,
  key: string,
  errors: Record<string, string>,
  min: number,
  max: number,
): number | null {
  if (value === null || value === "") return null;
  return readBoundedInteger(value, key, errors, min, max);
}

function readBoundedInteger(
  value: unknown,
  key: string,
  errors: Record<string, string>,
  min: number,
  max: number,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    errors[key] = `Укажіть ціле число від ${min} до ${max}.`;
    return min;
  }
  return Number(value);
}

function readBoolean(value: unknown, key: string, errors: Record<string, string>): boolean {
  if (typeof value !== "boolean") {
    errors[key] = "Укажіть так або ні.";
    return false;
  }
  return value;
}

function readCondition(
  value: unknown,
  key: string,
  errors: Record<string, string>,
): "unspecified" | "good" | "worn" | "damaged" {
  if (typeof value !== "string" || !CONDITIONS.has(value)) {
    errors[key] = "Оберіть стан примірників.";
    return "unspecified";
  }
  return value as "unspecified" | "good" | "worn" | "damaged";
}

function readEnum<const T extends readonly string[]>(
  value: unknown,
  options: T,
  key: string,
  errors: Record<string, string>,
): T[number] {
  if (
    typeof value !== "string" ||
    !(options as readonly string[]).includes(value)
  ) {
    errors[key] = "Оберіть дозволене значення.";
    return options[0];
  }
  return value as T[number];
}

function readIsoDate(value: unknown, key: string, errors: Record<string, string>): string {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) {
    errors[key] = "Укажіть дату у форматі РРРР-ММ-ДД.";
    return "";
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    errors[key] = "Укажіть коректну дату.";
    return "";
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid<T>(key: string, message: string): ValidationResult<T> {
  return { ok: false, fieldErrors: { [key]: message } };
}

function finish<T>(
  errors: Record<string, string>,
  value: T,
): ValidationResult<T> {
  return Object.keys(errors).length > 0
    ? { ok: false, fieldErrors: errors }
    : { ok: true, value };
}
