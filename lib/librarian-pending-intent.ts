export type InventoryIntentKind = "transfer" | "writeoff";

export type PendingInventoryIntent = {
  kind: InventoryIntentKind;
  materialId: string;
  requestId: string;
  payload: Record<string, unknown>;
};

export type SessionStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function pendingInventoryKey(kind: InventoryIntentKind, materialId: string): string {
  return `library.inventory.pending.v1.${kind}.${materialId}`;
}

export function readPendingInventoryIntent(
  storage: SessionStorageLike,
  kind: InventoryIntentKind,
  materialId: string,
): PendingInventoryIntent | null {
  try {
    const raw = storage.getItem(pendingInventoryKey(kind, materialId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingInventoryIntent>;
    if (
      value.kind !== kind
      || value.materialId !== materialId
      || typeof value.requestId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.requestId)
      || !value.payload
      || typeof value.payload !== "object"
      || Array.isArray(value.payload)
    ) return null;
    return value as PendingInventoryIntent;
  } catch {
    return null;
  }
}

export function writePendingInventoryIntent(
  storage: SessionStorageLike,
  intent: PendingInventoryIntent,
): void {
  storage.setItem(pendingInventoryKey(intent.kind, intent.materialId), JSON.stringify(intent));
}

export function clearPendingInventoryIntent(
  storage: SessionStorageLike,
  kind: InventoryIntentKind,
  materialId: string,
): void {
  storage.removeItem(pendingInventoryKey(kind, materialId));
}
