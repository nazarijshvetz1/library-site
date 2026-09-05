import { env } from "cloudflare:workers";
import { authorizeLibrarianApi, librarianError } from "@/lib/librarian-api";
import { createD1RecoverySnapshot, type RecoveryDatabase } from "@/lib/d1-recovery-snapshot";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  // Recovery snapshots include private access state and are restricted more tightly than reports.
  if (authorization.value.access.role !== "admin") return librarianError(403, "admin_required", "Резервний експорт доступний лише адміністратору бібліотеки.", false);
  try {
    const snapshot = await createD1RecoverySnapshot(env.DB as unknown as RecoveryDatabase);
    return new Response(snapshot.json, { headers: {
      "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store",
      "Content-Disposition": 'attachment; filename="library-d1-recovery.json"',
      "X-Content-Type-Options": "nosniff", "X-Recovery-Tables": String(snapshot.tables), "X-Recovery-Rows": String(snapshot.rows),
    } });
  } catch {
    return librarianError(503, "recovery_unavailable", "Повний резервний експорт не сформовано. Дані бібліотеки не змінено.", false);
  }
}
