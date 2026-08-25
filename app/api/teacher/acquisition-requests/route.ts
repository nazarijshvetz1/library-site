import { env } from "cloudflare:workers";
import { acquisitionError, acquisitionJson, acquisitionStoreError, readAcquisitionJson } from "@/lib/acquisition-api";
import { createTeacherAcquisitionRequest, listTeacherAcquisitionRequests, type AcquisitionDatabase, type TeacherAcquisitionSort } from "@/lib/acquisition-store";
import { validateAcquisitionCreateInput, type AcquisitionStatus } from "@/lib/acquisition-validation";
import { requireVisitTeacherSession } from "@/lib/visit-teacher-auth";
import type { VisitD1Database } from "@/lib/visit-schedule-store";
import { teacherPortalGate } from "@/lib/visit-schedule-api";
import { scheduleTelegramOutboxDrain } from "@/lib/telegram-delivery-runtime";

export const dynamic = "force-dynamic";
const STATUSES = new Set<AcquisitionStatus | "all">(["all","submitted","in_review","clarification","approved","planned","ordered","partially_received","received","rejected","cancelled"]);
const SORTS = new Set<TeacherAcquisitionSort>(["date_desc","date_asc","title_asc","title_desc","quantity_desc"]);

export async function GET(request: Request): Promise<Response> {
  const gate = teacherPortalGate(); if (gate) return gate;
  const db = env.DB as unknown as AcquisitionDatabase & VisitD1Database;
  try {
    const teacher = await requireVisitTeacherSession(db, request);
    const params = new URL(request.url).searchParams;
    const status = (params.get("status") ?? "all") as AcquisitionStatus | "all";
    const sort = (params.get("sort") ?? "date_desc") as TeacherAcquisitionSort;
    const query = (params.get("q") ?? "").trim();
    if (!STATUSES.has(status) || !SORTS.has(sort) || query.length > 80) return acquisitionError(400, "validation_failed", "Некоректний пошук, статус або сортування.");
    return acquisitionJson({ schemaVersion: 1, success: true, requests: await listTeacherAcquisitionRequests(db, teacher.teacherUserId, { status, sort, query }) });
  } catch (error) { return acquisitionStoreError(error, "acquisition_requests_unavailable"); }
}

export async function POST(request: Request): Promise<Response> {
  const gate = teacherPortalGate(); if (gate) return gate;
  const db = env.DB as unknown as AcquisitionDatabase & VisitD1Database;
  try {
    const teacher = await requireVisitTeacherSession(db, request);
    const body = await readAcquisitionJson(request); if (!body.ok) return body.response;
    const validated = validateAcquisitionCreateInput(body.value);
    if (!validated.ok) return acquisitionError(400, "validation_failed", "Перевірте дані пропозиції.", { fieldErrors: validated.fieldErrors });
    const record = await createTeacherAcquisitionRequest(db, teacher, validated.value);
    scheduleTelegramOutboxDrain(db, request.url);
    return acquisitionJson({ schemaVersion: 1, success: true, request: record }, { status: 201 });
  } catch (error) { return acquisitionStoreError(error, "acquisition_request_create_unavailable"); }
}
