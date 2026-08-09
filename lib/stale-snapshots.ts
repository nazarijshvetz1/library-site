export type EntityVersionSnapshot = {
  id: string;
  version: string;
};

export const SNAPSHOT_VERSION_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isSnapshotVersion(value: unknown): value is string {
  return typeof value === "string" && SNAPSHOT_VERSION_PATTERN.test(value);
}

export function findEntityVersion(
  snapshots: readonly EntityVersionSnapshot[],
  id: string,
): string | null {
  if (!id) return null;
  const matches = snapshots.filter((snapshot) => (
    snapshot.id === id && isSnapshotVersion(snapshot.version)
  ));
  return matches.length === 1 ? matches[0].version : null;
}

export function entityVersionIsCurrent(
  snapshots: readonly EntityVersionSnapshot[],
  id: string,
  expectedVersion: unknown,
): boolean {
  return isSnapshotVersion(expectedVersion)
    && findEntityVersion(snapshots, id) === expectedVersion;
}

export function materialLocationQuantity(
  material: Record<string, unknown> | null | undefined,
  locationName: string,
  knownLocationNames?: readonly string[],
): number | null {
  if (!material || !locationName.trim()) return null;
  if (
    knownLocationNames
    && !knownLocationNames.some((name) => (
      normalizeLocationName(name) === normalizeLocationName(locationName)
    ))
  ) return null;
  const stock = material.stock;
  if (!isRecord(stock) || !Array.isArray(stock.locations)) return null;

  const expectedName = normalizeLocationName(locationName);
  const matches = stock.locations.filter((entry) => (
    isRecord(entry)
    && normalizeLocationName(readText(entry.name)) === expectedName
  ));
  if (matches.length === 0) return 0;
  if (matches.length !== 1) return null;

  const quantity = Number(matches[0].quantity);
  return Number.isInteger(quantity) && quantity >= 0 && quantity <= 100_000
    ? quantity
    : null;
}

function normalizeLocationName(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("uk-UA");
}

function readText(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
