import type { ManualTextbookFields } from "@/lib/textbook-catalog-store";

export function validateManualTextbookFields(input: Record<string, unknown>): {
  fields: ManualTextbookFields;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};
  const grade = typeof input.grade === "number" ? input.grade : Number.NaN;
  const title = cleanText(input.title, 500);
  const author = cleanText(input.author, 500);
  const subject = cleanText(input.subject, 240);
  const publisher = cleanText(input.publisher, 240);
  const publicationYear = input.publicationYear === null || input.publicationYear === "" || input.publicationYear === undefined
    ? null
    : typeof input.publicationYear === "number" ? input.publicationYear : Number.NaN;
  const isbn = String(input.isbn ?? "").normalize("NFKC").replace(/[\s-]+/gu, "").toUpperCase();
  const resourceUrl = httpsUrl(input.resourceUrl);
  const rawCover = String(input.coverUrl ?? "").trim();
  const coverUrl = rawCover ? httpsUrl(rawCover) : "";
  const sortOrder = input.sortOrder === undefined || input.sortOrder === ""
    ? undefined
    : typeof input.sortOrder === "number" ? input.sortOrder : Number.NaN;

  if (!Number.isInteger(grade) || grade < 1 || grade > 11) errors.grade = "Оберіть клас від 1 до 11.";
  if (!title) errors.title = "Укажіть назву підручника.";
  if (!subject) errors.subject = "Укажіть предмет.";
  if (String(input.title ?? "").normalize("NFC").trim().length > 500) errors.title = "Не більше 500 символів.";
  if (String(input.author ?? "").normalize("NFC").trim().length > 500) errors.author = "Не більше 500 символів.";
  if (String(input.subject ?? "").normalize("NFC").trim().length > 240) errors.subject = "Не більше 240 символів.";
  if (String(input.publisher ?? "").normalize("NFC").trim().length > 240) errors.publisher = "Не більше 240 символів.";
  if (publicationYear !== null && (!Number.isInteger(publicationYear) || publicationYear < 1000 || publicationYear > 3000)) {
    errors.publicationYear = "Рік має бути від 1000 до 3000.";
  }
  if (isbn && !validIsbn(isbn)) errors.isbn = "Укажіть коректний ISBN-10 або ISBN-13.";
  if (!resourceUrl) errors.resourceUrl = "Укажіть коректне HTTPS-покликання на електронний підручник.";
  if (rawCover && !coverUrl) errors.coverUrl = "Покликання на обкладинку має починатися з HTTPS.";
  if (sortOrder !== undefined && (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 999999)) {
    errors.sortOrder = "Порядок має бути від 0 до 999999.";
  }

  return {
    fields: {
      grade: Number.isInteger(grade) ? grade : 1,
      title,
      author,
      subject,
      publisher,
      publicationYear: Number.isInteger(publicationYear) ? publicationYear : null,
      isbn,
      resourceUrl,
      coverUrl,
      ...(sortOrder === undefined ? {} : { sortOrder }),
    },
    errors,
  };
}

function cleanText(value: unknown, max: number): string {
  const text = String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function httpsUrl(value: unknown): string {
  try {
    const candidate = String(value ?? "").trim();
    if (candidate.length > 2_000) return "";
    const url = new URL(candidate);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : "";
  } catch {
    return "";
  }
}

function validIsbn(value: string): boolean {
  if (/^\d{13}$/u.test(value)) {
    const sum = [...value.slice(0, 12)].reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
    return (10 - (sum % 10)) % 10 === Number(value[12]);
  }
  if (!/^\d{9}[\dX]$/u.test(value)) return false;
  const sum = [...value].reduce((total, digit, index) => total + (digit === "X" ? 10 : Number(digit)) * (10 - index), 0);
  return sum % 11 === 0;
}
