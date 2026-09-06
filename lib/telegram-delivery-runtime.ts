import { getRequestExecutionContext } from "vinext/shims/request-context";

import {
  drainTelegramOutbox,
  type TelegramDatabase,
} from "./telegram-notifications.ts";

export async function drainTelegramOutboxUntilIdle(
  db: TelegramDatabase,
  options: { siteOrigin: string; maxBatches?: number; batchLimit?: number },
): Promise<{ attempted: number; sent: number; failed: number }> {
  const maxBatches = Math.max(1, Math.min(12, Math.trunc(options.maxBatches ?? 6)));
  const total = { attempted: 0, sent: 0, failed: 0 };
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await drainTelegramOutbox(db, { siteOrigin: options.siteOrigin, limit: options.batchLimit });
    total.attempted += result.attempted;
    total.sent += result.sent;
    total.failed += result.failed;
    if (result.attempted === 0) break;
  }
  return total;
}

/** Start a bounded delivery attempt after the durable business transaction commits. */
export function scheduleTelegramOutboxDrain(
  db: TelegramDatabase,
  requestUrl: string,
  options: { maxBatches?: number } = {},
): void {
  let origin: string;
  try {
    origin = new URL(requestUrl).origin;
  } catch {
    return;
  }
  const maxBatches = Math.max(1, Math.min(6, Math.trunc(options.maxBatches ?? 1)));
  const task = drainTelegramOutboxUntilIdle(db, { siteOrigin: origin, maxBatches }).catch(() => undefined);
  try {
    getRequestExecutionContext()?.waitUntil(task);
  } catch {
    // Local/non-Worker callers may not have a request context. The already-started task remains best effort.
    void task;
  }
}
