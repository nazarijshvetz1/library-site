import { env } from "cloudflare:workers";
import { authorizeLibrarianApi } from "@/lib/librarian-api";
import { acquisitionError, acquisitionJson, acquisitionStoreError, readAcquisitionJson } from "@/lib/acquisition-api";
import { commitAcquisitionImport, previewAcquisitionImport, type AcquisitionDatabase } from "@/lib/acquisition-store";
import { validateAcquisitionImportInput } from "@/lib/acquisition-validation";

export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi(); if (!authorization.ok) return authorization.response;
  const { user, access } = authorization.value;
  if (!access.writesEnabled) return acquisitionError(503, "writes_disabled", "Запис тимчасово вимкнено.", { writesEnabled: false });
  try {
    const body = await readAcquisitionJson(request, { maximumBytes: 1024 * 1024, writesEnabled: true }); if (!body.ok) return body.response;
    const validated = validateAcquisitionImportInput(body.value);
    if (!validated.ok) return acquisitionError(400, "validation_failed", "Файл має некоректну структуру.", { fieldErrors: validated.fieldErrors, writesEnabled: true });
    const db = env.DB as unknown as AcquisitionDatabase;
    if (validated.value.mode === "preview") return acquisitionJson({ schemaVersion: 1, success: true, preview: await previewAcquisitionImport(db, validated.value.rows), writesEnabled: true });
    return acquisitionJson({ schemaVersion: 1, success: true, result: await commitAcquisitionImport(db, user, validated.value), writesEnabled: true });
  } catch (error) { return acquisitionStoreError(error, "acquisition_import_unavailable", true); }
}
