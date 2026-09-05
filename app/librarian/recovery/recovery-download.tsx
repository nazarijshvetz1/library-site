"use client";

import { useState } from "react";

export default function RecoveryDownload() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  async function download() {
    setBusy(true); setStatus("Формується повний знімок бази…");
    try {
      const response = await fetch("/api/librarian/recovery-export", { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.error || "Не вдалося сформувати повний знімок.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = "library-d1-recovery.json";
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setStatus(`Знімок сформовано: ${response.headers.get("X-Recovery-Tables")} таблиць, ${response.headers.get("X-Recovery-Rows")} записів. Перевірте завантажений файл.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Резервний експорт недоступний."); }
    finally { setBusy(false); }
  }
  return <><button type="button" onClick={download} disabled={busy}>{busy ? "Формування…" : "Завантажити повну резервну копію D1"}</button><p role="status">{status}</p></>;
}
