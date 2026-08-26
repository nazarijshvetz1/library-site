import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFile(path.join(root, file), "utf8");

test("all main record lists use one accessible expand-collapse contract", async () => {
  const [component, teacher, acquisition, inbox, acquisitions, visitAdmin, teacherAdmin] = await Promise.all([
    read("app/_components/collapsible-list-section.tsx"),
    read("app/visits/visit-booking-workspace.tsx"),
    read("app/teacher/acquisition/teacher-acquisition-panel.tsx"),
    read("app/librarian/visits/material-request-inbox.tsx"),
    read("app/librarian/acquisitions/acquisition-workspace.tsx"),
    read("app/librarian/visits/visit-admin-workspace.tsx"),
    read("app/librarian/teachers/teacher-management-workspace.tsx"),
  ]);

  assert.match(component, /aria-expanded=\{expanded\}/u);
  assert.match(component, /aria-controls=\{contentId\}/u);
  assert.match(component, /hidden=\{!expanded\}/u);
  assert.match(component, /expanded \? "Згорнути" : "Розгорнути"/u);
  assert.match(component, /setExpanded\(\(value\) => !value\)/u);
  assert.equal((teacher.match(/<CollapsibleListSection/gu) ?? []).length >= 4, true);
  for (const source of [acquisition, inbox, acquisitions, visitAdmin, teacherAdmin]) {
    assert.match(source, /CollapsibleListSection/u);
  }
});

test("mobile list panels avoid overlaps, duplicate frames, and keyboard navigation collisions", async () => {
  const [componentCss, teacherCss, librarianShellCss, teacherWorkspace] = await Promise.all([
    read("app/_components/collapsible-list-section.module.css"),
    read("app/visits/visits.module.css"),
    read("app/librarian/_components/librarian-shell.module.css"),
    read("app/visits/visit-booking-workspace.tsx"),
  ]);

  assert.match(componentCss, /font-family: Georgia/u);
  assert.match(componentCss, /border-color: transparent !important/u);
  assert.match(componentCss, /box-shadow: none !important/u);
  assert.match(teacherWorkspace, /data-telegram-mini-app/u);
  assert.match(teacherCss, /\.header\[data-telegram-mini-app="true"\] \{ position: static; \}/u);
  assert.match(teacherCss, /padding: 14px 12px calc\(112px \+ env\(safe-area-inset-bottom\)\)/u);
  assert.match(teacherCss, /\.bookingActions \{ width: 100%; display: grid!important/u);
  assert.match(librarianShellCss, /\.shell:has\(input:focus, textarea:focus, select:focus\) \.mobileNav/u);
  assert.match(librarianShellCss, /scroll-padding-bottom: calc\(76px \+ env\(safe-area-inset-bottom\)\)/u);
});
