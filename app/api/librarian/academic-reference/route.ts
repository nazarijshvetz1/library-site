import { env } from "cloudflare:workers";

import {
  type AcademicD1Database,
  readAcademicReferenceData,
} from "@/lib/academic-admin-store";
import {
  authorizeLibrarianApi,
  librarianError,
  librarianJson,
} from "@/lib/librarian-api";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  const { access } = authorization.value;
  try {
    const referenceData = await readAcademicReferenceData(
      env.DB as unknown as AcademicD1Database,
    );
    return librarianJson({
      schemaVersion: 1,
      success: true,
      referenceData,
      writesEnabled: access.writesEnabled,
      generatedAt: new Date().toISOString(),
    });
  } catch {
    return librarianError(
      503,
      "academic_reference_unavailable",
      "Не вдалося завантажити навчальні роки та класи.",
      access.writesEnabled,
    );
  }
}
