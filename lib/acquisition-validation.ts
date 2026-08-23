export const ACQUISITION_MAX_QUANTITY = 1_000;
export const ACQUISITION_IMPORT_MAX_ROWS = 500;
export const ACQUISITION_IMPORT_MAX_NEW_ROWS = 20;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MATERIAL_ID_RE = /^CAT-\d{4,}$/u;
const USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type AcquisitionCategory = "educational" | "literature";
export type AcquisitionSourceKind = "catalog" | "manual";
export type AcquisitionLiteratureKind = "none" | "fiction" | "science" | "popular_science" | "other";
export type AcquisitionStatus =
  | "submitted"
  | "in_review"
  | "clarification"
  | "approved"
  | "planned"
  | "ordered"
  | "partially_received"
  | "received"
  | "rejected"
  | "cancelled";

export type AcquisitionCreateInput = {
  requestId: string;
  category: AcquisitionCategory;
  sourceKind: AcquisitionSourceKind;
  literatureKind: AcquisitionLiteratureKind;
  materialId: string | null;
  title: string;
  author: string;
  publicationYear: number;
  requestedQuantity: number;
  sourceUrl: string;
  subject: string;
  targetClass: string;
  note: string;
};

export type StudentAcquisitionCreateInput = {
  requestId: string;
  fullName: string;
  className: string;
  title: string;
  author: string;
  publicationYear: number;
  requestedQuantity: number;
  sourceUrl: string;
  note: string;
  website: string;
  startedAt: string;
};

export type AcquisitionAction =
  | "start_review"
  | "request_clarification"
  | "approve"
  | "plan"
  | "order"
  | "link_material"
  | "link_receipt"
  | "reject"
  | "cancel";

export type AcquisitionActionInput = {
  mutationId: string;
  expectedVersion: number;
  action: AcquisitionAction;
  approvedQuantity: number | null;
  orderedQuantity: number | null;
  targetMaterialId: string | null;
  receiptLineId: string;
  allocatedQuantity: number | null;
  message: string;
};

export type AcquisitionCancelInput = {
  mutationId: string;
  expectedVersion: number;
  reason: string;
};

export type AcquisitionImportRowInput = {
  sourceSheet: "Дозамовлення" | "Художня та наукова література" | "Пропозиції учнів";
  sourceRow: number;
  existingRequestNumber: string;
  requesterKind: "teacher" | "student";
  teacherUserId: string;
  teacherName: string;
  studentName: string;
  studentClassName: string;
  category: AcquisitionCategory;
  sourceKind: AcquisitionSourceKind;
  literatureKind: AcquisitionLiteratureKind;
  materialId: string | null;
  title: string;
  author: string;
  publicationYear: number;
  requestedQuantity: number;
  sourceUrl: string;
  subject: string;
  targetClass: string;
  note: string;
};

export type AcquisitionImportInput = {
  mode: "preview" | "commit";
  importId: string;
  fileName: string;
  fileHash: string;
  confirmation: "IMPORT_ACQUISITION_REQUESTS" | null;
  rows: AcquisitionImportRowInput[];
};

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; fieldErrors: Record<string, string> };

export function validateAcquisitionCreateInput(input: unknown): ValidationResult<AcquisitionCreateInput> {
  const errors: Record<string, string> = {};
  if (!isRecord(input)) return invalid("body", "Очікуються дані заявки.");
  exactKeys(input, [
    "requestId", "category", "sourceKind", "literatureKind", "materialId", "title", "author",
    "publicationYear", "requestedQuantity", "sourceUrl", "subject", "targetClass", "note",
  ], errors);
  const requestId = readUuid(input.requestId, "requestId", errors);
  const category = readCategory(input.category, "category", errors);
  const sourceKind = readSourceKind(input.sourceKind, "sourceKind", errors);
  const literatureKind = readLiteratureKind(input.literatureKind, "literatureKind", errors);
  const materialId = readNullableMaterialId(input.materialId, "materialId", errors);
  const title = readText(input.title, "title", errors, 2, 320);
  const author = readText(input.author, "author", errors, 2, 240);
  const publicationYear = readYear(input.publicationYear, "publicationYear", errors);
  const requestedQuantity = readInteger(input.requestedQuantity, "requestedQuantity", errors, 1, ACQUISITION_MAX_QUANTITY);
  const sourceUrl = readHttpUrl(input.sourceUrl, "sourceUrl", errors);
  const subject = readOptionalText(input.subject, "subject", errors, 120);
  const targetClass = readOptionalText(input.targetClass, "targetClass", errors, 80);
  const note = readOptionalText(input.note, "note", errors, 1_000);
  validateCategoryShape({ category, sourceKind, literatureKind, materialId, subject, targetClass }, errors);
  return finish(errors, {
    requestId, category, sourceKind, literatureKind, materialId, title, author,
    publicationYear, requestedQuantity, sourceUrl, subject, targetClass, note,
  });
}

