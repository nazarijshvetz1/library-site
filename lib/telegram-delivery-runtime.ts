import { getRequestExecutionContext } from "vinext/shims/request-context";

import {
  drainTelegramOutbox,
  type TelegramDatabase,
} from "./telegram-notifications.ts";

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
  const task = (async () => {
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const result = await drainTelegramOutbox(db, { siteOrigin: origin });
      if (result.attempted < 10) break;
    }
  })().catch(() => undefined);
  try {
    getRequestExecutionContext()?.waitUntil(task);
  } catch {
    // Local/non-Worker callers may not have a request context. The already-started task remains best effort.
    void task;
  }
}
