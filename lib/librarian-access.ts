import type { ChatGPTUser } from "@/app/chatgpt-auth";
import { getRuntimeBoolean, getRuntimeString } from "@/lib/runtime-env";

export type LibrarianAccess = {
  allowed: boolean;
  role: "librarian" | "admin" | null;
  reason: "allowed" | "not_configured" | "not_allowed";
  writesEnabled: boolean;
};

function configuredEmails(): Set<string> {
  const configured = getRuntimeString("LIBRARIAN_ALLOWED_EMAILS");
  if (!configured) return new Set();

  return new Set(
    configured
      .split(/[\s,;]+/u)
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function getLibrarianAccess(
  user: ChatGPTUser | null,
): LibrarianAccess {
  const emails = configuredEmails();
  if (emails.size === 0) {
    return {
      allowed: false,
      role: null,
      reason: "not_configured",
      writesEnabled: false,
    };
  }

  const allowed = Boolean(
    user && emails.has(user.email.trim().toLowerCase()),
  );

  return {
    allowed,
    role: allowed ? "librarian" : null,
    reason: allowed ? "allowed" : "not_allowed",
    writesEnabled:
      allowed && getRuntimeBoolean("LIBRARIAN_WRITES_ENABLED"),
  };
}
