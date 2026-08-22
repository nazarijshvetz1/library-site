import { getRequestExecutionContext } from "vinext/shims/request-context";

import {
  drainTelegramOutbox,
  type TelegramDatabase,
} from "./telegram-notifications.ts";

/** Start a bounded delivery attempt after the durable business transaction commits. */
export function scheduleTelegramOutboxDrain(db: TelegramDatabase, requestUrl: string): void {
  let origin: string;
  try {
    origin = new URL(requestUrl).origin;
  } catch {
    return;
  }
  const task = drainTelegramOutbox(db, { siteOrigin: origin }).then(() => undefined).catch(() => undefined);
  try {
    getRequestExecutionContext()?.waitUntil(task);
  } catch {
    // Local/non-Worker callers may not have a request context. The already-started task remains best effort.
    void task;
  }
}
