import { env } from "cloudflare:workers";

import { authorizeLibrarianApi } from "@/lib/librarian-api";
import {
  materialRequestJson,
  materialRequestStoreError,
} from "@/lib/teacher-material-request-api";
import {
  listMaterialRequestPickupLocations,
  type TeacherMaterialRequestDatabase,
} from "@/lib/teacher-material-request-store";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;
  const { access } = authorization.value;
  try {
    const locations = await listMaterialRequestPickupLocations(
      env.DB as unknown as TeacherMaterialRequestDatabase,
    );
    return materialRequestJson({
      schemaVersion: 1,
      success: true,
      locations,
      writesEnabled: access.writesEnabled,
    });
  } catch (error) {
    return materialRequestStoreError(
      error,
      "pickup_locations_unavailable",
      access.writesEnabled,
    );
  }
}
