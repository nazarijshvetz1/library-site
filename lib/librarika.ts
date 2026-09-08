export const LIBRARIKA_ORIGIN = "https://librarylyceummaup.librarika.com";
export const LIBRARIKA_CATALOG_URL = `${LIBRARIKA_ORIGIN}/search`;
export const LIBRARIKA_DASHBOARD_URL = `${LIBRARIKA_ORIGIN}/users/dashboard`;
export const LIBRARIKA_MEMBERS_URL = `${LIBRARIKA_ORIGIN}/members`;

/** Builds only a fixed-origin Librarika link. Untrusted URLs are never forwarded. */
export function librarikaBookUrl(sourceMediaId: unknown): string | null {
  const value = typeof sourceMediaId === "number" ? String(sourceMediaId) : String(sourceMediaId ?? "").trim();
  return /^[1-9][0-9]{0,19}$/.test(value)
    ? `${LIBRARIKA_ORIGIN}/search/detail/${value}`
    : null;
}
