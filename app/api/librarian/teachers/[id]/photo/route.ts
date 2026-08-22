import { coverBucket } from "@/lib/cover-storage";
import { getTeacherPhotoAsset } from "@/lib/teacher-profile-store";
import { authorizeTeacherRegistryRead, safeTeacherId } from "@/lib/teacher-registry-api";
import type { VisitD1Database } from "@/lib/visit-schedule-store";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const authorization = await authorizeTeacherRegistryRead();
  if (!authorization.ok) return authorization.response;
  const { id } = await context.params;
  if (!safeTeacherId(id)) return imageError(400);
  try {
    const asset = await getTeacherPhotoAsset(
      authorization.value.db as unknown as VisitD1Database,
      id,
    );
    if (!asset) return imageError(404);
    const bucket = coverBucket();
    if (!bucket) return imageError(503);
    const object = await bucket.get(asset.storageKey);
    if (!object) return imageError(404);
    return new Response(object.body, {
      headers: {
        "Cache-Control": "private, max-age=300",
        "Content-Disposition": "inline",
        "Content-Type": asset.mimeType,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return imageError(503);
  }
}

function imageError(status: number): Response {
  return new Response(null, {
    status,
    headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}
