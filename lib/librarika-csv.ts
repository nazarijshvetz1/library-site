/** Strict RFC 4180 reader for the unmodified Librarika exports. All values stay text. */
export function parseLibrarikaCsv(input: string): Record<string, string>[] {
  const text = input.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, closed = false;
  const finishField = () => { row.push(field); field = ""; closed = false; };
  const finishRow = () => { finishField(); if (row.some((value) => value !== "")) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === ",") finishField();
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; finishRow(); }
    else if (c === '"' && !field && !closed) quoted = true;
    else if (closed || c === '"') throw new Error(`Некоректні лапки CSV біля символу ${i}.`);
    else field += c;
  }
  if (quoted) throw new Error("Незакриті лапки CSV.");
  if (field || row.length || closed) finishRow();
  if (!rows.length) throw new Error("Порожній CSV.");
  const headers = rows.shift()!;
  if (headers.some((key) => !key || key === "__proto__" || key === "constructor" || key === "prototype") || new Set(headers).size !== headers.length) throw new Error("Некоректні або повторні заголовки CSV.");
  return rows.map((values, index) => {
    if (values.length !== headers.length) throw new Error(`Рядок CSV ${index + 2}: очікувалося ${headers.length} полів, отримано ${values.length}.`);
    return Object.fromEntries(headers.map((key, i) => [key, values[i]]));
  });
}

export const LIBRARIKA_EXPORTS = {
  titles: { filename: "catalog-titles-1.csv", required: ["Id", "Title", "Authors", "ISBN13", "Category"] },
  copies: { filename: "catalog-copies-1.csv", required: ["Id", "Accession No", "Copy No", "Title"] },
  members: { filename: "members-1.csv", required: ["Id", "Member No", "Name", "Member Group", "Status"] },
  circulations: { filename: "circulations-1.csv", required: ["ID", "Member No", "Media ID", "ASN No", "Status", "Booking Date", "Return Date"] },
  categories: { filename: "categories-1.csv", required: ["Name", "Slug"] },
  authors: { filename: "authors-1.csv", required: ["Name", "Nickname", "Country"] },
  publishers: { filename: "publishers-1.csv", required: ["Name", "Website"] },
  tags: { filename: "tags-1.csv", required: ["Name", "Slug"] },
} as const;

export type LibrarikaExportKind = keyof typeof LIBRARIKA_EXPORTS;
export type LibrarikaDataset = Record<LibrarikaExportKind, Record<string, string>[]>;

export function validateLibrarikaDataset(data: LibrarikaDataset) {
  const issues: { code: string; kind: string; sourceId: string; detail: string }[] = [];
  const add = (code: string, kind: string, sourceId: string, detail: string) => issues.push({ code, kind, sourceId, detail });
  const unique = (kind: LibrarikaExportKind, field: string) => {
    const index = new Map<string, Record<string, string>>();
    for (const row of data[kind]) {
      const key = row[field];
      if (!key?.trim()) add("missing_key", kind, row.Id || row.ID || "", field);
      else if (index.has(key)) add("duplicate_key", kind, key, field);
      else index.set(key, row);
    }
    return index;
  };
  for (const kind of Object.keys(LIBRARIKA_EXPORTS) as LibrarikaExportKind[]) {
    if (!Array.isArray(data[kind])) throw new Error(`Відсутній набір ${kind}.`);
    for (const field of LIBRARIKA_EXPORTS[kind].required) {
      if (data[kind].length && !Object.hasOwn(data[kind][0], field)) throw new Error(`У ${kind} відсутнє поле ${field}.`);
    }
  }
  const titles = unique("titles", "Id");
  unique("copies", "Id");
  const copies = unique("copies", "Accession No");
  unique("members", "Id");
  const members = unique("members", "Member No");
  unique("circulations", "ID");
  unique("categories", "Slug"); unique("tags", "Slug");
  const activeByCopy = new Set<string>();
  const statuses: Record<string, number> = {};
  const knownStatuses = new Set(["Pending", "Reserved", "Issued", "Overdue", "Returned", "Cancelled"]);
  for (const loan of data.circulations) {
    statuses[loan.Status] = (statuses[loan.Status] || 0) + 1;
    const title = titles.get(loan["Media ID"]);
    const copy = copies.get(loan["ASN No"]);
    if (!members.has(loan["Member No"])) add("unknown_member", "circulations", loan.ID, loan["Member No"]);
    if (!title) add("unknown_title", "circulations", loan.ID, loan["Media ID"]);
    if (!copy) add("unknown_copy", "circulations", loan.ID, loan["ASN No"]);
    if (!knownStatuses.has(loan.Status)) add("unknown_status", "circulations", loan.ID, loan.Status);
    if (copy && title && copy.Title.trim() !== title.Title.trim()) add("copy_title_mismatch", "circulations", loan.ID, loan["ASN No"]);
    if (["Issued", "Overdue"].includes(loan.Status)) {
      if (activeByCopy.has(loan["ASN No"])) add("multiple_open_loans", "circulations", loan.ID, loan["ASN No"]);
      activeByCopy.add(loan["ASN No"]);
      if (!loan["Booking Date"] || !loan["Return Date"]) add("missing_loan_date", "circulations", loan.ID, "Booking Date / Return Date");
    }
  }
  return {
    counts: Object.fromEntries(Object.entries(data).map(([kind, rows]) => [kind, rows.length])),
    circulationStatuses: statuses,
    openLoans: activeByCopy.size,
    issues,
    // CSV does not supply these. They need separate source verification, not fabricated defaults.
    missingExportCapabilities: ["cover_files", "member_photo_files", "author_biographies", "book_page_count", "book_language", "ratings", "reviews", "copy_to_title_source_id"],
    safeForProductionImport: false,
  };
}
