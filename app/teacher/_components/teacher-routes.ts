export const TEACHER_PORTAL_TABS = [
  "overview",
  "visits",
  "orders",
  "acquisition",
  "loans",
  "notifications",
  "telegram",
] as const;

export type TeacherPortalTab = (typeof TEACHER_PORTAL_TABS)[number];

export function boundedTeacherTab(value: string | string[] | null | undefined): TeacherPortalTab {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && TEACHER_PORTAL_TABS.includes(candidate as TeacherPortalTab)
    ? candidate as TeacherPortalTab
    : "overview";
}

export function teacherPortalHref(
  tab: TeacherPortalTab,
  telegramMiniApp = false,
  currentUrl?: URL,
): string {
  const path = telegramMiniApp ? "/teacher/telegram/cabinet" : "/teacher";
  const params = currentUrl ? new URLSearchParams(currentUrl.search) : new URLSearchParams();
  params.set("tab", tab);

  if (tab !== "orders") params.delete("material");
  if (tab !== "visits") {
    params.delete("date");
    params.delete("start");
    params.delete("end");
  }

  return `${path}?${params.toString()}`;
}