export function validateStudentAcquisitionCreateInput(input: unknown): ValidationResult<StudentAcquisitionCreateInput> {
  const errors: Record<string, string> = {};
  if (!isRecord(input)) return invalid("body", "Очікуються дані пропозиції.");
  exactKeys(input, [
    "requestId", "fullName", "className", "title", "author", "publicationYear",
    "requestedQuantity", "sourceUrl", "note", "website", "startedAt",
  ], errors);
  const requestId = readUuid(input.requestId, "requestId", errors);
  const fullName = readText(input.fullName, "fullName", errors, 3, 160);
  const className = readText(input.className, "className", errors, 1, 80);
  const title = readText(input.title, "title", errors, 2, 320);
  const author = readText(input.author, "author", errors, 2, 240);
  const publicationYear = readYear(input.publicationYear, "publicationYear", errors);
  const requestedQuantity = readInteger(input.requestedQuantity, "requestedQuantity", errors, 1, 50);
  const sourceUrl = readHttpUrl(input.sourceUrl, "sourceUrl", errors);
  const note = readOptionalText(input.note, "note", errors, 500);
  const website = readOptionalText(input.website, "website", errors, 200);
  const startedAt = readIsoDateTime(input.startedAt, "startedAt", errors);
  if (website) errors.website = "Автоматичне надсилання відхилено.";
  if (startedAt) {
    const elapsed = Date.now() - new Date(startedAt).getTime();
    if (elapsed < 1_500 || elapsed > 24 * 60 * 60 * 1_000) {
      errors.startedAt = "Оновіть сторінку та заповніть форму ще раз.";
    }
  }
  return finish(errors, {
    requestId, fullName, className, title, author, publicationYear,
    requestedQuantity, sourceUrl, note, website, startedAt,
  });
}

export function validateAcquisitionActionInput(input: unknown): ValidationResult<AcquisitionActionInput> {
  const errors: Record<string, string> = {};
  if (!isRecord(input)) return invalid("body", "Очікуються дані зміни стану.");
  exactKeys(input, [
    "mutationId", "expectedVersion", "action", "approvedQuantity",
    "orderedQuantity", "targetMaterialId", "receiptLineId", "allocatedQuantity", "message",
  ], errors);
  const mutationId = readUuid(input.mutationId, "mutationId", errors);
  const expectedVersion = readInteger(input.expectedVersion, "expectedVersion", errors, 1, 1_000_000);
  const action = readAction(input.action, "action", errors);
  const approvedQuantity = readNullableInteger(input.approvedQuantity, "approvedQuantity", errors, 0, ACQUISITION_MAX_QUANTITY);
  const orderedQuantity = readNullableInteger(input.orderedQuantity, "orderedQuantity", errors, 0, ACQUISITION_MAX_QUANTITY);
  const targetMaterialId = readNullableMaterialId(input.targetMaterialId, "targetMaterialId", errors);
  const receiptLineId = readOptionalText(input.receiptLineId, "receiptLineId", errors, 128);
  const allocatedQuantity = readNullableInteger(input.allocatedQuantity, "allocatedQuantity", errors, 1, ACQUISITION_MAX_QUANTITY);
  const message = readOptionalText(input.message, "message", errors, 1_000);
  if (action === "request_clarification" && !message) errors.message = "Напишіть, що потрібно уточнити.";
  if (action === "reject" && !message) errors.message = "Укажіть причину відхилення.";
  if (action === "approve" && approvedQuantity === null) errors.approvedQuantity = "Укажіть погоджену кількість.";
  if (action === "order" && orderedQuantity === null) errors.orderedQuantity = "Укажіть замовлену кількість.";
  if (action === "link_material" && !targetMaterialId) errors.targetMaterialId = "Укажіть CAT-ID створеного матеріалу.";
  if (action === "link_receipt") {
    if (!receiptLineId) errors.receiptLineId = "Укажіть рядок фактичного надходження.";
    if (allocatedQuantity === null) errors.allocatedQuantity = "Укажіть кількість із надходження.";
  }
  return finish(errors, { mutationId, expectedVersion, action, approvedQuantity, orderedQuantity, targetMaterialId, receiptLineId, allocatedQuantity, message });
}

