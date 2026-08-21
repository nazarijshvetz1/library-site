export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; fieldErrors: Record<string, string> };

export type AcademicYearCreateInput = {
  requestId: string;
  label: string;
  startDate: string;
  endDate: string;
  notes: string;
};

export type ClassYearCreateInput = {
  requestId: string;
  academicYearId: string;
  cohortMode: "existing" | "new";
  cohortId: string | null;
  grade: number;
  code: string;
  teacherUserId: string | null;
  locationId: string | null;
  notes: string;
};

export type ClassYearUpdateInput = {
  requestId: string;
  expectedVersion: number;
  reason: string;
  changes: {
    grade?: number;
    code?: string;
    teacherUserId?: string | null;
    locationId?: string | null;
    notes?: string;
  };
};

export type ClassYearCloseInput = {
  requestId: string;
  expectedVersion: number;
  actualClosedDate: string;
  reason: "closed" | "merged" | "graduated" | "reorganized" | "other";
  closeCohort: boolean;
  notes: string;
};

export type AcademicRolloverClassInput = {
  sourceClassYearId: string;
  expectedVersion: number;
  cohortId: string;
  sourceGrade: number;
  action: "promote" | "graduate" | "close";
  targetGrade?: number;
  targetCode?: string;
  teacherUserId?: string | null;
  locationId?: string | null;
  overrideReason?: string;
  notes?: string;
};

