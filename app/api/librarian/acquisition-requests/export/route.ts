import { env } from "cloudflare:workers";
import { createAcquisitionExport } from "@/lib/acquisition-excel";
import { listAcquisitionExportRows, type AcquisitionDatabase } from "@/lib/acquisition-store";
import { authorizeLibrarianApi, librarianError } from "@/lib/librarian-api";

export const dynamic = "force-dynamic";
export async function GET(): Promise<Response> {
  const authorization = await authorizeLibrarianApi(); if (!authorization.ok) return authorization.response;
  try {
    const workbook = createAcquisitionExport(await listAcquisitionExportRows(env.DB as unknown as AcquisitionDatabase));
    const body = new Uint8Array(workbook.bytes.byteLength); body.set(workbook.bytes);
    return new Response(body.buffer, { headers: {
      "Cache-Control": "private, no-store", "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="acquisition-export.xlsx"; filename*=UTF-8''${encodeURIComponent(workbook.fileName)}`,
      "X-Content-Type-Options": "nosniff", "X-Export-Rows": String(workbook.rowCount),
    } });
  } catch { return librarianError(503, "acquisition_export_unavailable", "Не вдалося сформувати експорт.", authorization.value.access.writesEnabled); }
}
