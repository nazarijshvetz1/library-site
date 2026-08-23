import { createAcquisitionImportTemplate } from "@/lib/acquisition-excel";
import { authorizeLibrarianApi, librarianError } from "@/lib/librarian-api";

export const dynamic = "force-dynamic";
export async function GET(): Promise<Response> {
  const authorization = await authorizeLibrarianApi(); if (!authorization.ok) return authorization.response;
  try {
    const workbook = createAcquisitionImportTemplate();
    const body = new Uint8Array(workbook.bytes.byteLength); body.set(workbook.bytes);
    return new Response(body.buffer, { headers: {
      "Cache-Control": "private, no-store", "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="acquisition-template.xlsx"; filename*=UTF-8''${encodeURIComponent(workbook.fileName)}`,
      "X-Content-Type-Options": "nosniff",
    } });
  } catch { return librarianError(503, "acquisition_template_unavailable", "Не вдалося сформувати шаблон.", authorization.value.access.writesEnabled); }
}
