function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function persistedCoverFromApplyResult(
  result: unknown,
): Record<string, unknown> | null {
  return recordValue(recordValue(result)?.cover);
}

/**
 * Temporary private bytes may be deleted only when the durable apply result
 * proves that this exact request wrote the expected permanent CAT cover.
 */
export function confirmedPermanentPrivateCover(
  cover: unknown,
  expectedRequestId: string,
): boolean {
  const value = recordValue(cover);
  if (!value || value.request_id !== expectedRequestId) return false;
  if (
    value.mode !== "private_photo"
    || value.status !== "completed"
    || value.permanent_url_written !== true
  ) return false;

  const materialId = typeof value.material_id === "string"
    ? value.material_id.trim()
    : "";
  const finalUrl = typeof value.final_url === "string"
    ? value.final_url.trim()
    : "";
  if (!/^CAT-\d{4,}$/u.test(materialId)) return false;
  const match = finalUrl.match(
    /^https:\/\/raw\.githubusercontent\.com\/[^/?#]+\/[^/?#]+\/main\/covers\/(CAT-\d{4,})\.jpg$/u,
  );
  return match?.[1] === materialId;
}