export function validateAcquisitionCancelInput(input: unknown): ValidationResult<AcquisitionCancelInput> {
  const errors: Record<string, string> = {};
  if (!isRecord(input)) return invalid("body", "Очікується підтвердження скасування.");
  exactKeys(input, ["mutationId", "expectedVersion", "reason"], errors);
  return finish(errors, {
    mutationId: readUuid(input.mutationId, "mutationId", errors),
    expectedVersion: readInteger(input.expectedVersion, "expectedVersion", errors, 1, 1_000_000),
    reason: readOptionalText(input.reason, "reason", errors, 500),
  });
}

export function validateAcquisitionImportInput(input: unknown): ValidationResult<AcquisitionImportInput> {
  const errors: Record<string, string> = {};
  if (!isRecord(input)) return invalid("body", "Очікуються дані імпорту.");
  exactKeys(input, ["mode", "importId", "fileName", "fileHash", "confirmation", "rows"], errors);
  const mode = input.mode === "preview" || input.mode === "commit" ? input.mode : "preview";
  if (input.mode !== "preview" && input.mode !== "commit") errors.mode = "Оберіть перевірку або імпорт.";
  const importId = readUuid(input.importId, "importId", errors);
  const fileName = readText(input.fileName, "fileName", errors, 1, 180);
  const fileHash = typeof input.fileHash === "string" && /^[0-9a-f]{64}$/iu.test(input.fileHash)
    ? input.fileHash.toLowerCase()
    : "";
  if (!fileHash) errors.fileHash = "Некоректний контрольний підпис файла.";
  const confirmation = input.confirmation === "IMPORT_ACQUISITION_REQUESTS" ? input.confirmation : null;
  if (mode === "commit" && !confirmation) errors.confirmation = "Підтвердьте імпорт перевірених рядків.";
  const rows: AcquisitionImportRowInput[] = [];
  if (!Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > ACQUISITION_IMPORT_MAX_ROWS) {
    errors.rows = `Додайте від 1 до ${ACQUISITION_IMPORT_MAX_ROWS} рядків.`;
  } else {
    input.rows.forEach((row, index) => {
      const parsed = validateImportRow(row, index);
      if (!parsed.ok) Object.entries(parsed.fieldErrors).forEach(([key, value]) => { errors[key] = value; });
      else rows.push(parsed.value);
    });
    if (rows.filter((row) => !row.existingRequestNumber).length > ACQUISITION_IMPORT_MAX_NEW_ROWS) {
      errors.rows = `За один раз можна імпортувати не більше ${ACQUISITION_IMPORT_MAX_NEW_ROWS} нових рядків.`;
    }
  }
  return finish(errors, { mode, importId, fileName, fileHash, confirmation, rows });
}

