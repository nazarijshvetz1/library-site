import { env } from "cloudflare:workers";

import {
  coverOwnerPrefix,
  detectCoverImage,
  validCoverPhotoKey,
} from "@/lib/cover-upload";

export type StoredCoverMetadata = {
  customMetadata?: Record<string, string>;
  httpMetadata?: { contentType?: string };
};

export type StoredCover = StoredCoverMetadata & {
  body: ReadableStream<Uint8Array>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
};

export type OwnedCoverAttachment = {
  key: string;
  contentType: "image/jpeg";
  originalName: string;
  byteLength: number;
  sha256: string;
  base64: string;
};

export class CoverAttachmentError extends Error {
  readonly code:
    | "invalid_key"
    | "storage_unavailable"
    | "not_found"
    | "cover_too_large"
    | "unsupported_cover_format"
    | "cover_not_normalized";

  constructor(code: CoverAttachmentError["code"], message: string) {
    super(message);
    this.name = "CoverAttachmentError";
    this.code = code;
  }
}

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

/**
 * Reads an owner-scoped draft photo for a single signed gateway request.
 * The bytes never become a public URL and are revalidated independently of
 * the metadata that was stored when the upload was accepted.
 */
export async function readOwnedCoverAttachment(
  userId: string,
  key: string,
): Promise<OwnedCoverAttachment> {
  if (!validCoverPhotoKey(key)) {
    throw new CoverAttachmentError("invalid_key", "Некоректний ключ фотографії обкладинки.");
  }

  const ownerPrefix = await coverOwnerPrefix(userId);
  if (!key.startsWith(`cover-drafts/${ownerPrefix}/`)) {
    throw new CoverAttachmentError("not_found", "Фотографію обкладинки не знайдено.");
  }

  const bucket = coverBucket();
  if (!bucket) {
    throw new CoverAttachmentError("storage_unavailable", "Сховище фотографій недоступне.");
  }
  const object = await bucket.get(key);
  if (!object || object.customMetadata?.ownerUserId !== userId) {
    throw new CoverAttachmentError("not_found", "Фотографію обкладинки не знайдено.");
  }

  const bytes = await readStoredCoverBytes(object, 900 * 1024);
  const detected = detectCoverImage(bytes.subarray(0, 16));
  if (!detected || detected.contentType !== "image/jpeg") {
    throw new CoverAttachmentError(
      "cover_not_normalized",
      "Фото не підготовлене як фінальний JPEG. Завантажте його повторно через форму сайту.",
    );
  }
  const dimensions = jpegDimensions(bytes);
  if (
    !dimensions
    || dimensions.width > 600
    || dimensions.height > 900
  ) {
    throw new CoverAttachmentError(
      "cover_not_normalized",
      "Фото має бути фінальним JPEG розміром не більше 600 × 900 пікселів. Завантажте його повторно.",
    );
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return {
    key,
    contentType: detected.contentType,
    originalName: object.customMetadata?.originalName?.slice(0, 180) || "cover",
    byteLength: bytes.byteLength,
    sha256: [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
    base64: bytesToBase64(bytes),
  };
}

/**
 * Deletes a temporary owner-scoped object only after the caller has confirmed
 * both the permanent cover write and the absence of other active references.
 */
export async function deleteOwnedCoverAttachment(
  userId: string,
  key: string,
): Promise<boolean> {
  if (!validCoverPhotoKey(key)) {
    throw new CoverAttachmentError("invalid_key", "Некоректний ключ фотографії обкладинки.");
  }
  const ownerPrefix = await coverOwnerPrefix(userId);
  if (!key.startsWith(`cover-drafts/${ownerPrefix}/`)) {
    throw new CoverAttachmentError("not_found", "Фотографію обкладинки не знайдено.");
  }
  const bucket = coverBucket();
  if (!bucket) {
    throw new CoverAttachmentError("storage_unavailable", "Сховище фотографій недоступне.");
  }
  const object = await bucket.head(key);
  if (!object) return false;
  if (object.customMetadata?.ownerUserId !== userId) {
    throw new CoverAttachmentError("not_found", "Фотографію обкладинки не знайдено.");
  }
  await bucket.delete(key);
  return true;
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  while (offset + 3 < bytes.byteLength) {
    while (offset < bytes.byteLength && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) return null;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 1 >= bytes.byteLength) return null;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.byteLength) return null;
    if (startOfFrame.has(marker)) {
      if (length < 7) return null;
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += length;
  }
  return null;
}

async function readStoredCoverBytes(
  object: StoredCover,
  limit: number,
): Promise<Uint8Array> {
  if (object.arrayBuffer) {
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength > limit) {
      throw new CoverAttachmentError("cover_too_large", "Підготовлена фотографія перевищує дозволений безпечний розмір.");
    }
    return bytes;
  }

  const reader = object.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        try {
          await reader.cancel("cover exceeds the attachment limit");
        } catch {
          // The size error remains authoritative if cancellation fails.
        }
        throw new CoverAttachmentError("cover_too_large", "Підготовлена фотографія перевищує дозволений безпечний розмір.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 3 * 8192;
  let encoded = "";
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
    let binary = "";
    for (const byte of chunk) binary += String.fromCharCode(byte);
    encoded += btoa(binary);
  }
  return encoded;
}
