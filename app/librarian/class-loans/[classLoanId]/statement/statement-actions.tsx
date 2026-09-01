"use client";

import { useRef, useState } from "react";

import StatementManager from "./statement-manager";

type StatementActionsProps = {
  classLoanId: string;
  excelHref: string;
  initialStatus: "open" | "closed" | "cancelled";
  writesEnabled: boolean;
};

export default function StatementActions({
  classLoanId,
  excelHref,
  initialStatus,
  writesEnabled,
}: StatementActionsProps) {
  const [managerOpen, setManagerOpen] = useState(false);
  const managerButtonRef = useRef<HTMLButtonElement>(null);

  function closeManager() {
    setManagerOpen(false);
    window.queueMicrotask(() => managerButtonRef.current?.focus());
  }

  return (
    <>
      <div className="statement-actions" aria-label="Дії з відомістю">
        <button ref={managerButtonRef} type="button" onClick={() => setManagerOpen(true)}>
          {initialStatus === "open" && writesEnabled ? "Керувати відомістю" : "Переглянути склад та історію"}
        </button>
        <button className="statement-print-button" type="button" onClick={() => window.print()}>
          Друкувати / зберегти PDF
        </button>
        <a href={excelHref}>Завантажити Excel</a>
        <a href="/librarian/reports">До звітів</a>
      </div>
      {managerOpen ? (
        <StatementManager
          classLoanId={classLoanId}
          writesEnabled={writesEnabled}
          onClose={closeManager}
        />
      ) : null}
    </>
  );
}
