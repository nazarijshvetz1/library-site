import { env } from "cloudflare:workers";

import {
  createAllClassesExcelArchive,
  createClassExcelWorkbook,
} from "@/lib/class-excel-export";
import {
  ClassExcelExportError,
  readClassExportSnapshot,
  type ClassExcelExportDatabase,
} from "@/lib/class-excel-export-store";
import {
  authorizeLibrarianApi,
  librarianError,
  librarianJson,
} from "@/lib/librarian-api";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;

  const url = new URL(request.url);
  const classYearId = url.searchParams.get("classYearId")?.trim() || null;
  const downloadAll = url.searchParams.get("all") === "true";

  try {
    const snapshot = await readClassExportSnapshot(
      env.DB as unknown as ClassExcelExportDatabase,
      classYearId,
    );

    if (!classYearId && !downloadAll) {
      return librarianJson({
        success: true,
        classes: snapshot.classes.map((item) => ({
          id: item.id,
          academicYear: item.academicYear,
          className: item.className,
          teacherName: item.teacherName,
          locationName: item.locationName,
          remainingQuantity: item.remainingQuantity,
        })),
      });
    }

    if (downloadAll) {
      const archive = createAllClassesExcelArchive(snapshot);
      return downloadResponse(archive.bytes, archive.fileName, "application/zip", {
        "X-Export-Documents": String(archive.documentCount),
        "X-Export-Rows": String(archive.rowCount),
      });
    }

    const document = snapshot.classes[0];
    if (!document) {
      throw new ClassExcelExportError("class_not_found", "Обраний активний клас не знайдено.");
    }
    const workbook = createClassExcelWorkbook(document, snapshot.generatedAt);
    return downloadResponse(
      workbook.bytes,
      workbook.fileName,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      {
        "X-Export-Documents": "1",
        "X-Export-Rows": String(workbook.rowCount),
        "X-Export-Sheets": String(workbook.sheetCount),
      },
    );
  } catch (error) {
    if (error instanceof ClassExcelExportError) {
      const status = error.code === "class_not_found" ? 404 : error.code === "export_too_large" ? 413 : 503;
      return librarianError(
        status,
        error.code,
        error.message,
        authorization.value.access.writesEnabled,
      );
    }
    return librarianError(
      503,
      "export_unavailable",
      "Не вдалося сформувати документи класів. Дані в бібліотеці не змінено.",
      authorization.value.access.writesEnabled,
    );
  }
}

function downloadResponse(
  bytes: Uint8Array,
  fileName: string,
  contentType: string,
  extraHeaders: Record<string, string>,
): Response {
  const encodedName = encodeURIComponent(fileName);
  return new Response(bytes, {
    status: 200,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="class-export"; filename*=UTF-8''${encodedName}`,
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
      "X-Export-Filename": encodedName,
      ...extraHeaders,
    },
  });
}
