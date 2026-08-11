"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import styles from "./staging-import.module.css";

type Phase = "idle" | "uploaded" | "preflighted" | "committed" | "verified" | "cleaned";

type ApiResult = {
  success?: boolean;
  code?: string;
  error?: string;
  status?: Phase;
  planSha256?: string;
  report?: unknown;
  [key: string]: unknown;
};

export default function ImportConsole({ displayName }: { displayName: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [planSha256, setPlanSha256] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [expiresAt, setExpiresAt] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageIsError, setMessageIsError] = useState(false);
  const [result, setResult] = useState<ApiResult | null>(null);

  useEffect(() => {
    if (!expiresAt) return;
    const expiryMs = Date.parse(expiresAt);
    const currentMs = Date.now();
    const timer = window.setTimeout(
      () => setNowMs(Date.now()),
      Number.isFinite(expiryMs)
        ? Math.max(0, Math.min(expiryMs - currentMs + 100, 2_147_483_647))
        : 0,
    );
    return () => window.clearTimeout(timer);
  }, [expiresAt]);

  async function upload() {
    if (!file || busy) return;
    setBusy(true);
    setMessage("");
    setMessageIsError(false);
    let sha256 = "";
    try {
      if (file.size <= 0 || file.size > 6 * 1024 * 1024) {
        throw new Error("JSON-план має бути непорожнім і не перевищувати 6 МіБ.");
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      sha256 = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      setPlanSha256(sha256);
      const response = await fetch("/api/internal/library-import/upload", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Library-Plan-SHA256": sha256,
        },
        body: bytes,
        credentials: "same-origin",
      });
      const body = await readResponse(response);
      const restored = responsePhase(body.status, "uploaded");
      setPhase(restored);
      if (typeof body.expiresAt === "string") setExpiresAt(body.expiresAt);
      setResult(body);
      setMessage(body.resumed
        ? `Наявну сесію відновлено: ${phaseLabel(restored)}.`
        : "План перевірено за SHA-256 і збережено у приватному R2.");
    } catch (error) {
      if (error instanceof ImportApiError
        && sha256
        && shouldRestoreExpiredRun(error)
        && await resumeStatus(sha256, error.message)) return;
      if (!(error instanceof ImportApiError) && sha256 && await resumeStatus(sha256)) return;
      setMessageIsError(true);
      if (error instanceof ImportApiError) setResult(error.body);
      setMessage(error instanceof Error ? error.message : "Завантаження не виконано.");
    } finally {
      setBusy(false);
    }
  }

  async function runPhase(next: Exclude<Phase, "idle" | "uploaded">) {
    if (!planSha256 || busy) return;
    setBusy(true);
    setMessage("");
    setMessageIsError(false);
    try {
      const response = await fetch(`/api/internal/library-import/${phaseEndpoint(next)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planSha256 }),
        credentials: "same-origin",
      });
      const body = await readResponse(response);
      setPhase(responsePhase(body.status, next));
      setResult(body);
      setMessage(phaseMessage(next));
    } catch (error) {
      if (error instanceof ImportApiError
        && shouldRestoreExpiredRun(error)
        && await resumeStatus(planSha256, error.message)) return;
      if (!(error instanceof ImportApiError) && await resumeStatus(planSha256)) return;
      setMessageIsError(true);
      if (error instanceof ImportApiError) setResult(error.body);
      setMessage(error instanceof Error ? error.message : "Операцію не виконано.");
    } finally {
      setBusy(false);
    }
  }

  async function resumeStatus(sha256 = planSha256, warning = ""): Promise<boolean> {
    if (!sha256) return false;
    try {
      const response = await fetch("/api/internal/library-import/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planSha256: sha256 }),
        credentials: "same-origin",
      });
      const body = await readResponse(response);
      const restored = responsePhase(body.status, "uploaded");
      setPlanSha256(sha256);
      setPhase(restored);
      if (typeof body.expiresAt === "string") setExpiresAt(body.expiresAt);
      setResult(body);
      setMessageIsError(Boolean(warning));
      setMessage(warning
        ? `${warning} Стан відновлено із сервера: ${phaseLabel(restored)}. Виконайте доступну дію завершення або abort.`
        : `Стан відновлено із сервера: ${phaseLabel(restored)}.`);
      return true;
    } catch {
      return false;
    }
  }

  const expired = isExpired(expiresAt, nowMs);

  return (
    <main className={styles.shell}>
      <section className={styles.card} aria-labelledby="import-title">
        <div className={styles.heading}>
          <div>
            <p>Внутрішній інструмент · лише staging</p>
            <h1 id="import-title">Одноразовий імпорт до D1</h1>
          </div>
          <Link href="/librarian">← Кабінет</Link>
        </div>

        <div className={styles.warning}>
          <strong>Production недоступний цьому маршруту.</strong>
          <span>
            Файл приймається лише за наперед дозволеним SHA-256, а commit стає доступним
            тільки після чистого preflight.
          </span>
        </div>

        <dl className={styles.identity}>
          <div><dt>Користувач</dt><dd>{displayName}</dd></div>
          <div><dt>Стан</dt><dd>{phaseLabel(phase)}</dd></div>
          <div><dt>SHA-256</dt><dd>{planSha256 || "ще не обчислено"}</dd></div>
        </dl>

        <div className={styles.uploadBox}>
          <label>
            <span>Перевірений JSON load plan (до 6 МіБ)</span>
            <input
              type="file"
              accept="application/json,.json"
              disabled={busy || phase !== "idle"}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <button type="button" disabled={!file || busy || phase !== "idle"} onClick={() => void upload()}>
            1. Завантажити
          </button>
        </div>

        <div className={styles.steps}>
          <button type="button" disabled={busy || phase !== "uploaded"} onClick={() => void runPhase("preflighted")}>
            2. Preflight
            <small>Лише читає D1 і перевіряє, що ціль порожня.</small>
          </button>
          <button className={styles.commit} type="button" disabled={busy || phase !== "preflighted"} onClick={() => void runPhase("committed")}>
            3. Atomic commit
            <small>Вносить усі рядки одним D1 batch.</small>
          </button>
          <button type="button" disabled={busy || phase !== "committed"} onClick={() => void runPhase("verified")}>
            4. Verify
            <small>Повторно звіряє рядки та FTS.</small>
          </button>
          <button
            type="button"
            disabled={busy || !(phase === "verified"
              || phase === "cleaned"
              || (expired && (phase === "uploaded" || phase === "preflighted")))}
            onClick={() => void runPhase("cleaned")}
          >
            5. Cleanup / abort
            <small>
              {phase === "cleaned"
                ? "Повторно перевіряє R2 та завершує видалення після перерваної відповіді."
                : expired && (phase === "uploaded" || phase === "preflighted")
                  ? "Строк минув: безпечно скасовує незавершену сесію та видаляє JSON."
                  : "Після verify видаляє приватний JSON з R2."}
            </small>
          </button>
        </div>

        {message ? <p className={messageIsError ? styles.message : styles.success}>{message}</p> : null}
        {result ? <pre className={styles.report}>{JSON.stringify(result, null, 2)}</pre> : null}
      </section>
    </main>
  );
}

async function readResponse(response: Response): Promise<ApiResult> {
  const body = await response.json() as ApiResult;
  if (!response.ok || body.success !== true) {
    throw new ImportApiError(body.error || `HTTP ${response.status}`, response.status, body);
  }
  return body;
}

class ImportApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly body: ApiResult,
  ) {
    super(message);
    this.name = "ImportApiError";
  }
}

function phaseEndpoint(phase: Phase): string {
  return phase === "preflighted" ? "preflight"
    : phase === "committed" ? "commit"
      : phase === "verified" ? "verify"
        : "cleanup";
}

function phaseMessage(phase: Phase): string {
  return phase === "preflighted" ? "Preflight пройдено: цільова D1 чиста й готова."
    : phase === "committed" ? "Атомарний commit завершено. Тепер обов’язково виконайте verify."
      : phase === "verified" ? "Reconciliation і пошуковий індекс підтверджено."
        : "Приватний файл плану очищено; журнал імпорту залишився у D1.";
}

function phaseLabel(phase: Phase): string {
  return {
    idle: "очікує файл",
    uploaded: "файл у приватному R2",
    preflighted: "preflight пройдено",
    committed: "commit виконано",
    verified: "дані звірено",
    cleaned: "завершено й очищено",
  }[phase];
}

function responsePhase(value: unknown, fallback: Phase): Phase {
  return value === "uploaded"
    || value === "preflighted"
    || value === "committed"
    || value === "verified"
    || value === "cleaned"
    ? value
    : fallback;
}

function shouldRestoreExpiredRun(error: ImportApiError): boolean {
  return error.body.code === "staging_import_gate_invalid"
    || error.body.code === "staging_import_gate_expired"
    || error.body.code === "import_run_expired";
}

function isExpired(value: string, nowMs: number): boolean {
  return Boolean(value) && Number.isFinite(Date.parse(value)) && Date.parse(value) <= nowMs;
}