function validateImportRow(input: unknown, index: number): ValidationResult<AcquisitionImportRowInput> {
  const prefix = `rows.${index}.`;
  const errors: Record<string, string> = {};
  if (!isRecord(input)) return invalid(`${prefix}row`, "Некоректний рядок.");
  exactKeys(input, [
    "sourceSheet", "sourceRow", "existingRequestNumber", "requesterKind", "teacherUserId", "teacherName", "studentName",
    "studentClassName", "category", "sourceKind", "literatureKind", "materialId", "title", "author",
    "publicationYear", "requestedQuantity", "sourceUrl", "subject", "targetClass", "note",
  ], errors, prefix);
  const sheets = ["Дозамовлення", "Художня та наукова література", "Пропозиції учнів"] as const;
  const sourceSheet = sheets.includes(input.sourceSheet as typeof sheets[number])
    ? input.sourceSheet as typeof sheets[number]
    : "Дозамовлення";
  if (!sheets.includes(input.sourceSheet as typeof sheets[number])) errors[`${prefix}sourceSheet`] = "Невідомий аркуш.";
  const sourceRow = readInteger(input.sourceRow, `${prefix}sourceRow`, errors, 2, 10_000);
  const existingRequestNumber = readOptionalText(input.existingRequestNumber, `${prefix}existingRequestNumber`, errors, 80);
  const requesterKind = input.requesterKind === "teacher" || input.requesterKind === "student"
    ? input.requesterKind
    : "teacher";
  if (input.requesterKind !== "teacher" && input.requesterKind !== "student") errors[`${prefix}requesterKind`] = "Некоректний заявник.";
  const teacherUserId = readOptionalText(input.teacherUserId, `${prefix}teacherUserId`, errors, 128);
  const teacherName = readOptionalText(input.teacherName, `${prefix}teacherName`, errors, 160);
  const studentName = readOptionalText(input.studentName, `${prefix}studentName`, errors, 160);
  const studentClassName = readOptionalText(input.studentClassName, `${prefix}studentClassName`, errors, 80);
  const category = readCategory(input.category, `${prefix}category`, errors);
  const sourceKind = readSourceKind(input.sourceKind, `${prefix}sourceKind`, errors);
  const literatureKind = readLiteratureKind(input.literatureKind, `${prefix}literatureKind`, errors);
  const materialId = readNullableMaterialId(input.materialId, `${prefix}materialId`, errors);
  const title = readText(input.title, `${prefix}title`, errors, 2, 320);
  const author = readText(input.author, `${prefix}author`, errors, 2, 240);
  const publicationYear = readYear(input.publicationYear, `${prefix}publicationYear`, errors);
  const requestedQuantity = readInteger(input.requestedQuantity, `${prefix}requestedQuantity`, errors, 1, ACQUISITION_MAX_QUANTITY);
  const sourceUrl = readHttpUrl(input.sourceUrl, `${prefix}sourceUrl`, errors);
  const subject = readOptionalText(input.subject, `${prefix}subject`, errors, 120);
  const targetClass = readOptionalText(input.targetClass, `${prefix}targetClass`, errors, 80);
  const note = readOptionalText(input.note, `${prefix}note`, errors, 1_000);
  if (requesterKind === "teacher") {
    if (!teacherUserId && !teacherName) errors[`${prefix}teacherName`] = "Укажіть USR-ID або точне ім’я вчителя.";
    if (teacherUserId && !USER_ID_RE.test(teacherUserId)) errors[`${prefix}teacherUserId`] = "Некоректний USR-ID.";
  } else {
    if (!studentName) errors[`${prefix}studentName`] = "Укажіть прізвище та ім’я учня.";
    if (!studentClassName) errors[`${prefix}studentClassName`] = "Укажіть клас учня.";
  }
  validateCategoryShape({ category, sourceKind, literatureKind, materialId, subject, targetClass }, errors, prefix);
  return finish(errors, {
    sourceSheet, sourceRow, existingRequestNumber, requesterKind, teacherUserId, teacherName, studentName, studentClassName,
    category, sourceKind, literatureKind, materialId, title, author, publicationYear,
    requestedQuantity, sourceUrl, subject, targetClass, note,
  });
}

function validateCategoryShape(
  input: Pick<AcquisitionCreateInput, "category" | "sourceKind" | "literatureKind" | "materialId" | "subject" | "targetClass">,
  errors: Record<string, string>,
  prefix = "",
): void {
  if (input.sourceKind === "catalog" && !input.materialId) errors[`${prefix}materialId`] = "Оберіть матеріал із каталогу.";
  if (input.sourceKind === "manual" && input.materialId) errors[`${prefix}materialId`] = "Для нового матеріалу CAT-ID не передається.";
  if (input.category === "educational") {
    if (input.literatureKind !== "none") errors[`${prefix}literatureKind`] = "Для навчального матеріалу вид літератури не потрібен.";
    if (!input.subject) errors[`${prefix}subject`] = "Укажіть предмет.";
    if (!input.targetClass) errors[`${prefix}targetClass`] = "Укажіть клас.";
  } else if (input.literatureKind === "none") {
    errors[`${prefix}literatureKind`] = "Оберіть вид літератури.";
  }
}

