type TeacherCodeCsvRow = {
  fullName: string;
  code: string;
};

const FORMULA_AFTER_LEADING_WHITESPACE_OR_CONTROL = /^[\p{White_Space}\p{Cc}]*[=+\-@]/u;

export function teacherCodeCsvCell(value: string): string {
  const spreadsheetSafe = FORMULA_AFTER_LEADING_WHITESPACE_OR_CONTROL.test(value)
    ? `'${value}`
    : value;
  return `"${spreadsheetSafe.replace(/"/gu, '""')}"`;
}

export function teacherCodesCsv(rows: readonly TeacherCodeCsvRow[]): string {
  return [
    "ПІБ,Код",
    ...rows.map((row) => `${teacherCodeCsvCell(row.fullName)},${teacherCodeCsvCell(row.code)}`),
  ].join("\r\n");
}
