import { env } from "cloudflare:workers";

import { isSameOriginRequest } from "@/lib/librarian-api";
import { coverBucket, jpegDimensions } from "@/lib/cover-storage";
import { detectCoverImage } from "@/lib/cover-upload";
import {
  deleteTeacherPhotoDirect,
  getTeacherPhotoAsset,
  replaceTeacherPhotoDirect,
} from "@/lib/teacher-profile-store";
import {
  readVisitJson,
  teacherPortalGate,
  visitError,
  visitJson,
  visitStoreError,
} from "@/lib/visit-schedule-api";
import type { VisitD1Database } from "@/lib/visit-schedule-store";
import { requireVisitTeacherSession } from "@/lib/visit-teacher-auth";

export const dynamic = "force-dynamic";

const MAX_PHOTO_BYTES = 900 * 1024;
const MAX_REQUEST_BYTES = 1300 * 1024;

export async function GET(request: Request): Promise<Response> {
  const gate = teacherPortalGate();
  if (gate) return gate;
  const db = env.DB as unknown as VisitD1Database;
  try {
    const teacher = await requireVisitTeacherSession(db, request);
    const asset = await getTeacherPhotoAsset(db, teacher.teacherUserId);
    if (!asset) return imageError(404);
    const bucket = coverBucket();
    if (!bucket) return imageError(503);
    const object = await bucket.get(asset.storageKey);
    if (!object) return imageError(404);
    return new Response(object.body, { headers: photoHeaders(asset.mimeType) });
  } catch {
    return imageError(401);
  }
}

export async function POST(request: Request): Promise<Response> {
  const gate = teacherPortalGate();
  if (gate) return gate;
  if (!isSameOriginRequest(request)) {
    return visitError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.");
  }
  if ((request.headers.get("Content-Encoding") ?? "identity").toLowerCase() !== "identity") {
    return visitError(415, "unsupported_content_encoding", "Стиснене тіло запиту не підтримується.");
  }
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    return visitError(415, "unsupported_media_type", "Надішліть фото як форму завантаження.");
  }
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > MAX_REQUEST_BYTES) {
    return visitError(413, "teacher_photo_too_large", "Підготовлене фото має бути не більше 900 КБ.");
  }

  const db = env.DB as unknown as VisitD1Database;
  try {
    const teacher = await requireVisitTeacherSession(db, request);
    const body = await readLimitedBody(request, MAX_REQUEST_BYTES);
    const form = await new Request(request.url, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    }).formData();
    if ([...form.keys()].some((key) => !["photo", "requestId", "expectedVersion"].includes(key))) {
      return visitError(400, "validation_failed", "Форма містить невідомі поля.");
    }
    const photo = form.get("photo");
    const requestId = form.get("requestId");
    const expectedVersion = Number(form.get("expectedVersion"));
    if (!(photo instanceof File) || typeof requestId !== "string"
      || !validRequestId(requestId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      return visitError(400, "validation_failed", "Оберіть фото та оновіть профіль перед збереженням.");
    }
    if (photo.size < 1 || photo.size > MAX_PHOTO_BYTES) {
      return visitError(413, "teacher_photo_too_large", "Підготовлене фото має бути не більше 900 КБ.");
    }
    const arrayBuffer = await photo.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const detected = detectCoverImage(bytes.subarray(0, 16));
    const dimensions = jpegDimensions(bytes);
    if (!detected || detected.contentType !== "image/jpeg" || !dimensions
      || dimensions.width > 600 || dimensions.height > 900) {
      return visitError(415, "teacher_photo_not_normalized",
        "Фото має бути підготовленим JPEG не більше 600 × 900 пікселів. Оберіть його через форму ще раз.");
    }
    const bucket = coverBucket();
    if (!bucket) return visitError(503, "photo_storage_unavailable", "Сховище фотографій тимчасово недоступне.");
    const sha256 = await sha256Hex(bytes);
    const result = await replaceTeacherPhotoDirect(db, bucket, teacher, {
      requestId,
      expectedVersion,
      bytes: arrayBuffer,
      sha256,
      width: dimensions.width,
      height: dimensions.height,
    });
    return visitJson({ schemaVersion: 1, success: true, photo: result }, { status: 201 });
  } catch (error) {
    if (error instanceof UploadTooLargeError) {
      return visitError(413, "teacher_photo_too_large", "Підготовлене фото має бути не більше 900 КБ.");
    }
    return visitStoreError(error, "teacher_photo_unavailable");
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const gate = teacherPortalGate();
  if (gate) return gate;
  if (!isSameOriginRequest(request)) {
    return visitError(403, "cross_origin_request", "Запит має надійти з цього самого сайту.");
  }
  const body = await readVisitJson(request);
  if (!body.ok) return body.response;
  if (Object.keys(body.value).length !== 2
    || typeof body.value.requestId !== "string" || !validRequestId(body.value.requestId)
    || !Number.isSafeInteger(body.value.expectedVersion) || Number(body.value.expectedVersion) < 1) {
    return visitError(400, "validation_failed", "Оновіть профіль та повторіть видалення фото.");
  }
  const db = env.DB as unknown as VisitD1Database;
  try {
    const teacher = await requireVisitTeacherSession(db, request);
    const bucket = coverBucket();
    if (!bucket) return visitError(503, "photo_storage_unavailable", "Сховище фотографій тимчасово недоступне.");
    const result = await deleteTeacherPhotoDirect(db, bucket, teacher, {
      requestId: body.value.requestId,
      expectedVersion: Number(body.value.expectedVersion),
    });
    return visitJson({ schemaVersion: 1, success: true, photo: result });
  } catch (error) {
    return visitStoreError(error, "teacher_photo_unavailable");
  }
}

class UploadTooLargeError extends Error {}

async function readLimitedBody(request: Request, limit: number): Promise<Uint8Array> {
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
        try { await reader.cancel("photo upload exceeds limit"); } catch { /* size remains authoritative */ }
        throw new UploadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function validRequestId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", source);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function photoHeaders(mimeType: string): Headers {
  return new Headers({
    "Cache-Control": "private, max-age=300",
    "Content-Disposition": "inline",
    "Content-Type": mimeType,
    "X-Content-Type-Options": "nosniff",
  });
}

function imageError(status: number): Response {
  return new Response(null, {
    status,
    headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}
