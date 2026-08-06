import { authorizeLibrarianApi, librarianError, librarianJson } from "@/lib/librarian-api";
import {
  fetchLibrarianReferenceData,
  GatewayNotConfiguredError,
} from "@/lib/sheets-gateway";

export const dynamic = "force-dynamic";

export async function GET() {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;

  try {
    const result = await fetchLibrarianReferenceData();
    return librarianJson({
      success: true,
      generatedAt: result.generatedAt,
      referenceData: result.referenceData,
      writesEnabled: authorization.value.access.writesEnabled,
    });
  } catch (error) {
    const notConfigured = error instanceof GatewayNotConfiguredError;
    return librarianError(
      notConfigured ? 503 : 502,
      notConfigured ? "reference_gateway_not_configured" : "reference_gateway_unavailable",
      notConfigured
        ? "Захищені довідники ще не підключено. Чернетки матеріалів залишаються доступними."
        : "Не вдалося оновити захищені довідники.",
      authorization.value.access.writesEnabled,
    );
  }
}
