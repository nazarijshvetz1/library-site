export type TeacherCartMaterial = {
  id: string; title: string; author: string; year: number | null; isbn: string; rubric: string;
  subject: string; publicationType: string; classFrom: number | null; classTo: number | null;
  publisher: string; thumbnailUrl: string; totalQuantity: number; availableQuantity: number;
  loanedQuantity: number; reservedQuantity: number;
};
export type TeacherCartRow = { item: TeacherCartMaterial; quantity: number };
export type AssistantCartSnapshot = { items: Array<{ materialId: string; quantity: number }>; notes: string };
export type AssistantCartUpdate = { before: string; snapshot: AssistantCartSnapshot; materials: TeacherCartMaterial[] };
export type AssistantCartBridge = {
  read(): AssistantCartSnapshot;
  isLocked(): boolean;
  apply(update: AssistantCartUpdate): boolean;
  lock(value: boolean): void;
  clear(signature: string): void;
};
export function cartSignature(cart: AssistantCartSnapshot): string {
  return JSON.stringify({ items: [...cart.items].sort((a, b) => a.materialId.localeCompare(b.materialId)), notes: cart.notes.trim() });
}
export function parseAssistantCart(input: unknown): AssistantCartSnapshot {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { items: [], notes: "" };
  const value = input as Partial<AssistantCartSnapshot>;
  if (!Array.isArray(value.items) || value.items.length > 10 || typeof value.notes !== "string" || value.notes.length > 2000) throw new Error("invalid_cart");
  const ids = new Set<string>();
  for (const item of value.items) {
    if (!item || !/^CAT-\d{4,}$/u.test(item.materialId) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 1000 || ids.has(item.materialId)) throw new Error("invalid_cart");
    ids.add(item.materialId);
  }
  return { items: value.items.map(({ materialId, quantity }) => ({ materialId, quantity })), notes: value.notes };
}
