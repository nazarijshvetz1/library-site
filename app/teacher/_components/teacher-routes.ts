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

export const TEACHER_ORDER_VIEWS = ["catalog", "history"] as const;

export type TeacherOrderView = (typeof TEACHER_ORDER_VIEWS)[number];

export function boundedTeacherTab(value: string | string[] | null | undefined): TeacherPortalTab {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && TEACHER_PORTAL_TABS.includes(candidate as TeacherPortalTab)
    ? candidate as TeacherPortalTab
    : "overview";
}

export function boundedTeacherOrderView(
  value: string | string[] | null | undefined,
): TeacherOrderView | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && TEACHER_ORDER_VIEWS.includes(candidate as TeacherOrderView)
    ? candidate as TeacherOrderView
    : null;
}

export function teacherPortalHref(
  tab: TeacherPortalTab,
  telegramMiniApp = false,
  currentUrl?: URL,
): string {
  const path = telegramMiniApp ? "/teacher/telegram/cabinet" : "/teacher";
  const params = currentUrl ? new URLSearchParams(currentUrl.search) : new URLSearchParams();
  params.set("tab", tab);

  params.delete("view");
  params.delete("material");
  if (tab !== "visits") {
    params.delete("date");
    params.delete("start");
    params.delete("end");
  }

  return `${path}?${params.toString()}`;
}

export function teacherOrderPortalHref(
  view: TeacherOrderView,
  telegramMiniApp = false,
  currentUrl?: URL,
): string {
  const path = telegramMiniApp ? "/teacher/telegram/cabinet" : "/teacher";
  const params = currentUrl ? new URLSearchParams(currentUrl.search) : new URLSearchParams();
  params.set("tab", "orders");
  params.set("view", view);
  if (view === "history") params.delete("material");
  params.delete("date");
  params.delete("start");
  params.delete("end");
  return `${path}?${params.toString()}`;
}

export function teacherTelegramCabinetHref(tab: TeacherPortalTab, materialId = ""): string {
  const params = new URLSearchParams({ tab });
  const normalizedMaterialId = materialId.trim().toUpperCase();
  if (tab === "orders" && /^CAT-\d{4,}$/u.test(normalizedMaterialId)) {
    params.set("material", normalizedMaterialId);
  }
  return `/teacher/telegram/cabinet?${params.toString()}`;
}
