export type ClosableTelegramWebApp = {
  close?(): void;
};

/**
 * Return to the chat only after Telegram received the new rich menu. If the
 * bridge is absent, throws, or silently does nothing, the teacher remains in a
 * usable authenticated cabinet instead of seeing a false login failure.
 */
export function finishTelegramLogin(
  webApp: ClosableTelegramWebApp | undefined,
  returnToChat: boolean,
  menuMessageDelivered: boolean,
  targetUrl: string,
  navigate: (url: string) => void,
  scheduleFallback: (callback: () => void, delayMs: number) => number,
  cancelFallback: (timerId: number) => void,
): "closed" | "navigated" {
  if (returnToChat && menuMessageDelivered && webApp?.close) {
    let fallbackTimer: number | null = null;
    try {
      fallbackTimer = scheduleFallback(() => navigate(targetUrl), 1_200);
      webApp.close();
      return "closed";
    } catch {
      if (fallbackTimer !== null) cancelFallback(fallbackTimer);
    }
  }
  navigate(targetUrl);
  return "navigated";
}
