export type PromotedCoverSourceCleanup =
  | { settled: true; sourceCleanedUp: boolean }
  | { settled: false; sourceCleanedUp: false };

type PromotedCoverCleanupDependencies = {
  hasActiveReference: (userId: string, key: string) => Promise<boolean>;
  deleteOwnedSource: (userId: string, key: string) => Promise<boolean>;
};

/**
 * A promoted source is settled when it was deleted, is already absent, or is
 * deliberately retained by an active draft. Storage/check failures remain
 * unsettled so the caller can keep the same request and retry safely.
 */
export async function settlePromotedCoverSource(
  userId: string,
  key: string,
  dependencies: PromotedCoverCleanupDependencies,
): Promise<PromotedCoverSourceCleanup> {
  try {
    if (await dependencies.hasActiveReference(userId, key)) {
      return { settled: true, sourceCleanedUp: false };
    }
    await dependencies.deleteOwnedSource(userId, key);
    return { settled: true, sourceCleanedUp: true };
  } catch {
    return { settled: false, sourceCleanedUp: false };
  }
}
