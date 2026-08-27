"use client";

export default function StatementActions({ excelHref }: { excelHref: string }) {
  return (
    <div className="statement-actions" aria-label="Дії з відомістю">
      <button type="button" onClick={() => window.print()}>Друкувати / зберегти PDF</button>
      <a href={excelHref}>Завантажити Excel</a>
      <a href="/librarian/reports">До звітів</a>
    </div>
  );
}
