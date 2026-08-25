import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  boundedTeacherTab,
  TEACHER_PORTAL_TABS,
  teacherPortalHref,
  teacherTelegramCabinetHref,
} from "../app/teacher/_components/teacher-routes.ts";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("teacher route helper keeps web and Telegram Mini App destinations bounded", () => {
  assert.deepEqual([...TEACHER_PORTAL_TABS], [
    "overview", "visits", "orders", "acquisition", "loans", "notifications", "telegram",
  ]);
  for (const tab of TEACHER_PORTAL_TABS) {
    assert.equal(new URL(teacherPortalHref(tab, false), "https://library.example").pathname, "/teacher");
    assert.equal(new URL(teacherPortalHref(tab, true), "https://library.example").pathname, "/teacher/telegram/cabinet");
  }
  assert.equal(boundedTeacherTab("visits"), "visits");
  assert.equal(boundedTeacherTab(["orders", "visits"]), "orders");
  assert.equal(boundedTeacherTab("unknown"), "overview");
  assert.equal(boundedTeacherTab(null), "overview");
});

test("Telegram launch target preserves only a bounded order material", () => {
  assert.equal(
    teacherTelegramCabinetHref("orders", "cat-0112"),
    "/teacher/telegram/cabinet?tab=orders&material=CAT-0112",
  );
  assert.equal(
    teacherTelegramCabinetHref("orders", "../CAT-0112"),
    "/teacher/telegram/cabinet?tab=orders",
  );
  assert.equal(
    teacherTelegramCabinetHref("visits", "CAT-0112"),
    "/teacher/telegram/cabinet?tab=visits",
  );
});

test("teacher route helper preserves only parameters relevant to the selected section", () => {
  const current = new URL("https://library.example/teacher?material=CAT-0195&date=2026-09-01&start=09%3A00&end=09%3A40");
  const orders = new URL(teacherPortalHref("orders", false, current), current);
  assert.equal(orders.searchParams.get("material"), "CAT-0195");
  assert.equal(orders.searchParams.get("date"), null);
  assert.equal(orders.searchParams.get("tab"), "orders");

  const visits = new URL(teacherPortalHref("visits", true, current), current);
  assert.equal(visits.pathname, "/teacher/telegram/cabinet");
  assert.equal(visits.searchParams.get("material"), null);
  assert.equal(visits.searchParams.get("date"), "2026-09-01");
  assert.equal(visits.searchParams.get("start"), "09:00");
  assert.equal(visits.searchParams.get("tab"), "visits");
});

test("teacher workspace has premium responsive navigation and accessible mobile menu", async () => {
  const [workspace, css, telegramLaunch] = await Promise.all([
    read("app/visits/visit-booking-workspace.tsx"),
    read("app/visits/visits.module.css"),
    read("app/teacher/telegram/telegram-teacher-launch.tsx"),
  ]);

  assert.match(workspace, /className=\{styles\.teacherSidebar\}/u);
  assert.match(workspace, /className=\{styles\.teacherMobileNav\}/u);
  assert.match(workspace, /aria-haspopup="dialog"/u);
  assert.match(workspace, /aria-controls="teacher-mobile-menu"/u);
  assert.match(workspace, /id="teacher-mobile-menu"/u);
  assert.match(workspace, /role="dialog" aria-modal="true"/u);
  assert.match(workspace, /event\.key === "Escape"/u);
  assert.match(workspace, /event\.key !== "Tab"/u);
  assert.match(workspace, /const dialogRef = useRef<HTMLElement \| null>\(null\)/u);
  assert.match(workspace, /window\.history\[historyMode === "replace" \? "replaceState" : "pushState"\]/u);
  assert.match(workspace, /window\.addEventListener\("popstate", syncTabFromHistory\)/u);
  assert.match(workspace, /window\.matchMedia\("\(min-width: 901px\)"\)/u);
  assert.match(workspace, /if \(event\.matches\) setMobileMenuOpen\(false\)/u);
  assert.match(workspace, /teacherPortalHref\(tab, telegramMiniApp/u);
  assert.match(workspace, /https:\/\/nazarijshvetz1\.github\.io\/library-site\/library-logo\.png/u);
  assert.match(workspace, /Бібліотека, що працює у вашому ритмі/u);
  assert.match(css, /env\(safe-area-inset-bottom\)/u);
  assert.match(css, /\.teacherPortalLayout/u);
  assert.match(css, /\.teacherSidebar/u);
  assert.match(css, /\.teacherMobileMenuBackdrop/u);
  assert.match(css, /outline:\s*3px solid/u);
  assert.match(telegramLaunch, /<img className=\{styles\.mark\} src=\{LOGO_URL\}/u);
  assert.doesNotMatch(workspace, /<svg\b/iu);
});
