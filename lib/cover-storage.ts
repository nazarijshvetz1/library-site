import { env } from "cloudflare:workers";

import { coverOwnerPrefix, validCoverPhotoKey } from "@/lib/cover-upload";

export type StoredCoverMetadata = {
  customMetadata?: Record<string, string>;
  httpMetadata?: { contentType?: string };
};

export type StoredCover = StoredCoverMetadata & {
  body: ReadableStream;
};

export type CoverBucket = {
  put(
    key: string,
    value: ArrayBuffer,
    options: {
      httpMetadata: { contentType: string };
      customMetadata: Record<string, string>;
    },
  ): Promise<unknown>;
  get(key: string): Promise<StoredCover | null>;
  head(key: string): Promise<StoredCoverMetadata | null>;
  delete(key: string): Promise<void>;
};

export type CoverOwnershipResult =
  | { ok: true }
  | { ok: false; code: "invalid_key" | "storage_unavailable" | "not_found" };

export function coverBucket(): CoverBucket | null {
  const value = (env as unknown as Record<string, unknown>).COVER_UPLOADS;
  return value && typeof value === "object" ? value as CoverBucket : null;
}

export async function verifyOwnedCoverPhoto(
  userId: string,
  key: string,
): Promise<CoverOwnershipResult> {
  if (!validCoverPhotoKey(key)) return { ok: false, code: "invalid_key" };

  const ownerPrefix = await coverOwnerPrefix(userId);
  if (!key.startsWith(`cover-drafts/${ownerPrefix}/`)) {
    return { ok: false, code: "not_found" };
  }

  const bucket = coverBucket();
  if (!bucket) return { ok: false, code: "storage_unavailable" };

  const object = await bucket.head(key);
  if (!object || object.customMetadata?.ownerUserId !== userId) {
    return { ok: false, code: "not_found" };
  }
  return { ok: true };
}
