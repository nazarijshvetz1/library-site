import { createTeacherCodeImportTemplate } from "@/lib/teacher-code-import-excel";
import { authorizeVisitTeacherAccessApi, visitStoreError } from "@/lib/visit-teacher-access-api";
import { listMissingVisitTeacherCodeRows } from "@/lib/visit-teacher-auth";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const authorization = await authorizeVisitTeacherAccessApi();
  if (!authorization.ok) return authorization.response;
  try {
    const rows = await listMissingVisitTeacherCodeRows(authorization.value.db);
    const workbook = createTeacherCodeImportTemplate(rows);
    const body = new Uint8Array(workbook.bytes.byteLength);
    body.set(workbook.bytes);
    return new Response(body.buffer, {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="teacher-code-template.xlsx"; filename*=UTF-8''${encodeURIComponent(workbook.fileName)}`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "X-Content-Type-Options": "nosniff",
        "X-Template-Rows": String(workbook.rowCount),
      },
    });
  } catch (error) {
    return visitStoreError(error, "teacher_code_template_unavailable");
  }
}
