import { env } from "cloudflare:workers";
import { acquisitionJson, acquisitionStoreError } from "@/lib/acquisition-api";
import { listPublicAcquisitionReference, type AcquisitionDatabase } from "@/lib/acquisition-store";

export const dynamic = "force-dynamic";
export async function GET(): Promise<Response> {
  try { return acquisitionJson({ schemaVersion: 1, success: true, ...(await listPublicAcquisitionReference(env.DB as unknown as AcquisitionDatabase)) }, {}, true); }
  catch (error) { return acquisitionStoreError(error, "acquisition_reference_unavailable", undefined, true); }
}
