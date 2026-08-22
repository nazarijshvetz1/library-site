import { env } from "cloudflare:workers";

import { createLibraryExcelExport } from "@/lib/library-excel-export";
import {
  LibraryExportError,
  readLibraryExportSnapshot,
  type LibraryExportDatabase,
} from "@/lib/library-export-store";
import {
  authorizeLibrarianApi,
  librarianError,
} from "@/lib/librarian-api";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;

  try {
    const snapshot = await readLibraryExportSnapshot(
      env.DB as unknown as LibraryExportDatabase,
    );
    const workbook = createLibraryExcelExport(snapshot);
    const encodedName = encodeURIComponent(workbook.fileName);
    return new Response(workbook.bytes, {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="library-full-export.xlsx"; filename*=UTF-8''${encodedName}`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "X-Content-Type-Options": "nosniff",
        "X-Export-Filename": encodedName,
        "X-Export-Rows": String(workbook.rowCount),
        "X-Export-Sheets": String(workbook.sheetCount),
      },
    });
  } catch (error) {
    if (error instanceof LibraryExportError) {
      return librarianError(
        error.code === "export_too_large" ? 413 : 503,
        error.code,
        error.message,
        authorization.value.access.writesEnabled,
      );
    }
    return librarianError(
      503,
      "export_unavailable",
      "Не вдалося сформувати Excel-файл. Дані в бібліотеці не змінено.",
      authorization.value.access.writesEnabled,
    );
  }
}
