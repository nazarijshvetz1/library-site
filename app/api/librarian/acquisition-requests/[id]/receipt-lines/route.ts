import { env } from "cloudflare:workers";
import { authorizeLibrarianApi } from "@/lib/librarian-api";
import { acquisitionError, acquisitionJson, acquisitionStoreError, safeAcquisitionId } from "@/lib/acquisition-api";
import { listAcquisitionReceiptOptions, type AcquisitionDatabase } from "@/lib/acquisition-store";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context): Promise<Response> {
  const authorization = await authorizeLibrarianApi(); if (!authorization.ok) return authorization.response;
  const { id } = await context.params;
  if (!safeAcquisitionId(id)) return acquisitionError(400, "validation_failed", "Некоректний номер заявки.", { writesEnabled: authorization.value.access.writesEnabled });
  try { return acquisitionJson({ schemaVersion: 1, success: true, lines: await listAcquisitionReceiptOptions(env.DB as unknown as AcquisitionDatabase, id), writesEnabled: authorization.value.access.writesEnabled }); }
  catch (error) { return acquisitionStoreError(error, "receipt_options_unavailable", authorization.value.access.writesEnabled); }
}
