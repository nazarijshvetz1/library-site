import { env } from "cloudflare:workers";

import { createLibrarianReportExcel } from "@/lib/librarian-report-excel";
import {
  isLibrarianReportKind,
  LibrarianReportError,
  readLibrarianReport,
  type LibrarianReportDatabase,
} from "@/lib/librarian-report-store";
import { authorizeLibrarianApi, librarianError } from "@/lib/librarian-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ report: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;

  const { report } = await context.params;
  if (!isLibrarianReportKind(report)) {
    return librarianError(404, "invalid_report", "Такий звіт не підтримується.", authorization.value.access.writesEnabled);
  }
  const url = new URL(request.url);
  const defaults = defaultPeriod();
  const from = url.searchParams.get("from")?.trim() || defaults.from;
  const to = url.searchParams.get("to")?.trim() || defaults.to;
  try {
    const data = await readLibrarianReport(
      env.DB as unknown as LibrarianReportDatabase,
      report,
      from,
      to,
    );
    const document = createLibrarianReportExcel(data);
    const encodedName = encodeURIComponent(document.fileName);
    return new Response(document.bytes, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="library-report.xlsx"; filename*=UTF-8''${encodedName}`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "X-Content-Type-Options": "nosniff",
        "X-Export-Filename": encodedName,
        "X-Export-Rows": String(document.rowCount),
        "X-Export-Sheets": String(document.sheetCount),
      },
    });
  } catch (error) {
    const code = error instanceof LibrarianReportError ? error.code : "report_unavailable";
    const status = code === "invalid_period" || code === "invalid_report" ? 400 : code === "report_too_large" ? 413 : 503;
    return librarianError(
      status,
      code,
      error instanceof Error ? error.message : "Не вдалося сформувати звіт.",
      authorization.value.access.writesEnabled,
    );
  }
}

function defaultPeriod() {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  return { from: `${today.slice(0, 4)}-01-01`, to: today };
}
