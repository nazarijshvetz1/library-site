import {
  authorizeLibrarianApi,
  isSameOriginRequest,
  librarianError,
  librarianJson,
} from "@/lib/librarian-api";
import {
  coverOwnerPrefix,
  detectCoverImage,
  MAX_COVER_PHOTO_BYTES,
  validCoverPhotoKey,
} from "@/lib/cover-upload";
import { coverBucket } from "@/lib/cover-storage";
import { activeDraftReferencesCoverPhoto } from "@/lib/draft-store";

export const dynamic = "force-dynamic";

const MAX_COVER_UPLOAD_REQUEST_BYTES = MAX_COVER_PHOTO_BYTES + 512 * 1024;

class CoverUploadTooLargeError extends Error {}

export async function POST(request: Request) {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  if (!isSameOriginRequest(request)) {
    return librarianError(
      403,
      "cross_origin_request",
      "Запит має надійти з цього самого сайту.",
      authorization.value.access.writesEnabled,
    );
  }

  const declaredLengthHeader = request.headers.get("content-length");
  if (declaredLengthHeader !== null) {
    const declaredLength = Number(declaredLengthHeader);
    if (!Number.isSafeInteger(declaredLength) || declaredLength <= 0) {
      return uploadError(400, "invalid_content_length", "Некоректний розмір запиту.", authorization.value.access.writesEnabled);
    }
    if (declaredLength > MAX_COVER_UPLOAD_REQUEST_BYTES) {
      return uploadError(413, "cover_too_large", "Фото має бути не більше 8 МБ.", authorization.value.access.writesEnabled);
    }
  }

  let uploadBody: Uint8Array;
  try {
    uploadBody = await readLimitedRequestBody(request, MAX_COVER_UPLOAD_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof CoverUploadTooLargeError) {
      return uploadError(413, "cover_too_large", "Фото має бути не більше 8 МБ.", authorization.value.access.writesEnabled);
    }
    return uploadError(400, "invalid_upload", "Не вдалося прочитати файл.", authorization.value.access.writesEnabled);
  }

  if (uploadBody.byteLength === 0) {
    return uploadError(400, "invalid_upload", "Не вдалося прочитати файл.", authorization.value.access.writesEnabled);
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    return uploadError(415, "invalid_upload_type", "Надішліть фото як форму завантаження.", authorization.value.access.writesEnabled);
  }

  let data: FormData;
  try {
    data = await new Request(request.url, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: uploadBody,
    }).formData();
  } catch {
    return uploadError(400, "invalid_upload", "Не вдалося прочитати файл.", authorization.value.access.writesEnabled);
  }
  const value = data.get("photo");
  if (!(value instanceof File)) {
    return uploadError(400, "photo_required", "Оберіть фотографію обкладинки.", authorization.value.access.writesEnabled);
  }
  if (value.size <= 0 || value.size > MAX_COVER_PHOTO_BYTES) {
    return uploadError(413, "cover_too_large", "Фото має бути не більше 8 МБ.", authorization.value.access.writesEnabled);
  }

  const arrayBuffer = await value.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const detected = detectCoverImage(bytes.subarray(0, 16));
  if (!detected) {
    return uploadError(
      415,
      "unsupported_cover_format",
      "Підтримуються фотографії JPG, PNG або WEBP.",
      authorization.value.access.writesEnabled,
    );
  }

  const bucket = coverBucket();
  if (!bucket) {
    return uploadError(503, "cover_storage_unavailable", "Сховище фотографій ще не підключено.", authorization.value.access.writesEnabled);
  }

  const { user, access } = authorization.value;
  const ownerPrefix = await coverOwnerPrefix(user.userId);
  const key = `cover-drafts/${ownerPrefix}/${crypto.randomUUID()}.${detected.extension}`;
  await bucket.put(key, arrayBuffer, {
    httpMetadata: { contentType: detected.contentType },
    customMetadata: {
      ownerUserId: user.userId,
      originalName: safeOriginalName(value.name),
      uploadedAt: new Date().toISOString(),
    },
  });

  return librarianJson(
    {
      success: true,
      photo: {
        key,
        name: safeOriginalName(value.name),
        size: value.size,
        contentType: detected.contentType,
        previewUrl: `/api/librarian/cover-photo?key=${encodeURIComponent(key)}`,
      },
      writesEnabled: access.writesEnabled,
    },
    { status: 201 },
  );
}

export async function GET(request: Request) {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  const key = new URL(request.url).searchParams.get("key") ?? "";
  if (!validCoverPhotoKey(key)) {
    return uploadError(400, "invalid_cover_key", "Некоректний ключ фотографії.", authorization.value.access.writesEnabled);
  }

  const bucket = coverBucket();
  if (!bucket) {
    return uploadError(503, "cover_storage_unavailable", "Сховище фотографій ще не підключено.", authorization.value.access.writesEnabled);
  }
  const object = await bucket.get(key);
  if (!object || object.customMetadata?.ownerUserId !== authorization.value.user.userId) {
    return uploadError(404, "cover_not_found", "Фотографію не знайдено.", authorization.value.access.writesEnabled);
  }

  return new Response(object.body, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function DELETE(request: Request) {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  if (!isSameOriginRequest(request)) {
    return uploadError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.", authorization.value.access.writesEnabled);
  }
  const key = new URL(request.url).searchParams.get("key") ?? "";
  if (!validCoverPhotoKey(key)) {
    return uploadError(400, "invalid_cover_key", "Некоректний ключ фотографії.", authorization.value.access.writesEnabled);
  }

  const bucket = coverBucket();
  if (!bucket) {
    return uploadError(503, "cover_storage_unavailable", "Сховище фотографій ще не підключено.", authorization.value.access.writesEnabled);
  }
  const object = await bucket.head(key);
  if (!object || object.customMetadata?.ownerUserId !== authorization.value.user.userId) {
    return uploadError(404, "cover_not_found", "Фотографію не знайдено.", authorization.value.access.writesEnabled);
  }
  try {
    if (await activeDraftReferencesCoverPhoto(authorization.value.user.userId, key)) {
      return uploadError(
        409,
        "cover_in_use",
        "Фото вже використовується в активній чернетці. Спочатку змініть або скасуйте чернетку.",
        authorization.value.access.writesEnabled,
      );
    }
  } catch {
    return uploadError(
      503,
      "draft_store_unavailable",
      "Не вдалося безпечно перевірити використання фото.",
      authorization.value.access.writesEnabled,
    );
  }
  await bucket.delete(key);
  return librarianJson({ success: true, deleted: true, writesEnabled: authorization.value.access.writesEnabled });
}

function safeOriginalName(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 180) || "cover";
  return /^[=+\-@]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

async function readLimitedRequestBody(request: Request, limit: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
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
          await reader.cancel("cover upload exceeds the request limit");
        } catch {
          // The size error below remains authoritative even if cancellation fails.
        }
        throw new CoverUploadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function uploadError(
  status: number,
  code: string,
  message: string,
  writesEnabled: boolean,
) {
  return librarianError(status, code, message, writesEnabled);
}
