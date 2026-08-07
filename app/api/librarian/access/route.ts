import { getChatGPTUser } from "@/app/chatgpt-auth";
import { getLibrarianAccess } from "@/lib/librarian-access";
import { librarianJson } from "@/lib/librarian-api";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getChatGPTUser();
  const access = getLibrarianAccess(user);

  return librarianJson({
    success: true,
    authenticated: Boolean(user),
    user: user
      ? { email: user.email, displayName: user.displayName }
      : null,
    access,
    writesEnabled: access.writesEnabled,
  });
}
