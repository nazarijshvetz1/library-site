import {
  CatalogUnavailableError,
  fetchPublicCatalog,
} from "@/lib/catalog-proxy";
import {
  authorizeLibrarianApi,
  librarianError,
  librarianJson,
} from "@/lib/librarian-api";

export const dynamic = "force-dynamic";

export async function GET() {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;

  const { access } = authorization.value;
  try {
    const catalog = await fetchPublicCatalog();
    return librarianJson({
      success: true,
      ...catalog,
      writesEnabled: access.writesEnabled,
    });
  } catch (error) {
    const message = error instanceof CatalogUnavailableError
      ? "Не вдалося завантажити каталог. Спробуйте ще раз пізніше."
      : "Сталася помилка під час завантаження каталогу.";
    return librarianError(
      503,
      "catalog_unavailable",
      message,
      access.writesEnabled,
    );
  }
}
