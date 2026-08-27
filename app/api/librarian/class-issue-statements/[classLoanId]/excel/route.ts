import { env } from "cloudflare:workers";

import { createClassIssueStatementExcel } from "@/lib/class-issue-statement-excel";
import {
  ClassIssueStatementError,
  readClassIssueStatement,
  type ClassIssueStatementDatabase,
} from "@/lib/class-issue-statement-store";
import { authorizeLibrarianApi, librarianError } from "@/lib/librarian-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ classLoanId: string }> };

export async function GET(_request: Request, context: Context): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;

  try {
    const { classLoanId } = await context.params;
    const statement = await readClassIssueStatement(
      env.DB as unknown as ClassIssueStatementDatabase,
      classLoanId,
    );
    const document = createClassIssueStatementExcel(statement);
    const encodedName = encodeURIComponent(document.fileName);
    return new Response(document.bytes, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="class-issue-statement.xlsx"; filename*=UTF-8''${encodedName}`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "X-Content-Type-Options": "nosniff",
        "X-Export-Filename": encodedName,
        "X-Export-Rows": String(document.rowCount),
      },
    });
  } catch (error) {
    const message = error instanceof ClassIssueStatementError
      ? error.message
      : "Не вдалося сформувати Excel-відомість.";
    const code = error instanceof ClassIssueStatementError ? error.code : "statement_unavailable";
    return librarianError(
      code === "statement_not_found" ? 404 : code === "statement_invalid" ? 409 : 503,
      code,
      message,
      authorization.value.access.writesEnabled,
    );
  }
}
