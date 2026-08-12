import { env } from "cloudflare:workers";

import type { CatalogD1Database } from "@/lib/catalog-d1";
import {
  authorizeLibrarianApi,
  librarianError,
  librarianJson,
} from "@/lib/librarian-api";
import { readLibraryReferenceData } from "@/lib/library-directory-store";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  const { access } = authorization.value;
  try {
    const reference = await readLibraryReferenceData(
      env.DB as unknown as CatalogD1Database,
    );
    return librarianJson({
      schemaVersion: 1,
      success: true,
      ...reference,
      writesEnabled: access.writesEnabled,
    });
  } catch {
    return librarianError(
      503,
      "library_reference_unavailable",
      "Не вдалося завантажити список учителів і місць зберігання.",
      access.writesEnabled,
    );
  }
}