export function normalizedAcquisitionText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("uk-UA")
    .replace(/[’'`ʼ]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function acquisitionDuplicateKey(input: {
  materialId: string | null;
  title: string;
  author: string;
  publicationYear: number;
}): string {
  return input.materialId
    ? `catalog:${input.materialId.toUpperCase()}`
    : `text:${normalizedAcquisitionText(input.title)}|${normalizedAcquisitionText(input.author)}|${input.publicationYear}`;
}

function readCategory(value: unknown, field: string, errors: Record<string, string>): AcquisitionCategory {
  if (value === "educational" || value === "literature") return value;
  errors[field] = "Оберіть тип заявки.";
  return "educational";
}

function readSourceKind(value: unknown, field: string, errors: Record<string, string>): AcquisitionSourceKind {
  if (value === "catalog" || value === "manual") return value;
  errors[field] = "Оберіть, чи є матеріал у каталозі.";
  return "manual";
}

function readLiteratureKind(value: unknown, field: string, errors: Record<string, string>): AcquisitionLiteratureKind {
  if (value === "none" || value === "fiction" || value === "science" || value === "popular_science" || value === "other") return value;
  errors[field] = "Оберіть вид літератури.";
  return "none";
}

function readAction(value: unknown, field: string, errors: Record<string, string>): AcquisitionAction {
  const values: AcquisitionAction[] = ["start_review", "request_clarification", "approve", "plan", "order", "link_material", "link_receipt", "reject", "cancel"];
  if (values.includes(value as AcquisitionAction)) return value as AcquisitionAction;
  errors[field] = "Оберіть підтримувану дію.";
  return "start_review";
}

function readUuid(value: unknown, field: string, errors: Record<string, string>): string {
  const result = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!UUID_RE.test(result)) errors[field] = "Некоректний ідентифікатор запиту.";
  return result;
}

function readNullableMaterialId(value: unknown, field: string, errors: Record<string, string>): string | null {
  if (value === null || value === undefined || value === "") return null;
  const result = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!MATERIAL_ID_RE.test(result)) errors[field] = "Некоректний CAT-ID.";
  return result || null;
}

function readText(value: unknown, field: string, errors: Record<string, string>, min: number, max: number): string {
  const result = clean(value);
  if (result.length < min || result.length > max) errors[field] = `Введіть від ${min} до ${max} символів.`;
  return result;
}

function readOptionalText(value: unknown, field: string, errors: Record<string, string>, max: number): string {
  const result = clean(value);
  if (result.length > max) errors[field] = `Не більше ${max} символів.`;
  return result;
}

function readYear(value: unknown, field: string, errors: Record<string, string>): number {
  return readInteger(value, field, errors, 1000, Math.min(2100, new Date().getUTCFullYear() + 5));
}

function readInteger(value: unknown, field: string, errors: Record<string, string>, min: number, max: number): number {
  const result = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isSafeInteger(result) || result < min || result > max) errors[field] = `Укажіть ціле число від ${min} до ${max}.`;
  return Number.isSafeInteger(result) ? result : min;
}

function readNullableInteger(value: unknown, field: string, errors: Record<string, string>, min: number, max: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  return readInteger(value, field, errors, min, max);
}

function readHttpUrl(value: unknown, field: string, errors: Record<string, string>): string {
  const result = clean(value);
  if (result.length > 1_000) {
    errors[field] = "Покликання задовге.";
    return result;
  }
  try {
    const parsed = new URL(result);
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || !parsed.hostname) throw new Error("invalid");
  } catch {
    errors[field] = "Укажіть повне покликання, що починається з https:// або http://.";
  }
  return result;
}

function readIsoDateTime(value: unknown, field: string, errors: Record<string, string>): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || Number.isNaN(new Date(result).getTime())) errors[field] = "Некоректний час відкриття форми.";
  return result;
}

function exactKeys(input: Record<string, unknown>, allowed: string[], errors: Record<string, string>, prefix = ""): void {
  const expected = new Set(allowed);
  for (const key of Object.keys(input)) if (!expected.has(key)) errors[`${prefix}${key}`] = "Непідтримуване поле.";
}

function clean(value: unknown): string {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalid<T>(field: string, message: string): ValidationResult<T> {
  return { ok: false, fieldErrors: { [field]: message } };
}

function finish<T>(errors: Record<string, string>, value: T): ValidationResult<T> {
  return Object.keys(errors).length ? { ok: false, fieldErrors: errors } : { ok: true, value };
}
