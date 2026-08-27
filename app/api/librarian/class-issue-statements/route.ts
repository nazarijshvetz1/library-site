import { env } from "cloudflare:workers";

import {
  ClassIssueStatementError,
  listClassIssueStatements,
  type ClassIssueStatementDatabase,
} from "@/lib/class-issue-statement-store";
import { authorizeLibrarianApi, librarianError, librarianJson } from "@/lib/librarian-api";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;

  const classYearId = new URL(request.url).searchParams.get("classYearId")?.trim() || null;
  try {
    const statements = await listClassIssueStatements(
      env.DB as unknown as ClassIssueStatementDatabase,
      classYearId,
    );
    return librarianJson({ success: true, statements });
  } catch (error) {
    const message = error instanceof ClassIssueStatementError
      ? error.message
      : "Не вдалося завантажити відомості видачі.";
    const code = error instanceof ClassIssueStatementError ? error.code : "statement_unavailable";
    return librarianError(
      code === "statement_not_found" ? 404 : 503,
      code,
      message,
      authorization.value.access.writesEnabled,
    );
  }
}