export type AcademicYearRolloverInput = {
  requestId: string;
  sourceYearId: string;
  sourceYearVersion: number;
  targetYearId: string;
  targetYearVersion: number;
  effectiveDate: string;
  classes: AcademicRolloverClassInput[];
  notes: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACADEMIC_YEAR_ID_RE = /^YR-(20\d{2})-(20\d{2})$/u;
const ACADEMIC_YEAR_LABEL_RE = /^(20\d{2})\/(20\d{2})$/u;
const CLASS_YEAR_ID_RE = /^CY-20\d{2}-\d{3,}$/u;
const COHORT_ID_RE = /^COH-\d{3,}$/u;
const USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const LOCATION_ID_RE = /^LOC-\d{3,}$/u;
const CLASS_CODE_RE = /^[\p{L}\p{N}().'_-]{1,16}$/u;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

export function validateAcademicYearCreateInput(
  input: unknown,
): ValidationResult<AcademicYearCreateInput> {
  const errors: Record<string, string> = {};
  if (!isRecord(input)) return invalid("body", "Очікується об’єкт із даними навчального року.");
  exactKeys(input, ["requestId", "label", "startDate", "endDate", "notes"], errors);
  const requestId = readRequestId(input.requestId, errors);
  const label = readRequiredText(input.label, "label", 9, errors);
  const startDate = readIsoDate(input.startDate, "startDate", errors);
  const endDate = readIsoDate(input.endDate, "endDate", errors);
  const notes = readOptionalText(input.notes ?? null, "notes", 2_000, errors) ?? "";
  const labelMatch = label.match(ACADEMIC_YEAR_LABEL_RE);
  if (!labelMatch || Number(labelMatch[2]) !== Number(labelMatch[1]) + 1) {
    errors.label = "Навчальний рік має формат 2026/2027 і містить послідовні роки.";
  }
  if (startDate && endDate && startDate >= endDate) {
    errors.endDate = "Дата завершення має бути пізнішою за дату початку.";
  }
  if (labelMatch && startDate && !startDate.startsWith(labelMatch[1])) {
    errors.startDate = "Дата початку має належати першому року в назві.";
  }
  if (labelMatch && endDate && !endDate.startsWith(labelMatch[2])) {
    errors.endDate = "Дата завершення має належати другому року в назві.";
  }
  return finish(errors, { requestId, label, startDate, endDate, notes });
}

export function validateClassYearCreateInput(
  input: unknown,
): ValidationResult<ClassYearCreateInput> {
  const errors: Record<string, string> = {};
  if (!isRecord(input)) return invalid("body", "Очікуються дані нового класу.");
  exactKeys(input, [
    "requestId", "academicYearId", "cohortMode", "cohortId", "grade", "code",
    "teacherUserId", "locationId", "notes",
  ], errors);
  const requestId = readRequestId(input.requestId, errors);
  const academicYearId = readAcademicYearId(input.academicYearId, "academicYearId", errors);
  const cohortMode = readEnum(input.cohortMode, ["existing", "new"] as const, "cohortMode", errors);
  const cohortId = input.cohortId === null || input.cohortId === undefined || input.cohortId === ""
    ? null
    : readPatternText(input.cohortId, COHORT_ID_RE, "cohortId", "Некоректний ID класної групи.", errors).toUpperCase();
  if (cohortMode === "existing" && !cohortId) errors.cohortId = "Оберіть наявну класну групу.";
  if (cohortMode === "new" && cohortId) errors.cohortId = "ID нової групи призначає система.";
  const grade = readInteger(input.grade, "grade", 1, 11, errors);
  const code = readClassCode(input.code, "code", errors);
  const teacherUserId = readNullableUserId(
    input.teacherUserId ?? null,
    "teacherUserId",
    "Некоректний ID класного керівника.",
    errors,
  );
  const locationId = readNullablePattern(
    input.locationId ?? null,
    LOCATION_ID_RE,
    "locationId",
    "Некоректний ID кабінету.",
    errors,
  );
  const notes = readOptionalText(input.notes ?? null, "notes", 2_000, errors) ?? "";
  return finish(errors, {
    requestId,
    academicYearId,
    cohortMode,
    cohortId,
    grade,
    code,
    teacherUserId,
    locationId,
    notes,
  });
}

export function validateClassYearUpdateInput(
  input: unknown,
): ValidationResult<ClassYearUpdateInput> {
  const errors: Record<string, string> = {};
  if (!isRecord(input)) return invalid("body", "Очікуються зміни класу.");
  exactKeys(input, ["requestId", "expectedVersion", "changes", "reason"], errors);
  const requestId = readRequestId(input.requestId, errors);
  const expectedVersion = readInteger(input.expectedVersion, "expectedVersion", 1, 2_147_483_647, errors);
  const reason = readOptionalText(input.reason ?? null, "reason", 1_000, errors) ?? "";
  const changes: ClassYearUpdateInput["changes"] = {};
  if (!isRecord(input.changes)) {
    errors.changes = "Укажіть зміни класу.";
  } else {
    exactKeys(input.changes, ["grade", "code", "teacherUserId", "locationId", "notes"], errors, "changes.");
    if (Object.keys(input.changes).length === 0) errors.changes = "Укажіть хоча б одну зміну.";
    if ("grade" in input.changes) {
      changes.grade = readInteger(input.changes.grade, "changes.grade", 1, 11, errors);
    }
    if ("code" in input.changes) changes.code = readClassCode(input.changes.code, "changes.code", errors);
    if ("teacherUserId" in input.changes) {
      changes.teacherUserId = readNullableUserId(
        input.changes.teacherUserId,
        "changes.teacherUserId",
        "Некоректний ID класного керівника.",
        errors,
      );
    }
    if ("locationId" in input.changes) {
      changes.locationId = readNullablePattern(
        input.changes.locationId,
        LOCATION_ID_RE,
        "changes.locationId",
        "Некоректний ID кабінету.",
        errors,
      );
    }
    if ("notes" in input.changes) {
      changes.notes = readOptionalText(input.changes.notes, "changes.notes", 2_000, errors) ?? "";
    }
  }
  return finish(errors, { requestId, expectedVersion, reason, changes });
}

export function validateClassYearCloseInput(
  input: unknown,
): ValidationResult<ClassYearCloseInput> {
  const errors: Record<string, string> = {};
  if (!isRecord(input)) return invalid("body", "Очікуються дані закриття класу.");
  exactKeys(input, [
    "requestId", "expectedVersion", "actualClosedDate", "reason", "closeCohort", "notes",
  ], errors);
  const requestId = readRequestId(input.requestId, errors);
  const expectedVersion = readInteger(input.expectedVersion, "expectedVersion", 1, 2_147_483_647, errors);
  const actualClosedDate = readIsoDate(input.actualClosedDate, "actualClosedDate", errors);
  const reason = readEnum(
    input.reason,
    ["closed", "merged", "graduated", "reorganized", "other"] as const,
    "reason",
    errors,
  );
  const closeCohort = readBoolean(input.closeCohort, "closeCohort", errors);
  const notes = readOptionalText(input.notes ?? null, "notes", 2_000, errors) ?? "";
  if (reason === "other" && !notes) errors.notes = "Для іншої причини додайте пояснення.";
  return finish(errors, {
    requestId,
    expectedVersion,
    actualClosedDate,
    reason,
    closeCohort,
    notes,
  });
}

export function validateAcademicYearRolloverInput(
  input: unknown,
): ValidationResult<AcademicYearRolloverInput> {
  const errors: Record<string, string> = {};
  if (!isRecord(input)) return invalid("body", "Очікується план переходу на новий навчальний рік.");
  exactKeys(input, [
    "requestId", "sourceYearId", "sourceYearVersion", "targetYearId", "targetYearVersion",
    "effectiveDate", "classes", "notes",
  ], errors);
  const requestId = readRequestId(input.requestId, errors);
  const sourceYearId = readAcademicYearId(input.sourceYearId, "sourceYearId", errors);
  const sourceYearVersion = readInteger(input.sourceYearVersion, "sourceYearVersion", 1, 2_147_483_647, errors);
  const targetYearId = readAcademicYearId(input.targetYearId, "targetYearId", errors);
  const targetYearVersion = readInteger(input.targetYearVersion, "targetYearVersion", 1, 2_147_483_647, errors);
  const effectiveDate = readIsoDate(input.effectiveDate, "effectiveDate", errors);
  const notes = readOptionalText(input.notes ?? null, "notes", 2_000, errors) ?? "";
  const sourceMatch = sourceYearId.match(ACADEMIC_YEAR_ID_RE);
  const targetMatch = targetYearId.match(ACADEMIC_YEAR_ID_RE);
  if (sourceYearId && targetYearId && sourceYearId === targetYearId) {
    errors.targetYearId = "Цільовий навчальний рік має відрізнятися.";
  } else if (sourceMatch && targetMatch && Number(targetMatch[1]) !== Number(sourceMatch[1]) + 1) {
    errors.targetYearId = "Цільовий навчальний рік має бути наступним.";
  }

  const classes: AcademicRolloverClassInput[] = [];
  if (!Array.isArray(input.classes) || input.classes.length > 100) {
    errors.classes = "Додайте до 100 класів для переходу.";
  } else {
    const classIds = new Set<string>();
    const cohortIds = new Set<string>();
    const targetNames = new Set<string>();
    input.classes.forEach((value, index) => {
      const prefix = `classes.${index}.`;
      if (!isRecord(value)) {
        errors[`classes.${index}`] = "Некоректний рядок класу.";
        return;
      }
      exactKeys(value, [
        "sourceClassYearId", "expectedVersion", "cohortId", "sourceGrade", "action",
        "targetGrade", "targetCode", "teacherUserId", "locationId", "overrideReason", "notes",
      ], errors, prefix);
      const sourceClassYearId = readPatternText(
        value.sourceClassYearId,
        CLASS_YEAR_ID_RE,
        `${prefix}sourceClassYearId`,
        "Некоректний ID класу.",
        errors,
      ).toUpperCase();
      const expectedVersion = readInteger(
        value.expectedVersion,
        `${prefix}expectedVersion`,
        1,
        2_147_483_647,
        errors,
      );
      const cohortId = readPatternText(
        value.cohortId,
        COHORT_ID_RE,
        `${prefix}cohortId`,
        "Некоректний ID класної групи.",
        errors,
      ).toUpperCase();
      const sourceGrade = readInteger(value.sourceGrade, `${prefix}sourceGrade`, 1, 11, errors);
      const action = readEnum(
        value.action,
        ["promote", "graduate", "close"] as const,
        `${prefix}action`,
        errors,
      );
      if (classIds.has(sourceClassYearId)) errors[`${prefix}sourceClassYearId`] = "Клас повторюється.";
      if (cohortIds.has(cohortId)) errors[`${prefix}cohortId`] = "Класна група повторюється.";
      classIds.add(sourceClassYearId);
      cohortIds.add(cohortId);

      const row: AcademicRolloverClassInput = {
        sourceClassYearId,
        expectedVersion,
        cohortId,
        sourceGrade,
        action,
      };
      if (action === "promote") {
        if (sourceGrade === 11) errors[`${prefix}action`] = "11 клас потрібно випустити або закрити.";
        row.targetGrade = readInteger(value.targetGrade, `${prefix}targetGrade`, 1, 11, errors);
        row.targetCode = readClassCode(value.targetCode, `${prefix}targetCode`, errors);
        row.overrideReason = readOptionalText(value.overrideReason ?? null, `${prefix}overrideReason`, 1_000, errors) ?? "";
        if (row.targetGrade !== sourceGrade + 1 && !row.overrideReason) {
          errors[`${prefix}overrideReason`] = "Поясніть нестандартний перехід між паралелями.";
        }
        const targetName = className(row.targetGrade, row.targetCode);
        if (targetNames.has(targetName)) errors[`${prefix}targetCode`] = "Цільова назва класу повторюється.";
        targetNames.add(targetName);
        if ("teacherUserId" in value) {
          row.teacherUserId = readNullableUserId(
            value.teacherUserId,
            `${prefix}teacherUserId`,
            "Некоректний ID класного керівника.",
            errors,
          );
        }
        if ("locationId" in value) {
          row.locationId = readNullablePattern(
            value.locationId,
            LOCATION_ID_RE,
            `${prefix}locationId`,
            "Некоректний ID кабінету.",
            errors,
          );
        }
      } else {
        if ("targetGrade" in value || "targetCode" in value || "teacherUserId" in value || "locationId" in value) {
          errors[`classes.${index}`] = "Цільові поля дозволені лише для переведення класу.";
        }
        if (action === "graduate" && sourceGrade !== 11) {
          errors[`${prefix}action`] = "Випуск дозволений лише для 11 класу.";
        }
      }
      if ("notes" in value) {
        row.notes = readOptionalText(value.notes, `${prefix}notes`, 2_000, errors) ?? "";
      }
      classes.push(row);
    });
  }
  return finish(errors, {
    requestId,
    sourceYearId,
    sourceYearVersion,
    targetYearId,
    targetYearVersion,
    effectiveDate,
    classes,
    notes,
  });
}

export function normalizeAcademicYearId(value: unknown): string | null {
  const id = String(value ?? "").trim().toUpperCase();
  const match = id.match(ACADEMIC_YEAR_ID_RE);
  return match && Number(match[2]) === Number(match[1]) + 1 ? id : null;
}

export function normalizeClassYearId(value: unknown): string | null {
  const id = String(value ?? "").trim().toUpperCase();
  return CLASS_YEAR_ID_RE.test(id) ? id : null;
}

export function className(grade: number, code: string): string {
  return `${grade}-${code.trim().toLocaleUpperCase("uk-UA")}`;
}

function readAcademicYearId(
  value: unknown,
  key: string,
  errors: Record<string, string>,
): string {
  const id = readPatternText(value, ACADEMIC_YEAR_ID_RE, key, "Некоректний ID навчального року.", errors).toUpperCase();
  const match = id.match(ACADEMIC_YEAR_ID_RE);
  if (match && Number(match[2]) !== Number(match[1]) + 1) {
    errors[key] = "Роки в ID мають бути послідовними.";
  }
  return id;
}

function readRequestId(value: unknown, errors: Record<string, string>): string {
  return readPatternText(value, UUID_RE, "requestId", "Некоректний request ID.", errors).toLowerCase();
}

function readClassCode(value: unknown, key: string, errors: Record<string, string>): string {
  const code = readRequiredText(value, key, 16, errors);
  if (code && !CLASS_CODE_RE.test(code)) {
    errors[key] = "Код класу містить недозволені символи.";
  }
  return code.toLocaleUpperCase("uk-UA");
}

function readRequiredText(
  value: unknown,
  key: string,
  maxLength: number,
  errors: Record<string, string>,
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
  maxLength: number,
  errors: Record<string, string>,
): string | null {
  if (value === null || value === undefined || value === "") return null;
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
  if (typeof value !== "string" || !pattern.test(value.trim().toUpperCase())) {
    errors[key] = message;
    return "";
  }
  return value.trim();
}

function readNullablePattern(
  value: unknown,
  pattern: RegExp,
  key: string,
  message: string,
  errors: Record<string, string>,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  return readPatternText(value, pattern, key, message, errors).toUpperCase();
}

function readNullableUserId(
  value: unknown,
  key: string,
  message: string,
  errors: Record<string, string>,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  return readPatternText(value, USER_ID_RE, key, message, errors);
}

function readInteger(
  value: unknown,
  key: string,
  minimum: number,
  maximum: number,
  errors: Record<string, string>,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    errors[key] = `Укажіть ціле число від ${minimum} до ${maximum}.`;
    return minimum;
  }
  return Number(value);
}

function readIsoDate(value: unknown, key: string, errors: Record<string, string>): string {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) {
    errors[key] = "Укажіть дату у форматі РРРР-ММ-ДД.";
    return "";
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    errors[key] = "Укажіть коректну календарну дату.";
    return "";
  }
  return value;
}

function readBoolean(value: unknown, key: string, errors: Record<string, string>): boolean {
  if (typeof value !== "boolean") {
    errors[key] = "Укажіть true або false.";
    return false;
  }
  return value;
}

function readEnum<const T extends readonly string[]>(
  value: unknown,
  options: T,
  key: string,
  errors: Record<string, string>,
): T[number] {
  if (typeof value !== "string" || !(options as readonly string[]).includes(value)) {
    errors[key] = "Оберіть дозволене значення.";
    return options[0];
  }
  return value as T[number];
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  errors: Record<string, string>,
  prefix = "",
): void {
  const names = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!names.has(key)) errors[`${prefix}${key}`] = "Невідоме поле.";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid<T>(key: string, message: string): ValidationResult<T> {
  return { ok: false, fieldErrors: { [key]: message } };
}

function finish<T>(errors: Record<string, string>, value: T): ValidationResult<T> {
  return Object.keys(errors).length > 0
    ? { ok: false, fieldErrors: errors }
    : { ok: true, value };
}
