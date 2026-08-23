"use client";

import { useEffect, useState } from "react";

import LibrarianShell from "../_components/librarian-shell";
import { STAGING_RESET_CONFIRMATION } from "@/lib/staging-reset-contract";
import styles from "./staging-import.module.css";

type Phase = "idle" | "uploaded" | "preflighted" | "committed" | "verified" | "cleaned";
type ImportTarget = "staging" | "production";

type ApiResult = {
  success?: boolean;
  code?: string;
  error?: string;
  status?: Phase;
  planSha256?: string;
  report?: unknown;
  [key: string]: unknown;
};

export default function ImportConsole({
  displayName,
  roleLabel,
  signOutHref,
  target,
}: {
  displayName: string;
  roleLabel: string;
  signOutHref: string;
  target: ImportTarget;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [planSha256, setPlanSha256] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [expiresAt, setExpiresAt] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageIsError, setMessageIsError] = useState(false);
  const [result, setResult] = useState<ApiResult | null>(null);
  const [productionConfirmed, setProductionConfirmed] = useState(false);
  const [resetConfirmation, setResetConfirmation] = useState("");

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
      const planFile = await readPlanFile(file);
      const { bytes } = planFile;
      sha256 = planFile.sha256;
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

  async function resetStagingD1() {
    if (target !== "staging" || phase !== "idle" || !file || busy
      || resetConfirmation !== STAGING_RESET_CONFIRMATION) return;
    setBusy(true);
    setMessage("");
    setMessageIsError(false);
    try {
      const { sha256 } = await readPlanFile(file);
      setPlanSha256(sha256);
      const response = await fetch("/api/internal/library-import/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planSha256: sha256,
          confirmation: resetConfirmation,
        }),
        credentials: "same-origin",
      });
      const body = await readResponse(response);
      setPhase("idle");
      setResult(body);
      setResetConfirmation("");
      setMessage("Тестову D1 очищено атомарно. Тепер завантажте цей самий JSON-план.");
    } catch (error) {
      setMessageIsError(true);
      if (error instanceof ImportApiError) setResult(error.body);
      setMessage(error instanceof Error ? error.message : "Тестову D1 не очищено.");
    } finally {
      setBusy(false);
    }
  }

  async function runPhase(next: Exclude<Phase, "idle" | "uploaded">) {
    if (!planSha256 || busy) return;
    if (next === "committed" && target === "production" && !productionConfirmed) {
      setMessageIsError(true);
      setMessage("Підтвердьте production cutover перед atomic commit.");
      return;
    }
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
      setMessage(phaseMessage(next, target));
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
  const production = target === "production";

  return (
    <LibrarianShell
      activeSection="management"
      displayName={displayName}
      roleLabel={roleLabel}
      signOutHref={signOutHref}
    >
      <main className={styles.shell}>
        <section className={styles.card} aria-labelledby="import-title">
          <div className={styles.heading}>
            <div>
              <p>Внутрішній інструмент · {production ? "production cutover" : "staging"}</p>
              <h1 id="import-title">Одноразовий імпорт до D1</h1>
            </div>
          </div>

        <div className={production ? styles.productionWarning : styles.warning}>
          <strong>{production
            ? "Увага: це робоча production D1."
            : "Staging-контур відокремлений від production."}</strong>
          <span>{production
            ? "Atomic commit запише весь перевірений план у робочу базу. Перед ним мають бути готові D1 recovery point, фінальна звірка та замороження змін у старій базі."
            : "Файл приймається лише за наперед дозволеним SHA-256, а commit стає доступним тільки після чистого preflight."}</span>
        </div>

        <dl className={styles.identity}>
          <div><dt>Користувач</dt><dd>{displayName}</dd></div>
          <div><dt>Середовище</dt><dd>{production ? "PRODUCTION" : "STAGING"}</dd></div>
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

        {!production ? (
          <section className={styles.resetBox} aria-labelledby="staging-reset-title">
            <div>
              <strong id="staging-reset-title">Очистити тестову D1 перед імпортом</strong>
              <small>
                Видаляє лише тестові доменні дані та попередні сесії імпорту. Схема,
                міграції й legacy-чернетки залишаються.
              </small>
            </div>
            <label htmlFor="staging-reset-confirmation">
              <span>Для підтвердження введіть: <b>{STAGING_RESET_CONFIRMATION}</b></span>
              <input
                id="staging-reset-confirmation"
                type="text"
                value={resetConfirmation}
                disabled={busy || phase !== "idle"}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setResetConfirmation(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={!file || busy || phase !== "idle" || resetConfirmation !== STAGING_RESET_CONFIRMATION}
              onClick={() => void resetStagingD1()}
            >
              Очистити тестову D1 перед імпортом
            </button>
          </section>
        ) : null}

        {production ? (
          <label
            className={styles.productionConfirmation}
            htmlFor="production-cutover-confirmation"
            aria-label="Підтверджую production cutover"
          >
            <input
              id="production-cutover-confirmation"
              type="checkbox"
              checked={productionConfirmed}
              disabled={busy || phase === "committed" || phase === "verified" || phase === "cleaned"}
              onChange={(event) => setProductionConfirmed(event.target.checked)}
            />
            <span>
              <strong>Підтверджую production cutover</strong>
              <small>Recovery point створено, SHA-256 фінального плану звірено, а зміни у старій базі заморожено.</small>
            </span>
          </label>
        ) : null}

        <div className={styles.steps}>
          <button type="button" disabled={busy || phase !== "uploaded"} onClick={() => void runPhase("preflighted")}>
            2. Preflight
            <small>Лише читає D1 і перевіряє, що ціль порожня.</small>
          </button>
          <button className={styles.commit} type="button" disabled={busy || phase !== "preflighted" || (production && !productionConfirmed)} onClick={() => void runPhase("committed")}>
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
    </LibrarianShell>
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

function phaseMessage(phase: Phase, target: ImportTarget): string {
  return phase === "preflighted" ? "Preflight пройдено: цільова D1 чиста й готова."
    : phase === "committed" ? "Атомарний commit завершено. Тепер обов’язково виконайте verify."
      : phase === "verified" ? "Reconciliation і пошуковий індекс підтверджено."
        : target === "production"
          ? "Приватний план очищено. Негайно вимкніть LIBRARY_IMPORT_ENABLED і приберіть LIBRARY_IMPORT_MODE, SHA та expiry."
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

async function readPlanFile(file: File): Promise<{ bytes: Uint8Array; sha256: string }> {
  if (file.size <= 0 || file.size > 6 * 1024 * 1024) {
    throw new Error("JSON-план має бути непорожнім і не перевищувати 6 МіБ.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return {
    bytes,
    sha256: [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
  };
}
