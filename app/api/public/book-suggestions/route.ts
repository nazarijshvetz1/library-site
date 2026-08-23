import { env } from "cloudflare:workers";
import { acquisitionError, acquisitionJson, acquisitionStoreError, readAcquisitionJson } from "@/lib/acquisition-api";
import { createStudentAcquisitionRequest, type AcquisitionDatabase } from "@/lib/acquisition-store";
import { validateStudentAcquisitionCreateInput } from "@/lib/acquisition-validation";
import { scheduleTelegramOutboxDrain } from "@/lib/telegram-delivery-runtime";
import { getRuntimeString } from "@/lib/runtime-env";

export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readAcquisitionJson(request, { publicForm: true }); if (!body.ok) return body.response;
    const validated = validateStudentAcquisitionCreateInput(body.value);
    if (!validated.ok) return acquisitionError(400, "validation_failed", "Перевірте дані пропозиції.", { fieldErrors: validated.fieldErrors }, true);
    const db = env.DB as unknown as AcquisitionDatabase;
    const secret = getRuntimeString("ACQUISITION_RATE_LIMIT_SECRET") || getRuntimeString("VISIT_TEACHER_AUTH_PEPPER") || "";
    const result = await createStudentAcquisitionRequest(db, request, validated.value, secret);
    scheduleTelegramOutboxDrain(db, request.url);
    return acquisitionJson({ schemaVersion: 1, success: true, publicNumber: result.request.publicNumber, replayed: result.replayed }, { status: result.replayed ? 200 : 201 }, true);
  } catch (error) { return acquisitionStoreError(error, "book_suggestion_unavailable", undefined, true); }
}
